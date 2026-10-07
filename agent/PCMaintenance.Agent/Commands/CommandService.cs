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
    private const uint TokenQuery = 0x0008;
    private const uint TokenAdjustPrivileges = 0x0020;
    private const uint PrivilegeEnabled = 0x00000002;
    private const int ErrorNotAllAssigned = 1300;

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

    private string RequestShutdown(bool restart)
    {
        const uint plannedApplicationReason = 0x80040000;
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Restart and shutdown requests require Windows.");
        var action = restart ? "restart" : "shut down";

        if (!OpenProcessToken(GetCurrentProcess(), TokenQuery | TokenAdjustPrivileges, out var tokenHandle))
            throw CreateWindowsError("Could not open the agent service security token", Marshal.GetLastWin32Error());

        try
        {
            var previousPrivileges = EnableShutdownPrivilege(tokenHandle);
            var success = false;
            var shutdownError = 0;
            try
            {
                success = InitiateSystemShutdownEx(null, $"An authorized administrator requested this computer to {action}.", 60, false, restart, plannedApplicationReason);
                if (!success) shutdownError = Marshal.GetLastWin32Error();
            }
            finally
            {
                RestoreShutdownPrivilege(tokenHandle, previousPrivileges);
            }

            if (!success) throw CreateWindowsError($"Windows rejected the {action} request", shutdownError);
        }
        finally
        {
            _ = CloseHandle(tokenHandle);
        }

        return $"Windows accepted a graceful {action} request with a 60-second delay. Applications can prevent the shutdown.";
    }

    private static TokenPrivileges EnableShutdownPrivilege(IntPtr tokenHandle)
    {
        if (!LookupPrivilegeValue(null, "SeShutdownPrivilege", out var shutdownPrivilege))
            throw CreateWindowsError("Could not look up the Windows shutdown privilege", Marshal.GetLastWin32Error());

        var requestedPrivileges = new TokenPrivileges
        {
            PrivilegeCount = 1,
            Privileges = new LuidAndAttributes { Luid = shutdownPrivilege, Attributes = PrivilegeEnabled },
        };
        if (!AdjustTokenPrivileges(tokenHandle, false, ref requestedPrivileges, (uint)Marshal.SizeOf<TokenPrivileges>(), out var previousPrivileges, out _))
            throw CreateWindowsError("Could not enable the Windows shutdown privilege", Marshal.GetLastWin32Error());

        var adjustmentError = Marshal.GetLastWin32Error();
        if (adjustmentError == ErrorNotAllAssigned)
            throw new InvalidOperationException("The agent service account does not have the Windows shutdown privilege.");

        return previousPrivileges;
    }

    private void RestoreShutdownPrivilege(IntPtr tokenHandle, TokenPrivileges previousPrivileges)
    {
        if (previousPrivileges.PrivilegeCount == 0) return;
        if (!AdjustTokenPrivileges(tokenHandle, false, ref previousPrivileges, (uint)Marshal.SizeOf<TokenPrivileges>(), out _, out _))
            logger.LogError("Could not restore the agent process's previous shutdown privilege state. Windows error {ErrorCode}.", Marshal.GetLastWin32Error());
    }

    private static System.ComponentModel.Win32Exception CreateWindowsError(string operation, int errorCode)
    {
        var systemMessage = new System.ComponentModel.Win32Exception(errorCode).Message;
        return new System.ComponentModel.Win32Exception(errorCode, $"{operation} (Windows error {errorCode}: {systemMessage})");
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Luid
    {
        public uint LowPart;
        public int HighPart;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct LuidAndAttributes
    {
        public Luid Luid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TokenPrivileges
    {
        public uint PrivilegeCount;
        public LuidAndAttributes Privileges;
    }

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool LookupPrivilegeValue(string? systemName, string name, out Luid luid);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AdjustTokenPrivileges(
        IntPtr tokenHandle,
        [MarshalAs(UnmanagedType.Bool)] bool disableAllPrivileges,
        ref TokenPrivileges newState,
        uint bufferLength,
        out TokenPrivileges previousState,
        out uint returnLength);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitiateSystemShutdownEx(string? machineName, string? message, uint timeoutSeconds, [MarshalAs(UnmanagedType.Bool)] bool forceApplicationsClosed, [MarshalAs(UnmanagedType.Bool)] bool rebootAfterShutdown, uint reason);
}
