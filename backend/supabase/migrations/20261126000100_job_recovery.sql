create function public.recover_device_job(p_secret text,p_action text,p_id uuid,p_attempt uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    host public.host_installations;
    automatic boolean;
    state text;
    uploaded boolean;
begin
    select * into host from public.host_installations where revoked_at is null and last_seen is not null
        and credential_hash=encode(sha256(convert_to(p_secret,'UTF8')),'hex') for update;
    if not found then return null; end if;

    if p_action in ('queue','auto_accept') then
        select coalesce(specs->>'acceptance'='automatic',false) into automatic
        from public.host_devices where id=host.device_id for share;
        if p_action='queue' then
            return jsonb_build_object('automatic',automatic,'offers',
                public.device_job(p_secret,'offers',null,null,''));
        end if;
        if automatic is not true or not exists (
            select 1 from public.job_specs s where s.id=p_id and s.device_id=host.device_id
            and host.capabilities->>'runtime'='ready' and host.capabilities->'checksum_verified'='true'::jsonb
            and s.cpus <= (host.capabilities->>'cpus')::numeric
            and s.memory_mib <= (host.capabilities->>'memory_mib')::numeric
        ) then return null; end if;
        return public.device_job(p_secret,'accept',p_id,p_attempt,'');
    end if;

    if p_action='begin' then
        if public.device_job(p_secret,'running',p_id,p_attempt,'') is distinct from 'true'::jsonb then
            return null;
        end if;
        update public.job_specs s set deadline=j.started_at+make_interval(secs=>s.seconds)+interval '24 hours'
        from public.compute_jobs j where s.id=p_id and j.id=s.id and s.attempt=p_attempt and s.installation=host.id;
        return 'true';
    end if;

    if p_action <> 'reconcile' then return null; end if;
    perform public.expire_job_claims(null,host.device_id);
    select j.status into state from public.job_specs s join public.compute_jobs j using(id)
    where s.id=p_id and s.installation=host.id and s.attempt=p_attempt and s.device_id=host.device_id;
    if not found then return null; end if;
    select exists(select 1 from storage.objects where bucket_id='grove-pilot-results'
        and name=p_id::text || '/' || p_attempt::text || '/result.zip'
        and (metadata->>'size')::bigint between 1 and 52428800) into uploaded;
    return jsonb_build_object('status',state,'uploaded',uploaded);
end $$;
revoke all on function public.recover_device_job(text,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.recover_device_job(text,text,uuid,uuid) to service_role;
