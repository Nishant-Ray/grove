-- Run with: supabase start && supabase test db   (from backend/)
begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

-- Pricing data sanity ------------------------------------------------------------
select is_empty($$
    select g.gpu_model
    from public.gpu_rates g, public.grove_settings s, public.priority_levels p, public.electricity_rates e
    where g.active and p.id = 'standard' and e.state = 'US'
      and round(round(g.base_rate_usd_hr * p.multiplier, 4) * s.host_share, 4)
          < ceil((g.power_kw + s.system_overhead_kw) * e.usd_per_kwh * s.floor_margin * 10000) / 10000
$$, 'every active GPU clears the power floor at Standard priority at the national rate');

select is_empty($$
    select 1 from public.zip3_ranges a join public.zip3_ranges b
      on a.zip3_start < b.zip3_start and b.zip3_start <= a.zip3_end
$$, 'ZIP3 ranges do not overlap');

select is_empty($$
    select state from public.zip3_ranges
    where state <> 'PR' and state not in (select state from public.electricity_rates)
$$, 'every mapped state has an electricity rate');

-- Privileges ---------------------------------------------------------------------
select ok((select not ('zip' = any(proargnames) or 'owner_id' = any(proargnames))
           from pg_proc where proname = 'quote_inputs'), 'quote_inputs never returns ZIP or owner');
select ok(not has_function_privilege('anon', 'public.quote_inputs(uuid,text)', 'execute'), 'anon cannot quote');
select ok(has_function_privilege('authenticated', 'public.quote_inputs(uuid,text)', 'execute'),
          'signed-in users can quote');
select ok(not has_table_privilege('authenticated', 'public.gpu_rates', 'insert,update,delete'), 'gpu_rates read-only');
select ok(not has_table_privilege('authenticated', 'public.priority_levels', 'insert,update,delete'), 'priority_levels read-only');
select ok(not has_table_privilege('authenticated', 'public.grove_settings', 'insert,update,delete'), 'grove_settings read-only');
select ok(not has_table_privilege('authenticated', 'public.electricity_rates', 'insert,update,delete'), 'electricity_rates read-only');
select ok(not has_table_privilege('authenticated', 'public.zip3_ranges', 'insert,update,delete'), 'zip3_ranges read-only');
select ok(has_table_privilege('anon', 'public.gpu_rates', 'select'), 'rates are public');

-- quote_inputs behaviour -----------------------------------------------------------
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'host@test.invalid');
insert into public.host_devices (id, owner_id, name, hardware, gpu_model, zip, usd_per_kwh_override) values
    ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'NY rig', 'x', 'rtx-4090', '14850', null),
    ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a1', 'Solar rig', 'x', 'rtx-4090', '14850', 0.0900),
    ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000a1', 'APO rig', 'x', 'rtx-4090', '34001', null),
    ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000a1', 'CPU box', 'x', null, '14850', null);

select results_eq($$ select usd_per_kwh, kwh_source from public.quote_inputs('00000000-0000-0000-0000-0000000000d1', 'standard') $$,
                  $$ values (0.2842::numeric, 'state'::text) $$, 'NY ZIP uses the NY state rate');
select results_eq($$ select power_kw, priority_multiplier from public.quote_inputs('00000000-0000-0000-0000-0000000000d1', 'standard') $$,
                  $$ values (0.550::numeric, 1.30::numeric) $$, 'power includes system overhead');
select is((select kwh_source from public.quote_inputs('00000000-0000-0000-0000-0000000000d2', 'batch')), 'host',
          'host override wins');
select is((select kwh_source from public.quote_inputs('00000000-0000-0000-0000-0000000000d3', 'batch')), 'national',
          'unmapped ZIP falls back to the national rate');
select is((select priority_multiplier from public.quote_inputs('00000000-0000-0000-0000-0000000000d1', 'turbo')), null,
          'unknown priority returns no multiplier');
select is((select gpu_model from public.quote_inputs('00000000-0000-0000-0000-0000000000d4', 'batch')), null,
          'device without a listed GPU returns no GPU');

-- A different signed-in user can quote a device they cannot read directly.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is((select gpu_model from public.quote_inputs('00000000-0000-0000-0000-0000000000d1', 'standard')), 'rtx-4090',
          'renters can quote other hosts'' devices');

select * from finish();
rollback;
