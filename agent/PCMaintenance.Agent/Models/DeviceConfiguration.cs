namespace PCMaintenance.Agent.Models;

public sealed record DeviceConfiguration(string SupabaseUrl, string PublishableKey, string DeviceId, string EncryptedCredential);
public sealed record SystemSnapshot(string ComputerName, string OsName, string OsVersion, string Architecture, string? IpAddress, double CpuUsage, double RamUsage, double DiskUsage, long Uptime);
public sealed record HardwareSnapshot(string? Manufacturer, string? Model, string? SerialNumber, string? CpuName, int CpuCores, int LogicalProcessors, long RamTotal, string? GpuName, string? Motherboard, string? Bios, long StorageTotal, long StorageFree, string? MacAddress, IReadOnlyList<StorageDeviceSnapshot> StorageDevices, IReadOnlyList<NetworkAdapterSnapshot> NetworkAdapters);
public sealed record StorageDeviceSnapshot(string Name, string? Model, string? SerialNumber, long SizeBytes, long FreeBytes, string? FileSystem);
public sealed record NetworkAdapterSnapshot(string Name, string? Description, string Type, string Status, string? MacAddress, IReadOnlyList<string> IpAddresses);
public sealed record SoftwareRow(string SoftwareName, string? Version, string? Publisher, string? InstallDate);
public sealed record ProcessRow(int ProcessId, string ProcessName, double CpuUsage, long MemoryUsage);
public sealed record ServiceRow(string ServiceName, string DisplayName, string Status, string StartupType);
public sealed record AgentCommand(Guid Id, string CommandType, System.Text.Json.JsonElement Parameters, DateTimeOffset ExpiresAt);
public sealed record AgentCommandEnvelope(AgentCommand? Command);
