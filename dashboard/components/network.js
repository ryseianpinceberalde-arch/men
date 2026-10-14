import { supabase } from "../services/supabase.js";
import { invoke } from "../services/api.js";
import { escapeHtml as esc, formatBytes, formatDate, heading, dataTable, statusBadge, toast, showModal, field } from "./ui.js";
import { networkStatus, signalQuality, availability, numberLabel, chartRows } from "../services/network-metrics.js";

const filters = { computer: "", connection: "", status: "", hours: 24 };
let active = null;
export function disposeNetwork() { active?.dispose(); active = null; }
export function networkLoadError(error) {
  if (error?.code === "PGRST205" && /network_(settings|state|samples|events|outages|speed_tests)/i.test(error.message ?? "")) {
    return "Network monitoring has not been enabled in this Supabase project yet. Apply the network monitoring migration and deploy the updated agent-api function, then try again.";
  }
  return error?.message || "Please try again.";
}
export async function renderNetwork(content, view, profile) {
  if (active?.view === view && active.root.isConnected) return active.refresh();
  disposeNetwork();
  active = new NetworkView(content, view, profile);
  await active.refresh();
}

async function allRows(table, columns) {
  const rows = [];
  for (let start = 0; ; start += 500) {
    const { data, error } = await supabase.from(table).select(columns).order(table === "computers" ? "id" : "computer_id").range(start, start + 499);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 500) return rows;
  }
}
const setHtml = (element, html) => { if (element && element.innerHTML !== html) element.innerHTML = html; };
const date = value => value ? formatDate(value, true) : "Unavailable";
const details = values => `<dl class="network-details">${values.map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(value ?? "Unavailable")}</dd></div>`).join("")}</dl>`;

class NetworkView {
  constructor(content, view, profile) {
    this.view = view; this.profile = profile; this.charts = new Map(); this.abort = new AbortController(); this.revision = 0;
    this.rows = []; this.settings = {}; this.busy = null; this.disposed = false;
    const label = { network: "Network Overview", wifi: "Wi-Fi Monitoring", internet: "Internet Monitoring" }[view];
    content.innerHTML = `${heading(label, "Recorded network observations from your managed computers. Missing measurements remain unknown.", profile.role === "administrator" ? '<button class="btn btn-outline-secondary" data-network-settings>Network settings</button>' : "")}
      <div class="network-view"><div class="network-filters panel">
      <label>Computer<select class="form-select" data-network-filter="computer"><option value="">All computers</option></select></label>
      <label>Connection<select class="form-select" data-network-filter="connection"><option value="">All connections</option><option value="wifi">Wi-Fi</option><option value="ethernet">Ethernet</option><option value="other">Other / VPN</option><option value="unknown">Unknown</option></select></label>
      <label>Status<select class="form-select" data-network-filter="status"><option value="">All statuses</option>${["online", "offline", "degraded", "unknown", "agent_offline"].map(s => `<option value="${s}">${s.replaceAll("_", " ")}</option>`).join("")}</select></label>
      <label>History<select class="form-select" data-network-filter="hours"><option value="1">Last hour</option><option value="24">Last 24 hours</option><option value="168">Last 7 days</option><option value="720">Last 30 days</option></select></label></div>
      <p class="small text-secondary" data-network-message role="status">Loading network observations…</p>
      <div class="stat-grid network-summary"></div>
      <section class="panel mt-3"><div class="panel-title"><div><h3>Managed connections</h3><p>Select a computer for adapter details, events, and speed tests.</p></div></div>
      <div class="table-overflow"><table class="data-table"><thead><tr><th>Computer</th><th>Connection</th><th>Internet</th><th>Wi-Fi signal</th><th>Latency</th><th>Traffic ↓ / ↑</th><th>Last observation</th></tr></thead><tbody data-network-rows></tbody></table></div></section>
      <div class="network-chart-grid mt-3">${[["latency", "Internet latency (ICMP ms)"], ["signal", "Wi-Fi signal (%; connected adapter average)"], ["traffic", "Primary interface traffic (Mbps; includes local traffic)"], ["loss", "ICMP packet loss (%)"], ["availability", "Recorded check availability (%)"]].map(([key, title]) => `<section class="panel"><div class="panel-title"><h3>${title}</h3></div><div class="network-chart"><canvas data-network-chart="${key}" aria-label="${title}" role="img"></canvas></div></section>`).join("")}</div>
      <section class="panel mt-3"><div class="panel-title"><h3>Selected computer</h3><div class="d-flex gap-2">${profile.role === "administrator" ? '<button class="btn btn-outline-secondary btn-sm" data-network-command="GET_NETWORK_STATUS">Request fresh data</button><button class="btn btn-primary btn-sm" data-network-command="RUN_NETWORK_SPEED_TEST">Run speed test · 12 MB</button>' : ""}</div></div>
      <p data-network-command-status role="status" class="small text-secondary"></p><div data-network-detail>Select a computer to inspect its network.</div></section>
      <section class="panel mt-3"><h3>Recent network events</h3><div data-network-events></div></section>
      <section class="panel mt-3"><h3>Recorded outages</h3><p class="small text-secondary">Boundaries are observed probe times. Agent silence is unknown, and gaps can include unobserved recovery.</p><div data-network-outages></div></section>
      <section class="panel mt-3"><h3>Measured internet speed tests</h3><p class="small text-secondary">Manual by default. Bounded HTTPS transfers to Cloudflare measure this endpoint path, not maximum ISP capacity. Routine interface traffic above is a separate measurement.</p><div data-network-speeds></div></section></div>`;
    this.root = content.querySelector(".network-view");
    for (const control of this.root.querySelectorAll("[data-network-filter]")) {
      control.value = filters[control.dataset.networkFilter];
      control.addEventListener("change", () => { filters[control.dataset.networkFilter] = control.dataset.networkFilter === "hours" ? Number(control.value) : control.value; this.revision++; void this.refresh().catch(e => this.error(e)); }, { signal: this.abort.signal });
    }
    this.root.addEventListener("click", event => {
      const computer = event.target.closest("[data-network-computer]");
      const command = event.target.closest("[data-network-command]");
      if (computer) { filters.computer = computer.dataset.networkComputer; this.root.querySelector('[data-network-filter="computer"]').value = filters.computer; this.revision++; void this.refresh().catch(e => this.error(e)); }
      if (command) void this.command(command).catch(e => this.error(e));
    }, { signal: this.abort.signal });
    content.querySelector("[data-network-settings]")?.addEventListener("click", () => this.settingsDialog(), { signal: this.abort.signal });
    this.channel = supabase.channel(`network-${crypto.randomUUID()}`).on("postgres_changes", { event: "*", schema: "public", table: "network_state" }, () => {
      if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.refresh().catch(e => this.error(e)); }, 5000);
    }).subscribe();
    // Fallback also ages stale agents without requiring a realtime event.
    this.interval = setInterval(() => { if (!document.hidden) void this.refresh().catch(e => this.error(e)); }, 30_000);
  }
  error(error) { if (!this.disposed) this.root.querySelector("[data-network-message]").textContent = `Network data could not be refreshed: ${networkLoadError(error)}`; }
  async refresh() {
    if (this.disposed) return;
    if (this.busy) { await this.busy; if (this.loadedRevision !== this.revision && !this.disposed) return this.refresh(); return; }
    const revision = this.revision; const selected = { ...filters };
    this.busy = this.load(selected, revision);
    try { await this.busy; } finally { this.busy = null; }
    if (revision !== this.revision && !this.disposed) return this.refresh();
  }
  async load(selected, revision) {
    const start = new Date(Date.now() - selected.hours * 3600_000).toISOString();
    const bounded = (table, time) => { let query = supabase.from(table).select("*").gte(time, start).order(time, { ascending: false }).limit(100); if (selected.computer) query = query.eq("computer_id", selected.computer); return query; };
    const [computers, states, settings, history, events, outages, speeds, alerts, identifiers] = await Promise.all([
      allRows("computers", "id,computer_name,last_seen,enrollment_status"), allRows("network_state", "*"),
      supabase.from("network_settings").select("*").eq("id", true).single(),
      supabase.rpc("network_history", { target_computer: selected.computer || null, hours: selected.hours, connection: selected.connection, health: ["online", "offline", "degraded", "unknown"].includes(selected.status) ? selected.status : "" }),
      bounded("network_events", "observed_at"),
      (() => { let q = supabase.from("network_outages").select("*").or(`ended_at.is.null,ended_at.gte.${start}`).order("started_at", { ascending: false }).limit(100); return selected.computer ? q.eq("computer_id", selected.computer) : q; })(),
      bounded("network_speed_tests", "tested_at"),
      supabase.from("alerts").select("computer_id").like("alert_type", "network_%").in("status", ["Open", "Acknowledged"]),
      this.profile.role === "administrator" && selected.computer ? supabase.from("network_identifiers").select("adapters").eq("computer_id", selected.computer).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    for (const result of [settings, history, events, outages, speeds, alerts, identifiers]) if (result.error) throw result.error;
    if (this.disposed || revision !== this.revision) return;
    this.loadedRevision = revision; this.settings = settings.data;
    const byId = new Map(states.map(s => [s.computer_id, s]));
    this.rows = computers.map(c => ({ ...c, network: byId.get(c.id) }));
    const selector = this.root.querySelector('[data-network-filter="computer"]');
    const options = '<option value="">All computers</option>' + computers.map(c => `<option value="${esc(c.id)}">${esc(c.computer_name)}</option>`).join("");
    setHtml(selector, options); selector.value = selected.computer;
    const visible = this.rows.filter(c => (!selected.computer || c.id === selected.computer) && (!selected.connection || c.network?.connection_type === selected.connection || this.view === "wifi" && !c.network) && (!selected.status || networkStatus(c, this.settings) === selected.status) && (this.view !== "wifi" || !c.network || c.network.adapters?.some(a => a.type === "wifi")));
    this.updateRows(visible);
    const current = visible.filter(c => !["agent_offline", "unknown"].includes(networkStatus(c, this.settings)));
    const latencies = current.map(c => c.network?.probe?.latency_ms).filter(v => v != null);
    const latest = visible.map(c => c.network?.observed_at).filter(Boolean).sort().at(-1);
    const summary = [["Monitored computers", visible.length], ["Through Wi-Fi", current.filter(c => c.network?.connection_type === "wifi").length], ["Through Ethernet", current.filter(c => c.network?.connection_type === "ethernet").length], ["Internet access", current.filter(c => ["online", "degraded"].includes(c.network?.probe?.status)).length], ["Network problems", current.filter(c => ["offline", "degraded"].includes(c.network?.probe?.status) || c.network?.adapters?.some(a => a.wifi?.signal_percent != null && a.wifi.signal_percent < this.settings.signal_warning)).length], ["Average latency", numberLabel(latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null, "ms")], ["Active network alerts", alerts.data.filter(a => visible.some(c => c.id === a.computer_id)).length], ["Last observation", date(latest)]];
    setHtml(this.root.querySelector(".network-summary"), summary.map(([label, value]) => `<div class="stat-card"><span class="stat-label">${esc(label)}</span><div class="network-stat-value">${esc(value)}</div></div>`).join(""));
    const totals = availability(history.data);
    this.root.querySelector("[data-network-message]").textContent = visible.length > 0 && visible.every(c => !c.network)
      ? `${visible.length} computers shown, but no network readings have arrived yet. Make sure the updated agent is installed, paired, and running on each computer.`
      : `${visible.length} computers shown. Recorded check availability: ${numberLabel(totals.percent, "%")} (${totals.available}/${totals.checks}; ${totals.failed} failed checks). Unknown periods are excluded. ${selected.status === "agent_offline" ? "History shows recorded observations; current agent silence is not an internet outage." : "History follows computer, connection and probe-status filters."} Updated ${new Date().toLocaleTimeString()}.`;
    this.updateCharts(chartRows(history.data, selected.hours));
    const signalHistory = history.data.filter(r => r.signal != null);
    this.signalTrend = signalHistory.length < 2 ? "Unavailable" : numberLabel(signalHistory.at(-1).signal - signalHistory.at(-2).signal, "percentage points between latest history buckets");
    this.detail(this.rows.find(c => c.id === selected.computer), identifiers.data?.adapters ?? []);
    const names = new Map(computers.map(c => [c.id, c.computer_name]));
    const nameColumn = { label: "Computer", render: r => esc(names.get(r.computer_id) ?? "Managed computer") };
    setHtml(this.root.querySelector("[data-network-events]"), dataTable([nameColumn, { label: "Time", render: r => esc(date(r.observed_at)) }, { label: "Event", key: "kind" }, { label: "Details", key: "message" }], events.data, { emptyText: "No recorded network events in this period." }));
    setHtml(this.root.querySelector("[data-network-outages]"), dataTable([nameColumn, { label: "Start", render: r => esc(date(r.started_at)) }, { label: "End", render: r => esc(r.ended_at ? date(r.ended_at) : "No recovery recorded") }, { label: "Observed duration", render: r => r.ended_at ? `${Math.round((Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000)} s${r.observation_gap ? " (gap in observations)" : ""}` : "Unknown until next observation" }, { label: "Reason", key: "reason" }], outages.data));
    setHtml(this.root.querySelector("[data-network-speeds]"), dataTable([nameColumn, { label: "Time", render: r => esc(date(r.tested_at)) }, { label: "Status", render: r => statusBadge(r.result.status) }, ...[["Download", "download_mbps", "Mbps"], ["Upload", "upload_mbps", "Mbps"], ["Latency", "latency_ms", "ms"], ["Jitter", "jitter_ms", "ms"], ["Loss", "packet_loss_percent", "%"]].map(([label, key, unit]) => ({ label, render: r => esc(numberLabel(r.result[key], unit)) })), { label: "Method / error", render: r => esc(r.result.error || r.result.provider) }], speeds.data, { emptyText: "No measured speed tests in this period. Select a computer to run one." }));
    if (this.commandId) {
      const { data, error } = await supabase.from("commands").select("status,error_message").eq("id", this.commandId).maybeSingle();
      if (!error && data && !this.disposed) this.root.querySelector("[data-network-command-status]").textContent = `Agent request: ${data.status}${data.error_message ? ` — ${data.error_message}` : ""}`;
    }
  }
  updateRows(rows) {
    const tbody = this.root.querySelector("[data-network-rows]");
    for (const old of [...tbody.children]) if (!rows.some(c => c.id === old.dataset.id)) old.remove();
    for (const c of rows) {
      let tr = [...tbody.children].find(r => r.dataset.id === c.id);
      if (!tr) { tr = document.createElement("tr"); tr.dataset.id = c.id; for (let i = 0; i < 7; i++) tr.append(document.createElement("td")); tbody.append(tr); }
      const n = c.network; const primary = n?.adapters?.find(a => a.id === n.primary_adapter_id);
      const wifi = n?.adapters?.find(a => a.wifi?.status === "connected")?.wifi;
      const signal = wifi?.signal_percent;
      const stale = ["agent_offline", "unknown"].includes(networkStatus(c, this.settings));
      const cells = [`<button class="table-link" data-network-computer="${esc(c.id)}">${esc(c.computer_name)}</button>`, esc(n?.connection_type ?? "Unknown"), statusBadge(networkStatus(c, this.settings)), signal == null ? "Unavailable" : `<div class="network-signal"><meter min="0" max="100" value="${signal}" aria-label="Wi-Fi signal"></meter><span>${signal}% · ${esc(signalQuality(signal, this.settings.signal_categories))}${stale ? " (last observed)" : ""}</span></div>`, esc(numberLabel(n?.probe?.latency_ms, "ms")), `${primary?.receive_bytes_per_second == null ? "Unavailable" : esc(formatBytes(primary.receive_bytes_per_second)) + "/s"} / ${primary?.send_bytes_per_second == null ? "Unavailable" : esc(formatBytes(primary.send_bytes_per_second)) + "/s"}`, esc(date(n?.observed_at))];
      cells.forEach((html, i) => setHtml(tr.children[i], html));
    }
  }
  updateCharts(rows) {
    const labels = rows.map(r => new Date(r.bucket).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
    const metrics = { latency: [["Latency", r => r.latency]], signal: [["Signal", r => r.signal]], traffic: [["Receive", r => r.receive_bps == null ? null : r.receive_bps * 8 / 1e6], ["Send", r => r.send_bps == null ? null : r.send_bps * 8 / 1e6]], loss: [["Packet loss", r => r.loss]], availability: [["Availability", r => Number(r.checks) > 0 ? Number(r.available) / Number(r.checks) * 100 : null]] };
    for (const [key, series] of Object.entries(metrics)) {
      const data = { labels, datasets: series.map(([label, read], i) => ({ label, data: rows.map(read), borderColor: ["#3273f5", "#20a879"][i], backgroundColor: "transparent", borderWidth: 2, pointRadius: 0, tension: 0.18, spanGaps: false })) };
      const signature = JSON.stringify(data);
      let chart = this.charts.get(key);
      if (!chart) {
        chart = new Chart(this.root.querySelector(`[data-network-chart="${key}"]`), { type: "line", data, options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { intersect: false, mode: "index" }, plugins: { legend: { display: series.length > 1 } }, scales: { x: { ticks: { maxTicksLimit: 6 } }, y: { beginAtZero: true, ...(["signal", "loss", "availability"].includes(key) ? { max: 100 } : {}) } } } });
        this.charts.set(key, chart);
      } else if (chart.networkSignature !== signature) { chart.data = data; chart.update("none"); }
      chart.networkSignature = signature;
    }
  }
  detail(computer, identifiers) {
    const n = computer?.network; const canCommand = this.profile.role === "administrator" && n && networkStatus(computer, this.settings) !== "agent_offline";
    for (const b of this.root.querySelectorAll("[data-network-command]")) b.disabled = !canCommand;
    if (!computer) { setHtml(this.root.querySelector("[data-network-detail]"), "Select a computer to inspect its network."); return; }
    if (!n) { setHtml(this.root.querySelector("[data-network-detail]"), "This computer has not reported network readings yet. Install the updated agent, pair it with this dashboard, and make sure the Windows service is running."); return; }
    const probe = n.probe;
    const html = `<h4>${esc(computer.computer_name)}</h4>${details([["Internet status", networkStatus(computer, this.settings).replaceAll("_", " ")], ["Diagnosis", probe?.reason?.replaceAll("_", " ")], ["Signal trend", this.signalTrend], ["DNS resolution", probe?.dns_ok == null ? null : probe.dns_ok ? "Successful" : "Failed"], ["Gateway probe", probe?.gateway_reachable == null ? null : probe.gateway_reachable ? "Reachable" : "No ICMP reply; may be filtered"], ["Last successful test", date(n.last_success_at)], ["Probe time", date(probe?.tested_at)], ["Jitter", numberLabel(probe?.jitter_ms, "ms")], ["Packet loss", numberLabel(probe?.packet_loss_percent, "%")], ["Probe method", probe?.method]])}
      ${n.adapters.map(a => {
        const w = a.wifi; const privateData = identifiers.find(i => i.id === a.id);
        return `<article class="network-adapter"><h4>${esc(a.name)} <small class="text-secondary">${esc(a.type)} · ${esc(a.status)}</small></h4>${details([["IPv4", a.ipv4?.join(", ") || null], ["IPv6", a.ipv6?.join(", ") || null], ["Gateway", a.gateways?.join(", ") || null], ["DNS servers", a.dns_servers?.join(", ") || null], ["DHCP", a.dhcp_enabled == null ? null : a.dhcp_enabled ? "Enabled" : "Disabled"], ...(this.profile.role === "administrator" ? [["MAC", privateData?.mac_address], ["Access point BSSID", privateData?.bssid]] : []), ["Link speed", numberLabel(a.link_mbps, "Mbps")], ["Bytes received (OS counter)", a.bytes_received == null ? null : formatBytes(a.bytes_received)], ["Bytes sent (OS counter)", a.bytes_sent == null ? null : formatBytes(a.bytes_sent)], ["Interface utilization (busiest direction)", numberLabel(a.utilization_percent, "%")], ...(w ? [["Wi-Fi status", w.status], ["Last signal observation", date(w.observed_at)], ["SSID", w.ssid], ["Signal", `${numberLabel(w.signal_percent, "%")} · ${signalQuality(w.signal_percent, this.settings.signal_categories)}`], ["Radio", w.radio_type], ["Band", w.band], ["Channel", w.channel], ["Receive / transmit link", `${numberLabel(w.receive_link_mbps, "Mbps")} / ${numberLabel(w.transmit_link_mbps, "Mbps")}`], ["Collection note", w.limitation]] : [])])}</article>`;
      }).join("")}<p class="small text-secondary">Last observation: ${esc(date(n.observed_at))}. ${n.adapters.some(a => a.type === "wifi") ? "Wi-Fi details depend on driver support and Windows privacy permissions." : "No wireless adapter was reported."} Check adapter state, gateway, and DNS results before testing the internet path. Counters reset with the operating system or adapter; link speed is not measured internet speed.</p>`;
    setHtml(this.root.querySelector("[data-network-detail]"), html);
  }
  async command(button) {
    if (button.disabled || !filters.computer) return;
    button.disabled = true;
    try {
      const result = await invoke("admin-api", { action: "network_command", computer_id: filters.computer, command_type: button.dataset.networkCommand, request_id: crypto.randomUUID() });
      this.commandId = result.command_id;
      this.root.querySelector("[data-network-command-status]").textContent = "Queued. Waiting for the managed agent; results appear when telemetry arrives.";
      toast("Network request queued.");
    } finally { if (!this.disposed) button.disabled = false; }
  }
  settingsDialog() {
    const config = this.settings;
    const specs = [["signal_warning", "Low signal threshold (%)", 0, 100], ["latency_warning", "High latency (ms)", 1, 60000], ["packet_loss_warning", "High packet loss (%)", 1, 100], ["poor_seconds", "Sustained degradation (seconds)", 30, 3600], ["cooldown_seconds", "Alert cooldown (seconds)", 60, 86400], ["repeated_disconnects", "Disconnections per hour", 2, 100], ["wifi_seconds", "Wi-Fi sampling (seconds)", 10, 300], ["probe_seconds", "Connectivity checks (seconds)", 30, 300], ["bandwidth_seconds", "Counter sampling (seconds)", 5, 60], ["speed_interval_hours", "Scheduled speed tests (hours; 0 = manual only)", 0, 168], ["retention_days", "Network history retention (days)", 30, 365]];
    showModal({ title: "Network settings", large: true, body: `<p>Speed-test scheduling applies to reporting computers. Each test transfers up to 12 MB plus protocol overhead. Signal categories are configurable UI labels.</p><div class="settings-grid">${specs.map(([key, label, min, max]) => field(label, key, { type: "number", value: config[key], min, max, step: 1, required: true })).join("")}${["Weak starts at", "Fair starts at", "Good starts at", "Excellent starts at"].map((label, i) => field(`${label} (%)`, `signal_${i}`, { type: "number", value: config.signal_categories[i], min: 1, max: 100, step: 1, required: true })).join("")}</div>`, onSubmit: async form => {
      const update = Object.fromEntries(specs.map(([key, , min, max]) => { const value = Number(form.get(key)); if (!Number.isInteger(value) || value < min || value > max) throw new Error("Enter valid whole-number settings."); return [key, value]; }));
      update.signal_categories = [0, 1, 2, 3].map(i => Number(form.get(`signal_${i}`)));
      if (update.bandwidth_seconds > Math.min(update.wifi_seconds, update.probe_seconds)) throw new Error("Counter sampling must be at least as frequent as Wi-Fi and connectivity sampling.");
      if (update.signal_categories.some((v, i, values) => !Number.isInteger(v) || v < 1 || v > 100 || i > 0 && v <= values[i - 1])) throw new Error("Signal category thresholds must increase.");
      const { error } = await supabase.from("network_settings").update(update).eq("id", true); if (error) throw error;
      toast("Network settings saved. Agents receive settings on their next successful upload."); await this.refresh();
    } });
  }
  dispose() { this.disposed = true; this.abort.abort(); clearInterval(this.interval); clearTimeout(this.timer); void supabase.removeChannel(this.channel); for (const chart of this.charts.values()) chart.destroy(); }
}
