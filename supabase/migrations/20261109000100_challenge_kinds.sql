-- =====================================================================
-- Challenge kinds: distance / workouts / steps / custom pacts on the same pledge-forfeit-pool engine.
-- Spec: docs/superpowers/specs/2026-11-08-challenge-kinds-design.md; docs/CONTRACT.md "Kinds",
-- "Activities", "Views"; docs/DECISIONS.md CA-*. Owner: challenges lane A.
--
-- What changes (full text in CONTRACT.md):
--   * pacts gain kind / period / goal_value / goal_unit / activity_types / race_start / race_end with
--     check constraints per kind; days_of_week is null for weekly and once pacts. Once any instance of
--     a pact has opened, kind, period, goal, types, race dates and tz are locked (trigger, 23514).
--   * create_pact gains optional trailing parameters (the 7-argument call is unchanged);
--     join_pact's place arguments are nullable: a place is required for show_up only, goal kinds
--     keep no place history and may join while a week is open (they are on the next roster).
--   * Instances: weekly = one per ISO week (local_date Monday, Mon 00:00 -> next Mon 00:00 in the pact
--     zone, DST-correct); once = one instance race_start 00:00 -> race_end + 1 day 00:00; daily as
--     before. _generate_instances_v1 (the body under the heartbeat wrapper) is replaced in place: its
--     daily loop had to learn to skip non-daily pacts, so wrapping it was not enough (CA-1).
--   * Roster (_instance_participants): the place gate applies to show_up only.
--   * activities (evidence) + submit_activities / submit_activities_for / submit_activities_at (core);
--     verdicts: unknown type -> rejected_type; is_manual -> rejected_manual; ends more than 5 min in the
--     future -> rejected_future; implausible pace (> 12 m/s on foot or in water, > 25 m/s cycling) ->
--     rejected_type 'implausible pace'; >= 80 % time overlap with an accepted activity of the same user
--     from another source -> rejected_duplicate (first accepted wins); else accepted. Idempotent per
--     (user, source, external_id): same raw_hash -> no-op; a different hash updates steps samples only,
--     anything else is 23514. A rejected_future row whose end has since passed is re-judged on re-submit.
--   * Views instance_progress, instance_standings, pact_activities (security invoker; members only).
--   * Results: _base_result dispatches on kind (the old body is _base_result_v1): goal kinds are
--     success when progress at the deadline >= goal (first_success_at = reached_at), else failed,
--     never unverified; only evidence submitted by deadline + 24 h counts for money (late sync = a late
--     offline check-in: recompute + correction; later evidence is shown, not billed). custom: success
--     when custom_completions holds a row marked before the deadline (mark_done).
--   * Freezes on weekly / once pacts: one per calendar month (freezes.iso_week holds 'YYYY-MM').
--   * tick_instances is wrapped again (_tick_instances_v3 is the previous public body): weekly / once
--     instances open without a window_open push (nobody wants a Monday-midnight banner) and get their
--     one deadline_soon ("Final call") at 18:00 local the day before the deadline, to roster members
--     short of the goal and not frozen; the daily 15-minute rule is untouched.
--   * leave_group: the open-window refusal applies to daily pacts only; leaving mid-week keeps you on
--     the week's roster (scored at close, D24 holds).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Enums and pact columns
-- ---------------------------------------------------------------------
create type public.pact_kind as enum ('show_up', 'distance', 'workouts', 'steps', 'custom');
create type public.pact_period as enum ('daily', 'weekly', 'once');
create type public.activity_source as enum ('healthkit', 'strava', 'manual');
create type public.activity_verdict as enum ('accepted', 'rejected_manual', 'rejected_duplicate', 'rejected_type', 'rejected_future');

alter table public.pacts
  add column kind public.pact_kind not null default 'show_up',
  add column period public.pact_period not null default 'daily',
  add column goal_value numeric null,
  add column goal_unit text null,
  add column activity_types text[] null,
  add column race_start date null,
  add column race_end date null;

alter table public.pacts alter column days_of_week drop not null;
do $$
declare
  c text;
begin
  select conname into c
    from pg_constraint
   where conrelid = 'public.pacts'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%valid_days_of_week%';
  if c is not null then
    execute format('alter table public.pacts drop constraint %I', c);
  end if;
end;
$$;

-- The activity types a pact can count (plus 'steps', the type of a daily step sample).
create function public.known_activity_types() returns text[]
language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$
  select array['running', 'walking', 'cycling', 'swimming', 'hiking', 'rowing', 'strength', 'yoga', 'other']::text[]
$$;

alter table public.pacts
  add constraint pacts_days_by_period check (
    case when period = 'daily' then public.valid_days_of_week(days_of_week) else days_of_week is null end),
  add constraint pacts_goal_unit_check check (goal_unit is null or goal_unit in ('m', 'count', 'steps')),
  add constraint pacts_kind_rules check (
    case kind
      when 'show_up' then period = 'daily' and goal_value is null and goal_unit is null and activity_types is null
      when 'distance' then period in ('weekly', 'once') and coalesce(goal_value, 0) > 0 and goal_unit = 'm'
                          and coalesce(cardinality(activity_types), 0) >= 1
      when 'workouts' then period = 'weekly' and coalesce(goal_value, 0) > 0 and goal_unit = 'count'
                          and coalesce(cardinality(activity_types), 0) >= 1
      when 'steps' then period = 'daily' and coalesce(goal_value, 0) > 0 and goal_unit = 'steps' and activity_types is null
      when 'custom' then period in ('daily', 'weekly') and goal_value is null and goal_unit is null and activity_types is null
    end),
  add constraint pacts_race_dates check (
    case when period = 'once' then race_start is not null and race_end is not null and race_start <= race_end
         else race_start is null and race_end is null end),
  add constraint pacts_activity_types_known check (
    activity_types is null or activity_types <@ public.known_activity_types());

-- Goal kinds have no place.
alter table public.pact_participants
  alter column place_lat drop not null,
  alter column place_lng drop not null,
  alter column place_radius_m drop not null;

-- Once a window has opened the game is fixed: no moving the finish line of a race, the goal or the
-- allowed types (and no zone games on the Sunday boundary).
create function public._pacts_lock_after_open() returns trigger
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if (new.kind, new.period, new.goal_value, new.goal_unit, new.activity_types, new.race_start, new.race_end, new.tz)
     is distinct from
     (old.kind, old.period, old.goal_value, old.goal_unit, old.activity_types, old.race_start, old.race_end, old.tz)
     and exists (
       select 1 from public.pact_instances i
        where i.pact_id = new.id
          and (i.status in ('open', 'closed', 'settled') or i.closed_at is not null
               or (i.status = 'scheduled' and i.window_open_at <= now()))
     ) then
    raise exception 'the kind, period, goal, activity types, race dates and zone of a pact are locked once one of its windows has opened'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger pacts_lock_after_open before update on public.pacts
  for each row execute function public._pacts_lock_after_open();

