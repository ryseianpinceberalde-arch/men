-- Additive network telemetry. No changes to existing inventory or health history.
create table public.network_settings (
  id boolean primary key default true check (id),
  wifi_seconds integer not null default 10 check (wifi_seconds between 10 and 300),
  probe_seconds integer not null default 30 check (probe_seconds between 30 and 300),
  bandwidth_seconds integer not null default 5 check (bandwidth_seconds between 5 and 60),
  signal_warning integer not null default 40 check (signal_warning between 0 and 100),
  signal_categories integer[] not null default array[20,40,60,80] check (
    cardinality(signal_categories) = 4 and array_ndims(signal_categories) = 1 and array_lower(signal_categories,1) = 1 and array_position(signal_categories,null) is null and signal_categories[1] >= 1 and signal_categories[4] <= 100 and
    signal_categories[1] < signal_categories[2] and signal_categories[2] < signal_categories[3] and signal_categories[3] < signal_categories[4]),
  latency_warning integer not null default 200 check (latency_warning between 1 and 60000),
  packet_loss_warning integer not null default 20 check (packet_loss_warning between 1 and 100),
  poor_seconds integer not null default 120 check (poor_seconds between 30 and 3600),
  cooldown_seconds integer not null default 900 check (cooldown_seconds between 60 and 86400),
  repeated_disconnects integer not null default 3 check (repeated_disconnects between 2 and 100),
  speed_interval_hours integer not null default 0 check (speed_interval_hours between 0 and 168),
  retention_days integer not null default 30 check (retention_days between 30 and 365),
  updated_at timestamptz not null default now(),
  check (bandwidth_seconds <= wifi_seconds and bandwidth_seconds <= probe_seconds)
);
insert into public.network_settings(id) values(true);
create table public.network_state (
  computer_id uuid primary key references public.computers(id) on delete cascade,
  observed_at timestamptz not null,
  received_at timestamptz not null default now(),
  connection_type text not null check (connection_type in ('wifi','ethernet','other','unknown')),
  primary_adapter_id text,
  adapters jsonb not null default '[]',
  probe jsonb,
  last_success_at timestamptz
);
create table public.network_identifiers (
  computer_id uuid primary key references public.computers(id) on delete cascade,
  adapters jsonb not null default '[]'
);
create table public.network_samples (
  computer_id uuid not null references public.computers(id) on delete cascade,
  sample_id uuid not null,
  observed_at timestamptz not null,
  connection_type text not null,
  signal_percent numeric check(signal_percent between 0 and 100),
  receive_bps numeric check(receive_bps >= 0), send_bps numeric check(send_bps >= 0),
  probe_status text, probe_at timestamptz,
  latency_ms numeric check(latency_ms >= 0), jitter_ms numeric check(jitter_ms >= 0),
  packet_loss_percent numeric check(packet_loss_percent between 0 and 100),
  attempts integer, successes integer,
  primary key(computer_id, sample_id)
);
create index network_samples_time_idx on public.network_samples(computer_id, observed_at desc);
create index network_samples_retention_idx on public.network_samples(observed_at);
create table public.network_events (
  id bigint generated always as identity primary key,
  computer_id uuid not null references public.computers(id) on delete cascade,
  observed_at timestamptz not null, kind text not null, message text not null
);
create index network_events_time_idx on public.network_events(computer_id, observed_at desc);
create index network_events_retention_idx on public.network_events(observed_at);
create table public.network_outages (
  id bigint generated always as identity primary key,
  computer_id uuid not null references public.computers(id) on delete cascade,
  started_at timestamptz not null, ended_at timestamptz,
  reason text not null, observation_gap boolean not null default false,
  check(ended_at is null or ended_at >= started_at)
);
create unique index network_outages_open_idx on public.network_outages(computer_id) where ended_at is null;
create index network_outages_time_idx on public.network_outages(computer_id, started_at desc);
create index network_outages_retention_idx on public.network_outages(ended_at) where ended_at is not null;
create table public.network_speed_tests (
  computer_id uuid not null references public.computers(id) on delete cascade,
  test_id uuid not null, tested_at timestamptz not null,
  result jsonb not null,
  primary key(computer_id, test_id)
);
create index network_speed_time_idx on public.network_speed_tests(computer_id, tested_at desc);
create index network_speed_retention_idx on public.network_speed_tests(tested_at);
create table public.network_conditions (
  computer_id uuid not null references public.computers(id) on delete cascade,
  kind text not null, since_at timestamptz, last_alert_at timestamptz,
  primary key(computer_id, kind)
);

