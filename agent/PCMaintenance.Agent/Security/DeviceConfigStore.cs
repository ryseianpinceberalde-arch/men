using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using PCMaintenance.Agent.Models;

namespace PCMaintenance.Agent.Security;

public sealed class DeviceConfigStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    public string DirectoryPath { get; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "PCMaintenance.Agent");
    public string FilePath => Path.Combine(DirectoryPath, "device.json");

    public DeviceConfiguration Load()
    {
        if (!File.Exists(FilePath)) throw new InvalidOperationException("This agent is not paired. Run the one-time administrator pairing command first.");
        try
        {
            var configuration = JsonSerializer.Deserialize<DeviceConfiguration>(File.ReadAllText(FilePath), JsonOptions);
            if (configuration is null || string.IsNullOrWhiteSpace(configuration.EncryptedCredential))
                throw new InvalidDataException("Device configuration is incomplete.");
            return configuration;
        }
        catch (JsonException exception)
        {
            throw new InvalidDataException("The protected device configuration is unreadable.", exception);
        }
    }

    public void Save(DeviceConfiguration configuration)
    {
        Directory.CreateDirectory(DirectoryPath);
        SetPrivateDirectoryAcl(DirectoryPath);
        var temporaryPath = FilePath + ".tmp";
        File.WriteAllText(temporaryPath, JsonSerializer.Serialize(configuration, JsonOptions));
        File.Move(temporaryPath, FilePath, overwrite: true);
        File.SetAttributes(FilePath, FileAttributes.Hidden | FileAttributes.Archive);
    }

    private static void SetPrivateDirectoryAcl(string path)
    {
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        var inheritance = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        security.AddAccessRule(new FileSystemAccessRule(administrators, FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(system, FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
        new DirectoryInfo(path).SetAccessControl(security);
    }
}
