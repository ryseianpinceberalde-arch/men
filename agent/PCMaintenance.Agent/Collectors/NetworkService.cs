using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using Microsoft.Extensions.Logging;
using PCMaintenance.Agent.Models;

namespace PCMaintenance.Agent.Collectors;

public sealed class NetworkService(ILogger<NetworkService> logger)
{
    private readonly Dictionary<string, (long Received, long Sent, long Tick)> _counters = [];
    private readonly Dictionary<string, WifiSnapshot> _wifi = [];
    private readonly object _lock = new();
    private static readonly HttpClient ProbeHttp = new(new SocketsHttpHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(4) };

    public AdapterSnapshot[] Collect(bool refreshWifi)
    {
        lock (_lock) return CollectCore(refreshWifi);
    }

    private AdapterSnapshot[] CollectCore(bool refreshWifi)
    {
        var results = new List<AdapterSnapshot>();
        var adapters = NetworkInterface.GetAllNetworkInterfaces().Where(a => a.NetworkInterfaceType is not NetworkInterfaceType.Loopback and not NetworkInterfaceType.Tunnel).Take(32).ToArray();
        foreach (var adapter in adapters)
        {
            try
            {
                var ip = adapter.GetIPProperties();
                var stats = adapter.GetIPStatistics();
                var tick = Stopwatch.GetTimestamp();
                double? received = null, sent = null;
                if (_counters.TryGetValue(adapter.Id, out var previous))
                {
                    var elapsed = Stopwatch.GetElapsedTime(previous.Tick, tick).TotalSeconds;
                    received = Rate(previous.Received, stats.BytesReceived, elapsed);
                    sent = Rate(previous.Sent, stats.BytesSent, elapsed);
                }
                _counters[adapter.Id] = (stats.BytesReceived, stats.BytesSent, tick);
                var type = adapter.NetworkInterfaceType switch { NetworkInterfaceType.Wireless80211 => "wifi", NetworkInterfaceType.Ethernet or NetworkInterfaceType.GigabitEthernet or NetworkInterfaceType.FastEthernetFx or NetworkInterfaceType.FastEthernetT => "ethernet", _ => "other" };
                if (type == "wifi" && (refreshWifi || !_wifi.ContainsKey(adapter.Id)))
                    _wifi[adapter.Id] = InterfaceStatus.IsDisabled(ip) == true
                        ? new WifiSnapshot("disabled", ObservedAt: DateTimeOffset.UtcNow)
                        : WifiService.Read(adapter.Id, adapter.OperationalStatus.ToString());
                bool? dhcp = null;
                try { dhcp = ip.GetIPv4Properties()?.IsDhcpEnabled; } catch (NetworkInformationException) { }
                var link = adapter.Speed > 0 ? adapter.Speed / 1_000_000d : (double?)null;
                results.Add(new(adapter.Id, adapter.Name, type, adapter.OperationalStatus.ToString(),
                    adapter.GetPhysicalAddress().GetAddressBytes().Length > 0 ? adapter.GetPhysicalAddress().ToString() : null,
                    ip.UnicastAddresses.Where(a => a.Address.AddressFamily == AddressFamily.InterNetwork).Select(a => a.Address.ToString()).ToArray(),
                    ip.UnicastAddresses.Where(a => a.Address.AddressFamily == AddressFamily.InterNetworkV6).Select(a => a.Address.ToString()).ToArray(),
                    ip.GatewayAddresses.Select(a => a.Address.ToString()).ToArray(), ip.DnsAddresses.Select(a => a.ToString()).ToArray(),
                    dhcp, link, stats.BytesReceived, stats.BytesSent, received, sent,
                    link > 0 && received.HasValue && sent.HasValue ? Math.Min(100, Math.Max(received.Value, sent.Value) * 8 / (link.Value * 1_000_000) * 100) : null,
                    type == "wifi" ? _wifi.GetValueOrDefault(adapter.Id) : null));
            }
            catch (Exception ex) when (ex is NetworkInformationException or SocketException)
            { logger.LogDebug(ex, "Network adapter disappeared or its counters are unavailable."); }
        }
        foreach (var id in _counters.Keys.Except(adapters.Select(a => a.Id)).ToArray()) { _counters.Remove(id); _wifi.Remove(id); }
        return results.ToArray();
    }

    public static double? Rate(long previous, long current, double seconds) => seconds > 0 && current >= previous ? (current - previous) / seconds : null;

    // Use the OS routing decision to a probe target; don't guess that the first adapter is the active route.
    public static AdapterSnapshot? Primary(AdapterSnapshot[] adapters)
    {
        try
        {
            using var socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
            socket.Connect(IPAddress.Parse("1.1.1.1"), 443); // UDP connect selects a route; sends no packet.
            var address = (socket.LocalEndPoint as IPEndPoint)?.Address.ToString();
            return adapters.FirstOrDefault(a => a.Ipv4.Contains(address ?? ""));
        }
        catch (SocketException) { return null; }
    }

