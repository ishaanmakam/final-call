-- =====================================================================
-- Cron heartbeat and ops alerting. Spec: docs/CONTRACT.md "Server jobs" (Heartbeat);
-- decisions P2-* in docs/DECISIONS.md. Owner: night-1 agent P2.
--
-- Problem: a job that stops running (pg_cron unscheduled, Vault secret missing, the Edge Function
-- down) is invisible: instances stop opening and closing, pushes stop, and nobody is told.
--
-- Mechanics:
--   * job_heartbeats: one row per job, written by _heartbeat(job, ok, error) at the end of every run
--     (started = transaction start, finished = clock_timestamp()). pg_cron runs each job in its own
--     transaction, so a run that raised would roll its heartbeat back with it; the wrappers below
--     therefore catch the body's error, record it (heartbeat last_error + a job_failures row) and
--     return normally. The error is still visible: job_health.recent_failures counts it.
--   * Each job function is wrapped the way N1 wrapped tick_instances: the current body is renamed
--     (`_<job>_vN`) and a new function of the same signature calls it, then beats. Signatures,
--     defaults, return types and grants are unchanged, so the pg_cron schedules keep working.
--   * The push-outbox Edge Function beats through record_push_heartbeat(ok, error) (service role).
--   * _job_health_at(p_now) / view job_health: expected cadence per job, overdue when the last ok
--     is older than 3x the cadence (a job that never ran is `never_ran`, not overdue: a fresh
--     deploy must not alert for the daily purges before 03:23 UTC), recent_failures = job_failures
--     rows of the last hour (tick_instances' sub-jobs, place_timeouts, count towards tick).
--   * ops_settings: one row; ops_user_id names who gets the alerts (null = nobody; set it with
--     `update public.ops_settings set ops_user_id = '<auth user id>'`).
--   * check_job_health(p_now): for every job that is overdue or has >= 5 failures in the last
--     hour, one notification_outbox row of kind 'ops_alert' for the ops user, at most one per job
--     per hour. Scheduled every 10 minutes (guarded like the other cron jobs).
--   Everything here is service-only; RLS is on and nothing is granted to anon/authenticated.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------

create table public.job_heartbeats (
  job text primary key,
  last_started_at timestamptz null,
  last_finished_at timestamptz null,
  last_ok_at timestamptz null,
  last_error text null,
  runs bigint not null default 0
);
alter table public.job_heartbeats enable row level security;
revoke all on public.job_heartbeats from public, anon, authenticated;
grant all on public.job_heartbeats to service_role;

create table public.ops_settings (
  one boolean primary key default true check (one),
  ops_user_id uuid null references public.profiles (id) on delete set null
);
alter table public.ops_settings enable row level security;
revoke all on public.ops_settings from public, anon, authenticated;
grant all on public.ops_settings to service_role;
insert into public.ops_settings (one, ops_user_id) values (true, null);

-- ---------------------------------------------------------------------
-- The beat
-- ---------------------------------------------------------------------

create function public._heartbeat(p_job text, p_ok boolean, p_error text) returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  insert into public.job_heartbeats as h (job, last_started_at, last_finished_at, last_ok_at, last_error, runs)
  values (p_job, now(), clock_timestamp(), case when p_ok then clock_timestamp() end, case when p_ok then null else coalesce(p_error, 'unknown error') end, 1)
  on conflict (job) do update
     set last_started_at = excluded.last_started_at,
         last_finished_at = excluded.last_finished_at,
         last_ok_at = coalesce(excluded.last_ok_at, h.last_ok_at),
         last_error = excluded.last_error,
         runs = h.runs + 1;
end;
$$;

-- The Edge Function's beat (service role key; the function never sees a user).
create function public.record_push_heartbeat(p_ok boolean, p_error text default null) returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._heartbeat('push_outbox', coalesce(p_ok, false), p_error);
end;
$$;

-- ---------------------------------------------------------------------
-- Wrapped jobs (rename the current body, re-create the public name around it)
-- ---------------------------------------------------------------------

alter function public.tick_instances(timestamptz) rename to _tick_instances_v2;
create function public.tick_instances(p_now timestamptz default now()) returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  begin
    perform public._tick_instances_v2(p_now);
  exception when others then
    insert into public.job_failures (job, group_id, error) values ('tick_instances', null, sqlstate || ': ' || sqlerrm);
    perform public._heartbeat('tick_instances', false, sqlstate || ': ' || sqlerrm);
    return;
  end;
  perform public._heartbeat('tick_instances', true, null);
end;
$$;

alter function public.generate_instances(int, timestamptz) rename to _generate_instances_v1;
create function public.generate_instances(p_days_ahead int default 7, p_now timestamptz default now()) returns int
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_n int;
begin
  begin
    v_n := public._generate_instances_v1(p_days_ahead, p_now);
  exception when others then
    insert into public.job_failures (job, group_id, error) values ('generate_instances', null, sqlstate || ': ' || sqlerrm);
    perform public._heartbeat('generate_instances', false, sqlstate || ': ' || sqlerrm);
    return 0;
  end;
  perform public._heartbeat('generate_instances', true, null);
  return v_n;
end;
$$;

alter function public.settle_due_groups(timestamptz) rename to _settle_due_groups_v1;
create function public.settle_due_groups(p_now timestamptz default now()) returns int
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_n int;
begin
  begin
    v_n := public._settle_due_groups_v1(p_now);
  exception when others then
    insert into public.job_failures (job, group_id, error) values ('settle_due_groups', null, sqlstate || ': ' || sqlerrm);
    perform public._heartbeat('settle_due_groups', false, sqlstate || ': ' || sqlerrm);
    return 0;
  end;
  perform public._heartbeat('settle_due_groups', true, null);
  return v_n;
end;
$$;

alter function public.purge_old_locations(timestamptz) rename to _purge_old_locations_v1;
create function public.purge_old_locations(p_now timestamptz default now()) returns int
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_n int;
begin
  begin
    v_n := public._purge_old_locations_v1(p_now);
  exception when others then
    insert into public.job_failures (job, group_id, error) values ('purge_old_locations', null, sqlstate || ': ' || sqlerrm);
    perform public._heartbeat('purge_old_locations', false, sqlstate || ': ' || sqlerrm);
    return 0;
  end;
  perform public._heartbeat('purge_old_locations', true, null);
  return v_n;
end;
$$;

alter function public.purge_old_outbox(timestamptz) rename to _purge_old_outbox_v1;
create function public.purge_old_outbox(p_now timestamptz default now()) returns int
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_n int;
begin
  begin
    v_n := public._purge_old_outbox_v1(p_now);
  exception when others then
    insert into public.job_failures (job, group_id, error) values ('purge_old_outbox', null, sqlstate || ': ' || sqlerrm);
    perform public._heartbeat('purge_old_outbox', false, sqlstate || ': ' || sqlerrm);
    return 0;
  end;
  perform public._heartbeat('purge_old_outbox', true, null);
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------
-- Health
-- ---------------------------------------------------------------------

create function public._job_health_at(p_now timestamptz default now())
returns table (
  job text,
  expected_every interval,
  last_ok_at timestamptz,
  last_error text,
  runs bigint,
  overdue boolean,
  never_ran boolean,
  recent_failures int
)
language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  with expected (job, expected_every) as (
    values ('tick_instances', interval '1 minute'),
           ('generate_instances', interval '15 minutes'),
           ('settle_due_groups', interval '60 minutes'),
           ('purge_old_locations', interval '1 day'),
           ('purge_old_outbox', interval '1 day'),
           ('push_outbox', interval '1 minute')
  )
  select e.job,
         e.expected_every,
         h.last_ok_at,
         h.last_error,
         coalesce(h.runs, 0) as runs,
         -- ran at least once, and no success inside 3 cadences; a job that has only ever failed
         -- is overdue at once (a missing Vault secret must not hide until the hour is up)
         (h.job is not null
          and (h.last_ok_at is null or h.last_ok_at < coalesce(p_now, now()) - 3 * e.expected_every)) as overdue,
         (h.job is null) as never_ran,
         (select count(*)::int
            from public.job_failures f
           where f.failed_at > coalesce(p_now, now()) - interval '1 hour'
             and f.failed_at <= coalesce(p_now, now())
             and (f.job = e.job or (e.job = 'tick_instances' and f.job = 'place_timeouts'))) as recent_failures
    from expected e
    left join public.job_heartbeats h on h.job = e.job
   order by e.job;
$$;

create view public.job_health with (security_invoker = false) as
  select job, expected_every, last_ok_at, last_error, runs, overdue, never_ran, recent_failures
    from public._job_health_at(now());
revoke all on public.job_health from public, anon, authenticated;
grant select on public.job_health to service_role;

-- One outbox row per unhealthy job per hour for the ops user. Returns how many were inserted.
create function public.check_job_health(p_now timestamptz default now()) returns int
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_ops uuid;
  v_job record;
  v_reason text;
  v_n int := 0;
begin
  select ops_user_id into v_ops from public.ops_settings;
  if v_ops is null then
    return 0;
  end if;
  for v_job in select * from public._job_health_at(v_now) where overdue or recent_failures >= 5 loop
    continue when exists (
      select 1 from public.notification_outbox o
       where o.kind = 'ops_alert' and o.user_id = v_ops
         and o.payload->>'job' = v_job.job
         and o.created_at > v_now - interval '1 hour'
    );
    v_reason := concat_ws('; ',
      case when v_job.overdue then
        format('overdue: last ok %s (expected every %s)',
               coalesce(to_char(v_job.last_ok_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"'), 'never'),
               v_job.expected_every::text)
      end,
      case when v_job.recent_failures >= 5 then format('%s failures in the last hour', v_job.recent_failures) end);
    insert into public.notification_outbox (user_id, kind, payload)
    values (v_ops, 'ops_alert', jsonb_build_object(
      'job', v_job.job,
      'reason', v_reason,
      'message', format('Final Call job %s needs a look: %s', v_job.job, v_reason),
      'overdue', v_job.overdue,
      'last_ok_at', v_job.last_ok_at,
      'last_error', v_job.last_error,
      'recent_failures', v_job.recent_failures,
      'url', '/settings'
    ));
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------
-- Grants: service role only, everywhere
-- ---------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public._heartbeat(text, boolean, text)',
    'public.record_push_heartbeat(boolean, text)',
    'public._job_health_at(timestamptz)',
    'public.check_job_health(timestamptz)',
    'public.tick_instances(timestamptz)',
    'public._tick_instances_v2(timestamptz)',
    'public.generate_instances(int, timestamptz)',
    'public._generate_instances_v1(int, timestamptz)',
    'public.settle_due_groups(timestamptz)',
    'public._settle_due_groups_v1(timestamptz)',
    'public.purge_old_locations(timestamptz)',
    'public._purge_old_locations_v1(timestamptz)',
    'public.purge_old_outbox(timestamptz)',
    'public._purge_old_outbox_v1(timestamptz)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- Schedule (no-op without pg_cron, like 20261107000400_cron.sql)
-- ---------------------------------------------------------------------
do $outer$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('check-job-health', '*/10 * * * *',
      $cmd$select public.check_job_health()$cmd$);
  end if;
end;
$outer$;
