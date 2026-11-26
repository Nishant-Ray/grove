-- Run with: supabase start && supabase test db   (from backend/)
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users (id, email, raw_user_meta_data) values
    ('00000000-0000-0000-0000-0000000000a1', 'host@credits.invalid',   '{"display_name":"Hana"}'),
    ('00000000-0000-0000-0000-0000000000b2', 'renter@credits.invalid', '{"display_name":"Rae"}'),
    ('00000000-0000-0000-0000-0000000000b4', 'broke@credits.invalid',  '{}');
insert into public.host_devices (id, owner_id, name, hardware, availability, gpu_model, zip, last_seen_at, specs) values
    ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'Lab 4090', 'x', 'available', 'rtx-4090', '14850', now(), '{"acceptance":"automatic"}'),
    ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a1', 'Lab 4070', 'x', 'available', 'rtx-4070', '14850', now(), '{"acceptance":"manual"}');

create temp table ids (name text primary key, id uuid);
create function pg_temp.book(p_name text, p_device text, p_renter text, p_rate numeric, p_payout numeric, p_reserve bigint)
returns void language sql as $$
    insert into ids select p_name, id from public.create_job(p_renter::uuid, p_device::uuid, p_name, 'standard', 1, 0, '',
                                                            p_rate, p_payout, p_reserve);
$$;
create function pg_temp.act(p_job text, p_actor text, p_action text) returns void language sql as $$
    select public.job_action(p_actor::uuid, (select id from ids where name = p_job), p_action);
$$;
create function pg_temp.ran(p_job text, p_seconds int) returns void language sql as $$
    update public.compute_jobs set started_at = now() - make_interval(secs => p_seconds)
    where id = (select id from ids where name = p_job);
$$;
create function pg_temp.w(p_user text) returns text language sql as $$
    select balance_micros || '/' || reserved_micros || '/' || earnings_micros from public.wallets where user_id = p_user::uuid;
$$;
create function pg_temp.ledger(p_kind text) returns bigint language sql as $$
    select coalesce(sum(amount_micros), 0)::bigint from public.ledger_entries
    where kind = p_kind and (user_id is null or user_id in (select id from auth.users where email like '%@credits.invalid'));
$$;
-- sum(topups) - sum(charges) = sum(balances); sum(reserves) - sum(releases) = sum(reserved);
-- sum(charges) = sum(host earnings) + sum(Grove fees); earnings - withdrawals + reversals = sum(earnings)
create function pg_temp.balanced() returns boolean language sql as $$
    select pg_temp.ledger('topup') - pg_temp.ledger('charge') = sum(balance_micros)
       and pg_temp.ledger('reserve') - pg_temp.ledger('release') = sum(reserved_micros)
       and pg_temp.ledger('charge') = pg_temp.ledger('host_earning') + pg_temp.ledger('grove_fee')
       and pg_temp.ledger('host_earning') - pg_temp.ledger('withdrawal') + pg_temp.ledger('withdrawal_reversal') = sum(earnings_micros)
    from public.wallets where user_id in (select id from auth.users where email like '%@credits.invalid');
$$;

-- Top-ups ---------------------------------------------------------------------------------------
select is(public.credit_topup('00000000-0000-0000-0000-0000000000b2', 'cs_test_1', 50000000), true, 'a paid Checkout session credits the renter');
select is(public.credit_topup('00000000-0000-0000-0000-0000000000b2', 'cs_test_1', 50000000), false, 'the same session never credits twice');
select is(pg_temp.w('00000000-0000-0000-0000-0000000000b2'), '50000000/0/0', 'balance is $50.00');
select throws_ok($$ select public.credit_topup('00000000-0000-0000-0000-0000000000b2', 'cs_test_x', 0) $$, 'P0001', 'INVALID_AMOUNT', 'zero top-ups are rejected');

