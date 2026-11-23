create table public.host_installations (
    id uuid primary key default gen_random_uuid(),
    device_id uuid not null references public.host_devices(id) on delete cascade,
    credential_hash text unique not null check (credential_hash ~ '^[a-f0-9]{64}$'),
    expires_at timestamptz not null,
    last_seen timestamptz,
    online boolean not null default false,
    capabilities jsonb,
    limits jsonb,
    revoked_at timestamptz
);
create unique index one_installation_per_device on public.host_installations(device_id)
    where revoked_at is null;
alter table public.host_installations enable row level security;
revoke all on public.host_installations from public, anon, authenticated;

create function public.approve_host(p_device uuid, p_hash text, p_expires bigint)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
    if to_timestamp(p_expires) <= now() or to_timestamp(p_expires) > now() + interval '11 minutes'
        or p_hash !~ '^[a-f0-9]{64}$' then return false; end if;
    perform 1 from public.host_devices where id=p_device and owner_id=auth.uid() for update;
    if not found then return false; end if;
    update public.host_installations set revoked_at=now() where device_id=p_device
        and revoked_at is null and last_seen is null and expires_at <= now();
    insert into public.host_installations(device_id,credential_hash,expires_at)
        values(p_device,p_hash,to_timestamp(p_expires)) on conflict do nothing;
    return exists(select 1 from public.host_installations where device_id=p_device
        and credential_hash=p_hash and revoked_at is null);
end $$;

create function public.revoke_host(p_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
    update public.host_installations i set revoked_at=now(), online=false
    from public.host_devices d where i.id=p_id and i.device_id=d.id and d.owner_id=auth.uid()
        and i.revoked_at is null;
    return found;
end $$;

create function public.host_status()
returns table(id uuid, device_id uuid, state text, last_seen timestamptz, capabilities jsonb, limits jsonb)
language sql stable security definer set search_path = '' as $$
    select i.id,i.device_id,case when i.last_seen is null then 'pending'
        when i.last_seen < now()-interval '60 seconds' then 'offline'
        when i.online then 'online' else 'paused' end,
        i.last_seen,i.capabilities,i.limits
    from public.host_installations i join public.host_devices d on d.id=i.device_id
    where d.owner_id=auth.uid() and i.revoked_at is null
        and (i.last_seen is not null or i.expires_at > now())
$$;

create function public.host_pulse(p_secret text, p_online boolean, p_caps jsonb, p_limits jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare
    linked uuid;
begin
    if p_secret !~ '^[0-9]{10}\.[0-9a-f]{64}$' or octet_length(p_caps::text) > 2048 or octet_length(p_limits::text) > 256
        then return null; end if;
    if not coalesce(
        p_caps @? 'strict $ ? (@.os.type() == "string" && @.arch.type() == "string" && @.engine_arch.type() == "string" && @.agent_version.type() == "string" && @.checksum_verified.type() == "boolean" && (@.runtime == "ready" || @.runtime == "unavailable") && @.cpus.type() == "number" && @.memory_mib.type() == "number" && @.disk_mib.type() == "number")'
        and p_limits @? 'strict $ ? (@.cpus.type() == "number" && @.cpus >= 1 && @.memory_mib.type() == "number" && @.memory_mib >= 256)'
        and (not p_online or (p_caps->>'runtime' = 'ready' and p_caps->'checksum_verified' = 'true'::jsonb
            and p_limits->'cpus' <= p_caps->'cpus' and p_limits->'memory_mib' <= p_caps->'memory_mib')), false)
        then return null; end if;
    update public.host_installations set last_seen=now(), online=p_online, capabilities=p_caps, limits=p_limits
    where credential_hash=encode(sha256(convert_to(p_secret,'UTF8')),'hex') and revoked_at is null
        and (last_seen is not null or expires_at > now())
        and (last_seen is not null or split_part(p_secret,'.',1)=extract(epoch from expires_at)::bigint::text)
    returning device_id into linked;
    return (select name from public.host_devices where id=linked);
end $$;

revoke all on function public.approve_host(uuid,text,bigint), public.revoke_host(uuid), public.host_status(),
    public.host_pulse(text,boolean,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.approve_host(uuid,text,bigint), public.revoke_host(uuid), public.host_status() to authenticated;
grant execute on function public.host_pulse(text,boolean,jsonb,jsonb) to anon;
