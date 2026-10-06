import { activeProfile, isRecord, preflight, randomToken, reply, serviceClient, sha256, signedInUser } from "../_shared/http.ts";

const allowedRoles = new Set(["administrator", "technician", "viewer"]);

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
