-- =====================================================================
-- 20261108000800_instance_nets.sql  (night-1, Q1: the gate-close money moment)
--
-- Contract addition:
--   view instance_member_nets(instance_id, group_id, user_id, net_cents, pot_cents)   -- security_invoker
--       The posted ledger effect of one instance on each member, summed from ledger_lines over that
--       instance's entries (stake, payout, correction; rollover touches only pot and carry). One row per
--       member whose lines sum to a non-zero amount; a day that moved no money (unverified, frozen, void,
--       fewer than two in it) has no rows. `pot_cents` is the same on every row of an instance: everything
--       that was paid into its pot (forfeited pledges plus any carry it drew), i.e. the "pool" the client
--       names. Readable by group members under the ledger tables' own RLS; nothing is computed on the
--       client, which only looks up its own user_id.
-- =====================================================================

create view public.instance_member_nets with (security_invoker = true) as
with lines as (
  select e.instance_id, e.group_id, a.kind, a.user_id, l.amount_cents
    from public.ledger_entries e
    join public.ledger_lines l on l.entry_id = e.id
    join public.ledger_accounts a on a.id = l.account_id
   where e.instance_id is not null
), pots as (
  select instance_id, sum(amount_cents) filter (where amount_cents > 0)::bigint as pot_cents
    from lines
   where kind = 'pot'
   group by instance_id
)
select m.instance_id,
       m.group_id,
       m.user_id,
       sum(m.amount_cents)::bigint as net_cents,
       coalesce(p.pot_cents, 0)::bigint as pot_cents
  from lines m
  left join pots p on p.instance_id = m.instance_id
 where m.kind = 'member'
 group by m.instance_id, m.group_id, m.user_id, p.pot_cents
having sum(m.amount_cents) <> 0;

revoke all on public.instance_member_nets from public, anon, authenticated;
grant select on public.instance_member_nets to authenticated, service_role;
