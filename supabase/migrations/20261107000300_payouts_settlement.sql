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
--   * All money operations on a pact serialize on a row lock of the pact's carry account.
--
-- Corrections: posted net (sum of lines of entries with instance_id = X, pot excluded) is compared
-- with the plan from current results and the stored carry_in_cents; the difference is posted as
-- one 'correction' entry keyed correction:<instance_id>:<n>, n = 1 + existing corrections.
--
-- CARRY RULE FOR CORRECTIONS (the carry balance never goes negative; money is never created):
--   A correction can lower what instance A puts into the carry (or make A newly draw its stored
--   carry_in) after a later instance already drew that money out. Example: Mon all-fail adds
--   1500, Tue's winner draws 1500, then Mon's appeal is accepted. Posting Mon's difference as-is
--   would pay the same 1500 twice (carry -1500). Rule: when A's correction takes X out of the
--   carry, X is first taken back from LATER DRAWS on the carry, oldest first: unsettled
--   instances B of the same pact whose posted carry effect is negative and whose draw came after
--   A's first ledger line (if A never posted a line: deadline after A's). For each B,
--   carry_in_cents is lowered by r = min(remaining X, B's draw) and B is re-corrected (its
--   winners give back r under the normal floor/leftover split, notified as a 'result'
--   correction), which returns r to the carry. Only what no later draw took comes from the
--   carry balance itself. This is what would have happened had A's result been right from the
--   start: every draw empties the carry, so the first draw after A is the one that received
--   A's money; draws before A, and carry added after the draw, are never touched.
--   Corrections that ADD to the carry just leave it there for the next winning instance
--   (later instances' carry_in is never raised).
--   Fallback (unreachable in normal operation, because settlement settles weeks in order and
--   later draws are therefore unsettled whenever A is): if the balance would still go
--   negative, the remainder is cut from A's own correction (largest positive member lines
--   first, then user_id asc), so A's winners get less instead of the carry going negative.
--
-- Settlement: settle_due_groups(p_now) settles, per group and in order, every Mon-Sun week
-- (settlement_tz) whose Monday 12:00 local (next week) is <= p_now and that has no settlements
-- row yet, starting from the latest settled week + 7 or the week containing groups.created_at.
-- A week's instances are those whose deadline_at falls before the following Monday 00:00 in
-- settlement_tz (earlier stragglers included). Per week: default_open_reviews(group, that
-- Monday 00:00) -- the other agent's version defaults open reviews on instances with
-- deadline_at < p_until, so passing p_now (Monday noon) would wrongly default reviews of
-- Monday-morning instances of the new week; apply_instance_correction on every 'closed'
-- instance of the week (posts never-posted ones, reconciles changed ones), in deadline order; mark them 'settled'; supersede 'pending'/'marked_paid' obligations;
-- insert the settlements row; create obligations from all-time member_balances with the same
-- greedy as simplifyDebts (largest debtor <-> largest creditor, ties by user_id asc).
-- 'settlement' outbox rows go out only for the latest week settled in a run (catch-up weeks
-- are superseded immediately) to current members and anyone with a non-zero balance.
-- =====================================================================

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

-- Get the pact's carry account and take the per-pact money lock.
create or replace function public._lock_pact_carry(p_group uuid, p_pact uuid)
returns uuid
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_carry uuid;
begin
  v_carry := public.ensure_account(p_group, 'carry', null, null, p_pact);
  perform 1 from public.ledger_accounts where id = v_carry for update;
  return v_carry;
end;
$$;

-- First posting. Caller holds the carry lock and the instance row lock; carry_in_cents is null.
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
begin
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

-- Reconcile a posted instance with its plan. Caller holds the carry lock; instance is posted
-- (carry_in_cents not null) and not settled. Applies the carry safety rule (see header).
create or replace function public._correct_instance(p_instance uuid, p_group uuid, p_pact uuid, p_carry uuid)
returns void
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_carry_in bigint;
  v_diff jsonb;
  v_carry_diff bigint;
  v_short bigint;
  v_need bigint;
  v_pos bigint;
  v_cand record;
  v_r bigint;
  v_n int;
  v_line record;
  v_cut bigint;
