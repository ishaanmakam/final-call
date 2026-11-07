-- =====================================================================
-- Instances, check-ins, freezes, results, reviews.
-- Spec: docs/CONTRACT.md "Rules" + docs/DECISIONS.md D1-D8. Owner: instances agent.
--
-- Contract additions (reported to the lead):
--   pact_instances.deadline_soon_sent_at  marks the one-time 'deadline_soon' fan-out
--   checkins.client_attempt_id            idempotent client retries, unique per (user_id, client_attempt_id)
--   check_in(..., p_client_attempt_id uuid default null)   extra trailing param
--   reviews: at most one 'open' review per (instance_id, subject_user_id) (partial unique index)
--   Deterministic internal cores, revoked from clients (tests and the RPCs call them):
--     check_in_at, declare_freeze_at, open_review_at, cast_vote_at   (take p_user + p_now)
--   generate_instances also revives instances voided by a pause once the pact is resumed
--   (only if still in the future and untouched).
--   reviews: at most one appeal and at most one challenge per (instance_id, subject_user_id), ever
--     (unique index reviews_one_per_kind; open_review raises 23514 first).
--   pact_participant_places: place history. A participant's first place is effective at once;
--     every later change (incl. a rejoin with another place) is effective 12 hours after the
--     request, and replaces any still-pending change. Check-ins are judged against the latest
--     place with effective_from <= the instance's window_open_at. pact_participants.place_*
--     stay the requested (current or pending) place the app shows.
--   Instance roster (_instance_participants): before close, participants with
--     joined_at <= window_open_at and (left_at is null or left_at > window_open_at); once an
--     instance has closed, exactly the users holding a result row (a later rejoin, which resets
--     joined_at, cannot rewrite it). Used for results, check-ins, freezes, review openers,
--     review notifications and voters.
--   Voters (_review_voters): the roster minus the subject, minus anyone who has left the group
--     (they cannot vote, are not counted as eligible, and votes they cast before leaving are not
--     counted, also when settlement defaults the review).
--   leave_group (foundation) refuses while the caller is on the roster of an instance that is
--     open, or 'scheduled' with window_open_at <= now() < deadline_at (cron lag), paused pacts
--     included (a resume before the tick voids it would open it with the leaver on the roster): 23514.
--   pact_instances.settled_at: stamped by settlement (20261107000300) when it marks the instance
--     'settled'. Reviews: closed instances as before; on a settled instance only a CHALLENGE, and
--     only of a result whose decided_at > settled_at (changed by a late offline tap after
--     settlement). Such challenges can be voted on, and the next settlement's default_open_reviews
--     resolves them (deadline_at < p_until) before billing, so their correction is billed then.
--   A late tap that leaves fewer than 2 active participants does NOT void a closed/settled
--     instance: the payout plan is already empty (money refunded by the correction), and keeping
--     the instance closed keeps the late result challengeable (voiding would make a forged
--     capture time unreviewable, and an accepted challenge restores the payout).
--   tick_instances: each instance's open / deadline_soon / close runs in its own subtransaction;
--     a failure is logged to job_failures (job 'tick_instances', the pact's group) and the tick
--     carries on (the instance is retried next tick). Lock order: see 20261107000300.
--   join_pact (foundation) refuses joins, rejoins and place changes while any instance of the
--     pact is open or has window_open_at <= now() and is not closed/settled/voided: 23514.
--   check_in: at most 20 check-ins per user per instance (23514; idempotent retries don't count).
--     client_captured_at is only compared with server time off the on-time path. Late offline
--     check-ins (captured inside the window) are accepted until deadline_at + 24 hours, also on
--     settled instances (result recomputed, apply_instance_correction called); later -> 22023.
--   Late rule: only a late in_fence check-in makes a result unverified.
--   default_open_reviews stamps resolved_at / decided_at with greatest(p_until, opened_at).
--
-- Time: local date + local time are converted with _local_to_utc. Nonexistent local times
-- (spring-forward gap) shift forward by the gap (02:30 -> 03:30 PDT); ambiguous local times
-- (fall-back) take the earlier instant (01:30 -> 01:30 PDT). If both window ends fall in a gap
-- so the shifted open is not before the deadline, the window keeps its nominal length ending
-- at the deadline.
-- =====================================================================

alter table public.pact_instances add column deadline_soon_sent_at timestamptz null;
alter table public.pact_instances add column settled_at timestamptz null;  -- set by settlement (20261107000300)
alter table public.checkins add column client_attempt_id uuid null;

create unique index checkins_user_attempt_uniq on public.checkins (user_id, client_attempt_id)
  where client_attempt_id is not null;
create unique index reviews_one_open_per_subject on public.reviews (instance_id, subject_user_id)
  where status = 'open';
create index reviews_open_idx on public.reviews (instance_id) where status = 'open';
create unique index reviews_one_per_kind on public.reviews (instance_id, subject_user_id, kind);

-- Place history (see header). Written only by join_pact (SECURITY DEFINER).
create table public.pact_participant_places (
  pact_id uuid not null,
  user_id uuid not null,
  lat float8 not null check (lat between -90 and 90),
  lng float8 not null check (lng between -180 and 180),
  radius_m int not null check (radius_m between 25 and 500),
  label text null check (label is null or char_length(label) <= 80),
  effective_from timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (pact_id, user_id, effective_from),
  foreign key (pact_id, user_id) references public.pact_participants (pact_id, user_id) on delete cascade
);
alter table public.pact_participant_places enable row level security;
create policy pact_participant_places_select on public.pact_participant_places for select to authenticated
  using (public.is_pact_group_member(pact_id));
revoke all on public.pact_participant_places from public, anon, authenticated;
grant select on public.pact_participant_places to authenticated;
grant all on public.pact_participant_places to service_role;

-- Participants that predate this migration: their place has been in effect since they joined.
insert into public.pact_participant_places (pact_id, user_id, lat, lng, radius_m, label, effective_from)
select pact_id, user_id, place_lat, place_lng, place_radius_m, place_label, joined_at from public.pact_participants;

-- ---------------------------------------------------------------------
-- Pure helpers
-- ---------------------------------------------------------------------

-- Wall-clock p_local in zone p_tz -> instant. See header for gap/ambiguity rules.
-- Independent of the session TimeZone.
create function public._local_to_utc(p_local timestamp, p_tz text) returns timestamptz
language plpgsql stable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_off_before interval;
  v_off_after interval;
  v_c1 timestamptz;
  v_c2 timestamptz;
  v_ok1 boolean;
  v_ok2 boolean;
begin
  -- UTC offsets (local minus UTC) one day before and one day after
  v_off_before := (((p_local - interval '1 day') at time zone 'UTC') at time zone p_tz) - (p_local - interval '1 day');
  v_off_after  := (((p_local + interval '1 day') at time zone 'UTC') at time zone p_tz) - (p_local + interval '1 day');
  v_c1 := (p_local - v_off_before) at time zone 'UTC';
  v_c2 := (p_local - v_off_after) at time zone 'UTC';
  v_ok1 := (v_c1 at time zone p_tz) = p_local;
  v_ok2 := (v_c2 at time zone p_tz) = p_local;
  if v_ok1 and v_ok2 then
    return least(v_c1, v_c2);            -- ambiguous: earlier instant
  elsif v_ok1 then
    return v_c1;
  elsif v_ok2 then
    return v_c2;
  end if;
  return v_c1;                           -- gap: pre-transition offset moves the clock forward by the gap
end;
$$;

-- Haversine distance in metres, written to mirror packages/rules distanceMeters operation for operation.
create function public._haversine_m(p_lat1 float8, p_lng1 float8, p_lat2 float8, p_lng2 float8) returns float8
language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$
  select 2 * 6371008.8::float8 * asin(least(1::float8, sqrt(
           power(sin((((p_lat2 - p_lat1) * pi()) / 180) / 2), 2)
         + cos((p_lat1 * pi()) / 180) * cos((p_lat2 * pi()) / 180)
           * power(sin((((p_lng2 - p_lng1) * pi()) / 180) / 2), 2))))
$$;

-- The instance roster. Until the instance closes: joined no later than the window opened and
-- not left before it. Once closed (closed_at set): frozen as the users holding a result, so
-- leaving and rejoining afterwards (which resets joined_at) cannot change it.
create function public._instance_participants(p_instance uuid) returns setof uuid
language sql stable
set search_path = pg_catalog, public, pg_temp
as $$
  select u from (
    select r.user_id as u
      from public.pact_instances i
      join public.results r on r.instance_id = i.id
     where i.id = p_instance and i.closed_at is not null
    union all
    select pp.user_id
      from public.pact_instances i
      join public.pact_participants pp on pp.pact_id = i.pact_id
     where i.id = p_instance and i.closed_at is null
       and pp.joined_at <= i.window_open_at
       and (pp.left_at is null or pp.left_at > i.window_open_at)
  ) x
  order by u
$$;

create function public._on_instance_roster(p_instance uuid, p_user uuid) returns boolean
language sql stable
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (select 1 from public._instance_participants(p_instance) u where u = p_user)
$$;

-- Eligible voters of a review: the instance roster minus the subject, limited to current members
-- of the pact's group (a challenge's opener may vote).
create function public._review_voters(p_review uuid) returns setof uuid
language sql stable
set search_path = pg_catalog, public, pg_temp
as $$
  select u.uid
    from public.reviews r
    join public.pact_instances i on i.id = r.instance_id
    join public.pacts p on p.id = i.pact_id
    cross join lateral public._instance_participants(r.instance_id) as u(uid)
   where r.id = p_review and u.uid <> r.subject_user_id
     and exists (select 1 from public.group_members m
                  where m.group_id = p.group_id and m.user_id = u.uid and m.left_at is null)
   order by u.uid
$$;

-- The place a check-in for an instance opening at p_at is judged against: the latest place in
-- effect at p_at. Fallbacks (unreachable for rows written by join_pact, whose first place is in
-- effect from the original join): the earliest recorded place, then pact_participants.
create function public._place_at(p_pact uuid, p_user uuid, p_at timestamptz,
  out lat float8, out lng float8, out radius_m int)
language plpgsql stable
set search_path = pg_catalog, public, pg_temp
as $$
begin
  select h.lat, h.lng, h.radius_m into lat, lng, radius_m
    from public.pact_participant_places h
   where h.pact_id = p_pact and h.user_id = p_user and h.effective_from <= p_at
   order by h.effective_from desc
   limit 1;
  if found then
    return;
  end if;
  select h.lat, h.lng, h.radius_m into lat, lng, radius_m
    from public.pact_participant_places h
   where h.pact_id = p_pact and h.user_id = p_user
   order by h.effective_from
   limit 1;
  if found then
    return;
  end if;
  select pp.place_lat, pp.place_lng, pp.place_radius_m into lat, lng, radius_m
    from public.pact_participants pp
   where pp.pact_id = p_pact and pp.user_id = p_user;
end;
$$;

-- Common outbox payload (keys per supabase/functions/README.md), nulls stripped.
create function public._instance_payload(p_instance uuid, p_user uuid) returns jsonb
language sql stable
set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_strip_nulls(jsonb_build_object(
           'instance_id', i.id,
           'pact_id', p.id,
           'group_id', p.group_id,
           'pact_title', p.title,
           'place_label', pp.place_label,
           'local_date', i.local_date,
           'window_open_at', i.window_open_at,
           'deadline_local', p.deadline_local::text,
           'deadline_at', i.deadline_at,
           'tz', p.tz,
           'stake_cents', p.stake_cents))
    from public.pact_instances i
    join public.pacts p on p.id = i.pact_id
    left join public.pact_participants pp on pp.pact_id = p.id and pp.user_id = p_user
   where i.id = p_instance
$$;

-- Result from check-ins and freezes alone (CONTRACT "Result per participant"), before the
-- instance-level void rule and before review overrides.
create function public._base_result(p_instance uuid, p_user uuid,
  out status public.result_status, out first_success_at timestamptz)
language plpgsql stable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_deadline timestamptz;
begin
  select deadline_at into v_deadline from public.pact_instances where id = p_instance;
  if exists (select 1 from public.freezes f where f.instance_id = p_instance and f.user_id = p_user) then
    status := 'frozen';
    return;
  end if;
  select min(c.server_received_at) into first_success_at
    from public.checkins c
   where c.instance_id = p_instance and c.user_id = p_user
     and c.verdict = 'in_fence' and c.server_received_at <= v_deadline;
  if first_success_at is not null then
    status := 'success';
  elsif exists (
    select 1 from public.checkins c
     where c.instance_id = p_instance and c.user_id = p_user
       and (c.verdict = 'unjudgeable'
            or (c.verdict = 'in_fence' and c.server_received_at > v_deadline and c.client_captured_at <= v_deadline))
  ) then
    status := 'unverified';
  else
    status := 'failed';
  end if;
end;
$$;

-- Recompute one participant's result on a closed instance: base result, then resolved reviews
-- in resolution order (D1/D2: accepted appeal -> success at deadline; defaulted appeal ->
-- excluded; accepted challenge -> failed; rejected / defaulted challenge -> unchanged).
-- Closed and settled instances (late offline check-ins reach settled ones); voided or open
-- instances are left alone. Returns true if the row changed.
create function public._refresh_result(p_instance uuid, p_user uuid, p_now timestamptz) returns boolean
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_inst public.pact_instances;
  v_cur public.results;
  v_status public.result_status;
  v_first timestamptz;
  v_rev record;
begin
  select * into v_inst from public.pact_instances where id = p_instance;
  if not found or v_inst.status not in ('closed', 'settled') then
    return false;
  end if;
  select * into v_cur from public.results where instance_id = p_instance and user_id = p_user for update;
  if not found then
    return false;
  end if;
  select b.status, b.first_success_at into v_status, v_first from public._base_result(p_instance, p_user) b;
  for v_rev in
    select r.kind, r.status from public.reviews r
     where r.instance_id = p_instance and r.subject_user_id = p_user and r.status <> 'open'
     order by r.resolved_at, r.opened_at, r.id
  loop
    if v_rev.kind = 'appeal' and v_rev.status = 'accepted' then
      v_status := 'success';
      v_first := v_inst.deadline_at;
    elsif v_rev.kind = 'appeal' and v_rev.status = 'defaulted' then
      v_status := 'excluded';
      v_first := null;
    elsif v_rev.kind = 'challenge' and v_rev.status = 'accepted' then
      v_status := 'failed';
      v_first := null;
    end if;
  end loop;
  if v_status is distinct from v_cur.status or v_first is distinct from v_cur.first_success_at then
    update public.results set status = v_status, first_success_at = v_first, decided_at = p_now
     where instance_id = p_instance and user_id = p_user;
    return true;
  end if;
  return false;
end;
$$;

-- Close one open instance (caller holds the row lock): results, void rule, payout, outbox.
create function public._close_instance(p_instance uuid, p_now timestamptz) returns void
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_active int;
  v_successes int;
  v_voided boolean;
begin
  insert into public.results (instance_id, user_id, status, first_success_at, decided_at)
  select p_instance, u.uid, b.status, b.first_success_at, p_now
    from public._instance_participants(p_instance) as u(uid)
    cross join lateral public._base_result(p_instance, u.uid) b
  on conflict (instance_id, user_id) do update
     set status = excluded.status, first_success_at = excluded.first_success_at, decided_at = excluded.decided_at;

  select count(*) filter (where status in ('success', 'failed')), count(*) filter (where status = 'success')
    into v_active, v_successes
    from public.results where instance_id = p_instance;
  v_voided := v_active < 2;

  if v_voided then
    update public.results set status = 'void', first_success_at = null, decided_at = p_now
     where instance_id = p_instance and status <> 'frozen';
    update public.pact_instances set status = 'voided', closed_at = p_now where id = p_instance;
  else
    update public.pact_instances set status = 'closed', closed_at = p_now where id = p_instance;
    perform public.post_instance_payout(p_instance);
  end if;

  insert into public.notification_outbox (user_id, kind, payload)
  select r.user_id, 'result',
         public._instance_payload(p_instance, r.user_id) || jsonb_build_object(
           'status', r.status,
           'net_cents', coalesce((
             select sum(l.amount_cents)
               from public.ledger_lines l
               join public.ledger_entries e on e.id = l.entry_id
               join public.ledger_accounts a on a.id = l.account_id
              where e.instance_id = p_instance and a.kind = 'member' and a.user_id = r.user_id), 0),
           'rolled_over', (not v_voided and v_successes = 0))
    from public.results r
   where r.instance_id = p_instance
   order by r.user_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Server jobs
-- ---------------------------------------------------------------------
create function public.generate_instances(p_days_ahead int default 7, p_now timestamptz default now())
returns int
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_pact public.pacts;
  v_today date;
  v_day date;
  v_open timestamptz;
  v_deadline timestamptz;
  v_n int;
  v_count int := 0;
begin
  if p_days_ahead is null or p_days_ahead not between 0 and 366 then
    raise exception 'days_ahead must be between 0 and 366' using errcode = '22023';
  end if;
  for v_pact in select * from public.pacts where not paused order by id loop
    v_today := (v_now at time zone v_pact.tz)::date;
    for i in 0 .. p_days_ahead loop
      v_day := v_today + i;
      continue when not (extract(isodow from v_day)::smallint = any (v_pact.days_of_week));
      v_open := public._local_to_utc(v_day + v_pact.window_open_local, v_pact.tz);
      v_deadline := public._local_to_utc(v_day + v_pact.deadline_local, v_pact.tz);
      if v_open >= v_deadline then
        v_open := v_deadline - (v_pact.deadline_local - v_pact.window_open_local);
      end if;
      continue when v_open < v_now;

      insert into public.pact_instances (pact_id, local_date, window_open_at, deadline_at)
      values (v_pact.id, v_day, v_open, v_deadline)
      on conflict (pact_id, local_date) do nothing;
      get diagnostics v_n = row_count;
      if v_n = 0 then
        -- voided by a pause (never closed, no results) and still in the future: bring it back
        update public.pact_instances i
           set status = 'scheduled', window_open_at = v_open, deadline_at = v_deadline, deadline_soon_sent_at = null
         where i.pact_id = v_pact.id and i.local_date = v_day and i.status = 'voided' and i.closed_at is null
           and not exists (select 1 from public.results r where r.instance_id = i.id);
        get diagnostics v_n = row_count;
      end if;
      v_count := v_count + v_n;
    end loop;
  end loop;
  return v_count;
end;
$$;

create function public.tick_instances(p_now timestamptz default now())
returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_pact record;
  v_cand record;
  v_inst public.pact_instances;
  v_skip uuid[] := '{}';
begin
  -- Lock order (20261107000300 header): the carry of every pact this tick will touch is locked
  -- first, in (group_id, pact_id) order, before any instance row. Paused pacts: instances that
  -- have not opened are voided (no results).
  for v_pact in
    select distinct p.group_id, p.id, p.paused
      from public.pacts p
      join public.pact_instances i on i.pact_id = p.id
     where (i.status = 'scheduled' and (p.paused or i.window_open_at <= v_now))
        or (i.status = 'open' and i.deadline_at - interval '15 minutes' <= v_now)
     order by p.group_id, p.id
  loop
    begin
      perform public._lock_pact_carry(v_pact.group_id, v_pact.id);
      if v_pact.paused then
        update public.pact_instances set status = 'voided' where pact_id = v_pact.id and status = 'scheduled';
      end if;
    exception when others then
      v_skip := v_skip || v_pact.id;
      insert into public.job_failures (job, group_id, error)
      values ('tick_instances', v_pact.group_id, sqlstate || ': ' || sqlerrm);
    end;
  end loop;

  -- Each instance below is handled in its own subtransaction: a failure is logged and rolled
  -- back (the instance keeps its status and is retried by the next tick), the others go on.

  -- (a) scheduled -> open
  for v_cand in
    select i.id, p.group_id
      from public.pact_instances i join public.pacts p on p.id = i.pact_id
     where i.status = 'scheduled' and i.window_open_at <= v_now and not (i.pact_id = any (v_skip))
     order by i.window_open_at, i.id
  loop
    begin
      select * into v_inst from public.pact_instances where id = v_cand.id and status = 'scheduled' for update;
      if found then
        update public.pact_instances set status = 'open' where id = v_inst.id;
        if v_inst.deadline_at > v_now then
          insert into public.notification_outbox (user_id, kind, payload)
          select u.uid, 'window_open', public._instance_payload(v_inst.id, u.uid)
            from public._instance_participants(v_inst.id) as u(uid)
           where not exists (select 1 from public.freezes f where f.instance_id = v_inst.id and f.user_id = u.uid);
        end if;
      end if;
    exception when others then
      insert into public.job_failures (job, group_id, error)
      values ('tick_instances', v_cand.group_id, sqlstate || ': ' || sqlerrm);
    end;
  end loop;

  -- (b) one 'deadline_soon' fan-out per instance, to participants without a success (not frozen)
  for v_cand in
    select i.id, p.group_id
      from public.pact_instances i join public.pacts p on p.id = i.pact_id
     where i.status = 'open' and i.deadline_soon_sent_at is null
       and i.deadline_at - interval '15 minutes' <= v_now and v_now < i.deadline_at
       and not (i.pact_id = any (v_skip))
     order by i.deadline_at, i.id
  loop
    begin
      select * into v_inst from public.pact_instances
       where id = v_cand.id and status = 'open' and deadline_soon_sent_at is null for update;
      if found then
        update public.pact_instances set deadline_soon_sent_at = v_now where id = v_inst.id;
        insert into public.notification_outbox (user_id, kind, payload)
        select u.uid, 'deadline_soon',
               public._instance_payload(v_inst.id, u.uid)
               || jsonb_build_object('minutes_left', ceil(extract(epoch from v_inst.deadline_at - v_now) / 60)::int)
          from public._instance_participants(v_inst.id) as u(uid)
         where not exists (select 1 from public.freezes f where f.instance_id = v_inst.id and f.user_id = u.uid)
           and not exists (
             select 1 from public.checkins c
              where c.instance_id = v_inst.id and c.user_id = u.uid
                and c.verdict = 'in_fence' and c.server_received_at <= v_inst.deadline_at);
      end if;
    exception when others then
      insert into public.job_failures (job, group_id, error)
      values ('tick_instances', v_cand.group_id, sqlstate || ': ' || sqlerrm);
    end;
  end loop;

  -- (c) open -> closed / voided
  for v_cand in
    select i.id, p.group_id
      from public.pact_instances i join public.pacts p on p.id = i.pact_id
     where i.status = 'open' and i.deadline_at <= v_now and not (i.pact_id = any (v_skip))
     order by i.deadline_at, i.id
  loop
    begin
      perform 1 from public.pact_instances where id = v_cand.id and status = 'open' for update;
      if found then
        perform public._close_instance(v_cand.id, v_now);
      end if;
    exception when others then
      insert into public.job_failures (job, group_id, error)
      values ('tick_instances', v_cand.group_id, sqlstate || ': ' || sqlerrm);
    end;
  end loop;
end;
$$;

create function public.purge_old_locations(p_now timestamptz default now())
returns int
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_n int;
begin
  update public.checkins set lat = null, lng = null
   where server_received_at < coalesce(p_now, now()) - interval '30 days'
     and (lat is not null or lng is not null);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------
-- Check-ins
-- ---------------------------------------------------------------------
create function public.check_in_at(
  p_user uuid,
  p_instance uuid,
  p_lat float8,
  p_lng float8,
  p_accuracy_m float8,
  p_client_captured_at timestamptz,
  p_is_simulated boolean,
  p_client_attempt_id uuid,
  p_now timestamptz
) returns public.checkins
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_row public.checkins;
  v_inst public.pact_instances;
  v_place record;
  v_on_time boolean;
  v_sim boolean := coalesce(p_is_simulated, false);
  v_dist float8;
  v_verdict public.checkin_verdict;
  v_pact uuid;
  v_group uuid;
begin
  if p_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  -- idempotent retry: the stored attempt comes back unchanged, whatever was sent this time
  if p_client_attempt_id is not null then
    select * into v_row from public.checkins where user_id = p_user and client_attempt_id = p_client_attempt_id;
    if found then
      return v_row;
    end if;
  end if;

  -- Lock order (20261107000300 header): the pact's carry before the instance. A check-in can turn
  -- into a correction (late tap, or the tick closing the instance while we wait for its lock).
  -- Unlocked pre-checks first, so outsiders never queue on the carry.
  select i.pact_id, p.group_id into v_pact, v_group
    from public.pact_instances i join public.pacts p on p.id = i.pact_id where i.id = p_instance;
  if not found then
    raise exception 'instance not found' using errcode = 'P0002';
  end if;
  if not public._on_instance_roster(p_instance, p_user) then
    raise exception 'not a participant of this pact instance' using errcode = '42501';
  end if;
  perform public._lock_pact_carry(v_group, v_pact);
  select * into v_inst from public.pact_instances where id = p_instance for update;
  if not public._on_instance_roster(p_instance, p_user) then
    raise exception 'not a participant of this pact instance' using errcode = '42501';
  end if;

  if p_client_captured_at is null then
    raise exception 'client_captured_at is required' using errcode = '22023';
  end if;
  -- On time, the phone clock is stored but not judged (a fast clock must not reject a real tap).
  v_on_time := v_now >= v_inst.window_open_at and v_now <= v_inst.deadline_at;
  if not v_on_time and p_client_captured_at > v_now + interval '2 minutes' then
    raise exception 'client_captured_at is more than 2 minutes ahead of server time' using errcode = '22023';
  end if;
  if p_lat is not null and not (p_lat between -90 and 90) then
    raise exception 'lat must be between -90 and 90' using errcode = '22023';
  end if;
  if p_lng is not null and not (p_lng between -180 and 180) then
    raise exception 'lng must be between -180 and 180' using errcode = '22023';
  end if;

  if v_inst.status = 'voided' and v_inst.closed_at is null then
    raise exception 'instance was cancelled (pact paused)' using errcode = '23514';
  end if;
  if v_now < v_inst.window_open_at then
    raise exception 'check-in window has not opened yet' using errcode = '23514';
  end if;
  if v_now > v_inst.deadline_at
     and not (p_client_captured_at >= v_inst.window_open_at and p_client_captured_at <= v_inst.deadline_at) then
    raise exception 'check-in window is closed' using errcode = '23514';
  end if;
  -- late offline taps are accepted for 24 hours after the deadline (also on settled instances)
  if v_now > v_inst.deadline_at + interval '24 hours' then
    raise exception 'late check-ins are accepted only until 24 hours after the deadline' using errcode = '22023';
  end if;
  if (select count(*) from public.checkins where instance_id = p_instance and user_id = p_user) >= 20 then
    raise exception 'at most 20 check-ins per instance' using errcode = '23514';
  end if;

  select * into v_place from public._place_at(v_inst.pact_id, p_user, v_inst.window_open_at);
  if p_lat is not null and p_lng is not null then
    v_dist := public._haversine_m(p_lat, p_lng, v_place.lat, v_place.lng);
  end if;
  v_verdict := case
    when v_sim then 'rejected_simulated'
    when v_dist is null or p_accuracy_m is null or p_accuracy_m < 0 or p_accuracy_m > 200 then 'unjudgeable'  -- NaN > 200
    when v_dist - p_accuracy_m <= v_place.radius_m then 'in_fence'
    else 'out_of_fence'
  end::public.checkin_verdict;

  begin
    insert into public.checkins (instance_id, user_id, client_captured_at, server_received_at, lat, lng,
                                 accuracy_m, distance_m, is_simulated, verdict, client_attempt_id)
    values (p_instance, p_user, p_client_captured_at, v_now, case when v_dist is null then null else p_lat end,
            case when v_dist is null then null else p_lng end, p_accuracy_m, v_dist, v_sim, v_verdict, p_client_attempt_id)
    returning * into v_row;
  exception when unique_violation then
    select * into v_row from public.checkins where user_id = p_user and client_attempt_id = p_client_attempt_id;
    return v_row;
  end;

  -- already closed or settled: recompute this user's result (late offline -> unverified unless
  -- already success) and let the ledger catch up
  if v_inst.status in ('closed', 'settled') and public._refresh_result(p_instance, p_user, v_now) then
    perform public.apply_instance_correction(p_instance);
  end if;
  return v_row;
