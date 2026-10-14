using System.Net.NetworkInformation;
using System.Runtime.InteropServices;

namespace PCMaintenance.Agent.Collectors;

// IP Helper's administrative state distinguishes a disabled adapter from a disconnected link.
internal static class InterfaceStatus
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MibIfRow
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string Name;
        public uint Index, Type, Mtu, Speed, PhysicalAddressLength;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 8)] public byte[] PhysicalAddress;
        public uint AdminStatus, OperStatus, LastChange, InOctets, InUnicastPackets, InNonUnicastPackets,
            InDiscards, InErrors, InUnknownProtocols, OutOctets, OutUnicastPackets, OutNonUnicastPackets,
            OutDiscards, OutErrors, OutQueueLength, DescriptionLength;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 256)] public byte[] Description;
    }
    [DllImport("iphlpapi.dll")] private static extern uint GetIfEntry(ref MibIfRow row);

    public static bool? IsDisabled(IPInterfaceProperties properties)
    {
        try
        {
            var index = properties.GetIPv4Properties()?.Index ?? properties.GetIPv6Properties()?.Index;
            if (index is null) return null;
            var row = new MibIfRow { Index = (uint)index.Value, Name = "", PhysicalAddress = new byte[8], Description = new byte[256] };
            if (GetIfEntry(ref row) != 0) return null;
            return row.AdminStatus switch { 1 => false, 2 => true, _ => null };
        }
        catch (NetworkInformationException) { return null; }
    }
}
