# PC Maintenance and Remote Management System

A role-based operations dashboard backed by Supabase, with a separately installed .NET 10 LTS Windows service for inventory, health reporting, and a small allowlisted set of administrator-approved actions. Install the agent only on computers your organization owns or is authorized to manage.

## Project layout

```text
dashboard/                    Static HTML, Bootstrap, and JavaScript dashboard
agent/PCMaintenance.Agent/    .NET 10 Windows service and collectors
supabase/migrations/           PostgreSQL schema, RLS, audit triggers
supabase/functions/            Authenticated admin, enrollment, and agent APIs
docs/                          Installation, security, and user guides
.env.example                   Local Edge Function environment names only
```

## Configure Supabase

1. Create a Supabase project for the organization. Disable public sign-up in Authentication settings; invite accounts instead.
2. Install the Supabase CLI and link this folder to the project: `supabase link --project-ref YOUR_PROJECT_REF`.
3. Apply the schema with `supabase db push`.
4. Deploy `admin-api`, `record-activity`, `device-enroll`, `agent-api`, and `evaluate-alerts` using `supabase functions deploy FUNCTION_NAME`. The trusted functions need the platform-provided `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`. Never copy the service-role key into the dashboard or agent.
5. Create the first organization user in Supabase Authentication and promote that account once in the SQL Editor:

   ```sql
   update public.profiles
   set role = 'administrator', full_name = 'Organization Administrator'
   where id = (select id from auth.users where lower(email) = lower('admin@example.com'));
   ```

   The trigger creates each new profile as a viewer. After bootstrap, invite users from **Users** in the dashboard.
6. Copy `dashboard/config.example.js` to `dashboard/config.js` and set the project URL and **publishable** key. That file is ignored by Git.
7. Serve the `dashboard/` directory over HTTP for local use, or deploy its static files to an HTTPS web host. Add the resulting URL to Supabase Authentication's allowed redirect URLs.

See [docs/installation.md](docs/installation.md) for local development and deployment details, [docs/database.md](docs/database.md) for schema/RLS, and [docs/agent-setup.md](docs/agent-setup.md) for Windows installation.

## Development

Serve the dashboard from the repository root with Python's built-in static server:

```powershell
python -m http.server 8000 --directory dashboard
```

Open `http://localhost:8000` after configuring `dashboard/config.js`. Browser authentication uses Supabase Auth. All operational data requests are subject to PostgreSQL RLS.

Type-check the Edge Functions with Deno 2 using:

```powershell
deno check .\supabase\functions\admin-api\index.ts .\supabase\functions\record-activity\index.ts .\supabase\functions\device-enroll\index.ts .\supabase\functions\agent-api\index.ts .\supabase\functions\evaluate-alerts\index.ts
```

Publish the agent on a Windows build machine with the .NET 10 SDK:

```powershell
dotnet publish .\agent\PCMaintenance.Agent\PCMaintenance.Agent.csproj -c Release -r win-x64 --self-contained false -o .\agent\PCMaintenance.Agent\publish\win-x64
```

The agent uses the Supabase Edge Functions deployed above. It does not accept shell commands, execute scripts, install software, take screenshots, or provide remote desktop.

## Current implementation notes

- Computer monitoring is sent on a 45-second heartbeat and historical status is retained at most once per computer every five minutes.
- Software, process, and service inventories are requested from the agent; service actions are blocked unless a service name is explicitly allowlisted in the local agent configuration.
- Offline and overdue-schedule evaluation runs while an administrator dashboard is open. For continuous evaluation, schedule `evaluate-alerts` from your approved scheduler and set a private `CRON_SECRET` with `supabase secrets set CRON_SECRET=...`.
- No production credentials, demo fleet, service-role key, or custom password store are included.

## Verification

Use the checks documented in [docs/installation.md](docs/installation.md) after configuring a Supabase project. The dashboard depends on configured Supabase credentials and deployed Edge Functions; the Windows service requires a Windows host and .NET 10 SDK/runtime.
