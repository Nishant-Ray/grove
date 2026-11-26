-- Renter-host messaging, available once a job has been accepted.
-- Reads and writes use the signed-in user's own JWT; row-level security decides access:
--   * only the job's renter and host can read or post;
--   * nothing is visible before the host accepts (accepted_at is set);
--   * posting is open while the job is scheduled or running, and for 14 days after it finishes.

create table public.messages (
    id uuid primary key default gen_random_uuid(),
    job_id uuid not null references public.compute_jobs(id) on delete cascade,
    sender_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
    body text not null check (length(trim(body)) between 1 and 2000),
    created_at timestamptz not null default now()
);
create index messages_job_time_idx on public.messages(job_id, created_at, id);

create table public.message_reads (
    job_id uuid not null references public.compute_jobs(id) on delete cascade,
    user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
    last_read_at timestamptz not null default now(),
    primary key (job_id, user_id)
);

-- True when the signed-in user is the renter or host of an accepted job.
create function public.in_job_thread(p_job uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
    select exists (
        select 1 from public.compute_jobs j
        where j.id = p_job and j.accepted_at is not null
          and (select auth.uid()) in (j.owner_id, j.host_id));
$$;

-- True when the thread is open for new messages.
create function public.job_thread_open(p_job uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
    select exists (
        select 1 from public.compute_jobs j
        where j.id = p_job and j.accepted_at is not null
          and (j.status in ('scheduled', 'running')
               or (j.status in ('completed', 'failed', 'cancelled')
                   and j.finished_at > now() - interval '14 days')));
$$;

alter table public.messages enable row level security;
revoke all on public.messages from public, anon, authenticated;
grant select on public.messages to authenticated;
grant insert (job_id, body) on public.messages to authenticated;
create policy read_job_messages on public.messages for select to authenticated
    using (public.in_job_thread(job_id));
create policy post_job_messages on public.messages for insert to authenticated
    with check (sender_id = (select auth.uid()) and public.in_job_thread(job_id) and public.job_thread_open(job_id));

alter table public.message_reads enable row level security;
revoke all on public.message_reads from public, anon, authenticated;
grant select on public.message_reads to authenticated;
-- PostgREST upserts (on_conflict + merge-duplicates) update every column in the payload,
-- so job_id needs UPDATE too; the policy still pins rows to the user's own accepted threads.
grant insert (job_id, last_read_at), update (job_id, last_read_at) on public.message_reads to authenticated;
create policy own_message_reads on public.message_reads for all to authenticated
    using (user_id = (select auth.uid()))
    with check (user_id = (select auth.uid()) and public.in_job_thread(job_id));

revoke execute on function public.in_job_thread(uuid) from public, anon;
revoke execute on function public.job_thread_open(uuid) from public, anon;
grant execute on function public.in_job_thread(uuid) to authenticated;
grant execute on function public.job_thread_open(uuid) to authenticated;

-- Thread header: who is on each side, for participants only.
create function public.job_participants(p_job uuid)
returns table (role text, renter_name text, host_name text, device_name text)
language sql stable security definer set search_path = ''
as $$
    select case when j.owner_id = (select auth.uid()) then 'renter' else 'host' end,
           coalesce(nullif(trim(r.raw_user_meta_data->>'display_name'), ''), 'Renter'),
           coalesce(nullif(trim(h.raw_user_meta_data->>'display_name'), ''), 'Host'),
           coalesce(d.name, 'Host device')
    from public.compute_jobs j
    left join auth.users r on r.id = j.owner_id
    left join auth.users h on h.id = j.host_id
    left join public.host_devices d on d.id = j.host_device_id
    where j.id = p_job and (select auth.uid()) in (j.owner_id, j.host_id);
$$;
revoke execute on function public.job_participants(uuid) from public, anon;
grant execute on function public.job_participants(uuid) to authenticated;

-- New-message notifications: one row per job per recipient, refreshed on each message,
-- so a busy thread never floods the bell but a new message after reading notifies again.
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in (
    'job_requested', 'job_booked', 'job_accepted', 'job_declined', 'job_started',
    'job_completed', 'job_stopped', 'job_failed', 'job_cancelled', 'job_missed', 'job_upcoming',
    'new_message'));

create function public.notify_new_message()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
    j public.compute_jobs;
    recipient uuid;
    sender text;
    preview text;
begin
    select * into j from public.compute_jobs where id = new.job_id;
    recipient := case when new.sender_id = j.owner_id then j.host_id else j.owner_id end;
    if recipient is null then return new; end if;
    select coalesce(nullif(trim(u.raw_user_meta_data->>'display_name'), ''),
                    case when new.sender_id = j.owner_id then 'The renter' else 'The host' end)
        into sender from auth.users u where u.id = new.sender_id;
    preview := sender || ': ' || case when length(new.body) > 140 then left(new.body, 137) || '...' else new.body end;
    insert into public.notifications (user_id, kind, job_id, title, body)
    values (recipient, 'new_message', j.id, left('New message about "' || j.name || '"', 120), left(preview, 500))
    on conflict (user_id, kind, job_id) where job_id is not null do update
        set body = excluded.body, title = excluded.title, created_at = now(), read_at = null;
    return new;
end $$;
revoke execute on function public.notify_new_message() from public, anon, authenticated;

create trigger notify_new_message after insert on public.messages
    for each row execute function public.notify_new_message();
