# User manual

## Sign in and roles

Open the organization dashboard and sign in with the invited Supabase account. Use **Forgot your password?** if needed. The account menu lets you update your name or password through Supabase Auth.

- **Administrator:** all assets and records, pairing/revocation, command confirmations, settings, and user invitations.
- **Technician:** assigned computers, monitoring, maintenance and problem records, and allowed maintenance operations.
- **Viewer:** computer, hardware, monitoring, and maintenance-record read access.

## Fleet and computer details

Use **Computers** to search, filter by state, sort, and page through registered devices. Choose a computer to view overview, hardware, monitoring, software, applications, processes, services, maintenance, troubleshooting, activity, and commands. The **Applications** tab lists apps with open windows on an active Windows desktop, such as Chrome; pinned taskbar icons without an open window are not included. Expand an app to inspect its window-owning process. The available tabs follow the signed-in role. Realtime updates show current database changes; the agent heartbeat interval is approximately 45 seconds.

## Maintenance and problems

Administrators and technicians can add maintenance records, schedule work, and report a problem. Each record belongs to a computer and may include technician, findings, action, status, solution, and follow-up date. The dashboard highlights overdue schedules; offline and overdue alerts are evaluated once per minute when an administrator dashboard is open or by the configured scheduler.

## Approved commands

An administrator or assigned technician can request supported inventory and service actions for computers they can access. Only administrators can end a process. In a computer's **Applications** or **Processes** tab, review the application, process, PID, CPU, memory, running state, and start time, then choose **End Task** and confirm **End Task Now**. This immediately force-closes the selected process and may lose unsaved work. The agent verifies the exact PID/name/start-time identity and rejects stale, expired, protected, duplicate, or unauthorized requests; the computer must be online. The dashboard reports success only after the agent confirms the process exited. Review command progress and results in the computer's **Commands** tab; termination attempts are also recorded in the activity log.

## Alerts, reports, and activity

Administrators and technicians can search/filter visible alerts and records. Acknowledge active alerts after review. Reports export up to 5,000 matching rows as CSV, subject to the same role policies as the dashboard. Activity history is read-only and records verified database operations.

## Remote assistance

The remote assistance panel can store whether support is enabled and organization-written connection instructions, such as how to arrange a Quick Assist session. It does not open a session or bypass Windows authentication.