end;
$$;

create function public.check_in(
  p_instance uuid,
  p_lat float8,
  p_lng float8,
  p_accuracy_m float8,
  p_client_captured_at timestamptz,
  p_is_simulated boolean,
  p_client_attempt_id uuid default null
) returns public.checkins
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  return public.check_in_at(auth.uid(), p_instance, p_lat, p_lng, p_accuracy_m, p_client_captured_at,
                            p_is_simulated, p_client_attempt_id, now());
end;
$$;

-- ---------------------------------------------------------------------
-- Freezes
-- ---------------------------------------------------------------------
create function public.declare_freeze_at(p_user uuid, p_instance uuid, p_now timestamptz) returns uuid
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_inst public.pact_instances;
  v_week text;
  v_id uuid;
begin
  if p_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select * into v_inst from public.pact_instances where id = p_instance for update;
  if not found then
    raise exception 'instance not found' using errcode = 'P0002';
  end if;
  if not public._on_instance_roster(p_instance, p_user) then
    raise exception 'not a participant of this pact instance' using errcode = '42501';
  end if;
  if v_inst.status <> 'scheduled' or v_now >= v_inst.window_open_at then
    raise exception 'a freeze must be declared before the window opens' using errcode = '23514';
  end if;
  v_week := to_char(v_inst.local_date::timestamp, 'IYYY-"W"IW');
  perform 1 from public.pacts where id = v_inst.pact_id for update;
  if exists (select 1 from public.freezes where pact_id = v_inst.pact_id and user_id = p_user and iso_week = v_week) then
    raise exception 'freeze already used for ISO week %', v_week using errcode = '23514';
  end if;
  insert into public.freezes (pact_id, user_id, instance_id, declared_at, iso_week)
  values (v_inst.pact_id, p_user, p_instance, v_now, v_week)
  returning id into v_id;
  return v_id;