-- ---------------------------------------------------------------------
-- Evidence tables
-- ---------------------------------------------------------------------
create table public.activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id),
  source public.activity_source not null,
  external_id text not null check (char_length(external_id) between 1 and 200),
  activity_type text not null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  distance_m float8 null check (distance_m is null or distance_m >= 0),
  duration_s int not null check (duration_s >= 0),
  steps int null check (steps is null or steps >= 0),
  device text null,
  app_bundle text null,
  is_manual boolean not null default false,
  raw_hash text null,
  submitted_at timestamptz not null default now(),
  verdict public.activity_verdict not null,
  reject_reason text null,
  unique (user_id, source, external_id),
  constraint activities_ends_after_start check (ended_at > started_at)
);
create index activities_user_started_idx on public.activities (user_id, started_at);
alter table public.activities enable row level security;

-- Does an activity of this type belong to a pact of this kind? (steps samples to steps pacts; the
-- pact's allowed types otherwise). Plain function: views and policies run it as the member.
create function public.activity_matches_pact(p_kind public.pact_kind, p_types text[], p_type text) returns boolean
language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$
  select case p_kind
           when 'steps' then p_type = 'steps'
           when 'distance' then p_type = any (p_types)
           when 'workouts' then p_type = any (p_types)
           else false
         end
$$;

-- Own rows, plus other members' activities that belong to a shared goal pact and fall inside one of
-- its instance windows (what pact_activities and the standings show). Nothing else of theirs.
create policy activities_select on public.activities for select to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1
        from public.pact_participants pp
        join public.pacts p on p.id = pp.pact_id
        join public.pact_instances i on i.pact_id = p.id
       where pp.user_id = activities.user_id
         and p.kind in ('distance', 'workouts', 'steps')
         and public.is_group_member(p.group_id)
         and activities.started_at >= i.window_open_at and activities.started_at < i.deadline_at
         and public.activity_matches_pact(p.kind, p.activity_types, activities.activity_type)
    )
  );
revoke all on public.activities from public, anon, authenticated;
grant select on public.activities to authenticated;
grant all on public.activities to service_role;

create table public.custom_completions (
  instance_id uuid not null references public.pact_instances (id) on delete cascade,
  user_id uuid not null references public.profiles (id),
  marked_at timestamptz not null default now(),
  photo_path text null check (photo_path is null or char_length(photo_path) <= 500),
  primary key (instance_id, user_id)
);
alter table public.custom_completions enable row level security;
create policy custom_completions_select on public.custom_completions for select to authenticated
  using (public.is_instance_group_member(instance_id));
revoke all on public.custom_completions from public, anon, authenticated;
grant select on public.custom_completions to authenticated;
grant all on public.custom_completions to service_role;

-- ---------------------------------------------------------------------
-- create_pact: optional kind parameters (the 7-argument call keeps working)
-- ---------------------------------------------------------------------
drop function public.create_pact(uuid, text, smallint[], time, time, int, text);

create function public.create_pact(
  p_group uuid,
  p_title text,
  p_days smallint[],
  p_window_open time,
  p_deadline time,
  p_stake_cents int,
  p_tz text,
  p_kind public.pact_kind default 'show_up',
  p_period public.pact_period default 'daily',
  p_goal_value numeric default null,
  p_goal_unit text default null,
  p_activity_types text[] default null,
  p_race_start date default null,
  p_race_end date default null
) returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_title text := btrim(p_title);
  v_kind public.pact_kind := coalesce(p_kind, 'show_up');
  v_period public.pact_period := coalesce(p_period, 'daily');
  v_days smallint[];
  v_open time;
  v_deadline time;
  v_stake int := coalesce(p_stake_cents, 500);
  v_tz text;
  v_goal numeric := p_goal_value;
  v_unit text := nullif(btrim(p_goal_unit), '');
  v_types text[];
  v_expected_unit text;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not public.is_group_member(p_group) then
    raise exception 'not a member of this group' using errcode = '42501';
  end if;
  if v_title is null or char_length(v_title) not between 1 and 80 then
    raise exception 'pact title must be 1 to 80 characters' using errcode = '22023';
  end if;
  if v_stake not between 1 and 10000 then
    raise exception 'stake must be between 1 and 10000 cents' using errcode = '22023';
  end if;
  v_tz := coalesce(p_tz, (select settlement_tz from public.groups where id = p_group));
  if not public.is_valid_tz(v_tz) then
    raise exception 'invalid time zone: % (must be an IANA zone name)', coalesce(v_tz, 'null') using errcode = '22023';
  end if;

  -- kind / period
  if v_kind = 'show_up' and v_period <> 'daily' then
    raise exception 'a show-up pact runs daily' using errcode = '22023';
  elsif v_kind = 'distance' and v_period not in ('weekly', 'once') then
    raise exception 'a distance challenge runs weekly or as a race (once)' using errcode = '22023';
  elsif v_kind = 'workouts' and v_period <> 'weekly' then
    raise exception 'a workouts challenge runs weekly' using errcode = '22023';
  elsif v_kind = 'steps' and v_period <> 'daily' then
    raise exception 'a steps challenge runs daily' using errcode = '22023';
  elsif v_kind = 'custom' and v_period not in ('daily', 'weekly') then
    raise exception 'a custom challenge runs daily or weekly' using errcode = '22023';
  end if;

  -- goal and unit
  v_expected_unit := case v_kind when 'distance' then 'm' when 'workouts' then 'count' when 'steps' then 'steps' end;
  if v_expected_unit is null then
    if v_goal is not null or v_unit is not null then
      raise exception 'a % pact has no goal', v_kind using errcode = '22023';
    end if;
  else
    if v_goal is null or v_goal <= 0 then
      raise exception 'a % challenge needs a goal above 0 (%)', v_kind, v_expected_unit using errcode = '22023';
    end if;
    if v_kind in ('workouts', 'steps') and v_goal <> trunc(v_goal) then
      raise exception 'a % goal is a whole number', v_kind using errcode = '22023';
    end if;
    v_unit := coalesce(v_unit, v_expected_unit);
    if v_unit <> v_expected_unit then
      raise exception 'goal_unit for a % challenge is %', v_kind, v_expected_unit using errcode = '22023';
    end if;
  end if;

  -- activity types
  if v_kind in ('distance', 'workouts') then
    if p_activity_types is null then
      v_types := case v_kind when 'distance' then array['running'] else public.known_activity_types() end;
    else
      select array_agg(distinct lower(btrim(t)) order by lower(btrim(t))) into v_types
        from unnest(p_activity_types) t where nullif(btrim(t), '') is not null;
      if coalesce(cardinality(v_types), 0) = 0 then
        raise exception 'at least one activity type is required' using errcode = '22023';
      end if;
      if not (v_types <@ public.known_activity_types()) then
        raise exception 'unknown activity type in %', v_types using errcode = '22023';
      end if;
    end if;
  elsif p_activity_types is not null then
    raise exception 'a % pact has no activity types', v_kind using errcode = '22023';
  end if;

  -- race dates
  if v_period = 'once' then
    if p_race_start is null or p_race_end is null then
      raise exception 'a race needs race_start and race_end' using errcode = '22023';
    end if;
    if p_race_start > p_race_end then
      raise exception 'race_start must be on or before race_end' using errcode = '22023';
    end if;
    if p_race_start < (now() at time zone v_tz)::date then
      raise exception 'a race cannot start in the past' using errcode = '22023';
    end if;
  elsif p_race_start is not null or p_race_end is not null then
    raise exception 'race dates apply to a race (period once) only' using errcode = '22023';
  end if;

  -- days and local times
  if v_period = 'daily' then
    if p_days is not null and array_position(p_days, null) is null then
      select array_agg(distinct d order by d) into v_days from unnest(p_days) d;
    end if;
    if not coalesce(public.valid_days_of_week(v_days), false) then
      raise exception 'days_of_week must list ISO days 1 (Mon) to 7 (Sun), at least one' using errcode = '22023';
    end if;
    if v_kind = 'steps' then
      -- a day's steps are counted from midnight (Apple Health's daily total starts there)
      v_open := time '00:00';
      v_deadline := coalesce(p_deadline, time '23:59');
      if v_deadline <= v_open then
        raise exception 'the deadline of a steps challenge must be after midnight' using errcode = '22023';
      end if;
    else
      if p_deadline is null then
        raise exception 'deadline is required' using errcode = '22023';
      end if;
      v_deadline := p_deadline;
      v_open := coalesce(
        p_window_open,
        case when p_deadline >= time '01:00' then p_deadline - interval '1 hour' else time '00:00' end
      );
      if v_open >= v_deadline then
        raise exception 'window open time must be before the deadline on the same local day' using errcode = '22023';
      end if;
    end if;
  else
    -- weekly / once: the window is the whole period; the local times are nominal (CA-3)
    v_days := null;
    v_open := time '00:00';
    v_deadline := time '23:59';
  end if;

  insert into public.pacts (group_id, title, days_of_week, window_open_local, deadline_local, stake_cents, tz, created_by,
                            kind, period, goal_value, goal_unit, activity_types, race_start, race_end)
  values (p_group, v_title, v_days, v_open, v_deadline, v_stake, v_tz, v_uid,
          v_kind, v_period, v_goal, v_unit, v_types, p_race_start, p_race_end)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- join_pact: place arguments nullable; a place is required for show_up only
