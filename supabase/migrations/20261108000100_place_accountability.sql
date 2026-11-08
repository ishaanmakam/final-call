-- =====================================================================
-- Place accountability. Spec: docs/CONTRACT.md "Places", "Place events"; docs/DECISIONS.md N1-*.
-- Owner: night-1 agent N1.
--
-- Problem: the fence a person sets was unaccountable. Someone could set their dorm room as
-- "class" and collect from honest friends every day; the group saw nothing.
--
-- Rules (full text in CONTRACT.md):
--   * Every current member of the group can read every participant's current and pending place
--     (view pact_places_visible) and the pairwise distances between places (RPC pact_place_distances).
--   * A first place (joining a pact) counts at once, as before (D11), so a pact can start today.
--   * A CHANGED place is gated when anybody else is in the group: it counts from the moment another
--     current member confirms it (acknowledge_place), but never sooner than 12 hours after the
--     change (D11's minimum), or 24 hours after the change if nobody confirms and nobody objects.
--     With nobody else in the group a change simply waits the 12 hours.
--   * Any place can be objected to (object_place, reason required) by another current member for
--     24 hours after it was set, unless a member already confirmed it. An objected place never
--     counts for a window opening after the objection; the setter must set a new place.
--   * A participant with no place in force when a window opens is judged against nothing: they
--     are not on that instance's roster (no result row, no money). A pending change leaves the
--     previous place in force, so this only happens when a first place was objected to.
--   * Every creation / confirmation / objection / timeout writes a place_events row (feed) and a
--     notification_outbox row of kind 'place_changed' (created -> the other members; the rest ->
--     the setter).
--
-- Mechanics:
--   pact_participant_places gains a surrogate id and the gate columns; effective_from stays the
--   instant the row starts to count (24 h after a gated change, moved earlier by a confirmation).
--   _place_row_at / _place_at skip objected rows and fall back only to ungated, unobjected rows.
--   _instance_participants requires a place in force at window open (not-yet-closed instances).
--   tick_instances is wrapped: the old body is renamed _tick_instances_v1 and the timeout events
--   are posted first (own subtransaction, failures go to job_failures).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------

alter table public.pact_participant_places
  add column id uuid not null default gen_random_uuid(),
  add column requires_ack boolean not null default false,
  add column acknowledged_at timestamptz null,
  add column acknowledged_by uuid null references public.profiles (id),
  add column objected_at timestamptz null,
  add column objected_by uuid null references public.profiles (id),
  add column objection_reason text null check (objection_reason is null or char_length(objection_reason) <= 280),
  add column effective_event_at timestamptz null;

create unique index pact_participant_places_id_uniq on public.pact_participant_places (id);
create index pact_participant_places_timeout_idx on public.pact_participant_places (effective_from)
  where requires_ack and acknowledged_at is null and objected_at is null and effective_event_at is null;

-- Feed rows. Self-contained snapshots: a pending place that is replaced is deleted (its row
-- would never count), so events keep the place and the previous place inline (place_id -> null).
create table public.place_events (
  id bigserial primary key,
  group_id uuid not null references public.groups (id),
  pact_id uuid not null references public.pacts (id) on delete cascade,
  place_id uuid null references public.pact_participant_places (id) on delete set null,
  user_id uuid not null references public.profiles (id),      -- whose place
  actor_id uuid not null references public.profiles (id),     -- who did it (setter, confirmer, objector)
  kind text not null check (kind in ('created', 'acknowledged', 'objected', 'effective')),
  label text null,
  lat float8 null,
  lng float8 null,
  radius_m int null,
  prev_label text null,
  prev_lat float8 null,
  prev_lng float8 null,
  prev_radius_m int null,
  distance_from_prev_m float8 null,
  reason text null,
  created_at timestamptz not null default now()
);
create index place_events_group_idx on public.place_events (group_id, created_at desc);
create index place_events_place_idx on public.place_events (place_id);
alter table public.place_events enable row level security;
create policy place_events_select on public.place_events for select to authenticated
  using (public.is_group_member(group_id));
revoke all on public.place_events from public, anon, authenticated;
grant select on public.place_events to authenticated;
grant all on public.place_events to service_role;
grant usage, select on sequence public.place_events_id_seq to service_role;

-- ---------------------------------------------------------------------
-- Which place is in force
-- ---------------------------------------------------------------------

-- The row in force at p_at: the latest row that started to count by then and was not objected to
-- by then. Fallback (for rows whose first place was written at wall-clock time after the window
-- in question, i.e. test fixtures and pre-history rows): the earliest ungated, unobjected row.
-- Null when the person has no place in force (first place objected to, nothing confirmed since).
-- Plain function (not SECURITY DEFINER): the views call it as the querying member.
create function public._place_row_at(p_pact uuid, p_user uuid, p_at timestamptz) returns uuid
language plpgsql stable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_id uuid;
begin
  select h.id into v_id
    from public.pact_participant_places h
   where h.pact_id = p_pact and h.user_id = p_user
     and h.effective_from <= p_at
     and (h.objected_at is null or h.objected_at > p_at)
   order by h.effective_from desc, h.created_at desc
   limit 1;
  if v_id is not null then
    return v_id;
  end if;
  select h.id into v_id
    from public.pact_participant_places h
   where h.pact_id = p_pact and h.user_id = p_user
     and not h.requires_ack and h.objected_at is null
   order by h.effective_from, h.created_at
   limit 1;
  return v_id;
end;
$$;

create or replace function public._place_at(p_pact uuid, p_user uuid, p_at timestamptz,
  out lat float8, out lng float8, out radius_m int)
language plpgsql stable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_id uuid := public._place_row_at(p_pact, p_user, p_at);
begin
  if v_id is not null then
    select h.lat, h.lng, h.radius_m into lat, lng, radius_m from public.pact_participant_places h where h.id = v_id;
    return;
  end if;
  -- no history at all (rows inserted outside join_pact): the participant row
  if not exists (select 1 from public.pact_participant_places h where h.pact_id = p_pact and h.user_id = p_user) then
    select pp.place_lat, pp.place_lng, pp.place_radius_m into lat, lng, radius_m
      from public.pact_participants pp
     where pp.pact_id = p_pact and pp.user_id = p_user;
  end if;
end;
$$;

-- Roster: as before, plus a place in force when the window opens (CONTRACT "Roster").
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
      join public.pact_participants pp on pp.pact_id = i.pact_id
     where i.id = p_instance and i.closed_at is null
       and pp.joined_at <= i.window_open_at
       and (pp.left_at is null or pp.left_at > i.window_open_at)
       and (select pl.lat from public._place_at(i.pact_id, pp.user_id, i.window_open_at) pl) is not null
  ) x
  order by u
