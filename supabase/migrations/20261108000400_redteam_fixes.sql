-- =====================================================================
-- Red-team fixes (night-1). Spec: docs/REDTEAM.md, docs/DECISIONS.md RT-1..RT-4, docs/CONTRACT.md.
-- Every function here is `create or replace` over its last definition (0200 / 0300 / 0200-budget),
-- same signatures and privileges, except _post_initial which gains a trailing optional parameter.
--
-- RT-1  The opener of a challenge is not one of its voters (_review_voters). Before, the opener's
--       own vote counted: in a 2-person pact one member could turn the other's verified success
--       into a miss alone (1 of 1 eligible), and in any pact a lone challenger whose group stayed
--       silent won at settlement (majority of votes cast = their one vote). D3 is amended.
-- RT-2  An unverified result on a voided day stays `unverified` (success/failed still become
--       `void`). Before, every non-frozen result became `void`, so in a 2-person pact a member whose
--       every tap was unjudgeable voided every day: nothing to count for the unverified budget,
--       nothing to challenge, never a forfeit. Now such results count toward the budget, can be
--       challenged (human or automatic) on the voided day, and an accepted challenge that brings
--       the day to 2 active participants revives it: results recomputed, status `closed`, payout
--       posted with carry_in = 0 (a revived day never draws carry deposited after it). Oracle
--       computeResults, RULES_VERSION 3.
-- RT-3  mark_obligation_paid queues `obligation_marked_paid` for the payee and dispute_obligation
--       queues `obligation_disputed` for the payer. Before, a payment marked paid without paying was
--       silent: the payee learned of it only by opening the app, and until they disputed it the next
--       settlement treated it as paid (D7).
-- RT-4  _resolve_review re-runs the unverified-budget check after the result is refreshed. Before, a
--       miss appealed first (review open) and then turned unverified by a late tap never got its
--       automatic challenge: the trigger fired while the appeal was open (suppressed) and nothing
--       re-checked once the appeal defaulted.
-- =====================================================================

-- ---------------------------------------------------------------------
-- RT-1: voters
-- ---------------------------------------------------------------------
create or replace function public._review_voters(p_review uuid) returns setof uuid
language sql stable
set search_path = pg_catalog, public, pg_temp
as $$
  select u.uid
    from public.reviews r
    join public.pact_instances i on i.id = r.instance_id
    join public.pacts p on p.id = i.pact_id
    cross join lateral public._instance_participants(r.instance_id) as u(uid)
   where r.id = p_review
     and u.uid <> r.subject_user_id
     and not (r.kind = 'challenge' and u.uid = r.opened_by)
     and exists (select 1 from public.group_members m
                  where m.group_id = p.group_id and m.user_id = u.uid and m.left_at is null)
   order by u.uid
$$;

-- ---------------------------------------------------------------------
-- RT-2: results on voided days
-- ---------------------------------------------------------------------

-- One participant's result from check-ins, freezes and resolved reviews (what _refresh_result
-- computed inline before): base result, then resolved reviews in resolution order.
create or replace function public._computed_result(p_instance uuid, p_user uuid,
  out status public.result_status, out first_success_at timestamptz)
language plpgsql stable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_deadline timestamptz;
  v_rev record;
begin
  select i.deadline_at into v_deadline from public.pact_instances i where i.id = p_instance;
  select b.status, b.first_success_at into status, first_success_at from public._base_result(p_instance, p_user) b;
  for v_rev in
    select r.kind, r.status as rstatus from public.reviews r
     where r.instance_id = p_instance and r.subject_user_id = p_user and r.status <> 'open'
     order by r.resolved_at, r.opened_at, r.id
  loop
    if v_rev.kind = 'appeal' and v_rev.rstatus = 'accepted' then
      status := 'success';
      first_success_at := v_deadline;
    elsif v_rev.kind = 'challenge' and v_rev.rstatus = 'accepted' then
      status := 'failed';
      first_success_at := null;
    end if;
  end loop;
end;
$$;

-- First posting, with an optional override of the carry it draws (revived days pass 0).
drop function public._post_initial(uuid, uuid, uuid);
create function public._post_initial(p_instance uuid, p_group uuid, p_carry uuid, p_carry_in bigint default null)
returns void
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_carry_in bigint;
  v_pot uuid;
  v_out jsonb;
  v_in jsonb;
  v_total bigint;
  v_rollover boolean;
  v_plan jsonb;
  v_prev uuid;
