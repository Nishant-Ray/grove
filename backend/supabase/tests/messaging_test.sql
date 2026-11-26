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
    ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a1', 'Lab 4070', 'x', 'available', 'rtx-4070', '14850', now(), '{"acceptance":"manual"}'),
    ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000a1', 'Lab 3090', 'x', 'available', 'rtx-3090', '14850', now(), '{"acceptance":"automatic"}');

create temp table ids (name text primary key, id uuid);
grant select on ids to authenticated;
insert into ids select 'auto', id from public.create_job('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000d1', 'Train', 'standard', 1, 0, '', 0.4511, 0.3609, 1000000);
insert into ids select 'pending', id from public.create_job('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000d2', 'Pending', 'standard', 1, 0, '', 0.1729, 0.1383, 1000000);
insert into ids select 'old', id from public.create_job('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000d3', 'Old', 'standard', 1, 0, '', 0.2119, 0.1695, 1000000);
select public.job_action('00000000-0000-0000-0000-0000000000a1', (select id from ids where name = 'old'), 'start');
select public.job_action('00000000-0000-0000-0000-0000000000a1', (select id from ids where name = 'old'), 'complete');
insert into public.messages (job_id, sender_id, body) values
    ((select id from ids where name = 'old'), '00000000-0000-0000-0000-0000000000b2', 'Thanks!');
update public.compute_jobs set finished_at = now() - interval '15 days' where id = (select id from ids where name = 'old');

-- Renter ---------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
select lives_ok($$ insert into public.messages (job_id, body) values ((select id from ids where name = 'auto'), 'Hi! Data is in the repo.') $$,
                'renter can message once the job is accepted');
select is((select sender_id from public.messages where job_id = (select id from ids where name = 'auto')),
          '00000000-0000-0000-0000-0000000000b2'::uuid, 'sender is always the signed-in user');
select throws_ok($$ insert into public.messages (job_id, body) values ((select id from ids where name = 'pending'), 'Hello?') $$,
                 '42501', null, 'no messaging before the host accepts');
select throws_ok($$ insert into public.messages (job_id, sender_id, body) values ((select id from ids where name = 'auto'), '00000000-0000-0000-0000-0000000000a1', 'spoof') $$,
                 '42501', null, 'cannot send as someone else');
select throws_ok($$ insert into public.messages (job_id, body, created_at) values ((select id from ids where name = 'auto'), 'x', now() - interval '1 year') $$,
                 '42501', null, 'cannot backdate messages');
select throws_ok($$ insert into public.messages (job_id, body) values ((select id from ids where name = 'auto'), '   ') $$,
                 '23514', null, 'blank messages are rejected');
select throws_ok(format($$ insert into public.messages (job_id, body) values ((select id from ids where name = 'auto'), %L) $$, repeat('x', 2001)),
                 '23514', null, 'messages over 2,000 characters are rejected');
select is((select count(*)::int from public.messages where job_id = (select id from ids where name = 'old')), 1,
          'old threads stay readable');
select throws_ok($$ insert into public.messages (job_id, body) values ((select id from ids where name = 'old'), 'One more thing') $$,
                 '42501', null, 'threads close 14 days after the job finishes');
select results_eq($$ select role, renter_name, host_name, device_name from public.job_participants((select id from ids where name = 'auto')) $$,
                  $$ values ('renter'::text, 'Rae'::text, 'Hana'::text, 'Lab 4090'::text) $$, 'thread header for the renter');
-- Same statement shape PostgREST generates for an upsert (on_conflict + merge-duplicates).
select lives_ok($$ insert into public.message_reads (job_id, last_read_at) values ((select id from ids where name = 'auto'), now())
                   on conflict (job_id, user_id) do update set job_id = excluded.job_id, last_read_at = excluded.last_read_at $$,
                'renter can record what they read');
select lives_ok($$ insert into public.message_reads (job_id, last_read_at) values ((select id from ids where name = 'auto'), now())
                   on conflict (job_id, user_id) do update set job_id = excluded.job_id, last_read_at = excluded.last_read_at $$,
                'repeat read markers update in place');
select throws_ok($$ insert into public.message_reads (job_id) values ((select id from ids where name = 'pending')) $$,
                 '42501', null, 'no read markers for threads you are not in');

-- Host ---------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
select is((select count(*)::int from public.messages where job_id = (select id from ids where name = 'auto')), 1, 'host reads the renter''s message');
select is((select title || ' | ' || body from public.notifications where kind = 'new_message' and job_id = (select id from ids where name = 'auto')),
          'New message about "Train" | Rae: Hi! Data is in the repo.', 'host is notified with a preview');
select lives_ok($$ insert into public.messages (job_id, body) values ((select id from ids where name = 'auto'), 'Got it, starting now.') $$,
                'host can reply');
select is((select role from public.job_participants((select id from ids where name = 'auto'))), 'host', 'thread header for the host');
select is((select count(*)::int from public.message_reads), 0, 'host cannot see the renter''s read markers');
update public.notifications set read_at = now() where kind = 'new_message';

-- Outsider ---------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}', true);
select is((select count(*)::int from public.messages), 0, 'outsiders read nothing');
select throws_ok($$ insert into public.messages (job_id, body) values ((select id from ids where name = 'auto'), 'Hi') $$,
                 '42501', null, 'outsiders cannot post');
select is_empty($$ select * from public.job_participants((select id from ids where name = 'auto')) $$, 'outsiders get no thread header');

-- Notification behaviour for busy threads ---------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
insert into public.messages (job_id, body) values ((select id from ids where name = 'auto'), 'Second message');
insert into public.messages (job_id, body) values ((select id from ids where name = 'auto'), 'Third message');
reset role;
select is((select count(*)::int from public.notifications where kind = 'new_message' and job_id = (select id from ids where name = 'auto') and user_id = '00000000-0000-0000-0000-0000000000a1'), 1,
          'a busy thread keeps one notification per person');
select is((select body || ' | ' || (read_at is null)::text from public.notifications where kind = 'new_message' and job_id = (select id from ids where name = 'auto') and user_id = '00000000-0000-0000-0000-0000000000a1'),
          'Rae: Third message | true', 'new messages after reading notify again with the latest preview');
select is((select body from public.notifications where kind = 'new_message' and job_id = (select id from ids where name = 'auto') and user_id = '00000000-0000-0000-0000-0000000000b2'),
          'Hana: Got it, starting now.', 'the renter is notified of the host''s reply');
select is((select count(*)::int from public.notifications where kind = 'new_message' and user_id = '00000000-0000-0000-0000-0000000000b4'), 0,
          'outsiders are never notified');
select ok(not has_function_privilege('anon', 'public.job_participants(uuid)', 'execute'), 'anon cannot read thread headers');

select * from finish();
rollback;
