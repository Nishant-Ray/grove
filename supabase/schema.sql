-- Future integration scaffold. Run only when a Supabase project is ready.
-- No public insert/read policies: a validated, rate-limited Edge Function owns writes.
create table if not exists public.pilot_submissions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('job', 'host')),
  status text not null default 'pending_review',
  email text not null,
  name text not null,
  details jsonb not null default '{}'::jsonb,
  requested_deadline timestamptz,
  timezone text,
  file_path text
);
alter table public.pilot_submissions enable row level security;
revoke all on public.pilot_submissions from anon, authenticated;
-- Private bucket. MIME, content, file size, and extension checks must also run server-side.
insert into storage.buckets (id, name, public, file_size_limit)
values ('pilot-workloads', 'pilot-workloads', false, 20971520)
on conflict (id) do nothing;