begin
  for v_prev in
    select e.id from public.pact_instances e join public.pact_instances x on x.id = p_instance
     where e.pact_id = x.pact_id and e.id <> x.id
       and e.status in ('closed', 'settled') and e.carry_in_cents is null
       and (e.deadline_at, e.id) < (x.deadline_at, x.id)
     order by e.deadline_at, e.id
  loop
    perform 1 from public.pact_instances where id = v_prev and carry_in_cents is null for update;
    if found then
      perform public._post_initial(v_prev, p_group, p_carry);
    end if;
  end loop;

  v_carry_in := coalesce(p_carry_in, public._account_balance(p_carry));
  if v_carry_in < 0 then
    raise exception 'carry account % is negative (%)', p_carry, v_carry_in using errcode = '23514';
  end if;
  update public.pact_instances set carry_in_cents = v_carry_in where id = p_instance;

  select coalesce(jsonb_agg(jsonb_build_object('user_id', x.user_id, 'amount_cents', x.amount_cents)), '[]'::jsonb)
    into v_plan
    from public._payout_plan(p_instance, v_carry_in) x;
  if v_plan = '[]'::jsonb then
    return;
  end if;
  v_pot := public.ensure_account(p_group, 'pot', null, p_instance, null);

  select coalesce(sum(-amount_cents), 0),
         coalesce(jsonb_agg(jsonb_build_object(
           'account_id', case when user_id is null then p_carry
                              else public.ensure_account(p_group, 'member', user_id, null, null) end,
           'amount_cents', amount_cents)), '[]'::jsonb)
    into v_total, v_out
    from jsonb_to_recordset(v_plan) as x(user_id uuid, amount_cents bigint) where amount_cents < 0;
  if v_total > 0 then
    perform public.post_entry(p_group, 'stake', 'stake:' || p_instance, p_instance, 'stakes into the pot',
      v_out || jsonb_build_array(jsonb_build_object('account_id', v_pot, 'amount_cents', v_total)));
  end if;

  select coalesce(sum(amount_cents), 0),
         bool_or(user_id is null),
         coalesce(jsonb_agg(jsonb_build_object(
           'account_id', case when user_id is null then p_carry
                              else public.ensure_account(p_group, 'member', user_id, null, null) end,
           'amount_cents', amount_cents)), '[]'::jsonb)
    into v_total, v_rollover, v_in
    from jsonb_to_recordset(v_plan) as x(user_id uuid, amount_cents bigint) where amount_cents > 0;
  if v_total > 0 then
    if v_rollover then
      perform public.post_entry(p_group, 'rollover', 'rollover:' || p_instance, p_instance, 'all failed: pot rolls into the carry',
        v_in || jsonb_build_array(jsonb_build_object('account_id', v_pot, 'amount_cents', -v_total)));
    else
      perform public.post_entry(p_group, 'payout', 'payout:' || p_instance, p_instance, 'pot paid to winners',
        v_in || jsonb_build_array(jsonb_build_object('account_id', v_pot, 'amount_cents', -v_total)));
    end if;
  end if;
end;
$$;

-- 'result' outbox rows for every participant of a closed/voided instance (shared by close and revival).
create or replace function public._notify_results(p_instance uuid, p_rolled_over boolean) returns void
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
begin
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
           'rolled_over', p_rolled_over)
    from public.results r
   where r.instance_id = p_instance
   order by r.user_id;
end;
$$;

-- Re-evaluate a day voided at close (status 'voided', closed_at set): every participant's result from
-- check-ins and resolved reviews, then the void rule (fewer than 2 active: success/failed -> void;
-- frozen and unverified keep their status). If 2 or more are active now (a challenge of an unverified
-- result was accepted), the day is revived: status 'closed', payout posted with carry_in = 0, result
-- pushes queued. Caller holds the pact's carry lock. Returns true if anything changed.
create or replace function public._reclose_instance(p_instance uuid, p_now timestamptz) returns boolean
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_inst public.pact_instances;
  v_group uuid;
  v_carry uuid;
  v_active int := 0;
  v_successes int := 0;
  v_changed boolean := false;
  v_revive boolean;
  r record;
  v_target public.result_status;
  v_first timestamptz;
