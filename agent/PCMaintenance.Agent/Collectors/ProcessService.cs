using System.Collections.Concurrent;
using System.Diagnostics;
using PCMaintenance.Agent.Configuration;
using PCMaintenance.Agent.Models;

namespace PCMaintenance.Agent.Collectors;

public sealed class ProcessService(AgentOptions options)
{
    private readonly ConcurrentDictionary<int, (TimeSpan CpuTime, DateTime SampledAt)> _previous = new();
    private readonly HashSet<string> _deniedNames = new(options.DeniedProcessNames.Select(NormalizeName), StringComparer.OrdinalIgnoreCase);

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
                    TimeSpan cpuTime;
                    long memory;
                    try
                    {
                        cpuTime = process.TotalProcessorTime;
                        memory = Math.Max(0, process.WorkingSet64);
                    }
                    catch (Exception) { continue; }

                    var cpu = 0d;
                    if (_previous.TryGetValue(process.Id, out var prior))
                    {
                        var elapsed = (now - prior.SampledAt).TotalMilliseconds;
                        if (elapsed > 0)
                        {
                            var cpuDelta = Math.Max(0, (cpuTime - prior.CpuTime).TotalMilliseconds);
                            cpu = Math.Clamp(100d * cpuDelta / (elapsed * Environment.ProcessorCount), 0, 100);
                        }
                    }
                    _previous[process.Id] = (cpuTime, now);
                    rows.Add(new ProcessRow(process.Id, name, Math.Round(cpu, 2), memory));
                }
            }
            catch (Exception) { /* A process may exit between enumeration and inspection. */ }
        }
        foreach (var staleId in _previous.Keys.Where(id => rows.All(row => row.ProcessId != id)).ToArray()) _previous.TryRemove(staleId, out _);
        return rows.OrderByDescending(row => row.MemoryUsage).Take(Math.Clamp(maximumRows, 1, 2500)).ToArray();
    }

    public string Stop(int processId, string requestedName)
    {
        if (processId <= 4) throw new InvalidOperationException("Core Windows process IDs cannot be stopped.");
        if (_deniedNames.Contains(NormalizeName(requestedName))) throw new InvalidOperationException("This Windows process is protected by the agent denylist.");
        using var process = Process.GetProcessById(processId);
        if (!process.ProcessName.Equals(Path.GetFileNameWithoutExtension(requestedName), StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("The process ID no longer belongs to the requested process.");
        if (_deniedNames.Contains(NormalizeName(process.ProcessName))) throw new InvalidOperationException("This Windows process is protected by the agent denylist.");
        process.Kill(entireProcessTree: false);
        if (!process.WaitForExit(10_000)) throw new TimeoutException("Windows did not stop the process within ten seconds.");
        return $"Stopped {process.ProcessName} (PID {processId}).";
    }

    private static string NormalizeName(string name) => Path.GetFileNameWithoutExtension(name.Trim());
}