-- ---------------------------------------------------------------------
create or replace function public.join_pact(
  p_pact uuid,
  p_lat float8 default null,
  p_lng float8 default null,
  p_radius_m int default null,
  p_label text default null
) returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_group uuid;
  v_kind public.pact_kind;
  v_label text := nullif(btrim(p_label), '');
  v_cur public.pact_participants%rowtype;
  v_same boolean;
  v_eff record;
  v_others boolean;
  v_place uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select group_id, kind into v_group, v_kind from public.pacts where id = p_pact;
  if v_group is null then
    raise exception 'pact not found' using errcode = 'P0002';
  end if;
  if not public.is_group_member(v_group) then
    raise exception 'not a member of this group' using errcode = '42501';
  end if;

  if v_kind <> 'show_up' then
    -- Goal kinds: no place, no place history, no window refusal (the roster rule D18 already keeps a
    -- mid-week joiner off the open week). Place arguments, if sent, are ignored.
    perform 1 from public.pacts where id = p_pact for update;
    select * into v_cur from public.pact_participants where pact_id = p_pact and user_id = v_uid for update;
    if v_cur.user_id is null then
      insert into public.pact_participants (pact_id, user_id, place_lat, place_lng, place_radius_m, place_label)
      values (p_pact, v_uid, null, null, null, null);
    else
      update public.pact_participants
         set joined_at = case when left_at is null then joined_at else now() end,
             left_at = null
       where pact_id = p_pact and user_id = v_uid;
    end if;
    return;
  end if;

  if p_lat is null or not (p_lat between -90 and 90) then
    raise exception 'place_lat must be between -90 and 90' using errcode = '22023';
  end if;
  if p_lng is null or not (p_lng between -180 and 180) then
    raise exception 'place_lng must be between -180 and 180' using errcode = '22023';
  end if;
  if p_radius_m is null or p_radius_m not between 25 and 500 then
    raise exception 'place_radius_m must be between 25 and 500' using errcode = '22023';
  end if;
  if v_label is not null and char_length(v_label) > 80 then
    raise exception 'place label must be at most 80 characters' using errcode = '22023';
  end if;

  perform 1 from public.pacts where id = p_pact for update;
  select * into v_cur from public.pact_participants where pact_id = p_pact and user_id = v_uid for update;
  v_same := v_cur.user_id is not null
            and v_cur.place_lat = p_lat and v_cur.place_lng = p_lng and v_cur.place_radius_m = p_radius_m;

  if not (v_same and v_cur.left_at is null) and exists (
    select 1 from public.pact_instances
     where pact_id = p_pact
       and (status = 'open' or (window_open_at <= now() and status not in ('closed', 'settled', 'voided')))
  ) then
    raise exception 'cannot join, rejoin or change your place once a check-in window has opened (until it closes)'
      using errcode = '23514';
  end if;

  v_others := exists (
    select 1 from public.group_members m where m.group_id = v_group and m.user_id <> v_uid and m.left_at is null
  );

  if v_cur.user_id is null then
    insert into public.pact_participants (pact_id, user_id, place_lat, place_lng, place_radius_m, place_label)
    values (p_pact, v_uid, p_lat, p_lng, p_radius_m, v_label);
    insert into public.pact_participant_places (pact_id, user_id, lat, lng, radius_m, label, effective_from, requires_ack)
    values (p_pact, v_uid, p_lat, p_lng, p_radius_m, v_label, now(), false)
    returning id into v_place;
    perform public._place_event(v_place, 'created', v_uid, null);
    return;
  end if;

  -- rows without history (inserted outside join_pact): their place has applied since they joined
  insert into public.pact_participant_places (pact_id, user_id, lat, lng, radius_m, label, effective_from)
  select v_cur.pact_id, v_cur.user_id, v_cur.place_lat, v_cur.place_lng, v_cur.place_radius_m, v_cur.place_label,
         least(v_cur.joined_at, now())
   where v_cur.place_lat is not null
     and not exists (select 1 from public.pact_participant_places where pact_id = p_pact and user_id = v_uid);

  if not v_same then
    -- a new request replaces any change that has not started to count (objected rows stay as history)
    delete from public.pact_participant_places
     where pact_id = p_pact and user_id = v_uid and effective_from > now() and objected_at is null;
    select h.lat, h.lng, h.radius_m into v_eff
      from public.pact_participant_places h
     where h.id = public._place_row_at(p_pact, v_uid, now());
    if v_eff.lat is null or not (v_eff.lat = p_lat and v_eff.lng = p_lng and v_eff.radius_m = p_radius_m) then
      insert into public.pact_participant_places (pact_id, user_id, lat, lng, radius_m, label, effective_from, requires_ack)
      values (p_pact, v_uid, p_lat, p_lng, p_radius_m, v_label,
              now() + case when v_others then interval '24 hours' else interval '12 hours' end, v_others)
      returning id into v_place;
      perform public._place_event(v_place, 'created', v_uid, null);
    end if;
  end if;

  update public.pact_participants
     set place_lat = p_lat,
         place_lng = p_lng,
         place_radius_m = p_radius_m,
         place_label = v_label,
         joined_at = case when left_at is null then joined_at else now() end,
         left_at = null
   where pact_id = p_pact and user_id = v_uid;
