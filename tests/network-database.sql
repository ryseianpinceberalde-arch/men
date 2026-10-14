-- Run only against the disposable database created by test-network-database.ps1.
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('00000000-0000-0000-0000-000000000001','admin@test.invalid','{}'),
 ('00000000-0000-0000-0000-000000000002','tech@test.invalid','{}'),
 ('00000000-0000-0000-0000-000000000003','viewer@test.invalid','{}');
update public.profiles set role='administrator' where id='00000000-0000-0000-0000-000000000001';
update public.profiles set role='technician' where id='00000000-0000-0000-0000-000000000002';
insert into public.computers(id,device_id,computer_name,enrollment_status,last_seen) values
 ('10000000-0000-0000-0000-000000000001','network-test-1','Fixture computer','active',now()),
 ('10000000-0000-0000-0000-000000000002','network-test-2','Other fixture computer','active',now());
insert into public.computer_assignments(computer_id,technician_id) values('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002');

create function pg_temp.sample(sid uuid,at_time timestamptz,health text,signal integer default 90,ssid text default 'Fixture SSID') returns jsonb language sql as $$
select jsonb_build_object('sample_id',sid,'observed_at',at_time,'connection_type','wifi','primary_adapter_id','fixture-adapter',
 'adapters',jsonb_build_array(jsonb_build_object('id','fixture-adapter','name','Fixture wireless','type','wifi','status','Up','mac_address','AA:BB:CC:DD:EE:FF','receive_bytes_per_second',123,'send_bytes_per_second',45,
 'wifi',jsonb_build_object('status',case when health='offline' then 'disconnected' else 'connected' end,'signal_percent',signal,'ssid',ssid,'bssid','11:22:33:44:55:66'))),
 'probe',jsonb_build_object('tested_at',at_time,'status',health,'reason',case when health='offline' then 'internet_probe_failure' else 'ok' end,'successes',case when health='offline' then 0 else 2 end,'attempts',2,'dns_ok',true,'gateway_reachable',true,'latency_ms',case when health='offline' then null else 20 end,'packet_loss_percent',case when health='offline' then null else 0 end));
$$;
create function pg_temp.check(ok boolean,label text) returns void language plpgsql as $$ begin if ok is distinct from true then raise exception 'FAILED: %',label; end if; raise notice 'PASS: %',label; end $$;
select public.ingest_network_batch('10000000-0000-0000-0000-000000000001', jsonb_build_object('samples',jsonb_build_array(
 pg_temp.sample('20000000-0000-0000-0000-000000000001',now()-interval '8 minutes','online'),
 pg_temp.sample('20000000-0000-0000-0000-000000000002',now()-interval '7 minutes','offline',10),
 pg_temp.sample('20000000-0000-0000-0000-000000000003',now()-interval '6 minutes','offline',10),
 pg_temp.sample('20000000-0000-0000-0000-000000000004',now()-interval '5 minutes','online',90,'Second fixture SSID')),'speed_tests','[]'::jsonb));
