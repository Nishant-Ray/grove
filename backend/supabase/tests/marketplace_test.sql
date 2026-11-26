-- Run with: supabase start && supabase test db   (from backend/)
-- now() is fixed within a transaction, so elapsed time and deadlines are simulated by
-- moving timestamps.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- Fixtures -------------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
    ('00000000-0000-0000-0000-0000000000a1', 'host@test.invalid',   '{"display_name":"Hana Host"}'),
    ('00000000-0000-0000-0000-0000000000a3', 'host2@test.invalid',  '{}'),
    ('00000000-0000-0000-0000-0000000000b2', 'renter@test.invalid', '{"display_name":"Rae"}'),
    ('00000000-0000-0000-0000-0000000000b4', 'other@test.invalid',  '{}');
-- Test renters start with $1,000 of credits (bookings reserve from the balance).
insert into public.wallets (user_id, balance_micros) select id, 1000000000 from auth.users where email like '%@test.invalid'
    on conflict (user_id) do update set balance_micros = excluded.balance_micros;
insert into public.host_devices (id, owner_id, name, hardware, availability, gpu_model, zip, last_seen_at, specs) values
    ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'NY 4090', 'x', 'available', 'rtx-4090', '14850', now(), '{"acceptance":"automatic"}'),
    ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a1', 'SF 3060', 'x', 'available', 'rtx-3060', '94103', now(), '{"acceptance":"manual"}'),
    ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000a1', 'Stale',   'x', 'available', 'rtx-4090', '14850', now() - interval '1 hour', null),
    ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000a1', 'Paused',  'x', 'paused',    'rtx-4090', '14850', now(), null),
    ('00000000-0000-0000-0000-0000000000d5', '00000000-0000-0000-0000-0000000000a3', '4060',    'x', 'available', 'rtx-4060', null,    now(), '{"vram_gb":8}');

-- Isolate from any data already in the database (rolled back at the end).
update public.host_devices set availability = 'paused' where owner_id not in
    ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a3');

create temp table ids (name text primary key, id uuid);
grant all on ids to authenticated;

-- Permissions: users can never call these with their own JWT --------------------------------
select ok(not has_function_privilege('authenticated', 'public.create_job(uuid,uuid,text,text,numeric,int,text,numeric,numeric,bigint)', 'execute'), 'users cannot call create_job directly');
select ok(not has_function_privilege('authenticated', 'public.job_action(uuid,uuid,text,text)', 'execute'), 'users cannot call job_action directly');
select ok(not has_function_privilege('authenticated', 'public.recommend_hosts(uuid,text,int,text,text)', 'execute'), 'users cannot call recommend_hosts directly');
select ok(not has_function_privilege('authenticated', 'public.device_heartbeat(uuid)', 'execute'), 'users cannot fake heartbeats');
select ok(not has_function_privilege('anon', 'public.expire_jobs()', 'execute'), 'anon cannot expire jobs');
select ok(has_function_privilege('service_role', 'public.create_job(uuid,uuid,text,text,numeric,int,text,numeric,numeric,bigint)', 'execute'), 'API (service role) can book');
select is((select count(*)::int from cron.job where jobname = 'grove-expire-jobs'), 1, 'expiry job is scheduled');

-- Recommendations ------------------------------------------------------------------------
select set_eq($$ select device_name from public.recommend_hosts('00000000-0000-0000-0000-0000000000b2', 'standard', 0, null, '14850') $$,
              array['NY 4090', 'SF 3060', '4060'], 'only available, recently seen devices are candidates');
select set_eq($$ select device_name from public.recommend_hosts('00000000-0000-0000-0000-0000000000b2', 'standard', 16, null, null) $$,
              array['NY 4090'], 'VRAM filter');
select set_eq($$ select device_name from public.recommend_hosts('00000000-0000-0000-0000-0000000000b2', 'standard', 0, 'rtx-3060', null) $$,
              array['SF 3060'], 'GPU model filter');
select set_eq($$ select device_name from public.recommend_hosts('00000000-0000-0000-0000-0000000000a1', 'standard', 0, null, null) $$,
              array['4060'], 'hosts never see their own devices');
select is((select distance_miles from public.recommend_hosts('00000000-0000-0000-0000-0000000000b2', 'standard', 0, null, '14850') where device_name = 'NY 4090'),
          0.0, 'same ZIP3 is 0 miles');
select ok((select distance_miles between 2200 and 2500 from public.recommend_hosts('00000000-0000-0000-0000-0000000000b2', 'standard', 0, null, '14850') where device_name = 'SF 3060'),
          'Ithaca to San Francisco is about 2,300 miles');
select is((select distance_miles from public.recommend_hosts('00000000-0000-0000-0000-0000000000b2', 'standard', 0, null, '14850') where device_name = '4060'),
          null, 'unknown host location has no distance');
select is((select host_name from public.recommend_hosts('00000000-0000-0000-0000-0000000000b2', 'standard', 0, null, null) where device_name = '4060'),
          'Grove host', 'hosts without a display name get a neutral label');
