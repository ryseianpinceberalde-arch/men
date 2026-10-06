import { isRecord, preflight, reply, serviceClient, sha256 } from "../_shared/http.ts";

const limits = { software: 2500, processes: 2000, services: 2500 };
const textValue = (value: unknown, maximum = 200): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, maximum) : null;
const nonNegativeNumber = (value: unknown): number => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
};

function cleanHardwareRows(value: unknown, map: (item: Record<string, unknown>) => Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord).slice(0, 64).map(map) : [];
}

async function updateAlert(admin: ReturnType<typeof serviceClient>, computerId: string, kind: string, active: boolean, severity: string, message: string) {
  const { data: existing, error } = await admin.from("alerts").select("id").eq("computer_id", computerId).eq("alert_type", kind).in("status", ["Open", "Acknowledged"]).maybeSingle();
  if (error) throw error;
  if (active && !existing) {
    const { error: insertError } = await admin.from("alerts").insert({ computer_id: computerId, alert_type: kind, severity, message });
    if (insertError) throw insertError;
  } else if (!active && existing) {
    const { error: resolveError } = await admin.from("alerts").update({ status: "Resolved", resolved_at: new Date().toISOString() }).eq("id", existing.id);
    if (resolveError) throw resolveError;
  }
}

async function storeInventory(admin: ReturnType<typeof serviceClient>, computerId: string, type: string, result: Record<string, unknown>) {
  const rows = Array.isArray(result[type]) ? (result[type] as unknown[]).filter(isRecord) : [];
  if (rows.length > limits[type as keyof typeof limits]) throw new Error(`${type} inventory is larger than the allowed limit.`);
  const table = type === "software" ? "installed_software" : type;
  if (type === "processes" || type === "software" || type === "services") {
    const { error: deleteError } = await admin.from(table).delete().eq("computer_id", computerId);
    if (deleteError) throw deleteError;
  }
  if (type === "software") {
    const items = rows.flatMap((item) => {
      const softwareName = textValue(item.software_name);
      if (!softwareName) return [];
      return [{ computer_id: computerId, software_name: softwareName, version: textValue(item.version), publisher: textValue(item.publisher), install_date: textValue(item.install_date, 20), scanned_at: new Date().toISOString() }];
    });
    for (let start = 0; start < items.length; start += 500) {
      const { error } = await admin.from(table).upsert(items.slice(start, start + 500), { onConflict: "computer_id,software_name,version" });
      if (error) throw error;
    }
    return;
  }
  if (type === "processes") {
    const items = rows.flatMap((item) => {
      const processId = Number(item.process_id);
      const processName = textValue(item.process_name);
      if (!Number.isInteger(processId) || processId <= 0 || !processName) return [];
      return [{ computer_id: computerId, process_id: processId, process_name: processName, cpu_usage: Number(item.cpu_usage) || 0, memory_usage: Math.max(0, Number(item.memory_usage) || 0), updated_at: new Date().toISOString() }];
    });
    for (let start = 0; start < items.length; start += 500) {
      const { error } = await admin.from(table).upsert(items.slice(start, start + 500), { onConflict: "computer_id,process_id" });
      if (error) throw error;
    }
    return;
  }
  if (type === "services") {
    const items = rows.flatMap((item) => {
      const serviceName = textValue(item.service_name);
      const displayName = textValue(item.display_name) ?? serviceName;
      if (!serviceName || !displayName) return [];
      const status = ["running", "stopped", "paused", "start_pending", "stop_pending"].includes(String(item.status)) ? String(item.status) : "unknown";
      return [{ computer_id: computerId, service_name: serviceName, display_name: displayName, status, startup_type: textValue(item.startup_type) ?? "unknown", updated_at: new Date().toISOString() }];
    });
    for (let start = 0; start < items.length; start += 500) {
      const { error } = await admin.from(table).upsert(items.slice(start, start + 500), { onConflict: "computer_id,service_name" });
      if (error) throw error;
    }
  }
}

