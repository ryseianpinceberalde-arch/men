# Security guide

- Use the system only for computers the organization owns or has explicit permission to manage.
- Dashboard authentication is Supabase Auth. The application does not store passwords. Set strong Supabase password policy and MFA according to organizational requirements.
- The browser uses a public Supabase publishable key and PostgreSQL RLS. Never put `SUPABASE_SERVICE_ROLE_KEY`, database passwords, agent credentials, or the alert scheduler secret in browser code or source control.
- Edge Functions validate active user JWTs and roles. The agent enrollment code is random, hashed in the database, valid for 30 minutes, and consumed once. Each paired device has an independent random credential, stored only as a hash in Supabase and DPAPI-encrypted on Windows.
- RLS scopes technicians to assigned computers. Viewers can see computer information, hardware, monitoring, and maintenance records only. Admin-only user management uses Edge Functions.
- Remote requests use an explicit database command allowlist, exact structured parameters, a short expiration, a per-user queue limit, and a second allowlist/denylist check inside the Windows agent. No arbitrary shell or file execution endpoint exists.
- Stop-process checks deny protected Windows names and core process IDs. Service changes require an exact local allowlist and still honor a protected-service denylist. Restart/shutdown requires a dashboard confirmation and uses a graceful Windows request without forcing applications closed.
- Operational activity is inserted by database triggers after successful changes or by trusted functions. Authenticated users cannot directly modify activity logs.
- Keep the endpoint service visible in Windows Services and Programs/installed software. Protect service files with administrator-only write access, patch Windows and .NET, and revoke credentials before retiring devices.
- Use HTTPS outside local development. Add production dashboard origins to the Supabase Auth redirect allowlist. Store optional `CRON_SECRET` in the Supabase secret store and send it only from an approved scheduler.
- This first version does not implement remote desktop, screenshots, keylogging, credential collection, arbitrary software installation, or security bypasses. Remote assistance settings contain organization-authored instructions only.

For incidents, revoke the device in the dashboard, disable the user's Supabase profile, and rotate any exposed scheduler secret. Investigate Windows and Supabase logs before re-enrollment.
