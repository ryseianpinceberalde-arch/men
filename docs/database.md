# Database and access model

One Supabase project represents one organization. A future multi-organization deployment needs explicit organization IDs on records and organization-scoped policies before sharing a project across tenants.

## Tables

| Area | Tables |
|---|---|
| Identity and assignment | `profiles`, `computer_assignments` |
| Fleet and monitoring | `computers`, `computer_specs`, `computer_status` |
| Inventory | `installed_software`, `processes`, `services` |
| Approved operations | `commands`, `device_enrollment_tokens`, `agent_credentials` |
| Service desk | `maintenance_records`, `maintenance_schedules`, `problems` |
| Oversight | `alerts`, `alert_settings`, `activity_logs` |

Foreign keys cascade computer-owned inventory and records when a computer is removed. User references point at `auth.users` through `profiles`. Device credentials and one-time enrollment codes are hashed in server-only tables. Command types, statuses, process parameters, service parameters, sizes, expiry, and request rate are constrained in the database.

`computer_specs.storage_devices` and `computer_specs.network_adapters` store bounded JSON arrays reported by the agent. They include disk/volume capacity and network adapter identifiers and addresses; access follows the same role and computer-assignment policy as the rest of the hardware specification.

## Roles and RLS

- **Administrator:** organization-wide read/write access to the fleet and service records; user administration is performed through the trusted `admin-api` function.
- **Technician:** computer and service-record access only for assigned computers. Assignments are stored in `computer_assignments`.
- **Viewer:** read-only computer identity, hardware, monitoring, and maintenance records. RLS also blocks software, process, service, schedule, problem, alert, command, and audit-log reads.
- Device inventory and command results are written by Edge Functions with the service role after per-device authentication. The service-role key is never sent to the browser or PC.
- Audit log writes for records, commands, user access, and alerts are derived from successful database operations or trusted functions. Authenticated users have no direct activity-log insert/update/delete policies.

The helper functions `current_user_role`, `can_access_computer`, and `can_manage_computer` run with a fixed search path. Check their policies along with every new table or function before adding data paths.

## Realtime and monitoring retention

`computers`, `computer_status`, `alerts`, `commands`, `maintenance_records`, and `maintenance_schedules` are added to the Realtime publication. Reads remain subject to RLS. Agents report every 45 seconds; the API stores a `computer_status` history sample no more often than every five minutes. The dashboard summary uses a compact RLS-aware SQL function rather than loading full histories.

## First administrator

The Auth user-creation trigger inserts a profile with the safe `viewer` role. Create the first user through Supabase Auth, then promote it once in the Supabase SQL Editor:

```sql
update public.profiles
set role = 'administrator', full_name = 'Organization Administrator'
where id = (select id from auth.users where lower(email) = lower('admin@example.com'));
```

Replace the email with the exact account you created. Do not expose a public signup path or store a password in `profiles`.

## Applying schema changes

Back up an existing database first. Apply committed files under `supabase/migrations/` with `supabase db push`, inspect the migration result, and test administrator, assigned technician, unassigned technician, and viewer access in a non-production project. Do not reset project data to apply this initial schema.
