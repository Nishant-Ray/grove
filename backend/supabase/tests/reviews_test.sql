-- Run with: supabase start && supabase test db   (from backend/)
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users (id, email, raw_user_meta_data) values
    ('00000000-0000-0000-0000-0000000000a1', 'host@reviews.invalid',   '{"display_name":"Hana"}'),
    ('00000000-0000-0000-0000-0000000000a3', 'host2@reviews.invalid',  '{"display_name":"Hugo"}'),
    ('00000000-0000-0000-0000-0000000000b2', 'renter@reviews.invalid', '{"display_name":"Rae"}'),
    ('00000000-0000-0000-0000-0000000000b4', 'other@reviews.invalid',  '{}');
insert into public.wallets (user_id, balance_micros) select id, 1000000000 from auth.users where email like '%@reviews.invalid';
insert into public.host_devices (id, owner_id, name, hardware, availability, gpu_model, zip, last_seen_at, specs) values
    ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'Lab 4090', 'x', 'available', 'rtx-4090', '14850', now(), '{"acceptance":"automatic"}'),
    ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a1', 'Lab 4070', 'x', 'available', 'rtx-4070', '14850', now(), '{"acceptance":"manual"}'),
    ('00000000-0000-0000-0000-0000000000d5', '00000000-0000-0000-0000-0000000000a3', 'Hugo 4090', 'x', 'available', 'rtx-4090', '14850', now(), '{"acceptance":"automatic"}');
-- Isolate from data already in the database (rolled back at the end).
update public.host_devices set availability = 'paused'
    where owner_id not in ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a3');

create temp table ids (name text primary key, id uuid);
grant select on ids to authenticated;
create function pg_temp.book(p_name text, p_device text, p_renter text default '00000000-0000-0000-0000-0000000000b2')
returns void language sql as $$
    insert into ids select p_name, id from public.create_job(p_renter::uuid, p_device::uuid, p_name, 'standard', 1, 0, '', 0.4511, 0.3609, 1000000);
$$;
create function pg_temp.act(p_job text, p_actor text, p_action text) returns void language sql as $$
    select public.job_action(p_actor::uuid, (select id from ids where name = p_job), p_action);
$$;
create function pg_temp.complete(p_job text, p_host text default '00000000-0000-0000-0000-0000000000a1') returns void language sql as $$
    select pg_temp.act(p_job, p_host, 'start');
    select pg_temp.act(p_job, p_host, 'complete');
$$;

-- Host Hana: two completed jobs, plus a host-side failure, a no-show and a cancellation.
select pg_temp.book('done', '00000000-0000-0000-0000-0000000000d1');
select pg_temp.complete('done');
select pg_temp.book('old', '00000000-0000-0000-0000-0000000000d1');
select pg_temp.complete('old');
update public.compute_jobs set finished_at = now() - interval '15 days' where id = (select id from ids where name = 'old');
select pg_temp.book('failed', '00000000-0000-0000-0000-0000000000d1');
select pg_temp.act('failed', '00000000-0000-0000-0000-0000000000a1', 'start');
select pg_temp.act('failed', '00000000-0000-0000-0000-0000000000a1', 'fail_host');
select pg_temp.book('noshow', '00000000-0000-0000-0000-0000000000d1');
update public.compute_jobs set start_by = now() - interval '1 minute' where id = (select id from ids where name = 'noshow');
select public.expire_jobs();
select pg_temp.book('hcancel', '00000000-0000-0000-0000-0000000000d1');
select pg_temp.act('hcancel', '00000000-0000-0000-0000-0000000000a1', 'cancel');
select pg_temp.book('pending', '00000000-0000-0000-0000-0000000000d2');
-- Host Hugo: one completed job.
select pg_temp.book('hugo', '00000000-0000-0000-0000-0000000000d5');
select pg_temp.complete('hugo', '00000000-0000-0000-0000-0000000000a3');

-- Renter -------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
select lives_ok($$ insert into public.reviews (job_id, rating, comment) values ((select id from ids where name = 'done'), 5, '  Great host, fast and friendly.  ') $$,
                'renter reviews a completed job');
select results_eq($$ select reviewer_role, reviewee_id, comment from public.reviews where job_id = (select id from ids where name = 'done') $$,
                  $$ values ('renter'::text, '00000000-0000-0000-0000-0000000000a1'::uuid, 'Great host, fast and friendly.'::text) $$,
                  'the database works out who is reviewed, and trims the comment');
select throws_ok($$ insert into public.reviews (job_id, rating) values ((select id from ids where name = 'done'), 1) $$,
                 '23505', null, 'one review per job per person');
