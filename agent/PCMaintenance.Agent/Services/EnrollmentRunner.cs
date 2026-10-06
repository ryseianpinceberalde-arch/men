using Microsoft.Extensions.Logging.Abstractions;
using PCMaintenance.Agent.Networking;
using PCMaintenance.Agent.Security;

namespace PCMaintenance.Agent.Services;

public static class EnrollmentRunner
{
    public static async Task<int> RunAsync(string[] arguments)
    {
        if (!OperatingSystem.IsWindows())
        {
            Console.Error.WriteLine("Enrollment is supported only on Windows.");
            return 2;
        }
        try
        {
            var values = ParseArguments(arguments);
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
            var store = new DeviceConfigStore();
            var client = new SupabaseAgentClient(http, store, NullLogger<SupabaseAgentClient>.Instance);
            await client.EnrollAsync(values["--supabase-url"], values["--publishable-key"], values["--device-id"], values["--pairing-code"], CancellationToken.None);
            Console.WriteLine("Computer paired successfully. The credential is encrypted and stored in the protected ProgramData folder.");
            Console.WriteLine($"Device configuration: {store.FilePath}");
            Console.WriteLine("You can now install and start the PC Maintenance Agent Windows service.");
            return 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"Enrollment failed: {exception.Message}");
            return 1;
        }
    }

    private static Dictionary<string, string> ParseArguments(string[] arguments)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < arguments.Length; index++)
        {
            var option = arguments[index];
            if (!option.StartsWith("--", StringComparison.Ordinal) || index + 1 >= arguments.Length)
                throw new ArgumentException("Use --supabase-url, --publishable-key, --device-id, and --pairing-code with a value for each.");
            result[option] = arguments[++index];
        }
        foreach (var required in new[] { "--supabase-url", "--publishable-key", "--device-id", "--pairing-code" })
        {
            if (!result.TryGetValue(required, out var value) || string.IsNullOrWhiteSpace(value))
                throw new ArgumentException($"Required option {required} is missing.");
        }
        if (result.Keys.Any(key => !new[] { "--supabase-url", "--publishable-key", "--device-id", "--pairing-code" }.Contains(key, StringComparer.OrdinalIgnoreCase)))
            throw new ArgumentException("An unknown enrollment option was provided.");
        if (result["--publishable-key"].Contains("service_role", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("A Supabase service-role key must never be used by the PC agent.");
        if (result["--device-id"].Length > 120 || result["--pairing-code"].Length != 32)
            throw new ArgumentException("Device ID or one-time pairing code is invalid.");
        return result;
    }
}
