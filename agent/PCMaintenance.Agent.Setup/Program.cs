using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

internal static class Program
{
    private const string ServiceName = "PCMaintenanceAgent";
    private const int MaximumPartBytes = 64 * 1024 * 1024;

    private static int Main(string[] arguments)
    {
        try
        {
            Install(ParseArguments(arguments));
            return 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine("PC Maintenance Agent setup failed: " + exception.Message);
            return 1;
        }
    }

    private static Dictionary<string, string> ParseArguments(string[] arguments)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < arguments.Length; index++)
        {
            if (!arguments[index].StartsWith("--", StringComparison.Ordinal) || index + 1 >= arguments.Length)
                throw new ArgumentException("Setup arguments are incomplete.");
            values[arguments[index]] = arguments[++index];
        }

        foreach (var name in new[] { "--package-manifest-url", "--supabase-url", "--publishable-key", "--device-id", "--pairing-code" })
        {
            if (!values.ContainsKey(name) || String.IsNullOrWhiteSpace(values[name]))
                throw new ArgumentException("A required setup argument is missing: " + name);
        }

        if (values.Count != 5) throw new ArgumentException("An unknown setup argument was provided.");
        if (values["--device-id"].Length > 120) throw new ArgumentException("The device ID is invalid.");
        if (!Regex.IsMatch(values["--pairing-code"], "^[a-fA-F0-9]{32}$")) throw new ArgumentException("The one-time pairing code is invalid.");
        if (values["--publishable-key"].IndexOf("service_role", StringComparison.OrdinalIgnoreCase) >= 0)
            throw new ArgumentException("A Supabase service-role key must never be used by the PC agent.");

        return values;
    }

    private static void Install(Dictionary<string, string> values)
    {
        using (var identity = WindowsIdentity.GetCurrent())
        {
            var principal = new WindowsPrincipal(identity);
            if (!principal.IsInRole(WindowsBuiltInRole.Administrator))
                throw new InvalidOperationException("Open PowerShell as administrator, then run the setup command again.");
        }

        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        var manifestUri = ValidateDownloadUri(values["--package-manifest-url"]);
        var manifestBytes = Download(manifestUri, 1024 * 1024);
        var manifest = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024, RecursionLimit = 16 }
            .DeserializeObject(Encoding.UTF8.GetString(manifestBytes)) as IDictionary<string, object>;
        if (manifest == null) throw new InvalidDataException("The agent package manifest is invalid.");

        var expectedHash = manifest.ContainsKey("sha256") ? manifest["sha256"] as string : null;
        if (expectedHash == null || !Regex.IsMatch(expectedHash, "^[a-fA-F0-9]{64}$"))
            throw new InvalidDataException("The agent package manifest has an invalid SHA-256 hash.");

        var partValues = manifest.ContainsKey("parts") ? manifest["parts"] as object[] : null;
        if (partValues == null || partValues.Length == 0 || partValues.Length > 64)
            throw new InvalidDataException("The agent package manifest has no valid package parts.");

        var temporaryDirectory = Path.Combine(Path.GetTempPath(), "PCMaintenance.Agent.Setup-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temporaryDirectory);
        var archivePath = Path.Combine(temporaryDirectory, "agent.zip");
        var agentDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "PCMaintenance.Agent");
        var agentExecutable = Path.Combine(agentDirectory, "PCMaintenance.Agent.exe");
        var serviceWasRunning = false;
        var setupCompleted = false;

        try
        {
            Console.WriteLine("Downloading the Windows agent...");
            using (var archive = new FileStream(archivePath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                foreach (var partValue in partValues)
                {
                    var partName = partValue as string;
                    if (String.IsNullOrWhiteSpace(partName) || Path.GetFileName(partName) != partName || partName.IndexOf('/') >= 0 || partName.IndexOf('\\') >= 0)
                        throw new InvalidDataException("The agent package manifest contains an invalid file name.");

                    var partUri = new Uri(manifestUri, partName);
                    if (!String.Equals(partUri.Scheme, manifestUri.Scheme, StringComparison.OrdinalIgnoreCase) ||
                        !String.Equals(partUri.Authority, manifestUri.Authority, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("Agent package parts must come from the same site.");

                    var partBytes = Download(partUri, MaximumPartBytes);
                    archive.Write(partBytes, 0, partBytes.Length);
                }
            }

            using (var sha = SHA256.Create())
            using (var package = File.OpenRead(archivePath))
            {
                var actualHash = BitConverter.ToString(sha.ComputeHash(package)).Replace("-", "").ToLowerInvariant();
                if (!String.Equals(actualHash, expectedHash, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("The agent download failed its integrity check. Please try again.");
            }

            Console.WriteLine("Package verified. Installing the agent...");
            var service = FindService();
            if (service != null)
            {
                try
                {
                    serviceWasRunning = service.Status == ServiceControllerStatus.Running;
                    if (serviceWasRunning)
                    {
                        service.Stop();
                        service.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(30));
                    }
                }
                finally
                {
                    service.Dispose();
                }
            }

            Directory.CreateDirectory(agentDirectory);
            ExtractPackage(archivePath, agentDirectory);
            if (!File.Exists(agentExecutable)) throw new InvalidDataException("The agent package does not contain its Windows executable.");

            var enrollmentArguments = new[]
            {
                "--supabase-url", values["--supabase-url"],
                "--publishable-key", values["--publishable-key"],
                "--device-id", values["--device-id"],
                "--pairing-code", values["--pairing-code"],
            };
            var enrollmentExitCode = RunProcess(agentExecutable, enrollmentArguments, agentDirectory);
            if (enrollmentExitCode != 0)
                throw new InvalidOperationException("Pairing failed. Generate a fresh setup command in the dashboard and try again.");

            service = FindService();
            if (service == null) CreateService(agentExecutable);
            else service.Dispose();
            service = FindService();
            if (service == null) throw new InvalidOperationException("Windows did not register the PC Maintenance Agent service.");
            try
            {
                if (service.Status != ServiceControllerStatus.Running)
                {
                    service.Start();
                    service.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(60));
                }
            }
            finally
            {
                service.Dispose();
            }

            setupCompleted = true;
            Console.WriteLine("Setup complete. The PC Maintenance Agent service is installed and running.");
        }
        finally
        {
            if (!setupCompleted && serviceWasRunning)
            {
                var service = FindService();
                if (service != null)
                {
                    try
                    {
                        if (service.Status != ServiceControllerStatus.Running) service.Start();
                    }
                    catch (Exception exception)
                    {
                        Console.Error.WriteLine("The previously running agent could not be restarted: " + exception.Message);
                    }
                    finally
                    {
                        service.Dispose();
                    }
                }
            }

            DeleteTemporaryDirectory(temporaryDirectory);
        }
    }

    private static Uri ValidateDownloadUri(string value)
    {
        Uri uri;
        if (!Uri.TryCreate(value, UriKind.Absolute, out uri) ||
            !(String.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) ||
              (String.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) && uri.IsLoopback)))
            throw new InvalidDataException("The agent download must use HTTPS (HTTP is allowed only on localhost).");
        return uri;
    }

    private static byte[] Download(Uri uri, int maximumBytes)
    {
        var request = (HttpWebRequest)WebRequest.Create(uri);
        request.Method = "GET";
        request.Timeout = 120000;
        request.ReadWriteTimeout = 120000;
        request.UserAgent = "PCMaintenance.Agent.Setup/1.0";

        using (var response = (HttpWebResponse)request.GetResponse())
        using (var input = response.GetResponseStream())
        using (var output = new MemoryStream())
        {
            if (response.ContentLength > maximumBytes) throw new InvalidDataException("A setup download exceeded the allowed file size.");
            var buffer = new byte[32768];
            int read;
            while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
            {
                if (output.Length + read > maximumBytes) throw new InvalidDataException("A setup download exceeded the allowed file size.");
                output.Write(buffer, 0, read);
            }
            return output.ToArray();
        }
    }

    private static void ExtractPackage(string archivePath, string destinationDirectory)
    {
        var root = Path.GetFullPath(destinationDirectory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        using (var stream = File.OpenRead(archivePath))
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Read))
        {
            foreach (var entry in archive.Entries)
            {
                var entryName = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                var outputPath = Path.GetFullPath(Path.Combine(destinationDirectory, entryName));
                if (!outputPath.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("The agent package contains an invalid file path.");

                if (entry.Name.Length == 0)
                {
                    Directory.CreateDirectory(outputPath);
                    continue;
                }

                var parentDirectory = Path.GetDirectoryName(outputPath);
                if (!Directory.Exists(parentDirectory)) Directory.CreateDirectory(parentDirectory);
                using (var input = entry.Open())
                using (var output = new FileStream(outputPath, FileMode.Create, FileAccess.Write, FileShare.None))
                    input.CopyTo(output);
            }
        }
    }

    private static ServiceController FindService()
    {
        foreach (var service in ServiceController.GetServices())
        {
            if (String.Equals(service.ServiceName, ServiceName, StringComparison.OrdinalIgnoreCase)) return service;
            service.Dispose();
        }
        return null;
    }

    private static void CreateService(string agentExecutable)
    {
        var scExecutable = Path.Combine(Environment.SystemDirectory, "sc.exe");
        var binaryPath = "\"" + agentExecutable + "\"";
        var exitCode = RunProcess(scExecutable, new[]
        {
            "create", ServiceName,
            "binPath=", binaryPath,
            "start=", "auto",
            "DisplayName=", "PC Maintenance Agent",
        }, Environment.SystemDirectory);

        if (exitCode != 0) throw new InvalidOperationException("Windows could not register the PC Maintenance Agent service (sc.exe exit code " + exitCode + ").");
    }

    private static int RunProcess(string executable, string[] arguments, string workingDirectory)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = executable,
            Arguments = JoinArguments(arguments),
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            CreateNoWindow = false,
        };

        using (var process = Process.Start(startInfo))
        {
            if (process == null) throw new InvalidOperationException("Windows could not start the agent setup process.");
            process.WaitForExit();
            return process.ExitCode;
        }
    }

    private static string JoinArguments(string[] arguments)
    {
        var result = new StringBuilder();
        foreach (var argument in arguments)
        {
            if (result.Length > 0) result.Append(' ');
            result.Append(QuoteArgument(argument));
        }
        return result.ToString();
    }

    private static string QuoteArgument(string argument)
    {
        var result = new StringBuilder("\"");
        var backslashes = 0;
        foreach (var character in argument)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
                continue;
            }
            result.Append('\\', backslashes);
            backslashes = 0;
            result.Append(character);
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static void DeleteTemporaryDirectory(string directory)
    {
        if (!Directory.Exists(directory)) return;
        var tempRoot = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var resolvedDirectory = Path.GetFullPath(directory);
        if (!resolvedDirectory.StartsWith(tempRoot, StringComparison.OrdinalIgnoreCase) ||
            !Regex.IsMatch(Path.GetFileName(resolvedDirectory), "^PCMaintenance\\.Agent\\.Setup-[a-f0-9]{32}$"))
            throw new IOException("Refusing to remove a temporary path outside the setup folder.");
        Directory.Delete(resolvedDirectory, true);
    }
}
