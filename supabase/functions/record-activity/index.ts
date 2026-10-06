import { activeProfile, isRecord, preflight, reply, serviceClient, signedInUser } from "../_shared/http.ts";

Deno.serve(async (request) => {
  const options = preflight(request);
  if (options) return options;
  if (request.method !== "POST") return reply({ error: "Method not allowed." }, 405);
  try {
    const user = await signedInUser(request);
    if (!user) return reply({ error: "Sign in is required." }, 401);
    const profile = await activeProfile(user.id);
    if (!profile) return reply({ error: "This account is disabled." }, 403);
    const body: unknown = await request.json();
    if (!isRecord(body) || typeof body.action !== "string") return reply({ error: "Invalid activity record." }, 400);
    const supported = new Set(["LOGIN", "LOGOUT", "VIEW_PC"]);
    if (!supported.has(body.action)) return reply({ error: "This activity is recorded from its verified database operation." }, 400);
    const computerId = typeof body.computer_id === "string" ? body.computer_id : null;
    if (body.action === "VIEW_PC" && !computerId) return reply({ error: "A computer is required for this activity." }, 400);
    if (body.action !== "VIEW_PC" && computerId) return reply({ error: "This activity cannot include a computer." }, 400);
    const admin = serviceClient();
    if (computerId) {
      const { data: computer, error } = await admin.from("computers").select("id").eq("id", computerId).maybeSingle();
      if (error) throw error;
      if (!computer) return reply({ error: "Computer not found." }, 404);
      if (profile.role === "technician") {
        const { data: assignment, error: assignmentError } = await admin.from("computer_assignments").select("computer_id").eq("computer_id", computerId).eq("technician_id", user.id).maybeSingle();
        if (assignmentError) throw assignmentError;
        if (!assignment) return reply({ error: "You cannot access this computer." }, 403);
      }
    }
    const description = body.action === "LOGIN" ? "Signed in to the management dashboard." : body.action === "LOGOUT" ? "Signed out of the management dashboard." : "Viewed an authorized computer record.";
    const { error } = await admin.from("activity_logs").insert({ user_id: user.id, computer_id: computerId, action: body.action, description, result: "success" });
    if (error) throw error;
    return reply({ ok: true });
  } catch (error) {
    console.error("record-activity", error);
    return reply({ error: "Activity could not be recorded." }, 500);
  }
});
