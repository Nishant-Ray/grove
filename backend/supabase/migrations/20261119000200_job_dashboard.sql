create table public.compute_jobs (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete cascade,
    name text not null check (length(trim(name)) between 1 and 200),
    status text not null default 'requested' check (status in
        ('requested','scheduled','running','completed','failed','cancelled')),
    progress smallint check (progress between 0 and 100),
    requested_at timestamptz not null default now(),
    scheduled_at timestamptz,
    started_at timestamptz,
    finished_at timestamptz,
    result_summary text,
    result_filename text
);
create index compute_jobs_owner_date_idx on public.compute_jobs(owner_id, requested_at desc, id desc);
alter table public.compute_jobs enable row level security;
revoke all on public.compute_jobs from public, anon, authenticated;
grant select on public.compute_jobs to authenticated;
grant select, insert, update, delete on public.compute_jobs to service_role;
create policy read_own_jobs on public.compute_jobs for select to authenticated
    using (owner_id = (select auth.uid()));

insert into storage.buckets (id, name, public) values ('grove-job-results','grove-job-results',false);
create policy read_own_job_result on storage.objects for select to authenticated
using (bucket_id = 'grove-job-results' and exists (
    select 1 from public.compute_jobs j where j.id::text || '/result' = storage.objects.name
    and j.owner_id = (select auth.uid()) and j.result_filename is not null
    and j.status in ('completed','failed','cancelled')
));
