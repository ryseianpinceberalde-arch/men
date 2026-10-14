using Microsoft.Extensions.Logging.Abstractions;
using PCMaintenance.Agent.Collectors;
using PCMaintenance.Agent.Models;

static void Check(bool value, string message) { if (!value) throw new Exception(message); }
Check(NetworkService.Rate(100, 1100, 5) == 200, "Counter rate");
Check(NetworkService.Rate(1100, 100, 5) is null, "Reset counter must be unknown");
Check(NetworkService.Rate(100, 100, 0) is null, "Zero elapsed time");
var settings = new NetworkSettings();
Check(NetworkService.Classify(1, 0, true, false, null, null, settings).Status == "degraded", "One failed site is not internet offline");
Check(NetworkService.Classify(2, 0, true, false, null, null, settings).Status == "online", "Filtered ICMP does not imply internet outage");
Check(NetworkService.Classify(0, 0, false, true, null, null, settings).Reason == "dns_failure", "DNS diagnosis");
Check(NetworkService.Classify(0, 0, true, false, null, null, settings).Reason == "gateway_unreachable", "Gateway diagnosis");
Check(NetworkService.Classify(0, 0, true, true, null, null, settings).Reason == "internet_probe_failure", "Internet probe diagnosis");
Check(NetworkService.Classify(2, 4, true, true, 300, 0, settings).Status == "degraded", "Latency threshold");
Check(NetworkService.Classify(2, 3, true, true, 10, 25, settings).Status == "degraded", "Loss threshold");
var taskbarApplications = new TaskbarApplicationStore();
taskbarApplications.ReplaceSession(7, [1234, 0, -8]);
Check(taskbarApplications.Contains(7, 1234), "Taskbar app process is available in its session");
Check(!taskbarApplications.Contains(8, 1234), "Taskbar app process is isolated by session");
Check(!taskbarApplications.Contains(7, 1235), "Unknown process is not marked as a taskbar app");
Console.WriteLine("13 agent calculation, classification, and taskbar-state checks passed.");
if (args.Contains("--hardware"))
{
    var process = System.Diagnostics.Process.GetCurrentProcess();
    var started = System.Diagnostics.Stopwatch.StartNew(); var cpu = process.TotalProcessorTime;
    var collector = new NetworkService(NullLogger<NetworkService>.Instance);
    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(40));
    var before = collector.Collect(true);
    await Task.Delay(5000, timeout.Token);
    var after = collector.Collect(true);
    Check(after.All(a => a.ReceiveBytesPerSecond is null or >= 0 && a.SendBytesPerSecond is null or >= 0), "Live counters nonnegative");
    var probe = await collector.ProbeAsync(after, settings, timeout.Token);
    Check(probe.Successes <= probe.Attempts, "Live probe counts valid");
    Console.WriteLine($"Actual host: {after.Length} adapters; Wi-Fi={after.Count(a => a.Type == "wifi")}; Ethernet={after.Count(a => a.Type == "ethernet")}; sampled rates={after.Count(a => a.ReceiveBytesPerSecond.HasValue)}; probe={probe.Status}/{probe.Reason}; HTTPS successes={probe.Successes}/{probe.Attempts}.");
    Console.WriteLine($"Actual connected Wi-Fi detail availability: {after.Count(a => a.Wifi?.Ssid is not null)} SSID; {after.Count(a => a.Wifi?.SignalPercent is not null)} signal.");
    Console.WriteLine($"Short collector check: elapsed={started.Elapsed.TotalSeconds:F1}s; process CPU={(process.TotalProcessorTime-cpu).TotalMilliseconds:F0}ms; working set={process.WorkingSet64/1048576d:F1}MiB (test host, not long-running service profiling).");
    if (args.Contains("--speed"))
    {
        var result = await new SpeedTestService(collector).RunAsync(settings, CancellationToken.None);
        Console.WriteLine($"Actual bounded speed test: {result.Status}; download={result.DownloadMbps:F2} Mbps; upload={result.UploadMbps:F2} Mbps; bytes={result.DownloadBytes}/{result.UploadBytes}.");
    }
}
