import { supabase } from "./supabase.js";

export async function invoke(name, body = {}) {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  const session = sessionData?.session;
  const signInMessage = "Your session has expired. Please sign in again.";
  if (!session?.access_token) throw new Error(signInMessage);

  const send = (accessToken) => supabase.functions.invoke(name, {
    body,
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  let { data, error } = await send(session.access_token);
  if (error?.context?.status === 401) {
    // Auth rejection happens before the action runs. Retry once with the same
    // body (including the End Task idempotency key), using a refreshed token.
    const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError) throw refreshError;
    if (!refreshed?.session?.access_token || refreshed.session.user.id !== session.user.id) {
      throw new Error(signInMessage);
    }
    ({ data, error } = await send(refreshed.session.access_token));
  }
  if (error) {
    let responseError;
    const response = error.context;
    if (response && typeof response.clone === "function") {
      try {
        const payload = await response.clone().json();
        if (typeof payload?.error === "string" && payload.error.trim()) responseError = payload.error;
      } catch {
        // Non-JSON responses fall back to the Functions client's message.
      }
    }
    const message = data?.error || responseError || error.message || "The request could not be completed.";
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function recordActivity(action, description, computerId = null, result = "success") {
  return invoke("record-activity", { action, description, computer_id: computerId, result });
}

export function safeSearch(value) {
  return String(value ?? "").replace(/[^\p{L}\p{N}@._\- ]/gu, "").trim().slice(0, 100);
}

export async function latestStatusFor(ids) {
  if (!ids.length) return new Map();
  const { data, error } = await supabase.from("computer_status")
    .select("computer_id, cpu_usage, ram_usage, disk_usage, uptime, recorded_at")
    .in("computer_id", ids).order("recorded_at", { ascending: false }).limit(Math.min(ids.length * 5, 500));
  if (error) throw error;
  const latest = new Map();
  for (const row of data ?? []) if (!latest.has(row.computer_id)) latest.set(row.computer_id, row);
  return latest;
}

export async function listTechnicians() {
  const { data, error } = await supabase.from("profiles").select("id, full_name, role").eq("role", "technician").eq("status", "active").order("full_name");
  if (error) throw error;
  return data ?? [];
}
