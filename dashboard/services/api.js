import { supabase } from "./supabase.js";

export async function invoke(name, body = {}) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    const message = data?.error || error.message || "The request could not be completed.";
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
