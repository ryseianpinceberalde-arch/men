import { supabase, configurationError } from "./services/supabase.js";
import { invoke, recordActivity, safeSearch, latestStatusFor, listTechnicians } from "./services/api.js";
import { escapeHtml, formatBytes, formatDate, formatUptime, statusBadge, heading, emptyState, dataTable, tablePanel, toast, showModal, field, downloadCsv } from "./components/ui.js";

const content = document.querySelector("#page-content");
const state = { user: null, profile: null, view: "dashboard", detailId: null, detailTab: "overview", realtime: null, chart: null, searchTimer: null, evaluationTimer: null, list: { page: 1, pageSize: 10, search: "", filter: "", sort: "created_at", ascending: false, rows: [] }, lists: {} };
const roleNames = { administrator: "Administrator", technician: "Technician", viewer: "Viewer" };
const maintenanceTypes = ["Preventive Maintenance", "Corrective Maintenance", "Hardware Maintenance", "Software Maintenance", "Network Maintenance", "Security Maintenance"];
const processDenylist = new Set(["system", "system idle process", "smss.exe", "csrss.exe", "wininit.exe", "services.exe", "lsass.exe", "winlogon.exe", "svchost.exe"]);
const serviceDenylist = new Set(["rpcss", "dcomlaunch", "eventlog", "wininit", "winmgmt", "windefend", "mpssvc", "plugplay", "samss"]);
const navItems = [
  { id: "dashboard", label: "Dashboard", icon: "bi-grid-1x2" },
  { section: "FLEET" },
  { id: "computers", label: "Computers", icon: "bi-pc-display-horizontal" },
  { id: "hardware", label: "Hardware Inventory", icon: "bi-cpu" },
  { id: "software", label: "Software Inventory", icon: "bi-box-seam", adminTech: true },
  { section: "SERVICE DESK" },
  { id: "maintenance", label: "Maintenance", icon: "bi-wrench-adjustable" },
  { id: "schedules", label: "Maintenance Schedule", icon: "bi-calendar3", adminTech: true },
  { id: "problems", label: "Troubleshooting", icon: "bi-bug", adminTech: true },
  { section: "OVERSIGHT", adminTech: true },
  { id: "alerts", label: "Alerts", icon: "bi-bell", adminTech: true },
  { id: "activity", label: "Activity Logs", icon: "bi-journal-text", adminOnly: true },
  { id: "reports", label: "Reports", icon: "bi-file-earmark-bar-graph", adminTech: true },
  { id: "users", label: "Users", icon: "bi-people", adminOnly: true },
  { id: "settings", label: "Settings", icon: "bi-sliders", adminOnly: true },
  { section: "" },
  { id: "logout", label: "Sign out", icon: "bi-box-arrow-left" },
];

function renderNav() {
  const isAdmin = state.profile?.role === "administrator";
  const isTech = state.profile?.role === "technician";
  document.querySelector("#side-nav").innerHTML = navItems.map((item) => {
    if (item.section !== undefined) return item.section ? `<div class="nav-section">${escapeHtml(item.section)}</div>` : "";
    if (item.adminOnly && !isAdmin) return "";
    if (item.adminTech && !isAdmin && !isTech) return "";
    const active = state.view === item.id || (state.view === "computer-detail" && item.id === "computers");
    return `<a class="side-link ${active ? "active" : ""}" href="#${escapeHtml(item.id)}" data-view="${escapeHtml(item.id)}"><i class="bi ${escapeHtml(item.icon)}"></i><span>${escapeHtml(item.label)}</span></a>`;
  }).join("");
}

function showAuth(message = "") {
  document.querySelector("#app-screen").classList.add("d-none");
  document.querySelector("#auth-screen").classList.remove("d-none");
  const box = document.querySelector("#auth-message");
  if (message) { box.textContent = message; box.className = "alert alert-warning"; }
  else { box.textContent = ""; box.className = "alert d-none"; }
}

async function activateSession(user) {
  if (!user) {
    state.user = null;
    state.profile = null;
    state.realtime?.unsubscribe();
    state.realtime = null;
    clearInterval(state.evaluationTimer);
    state.evaluationTimer = null;
    if (state.chart) { state.chart.destroy(); state.chart = null; }
    showAuth();
    return;
  }
  state.user = user;
  const { data, error } = await supabase.from("profiles").select("id, full_name, role, status").eq("id", user.id).maybeSingle();
  if (error) { showAuth(`Unable to load your user profile: ${error.message}`); return; }
  if (!data || data.status !== "active") {
    await supabase.auth.signOut();
    showAuth("This account is not active. Contact an administrator.");
    return;
  }
  state.profile = data;
  document.querySelector("#auth-screen").classList.add("d-none");
  document.querySelector("#app-screen").classList.remove("d-none");
  document.querySelector("#user-name").textContent = data.full_name || user.email || "User";
  document.querySelector("#user-role").textContent = roleNames[data.role] ?? "Viewer";
  document.querySelector("#user-avatar").textContent = (data.full_name || user.email || "U").trim().charAt(0).toUpperCase();
  renderNav();
  listenRealtime();
  if (data.role === "administrator") {
    void invoke("evaluate-alerts").catch(() => {});
    state.evaluationTimer = setInterval(() => void invoke("evaluate-alerts").catch(() => {}), 60_000);
  }
  await navigate(readHashView());
}

function readHashView() {
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash.startsWith("computer/")) {
    const [id, tab] = hash.slice("computer/".length).split("/");
    state.detailId = id || null;
    state.detailTab = tab || "overview";
    return "computer-detail";
  }
  const requested = hash.split("/")[0];
  const valid = navItems.filter((item) => item.id).map((item) => item.id);
  return valid.includes(requested) ? requested : "dashboard";
}

async function navigate(view, { push = true } = {}) {
  const isAdmin = state.profile?.role === "administrator";
  const isTech = state.profile?.role === "technician";
  if (view === "logout") return logout();
  if (state.profile?.role === "viewer" && ["software", "schedules", "problems", "alerts", "activity", "reports", "users", "settings"].includes(view)) view = "dashboard";
  if (["users", "settings", "activity"].includes(view) && !isAdmin) view = "dashboard";
  if (["alerts", "reports"].includes(view) && !isAdmin && !isTech) view = "dashboard";
  state.view = view;
  renderNav();
  if (push) {
    const hash = view === "computer-detail" ? `#computer/${encodeURIComponent(state.detailId ?? "")}/${encodeURIComponent(state.detailTab)}` : `#${view}`;
    if (location.hash !== hash) history.pushState(null, "", hash);
  }
  const label = view === "computer-detail" ? "Computer details" : navItems.find((item) => item.id === view)?.label ?? "Dashboard";
  document.querySelector("#page-crumb").textContent = label;
  document.querySelector("#sidebar").classList.remove("open");
  document.querySelector(".mobile-shade")?.classList.remove("show");
  if (state.chart) { state.chart.destroy(); state.chart = null; }
  content.innerHTML = `<section class="panel"><div class="skeleton" style="width:180px"></div><div class="skeleton mt-3" style="height:130px"></div></section>`;
  try {
    if (view === "dashboard") await renderDashboard();
    else if (view === "computers") await renderComputers();
    else if (view === "computer-detail") await renderComputerDetail();
    else if (view === "users") await renderUsers();
    else if (view === "settings") await renderSettings();
    else if (view === "reports") renderReports();
    else if (view === "hardware") await renderHardware();
    else if (recordConfigs[view]) await renderRecords(view);
    else await renderDashboard();
  } catch (error) {
    content.innerHTML = `${heading(label, "We could not load this view.")}<div class="error-block">${escapeHtml(error.message || "Please try again.")}</div><button class="btn btn-outline-secondary mt-3" data-action="refresh">Try again</button>`;
  }
}

async function logout() {
  try { await recordActivity("LOGOUT", "Signed out of the management dashboard."); } catch { /* Continue sign-out if the audit service is temporarily unavailable. */ }
  await supabase.auth.signOut();
}

function listenRealtime() {
  if (state.realtime) return;
  const watched = ["computers", "computer_status", "alerts", "commands", "maintenance_records", "maintenance_schedules"];
  let timer;
  let builder = supabase.channel(`dashboard-${state.user.id}`);
  for (const table of watched) builder = builder.on("postgres_changes", { event: "*", schema: "public", table }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (state.view === "dashboard" || state.view === "computers" || state.view === "computer-detail" || ["alerts", "maintenance", "schedules"].includes(state.view)) void navigate(state.view, { push: false });
    }, 500);
  });
  state.realtime = builder.subscribe((status) => {
    const label = document.querySelector(".connection-status span:last-child");
    if (label && status === "SUBSCRIBED") label.textContent = "Supabase connected";
    if (label && status === "CHANNEL_ERROR") label.textContent = "Connection interrupted";
  });
}

