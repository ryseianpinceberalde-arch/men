-- Keep inventory and detail views eligible for targeted Realtime updates.
do $$
declare table_name text;
begin
  foreach table_name in array array['computer_specs', 'installed_software', 'processes', 'services', 'problems', 'activity_logs', 'computer_assignments'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = table_name
    ) then
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    end if;
  end loop;
end;
$$;