end;
$$;

create function public.declare_freeze(p_instance uuid) returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  return public.declare_freeze_at(auth.uid(), p_instance, now());
end;
$$;

-- ---------------------------------------------------------------------
-- Reviews
-- ---------------------------------------------------------------------

-- Resolve an open review, apply it to the subject's result, and let the ledger catch up.
create function public._resolve_review(p_review uuid, p_status public.review_status, p_now timestamptz) returns void
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_instance uuid;
  v_subject uuid;
begin
  update public.reviews set status = p_status, resolved_at = p_now
   where id = p_review and status = 'open'
  returning instance_id, subject_user_id into v_instance, v_subject;
  if v_instance is null then
    return;
  end if;
  perform public._refresh_result(v_instance, v_subject, p_now);
  perform public.apply_instance_correction(v_instance);
end;
$$;

create function public.open_review_at(
  p_user uuid,
  p_instance uuid,
  p_subject uuid,
  p_kind public.review_kind,
  p_reason text,
  p_photo_path text,
  p_now timestamptz
) returns uuid
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_inst public.pact_instances;
  v_status public.result_status;
  v_reason text := nullif(btrim(p_reason), '');
  v_photo text := nullif(btrim(p_photo_path), '');
  v_id uuid;
begin
  if p_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select * into v_inst from public.pact_instances where id = p_instance for update;
  if not found then
    raise exception 'instance not found' using errcode = 'P0002';
  end if;
  if not public._on_instance_roster(p_instance, p_user) then
    raise exception 'not a participant of this pact instance' using errcode = '42501';
  end if;
  if v_inst.status = 'settled' then
    -- Only a challenge of a result changed after settlement (a late offline tap): the one
    -- defence against a forged capture time. Appeals and everything else stay final.
    if p_kind is distinct from 'challenge' or not exists (
      select 1 from public.results r
       where r.instance_id = p_instance and r.user_id = p_subject and r.decided_at > v_inst.settled_at
    ) then
      raise exception 'a settled instance can only get a challenge of a result changed after settlement'
        using errcode = '23514';
    end if;
  elsif v_inst.status <> 'closed' then
    raise exception 'only closed, unsettled instances can be reviewed' using errcode = '23514';
  end if;
  if p_kind is null or p_subject is null then
    raise exception 'kind and subject are required' using errcode = '22023';
  end if;
  if char_length(coalesce(v_reason, '')) > 500 or char_length(coalesce(v_photo, '')) > 500 then
    raise exception 'reason and photo_path must be at most 500 characters' using errcode = '22023';
  end if;
  select status into v_status from public.results where instance_id = p_instance and user_id = p_subject;
  if v_status is null then
    raise exception 'subject has no result for this instance' using errcode = 'P0002';
  end if;
  if p_kind = 'appeal' then
    if p_user <> p_subject then
      raise exception 'only the subject can appeal their own result' using errcode = '42501';
    end if;
    if v_status <> 'failed' then
      raise exception 'only a failed result can be appealed' using errcode = '23514';
    end if;
  else
    if p_user = p_subject then
      raise exception 'you cannot challenge your own result' using errcode = '42501';
    end if;
    -- Former members keep their own appeal (they can still be charged) but can't challenge others.
    if not exists (
      select 1 from public.group_members gm
        join public.pacts pa on pa.group_id = gm.group_id
       where pa.id = v_inst.pact_id and gm.user_id = p_user and gm.left_at is null
    ) then
      raise exception 'only current group members can challenge a result' using errcode = '42501';
    end if;
    if v_status not in ('success', 'unverified') then
      raise exception 'only a success or unverified result can be challenged' using errcode = '23514';
    end if;
  end if;
  if exists (select 1 from public.reviews where instance_id = p_instance and subject_user_id = p_subject and status = 'open') then
    raise exception 'a review of this result is already open' using errcode = '23514';
  end if;
  if exists (select 1 from public.reviews where instance_id = p_instance and subject_user_id = p_subject and kind = p_kind) then
    raise exception 'this result has already had its % (one per instance)', p_kind using errcode = '23514';
  end if;

  insert into public.reviews (instance_id, subject_user_id, opened_by, kind, reason, photo_path, opened_at)
  values (p_instance, p_subject, p_user, p_kind, v_reason, v_photo, v_now)
  returning id into v_id;

  insert into public.notification_outbox (user_id, kind, payload)
  select u.uid, 'review_opened',
         public._instance_payload(p_instance, u.uid) || jsonb_strip_nulls(jsonb_build_object(
           'review_id', v_id,
           'review_kind', p_kind,
           'subject_user_id', p_subject,
           'subject_name', (select display_name from public.profiles where id = p_subject),
           'opener_name', (select display_name from public.profiles where id = p_user)))
    from public._instance_participants(p_instance) as u(uid)
   where u.uid <> p_user
   order by u.uid;
  return v_id;