begin
  select carry_in_cents into v_carry_in from public.pact_instances where id = p_instance for update;

  with t as (
    select case when x.user_id is null then p_carry
                else public.ensure_account(p_group, 'member', x.user_id, null, null) end as account_id,
           x.user_id, x.amount_cents
      from public._payout_plan(p_instance, v_carry_in) x
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

  if v_diff = '[]'::jsonb then
    return;
  end if;

  select coalesce(sum((e ->> 'amount_cents')::bigint), 0) into v_carry_diff
    from jsonb_array_elements(v_diff) e where (e ->> 'account_id')::uuid = p_carry;

  if v_carry_diff < 0 then
    -- The carry must give up -v_carry_diff. Whatever of it a later instance already drew out is
    -- taken back from that instance (oldest draw first); only the rest comes from the balance.
    v_need := -v_carry_diff;
    select min(l.id) into v_pos
      from public.ledger_entries e join public.ledger_lines l on l.entry_id = e.id
     where e.instance_id = p_instance;
    for v_cand in
      select i.id, i.carry_in_cents, -pc.amount_cents as drawn, dl.pos
        from public.pact_instances i
        join lateral (
          select sum(l.amount_cents)::bigint as amount_cents
            from public.ledger_entries e join public.ledger_lines l on l.entry_id = e.id
           where e.instance_id = i.id and l.account_id = p_carry
        ) pc on true
        join lateral (
          select min(l.id) as pos
            from public.ledger_entries e join public.ledger_lines l on l.entry_id = e.id
           where e.instance_id = i.id and l.account_id = p_carry and l.amount_cents < 0
        ) dl on true
       where i.pact_id = p_pact
         and i.id <> p_instance
         and i.status = 'closed'
         and i.carry_in_cents > 0
         and pc.amount_cents < 0
         and case when v_pos is not null then dl.pos > v_pos
                  -- A never posted a line: place it by deadline instead
                  else (i.deadline_at, i.id) > (select a.deadline_at, a.id from public.pact_instances a where a.id = p_instance)
             end
       order by dl.pos
    loop
      exit when v_need <= 0;
      v_r := least(v_need, v_cand.carry_in_cents, v_cand.drawn);
      update public.pact_instances set carry_in_cents = carry_in_cents - v_r where id = v_cand.id;
      perform public._correct_instance(v_cand.id, p_group, p_pact, p_carry);
      v_need := v_need - v_r;
    end loop;

    v_short := -(public._account_balance(p_carry) + v_carry_diff);
    if v_short > 0 then
      -- Fallback (later draws already settled): this correction absorbs what could not be
      -- recovered, cutting its largest positive member lines first (then user_id asc).
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
-- A never-posted closed instance is posted normally. Settled instances raise 23514.
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
  if v_status = 'settled' then
    raise exception 'instance % is settled; its results are final', p_instance using errcode = '23514';
  end if;
  if v_status not in ('closed', 'voided') then
    raise exception 'instance % is not closed (status %)', p_instance, v_status using errcode = '23514';
  end if;
  if v_carry_in is null then
    if v_status = 'closed' then
      perform public._post_initial(p_instance, v_group, v_carry);
    end if;
    return;
  end if;
  perform public._correct_instance(p_instance, v_group, v_pact, v_carry);
end;
$$;

-- Settle one group-week. Caller holds the group row lock. p_week_end = the following Monday
-- 00:00 in settlement_tz. Returns the settlements id.
create or replace function public._settle_group_week(p_group uuid, p_week date, p_week_end timestamptz)
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
  update public.pact_instances set status = 'settled' where id = any (v_ids) and status = 'closed';

  update public.obligations set status = 'superseded'
   where group_id = p_group and status in ('pending', 'marked_paid');

  insert into public.settlements (group_id, week_start) values (p_group, p_week)
  returning id into v_settlement;

  select sum(balance_cents) into v_total from public.member_balances where group_id = p_group;
  if coalesce(v_total, 0) > 0 then
    raise exception 'group % member balances sum to % > 0: money cannot appear from nowhere', p_group, v_total
      using errcode = '23514';
  end if;

  select coalesce(array_agg(user_id order by user_id), '{}'), coalesce(array_agg(balance_cents order by user_id), '{}')
    into v_c_ids, v_c_amt
    from public.member_balances where group_id = p_group and balance_cents > 0;
  select coalesce(array_agg(user_id order by user_id), '{}'), coalesce(array_agg(-balance_cents order by user_id), '{}')
    into v_d_ids, v_d_amt
    from public.member_balances where group_id = p_group and balance_cents < 0;

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
begin
  if p_now is null then
    raise exception 'settle_due_groups: p_now is required' using errcode = '22023';
  end if;
  for v_gid in select g.id from public.groups g order by g.id loop
    select g.id, g.name, g.settlement_tz, g.created_at into v_group
      from public.groups g where g.id = v_gid for update;
    select max(week_start) into v_last from public.settlements where group_id = v_group.id;
    v_week := coalesce(v_last + 7, date_trunc('week', v_group.created_at at time zone v_group.settlement_tz)::date);
    v_settlement := null;
    loop
      v_due := ((v_week + 7) + time '12:00') at time zone v_group.settlement_tz;
      exit when p_now < v_due;
      v_settlement := public._settle_group_week(v_group.id, v_week,
                                                ((v_week + 7)::timestamp) at time zone v_group.settlement_tz);
      v_last_week := v_week;
      v_count := v_count + 1;
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
          select mb.user_id from public.member_balances mb where mb.group_id = v_group.id and mb.balance_cents <> 0
        ) u
        left join public.member_balances b on b.group_id = v_group.id and b.user_id = u.user_id;
    end if;
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

-- ---------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------
revoke all on function public._payout_plan(uuid, bigint) from public, anon, authenticated, service_role;
revoke all on function public._instance_posted(uuid) from public, anon, authenticated, service_role;
revoke all on function public._account_balance(uuid) from public, anon, authenticated, service_role;
revoke all on function public._lock_pact_carry(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public._post_initial(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public._correct_instance(uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public._settle_group_week(uuid, date, timestamptz) from public, anon, authenticated, service_role;

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
