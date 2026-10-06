using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PCMaintenance.Agent.Collectors;
using PCMaintenance.Agent.Commands;
using PCMaintenance.Agent.Configuration;
using PCMaintenance.Agent.Models;
using PCMaintenance.Agent.Networking;
using PCMaintenance.Agent.Security;

namespace PCMaintenance.Agent.Services;

public sealed class AgentWorker(
    SupabaseAgentClient client,
    DeviceConfigStore configStore,
    AgentOptions options,
    SystemInfoService systemInfo,
    HardwareService hardware,
    CommandService commands,
    ILogger<AgentWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        DeviceConfiguration configuration;
        try { configuration = configStore.Load(); }
        catch (Exception exception)
        {
            logger.LogCritical(exception, "Agent is not configured. Run the one-time administrator pairing command.");
            return;
        }

        logger.LogInformation("PC Maintenance Agent started for device {DeviceId}.", configuration.DeviceId);
        var heartbeatInterval = TimeSpan.FromSeconds(Math.Clamp(options.HeartbeatSeconds, 30, 60));
        var pollInterval = TimeSpan.FromSeconds(Math.Clamp(options.PollSeconds, 5, 60));
        var hardwareInterval = TimeSpan.FromMinutes(Math.Clamp(options.HardwareRefreshMinutes, 5, 1440));
        var nextHeartbeat = DateTimeOffset.MinValue;
        var nextPoll = DateTimeOffset.MinValue;
        var lastHardwareRead = DateTimeOffset.MinValue;
        HardwareSnapshot? hardwareSnapshot = null;

        while (!stoppingToken.IsCancellationRequested)
        {
            var now = DateTimeOffset.UtcNow;
            if (now >= nextHeartbeat)
            {
                try
                {
                    if (hardwareSnapshot is null || now - lastHardwareRead >= hardwareInterval)
                    {
                        hardwareSnapshot = hardware.Collect();
                        lastHardwareRead = now;
                    }
                    await client.SendHeartbeatAsync(systemInfo.Collect(), hardwareSnapshot, stoppingToken);
                    logger.LogDebug("Heartbeat sent for {DeviceId}.", configuration.DeviceId);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
                catch (Exception exception) { logger.LogWarning(exception, "Heartbeat failed; the next interval will retry."); }
                nextHeartbeat = DateTimeOffset.UtcNow + heartbeatInterval;
            }

            if (DateTimeOffset.UtcNow >= nextPoll)
            {
                try
                {
                    var command = await client.PollCommandAsync(stoppingToken);
                    if (command is not null) await ProcessCommandAsync(command, stoppingToken);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
                catch (Exception exception) { logger.LogWarning(exception, "Command polling failed; the next poll will retry."); }
                nextPoll = DateTimeOffset.UtcNow + pollInterval;
            }

            var untilHeartbeat = nextHeartbeat - DateTimeOffset.UtcNow;
            var untilPoll = nextPoll - DateTimeOffset.UtcNow;
            var delay = TimeSpan.FromMilliseconds(Math.Clamp(Math.Min(untilHeartbeat.TotalMilliseconds, untilPoll.TotalMilliseconds), 250, 2000));
            try { await Task.Delay(delay, stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
        }

        logger.LogInformation("PC Maintenance Agent stopped for device {DeviceId}.", configuration.DeviceId);
    }

    private async Task ProcessCommandAsync(AgentCommand command, CancellationToken cancellationToken)
    {
        if (command.ExpiresAt <= DateTimeOffset.UtcNow)
        {
            try { await client.SendCommandResultAsync(command.Id, "rejected", new { message = "Command expired before execution." }, "Command expired.", cancellationToken); }
            catch (Exception exception) { logger.LogWarning(exception, "Could not report an expired command."); }
            return;
        }

        try
        {
            if (!await client.StartCommandAsync(command.Id, cancellationToken)) return;
            var execution = await commands.ExecuteAsync(command, cancellationToken);
            await client.SendCommandResultAsync(command.Id, execution.Status, execution.Result, execution.ErrorMessage, cancellationToken);
            logger.LogInformation("Command {CommandType} finished with status {Status}.", command.CommandType, execution.Status);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
        catch (Exception exception) { logger.LogError(exception, "Could not run or report command {CommandType}.", command.CommandType); }
    }
}
