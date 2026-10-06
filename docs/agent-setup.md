# Windows agent setup

The agent is a visible Windows service named **PC Maintenance Agent**. It sends inventory and health status to the configured organization's Supabase project. It supports only the command allowlist in `Commands/CommandService.cs`; there is no shell, PowerShell, arbitrary execution, hidden remote access, or custom remote desktop.

## Build

On a Windows build machine with the .NET 10 SDK:

```powershell
dotnet publish .\agent\PCMaintenance.Agent\PCMaintenance.Agent.csproj -c Release -r win-x64 --self-contained false -o .\agent\PCMaintenance.Agent\publish\win-x64
```

Copy the publish directory to an administrator-controlled folder on the endpoint, for example `C:\Program Files\PCMaintenance.Agent`. The PC must have the .NET 10 runtime installed. Confirm the service host can reach the organization's Supabase HTTPS endpoint.

For a PC without the .NET 10 runtime, replace `--self-contained false` with `--self-contained true` in the publish command. This includes the runtime in the output. Copy the entire publish directory, not just the `.exe` file.

## Register and pair a computer

1. In the dashboard, add a computer. This creates a database asset record and an expiring pairing code.
2. Open PowerShell with **Run as administrator** on the organization-owned computer. Change to the folder containing the published executable, for example:

   ```powershell
   Set-Location 'C:\Program Files\PCMaintenance.Agent'
   ```

   Copy and run the dashboard's command, which starts with `.\PCMaintenance.Agent.exe`. PowerShell requires this prefix to run an executable from the current folder. Running the command from `C:\Windows\System32` will not find the agent. The command includes the public publishable key, device ID, and single-use code; it does not include an administrator password or service-role key.
3. The enrollment function validates the code and device ID, consumes the code once, and returns a per-device credential. The agent encrypts the credential with Windows DPAPI and writes it under `%ProgramData%\PCMaintenance.Agent\device.json`. Directory ACLs allow only Local System and local Administrators.
4. Install and start the Windows service from an elevated PowerShell window:

   ```powershell
   $agentExe = 'C:\Program Files\PCMaintenance.Agent\PCMaintenance.Agent.exe'
   New-Service -Name PCMaintenanceAgent -DisplayName 'PC Maintenance Agent' -BinaryPathName ('"{0}"' -f $agentExe) -StartupType Automatic
   Start-Service PCMaintenanceAgent
   ```

5. Confirm the computer becomes online and review the heartbeat in the dashboard.

Pairing codes expire after 30 minutes and are single-use. If enrollment fails, generate a new one. Do not paste a code into a ticket, email, or log. The pairing command briefly includes the code as a process argument, so run it only on the target computer and close the shell afterward.

## Allow approved service actions

Service start/stop/restart is blocked unless the exact Windows service name is in the agent's local `Agent:ApprovedServiceNames` array in `appsettings.json`. Review organization change control and the service's impact before adding it. Critical names in the agent denylist are always rejected. The installed service must be restarted for configuration edits to take effect.

Process stop requests are rejected for core Windows process names and PIDs. The agent rechecks the PID/name pairing before acting. Computer restart and shutdown are requested through Windows with a 60-second delay and `forceApplicationsClosed=false`; applications may prevent shutdown.

## Operations and removal

- The service sends a heartbeat every 45 seconds, checks for commands every 15 seconds, and refreshes hardware every 30 minutes. Status history is limited to one stored sample per five minutes.
- Hardware inventory includes bounded storage-device/volume details and non-loopback network adapter details when Windows permits the read. Adapter MAC and IP addresses are visible to users who can access that computer under RLS.
- Service logs use the Windows Application event log with source **PC Maintenance Agent**.
- To stop/remove it as an administrator: `Stop-Service PCMaintenanceAgent`, then `sc.exe delete PCMaintenanceAgent`. Remove the installed program directory and `%ProgramData%\PCMaintenance.Agent` only after the organization authorizes device retirement. Use the dashboard's **Revoke agent** action first.
- To re-pair, revoke the old credential in the dashboard, generate a new pairing code, and run the enrollment command again.

The agent is separate from the dashboard and can be stopped and removed by an authorized local administrator.
