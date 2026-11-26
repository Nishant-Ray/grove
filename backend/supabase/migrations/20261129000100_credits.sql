-- Prepaid credits, per-second billing and host earnings.
--
-- Money model (all amounts in micro-dollars, 1 USD = 1,000,000):
--   * Renters top up a balance through Stripe Checkout (credit_topup, idempotent per session).
--   * Booking reserves estimate x 1.25 from the available balance (balance - reserved). The
--     reservation is taken by a trigger on compute_jobs, so no booking path can skip it.
--   * When a job ends, a second trigger settles it: the reserve is released, the renter pays
--     charged_micros (per-second usage, already capped at the reserve, 0 for host-side failures,
--     no-shows and cancellations), the host earns charge x payout/rate, and Grove keeps the rest.
--   * Hosts withdraw earnings to their Stripe Connect account (request/complete/fail_withdrawal).
-- Every change writes an append-only ledger row in the same transaction, so
--   sum(topups) = sum(balances) + sum(earnings) + sum(grove fees) + sum(withdrawn)
-- holds at all times. Only the API's service role can call these functions; users can only
-- read their own wallet, ledger, payout account and withdrawals.

create table public.wallets (
    user_id uuid primary key references auth.users(id) on delete cascade,
    balance_micros bigint not null default 0,
    reserved_micros bigint not null default 0,
    earnings_micros bigint not null default 0,
    updated_at timestamptz not null default now(),
    check (reserved_micros >= 0 and balance_micros >= reserved_micros and earnings_micros >= 0)
);

create table public.ledger_entries (
    id bigint generated always as identity primary key,
    user_id uuid references auth.users(id) on delete set null, -- null: Grove's own fee rows
    job_id uuid references public.compute_jobs(id) on delete set null deferrable initially deferred,
    kind text not null check (kind in ('topup', 'reserve', 'release', 'charge', 'host_earning',
                                       'grove_fee', 'withdrawal', 'withdrawal_reversal')),
    amount_micros bigint not null check (amount_micros >= 0),
    stripe_ref text,
    created_at timestamptz not null default now()
);
create unique index ledger_topup_once on public.ledger_entries(stripe_ref) where kind = 'topup';
create index ledger_user_recent_idx on public.ledger_entries(user_id, created_at desc, id desc);

create table public.host_accounts (
    user_id uuid primary key references auth.users(id) on delete cascade,
    stripe_account_id text not null unique,
    details_submitted boolean not null default false,
    payouts_enabled boolean not null default false,
    updated_at timestamptz not null default now()
);

