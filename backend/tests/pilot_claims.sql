begin;
do $$
declare
    renter uuid := gen_random_uuid();
    owner_id uuid := gen_random_uuid();
    device uuid := gen_random_uuid();
    other uuid := gen_random_uuid();
    job uuid := gen_random_uuid();
    next_job uuid := gen_random_uuid();
    attempt uuid := gen_random_uuid();
    secret text := gen_random_uuid()::text;
    other_secret text := gen_random_uuid()::text;
    files jsonb := '[{"name":"main.py","size":10}]';
begin
    insert into auth.users(id) values(renter),(owner_id);
    insert into public.host_devices(id,owner_id,name,hardware) values
        (device,owner_id,'First','CPU'),(other,owner_id,'Other','CPU');
    insert into public.host_installations(device_id,credential_hash,expires_at,last_seen,online,limits)
        values(device,encode(sha256(convert_to(secret,'UTF8')),'hex'),now(),now(),true,'{"cpus":2,"memory_mib":1024}'),
              (other,encode(sha256(convert_to(other_secret,'UTF8')),'hex'),now(),now(),true,'{"cpus":1,"memory_mib":512}');
    assert not has_function_privilege('authenticated','public.device_job(text,text,uuid,uuid,text)','execute');
    assert not has_function_privilege('anon','public.stage_job(uuid,uuid,uuid,text,int,int,int,jsonb)','execute');
    assert not public.stage_job(job,renter,device,'Test',3,256,20,files);
    assert public.stage_job(job,renter,device,'Test',1,256,20,files);
    assert not public.submit_job(job,renter);
    assert public.stage_job(next_job,renter,device,'Next',1,256,20,files);
    insert into public.compute_jobs(id,owner_id,name) values(job,renter,'Test'),(next_job,renter,'Next');
    assert public.device_job(other_secret,'offers',null,null,'') = '[]';
    assert public.device_job(other_secret,'accept',job,attempt,'') is null;
    assert public.recover_device_job(secret,'auto_accept',job,attempt) is null;
    update public.host_devices set specs='{"acceptance":"automatic"}' where id=device;
    assert public.recover_device_job(secret,'auto_accept',job,attempt) is null;
    update public.host_installations set capabilities='{"runtime":"ready","checksum_verified":true,"cpus":2,"memory_mib":1024}' where device_id=device;
    assert (public.recover_device_job(secret,'queue',null,null)->>'automatic')::boolean;
    assert public.recover_device_job(secret,'auto_accept',job,attempt) = 'true';
    assert public.recover_device_job(other_secret,'reconcile',job,attempt) is null;
    assert public.recover_device_job(secret,'reconcile',job,gen_random_uuid()) is null;
    assert public.recover_device_job(secret,'reconcile',job,attempt)->>'status'='scheduled';
    assert public.device_job(secret,'accept',job,attempt,'') = 'true';
    assert public.device_job(secret,'accept',job,gen_random_uuid(),'') is null;
    assert public.device_job(secret,'accept',next_job,gen_random_uuid(),'') is null;
    assert public.device_job(secret,'inputs',job,gen_random_uuid(),'') is null;
    assert public.device_job(secret,'upload',job,attempt,'') is null;
    assert public.recover_device_job(secret,'begin',job,attempt) = 'true';
    assert (select deadline >= now()+interval '24 hours' from public.job_specs where id=job);
    assert public.device_job(secret,'complete',job,attempt,'') is null;
    update public.job_specs set deadline=now()-interval '1 second' where id=job;
    assert public.device_job(secret,'upload',job,attempt,'') is null;
    assert public.recover_device_job(secret,'reconcile',job,attempt)->>'status'='failed';
    assert (select status='failed' from public.compute_jobs where id=job);
    update public.host_installations set online=false where device_id=device;
    assert public.device_job(secret,'accept',next_job,attempt,'') is null;
    update public.host_installations set online=true,last_seen=now() where device_id=device;
    assert public.device_job(secret,'decline',next_job,null,'') = 'true';
    assert (select status='cancelled' from public.compute_jobs where id=next_job);
    update public.host_installations set revoked_at=now() where device_id=device;
    assert public.device_job(secret,'offers',null,null,'') is null;
end $$;
rollback;
