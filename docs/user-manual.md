# User manual

## Sign in and roles

Open the organization dashboard and sign in with the invited Supabase account. Use **Forgot your password?** if needed. The account menu lets you update your name or password through Supabase Auth.

- **Administrator:** all assets and records, pairing/revocation, command confirmations, settings, and user invitations.
- **Technician:** assigned computers, monitoring, maintenance and problem records, and allowed maintenance operations.
- **Viewer:** computer, hardware, monitoring, and maintenance-record read access.

## Fleet and computer details

Use **Computers** to search, filter by state, sort, and page through registered devices. Choose a computer to view overview, hardware, monitoring, software, processes, services, maintenance, troubleshooting, activity, and commands. The available tabs follow the signed-in role. Realtime updates show current database changes; the agent heartbeat interval is approximately 45 seconds.

## Maintenance and problems

Administrators and technicians can add maintenance records, schedule work, and report a problem. Each record belongs to a computer and may include technician, findings, action, status, solution, and follow-up date. The dashboard highlights overdue schedules; offline and overdue alerts are evaluated once per minute when an administrator dashboard is open or by the configured scheduler.

## Approved commands

Only an administrator or technician with access to the computer can request an action. Inventory refreshes queue a short-lived read operation. Process stop, service change, restart, and shutdown require confirmation in the dashboard. The local agent can reject commands that are expired, outside its allowlist, or blocked by its denylist. Review the command status and result in the computer's **Commands** tab.

## Alerts, reports, and activity

Administrators and technicians can search/filter visible alerts and records. Acknowledge active alerts after review. Reports export up to 5,000 matching rows as CSV, subject to the same role policies as the dashboard. Activity history is read-only and records verified database operations.

## Remote assistance

The remote assistance panel can store whether support is enabled and organization-written connection instructions, such as how to arrange a Quick Assist session. It does not open a session or bypass Windows authentication.
