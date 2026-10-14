namespace PCMaintenance.Agent.Models;

public sealed record WifiSnapshot(string Status, string? Ssid = null, string? Bssid = null,
    double? SignalPercent = null, string? RadioType = null, string? Band = null,
    int? Channel = null, double? ReceiveLinkMbps = null, double? TransmitLinkMbps = null,
    string? Limitation = null, DateTimeOffset? ObservedAt = null);
public sealed record AdapterSnapshot(string Id, string Name, string Type, string Status,
    string? MacAddress, string[] Ipv4, string[] Ipv6, string[] Gateways, string[] DnsServers,
    bool? DhcpEnabled, double? LinkMbps, long? BytesReceived, long? BytesSent,
    double? ReceiveBytesPerSecond, double? SendBytesPerSecond, double? UtilizationPercent,
    WifiSnapshot? Wifi);
public sealed record ConnectivitySnapshot(DateTimeOffset TestedAt, string Status, string Reason,
    bool? DnsOk, bool? GatewayReachable, int Attempts, int Successes,
    double? LatencyMs, double? JitterMs, double? PacketLossPercent, string Method);
public sealed record NetworkSnapshot(Guid SampleId, DateTimeOffset ObservedAt, string ConnectionType,
    string? PrimaryAdapterId, AdapterSnapshot[] Adapters, ConnectivitySnapshot? Probe);
public sealed record NetworkSettings(int WifiSeconds = 10, int ProbeSeconds = 30, int BandwidthSeconds = 5,
    int SpeedIntervalHours = 0, double LatencyWarning = 200, double PacketLossWarning = 20);
public sealed record NetworkResponse(NetworkSettings? Settings);
public sealed record SpeedSnapshot(Guid TestId, DateTimeOffset TestedAt, string Provider, string Status,
    double? DownloadMbps, double? UploadMbps, long DownloadBytes, long UploadBytes,
    double? LatencyMs, double? JitterMs, double? PacketLossPercent, string? Error);