select is((select vram_gb from public.recommend_hosts('00000000-0000-0000-0000-0000000000b2', 'standard', 0, null, null) where device_name = '4060'),
          8, 'host-entered VRAM overrides the GPU default');
select throws_ok($$ select * from public.recommend_hosts('00000000-0000-0000-0000-0000000000b2', 'turbo', 0, null, null) $$,
                 'P0001', 'UNKNOWN_PRIORITY', 'unknown priority is rejected');

-- Booking ----------------------------------------------------------------------------------
insert into ids select 'auto', id from public.create_job('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000d1',
    'Train', 'standard', 2, 16, 'https://example.com/x', 0.3549, 0.2839, 887250);
select results_eq($$ select status, host_id, accepted_at is not null, start_by = now() + interval '30 minutes'
                     from public.compute_jobs where id = (select id from ids where name = 'auto') $$,
                  $$ values ('scheduled'::text, '00000000-0000-0000-0000-0000000000a1'::uuid, true, true) $$,
                  'auto-accept devices schedule immediately with a 30-minute start deadline');
select ok(not exists (select 1 from public.recommend_hosts('00000000-0000-0000-0000-0000000000b4', 'standard', 0, null, null) where device_name = 'NY 4090'),
          'booked devices drop out of recommendations');
select throws_ok($$ select public.create_job('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-0000000000d1', 'Mine', 'standard', 1, 0, '', 0.3549, 0.2839, 1) $$,
                 'P0001', 'DEVICE_BUSY', 'a second booking on a busy device fails');
select throws_ok($$ select public.create_job('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d2', 'Self', 'standard', 1, 0, '', 0.1, 0.08, 1) $$,
                 'P0001', 'OWN_DEVICE', 'hosts cannot book their own device');
select throws_ok($$ select public.create_job('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000d3', 'Stale', 'standard', 1, 0, '', 0.1, 0.08, 1) $$,
                 'P0001', 'DEVICE_UNAVAILABLE', 'stale heartbeat blocks booking');
select throws_ok($$ select public.create_job('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000d4', 'Paused', 'standard', 1, 0, '', 0.1, 0.08, 1) $$,
                 'P0001', 'DEVICE_UNAVAILABLE', 'paused devices cannot be booked');
select throws_ok($$ select public.create_job('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000d5', 'Big', 'standard', 1, 16, '', 0.1, 0.08, 1) $$,
                 'P0001', 'NOT_ENOUGH_VRAM', 'VRAM is enforced at booking');
select throws_ok($$ select public.create_job('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000d5', 'Bad', 'standard', 1, 0, 'javascript:alert(1)', 0.1, 0.08, 1) $$,
                 '23514', null, 'non-http code links are rejected by the database');

insert into ids select 'manual', id from public.create_job('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000d2',
    'Notebook', 'batch', 1, 0, '', 0.08, 0.064, 100000);
select is((select status from public.compute_jobs where id = (select id from ids where name = 'manual')), 'requested',
          'manual-acceptance devices wait for the host');

-- Lifecycle permissions ------------------------------------------------------------------
select throws_ok($$ select public.job_action('00000000-0000-0000-0000-0000000000b2', (select id from ids where name = 'manual'), 'accept') $$,
                 'P0001', 'NOT_ALLOWED', 'renters cannot accept their own request');
select throws_ok($$ select public.job_action('00000000-0000-0000-0000-0000000000b4', (select id from ids where name = 'manual'), 'cancel') $$,
                 'P0001', 'JOB_NOT_FOUND', 'strangers cannot see or act on a job');
select throws_ok($$ select public.job_action('00000000-0000-0000-0000-0000000000a1', (select id from ids where name = 'manual'), 'complete') $$,
                 'P0001', 'INVALID_TRANSITION', 'cannot complete a job that never started');
select throws_ok($$ select public.job_action('00000000-0000-0000-0000-0000000000a1', (select id from ids where name = 'manual'), 'explode') $$,
                 'P0001', 'INVALID_ACTION', 'unknown actions are rejected');
select is((public.job_action('00000000-0000-0000-0000-0000000000a1', (select id from ids where name = 'manual'), 'accept')).status,
          'scheduled', 'host accepts');
select is((select start_by from public.compute_jobs where id = (select id from ids where name = 'manual')),
          now() + interval '24 hours', 'accepted Batch jobs may start within 24 hours');

-- Billing: per-second, capped at the reserve, never charged for host-side failure ----------------
select is((public.job_action('00000000-0000-0000-0000-0000000000a1', (select id from ids where name = 'auto'), 'start')).status,
          'running', 'host starts');
select throws_ok($$ select public.job_action('00000000-0000-0000-0000-0000000000a1', (select id from ids where name = 'auto'), 'stop') $$,
                 'P0001', 'NOT_ALLOWED', 'only the renter can stop a job');
