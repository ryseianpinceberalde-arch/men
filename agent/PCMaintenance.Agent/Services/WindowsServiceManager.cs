using Microsoft.Win32;
using PCMaintenance.Agent.Configuration;
using PCMaintenance.Agent.Models;
using System.ServiceProcess;

namespace PCMaintenance.Agent.Services;

public sealed class WindowsServiceManager(AgentOptions options)
{
    private static readonly HashSet<string> BuiltInDenied = new(StringComparer.OrdinalIgnoreCase)
    {
        "RpcSs", "DcomLaunch", "EventLog", "Winmgmt", "WinDefend", "MpsSvc", "PlugPlay", "SamSs", "LSM", "Schedule",
    };
    private readonly HashSet<string> _approved = new(options.ApprovedServiceNames.Select(Normalize), StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _denied = new(BuiltInDenied.Concat(options.DeniedServiceNames.Select(Normalize)), StringComparer.OrdinalIgnoreCase);

    public IReadOnlyList<ServiceRow> Collect(int maximumRows)
    {
        var rows = new List<ServiceRow>();
        foreach (var service in ServiceController.GetServices())
        {
            try
            {
                using (service)
                {
                    rows.Add(new ServiceRow(service.ServiceName, service.DisplayName, StatusName(service.Status), StartupType(service.ServiceName)));
                    if (rows.Count >= Math.Clamp(maximumRows, 1, 2500)) break;
                }
            }
            catch (Exception) { /* Restricted or disappearing services are skipped. */ }
        }
        return rows.OrderBy(row => row.DisplayName, StringComparer.OrdinalIgnoreCase).ToArray();
    }

    public string Execute(string action, string serviceName)
    {
        ValidateServiceName(serviceName);
        if (_denied.Contains(serviceName)) throw new InvalidOperationException("This critical Windows service is protected by the agent denylist.");
        if (!_approved.Contains(serviceName)) throw new InvalidOperationException("This service is not included in the agent's approved service allowlist.");
        using var service = new ServiceController(serviceName);
        _ = service.Status; // Confirm that the named service exists before acting.
        switch (action)
        {
            case "START_SERVICE":
                Start(service);
                return $"Started Windows service {serviceName}.";
            case "STOP_SERVICE":
                Stop(service);
                return $"Stopped Windows service {serviceName}.";
            case "RESTART_SERVICE":
                Stop(service);
                Start(service);
                return $"Restarted Windows service {serviceName}.";
            default:
                throw new InvalidOperationException("The requested service operation is not allowed.");
        }
    }

    private static void Start(ServiceController service)
    {
        if (service.Status == ServiceControllerStatus.Running) return;
        service.Start();
        service.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(20));
    }

    private static void Stop(ServiceController service)
    {
        service.Refresh();
        if (service.Status == ServiceControllerStatus.Stopped) return;
        if (!service.CanStop) throw new InvalidOperationException("Windows does not allow this service to be stopped.");
        service.Stop();
        service.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(20));
    }

    private static string StatusName(ServiceControllerStatus status) => status switch
    {
        ServiceControllerStatus.Running => "running",
        ServiceControllerStatus.Stopped => "stopped",
        ServiceControllerStatus.Paused => "paused",
        ServiceControllerStatus.StartPending or ServiceControllerStatus.ContinuePending => "start_pending",
        ServiceControllerStatus.StopPending or ServiceControllerStatus.PausePending => "stop_pending",
        _ => "unknown",
    };

    private static string StartupType(string serviceName)
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey($@"SYSTEM\CurrentControlSet\Services\{serviceName}");
            return Convert.ToInt32(key?.GetValue("Start") ?? 3, System.Globalization.CultureInfo.InvariantCulture) switch
            {
                0 => "boot",
                1 => "system",
                2 => "automatic",
                3 => "manual",
                4 => "disabled",
                _ => "unknown",
            };
        }
        catch (Exception) { return "unknown"; }
    }

    private static void ValidateServiceName(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 256 || value.Any(character => !char.IsLetterOrDigit(character) && character is not '-' and not '_' and not '.'))
            throw new InvalidOperationException("The service name contains unsupported characters.");
    }

    private static string Normalize(string value) => value.Trim();
}
