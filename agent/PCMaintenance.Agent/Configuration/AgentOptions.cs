namespace PCMaintenance.Agent.Configuration;

public sealed class AgentOptions
{
    public int WifiSeconds { get; init; } = 10;
    public int ProbeSeconds { get; init; } = 30;
    public int BandwidthSeconds { get; init; } = 5;
    public int HeartbeatSeconds { get; init; } = 45;
    public int PollSeconds { get; init; } = 15;
    public int HardwareRefreshMinutes { get; init; } = 30;
    public int MaximumInventoryRows { get; init; } = 2500;
    public string[] ApprovedServiceNames { get; init; } = [];
    public string[] DeniedServiceNames { get; init; } = [];
    public string[] DeniedProcessNames { get; init; } = [];
}