$$;

-- ---------------------------------------------------------------------
-- Events + notifications
-- ---------------------------------------------------------------------

-- Writes the feed row for a place and queues the push. 'created' goes to every other current
-- member of the group; 'acknowledged' / 'objected' / 'effective' go to the setter.
create function public._place_event(p_place uuid, p_kind text, p_actor uuid, p_reason text) returns void
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_pl public.pact_participant_places%rowtype;
  v_pact public.pacts%rowtype;
  v_prev public.pact_participant_places%rowtype;
  v_prev_id uuid;
  v_dist float8;
  v_payload jsonb;
begin
  select * into v_pl from public.pact_participant_places where id = p_place;
  if not found then
    return;
  end if;
  select * into v_pact from public.pacts where id = v_pl.pact_id;
  -- the place that was in force when this one was requested
  v_prev_id := public._place_row_at(v_pl.pact_id, v_pl.user_id, v_pl.created_at);
  if v_prev_id is not null and v_prev_id <> v_pl.id then
    select * into v_prev from public.pact_participant_places where id = v_prev_id;
    v_dist := public._haversine_m(v_prev.lat, v_prev.lng, v_pl.lat, v_pl.lng);
  end if;

  insert into public.place_events (group_id, pact_id, place_id, user_id, actor_id, kind, label, lat, lng, radius_m,
                                   prev_label, prev_lat, prev_lng, prev_radius_m, distance_from_prev_m, reason)
  values (v_pact.group_id, v_pl.pact_id, v_pl.id, v_pl.user_id, p_actor, p_kind, v_pl.label, v_pl.lat, v_pl.lng, v_pl.radius_m,
          v_prev.label, v_prev.lat, v_prev.lng, v_prev.radius_m, v_dist, p_reason);

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'event', p_kind,
    'place_id', v_pl.id,
    'pact_id', v_pl.pact_id,
    'group_id', v_pact.group_id,
    'pact_title', v_pact.title,
    'user_id', v_pl.user_id,
    'user_name', (select display_name from public.profiles where id = v_pl.user_id),
    'actor_id', p_actor,
    'actor_name', (select display_name from public.profiles where id = p_actor),
    'label', v_pl.label,
    'radius_m', v_pl.radius_m,
    'prev_label', v_prev.label,
    'distance_from_prev_m', case when v_dist is null then null else round(v_dist::numeric)::int end,
    'requires_ack', v_pl.requires_ack,
    'effective_from', v_pl.effective_from,
    'reason', p_reason,
    'url', '/pacts/' || v_pl.pact_id::text));

  if p_kind = 'created' then
    insert into public.notification_outbox (user_id, kind, payload)
    select m.user_id, 'place_changed', v_payload
      from public.group_members m
     where m.group_id = v_pact.group_id and m.left_at is null and m.user_id <> v_pl.user_id
     order by m.user_id;
  else
    insert into public.notification_outbox (user_id, kind, payload) values (v_pl.user_id, 'place_changed', v_payload);
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- join_pact: same signature and refusals; changes are gated
-- ---------------------------------------------------------------------
create or replace function public.join_pact(
  p_pact uuid,
  p_lat float8,
  p_lng float8,
  p_radius_m int,
  p_label text
) returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_group uuid;
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
  select group_id into v_group from public.pacts where id = p_pact;
  if v_group is null then
    raise exception 'pact not found' using errcode = 'P0002';
  end if;
  if not public.is_group_member(v_group) then
    raise exception 'not a member of this group' using errcode = '42501';
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
   where not exists (select 1 from public.pact_participant_places where pact_id = p_pact and user_id = v_uid);

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
-- acknowledge_place / object_place (client RPCs)
-- ---------------------------------------------------------------------

