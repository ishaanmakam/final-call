-- =====================================================================
-- Challenge kinds, red-team fixes (day 2). Tests: supabase/tests/redteam-kinds.test.ts (RK-*);
-- attack table in docs/REDTEAM.md "Challenge kinds (day 2)"; decisions CE-* in docs/DECISIONS.md.
--
--   * RK-1  join_pact (goal kinds): a rejoin keeps joined_at while you are still on the roster of an
--           instance that has opened and not closed (left_at > window_open_at). Leaving the group and
--           rejoining mid-week used to reset joined_at to now() and drop you from the open week.
--   * RK-9  leave_group: the open-window refusal applies to show_up pacts only. A steps day (00:00 to
--           23:59) or a custom day is open for hours; the roster rule (D24, CA-7) scores a leaver anyway.
--   * RK-2  submit_activities_at: a rejected_future row re-judged on re-submit gets the whole verdict
--           chain (pace, duplicate), not a bare "accepted".
--   * RK-3  a steps re-send that changes started_at (another day) is a no-op.
--   * RK-4  a steps re-send after the 24 h money cut-off of a steps instance the user is on is a no-op:
--           an in-time total can neither be erased (honest late watch data) nor inflated (appeal trick).
--   * RK-5  the duplicate rule applies to every source, the same one included (watch + phone both
--           writing HealthKit; a HealthKit edit that mints a new UUID). Steps samples still excluded.
--   * RK-6  duration_s is clamped to the elapsed time (plus 60 s of rounding slack): moving time
--           cannot exceed the activity, so it cannot hide an implausible pace or pad a workout.
--   * RK-7  source 'manual' is hand-entered whatever is_manual says; the client RPC refuses 'strava'
--           (that source only ever comes from the Strava function through submit_activities_for).
--   * RK-8  a batch holds at most 1000 items (22023).
-- Oracle: packages/rules RULES_VERSION 5 (activityVerdict: any-source duplicates, 'manual' source,
-- duration clamp). CONTRACT.md "Activities", "Roster" and join_pact updated.
-- =====================================================================

-- ---------------------------------------------------------------------
-- The verdict of one activity, shared by first submission and re-judging (RK-2, RK-5, RK-6, RK-7).
-- p_exclude: the row being re-judged (never its own duplicate).
-- ---------------------------------------------------------------------
create function public._activity_verdict(
  p_user uuid,
  p_source public.activity_source,
  p_type text,
  p_start timestamptz,
  p_end timestamptz,
  p_dist float8,
  p_dur int,
  p_manual boolean,
  p_now timestamptz,
  p_exclude uuid,
  out verdict public.activity_verdict,
  out reason text
)
language plpgsql stable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_limit float8 := case when p_type in ('running', 'walking', 'hiking', 'swimming', 'rowing') then 12.0
                         when p_type = 'cycling' then 25.0 end;
  v_dup record;
