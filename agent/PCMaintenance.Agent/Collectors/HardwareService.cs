using System.Net.NetworkInformation;
using System.Management;
using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;
using PCMaintenance.Agent.Models;

namespace PCMaintenance.Agent.Collectors;

[SupportedOSPlatform("windows")]
public sealed class HardwareService(ILogger<HardwareService> logger)
{
    public HardwareSnapshot Collect()
    {
        var computer = QueryFirst("SELECT Manufacturer, Model, TotalPhysicalMemory FROM Win32_ComputerSystem");
        var processor = QueryFirst("SELECT Name, NumberOfCores, NumberOfLogicalProcessors FROM Win32_Processor");
        var bios = QueryFirst("SELECT SMBIOSBIOSVersion, SerialNumber FROM Win32_BIOS");
        var board = QueryFirst("SELECT Manufacturer, Product FROM Win32_BaseBoard");
        var graphics = QueryNames("SELECT Name FROM Win32_VideoController");
        var drives = QueryDrives();
        var storageDevices = QueryRows("SELECT Model, SerialNumber, Size FROM Win32_DiskDrive")
            .Select((disk, index) => new StorageDeviceSnapshot(
                $"Physical disk {index + 1}", Value(disk, "Model"), Value(disk, "SerialNumber"), Integer64(disk, "Size"), 0, null))
            .Concat(ReadVolumes())
            .Take(64)
            .ToArray();
        var networkAdapters = ReadNetworkAdapters();
        var adapter = ReadNetworkAdapter();

        return new HardwareSnapshot(
            Value(computer, "Manufacturer"),
            Value(computer, "Model"),
            Value(bios, "SerialNumber"),
            Value(processor, "Name"),
            Integer(processor, "NumberOfCores"),
            Integer(processor, "NumberOfLogicalProcessors"),
            Integer64(computer, "TotalPhysicalMemory"),
            graphics.FirstOrDefault(),
            Join(Value(board, "Manufacturer"), Value(board, "Product")),
            Value(bios, "SMBIOSBIOSVersion"),
            drives.Total,
            drives.Free,
            adapter?.GetPhysicalAddress().ToString(),
            storageDevices,
            networkAdapters);
    }

    private Dictionary<string, object?>? QueryFirst(string query)
    {
        try
        {
            using var searcher = new ManagementObjectSearcher(query);
            using var results = searcher.Get();
            foreach (ManagementBaseObject item in results)
            {
                using (item)
                {
                    var values = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
                    foreach (PropertyData property in item.Properties) values[property.Name] = property.Value;
                    return values;
                }
            }
        }
        catch (Exception exception) { logger.LogWarning(exception, "A Windows hardware property could not be read."); }
        return null;
    }

    private List<string> QueryNames(string query)
    {
        var values = new List<string>();
        try
        {
            using var searcher = new ManagementObjectSearcher(query);
            using var results = searcher.Get();
            foreach (ManagementBaseObject item in results)
            {
                using (item)
                {
                    var name = item["Name"]?.ToString();
                    if (!string.IsNullOrWhiteSpace(name)) values.Add(name.Trim());
                }
            }
        }
        catch (Exception exception) { logger.LogWarning(exception, "A hardware inventory query could not be completed."); }
        return values;
    }

    private List<Dictionary<string, object?>> QueryRows(string query)
    {
        var values = new List<Dictionary<string, object?>>();
        try
        {
            using var searcher = new ManagementObjectSearcher(query);
            using var results = searcher.Get();
            foreach (ManagementBaseObject item in results)
            {
                using (item)
                {
                    var row = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
                    foreach (PropertyData property in item.Properties) row[property.Name] = property.Value;
                    values.Add(row);
                }
            }
        }
        catch (Exception exception) { logger.LogWarning(exception, "A hardware inventory query could not be completed."); }
        return values;
    }

    private static IReadOnlyList<StorageDeviceSnapshot> ReadVolumes()
    {
        try
        {
            return DriveInfo.GetDrives()
                .Where(drive => drive.IsReady && drive.DriveType == DriveType.Fixed)
                .Select(drive => new StorageDeviceSnapshot(drive.Name, drive.VolumeLabel, null, drive.TotalSize, drive.AvailableFreeSpace, drive.DriveFormat))
                .Take(64)
                .ToArray();
        }
        catch (Exception) { return []; }
    }

    private static IReadOnlyList<NetworkAdapterSnapshot> ReadNetworkAdapters()
    {
        var rows = new List<NetworkAdapterSnapshot>();
        try
        {
            foreach (var adapter in NetworkInterface.GetAllNetworkInterfaces()
                .Where(adapter => adapter.NetworkInterfaceType is not NetworkInterfaceType.Loopback and not NetworkInterfaceType.Tunnel)
                .Take(64))
            {
                try
                {
                    rows.Add(new NetworkAdapterSnapshot(
                        adapter.Name,
                        adapter.Description,
                        adapter.NetworkInterfaceType.ToString(),
                        adapter.OperationalStatus.ToString(),
                        adapter.GetPhysicalAddress().ToString(),
                        adapter.GetIPProperties().UnicastAddresses.Select(address => address.Address.ToString()).Take(16).ToArray()));
                }
                catch (Exception) { /* A restricted or changing adapter must not hide the remaining adapters. */ }
            }
        }
        catch (Exception) { /* Network inventory is optional when Windows denies access. */ }
        return rows;
    }

    private (long Total, long Free) QueryDrives()
    {
        long total = 0, free = 0;
        try
        {
            foreach (var drive in DriveInfo.GetDrives().Where(item => item.IsReady && item.DriveType == DriveType.Fixed))
            {
                total = checked(total + drive.TotalSize);
                free = checked(free + drive.AvailableFreeSpace);
            }
        }
        catch (Exception exception) { logger.LogWarning(exception, "Storage capacity was only partially collected."); }
        return (total, free);
    }

    private static NetworkInterface? ReadNetworkAdapter()
    {
        try
        {
            return NetworkInterface.GetAllNetworkInterfaces().FirstOrDefault(adapter =>
                adapter.OperationalStatus == OperationalStatus.Up &&
                adapter.NetworkInterfaceType is not NetworkInterfaceType.Loopback and not NetworkInterfaceType.Tunnel &&
                adapter.GetPhysicalAddress().GetAddressBytes().Length == 6);
        }
        catch (Exception) { return null; }
    }

    private static string? Value(IReadOnlyDictionary<string, object?>? item, string property)
    {
        try { return item is not null && item.TryGetValue(property, out var value) ? value?.ToString()?.Trim() : null; }
        catch (Exception) { return null; }
    }

    private static int Integer(IReadOnlyDictionary<string, object?>? item, string property)
    {
        try { return Math.Max(0, Convert.ToInt32(item is not null && item.TryGetValue(property, out var value) ? value ?? 0 : 0, System.Globalization.CultureInfo.InvariantCulture)); }
        catch (Exception) { return 0; }
    }

    private static long Integer64(IReadOnlyDictionary<string, object?>? item, string property)
    {
        try { return Math.Max(0, Convert.ToInt64(item is not null && item.TryGetValue(property, out var value) ? value ?? 0 : 0, System.Globalization.CultureInfo.InvariantCulture)); }
        catch (Exception) { return 0; }
    }

    private static string? Join(string? first, string? second) => string.Join(" ", new[] { first, second }.Where(value => !string.IsNullOrWhiteSpace(value)).Select(value => value!.Trim())) is { Length: > 0 } value ? value : null;
}