Deno.serve(async (request) => {
  const options = preflight(request);
  if (options) return options;
  if (request.method !== "POST") return reply({ error: "Method not allowed." }, 405);
  try {
    const authorization = request.headers.get("Authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) return reply({ error: "Device authentication is required." }, 401);
    const credentialHash = await sha256(authorization.slice(7));
    const admin = serviceClient();
    const { data: credential, error: credentialError } = await admin.from("agent_credentials").select("computer_id, revoked_at, computers!inner(enrollment_status)").eq("token_hash", credentialHash).maybeSingle();
    if (credentialError) throw credentialError;
    if (!credential || credential.revoked_at) return reply({ error: "Device credential is invalid or revoked." }, 401);
    const computerRelation = credential.computers as unknown as { enrollment_status: string };
    if (computerRelation.enrollment_status !== "active") return reply({ error: "This device is not active." }, 403);
    const computerId = credential.computer_id;
    const body: unknown = await request.json();
    if (!isRecord(body) || typeof body.action !== "string") return reply({ error: "Invalid agent request." }, 400);
    await admin.from("agent_credentials").update({ last_used_at: new Date().toISOString() }).eq("computer_id", computerId);

    if (body.action === "heartbeat") {
      if (!isRecord(body.system) || !isRecord(body.specs)) return reply({ error: "System status and hardware information are required." }, 400);
      const system = body.system;
      const specs = body.specs;
      const now = new Date().toISOString();
      const computerUpdate = {
        computer_name: textValue(system.computer_name, 120) ?? "Windows computer",
        manufacturer: textValue(specs.manufacturer),
        model: textValue(specs.model),
        serial_number: textValue(specs.serial_number),
        os_name: textValue(system.os_name),
        os_version: textValue(system.os_version),
        architecture: textValue(system.architecture, 40),
        ip_address: textValue(system.ip_address, 64),
        mac_address: textValue(specs.mac_address, 40),
        last_seen: now,
        status: "online",
      };
      const { error: computerError } = await admin.from("computers").update(computerUpdate).eq("id", computerId);
      if (computerError) throw computerError;
      const { error: specsError } = await admin.from("computer_specs").upsert({
        computer_id: computerId,
        cpu_name: textValue(specs.cpu_name),
        cpu_cores: Math.max(0, Number(specs.cpu_cores) || 0),
        logical_processors: Math.max(0, Number(specs.logical_processors) || 0),
        ram_total: Math.max(0, Number(specs.ram_total) || 0),
        gpu_name: textValue(specs.gpu_name),
        motherboard: textValue(specs.motherboard),
        bios: textValue(specs.bios),
        storage_total: Math.max(0, Number(specs.storage_total) || 0),
        storage_free: Math.max(0, Number(specs.storage_free) || 0),
        storage_devices: cleanHardwareRows(specs.storage_devices, (item) => ({
          name: textValue(item.name, 120) ?? "Storage device",
          model: textValue(item.model, 200),
          serial_number: textValue(item.serial_number, 120),
          size_bytes: nonNegativeNumber(item.size_bytes),
          free_bytes: nonNegativeNumber(item.free_bytes),
          file_system: textValue(item.file_system, 40),
        })),
        network_adapters: cleanHardwareRows(specs.network_adapters, (item) => ({
          name: textValue(item.name, 120) ?? "Network adapter",
          description: textValue(item.description, 200),
          type: textValue(item.type, 80) ?? "unknown",
          status: textValue(item.status, 40) ?? "unknown",
          mac_address: textValue(item.mac_address, 40),
          ip_addresses: Array.isArray(item.ip_addresses)
            ? item.ip_addresses.filter((ip): ip is string => typeof ip === "string").slice(0, 16).map((ip) => ip.trim().slice(0, 64))
            : [],
        })),
        updated_at: now,
      }, { onConflict: "computer_id" });
      if (specsError) throw specsError;
      const cpu = Math.min(100, Math.max(0, Number(system.cpu_usage) || 0));
      const ram = Math.min(100, Math.max(0, Number(system.ram_usage) || 0));
      const disk = Math.min(100, Math.max(0, Number(system.disk_usage) || 0));
      const { data: latest, error: latestError } = await admin.from("computer_status").select("recorded_at").eq("computer_id", computerId).order("recorded_at", { ascending: false }).limit(1).maybeSingle();
      if (latestError) throw latestError;
      if (!latest || Date.now() - new Date(latest.recorded_at).getTime() >= 5 * 60_000) {
        const { error } = await admin.from("computer_status").insert({ computer_id: computerId, cpu_usage: cpu, ram_usage: ram, disk_usage: disk, uptime: Math.max(0, Number(system.uptime) || 0), recorded_at: now });
        if (error) throw error;
      }
      const { data: thresholds, error: thresholdError } = await admin.from("alert_settings").select("cpu_warning, ram_warning, disk_warning").eq("id", true).single();
      if (thresholdError) throw thresholdError;
      await updateAlert(admin, computerId, "high_cpu", cpu > thresholds.cpu_warning, "Warning", `CPU usage is ${cpu.toFixed(0)}%.`);
      await updateAlert(admin, computerId, "high_ram", ram > thresholds.ram_warning, "Warning", `Memory usage is ${ram.toFixed(0)}%.`);
      await updateAlert(admin, computerId, "disk_full", disk > thresholds.disk_warning, "Warning", `Storage usage is ${disk.toFixed(0)}%.`);
      return reply({ ok: true, received_at: now });
    }

    if (body.action === "poll") {
      const { data, error } = await admin.rpc("claim_next_command", { target_computer: computerId });
      if (error) throw error;
      const command = Array.isArray(data) ? data[0] : null;
      return reply({ command: command ? { id: command.id, command_type: command.command_type, parameters: command.parameters, expires_at: command.expires_at } : null });
    }

    if (body.action === "command_start") {
      if (typeof body.command_id !== "string") return reply({ error: "Invalid command ID." }, 400);
      const startedAt = new Date().toISOString();
      const { data: started, error } = await admin.from("commands").update({ status: "processing" })
        .eq("id", body.command_id).eq("computer_id", computerId).eq("status", "received").gt("expires_at", startedAt)
        .select("id").maybeSingle();
      if (error) throw error;
      if (!started) return reply({ error: "Command expired or has already been claimed." }, 409);
      return reply({ ok: true });
    }

    if (body.action === "command_result") {
      if (typeof body.command_id !== "string" || !["completed", "failed", "rejected"].includes(String(body.status))) return reply({ error: "Invalid command result." }, 400);
      const { data: command, error: commandError } = await admin.from("commands").select("id, computer_id, command_type, status, expires_at").eq("id", body.command_id).eq("computer_id", computerId).maybeSingle();
      if (commandError) throw commandError;
      if (!command) return reply({ error: "Command is unavailable." }, 404);
      if (command.status === body.status && command.status !== "pending") return reply({ ok: true });
      if (!["received", "processing"].includes(command.status)) return reply({ error: "Command is unavailable." }, 404);
      if (command.status === "received" && new Date(command.expires_at).getTime() <= Date.now()) {
        await admin.from("commands").update({ status: "expired", executed_at: new Date().toISOString() }).eq("id", command.id);
        return reply({ error: "Command expired before execution completed." }, 410);
      }
      const safeResult = isRecord(body.result) ? body.result : {};
      if (command.command_type === "GET_PROCESSES") await storeInventory(admin, computerId, "processes", safeResult);
      if (command.command_type === "GET_SERVICES") await storeInventory(admin, computerId, "services", safeResult);
      if (command.command_type === "GET_SOFTWARE") await storeInventory(admin, computerId, "software", safeResult);
      const status = String(body.status);
      const errorMessage = typeof body.error_message === "string" ? body.error_message.slice(0, 1000) : null;
      const { error: updateError } = await admin.from("commands").update({ status, result: safeResult, error_message: errorMessage, executed_at: new Date().toISOString() }).eq("id", command.id);
      if (updateError) throw updateError;
      const action = command.command_type;
      await admin.from("activity_logs").insert({ computer_id: computerId, action, description: `Agent reported ${status} for ${command.command_type}.`, result: status === "completed" ? "success" : status });
      return reply({ ok: true });
    }

    return reply({ error: "Unknown agent action." }, 400);
  } catch (error) {
    console.error("agent-api", error);
    return reply({ error: "The agent request could not be completed." }, 500);
  }
});
