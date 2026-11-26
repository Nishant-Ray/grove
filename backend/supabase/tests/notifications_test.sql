-- Run with: supabase start && supabase test db   (from backend/)
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users (id, email, raw_user_meta_data) values
    ('00000000-0000-0000-0000-0000000000a1', 'host@test.invalid',   '{"display_name":"Hana"}'),
    ('00000000-0000-0000-0000-0000000000b2', 'renter@test.invalid', '{"display_name":"Rae"}'),
    ('00000000-0000-0000-0000-0000000000b4', 'other@test.invalid',  '{}');
insert into public.host_devices (id, owner_id, name, hardware, availability, gpu_model, zip, last_seen_at, specs) values
    ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'Lab 4090', 'x', 'available', 'rtx-4090', '14850', now(), '{"acceptance":"automatic"}'),
    ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a1', 'Lab 4070', 'x', 'available', 'rtx-4070', '14850', now(), '{"acceptance":"manual"}');

-- Isolate from any data already in the database (rolled back at the end).
update public.compute_jobs set start_by = null where status in ('requested', 'scheduled');

create temp table ids (name text primary key, id uuid);
grant all on ids to authenticated;

-- notes(job) = the notifications for one job, as "who:kind" strings.
create function pg_temp.notes(p_job text) returns setof text language sql as $$
    select case n.user_id when '00000000-0000-0000-0000-0000000000a1' then 'host'
                          when '00000000-0000-0000-0000-0000000000b2' then 'renter' else 'other' end || ':' || n.kind
    from public.notifications n where n.job_id = (select id from ids where name = p_job)
$$;
create function pg_temp.book(p_name text, p_device text) returns void language sql as $$
    insert into ids select p_name, id from public.create_job('00000000-0000-0000-0000-0000000000b2', p_device::uuid,
        p_name, 'standard', 1, 0, '', 0.4511, 0.3609, 1000000);
$$;
create function pg_temp.act(p_job text, p_actor text, p_action text) returns void language sql as $$
    select public.job_action(p_actor::uuid, (select id from ids where name = p_job), p_action);
$$;

-- Auto-accept: booked -> started -> completed
select pg_temp.book('auto', '00000000-0000-0000-0000-0000000000d1');
select set_eq($$ select * from pg_temp.notes('auto') $$, array['host:job_booked', 'renter:job_accepted'],
              'auto-accept booking notifies the host (booked) and the renter (scheduled)');
select is((select body from public.notifications where kind = 'job_booked' and job_id = (select id from ids where name = 'auto')),
          'Rae booked "auto" on Lab 4090. Start it from your dashboard.', 'host message names the renter and device');
select pg_temp.act('auto', '00000000-0000-0000-0000-0000000000a1', 'start');
select pg_temp.act('auto', '00000000-0000-0000-0000-0000000000a1', 'complete');
select set_eq($$ select * from pg_temp.notes('auto') $$,
              array['host:job_booked', 'renter:job_accepted', 'renter:job_started', 'renter:job_completed'],
              'start and completion notify the renter');

-- Manual acceptance: request -> accept, and request -> decline
select pg_temp.book('manual', '00000000-0000-0000-0000-0000000000d2');
select set_eq($$ select * from pg_temp.notes('manual') $$, array['host:job_requested'], 'requests notify the host only');
select pg_temp.act('manual', '00000000-0000-0000-0000-0000000000a1', 'accept');
select set_eq($$ select * from pg_temp.notes('manual') $$, array['host:job_requested', 'renter:job_accepted'],
              'approval notifies the renter');
select pg_temp.act('manual', '00000000-0000-0000-0000-0000000000a1', 'start');
select pg_temp.act('manual', '00000000-0000-0000-0000-0000000000a1', 'fail_host');
select is((select body from public.notifications where kind = 'job_failed' and job_id = (select id from ids where name = 'manual')),
          '"manual" failed on the host''s side. You will not be charged.', 'host-side failure tells the renter they are not charged');

