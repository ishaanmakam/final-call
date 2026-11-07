-- =====================================================================
-- GLOBAL LOCK ORDER (every function in 20261107000100..0500 follows it; PGlite cannot test it)
--   1. groups row, FOR NO KEY UPDATE (settle_due_groups, leave_group; join_group / the member-cap
--      trigger use FOR UPDATE but take nothing below). Never FOR UPDATE on a path that waits for a
--      carry: FOR UPDATE conflicts with the FOR KEY SHARE that every ledger_entries / ledger_accounts
--      insert takes on its group (FK), so settlement holding the group FOR UPDATE and waiting for a
--      carry would deadlock with any money path holding that carry and posting an entry.
--   2. carry accounts (_lock_pact_carry), several at once only in (group_id, pact_id) order:
--      settle_due_groups (groups by id, then each group's pacts by id), default_open_reviews (its
--      group's pacts by id), tick_instances (pre-locks every pact it will touch, by group_id,
--      pact_id, before any instance). A transaction that may lock more than one of
--      {pact_instances, reviews, results} of a pact, or post to its ledger, takes that pact's carry
--      first: check_in_at, cast_vote_at, post_instance_payout, apply_instance_correction,
--      _settle_group_week, tick_instances.
--   3. pact_instances rows, then reviews, then results (in any order once the carry is held: the
--      carry serializes everything below it per pact).
--   Leaves that take a single row lock and wait for nothing below it: open_review_at and
--   declare_freeze_at (instance, then pacts row), join_pact (pacts row, participant row),
--   generate_instances, obligation RPCs (obligation row; their entries only take FK KEY SHARE).
-- =====================================================================
-- Payouts, corrections, weekly settlement, obligations (settle-up).
-- Spec: docs/CONTRACT.md ("Payout", "Settlement", "Settle-up"). Owner: payouts agent.
-- Oracle: packages/rules/src/index.ts (computeInstancePayout, simplifyDebts);
-- supabase/tests/differential.test.ts checks this file against it.
--
-- Money rules
--   * Integer cents only. Every ledger write goes through post_entry (idempotency keys);
--     ledger rows are never updated or deleted.
--   * Per instance, the "plan" is the target net effect per account (members + the pact's carry;
--     the pot always nets to 0): failed members -stake; k = 0 -> carry +stake*(n-k);
--     k >= 1 -> pot = stake*(n-k) + C, winners floor(pot/k), leftover cents one each by
--     first_success_at asc (nulls last), user_id asc; carry -C. Active = success + failed;
--     fewer than 2 active, or instance status 'voided' -> empty plan.
--   * C = carry_in_cents, stored on the instance at its first posting (= carry balance then).
--   * All money operations on a pact serialize on a row lock of the pact's carry account
--     (see GLOBAL LOCK ORDER above).
--
-- Corrections: posted net (sum of lines of entries with instance_id = X, pot excluded) is compared
-- with the plan from current results and the stored carry_in_cents; the difference is posted as
-- one 'correction' entry keyed correction:<instance_id>:<n>, n = 1 + existing corrections.
--
-- CARRY RULE FOR CORRECTIONS (D21: the carry balance never goes negative; money is never created):
--   A correction can lower what instance A puts into the carry (or make A newly draw its stored
--   carry_in) after later instances already captured that money. Example: Mon all-fail adds
--   1500, Tue's winner draws 1500, then Mon's appeal is accepted. Posting Mon's difference as-is
--   would pay the same 1500 twice (carry -1500). Rule: when A's correction takes X out of the
--   carry, walk the LATER CAPTURES of the carry in capture order: instances B of the same pact
--   (closed or settled) with carry_in_cents > 0 and (deadline_at, id) after A's. Capture order is
--   deadline order: tick closes and posts in deadline order, and _post_initial first posts any
--   earlier closed, never-posted instance. Each such B's carry_in was taken from a carry that
--   still held A's money, until the first draw after A emptied it.
--     * B drew its carry_in (posted carry effect < 0): carry_in is lowered by
--       r = min(remaining X, carry_in, draw) and B is re-corrected (its winners give back r under
--       the normal floor/leftover split, notified as a 'result' correction), which returns r to
--       the carry; X decreases by r. Settled draws are clawed back too: their correction lines
--       are billed at the next settlement like any correction of a settled instance.
--     * B did not draw it (all-fail rollover, or fewer than 2 active): carry_in is lowered by
--       min(remaining X, carry_in) so that a later correction of B can never draw money that is
--       gone; X is unchanged (the money is still in the carry or in a later draw).
--   Only what no later draw took comes from the carry balance itself. This is what would have
--   happened had A's result been right from the start: every draw empties the carry, so the
--   first draw after A is the one that received A's money; draws before A, and carry added
--   after the draw, are never touched. Corrections that ADD to the carry just leave it there for
--   the next winning instance (later instances' carry_in is never raised).
--   Fallback (only reachable if money left the carry outside any instance): if the balance would
--   still go negative, A's own carry_in_cents is lowered by the shortfall (when A draws it), so
--   A's target is recomputed with the smaller pot and split exactly like the oracle (floor, then
--   leftover cents by first_success_at asc, user_id asc); A's stored target then equals what is
--   posted and re-running the correction is a no-op. Any remainder beyond A's carry_in is cut from
--   A's correction (largest positive member lines first, then user_id asc).
--
-- Settlement: settle_due_groups(p_now) settles, per group and in order, every Mon-Sun week
-- (settlement_tz) whose Monday 12:00 local (next week) is <= p_now and that has no settlements
-- row yet, starting from the latest settled week + 7 or the week containing groups.created_at.
-- A week's instances are those whose deadline_at falls before the following Monday 00:00 in
-- settlement_tz (earlier stragglers included). Per week: default_open_reviews(group, that
-- Monday 00:00) -- the other agent's version defaults open reviews on instances with
-- deadline_at < p_until, so passing p_now (Monday noon) would wrongly default reviews of
-- Monday-morning instances of the new week; apply_instance_correction on every 'closed'
-- instance of the week (posts never-posted ones, reconciles changed ones), in deadline order;
-- mark them 'settled'; supersede 'pending' obligations ('marked_paid' ones stay confirmable and
-- disputable); insert the settlements row; create obligations from billable_member_balances
-- (lines of settled instances + settlement payments; closed-but-unsettled instances are not
-- billed yet), with every still-'marked_paid' obligation treated as provisionally paid (payer
-- +amount, payee -amount), using the same greedy as simplifyDebts (largest debtor <-> largest
-- creditor, ties by user_id asc). Corrections of settled instances (late offline check-ins,
-- claw-backs) are billed at the next settlement. Marking an instance 'settled' stamps settled_at
-- (the run's p_now). Late challenges of settled instances (allowed only for results changed after
-- settled_at, see 20261107000200) are resolved by the next week's default_open_reviews before
-- billing, so their corrections are billed in that run.
-- 'settlement' outbox rows go out only for the latest week settled in a run (catch-up weeks
-- are superseded immediately) to current members and anyone with a non-zero billable balance.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Billable balances: what settlement bills. Lines of entries whose instance is 'settled'
-- (stake/payout/rollover/correction member lines) plus all settlement_payment entries.
-- Closed-but-unsettled instances (e.g. Monday-morning instances of the new week, still open to
-- review) are billed at their own week's settlement. member_balances stays the full live view.
-- security_invoker: clients see only rows RLS lets them see, like member_balances.
-- ---------------------------------------------------------------------
create or replace view public.billable_member_balances with (security_invoker = true) as
select a.group_id,
       a.user_id,
       coalesce(sum(l.amount_cents) filter (where e.kind = 'settlement_payment' or i.status = 'settled'), 0)::bigint
         as balance_cents
  from public.ledger_accounts a
  left join public.ledger_lines l on l.account_id = a.id
  left join public.ledger_entries e on e.id = l.entry_id
  left join public.pact_instances i on i.id = e.instance_id
 where a.kind = 'member'
 group by a.id, a.group_id, a.user_id;

