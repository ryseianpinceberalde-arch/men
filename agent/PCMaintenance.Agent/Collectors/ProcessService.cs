using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using PCMaintenance.Agent.Configuration;
using PCMaintenance.Agent.Models;

namespace PCMaintenance.Agent.Collectors;

public sealed record ProcessStopOutcome(string Status, object Result, string? ErrorMessage = null);

public sealed class ProcessService(AgentOptions options, TaskbarApplicationStore taskbarApplications)
{
    private static readonly string[] ProtectedNames =
    [
        "system", "system idle process", "smss.exe", "csrss.exe", "wininit.exe", "services.exe", "lsass.exe", "winlogon.exe", "svchost.exe",
        "MsMpEng.exe", "NisSrv.exe", "SecurityHealthService.exe", "Sense.exe", "MsSense.exe",
        "CSFalconService.exe", "CSFalconContainer.exe", "SentinelAgent.exe", "SentinelService.exe", "SentinelStaticEngine.exe",
        "SophosFileScanner.exe", "SophosHealth.exe", "SophosNetFilter.exe", "SophosClean.exe", "ekrn.exe", "avp.exe",
        "bdservicehost.exe", "WRSA.exe", "McShield.exe", "McAfeeFramework.exe", "TmListen.exe", "TmPfw.exe",
        "NortonSecurity.exe", "ElasticEndpoint.exe", "elastic-agent.exe", "osqueryd.exe",
    ];

    private readonly ConcurrentDictionary<int, (TimeSpan CpuTime, DateTime SampledAt, DateTimeOffset? StartedAt)> _previous = new();
    private readonly HashSet<string> _deniedNames = new(
        options.DeniedProcessNames.Concat(ProtectedNames).Select(NormalizeName), StringComparer.OrdinalIgnoreCase);

    public IReadOnlyList<ProcessRow> Collect(int maximumRows)
    {
        var rows = new List<ProcessRow>();
        var now = DateTime.UtcNow;
        foreach (var process in Process.GetProcesses())
        {
            try
            {
                using (process)
                {
                    if (process.Id <= 0) continue;
                    var name = process.ProcessName;
                    var applicationName = name;
                    TimeSpan cpuTime;
                    long memory;
                    try
                    {
                        cpuTime = process.TotalProcessorTime;
                        memory = Math.Max(0, process.WorkingSet64);
                    }
                    catch (Exception) { continue; }

                    DateTimeOffset? startedAt = null;
                    try { startedAt = NormalizeToMicroseconds(process.StartTime.ToUniversalTime()); }
                    catch (Exception) { /* Windows may restrict start-time reads for protected processes. */ }
                    try
                    {
                        var imagePath = process.MainModule?.FileName;
                        if (!string.IsNullOrWhiteSpace(imagePath))
                        {
                            var version = FileVersionInfo.GetVersionInfo(imagePath);
                            applicationName = FirstText(version.ProductName, version.FileDescription, name);
                        }
                    }
                    catch (Exception) { /* Module metadata is unavailable for some protected or short-lived processes. */ }

                    var cpu = 0d;
                    if (_previous.TryGetValue(process.Id, out var prior) && prior.StartedAt == startedAt)
                    {
                        var elapsed = (now - prior.SampledAt).TotalMilliseconds;
                        if (elapsed > 0)
                        {
                            var cpuDelta = Math.Max(0, (cpuTime - prior.CpuTime).TotalMilliseconds);
                            cpu = Math.Clamp(100d * cpuDelta / (elapsed * Environment.ProcessorCount), 0, 100);
                        }
                    }
                    _previous[process.Id] = (cpuTime, now, startedAt);
                    var isTaskbarApp = false;
                    try { isTaskbarApp = taskbarApplications.Contains(process.SessionId, process.Id); }
                    catch (Exception) { /* Session metadata may be unavailable for protected processes. */ }
                    rows.Add(new ProcessRow(process.Id, name, applicationName, Math.Round(cpu, 2), memory, startedAt, isTaskbarApp));
                }
            }
            catch (Exception) { /* A process may exit between enumeration and inspection. */ }
        }
        foreach (var staleId in _previous.Keys.Where(id => rows.All(row => row.ProcessId != id)).ToArray()) _previous.TryRemove(staleId, out _);
        return rows.OrderByDescending(row => row.MemoryUsage).Take(Math.Clamp(maximumRows, 1, 2500)).ToArray();
    }

