export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));

export const formatDate = (value, withTime = false) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  return new Intl.DateTimeFormat(undefined, withTime
    ? { dateStyle: "medium", timeStyle: "short" }
    : { dateStyle: "medium" }).format(date);
};

export const formatBytes = (value) => {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const step = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** step)).toFixed(step > 1 ? 1 : 0)} ${units[step]}`;
};

export const formatUptime = (seconds) => {
  const value = Math.max(0, Number(seconds) || 0);
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  return `${days ? `${days}d ` : ""}${hours}h ${minutes}m`;
};

export const statusBadge = (value) => {
  const label = String(value ?? "Unknown");
  const style = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `<span class="status-badge status-${escapeHtml(style)}">${escapeHtml(label.replaceAll("_", " "))}</span>`;
};

export function heading(title, description, actions = "", kicker = "OPERATIONS") {
  return `<div class="page-heading"><div><div class="heading-kicker">${escapeHtml(kicker)}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div><div class="heading-actions">${actions}</div></div>`;
}

export function emptyState(icon, title, description) {
  return `<div class="empty-state"><i class="bi ${escapeHtml(icon)}"></i><h4>${escapeHtml(title)}</h4><p>${escapeHtml(description)}</p></div>`;
}

export function dataTable(columns, rows, { emptyTitle = "Nothing here yet", emptyText = "Records will appear here when available.", icon = "bi-inbox", colspan } = {}) {
  if (!rows.length) return emptyState(icon, emptyTitle, emptyText);
  const head = columns.map((column) => `<th>${column.sort ? `<button class="table-link" data-action="sort" data-sort="${escapeHtml(column.sort)}">${escapeHtml(column.label)} <i class="bi bi-arrow-down-up ms-1"></i></button>` : escapeHtml(column.label)}</th>`).join("");
  const body = rows.map((row) => `<tr>${columns.map((column) => `<td>${column.render ? column.render(row) : escapeHtml(row[column.key])}</td>`).join("")}</tr>`).join("");
  return `<div class="table-overflow"><table class="data-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function tablePanel({ columns, rows, search = "", placeholder = "Search records...", filters = "", tools = "", page = 1, pageSize = 10, count = rows.length, onPage = true, emptyTitle, emptyText, icon }) {
  const from = count ? ((page - 1) * pageSize + 1) : 0;
  const to = Math.min(page * pageSize, count);
  const pages = Math.max(1, Math.ceil(count / pageSize));
  return `<section class="table-card"><div class="table-toolbar"><div class="toolbar-left"><label class="search-wrap"><i class="bi bi-search"></i><input class="search-input" data-search placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(search)}" aria-label="Search"></label>${filters}</div><div class="toolbar-right">${tools}</div></div>${dataTable(columns, rows, { emptyTitle, emptyText, icon })}${onPage ? `<div class="table-pagination"><span>Showing ${from}–${to} of ${count} records</span><div class="pagination-buttons"><button class="page-btn" data-action="page" data-page="${Math.max(1, page - 1)}" ${page <= 1 ? "disabled" : ""}><i class="bi bi-chevron-left"></i></button><span class="page-btn active">${page} / ${pages}</span><button class="page-btn" data-action="page" data-page="${Math.min(pages, page + 1)}" ${page >= pages ? "disabled" : ""}><i class="bi bi-chevron-right"></i></button></div></div>` : ""}</section>`;
}

export function toast(message, kind = "success") {
  const root = document.querySelector("#toast-root");
  const id = `toast-${crypto.randomUUID()}`;
  const color = kind === "danger" ? "text-bg-danger" : kind === "warning" ? "text-bg-warning" : "text-bg-dark";
  root.insertAdjacentHTML("beforeend", `<div id="${id}" class="toast ${color}" role="status" aria-live="polite"><div class="d-flex"><div class="toast-body">${escapeHtml(message)}</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button></div></div>`);
  const element = document.getElementById(id);
  const instance = new bootstrap.Toast(element, { delay: 3800 });
  element.addEventListener("hidden.bs.toast", () => element.remove());
  instance.show();
}

export function showModal({ title, body, submitLabel = "Save", danger = false, closeLabel = "Cancel", onSubmit = null, large = false }) {
  const root = document.querySelector("#modal-root");
  const id = `modal-${crypto.randomUUID()}`;
  root.innerHTML = `<div class="modal fade" id="${id}" tabindex="-1" aria-hidden="true"><div class="modal-dialog modal-dialog-centered ${large ? "modal-lg" : ""}"><div class="modal-content"><form data-modal-form><div class="modal-header"><h2 class="modal-title">${escapeHtml(title)}</h2><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div><div class="modal-body">${body}</div><div class="modal-footer"><button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">${escapeHtml(closeLabel)}</button>${submitLabel ? `<button type="submit" class="btn ${danger ? "btn-danger" : "btn-primary"}">${escapeHtml(submitLabel)}</button>` : ""}</div></form></div></div></div>`;
  const element = document.getElementById(id);
  const instance = new bootstrap.Modal(element);
  element.addEventListener("hidden.bs.modal", () => { instance.dispose(); root.innerHTML = ""; });
  if (onSubmit) element.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('[type="submit"]');
    if (button) { button.disabled = true; button.dataset.previousLabel = button.innerHTML; button.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Working'; }
    try {
      const result = await onSubmit(new FormData(event.currentTarget), event.currentTarget);
      if (result !== false) instance.hide();
    } catch (error) {
      toast(error.message || "The request could not be completed.", "danger");
      if (button) { button.disabled = false; button.innerHTML = button.dataset.previousLabel; }
    }
  });
  instance.show();
  return instance;
}

export function field(label, name, { type = "text", value = "", required = false, placeholder = "", options = [], help = "", rows = 3, min = "", max = "", step = "" } = {}) {
  const id = `field-${name}`;
  let control;
  if (type === "textarea") control = `<textarea class="form-control" id="${id}" name="${escapeHtml(name)}" rows="${rows}" ${required ? "required" : ""} placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea>`;
  else if (type === "select") control = `<select class="form-select" id="${id}" name="${escapeHtml(name)}" ${required ? "required" : ""}><option value="">Select ${escapeHtml(label.toLowerCase())}</option>${options.map((option) => `<option value="${escapeHtml(option.value)}" ${String(option.value) === String(value) ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}</select>`;
  else control = `<input class="form-control" id="${id}" type="${escapeHtml(type)}" name="${escapeHtml(name)}" value="${escapeHtml(value)}" ${required ? "required" : ""} placeholder="${escapeHtml(placeholder)}" ${min !== "" ? `min="${escapeHtml(min)}"` : ""} ${max !== "" ? `max="${escapeHtml(max)}"` : ""} ${step !== "" ? `step="${escapeHtml(step)}"` : ""}>`;
  return `<div class="mb-3"><label class="form-label" for="${id}">${escapeHtml(label)}${required ? ' <span class="text-danger">*</span>' : ""}</label>${control}${help ? `<div class="form-text">${escapeHtml(help)}</div>` : ""}</div>`;
}

export function downloadCsv(filename, rows, columns) {
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const content = [columns.map((column) => quote(column.label)).join(","), ...rows.map((row) => columns.map((column) => quote(column.csv ? column.csv(row) : row[column.key])).join(","))].join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob(["\ufeff", content], { type: "text/csv;charset=utf-8" }));
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}
