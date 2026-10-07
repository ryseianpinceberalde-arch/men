# Windows agent setup

The agent is a visible Windows service named **PC Maintenance Agent**. It sends inventory and health status to the configured organization's Supabase project. It supports only the command allowlist in `Commands/CommandService.cs`; there is no shell, PowerShell, arbitrary execution, hidden remote access, or custom remote desktop.

## Build

On a Windows build machine with the .NET 10 SDK and .NET Framework C# compiler (`csc.exe`), create the downloadable agent package and native setup program:

```powershell
.\scripts\package-agent.ps1
```

The script creates a native Windows setup executable, self-contained Windows x64 package parts, and a SHA-256 manifest under `dashboard/downloads/`. Commit and push these files so Cloudflare Pages can serve them. The setup executable downloads and verifies the package, enrolls the PC, and installs the Windows service without running a PowerShell script or changing the computer's execution policy. Package files are split into 15 MiB parts to stay below Cloudflare Pages' per-file asset limit. Re-run the packaging script and push its output after changing the agent.

## Register and pair a computer

1. In the dashboard, add a computer. This creates a database asset record and an expiring pairing code.
2. On that organization-owned Windows PC, open PowerShell with **Run as administrator**. In the dashboard pairing window, click **Copy complete setup command**, paste it into PowerShell, and press Enter. The command downloads the native setup program, which verifies the latest agent package, pairs the PC, updates an existing installation, and starts the Windows service. It works from any PowerShell folder and does not change PowerShell's execution policy.
3. The enrollment function validates the code and device ID, consumes the code once, and returns a per-device credential. The agent encrypts the credential with Windows DPAPI and writes it under `%ProgramData%\PCMaintenance.Agent\device.json`. Directory ACLs allow only Local System and local Administrators.
4. Confirm PowerShell reports the `PCMaintenanceAgent` service is running. The computer should appear online after its first heartbeat.

Pairing codes expire after 30 minutes and are single-use. If enrollment fails, generate a new one. Do not paste a code into a ticket, email, or log. The setup command briefly includes the code as a process argument, so run it only on the target computer and close the shell afterward.

## Allow approved service actions

Service start/stop/restart is blocked unless the exact Windows service name is in the agent's local `Agent:ApprovedServiceNames` array in `appsettings.json`. Review organization change control and the service's impact before adding it. Critical names in the agent denylist are always rejected. The installed service must be restarted for configuration edits to take effect.

Process stop requests are rejected for core Windows process names and PIDs. The agent rechecks the PID/name pairing before acting. Computer restart and shutdown use a 3-second Windows countdown with `forceApplicationsClosed=false`; applications are not force-closed and may prevent the operation.

## Operations and removal

- The service sends a heartbeat every 45 seconds, checks for commands every 15 seconds, and refreshes hardware every 30 minutes. Status history is limited to one stored sample per five minutes.
- Hardware inventory includes bounded storage-device/volume details and non-loopback network adapter details when Windows permits the read. Adapter MAC and IP addresses are visible to users who can access that computer under RLS.
- Service logs use the Windows Application event log with source **PC Maintenance Agent**.
- To stop/remove it as an administrator: `Stop-Service PCMaintenanceAgent`, then `sc.exe delete PCMaintenanceAgent`. Remove the installed program directory and `%ProgramData%\PCMaintenance.Agent` only after the organization authorizes device retirement. Use the dashboard's **Revoke agent** action first.
- To update or re-pair an existing agent, generate a fresh pairing code and run the copied setup command as administrator. It replaces the installed agent, rotates its device credential, and restarts the service. Before retiring a PC, use the dashboard's **Revoke agent** action.

The agent is separate from the dashboard and can be stopped and removed by an authorized local administrator.