create table public.withdrawals (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    amount_micros bigint not null check (amount_micros > 0 and amount_micros % 10000 = 0),
    status text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
    stripe_transfer_id text,
    failure text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index withdrawals_user_recent_idx on public.withdrawals(user_id, created_at desc);

-- Webhook deduplication: each Stripe event is processed at most once.
create table public.stripe_events (
    id text primary key,
    type text not null,
    received_at timestamptz not null default now()
);

alter table public.compute_jobs add column credits_reserved boolean not null default false;
alter table public.grove_settings add column max_topup_usd numeric(8,2) not null default 500 check (max_topup_usd > 0);

do $$
declare t text;
begin
    foreach t in array array['wallets', 'ledger_entries', 'host_accounts', 'withdrawals', 'stripe_events'] loop
        execute format('alter table public.%I enable row level security', t);
        execute format('revoke all on public.%I from public, anon, authenticated', t);
    end loop;
    foreach t in array array['wallets', 'ledger_entries', 'host_accounts', 'withdrawals'] loop
        execute format('grant select on public.%I to authenticated', t);
        execute format('create policy read_own_%s on public.%I for select to authenticated using (user_id = (select auth.uid()))', t, t);
    end loop;
end $$;

-- Top-ups ------------------------------------------------------------------------------------
create function public.credit_topup(p_user uuid, p_session text, p_amount_micros bigint)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
    if p_amount_micros <= 0 then raise exception 'INVALID_AMOUNT'; end if;
    insert into public.ledger_entries (user_id, kind, amount_micros, stripe_ref)
    values (p_user, 'topup', p_amount_micros, p_session)
    on conflict (stripe_ref) where kind = 'topup' do nothing;
    if not found then
        return false; -- already credited (webhook and return page can both report a session)
    end if;
    insert into public.wallets (user_id, balance_micros) values (p_user, p_amount_micros)
    on conflict (user_id) do update
        set balance_micros = public.wallets.balance_micros + excluded.balance_micros, updated_at = now();
    return true;
end $$;

-- Reserve on booking -----------------------------------------------------------------------------
create function public.reserve_job_credits()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
    if coalesce(new.reserve_micros, 0) = 0 then
        return new;
    end if;
    insert into public.wallets (user_id) values (new.owner_id) on conflict (user_id) do nothing;
    -- The row lock makes concurrent bookings by the same renter queue up and re-check.
    update public.wallets set reserved_micros = reserved_micros + new.reserve_micros, updated_at = now()
    where user_id = new.owner_id and balance_micros - reserved_micros >= new.reserve_micros;
    if not found then
        raise exception 'INSUFFICIENT_CREDITS';
    end if;
    insert into public.ledger_entries (user_id, job_id, kind, amount_micros)
    values (new.owner_id, new.id, 'reserve', new.reserve_micros);
    new.credits_reserved := true;
    return new;
end $$;

create trigger reserve_job_credits before insert on public.compute_jobs
    for each row execute function public.reserve_job_credits();

-- Settle when a job ends --------------------------------------------------------------------------
create function public.settle_job_credits()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
    charge bigint;
    payout bigint;
begin
    if not old.credits_reserved
       or old.status not in ('requested', 'scheduled', 'running')
       or new.status not in ('completed', 'failed', 'cancelled', 'declined') then
        return new;
    end if;
    charge := least(coalesce(new.charged_micros, 0), new.reserve_micros);
    payout := case when charge > 0 and new.rate_per_hr > 0
                   then floor(charge * new.host_payout_per_hr / new.rate_per_hr)::bigint else 0 end;

    update public.wallets
    set reserved_micros = reserved_micros - new.reserve_micros, balance_micros = balance_micros - charge,
        updated_at = now()
    where user_id = new.owner_id;
    insert into public.ledger_entries (user_id, job_id, kind, amount_micros)
    values (new.owner_id, new.id, 'release', new.reserve_micros);
    if charge > 0 then
        insert into public.ledger_entries (user_id, job_id, kind, amount_micros)
        values (new.owner_id, new.id, 'charge', charge);
    end if;
    if payout > 0 then
        insert into public.wallets (user_id, earnings_micros) values (new.host_id, payout)
        on conflict (user_id) do update
            set earnings_micros = public.wallets.earnings_micros + excluded.earnings_micros, updated_at = now();
        insert into public.ledger_entries (user_id, job_id, kind, amount_micros)
        values (new.host_id, new.id, 'host_earning', payout);
    end if;
    if charge - payout > 0 then
        insert into public.ledger_entries (user_id, job_id, kind, amount_micros)
        values (null, new.id, 'grove_fee', charge - payout);
    end if;
    return new;
end $$;

create trigger settle_job_credits after update of status on public.compute_jobs
    for each row execute function public.settle_job_credits();

-- Host payout accounts ---------------------------------------------------------------------------
create function public.save_host_account(p_actor uuid, p_account text)
returns public.host_accounts
language sql security definer set search_path = ''
as $$
    insert into public.host_accounts (user_id, stripe_account_id) values (p_actor, p_account)
    on conflict (user_id) do update set updated_at = now()
    returning *;
$$;

create function public.sync_host_account(p_account text, p_details boolean, p_payouts boolean)
returns void
language sql security definer set search_path = ''
as $$
    update public.host_accounts
    set details_submitted = p_details, payouts_enabled = p_payouts, updated_at = now()
    where stripe_account_id = p_account;
$$;

-- Withdrawals ------------------------------------------------------------------------------------
create function public.request_withdrawal(p_actor uuid, p_amount_micros bigint)
returns table (withdrawal_id uuid, stripe_account_id text)
language plpgsql security definer set search_path = ''
as $$
declare
    account public.host_accounts;
    minimum bigint;
    w uuid;
begin
    select (min_withdrawal_usd * 1000000)::bigint into minimum from public.grove_settings;
    if p_amount_micros % 10000 <> 0 then raise exception 'WHOLE_CENTS'; end if;
    if p_amount_micros < coalesce(minimum, 0) then raise exception 'BELOW_MINIMUM'; end if;
    select * into account from public.host_accounts where user_id = p_actor;
    if not found or not account.payouts_enabled then raise exception 'PAYOUTS_NOT_READY'; end if;
    update public.wallets set earnings_micros = earnings_micros - p_amount_micros, updated_at = now()
    where user_id = p_actor and earnings_micros >= p_amount_micros;
    if not found then raise exception 'INSUFFICIENT_EARNINGS'; end if;
    insert into public.withdrawals (user_id, amount_micros) values (p_actor, p_amount_micros) returning id into w;
    insert into public.ledger_entries (user_id, kind, amount_micros, stripe_ref)
    values (p_actor, 'withdrawal', p_amount_micros, w::text);
    return query select w, account.stripe_account_id;
end $$;

create function public.complete_withdrawal(p_id uuid, p_transfer text)
returns void
language sql security definer set search_path = ''
as $$
    update public.withdrawals set status = 'paid', stripe_transfer_id = p_transfer, updated_at = now()
    where id = p_id and status = 'pending';
$$;

-- A transfer that fails puts the money back into the host's earnings.
create function public.fail_withdrawal(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
    w public.withdrawals;
begin
    update public.withdrawals set status = 'failed', failure = left(p_reason, 500), updated_at = now()
    where id = p_id and status = 'pending' returning * into w;
    if not found then return; end if;
    update public.wallets set earnings_micros = earnings_micros + w.amount_micros, updated_at = now()
    where user_id = w.user_id;
    insert into public.ledger_entries (user_id, kind, amount_micros, stripe_ref)
    values (w.user_id, 'withdrawal_reversal', w.amount_micros, w.id::text);
end $$;

create function public.record_stripe_event(p_id text, p_type text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
    insert into public.stripe_events (id, type) values (p_id, p_type) on conflict (id) do nothing;
    return found;
end $$;

do $$
declare f text;
begin
    foreach f in array array[
        'credit_topup(uuid,text,bigint)', 'reserve_job_credits()', 'settle_job_credits()',
        'save_host_account(uuid,text)', 'sync_host_account(text,boolean,boolean)',
        'request_withdrawal(uuid,bigint)', 'complete_withdrawal(uuid,text)',
        'fail_withdrawal(uuid,text)', 'record_stripe_event(text,text)'] loop
        execute format('revoke execute on function public.%s from public, anon, authenticated', f);
        execute format('grant execute on function public.%s to service_role', f);
    end loop;
end $$;
