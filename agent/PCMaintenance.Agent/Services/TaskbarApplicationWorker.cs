using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Win32.SafeHandles;
using PCMaintenance.Agent.Collectors;

namespace PCMaintenance.Agent.Services;

public sealed class TaskbarApplicationWorker(
    TaskbarApplicationStore store,
    ILogger<TaskbarApplicationWorker> logger) : BackgroundService
{
    private readonly Dictionary<int, SessionMonitor> _monitors = [];
    private readonly Dictionary<int, DateTimeOffset> _retryAfter = [];

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var activeSessions = EnumerateActiveSessions();
                foreach (var sessionId in _retryAfter.Keys.Where(id => !activeSessions.Contains(id)).ToArray()) _retryAfter.Remove(sessionId);
                foreach (var sessionId in _monitors.Keys.Where(id => !activeSessions.Contains(id)).ToArray())
                    await StopMonitorAsync(sessionId);

                foreach (var (sessionId, monitor) in _monitors.ToArray())
                {
                    if (monitor.IsRunning && !monitor.ReaderTask.IsCompleted) continue;
                    await StopMonitorAsync(sessionId);
                }

                foreach (var sessionId in activeSessions)
                {
                    if (_monitors.ContainsKey(sessionId) || _retryAfter.TryGetValue(sessionId, out var retryAt) && retryAt > DateTimeOffset.UtcNow) continue;
                    try
                    {
                        var monitor = StartMonitor(sessionId);
                        monitor.ReaderTask = ReadSnapshotsAsync(monitor, stoppingToken);
                        _monitors.Add(sessionId, monitor);
                        _retryAfter.Remove(sessionId);
                        logger.LogInformation("Started taskbar-window collection for Windows session {SessionId}.", sessionId);
                    }
                    catch (Exception exception)
                    {
                        _retryAfter[sessionId] = DateTimeOffset.UtcNow.AddSeconds(30);
                        logger.LogWarning(exception, "Taskbar-window collection is unavailable for Windows session {SessionId}.", sessionId);
                    }
                }
            }
            catch (Exception exception)
            {
                logger.LogWarning(exception, "Could not refresh active Windows sessions for taskbar-window collection.");
            }

            try { await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
        }

        foreach (var sessionId in _monitors.Keys.ToArray()) await StopMonitorAsync(sessionId);
    }

    private async Task ReadSnapshotsAsync(SessionMonitor monitor, CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                var line = await monitor.Reader.ReadLineAsync(cancellationToken);
                if (line is null) break;
                if (line.Length > 32_768) continue;
                try
                {
                    var processIds = JsonSerializer.Deserialize<int[]>(line);
                    if (processIds is { Length: <= 2500 }) store.ReplaceSession(monitor.SessionId, processIds);
                }
                catch (JsonException) { logger.LogDebug("Ignoring an invalid taskbar-window snapshot from session {SessionId}.", monitor.SessionId); }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
        finally { store.RemoveSession(monitor.SessionId); }
    }

    private async Task StopMonitorAsync(int sessionId)
    {
        if (!_monitors.Remove(sessionId, out var monitor)) return;
        store.RemoveSession(sessionId);
        monitor.Stop();
        try { await Task.WhenAny(monitor.ReaderTask, Task.Delay(TimeSpan.FromSeconds(2))); }
        catch (OperationCanceledException) { }
        monitor.Dispose();
        try { await monitor.ReaderTask; }
        catch (Exception exception) when (exception is IOException or ObjectDisposedException or OperationCanceledException) { }
        logger.LogInformation("Stopped taskbar-window collection for Windows session {SessionId}.", sessionId);
    }

    private static HashSet<int> EnumerateActiveSessions()
    {
        if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out var buffer, out var count))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows could not enumerate interactive logon sessions.");
        try
        {
            var sessions = new HashSet<int>();
            var offset = 0;
            var itemSize = Marshal.SizeOf<WtsSessionInfo>();
            for (var index = 0; index < count; index++)
            {
                var item = Marshal.PtrToStructure<WtsSessionInfo>(IntPtr.Add(buffer, offset));
                if (item.SessionId > 0 && item.State == WtsActive) sessions.Add(item.SessionId);
                offset += itemSize;
            }
            return sessions;
        }
        finally { WTSFreeMemory(buffer); }
    }

    private static SessionMonitor StartMonitor(int sessionId)
    {
        if (!WTSQueryUserToken((uint)sessionId, out var tokenValue))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows could not open the signed-in user's session token.");
        using var token = new SafeAccessTokenHandle(tokenValue);

        var pipeSecurity = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), InheritHandle = true };
        if (!CreatePipe(out var parentRead, out var childWrite, ref pipeSecurity, 0))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows could not create the taskbar monitor output pipe.");
        using (parentRead)
        using (childWrite)
        {
            if (!SetHandleInformation(parentRead, HandleFlagInherit, 0))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows could not secure the taskbar monitor output pipe.");
            using var standardInput = CreateFile("NUL", GenericReadWrite, FileShareReadWrite, ref pipeSecurity, OpenExisting, FileAttributeNormal, IntPtr.Zero);
            if (standardInput.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows could not prepare standard input for the taskbar monitor.");

            var executablePath = Environment.ProcessPath;
            if (string.IsNullOrWhiteSpace(executablePath)) throw new InvalidOperationException("The agent executable path is unavailable.");
            var startup = CreateStartupInfo(childWrite, standardInput);
            var commandLine = new StringBuilder($"\"{executablePath}\" --taskbar-monitor");
            if (!CreateProcessForUser(token, executablePath, commandLine, Path.GetDirectoryName(executablePath)!, ref startup, out var processInfo))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows could not start the taskbar monitor in the signed-in user's session.");

            CloseHandle(processInfo.ThreadHandle);
            SafeFileHandle? outputHandle = null;
            try
            {
                outputHandle = new SafeFileHandle(parentRead.DangerousGetHandle(), ownsHandle: true);
                parentRead.SetHandleAsInvalid();
                var reader = new StreamReader(new FileStream(outputHandle, FileAccess.Read, 4096, isAsync: false), Encoding.UTF8, detectEncodingFromByteOrderMarks: false);
                return new SessionMonitor(sessionId, processInfo.ProcessHandle, reader);
            }
            catch
            {
                outputHandle?.Dispose();
                _ = TerminateProcess(processInfo.ProcessHandle, 1);
                CloseHandle(processInfo.ProcessHandle);
                throw;
            }
        }
    }

    private static StartupInfoEx CreateStartupInfo(SafeFileHandle childOutput, SafeFileHandle standardInput)
    {
        var startup = new StartupInfoEx
        {
            StartupInfo = new StartupInfo
            {
                Desktop = "winsta0\\default",
                Flags = StartfUseStdHandles,
                StandardInput = standardInput.DangerousGetHandle(),
                StandardOutput = childOutput.DangerousGetHandle(),
                StandardError = standardInput.DangerousGetHandle(),
            },
        };
        var requiredBytes = IntPtr.Zero;
        _ = InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref requiredBytes);
        if (requiredBytes == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows could not prepare the taskbar monitor process handles.");
        startup.AttributeList = Marshal.AllocHGlobal(requiredBytes);
        if (!InitializeProcThreadAttributeList(startup.AttributeList, 1, 0, ref requiredBytes))
        {
            Marshal.FreeHGlobal(startup.AttributeList);
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows could not initialize the taskbar monitor process handles.");
        }

        var inheritedHandles = new[] { standardInput.DangerousGetHandle(), childOutput.DangerousGetHandle() };
        var pinnedHandles = GCHandle.Alloc(inheritedHandles, GCHandleType.Pinned);
        try
        {
            if (!UpdateProcThreadAttribute(startup.AttributeList, 0, new IntPtr(ProcThreadAttributeHandleList), pinnedHandles.AddrOfPinnedObject(), new IntPtr(inheritedHandles.Length * IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows could not restrict the taskbar monitor's inherited handles.");
            startup.StartupInfo.Size = (uint)Marshal.SizeOf<StartupInfoEx>();
            return startup;
        }
        catch
        {
            DeleteProcThreadAttributeList(startup.AttributeList);
            Marshal.FreeHGlobal(startup.AttributeList);
            throw;
        }
        finally { pinnedHandles.Free(); }
    }

    private static bool CreateProcessForUser(SafeAccessTokenHandle token, string executablePath, StringBuilder commandLine, string workingDirectory, ref StartupInfoEx startup, out ProcessInformation processInfo)
    {
        try
        {
            return CreateProcessAsUser(token, executablePath, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                CreateNoWindow | CreateUnicodeEnvironment | ExtendedStartupInfoPresent,
                IntPtr.Zero, workingDirectory, ref startup, out processInfo);
        }
        finally
        {
            DeleteProcThreadAttributeList(startup.AttributeList);
            Marshal.FreeHGlobal(startup.AttributeList);
        }
    }

    private const int WtsActive = 0;
    private const int HandleFlagInherit = 1;
    private const uint GenericReadWrite = 0xC0000000;
    private const uint FileShareReadWrite = 0x00000003;
    private const uint OpenExisting = 3;
    private const uint FileAttributeNormal = 0x00000080;
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint CreateNoWindow = 0x08000000;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const int ProcThreadAttributeHandleList = 0x00020002;
    private const uint WaitObject0 = 0;
    private const uint WaitTimeout = 0x00000102;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WtsSessionInfo
    {
        public int SessionId;
        public IntPtr StationName;
        public int State;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public int Length;
        public IntPtr SecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public uint Size;
        public string? Reserved;
        public string? Desktop;
        public string? Title;
        public uint X;
        public uint Y;
        public uint XSize;
        public uint YSize;
        public uint XCountChars;
        public uint YCountChars;
        public uint FillAttribute;
        public uint Flags;
        public ushort ShowWindow;
        public ushort Reserved2Size;
        public IntPtr Reserved2;
        public IntPtr StandardInput;
        public IntPtr StandardOutput;
        public IntPtr StandardError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public IntPtr AttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr ProcessHandle;
        public IntPtr ThreadHandle;
        public int ProcessId;
        public int ThreadId;
    }

    private sealed class SessionMonitor(int sessionId, IntPtr processHandle, StreamReader reader) : IDisposable
    {
        private readonly IntPtr _processHandle = processHandle;
        public int SessionId { get; } = sessionId;
        public StreamReader Reader { get; } = reader;
        public Task ReaderTask { get; set; } = Task.CompletedTask;
        public bool IsRunning => _processHandle != IntPtr.Zero && WaitForSingleObject(_processHandle, 0) == WaitTimeout;
        public void Stop()
        {
            if (IsRunning) _ = TerminateProcess(_processHandle, 1);
        }
        public void Dispose()
        {
            Reader.Dispose();
            if (_processHandle != IntPtr.Zero) CloseHandle(_processHandle);
        }
    }

    [DllImport("wtsapi32.dll", EntryPoint = "WTSEnumerateSessionsW", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WTSEnumerateSessions(IntPtr server, int reserved, int version, out IntPtr sessionInfo, out int count);

    [DllImport("wtsapi32.dll")]
    private static extern void WTSFreeMemory(IntPtr memory);

    [DllImport("wtsapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WTSQueryUserToken(uint sessionId, out IntPtr token);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreatePipe(out SafeFileHandle readPipe, out SafeFileHandle writePipe, ref SecurityAttributes attributes, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(SafeFileHandle handle, int mask, int flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string fileName, uint access, uint share, ref SecurityAttributes security, uint creationDisposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr attributeList, int attributeCount, int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateProcThreadAttribute(IntPtr attributeList, int flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

    [DllImport("advapi32.dll", EntryPoint = "CreateProcessAsUserW", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessAsUser(SafeAccessTokenHandle token, string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref StartupInfoEx startupInfo, out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);
}
