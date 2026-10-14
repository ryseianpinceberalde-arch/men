import { activeProfile, isRecord, preflight, randomToken, reply, serviceClient, sha256, signedInUser } from "../_shared/http.ts";

const allowedRoles = new Set(["administrator", "technician", "viewer"]);
const isUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function sameProcessRequest(parameters: unknown, computerId: string, processId: number, processName: string, startedAt: string, force: boolean): boolean {
  if (!isRecord(parameters)) return false;
  return parameters.computer_id === computerId &&
    Number(parameters.process_id) === processId &&
    String(parameters.process_name).toLowerCase() === processName.toLowerCase() &&
    Date.parse(String(parameters.process_started_at)) === Date.parse(startedAt) &&
    parameters.force === force;
}

Deno.serve(async (request) => {
  const options = preflight(request);
  if (options) return options;
  if (request.method !== "POST") return reply({ error: "Method not allowed." }, 405);
  try {
    const user = await signedInUser(request);
    if (!user) return reply({ error: "Sign in is required." }, 401);
    const caller = await activeProfile(user.id);
    if (!caller) return reply({ error: "This account is disabled." }, 403);
    const body: unknown = await request.json();
    if (!isRecord(body) || typeof body.action !== "string") return reply({ error: "Invalid request." }, 400);
    const admin = serviceClient();

    if (body.action === "update_profile") {
      if (typeof body.full_name !== "string" || body.full_name.trim().length > 120) return reply({ error: "Enter a name up to 120 characters." }, 400);
      const { error } = await admin.from("profiles").update({ full_name: body.full_name.trim() }).eq("id", user.id);
      if (error) throw error;
      await admin.from("activity_logs").insert({ user_id: user.id, action: "UPDATE_PROFILE", description: "Updated personal profile information.", result: "success" });
      return reply({ ok: true });
    }
    if (caller.role !== "administrator") return reply({ error: "Administrator access is required." }, 403);

    if (body.action === "network_command") {
      if (!isUuid(body.computer_id) || !isUuid(body.request_id) || !["GET_NETWORK_STATUS", "RUN_NETWORK_SPEED_TEST"].includes(String(body.command_type))) return reply({ error: "Invalid network command." }, 400);
      const { data, error } = await admin.rpc("queue_network_command", { target_computer: body.computer_id, actor: user.id, kind: body.command_type, request_key: body.request_id });
      if (error) return reply({ error: "Network command unavailable. Check agent freshness, pending requests, and the 15-minute speed-test cooldown." }, 409);
      return reply({ command_id: data }, 202);
    }

    if (body.action === "terminate_process") {
      if (!isUuid(body.computer_id) || !isUuid(body.request_id)) return reply({ error: "Select a valid computer and request ID." }, 400);
      const processId = Number(body.process_id);
      const processName = typeof body.process_name === "string" ? body.process_name.trim() : "";
      const processStartedAt = typeof body.process_started_at === "string" ? body.process_started_at.trim() : "";
      const force = body.force;
      if (!Number.isSafeInteger(processId) || processId <= 4 || processId > 2_147_483_647 || processName.length < 1 || processName.length > 256 || !Number.isFinite(Date.parse(processStartedAt)) || (force !== true && force !== false)) {
        return reply({ error: "The selected process identity is invalid. Refresh its inventory and try again." }, 400);
      }

      const { data: computer, error: computerError } = await admin.from("computers")
        .select("id, computer_name, enrollment_status")
        .eq("id", body.computer_id).maybeSingle();
      if (computerError) throw computerError;
      if (!computer) return reply({ error: "Computer not found." }, 404);
      if (force && body.force_confirmation !== `END TASK ${computer.computer_name}`) return reply({ error: "Type the computer confirmation phrase to authorize force termination." }, 400);

      const { data: existing, error: existingError } = await admin.from("commands")
        .select("id, command_type, parameters, status, result, error_message, expires_at")
        .eq("created_by", user.id).eq("idempotency_key", body.request_id).maybeSingle();
      if (existingError) throw existingError;
      if (existing) {
        if (existing.command_type !== "STOP_PROCESS" || !sameProcessRequest(existing.parameters, computer.id, processId, processName, processStartedAt, force)) {
          return reply({ error: "This request ID was already used for a different process action." }, 409);
        }
        return reply({ command_id: existing.id, status: existing.status, result: existing.result, error_message: existing.error_message, expires_at: existing.expires_at });
      }

      const { data: process, error: processError } = await admin.from("processes")
        .select("computer_id, process_id, process_name, process_started_at, updated_at")
        .eq("computer_id", computer.id).eq("process_id", processId).maybeSingle();
      if (processError) throw processError;
      const rejection = async (reason: string) => {
        const { error: auditError } = await admin.from("activity_logs").insert({
          user_id: user.id,
          computer_id: computer.id,
          action: "STOP_PROCESS",
          description: `${force ? "Force " : ""}End Task request rejected for ${processName} (PID ${processId}) on ${computer.computer_name}: ${reason}`.slice(0, 1000),
          result: "rejected",
        });
        if (auditError) throw auditError;
        return reply({ error: reason }, 409);
      };
      const { data: credential, error: credentialError } = await admin.from("agent_credentials")
        .select("computer_id, last_used_at").eq("computer_id", computer.id).is("revoked_at", null).maybeSingle();
      if (credentialError) throw credentialError;
      if (!credential) return await rejection("The computer does not have an active agent credential.");
      const agentLastUsed = credential.last_used_at ? Date.parse(credential.last_used_at) : NaN;
      if (computer.enrollment_status !== "active" || !Number.isFinite(agentLastUsed) || Date.now() - agentLastUsed > 120_000) {
        return await rejection("The agent has not checked in recently.");
      }
      if (!process || !process.process_started_at || process.process_name.toLowerCase() !== processName.toLowerCase() || Date.parse(process.process_started_at) !== Date.parse(processStartedAt)) {
        return await rejection("The process is no longer in the current inventory or its PID has changed. Refresh the process list.");
      }
      if (!process.updated_at || Date.now() - Date.parse(process.updated_at) > 120_000) {
        return await rejection("The process inventory is stale. Refresh the process list before ending this task.");
      }

      const { data: command, error: insertError } = await admin.from("commands").insert({
        computer_id: computer.id,
        command_type: "STOP_PROCESS",
        parameters: { computer_id: computer.id, process_id: process.process_id, process_name: process.process_name, process_started_at: process.process_started_at, force },
        idempotency_key: body.request_id,
        created_by: user.id,
        expires_at: new Date(Date.now() + 3 * 60_000).toISOString(),
      }).select("id, status, expires_at").single();
      if (insertError?.code === "23505") {
        const { data: duplicate, error: duplicateError } = await admin.from("commands")
          .select("id, command_type, parameters, status, result, error_message, expires_at")
          .eq("created_by", user.id).eq("idempotency_key", body.request_id).maybeSingle();
        if (duplicateError) throw duplicateError;
        if (duplicate?.command_type === "STOP_PROCESS" && sameProcessRequest(duplicate.parameters, computer.id, processId, processName, processStartedAt, force)) {
          return reply({ command_id: duplicate.id, status: duplicate.status, result: duplicate.result, error_message: duplicate.error_message, expires_at: duplicate.expires_at });
        }
        return reply({ error: "This request ID was already used for another action." }, 409);
      }
      if (insertError) throw insertError;
      return reply({ command_id: command.id, status: command.status, expires_at: command.expires_at }, 202);
    }

    if (body.action === "create_pairing_code") {
      if (typeof body.computer_id !== "string") return reply({ error: "Select a registered computer." }, 400);
      const { data: computer, error: computerError } = await admin.from("computers").select("id, device_id, computer_name").eq("id", body.computer_id).maybeSingle();
      if (computerError) throw computerError;
      if (!computer) return reply({ error: "Computer not found." }, 404);
      const code = randomToken(16);
      const { error } = await admin.from("device_enrollment_tokens").insert({
        computer_id: computer.id,
        token_hash: await sha256(code),
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        created_by: user.id,
      });
      if (error) throw error;
      await admin.from("computers").update({ enrollment_status: "pending" }).eq("id", computer.id);
      await admin.from("activity_logs").insert({ user_id: user.id, computer_id: computer.id, action: "PAIR_DEVICE", description: `Created an expiring device pairing code for ${computer.computer_name}.`, result: "success" });
      return reply({ pairing_code: code, device_id: computer.device_id, computer_name: computer.computer_name, expires_in_minutes: 30 });
    }

    if (body.action === "invite_user") {
      if (typeof body.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return reply({ error: "Enter a valid email address." }, 400);
      if (typeof body.full_name !== "string" || body.full_name.trim().length > 120) return reply({ error: "Enter a name up to 120 characters." }, 400);
      if (typeof body.role !== "string" || !allowedRoles.has(body.role)) return reply({ error: "Choose a valid role." }, 400);
      const { data, error } = await admin.auth.admin.inviteUserByEmail(body.email.trim(), {
        data: { full_name: body.full_name.trim() },
      });
      if (error) return reply({ error: error.message }, 400);
      const { error: profileError } = await admin.from("profiles").update({ full_name: body.full_name.trim(), role: body.role }).eq("id", data.user.id);
      if (profileError) throw profileError;
      await admin.from("activity_logs").insert({ user_id: user.id, action: "CREATE_USER", description: `Invited ${body.email.trim()} as ${body.role}.`, result: "success" });
      return reply({ user_id: data.user.id });
    }

    if (body.action === "update_user") {
      if (typeof body.user_id !== "string" || body.user_id === user.id) return reply({ error: "You cannot change your own account here." }, 400);
      const update: Record<string, unknown> = {};
      if (typeof body.role === "string" && allowedRoles.has(body.role)) update.role = body.role;
      if (body.status === "active" || body.status === "disabled") update.status = body.status;
      if (typeof body.full_name === "string" && body.full_name.trim().length <= 120) update.full_name = body.full_name.trim();
      if (Object.keys(update).length === 0) return reply({ error: "No valid account changes were provided." }, 400);
      const { error } = await admin.from("profiles").update(update).eq("id", body.user_id);
      if (error) throw error;
      await admin.from("activity_logs").insert({ user_id: user.id, action: "UPDATE_USER", description: `Updated account ${body.user_id}.`, result: "success" });
      return reply({ ok: true });
    }

    if (body.action === "revoke_device") {
      if (typeof body.computer_id !== "string") return reply({ error: "Select a computer." }, 400);
      const { error: credentialError } = await admin.from("agent_credentials").update({ revoked_at: new Date().toISOString() }).eq("computer_id", body.computer_id);
      if (credentialError) throw credentialError;
      const { error: computerError } = await admin.from("computers").update({ enrollment_status: "revoked", status: "offline" }).eq("id", body.computer_id);
      if (computerError) throw computerError;
      await admin.from("activity_logs").insert({ user_id: user.id, computer_id: body.computer_id, action: "REVOKE_DEVICE", description: "Revoked the PC agent credential.", result: "success" });
      return reply({ ok: true });
    }

    return reply({ error: "Unknown action." }, 400);
  } catch (error) {
    console.error("admin-api", error);
    return reply({ error: "The requested administrator action could not be completed." }, 500);
  }
});
