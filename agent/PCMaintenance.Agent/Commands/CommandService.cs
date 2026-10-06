using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using PCMaintenance.Agent.Collectors;
using PCMaintenance.Agent.Configuration;
using PCMaintenance.Agent.Models;
using PCMaintenance.Agent.Services;

namespace PCMaintenance.Agent.Commands;

public sealed record CommandExecution(string Status, object Result, string? ErrorMessage = null);

public sealed class CommandService(
    AgentOptions options,
    SystemInfoService systemInfo,
    HardwareService hardware,
    SoftwareInventoryService software,
    ProcessService processes,
    WindowsServiceManager services,
    ILogger<CommandService> logger)
{
    private static readonly HashSet<string> AllowedCommands = new(StringComparer.Ordinal)
    {
        "GET_SYSTEM_INFO", "GET_HARDWARE_INFO", "GET_SOFTWARE", "GET_PROCESSES", "GET_SERVICES", "GET_SYSTEM_STATUS",
        "STOP_PROCESS", "START_SERVICE", "STOP_SERVICE", "RESTART_SERVICE", "RESTART_PC", "SHUTDOWN_PC",
    };

    public Task<CommandExecution> ExecuteAsync(AgentCommand command, CancellationToken cancellationToken)
    {
        if (!AllowedCommands.Contains(command.CommandType))
            return Task.FromResult(new CommandExecution("rejected", new { message = "The requested command is not on the agent allowlist." }, "Command type is not allowlisted."));
        if (command.ExpiresAt <= DateTimeOffset.UtcNow)
            return Task.FromResult(new CommandExecution("rejected", new { message = "The command expired before execution." }, "Command expired."));

        try
        {
            object result = command.CommandType switch
            {
                "GET_SYSTEM_INFO" => new { system = systemInfo.Collect(), specs = hardware.Collect() },
                "GET_HARDWARE_INFO" => new { specs = hardware.Collect() },
                "GET_SYSTEM_STATUS" => new { system = systemInfo.Collect() },
                "GET_SOFTWARE" => new { software = software.Collect(options.MaximumInventoryRows) },
                "GET_PROCESSES" => new { processes = processes.Collect(options.MaximumInventoryRows) },
                "GET_SERVICES" => new { services = services.Collect(options.MaximumInventoryRows) },
                "STOP_PROCESS" => new { message = processes.Stop(ReadProcessId(command.Parameters), ReadRequiredText(command.Parameters, "process_name")) },
                "START_SERVICE" or "STOP_SERVICE" or "RESTART_SERVICE" => new { message = services.Execute(command.CommandType, ReadRequiredText(command.Parameters, "service_name")) },
                "RESTART_PC" => new { message = RequestShutdown(restart: true) },
                "SHUTDOWN_PC" => new { message = RequestShutdown(restart: false) },
                _ => throw new InvalidOperationException("Command is not allowlisted."),
            };
            return Task.FromResult(new CommandExecution("completed", result));
        }
        catch (InvalidOperationException exception)
        {
            logger.LogWarning("Agent rejected {CommandType}: {Reason}", command.CommandType, exception.Message);
            return Task.FromResult(new CommandExecution("rejected", new { message = exception.Message }, exception.Message));
        }
        catch (Exception exception)
        {
            logger.LogError(exception, "Approved command {CommandType} failed.", command.CommandType);
            return Task.FromResult(new CommandExecution("failed", new { message = "The approved operation could not be completed." }, exception.Message));
        }
    }

    private static int ReadProcessId(JsonElement parameters)
    {
        if (!parameters.TryGetProperty("process_id", out var value) || !value.TryGetInt32(out var processId) || processId <= 0)
            throw new InvalidOperationException("A valid process ID is required.");
        return processId;
    }

    private static string ReadRequiredText(JsonElement parameters, string key)
    {
        if (!parameters.TryGetProperty(key, out var value) || value.ValueKind != JsonValueKind.String)
            throw new InvalidOperationException($"A valid {key.Replace('_', ' ')} is required.");
        var text = value.GetString()?.Trim();
        if (string.IsNullOrWhiteSpace(text) || text.Length > 256)
            throw new InvalidOperationException($"A valid {key.Replace('_', ' ')} is required.");
        return text;
    }

    private static string RequestShutdown(bool restart)
    {
        const uint plannedApplicationReason = 0x80040000;
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Restart and shutdown requests require Windows.");
        var action = restart ? "restart" : "shut down";
        var success = InitiateSystemShutdownEx(null, $"An authorized administrator requested this computer to {action}.", 60, false, restart, plannedApplicationReason);
        if (!success) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Windows rejected the shutdown request.");
        return $"Windows accepted a graceful {action} request with a 60-second delay. Applications can prevent the shutdown.";
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitiateSystemShutdownEx(string? machineName, string? message, uint timeoutSeconds, [MarshalAs(UnmanagedType.Bool)] bool forceApplicationsClosed, [MarshalAs(UnmanagedType.Bool)] bool rebootAfterShutdown, uint reason);
}
