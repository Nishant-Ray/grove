alter table public.host_devices add column specs jsonb
    check (specs is null or jsonb_typeof(specs) = 'object');
grant insert (specs), update (specs) on public.host_devices to authenticated;
