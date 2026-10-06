import { activeProfile, preflight, reply, serviceClient, signedInUser } from "../_shared/http.ts";

Deno.serve(async (request) => {
  const options = preflight(request);
  if (options) return options;
  if (request.method !== "POST") return reply({ error: "Method not allowed." }, 405);
  try {
    let authorized = false;
    const cronSecret = Deno.env.get("CRON_SECRET");
    if (cronSecret && request.headers.get("x-cron-secret") === cronSecret) authorized = true;
    if (!authorized) {
      const user = await signedInUser(request);
      const profile = user ? await activeProfile(user.id) : null;
      authorized = profile?.role === "administrator";
    }
    if (!authorized) return reply({ error: "Administrator access is required." }, 403);
    const admin = serviceClient();
    const { data: settings, error: settingsError } = await admin.from("alert_settings").select("offline_after_minutes").eq("id", true).single();
    if (settingsError) throw settingsError;
    const threshold = new Date(Date.now() - settings.offline_after_minutes * 60_000).toISOString();
    const { data: staleComputers, error } = await admin.from("computers").select("id, computer_name, last_seen").eq("enrollment_status", "active").lt("last_seen", threshold);
    if (error) throw error;
    for (const computer of staleComputers ?? []) {
      await admin.from("computers").update({ status: "offline" }).eq("id", computer.id).neq("status", "offline");
      const { data: open } = await admin.from("alerts").select("id").eq("computer_id", computer.id).eq("alert_type", "computer_offline").in("status", ["Open", "Acknowledged"]).maybeSingle();
      if (!open) await admin.from("alerts").insert({ computer_id: computer.id, alert_type: "computer_offline", severity: "Critical", message: `${computer.computer_name} has not checked in since ${computer.last_seen ?? "registration"}.` });
    }
    const { data: due, error: dueError } = await admin.from("maintenance_schedules").select("id, computer_id, maintenance_type, scheduled_date").eq("status", "Scheduled").lt("scheduled_date", new Date().toISOString().slice(0, 10));
    if (dueError) throw dueError;
    for (const item of due ?? []) {
      await admin.from("maintenance_schedules").update({ status: "Overdue" }).eq("id", item.id);
      const { data: open } = await admin.from("alerts").select("id").eq("computer_id", item.computer_id).eq("alert_type", `maintenance_${item.id}`).in("status", ["Open", "Acknowledged"]).maybeSingle();
      if (!open) await admin.from("alerts").insert({ computer_id: item.computer_id, alert_type: `maintenance_${item.id}`, severity: "Warning", message: `${item.maintenance_type} scheduled for ${item.scheduled_date} is overdue.` });
    }
    const { data: online } = await admin.from("computers").select("id").eq("enrollment_status", "active").gte("last_seen", threshold);
    for (const computer of online ?? []) {
      await admin.from("computers").update({ status: "online" }).eq("id", computer.id).neq("status", "online");
      await admin.from("alerts").update({ status: "Resolved", resolved_at: new Date().toISOString() }).eq("computer_id", computer.id).eq("alert_type", "computer_offline").in("status", ["Open", "Acknowledged"]);
    }
    return reply({ ok: true, offline_count: staleComputers?.length ?? 0, overdue_count: due?.length ?? 0 });
  } catch (error) {
    console.error("evaluate-alerts", error);
    return reply({ error: "Alert evaluation could not be completed." }, 500);
  }
});
