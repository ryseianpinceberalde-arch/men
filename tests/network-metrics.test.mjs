import test from "node:test";
import assert from "node:assert/strict";
import { availability, networkStatus, numberLabel, signalQuality, chartRows } from "../dashboard/services/network-metrics.js";
test("unknown measurements stay unknown; real zeros remain visible", () => {
  assert.equal(numberLabel(null, "ms"), "Unavailable"); assert.equal(numberLabel(0, "%"), "0.0%");
  assert.equal(signalQuality(null), "Unavailable");
  assert.deepEqual([0,19,20,39,40,59,60,79,80,100].map(n => signalQuality(n)), ["Very weak","Very weak","Weak","Weak","Fair","Fair","Good","Good","Excellent","Excellent"]);
  assert.equal(signalQuality(60, [10,30,70,90]), "Fair");
});
test("agent silence and stale probes never imply internet offline", () => {
  const now = Date.now(); const at = new Date(now).toISOString();
  const c = { enrollment_status: "active", last_seen: at, network: { observed_at: at, probe: { tested_at: at, status: "offline" } } };
  assert.equal(networkStatus(c, {}, now), "offline");
  assert.equal(networkStatus(c, {}, now + 181000), "agent_offline");
  assert.equal(networkStatus({ ...c, network: null }, {}, now), "unknown");
  assert.equal(networkStatus({ ...c, network: { ...c.network, probe: { tested_at: new Date(now-100000).toISOString(), status: "online" } } }, {}, now), "unknown");
});
test("availability is weighted by recorded checks, with no invented empty-period availability", () => {
  assert.equal(availability([]).percent, null);
  assert.deepEqual(availability([{ checks: 2, available: 1, failed: 1 }, { checks: 8, available: 8, failed: 0 }]), { checks: 10, available: 9, failed: 1, percent: 90 });
});
test("missing historical buckets break chart lines without adding fake observations", () => {
  const rows = [{ bucket: "2026-10-14T00:00:00Z", signal: 80 }, { bucket: "2026-10-14T00:15:00Z", signal: 70 }];
  const result = chartRows(rows, 24);
  assert.equal(result.length, 3); assert.equal(result[1].signal, null); assert.equal(result[1].checks, 0);
  assert.equal(result[0], rows[0]); assert.equal(result[2], rows[1]);
});