update public.compute_jobs set started_at = now() - interval '90 seconds' where id = (select id from ids where name = 'auto');
select results_eq($$ select status, outcome_reason, charged_micros, progress, result_summary
                     from public.job_action('00000000-0000-0000-0000-0000000000a1', (select id from ids where name = 'auto'), 'complete', 'all good') $$,
                  $$ values ('completed'::text, 'completed'::text, 8873::bigint, 100::smallint, 'all good'::text) $$,
                  '90 s at $0.3549/hr bills 8,873 micro-dollars (matches app.pricing)');
select throws_ok($$ select public.job_action('00000000-0000-0000-0000-0000000000a1', (select id from ids where name = 'auto'), 'complete') $$,
                 'P0001', 'INVALID_TRANSITION', 'a finished job cannot be finished again');
select ok(exists (select 1 from public.recommend_hosts('00000000-0000-0000-0000-0000000000b4', 'standard', 0, null, null) where device_name = 'NY 4090'),
          'finished jobs free the device');

select public.job_action('00000000-0000-0000-0000-0000000000a1', (select id from ids where name = 'manual'), 'start');
update public.compute_jobs set started_at = now() - interval '2 hours' where id = (select id from ids where name = 'manual');
select results_eq($$ select status, outcome_reason, charged_micros from public.job_action('00000000-0000-0000-0000-0000000000a1', (select id from ids where name = 'manual'), 'fail_host') $$,
                  $$ values ('failed'::text, 'host_side'::text, 0::bigint) $$, 'host-side failures are free for the renter');

insert into ids select 'capped', id from public.create_job('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000d1',
    'Long', 'standard', 1, 0, '', 0.3549, 0.2839, 1000);
select public.job_action('00000000-0000-0000-0000-0000000000a1', (select id from ids where name = 'capped'), 'start');
update public.compute_jobs set started_at = now() - interval '1 day' where id = (select id from ids where name = 'capped');
select results_eq($$ select status, outcome_reason, charged_micros from public.job_action('00000000-0000-0000-0000-0000000000b2', (select id from ids where name = 'capped'), 'stop') $$,
                  $$ values ('completed'::text, 'renter_stopped'::text, 1000::bigint) $$, 'renter stop bills elapsed time capped at the reserve');

insert into ids select 'err', id from public.create_job('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000d1',
    'Buggy', 'standard', 1, 0, '', 0.3600, 0.2880, 1000000);
select public.job_action('00000000-0000-0000-0000-0000000000a1', (select id from ids where name = 'err'), 'start');
update public.compute_jobs set started_at = now() - interval '10 minutes' where id = (select id from ids where name = 'err');
select results_eq($$ select status, outcome_reason, charged_micros from public.job_action('00000000-0000-0000-0000-0000000000a1', (select id from ids where name = 'err'), 'fail_job') $$,
                  $$ values ('failed'::text, 'job_error'::text, 60000::bigint) $$, 'job errors bill elapsed time');

-- Cancel, decline and expiry -------------------------------------------------------------------
insert into ids select 'decline', id from public.create_job('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000d2',
    'Maybe', 'standard', 1, 0, '', 0.104, 0.0832, 1);
select results_eq($$ select status, outcome_reason, charged_micros from public.job_action('00000000-0000-0000-0000-0000000000a1', (select id from ids where name = 'decline'), 'decline') $$,
                  $$ values ('declined'::text, 'declined'::text, 0::bigint) $$, 'host declines');

insert into ids select 'hostcancel', id from public.create_job('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000d1',
    'Cancel me', 'standard', 1, 0, '', 0.3549, 0.2839, 1);
select is((public.job_action('00000000-0000-0000-0000-0000000000a1', (select id from ids where name = 'hostcancel'), 'cancel')).outcome_reason,
          'host_cancelled', 'host cancellations are recorded for reliability');

insert into ids select 'expire_req', id from public.create_job('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000d2',
    'Ignored', 'standard', 1, 0, '', 0.104, 0.0832, 1);
insert into ids select 'expire_sched', id from public.create_job('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000d1',
    'No show', 'standard', 1, 0, '', 0.3549, 0.2839, 1);
update public.compute_jobs set start_by = now() - interval '1 minute'
    where id in (select id from ids where name in ('expire_req', 'expire_sched'));
select is(public.expire_jobs(), 2, 'expire_jobs cancels overdue requests and no-shows');
select set_eq($$ select outcome_reason from public.compute_jobs where id in (select id from ids where name in ('expire_req', 'expire_sched')) $$,
              array['not_accepted', 'no_show'], 'expired jobs record why');
select is(public.expire_jobs(), 0, 'expiry is idempotent');

select is(public.device_heartbeat('00000000-0000-0000-0000-0000000000a1'), 4, 'heartbeat marks all of the host''s devices');

-- Row-level security on the dashboard ------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
select is((select count(*)::int from public.compute_jobs where host_id = '00000000-0000-0000-0000-0000000000a1'), 8,
          'hosts can read jobs on their devices');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}', true);
select is((select count(*)::int from public.compute_jobs), 0, 'other users see none of these jobs');
select throws_ok($$ update public.compute_jobs set status = 'completed' $$, '42501', null,
                 'users cannot update jobs directly');

select * from finish();
rollback;
