create table public.job_specs (
    id uuid primary key,
    owner_id uuid not null references auth.users on delete cascade,
    device_id uuid not null,
    name text not null,
    cpus integer not null check (cpus between 1 and 64),
    memory_mib integer not null check (memory_mib between 256 and 65536),
    seconds integer not null check (seconds between 1 and 900),
    files jsonb not null check (jsonb_array_length(files) between 1 and 9),
    created_at timestamptz not null default now(),
    installation uuid,
    attempt uuid,
    deadline timestamptz
);
create index job_specs_device_idx on public.job_specs(device_id);
create index job_specs_owner_idx on public.job_specs(owner_id);
alter table public.job_specs enable row level security;
revoke all on public.job_specs from public, anon, authenticated;

insert into storage.buckets(id,name,public,file_size_limit)
values ('grove-job-inputs','grove-job-inputs',false,16777216),
       ('grove-pilot-results','grove-pilot-results',false,52428800);

create function public.stage_job(p_id uuid,p_owner uuid,p_device uuid,p_name text,p_cpus int,
    p_memory int,p_seconds int,p_files jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
    if exists(select 1 from public.compute_jobs where id=p_id) then return false; end if;
    if not exists (select 1 from public.host_installations where device_id=p_device and revoked_at is null
        and online and last_seen >= now()-interval '60 seconds' and (limits->>'cpus')::numeric >= p_cpus
        and (limits->>'memory_mib')::numeric >= p_memory) then return false; end if;
    insert into public.job_specs(id,owner_id,device_id,name,cpus,memory_mib,seconds,files)
        values(p_id,p_owner,p_device,p_name,p_cpus,p_memory,p_seconds,p_files) on conflict do nothing;
    return exists(select 1 from public.job_specs where id=p_id and owner_id=p_owner and device_id=p_device
        and name=p_name and cpus=p_cpus and memory_mib=p_memory and seconds=p_seconds and files=p_files
        and created_at >= now()-interval '2 hours' and not exists(select 1 from public.compute_jobs where id=p_id));
end $$;

create function public.submit_job(p_id uuid,p_owner uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare s public.job_specs;
begin
    select * into s from public.job_specs where id=p_id and owner_id=p_owner for update;
    if not found then return false; end if;
    if exists(select 1 from public.compute_jobs where id=p_id) then return true; end if;
    if s.created_at < now()-interval '2 hours' or exists (
        select 1 from jsonb_array_elements(s.files) f where not exists (
            select 1 from storage.objects o where o.bucket_id='grove-job-inputs'
            and o.name=p_id::text || '/' || (f->>'name')
            and (o.metadata->>'size')::bigint=(f->>'size')::bigint)) then return false; end if;
    insert into public.compute_jobs(id,owner_id,name) values(s.id,s.owner_id,s.name);
    return true;
end $$;

create function public.expire_job_claims(p_owner uuid,p_device uuid) returns void
language sql security definer set search_path = '' as $$
    update public.compute_jobs j set status='failed',finished_at=now(),result_summary='The host claim expired.'
    from public.job_specs s where j.id=s.id and (s.owner_id=p_owner or s.device_id=p_device)
        and j.status in ('scheduled','running') and (s.deadline <= now() or not exists(
            select 1 from public.host_installations i where i.id=s.installation and i.revoked_at is null))
$$;
create function public.refresh_my_jobs() returns void language sql security definer set search_path = '' as $$
    select public.expire_job_claims(auth.uid(),null)
$$;

create function public.cancel_job_request(p_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
    update public.compute_jobs set status='cancelled',finished_at=now(),result_summary='Withdrawn by renter.'
    where id=p_id and owner_id=auth.uid() and status='requested';
    return found;
end $$;

create function public.device_job(p_secret text,p_action text,p_id uuid,p_attempt uuid,p_detail text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    h public.host_installations;
    s public.job_specs;
    current_status text;
    offer jsonb;
begin
    select * into h from public.host_installations where revoked_at is null and last_seen is not null
        and credential_hash=encode(sha256(convert_to(p_secret,'UTF8')),'hex') for update;
    if not found then return null; end if;
    perform public.expire_job_claims(null,h.device_id);
    if p_action='offers' then
        select jsonb_agg(to_jsonb(q)) into offer from (
            select s1.id,s1.name,s1.cpus,s1.memory_mib,s1.seconds,
                (select sum((f->>'size')::bigint) from jsonb_array_elements(s1.files) f) as bytes
            from public.job_specs s1 join public.compute_jobs j using(id)
            where s1.device_id=h.device_id and j.status='requested' and h.online
                and h.last_seen >= now()-interval '60 seconds'
                and s1.cpus <= (h.limits->>'cpus')::numeric
                and s1.memory_mib <= (h.limits->>'memory_mib')::numeric
            order by j.requested_at,j.id limit 10) q;
        return coalesce(offer,'[]');
    end if;
    select * into s from public.job_specs where id=p_id and device_id=h.device_id;
    if not found then return null; end if;
    select status into current_status from public.compute_jobs where id=p_id for update;
    if not found then return null; end if;
    if p_action in ('accept','decline') and current_status='requested' then
        if not h.online or h.last_seen < now()-interval '60 seconds' then return null; end if;
        if p_action='decline' then
            update public.compute_jobs set status='cancelled',finished_at=now(),result_summary='Declined by host.' where id=p_id;
            return 'true';
        end if;
        if p_attempt is null or s.cpus > (h.limits->>'cpus')::numeric or s.memory_mib > (h.limits->>'memory_mib')::numeric
            or exists(select 1 from public.job_specs other join public.compute_jobs j using(id)
                where other.device_id=h.device_id and j.status in ('scheduled','running')) then return null; end if;
        update public.job_specs set attempt=p_attempt,installation=h.id,
            deadline=now()+make_interval(secs=>s.seconds+300) where id=p_id;
        update public.compute_jobs set status='scheduled',scheduled_at=now(),result_summary='Preparing job inputs.' where id=p_id;
        return 'true';
    end if;
    if p_attempt is null or s.attempt is distinct from p_attempt or s.installation is distinct from h.id then return null; end if;
    if p_action='complete' and current_status='completed' then return 'true'; end if;
    if s.deadline <= now() or current_status not in ('scheduled','running') then return null; end if;
    case p_action
    when 'accept' then return 'true';
    when 'inputs' then
        return jsonb_build_object('files',s.files,'cpus',s.cpus,'memory_mib',s.memory_mib,'seconds',s.seconds);
    when 'running' then
        update public.compute_jobs set status='running',started_at=coalesce(started_at,now()),result_summary='Executing Python on the host.' where id=p_id;
    when 'upload' then
        if current_status <> 'running' then return null; end if;
        update public.compute_jobs set result_summary='Uploading the result archive.' where id=p_id;
    when 'complete' then
        if current_status <> 'running' or not exists(select 1 from storage.objects where bucket_id='grove-pilot-results'
            and name=p_id::text || '/' || p_attempt::text || '/result.zip' and (metadata->>'size')::bigint between 1 and 52428800)
            then return null; end if;
        update public.compute_jobs set status='completed',finished_at=now(),progress=100,
            result_summary='Output archive ready.',result_filename='result.zip' where id=p_id;
    when 'cancel' then
        update public.compute_jobs set status='cancelled',finished_at=now(),result_summary='Stopped by host.' where id=p_id;
    when 'fail' then
        update public.compute_jobs set status='failed',finished_at=now(),result_summary=left(p_detail,300) where id=p_id;
    else return null;
    end case;
    return 'true';
end $$;

create function public.pilot_result_path(p_id uuid) returns text language sql stable security definer set search_path = '' as $$
    select s.id::text || '/' || s.attempt::text || '/result.zip' from public.job_specs s
    join public.compute_jobs j using(id) where s.id=p_id and j.owner_id=auth.uid() and j.status='completed'
$$;

revoke all on function public.stage_job(uuid,uuid,uuid,text,int,int,int,jsonb),public.submit_job(uuid,uuid),
    public.expire_job_claims(uuid,uuid),public.device_job(text,text,uuid,uuid,text),
    public.pilot_result_path(uuid),public.refresh_my_jobs(),public.cancel_job_request(uuid) from public,anon,authenticated;
grant execute on function public.stage_job(uuid,uuid,uuid,text,int,int,int,jsonb),public.submit_job(uuid,uuid),
    public.device_job(text,text,uuid,uuid,text) to service_role;
grant execute on function public.pilot_result_path(uuid),public.refresh_my_jobs(),public.cancel_job_request(uuid) to authenticated;
