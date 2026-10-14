-- Mark process rows that own a visible application window on an active user's desktop.
alter table public.processes
  add column is_taskbar_app boolean not null default false;