end;
$$;

-- ---------------------------------------------------------------------
-- Roster: the place gate applies to show_up only
-- ---------------------------------------------------------------------
create or replace function public._instance_participants(p_instance uuid) returns setof uuid
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
      join public.pacts p on p.id = i.pact_id
      join public.pact_participants pp on pp.pact_id = i.pact_id
     where i.id = p_instance and i.closed_at is null
       and pp.joined_at <= i.window_open_at
       and (pp.left_at is null or pp.left_at > i.window_open_at)
       and (p.kind <> 'show_up'
            or (select pl.lat from public._place_at(i.pact_id, pp.user_id, i.window_open_at) pl) is not null)
  ) x
  order by u
$$;

-- ---------------------------------------------------------------------
-- Progress (derived, never stored)
-- ---------------------------------------------------------------------

-- One participant's progress on a goal-kind instance from accepted activities started inside the
-- window, optionally only those submitted by p_submitted_before (the 24 h late-evidence cut-off used
-- for money; null = everything, what the views show). reached_at = ended_at of the activity that first
-- brought the running total (in started_at, id order) to the goal.
create function public._goal_progress(p_instance uuid, p_user uuid, p_submitted_before timestamptz)
returns table (value numeric, activity_count int, reached_at timestamptz)
language sql stable
set search_path = pg_catalog, public, pg_temp
as $$
  with inst as (
    select i.window_open_at, i.deadline_at, p.kind, p.goal_value, p.activity_types
      from public.pact_instances i join public.pacts p on p.id = i.pact_id
     where i.id = p_instance
  ), counted as (
    select a.id, a.started_at, a.ended_at,
           case inst.kind
             when 'distance' then coalesce(a.distance_m, 0)::numeric
             when 'workouts' then 1::numeric
             when 'steps' then coalesce(a.steps, 0)::numeric
             else 0::numeric
           end as amt
      from inst
      join public.activities a
        on a.user_id = p_user and a.verdict = 'accepted'
       and a.started_at >= inst.window_open_at and a.started_at < inst.deadline_at
       and (p_submitted_before is null or a.submitted_at <= p_submitted_before)
       and public.activity_matches_pact(inst.kind, inst.activity_types, a.activity_type)
       and (inst.kind <> 'workouts' or a.duration_s >= 600)
  ), cum as (
    select c.*, sum(c.amt) over (order by c.started_at, c.id) as running from counted c
  )
  select coalesce(sum(amt), 0)::numeric,
         count(*)::int,
         (array_agg(ended_at order by started_at, id) filter (where running >= (select goal_value from inst)))[1]
    from cum
$$;

create view public.instance_progress with (security_invoker = true) as
with roster as (
  select i.id as instance_id, r.user_id
    from public.pact_instances i
    join public.results r on r.instance_id = i.id
   where i.closed_at is not null
  union
  select i.id, pp.user_id
    from public.pact_instances i
    join public.pact_participants pp on pp.pact_id = i.pact_id
   where i.closed_at is null
     and pp.joined_at <= i.window_open_at
     and (pp.left_at is null or pp.left_at > i.window_open_at)
), inst as (
  select i.id, i.window_open_at, i.deadline_at, p.kind, p.goal_value, p.activity_types
    from public.pact_instances i
    join public.pacts p on p.id = i.pact_id
   where p.kind in ('distance', 'workouts', 'steps')
), counted as (
  select ro.instance_id, ro.user_id, a.id, a.started_at, a.ended_at, inst.goal_value,
         case inst.kind
           when 'distance' then coalesce(a.distance_m, 0)::numeric
           when 'workouts' then 1::numeric
           when 'steps' then coalesce(a.steps, 0)::numeric
           else 0::numeric
         end as amt
    from roster ro
    join inst on inst.id = ro.instance_id
    join public.activities a
      on a.user_id = ro.user_id and a.verdict = 'accepted'
     and a.started_at >= inst.window_open_at and a.started_at < inst.deadline_at
     and public.activity_matches_pact(inst.kind, inst.activity_types, a.activity_type)
     and (inst.kind <> 'workouts' or a.duration_s >= 600)
), cum as (
  select c.*, sum(c.amt) over (partition by c.instance_id, c.user_id order by c.started_at, c.id) as running
    from counted c
), agg as (
  select instance_id, user_id, sum(amt) as value, count(*) as cnt,
         (array_agg(ended_at order by started_at, id) filter (where running >= goal_value))[1] as reached_at
    from cum
   group by instance_id, user_id
)
select ro.instance_id,
       ro.user_id,
       coalesce(agg.value, 0)::numeric as value,
       inst.goal_value as goal,
       coalesce(agg.cnt, 0)::int as activity_count,
       agg.reached_at
  from roster ro
  join inst on inst.id = ro.instance_id
  left join agg on agg.instance_id = ro.instance_id and agg.user_id = ro.user_id;

create view public.instance_standings with (security_invoker = true) as
select instance_id,
       user_id,
       (row_number() over (partition by instance_id
                           order by (reached_at is null), reached_at, value desc, user_id))::int as rank,
       value,
       goal,
       reached_at
  from public.instance_progress;

-- The activities (accepted or rejected) of a pact's roster members that belong to the pact and fall
-- inside one of its instance windows. No coordinates, no routes.
create view public.pact_activities with (security_invoker = true) as
with roster as (
  select i.id as instance_id, i.pact_id, i.window_open_at, i.deadline_at, r.user_id
    from public.pact_instances i
    join public.results r on r.instance_id = i.id
   where i.closed_at is not null
  union
  select i.id, i.pact_id, i.window_open_at, i.deadline_at, pp.user_id
    from public.pact_instances i
    join public.pact_participants pp on pp.pact_id = i.pact_id
   where i.closed_at is null
     and pp.joined_at <= i.window_open_at
     and (pp.left_at is null or pp.left_at > i.window_open_at)
)
select ro.pact_id,
       ro.instance_id,
       ro.user_id,
       a.id as activity_id,
       a.source,
       a.activity_type,
       a.started_at,
       a.ended_at,
       a.distance_m,
       a.duration_s,
       a.steps,
       a.device,
       a.app_bundle,
       a.is_manual,
       a.verdict,
       a.reject_reason
  from roster ro
  join public.pacts p on p.id = ro.pact_id and p.kind in ('distance', 'workouts', 'steps')
  join public.activities a
    on a.user_id = ro.user_id
   and a.started_at >= ro.window_open_at and a.started_at < ro.deadline_at
   and public.activity_matches_pact(p.kind, p.activity_types, a.activity_type);

revoke all on public.instance_progress, public.instance_standings, public.pact_activities from public, anon, authenticated;
grant select on public.instance_progress, public.instance_standings, public.pact_activities to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Results per kind
-- ---------------------------------------------------------------------
alter function public._base_result(uuid, uuid) rename to _base_result_v1;

create function public._base_result(p_instance uuid, p_user uuid,
  out status public.result_status, out first_success_at timestamptz)