    public ProcessStopOutcome Stop(int processId, string requestedName, string requestedStartedAt, bool force)
    {
        if (processId <= 4) throw new InvalidOperationException("Core Windows process IDs cannot be stopped.");
        var normalizedName = NormalizeName(requestedName);
        if (_deniedNames.Contains(normalizedName)) throw new InvalidOperationException("This Windows or security process is protected by the agent denylist.");
        if (!DateTimeOffset.TryParse(requestedStartedAt, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var expectedStartedAt))
            throw new InvalidOperationException("A valid process start time is required.");

        Process process;
        try { process = Process.GetProcessById(processId); }
        catch (ArgumentException) { throw new InvalidOperationException("The selected process is no longer running."); }

        using (process)
        {
            if (!process.ProcessName.Equals(Path.GetFileNameWithoutExtension(requestedName), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("The process ID no longer belongs to the requested process.");
            if (_deniedNames.Contains(NormalizeName(process.ProcessName)))
                throw new InvalidOperationException("This Windows or security process is protected by the agent denylist.");
            if (process.SessionId == 0)
                throw new InvalidOperationException("Processes in the Windows service session are protected from remote termination.");

            DateTimeOffset actualStartedAt;
            try { actualStartedAt = NormalizeToMicroseconds(process.StartTime.ToUniversalTime()); }
            catch (Exception exception) { throw new InvalidOperationException("Windows did not allow the agent to verify this process start time.", exception); }
            if (actualStartedAt != NormalizeToMicroseconds(expectedStartedAt.UtcDateTime))
                throw new InvalidOperationException("The process ID has been reused or the process changed since inventory was collected.");
            if (process.HasExited) throw new InvalidOperationException("The selected process is no longer running.");

            if (!force)
            {
                var closed = false;
                try { closed = process.CloseMainWindow(); }
                catch (InvalidOperationException) { throw new InvalidOperationException("The selected process is no longer running."); }
                catch (System.ComponentModel.Win32Exception) { /* Continue to the separate confirmation if Windows cannot signal a graceful close. */ }
                if (!closed)
                    return new ProcessStopOutcome("awaiting_confirmation", new { message = "Windows could not close this process gracefully. Explicit administrator confirmation is required before force termination." });
                try
                {
                    if (process.WaitForExit(5_000))
                        return new ProcessStopOutcome("completed", new { terminated = true, method = "graceful", message = $"The application closed gracefully. The agent confirmed {process.ProcessName} (PID {processId}) exited." });
                }
                catch (InvalidOperationException) { }
                return new ProcessStopOutcome("awaiting_confirmation", new { message = "The application did not exit after the graceful close request. Explicit administrator confirmation is required before force termination." });
            }

            try
            {
                if (!process.HasExited) process.Kill(entireProcessTree: false);
                if (!process.WaitForExit(10_000)) throw new TimeoutException("Windows did not stop the process within ten seconds.");
            }
            catch (InvalidOperationException) { throw new InvalidOperationException("The selected process is no longer running."); }
            return new ProcessStopOutcome("completed", new { terminated = true, method = "forced", message = $"The agent confirmed {process.ProcessName} (PID {processId}) exited after force termination." });
        }
    }

    private static DateTimeOffset NormalizeToMicroseconds(DateTime value)
    {
        var utcTicks = value.ToUniversalTime().Ticks;
        return new DateTimeOffset(utcTicks - utcTicks % 10, TimeSpan.Zero);
    }

    private static string FirstText(params string?[] values) => values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value))?.Trim() ?? "Unknown application";

    private static string NormalizeName(string name) => Path.GetFileNameWithoutExtension(name.Trim());
}
