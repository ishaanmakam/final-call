-- =====================================================================
-- Custom-kind proof: a custom challenge may require a photo with every mark.
-- Spec: docs/superpowers/specs/2026-11-08-challenge-kinds-design.md ("custom ... with optional photo");
-- the wizard's "Needs a photo" switch (CB-9) now has a column. Decisions CI-* in docs/DECISIONS.md.
--
--   * pacts.proof_required boolean not null default false; true only on kind 'custom' (check), and
--     locked with the kind / goal once a window has opened (the lock trigger gains the column).
--   * create_pact gains a 15th argument p_proof_required boolean default false. The 14-argument body
--     from 20261109000100 is kept verbatim as _create_pact_v2 (service only); the new create_pact
--     validates the flag, delegates, and sets the column. The 7-argument call is unchanged.
--   * mark_done_at raises 23514 'This challenge needs a photo' when the pact requires proof and no
--     photo path is given, unless an earlier mark already carries one (a repeat keeps the first).
-- =====================================================================

alter table public.pacts add column proof_required boolean not null default false;
alter table public.pacts
  add constraint pacts_proof_custom_only check (not proof_required or kind = 'custom');

-- ---------------------------------------------------------------------
-- Lock after open: proof_required joins the fixed columns (CA-11)
-- ---------------------------------------------------------------------
create or replace function public._pacts_lock_after_open() returns trigger
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if (new.kind, new.period, new.goal_value, new.goal_unit, new.activity_types, new.race_start, new.race_end, new.tz, new.proof_required)
     is distinct from
     (old.kind, old.period, old.goal_value, old.goal_unit, old.activity_types, old.race_start, old.race_end, old.tz, old.proof_required)
     and exists (
       select 1 from public.pact_instances i
        where i.pact_id = new.id
          and (i.status in ('open', 'closed', 'settled') or i.closed_at is not null
               or (i.status = 'scheduled' and i.window_open_at <= now()))
     ) then
    raise exception 'the kind, period, goal, activity types, race dates, proof rule and zone of a pact are locked once one of its windows has opened'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- create_pact: 15 arguments
-- ---------------------------------------------------------------------
alter function public.create_pact(uuid, text, smallint[], time, time, int, text, public.pact_kind, public.pact_period, numeric, text, text[], date, date)
  rename to _create_pact_v2;
revoke all on function public._create_pact_v2(uuid, text, smallint[], time, time, int, text, public.pact_kind, public.pact_period, numeric, text, text[], date, date)
  from public, anon, authenticated;

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
  p_race_end date default null,
  p_proof_required boolean default false
) returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_proof boolean := coalesce(p_proof_required, false);
  v_id uuid;
begin
  if v_proof and coalesce(p_kind, 'show_up') <> 'custom' then
    raise exception 'only a custom challenge can require a photo' using errcode = '22023';
  end if;
  v_id := public._create_pact_v2(p_group, p_title, p_days, p_window_open, p_deadline, p_stake_cents, p_tz,
                                 p_kind, p_period, p_goal_value, p_goal_unit, p_activity_types, p_race_start, p_race_end);
  if v_proof then
    update public.pacts set proof_required = true where id = v_id;
  end if;
  return v_id;
end;
$$;

revoke all on function public.create_pact(uuid, text, smallint[], time, time, int, text, public.pact_kind, public.pact_period, numeric, text, text[], date, date, boolean)
  from public, anon, authenticated;
grant execute on function public.create_pact(uuid, text, smallint[], time, time, int, text, public.pact_kind, public.pact_period, numeric, text, text[], date, date, boolean)
  to authenticated;

-- ---------------------------------------------------------------------
-- mark_done_at: the photo is required when the pact says so
-- ---------------------------------------------------------------------
create or replace function public.mark_done_at(p_user uuid, p_instance uuid, p_photo_path text, p_now timestamptz) returns void
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_inst public.pact_instances;
  v_kind public.pact_kind;
  v_proof boolean;
  v_photo text := nullif(btrim(p_photo_path), '');
begin
  if p_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select p.kind, p.proof_required into v_kind, v_proof
    from public.pact_instances i join public.pacts p on p.id = i.pact_id where i.id = p_instance;
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
  if v_proof and v_photo is null and not exists (
       select 1 from public.custom_completions c
        where c.instance_id = p_instance and c.user_id = p_user and c.photo_path is not null) then
    raise exception 'This challenge needs a photo' using errcode = '23514';
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