language plpgsql stable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_kind public.pact_kind;
  v_deadline timestamptz;
  v_goal numeric;
  v_prog record;
begin
  select p.kind, i.deadline_at, p.goal_value into v_kind, v_deadline, v_goal
    from public.pact_instances i join public.pacts p on p.id = i.pact_id
   where i.id = p_instance;
  if v_kind is null or v_kind = 'show_up' then
    select b.status, b.first_success_at into status, first_success_at from public._base_result_v1(p_instance, p_user) b;
    return;
  end if;
  if exists (select 1 from public.freezes f where f.instance_id = p_instance and f.user_id = p_user) then
    status := 'frozen';
    return;
  end if;
  if v_kind = 'custom' then
    select c.marked_at into first_success_at
      from public.custom_completions c
     where c.instance_id = p_instance and c.user_id = p_user and c.marked_at <= v_deadline;
    status := case when first_success_at is null then 'failed' else 'success' end;
    return;
  end if;
  -- distance / workouts / steps: evidence submitted by deadline + 24 h (C0-2); no unverified
  select * into v_prog from public._goal_progress(p_instance, p_user, v_deadline + interval '24 hours');
  if v_prog.value >= v_goal then
    status := 'success';
    first_success_at := v_prog.reached_at;
  else
    status := 'failed';
    first_success_at := null;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- submit_activities
-- ---------------------------------------------------------------------
create function public.submit_activities_at(p_user uuid, p_activities jsonb, p_now timestamptz) returns int
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_item jsonb;
  v_idx int;
  v_src public.activity_source;
  v_ext text;
  v_type text;
  v_start timestamptz;
  v_end timestamptz;
  v_dist float8;
  v_dur int;
  v_steps int;
  v_device text;
  v_bundle text;
  v_manual boolean;
  v_hash text;
  v_cur public.activities;
  v_verdict public.activity_verdict;
  v_reason text;
  v_dup record;
  v_limit float8;
  v_id uuid;
  v_n int := 0;
  v_touched uuid[] := '{}';
  v_inst record;
begin
  if p_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
  if p_activities is null or jsonb_typeof(p_activities) <> 'array' then
    raise exception 'p_activities must be a JSON array' using errcode = '22023';
  end if;

  for v_item, v_idx in select e.value, e.ordinality from jsonb_array_elements(p_activities) with ordinality e loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'activity %: must be an object', v_idx using errcode = '22023';
    end if;
    begin
      v_src := (v_item ->> 'source')::public.activity_source;
    exception when others then
      raise exception 'activity %: source must be healthkit, strava or manual', v_idx using errcode = '22023';
    end;
    if v_src is null then
      raise exception 'activity %: source is required', v_idx using errcode = '22023';
    end if;
    v_ext := nullif(btrim(v_item ->> 'external_id'), '');
    if v_ext is null or char_length(v_ext) > 200 then
      raise exception 'activity %: external_id is required (max 200 characters)', v_idx using errcode = '22023';
    end if;
    v_type := nullif(lower(btrim(v_item ->> 'activity_type')), '');
    if v_type is null or char_length(v_type) > 40 then
      raise exception 'activity %: activity_type is required', v_idx using errcode = '22023';
    end if;
    begin
      v_start := (v_item ->> 'started_at')::timestamptz;
      v_end := (v_item ->> 'ended_at')::timestamptz;
    exception when others then
      raise exception 'activity %: started_at and ended_at must be timestamps', v_idx using errcode = '22023';
    end;
    if v_start is null or v_end is null then
      raise exception 'activity %: started_at and ended_at are required', v_idx using errcode = '22023';
    end if;
    if v_end <= v_start then
      raise exception 'activity %: ended_at must be after started_at', v_idx using errcode = '22023';
    end if;
    begin
      v_dist := (v_item ->> 'distance_m')::float8;
      v_dur := (v_item ->> 'duration_s')::int;
      v_steps := (v_item ->> 'steps')::int;
    exception when others then
      raise exception 'activity %: distance_m, duration_s and steps must be numbers', v_idx using errcode = '22023';
    end;
    if v_dist is not null and (v_dist < 0 or v_dist <> v_dist or v_dist > 1e7) then
      raise exception 'activity %: distance_m must be between 0 and 10 000 000', v_idx using errcode = '22023';
    end if;
    v_dur := coalesce(v_dur, extract(epoch from v_end - v_start)::int);
    if v_dur < 0 then
      raise exception 'activity %: duration_s must be at least 0', v_idx using errcode = '22023';
    end if;
    if v_steps is not null and v_steps < 0 then
      raise exception 'activity %: steps must be at least 0', v_idx using errcode = '22023';
    end if;
    if v_type = 'steps' and v_steps is null then
      raise exception 'activity %: a steps sample needs steps', v_idx using errcode = '22023';
    end if;
    v_device := left(nullif(btrim(v_item ->> 'device'), ''), 120);
    v_bundle := left(nullif(btrim(v_item ->> 'app_bundle'), ''), 200);
    v_manual := coalesce((v_item ->> 'is_manual')::boolean, false);
    v_hash := left(nullif(btrim(v_item ->> 'raw_hash'), ''), 128);

    select * into v_cur from public.activities
     where user_id = p_user and source = v_src and external_id = v_ext
       for update;
    if found then
      if v_cur.raw_hash is not distinct from v_hash then
        -- same content: a no-op, except that an activity once refused as "in the future" whose end
        -- has since passed (clock skew at sync time) gets its real verdict now
        if v_cur.verdict = 'rejected_future' and v_cur.ended_at <= v_now + interval '5 minutes' then
          v_verdict := case when v_cur.is_manual then 'rejected_manual' else 'accepted' end;
          update public.activities
             set verdict = v_verdict, reject_reason = case when v_verdict = 'accepted' then null else 'entered by hand' end,
                 submitted_at = v_now
           where id = v_cur.id;
          v_touched := v_touched || v_cur.id;
          v_n := v_n + 1;
        end if;
        continue;
      end if;
      if v_cur.activity_type <> 'steps' or v_type <> 'steps' then
        raise exception 'activity % (% %) was already submitted with different content', v_idx, v_src, v_ext
          using errcode = '23514';
      end if;
      -- a daily step total grows during the day: only a later snapshot (or a larger one at the same
      -- instant) replaces the row; a stale re-send (offline queue flushed out of order) is a no-op
      if v_end < v_cur.ended_at or (v_end = v_cur.ended_at and coalesce(v_steps, 0) < coalesce(v_cur.steps, 0)) then
        continue;
      end if;
      if v_manual then
        v_verdict := 'rejected_manual'; v_reason := 'entered by hand';
      elsif v_end > v_now + interval '5 minutes' then
        v_verdict := 'rejected_future'; v_reason := 'ends in the future';
      else
        v_verdict := 'accepted'; v_reason := null;
      end if;
      update public.activities
         set started_at = v_start, ended_at = v_end, duration_s = v_dur, distance_m = v_dist, steps = v_steps,
             device = v_device, app_bundle = v_bundle, is_manual = v_manual, raw_hash = v_hash,
             submitted_at = v_now, verdict = v_verdict, reject_reason = v_reason
       where id = v_cur.id;
      v_touched := v_touched || v_cur.id;
      v_n := v_n + 1;
      continue;
    end if;

    -- verdict (order: type, manual, future, pace, duplicate)
    v_reason := null;
    v_limit := case when v_type in ('running', 'walking', 'hiking', 'swimming', 'rowing') then 12.0
                    when v_type = 'cycling' then 25.0 end;
    if v_type <> 'steps' and not (v_type = any (public.known_activity_types())) then
      v_verdict := 'rejected_type'; v_reason := 'unknown activity type';
    elsif v_manual then
      v_verdict := 'rejected_manual'; v_reason := 'entered by hand';
    elsif v_end > v_now + interval '5 minutes' then
      v_verdict := 'rejected_future'; v_reason := 'ends in the future';
    elsif v_limit is not null and v_dist is not null and v_dist / greatest(v_dur, 1) > v_limit then
      v_verdict := 'rejected_type'; v_reason := 'implausible pace';
    else
      v_verdict := 'accepted';
      if v_type <> 'steps' then
        select a.source, a.external_id into v_dup
          from public.activities a
         where a.user_id = p_user and a.verdict = 'accepted' and a.source <> v_src and a.activity_type <> 'steps'
           and a.started_at < v_end and a.ended_at > v_start
           and extract(epoch from (least(a.ended_at, v_end) - greatest(a.started_at, v_start)))
               >= 0.8 * extract(epoch from least(a.ended_at - a.started_at, v_end - v_start))
         order by a.started_at, a.id
         limit 1;
        if found then
          v_verdict := 'rejected_duplicate';
          v_reason := format('duplicate of %s %s', v_dup.source, v_dup.external_id);
        end if;
      end if;
    end if;

    insert into public.activities (user_id, source, external_id, activity_type, started_at, ended_at, distance_m, duration_s,
                                   steps, device, app_bundle, is_manual, raw_hash, submitted_at, verdict, reject_reason)
    values (p_user, v_src, v_ext, v_type, v_start, v_end, v_dist, v_dur, v_steps, v_device, v_bundle, v_manual, v_hash,
            v_now, v_verdict, v_reason)
    returning id into v_id;
    v_touched := v_touched || v_id;
    v_n := v_n + 1;
  end loop;

  -- Late evidence (C0-2): a closed instance whose window holds an accepted activity written above is
  -- recomputed for this user while now <= deadline + 24 h, like a late offline check-in. Lock order
  -- (20261107000300 header): the pact's carry before the instance.
  for v_inst in
    select distinct i.id, i.pact_id, p.group_id, i.deadline_at
      from public.activities a
      join public.pact_participants pp on pp.user_id = a.user_id
      join public.pacts p on p.id = pp.pact_id and p.kind in ('distance', 'workouts', 'steps')
      join public.pact_instances i
        on i.pact_id = p.id and i.closed_at is not null
       and a.started_at >= i.window_open_at and a.started_at < i.deadline_at
       and v_now <= i.deadline_at + interval '24 hours'
      join public.results r on r.instance_id = i.id and r.user_id = a.user_id
     where a.id = any (v_touched) and a.user_id = p_user
       and public.activity_matches_pact(p.kind, p.activity_types, a.activity_type)
     order by i.deadline_at, i.id
  loop
    perform public._lock_pact_carry(v_inst.group_id, v_inst.pact_id);
    if public._refresh_result(v_inst.id, p_user, v_now) then
      perform public.apply_instance_correction(v_inst.id);
    end if;
  end loop;

  return v_n;
