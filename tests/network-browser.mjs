// Isolated browser fixtures only; never connects to an organization's Supabase project.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const artifacts = await mkdtemp(join(tmpdir(), "pcma-network-browser-"));
const edge = process.env.EDGE_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const chart = process.env.PCMA_CHART_PATH ? await readFile(process.env.PCMA_CHART_PATH) : Buffer.from(await (await fetch("https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js")).arrayBuffer());
const mock = `
const now = new Date().toISOString();
const adapter = {id:'adapter',name:'Fixture Wi-Fi',type:'wifi',status:'Up',ipv4:[],ipv6:[],gateways:[],dns_servers:[],wifi:{status:'connected',ssid:'Fixture SSID',signal_percent:80}};
window.fixture = {computers:[{id:'fixture-1',computer_name:'TEST FIXTURE <script>bad()</script>',enrollment_status:'active',last_seen:now},{id:'fixture-2',computer_name:'TEST Ethernet',enrollment_status:'active',last_seen:now}],network_state:[{computer_id:'fixture-1',observed_at:now,received_at:now,connection_type:'wifi',primary_adapter_id:'adapter',adapters:[adapter],probe:{tested_at:now,status:'online',reason:'ok',attempts:2,successes:2,latency_ms:12}},{computer_id:'fixture-2',observed_at:now,received_at:now,connection_type:'ethernet',adapters:[],probe:{tested_at:now,status:'unknown'}}],network_settings:{signal_categories:[20,40,60,80],wifi_seconds:10,probe_seconds:30,bandwidth_seconds:5,signal_warning:40},network_events:[],network_outages:[],network_speed_tests:[],network_identifiers:null,alerts:[],commands:{status:'completed'}};
window.channelCount=0; window.removedChannels=0;
class Query { constructor(table){this.table=table;this.singleResult=false;this.filters=[];} select(){return this;} order(){return this;} range(){return this;} gte(){return this;} or(){return this;} limit(){return this;} like(){return this;} in(){return this;} update(){return this;} eq(k,v){this.filters.push([k,v]);return this;} single(){this.singleResult=true;return this;} maybeSingle(){this.singleResult=true;return this;} then(resolve){let data=structuredClone(window.fixture[this.table]);if(Array.isArray(data)){data=data.filter(r=>this.filters.every(([k,v])=>r[k]===v));if(this.singleResult)data=data[0]??null;}return Promise.resolve({data,error:null}).then(resolve);} }
export const supabase={from:t=>new Query(t),rpc:async()=>({data:[{bucket:new Date(Date.now()-300000).toISOString(),signal:70,receive_bps:10000,send_bps:2000,latency:15,loss:0,checks:5,available:5,failed:0},{bucket:new Date().toISOString(),signal:80,receive_bps:13000,send_bps:3000,latency:12,loss:0,checks:5,available:5,failed:0}],error:null}),channel:()=>{window.channelCount++;return {on(){return this},subscribe(){return this}}},removeChannel:async()=>{window.removedChannels++}};`;
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><script src="/chart.js"></script></head><body><p>ISOLATED TEST FIXTURES — NOT DEVICE MEASUREMENTS</p><main id="page-content" class="page-content"></main><div id="modal-root"></div><div id="toast-root"></div><script type="module">import {renderNetwork,disposeNetwork} from '/components/network.js';window.renderNetwork=()=>renderNetwork(document.querySelector('#page-content'),'network',{role:'administrator'});window.renderWifi=()=>renderNetwork(document.querySelector('#page-content'),'wifi',{role:'administrator'});window.disposeNetwork=disposeNetwork;await window.renderNetwork();window.ready=true;</script></body></html>`;
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname === "/") { res.setHeader("Content-Type", "text/html"); return res.end(html); }
    if (pathname === "/services/supabase.js") { res.setHeader("Content-Type", "text/javascript"); return res.end(mock); }
    if (pathname === "/chart.js") { res.setHeader("Content-Type", "text/javascript"); return res.end(chart); }
    const path = resolve(repo, "dashboard", `.${pathname}`);
    if (!path.startsWith(resolve(repo, "dashboard") + "\\")) { res.statusCode = 403; return res.end(); }
    res.setHeader("Content-Type", path.endsWith(".css") ? "text/css" : "text/javascript"); res.end(await readFile(path));
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const browser = spawn(edge, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${artifacts}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
let ws;
try {
  let port;
  for (let i = 0; i < 100; i++) { try { port = (await readFile(join(artifacts, "DevToolsActivePort"), "utf8")).split("\n")[0]; break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  assert.ok(port, "Isolated Edge started");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  ws = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let sequence = 0; const pending = new Map(); const exceptions = [];
  ws.onmessage = e => { const message = JSON.parse(e.data); if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.text); if (message.id) { const callback = pending.get(message.id); pending.delete(message.id); if (message.error) callback.reject(new Error(message.error.message)); else callback.resolve(message.result); } };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
  for (let i = 0; i < 100 && !(await evaluate("window.ready === true")); i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(await evaluate("window.ready"), true, "Network view loaded");
  assert.equal(await evaluate("document.querySelectorAll('[data-network-rows] tr').length"), 2);
  assert.equal(await evaluate("document.querySelectorAll('[data-network-rows] script').length"), 0, "Device labels escaped");
  await evaluate("window.originalCanvas=document.querySelector('canvas');window.originalChart=Chart.getChart(originalCanvas);window.originalRoot=document.querySelector('.network-view');document.querySelector('[data-network-filter=computer]').value='fixture-1';document.querySelector('[data-network-filter=computer]').dispatchEvent(new Event('change'));window.renderNetwork()");
  assert.equal(await evaluate("document.querySelectorAll('[data-network-rows] tr').length"), 1, "Computer filter applied");
  await evaluate("window.scrollTo(0,500);window.savedScroll=scrollY;fixture.network_state[0].probe.latency_ms=25;window.renderNetwork()");
  assert.equal(await evaluate("originalCanvas===document.querySelector('canvas') && originalChart===Chart.getChart(originalCanvas) && originalRoot===document.querySelector('.network-view')"), true, "Manual refresh preserves DOM and chart instances");
  assert.equal(await evaluate("document.querySelector('[data-network-filter=computer]').value"), "fixture-1", "Selection preserved");
  assert.equal(await evaluate("scrollY===savedScroll"), true, "Scroll preserved");
  assert.ok(await evaluate("document.querySelector('[data-network-rows]').textContent.includes('25.0 ms')"), "Changed measurement updated");
  assert.equal(await evaluate("performance.getEntriesByType('navigation').length"), 1, "No browser reload");
  await writeFile(join(artifacts, "network-desktop.png"), Buffer.from((await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).data, "base64"));
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await new Promise(r => setTimeout(r, 250)); // Chart.js ResizeObserver settles after viewport changes.
  await evaluate("window.scrollTo(0,0)");
  await writeFile(join(artifacts, "network-mobile.png"), Buffer.from((await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).data, "base64"));
  if (!(await evaluate("document.documentElement.scrollWidth <= 390"))) console.log(await evaluate("[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>390 && getComputedStyle(e).position!=='absolute').map(e=>({tag:e.tagName,cls:e.className,right:e.getBoundingClientRect().right})).slice(0,15)"));
  assert.equal(await evaluate("document.documentElement.scrollWidth <= 390"), true, "Mobile page has no horizontal overflow");
  await evaluate("window.disposeNetwork()");
  assert.equal(await evaluate("removedChannels===channelCount && !Chart.getChart(originalCanvas)"), true, "Subscriptions and charts cleaned up");
  await evaluate("fixture.network_state=[];window.renderWifi()");
  assert.equal(await evaluate("document.querySelectorAll('[data-network-rows] tr').length"), 1, "Wi-Fi view keeps the selected computer visible before its first report");
  assert.ok(await evaluate("document.querySelector('[data-network-message]').textContent.includes('no network readings have arrived yet')"), "No-reading state explains the paired agent requirement");
  await evaluate("window.disposeNetwork()");
  assert.equal(await evaluate("removedChannels===channelCount"), true, "Wi-Fi subscription is also cleaned up");
  assert.deepEqual(exceptions, [], "No browser runtime exceptions");
  console.log("Browser checks passed: rendering, escaping, filters, targeted refresh, stable charts, scroll, no reload, mobile layout and cleanup.");
  console.log(`Isolated browser artifacts: ${artifacts}`);
  await send("Browser.close");
} finally { ws?.close(); browser.kill(); server.close(); }
