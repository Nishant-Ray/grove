-- Reviews and ratings. After a completed job the renter and the host can each review the other once,
-- within 14 days. Reviews are written with the user's own JWT: a trigger derives who is being
-- reviewed from the job (clients only send job_id, rating and comment) and refuses anyone who
-- isn't a participant of a completed, recent job. Reviews are public to signed-in users.

create table public.reviews (
    id uuid primary key default gen_random_uuid(),
    job_id uuid not null references public.compute_jobs(id) on delete cascade,
    reviewer_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
    reviewee_id uuid not null references auth.users(id) on delete cascade,
    reviewer_role text not null check (reviewer_role in ('renter', 'host')),
    rating smallint not null check (rating between 1 and 5),
    comment text not null default '' check (length(comment) <= 1000),
    created_at timestamptz not null default now(),
    unique (job_id, reviewer_id),
    check (reviewer_id <> reviewee_id)
);
create index reviews_reviewee_idx on public.reviews(reviewee_id, created_at desc);

create function public.prepare_review()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
    j public.compute_jobs;
begin
    select * into j from public.compute_jobs where id = new.job_id;
    if not found or new.reviewer_id not in (j.owner_id, coalesce(j.host_id, j.owner_id)) or j.host_id is null then
        raise exception 'NOT_REVIEWABLE' using errcode = '42501', detail = 'not a participant';
    end if;
    if j.status <> 'completed' then
        raise exception 'NOT_REVIEWABLE' using errcode = '42501', detail = 'job not completed';
    end if;
    if j.finished_at < now() - interval '14 days' then
        raise exception 'NOT_REVIEWABLE' using errcode = '42501', detail = 'review window closed';
    end if;
    new.reviewer_role := case when new.reviewer_id = j.owner_id then 'renter' else 'host' end;
    new.reviewee_id := case when new.reviewer_id = j.owner_id then j.host_id else j.owner_id end;
    new.comment := trim(coalesce(new.comment, ''));
    new.created_at := now();
    return new;
end $$;
revoke execute on function public.prepare_review() from public, anon, authenticated;

create trigger prepare_review before insert on public.reviews
    for each row execute function public.prepare_review();

alter table public.reviews enable row level security;
revoke all on public.reviews from public, anon, authenticated;
grant select on public.reviews to authenticated;
grant insert (job_id, rating, comment) on public.reviews to authenticated;
create policy read_reviews on public.reviews for select to authenticated using (true);
create policy write_own_reviews on public.reviews for insert to authenticated
    with check (reviewer_id = (select auth.uid()));

-- Reputation ------------------------------------------------------------------------------------
-- Ratings people received as host and as renter, plus objective host reliability: of the jobs a
-- host accepted, how many they completed rather than no-showed, cancelled or failed on their side.
create function public.reputation(p_users uuid[])
returns table (
    user_id uuid, display_name text,
    host_rating numeric, host_reviews int, renter_rating numeric, renter_reviews int,
    jobs_completed int, no_shows int, host_cancels int, host_failures int, completion_rate numeric
)
language sql stable security definer set search_path = ''
as $$
    select u.id,
           nullif(trim(u.raw_user_meta_data->>'display_name'), ''),  -- callers choose the fallback label
           (select round(avg(r.rating), 2) from public.reviews r where r.reviewee_id = u.id and r.reviewer_role = 'renter'),
           (select count(*)::int from public.reviews r where r.reviewee_id = u.id and r.reviewer_role = 'renter'),
           (select round(avg(r.rating), 2) from public.reviews r where r.reviewee_id = u.id and r.reviewer_role = 'host'),
           (select count(*)::int from public.reviews r where r.reviewee_id = u.id and r.reviewer_role = 'host'),
           s.completed, s.no_shows, s.cancels, s.failures,
           case when s.completed + s.no_shows + s.cancels + s.failures > 0
                then round(s.completed::numeric / (s.completed + s.no_shows + s.cancels + s.failures), 3) end
    from auth.users u
    cross join lateral (
        select count(*) filter (where j.status = 'completed')::int as completed,
               count(*) filter (where j.outcome_reason = 'no_show')::int as no_shows,
               count(*) filter (where j.outcome_reason = 'host_cancelled')::int as cancels,
               count(*) filter (where j.outcome_reason = 'host_side')::int as failures
        from public.compute_jobs j where j.host_id = u.id
    ) s
    where u.id = any(p_users);
$$;
revoke execute on function public.reputation(uuid[]) from public, anon;
grant execute on function public.reputation(uuid[]) to authenticated, service_role;

-- Recent reviews someone received, with the reviewer's display name.
create function public.reviews_received(p_user uuid, p_limit int default 20)
returns table (id uuid, job_id uuid, reviewer_name text, reviewer_role text, rating smallint, comment text, created_at timestamptz)
language sql stable security definer set search_path = ''
as $$
    select r.id, r.job_id, coalesce(nullif(trim(u.raw_user_meta_data->>'display_name'), ''), 'Grove member'),
           r.reviewer_role, r.rating, r.comment, r.created_at
    from public.reviews r left join auth.users u on u.id = r.reviewer_id
    where r.reviewee_id = p_user
    order by r.created_at desc, r.id desc
    limit least(greatest(p_limit, 1), 50);
