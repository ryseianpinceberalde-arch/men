-- Keep the new lifecycle status in its own migration so it is committed
-- before later migrations reference the enum value in triggers and policies.
alter type public.command_status add value if not exists 'awaiting_confirmation';