select pg_temp.check((select count(*)=4 from public.network_samples),'all recorded probes retained');
select pg_temp.check((select count(*)=1 from public.network_outages where ended_at-started_at=interval '2 minutes'),'outage starts and ends at observed times');
select pg_temp.check((select count(*)=1 from public.alerts where alert_type='network_internet_lost' and status='Resolved'),'loss alert deduplicated and recovered');
select pg_temp.check((select count(*)>0 from public.network_events where kind='recovery'),'recovery event generated');
select pg_temp.check((select adapters::text not like '%AA:BB%' and adapters::text not like '%11:22%' from public.network_state),'MAC/BSSID excluded from shared state');
select pg_temp.check((select adapters::text like '%AA:BB%' from public.network_identifiers),'identifiers retained separately');
select pg_temp.check((select sum(checks)=4 and sum(available)=2 and sum(failed)=2 from public.network_history(null,1)),'history totals count actual observations');
select public.ingest_network_batch('10000000-0000-0000-0000-000000000001',jsonb_build_object('samples',jsonb_build_array(pg_temp.sample('20000000-0000-0000-0000-000000000004',now()-interval '5 minutes','online',90,'Second fixture SSID')),'speed_tests','[]'::jsonb));
select pg_temp.check((select count(*)=4 from public.network_samples),'retry is idempotent');
select public.ingest_network_batch('10000000-0000-0000-0000-000000000001',jsonb_build_object('samples',jsonb_build_array(pg_temp.sample(gen_random_uuid(),now()-interval '9 minutes','offline')),'speed_tests','[]'::jsonb));
select pg_temp.check((select probe->>'status'='online' from public.network_state),'late observation cannot regress latest state');
select public.ingest_network_batch('10000000-0000-0000-0000-000000000002',jsonb_build_object('samples',jsonb_build_array(pg_temp.sample(gen_random_uuid(),now(),'online')),'speed_tests','[]'::jsonb));

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
select pg_temp.check((select count(*)=1 from public.network_state),'technician sees only assigned device');
select pg_temp.check((select count(*)=0 from public.network_identifiers),'technician cannot read MAC/BSSID');
select pg_temp.check(not has_function_privilege(current_user,'public.ingest_network_batch(uuid,jsonb)','EXECUTE'),'browser cannot ingest');
select pg_temp.check(not has_function_privilege(current_user,'public.queue_network_command(uuid,uuid,text,uuid)','EXECUTE'),'browser cannot bypass admin dispatch');
select pg_temp.check(not has_table_privilege(current_user,'public.network_samples','INSERT'),'browser cannot invent telemetry');
select pg_temp.check((select sum(checks)=5 from public.network_history(null,1)),'aggregate respects assigned-device RLS');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',true);
select pg_temp.check((select count(*)=0 from public.network_state),'viewer cannot read network telemetry');
select pg_temp.check((select count(*)=0 from public.network_settings),'viewer cannot read network settings');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
select pg_temp.check((select count(*)=2 from public.network_state),'administrator can see fleet');
select pg_temp.check((select count(*)=2 from public.network_identifiers),'administrator can read identifiers');
reset role;

select pg_temp.check(public.queue_network_command('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','RUN_NETWORK_SPEED_TEST','30000000-0000-0000-0000-000000000001') is not null,'admin speed command queues');
select pg_temp.check(public.queue_network_command('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','RUN_NETWORK_SPEED_TEST','30000000-0000-0000-0000-000000000001') is not null,'command retry reuses request');
do $$ begin
  begin
    perform public.queue_network_command('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','GET_NETWORK_STATUS',gen_random_uuid());
    raise exception 'Test expected administrator rejection';
  exception when raise_exception then if sqlerrm<>'Unauthorized' then raise; end if; end;
  begin
    perform public.queue_network_command('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','RUN_NETWORK_SPEED_TEST',gen_random_uuid());
    raise exception 'Test expected duplicate rejection';
  exception when raise_exception then if sqlerrm<>'Command pending' then raise; end if; end;
end $$;
-- Retention removes only expired network history.
select public.network_condition('10000000-0000-0000-0000-000000000001','network_test_unknown',true,now()-interval '3 minutes',120,900,'Fixture sustained condition');
select public.network_condition('10000000-0000-0000-0000-000000000001','network_test_unknown',null,now()-interval '1 minute',120,900,'Fixture sustained condition');
select public.network_condition('10000000-0000-0000-0000-000000000001','network_test_unknown',true,now(),120,900,'Fixture sustained condition');
select pg_temp.check(not exists(select 1 from public.alerts where alert_type='network_test_unknown'),'unknown samples break sustained degradation continuity');
insert into public.network_samples(computer_id,sample_id,observed_at,connection_type) values('10000000-0000-0000-0000-000000000001',gen_random_uuid(),now()-interval '31 days','unknown');
select public.prune_network_history();
select pg_temp.check(not exists(select 1 from public.network_samples where observed_at<now()-interval '30 days'),'retention removes expired measurements');
select pg_temp.check((select count(*)=2 from public.computers),'retention preserves computers');
rollback;
