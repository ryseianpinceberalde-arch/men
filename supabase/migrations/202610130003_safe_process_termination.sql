-- Add an exact process identity, admin-only dispatch, and a durable audit trail.
alter table public.processes
  add column process_started_at timestamptz,
  add column application_name text;

alter table public.commands
  add column idempotency_key uuid;

-- The initial schema limited PIDs to nine digits, although Windows process IDs
-- are signed 32-bit values. Replace only that original STOP_PROCESS check.
do $$
declare
  pid_constraint record;
begin
  for pid_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.commands'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%parameters%process_id%'
      and pg_get_constraintdef(oid) like '%0-9%'
      and pg_get_constraintdef(oid) like '%STOP_PROCESS%'
  loop
    execute format('alter table public.commands drop constraint %I', pid_constraint.conname);
  end loop;
end;
$$;

alter table public.commands
  add constraint commands_stop_process_pid_check check (
    command_type <> 'STOP_PROCESS' or coalesce((
      jsonb_typeof(parameters -> 'process_id') = 'number' and
      (parameters ->> 'process_id') ~ '^[1-9][0-9]{0,9}$' and
      (parameters ->> 'process_id')::bigint <= 2147483647
    ), false)
  );

create unique index commands_created_by_idempotency_idx
  on public.commands(created_by, idempotency_key)
  where idempotency_key is not null;

alter table public.commands
  add constraint commands_stop_process_identity_check check (
    command_type <> 'STOP_PROCESS' or idempotency_key is null or coalesce((
      jsonb_typeof(parameters -> 'process_started_at') = 'string' and
      length(parameters ->> 'process_started_at') between 20 and 40 and
      jsonb_typeof(parameters -> 'force') = 'boolean'
    ), false)
  );

alter table public.activity_logs
  add column command_id uuid references public.commands(id) on delete set null;

create unique index activity_logs_command_id_idx
  on public.activity_logs(command_id)
  where command_id is not null;

-- Termination must pass through admin-api, which verifies role, online state,
-- fresh process inventory, exact PID/name/start-time, and idempotency.
drop policy commands_create on public.commands;
create policy commands_create on public.commands for insert to authenticated
  with check (
    command_type <> 'STOP_PROCESS' and
    public.can_manage_computer(computer_id) and
    created_by = (select auth.uid())
  );

create or replace function public.audit_process_command()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  computer_label text;
  process_label text;
  process_identifier text;
  audit_result text;
  audit_detail text;
begin
  if new.command_type <> 'STOP_PROCESS' then return new; end if;
  select c.computer_name into computer_label from public.computers c where c.id = new.computer_id;
  process_label := coalesce(new.parameters ->> 'process_name', 'unknown process');
  process_identifier := coalesce(new.parameters ->> 'process_id', 'unknown PID');

  if tg_op = 'INSERT' then
    insert into public.activity_logs(user_id, computer_id, command_id, action, description, result)
    values (
      new.created_by,
      new.computer_id,
      new.id,
      'STOP_PROCESS',
      format('Administrator requested %sEnd Task for %s (PID %s) on %s.',
        case when coalesce((new.parameters ->> 'force')::boolean, false) then 'forced ' else 'graceful ' end,
        process_label, process_identifier, coalesce(computer_label, new.computer_id::text)),
      'pending'
    );
    return new;
  end if;

  if old.status is not distinct from new.status then return new; end if;
  audit_result := case new.status
    when 'completed' then 'success'
    when 'rejected' then 'rejected'
    when 'failed' then 'failure'
    when 'expired' then 'failure'
    else 'pending'
  end;
  audit_detail := case new.status
    when 'processing' then format('Agent started the End Task request for %s (PID %s) on %s.', process_label, process_identifier, coalesce(computer_label, new.computer_id::text))
    when 'awaiting_confirmation' then format('The agent could not close %s (PID %s) on %s gracefully; administrator confirmation is required before force termination.', process_label, process_identifier, coalesce(computer_label, new.computer_id::text))
    when 'completed' then format('The agent confirmed the End Task request for %s (PID %s) on %s.', process_label, process_identifier, coalesce(computer_label, new.computer_id::text))
    when 'rejected' then format('The agent rejected the End Task request for %s (PID %s) on %s: %s', process_label, process_identifier, coalesce(computer_label, new.computer_id::text), coalesce(new.error_message, 'no reason supplied'))
    when 'failed' then format('The End Task request for %s (PID %s) on %s failed: %s', process_label, process_identifier, coalesce(computer_label, new.computer_id::text), coalesce(new.error_message, 'no reason supplied'))
    when 'expired' then format('The End Task request for %s (PID %s) on %s expired before the agent confirmed it.', process_label, process_identifier, coalesce(computer_label, new.computer_id::text))
    else format('End Task request for %s (PID %s) on %s is %s.', process_label, process_identifier, coalesce(computer_label, new.computer_id::text), new.status::text)
  end;
  update public.activity_logs
    set description = audit_detail, result = audit_result
    where command_id = new.id;
  return new;
end;
$$;

create trigger audit_process_command_change
  after insert or update of status on public.commands
  for each row execute function public.audit_process_command();
