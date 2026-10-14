import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

const source = await readFile(new URL("../dashboard/services/api.js", import.meta.url), "utf8");
const session = { access_token: "current-user-token", user: { id: "administrator" } };
const refreshedSession = { ...session, access_token: "refreshed-user-token" };
const termination = { action: "terminate_process", request_id: "same-request-id", process_id: 1234, force: true };
const success = { data: { command_id: "command-id" }, error: null };

function httpError(status, message) {
  return {
    data: null,
    error: { message: "Edge Function returned a non-2xx status code", context: new Response(JSON.stringify({ error: message }), { status }) },
  };
}

async function fixture({ initial = { data: { session }, error: null }, refreshed = { data: { session: refreshedSession }, error: null }, responses = [success] } = {}) {
  const calls = [];
  let refreshes = 0;
  const supabase = {
    auth: {
      getSession: async () => initial,
      refreshSession: async () => { refreshes++; return refreshed; },
    },
    functions: { invoke: async (name, options) => {
      calls.push({ name, ...options });
      assert.ok(responses.length, "No unexpected function retries");
      return responses.shift();
    } },
  };
  const context = createContext({});
  const dependency = new SyntheticModule(["supabase"], function () { this.setExport("supabase", supabase); }, { context });
  const api = new SourceTextModule(source, { context });
  await api.link((specifier) => {
    assert.equal(specifier, "./supabase.js");
    return dependency;
  });
  await api.evaluate();
  return { invoke: api.namespace.invoke, calls, get refreshes() { return refreshes; } };
}

test("End Task explicitly sends the signed-in user's access token", async () => {
  const api = await fixture();
  assert.equal(await api.invoke("admin-api", termination), success.data);
  assert.equal(api.calls[0].headers.Authorization, `Bearer ${session.access_token}`);
  assert.equal(api.calls[0].body, termination);
  assert.equal(api.refreshes, 0);
});

test("a rejected token is refreshed once and End Task keeps its original request ID", async () => {
  const api = await fixture({ responses: [httpError(401, "Sign in is required."), success] });
  assert.equal(await api.invoke("admin-api", termination), success.data);
  assert.equal(api.refreshes, 1);
  assert.equal(api.calls.length, 2);
  for (const call of api.calls) {
    assert.equal(call.name, "admin-api");
    assert.equal(call.body, termination);
  }
  assert.equal(api.calls[1].headers.Authorization, `Bearer ${refreshedSession.access_token}`);
});

test("signed-out requests never reach the function", async () => {
  const api = await fixture({ initial: { data: { session: null }, error: null } });
  await assert.rejects(api.invoke("admin-api", termination), /sign in again/i);
  assert.equal(api.calls.length, 0);
  assert.equal(api.refreshes, 0);
});

test("session read errors are preserved without sending a command", async () => {
  const error = new Error("Session storage unavailable");
  const api = await fixture({ initial: { data: { session: null }, error } });
  await assert.rejects(api.invoke("admin-api", termination), error);
  assert.equal(api.calls.length, 0);
});

test("failed refresh does not retry the command", async () => {
  const error = new Error("Refresh service unavailable");
  const api = await fixture({ responses: [httpError(401, "Sign in is required.")], refreshed: { data: { session: null }, error } });
  await assert.rejects(api.invoke("admin-api", termination), error);
  assert.equal(api.calls.length, 1);
  assert.equal(api.refreshes, 1);
});

test("missing refreshed session requires sign-in without retrying", async () => {
  const api = await fixture({ responses: [httpError(401, "Sign in is required.")], refreshed: { data: { session: null }, error: null } });
  await assert.rejects(api.invoke("admin-api", termination), /sign in again/i);
  assert.equal(api.calls.length, 1);
});

test("a user change during refresh cannot resubmit the previous user's action", async () => {
  const api = await fixture({ responses: [httpError(401, "Sign in is required.")], refreshed: { data: { session: { ...refreshedSession, user: { id: "different-user" } } }, error: null } });
  await assert.rejects(api.invoke("admin-api", termination), /sign in again/i);
  assert.equal(api.calls.length, 1);
});

test("a second 401 stops and preserves the server error", async () => {
  const api = await fixture({ responses: [httpError(401, "Sign in is required."), httpError(401, "Sign in is required.")] });
  await assert.rejects(api.invoke("admin-api", termination), /Sign in is required\./);
  assert.equal(api.calls.length, 2);
  assert.equal(api.refreshes, 1);
});

for (const [status, message] of [[403, "Administrator access is required."], [409, "The process inventory is stale."], [500, "The request could not be completed."]]) {
  test(`HTTP ${status} is preserved and never retried`, async () => {
    const api = await fixture({ responses: [httpError(status, message)] });
    await assert.rejects(api.invoke("admin-api", termination), { message });
    assert.equal(api.calls.length, 1);
    assert.equal(api.refreshes, 0);
  });
}

test("transport failures are not retried because the command may have been accepted", async () => {
  const api = await fixture({ responses: [{ data: null, error: { message: "Failed to send a request to the Edge Function" } }] });
  await assert.rejects(api.invoke("admin-api", termination), /Failed to send/);
  assert.equal(api.calls.length, 1);
  assert.equal(api.refreshes, 0);
});

test("non-JSON failures retain the Functions client error", async () => {
  const api = await fixture({ responses: [{ data: null, error: { message: "Gateway unavailable", context: new Response("Bad gateway", { status: 502 }) } }] });
  await assert.rejects(api.invoke("admin-api", termination), /Gateway unavailable/);
});

test("application errors in successful HTTP responses are preserved", async () => {
  const api = await fixture({ responses: [{ data: { error: "Invalid request." }, error: null }] });
  await assert.rejects(api.invoke("admin-api", termination), /Invalid request\./);
  assert.equal(api.refreshes, 0);
});
