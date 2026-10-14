using System.Runtime.InteropServices;
using System.Text;
using PCMaintenance.Agent.Models;

namespace PCMaintenance.Agent.Collectors;

// Read-only Native Wi-Fi queries. Never scans, reads profiles/keys, or changes radio state.
public static class WifiService
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Connection
    {
        public int State, Mode;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string Profile;
        public uint SsidLength;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)] public byte[] Ssid;
        public int BssType;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 6)] public byte[] Bssid;
        public int PhyType;
        public uint PhyIndex, Quality, RxRate, TxRate;
        public int Security, OneX, Auth, Cipher;
    }
    [DllImport("wlanapi.dll")] private static extern uint WlanOpenHandle(uint version, IntPtr reserved, out uint negotiated, out IntPtr handle);
    [DllImport("wlanapi.dll")] private static extern uint WlanCloseHandle(IntPtr handle, IntPtr reserved);
    [DllImport("wlanapi.dll")] private static extern void WlanFreeMemory(IntPtr memory);
    [DllImport("wlanapi.dll")] private static extern uint WlanQueryInterface(IntPtr handle, ref Guid id, int opcode, IntPtr reserved, out uint size, out IntPtr data, out int type);

    public static WifiSnapshot Read(string adapterId, string fallbackStatus)
        => ReadCore(adapterId, fallbackStatus) with { ObservedAt = DateTimeOffset.UtcNow };

    private static WifiSnapshot ReadCore(string adapterId, string fallbackStatus)
    {
        if (!Guid.TryParse(adapterId, out var id)) return new("unknown", Limitation: "Adapter has no WLAN interface identifier.");
        var error = WlanOpenHandle(2, IntPtr.Zero, out _, out var handle);
        if (error != 0) return new(fallbackStatus == "Up" ? "connected" : "unknown", Limitation: $"WLAN service unavailable ({error}).");
        try
        {
            string status = "unknown";
            if (Query(handle, id, 6, out var state, out var size, out _))
            {
                try { if (size >= 4) status = Marshal.ReadInt32(state) switch { 1 or 2 => "connected", 4 => "disconnected", _ => "unknown" }; }
                finally { WlanFreeMemory(state); }
            }
            if (Query(handle, id, 4, out var radio, out size, out _))
            {
                try
                {
                    var count = size >= 4 ? Math.Min(Marshal.ReadInt32(radio), 64) : 0;
                    if (count > 0 && size >= 4 + count * 12 && Enumerable.Range(0, count).All(i =>
                        Marshal.ReadInt32(radio, 4 + i * 12 + 4) == 2 || Marshal.ReadInt32(radio, 4 + i * 12 + 8) == 2)) status = "disabled";
                }
                finally { WlanFreeMemory(radio); }
            }
            if (status != "connected") return new(status);
            string? ssid = null, bssid = null, limitation = null, band = null;
            double? signal = null, rx = null, tx = null;
            int? channel = null, phy = null;
            if (Query(handle, id, 7, out var data, out size, out error))
            {
                try
                {
                    if (size >= Marshal.SizeOf<Connection>())
                    {
                        var connection = Marshal.PtrToStructure<Connection>(data);
                        ssid = Encoding.UTF8.GetString(connection.Ssid, 0, (int)Math.Min(connection.SsidLength, 32));
                        bssid = string.Join(":", connection.Bssid.Select(b => b.ToString("X2")));
                        signal = connection.Quality <= 100 ? connection.Quality : null;
                        phy = connection.PhyType;
                        rx = connection.RxRate / 1000d; tx = connection.TxRate / 1000d;
                    }
                }
                finally { WlanFreeMemory(data); }
            }
            else limitation = error == 5 ? "Windows location/privacy policy denied SSID and BSSID access." : $"Connection details unavailable ({error}).";
            // Available on newer Windows builds; no location-sensitive fields. Older builds return unsupported.
            if (Query(handle, id, 19, out data, out size, out _))
            {
                try
                {
                    if (size >= 24)
                    {
                        phy = Marshal.ReadInt32(data); var quality = Marshal.ReadInt32(data, 4);
                        if (quality is >= 0 and <= 100) signal = quality;
                        rx ??= (uint)Marshal.ReadInt32(data, 8) / 1000d;
                        tx ??= (uint)Marshal.ReadInt32(data, 12) / 1000d;
                        if (Marshal.ReadInt32(data, 20) > 0 && size >= 32)
                        {
                            var frequency = Marshal.ReadInt32(data, 28);
                            // SDK documentation differs in units; accept only known MHz/kHz ranges.
                            if (frequency > 1_000_000) frequency /= 1000;
                            band = frequency switch { >= 2400 and <= 2500 => "2.4 GHz", >= 4900 and < 5925 => "5 GHz", >= 5925 and <= 7125 => "6 GHz", _ => null };
                        }
                    }
                }
                finally { WlanFreeMemory(data); }
            }
            if (Query(handle, id, 8, out data, out size, out _))
            {
                try { if (size >= 4 && Marshal.ReadInt32(data) > 0) channel = Marshal.ReadInt32(data); }
                finally { WlanFreeMemory(data); }
            }
            var radioType = phy switch { 7 => "Wi-Fi 4", 8 => "Wi-Fi 5", 10 => band == "6 GHz" ? "Wi-Fi 6E" : "Wi-Fi 6", 11 => "Wi-Fi 7", _ => null };
            return new(status, ssid, bssid, signal, radioType, band, channel, rx, tx, limitation);
        }
        finally { _ = WlanCloseHandle(handle, IntPtr.Zero); }
    }

    private static bool Query(IntPtr handle, Guid id, int opcode, out IntPtr data, out uint size, out uint error)
    {
        error = WlanQueryInterface(handle, ref id, opcode, IntPtr.Zero, out size, out data, out _);
        if (error == 0) return true;
        if (data != IntPtr.Zero) WlanFreeMemory(data);
        return false;
    }
}
