# Installation and configuration

## Requirements

- A Supabase project with Authentication, PostgreSQL, Realtime, and Edge Functions enabled.
- Supabase CLI for linking the project, applying migrations, and deploying functions.
- A static HTTPS host for production dashboard use. A local static server is sufficient for development.
- .NET 10 SDK on the Windows build machine to package the self-contained agent; no separate .NET runtime is needed on managed PCs.
- Windows administrator access for pairing, service installation, and allowlist configuration.

## Supabase setup

1. Create a project and disable public user sign-up. Configure the organization name, email templates, SMTP, and Authentication site/redirect URLs.
2. In the repository directory, run `supabase login`, `supabase link --project-ref YOUR_PROJECT_REF`, and `supabase db push`.
3. Deploy the five functions:

   ```powershell
   supabase functions deploy admin-api
   supabase functions deploy record-activity
   supabase functions deploy device-enroll
   supabase functions deploy agent-api
   supabase functions deploy evaluate-alerts
   ```

4. Hosted functions receive Supabase project URL, anon key, and service-role key through the platform. Local function development can use `.env.example`; copy it to `supabase/.env` and fill only local values. Do not commit either environment file.
5. Create the initial user from Supabase Authentication, then set that profile's role to `administrator` once in the SQL Editor using the SQL in `README.md`. Subsequent users are invited from the dashboard.

`admin-api`, `record-activity`, `device-enroll`, `agent-api`, and `evaluate-alerts` have platform JWT verification disabled in `supabase/config.toml`. The user-facing functions validate the caller's bearer token and active profile in code. The device functions authenticate a per-device credential. Do not remove these checks or expose service-role credentials.

## Dashboard

1. Copy `dashboard/config.example.js` to `dashboard/config.js`.
2. Set `supabaseUrl` to the project's URL and `supabasePublishableKey` to its public publishable/anon key.
3. For local use, run `python -m http.server 8000 --directory dashboard` and open `http://localhost:8000`.
4. Add that address under Supabase Authentication URL configuration. For production, configure your HTTPS hostname as the site URL and allowed redirect URL.
5. Sign in with an invited account. Password reset and password changes run through Supabase Authentication.

The browser contains no service-role key or database password. The publishable key is public and relies on the migration's RLS policies.

## Offline and overdue alert evaluation

An open administrator dashboard requests `evaluate-alerts` once a minute. To keep offline and schedule evaluation running when the dashboard is closed, configure an approved scheduler to POST to:

```text
https://YOUR_PROJECT_ID.supabase.co/functions/v1/evaluate-alerts
```

Send `x-cron-secret: YOUR_PRIVATE_CRON_SECRET`, store that value as an Edge Function secret with `supabase secrets set CRON_SECRET=...`, and do not expose it in browser code. Schedule the request every one to five minutes. The function also accepts an authenticated active administrator.

## Database and RLS

The migration is `supabase/migrations/202610070001_initial_schema.sql`. It creates the requested inventory, monitoring, commands, maintenance, alert, profile, and audit tables, helper functions, indexes, audit triggers, and policies. Review [database.md](database.md) before applying it to a non-empty project. This project treats one Supabase project as one organization.

## Production deployment

- Serve static dashboard files from an HTTPS host and use the Supabase publishable key only.
- Keep Supabase function secrets in the Supabase secret store.
- Set Authentication redirect URLs to the production origin and a localhost URL only for development.
- Configure database backups/retention and an alert evaluation schedule under the organization's policies.
- Verify RLS with one account per role before onboarding managed endpoints.

## Cloudflare Pages

The dashboard is static, and Supabase continues to provide authentication, the database, and Edge Functions. The Pages build creates the Git-ignored `dashboard/config.js` from the two public Supabase settings supplied to the build.

1. In Cloudflare, open **Workers & Pages** and select **Create application** > **Pages** > **Import an existing Git repository**. Connect GitHub if prompted, then choose `ryseianpinceberalde-arch/men`.
2. Set **Production branch** to `main`, leave **Root directory** at the repository root, set **Build command** to `node scripts/prepare-cloudflare-pages.mjs`, and set **Build output directory** to `dashboard`. Do not select a framework preset.
3. Before the first deployment, add these under the production **Build environment variables**:

   | Name | Value |
   | --- | --- |
   | `SUPABASE_URL` | Your Supabase Project URL |
   | `SUPABASE_PUBLISHABLE_KEY` | Your Supabase publishable key (`sb_publishable_...`) |

   These values are for the browser dashboard. Never set a Supabase service-role key here.

4. Save and deploy. When Cloudflare shows a successful deployment, open the assigned `*.pages.dev` address.
5. In Supabase **Authentication > URL Configuration**, set **Site URL** to that production address and add it to the redirect URL allow list. Use the exact production address, for example `https://your-project.pages.dev/**`.
6. Sign in and confirm the dashboard loads. The Windows agent still connects directly to Supabase; this deployment hosts only the dashboard.

## Troubleshooting

- **Dashboard reports configuration missing:** ensure `dashboard/config.js` exists and contains the URL and publishable key, then hard-refresh.
- **Login succeeds but no admin pages appear:** the initial profile defaults to viewer. Promote the first user once in the SQL Editor or ask an administrator to change the role.
- **RLS or empty data errors:** apply the migration, ensure the signed-in profile is active, and assign technician accounts to computers.
- **Pairing returns unauthorized:** generate a new code; codes expire after 30 minutes and can be consumed only once. Verify device ID and project URL.
- **Agent reports authorization failure:** confirm the device enrollment is active and its credential has not been revoked. Re-pair from the computer detail page.
- **Realtime appears stale:** check Supabase Realtime is enabled and that the migration added the subscribed tables to `supabase_realtime`.
