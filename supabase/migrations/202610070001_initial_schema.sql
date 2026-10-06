-- PC Maintenance and Remote Management System
-- One Supabase project represents one organization. Device credentials and
-- enrollment codes are stored only as SHA-256 hashes and are service-role only.

create type public.user_role as enum ('administrator', 'technician', 'viewer');
create type public.record_status as enum ('active', 'disabled');
create type public.computer_status_type as enum ('online', 'offline', 'maintenance');
create type public.command_status as enum ('pending', 'received', 'processing', 'completed', 'failed', 'rejected', 'expired');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  role public.user_role not null default 'viewer',
  status public.record_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.computers (
  id uuid primary key default gen_random_uuid(),
  device_id text not null unique,
  computer_name text not null,
  assigned_user text,
  manufacturer text,
  model text,
  serial_number text,
  os_name text,
  os_version text,
  architecture text,
  ip_address inet,
  mac_address text,
  status public.computer_status_type not null default 'offline',
  enrollment_status text not null default 'not_registered' check (enrollment_status in ('not_registered', 'pending', 'active', 'revoked')),
  last_seen timestamptz,
  remote_assistance_enabled boolean not null default false,
  remote_assistance_instructions text,
  last_remote_session timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.computer_assignments (
  computer_id uuid not null references public.computers(id) on delete cascade,
  technician_id uuid not null references public.profiles(id) on delete cascade,
  assigned_by uuid references public.profiles(id) on delete set null,
  assigned_at timestamptz not null default now(),
  primary key (computer_id, technician_id)
);

create table public.computer_specs (
  id uuid primary key default gen_random_uuid(),
  computer_id uuid not null unique references public.computers(id) on delete cascade,
  cpu_name text,
  cpu_cores integer check (cpu_cores is null or cpu_cores >= 0),
  logical_processors integer check (logical_processors is null or logical_processors >= 0),
  ram_total bigint check (ram_total is null or ram_total >= 0),
  gpu_name text,
  motherboard text,
  bios text,
  storage_total bigint check (storage_total is null or storage_total >= 0),
  storage_free bigint check (storage_free is null or storage_free >= 0),
  storage_devices jsonb not null default '[]'::jsonb check (jsonb_typeof(storage_devices) = 'array'),
  network_adapters jsonb not null default '[]'::jsonb check (jsonb_typeof(network_adapters) = 'array'),
  updated_at timestamptz not null default now()
);

create table public.computer_status (
  id uuid primary key default gen_random_uuid(),
  computer_id uuid not null references public.computers(id) on delete cascade,
  cpu_usage numeric(5,2) not null default 0 check (cpu_usage between 0 and 100),
  ram_usage numeric(5,2) not null default 0 check (ram_usage between 0 and 100),
  disk_usage numeric(5,2) not null default 0 check (disk_usage between 0 and 100),
  uptime bigint not null default 0 check (uptime >= 0),
  recorded_at timestamptz not null default now()
);

create table public.installed_software (
  id uuid primary key default gen_random_uuid(),
  computer_id uuid not null references public.computers(id) on delete cascade,
  software_name text not null,
  version text,
  publisher text,
  install_date date,
  scanned_at timestamptz not null default now(),
  unique (computer_id, software_name, version)
);

create table public.processes (
  id uuid primary key default gen_random_uuid(),
  computer_id uuid not null references public.computers(id) on delete cascade,
  process_id integer not null check (process_id > 0),
  process_name text not null,
  cpu_usage numeric(7,2) not null default 0,
  memory_usage bigint not null default 0 check (memory_usage >= 0),
  updated_at timestamptz not null default now(),
  unique (computer_id, process_id)
);

create table public.services (
  id uuid primary key default gen_random_uuid(),
  computer_id uuid not null references public.computers(id) on delete cascade,
  service_name text not null,
  display_name text not null,
  status text not null default 'unknown' check (status in ('running', 'stopped', 'paused', 'start_pending', 'stop_pending', 'unknown')),
  startup_type text not null default 'unknown',
  updated_at timestamptz not null default now(),
  unique (computer_id, service_name)
);

create table public.commands (
  id uuid primary key default gen_random_uuid(),
  computer_id uuid not null references public.computers(id) on delete cascade,
  command_type text not null check (command_type in ('GET_SYSTEM_INFO', 'GET_HARDWARE_INFO', 'GET_SOFTWARE', 'GET_PROCESSES', 'GET_SERVICES', 'GET_SYSTEM_STATUS', 'STOP_PROCESS', 'START_SERVICE', 'STOP_SERVICE', 'RESTART_SERVICE', 'RESTART_PC', 'SHUTDOWN_PC')),
  parameters jsonb not null default '{}'::jsonb check (jsonb_typeof(parameters) = 'object'),
  status public.command_status not null default 'pending',
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  received_at timestamptz,
  executed_at timestamptz,
  expires_at timestamptz not null default (now() + interval '5 minutes'),
  result jsonb,
  error_message text,
  check (expires_at > created_at and expires_at <= created_at + interval '15 minutes'),
  check (octet_length(parameters::text) <= 4096),
  check (command_type <> 'STOP_PROCESS' or coalesce((
    jsonb_typeof(parameters -> 'process_id') = 'number' and
    (parameters ->> 'process_id') ~ '^[1-9][0-9]{0,8}$' and
    jsonb_typeof(parameters -> 'process_name') = 'string' and
    length(parameters ->> 'process_name') between 1 and 256
  ), false)),
  check (command_type not in ('START_SERVICE', 'STOP_SERVICE', 'RESTART_SERVICE') or coalesce((
    jsonb_typeof(parameters -> 'service_name') = 'string' and
    length(parameters ->> 'service_name') between 1 and 256
  ), false))
);

create table public.maintenance_records (
  id uuid primary key default gen_random_uuid(),
  computer_id uuid not null references public.computers(id) on delete cascade,
  maintenance_type text not null check (maintenance_type in ('Preventive Maintenance', 'Corrective Maintenance', 'Hardware Maintenance', 'Software Maintenance', 'Network Maintenance', 'Security Maintenance')),
  description text not null,
  technician_id uuid references public.profiles(id) on delete set null,
  maintenance_date date not null default current_date,
  findings text,
  actions_performed text,
  recommendation text,
  status text not null default 'Completed' check (status in ('Scheduled', 'In Progress', 'Completed', 'Cancelled', 'Overdue')),
  next_maintenance_date date,
  created_at timestamptz not null default now()
);

create table public.maintenance_schedules (
  id uuid primary key default gen_random_uuid(),
  computer_id uuid not null references public.computers(id) on delete cascade,
  maintenance_type text not null check (maintenance_type in ('Preventive Maintenance', 'Corrective Maintenance', 'Hardware Maintenance', 'Software Maintenance', 'Network Maintenance', 'Security Maintenance')),
  technician_id uuid references public.profiles(id) on delete set null,
  scheduled_date date not null,
  priority text not null default 'Normal' check (priority in ('Low', 'Normal', 'High', 'Critical')),
  status text not null default 'Scheduled' check (status in ('Scheduled', 'In Progress', 'Completed', 'Cancelled', 'Overdue')),
  notes text,
  created_at timestamptz not null default now()
);

create table public.problems (
  id uuid primary key default gen_random_uuid(),
  computer_id uuid not null references public.computers(id) on delete cascade,
  title text not null,
  description text not null,
  category text not null check (category in ('Hardware', 'Software', 'Network', 'Operating System', 'Security', 'Other')),
  error_message text,
  cause text,
  troubleshooting text,
  solution text,
  technician_id uuid references public.profiles(id) on delete set null,
  reported_at timestamptz not null default now(),
  resolved_at timestamptz,
  status text not null default 'Open' check (status in ('Open', 'In Progress', 'Resolved', 'Closed'))
);

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  computer_id uuid not null references public.computers(id) on delete cascade,
  alert_type text not null,
  severity text not null check (severity in ('Information', 'Warning', 'Critical')),
  message text not null,
  status text not null default 'Open' check (status in ('Open', 'Acknowledged', 'Resolved')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  computer_id uuid references public.computers(id) on delete set null,
  action text not null,
  description text not null,
  result text not null default 'success' check (result in ('success', 'failure', 'rejected', 'pending')),
  created_at timestamptz not null default now()
);

create table public.alert_settings (
  id boolean primary key default true check (id),
  cpu_warning numeric(5,2) not null default 80 check (cpu_warning between 1 and 100),
  ram_warning numeric(5,2) not null default 85 check (ram_warning between 1 and 100),
  disk_warning numeric(5,2) not null default 90 check (disk_warning between 1 and 100),
  offline_after_minutes integer not null default 3 check (offline_after_minutes between 1 and 1440),
  updated_at timestamptz not null default now()
);
insert into public.alert_settings (id) values (true) on conflict do nothing;

-- These two tables have no user-facing policies. Edge Functions use the
-- service role after verifying the caller or device credential.
create table public.device_enrollment_tokens (
  id uuid primary key default gen_random_uuid(),
  computer_id uuid not null references public.computers(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.agent_credentials (
  computer_id uuid primary key references public.computers(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index computers_status_last_seen_idx on public.computers(status, last_seen desc);
create index computer_assignments_technician_idx on public.computer_assignments(technician_id, computer_id);
create index computer_status_latest_idx on public.computer_status(computer_id, recorded_at desc);
create index software_computer_name_idx on public.installed_software(computer_id, software_name);
create index processes_computer_name_idx on public.processes(computer_id, process_name);
create index services_computer_name_idx on public.services(computer_id, service_name);
create index commands_pending_idx on public.commands(status, expires_at, created_at) where status = 'pending';
create index commands_computer_created_idx on public.commands(computer_id, created_at desc);
create index maintenance_computer_date_idx on public.maintenance_records(computer_id, maintenance_date desc);
create index schedules_due_idx on public.maintenance_schedules(status, scheduled_date);
create index problems_computer_reported_idx on public.problems(computer_id, reported_at desc);
create index alerts_status_created_idx on public.alerts(status, created_at desc);
create index activity_created_idx on public.activity_logs(created_at desc);
create index activity_user_created_idx on public.activity_logs(user_id, created_at desc);

create or replace function public.enforce_command_rate_limit()
returns trigger language plpgsql set search_path = '' as $$
declare recent_commands integer;
begin
  select count(*) into recent_commands from public.commands c
  where c.created_by = new.created_by and c.created_at > now() - interval '10 minutes'
    and c.status in ('pending', 'received', 'processing');
  if recent_commands >= 20 then
    raise exception 'Command request rate limit reached; wait for queued actions to complete.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger commands_rate_limit before insert on public.commands
for each row execute function public.enforce_command_rate_limit();

-- Claim one queued command atomically so two agent polls cannot execute it twice.
create or replace function public.claim_next_command(target_computer uuid)
returns setof public.commands language plpgsql security definer set search_path = '' as $$
declare selected_id uuid;
begin
  update public.commands set status = 'expired', executed_at = coalesce(executed_at, now())
  where computer_id = target_computer and status in ('pending', 'received', 'processing') and expires_at <= now();
  select c.id into selected_id from public.commands c
  where c.computer_id = target_computer and c.status = 'pending' and c.expires_at > now()
  order by c.created_at limit 1 for update skip locked;
  if selected_id is null then return; end if;
  return query update public.commands c set status = 'received', received_at = now()
    where c.id = selected_id returning c.*;
end;
$$;
revoke all on function public.claim_next_command(uuid) from public, anon, authenticated;
grant execute on function public.claim_next_command(uuid) to service_role;

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
create trigger computers_set_updated_at before update on public.computers
for each row execute function public.set_updated_at();
create trigger computer_specs_set_updated_at before update on public.computer_specs
for each row execute function public.set_updated_at();
create trigger alert_settings_set_updated_at before update on public.alert_settings
for each row execute function public.set_updated_at();

-- Auditing is derived from successful database writes. Browser clients cannot
-- invent operational events by calling the activity logging endpoint.
create or replace function public.audit_resource_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  action_name text;
  detail text;
  target_computer uuid;
  event_result text := 'success';
begin
  if tg_table_name = 'computers' then
    target_computer := new.id;
    if tg_op = 'INSERT' then
      action_name := 'REGISTER_COMPUTER';
      detail := 'Registered computer ' || new.computer_name || '.';
    elsif old.remote_assistance_enabled is distinct from new.remote_assistance_enabled
       or old.remote_assistance_instructions is distinct from new.remote_assistance_instructions then
      action_name := 'UPDATE_REMOTE_ASSISTANCE';
      detail := 'Updated remote assistance details for ' || new.computer_name || '.';
    else
      return new;
    end if;
  elsif tg_table_name = 'computer_assignments' then
    target_computer := case when tg_op = 'DELETE' then old.computer_id else new.computer_id end;
    action_name := case when tg_op = 'INSERT' then 'ASSIGN_TECHNICIAN' else 'REMOVE_TECHNICIAN_ASSIGNMENT' end;
    detail := 'Updated technician assignment for computer ' || target_computer::text || '.';
  elsif tg_table_name = 'commands' then
    target_computer := new.computer_id;
    actor := new.created_by;
    action_name := new.command_type;
    detail := 'Queued approved command ' || new.command_type || '.';
    event_result := 'pending';
  elsif tg_table_name = 'maintenance_records' then
    target_computer := new.computer_id;
    action_name := case when tg_op = 'INSERT' then 'CREATE_MAINTENANCE' else 'UPDATE_MAINTENANCE' end;
    detail := 'Saved ' || new.maintenance_type || ' maintenance record (' || new.status || ').';
  elsif tg_table_name = 'maintenance_schedules' then
    target_computer := new.computer_id;
    action_name := case when tg_op = 'INSERT' then 'CREATE_MAINTENANCE_SCHEDULE' else 'UPDATE_MAINTENANCE_SCHEDULE' end;
    detail := 'Saved ' || new.maintenance_type || ' maintenance schedule (' || new.status || ').';
  elsif tg_table_name = 'problems' then
    target_computer := new.computer_id;
    action_name := case when tg_op = 'INSERT' then 'CREATE_TROUBLESHOOTING_RECORD' else 'UPDATE_TROUBLESHOOTING' end;
    detail := 'Saved troubleshooting record: ' || new.title || ' (' || new.status || ').';
  elsif tg_table_name = 'alerts' then
    if actor is null or new.status <> 'Acknowledged' or old.status is not distinct from new.status then return new; end if;
    target_computer := new.computer_id;
    action_name := 'ACKNOWLEDGE_ALERT';
    detail := 'Acknowledged alert: ' || new.alert_type || '.';
  elsif tg_table_name = 'alert_settings' then
    action_name := 'UPDATE_SETTINGS';
    detail := 'Updated organization health alert thresholds.';
  elsif tg_table_name = 'profiles' then
    if actor is null then return new; end if;
    action_name := 'UPDATE_USER';
    detail := 'Updated account access for profile ' || new.id::text || '.';
  else
    return new;
  end if;

  insert into public.activity_logs(user_id, computer_id, action, description, result)
  values (actor, target_computer, action_name, detail, event_result);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger audit_computer_change after insert or update on public.computers
for each row execute function public.audit_resource_change();
create trigger audit_assignment_insert after insert on public.computer_assignments
for each row execute function public.audit_resource_change();
create trigger audit_assignment_delete after delete on public.computer_assignments
for each row execute function public.audit_resource_change();
create trigger audit_command_insert after insert on public.commands
for each row execute function public.audit_resource_change();
create trigger audit_maintenance_change after insert or update on public.maintenance_records
for each row execute function public.audit_resource_change();
create trigger audit_schedule_change after insert or update on public.maintenance_schedules
for each row execute function public.audit_resource_change();
create trigger audit_problem_change after insert or update on public.problems
for each row execute function public.audit_resource_change();
create trigger audit_alert_acknowledgement after update on public.alerts
for each row execute function public.audit_resource_change();
create trigger audit_alert_settings_update after update on public.alert_settings
for each row execute function public.audit_resource_change();
create trigger audit_profile_update after update on public.profiles
for each row execute function public.audit_resource_change();

create or replace function public.current_user_role()
returns public.user_role language sql stable security definer set search_path = '' as $$
  select p.role from public.profiles p where p.id = (select auth.uid()) and p.status = 'active'
$$;

create or replace function public.can_access_computer(target_computer uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(public.current_user_role() in ('administrator', 'viewer'), false)
    or (public.current_user_role() = 'technician' and exists (
      select 1 from public.computer_assignments a
      where a.computer_id = target_computer and a.technician_id = (select auth.uid())
    ))
$$;

create or replace function public.can_manage_computer(target_computer uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(public.current_user_role() = 'administrator', false)
    or (public.current_user_role() = 'technician' and exists (
      select 1 from public.computer_assignments a
      where a.computer_id = target_computer and a.technician_id = (select auth.uid())
    ))
$$;

grant execute on function public.current_user_role() to authenticated;
grant execute on function public.can_access_computer(uuid) to authenticated;
grant execute on function public.can_manage_computer(uuid) to authenticated;

alter table public.profiles enable row level security;
alter table public.computers enable row level security;
alter table public.computer_assignments enable row level security;
alter table public.computer_specs enable row level security;
alter table public.computer_status enable row level security;
alter table public.installed_software enable row level security;
alter table public.processes enable row level security;
alter table public.services enable row level security;
alter table public.commands enable row level security;
alter table public.maintenance_records enable row level security;
alter table public.maintenance_schedules enable row level security;
alter table public.problems enable row level security;
alter table public.alerts enable row level security;
alter table public.activity_logs enable row level security;
alter table public.alert_settings enable row level security;
alter table public.device_enrollment_tokens enable row level security;
alter table public.agent_credentials enable row level security;

-- Dashboard subscriptions are limited by the same table RLS policies above.
do $$
declare table_name text;
begin
  foreach table_name in array array['computers', 'computer_status', 'alerts', 'commands', 'maintenance_records', 'maintenance_schedules'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = table_name
    ) then
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    end if;
  end loop;
end;
$$;

create policy profiles_read on public.profiles for select to authenticated
  using (id = (select auth.uid()) or public.current_user_role() = 'administrator');
create policy profiles_admin_update on public.profiles for update to authenticated
  using (public.current_user_role() = 'administrator') with check (public.current_user_role() = 'administrator');
create policy profiles_admin_insert on public.profiles for insert to authenticated
  with check (public.current_user_role() = 'administrator');

create policy computers_read on public.computers for select to authenticated
  using (public.can_access_computer(id));
create policy computers_admin_insert on public.computers for insert to authenticated
  with check (public.current_user_role() = 'administrator');
create policy computers_admin_update on public.computers for update to authenticated
  using (public.current_user_role() = 'administrator') with check (public.current_user_role() = 'administrator');
create policy computers_admin_delete on public.computers for delete to authenticated
  using (public.current_user_role() = 'administrator');

create policy assignments_read on public.computer_assignments for select to authenticated
  using (public.current_user_role() = 'administrator' or technician_id = (select auth.uid()));
create policy assignments_admin_write on public.computer_assignments for all to authenticated
  using (public.current_user_role() = 'administrator') with check (public.current_user_role() = 'administrator');

create policy specs_read on public.computer_specs for select to authenticated using (public.can_access_computer(computer_id));
create policy specs_admin_write on public.computer_specs for all to authenticated
  using (public.current_user_role() = 'administrator') with check (public.current_user_role() = 'administrator');
create policy status_read on public.computer_status for select to authenticated using (public.can_access_computer(computer_id));
create policy software_read on public.installed_software for select to authenticated
  using (public.current_user_role() = 'administrator' or (public.current_user_role() = 'technician' and public.can_access_computer(computer_id)));
create policy processes_read on public.processes for select to authenticated
  using (public.current_user_role() = 'administrator' or (public.current_user_role() = 'technician' and public.can_access_computer(computer_id)));
create policy services_read on public.services for select to authenticated
  using (public.current_user_role() = 'administrator' or (public.current_user_role() = 'technician' and public.can_access_computer(computer_id)));

create policy commands_read on public.commands for select to authenticated
  using (public.current_user_role() = 'administrator' or (public.current_user_role() = 'technician' and public.can_access_computer(computer_id)));
create policy commands_create on public.commands for insert to authenticated
  with check (public.can_manage_computer(computer_id) and created_by = (select auth.uid()));
create policy maintenance_read on public.maintenance_records for select to authenticated using (public.can_access_computer(computer_id));
create policy maintenance_write on public.maintenance_records for insert to authenticated
  with check (public.can_manage_computer(computer_id) and (technician_id is null or technician_id = (select auth.uid()) or public.current_user_role() = 'administrator'));
create policy maintenance_update on public.maintenance_records for update to authenticated
  using (public.can_manage_computer(computer_id)) with check (public.can_manage_computer(computer_id) and (technician_id is null or technician_id = (select auth.uid()) or public.current_user_role() = 'administrator'));
create policy schedules_read on public.maintenance_schedules for select to authenticated
  using (public.current_user_role() = 'administrator' or (public.current_user_role() = 'technician' and public.can_access_computer(computer_id)));
create policy schedules_write on public.maintenance_schedules for insert to authenticated
  with check (public.can_manage_computer(computer_id) and (technician_id is null or technician_id = (select auth.uid()) or public.current_user_role() = 'administrator'));
create policy schedules_update on public.maintenance_schedules for update to authenticated
  using (public.can_manage_computer(computer_id)) with check (public.can_manage_computer(computer_id) and (technician_id is null or technician_id = (select auth.uid()) or public.current_user_role() = 'administrator'));
create policy problems_read on public.problems for select to authenticated
  using (public.current_user_role() = 'administrator' or (public.current_user_role() = 'technician' and public.can_access_computer(computer_id)));
create policy problems_write on public.problems for insert to authenticated
  with check (public.can_manage_computer(computer_id) and (technician_id is null or technician_id = (select auth.uid()) or public.current_user_role() = 'administrator'));
create policy problems_update on public.problems for update to authenticated
  using (public.can_manage_computer(computer_id)) with check (public.can_manage_computer(computer_id) and (technician_id is null or technician_id = (select auth.uid()) or public.current_user_role() = 'administrator'));

create policy alerts_read on public.alerts for select to authenticated
  using (public.current_user_role() = 'administrator' or (public.current_user_role() = 'technician' and public.can_access_computer(computer_id)));
create policy alerts_acknowledge on public.alerts for update to authenticated
  using (public.current_user_role() = 'administrator' or (public.current_user_role() = 'technician' and public.can_manage_computer(computer_id)))
  with check (public.current_user_role() = 'administrator' or (public.current_user_role() = 'technician' and public.can_manage_computer(computer_id)));
create policy logs_read on public.activity_logs for select to authenticated
  using (public.current_user_role() = 'administrator' or (public.current_user_role() = 'technician' and computer_id is not null and public.can_access_computer(computer_id)));
create policy alert_settings_read on public.alert_settings for select to authenticated using (public.current_user_role() is not null);
create policy alert_settings_admin_write on public.alert_settings for update to authenticated
  using (public.current_user_role() = 'administrator') with check (public.current_user_role() = 'administrator');

-- A compact, RLS-aware fleet summary avoids downloading the full asset or
-- monitoring history just to render dashboard totals.
create or replace function public.dashboard_metrics()
returns jsonb language sql stable security invoker set search_path = '' as $$
  with latest_status as (
    select distinct on (s.computer_id) s.computer_id, s.cpu_usage, s.ram_usage, s.disk_usage
    from public.computer_status s
    where s.recorded_at >= now() - interval '5 minutes'
    order by s.computer_id, s.recorded_at desc
  )
  select jsonb_build_object(
    'total_computers', (select count(*) from public.computers),
    'online_computers', (select count(*) from public.computers c where c.status = 'online' and c.enrollment_status = 'active'),
    'offline_computers', (select count(*) from public.computers c where c.status = 'offline' or c.enrollment_status <> 'active'),
    'maintenance_computers', (select count(*) from public.computers c where c.status = 'maintenance'),
    'overdue_maintenance', (select count(*) from public.maintenance_schedules m where m.status = 'Overdue'),
    'critical_alerts', (select count(*) from public.alerts a where a.severity = 'Critical' and a.status in ('Open', 'Acknowledged')),
    'storage_alerts', (select count(*) from public.alerts a where a.alert_type = 'disk_full' and a.status in ('Open', 'Acknowledged')),
    'average_cpu', coalesce((select avg(s.cpu_usage) from latest_status s), 0),
    'average_ram', coalesce((select avg(s.ram_usage) from latest_status s), 0),
    'average_disk', coalesce((select avg(s.disk_usage) from latest_status s), 0)
  );
$$;
revoke all on function public.dashboard_metrics() from public, anon;
grant execute on function public.dashboard_metrics() to authenticated;

-- Device tables deliberately have no authenticated policies. Service role only.