$$;
revoke execute on function public.reviews_received(uuid, int) from public, anon;
grant execute on function public.reviews_received(uuid, int) to authenticated;

-- Recommendations now include each host's rating and reliability inputs.
drop function public.recommend_hosts(uuid, text, int, text, text);
create function public.recommend_hosts(p_actor uuid, p_priority text, p_min_vram int,
                                       p_gpu_model text, p_renter_zip text)
returns table (
    device_id uuid, device_name text, host_id uuid, host_name text, gpu_model text, gpu_label text, vram_gb int,
    base_rate_usd_hr numeric, power_kw numeric, usd_per_kwh numeric, green_energy boolean,
    state text, distance_miles numeric, priority_multiplier numeric, host_share numeric,
    floor_margin numeric, reserve_multiplier numeric,
    host_rating numeric, host_reviews int, jobs_completed int, completion_rate numeric
)
language plpgsql stable security definer set search_path = ''
as $$
declare
    renter public.zip3_centroids;
begin
    if not exists (select 1 from public.priority_levels where id = p_priority) then
        raise exception 'UNKNOWN_PRIORITY';
    end if;
    if not exists (select 1 from public.grove_settings) then
        raise exception 'PRICING_UNAVAILABLE';
    end if;
    select * into renter from public.zip3_centroids where zip3 = left(p_renter_zip, 3);
    return query
    with candidates as (
        select d.id, d.name, d.owner_id, g.gpu_model, g.label, v.vram, g.base_rate_usd_hr,
               g.power_kw + s.system_overhead_kw as power_kw,
               coalesce(d.usd_per_kwh_override, st.usd_per_kwh, us.usd_per_kwh) as usd_per_kwh,
               d.green_energy, z.state::text as state,
               case when renter.zip3 is not null and c.zip3 is not null then
                   round((3958.8 * 2 * asin(sqrt(
                       power(sin(radians(c.lat - renter.lat) / 2), 2) +
                       cos(radians(renter.lat)) * cos(radians(c.lat)) *
                       power(sin(radians(c.lng - renter.lng) / 2), 2))))::numeric, 1)
               end as distance,
               p.multiplier, s.host_share, s.floor_margin, s.reserve_multiplier
        from public.host_devices d
        join public.gpu_rates g on g.gpu_model = d.gpu_model and g.active
        cross join public.grove_settings s
        join public.priority_levels p on p.id = p_priority
        cross join lateral (select coalesce(case when (d.specs->>'vram_gb') ~ '^[0-9]{1,6}$'
                                                 then (d.specs->>'vram_gb')::int end, g.vram_gb) as vram) v
        left join public.zip3_ranges z on left(d.zip, 3) between z.zip3_start and z.zip3_end
        left join public.electricity_rates st on st.state = z.state
        left join public.electricity_rates us on us.state = 'US'
        left join public.zip3_centroids c on c.zip3 = left(d.zip, 3)
        where d.availability = 'available'
          and d.owner_id <> p_actor
          and d.last_seen_at > now() - make_interval(mins => s.heartbeat_minutes)
          and v.vram >= coalesce(p_min_vram, 0)
          and (p_gpu_model is null or d.gpu_model = p_gpu_model)
          and not exists (select 1 from public.compute_jobs j where j.host_device_id = d.id
                          and j.status in ('requested','scheduled','running'))
        order by g.base_rate_usd_hr, d.id
        limit 200
    )
    select c.id, c.name, c.owner_id, coalesce(r.display_name, 'Grove host'), c.gpu_model, c.label, c.vram, c.base_rate_usd_hr,
           c.power_kw, c.usd_per_kwh, c.green_energy, c.state, c.distance, c.multiplier, c.host_share,
           c.floor_margin, c.reserve_multiplier, r.host_rating, r.host_reviews, r.jobs_completed, r.completion_rate
    from candidates c
    join public.reputation((select array_agg(distinct owner_id) from candidates)) r on r.user_id = c.owner_id
    order by c.base_rate_usd_hr, c.id;
end $$;
revoke execute on function public.recommend_hosts(uuid, text, int, text, text) from public, anon, authenticated;
grant execute on function public.recommend_hosts(uuid, text, int, text, text) to service_role;

-- Notifications ------------------------------------------------------------------------------------
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in (
    'job_requested', 'job_booked', 'job_accepted', 'job_declined', 'job_started',
    'job_completed', 'job_stopped', 'job_failed', 'job_cancelled', 'job_missed', 'job_upcoming',
    'new_message', 'review_received'));

create function public.notify_review()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
    reviewer text;
    job text;
begin
    select coalesce(nullif(trim(raw_user_meta_data->>'display_name'), ''),
                    case new.reviewer_role when 'renter' then 'The renter' else 'The host' end)
        into reviewer from auth.users where id = new.reviewer_id;
    select name into job from public.compute_jobs where id = new.job_id;
    perform public.notify(new.reviewee_id, 'review_received', new.job_id, 'New review',
        reviewer || ' rated you ' || new.rating || ' out of 5 for "' || job || '"'
        || case when new.comment <> '' then ': ' || case when length(new.comment) > 140
                then left(new.comment, 137) || '...' else new.comment end else '.' end);
    return new;
end $$;
revoke execute on function public.notify_review() from public, anon, authenticated;

create trigger notify_review after insert on public.reviews
    for each row execute function public.notify_review();