async function renderDashboard() {
  const isViewer = state.profile.role === "viewer";
  const currentThreshold = new Date(Date.now() - 5 * 60_000).toISOString();
  const [metricResult, computerResult, statusResult, maintenanceResult] = await Promise.all([
    supabase.rpc("dashboard_metrics"),
    supabase.from("computers").select("id, device_id, computer_name, os_name, status, last_seen, enrollment_status").order("computer_name").limit(6),
    supabase.from("computer_status").select("computer_id, cpu_usage, ram_usage, disk_usage, uptime, recorded_at").gte("recorded_at", currentThreshold).order("recorded_at", { ascending: false }).limit(500),
    supabase.from("maintenance_records").select("id, computer_id, maintenance_type, maintenance_date, status, computers(computer_name)").order("maintenance_date", { ascending: false }).limit(6),
  ]);
  if (metricResult.error) throw metricResult.error;
  if (computerResult.error) throw computerResult.error;
  if (statusResult.error) throw statusResult.error;
  if (maintenanceResult.error) throw maintenanceResult.error;
  const summary = metricResult.data ?? {};
  const computers = computerResult.data ?? [];
  const statuses = statusResult.data ?? [];
  const maintenance = maintenanceResult.data ?? [];
  const totalComputers = Number(summary.total_computers ?? 0);
  const online = Number(summary.online_computers ?? 0);
  const offline = Number(summary.offline_computers ?? 0);
  const overdueCount = Number(summary.overdue_maintenance ?? 0);
  let upcoming = [];
  let recentActivity = [];
  const criticalCount = Number(summary.critical_alerts ?? 0);
  const storageAlertCount = Number(summary.storage_alerts ?? 0);
  const averageCpu = Number(summary.average_cpu ?? 0);
  const averageRam = Number(summary.average_ram ?? 0);
  const averageDisk = Number(summary.average_disk ?? 0);
  let alerts = [];
  if (!isViewer) {
    const [alertResult, upcomingResult, activityResult] = await Promise.all([
      supabase.from("alerts").select("id, computer_id, severity, message, created_at, status, computers(computer_name)").in("status", ["Open", "Acknowledged"]).order("created_at", { ascending: false }).limit(6),
      supabase.from("maintenance_schedules").select("id, computer_id, maintenance_type, scheduled_date, priority, status, computers(computer_name)").eq("status", "Scheduled").gte("scheduled_date", new Date().toISOString().slice(0, 10)).order("scheduled_date").limit(5),
      state.profile.role === "administrator" ? supabase.from("activity_logs").select("id, action, description, result, created_at, profiles(full_name)").order("created_at", { ascending: false }).limit(6) : Promise.resolve({ data: [], error: null }),
    ]);
    if (alertResult.error) throw alertResult.error;
    if (upcomingResult.error) throw upcomingResult.error;
    if (activityResult.error) throw activityResult.error;
    alerts = alertResult.data ?? [];
    upcoming = upcomingResult.data ?? [];
    recentActivity = activityResult.data ?? [];
    document.querySelector("#notification-dot").classList.toggle("d-none", !alerts.length);
  }
  const card = (label, number, icon, color, caption) => `<div class="stat-card"><div class="stat-top"><span class="stat-label">${escapeHtml(label)}</span><span class="stat-icon ${color}"><i class="bi ${icon}"></i></span></div><div class="stat-number">${number}</div><div class="stat-foot">${caption}</div></div>`;
  const metricCards = isViewer
    ? [card("Total computers", totalComputers, "bi-pc-display-horizontal", "icon-blue", `${online} currently reporting`), card("Online", online, "bi-check-circle", "icon-green", "Healthy connection status"), card("Offline", offline, "bi-wifi-off", "icon-amber", "Awaiting agent heartbeat"), card("Avg. CPU usage", `${averageCpu.toFixed(0)}%`, "bi-cpu", "icon-blue", `Avg. RAM ${averageRam.toFixed(0)}%`)]
    : [card("Total computers", totalComputers, "bi-pc-display-horizontal", "icon-blue", `${online} reporting now`), card("Online", online, "bi-check-circle", "icon-green", "Healthy connection status"), card("Offline", offline, "bi-wifi-off", "icon-amber", "Awaiting agent heartbeat"), card("Needs maintenance", overdueCount, "bi-calendar-x", "icon-amber", "Overdue schedules"), card("Critical alerts", criticalCount, "bi-exclamation-octagon", "icon-red", "Open or acknowledged"), card("Average CPU", `${averageCpu.toFixed(0)}%`, "bi-cpu", "icon-blue", "Current fleet average"), card("Average RAM", `${averageRam.toFixed(0)}%`, "bi-memory", "icon-green", "Current fleet average"), card("Storage alerts", storageAlertCount, "bi-device-hdd", "icon-amber", "Nearly full computers")];
  const visibleRows = computers.slice(0, 6);
  const computerColumns = [
    { label: "COMPUTER", render: (row) => `<div class="computer-name"><span class="computer-icon"><i class="bi bi-pc-display"></i></span><span><button class="table-link" data-action="open-computer" data-id="${escapeHtml(row.id)}">${escapeHtml(row.computer_name)}</button><small>${escapeHtml(row.device_id)}</small></span></div>` },
    { label: "OPERATING SYSTEM", render: (row) => escapeHtml(row.os_name || "Pending agent connection") },
    { label: "STATUS", render: (row) => statusBadge(row.status === "online" && row.enrollment_status === "active" ? "Online" : row.enrollment_status === "revoked" ? "Revoked" : row.status) },
    { label: "LAST SEEN", render: (row) => escapeHtml(relativeTime(row.last_seen)) },
  ];
  const maintenanceRows = (maintenance ?? []).map((row) => ({ ...row, computer: relationName(row.computers) }));
  const health = `<section class="panel"><div class="panel-title"><div><h3>System health</h3><p>Current fleet averages</p></div><i class="bi bi-activity text-primary"></i></div><div class="health-list">${healthMetric("CPU usage", averageCpu, "Across reporting computers", "progress-blue")}${healthMetric("Memory usage", averageRam, "Across reporting computers", "progress-green")}${healthMetric("Disk capacity", averageDisk, "Average storage in use", "progress-amber")}${!isViewer ? healthMetric("Open alerts", alerts.length, "Requires attention", alerts.some((item) => item.severity === "Critical") ? "progress-red" : "progress-amber", 100) : ""}</div></section>`;
  const alertPanel = `<section class="table-card"><div class="panel-heading-row"><div><h3>Attention required</h3><small>Active alerts across your fleet</small></div><button class="mini-link" data-view="alerts">View all <i class="bi bi-arrow-right"></i></button></div>${dataTable([{ label: "ALERT", render: (row) => `<span class="${row.severity === "Critical" ? "text-danger" : "text-warning"}"><i class="bi bi-exclamation-circle me-1"></i>${escapeHtml(row.message)}</span>` }, { label: "COMPUTER", render: (row) => escapeHtml(relationName(row.computers)) }, { label: "AGE", render: (row) => escapeHtml(relativeTime(row.created_at)) }], alerts, { emptyTitle: "All clear", emptyText: "There are no active fleet alerts.", icon: "bi-check-circle" })}</section>`;
  const maintenancePanel = `<section class="table-card"><div class="panel-heading-row"><div><h3>Recent maintenance</h3><small>Latest service records</small></div><button class="mini-link" data-view="maintenance">View records <i class="bi bi-arrow-right"></i></button></div>${dataTable([{ label: "COMPUTER", render: (row) => escapeHtml(relationName(row.computers)) }, { label: "MAINTENANCE TYPE", render: (row) => escapeHtml(row.maintenance_type) }, { label: "DATE", render: (row) => escapeHtml(formatDate(row.maintenance_date)) }, { label: "STATUS", render: (row) => statusBadge(row.status) }], maintenanceRows, { emptyTitle: "No maintenance records", emptyText: "Plan and record the work performed on your computers." })}</section>`;
  const upcomingPanel = !isViewer ? `<section class="table-card mt-3"><div class="panel-heading-row"><div><h3>Upcoming maintenance</h3><small>Scheduled work on your computers</small></div><button class="mini-link" data-view="schedules">View schedule <i class="bi bi-arrow-right"></i></button></div>${dataTable([{ label: "DATE", render: (row) => escapeHtml(formatDate(row.scheduled_date)) }, { label: "COMPUTER", render: (row) => escapeHtml(relationName(row.computers)) }, { label: "TYPE", key: "maintenance_type" }, { label: "PRIORITY", render: (row) => statusBadge(row.priority) }], upcoming, { emptyTitle: "No upcoming maintenance", emptyText: "Schedules will appear here when created.", icon: "bi-calendar3" })}</section>` : "";
  const activityPanel = state.profile.role === "administrator" ? `<section class="table-card mt-3"><div class="panel-heading-row"><div><h3>Recent administrator activity</h3><small>Latest audit events</small></div><button class="mini-link" data-view="activity">View activity log <i class="bi bi-arrow-right"></i></button></div>${dataTable([{ label: "TIME", render: (row) => escapeHtml(relativeTime(row.created_at)) }, { label: "USER", render: (row) => escapeHtml(relationName(row.profiles) || "System") }, { label: "ACTION", key: "action" }, { label: "RESULT", render: (row) => statusBadge(row.result) }], recentActivity, { emptyTitle: "No recent activity", emptyText: "Administrator activity will appear here." })}</section>` : "";
  const secondary = isViewer ? maintenancePanel : alertPanel;
  content.innerHTML = `${heading(`Good ${greeting()}, ${state.profile.full_name?.split(" ")[0] || "there"}`, "Here’s your organization’s device health at a glance.", `<button class="btn btn-outline-secondary" data-action="refresh"><i class="bi bi-arrow-clockwise me-1"></i>Refresh</button>${state.profile.role === "administrator" ? '<button class="btn btn-primary" data-action="add-computer"><i class="bi bi-plus-lg me-1"></i>Add computer</button>' : ""}`, "OVERVIEW / LIVE FLEET")}<div class="stat-grid">${metricCards.join("")}</div><div class="content-grid"><section class="panel"><div class="panel-title"><div><h3>Fleet activity</h3><p>Live computer status · latest samples</p></div><button class="mini-link" data-view="computers">View fleet <i class="bi bi-arrow-right"></i></button></div><div class="chart-box"><canvas id="fleet-chart" aria-label="Recent CPU and memory samples"></canvas></div></section>${health}</div><div class="content-grid"><section class="table-card"><div class="panel-heading-row"><div><h3>Computer fleet</h3><small>Recently active devices</small></div><button class="mini-link" data-view="computers">View all <i class="bi bi-arrow-right"></i></button></div>${dataTable(computerColumns, visibleRows, { emptyTitle: "No computers registered", emptyText: "Register an authorized computer to begin." })}</section>${secondary}</div>${maintenancePanel}${upcomingPanel}${activityPanel}`;
  drawFleetChart(statuses ?? [], computers);
}

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
}

function healthMetric(label, value, caption, barClass, fixedPercent = null) {
  const percentage = Math.max(0, Math.min(100, fixedPercent ?? (Number(value) || 0)));
  const colorClass = percentage > 90 ? "progress-red" : percentage > 80 && barClass === "progress-blue" ? "progress-amber" : barClass;
  return `<div><div class="health-row-top"><span>${escapeHtml(label)}</span><span>${fixedPercent !== null ? escapeHtml(value) : `${Number(value).toFixed(0)}%`}</span></div><div class="progress"><div class="progress-bar ${colorClass}" style="width:${percentage}%"></div></div><div class="health-caption">${escapeHtml(caption)}</div></div>`;
}

function drawFleetChart(statuses, computers) {
  const canvas = document.querySelector("#fleet-chart");
  if (!canvas || !window.Chart) return;
  const latest = new Map();
  for (const row of [...statuses].sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at))) {
    const bucket = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(row.recorded_at));
    if (!latest.has(bucket)) latest.set(bucket, { cpu: [], ram: [] });
    latest.get(bucket).cpu.push(Number(row.cpu_usage));
    latest.get(bucket).ram.push(Number(row.ram_usage));
  }
  const labels = [...latest.keys()].slice(-12);
  const cpu = labels.map((label) => mean(latest.get(label).cpu));
  const ram = labels.map((label) => mean(latest.get(label).ram));
  state.chart = new Chart(canvas, { type: "line", data: { labels: labels.length ? labels : ["Waiting for agent samples"], datasets: [{ label: "CPU", data: cpu.length ? cpu : [0], borderColor: "#4a7df2", backgroundColor: "#4a7df21a", pointRadius: 2.5, pointBackgroundColor: "#4a7df2", borderWidth: 2, fill: true, tension: .4 }, { label: "Memory", data: ram.length ? ram : [0], borderColor: "#32b58a", backgroundColor: "transparent", pointRadius: 2.5, pointBackgroundColor: "#32b58a", borderWidth: 2, tension: .4 }] }, options: { maintainAspectRatio: false, interaction: { intersect: false, mode: "index" }, plugins: { legend: { position: "bottom", align: "start", labels: { usePointStyle: true, boxWidth: 7, boxHeight: 7, padding: 18, color: "#80909b", font: { family: "DM Sans", size: 10 } } }, tooltip: { callbacks: { label: (context) => `${context.dataset.label}: ${Number(context.raw).toFixed(0)}%` } } }, scales: { x: { grid: { display: false }, border: { display: false }, ticks: { color: "#9ba7af", font: { size: 9 }, maxTicksLimit: 7 } }, y: { beginAtZero: true, suggestedMax: 100, max: 100, border: { display: false }, grid: { color: "#edf1f4" }, ticks: { color: "#9ba7af", font: { size: 9 }, callback: (value) => `${value}%`, maxTicksLimit: 5 } } } } });
}