select pg_temp.book('declined', '00000000-0000-0000-0000-0000000000d2');
select pg_temp.act('declined', '00000000-0000-0000-0000-0000000000a1', 'decline');
select set_eq($$ select * from pg_temp.notes('declined') $$, array['host:job_requested', 'renter:job_declined'],
              'declines notify the renter');

-- Stops, errors and cancellations notify the other party
select pg_temp.book('stopped', '00000000-0000-0000-0000-0000000000d1');
select pg_temp.act('stopped', '00000000-0000-0000-0000-0000000000a1', 'start');
select pg_temp.act('stopped', '00000000-0000-0000-0000-0000000000b2', 'stop');
select ok('host:job_stopped' in (select * from pg_temp.notes('stopped')), 'renter stop notifies the host');
select ok('renter:job_completed' not in (select * from pg_temp.notes('stopped')), 'the renter is not told about their own stop');

select pg_temp.book('rcancel', '00000000-0000-0000-0000-0000000000d1');
select pg_temp.act('rcancel', '00000000-0000-0000-0000-0000000000b2', 'cancel');
select ok('host:job_cancelled' in (select * from pg_temp.notes('rcancel')), 'renter cancel notifies the host');

select pg_temp.book('hcancel', '00000000-0000-0000-0000-0000000000d1');
select pg_temp.act('hcancel', '00000000-0000-0000-0000-0000000000a1', 'cancel');
select ok('renter:job_cancelled' in (select * from pg_temp.notes('hcancel')), 'host cancel notifies the renter');

-- Upcoming reminders and expiry
select pg_temp.book('soon', '00000000-0000-0000-0000-0000000000d1');
update public.compute_jobs set start_by = now() + interval '10 minutes' where id = (select id from ids where name = 'soon');
select is(public.remind_upcoming_jobs(), 1, 'hosts are reminded before a start deadline');
select is((select body from public.notifications where kind = 'job_upcoming' and job_id = (select id from ids where name = 'soon')),
          '"soon" is cancelled automatically if you don''t start it within 10 minutes.', 'reminder says how long is left');
select is(public.remind_upcoming_jobs(), 0, 'reminders are sent once');
update public.compute_jobs set start_by = now() - interval '1 minute' where id = (select id from ids where name = 'soon');
select public.expire_jobs();
select set_eq($$ select * from pg_temp.notes('soon') $$,
              array['host:job_booked', 'renter:job_accepted', 'host:job_upcoming', 'renter:job_cancelled', 'host:job_missed'],
              'no-shows notify both sides');

select is((select count(*)::int from public.notifications where user_id = '00000000-0000-0000-0000-0000000000b4'), 0,
          'uninvolved users get nothing');
select is((select count(*)::int from cron.job where jobname = 'grove-job-reminders'), 1, 'reminder job is scheduled');

-- Privacy and permissions
select ok(not has_function_privilege('authenticated', 'public.notify(uuid,text,uuid,text,text)', 'execute'),
          'users cannot create notifications');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
select ok((select count(*) from public.notifications) > 0 and
          (select bool_and(user_id = '00000000-0000-0000-0000-0000000000b2') from public.notifications),
          'renters read only their own notifications');
select lives_ok($$ update public.notifications set read_at = now() $$, 'users can mark their notifications read');
select throws_ok($$ update public.notifications set title = 'hacked' $$, '42501', null, 'users cannot edit notification text');
select throws_ok($$ insert into public.notifications (user_id, kind, title) values (auth.uid(), 'job_started', 'x') $$,
                 '42501', null, 'users cannot insert notifications');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}', true);
update public.notifications set read_at = null;
reset role;
select is((select count(*)::int from public.notifications where read_at is null and user_id = '00000000-0000-0000-0000-0000000000b2'), 0,
          'other users cannot mark someone else''s notifications unread');

select * from finish();
rollback;
