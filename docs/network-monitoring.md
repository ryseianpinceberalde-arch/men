# Network monitoring implementation and operations

The existing dashboard now includes **Network Overview**, **Wi-Fi Monitoring**, and **Internet Monitoring**. The existing .NET Windows agent collects the data; the dashboard never measures its own browser connection on behalf of another computer. Older agents keep their existing behavior and show no network telemetry until upgraded.

## Deployment

1. Apply migrations in order, including the existing October 13 changes and `supabase/migrations/202610140001_network_monitoring.sql`, using the project's existing `supabase db push` workflow. No existing data is reset.
2. Deploy the updated `agent-api`, `admin-api`, and `evaluate-alerts` Edge Functions. Existing enrollment and user authentication remain unchanged.
3. Deploy the static `dashboard/` files, including `components/network.js` and `services/network-metrics.js`.
4. Build with `scripts/package-agent.ps1`, publish the resulting download manifest/package parts, and upgrade enrolled computers through the existing installation workflow. Installed services do **not** automatically replace their binaries. Existing device enrollment remains required.
5. Schedule the existing authenticated `evaluate-alerts` endpoint with `CRON_SECRET` if alerts and network retention must run without an administrator dashboard open. Pruning runs at most hourly. No hosted scheduler is installed by this change.

The migration and Edge Functions must be deployed before upgraded agents. Network upload failures retain bounded telemetry locally and do not stop normal inventory, heartbeat, or approved commands.

## Collection and measurement semantics

| Measurement | Implementation and limits |
|---|---|
| Wi-Fi | Native `WlanQueryInterface`: current connection, radio state, channel, and newer connection-quality API where supported. No active scanning, profile/key access, connection changes, or DNS changes. SSID/BSSID may be unavailable under Windows privacy policy. |
| Band/radio | Band is reported only when Windows returns a recognized center frequency. Channels alone are not used to infer band; Wi-Fi 6E requires an observed 6 GHz band. Unsupported fields remain null. |
| Adapters | .NET `NetworkInterface` counters, IPv4/IPv6, gateways, DNS, DHCP, and link capacity. Up to 32 non-loopback/non-tunnel adapters per sample. The OS routing decision to 1.1.1.1 identifies the primary IPv4 interface; VPN/other/unknown are retained instead of guessing Wi-Fi or Ethernet. IPv6-only primary-route attribution is unavailable. |
| Traffic | Counter deltas divided by monotonic elapsed time. Initial/reset counters have unknown rates. The current totals are OS counters, not billing totals. Historical charts show sampled primary-interface rates, including local traffic, and are not ISP speed tests. Utilization uses the busiest direction divided by reported link capacity. |
| Connectivity | Two independent HTTPS checks: Cloudflare zero-byte download and Google HTTP 204 endpoint. DNS resolution uses the configured OS resolver for `www.microsoft.com`. Four alternating ICMP echoes target 1.1.1.1 and 8.8.8.8. Gateway ICMP is checked separately. These endpoints must be permitted by the organization's network policy. |
| Latency/loss | Mean successful ICMP round trips; jitter is mean absolute difference of consecutive successful replies. Loss is missing replies out of four echoes. When all ICMP replies are absent, latency, jitter, and loss remain unknown because filtering cannot be distinguished from packet loss. Gateway probe failures explicitly mention possible ICMP filtering. |
| Internet status | Local adapters down: Offline/local disconnected. No adapters: Unknown. Both HTTPS checks succeed with DNS and healthy measured latency/loss: Online. Partial HTTPS/ICMP success or high latency/loss: Degraded. Multiple HTTPS failures plus no ICMP success: Offline with DNS/gateway/probe diagnosis. One failed website never proves total internet loss. |
| Availability | Successful recorded connectivity checks divided by known recorded checks, weighted by check counts rather than averages of bucket percentages. A degraded check with HTTPS or ICMP success counts as available. Missing/unknown observations are excluded, not assumed online or offline. |
| Outages | First offline probe through the next observed recovery. Boundaries have sampling precision. Known gaps are marked; an unclosed outage has no invented end or definitive continuing duration. Agent silence is shown separately. |
| Speed test | Administrator command or optional global schedule. Fixed HTTPS endpoint at Cloudflare; at most 10 MB down and 2 MB up plus overhead. Reported Mbps includes HTTP request/response elapsed time. These bounded single-stream measurements do not claim maximum ISP capacity. Failed/incomplete transfers remain failed with partial results labeled. A 15-minute cooldown and single-test lock prevent overlapping tests. |

Default Wi-Fi collection is 10 seconds, connectivity probing 30 seconds, and traffic-counter sampling 5 seconds. Probes run independently so slow connectivity checks do not stop counter collection. Agent uploads are batched every 15 seconds; charts aggregate on the server. Network settings in any network page configure intervals, signal categories, low-signal/latency/loss thresholds, sustained duration, repeated disconnections, cooldowns, retention, and optional speed-test interval. **0 hours means manual-only speed tests.** Agents receive settings on their next successful upload. Local `appsettings.json` supplies initial defaults.