end;
$$;

create function public.open_review(p_instance uuid, p_subject uuid, p_kind public.review_kind, p_reason text, p_photo_path text)
returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  return public.open_review_at(auth.uid(), p_instance, p_subject, p_kind, p_reason, p_photo_path, now());
end;
$$;

-- D3: voters = _review_voters (the instance roster except the subject, current group members
-- only; a challenge's opener may vote). Resolves as soon as supports or opposes exceed half of
-- the eligible voters. Open reviews of closed instances, and late challenges of settled ones.
create function public.cast_vote_at(p_user uuid, p_review uuid, p_supports boolean, p_now timestamptz) returns void
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_rev public.reviews;
  v_inst_status public.instance_status;
  v_pact uuid;
  v_group uuid;
  v_eligible int;
  v_sup int;
  v_opp int;
begin
  if p_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select i.pact_id, p.group_id into v_pact, v_group
    from public.reviews r
    join public.pact_instances i on i.id = r.instance_id
    join public.pacts p on p.id = i.pact_id
   where r.id = p_review;
  if not found then
    raise exception 'review not found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public._review_voters(p_review) e where e = p_user) then
    raise exception 'not an eligible voter for this review' using errcode = '42501';
  end if;
  -- Lock order (20261107000300 header): the pact's carry before the review (a vote can resolve it
  -- and post a correction).
  perform public._lock_pact_carry(v_group, v_pact);
  select * into v_rev from public.reviews where id = p_review for update;
  select status into v_inst_status from public.pact_instances where id = v_rev.instance_id;
  if not exists (select 1 from public._review_voters(p_review) e where e = p_user) then
    raise exception 'not an eligible voter for this review' using errcode = '42501';
  end if;
  if v_rev.status <> 'open'
     or not (v_inst_status = 'closed' or (v_inst_status = 'settled' and v_rev.kind = 'challenge')) then
    raise exception 'review is already resolved' using errcode = '23514';
  end if;
  if p_supports is null then
    raise exception 'supports must be true or false' using errcode = '22023';
  end if;

  insert into public.review_votes (review_id, voter_id, supports, cast_at)
  values (p_review, p_user, p_supports, v_now)
  on conflict (review_id, voter_id) do update set supports = excluded.supports, cast_at = excluded.cast_at;

  select count(*) into v_eligible from public._review_voters(p_review);
  select count(*) filter (where v.supports), count(*) filter (where not v.supports)
    into v_sup, v_opp
    from public.review_votes v
    join public._review_voters(p_review) as e(uid) on e.uid = v.voter_id
   where v.review_id = p_review;
  if 2 * v_sup > v_eligible then
    perform public._resolve_review(p_review, 'accepted', v_now);
  elsif 2 * v_opp > v_eligible then
    perform public._resolve_review(p_review, 'rejected', v_now);
  end if;