revoke all on public.billable_member_balances from anon, authenticated;
grant select on public.billable_member_balances to authenticated;

-- ---------------------------------------------------------------------
-- Internal helpers (not SECURITY DEFINER; callable only by the owner, i.e. from the
-- SECURITY DEFINER functions below).
-- ---------------------------------------------------------------------

-- Target net effect of an instance for a given carry_in. user_id null = the pact's carry.
create or replace function public._payout_plan(p_instance uuid, p_carry_in bigint)
returns table (user_id uuid, amount_cents bigint)
language plpgsql stable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_status public.instance_status;
  v_stake bigint;
  v_w int;
  v_l int;
  v_pot bigint;
  v_share bigint;
  v_left bigint;
begin
  select i.status, p.stake_cents into v_status, v_stake
    from public.pact_instances i join public.pacts p on p.id = i.pact_id
   where i.id = p_instance;
  if not found then
    raise exception 'instance % not found', p_instance using errcode = 'P0002';
  end if;
  if v_status = 'voided' then
    return;
  end if;
  if p_carry_in is null or p_carry_in < 0 then
    raise exception 'invalid carry_in % for instance %', p_carry_in, p_instance using errcode = '22023';
  end if;

  select count(*) filter (where r.status = 'success'), count(*) filter (where r.status = 'failed')
    into v_w, v_l
    from public.results r where r.instance_id = p_instance;
  if v_w + v_l < 2 then
    return;
  end if;

  return query
    select r.user_id, -v_stake from public.results r
     where r.instance_id = p_instance and r.status = 'failed';

  if v_w = 0 then
    user_id := null;
    amount_cents := v_stake * v_l;
    return next;
    return;
  end if;

  v_pot := v_stake * v_l + p_carry_in;
  v_share := v_pot / v_w;
  v_left := v_pot % v_w;
  return query
    select w.user_id, (v_share + case when w.rn <= v_left then 1 else 0 end)::bigint
      from (
        select r.user_id, row_number() over (order by r.first_success_at asc nulls last, r.user_id asc) as rn
          from public.results r
         where r.instance_id = p_instance and r.status = 'success'
      ) w
     where v_share + case when w.rn <= v_left then 1 else 0 end <> 0;

  if p_carry_in <> 0 then
    user_id := null;
    amount_cents := -p_carry_in;
    return next;
  end if;
