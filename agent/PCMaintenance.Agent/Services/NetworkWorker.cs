using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PCMaintenance.Agent.Collectors;
using PCMaintenance.Agent.Configuration;
using PCMaintenance.Agent.Models;
using PCMaintenance.Agent.Networking;
using PCMaintenance.Agent.Security;

namespace PCMaintenance.Agent.Services;

// Independent from the existing heartbeat/command loop. Sampling continues while ingestion retries.
public sealed class NetworkWorker(NetworkService network, SpeedTestService speed, SupabaseAgentClient client,
    DeviceConfigStore store, AgentOptions options, ILogger<NetworkWorker> logger) : BackgroundService
{
    private readonly object _sync = new();
    private readonly List<NetworkSnapshot> _pending = [];
    private readonly List<SpeedSnapshot> _speeds = [];
    private NetworkSettings _settings = new(options.WifiSeconds, options.ProbeSeconds, options.BandwidthSeconds);
    private int _refresh;
    public void RequestRefresh() => Interlocked.Exchange(ref _refresh, 1);
    public async Task<SpeedSnapshot> RunSpeedTestAsync(CancellationToken token)
    {
        var result = await speed.RunAsync(_settings, token);
        lock (_sync) { _speeds.Add(result); if (_speeds.Count > 32) _speeds.RemoveAt(0); Persist(); }
        return result;
    }
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { _ = store.Load(); }
        catch (Exception ex) { logger.LogWarning(ex, "Network monitoring awaits device enrollment."); return; }
        var spool = Path.Combine(store.DirectoryPath, "network-spool.json.dpapi");
        try
        {
            if (File.Exists(spool))
            {
                var saved = JsonSerializer.Deserialize<Spool>(DpapiProtector.Unprotect(File.ReadAllText(spool)));
                if (saved is not null) { _pending.AddRange(saved.Samples.TakeLast(2880)); _speeds.AddRange(saved.Speeds.TakeLast(32)); }
            }
        }
        catch (Exception ex) when (ex is IOException or JsonException or System.ComponentModel.Win32Exception or FormatException)
        { logger.LogWarning(ex, "Protected network backlog could not be read; new samples will still be collected."); }
        await Task.WhenAll(SampleLoop(stoppingToken), SendLoop(stoppingToken));
    }
    private async Task SampleLoop(CancellationToken token)
    {
        var nextWifi = DateTimeOffset.MinValue; var nextProbe = DateTimeOffset.MinValue;
        var nextSpeed = DateTimeOffset.UtcNow; var lastSchedule = 0;
        Task<SpeedSnapshot>? scheduledTest = null;
        Task<ConnectivitySnapshot>? probeTask = null;
        try
        {
            while (!token.IsCancellationRequested)
            {
                try
                {
                    var settings = _settings; var now = DateTimeOffset.UtcNow;
                    var refresh = Interlocked.Exchange(ref _refresh, 0) != 0;
                    var wifiDue = refresh || now >= nextWifi;
                    var adapters = network.Collect(wifiDue);
                    ConnectivitySnapshot? probe = null;
                    if (probeTask?.IsCompleted == true)
                    {
                        var completed = probeTask; probeTask = null;
                        probe = await completed;
                    }
                    if ((refresh || now >= nextProbe) && probeTask is null)
                    {
                        probeTask = network.ProbeAsync(adapters, settings, token);
                        nextProbe = now.AddSeconds(Math.Clamp(settings.ProbeSeconds, 30, 300));
                    }
                    if (wifiDue || probe is not null)
                    {
                        var primary = NetworkService.Primary(adapters);
                        var sample = new NetworkSnapshot(Guid.NewGuid(), now, primary?.Type ?? "unknown", primary?.Id, adapters, probe);
                        lock (_sync) { _pending.Add(sample); if (_pending.Count > 2880) _pending.RemoveAt(0); Persist(); }
                        if (wifiDue) nextWifi = now.AddSeconds(Math.Clamp(settings.WifiSeconds, 10, 300));
                    }
                    if (settings.SpeedIntervalHours != lastSchedule)
                    { lastSchedule = settings.SpeedIntervalHours; nextSpeed = now.AddHours(Math.Max(1, lastSchedule)); }
                    if (scheduledTest?.IsCompleted == true) { var completed = scheduledTest; scheduledTest = null; await completed; }
                    if (lastSchedule > 0 && now >= nextSpeed && scheduledTest is null)
                    { nextSpeed = now.AddHours(Math.Clamp(lastSchedule, 1, 168)); scheduledTest = RunSpeedTestAsync(token); }
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
                catch (Exception ex) { logger.LogWarning(ex, "Network sampling failed; the next sample will retry."); }
                await Task.Delay(TimeSpan.FromSeconds(Math.Min(Math.Clamp(_settings.BandwidthSeconds, 5, 60), Math.Clamp(_settings.WifiSeconds, 10, 300))), token);
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        finally
        {
            if (scheduledTest is not null) { try { await scheduledTest; } catch (Exception ex) { logger.LogDebug(ex, "Scheduled speed test ended."); } }
            if (probeTask is not null) { try { await probeTask; } catch (Exception ex) { logger.LogDebug(ex, "Connectivity probe ended."); } }
        }
    }
    private async Task SendLoop(CancellationToken token)
    {
        try
        {
            while (!token.IsCancellationRequested)
            {
                NetworkSnapshot[] batch; SpeedSnapshot[] speeds;
                lock (_sync)
                {
                    // Expired backlogs must not poison every subsequent batch after a long outage.
                    var cutoff = DateTimeOffset.UtcNow.AddDays(-6);
                    _pending.RemoveAll(s => s.ObservedAt < cutoff); _speeds.RemoveAll(s => s.TestedAt < cutoff);
                    batch = _pending.Take(60).ToArray(); speeds = _speeds.ToArray();
                    while (batch.Length > 1 && JsonSerializer.Serialize(batch).Length > 1_500_000)
                        batch = batch.Take(batch.Length / 2).ToArray();
                }
                if (batch.Length > 0 || speeds.Length > 0)
                {
                    try
                    {
                        var response = await client.SendNetworkAsync(batch, speeds, token);
                        if (response?.Settings is not null) _settings = response.Settings;
                        lock (_sync)
                        {
                            var ids = batch.Select(s => s.SampleId).ToHashSet(); _pending.RemoveAll(s => ids.Contains(s.SampleId));
                            var testIds = speeds.Select(s => s.TestId).ToHashSet(); _speeds.RemoveAll(s => testIds.Contains(s.TestId)); Persist();
                        }
                    }
                    catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
                    catch (Exception ex) { logger.LogWarning(ex, "Network upload failed; bounded protected backlog retained for retry."); }
                }
                await Task.Delay(TimeSpan.FromSeconds(15), token);
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
    }
    private void Persist()
    {
        var path = Path.Combine(store.DirectoryPath, "network-spool.json.dpapi");
        var json = JsonSerializer.Serialize(new Spool(_pending.ToArray(), _speeds.ToArray()));
        // Bound disk and encryption work even on hosts with many adapters.
        while (json.Length > 4_000_000 && _pending.Count > 1)
        {
            _pending.RemoveRange(0, Math.Max(1, _pending.Count / 4));
            json = JsonSerializer.Serialize(new Spool(_pending.ToArray(), _speeds.ToArray()));
        }
        File.WriteAllText(path + ".tmp", DpapiProtector.Protect(json));
        File.Move(path + ".tmp", path, overwrite: true);
    }
    private sealed record Spool(NetworkSnapshot[] Samples, SpeedSnapshot[] Speeds);
}