end;
$$;

create function public.cast_vote(p_review uuid, p_supports boolean) returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  perform public.cast_vote_at(auth.uid(), p_review, p_supports, now());
end;
$$;

-- Replaces the stub in 20261107000150_interfaces.sql. Called by settlement.
-- Majority of votes cast; tie -> rejected; no votes -> defaulted.
create or replace function public.default_open_reviews(p_group uuid, p_until timestamptz)
returns int
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_rev record;
  v_pact uuid;
  v_n int := 0;
begin
  -- Lock order (20261107000300 header): the group's carries (pact id order) before any review.
  -- A no-op re-lock when called from settlement, which already holds them.
  for v_pact in select id from public.pacts where group_id = p_group order by id loop
    perform public._lock_pact_carry(p_group, v_pact);
  end loop;
  -- Includes late challenges of settled instances (deadline_at < p_until too). Only votes of
  -- current eligible voters count (_review_voters).
  for v_rev in
    select r.id, r.opened_at,
           (select count(*) from public.review_votes v join public._review_voters(r.id) e(uid) on e.uid = v.voter_id
             where v.review_id = r.id and v.supports) as sup,
           (select count(*) from public.review_votes v join public._review_voters(r.id) e(uid) on e.uid = v.voter_id
             where v.review_id = r.id and not v.supports) as opp
      from public.reviews r
      join public.pact_instances i on i.id = r.instance_id
      join public.pacts p on p.id = i.pact_id
     where p.group_id = p_group and r.status = 'open' and i.deadline_at < p_until
     order by r.opened_at, r.id
     for update of r
  loop
    perform public._resolve_review(
      v_rev.id,
      case when v_rev.sup + v_rev.opp = 0 then 'defaulted'
           when v_rev.sup > v_rev.opp then 'accepted'
           else 'rejected' end::public.review_status,
      greatest(p_until, v_rev.opened_at));
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public._local_to_utc(timestamp, text)',
    'public._haversine_m(float8, float8, float8, float8)',
    'public._instance_participants(uuid)',
    'public._on_instance_roster(uuid, uuid)',
    'public._review_voters(uuid)',
    'public._place_at(uuid, uuid, timestamptz)',
    'public._instance_payload(uuid, uuid)',
    'public._base_result(uuid, uuid)',
    'public._refresh_result(uuid, uuid, timestamptz)',
    'public._close_instance(uuid, timestamptz)',
    'public._resolve_review(uuid, public.review_status, timestamptz)',
    'public.check_in_at(uuid, uuid, float8, float8, float8, timestamptz, boolean, uuid, timestamptz)',
    'public.declare_freeze_at(uuid, uuid, timestamptz)',
    'public.open_review_at(uuid, uuid, uuid, public.review_kind, text, text, timestamptz)',
    'public.cast_vote_at(uuid, uuid, boolean, timestamptz)',
    'public.generate_instances(int, timestamptz)',
    'public.tick_instances(timestamptz)',
    'public.purge_old_locations(timestamptz)',
    'public.default_open_reviews(uuid, timestamptz)',
    'public.check_in(uuid, float8, float8, float8, timestamptz, boolean, uuid)',
    'public.declare_freeze(uuid)',
    'public.open_review(uuid, uuid, public.review_kind, text, text)',
    'public.cast_vote(uuid, boolean)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;

  -- server jobs: service role / pg_cron only
  foreach f in array array[
    'public.generate_instances(int, timestamptz)',
    'public.tick_instances(timestamptz)',
    'public.purge_old_locations(timestamptz)',
    'public.default_open_reviews(uuid, timestamptz)'
  ] loop
    execute format('grant execute on function %s to service_role', f);
  end loop;

  -- client RPCs
  foreach f in array array[
    'public.check_in(uuid, float8, float8, float8, timestamptz, boolean, uuid)',
    'public.declare_freeze(uuid)',
    'public.open_review(uuid, uuid, public.review_kind, text, text)',
    'public.cast_vote(uuid, boolean)'
  ] loop
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