begin
  reason := null;
  if p_type <> 'steps' and not (p_type = any (public.known_activity_types())) then
    verdict := 'rejected_type'; reason := 'unknown activity type';
  elsif p_manual or p_source = 'manual' then
    verdict := 'rejected_manual'; reason := 'entered by hand';
  elsif p_end > p_now + interval '5 minutes' then
    verdict := 'rejected_future'; reason := 'ends in the future';
  elsif v_limit is not null and p_dist is not null and p_dist / greatest(p_dur, 1) > v_limit then
    verdict := 'rejected_type'; reason := 'implausible pace';
  else
    verdict := 'accepted';
    if p_type <> 'steps' then
      select a.source, a.external_id into v_dup
        from public.activities a
       where a.user_id = p_user and a.verdict = 'accepted' and a.activity_type <> 'steps'
         and (p_exclude is null or a.id <> p_exclude)
         and a.started_at < p_end and a.ended_at > p_start
         and extract(epoch from (least(a.ended_at, p_end) - greatest(a.started_at, p_start)))
             >= 0.8 * extract(epoch from least(a.ended_at - a.started_at, p_end - p_start))
       order by a.started_at, a.id
       limit 1;
      if found then
        verdict := 'rejected_duplicate';
        reason := format('duplicate of %s %s', v_dup.source, v_dup.external_id);
      end if;
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- submit_activities_at: same contract as 20261109000100 plus the fixes above
-- ---------------------------------------------------------------------
create or replace function public.submit_activities_at(p_user uuid, p_activities jsonb, p_now timestamptz) returns int
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
  v_elapsed int;
  v_steps int;
  v_device text;
  v_bundle text;
  v_manual boolean;
  v_hash text;
  v_cur public.activities;
  v_v record;
  v_cutoff timestamptz;
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
  if jsonb_array_length(p_activities) > 1000 then
    raise exception 'at most 1000 activities per call' using errcode = '22023';
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
    v_elapsed := extract(epoch from v_end - v_start)::int;
    v_dur := coalesce(v_dur, v_elapsed);
    if v_dur < 0 then
      raise exception 'activity %: duration_s must be at least 0', v_idx using errcode = '22023';
    end if;
    -- moving time never exceeds the activity itself (RK-6); 60 s covers rounding between sources
    if v_dur > v_elapsed + 60 then
      v_dur := v_elapsed;
    end if;
    if v_steps is not null and v_steps < 0 then
      raise exception 'activity %: steps must be at least 0', v_idx using errcode = '22023';
    end if;
    if v_type = 'steps' and v_steps is null then
      raise exception 'activity %: a steps sample needs steps', v_idx using errcode = '22023';
    end if;
    v_device := left(nullif(btrim(v_item ->> 'device'), ''), 120);
    v_bundle := left(nullif(btrim(v_item ->> 'app_bundle'), ''), 200);
    v_manual := coalesce((v_item ->> 'is_manual')::boolean, false) or v_src = 'manual';
    v_hash := left(nullif(btrim(v_item ->> 'raw_hash'), ''), 128);

    select * into v_cur from public.activities
     where user_id = p_user and source = v_src and external_id = v_ext
       for update;
    if found then
      if v_cur.raw_hash is not distinct from v_hash then
        -- same content: a no-op, except that an activity once refused as "in the future" whose end
        -- has since passed (clock skew at sync time) gets its real verdict now (the full chain, RK-2)
        if v_cur.verdict = 'rejected_future' and v_cur.ended_at <= v_now + interval '5 minutes' then
          select * into v_v from public._activity_verdict(p_user, v_cur.source, v_cur.activity_type, v_cur.started_at, v_cur.ended_at,
                                                          v_cur.distance_m, v_cur.duration_s, v_cur.is_manual, v_now, v_cur.id);
          update public.activities
             set verdict = v_v.verdict, reject_reason = v_v.reason, submitted_at = v_now
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
      -- instant) of the same day replaces the row; a stale re-send (offline queue flushed out of
      -- order) or one that moves the day (RK-3) is a no-op
      if v_start <> v_cur.started_at
         or v_end < v_cur.ended_at or (v_end = v_cur.ended_at and coalesce(v_steps, 0) < coalesce(v_cur.steps, 0)) then
        continue;
      end if;
      -- once the money cut-off of a steps day the user is on has passed, its total is final (RK-4)
      select min(i.deadline_at) into v_cutoff
        from public.pact_instances i
        join public.pacts p on p.id = i.pact_id and p.kind = 'steps'
        join public.pact_participants pp on pp.pact_id = p.id and pp.user_id = p_user
       where v_cur.started_at >= i.window_open_at and v_cur.started_at < i.deadline_at
         and pp.joined_at <= i.window_open_at and (pp.left_at is null or pp.left_at > i.window_open_at);
      if v_cutoff is not null and v_now > v_cutoff + interval '24 hours' then
        continue;
      end if;
      select * into v_v from public._activity_verdict(p_user, v_src, v_type, v_start, v_end, v_dist, v_dur, v_manual, v_now, v_cur.id);
      update public.activities
         set started_at = v_start, ended_at = v_end, duration_s = v_dur, distance_m = v_dist, steps = v_steps,
             device = v_device, app_bundle = v_bundle, is_manual = v_manual, raw_hash = v_hash,
             submitted_at = v_now, verdict = v_v.verdict, reject_reason = v_v.reason
       where id = v_cur.id;
      v_touched := v_touched || v_cur.id;
      v_n := v_n + 1;
      continue;
    end if;

    select * into v_v from public._activity_verdict(p_user, v_src, v_type, v_start, v_end, v_dist, v_dur, v_manual, v_now, null);
    insert into public.activities (user_id, source, external_id, activity_type, started_at, ended_at, distance_m, duration_s,
                                   steps, device, app_bundle, is_manual, raw_hash, submitted_at, verdict, reject_reason)
    values (p_user, v_src, v_ext, v_type, v_start, v_end, v_dist, v_dur, v_steps, v_device, v_bundle, v_manual, v_hash,
            v_now, v_v.verdict, v_v.reason)
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

-- Client RPC: Health (and nothing that pretends to be Strava; RK-7).
create or replace function public.submit_activities(p_activities jsonb) returns int
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_activities is not null and jsonb_typeof(p_activities) = 'array' and exists (
    select 1 from jsonb_array_elements(p_activities) e where jsonb_typeof(e.value) = 'object' and e.value ->> 'source' = 'strava'
  ) then
    raise exception 'Strava activities arrive through the Strava connection, not from the app' using errcode = '22023';
  end if;
  return public.submit_activities_at(auth.uid(), p_activities, now());
end;
$$;

-- ---------------------------------------------------------------------
-- join_pact: a rejoin while still on an open roster keeps joined_at (RK-1). Body as 20261109000100
-- otherwise.
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
  v_still_on boolean;
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
      -- Still on the roster of a window that has opened and not closed (left after it opened)? Then
      -- this is not a new join: joined_at stays and the week scores you (RK-1). Otherwise a rejoin
      -- counts from now (next roster).
      v_still_on := v_cur.left_at is not null and exists (
        select 1 from public.pact_instances i
         where i.pact_id = p_pact and i.closed_at is null and i.status <> 'voided'
           and i.window_open_at <= now()
           and v_cur.joined_at <= i.window_open_at and v_cur.left_at > i.window_open_at
      );
      update public.pact_participants
         set joined_at = case when left_at is null or v_still_on then joined_at else now() end,
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
-- leave_group: the open-window refusal is the show_up kind's (RK-9). Body as 20261109000100 otherwise.
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

  -- No dodging a stake: refuse while on the roster of a SHOW-UP instance that is open or due (a
  -- one-hour window). Goal and custom kinds are open for hours or days: leaving keeps you on the
  -- roster (left_at > window_open_at) and the instance scores you (D24, CA-7, RK-9).
  if exists (
    select 1
      from public.pact_instances i
      join public.pacts p on p.id = i.pact_id
      join public.pact_participants pp on pp.pact_id = i.pact_id and pp.user_id = v_uid
     where p.group_id = p_group
       and p.kind = 'show_up'
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
-- Privileges: the new helper is internal
-- ---------------------------------------------------------------------
revoke all on function public._activity_verdict(uuid, public.activity_source, text, timestamptz, timestamptz, float8, int, boolean, timestamptz, uuid)
  from public, anon, authenticated;