end;
$$;

create function public.submit_activities(p_activities jsonb) returns int
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  return public.submit_activities_at(auth.uid(), p_activities, now());
end;
$$;

-- Service role only (the Strava function): the same rules for another user.
create function public.submit_activities_for(p_user uuid, p_activities jsonb) returns int
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if p_user is null then
    raise exception 'p_user is required' using errcode = '22023';
  end if;
  return public.submit_activities_at(p_user, p_activities, now());
end;
$$;

-- ---------------------------------------------------------------------
-- mark_done (custom kind)
-- ---------------------------------------------------------------------
create function public.mark_done_at(p_user uuid, p_instance uuid, p_photo_path text, p_now timestamptz) returns void
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_inst public.pact_instances;
  v_kind public.pact_kind;
  v_photo text := nullif(btrim(p_photo_path), '');
begin
  if p_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select p.kind into v_kind from public.pact_instances i join public.pacts p on p.id = i.pact_id where i.id = p_instance;
  if not found then
    raise exception 'instance not found' using errcode = 'P0002';
  end if;
  if v_kind <> 'custom' then
    raise exception 'only a custom challenge is marked done' using errcode = '23514';
  end if;
  if not public._on_instance_roster(p_instance, p_user) then
    raise exception 'not a participant of this pact instance' using errcode = '42501';
  end if;
  if v_photo is not null and char_length(v_photo) > 500 then
    raise exception 'photo_path must be at most 500 characters' using errcode = '22023';
  end if;
  select * into v_inst from public.pact_instances where id = p_instance for update;
  if v_inst.status = 'voided' and v_inst.closed_at is null then
    raise exception 'instance was cancelled (pact paused)' using errcode = '23514';
  end if;
  if v_now < v_inst.window_open_at then
    raise exception 'this day has not opened yet' using errcode = '23514';
  end if;
  if v_now > v_inst.deadline_at or v_inst.closed_at is not null then
    raise exception 'the deadline has passed; appeal the result instead' using errcode = '23514';
  end if;
  insert into public.custom_completions (instance_id, user_id, marked_at, photo_path)
  values (p_instance, p_user, v_now, v_photo)
  on conflict (instance_id, user_id) do update
     set photo_path = coalesce(excluded.photo_path, public.custom_completions.photo_path);
end;
$$;

create function public.mark_done(p_instance uuid, p_photo_path text default null) returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  perform public.mark_done_at(auth.uid(), p_instance, p_photo_path, now());
end;
$$;

-- ---------------------------------------------------------------------
-- Instances per period. Replaces the body under the heartbeat wrapper (same name, signature and
-- privileges; CA-1): daily exactly as 20261107000200, plus weekly and once.
-- ---------------------------------------------------------------------
create or replace function public._generate_instances_v1(p_days_ahead int default 7, p_now timestamptz default now())
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
      if v_pact.period = 'daily' then
        continue when not (extract(isodow from v_day)::smallint = any (v_pact.days_of_week));
        v_open := public._local_to_utc(v_day + v_pact.window_open_local, v_pact.tz);
        v_deadline := public._local_to_utc(v_day + v_pact.deadline_local, v_pact.tz);
        if v_open >= v_deadline then
          v_open := v_deadline - (v_pact.deadline_local - v_pact.window_open_local);
        end if;
      elsif v_pact.period = 'weekly' then
        -- one instance per ISO week: Monday 00:00 -> next Monday 00:00 in the pact zone
        continue when extract(isodow from v_day) <> 1;
        v_open := public._local_to_utc(v_day::timestamp, v_pact.tz);
        v_deadline := public._local_to_utc((v_day + 7)::timestamp, v_pact.tz);
      else
        -- once: the race, when its start is within the horizon
        continue when v_day <> v_pact.race_start;
        v_open := public._local_to_utc(v_pact.race_start::timestamp, v_pact.tz);
        v_deadline := public._local_to_utc((v_pact.race_end + 1)::timestamp, v_pact.tz);
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