-- Reserving on booking -------------------------------------------------------------------------
select throws_ok($$ select pg_temp.book('broke', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b4', 0.3549, 0.2839, 887250) $$,
                 'P0001', 'INSUFFICIENT_CREDITS', 'renters without credits cannot book');
select is((select count(*)::int from public.compute_jobs where owner_id = '00000000-0000-0000-0000-0000000000b4'), 0, 'no job is created');
select throws_ok($$ select pg_temp.book('huge', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b2', 0.3549, 0.2839, 60000000) $$,
                 'P0001', 'INSUFFICIENT_CREDITS', 'a reserve larger than the available balance is refused');

select pg_temp.book('a', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b2', 0.3549, 0.2839, 887250);
select is(pg_temp.w('00000000-0000-0000-0000-0000000000b2'), '50000000/887250/0', 'booking reserves estimate x 1.25 without charging');
select ok((select credits_reserved from public.compute_jobs where id = (select id from ids where name = 'a')), 'job records that credits are reserved');
select throws_ok($$ select pg_temp.book('busy', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b2', 0.3549, 0.2839, 887250) $$,
                 'P0001', 'DEVICE_BUSY', 'booking a busy device fails');
select is(pg_temp.w('00000000-0000-0000-0000-0000000000b2'), '50000000/887250/0', 'a failed booking does not leak a reserve');

-- Settling: completed job, 90 seconds at $0.3549/hr ------------------------------------------------
select pg_temp.act('a', '00000000-0000-0000-0000-0000000000a1', 'start');
select pg_temp.ran('a', 90);
select pg_temp.act('a', '00000000-0000-0000-0000-0000000000a1', 'complete');
select is(pg_temp.w('00000000-0000-0000-0000-0000000000b2'), '49991127/0/0', 'renter pays 8,873 micro-dollars and the reserve is released');
select is(pg_temp.w('00000000-0000-0000-0000-0000000000a1'), '0/0/7097', 'host earns charge x payout/rate (floored)');
select is((select amount_micros from public.ledger_entries where kind = 'grove_fee' and job_id = (select id from ids where name = 'a')), 1776::bigint,
          'Grove keeps the remainder');

-- No charge: host-side failure, renter cancel, host decline, no-show -----------------------------------
select pg_temp.book('hostfail', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b2', 0.3549, 0.2839, 887250);
select pg_temp.act('hostfail', '00000000-0000-0000-0000-0000000000a1', 'start');
select pg_temp.ran('hostfail', 3600);
select pg_temp.act('hostfail', '00000000-0000-0000-0000-0000000000a1', 'fail_host');
select is(pg_temp.w('00000000-0000-0000-0000-0000000000b2'), '49991127/0/0', 'host-side failures cost the renter nothing');

select pg_temp.book('cancel', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b2', 0.3549, 0.2839, 887250);
select pg_temp.act('cancel', '00000000-0000-0000-0000-0000000000b2', 'cancel');
select pg_temp.book('decline', '00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000b2', 0.1729, 0.1383, 216125);
select pg_temp.act('decline', '00000000-0000-0000-0000-0000000000a1', 'decline');
select pg_temp.book('noshow', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b2', 0.3549, 0.2839, 887250);
update public.compute_jobs set start_by = now() - interval '1 minute' where id = (select id from ids where name = 'noshow');
select public.expire_jobs();
select is(pg_temp.w('00000000-0000-0000-0000-0000000000b2'), '49991127/0/0', 'cancellations, declines and no-shows release the full reserve');
select is(pg_temp.w('00000000-0000-0000-0000-0000000000a1'), '0/0/7097', 'and the host earns nothing for them');

-- Charged: job error, renter stop (capped at the reserve) ---------------------------------------------
select pg_temp.book('err', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b2', 0.3600, 0.2880, 1000000);
select pg_temp.act('err', '00000000-0000-0000-0000-0000000000a1', 'start');
select pg_temp.ran('err', 600);
select pg_temp.act('err', '00000000-0000-0000-0000-0000000000a1', 'fail_job');
select is((select amount_micros from public.ledger_entries where kind = 'charge' and job_id = (select id from ids where name = 'err')), 60000::bigint,
          'a job error bills the 10 minutes used');
select pg_temp.book('capped', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b2', 0.3549, 0.2839, 1000);
select pg_temp.act('capped', '00000000-0000-0000-0000-0000000000a1', 'start');
select pg_temp.ran('capped', 86400);
select pg_temp.act('capped', '00000000-0000-0000-0000-0000000000b2', 'stop');
select results_eq($$ select kind, amount_micros from public.ledger_entries where job_id = (select id from ids where name = 'capped') order by id $$,
                  $$ values ('reserve'::text, 1000::bigint), ('release', 1000), ('charge', 1000), ('host_earning', 799), ('grove_fee', 201) $$,
                  'a day-long run is capped at the reserve, and the ledger tells the whole story');
select ok(pg_temp.balanced(), 'ledger and wallets balance after every outcome');

-- Jobs booked before credits existed settle without touching wallets ------------------------------------
insert into public.compute_jobs (owner_id, host_id, name, status) values
    ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-0000000000a1', 'legacy', 'running');
update public.compute_jobs set status = 'completed', charged_micros = 5000 where name = 'legacy';
select is((select count(*)::int from public.wallets where user_id = '00000000-0000-0000-0000-0000000000b4' and balance_micros <> 0), 0,
          'legacy jobs are never charged');

-- Withdrawals ---------------------------------------------------------------------------------------
select pg_temp.book('big', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b2', 1.0000, 0.8000, 30000000);
select pg_temp.act('big', '00000000-0000-0000-0000-0000000000a1', 'start');
select pg_temp.ran('big', 72000);
select pg_temp.act('big', '00000000-0000-0000-0000-0000000000a1', 'complete');
select is((select earnings_micros from public.wallets where user_id = '00000000-0000-0000-0000-0000000000a1'), 16055896::bigint,
          'host earnings accumulate across jobs');
select throws_ok($$ select * from public.request_withdrawal('00000000-0000-0000-0000-0000000000a1', 5000000) $$,
                 'P0001', 'PAYOUTS_NOT_READY', 'no withdrawals before payout setup');
select public.save_host_account('00000000-0000-0000-0000-0000000000a1', 'acct_test_host');
select throws_ok($$ select * from public.request_withdrawal('00000000-0000-0000-0000-0000000000a1', 5000000) $$,
                 'P0001', 'PAYOUTS_NOT_READY', 'nor while Stripe has not enabled payouts');
select public.sync_host_account('acct_test_host', true, true);
select throws_ok($$ select * from public.request_withdrawal('00000000-0000-0000-0000-0000000000a1', 4990000) $$, 'P0001', 'BELOW_MINIMUM', 'minimum withdrawal is $5');
select throws_ok($$ select * from public.request_withdrawal('00000000-0000-0000-0000-0000000000a1', 5000001) $$, 'P0001', 'WHOLE_CENTS', 'withdrawals are whole cents');
select throws_ok($$ select * from public.request_withdrawal('00000000-0000-0000-0000-0000000000a1', 99000000) $$, 'P0001', 'INSUFFICIENT_EARNINGS', 'cannot withdraw more than earned');

create temp table wd as select * from public.request_withdrawal('00000000-0000-0000-0000-0000000000a1', 10000000);
select is((select stripe_account_id from wd), 'acct_test_host', 'withdrawal returns the destination account');
select is((select earnings_micros from public.wallets where user_id = '00000000-0000-0000-0000-0000000000a1'), 6055896::bigint, 'earnings are debited up front');
select public.complete_withdrawal((select withdrawal_id from wd), 'tr_test_1');
select is((select status || ' ' || stripe_transfer_id from public.withdrawals where id = (select withdrawal_id from wd)), 'paid tr_test_1', 'completed transfer recorded');

create temp table wd2 as select * from public.request_withdrawal('00000000-0000-0000-0000-0000000000a1', 6000000);
select public.fail_withdrawal((select withdrawal_id from wd2), 'insufficient platform balance');
select public.fail_withdrawal((select withdrawal_id from wd2), 'retry');
select is((select earnings_micros from public.wallets where user_id = '00000000-0000-0000-0000-0000000000a1'), 6055896::bigint,
          'a failed transfer refunds earnings exactly once');
select is((select status from public.withdrawals where id = (select withdrawal_id from wd2)), 'failed', 'failure recorded');
select ok(pg_temp.balanced(), 'ledger and wallets still balance after withdrawals');

select is(public.record_stripe_event('evt_1', 'checkout.session.completed'), true, 'first delivery of a webhook is processed');
select is(public.record_stripe_event('evt_1', 'checkout.session.completed'), false, 'redeliveries are ignored');

-- Permissions ----------------------------------------------------------------------------------------
select ok(not has_function_privilege('authenticated', 'public.credit_topup(uuid,text,bigint)', 'execute'), 'users cannot credit themselves');
select ok(not has_function_privilege('authenticated', 'public.request_withdrawal(uuid,bigint)', 'execute'), 'users cannot withdraw directly');
select ok(not has_function_privilege('authenticated', 'public.sync_host_account(text,boolean,boolean)', 'execute'), 'users cannot mark payouts ready');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
select is((select count(*)::int from public.wallets), 1, 'renters see only their own wallet');
select ok((select bool_and(user_id = '00000000-0000-0000-0000-0000000000b2') from public.ledger_entries), 'and only their own ledger rows');
select is((select count(*)::int from public.ledger_entries where kind = 'grove_fee'), 0, 'Grove''s fee rows are private');
select throws_ok($$ update public.wallets set balance_micros = 999999999 $$, '42501', null, 'users cannot edit balances');
select throws_ok($$ select * from public.stripe_events $$, '42501', null, 'webhook log is private');
select is((select count(*)::int from public.withdrawals), 0, 'renters cannot see the host''s withdrawals');

select * from finish();
rollback;