do $$ declare t text; begin
  foreach t in array array['network_settings','network_state','network_identifiers','network_samples','network_events','network_outages','network_speed_tests','network_conditions'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon, authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
  foreach t in array array['network_state','network_samples','network_events','network_outages','network_speed_tests'] loop
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy network_managed_read on public.%I for select to authenticated using (public.can_manage_computer(computer_id))',t);
  end loop;
end $$;
grant select on public.network_identifiers, public.network_settings to authenticated;
grant update on public.network_settings to authenticated;
create policy network_identifiers_admin on public.network_identifiers for select to authenticated using(public.current_user_role() = 'administrator');
create policy network_settings_read on public.network_settings for select to authenticated using(public.current_user_role() in ('administrator','technician'));
create policy network_settings_admin on public.network_settings for update to authenticated using(public.current_user_role() = 'administrator') with check(public.current_user_role() = 'administrator');
create trigger network_settings_updated before update on public.network_settings for each row execute function public.set_updated_at();
create function public.audit_network_settings() returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.activity_logs(user_id,action,description) values(auth.uid(),'UPDATE_NETWORK_SETTINGS','Updated network thresholds, sampling, retention, or speed-test schedule.');
  return new;
end $$;
create trigger network_settings_audit after update on public.network_settings for each row execute function public.audit_network_settings();
alter publication supabase_realtime add table public.network_state;

-- Serialized under the computer lock in ingest_network_batch. Unknown observations never recover an alert.
create function public.network_condition(target uuid, alert_kind text, active boolean, at_time timestamptz, delay_seconds integer, cooldown integer, detail text)
returns void language plpgsql security definer set search_path='' as $$
declare c public.network_conditions; opened uuid;
begin
  if active is null then
    update public.network_conditions set since_at=null where computer_id=target and kind=alert_kind and since_at is not null;
    return;
  end if;
  insert into public.network_conditions(computer_id,kind) values(target,alert_kind) on conflict do nothing;
  select * into c from public.network_conditions where computer_id=target and kind=alert_kind for update;
  if active then
    c.since_at := coalesce(c.since_at,at_time);
    if at_time >= c.since_at + make_interval(secs=>delay_seconds) and (c.last_alert_at is null or at_time >= c.last_alert_at + make_interval(secs=>cooldown))
      and not exists(select 1 from public.alerts where computer_id=target and alert_type=alert_kind and status in ('Open','Acknowledged')) then
      insert into public.alerts(computer_id,alert_type,severity,message,created_at) values(target,alert_kind,'Warning',detail,at_time);
      c.last_alert_at := at_time;
    end if;
  else
    c.since_at := null;
    update public.alerts set status='Resolved',resolved_at=at_time where computer_id=target and alert_type=alert_kind and status in ('Open','Acknowledged') returning id into opened;
    if opened is not null then
      insert into public.network_events(computer_id,observed_at,kind,message) values(target,at_time,'recovery','Recovered: ' || detail);
    end if;
  end if;
  update public.network_conditions set since_at=c.since_at,last_alert_at=c.last_alert_at where computer_id=target and kind=alert_kind;
end $$;
revoke all on function public.network_condition(uuid,text,boolean,timestamptz,integer,integer,text) from public,anon,authenticated;

create function public.ingest_network_batch(target_computer uuid, batch jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  cfg public.network_settings; previous public.network_state; s jsonb; a jsonb; old_a jsonb; p jsonb;
  at_time timestamptz; clean_adapters jsonb; identifiers jsonb; signal numeric; rx numeric; tx numeric;
  inserted integer; condition_key text; changed boolean; probe_new boolean; probe_time timestamptz;
begin
  perform 1 from public.computers where id=target_computer and enrollment_status='active' for update;
  if not found then raise exception 'Device unavailable'; end if;
  if jsonb_array_length(batch->'samples') > 60 or jsonb_array_length(batch->'speed_tests') > 32 then raise exception 'Batch too large'; end if;
  select * into cfg from public.network_settings where id;
  for s in select value from jsonb_array_elements(batch->'samples') order by value->>'observed_at' loop
    at_time := (s->>'observed_at')::timestamptz;
    if at_time > now()+interval '2 minutes' or at_time < now()-interval '7 days' then raise exception 'Invalid timestamp'; end if;
    select * into previous from public.network_state where computer_id=target_computer;
    p := nullif(s->'probe','null'::jsonb);
    probe_time := (p->>'tested_at')::timestamptz;
    probe_new := p is not null and (previous.probe is null or probe_time > (previous.probe->>'tested_at')::timestamptz);
    select avg((value->'wifi'->>'signal_percent')::numeric) into signal from jsonb_array_elements(s->'adapters') where value->'wifi'->>'status'='connected';
    select (value->>'receive_bytes_per_second')::numeric,(value->>'send_bytes_per_second')::numeric into rx,tx
      from jsonb_array_elements(s->'adapters') where value->>'id'=s->>'primary_adapter_id' limit 1;
    insert into public.network_samples(computer_id,sample_id,observed_at,connection_type,signal_percent,receive_bps,send_bps,probe_status,probe_at,latency_ms,jitter_ms,packet_loss_percent,attempts,successes)
      values(target_computer,(s->>'sample_id')::uuid,at_time,s->>'connection_type',signal,rx,tx,p->>'status',probe_time,(p->>'latency_ms')::numeric,(p->>'jitter_ms')::numeric,(p->>'packet_loss_percent')::numeric,(p->>'attempts')::integer,(p->>'successes')::integer)
      on conflict do nothing;
    get diagnostics inserted = row_count;
    if inserted=0 or (previous.observed_at is not null and at_time <= previous.observed_at) then continue; end if;
    if at_time-previous.observed_at > make_interval(secs=>greatest(cfg.wifi_seconds,cfg.probe_seconds)*3) then
      -- Missing observations cannot prove continuous degradation across an agent outage.
      update public.network_conditions set since_at=null where computer_id=target_computer;
    end if;
    clean_adapters := '[]'; identifiers := '[]';
    for a in select value from jsonb_array_elements(s->'adapters') loop
      identifiers := identifiers || jsonb_build_array(jsonb_build_object('id',a->'id','mac_address',a->'mac_address','bssid',a->'wifi'->'bssid'));
      clean_adapters := clean_adapters || jsonb_build_array((a-'mac_address') || jsonb_build_object('wifi',case when a->'wifi'='null' then 'null'::jsonb else (a->'wifi')-'bssid' end));
      if a->>'type'<>'wifi' then continue; end if;
      select value into old_a from jsonb_array_elements(coalesce(previous.adapters,'[]')) where value->>'id'=a->>'id';
      condition_key := md5(a->>'id');
      if old_a is not null and a->'wifi'->>'status' is distinct from old_a->'wifi'->>'status' then
        insert into public.network_events(computer_id,observed_at,kind,message) values(target_computer,at_time,'wifi_' || (a->'wifi'->>'status'),'Wireless adapter connection state changed.');
      end if;
      changed := old_a->'wifi'->>'ssid' is not null and a->'wifi'->>'ssid' is not null and old_a->'wifi'->>'ssid' <> a->'wifi'->>'ssid';
      if changed then insert into public.network_events(computer_id,observed_at,kind,message) values(target_computer,at_time,'ssid_changed','Connected SSID changed.'); end if;
      perform public.network_condition(target_computer,'network_ssid_'||condition_key,changed,at_time,0,cfg.cooldown_seconds,'Connected SSID changed.');
      perform public.network_condition(target_computer,'network_wifi_disabled_'||condition_key,case when a->'wifi'->>'status'='unknown' then null else a->'wifi'->>'status'='disabled' end,at_time,0,cfg.cooldown_seconds,'Wireless adapter is disabled.');
      -- Ignore an unused adapter that has never been observed connected.
      if old_a->'wifi'->>'status'='connected' or exists(select 1 from public.network_conditions where computer_id=target_computer and kind='network_wifi_disconnected_'||condition_key) then
        perform public.network_condition(target_computer,'network_wifi_disconnected_'||condition_key,case when a->'wifi'->>'status'='unknown' then null else a->'wifi'->>'status'<>'connected' end,at_time,0,cfg.cooldown_seconds,'Wi-Fi disconnected.');
      end if;
      perform public.network_condition(target_computer,'network_signal_'||condition_key,(a->'wifi'->>'signal_percent')::numeric < cfg.signal_warning,at_time,0,cfg.cooldown_seconds,'Wi-Fi signal below configured threshold.');
      perform public.network_condition(target_computer,'network_signal_sustained_'||condition_key,(a->'wifi'->>'signal_percent')::numeric < cfg.signal_warning,at_time,cfg.poor_seconds,cfg.cooldown_seconds,'Wi-Fi signal remains poor.');
    end loop;
    if probe_new then
      if p->>'status' is distinct from previous.probe->>'status' then
        insert into public.network_events(computer_id,observed_at,kind,message) values(target_computer,probe_time,case when previous.probe->>'status'='offline' and p->>'status' in ('online','degraded') then 'internet_restored' else 'internet_'||(p->>'status') end,'Connectivity probe status: '||(p->>'status')||' ('||(p->>'reason')||').');
      end if;
      if p->>'status'='offline' then
        insert into public.network_outages(computer_id,started_at,reason) values(target_computer,probe_time,p->>'reason') on conflict(computer_id) where ended_at is null do nothing;
      elsif p->>'status' in ('online','degraded') and ((p->>'successes')::integer>0 or p->>'latency_ms' is not null) then
        update public.network_outages set ended_at=probe_time where computer_id=target_computer and ended_at is null;
      end if;
      if p->>'status'='unknown' or (previous.probe is not null and probe_time-(previous.probe->>'tested_at')::timestamptz > make_interval(secs=>cfg.probe_seconds*3)) then
        update public.network_outages set observation_gap=true where computer_id=target_computer and (ended_at is null or ended_at=probe_time);
      end if;
      perform public.network_condition(target_computer,'network_internet_lost',case when p->>'status'='unknown' then null else p->>'status'='offline' end,probe_time,0,cfg.cooldown_seconds,'Internet connectivity lost.');
      perform public.network_condition(target_computer,'network_dns',not (p->>'dns_ok')::boolean,probe_time,0,cfg.cooldown_seconds,'DNS resolution failed.');
      perform public.network_condition(target_computer,'network_gateway',not (p->>'gateway_reachable')::boolean,probe_time,0,cfg.cooldown_seconds,'Gateway ICMP probe failed (ICMP may be filtered).');
      perform public.network_condition(target_computer,'network_latency',(p->>'latency_ms')::numeric>cfg.latency_warning,probe_time,0,cfg.cooldown_seconds,'Latency exceeds threshold.');
      perform public.network_condition(target_computer,'network_loss',(p->>'packet_loss_percent')::numeric>cfg.packet_loss_warning,probe_time,0,cfg.cooldown_seconds,'ICMP packet loss exceeds threshold.');
      perform public.network_condition(target_computer,'network_degraded',case when p->>'status'='unknown' then null else p->>'status'='degraded' end,probe_time,cfg.poor_seconds,cfg.cooldown_seconds,'Connectivity remains degraded.');
      perform public.network_condition(target_computer,'network_repeated',(select count(*)>=cfg.repeated_disconnects from public.network_outages where computer_id=target_computer and started_at between probe_time-interval '1 hour' and probe_time),probe_time,0,cfg.cooldown_seconds,'Repeated disconnections in the last hour.');
    end if;
    insert into public.network_state(computer_id,observed_at,connection_type,primary_adapter_id,adapters,probe,last_success_at)
      values(target_computer,at_time,s->>'connection_type',s->>'primary_adapter_id',clean_adapters,case when probe_new then p else previous.probe end,case when probe_new and ((p->>'successes')::integer>0 or p->>'latency_ms' is not null) then probe_time else previous.last_success_at end)
      on conflict(computer_id) do update set observed_at=excluded.observed_at,received_at=now(),connection_type=excluded.connection_type,primary_adapter_id=excluded.primary_adapter_id,adapters=excluded.adapters,probe=excluded.probe,last_success_at=excluded.last_success_at;
    insert into public.network_identifiers values(target_computer,identifiers) on conflict(computer_id) do update set adapters=excluded.adapters;
  end loop;
  for s in select value from jsonb_array_elements(batch->'speed_tests') loop
    insert into public.network_speed_tests values(target_computer,(s->>'test_id')::uuid,(s->>'tested_at')::timestamptz,s) on conflict do nothing;
  end loop;
  return jsonb_build_object('wifi_seconds',cfg.wifi_seconds,'probe_seconds',cfg.probe_seconds,'bandwidth_seconds',cfg.bandwidth_seconds,'speed_interval_hours',cfg.speed_interval_hours,'latency_warning',cfg.latency_warning,'packet_loss_warning',cfg.packet_loss_warning);
end $$;
revoke all on function public.ingest_network_batch(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.ingest_network_batch(uuid,jsonb) to service_role;

-- Server-side aggregation keeps chart payloads bounded; no invented values for empty buckets.
create function public.network_history(target_computer uuid default null, hours integer default 24, connection text default '', health text default '')
returns table(bucket timestamptz,signal numeric,receive_bps numeric,send_bps numeric,latency numeric,loss numeric,checks bigint,available bigint,failed bigint)
language sql stable security invoker set search_path='' as $$
  select date_bin(make_interval(secs=>case when hours<=1 then 30 when hours<=24 then 300 when hours<=168 then 3600 else 14400 end),s.observed_at,'2020-01-01'::timestamptz),
    avg(s.signal_percent),avg(s.receive_bps),avg(s.send_bps),avg(s.latency_ms),avg(s.packet_loss_percent),
    count(*) filter(where s.probe_status in ('online','offline','degraded')),
    count(*) filter(where s.probe_status='online' or s.probe_status='degraded' and (s.successes>0 or s.latency_ms is not null)),
    count(*) filter(where s.probe_status='offline')
  from public.network_samples s
  where (target_computer is null or s.computer_id=target_computer) and s.observed_at>=now()-make_interval(hours=>least(greatest(hours,1),720))
    and (connection='' or s.connection_type=connection) and (health='' or s.probe_status=health)
  group by 1 order by 1;
$$;
revoke all on function public.network_history(uuid,integer,text,text) from public,anon;
grant execute on function public.network_history(uuid,integer,text,text) to authenticated;

-- Extend the verified existing command allowlist and force dispatch through admin-api.
alter table public.commands drop constraint commands_command_type_check;
alter table public.commands add constraint commands_command_type_check check(command_type in ('GET_SYSTEM_INFO','GET_HARDWARE_INFO','GET_SOFTWARE','GET_PROCESSES','GET_SERVICES','GET_SYSTEM_STATUS','STOP_PROCESS','START_SERVICE','STOP_SERVICE','RESTART_SERVICE','RESTART_PC','SHUTDOWN_PC','GET_NETWORK_STATUS','RUN_NETWORK_SPEED_TEST'));
drop policy commands_create on public.commands;
create policy commands_create on public.commands for insert to authenticated with check(command_type not in ('STOP_PROCESS','GET_NETWORK_STATUS','RUN_NETWORK_SPEED_TEST') and public.can_manage_computer(computer_id) and created_by=auth.uid());
create function public.queue_network_command(target_computer uuid,actor uuid,kind text,request_key uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare command_id uuid; existing public.commands;
begin
  if kind not in ('GET_NETWORK_STATUS','RUN_NETWORK_SPEED_TEST') or not exists(select 1 from public.profiles where id=actor and role='administrator' and status='active') then raise exception 'Unauthorized'; end if;
  perform 1 from public.computers where id=target_computer and enrollment_status='active' and last_seen>now()-interval '3 minutes' for update;
  if not found or not exists(select 1 from public.network_state where computer_id=target_computer and received_at>now()-interval '3 minutes') then raise exception 'Updated reporting agent required'; end if;
  select * into existing from public.commands where created_by=actor and idempotency_key=request_key;
  if found then
    if existing.computer_id<>target_computer or existing.command_type<>kind then raise exception 'Idempotency conflict'; end if;
    return existing.id;
  end if;
  if exists(select 1 from public.commands where computer_id=target_computer and command_type=kind and status in ('pending','received','processing') and expires_at>now()) then raise exception 'Command pending'; end if;
  if kind='RUN_NETWORK_SPEED_TEST' and (exists(select 1 from public.network_speed_tests where computer_id=target_computer and tested_at>now()-interval '15 minutes') or exists(select 1 from public.commands where computer_id=target_computer and command_type=kind and created_at>now()-interval '15 minutes')) then raise exception 'Speed-test cooldown'; end if;
  insert into public.commands(computer_id,command_type,created_by,idempotency_key) values(target_computer,kind,actor,request_key) returning id into command_id;
  return command_id;
end $$;
revoke all on function public.queue_network_command(uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.queue_network_command(uuid,uuid,text,uuid) to service_role;

create table public.network_maintenance(id boolean primary key default true check(id),last_pruned_at timestamptz);
insert into public.network_maintenance(id) values(true);
alter table public.network_maintenance enable row level security;
revoke all on public.network_maintenance from public,anon,authenticated;
create function public.prune_network_history() returns void language plpgsql security definer set search_path='' as $$
declare cutoff timestamptz;
begin
  perform 1 from public.network_maintenance where id and (last_pruned_at is null or last_pruned_at<now()-interval '1 hour') for update skip locked;
  if not found then return; end if;
  select now()-make_interval(days=>retention_days) into cutoff from public.network_settings where id;
  delete from public.network_samples where observed_at<cutoff;
  delete from public.network_events where observed_at<cutoff;
  delete from public.network_outages where ended_at<cutoff;
  delete from public.network_speed_tests where tested_at<cutoff;
  update public.network_maintenance set last_pruned_at=now() where id;
end $$;
revoke all on function public.prune_network_history() from public,anon,authenticated;
grant execute on function public.prune_network_history() to service_role;
