import { cleanNetworkBatch } from "./network.ts";
function assert(value: unknown, message = "Assertion failed") { if (!value) throw new Error(message); }
function rejects(action: () => unknown) { let failed = false; try { action(); } catch { failed = true; } assert(failed, "Expected invalid telemetry to be rejected"); }
const now = Date.now();
const sample = () => ({ sample_id: crypto.randomUUID(), observed_at: new Date(now).toISOString(), connection_type: "unknown", primary_adapter_id: null, adapters: [], probe: null });
Deno.test("unknown observations preserve nulls and exclude untrusted fields", () => {
  const clean = cleanNetworkBatch([{ ...sample(), computer_id: crypto.randomUUID(), password: "never-store" }], [], now);
  assert(clean.samples[0].probe === null); assert(!("computer_id" in clean.samples[0])); assert(!("password" in clean.samples[0]));
});
Deno.test("timestamps, identifiers and batch bounds", () => {
  rejects(() => cleanNetworkBatch([{ ...sample(), sample_id: "bad" }], [], now));
  rejects(() => cleanNetworkBatch([{ ...sample(), observed_at: new Date(now + 300_000).toISOString() }], [], now));
  rejects(() => cleanNetworkBatch([{ ...sample(), observed_at: new Date(now - 8 * 86400_000).toISOString() }], [], now));
  rejects(() => cleanNetworkBatch(Array.from({ length: 61 }, sample), [], now));
  rejects(() => cleanNetworkBatch([sample()], Array(33).fill({}), now));
});
Deno.test("probe counts and nullable metrics cannot become invented zero measurements", () => {
  const probe = { tested_at: new Date(now).toISOString(), status: "online", reason: "ok", dns_ok: true, gateway_reachable: null, attempts: 2, successes: 2, latency_ms: null, jitter_ms: null, packet_loss_percent: null, method: "test fixture" };
  assert(cleanNetworkBatch([{ ...sample(), probe }], [], now).samples[0].probe?.latency_ms === null);
  for (const change of [{ successes: 3 }, { attempts: 1.5 }, { latency_ms: -1 }, { latency_ms: "12" }, { packet_loss_percent: 101 }, { status: "fabricated" }]) rejects(() => cleanNetworkBatch([{ ...sample(), probe: { ...probe, ...change } }], [], now));
});
Deno.test("adapter fields are bounded and allowlisted", () => {
  const adapter = { id: "adapter", name: "Wi-Fi", type: "wifi", status: "Up", mac_address: null, ipv4: [], ipv6: [], gateways: [], dns_servers: [], dhcp_enabled: null, wifi: { status: "connected", signal_percent: 0, password: "never-store" } };
  const cleaned = cleanNetworkBatch([{ ...sample(), adapters: [adapter] }], [], now).samples[0];
  assert(cleaned.adapters[0].wifi?.signal_percent === 0); assert(!("password" in cleaned.adapters[0].wifi!));
  rejects(() => cleanNetworkBatch([{ ...sample(), primary_adapter_id: "other", adapters: [adapter] }], [], now));
  rejects(() => cleanNetworkBatch([{ ...sample(), adapters: [{ ...adapter, wifi: { status: "connected", signal_percent: 101 } }] }], [], now));
});
Deno.test("failed transfers cannot masquerade as completed speed measurements", () => {
  const speed = { test_id: crypto.randomUUID(), tested_at: new Date(now).toISOString(), status: "failed", download_bytes: 100, upload_bytes: 0 };
  assert(cleanNetworkBatch([], [speed], now).speed_tests[0].download_mbps === null);
  rejects(() => cleanNetworkBatch([], [{ ...speed, status: "completed" }], now));
  const complete = { ...speed, status: "completed", download_bytes: 10_000_000, upload_bytes: 2_000_000, download_mbps: 10, upload_mbps: 2 };
  assert(cleanNetworkBatch([], [complete], now).speed_tests[0].status === "completed");
});