create function public.acknowledge_place(p_place uuid) returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_pl public.pact_participant_places%rowtype;
  v_group uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select * into v_pl from public.pact_participant_places where id = p_place for update;
  if not found then
    raise exception 'place not found' using errcode = 'P0002';
  end if;
  select group_id into v_group from public.pacts where id = v_pl.pact_id;
  if not public.is_group_member(v_group) then
    raise exception 'not a member of this group' using errcode = '42501';
  end if;
  if v_pl.user_id = v_uid then
    raise exception 'you cannot confirm your own place' using errcode = '42501';
  end if;
  if v_pl.objected_at is not null then
    raise exception 'this place was objected to and cannot be confirmed; the owner must set a new one' using errcode = '23514';
  end if;
  if v_pl.acknowledged_at is not null then
    raise exception 'this place was already confirmed' using errcode = '23514';
  end if;
  if not v_pl.requires_ack then
    raise exception 'this place does not need a confirmation' using errcode = '23514';
  end if;
  if v_pl.effective_from <= now() then
    raise exception 'this place already counts' using errcode = '23514';
  end if;

  update public.pact_participant_places
     set acknowledged_at = now(),
         acknowledged_by = v_uid,
         effective_from = greatest(now(), created_at + interval '12 hours')
   where id = p_place;
  perform public._place_event(p_place, 'acknowledged', v_uid, null);
end;
$$;

create function public.object_place(p_place uuid, p_reason text) returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_reason text := nullif(btrim(p_reason), '');
  v_pl public.pact_participant_places%rowtype;
  v_group uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if v_reason is null then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  if char_length(v_reason) > 280 then
    raise exception 'reason must be at most 280 characters' using errcode = '22023';
  end if;
  select * into v_pl from public.pact_participant_places where id = p_place for update;
  if not found then
    raise exception 'place not found' using errcode = 'P0002';
  end if;
  select group_id into v_group from public.pacts where id = v_pl.pact_id;
  if not public.is_group_member(v_group) then
    raise exception 'not a member of this group' using errcode = '42501';
  end if;
  if v_pl.user_id = v_uid then
    raise exception 'you cannot object to your own place' using errcode = '42501';
  end if;
  if v_pl.objected_at is not null then
    raise exception 'this place was already objected to' using errcode = '23514';
  end if;
  if v_pl.acknowledged_at is not null then
    raise exception 'another member already confirmed this place' using errcode = '23514';
  end if;
  if v_pl.created_at + interval '24 hours' <= now() then
    raise exception 'too late to object: a place can be objected to for 24 hours after it is set' using errcode = '23514';
  end if;
  -- already replaced by a newer place that counts
  if v_pl.effective_from <= now() and public._place_row_at(v_pl.pact_id, v_pl.user_id, now()) is distinct from v_pl.id then
    raise exception 'this place was already replaced' using errcode = '23514';
  end if;

  update public.pact_participant_places
     set objected_at = now(), objected_by = v_uid, objection_reason = v_reason
   where id = p_place;
  perform public._place_event(p_place, 'objected', v_uid, v_reason);
end;
$$;

-- ---------------------------------------------------------------------
-- Timeouts: a gated change nobody confirmed or objected to starts to count 24 h after the
-- request (effective_from already says so); this posts the feed event once. Called by the tick.
-- ---------------------------------------------------------------------
create function public._place_timeouts(p_now timestamptz) returns int
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_row record;
  v_n int := 0;
begin
  for v_row in
    select h.id
      from public.pact_participant_places h
     where h.requires_ack and h.acknowledged_at is null and h.objected_at is null
       and h.effective_event_at is null and h.effective_from <= p_now
     order by h.effective_from, h.id
     for update skip locked
  loop
    update public.pact_participant_places set effective_event_at = p_now where id = v_row.id;
    perform public._place_event(v_row.id, 'effective', (select user_id from public.pact_participant_places where id = v_row.id), null);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

