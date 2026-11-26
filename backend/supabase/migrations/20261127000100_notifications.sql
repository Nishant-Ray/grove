-- In-app notifications. Every job notification is created by one trigger on compute_jobs, so
-- each status change notifies the right people no matter which code path changed it
-- (API action, pg_cron expiry, or a future agent). Users can only read their own rows and
-- mark them read.

create table public.notifications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    kind text not null check (kind in (
        'job_requested', 'job_booked', 'job_accepted', 'job_declined', 'job_started',
        'job_completed', 'job_stopped', 'job_failed', 'job_cancelled', 'job_missed', 'job_upcoming')),
    job_id uuid references public.compute_jobs(id) on delete cascade,
    title text not null check (length(title) between 1 and 120),
    body text not null default '' check (length(body) <= 500),
    created_at timestamptz not null default now(),
    read_at timestamptz
);
-- Each kind is sent at most once per job per person (status changes only move forward).
create unique index notifications_once_per_job on public.notifications(user_id, kind, job_id)
    where job_id is not null;
create index notifications_user_recent_idx on public.notifications(user_id, created_at desc, id desc);
create index notifications_unread_idx on public.notifications(user_id) where read_at is null;

alter table public.notifications enable row level security;
revoke all on public.notifications from public, anon, authenticated;
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;
create policy read_own_notifications on public.notifications for select to authenticated
    using (user_id = (select auth.uid()));
create policy mark_own_notifications_read on public.notifications for update to authenticated
    using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create function public.notify(p_user uuid, p_kind text, p_job uuid, p_title text, p_body text)
returns void
language sql security definer set search_path = ''
as $$
    insert into public.notifications (user_id, kind, job_id, title, body)
    select p_user, p_kind, p_job, left(p_title, 120), left(coalesce(p_body, ''), 500)
    where p_user is not null
    on conflict (user_id, kind, job_id) where job_id is not null do nothing;
$$;

create function public.notify_job_change()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
    job text := '"' || new.name || '"';
    device text;
    renter text;
begin
    if tg_op = 'UPDATE' and new.status is not distinct from old.status then
        return new;
    end if;
    select coalesce(d.name, 'your device') into device from public.host_devices d where d.id = new.host_device_id;
    device := coalesce(device, 'your device');
    select coalesce(nullif(trim(u.raw_user_meta_data->>'display_name'), ''), 'A renter') into renter
        from auth.users u where u.id = new.owner_id;

    if new.status = 'requested' then
        perform public.notify(new.host_id, 'job_requested', new.id, 'New job request',
            renter || ' wants to run ' || job || ' on ' || device || '. Accept or decline it from your dashboard.');
    elsif new.status = 'scheduled' then
        perform public.notify(new.owner_id, 'job_accepted', new.id, 'Job scheduled',
            job || ' was accepted and will start soon.');
        if tg_op = 'INSERT' then
            perform public.notify(new.host_id, 'job_booked', new.id, 'New job booked',
                renter || ' booked ' || job || ' on ' || device || '. Start it from your dashboard.');
        end if;
    elsif new.status = 'declined' then
        perform public.notify(new.owner_id, 'job_declined', new.id, 'Request declined',
            'The host declined ' || job || '. You were not charged. Try another host.');
    elsif new.status = 'running' then
        perform public.notify(new.owner_id, 'job_started', new.id, 'Job started', job || ' is now running.');
    elsif new.status = 'completed' and new.outcome_reason = 'renter_stopped' then
        perform public.notify(new.host_id, 'job_stopped', new.id, 'Job stopped by renter',
            'The renter stopped ' || job || '. You earn for the time it ran.');
    elsif new.status = 'completed' then
        perform public.notify(new.owner_id, 'job_completed', new.id, 'Job completed', job || ' finished.');
    elsif new.status = 'failed' then
        perform public.notify(new.owner_id, 'job_failed', new.id, 'Job failed',
            case when new.outcome_reason = 'host_side'
                 then job || ' failed on the host''s side. You will not be charged.'
                 else job || ' stopped because of an error in the job. You are charged for the time it ran.' end);
    elsif new.status = 'cancelled' then
        if new.outcome_reason = 'renter_cancelled' then
            perform public.notify(new.host_id, 'job_cancelled', new.id, 'Job cancelled',
                'The renter cancelled ' || job || '.');
        else
            perform public.notify(new.owner_id, 'job_cancelled', new.id, 'Job cancelled',
                case new.outcome_reason
                    when 'host_cancelled' then 'The host cancelled ' || job || '. You were not charged.'
                    when 'no_show' then 'The host did not start ' || job || ' in time. You were not charged. Try another host.'
                    when 'not_accepted' then 'No response from the host for ' || job || '. You were not charged. Try another host.'
                    else job || ' was cancelled.' end);
            if new.outcome_reason in ('no_show', 'not_accepted') then
                perform public.notify(new.host_id, 'job_missed', new.id, 'Job missed',
                    job || ' on ' || device || ' was cancelled because it was not '
                    || case when new.outcome_reason = 'no_show' then 'started' else 'answered' end
                    || ' in time.');
            end if;
        end if;
    end if;
    return new;
end $$;

create trigger notify_job_change after insert or update of status on public.compute_jobs
    for each row execute function public.notify_job_change();

-- Upcoming jobs: remind hosts shortly before a deadline would cancel the job.
create function public.remind_upcoming_jobs()
returns int
language sql security definer set search_path = ''
as $$
    with due as (
        insert into public.notifications (user_id, kind, job_id, title, body)
        select j.host_id, 'job_upcoming', j.id,
               case when j.status = 'requested' then 'Respond to a request' else 'Start a job soon' end,
               '"' || j.name || '" is cancelled automatically if you don''t '
               || case when j.status = 'requested' then 'accept it' else 'start it' end
               || ' within ' || greatest(1, ceil(extract(epoch from j.start_by - now()) / 60))::int || ' minutes.'
        from public.compute_jobs j
        where j.status in ('requested', 'scheduled') and j.host_id is not null
          and j.start_by > now() and j.start_by <= now() + interval '15 minutes'
        on conflict (user_id, kind, job_id) where job_id is not null do nothing
        returning 1
    )
    select count(*)::int from due;
$$;

do $$
declare f text;
begin
    foreach f in array array['notify(uuid,text,uuid,text,text)', 'notify_job_change()', 'remind_upcoming_jobs()'] loop
        execute format('revoke execute on function public.%s from public, anon, authenticated', f);
        execute format('grant execute on function public.%s to service_role', f);
    end loop;
end $$;

select cron.schedule('grove-job-reminders', '* * * * *', 'select public.remind_upcoming_jobs()');
