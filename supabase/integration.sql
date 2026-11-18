-- Run once AFTER schema.sql. Safe to rerun.
alter table public.pilot_submissions add column if not exists request_hash text;
grant all on public.pilot_submissions to service_role;

-- Atomic reservations: basic pilot-wide and per-email quotas, plus retry protection.
-- Public keys cannot execute this function. It is used only by the Edge Function.
create or replace function public.reserve_pilot_submission(
  p_id uuid, p_hash text, p_kind text, p_email text, p_name text,
  p_details jsonb, p_deadline timestamptz, p_timezone text
) returns text language plpgsql security invoker set search_path = public as $$
declare existing public.pilot_submissions%rowtype;
begin
  perform pg_advisory_xact_lock(704102);
  select * into existing from public.pilot_submissions where id = p_id;
  if found then
    if existing.request_hash is distinct from p_hash then raise exception 'PILOT_CONFLICT'; end if;
    return existing.status;
  end if;
  if (select count(*) from public.pilot_submissions where created_at > now() - interval '1 day') >= 50
    or (select count(*) from public.pilot_submissions where email = p_email and created_at > now() - interval '1 hour') >= 5
  then raise exception 'PILOT_LIMIT'; end if;
  insert into public.pilot_submissions(id,kind,status,email,name,details,requested_deadline,timezone,request_hash)
  values(p_id,p_kind,'receiving',p_email,p_name,p_details,p_deadline,p_timezone,p_hash);
  return 'receiving';
end;
$$;
revoke all on function public.reserve_pilot_submission(uuid,text,text,text,text,jsonb,timestamptz,text) from public, anon, authenticated;
grant execute on function public.reserve_pilot_submission(uuid,text,text,text,text,jsonb,timestamptz,text) to service_role;