const mean = (values) => values.length ? values.reduce((sum, item) => sum + item, 0) / values.length : 0;
const relationName = (value) => Array.isArray(value) ? (value[0]?.computer_name ?? "—") : (value?.computer_name ?? "—");
const relativeTime = (value) => {
  if (!value) return "Never";
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return `${Math.round(seconds)} sec ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
};

function listState(key, defaultSort = "created_at", ascending = false) {
  if (!state.lists[key]) state.lists[key] = { page: 1, pageSize: 10, search: "", filter: "", sort: defaultSort, ascending, rows: [], count: 0 };
  return state.lists[key];
}

async function renderComputers() {
  const list = listState("computers", "computer_name", true);
  const filters = `<select class="filter-select" data-filter aria-label="Filter computer status"><option value="">All statuses</option><option value="online" ${list.filter === "online" ? "selected" : ""}>Online</option><option value="offline" ${list.filter === "offline" ? "selected" : ""}>Offline</option><option value="maintenance" ${list.filter === "maintenance" ? "selected" : ""}>Maintenance</option></select>`;
  let query = supabase.from("computers").select("id, device_id, computer_name, assigned_user, os_name, ip_address, status, enrollment_status, last_seen", { count: "exact" });
  if (list.search) query = query.or(`computer_name.ilike.%${list.search}%,device_id.ilike.%${list.search}%,assigned_user.ilike.%${list.search}%`);
  if (list.filter) query = query.eq("status", list.filter);
  const sortOptions = new Set(["computer_name", "device_id", "assigned_user", "status", "last_seen"]);
  query = query.order(sortOptions.has(list.sort) ? list.sort : "computer_name", { ascending: list.ascending, nullsFirst: false }).range((list.page - 1) * list.pageSize, list.page * list.pageSize - 1);
  const { data, error, count } = await query;
  if (error) throw error;
  const rows = data ?? [];
  const latest = await latestStatusFor(rows.map((row) => row.id));
  list.rows = rows; list.count = count ?? 0;
  const columns = [
    { label: "COMPUTER", sort: "computer_name", render: (row) => `<div class="computer-name"><span class="computer-icon"><i class="bi bi-pc-display"></i></span><span><button class="table-link" data-action="open-computer" data-id="${escapeHtml(row.id)}">${escapeHtml(row.computer_name)}</button><small>${escapeHtml(row.device_id)}</small></span></div>` },
    { label: "ASSIGNED USER", key: "assigned_user", sort: "assigned_user" },
    { label: "OPERATING SYSTEM", render: (row) => escapeHtml(row.os_name || "—") },
    { label: "IP ADDRESS", render: (row) => escapeHtml(row.ip_address || "—") },
    { label: "STATUS", sort: "status", render: (row) => statusBadge(row.enrollment_status === "revoked" ? "Revoked" : row.status) },
    { label: "CPU / RAM", render: (row) => { const sample = latest.get(row.id); return sample ? `${Number(sample.cpu_usage).toFixed(0)}% / ${Number(sample.ram_usage).toFixed(0)}%` : "—"; } },
    { label: "LAST SEEN", sort: "last_seen", render: (row) => escapeHtml(relativeTime(row.last_seen)) },
  ];
  const actions = `${state.profile.role === "administrator" ? '<button class="btn btn-primary" data-action="add-computer"><i class="bi bi-plus-lg me-1"></i><span class="btn-label">Add computer</span></button>' : ""}<button class="btn btn-outline-secondary" data-action="export-computers"><i class="bi bi-download me-1"></i><span class="btn-label">Export CSV</span></button>`;
  content.innerHTML = `${heading("Computers", "View the computers reporting to your organization.", actions, "FLEET / DEVICE MANAGEMENT")}${tablePanel({ columns, rows, search: list.search, placeholder: "Search name, device ID, or user...", filters, page: list.page, pageSize: list.pageSize, count: list.count, emptyTitle: "No computers found", emptyText: list.search || list.filter ? "Try changing your search or status filter." : "Register an authorized Windows computer to get started.", icon: "bi-pc-display-horizontal" })}`;
}

function htmlOptions(rows, valueKey, labelKey, chosen = "") {
  return rows.map((row) => `<option value="${escapeHtml(row[valueKey])}" ${String(row[valueKey]) === String(chosen) ? "selected" : ""}>${escapeHtml(row[labelKey])}</option>`).join("");
}

async function computerOptions() {
  const { data, error } = await supabase.from("computers").select("id, computer_name, device_id").order("computer_name").limit(1000);
  if (error) throw error;
  return data ?? [];
}

async function addComputerDialog() {
  if (state.profile.role !== "administrator") return;
  let technicians = [];
  try { technicians = await listTechnicians(); } catch { /* Assignment can be added later from user management. */ }
  const options = technicians.map((technician) => ({ value: technician.id, label: technician.full_name || technician.id }));
  const form = `${field("Computer name", "computer_name", { required: true, placeholder: "LAB-PC-01" })}${field("Assigned user", "assigned_user", { placeholder: "Name or email" })}${options.length ? field("Assign technician", "technician_id", { type: "select", options }) : ""}<div class="modal-note mb-3"><i class="bi bi-fingerprint me-1"></i>A unique device ID will be generated automatically.</div><div class="modal-note"><i class="bi bi-shield-check me-1"></i>Only install the agent on a computer your organization owns or is authorized to manage.</div>`;
  showModal({ title: "Register computer", body: form, submitLabel: "Create and pair agent", onSubmit: async (data) => {
    const name = String(data.get("computer_name") ?? "").trim();
    if (name.length > 120) throw new Error("Computer names must be 120 characters or fewer.");
    const deviceId = crypto.randomUUID();
    const { data: computer, error } = await supabase.from("computers").insert({ computer_name: name, device_id: deviceId, assigned_user: String(data.get("assigned_user") ?? "").trim() || null, status: "offline" }).select("id, device_id, computer_name").single();
    if (error) throw error;
    const technicianId = String(data.get("technician_id") ?? "");
    if (technicianId) {
      const { error: assignmentError } = await supabase.from("computer_assignments").insert({ computer_id: computer.id, technician_id: technicianId, assigned_by: state.user.id });
      if (assignmentError) throw assignmentError;
    }
    try {
      const pairing = await invoke("admin-api", { action: "create_pairing_code", computer_id: computer.id });
      setTimeout(() => showPairingCode(pairing), 250);
    } catch (pairingError) { toast(`Computer created; agent pairing code could not be generated: ${pairingError.message}`, "warning"); }
    toast(`${computer.computer_name} was registered.`);
    await navigate("computers", { push: false });
  } });
}

function showPairingCode(pairing) {
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const installerUrl = new URL("/downloads/install-agent.ps1", window.location.origin).href;
  const manifestUrl = new URL("/downloads/agent-package.json", window.location.origin).href;
  const command = `& { $ErrorActionPreference = 'Stop'; $pcmaInstaller = Join-Path $env:TEMP ('PCMaintenance.Agent-' + [guid]::NewGuid().ToString('N') + '.ps1'); $pcmaPowerShell = [System.IO.Path]::Combine($env:SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'); try { Invoke-WebRequest -UseBasicParsing -Uri ${quote(installerUrl)} -OutFile $pcmaInstaller; & $pcmaPowerShell -NoProfile -ExecutionPolicy Bypass -File $pcmaInstaller -PackageManifestUrl ${quote(manifestUrl)} -SupabaseUrl ${quote(window.PCMA_CONFIG.supabaseUrl)} -PublishableKey ${quote(window.PCMA_CONFIG.supabasePublishableKey)} -DeviceId ${quote(pairing.device_id)} -PairingCode ${quote(pairing.pairing_code)}; if ($LASTEXITCODE -ne 0) { throw \"The agent installer failed with exit code $LASTEXITCODE.\" } } finally { Remove-Item -LiteralPath $pcmaInstaller -Force -ErrorAction SilentlyContinue } }`;
  showModal({ title: "Install and pair this computer", submitLabel: "Copy complete setup command", closeLabel: "Done", body: `<p class="mb-2">On <b>${escapeHtml(pairing.computer_name)}</b>, open <b>PowerShell as administrator</b>, paste the command below, and press <kbd>Enter</kbd>.</p><p class="mb-2">The command downloads and verifies the Windows agent, pairs this computer, installs or updates the agent, and starts its service. It uses a temporary PowerShell execution-policy bypass for the installer process only; your saved policy is unchanged. Keep this window open until PowerShell reports that the service is running.</p><div class="p-3 rounded-2 bg-light border mb-3"><code class="small text-break" id="pairing-command">${escapeHtml(command)}</code></div><div class="modal-note"><i class="bi bi-exclamation-triangle me-1"></i>This one-time setup code expires in ${escapeHtml(pairing.expires_in_minutes)} minutes. Treat it as a credential and do not share this command or a screenshot of it.</div>`, onSubmit: async () => {
    await navigator.clipboard.writeText(command);
    toast("Complete setup command copied.");
    return false;
  } });
}

async function beginPairing(computer) {
  try {
    const result = await invoke("admin-api", { action: "create_pairing_code", computer_id: computer.id });
    showPairingCode({ ...result, computer_name: computer.computer_name });
  } catch (error) { toast(error.message, "danger"); }
}

async function openComputer(id) {
  state.detailId = id;
  state.detailTab = "overview";
  state.lists = {};
  await auditQuiet("VIEW_PC", `Viewed computer ${id}.`, id);
  await navigate("computer-detail");
}

const detailTabs = ["Overview", "Hardware", "Monitoring", "Software", "Processes", "Services", "Maintenance", "Troubleshooting", "Activity", "Commands"];
async function renderComputerDetail() {
  if (!state.detailId) return navigate("computers", { push: false });
  const { data: computer, error } = await supabase.from("computers").select("*").eq("id", state.detailId).maybeSingle();
  if (error) throw error;
  if (!computer) return navigate("computers", { push: false });
  const [{ data: specs, error: specsError }, { data: latest, error: latestError }, { data: assignments, error: assignmentsError }] = await Promise.all([
    supabase.from("computer_specs").select("*").eq("computer_id", computer.id).maybeSingle(),
    supabase.from("computer_status").select("*").eq("computer_id", computer.id).order("recorded_at", { ascending: false }).limit(1).maybeSingle(),
    state.profile.role === "administrator" ? supabase.from("computer_assignments").select("technician_id").eq("computer_id", computer.id) : Promise.resolve({ data: [], error: null }),
  ]);
  if (specsError) throw specsError;
  if (latestError) throw latestError;
  if (assignmentsError) throw assignmentsError;
  let technicianNames = [];
  const technicianIds = (assignments ?? []).map((assignment) => assignment.technician_id);
  if (technicianIds.length) {
    const { data: technicians, error: technicianError } = await supabase.from("profiles").select("id, full_name").in("id", technicianIds);
    if (technicianError) throw technicianError;
    technicianNames = (technicians ?? []).map((technician) => technician.full_name || technician.id);
  }
  const canManage = state.profile.role === "administrator" || state.profile.role === "technician";
  const online = computer.status === "online" && computer.enrollment_status === "active";
  const actions = `${canManage ? '<button class="btn btn-outline-light" data-action="request-system-info"><i class="bi bi-arrow-repeat me-1"></i>Refresh inventory</button>' : ""}${state.profile.role === "administrator" ? (computer.enrollment_status === "active" ? '<button class="btn btn-outline-light" data-action="revoke-agent"><i class="bi bi-shield-x me-1"></i>Revoke agent</button>' : '<button class="btn btn-light" data-action="pair-agent"><i class="bi bi-link-45deg me-1"></i>Pair agent</button>') : ""}`;
  const allowedTabs = state.profile.role === "viewer" ? ["Overview", "Hardware", "Monitoring", "Maintenance"] : detailTabs;
  if (!allowedTabs.some((tab) => tab.toLowerCase().replaceAll(" ", "-") === state.detailTab)) state.detailTab = "overview";
  const tabs = allowedTabs.map((tab) => {
    const id = tab.toLowerCase().replaceAll(" ", "-");
    return `<button class="detail-tab ${state.detailTab === id ? "active" : ""}" data-action="detail-tab" data-tab="${id}">${escapeHtml(tab)}</button>`;
  }).join("");
  let panel = "";
  if (state.detailTab === "overview") panel = overviewPanel(computer, specs, latest, technicianNames);
  else if (state.detailTab === "hardware") panel = hardwarePanel(computer, specs);
  else if (state.detailTab === "monitoring") panel = await monitoringPanel(computer);
  else if (state.detailTab === "software") panel = await detailTable(computer, "installed_software", "id, software_name, version, publisher, install_date, scanned_at", softwareDetailColumns, "software", { sort: "software_name", ascending: true });
  else if (state.detailTab === "processes") panel = await processesPanel(computer, canManage);
  else if (state.detailTab === "services") panel = await servicesPanel(computer, canManage);
  else if (state.detailTab === "maintenance") panel = await maintenanceDetail(computer, canManage);
  else if (state.detailTab === "troubleshooting") panel = await problemsDetail(computer, canManage);
  else if (state.detailTab === "activity") panel = await activityDetail(computer);
  else if (state.detailTab === "commands") panel = await commandsDetail(computer);
  else panel = overviewPanel(computer, specs, latest, technicianNames);
  content.innerHTML = `${heading("Computer details", "Asset profile, monitoring, and approved maintenance actions.", `<button class="btn btn-outline-secondary" data-view="computers"><i class="bi bi-arrow-left me-1"></i>Back to fleet</button>`, "FLEET / ASSET PROFILE")}<section class="detail-hero"><span class="detail-hero-icon"><i class="bi bi-pc-display-horizontal"></i></span><div><h2>${escapeHtml(computer.computer_name)}</h2><p>${escapeHtml(computer.device_id)} <span class="mx-1">·</span> ${escapeHtml(computer.os_name || "Windows agent not yet connected")} <span class="mx-1">·</span> Last seen ${escapeHtml(relativeTime(computer.last_seen))}</p></div><div class="ms-2">${statusBadge(online ? "Online" : computer.enrollment_status === "revoked" ? "Revoked" : computer.status)}</div><div class="hero-actions">${actions}</div></section><nav class="detail-tabs" aria-label="Computer information">${tabs}</nav><div id="detail-panel">${panel}</div>`;
  if (state.detailTab === "monitoring") drawMonitoringChart(state.monitorRows ?? []);
}

function overviewPanel(computer, specs, latest, technicianNames = []) {
  const pairs = [
    ["Assigned user", computer.assigned_user], ["Operating system", computer.os_name], ["OS version", computer.os_version], ["Architecture", computer.architecture], ["IP address", computer.ip_address], ["MAC address", computer.mac_address], ["Manufacturer", computer.manufacturer], ["Model", computer.model], ["Serial number", computer.serial_number], ["CPU", specs?.cpu_name], ["Total RAM", formatBytes(specs?.ram_total)], ["Last contact", formatDate(computer.last_seen, true)],
  ];
  if (state.profile.role === "administrator") pairs.splice(1, 0, ["Assigned technicians", technicianNames.length ? technicianNames.join(", ") : "No technician assigned"]);
  const metrics = latest ? `<div class="stat-grid mt-3">${healthMetric("CPU usage", Number(latest.cpu_usage), "Latest agent report", "progress-blue")}${healthMetric("Memory usage", Number(latest.ram_usage), "Latest agent report", "progress-green")}${healthMetric("Disk usage", Number(latest.disk_usage), "Latest agent report", "progress-amber")}${healthMetric("System uptime", formatUptime(latest.uptime), `Reported ${relativeTime(latest.recorded_at)}`, "progress-blue", 0)}</div>` : `<section class="panel mt-3">${emptyState("bi-activity", "Waiting for the agent heartbeat", "Once the approved agent is paired, its hardware and health status will appear here.")}</section>`;
  const adminActions = state.profile.role === "administrator" ? '<div class="d-flex flex-wrap gap-2"><button class="btn btn-soft" data-action="manage-assignments"><i class="bi bi-people me-1"></i>Assign technicians</button><button class="btn btn-soft" data-action="edit-remote"><i class="bi bi-headset me-1"></i>Remote assistance</button></div>' : "";
  return `<section class="panel"><div class="panel-title"><div><h3>Asset overview</h3><p>Current device identity and assigned user</p></div>${adminActions}</div><div class="detail-grid">${pairs.map(([label, value]) => `<div class="info-card"><label>${escapeHtml(label)}</label><b>${escapeHtml(value || "—")}</b></div>`).join("")}</div></section>${metrics}`;
}

function hardwarePanel(computer, specs) {
  const pairs = [["Computer name", computer.computer_name], ["Manufacturer", computer.manufacturer], ["Model", computer.model], ["Serial number", computer.serial_number], ["Processor", specs?.cpu_name], ["CPU cores", specs?.cpu_cores], ["Logical processors", specs?.logical_processors], ["Memory", formatBytes(specs?.ram_total)], ["Graphics adapter", specs?.gpu_name], ["Motherboard", specs?.motherboard], ["BIOS", specs?.bios], ["Storage capacity", formatBytes(specs?.storage_total)], ["Free storage", formatBytes(specs?.storage_free)]];
  const storageDevices = Array.isArray(specs?.storage_devices) ? specs.storage_devices : [];
  const networkAdapters = Array.isArray(specs?.network_adapters) ? specs.network_adapters : [];
  const storageRows = storageDevices.length
    ? storageDevices.map((device) => `<div class="info-card"><label>${escapeHtml(device.name || "Storage device")}</label><b>${escapeHtml(device.model || device.file_system || "Local storage")}</b><small class="text-secondary">${escapeHtml(formatBytes(device.size_bytes))} capacity${device.free_bytes ? ` · ${escapeHtml(formatBytes(device.free_bytes))} free` : ""}${device.serial_number ? ` · S/N ${escapeHtml(device.serial_number)}` : ""}</small></div>`).join("")
    : `<p class="text-secondary small mb-0">No storage device details were reported.</p>`;
  const networkRows = networkAdapters.length
    ? networkAdapters.map((adapter) => `<div class="info-card"><label>${escapeHtml(adapter.name || "Network adapter")}</label><b>${escapeHtml(adapter.description || adapter.type || "Adapter")}</b><small class="text-secondary">${escapeHtml(adapter.status || "Unknown status")}${adapter.mac_address ? ` · ${escapeHtml(adapter.mac_address)}` : ""}${Array.isArray(adapter.ip_addresses) && adapter.ip_addresses.length ? ` · ${escapeHtml(adapter.ip_addresses.join(", "))}` : ""}</small></div>`).join("")
    : `<p class="text-secondary small mb-0">No network adapter details were reported.</p>`;
  return `<section class="panel"><div class="panel-title"><div><h3>Hardware inventory</h3><p>Collected from the visible, installed PC agent</p></div><span class="text-secondary small">${specs ? `Updated ${escapeHtml(formatDate(specs.updated_at, true))}` : "No hardware scan available"}</span></div><div class="detail-grid">${pairs.map(([label, value]) => `<div class="info-card"><label>${escapeHtml(label)}</label><b>${escapeHtml(value ?? "—")}</b></div>`).join("")}</div><div class="row g-3 mt-1"><div class="col-lg-6"><h4 class="section-label">Storage devices and volumes</h4><div class="vstack gap-2">${storageRows}</div></div><div class="col-lg-6"><h4 class="section-label">Network adapters</h4><div class="vstack gap-2">${networkRows}</div></div></div></section>`;
}

async function monitoringPanel(computer) {
  const { data, error } = await supabase.from("computer_status").select("cpu_usage, ram_usage, disk_usage, uptime, recorded_at").eq("computer_id", computer.id).order("recorded_at", { ascending: false }).limit(60);
  if (error) throw error;
  const rows = data ?? [];
  state.monitorRows = rows;
  const latest = rows[0];
  return `${latest ? `<div class="stat-grid">${healthMetric("CPU usage", Number(latest.cpu_usage), "Latest report", "progress-blue")}${healthMetric("Memory usage", Number(latest.ram_usage), "Latest report", "progress-green")}${healthMetric("Disk usage", Number(latest.disk_usage), "Latest report", "progress-amber")}${healthMetric("System uptime", formatUptime(latest.uptime), `Updated ${relativeTime(latest.recorded_at)}`, "progress-blue", 0)}</div>` : ""}<section class="panel mt-3"><div class="panel-title"><div><h3>Recent health samples</h3><p>Sampling is limited to one historical record every five minutes.</p></div><span class="small text-secondary">${rows.length} samples</span></div>${rows.length ? '<div class="chart-box"><canvas id="monitoring-chart" aria-label="Computer system monitoring"></canvas></div>' : emptyState("bi-activity", "No monitoring data yet", "The agent sends a status heartbeat approximately every 45 seconds.")}</section>`;
}

function drawMonitoringChart(rows) {
  const canvas = document.querySelector("#monitoring-chart");
  if (!canvas || !window.Chart) return;
  const ordered = [...rows].reverse();
  state.chart = new Chart(canvas, { type: "line", data: { labels: ordered.map((row) => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(row.recorded_at))), datasets: [{ label: "CPU", data: ordered.map((row) => Number(row.cpu_usage)), borderColor: "#4a7df2", borderWidth: 2, tension: .35, pointRadius: 2 }, { label: "Memory", data: ordered.map((row) => Number(row.ram_usage)), borderColor: "#31b48a", borderWidth: 2, tension: .35, pointRadius: 2 }, { label: "Disk", data: ordered.map((row) => Number(row.disk_usage)), borderColor: "#eda73e", borderWidth: 2, tension: .35, pointRadius: 2 }] }, options: { maintainAspectRatio: false, scales: { y: { min: 0, max: 100, ticks: { callback: (value) => `${value}%` } } } } });
}

const softwareDetailColumns = [
  { label: "APPLICATION", key: "software_name", sort: "software_name" },
  { label: "VERSION", key: "version", sort: "version" },
  { label: "PUBLISHER", key: "publisher", sort: "publisher" },
  { label: "INSTALL DATE", render: (row) => escapeHtml(formatDate(row.install_date)) },
  { label: "LAST SCAN", render: (row) => escapeHtml(formatDate(row.scanned_at, true)) },
];

async function detailTable(computer, table, select, columns, key, { sort = "created_at", ascending = false, searchFields = [] } = {}) {
  const list = listState(`detail-${key}`, sort, ascending);
  let query = supabase.from(table).select(select, { count: "exact" }).eq("computer_id", computer.id);
  if (list.search && searchFields.length) query = query.or(searchFields.map((fieldName) => `${fieldName}.ilike.%${list.search}%`).join(","));
  query = query.order(list.sort, { ascending: list.ascending, nullsFirst: false }).range((list.page - 1) * list.pageSize, list.page * list.pageSize - 1);
  const { data, error, count } = await query;
  if (error) throw error;
  list.rows = data ?? []; list.count = count ?? 0;
  return tablePanel({ columns, rows: list.rows, search: list.search, page: list.page, pageSize: list.pageSize, count: list.count, placeholder: `Search ${key}...`, emptyTitle: `No ${key} inventory`, emptyText: "Request an inventory scan from the connected agent." });
}

async function processesPanel(computer, canManage) {
  const columns = [
    { label: "PROCESS", render: (row) => `<b>${escapeHtml(row.process_name)}</b>` },
    { label: "PID", key: "process_id", sort: "process_id" },
    { label: "CPU", render: (row) => `${Number(row.cpu_usage).toFixed(1)}%` },
    { label: "MEMORY", render: (row) => escapeHtml(formatBytes(row.memory_usage)) },
    { label: "UPDATED", render: (row) => escapeHtml(relativeTime(row.updated_at)) },
    ...(canManage ? [{ label: "ACTION", render: (row) => processDenylist.has(row.process_name.toLowerCase()) ? '<span class="text-secondary small">Protected process</span>' : `<button class="btn btn-sm btn-outline-danger" data-action="stop-process" data-id="${escapeHtml(row.process_id)}" data-name="${escapeHtml(row.process_name)}">Stop process</button>` }] : []),
  ];
  const actions = canManage ? '<button class="btn btn-soft btn-sm" data-action="refresh-inventory" data-type="GET_PROCESSES"><i class="bi bi-arrow-repeat me-1"></i>Refresh</button>' : "";
  return `<div class="d-flex justify-content-end mb-2">${actions}</div>${await detailTable(computer, "processes", "id, process_id, process_name, cpu_usage, memory_usage, updated_at", columns, "processes", { sort: "process_name", ascending: true, searchFields: ["process_name"] })}`;
}

async function servicesPanel(computer, canManage) {
  const columns = [
    { label: "SERVICE", render: (row) => `<b>${escapeHtml(row.display_name)}</b><div class="text-secondary small">${escapeHtml(row.service_name)}</div>` },
    { label: "STATUS", render: (row) => statusBadge(row.status) },
    { label: "STARTUP TYPE", key: "startup_type", sort: "startup_type" },
    { label: "UPDATED", render: (row) => escapeHtml(relativeTime(row.updated_at)) },
    ...(canManage ? [{ label: "APPROVED ACTION", render: (row) => serviceDenylist.has(row.service_name.toLowerCase()) ? '<span class="text-secondary small">Protected service</span>' : `<div class="row-actions"><button class="small-action" title="Start service" data-action="service-command" data-type="START_SERVICE" data-name="${escapeHtml(row.service_name)}"><i class="bi bi-play-fill"></i></button><button class="small-action" title="Stop service" data-action="service-command" data-type="STOP_SERVICE" data-name="${escapeHtml(row.service_name)}"><i class="bi bi-stop-fill"></i></button><button class="small-action" title="Restart service" data-action="service-command" data-type="RESTART_SERVICE" data-name="${escapeHtml(row.service_name)}"><i class="bi bi-arrow-repeat"></i></button></div>` }] : []),
  ];
  const actions = canManage ? '<button class="btn btn-soft btn-sm" data-action="refresh-inventory" data-type="GET_SERVICES"><i class="bi bi-arrow-repeat me-1"></i>Refresh</button>' : "";
  return `<div class="d-flex justify-content-between align-items-start mb-2"><p class="modal-note mb-2">Service control is restricted by the agent’s local allowlist and protected-service denylist.</p>${actions}</div>${await detailTable(computer, "services", "id, service_name, display_name, status, startup_type, updated_at", columns, "services", { sort: "display_name", ascending: true, searchFields: ["service_name", "display_name"] })}`;
}

async function maintenanceDetail(computer, canManage) {
  const actions = canManage ? '<button class="btn btn-primary btn-sm" data-action="new-maintenance" data-computer="' + escapeHtml(computer.id) + '"><i class="bi bi-plus-lg me-1"></i>Record maintenance</button>' : "";
  const columns = [{ label: "DATE", render: (row) => escapeHtml(formatDate(row.maintenance_date)) }, { label: "TYPE", key: "maintenance_type" }, { label: "STATUS", render: (row) => statusBadge(row.status) }, { label: "TECHNICIAN", render: (row) => escapeHtml(row.technician?.full_name || "—") }, { label: "DESCRIPTION", render: (row) => `<span title="${escapeHtml(row.description)}">${escapeHtml(row.description.slice(0, 90))}</span>` }];
  return `<div class="d-flex justify-content-end mb-2">${actions}</div>${await detailTable(computer, "maintenance_records", "id, computer_id, maintenance_type, description, maintenance_date, technician_id, status, next_maintenance_date, technician:profiles!maintenance_records_technician_id_fkey(full_name)", columns, "maintenance", { sort: "maintenance_date", searchFields: ["description", "maintenance_type"] })}`;
}

async function problemsDetail(computer, canManage) {
  const actions = canManage ? `<button class="btn btn-primary btn-sm" data-action="new-problem" data-computer="${escapeHtml(computer.id)}"><i class="bi bi-plus-lg me-1"></i>New problem</button>` : "";
  const columns = [{ label: "REPORTED", render: (row) => escapeHtml(formatDate(row.reported_at)) }, { label: "TITLE", key: "title" }, { label: "CATEGORY", key: "category" }, { label: "STATUS", render: (row) => statusBadge(row.status) }, { label: "SOLUTION", render: (row) => escapeHtml((row.solution || "—").slice(0, 80)) }];
  return `<div class="d-flex justify-content-end mb-2">${actions}</div>${await detailTable(computer, "problems", "id, title, category, status, solution, reported_at, description", columns, "problems", { sort: "reported_at", searchFields: ["title", "description"] })}`;
}

async function activityDetail(computer) {
  const columns = [{ label: "WHEN", render: (row) => escapeHtml(formatDate(row.created_at, true)) }, { label: "ACTION", key: "action" }, { label: "DESCRIPTION", key: "description" }, { label: "RESULT", render: (row) => statusBadge(row.result) }];
  return await detailTable(computer, "activity_logs", "id, action, description, result, created_at", columns, "activity", { sort: "created_at", searchFields: ["action", "description"] });
}

async function commandsDetail(computer) {
  const columns = [
    { label: "REQUESTED", render: (row) => escapeHtml(formatDate(row.created_at, true)) },
    { label: "COMMAND", key: "command_type" },
    { label: "STATUS", render: (row) => statusBadge(row.status) },
    { label: "RESULT", render: (row) => escapeHtml(row.error_message || JSON.stringify(row.result || {}).slice(0, 100)) },
    { label: "EXPIRES", render: (row) => escapeHtml(formatDate(row.expires_at, true)) },
  ];
  return `<div class="panel mb-3"><div class="panel-title"><div><h3>Approved agent actions</h3><p>Commands expire if the computer does not receive them within five minutes.</p></div></div><div class="d-flex flex-wrap gap-2">${["GET_SYSTEM_INFO", "GET_HARDWARE_INFO", "GET_SYSTEM_STATUS", "GET_SOFTWARE", "GET_PROCESSES", "GET_SERVICES"].map((type) => `<button class="btn btn-soft btn-sm" data-action="queue-command" data-type="${type}">${escapeHtml(type.replaceAll("_", " "))}</button>`).join("")}${state.profile.role !== "viewer" ? `<button class="btn btn-outline-danger btn-sm ms-auto" data-action="confirm-power" data-type="RESTART_PC"><i class="bi bi-arrow-clockwise me-1"></i>Restart</button><button class="btn btn-danger btn-sm" data-action="confirm-power" data-type="SHUTDOWN_PC"><i class="bi bi-power me-1"></i>Shut down</button>` : ""}</div></div>${await detailTable(computer, "commands", "id, command_type, status, result, error_message, created_at, expires_at", columns, "commands", { sort: "created_at" })}`;
}

async function queueCommand(computerId, commandType, parameters = {}) {
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const { data, error } = await supabase.from("commands").insert({ computer_id: computerId, command_type: commandType, parameters, created_by: state.user.id, expires_at: expiresAt }).select("id").single();
  if (error) throw error;
  toast(`${commandType.replaceAll("_", " ")} queued; the computer must check in before expiry.`);
  return data.id;
}

function confirmPowerAction(computer, type) {
  const action = type === "RESTART_PC" ? "restart" : "shut down";
  const confirmation = `${field(`Type ${computer.computer_name} to confirm`, "confirmation", { required: true, placeholder: computer.computer_name })}<div class="modal-note">${type === "RESTART_PC" ? "The computer will receive a graceful restart request." : "The computer will receive a graceful shutdown request. This action may interrupt work in progress."} The approved agent only executes this request before it expires.</div>`;
  showModal({ title: `${type === "RESTART_PC" ? "Restart" : "Shut down"} ${computer.computer_name}?`, body: `<div class="alert alert-warning py-2 small">Are you sure you want to ${action} <b>${escapeHtml(computer.computer_name)}</b>?</div>${confirmation}`, submitLabel: `Queue ${action}`, danger: true, onSubmit: async (form) => {
    if (String(form.get("confirmation") ?? "").trim() !== computer.computer_name) throw new Error("The computer name did not match.");
    await queueCommand(computer.id, type, {});
    await navigate("computer-detail", { push: false });
  } });
}

function confirmStopProcess(computer, processId, processName) {
  const normalized = processName.toLowerCase();
  if (processDenylist.has(normalized)) return toast("This system process is protected by the denylist.", "warning");
  showModal({ title: "Stop process?", body: `<div class="alert alert-warning small">Stop <b>${escapeHtml(processName)}</b> (PID ${escapeHtml(processId)}) on <b>${escapeHtml(computer.computer_name)}</b>?</div><p class="modal-note">The agent checks its protected process denylist and confirms the PID still belongs to this process before requesting a graceful stop.</p>`, submitLabel: "Queue stop request", danger: true, onSubmit: async () => {
    await queueCommand(computer.id, "STOP_PROCESS", { process_id: Number(processId), process_name: processName });
    await navigate("computer-detail", { push: false });
  } });
}

function confirmServiceAction(computer, type, serviceName) {
  if (serviceDenylist.has(serviceName.toLowerCase())) return toast("This Windows service is protected by the denylist.", "warning");
  const verb = type.split("_")[0].toLowerCase();
  showModal({ title: `${verb[0].toUpperCase()}${verb.slice(1)} service?`, body: `<p>Request <b>${escapeHtml(type.replaceAll("_", " "))}</b> for <b>${escapeHtml(serviceName)}</b> on <b>${escapeHtml(computer.computer_name)}</b>?</p><div class="modal-note">The agent also requires this exact service name to appear in its local allowlist.</div>`, submitLabel: `Queue ${verb}`, danger: type !== "START_SERVICE", onSubmit: async () => {
    await queueCommand(computer.id, type, { service_name: serviceName });
    await navigate("computer-detail", { push: false });
  } });
}

async function revokeAgent(computer) {
  showModal({ title: "Revoke computer agent?", body: `<p>Revoke the device credential for <b>${escapeHtml(computer.computer_name)}</b>?</p><div class="modal-note">The installed agent will be unable to authenticate after revocation. Pair it again to restore reporting.</div>`, submitLabel: "Revoke credential", danger: true, onSubmit: async () => {
    await invoke("admin-api", { action: "revoke_device", computer_id: computer.id });
    await navigate("computer-detail", { push: false });
    toast("Device credential revoked.");
  } });
}

async function manageAssignments(computer) {
  const [technicians, assignmentResult] = await Promise.all([
    listTechnicians(),
    supabase.from("computer_assignments").select("technician_id").eq("computer_id", computer.id),
  ]);
  if (assignmentResult.error) throw assignmentResult.error;
  const assigned = new Set((assignmentResult.data ?? []).map((row) => row.technician_id));
  const checklist = technicians.length
    ? technicians.map((technician) => `<label class="d-flex align-items-center gap-2 border rounded-2 p-3 mb-2"><input class="form-check-input mt-0" type="checkbox" name="technician_ids" value="${escapeHtml(technician.id)}" ${assigned.has(technician.id) ? "checked" : ""}><span><b>${escapeHtml(technician.full_name || "Technician")}</b><small class="d-block text-secondary">${escapeHtml(technician.id)}</small></span></label>`).join("")
    : `<div class="empty-state"><i class="bi bi-people"></i><h4>No active technicians</h4><p>Invite or reactivate a technician account before assigning this computer.</p></div>`;
  showModal({ title: `Assign technicians · ${computer.computer_name}`, body: `${checklist}<div class="modal-note">Assigned technicians can view this computer and perform approved maintenance actions. Changes are recorded in the activity log.</div>`, submitLabel: technicians.length ? "Save assignments" : "", closeLabel: "Done", onSubmit: technicians.length ? async (_form, formElement) => {
    const desired = new Set([...formElement.querySelectorAll('input[name="technician_ids"]:checked')].map((input) => input.value));
    const toAdd = [...desired].filter((id) => !assigned.has(id));
    const toRemove = [...assigned].filter((id) => !desired.has(id));
    if (toRemove.length) {
      const { error } = await supabase.from("computer_assignments").delete().eq("computer_id", computer.id).in("technician_id", toRemove);
      if (error) throw error;
    }
    if (toAdd.length) {
      const { error } = await supabase.from("computer_assignments").insert(toAdd.map((technicianId) => ({ computer_id: computer.id, technician_id: technicianId, assigned_by: state.user.id })));
      if (error) throw error;
    }
    await navigate("computer-detail", { push: false });
    toast("Technician assignments updated.");
  } : null });
}

async function editRemoteAssistance(computer) {
  const body = `${field("Remote assistance enabled", "remote_assistance_enabled", { type: "select", value: String(computer.remote_assistance_enabled), options: [{ value: "true", label: "Enabled" }, { value: "false", label: "Disabled" }] })}${field("Connection instructions", "remote_assistance_instructions", { type: "textarea", value: computer.remote_assistance_instructions || "", placeholder: "Use Quick Assist and contact the IT desk for a session code.", help: "Instructions only. This dashboard does not create a remote desktop connection." })}`;
  showModal({ title: "Remote assistance information", body, submitLabel: "Save instructions", onSubmit: async (form) => {
    const { error } = await supabase.from("computers").update({ remote_assistance_enabled: form.get("remote_assistance_enabled") === "true", remote_assistance_instructions: String(form.get("remote_assistance_instructions") ?? "").trim() || null }).eq("id", computer.id);
    if (error) throw error;
    await navigate("computer-detail", { push: false });
  } });
}

const recordConfigs = {
  software: { table: "installed_software", select: "id, computer_id, software_name, version, publisher, install_date, scanned_at, computers(computer_name, device_id)", title: "Software inventory", subtitle: "Installed applications reported by authorized computers.", searchFields: ["software_name", "publisher", "version"], sort: "software_name", ascending: true, sorts: ["software_name", "publisher", "version", "install_date", "scanned_at"], computerFilter: true, columns: [
    { label: "APPLICATION", key: "software_name", sort: "software_name" }, { label: "VERSION", key: "version", sort: "version" }, { label: "PUBLISHER", key: "publisher", sort: "publisher" }, { label: "COMPUTER", render: (row) => escapeHtml(relationName(row.computers)) }, { label: "INSTALL DATE", render: (row) => escapeHtml(formatDate(row.install_date)) }, { label: "LAST SCAN", render: (row) => escapeHtml(formatDate(row.scanned_at, true)) },
  ] },
  maintenance: { table: "maintenance_records", select: "id, computer_id, maintenance_type, description, technician_id, maintenance_date, findings, actions_performed, recommendation, status, next_maintenance_date, created_at, computers(computer_name)", title: "Maintenance records", subtitle: "Document completed and ongoing service work.", searchFields: ["maintenance_type", "description", "findings", "actions_performed"], sort: "maintenance_date", sorts: ["maintenance_date", "maintenance_type", "status", "created_at"], statusFilter: ["Scheduled", "In Progress", "Completed", "Cancelled", "Overdue"], columns: [
    { label: "DATE", sort: "maintenance_date", render: (row) => escapeHtml(formatDate(row.maintenance_date)) }, { label: "COMPUTER", render: (row) => escapeHtml(relationName(row.computers)) }, { label: "TYPE", key: "maintenance_type", sort: "maintenance_type" }, { label: "DESCRIPTION", render: (row) => `<span title="${escapeHtml(row.description)}">${escapeHtml(String(row.description ?? "").slice(0, 70))}</span>` }, { label: "STATUS", key: "status", sort: "status", render: (row) => statusBadge(row.status) },
  ] },
  schedules: { table: "maintenance_schedules", select: "id, computer_id, maintenance_type, technician_id, scheduled_date, priority, status, notes, created_at, computers(computer_name)", title: "Maintenance schedule", subtitle: "Plan upcoming maintenance and review overdue work.", searchFields: ["maintenance_type", "notes", "priority"], sort: "scheduled_date", ascending: true, sorts: ["scheduled_date", "maintenance_type", "priority", "status"], statusFilter: ["Scheduled", "In Progress", "Completed", "Cancelled", "Overdue"], columns: [
    { label: "SCHEDULED", sort: "scheduled_date", render: (row) => escapeHtml(formatDate(row.scheduled_date)) }, { label: "COMPUTER", render: (row) => escapeHtml(relationName(row.computers)) }, { label: "TYPE", key: "maintenance_type", sort: "maintenance_type" }, { label: "PRIORITY", key: "priority", sort: "priority", render: (row) => statusBadge(row.priority) }, { label: "STATUS", key: "status", sort: "status", render: (row) => statusBadge(row.status) },
  ] },
  problems: { table: "problems", select: "id, computer_id, title, description, category, error_message, cause, troubleshooting, solution, technician_id, reported_at, resolved_at, status, computers(computer_name)", title: "Troubleshooting", subtitle: "Track device problems, investigation, and resolution.", searchFields: ["title", "description", "category", "error_message"], sort: "reported_at", sorts: ["reported_at", "title", "category", "status"], statusFilter: ["Open", "In Progress", "Resolved", "Closed"], columns: [
    { label: "REPORTED", sort: "reported_at", render: (row) => escapeHtml(formatDate(row.reported_at)) }, { label: "COMPUTER", render: (row) => escapeHtml(relationName(row.computers)) }, { label: "PROBLEM", key: "title", sort: "title" }, { label: "CATEGORY", key: "category", sort: "category" }, { label: "STATUS", key: "status", sort: "status", render: (row) => statusBadge(row.status) }, { label: "SOLUTION", render: (row) => escapeHtml((row.solution || "—").slice(0, 70)) },
  ] },
  alerts: { table: "alerts", select: "id, computer_id, alert_type, severity, message, status, created_at, resolved_at, computers(computer_name)", title: "Alerts", subtitle: "Review device health and overdue maintenance notifications.", searchFields: ["alert_type", "severity", "message"], sort: "created_at", sorts: ["created_at", "severity", "status"], statusFilter: ["Open", "Acknowledged", "Resolved"], columns: [
    { label: "SEVERITY", sort: "severity", render: (row) => statusBadge(row.severity) }, { label: "ALERT", render: (row) => `<span title="${escapeHtml(row.message)}">${escapeHtml(String(row.message).slice(0, 100))}</span>` }, { label: "COMPUTER", render: (row) => escapeHtml(relationName(row.computers)) }, { label: "STATUS", key: "status", sort: "status", render: (row) => statusBadge(row.status) }, { label: "CREATED", sort: "created_at", render: (row) => escapeHtml(formatDate(row.created_at, true)) },
  ] },
  activity: { table: "activity_logs", select: "id, user_id, computer_id, action, description, result, created_at, computers(computer_name)", title: "Activity logs", subtitle: "Immutable audit history for administrator and technician actions.", searchFields: ["action", "description", "result"], sort: "created_at", sorts: ["created_at", "action", "result"], columns: [
    { label: "TIME", sort: "created_at", render: (row) => escapeHtml(formatDate(row.created_at, true)) }, { label: "ACTION", sort: "action", key: "action" }, { label: "DESCRIPTION", render: (row) => escapeHtml(String(row.description ?? "").slice(0, 120)) }, { label: "COMPUTER", render: (row) => escapeHtml(relationName(row.computers)) }, { label: "RESULT", sort: "result", render: (row) => statusBadge(row.result) },
  ] },
};

async function renderRecords(view) {
  const config = recordConfigs[view];
  const list = listState(view, config.sort, config.ascending ?? false);
  const canCreate = ["administrator", "technician"].includes(state.profile.role) && ["maintenance", "schedules", "problems"].includes(view);
  const actions = `${canCreate ? `<button class="btn btn-primary" data-action="new-record" data-view="${view}"><i class="bi bi-plus-lg me-1"></i><span class="btn-label">${view === "maintenance" ? "Add record" : view === "schedules" ? "Schedule maintenance" : "New problem"}</span></button>` : ""}<button class="btn btn-outline-secondary" data-action="export-records" data-view="${view}" title="Export filtered data to CSV"><i class="bi bi-download me-1"></i><span class="btn-label">Export CSV</span></button>`;
  let query = supabase.from(config.table).select(config.select, { count: "exact" });
  if (list.search && config.searchFields.length) query = query.or(config.searchFields.map((column) => `${column}.ilike.%${list.search}%`).join(","));
  if (config.statusFilter && list.filter) query = query.eq("status", list.filter);
  if (config.computerFilter && list.computerId) query = query.eq("computer_id", list.computerId);
  query = query.order(config.sorts.includes(list.sort) ? list.sort : config.sort, { ascending: list.ascending, nullsFirst: false }).range((list.page - 1) * list.pageSize, list.page * list.pageSize - 1);
  const { data, error, count } = await query;
  if (error) throw error;
  const rows = data ?? [];
  list.rows = rows; list.count = count ?? 0;
  let filters = "";
  if (config.statusFilter) filters += `<select class="filter-select" data-filter aria-label="Filter status"><option value="">All statuses</option>${config.statusFilter.map((status) => `<option value="${escapeHtml(status)}" ${list.filter === status ? "selected" : ""}>${escapeHtml(status)}</option>`).join("")}</select>`;
  if (config.computerFilter) {
    const computers = await computerOptions();
    filters += `<select class="filter-select" data-computer-filter aria-label="Filter computer"><option value="">All computers</option>${computers.map((computer) => `<option value="${escapeHtml(computer.id)}" ${list.computerId === computer.id ? "selected" : ""}>${escapeHtml(computer.computer_name)}</option>`).join("")}</select>`;
  }
  let columns = config.columns;
  if (canCreate && ["maintenance", "schedules", "problems"].includes(view)) columns = [...columns, { label: "UPDATE", render: (row) => `<button class="small-action" title="Update status" data-action="update-record-status" data-view="${view}" data-id="${escapeHtml(row.id)}" data-status="${escapeHtml(row.status)}"><i class="bi bi-pencil"></i></button>` }];
  if (view === "alerts" && state.profile.role !== "viewer") columns = [...columns, { label: "ACTION", render: (row) => row.status === "Resolved" ? "—" : `<button class="btn btn-sm btn-outline-secondary" data-action="ack-alert" data-id="${escapeHtml(row.id)}">Acknowledge</button>` }];
  content.innerHTML = `${heading(config.title, config.subtitle, actions, "SERVICE DESK / RECORDS")}${tablePanel({ columns, rows, search: list.search, placeholder: `Search ${config.title.toLowerCase()}...`, filters, page: list.page, pageSize: list.pageSize, count: list.count, emptyTitle: `No ${config.title.toLowerCase()} found`, emptyText: list.search || list.filter ? "Try another search or filter." : "Records will appear here when available." })}`;
}

async function openRecordForm(view, presetComputer = "") {
  const computers = await computerOptions();
  if (!computers.length) return toast("Register a computer before creating this record.", "warning");
  const computerField = field("Computer", "computer_id", { type: "select", required: true, value: presetComputer, options: computers.map((computer) => ({ value: computer.id, label: computer.computer_name })) });
  let technicians = [];
  try { technicians = await listTechnicians(); } catch { /* Technicians can still assign themselves. */ }
  const technicianField = state.profile.role === "administrator" ? field("Technician", "technician_id", { type: "select", options: technicians.map((person) => ({ value: person.id, label: person.full_name || person.id })) }) : "";
  let title = "", body = "", submit = "Save record", table = "", payload = {};
  if (view === "maintenance") {
    title = "Record maintenance"; table = "maintenance_records";
    body = `${computerField}${field("Maintenance type", "maintenance_type", { type: "select", required: true, options: maintenanceTypes.map((value) => ({ value, label: value })) })}${field("Maintenance date", "maintenance_date", { type: "date", required: true, value: new Date().toISOString().slice(0, 10) })}${field("Status", "status", { type: "select", value: "Completed", options: ["Scheduled", "In Progress", "Completed", "Cancelled", "Overdue"].map((value) => ({ value, label: value })) })}${field("Description", "description", { type: "textarea", required: true, placeholder: "Describe the maintenance performed." })}${field("Findings", "findings", { type: "textarea" })}${field("Actions performed", "actions_performed", { type: "textarea" })}${field("Recommendation", "recommendation", { type: "textarea" })}${technicianField}${field("Next maintenance date", "next_maintenance_date", { type: "date" })}`;
  } else if (view === "schedules") {
    title = "Schedule maintenance"; table = "maintenance_schedules"; submit = "Create schedule";
    body = `${computerField}${field("Maintenance type", "maintenance_type", { type: "select", required: true, options: maintenanceTypes.map((value) => ({ value, label: value })) })}${field("Schedule date", "scheduled_date", { type: "date", required: true })}${field("Priority", "priority", { type: "select", value: "Normal", options: ["Low", "Normal", "High", "Critical"].map((value) => ({ value, label: value })) })}${technicianField}${field("Notes", "notes", { type: "textarea" })}`;
  } else {
    title = "Report a problem"; table = "problems"; submit = "Save problem";
    body = `${computerField}${field("Problem title", "title", { required: true, placeholder: "Describe the issue briefly" })}${field("Category", "category", { type: "select", required: true, options: ["Hardware", "Software", "Network", "Operating System", "Security", "Other"].map((value) => ({ value, label: value })) })}${field("Problem description", "description", { type: "textarea", required: true })}${field("Error message", "error_message", { type: "textarea" })}${field("Cause", "cause", { type: "textarea" })}${field("Troubleshooting performed", "troubleshooting", { type: "textarea" })}${field("Solution", "solution", { type: "textarea" })}${technicianField}`;
  }
  showModal({ title, body, submitLabel: submit, large: true, onSubmit: async (form) => {
    const value = (name) => String(form.get(name) ?? "").trim() || null;
    payload = { computer_id: value("computer_id"), technician_id: state.profile.role === "administrator" ? value("technician_id") : state.profile.role === "technician" ? state.user.id : null };
    if (view === "maintenance") Object.assign(payload, { maintenance_type: value("maintenance_type"), description: value("description"), maintenance_date: value("maintenance_date"), status: value("status"), findings: value("findings"), actions_performed: value("actions_performed"), recommendation: value("recommendation"), next_maintenance_date: value("next_maintenance_date") });
    else if (view === "schedules") Object.assign(payload, { maintenance_type: value("maintenance_type"), scheduled_date: value("scheduled_date"), priority: value("priority"), notes: value("notes"), status: "Scheduled" });
    else Object.assign(payload, { title: value("title"), description: value("description"), category: value("category"), error_message: value("error_message"), cause: value("cause"), troubleshooting: value("troubleshooting"), solution: value("solution"), status: "Open" });
    const { data: inserted, error } = await supabase.from(table).insert(payload).select("id, computer_id").single();
    if (error) throw error;
    toast(`${title} saved.`);
    if (state.view === "computer-detail") await navigate("computer-detail", { push: false });
    else await navigate(view, { push: false });
  } });
}

async function updateRecordStatus(view, id, current) {
  const table = recordConfigs[view]?.table;
  if (!table) return;
  const options = view === "problems" ? ["Open", "In Progress", "Resolved", "Closed"] : ["Scheduled", "In Progress", "Completed", "Cancelled", "Overdue"];
  showModal({ title: "Update record status", body: field("Status", "status", { type: "select", required: true, value: current, options: options.map((value) => ({ value, label: value })) }), submitLabel: "Update status", onSubmit: async (form) => {
    const newStatus = String(form.get("status"));
    const update = { status: newStatus };
    if (view === "problems" && newStatus === "Resolved") update.resolved_at = new Date().toISOString();
    const { error } = await supabase.from(table).update(update).eq("id", id);
    if (error) throw error;
    await navigate(view, { push: false });
  } });
}

async function acknowledgeAlert(id) {
  const { error } = await supabase.from("alerts").update({ status: "Acknowledged" }).eq("id", id);
  if (error) return toast(error.message, "danger");
  await navigate("alerts", { push: false });
}

async function exportView(view) {
  const config = recordConfigs[view];
  if (!config) return;
  const list = listState(view, config.sort, config.ascending ?? false);
  let query = supabase.from(config.table).select(config.select);
  if (list.search && config.searchFields.length) query = query.or(config.searchFields.map((column) => `${column}.ilike.%${list.search}%`).join(","));
  if (config.statusFilter && list.filter) query = query.eq("status", list.filter);
  if (config.computerFilter && list.computerId) query = query.eq("computer_id", list.computerId);
  const { data, error } = await query.order(config.sorts.includes(list.sort) ? list.sort : config.sort, { ascending: list.ascending, nullsFirst: false }).limit(5000);
  if (error) return toast(error.message, "danger");
  const columns = config.columns.filter((column) => column.key).map((column) => ({ label: column.label, csv: (row) => column.csv ? column.csv(row) : row[column.key] }));
  for (const column of config.columns.filter((item) => !item.key)) columns.push({ label: column.label, csv: (row) => {
    if (column.label === "COMPUTER") return relationName(row.computers);
    if (column.label === "DATE" || column.label === "SCHEDULED" || column.label === "REPORTED" || column.label === "CREATED" || column.label === "TIME" || column.label === "LAST SCAN") return row.maintenance_date || row.scheduled_date || row.reported_at || row.created_at || row.scanned_at;
    return "";
  } });
  downloadCsv(`${view}-${new Date().toISOString().slice(0, 10)}.csv`, data ?? [], columns);
}

async function auditQuiet(action, description, computerId = null) {
  try { await recordActivity(action, description, computerId); }
  catch { toast("The requested change was saved, but the activity log could not be reached.", "warning"); }
}

async function renderHardware() {
  const list = listState("hardware", "computer_name", true);
  let query = supabase.from("computer_specs").select("id, computer_id, cpu_name, cpu_cores, logical_processors, ram_total, gpu_name, motherboard, storage_total, storage_free, updated_at, computers!inner(computer_name, device_id, manufacturer, model)", { count: "exact" });
  if (list.search) query = query.or(`cpu_name.ilike.%${list.search}%,gpu_name.ilike.%${list.search}%,motherboard.ilike.%${list.search}%`);
  query = query.order("updated_at", { ascending: false }).range((list.page - 1) * list.pageSize, list.page * list.pageSize - 1);
  const { data, error, count } = await query;
  if (error) throw error;
  const rows = data ?? []; list.rows = rows; list.count = count ?? 0;
  const columns = [
    { label: "COMPUTER", render: (row) => `<div class="computer-name"><span class="computer-icon"><i class="bi bi-pc-display"></i></span><span><button class="table-link" data-action="open-computer" data-id="${escapeHtml(row.computer_id)}">${escapeHtml(relationName(row.computers))}</button><small>${escapeHtml(Array.isArray(row.computers) ? row.computers[0]?.device_id : row.computers?.device_id)}</small></span></div>` },
    { label: "PROCESSOR", key: "cpu_name" }, { label: "CORES", key: "cpu_cores" }, { label: "MEMORY", render: (row) => escapeHtml(formatBytes(row.ram_total)) }, { label: "GRAPHICS", key: "gpu_name" }, { label: "STORAGE", render: (row) => `${escapeHtml(formatBytes(row.storage_free))} free / ${escapeHtml(formatBytes(row.storage_total))}` }, { label: "UPDATED", render: (row) => escapeHtml(relativeTime(row.updated_at)) },
  ];
  content.innerHTML = `${heading("Hardware inventory", "Hardware specifications reported by the connected PC agents.", '<button class="btn btn-outline-secondary" data-action="export-hardware"><i class="bi bi-download me-1"></i>Export CSV</button>', "FLEET / HARDWARE")}${tablePanel({ columns, rows, search: list.search, placeholder: "Search CPU, GPU, or motherboard...", page: list.page, pageSize: list.pageSize, count: list.count, emptyTitle: "No hardware inventory", emptyText: "Hardware will appear after an approved agent checks in." })}`;
}

async function exportHardware() {
  const { data, error } = await supabase.from("computer_specs").select("cpu_name, cpu_cores, logical_processors, ram_total, gpu_name, motherboard, bios, storage_total, storage_free, updated_at, computers(computer_name, device_id, manufacturer, model)").order("updated_at", { ascending: false }).limit(5000);
  if (error) return toast(error.message, "danger");
  downloadCsv(`hardware-inventory-${new Date().toISOString().slice(0, 10)}.csv`, data ?? [], [
    { label: "Computer", csv: (row) => relationName(row.computers) }, { label: "Device ID", csv: (row) => Array.isArray(row.computers) ? row.computers[0]?.device_id : row.computers?.device_id }, { label: "Manufacturer", csv: (row) => Array.isArray(row.computers) ? row.computers[0]?.manufacturer : row.computers?.manufacturer }, { label: "Model", csv: (row) => Array.isArray(row.computers) ? row.computers[0]?.model : row.computers?.model }, { label: "CPU", key: "cpu_name" }, { label: "Cores", key: "cpu_cores" }, { label: "Logical processors", key: "logical_processors" }, { label: "RAM bytes", key: "ram_total" }, { label: "GPU", key: "gpu_name" }, { label: "Motherboard", key: "motherboard" }, { label: "BIOS", key: "bios" }, { label: "Storage bytes", key: "storage_total" }, { label: "Free storage bytes", key: "storage_free" }, { label: "Updated", key: "updated_at" },
  ]);
}

async function exportComputers() {
  const list = listState("computers", "computer_name", true);
  let query = supabase.from("computers").select("device_id, computer_name, assigned_user, manufacturer, model, serial_number, os_name, os_version, architecture, ip_address, mac_address, status, enrollment_status, last_seen, created_at");
  if (list.search) query = query.or(`computer_name.ilike.%${list.search}%,device_id.ilike.%${list.search}%,assigned_user.ilike.%${list.search}%`);
  if (list.filter) query = query.eq("status", list.filter);
  const { data, error } = await query.order("computer_name", { ascending: true }).limit(5000);
  if (error) return toast(error.message, "danger");
  downloadCsv(`computers-${new Date().toISOString().slice(0, 10)}.csv`, data ?? [], ["device_id", "computer_name", "assigned_user", "manufacturer", "model", "serial_number", "os_name", "os_version", "architecture", "ip_address", "mac_address", "status", "enrollment_status", "last_seen", "created_at"].map((key) => ({ label: key.replaceAll("_", " "), key })));
}

async function renderUsers() {
  const list = listState("users", "created_at", false);
  let query = supabase.from("profiles").select("id, full_name, role, status, created_at, updated_at", { count: "exact" });
  if (list.search) query = query.ilike("full_name", `%${list.search}%`);
  query = query.order("created_at", { ascending: false }).range((list.page - 1) * list.pageSize, list.page * list.pageSize - 1);
  const { data, error, count } = await query;
  if (error) throw error;
  const rows = data ?? []; list.rows = rows; list.count = count ?? 0;
  const columns = [
    { label: "USER", render: (row) => `<div class="computer-name"><span class="avatar">${escapeHtml((row.full_name || "U").charAt(0).toUpperCase())}</span><span><b>${escapeHtml(row.full_name || "No name set")}</b><small>${escapeHtml(row.id)}</small></span></div>` },
    { label: "ROLE", render: (row) => statusBadge(roleNames[row.role] || row.role) }, { label: "STATUS", render: (row) => statusBadge(row.status) }, { label: "JOINED", render: (row) => escapeHtml(formatDate(row.created_at)) },
    { label: "ACTIONS", render: (row) => row.id === state.user.id ? '<span class="text-secondary small">Current account</span>' : `<button class="small-action" title="Update user access" data-action="edit-user" data-id="${escapeHtml(row.id)}" data-name="${escapeHtml(row.full_name)}" data-role="${escapeHtml(row.role)}" data-status="${escapeHtml(row.status)}"><i class="bi bi-pencil"></i></button>` },
  ];
  content.innerHTML = `${heading("User management", "Invite administrators and technicians, and set organization access roles.", '<button class="btn btn-primary" data-action="invite-user"><i class="bi bi-person-plus me-1"></i>Invite user</button>', "ADMINISTRATION / ACCESS")}${tablePanel({ columns, rows, search: list.search, placeholder: "Search users...", page: list.page, pageSize: list.pageSize, count: list.count, emptyTitle: "No organization users", emptyText: "Invite an authorized teammate to get started." })}`;
}

function inviteUserDialog() {
  const body = `${field("Full name", "full_name", { required: true })}${field("Work email", "email", { type: "email", required: true })}${field("Role", "role", { type: "select", required: true, value: "technician", options: [{ value: "administrator", label: "Administrator" }, { value: "technician", label: "Technician" }, { value: "viewer", label: "Viewer" }] })}<div class="modal-note">Supabase sends the invitation email and handles password setup. No password is stored in this dashboard.</div>`;
  showModal({ title: "Invite a user", body, submitLabel: "Send invitation", onSubmit: async (form) => {
    await invoke("admin-api", { action: "invite_user", email: String(form.get("email")).trim(), full_name: String(form.get("full_name")).trim(), role: String(form.get("role")) });
    toast("Invitation sent.");
    await navigate("users", { push: false });
  } });
}

function editUserDialog(userId, name, role, status) {
  const body = `${field("Full name", "full_name", { value: name })}${field("Role", "role", { type: "select", value: role, options: [{ value: "administrator", label: "Administrator" }, { value: "technician", label: "Technician" }, { value: "viewer", label: "Viewer" }] })}${field("Account status", "status", { type: "select", value: status, options: [{ value: "active", label: "Active" }, { value: "disabled", label: "Disabled" }] })}<div class="modal-note">Disabled users are denied access by Row Level Security. You cannot change your own account from this list.</div>`;
  showModal({ title: "Update user access", body, submitLabel: "Save changes", onSubmit: async (form) => {
    await invoke("admin-api", { action: "update_user", user_id: userId, full_name: String(form.get("full_name")).trim(), role: String(form.get("role")), status: String(form.get("status")) });
    toast("User access updated.");
    await navigate("users", { push: false });
  } });
}

function accountDialog() {
  const body = `${field("Full name", "full_name", { value: state.profile.full_name || "" })}<div class="info-card mb-3"><label>Account email</label><b>${escapeHtml(state.user.email || "")}</b></div>${field("New password", "password", { type: "password", placeholder: "Leave blank to keep the current password", help: "Use at least 12 characters. Supabase applies your project's password policy." })}<div class="modal-note">User role: <b>${escapeHtml(roleNames[state.profile.role])}</b></div>`;
  showModal({ title: "My profile", body, submitLabel: "Save profile", onSubmit: async (form) => {
    const password = String(form.get("password") ?? "");
    if (password && password.length < 12) throw new Error("Choose a password with at least 12 characters.");
    if (password) {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
    }
    const fullName = String(form.get("full_name") ?? "").trim();
    await invoke("admin-api", { action: "update_profile", full_name: fullName });
    state.profile.full_name = fullName;
    document.querySelector("#user-name").textContent = fullName || state.user.email;
    document.querySelector("#user-avatar").textContent = (fullName || state.user.email || "U").trim().charAt(0).toUpperCase();
    toast("Profile saved.");
  } });
}

async function renderSettings() {
  const { data, error } = await supabase.from("alert_settings").select("cpu_warning, ram_warning, disk_warning, offline_after_minutes").eq("id", true).single();
  if (error) throw error;
  const body = `<section class="panel"><div class="panel-title"><div><h3>Health alert thresholds</h3><p>Alerts open when reported health moves above a configured warning value.</p></div><i class="bi bi-sliders text-primary"></i></div><form id="settings-form" class="settings-grid">${field("CPU usage warning (%)", "cpu_warning", { type: "number", value: data.cpu_warning, min: "1", max: "100", step: "1", required: true })}${field("RAM usage warning (%)", "ram_warning", { type: "number", value: data.ram_warning, min: "1", max: "100", step: "1", required: true })}${field("Disk usage warning (%)", "disk_warning", { type: "number", value: data.disk_warning, min: "1", max: "100", step: "1", required: true })}${field("Offline after (minutes)", "offline_after_minutes", { type: "number", value: data.offline_after_minutes, min: "1", max: "1440", step: "1", required: true })}<div class="d-flex align-items-center"><button class="btn btn-primary" type="submit"><i class="bi bi-check2 me-1"></i>Save thresholds</button></div></form></section><section class="panel mt-3"><div class="panel-title"><div><h3>PC agent security</h3><p>Agents use one-time pairing codes and encrypted device credentials.</p></div><i class="bi bi-shield-lock text-primary"></i></div><p class="text-secondary small">Credentials are stored as hashes in Supabase. The local credential is protected using Windows DPAPI. Revoke an agent from the computer’s detail page if a device leaves the organization.</p><p class="text-secondary small mb-0">Start with the <a href="../docs/installation.md" target="_blank" rel="noopener">installation and security guide</a>. Never place a Supabase service-role key in this dashboard.</p></section>`;
  content.innerHTML = `${heading("Settings", "Configure the health thresholds and review deployment security.", "", "ADMINISTRATION / ORGANIZATION")}${body}`;
}

function renderReports() {
  const items = [
    ["Hardware inventory", "bi-cpu", "Export computer hardware specifications.", "hardware"],
    ["Software inventory", "bi-box-seam", "Export installed software by computer.", "software"],
    ["Maintenance history", "bi-wrench-adjustable", "Export completed and upcoming maintenance records.", "maintenance"],
    ["Maintenance schedule", "bi-calendar3", "Export schedule dates, priority, and status.", "schedules"],
    ["Troubleshooting records", "bi-bug", "Export reported problems and solutions.", "problems"],
    ["Activity history", "bi-journal-text", "Export organization activity visible to your role.", "activity"],
  ];
  content.innerHTML = `${heading("Reports", "Export filtered operational data as CSV or print the current view.", '<button class="btn btn-outline-secondary" data-action="print"><i class="bi bi-printer me-1"></i>Print this page</button>', "REPORTS / EXPORTS")}<div class="row g-3">${items.map(([title, icon, description, view]) => `<div class="col-md-6 col-xl-4"><section class="report-card h-100"><i class="bi ${icon}"></i><h4>${title}</h4><p>${description}</p><div class="d-flex gap-2"><button class="btn btn-soft btn-sm" data-action="report-export" data-view="${view}"><i class="bi bi-download me-1"></i>Export CSV</button><button class="btn btn-outline-secondary btn-sm" data-view="${view}">View records</button></div></section></div>`).join("")}</div><p class="modal-note mt-3">CSV exports respect Row Level Security and include up to 5,000 matching rows. Use the page search and filters before exporting.</p>`;
}

async function saveSettings(form) {
  const numbers = ["cpu_warning", "ram_warning", "disk_warning", "offline_after_minutes"].map((key) => Number(form.get(key)));
  if (numbers.some((number) => !Number.isFinite(number) || number <= 0)) return toast("Enter valid positive threshold values.", "warning");
  const { error } = await supabase.from("alert_settings").update({ cpu_warning: numbers[0], ram_warning: numbers[1], disk_warning: numbers[2], offline_after_minutes: numbers[3] }).eq("id", true);
  if (error) return toast(error.message, "danger");
  toast("Alert thresholds saved.");
}

async function currentComputer() {
  if (!state.detailId) return null;
  const { data, error } = await supabase.from("computers").select("id, computer_name, device_id, enrollment_status, remote_assistance_enabled, remote_assistance_instructions").eq("id", state.detailId).maybeSingle();
  if (error) throw error;
  return data;
}

async function refreshInventory(type) {
  const computer = await currentComputer();
  if (!computer) return;
  try {
    await queueCommand(computer.id, type, {});
    toast(`${type.replaceAll("_", " ")} requested. The result will appear after the agent checks in.`);
  } catch (error) { toast(error.message, "danger"); }
}

function bindAuth() {
  const loginForm = document.querySelector("#login-form");
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = loginForm.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const values = new FormData(loginForm);
      const { error } = await supabase.auth.signInWithPassword({ email: String(values.get("email")).trim(), password: String(values.get("password")) });
      if (error) throw error;
    } catch (error) {
      const box = document.querySelector("#auth-message");
      box.textContent = error.message || "Unable to sign in.";
      box.className = "alert alert-danger";
    } finally { button.disabled = false; }
  });
  document.querySelector("#forgot-password").addEventListener("click", async () => {
    const email = String(loginForm.elements.email.value ?? "").trim();
    if (!email) {
      const box = document.querySelector("#auth-message");
      box.textContent = "Enter your work email first, then choose Forgot your password.";
      box.className = "alert alert-warning";
      loginForm.elements.email.focus();
      return;
    }
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}${location.pathname}` });
      if (error) throw error;
      const box = document.querySelector("#auth-message");
      box.textContent = "If this address belongs to an invited user, Supabase will send password reset instructions.";
      box.className = "alert alert-success";
    } catch (error) {
      const box = document.querySelector("#auth-message");
      box.textContent = error.message || "The reset request could not be sent.";
      box.className = "alert alert-danger";
    }
  });
}

async function handleAction(action, element) {
  if (action === "refresh") return navigate(state.view, { push: false });
  if (action === "add-computer") return addComputerDialog();
  if (action === "open-computer") return openComputer(element.dataset.id);
  if (action === "invite-user") return inviteUserDialog();
  if (action === "edit-user") return editUserDialog(element.dataset.id, element.dataset.name, element.dataset.role, element.dataset.status);
  if (action === "export-records") return exportView(element.dataset.view);
  if (action === "export-hardware") return exportHardware();
  if (action === "export-computers") return exportComputers();
  if (action === "print") return window.print();
  if (action === "report-export") return element.dataset.view === "hardware" ? exportHardware() : exportView(element.dataset.view);
  if (action === "detail-tab") {
    state.detailTab = element.dataset.tab;
    return navigate("computer-detail");
  }
  if (action === "page") {
    const key = state.view === "computers" ? "computers" : state.view === "hardware" ? "hardware" : state.view === "computer-detail" ? `detail-${state.detailTab}` : state.view;
    const list = listState(key);
    list.page = Number(element.dataset.page) || 1;
    return navigate(state.view, { push: false });
  }
  if (action === "sort") {
    const key = state.view === "computers" ? "computers" : state.view === "hardware" ? "hardware" : state.view === "computer-detail" ? `detail-${state.detailTab}` : state.view;
    const list = listState(key);
    list.ascending = list.sort === element.dataset.sort ? !list.ascending : true;
    list.sort = element.dataset.sort;
    list.page = 1;
    return navigate(state.view, { push: false });
  }
  if (action === "pair-agent") {
    const computer = await currentComputer();
    if (computer) await beginPairing(computer);
    return;
  }
  if (action === "revoke-agent") {
    const computer = await currentComputer();
    if (computer) await revokeAgent(computer);
    return;
  }
  if (action === "manage-assignments") {
    const computer = await currentComputer();
    if (computer) await manageAssignments(computer);
    return;
  }
  if (action === "edit-remote") {
    const computer = await currentComputer();
    if (computer) await editRemoteAssistance(computer);
    return;
  }
  if (action === "request-system-info") return refreshInventory("GET_SYSTEM_INFO");
  if (action === "refresh-inventory") return refreshInventory(element.dataset.type);
  if (action === "queue-command") {
    try { await queueCommand(state.detailId, element.dataset.type, {}); await navigate("computer-detail", { push: false }); }
    catch (error) { toast(error.message, "danger"); }
    return;
  }
  if (action === "confirm-power") {
    const computer = await currentComputer();
    if (computer) confirmPowerAction(computer, element.dataset.type);
    return;
  }
  if (action === "stop-process") {
    const computer = await currentComputer();
    if (computer) confirmStopProcess(computer, element.dataset.id, element.dataset.name);
    return;
  }
  if (action === "service-command") {
    const computer = await currentComputer();
    if (computer) confirmServiceAction(computer, element.dataset.type, element.dataset.name);
    return;
  }
  if (action === "new-record") return openRecordForm(element.dataset.view);
  if (action === "new-maintenance") return openRecordForm("maintenance", element.dataset.computer);
  if (action === "new-problem") return openRecordForm("problems", element.dataset.computer);
  if (action === "update-record-status") return updateRecordStatus(element.dataset.view, element.dataset.id, element.dataset.status);
  if (action === "ack-alert") return acknowledgeAlert(element.dataset.id);
  if (action === "notification") return navigate("alerts");
}

function bindApplication() {
  document.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-action], [data-view]");
    if (target) {
      if (target.dataset.action) {
        event.preventDefault();
        try { await handleAction(target.dataset.action, target); }
        catch (error) { toast(error.message || "The action could not be completed.", "danger"); }
      } else if (target.dataset.view) {
        event.preventDefault();
        await navigate(target.dataset.view);
      }
      return;
    }
    if (event.target.closest("#sidebar-toggle")) {
      const sidebar = document.querySelector("#sidebar");
      sidebar.classList.toggle("open");
      document.querySelector(".mobile-shade")?.classList.toggle("show", sidebar.classList.contains("open"));
    } else if (event.target.closest(".mobile-shade")) {
      document.querySelector("#sidebar").classList.remove("open");
      document.querySelector(".mobile-shade")?.classList.remove("show");
    } else if (event.target.closest("#notification-button")) {
      if (state.profile?.role === "viewer") return navigate("dashboard");
      await navigate("alerts");
    } else if (event.target.closest("#user-menu-button")) accountDialog();
  });

  document.addEventListener("input", (event) => {
    if (!event.target.matches("[data-search]")) return;
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      const key = state.view === "computers" ? "computers" : state.view === "hardware" ? "hardware" : state.view === "computer-detail" ? `detail-${state.detailTab}` : state.view;
      const list = listState(key);
      list.search = safeSearch(event.target.value);
      list.page = 1;
      void navigate(state.view, { push: false });
    }, 220);
  });

  document.addEventListener("change", (event) => {
    if (event.target.matches("[data-filter]")) {
      const key = state.view === "computers" ? "computers" : state.view;
      const list = listState(key);
      list.filter = event.target.value;
      list.page = 1;
      void navigate(state.view, { push: false });
    } else if (event.target.matches("[data-computer-filter]")) {
      const list = listState(state.view);
      list.computerId = event.target.value;
      list.page = 1;
      void navigate(state.view, { push: false });
    }
  });

  document.addEventListener("submit", async (event) => {
    if (event.target.id === "settings-form") {
      event.preventDefault();
      await saveSettings(new FormData(event.target));
    }
  });

  window.addEventListener("hashchange", () => { if (state.profile) void navigate(readHashView(), { push: false }); });
  window.addEventListener("popstate", () => { if (state.profile) void navigate(readHashView(), { push: false }); });
}

function start() {
  if (configurationError) {
    showAuth("Configure dashboard/config.js with your Supabase project URL and publishable key, then reload this page.");
    document.querySelector("#login-form button[type=submit]").disabled = true;
    document.querySelector("#forgot-password").disabled = true;
    return;
  }
  bindAuth();
  bindApplication();
  supabase.auth.onAuthStateChange((event, session) => {
    if (!["INITIAL_SESSION", "SIGNED_IN", "SIGNED_OUT", "USER_UPDATED", "PASSWORD_RECOVERY"].includes(event)) return;
    setTimeout(async () => {
      try {
        await activateSession(session?.user ?? null);
        if (event === "SIGNED_IN" && session?.user) await auditQuiet("LOGIN", "Signed in to the management dashboard.");
        if (event === "PASSWORD_RECOVERY" && session?.user) setTimeout(accountDialog, 100);
      } catch (error) { showAuth(error.message || "Could not load your account."); }
    }, 0);
  });
}

start();
