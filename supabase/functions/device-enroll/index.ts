import { isRecord, preflight, randomToken, reply, serviceClient, sha256 } from "../_shared/http.ts";

Deno.serve(async (request) => {
  const options = preflight(request);
  if (options) return options;
  if (request.method !== "POST") return reply({ error: "Method not allowed." }, 405);
  try {
    const body: unknown = await request.json();
    if (!isRecord(body) || typeof body.pairing_code !== "string" || typeof body.device_id !== "string") return reply({ error: "A pairing code and device ID are required." }, 400);
    if (body.pairing_code.length !== 32 || body.device_id.length > 120) return reply({ error: "Invalid enrollment details." }, 400);
    const admin = serviceClient();
    const { data: enrollment, error } = await admin.from("device_enrollment_tokens")
      .select("id, computer_id, expires_at, used_at, computers!inner(device_id)")
      .eq("token_hash", await sha256(body.pairing_code)).maybeSingle();
    if (error) throw error;
    if (!enrollment || enrollment.used_at || new Date(enrollment.expires_at).getTime() <= Date.now()) return reply({ error: "Pairing code is invalid, expired, or already used." }, 401);
    const computerRelation = enrollment.computers as unknown as { device_id: string };
    if (computerRelation.device_id !== body.device_id) return reply({ error: "Pairing code is for a different device." }, 401);
    const consumedAt = new Date().toISOString();
    const { data: consumed, error: consumeError } = await admin.from("device_enrollment_tokens").update({ used_at: consumedAt })
      .eq("id", enrollment.id).is("used_at", null).gt("expires_at", consumedAt).select("id").maybeSingle();
    if (consumeError) throw consumeError;
    if (!consumed) return reply({ error: "Pairing code has already been used." }, 409);
    const credential = randomToken();
    const { error: credentialError } = await admin.from("agent_credentials").upsert({ computer_id: enrollment.computer_id, token_hash: await sha256(credential), revoked_at: null }, { onConflict: "computer_id" });
    if (credentialError) throw credentialError;
    await admin.from("computers").update({ enrollment_status: "active" }).eq("id", enrollment.computer_id);
    return reply({ device_credential: credential, computer_id: enrollment.computer_id });
  } catch (error) {
    console.error("device-enroll", error);
    return reply({ error: "Device enrollment could not be completed." }, 500);
  }
});
