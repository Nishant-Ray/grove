create table public.host_devices (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
    name text not null check (length(trim(name)) between 1 and 100),
    hardware text not null check (length(trim(hardware)) between 1 and 100),
    availability text not null default 'paused' check (availability in ('available', 'paused')),
    created_at timestamptz not null default now()
);
create index host_devices_owner_idx on public.host_devices(owner_id);
alter table public.host_devices enable row level security;
revoke all on public.host_devices from public, anon, authenticated;
grant select, delete on public.host_devices to authenticated;
grant insert (name, hardware, availability), update (name, hardware, availability)
    on public.host_devices to authenticated;
create policy manage_own_devices on public.host_devices for all to authenticated
    using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