select throws_ok($$ insert into public.reviews (job_id, rating) values ((select id from ids where name = 'pending'), 5) $$,
                 '42501', 'NOT_REVIEWABLE', 'jobs that have not completed cannot be reviewed');
select throws_ok($$ insert into public.reviews (job_id, rating) values ((select id from ids where name = 'failed'), 1) $$,
                 '42501', 'NOT_REVIEWABLE', 'failed jobs cannot be reviewed');
select throws_ok($$ insert into public.reviews (job_id, rating) values ((select id from ids where name = 'old'), 5) $$,
                 '42501', 'NOT_REVIEWABLE', 'the review window closes 14 days after the job');
select throws_ok($$ insert into public.reviews (job_id, rating) values ((select id from ids where name = 'hugo'), 0) $$, '23514', null, 'ratings start at 1');
select throws_ok($$ insert into public.reviews (job_id, rating) values ((select id from ids where name = 'hugo'), 6) $$, '23514', null, 'ratings stop at 5');
select throws_ok(format($$ insert into public.reviews (job_id, rating, comment) values ((select id from ids where name = 'hugo'), 3, %L) $$, repeat('x', 1001)),
                 '23514', null, 'comments are at most 1,000 characters');
select throws_ok($$ insert into public.reviews (job_id, rating, reviewee_id) values ((select id from ids where name = 'hugo'), 1, '00000000-0000-0000-0000-0000000000b4') $$,
                 '42501', null, 'cannot choose who is reviewed');
select throws_ok($$ insert into public.reviews (job_id, rating, reviewer_id) values ((select id from ids where name = 'hugo'), 1, '00000000-0000-0000-0000-0000000000b4') $$,
                 '42501', null, 'cannot review as someone else');
select lives_ok($$ insert into public.reviews (job_id, rating, comment) values ((select id from ids where name = 'hugo'), 3, 'Slow start') $$,
                'renter reviews a second host');
select throws_ok($$ update public.reviews set rating = 5 $$, '42501', null, 'reviews cannot be edited');
select throws_ok($$ delete from public.reviews $$, '42501', null, 'reviews cannot be deleted');

-- Host reviews the renter --------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
select lives_ok($$ insert into public.reviews (job_id, rating) values ((select id from ids where name = 'done'), 4) $$, 'host reviews the renter');
select is((select reviewee_id from public.reviews where job_id = (select id from ids where name = 'done') and reviewer_role = 'host'),
          '00000000-0000-0000-0000-0000000000b2'::uuid, 'the host''s review is about the renter');
select is((select body from public.notifications where kind = 'review_received' and job_id = (select id from ids where name = 'done')),
          'Rae rated you 5 out of 5 for "done": Great host, fast and friendly.', 'the host is notified of the review');

-- Outsiders ------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}', true);
select throws_ok($$ insert into public.reviews (job_id, rating) values ((select id from ids where name = 'done'), 1) $$,
                 '42501', 'NOT_REVIEWABLE', 'outsiders cannot review a job');
select ok((select count(*) from public.reviews where reviewee_id = '00000000-0000-0000-0000-0000000000a1') = 1, 'reviews are public to signed-in users');

-- Reputation ----------------------------------------------------------------------------------------
select results_eq($$ select host_rating, host_reviews, jobs_completed, no_shows, host_cancels, host_failures, completion_rate
                     from public.reputation(array['00000000-0000-0000-0000-0000000000a1'::uuid]) $$,
                  $$ values (5.00::numeric, 1, 2, 1, 1, 1, 0.400::numeric) $$,
                  'host reputation: rating, and 2 completed of 5 accepted jobs');
select results_eq($$ select renter_rating, renter_reviews from public.reputation(array['00000000-0000-0000-0000-0000000000b2'::uuid]) $$,
                  $$ values (4.00::numeric, 1) $$, 'renters have a rating too');
select results_eq($$ select reviewer_name, rating, comment from public.reviews_received('00000000-0000-0000-0000-0000000000a1') $$,
                  $$ values ('Rae'::text, 5::smallint, 'Great host, fast and friendly.'::text) $$, 'recent reviews show the reviewer''s name');
reset role;
select set_eq($$ select device_name || ' ' || host_rating || ' ' || host_reviews
                 from public.recommend_hosts('00000000-0000-0000-0000-0000000000b4', 'standard', 0, null, null) $$,
              array['Lab 4090 5.00 1', 'Hugo 4090 3.00 1'], 'recommendations carry each host''s rating (busy Lab 4070 excluded)');
select ok(not has_function_privilege('anon', 'public.reputation(uuid[])', 'execute'), 'anon cannot read reputations');

select * from finish();
rollback;