    public async Task<ConnectivitySnapshot> ProbeAsync(AdapterSnapshot[] adapters, NetworkSettings settings, CancellationToken token)
    {
        var at = DateTimeOffset.UtcNow;
        if (adapters.Length == 0) return new(at, "unknown", "adapter_unavailable", null, null, 0, 0, null, null, null, "none");
        if (!adapters.Any(a => a.Status == "Up")) return new(at, "offline", "local_disconnected", null, null, 0, 0, null, null, null, "none");
        var gateway = Primary(adapters)?.Gateways.FirstOrDefault();
        var gatewayTask = PingAsync(gateway, token);
        var dnsTask = ResolveAsync(token);
        // Two independent HTTPS providers, with exact response validation (captive portals don't count).
        var checks = await Task.WhenAll(
            CheckAsync("https://speed.cloudflare.com/__down?bytes=0", "", token),
            CheckAsync("https://www.gstatic.com/generate_204", null, token));
        var dns = await dnsTask;
        var gatewayReachable = await gatewayTask;
        var samples = new List<double>();
        var pingAttempts = 4;
        for (var i = 0; i < pingAttempts; i++)
        {
            using var ping = new Ping();
            try
            {
                var reply = await ping.SendPingAsync(IPAddress.Parse(i % 2 == 0 ? "1.1.1.1" : "8.8.8.8"), TimeSpan.FromSeconds(1), cancellationToken: token);
                if (reply.Status == IPStatus.Success) samples.Add(reply.RoundtripTime);
            }
            catch (PingException) { }
        }
        var successes = checks.Count(c => c);
        var loss = samples.Count == 0 ? (double?)null : 100d * (pingAttempts - samples.Count) / pingAttempts;
        var latency = samples.Count > 0 ? samples.Average() : (double?)null;
        var jitter = samples.Count > 1 ? samples.Zip(samples.Skip(1), (a, b) => Math.Abs(a - b)).Average() : (double?)null;
        var (status, reason) = Classify(successes, samples.Count, dns, gatewayReachable, latency, loss, settings);
        return new(at, status, reason, dns, gatewayReachable, checks.Length, successes, latency, jitter, loss, "2 HTTPS endpoints; 4 ICMP echoes (loss unknown when all ICMP blocked)");
    }

    public static (string Status, string Reason) Classify(int httpsSuccesses, int pingSuccesses, bool dns, bool? gateway,
        double? latency, double? loss, NetworkSettings settings)
    {
        if (httpsSuccesses == 2 && dns && !(latency > settings.LatencyWarning || loss > settings.PacketLossWarning)) return ("online", "ok");
        if (httpsSuccesses > 0 || pingSuccesses > 0) return ("degraded", !dns ? "dns_failure" : "partial_probe_failure");
        return ("offline", !dns ? "dns_failure" : gateway == false ? "gateway_unreachable" : "internet_probe_failure");
    }

    private static async Task<bool> ResolveAsync(CancellationToken token)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token); timeout.CancelAfter(TimeSpan.FromSeconds(4));
        try { return (await Dns.GetHostAddressesAsync("www.microsoft.com", timeout.Token)).Length > 0; }
        catch (SocketException) { return false; }
        catch (OperationCanceledException) when (!token.IsCancellationRequested) { return false; }
    }
    private static async Task<bool?> PingAsync(string? gateway, CancellationToken token)
    {
        if (!IPAddress.TryParse(gateway, out var address)) return null;
        using var ping = new Ping();
        try { return (await ping.SendPingAsync(address, TimeSpan.FromSeconds(1), cancellationToken: token)).Status == IPStatus.Success; }
        catch (PingException) { return null; }
    }
    private static async Task<bool> CheckAsync(string url, string? expected, CancellationToken token)
    {
        try
        {
            using var response = await ProbeHttp.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, token);
            if (expected is null) return response.StatusCode == HttpStatusCode.NoContent;
            if (response.StatusCode != HttpStatusCode.OK) return false;
            await using var stream = await response.Content.ReadAsStreamAsync(token);
            var buffer = new byte[128];
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token); timeout.CancelAfter(TimeSpan.FromSeconds(4));
            var length = await stream.ReadAtLeastAsync(buffer, expected.Length + 1, throwOnEndOfStream: false, cancellationToken: timeout.Token);
            return System.Text.Encoding.UTF8.GetString(buffer, 0, length).Trim() == expected;
        }
        catch (HttpRequestException) { return false; }
        catch (OperationCanceledException) when (!token.IsCancellationRequested) { return false; }
    }
}
