using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PCMaintenance.Agent.Commands;
using PCMaintenance.Agent.Collectors;
using PCMaintenance.Agent.Configuration;
using PCMaintenance.Agent.Networking;
using PCMaintenance.Agent.Security;
using PCMaintenance.Agent.Services;

if (args.Contains("--pairing-code", StringComparer.OrdinalIgnoreCase))
{
    return await EnrollmentRunner.RunAsync(args);
}

if (args.Length == 1 && args[0].Equals("--taskbar-monitor", StringComparison.OrdinalIgnoreCase))
{
    if (!OperatingSystem.IsWindows()) return 2;
    return await TaskbarWindowMonitor.RunAsync();
}

if (!OperatingSystem.IsWindows())
{
    Console.Error.WriteLine("The PC Maintenance Agent can only run on Windows.");
    return 2;
}

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(options => options.ServiceName = "PCMaintenanceAgent");
builder.Logging.AddEventLog(settings => settings.SourceName = "PC Maintenance Agent");
builder.Services.Configure<AgentOptions>(builder.Configuration.GetSection("Agent"));
builder.Services.AddSingleton(serviceProvider => serviceProvider.GetRequiredService<IOptions<AgentOptions>>().Value);
builder.Services.AddSingleton<DeviceConfigStore>();
builder.Services.AddSingleton<SystemInfoService>();
builder.Services.AddSingleton<HardwareService>();
builder.Services.AddSingleton<SoftwareInventoryService>();
builder.Services.AddSingleton<TaskbarApplicationStore>();
builder.Services.AddSingleton<ProcessService>();
builder.Services.AddSingleton<WindowsServiceManager>();
builder.Services.AddSingleton<CommandService>();
builder.Services.AddSingleton<NetworkService>();
builder.Services.AddSingleton<SpeedTestService>();
builder.Services.AddSingleton<NetworkWorker>();
builder.Services.AddHostedService(serviceProvider => serviceProvider.GetRequiredService<NetworkWorker>());
builder.Services.AddHostedService<TaskbarApplicationWorker>();
builder.Services.AddHttpClient<SupabaseAgentClient>(client => client.Timeout = TimeSpan.FromSeconds(15));
builder.Services.AddHostedService<AgentWorker>();

try
{
    await builder.Build().RunAsync();
    return 0;
}
catch (Exception exception)
{
    Console.Error.WriteLine($"Agent startup failed: {exception.Message}");
    return 1;
}