end;
$$;

-- Net posted per non-pot account for an instance.
create or replace function public._instance_posted(p_instance uuid)
returns table (account_id uuid, kind public.ledger_account_kind, user_id uuid, amount_cents bigint)
language sql stable
set search_path = pg_catalog, public, pg_temp
as $$
  select a.id, a.kind, a.user_id, sum(l.amount_cents)::bigint
    from public.ledger_entries e
    join public.ledger_lines l on l.entry_id = e.id
    join public.ledger_accounts a on a.id = l.account_id
   where e.instance_id = p_instance and a.kind <> 'pot'
   group by a.id, a.kind, a.user_id
  having sum(l.amount_cents) <> 0
$$;

create or replace function public._account_balance(p_account uuid)
returns bigint
language sql stable
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(sum(amount_cents), 0)::bigint from public.ledger_lines where account_id = p_account
$$;

-- _lock_pact_carry(p_group, p_pact) is defined in 20261107000150_interfaces.sql.

-- First posting. Caller holds the carry lock and the instance row lock; carry_in_cents is null.
-- Earlier-deadline instances of the pact that are closed but were never posted (tick lag; settlement
-- catch-up) are posted first, in deadline order, so an instance never captures carry deposited by a
-- later instance. Otherwise a settled instance could draw money whose depositors belong to a later,
-- not yet billed week.
create or replace function public._post_initial(p_instance uuid, p_group uuid, p_carry uuid)
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

  v_carry_in := public._account_balance(p_carry);
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

  -- stake: every negative line (failed members, and the carry when k >= 1) pays into the pot.
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

  -- payout (to winners) or rollover (to the carry, when nobody succeeded): the pot pays out.
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

