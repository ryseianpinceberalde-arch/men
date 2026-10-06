using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using Microsoft.Win32;
using PCMaintenance.Agent.Models;

namespace PCMaintenance.Agent.Collectors;

public sealed class SystemInfoService
{
    private readonly object _cpuLock = new();
    private (ulong Idle, ulong Kernel, ulong User)? _previousCpu;

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime
    {
        public uint Low;
        public uint High;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private sealed class MemoryStatus
    {
        public uint Length = (uint)Marshal.SizeOf<MemoryStatus>();
        public uint MemoryLoad;
        public ulong TotalPhysical;
        public ulong AvailablePhysical;
        public ulong TotalPageFile;
        public ulong AvailablePageFile;
        public ulong TotalVirtual;
        public ulong AvailableVirtual;
        public ulong AvailableExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetSystemTimes(out FileTime idleTime, out FileTime kernelTime, out FileTime userTime);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx([In, Out] MemoryStatus buffer);

    public SystemSnapshot Collect()
    {
        var os = ReadOperatingSystem();
        var memory = ReadMemoryLoad();
        return new SystemSnapshot(
            Environment.MachineName,
            os.Name,
            os.Version,
            Environment.Is64BitOperatingSystem ? "64-bit" : "32-bit",
            ReadPrimaryIp(),
            ReadCpuLoad(),
            memory,
            ReadPrimaryDiskLoad(),
            Math.Max(0, Environment.TickCount64 / 1000));
    }

    private static (string Name, string Version) ReadOperatingSystem()
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
            var name = key?.GetValue("ProductName")?.ToString() ?? "Windows";
            var version = key?.GetValue("DisplayVersion")?.ToString() ?? key?.GetValue("CurrentBuildNumber")?.ToString() ?? Environment.OSVersion.Version.ToString();
            return (name, version);
        }
        catch (Exception) { return ("Windows", Environment.OSVersion.Version.ToString()); }
    }

    private static double ReadMemoryLoad()
    {
        try
        {
            var status = new MemoryStatus();
            return GlobalMemoryStatusEx(status) ? Math.Clamp(status.MemoryLoad, 0, 100) : 0;
        }
        catch (Exception) { return 0; }
    }

    private double ReadCpuLoad()
    {
        try
        {
            if (!GetSystemTimes(out var idle, out var kernel, out var user)) return 0;
            var current = (Ticks(idle), Ticks(kernel), Ticks(user));
            lock (_cpuLock)
            {
                var previous = _previousCpu;
                _previousCpu = current;
                if (previous is null) return 0;
                var idleDelta = current.Item1 - previous.Value.Idle;
                var totalDelta = current.Item2 - previous.Value.Kernel + current.Item3 - previous.Value.User;
                return totalDelta == 0 ? 0 : Math.Round(Math.Clamp(100d * (1d - (double)idleDelta / totalDelta), 0, 100), 2);
            }
        }
        catch (Exception) { return 0; }
    }

    private static ulong Ticks(FileTime value) => ((ulong)value.High << 32) | value.Low;

    private static double ReadPrimaryDiskLoad()
    {
        try
        {
            var systemRoot = Path.GetPathRoot(Environment.SystemDirectory);
            var drive = DriveInfo.GetDrives().FirstOrDefault(item => item.IsReady && item.DriveType == DriveType.Fixed && item.Name.Equals(systemRoot, StringComparison.OrdinalIgnoreCase));
            if (drive is null || drive.TotalSize <= 0) return 0;
            return Math.Round(Math.Clamp(100d * (drive.TotalSize - drive.AvailableFreeSpace) / drive.TotalSize, 0, 100), 2);
        }
        catch (Exception) { return 0; }
    }

    private static string? ReadPrimaryIp()
    {
        try
        {
            return NetworkInterface.GetAllNetworkInterfaces()
                .Where(adapter => adapter.OperationalStatus == OperationalStatus.Up && adapter.NetworkInterfaceType is not NetworkInterfaceType.Loopback and not NetworkInterfaceType.Tunnel)
                .SelectMany(adapter => adapter.GetIPProperties().UnicastAddresses)
                .Select(address => address.Address)
                .FirstOrDefault(address => address.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(address))?.ToString();
        }
        catch (Exception) { return null; }
    }
}