begin
  select * into v_inst from public.pact_instances where id = p_instance for update;
  if not found or v_inst.status <> 'voided' or v_inst.closed_at is null then
    return false;
  end if;
  for r in
    select x.status as cstatus
      from public.results res
      cross join lateral public._computed_result(p_instance, res.user_id) x
     where res.instance_id = p_instance
  loop
    if r.cstatus in ('success', 'failed') then v_active := v_active + 1; end if;
    if r.cstatus = 'success' then v_successes := v_successes + 1; end if;
  end loop;
  v_revive := v_active >= 2;

  for r in
    select res.user_id, res.status as cur, res.first_success_at as cur_first, x.status as cstatus, x.first_success_at as cfirst
      from public.results res
      cross join lateral public._computed_result(p_instance, res.user_id) x
     where res.instance_id = p_instance
     order by res.user_id
  loop
    v_target := case when not v_revive and r.cstatus in ('success', 'failed') then 'void'::public.result_status else r.cstatus end;
    v_first := case when v_target = 'success' then r.cfirst else null end;
    if v_target is distinct from r.cur or v_first is distinct from r.cur_first then
      update public.results set status = v_target, first_success_at = v_first, decided_at = p_now
       where instance_id = p_instance and user_id = r.user_id;
      v_changed := true;
    end if;
  end loop;

  if v_revive then
    select p.group_id into v_group from public.pacts p where p.id = v_inst.pact_id;
    v_carry := public._lock_pact_carry(v_group, v_inst.pact_id);
    update public.pact_instances set status = 'closed' where id = p_instance;
    if v_inst.carry_in_cents is null then
      perform public._post_initial(p_instance, v_group, v_carry, 0);
    end if;
    perform public._notify_results(p_instance, v_successes = 0);
    v_changed := true;
  end if;
  return v_changed;
end;
$$;

-- Closed/settled: one participant, as before (fix 6 keeps a day closed even if it drops below 2
-- active). Voided at close: the whole day is re-evaluated (_reclose_instance).
create or replace function public._refresh_result(p_instance uuid, p_user uuid, p_now timestamptz) returns boolean
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_inst public.pact_instances;
  v_cur public.results;
  v_status public.result_status;
  v_first timestamptz;
begin
  select * into v_inst from public.pact_instances where id = p_instance;
  if not found then
    return false;
  end if;
  if v_inst.status = 'voided' then
    if v_inst.closed_at is null then
      return false;
    end if;
    return public._reclose_instance(p_instance, p_now);
  end if;
  if v_inst.status not in ('closed', 'settled') then
    return false;
  end if;
  select * into v_cur from public.results where instance_id = p_instance and user_id = p_user for update;
  if not found then
    return false;
  end if;
  select x.status, x.first_success_at into v_status, v_first from public._computed_result(p_instance, p_user) x;
  if v_status is distinct from v_cur.status or v_first is distinct from v_cur.first_success_at then
    update public.results set status = v_status, first_success_at = v_first, decided_at = p_now
     where instance_id = p_instance and user_id = p_user;
    return true;
  end if;
  return false;
end;
$$;

comment on function public._refresh_result(uuid, uuid, timestamptz) is
  'Recompute a result on a closed/settled instance (one participant; base result then resolved reviews), or re-evaluate a '
  'day voided at close (_reclose_instance: void rule re-applied, revived to closed when 2+ are active). Returns true if changed.';

-- Close: as 20261107000200, except that the void rule keeps unverified (and frozen) results.
create or replace function public._close_instance(p_instance uuid, p_now timestamptz) returns void
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
    -- RT-2: only the active statuses become void; an unverified attempt stays on record
    update public.results set status = 'void', first_success_at = null, decided_at = p_now
     where instance_id = p_instance and status in ('success', 'failed');
    update public.pact_instances set status = 'voided', closed_at = p_now where id = p_instance;
  else
    update public.pact_instances set status = 'closed', closed_at = p_now where id = p_instance;
    perform public.post_instance_payout(p_instance);
  end if;

  perform public._notify_results(p_instance, not v_voided and v_successes = 0);
end;
$$;