-- ---------------------------------------------------------------------
-- Tick: weekly / once instances open quietly and get their Final call at 18:00 local the day before
-- the deadline (Sunday 18:00 for a week). Runs before the previous body in its own subtransaction.
-- ---------------------------------------------------------------------
create function public._tick_periodic(p_now timestamptz) returns void
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_cand record;
  v_inst public.pact_instances;
begin
  -- (a) scheduled -> open, no window_open push (CA-5)
  for v_cand in
    select i.id, p.group_id
      from public.pact_instances i join public.pacts p on p.id = i.pact_id
     where p.period <> 'daily' and not p.paused
       and i.status = 'scheduled' and i.window_open_at <= p_now
     order by i.window_open_at, i.id
  loop
    begin
      perform 1 from public.pact_instances where id = v_cand.id and status = 'scheduled' for update;
      if found then
        update public.pact_instances set status = 'open' where id = v_cand.id;
      end if;
    exception when others then
      insert into public.job_failures (job, group_id, error)
      values ('tick_instances', v_cand.group_id, sqlstate || ': ' || sqlerrm);
    end;
  end loop;

  -- (b) one deadline_soon per instance at 18:00 local the day before the deadline, to roster members
  --     who are short of the goal (or, for custom, have not marked the week done) and are not frozen
  for v_cand in
    select i.id, p.group_id, p.kind, p.goal_value
      from public.pact_instances i join public.pacts p on p.id = i.pact_id
     where p.period <> 'daily'
       and i.status = 'open' and i.deadline_soon_sent_at is null
       and p_now >= public._local_to_utc(((i.deadline_at at time zone p.tz)::date - 1) + time '18:00', p.tz)
       and p_now < i.deadline_at
     order by i.deadline_at, i.id
  loop
    begin
      select * into v_inst from public.pact_instances
       where id = v_cand.id and status = 'open' and deadline_soon_sent_at is null for update;
      if found then
        update public.pact_instances set deadline_soon_sent_at = p_now where id = v_inst.id;
        insert into public.notification_outbox (user_id, kind, payload)
        select u.uid, 'deadline_soon',
               public._instance_payload(v_inst.id, u.uid)
               || jsonb_build_object('minutes_left', ceil(extract(epoch from v_inst.deadline_at - p_now) / 60)::int)
          from public._instance_participants(v_inst.id) as u(uid)
         where not exists (select 1 from public.freezes f where f.instance_id = v_inst.id and f.user_id = u.uid)
           and case
                 when v_cand.kind = 'custom' then not exists (
                   select 1 from public.custom_completions c where c.instance_id = v_inst.id and c.user_id = u.uid)
                 else (select g.value from public._goal_progress(v_inst.id, u.uid, null) g) < v_cand.goal_value
               end;
      end if;
    exception when others then
      insert into public.job_failures (job, group_id, error)
      values ('tick_instances', v_cand.group_id, sqlstate || ': ' || sqlerrm);
    end;
  end loop;
end;
$$;

alter function public.tick_instances(timestamptz) rename to _tick_instances_v3;

create function public.tick_instances(p_now timestamptz default now()) returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
begin
  begin
    perform public._tick_periodic(v_now);
  exception when others then
    insert into public.job_failures (job, group_id, error) values ('tick_instances', null, sqlstate || ': ' || sqlerrm);
  end;
  perform public._tick_instances_v3(v_now);
end;
$$;

-- ---------------------------------------------------------------------
-- Freezes: weekly / once pacts allow one per calendar month (iso_week holds 'YYYY-MM')
-- ---------------------------------------------------------------------
create or replace function public.declare_freeze_at(p_user uuid, p_instance uuid, p_now timestamptz) returns uuid
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_inst public.pact_instances;
  v_period public.pact_period;
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
  select period into v_period from public.pacts where id = v_inst.pact_id;
  v_week := case when v_period = 'daily' then to_char(v_inst.local_date::timestamp, 'IYYY-"W"IW')
                 else to_char(v_inst.local_date::timestamp, 'YYYY-MM') end;
  perform 1 from public.pacts where id = v_inst.pact_id for update;
  if exists (select 1 from public.freezes where pact_id = v_inst.pact_id and user_id = p_user and iso_week = v_week) then
    if v_period = 'daily' then
      raise exception 'freeze already used for ISO week %', v_week using errcode = '23514';
    else
      raise exception 'freeze already used in %', v_week using errcode = '23514';
    end if;
  end if;
  insert into public.freezes (pact_id, user_id, instance_id, declared_at, iso_week)
  values (v_inst.pact_id, p_user, p_instance, v_now, v_week)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- leave_group: the open-window refusal applies to daily pacts (a week is always open)
-- ---------------------------------------------------------------------
create or replace function public.leave_group(p_group uuid) returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  -- NO KEY UPDATE: see GLOBAL LOCK ORDER in 20261107000300
  perform 1 from public.groups where id = p_group for no key update;
  select role into v_role from public.group_members
   where group_id = p_group and user_id = v_uid and left_at is null;
  if v_role is null then
    raise exception 'not a member of this group' using errcode = '42501';
  end if;

  -- No dodging a stake: refuse while on the roster of a DAILY instance that is open or due. Weekly
  -- and once pacts are open for days: leaving keeps you on the roster (left_at > window_open_at), so
  -- the week still scores you (D24, CA-7).
  if exists (
    select 1
      from public.pact_instances i
      join public.pacts p on p.id = i.pact_id
      join public.pact_participants pp on pp.pact_id = i.pact_id and pp.user_id = v_uid
     where p.group_id = p_group
       and p.period = 'daily'
       and pp.joined_at <= i.window_open_at
       and (pp.left_at is null or pp.left_at > i.window_open_at)
       and (i.status = 'open'
            or (i.status = 'scheduled' and i.window_open_at <= now() and now() < i.deadline_at))
  ) then
    raise exception 'cannot leave while a check-in window you are part of is open or awaiting its result'
      using errcode = '23514';
  end if;

  update public.group_members set left_at = now(), role = 'member'
   where group_id = p_group and user_id = v_uid;

  update public.pact_participants pp set left_at = now()
    from public.pacts p
   where p.id = pp.pact_id and p.group_id = p_group and pp.user_id = v_uid and pp.left_at is null;

  if v_role = 'owner' then
    update public.group_members set role = 'owner'
     where (group_id, user_id) = (
       select group_id, user_id from public.group_members
        where group_id = p_group and left_at is null
        order by joined_at, user_id
        limit 1
     );
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Settlement boundary: a week's instance ends exactly at the following Monday 00:00, which is also
-- the settlement week's end, so settlement takes instances with deadline_at <= week end and
-- default_open_reviews treats a weekly / once instance ending exactly at p_until as part of the week
-- being settled (CA-8). Daily instances never end exactly at midnight (window_open_local <
-- deadline_local), so for them both rules are unchanged. Same signatures and bodies as
-- 20261107000300 / 20261107000200 otherwise.
-- ---------------------------------------------------------------------
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
  for v_pact in select id from public.pacts where group_id = p_group order by id loop
    perform public._lock_pact_carry(p_group, v_pact);
  end loop;
  for v_rev in
    select r.id, r.opened_at,
           (select count(*) from public.review_votes v join public._review_voters(r.id) e(uid) on e.uid = v.voter_id
             where v.review_id = r.id and v.supports) as sup,
           (select count(*) from public.review_votes v join public._review_voters(r.id) e(uid) on e.uid = v.voter_id
             where v.review_id = r.id and not v.supports) as opp
      from public.reviews r
      join public.pact_instances i on i.id = r.instance_id
      join public.pacts p on p.id = i.pact_id
     where p.group_id = p_group and r.status = 'open'
       and (i.deadline_at < p_until or (i.deadline_at = p_until and p.period <> 'daily'))
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

