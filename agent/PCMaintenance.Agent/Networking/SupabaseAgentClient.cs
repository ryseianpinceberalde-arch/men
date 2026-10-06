using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using PCMaintenance.Agent.Models;
using PCMaintenance.Agent.Security;

namespace PCMaintenance.Agent.Networking;

public sealed class SupabaseAgentClient(HttpClient http, DeviceConfigStore configStore, ILogger<SupabaseAgentClient> logger)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        PropertyNameCaseInsensitive = true,
    };

    public async Task EnrollAsync(string supabaseUrl, string publishableKey, string deviceId, string pairingCode, CancellationToken cancellationToken)
    {
        var endpoint = CreateFunctionUri(supabaseUrl, "device-enroll");
        using var request = CreateRequest(endpoint, publishableKey, null);
        request.Content = JsonContent.Create(new { pairing_code = pairingCode, device_id = deviceId }, options: JsonOptions);
        using var response = await http.SendAsync(request, cancellationToken);
        var payload = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException(ReadError(payload, response.StatusCode));
        using var document = JsonDocument.Parse(payload);
        if (!document.RootElement.TryGetProperty("device_credential", out var credentialElement) || string.IsNullOrWhiteSpace(credentialElement.GetString()))
            throw new InvalidOperationException("The enrollment service returned no device credential.");
        var configuration = new DeviceConfiguration(NormalizeSupabaseUrl(supabaseUrl), publishableKey, deviceId, DpapiProtector.Protect(credentialElement.GetString()!));
        configStore.Save(configuration);
    }

    public Task SendHeartbeatAsync(object system, object specs, CancellationToken cancellationToken) =>
        SendWithRetryAsync("heartbeat", new { action = "heartbeat", system, specs }, cancellationToken);

    public async Task<AgentCommand?> PollCommandAsync(CancellationToken cancellationToken)
    {
        var configuration = configStore.Load();
        using var request = CreateAuthenticatedRequest(configuration, new { action = "poll" });
        using var response = await http.SendAsync(request, cancellationToken);
        var payload = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode) throw new HttpRequestException(ReadError(payload, response.StatusCode));
        return JsonSerializer.Deserialize<AgentCommandEnvelope>(payload, JsonOptions)?.Command;
    }

    public async Task<bool> StartCommandAsync(Guid commandId, CancellationToken cancellationToken)
    {
        var response = await SendAuthenticatedAsync(new { action = "command_start", command_id = commandId }, cancellationToken);
        if (response.StatusCode == HttpStatusCode.Conflict) return false;
        if (!response.IsSuccessStatusCode) throw new HttpRequestException(ReadError(response.Payload, response.StatusCode));
        return true;
    }

    public async Task SendCommandResultAsync(Guid commandId, string status, object result, string? errorMessage, CancellationToken cancellationToken)
    {
        await SendWithRetryAsync("command result", new { action = "command_result", command_id = commandId, status, result, error_message = errorMessage }, cancellationToken);
    }

    private async Task SendWithRetryAsync(string name, object requestBody, CancellationToken cancellationToken)
    {
        const int maximumAttempts = 3;
        for (var attempt = 1; ; attempt++)
        {
            (HttpStatusCode StatusCode, bool IsSuccessStatusCode, string Payload) response;
            try
            {
                response = await SendAuthenticatedAsync(requestBody, cancellationToken);
            }
            catch (Exception exception) when (attempt < maximumAttempts && (exception is HttpRequestException or TaskCanceledException) && !cancellationToken.IsCancellationRequested)
            {
                logger.LogWarning(exception, "Supabase {RequestName} failed; retry {Attempt}/{MaximumAttempts}.", name, attempt, maximumAttempts);
                await Task.Delay(TimeSpan.FromSeconds(attempt * 2), cancellationToken);
                continue;
            }
            if (response.IsSuccessStatusCode) return;
            var isTransient = (int)response.StatusCode >= 500 || response.StatusCode == HttpStatusCode.TooManyRequests;
            if (isTransient && attempt < maximumAttempts)
            {
                logger.LogWarning("Supabase {RequestName} returned HTTP {StatusCode}; retry {Attempt}/{MaximumAttempts}.", name, (int)response.StatusCode, attempt, maximumAttempts);
                await Task.Delay(TimeSpan.FromSeconds(attempt * 2), cancellationToken);
                continue;
            }
            throw new HttpRequestException(ReadError(response.Payload, response.StatusCode));
        }
    }

    private async Task<(HttpStatusCode StatusCode, bool IsSuccessStatusCode, string Payload)> SendAuthenticatedAsync(object body, CancellationToken cancellationToken)
    {
        var configuration = configStore.Load();
        using var request = CreateAuthenticatedRequest(configuration, body);
        using var response = await http.SendAsync(request, cancellationToken);
        return (response.StatusCode, response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync(cancellationToken));
    }

    private static HttpRequestMessage CreateAuthenticatedRequest(DeviceConfiguration configuration, object body)
    {
        var credential = DpapiProtector.Unprotect(configuration.EncryptedCredential);
        var request = CreateRequest(CreateFunctionUri(configuration.SupabaseUrl, "agent-api"), configuration.PublishableKey, credential);
        request.Content = JsonContent.Create(body, options: JsonOptions);
        return request;
    }

    private static HttpRequestMessage CreateRequest(Uri endpoint, string publishableKey, string? credential)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, endpoint);
        request.Headers.Add("apikey", publishableKey);
        if (!string.IsNullOrWhiteSpace(credential)) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credential);
        return request;
    }

    private static Uri CreateFunctionUri(string baseUrl, string functionName) => new($"{NormalizeSupabaseUrl(baseUrl)}/functions/v1/{functionName}");

    public static string NormalizeSupabaseUrl(string value)
    {
        if (!Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri)) throw new ArgumentException("Enter a valid Supabase URL.", nameof(value));
        var isLocalHttp = uri.Scheme == Uri.UriSchemeHttp &&
            (uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase) || IPAddress.TryParse(uri.Host, out var address) && IPAddress.IsLoopback(address));
        if (uri.Scheme != Uri.UriSchemeHttps && !isLocalHttp) throw new ArgumentException("Use HTTPS for a Supabase URL. HTTP is allowed only for local development.", nameof(value));
        return uri.GetLeftPart(UriPartial.Authority).TrimEnd('/');
    }

    private static string ReadError(string payload, HttpStatusCode statusCode)
    {
        try
        {
            using var document = JsonDocument.Parse(payload);
            if (document.RootElement.TryGetProperty("error", out var value) && value.ValueKind == JsonValueKind.String)
                return value.GetString() ?? $"Request failed (HTTP {(int)statusCode}).";
        }
        catch (JsonException) { }
        return $"Request failed (HTTP {(int)statusCode}).";
    }
}
