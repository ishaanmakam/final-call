-- =====================================================================
-- Seasons, streaks and settle-up completion (night-1, agent Q2). Spec: docs/CONTRACT.md
-- "Seasons and stats", docs/DESIGN.md "Seasons and streaks", docs/DECISIONS.md Q2-*.
--
-- Nothing here moves money or changes a result. These are read models over results and the
-- ledger plus one small setting on the pact:
--
--   pacts.season_start date null, pacts.season_weeks smallint null (1..12, both set or both null)
--   set_pact_season(p_pact, p_start, p_weeks)   -- owner or pact creator (like set_pact_paused);
--                                                  (null, null) clears
--   pact_season_recaps(pact_id, user_id, season_start, season_end, days, showed_up, missed,
--                      unverified, frozen, net_cents)
--       one row per (pact, member with a result) over the closed/settled instances whose
--       local_date lies in [season_start, season_start + 7*weeks); net_cents = that member's
--       ledger lines on those instances (stakes, payouts, corrections), so members + carry = 0
--   pact_streaks(pact_id, user_id, current_streak, best_streak)
--       consecutive successes over closed/settled instances in local_date order; frozen (and
--       the historical excluded) is neutral: it neither breaks nor extends; failed / unverified
--       break; voided days are not scheduled days for this purpose and are ignored
--   group_settlement_stats(group_id, obligations_created, obligations_confirmed, completion_rate,
--                          weeks_settled, last_settled_week)
--       created excludes superseded rows; completion_rate = confirmed / created (null when 0)
--
-- All three views are security_invoker: RLS on pacts / pact_instances / results / ledger_* /
-- groups / obligations / settlements limits them to the caller's groups. Grants: authenticated and
-- service_role; never anon.
-- =====================================================================

alter table public.pacts
  add column season_start date null,
  add column season_weeks smallint null check (season_weeks between 1 and 12),
  add constraint pacts_season_both_or_neither check ((season_start is null) = (season_weeks is null));

-- ---------------------------------------------------------------------
-- RPC
-- ---------------------------------------------------------------------
create function public.set_pact_season(p_pact uuid, p_start date, p_weeks smallint) returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_group uuid;
  v_creator uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select group_id, created_by into v_group, v_creator from public.pacts where id = p_pact;
  if v_group is null then
    raise exception 'pact not found' using errcode = 'P0002';
  end if;
  if not public.is_group_member(v_group) then
    raise exception 'not a member of this group' using errcode = '42501';
  end if;
  if v_creator <> v_uid and not exists (
    select 1 from public.group_members
     where group_id = v_group and user_id = v_uid and role = 'owner' and left_at is null
  ) then
    raise exception 'only the group owner or the pact creator can start or end a season' using errcode = '42501';
  end if;
  if (p_start is null) <> (p_weeks is null) then
    raise exception 'a season needs both a start date and a length in weeks, or neither' using errcode = '22023';
  end if;
  if p_weeks is not null and p_weeks not between 1 and 12 then
    raise exception 'a season runs between 1 and 12 weeks' using errcode = '23514';
  end if;
  update public.pacts set season_start = p_start, season_weeks = p_weeks where id = p_pact;
end;
$$;

revoke all on function public.set_pact_season(uuid, date, smallint) from public, anon;
grant execute on function public.set_pact_season(uuid, date, smallint) to authenticated;

-- ---------------------------------------------------------------------
-- Season recaps
-- ---------------------------------------------------------------------
create view public.pact_season_recaps with (security_invoker = true) as
with win as (
  select p.id as pact_id,
         p.season_start,
         (p.season_start + p.season_weeks * 7 - 1)::date as season_end
    from public.pacts p
   where p.season_start is not null and p.season_weeks is not null
),
inst as (
  select w.pact_id, w.season_start, w.season_end, i.id as instance_id
    from win w
    join public.pact_instances i on i.pact_id = w.pact_id
   where i.status in ('closed', 'settled')
     and i.local_date between w.season_start and w.season_end
),
res as (
  select n.pact_id, r.user_id, n.season_start, n.season_end,
         count(*) filter (where r.status in ('success', 'failed', 'unverified', 'frozen'))::int as days,
         count(*) filter (where r.status = 'success')::int as showed_up,
         count(*) filter (where r.status = 'failed')::int as missed,
         count(*) filter (where r.status = 'unverified')::int as unverified,
         count(*) filter (where r.status = 'frozen')::int as frozen
    from inst n
    join public.results r on r.instance_id = n.instance_id
   group by n.pact_id, r.user_id, n.season_start, n.season_end
),
net as (
  select n.pact_id, a.user_id, sum(l.amount_cents)::bigint as net_cents
    from inst n
    join public.ledger_entries e on e.instance_id = n.instance_id
    join public.ledger_lines l on l.entry_id = e.id
    join public.ledger_accounts a on a.id = l.account_id and a.kind = 'member'
   group by n.pact_id, a.user_id
)
select res.pact_id,
       res.user_id,
       res.season_start,
       res.season_end,
       res.days,
       res.showed_up,
       res.missed,
       res.unverified,
       res.frozen,
       coalesce(net.net_cents, 0)::bigint as net_cents
  from res
  left join net on net.pact_id = res.pact_id and net.user_id = res.user_id;

revoke all on public.pact_season_recaps from public, anon, authenticated;
grant select on public.pact_season_recaps to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Streaks
-- ---------------------------------------------------------------------
create view public.pact_streaks with (security_invoker = true) as
with days as (
  -- frozen (and the historical excluded) neither break nor extend, so they are simply not days here
  select i.pact_id, r.user_id, i.local_date, r.status
    from public.results r
    join public.pact_instances i on i.id = r.instance_id
   where i.status in ('closed', 'settled')
     and r.status in ('success', 'failed', 'unverified')
),
runs as (
  -- a run starts at every break; successes after it belong to it
  select pact_id, user_id, local_date, status,
         sum(case when status = 'success' then 0 else 1 end)
           over (partition by pact_id, user_id order by local_date rows unbounded preceding) as run_id
    from days
),
agg as (
  select pact_id, user_id, run_id,
         count(*) filter (where status = 'success')::int as len
    from runs
   group by pact_id, user_id, run_id
)
select pact_id,
       user_id,
       -- the last run: its successes, or 0 when the last day was a break
       (array_agg(len order by run_id desc))[1] as current_streak,
       max(len) as best_streak
  from agg
 group by pact_id, user_id;

revoke all on public.pact_streaks from public, anon, authenticated;
grant select on public.pact_streaks to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Settle-up completion: obligations confirmed on Venmo out of those created
-- ---------------------------------------------------------------------
create view public.group_settlement_stats with (security_invoker = true) as
select g.id as group_id,
       coalesce(o.created, 0)::int as obligations_created,
       coalesce(o.confirmed, 0)::int as obligations_confirmed,
       case when coalesce(o.created, 0) = 0 then null
            else round(o.confirmed::numeric / o.created, 4) end as completion_rate,
       coalesce(s.weeks, 0)::int as weeks_settled,
       s.last_week as last_settled_week
  from public.groups g
  left join (
    select group_id,
           count(*) filter (where status <> 'superseded') as created,
           count(*) filter (where status = 'confirmed') as confirmed
      from public.obligations
     group by group_id
  ) o on o.group_id = g.id
  left join (
    select group_id, count(*) as weeks, max(week_start) as last_week
      from public.settlements
     group by group_id
  ) s on s.group_id = g.id;

revoke all on public.group_settlement_stats from public, anon, authenticated;
grant select on public.group_settlement_stats to authenticated, service_role;
