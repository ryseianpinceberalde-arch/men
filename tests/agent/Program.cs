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
var osCases = new (string ProductName, int Build, string Expected)[]
{
    ("Windows 10 Pro", 19045, "Windows 10 Pro"),
    ("Windows 10 Pro", 21999, "Windows 10 Pro"),
    ("Windows 10 Pro", 22000, "Windows 11 Pro"),
    ("Windows 10 Home Single Language", 26300, "Windows 11 Home Single Language"),
    ("Windows 10 Enterprise", 26100, "Windows 11 Enterprise"),
    ("Windows 10", 22000, "Windows 11"),
    ("windows 10 Pro", 22631, "Windows 11 Pro"),
    ("Windows 11 Pro", 26300, "Windows 11 Pro"),
    ("Windows Server 2022 Standard", 20348, "Windows Server 2022 Standard"),
    ("Windows Server 2025 Standard", 26100, "Windows Server 2025 Standard"),
    ("Windows 10 Pro", -1, "Windows 10 Pro"),
    ("Windows", 26300, "Windows"),
    ("Windows 100 Pro", 26300, "Windows 100 Pro"),
};
foreach (var osCase in osCases)
    Check(SystemInfoService.ResolveOperatingSystemName(osCase.ProductName, osCase.Build) == osCase.Expected,
        $"OS name for '{osCase.ProductName}' build {osCase.Build}");
Console.WriteLine($"{osCases.Length} operating-system name checks passed.");
if (args.Contains("--system"))
{
    using var searcher = new System.Management.ManagementObjectSearcher("SELECT Caption FROM Win32_OperatingSystem");
    using var results = searcher.Get();
    using var operatingSystem = results.Cast<System.Management.ManagementBaseObject>().Single();
    var caption = operatingSystem["Caption"]?.ToString()?.Trim() ?? throw new Exception("Windows returned no OS caption.");
    var expectedName = caption.StartsWith("Microsoft ", StringComparison.Ordinal) ? caption["Microsoft ".Length..] : caption;
    var snapshot = new SystemInfoService().Collect();
    Check(snapshot.OsName == expectedName, $"Live OS name: expected '{expectedName}', got '{snapshot.OsName}'.");
    Console.WriteLine($"Actual host OS: {snapshot.OsName}; version={snapshot.OsVersion}.");
}
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