-- Unverified budget: days voided at close count and can be challenged.
create or replace view public.unverified_month_counts with (security_invoker = true) as
select i.pact_id,
       r.user_id,
       date_trunc('month', i.local_date::timestamp)::date as month,
       count(*)::int as count
  from public.results r
  join public.pact_instances i on i.id = r.instance_id
 where r.status = 'unverified'
   and (i.status in ('closed', 'settled') or (i.status = 'voided' and i.closed_at is not null))
 group by i.pact_id, r.user_id, date_trunc('month', i.local_date::timestamp);

create or replace function public._auto_challenge_if_over_budget(p_instance uuid, p_user uuid, p_now timestamptz) returns uuid
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_inst public.pact_instances;
  v_n int;
  v_id uuid;
begin
  select * into v_inst from public.pact_instances where id = p_instance;
  if not found or not (v_inst.status in ('closed', 'settled') or (v_inst.status = 'voided' and v_inst.closed_at is not null)) then
    return null;
  end if;
  if not exists (
    select 1 from public.results r where r.instance_id = p_instance and r.user_id = p_user and r.status = 'unverified'
  ) then
    return null;
  end if;
  -- one challenge per (instance, subject) ever, human or automatic; nothing while a review is open
  if exists (
    select 1 from public.reviews r
     where r.instance_id = p_instance and r.subject_user_id = p_user
       and (r.kind = 'challenge' or r.status = 'open')
  ) then
    return null;
  end if;
  select count(*) into v_n
    from public.results r
    join public.pact_instances i on i.id = r.instance_id
   where i.pact_id = v_inst.pact_id
     and r.user_id = p_user
     and r.status = 'unverified'
     and (i.status in ('closed', 'settled') or (i.status = 'voided' and i.closed_at is not null))
     and date_trunc('month', i.local_date::timestamp) = date_trunc('month', v_inst.local_date::timestamp);
  if v_n <= 2 then
    return null;
  end if;

  insert into public.reviews (instance_id, subject_user_id, opened_by, kind, reason, photo_path, opened_at, system_opened)
  values (p_instance, p_user, p_user, 'challenge', 'Automatic: more than 2 unverified days this month', null,
          coalesce(p_now, now()), true)
  returning id into v_id;

  insert into public.notification_outbox (user_id, kind, payload)
  select u.uid, 'review_opened',
         public._instance_payload(p_instance, u.uid) || jsonb_strip_nulls(jsonb_build_object(
           'review_id', v_id,
           'review_kind', 'challenge',
           'subject_user_id', p_user,
           'subject_name', (select display_name from public.profiles where id = p_user),
           'system_opened', true,
           'unverified_this_month', v_n))
    from public._instance_participants(p_instance) as u(uid)
   order by u.uid;
  return v_id;
end;
$$;

-- The close of a day that is voided at close (closed_at set in the same statement; a pause's void has
-- no closed_at and no results).
create trigger instances_unverified_budget_void
  after update of status on public.pact_instances
  for each row
  when (new.status = 'voided' and old.status is distinct from 'voided' and new.closed_at is not null)
  execute function public._instances_unverified_budget_trg();