create or replace function public._settle_group_week(p_group uuid, p_week date, p_week_end timestamptz,
                                                     p_now timestamptz default null)
returns uuid
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_settlement uuid;
  v_pact uuid;
  v_inst uuid;
  v_ids uuid[];
  v_c_ids uuid[];
  v_c_amt bigint[];
  v_d_ids uuid[];
  v_d_amt bigint[];
  v_total numeric;
  v_ci int;
  v_di int;
  v_amt bigint;
  i int;
begin
  for v_pact in select id from public.pacts where group_id = p_group order by id loop
    perform public._lock_pact_carry(p_group, v_pact);
  end loop;

  perform public.default_open_reviews(p_group, p_week_end);

  select coalesce(array_agg(i.id order by i.deadline_at, i.id), '{}') into v_ids
    from public.pact_instances i join public.pacts p on p.id = i.pact_id
   where p.group_id = p_group and i.status = 'closed' and i.deadline_at <= p_week_end;

  foreach v_inst in array v_ids loop
    perform public.apply_instance_correction(v_inst);
  end loop;
  update public.pact_instances set status = 'settled', settled_at = coalesce(p_now, now())
   where id = any (v_ids) and status = 'closed';

  update public.obligations set status = 'superseded'
   where group_id = p_group and status = 'pending';

  insert into public.settlements (group_id, week_start) values (p_group, p_week)
  returning id into v_settlement;

  select sum(balance_cents) into v_total from public.billable_member_balances where group_id = p_group;
  if coalesce(v_total, 0) > 0 then
    raise exception 'group % billable balances sum to % > 0: money cannot appear from nowhere', p_group, v_total
      using errcode = '23514';
  end if;

  with b as (
    select bb.user_id, bb.balance_cents::bigint as amt
      from public.billable_member_balances bb where bb.group_id = p_group
    union all
    select o.from_user, o.amount_cents from public.obligations o
     where o.group_id = p_group and o.status = 'marked_paid'
    union all
    select o.to_user, -o.amount_cents from public.obligations o
     where o.group_id = p_group and o.status = 'marked_paid'
  ), n as (
    select user_id, sum(amt)::bigint as amt from b group by user_id
  )
  select coalesce(array_agg(user_id order by user_id) filter (where amt > 0), '{}'),
         coalesce(array_agg(amt order by user_id) filter (where amt > 0), '{}'),
         coalesce(array_agg(user_id order by user_id) filter (where amt < 0), '{}'),
         coalesce(array_agg(-amt order by user_id) filter (where amt < 0), '{}')
    into v_c_ids, v_c_amt, v_d_ids, v_d_amt
    from n;

  loop
    v_ci := 0;
    for i in 1 .. coalesce(array_length(v_c_ids, 1), 0) loop
      if v_c_amt[i] > 0 and (v_ci = 0 or v_c_amt[i] > v_c_amt[v_ci]) then v_ci := i; end if;
    end loop;
    exit when v_ci = 0;
    v_di := 0;
    for i in 1 .. coalesce(array_length(v_d_ids, 1), 0) loop
      if v_d_amt[i] > 0 and (v_di = 0 or v_d_amt[i] > v_d_amt[v_di]) then v_di := i; end if;
    end loop;
    if v_di = 0 then
      raise exception 'settlement for group %: credits exceed debts', p_group using errcode = '23514';
    end if;
    v_amt := least(v_c_amt[v_ci], v_d_amt[v_di]);
    insert into public.obligations (settlement_id, group_id, from_user, to_user, amount_cents)
    values (v_settlement, p_group, v_d_ids[v_di], v_c_ids[v_ci], v_amt);
    v_c_amt[v_ci] := v_c_amt[v_ci] - v_amt;
    v_d_amt[v_di] := v_d_amt[v_di] - v_amt;
  end loop;

  return v_settlement;
end;
$$;

-- ---------------------------------------------------------------------
-- Outbox payload: the kind, period and goal travel with every instance push
-- ---------------------------------------------------------------------
create or replace function public._instance_payload(p_instance uuid, p_user uuid) returns jsonb
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
           'stake_cents', p.stake_cents,
           'kind', p.kind,
           'period', p.period,
           'goal_value', p.goal_value,
           'goal_unit', p.goal_unit))
    from public.pact_instances i
    join public.pacts p on p.id = i.pact_id
    left join public.pact_participants pp on pp.pact_id = p.id and pp.user_id = p_user
   where i.id = p_instance
$$;

-- ---------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.known_activity_types()',
    'public.activity_matches_pact(public.pact_kind, text[], text)',
    'public._pacts_lock_after_open()',
    'public._goal_progress(uuid, uuid, timestamptz)',
    'public._base_result(uuid, uuid)',
    'public._tick_periodic(timestamptz)',
    'public.submit_activities_at(uuid, jsonb, timestamptz)',
    'public.mark_done_at(uuid, uuid, text, timestamptz)',
    'public.submit_activities(jsonb)',
    'public.submit_activities_for(uuid, jsonb)',
    'public.mark_done(uuid, text)',
    'public.create_pact(uuid, text, smallint[], time, time, int, text, public.pact_kind, public.pact_period, numeric, text, text[], date, date)',
    'public.tick_instances(timestamptz)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;

  -- client RPCs
  foreach f in array array[
    'public.submit_activities(jsonb)',
    'public.mark_done(uuid, text)',
    'public.create_pact(uuid, text, smallint[], time, time, int, text, public.pact_kind, public.pact_period, numeric, text, text[], date, date)'
  ] loop
    execute format('grant execute on function %s to authenticated', f);
  end loop;

  -- server / service role
  foreach f in array array[
    'public.submit_activities_for(uuid, jsonb)',
    'public.tick_instances(timestamptz)'
  ] loop
    execute format('grant execute on function %s to service_role', f);
  end loop;

  -- plain helpers the security-invoker views and the activities policy run as the member
  grant execute on function public.known_activity_types() to authenticated, service_role;
  grant execute on function public.activity_matches_pact(public.pact_kind, text[], text) to authenticated, service_role;
end;
$$;