-- Difference between an instance's plan (for p_carry_in) and what is posted for it, as
-- [{account_id, user_id (null = carry), target, amount_cents}], non-zero amounts only, by account_id.
create or replace function public._instance_diff(p_instance uuid, p_group uuid, p_carry uuid, p_carry_in bigint)
returns jsonb
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_diff jsonb;
begin
  with t as (
    select case when x.user_id is null then p_carry
                else public.ensure_account(p_group, 'member', x.user_id, null, null) end as account_id,
           x.user_id, x.amount_cents
      from public._payout_plan(p_instance, p_carry_in) x
  ), p as (
    select account_id, user_id, amount_cents from public._instance_posted(p_instance)
  ), d as (
    select coalesce(t.account_id, p.account_id) as account_id,
           coalesce(t.user_id, p.user_id) as user_id,
           coalesce(t.amount_cents, 0) as target,
           coalesce(t.amount_cents, 0) - coalesce(p.amount_cents, 0) as amount_cents
      from t full join p on p.account_id = t.account_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('account_id', account_id, 'user_id', user_id,
                                               'target', target, 'amount_cents', amount_cents)
                            order by account_id) filter (where amount_cents <> 0), '[]'::jsonb)
    into v_diff
    from d;
  return v_diff;
end;
$$;

-- Reconcile a posted instance (carry_in_cents not null; closed or settled) with its plan.
-- Caller holds the carry lock. Applies the carry rule (see header).
create or replace function public._correct_instance(p_instance uuid, p_group uuid, p_pact uuid, p_carry uuid)
returns void
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_carry_in bigint;
  v_deadline timestamptz;
  v_diff jsonb;
  v_carry_diff bigint;
  v_carry_target bigint;
  v_short bigint;
  v_need bigint;
  v_cand record;
  v_r bigint;
  v_n int;
  v_line record;
  v_cut bigint;