The protected local backlog is capped at 2,880 observations and roughly 4 MB of JSON before encryption, plus 32 speed results. At 10-second observations, the nominal bound is up to eight hours, often less with many adapters or additional probe samples. It is DPAPI-encrypted inside the existing restricted agent configuration directory, replaced atomically, and replayed oldest-first in batches of 60 with stable sample IDs. Records older than six days are discarded locally so an expired batch cannot block new telemetry. Gaps beyond these bounds cannot be reconstructed. The sender retries without blocking sampling. A service restart resets the next scheduled speed-test countdown.

When a computer cannot reach Supabase, live remote measurements are unavailable: the dashboard ages its agent state to offline/unknown, and recorded connectivity failures and recoveries arrive after reconnection. Manual speed commands run independently of heartbeats. A disabled wireless adapter is identified through the Windows IP Helper administrative state or an explicitly disabled WLAN radio; a disconnected cable or link is not guessed to mean disabled.

## Database and access controls

- `network_state`: latest adapters, connectivity probe, receipt/observation times, and last successful HTTPS/ICMP connectivity check. Only this new table is added to Realtime.
- `network_identifiers`: separate MAC/BSSID values, readable only by administrators. New shared telemetry and history exclude these identifiers. Existing hardware-inventory access rules are preserved.
- `network_samples`: idempotent timestamped signal, traffic, latency, jitter, packet-loss and connectivity history; indexed by device/time and retention time.
- `network_events`, `network_outages`, `network_speed_tests`: state transitions, recoveries, outage boundaries, and bounded transfer results.
- `network_settings`: validated, administrator-editable settings with audit records.
- `network_conditions`, `network_maintenance`: server-only alert persistence and retention bookkeeping.
- `ingest_network_batch`: service-role-only transaction, serialized per computer. The Edge Function derives the computer ID from its verified credential and validates bounded, allowlisted telemetry. Retries cannot duplicate samples; older observations cannot overwrite newer state.
- `network_history`: RLS-aware server aggregation, at most 30 days per request. Charts use real buckets and explicitly break lines across missing periods.
- `queue_network_command`: server-only, administrator-validated command dispatch, freshness checks, idempotency, pending-command exclusion, and speed-test cooldown. Direct browser inserts cannot dispatch new network commands.
- `prune_network_history`: retention for new network samples/events/completed outages/speed tests only, default 30 days, configurable 30–365. Existing inventory and records are not deleted.

Administrators can read the fleet. Technicians can read assigned computers' network telemetry, but not MAC/BSSID or settings/command writes. Viewers cannot read network telemetry. Existing device credentials, server-held service-role keys, HTTPS ingestion, and DPAPI enrollment remain in use. No packet content, browsing history, Wi-Fi passwords, or unrelated network scans are collected.

Alerts use the existing Alerts page and `network_` types. Conditions cover disconnection/disabled Wi-Fi, SSID changes, low and sustained poor signal, gateway/DNS failures, connectivity loss, high latency/loss, sustained degradation, and repeated outages. Persistent per-condition state, cooldowns, and recovery events suppress duplicates. Unknown measurements do not resolve an alert. Missing observation intervals reset sustained-condition timers. Recovery updates existing alerts to Resolved and records an event rather than leaving permanent open recovery alerts.

## Dashboard behavior

Network pages retain filters, selected computer, scroll, DOM rows, and Chart.js instances during refreshes. Only changed cells, panels, and chart data update. Each page has one network-state Realtime subscription, throttled updates, a 30-second fallback timer, and disposal on navigation/logout. **Refresh Data** retrieves stored telemetry; **Request fresh data** queues an agent sample for the selected computer. Neither reloads the browser. Pending speed/refresh command status is displayed separately.

Computer/connection/status/time filters govern the fleet and historical measurements. Current agent-offline status has no historical probe-status equivalent; that filter shows stored history with a notice. Event/outage/speed tables follow computer and time and show the latest 100 records. Wi-Fi signal history is an average of reporting connected wireless adapters, and its trend compares the latest recorded aggregate buckets. Connection duration is omitted because the agent does not have a reliable Windows connection-start timestamp.

## Verification

Run from the repository root:

```powershell
dotnet build agent/PCMaintenance.Agent/PCMaintenance.Agent.csproj -c Release
dotnet run --project tests/agent/NetworkChecks.csproj -c Release
# Optional real host read-only probes (never ingest into Supabase):
dotnet run --project tests/agent/NetworkChecks.csproj -c Release -- --hardware
# Optional real bandwidth test, up to 12 MB:
dotnet run --project tests/agent/NetworkChecks.csproj -c Release -- --hardware --speed
deno check supabase/functions/admin-api/index.ts supabase/functions/agent-api/index.ts supabase/functions/evaluate-alerts/index.ts supabase/functions/device-enroll/index.ts supabase/functions/record-activity/index.ts
deno test supabase/functions/_shared/network_test.ts
node --test tests/network-metrics.test.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-network-database.ps1
node tests/network-browser.mjs
```

The database script creates and stops a disposable local PostgreSQL instance; it does not touch a configured Supabase project. It applies **every existing migration**, then checks deduplication, history, outage/recovery, identifiers, role policies, command authorization/idempotency and retention using explicit test fixtures. The browser test uses an isolated headless Edge profile and fixtures, with real Chart.js. Set `EDGE_PATH` for another Chromium browser and `PCMA_CHART_PATH` for an already-downloaded Chart.js bundle. Test fixture results are never displayed as real fleet data or written into a live project.

Initial verification on this Windows host passed the .NET build, Edge Function checks, validation/calculation tests, disposable PostgreSQL tests, and browser checks (escaping, filters, stable chart/DOM instances, scroll retention, no reload, mobile layout, subscription cleanup). The agent host also started successfully in an unpaired five-second smoke test, reporting the missing enrollment without attempting ingestion. The real collector returned Wi-Fi details, signal, and adapter traffic counters; the final lightweight check succeeded at both HTTPS endpoints (Online). A real bounded speed test timed out during download after 4,666,880 bytes; it reported failure and no fabricated Mbps or upload result. Successful end-to-end speed measurements still require a reachable test endpoint.

Authenticated hosted Supabase ingestion, hosted Realtime delivery, Windows service deployment under its installed account, separate physical Ethernet/no-Wi-Fi machines, disabled-adapter transitions, controlled physical outages, and long-running fleet overhead require deployment/hardware verification. Automated tests cover their data and state logic, not those external environments. No production migration or deployment was performed during local implementation.

The final short collector check took 5.9 seconds including a deliberate five-second counter interval, used 312 ms of process CPU, and reported a 45.3 MiB working set in the test host. These are real short-run observations, not estimates of steady-state service overhead. The downloadable self-contained Windows package and installer were rebuilt; the concatenated package parts were verified against the manifest SHA-256.

## Changed files

| Area | Files added or extended by this implementation |
|---|---|
| Windows collectors | `Collectors/NetworkService.cs`, `WifiService.cs`, `InterfaceStatus.cs`, `SpeedTestService.cs` |
| Agent lifecycle and transport | `Services/NetworkWorker.cs`, `Services/AgentWorker.cs`, `Models/NetworkSnapshot.cs`, `Commands/CommandService.cs`, `Networking/SupabaseAgentClient.cs`, `Configuration/AgentOptions.cs`, `Program.cs`, `appsettings.json` under `agent/PCMaintenance.Agent/` |
| Dashboard | `dashboard/app.js`, `dashboard/styles.css`, `dashboard/components/network.js`, `dashboard/services/network-metrics.js` |
| Trusted APIs | `supabase/functions/_shared/network.ts`, `agent-api/index.ts`, `admin-api/index.ts`, `evaluate-alerts/index.ts` |
| Migration | `supabase/migrations/202610140001_network_monitoring.sql` |
| Tests | `supabase/functions/_shared/network_test.ts`, `tests/network-metrics.test.mjs`, `tests/network-browser.mjs`, `tests/network-database.sql`, `tests/agent/NetworkChecks.csproj`, `tests/agent/Program.cs`, `scripts/test-network-database.ps1` |
| Distribution and documentation | `dashboard/downloads/agent-package.json`, its referenced three package parts, `PCMaintenance.Agent.Setup.exe`, `README.md`, `.gitignore`, and this document |

Existing uncommitted process-termination, dashboard-refresh, documentation, and October 13 migration changes were preserved. They are not claimed as new network work. No new application library/package dependencies were added.

## Sources

- [Microsoft Native Wi-Fi query API](https://learn.microsoft.com/en-us/windows/win32/api/wlanapi/nf-wlanapi-wlanqueryinterface)
- [Microsoft connection-quality API](https://learn.microsoft.com/en-us/windows/win32/api/wlanapi/ns-wlanapi-wlan_realtime_connection_quality)
- [Microsoft interface administrative status](https://learn.microsoft.com/en-us/windows/win32/api/ifmib/ns-ifmib-mib_ifrow)
- [Windows Wi-Fi location-access changes](https://github.com/MicrosoftDocs/win32/blob/docs/desktop-src/NativeWiFi/wi-fi-access-location-changes.md)
- [Cloudflare speed-test endpoint documentation](https://github.com/cloudflare/speedtest/blob/main/README.md)