-- Reviews: a day voided at close accepts a challenge (of an unverified result; nothing else exists).
create or replace function public.open_review_at(
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
  elsif v_inst.status = 'voided' then
    -- RT-2: a day voided at close keeps unverified results on record; they can be challenged
    if v_inst.closed_at is null or p_kind is distinct from 'challenge' then
      raise exception 'a voided instance can only get a challenge of an unverified result' using errcode = '23514';
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

create or replace function public.cast_vote_at(p_user uuid, p_review uuid, p_supports boolean, p_now timestamptz) returns void
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_rev public.reviews;
  v_inst_status public.instance_status;
  v_closed_at timestamptz;
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
  select status, closed_at into v_inst_status, v_closed_at from public.pact_instances where id = v_rev.instance_id;
  if not exists (select 1 from public._review_voters(p_review) e where e = p_user) then
    raise exception 'not an eligible voter for this review' using errcode = '42501';
  end if;
  if v_rev.status <> 'open'
     or not (v_inst_status = 'closed'
             or (v_inst_status = 'settled' and v_rev.kind = 'challenge')
             or (v_inst_status = 'voided' and v_closed_at is not null and v_rev.kind = 'challenge')) then
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

-- Late taps recompute on every day that has closed (closed, settled, or voided at close).
create or replace function public.check_in_at(
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

  -- already closed (closed, settled, or voided at close): recompute (late offline -> unverified
  -- unless already success) and let the ledger catch up
  if v_inst.closed_at is not null and public._refresh_result(p_instance, p_user, v_now) then
    perform public.apply_instance_correction(p_instance);
  end if;
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------
-- RT-4: re-check the unverified budget once a review of the result is resolved
-- ---------------------------------------------------------------------
create or replace function public._resolve_review(p_review uuid, p_status public.review_status, p_now timestamptz) returns void
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
  -- an open appeal suppressed the automatic challenge while a late tap made the day unverified
  perform public._auto_challenge_if_over_budget(v_instance, v_subject, p_now);
  perform public.apply_instance_correction(v_instance);
end;
$$;

-- ---------------------------------------------------------------------
-- RT-3: settle-up pushes
-- ---------------------------------------------------------------------
create or replace function public._obligation_payload(p_ob public.obligations) returns jsonb
language sql stable
set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object(
           'obligation_id', p_ob.id,
           'settlement_id', p_ob.settlement_id,
           'group_id', p_ob.group_id,
           'group_name', (select g.name from public.groups g where g.id = p_ob.group_id),
           'from_user', p_ob.from_user,
           'from_name', (select pr.display_name from public.profiles pr where pr.id = p_ob.from_user),
           'to_user', p_ob.to_user,
           'to_name', (select pr.display_name from public.profiles pr where pr.id = p_ob.to_user),
           'amount_cents', p_ob.amount_cents,
           'url', '/groups/' || p_ob.group_id::text || '/ledger')
$$;

create or replace function public.mark_obligation_paid(p_obligation uuid)
returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_ob public.obligations%rowtype;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select * into v_ob from public.obligations where id = p_obligation for update;
  if not found then
    raise exception 'obligation not found' using errcode = 'P0002';
  end if;
  if v_ob.from_user <> v_uid then
    raise exception 'only the payer can mark an obligation paid' using errcode = '42501';
  end if;
  if v_ob.status = 'superseded' then
    raise exception 'obligation is superseded by a later settlement' using errcode = '23514';
  end if;
  if v_ob.status <> 'pending' then
    return;
  end if;
  update public.obligations set status = 'marked_paid', marked_paid_at = now() where id = p_obligation;
  -- the payee must know: until they confirm or dispute, the next settlement treats it as paid (D7)
  insert into public.notification_outbox (user_id, kind, payload)
  values (v_ob.to_user, 'obligation_marked_paid', public._obligation_payload(v_ob));
end;
$$;

create or replace function public.dispute_obligation(p_obligation uuid)
returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_ob public.obligations%rowtype;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select * into v_ob from public.obligations where id = p_obligation for update;
  if not found then
    raise exception 'obligation not found' using errcode = 'P0002';
  end if;
  if v_ob.to_user <> v_uid then
    raise exception 'only the payee can dispute an obligation' using errcode = '42501';
  end if;
  if v_ob.status = 'superseded' then
    raise exception 'obligation is superseded by a later settlement' using errcode = '23514';
  end if;
  if v_ob.status = 'confirmed' then
    raise exception 'obligation is already confirmed' using errcode = '23514';
  end if;
  if v_ob.status = 'pending' then
    return;
  end if;
  update public.obligations set status = 'pending', marked_paid_at = null where id = p_obligation;
  insert into public.notification_outbox (user_id, kind, payload)
  values (v_ob.from_user, 'obligation_disputed', public._obligation_payload(v_ob));
end;
$$;

-- ---------------------------------------------------------------------
-- Privileges: new internals are never client-callable; replaced functions keep their grants.
-- ---------------------------------------------------------------------
revoke all on function public._computed_result(uuid, uuid) from public, anon, authenticated;
revoke all on function public._reclose_instance(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public._notify_results(uuid, boolean) from public, anon, authenticated;
revoke all on function public._obligation_payload(public.obligations) from public, anon, authenticated;
revoke all on function public._post_initial(uuid, uuid, uuid, bigint) from public, anon, authenticated, service_role;