begin
  select carry_in_cents, deadline_at into v_carry_in, v_deadline
    from public.pact_instances where id = p_instance for update;

  v_diff := public._instance_diff(p_instance, p_group, p_carry, v_carry_in);
  if v_diff = '[]'::jsonb then
    return;
  end if;

  select coalesce(sum((e ->> 'amount_cents')::bigint), 0), coalesce(sum((e ->> 'target')::bigint), 0)
    into v_carry_diff, v_carry_target
    from jsonb_array_elements(v_diff) e where (e ->> 'account_id')::uuid = p_carry;

  if v_carry_diff < 0 then
    -- The carry must give up -v_carry_diff. Later captures of the carry give back what they took
    -- of it (draws) or forget it (non-draws), in capture order; only the rest comes from the balance.
    v_need := -v_carry_diff;
    for v_cand in
      select i.id, coalesce(-pc.amount_cents, 0) as drawn
        from public.pact_instances i
        left join lateral (
          select sum(l.amount_cents)::bigint as amount_cents
            from public.ledger_entries e join public.ledger_lines l on l.entry_id = e.id
           where e.instance_id = i.id and l.account_id = p_carry
        ) pc on true
       where i.pact_id = p_pact
         and i.status in ('closed', 'settled')
         and i.carry_in_cents > 0
         and (i.deadline_at, i.id) > (v_deadline, p_instance)
       order by i.deadline_at, i.id
    loop
      exit when v_need <= 0;
      -- re-read: a recursive correction above may have lowered it already
      select least(v_need, i.carry_in_cents) into v_r from public.pact_instances i where i.id = v_cand.id for update;
      continue when v_r <= 0;
      if v_cand.drawn > 0 then
        v_r := least(v_r, v_cand.drawn);
        update public.pact_instances set carry_in_cents = carry_in_cents - v_r where id = v_cand.id;
        perform public._correct_instance(v_cand.id, p_group, p_pact, p_carry);
        v_need := v_need - v_r;
      else
        update public.pact_instances set carry_in_cents = carry_in_cents - v_r where id = v_cand.id;
      end if;
    end loop;

    v_short := -(public._account_balance(p_carry) + v_carry_diff);
    if v_short > 0 and v_carry_target < 0 and v_carry_in > 0 then
      -- Fallback 1: A draws its carry_in; draw only what the carry can still give. The plan is
      -- recomputed with the smaller pot, so winners lose it under the oracle's split order.
      v_cut := least(v_short, v_carry_in);
      update public.pact_instances set carry_in_cents = carry_in_cents - v_cut where id = p_instance;
      v_carry_in := v_carry_in - v_cut;
      v_short := v_short - v_cut;
      v_diff := public._instance_diff(p_instance, p_group, p_carry, v_carry_in);
      if v_diff = '[]'::jsonb then
        return;
      end if;
      select coalesce(sum((e ->> 'amount_cents')::bigint), 0) into v_carry_diff
        from jsonb_array_elements(v_diff) e where (e ->> 'account_id')::uuid = p_carry;
    end if;
    if v_short > 0 then
      -- Fallback 2 (remainder beyond A's own carry_in): cut A's correction, largest positive
      -- member lines first (then user_id asc).
      for v_line in
        select x.ord - 1 as idx, (x.val ->> 'amount_cents')::bigint as amt
          from jsonb_array_elements(v_diff) with ordinality as x(val, ord)
         where (x.val ->> 'user_id') is not null and (x.val ->> 'amount_cents')::bigint > 0
         order by (x.val ->> 'amount_cents')::bigint desc, (x.val ->> 'user_id') asc
      loop
        exit when v_short <= 0;
        v_cut := least(v_short, v_line.amt);
        v_diff := jsonb_set(v_diff, array[v_line.idx::text, 'amount_cents'], to_jsonb(v_line.amt - v_cut));
        v_diff := jsonb_set(v_diff, array[v_line.idx::text, 'target'],
                            to_jsonb(((v_diff -> (v_line.idx)::int) ->> 'target')::bigint - v_cut));
        v_short := v_short - v_cut;
        v_carry_diff := v_carry_diff + v_cut;
      end loop;
      if not exists (select 1 from jsonb_array_elements(v_diff) e where (e ->> 'account_id')::uuid = p_carry) then
        v_diff := v_diff || jsonb_build_array(jsonb_build_object('account_id', p_carry, 'user_id', null,
                                                                 'target', 0, 'amount_cents', 0));
      end if;
      select coalesce(jsonb_agg(case when (e ->> 'account_id')::uuid = p_carry
                                     then jsonb_set(e, '{amount_cents}', to_jsonb(v_carry_diff)) else e end), '[]'::jsonb)
        into v_diff
        from jsonb_array_elements(v_diff) e;
      select coalesce(jsonb_agg(e), '[]'::jsonb) into v_diff
        from jsonb_array_elements(v_diff) e where (e ->> 'amount_cents')::bigint <> 0;
      if v_diff = '[]'::jsonb then
        return;
      end if;
    end if;
  end if;

  select count(*)::int + 1 into v_n
    from public.ledger_entries where instance_id = p_instance and kind = 'correction';
  perform public.post_entry(p_group, 'correction', 'correction:' || p_instance || ':' || v_n, p_instance,
    'result correction ' || v_n,
    (select jsonb_agg(jsonb_build_object('account_id', e ->> 'account_id', 'amount_cents', (e ->> 'amount_cents')::bigint))
       from jsonb_array_elements(v_diff) e));

  insert into public.notification_outbox (user_id, kind, payload)
  select (e ->> 'user_id')::uuid, 'result',
         jsonb_build_object('instance_id', p_instance, 'pact_id', p_pact, 'group_id', p_group,
                            'correction', v_n,
                            'delta_cents', (e ->> 'amount_cents')::bigint,
                            'net_cents', (e ->> 'target')::bigint)
    from jsonb_array_elements(v_diff) e
   where (e ->> 'user_id') is not null;
end;
$$;

-- ---------------------------------------------------------------------
-- Server functions (service_role only)
-- ---------------------------------------------------------------------

-- Post stakes/payout/rollover for a closed instance. Idempotent: on an already-posted
-- instance it reconciles (a no-op when results are unchanged; a correction when they changed);
-- on a settled, posted instance it does nothing. Voided instances move no money.
create or replace function public.post_instance_payout(p_instance uuid)
returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_pact uuid;
  v_group uuid;
  v_status public.instance_status;
  v_carry_in bigint;
  v_carry uuid;
begin
  select i.pact_id, p.group_id into v_pact, v_group
    from public.pact_instances i join public.pacts p on p.id = i.pact_id
   where i.id = p_instance;
  if not found then
    raise exception 'instance % not found', p_instance using errcode = 'P0002';
  end if;
  v_carry := public._lock_pact_carry(v_group, v_pact);

  select i.status, i.carry_in_cents into v_status, v_carry_in
    from public.pact_instances i where i.id = p_instance for update;
  if v_status = 'voided' then
    return;
  end if;
  if v_status not in ('closed', 'settled') then
    raise exception 'instance % is not closed (status %)', p_instance, v_status using errcode = '23514';
  end if;
  if v_carry_in is null then
    perform public._post_initial(p_instance, v_group, v_carry);
  elsif v_status = 'closed' then
    perform public._correct_instance(p_instance, v_group, v_pact, v_carry);
  end if;
end;
$$;

-- Reconcile the ledger with the instance's current results (see header for the carry rule).
-- A never-posted closed instance is posted normally. Settled instances are corrected too (a late
-- offline check-in can arrive after settlement); their correction lines are billed at the next
-- settlement (billable_member_balances).
create or replace function public.apply_instance_correction(p_instance uuid)
returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_pact uuid;
  v_group uuid;
  v_status public.instance_status;
  v_carry_in bigint;
  v_carry uuid;
begin
  select i.pact_id, p.group_id into v_pact, v_group
    from public.pact_instances i join public.pacts p on p.id = i.pact_id
   where i.id = p_instance;
  if not found then
    raise exception 'instance % not found', p_instance using errcode = 'P0002';
  end if;
  v_carry := public._lock_pact_carry(v_group, v_pact);

  select i.status, i.carry_in_cents into v_status, v_carry_in
    from public.pact_instances i where i.id = p_instance for update;
  if v_status not in ('closed', 'settled', 'voided') then
    raise exception 'instance % is not closed (status %)', p_instance, v_status using errcode = '23514';
  end if;
  if v_carry_in is null then
    if v_status in ('closed', 'settled') then
      perform public._post_initial(p_instance, v_group, v_carry);
    end if;
    return;
  end if;
  perform public._correct_instance(p_instance, v_group, v_pact, v_carry);
end;
$$;

-- Settle one group-week. Caller holds the group row lock. p_week_end = the following Monday
-- 00:00 in settlement_tz; p_now = the settlement run time, stamped as settled_at. Returns the
-- settlements id.
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
  -- serialize with corrections on every pact of the group
  for v_pact in select id from public.pacts where group_id = p_group order by id loop
    perform public._lock_pact_carry(p_group, v_pact);
  end loop;

  perform public.default_open_reviews(p_group, p_week_end);

  select coalesce(array_agg(i.id order by i.deadline_at, i.id), '{}') into v_ids
    from public.pact_instances i join public.pacts p on p.id = i.pact_id
   where p.group_id = p_group and i.status = 'closed' and i.deadline_at < p_week_end;

  foreach v_inst in array v_ids loop
    perform public.apply_instance_correction(v_inst);
  end loop;
  update public.pact_instances set status = 'settled', settled_at = coalesce(p_now, now())
   where id = any (v_ids) and status = 'closed';

  -- Unpaid IOUs are recomputed (D7). Ones the payer marked paid stay open for the payee to
  -- confirm (or dispute back to pending) and count as paid below.
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

  -- Greedy, identical to simplifyDebts: largest creditor <-> largest debtor, ties by user_id asc
  -- (arrays are in user_id order and only a strictly larger amount replaces the pick).
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

-- job_failures is created in 20261107000150_interfaces.sql.

create or replace function public.settle_due_groups(p_now timestamptz default now())
returns int
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_gid uuid;
  v_group record;
  v_week date;
  v_last date;
  v_due timestamptz;
  v_settlement uuid;
  v_last_week date;
  v_count int := 0;
  v_group_count int;
begin
  if p_now is null then
    raise exception 'settle_due_groups: p_now is required' using errcode = '22023';
  end if;
  for v_gid in select g.id from public.groups g order by g.id loop
  -- Each group settles in its own subtransaction: one group's failure is recorded in job_failures
  -- and rolled back without blocking every other group's settlement.
  begin
    v_group_count := 0;
    select g.id, g.name, g.settlement_tz, g.created_at into v_group
      from public.groups g where g.id = v_gid for no key update;  -- see GLOBAL LOCK ORDER
    select max(week_start) into v_last from public.settlements where group_id = v_group.id;
    v_week := coalesce(v_last + 7, date_trunc('week', v_group.created_at at time zone v_group.settlement_tz)::date);
    v_settlement := null;
    loop
      v_due := ((v_week + 7) + time '12:00') at time zone v_group.settlement_tz;
      exit when p_now < v_due;
      v_settlement := public._settle_group_week(v_group.id, v_week,
                                                ((v_week + 7)::timestamp) at time zone v_group.settlement_tz, p_now);
      v_last_week := v_week;
      v_group_count := v_group_count + 1;
      v_week := v_week + 7;
    end loop;

    if v_settlement is not null then
      insert into public.notification_outbox (user_id, kind, payload)
      select u.user_id, 'settlement',
             jsonb_build_object('group_id', v_group.id, 'group_name', v_group.name, 'settlement_id', v_settlement,
                                'week_start', v_last_week, 'net_cents', coalesce(b.balance_cents, 0))
        from (
          select m.user_id from public.group_members m where m.group_id = v_group.id and m.left_at is null
          union
          select mb.user_id from public.billable_member_balances mb where mb.group_id = v_group.id and mb.balance_cents <> 0
        ) u
        left join public.billable_member_balances b on b.group_id = v_group.id and b.user_id = u.user_id;
    end if;
    v_count := v_count + v_group_count;
  exception when others then
    insert into public.job_failures (job, group_id, error)
    values ('settle_due_groups', v_gid, sqlstate || ': ' || sqlerrm);
  end;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------
-- Client RPCs: settle-up
-- ---------------------------------------------------------------------

-- Payer says they paid (e.g. on Venmo). pending -> marked_paid; repeat calls are no-ops.
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
end;
$$;

-- Payee confirms receipt. pending|marked_paid -> confirmed, posting the settlement_payment entry
-- (payer member +amount, payee member -amount) keyed payment:<obligation_id>. Repeat calls are no-ops.
create or replace function public.confirm_obligation(p_obligation uuid)
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
    raise exception 'only the payee can confirm an obligation' using errcode = '42501';
  end if;
  if v_ob.status = 'superseded' then
    raise exception 'obligation is superseded by a later settlement' using errcode = '23514';
  end if;
  if v_ob.status = 'confirmed' then
    return;
  end if;
  perform public.post_entry(v_ob.group_id, 'settlement_payment', 'payment:' || v_ob.id, null, 'settle-up payment',
    jsonb_build_array(
      jsonb_build_object('account_id', public.ensure_account(v_ob.group_id, 'member', v_ob.from_user, null, null),
                         'amount_cents', v_ob.amount_cents),
      jsonb_build_object('account_id', public.ensure_account(v_ob.group_id, 'member', v_ob.to_user, null, null),
                         'amount_cents', -v_ob.amount_cents)));
  update public.obligations
     set status = 'confirmed', confirmed_at = now(), marked_paid_at = coalesce(marked_paid_at, now())
   where id = p_obligation;
end;
$$;

-- Payee says the payment marked paid never arrived. marked_paid -> pending (the next settlement
-- supersedes it and bills the debt again); pending is a no-op; confirmed/superseded raise 23514.
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
end;
$$;

-- ---------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------
revoke all on function public._payout_plan(uuid, bigint) from public, anon, authenticated, service_role;
revoke all on function public._instance_posted(uuid) from public, anon, authenticated, service_role;
revoke all on function public._account_balance(uuid) from public, anon, authenticated, service_role;
revoke all on function public._post_initial(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public._instance_diff(uuid, uuid, uuid, bigint) from public, anon, authenticated, service_role;
revoke all on function public._correct_instance(uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public._settle_group_week(uuid, date, timestamptz, timestamptz) from public, anon, authenticated, service_role;

revoke all on function public.post_instance_payout(uuid) from public, anon, authenticated;
revoke all on function public.apply_instance_correction(uuid) from public, anon, authenticated;
revoke all on function public.settle_due_groups(timestamptz) from public, anon, authenticated;
grant execute on function public.post_instance_payout(uuid) to service_role;
grant execute on function public.apply_instance_correction(uuid) to service_role;
grant execute on function public.settle_due_groups(timestamptz) to service_role;

revoke all on function public.mark_obligation_paid(uuid) from public, anon;
revoke all on function public.confirm_obligation(uuid) from public, anon;
grant execute on function public.mark_obligation_paid(uuid) to authenticated;
grant execute on function public.confirm_obligation(uuid) to authenticated;
revoke all on function public.dispute_obligation(uuid) from public, anon;
grant execute on function public.dispute_obligation(uuid) to authenticated;
