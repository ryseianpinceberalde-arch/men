using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using PCMaintenance.Agent.Models;

namespace PCMaintenance.Agent.Collectors;

public sealed class SpeedTestService(NetworkService network)
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private DateTimeOffset _lastTest = DateTimeOffset.MinValue;
    public async Task<SpeedSnapshot> RunAsync(NetworkSettings settings, CancellationToken token)
    {
        if (!await _gate.WaitAsync(0, token)) throw new InvalidOperationException("A speed test is already running.");
        try
        {
            if (DateTimeOffset.UtcNow - _lastTest < TimeSpan.FromMinutes(15)) throw new InvalidOperationException("Wait 15 minutes between bandwidth tests.");
            _lastTest = DateTimeOffset.UtcNow;
            var id = Guid.NewGuid(); var at = _lastTest;
            double? download = null, upload = null;
            long downloaded = 0, uploaded = 0;
            var probe = await network.ProbeAsync(network.Collect(false), settings, token);
            using var http = new HttpClient(new SocketsHttpHandler { AllowAutoRedirect = false, AutomaticDecompression = DecompressionMethods.None }) { Timeout = TimeSpan.FromSeconds(35) };
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token); timeout.CancelAfter(TimeSpan.FromSeconds(65));
            const int downloadSize = 10_000_000, uploadSize = 2_000_000;
            try
            {
                var timer = Stopwatch.StartNew();
                using (var response = await http.GetAsync($"https://speed.cloudflare.com/__down?bytes={downloadSize}", HttpCompletionOption.ResponseHeadersRead, timeout.Token))
                {
                    response.EnsureSuccessStatusCode();
                    await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
                    var buffer = new byte[65536]; int length;
                    while ((length = await stream.ReadAsync(buffer, timeout.Token)) > 0)
                    {
                        downloaded += length;
                        if (downloaded > downloadSize) throw new HttpRequestException("Unexpected speed-test response size.");
                    }
                    if (downloaded != downloadSize) throw new HttpRequestException("Incomplete speed-test download.");
                }
                download = downloaded * 8d / timer.Elapsed.TotalSeconds / 1_000_000;
                using var content = new ByteArrayContent(RandomNumberGenerator.GetBytes(uploadSize));
                content.Headers.ContentType = new("application/octet-stream");
                timer.Restart();
                using var uploadResponse = await http.PostAsync("https://speed.cloudflare.com/__up", content, timeout.Token);
                uploadResponse.EnsureSuccessStatusCode();
                uploaded = uploadSize;
                upload = uploaded * 8d / timer.Elapsed.TotalSeconds / 1_000_000;
                return new(id, at, "Cloudflare HTTPS bounded transfer (10 MB down / 2 MB up)", "completed", download, upload, downloaded, uploaded, probe.LatencyMs, probe.JitterMs, probe.PacketLossPercent, null);
            }
            catch (Exception ex) when (ex is HttpRequestException || ex is OperationCanceledException && !token.IsCancellationRequested)
            {
                return new(id, at, "Cloudflare HTTPS bounded transfer (10 MB down / 2 MB up)", "failed", download, upload, downloaded, uploaded, probe.LatencyMs, probe.JitterMs, probe.PacketLossPercent, "Transfer failed or timed out; partial results are not a completed speed test.");
            }
        }
        finally { _gate.Release(); }
    }
}
