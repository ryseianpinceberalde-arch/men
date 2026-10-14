// Strict allowlist: device IDs come only from the authenticated credential, never this payload.
type Row = Record<string, unknown>;
const row = (v: unknown): Row => { if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Expected an object."); return v as Row; };
const text = (v: unknown, max = 200): string | null => v == null ? null : typeof v === "string" && v.length <= max ? v : fail("Invalid text.");
const fail = (message: string): never => { throw new Error(message); };
const number = (v: unknown, max = Number.MAX_SAFE_INTEGER): number | null => v == null ? null : typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : fail("Invalid measurement.");
const bool = (v: unknown) => v == null ? null : typeof v === "boolean" ? v : fail("Invalid flag.");
const choice = (v: unknown, values: string[]) => typeof v === "string" && values.includes(v) ? v : fail("Invalid status.");
const uuid = (v: unknown) => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v) ? v : fail("Invalid identifier.");
const list = (v: unknown, max: number) => Array.isArray(v) && v.length <= max ? v : fail("Invalid list.");
const timestamp = (v: unknown, now: number) => {
  const value = text(v, 40); const time = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(time) || time > now + 120_000 || time < now - 7 * 86400_000) return fail("Measurement timestamp outside the accepted seven-day window.");
  return new Date(time).toISOString();
};

export function cleanNetworkBatch(samples: unknown, speeds: unknown, now = Date.now()) {
  return {
    samples: list(samples, 60).map((v) => {
      const s = row(v);
      const adapters = list(s.adapters, 32).map((value) => {
        const a = row(value); const w = a.wifi == null ? null : row(a.wifi);
        return {
          id: text(a.id, 100) ?? fail("Adapter ID required."), name: text(a.name), type: choice(a.type, ["wifi", "ethernet", "other"]),
          status: choice(a.status, ["Up", "Down", "Testing", "Unknown", "Dormant", "NotPresent", "LowerLayerDown"]),
          mac_address: text(a.mac_address, 40), ipv4: list(a.ipv4, 32).map(v => text(v, 64)), ipv6: list(a.ipv6, 32).map(v => text(v, 100)),
          gateways: list(a.gateways, 16).map(v => text(v, 100)), dns_servers: list(a.dns_servers, 16).map(v => text(v, 100)),
          dhcp_enabled: bool(a.dhcp_enabled), link_mbps: number(a.link_mbps, 1_000_000),
          bytes_received: number(a.bytes_received), bytes_sent: number(a.bytes_sent), receive_bytes_per_second: number(a.receive_bytes_per_second), send_bytes_per_second: number(a.send_bytes_per_second), utilization_percent: number(a.utilization_percent, 100),
          wifi: w && { status: choice(w.status, ["connected", "disconnected", "disabled", "unknown"]), observed_at: w.observed_at == null ? null : timestamp(w.observed_at, now), ssid: text(w.ssid, 128), bssid: text(w.bssid, 40), signal_percent: number(w.signal_percent, 100), radio_type: text(w.radio_type, 30), band: w.band == null ? null : choice(w.band, ["2.4 GHz", "5 GHz", "6 GHz"]), channel: number(w.channel, 233), receive_link_mbps: number(w.receive_link_mbps, 1_000_000), transmit_link_mbps: number(w.transmit_link_mbps, 1_000_000), limitation: text(w.limitation, 300) },
        };
      });
      const p = s.probe == null ? null : row(s.probe);
      const probe = p && {
        tested_at: timestamp(p.tested_at, now), status: choice(p.status, ["online", "offline", "degraded", "unknown"]),
        reason: choice(p.reason, ["ok", "adapter_unavailable", "local_disconnected", "dns_failure", "gateway_unreachable", "internet_probe_failure", "partial_probe_failure"]),
        dns_ok: bool(p.dns_ok), gateway_reachable: bool(p.gateway_reachable), attempts: number(p.attempts, 10), successes: number(p.successes, 10),
        latency_ms: number(p.latency_ms, 60_000), jitter_ms: number(p.jitter_ms, 60_000), packet_loss_percent: number(p.packet_loss_percent, 100), method: text(p.method, 200),
      };
      if (probe && (probe.attempts == null || probe.successes == null || !Number.isInteger(probe.attempts) || !Number.isInteger(probe.successes) || probe.successes > probe.attempts)) fail("Invalid probe counts.");
      const primaryId = text(s.primary_adapter_id, 100);
      if (primaryId && !adapters.some(a => a.id === primaryId)) fail("Primary adapter is absent.");
      return { sample_id: uuid(s.sample_id), observed_at: timestamp(s.observed_at, now), connection_type: choice(s.connection_type, ["wifi", "ethernet", "other", "unknown"]), primary_adapter_id: primaryId, adapters, probe };
    }),
    speed_tests: list(speeds, 32).map((v) => {
      const s = row(v);
      const result = { test_id: uuid(s.test_id), tested_at: timestamp(s.tested_at, now), provider: text(s.provider), status: choice(s.status, ["completed", "failed"]), download_mbps: number(s.download_mbps, 1_000_000), upload_mbps: number(s.upload_mbps, 1_000_000), download_bytes: number(s.download_bytes, 10_100_000), upload_bytes: number(s.upload_bytes, 2_000_000), latency_ms: number(s.latency_ms, 60_000), jitter_ms: number(s.jitter_ms, 60_000), packet_loss_percent: number(s.packet_loss_percent, 100), error: text(s.error, 500) };
      if (result.status === "completed" && (result.download_mbps == null || result.upload_mbps == null || result.download_bytes !== 10_000_000 || result.upload_bytes !== 2_000_000)) fail("Completed speed test requires full measured transfers.");
      return result;
    }),
  };
}