alter function public.tick_instances(timestamptz) rename to _tick_instances_v1;

create function public.tick_instances(p_now timestamptz default now()) returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
begin
  begin
    perform public._place_timeouts(v_now);
  exception when others then
    insert into public.job_failures (job, group_id, error) values ('place_timeouts', null, sqlstate || ': ' || sqlerrm);
  end;
  perform public._tick_instances_v1(v_now);
end;
$$;

-- ---------------------------------------------------------------------
-- What the client reads
-- ---------------------------------------------------------------------

-- Every current participant's place rows with their state, for members of the pact's group
-- (RLS of the base tables applies: security_invoker).
create view public.pact_places_visible with (security_invoker = true) as
select h.id as place_id,
       h.pact_id,
       p.group_id,
       h.user_id,
       pr.display_name as user_name,
       h.lat,
       h.lng,
       h.radius_m,
       h.label,
       h.created_at,
       h.effective_from,
       h.requires_ack,
       h.acknowledged_at,
       h.acknowledged_by,
       ap.display_name as acknowledged_by_name,
       h.objected_at,
       h.objected_by,
       op.display_name as objected_by_name,
       h.objection_reason,
       (cur.id = h.id) as is_current,
       case when h.objected_at is not null then 'objected'
            when h.effective_from > now() then 'pending'
            when cur.id = h.id then 'effective'
            else 'superseded' end as state,
       (h.requires_ack and h.acknowledged_at is null and h.objected_at is null and h.effective_from > now()) as acknowledgeable,
       (h.objected_at is null and h.acknowledged_at is null and h.created_at + interval '24 hours' > now()
         and (h.effective_from > now() or cur.id = h.id)) as objectable
  from public.pact_participant_places h
  join public.pact_participants pp on pp.pact_id = h.pact_id and pp.user_id = h.user_id and pp.left_at is null
  join public.pacts p on p.id = h.pact_id
  left join public.profiles pr on pr.id = h.user_id
  left join public.profiles ap on ap.id = h.acknowledged_by
  left join public.profiles op on op.id = h.objected_by
  cross join lateral (select public._place_row_at(h.pact_id, h.user_id, now()) as id) cur;

revoke all on public.pact_places_visible from public, anon, authenticated;
grant select on public.pact_places_visible to authenticated, service_role;

-- Pairwise metres between each participant's place (the one in force and any pending one) and
-- the other participants' places in force. Members of the pact's group only.
create function public.pact_place_distances(p_pact uuid)
returns table (
  pact_id uuid,
  place_id uuid,
  user_id uuid,
  label text,
  state text,
  other_user_id uuid,
  other_place_id uuid,
  other_label text,
  distance_m float8
)
language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not public.is_pact_group_member(p_pact) then
    raise exception 'not a member of this group' using errcode = '42501';
  end if;
  return query
    with v as (
      select h.id, h.user_id, h.label, h.lat, h.lng, h.effective_from, h.objected_at,
             (public._place_row_at(h.pact_id, h.user_id, now()) = h.id) as is_current
        from public.pact_participant_places h
        join public.pact_participants pp on pp.pact_id = h.pact_id and pp.user_id = h.user_id and pp.left_at is null
       where h.pact_id = p_pact
    )
    select p_pact, a.id, a.user_id, a.label,
           case when a.is_current then 'effective' else 'pending' end::text,
           b.user_id, b.id, b.label,
           public._haversine_m(a.lat, a.lng, b.lat, b.lng)
      from v a
      join v b on b.user_id <> a.user_id and b.is_current
     where a.is_current or (a.effective_from > now() and a.objected_at is null)
     order by a.user_id, a.id, b.user_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public._place_row_at(uuid, uuid, timestamptz)',
    'public._place_event(uuid, text, uuid, text)',
    'public._place_timeouts(timestamptz)',
    'public._tick_instances_v1(timestamptz)',
    'public.tick_instances(timestamptz)',
    'public.acknowledge_place(uuid)',
    'public.object_place(uuid, text)',
    'public.pact_place_distances(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  -- the views call it as the querying member; it only reads rows that member may read
  grant execute on function public._place_row_at(uuid, uuid, timestamptz) to authenticated;
  -- client RPCs
  grant execute on function public.acknowledge_place(uuid) to authenticated;
  grant execute on function public.object_place(uuid, text) to authenticated;
  grant execute on function public.pact_place_distances(uuid) to authenticated;
  -- server jobs
  grant execute on function public.tick_instances(timestamptz) to service_role;
  grant execute on function public._tick_instances_v1(timestamptz) to service_role;
  grant execute on function public._place_timeouts(timestamptz) to service_role;
end;
$$;
