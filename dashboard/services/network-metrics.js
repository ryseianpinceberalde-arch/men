export function numberLabel(value, unit = "") {
  return value == null || !Number.isFinite(Number(value)) ? "Unavailable" : `${Number(value).toFixed(1)}${unit === "%" ? "" : " "}${unit}`.trim();
}
export function signalQuality(value, categories = [20, 40, 60, 80]) {
  if (value == null) return "Unavailable";
  return ["Very weak", "Weak", "Fair", "Good", "Excellent"][categories.filter(threshold => value >= threshold).length];
}
export function networkStatus(computer, settings = {}, now = Date.now()) {
  if (computer.enrollment_status !== "active" || !computer.last_seen || now - Date.parse(computer.last_seen) > 180_000) return "agent_offline";
  const network = computer.network;
  if (!network || now - Date.parse(network.observed_at) > Math.max(90, (settings.wifi_seconds || 10) * 3) * 1000 || !network.probe || now - Date.parse(network.probe.tested_at) > Math.max(90, (settings.probe_seconds || 30) * 3) * 1000) return "unknown";
  return network.probe.status ?? "unknown";
}
export function availability(rows) {
  const totals = rows.reduce((sum, r) => ({ checks: sum.checks + Number(r.checks), available: sum.available + Number(r.available), failed: sum.failed + Number(r.failed) }), { checks: 0, available: 0, failed: 0 });
  return { ...totals, percent: totals.checks ? totals.available / totals.checks * 100 : null };
}

// Preserve visible gaps between recorded buckets; null is never a synthetic measurement.
export function chartRows(rows, hours) {
  const step = (hours <= 1 ? 30 : hours <= 24 ? 300 : hours <= 168 ? 3600 : 14400) * 1000;
  return rows.flatMap((row, index) => index && Date.parse(row.bucket) - Date.parse(rows[index - 1].bucket) > step * 1.5
    ? [{ bucket: new Date(Date.parse(rows[index - 1].bucket) + step).toISOString(), signal: null, receive_bps: null, send_bps: null, latency: null, loss: null, checks: 0, available: 0 }, row] : [row]);
}
