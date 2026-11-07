-- pgTAP: payouts, corrections, settlement, settle-up. Run with `supabase test db` against a local stack.
-- (Copy/symlink into supabase/tests/database/ if your CLI version only looks there.)
-- Everything runs in one transaction and is rolled back. Mirrors supabase/tests/payouts.test.ts and
-- settlement.test.ts (dry-run against a pgTAP shim in payouts.test.ts).
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(20);

-- ---------------------------------------------------------------------
-- Fixtures (as postgres). a, b, c members of g1 (LA), x outsider. Pact p1 stake 500.
-- Group created Wed 2026-10-28, so its first week is Mon 2026-10-26 .. Sun 2026-11-01
-- (DST ends 2026-11-01): settlement due Mon 2026-11-02 12:00 PST = 20:00Z.
-- ---------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'a@pay.pgtap'),
  ('00000000-0000-0000-0000-0000000000b1', 'b@pay.pgtap'),
  ('00000000-0000-0000-0000-0000000000c1', 'c@pay.pgtap'),
  ('00000000-0000-0000-0000-0000000000f1', 'x@pay.pgtap');
insert into public.groups (id, name, invite_code, settlement_tz, created_by, created_at) values
  ('10000000-0000-0000-0000-0000000000e1', 'pgtap pay', 'PGTAPPAY01', 'America/Los_Angeles',
   '00000000-0000-0000-0000-0000000000a1', '2026-10-28T19:00:00Z');
insert into public.group_members (group_id, user_id, role) values
  ('10000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('10000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000b1', 'member'),
  ('10000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 'member');
insert into public.pacts (id, group_id, title, days_of_week, window_open_local, deadline_local, stake_cents, tz, created_by) values
  ('20000000-0000-0000-0000-0000000000e1', '10000000-0000-0000-0000-0000000000e1', 'pgtap pay', '{1,2,3,4,5}',
   '08:00', '09:00', 500, 'America/Los_Angeles', '00000000-0000-0000-0000-0000000000a1');
insert into public.pact_instances (id, pact_id, local_date, window_open_at, deadline_at, status, closed_at) values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000e1', '2026-10-28',
   '2026-10-28T15:00:00Z', '2026-10-28T16:00:00Z', 'closed', '2026-10-28T16:00:00Z'),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-0000000000e1', '2026-10-29',
   '2026-10-29T15:00:00Z', '2026-10-29T16:00:00Z', 'closed', '2026-10-29T16:00:00Z'),
  ('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-0000000000e1', '2026-10-30',
   '2026-10-30T15:00:00Z', '2026-10-30T16:00:00Z', 'closed', '2026-10-30T16:00:00Z');
insert into public.results (instance_id, user_id, status, first_success_at) values
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'success', '2026-10-28T15:30:00Z'),
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000b1', 'failed', null),
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1', 'failed', null),
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000a1', 'failed', null),
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000b1', 'failed', null),
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000c1', 'unverified', null),
  ('30000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000b1', 'success', '2026-10-30T15:30:00Z'),
  ('30000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000c1', 'failed', null);

create temp view t_effect as
select e.instance_id, a.kind, a.user_id, sum(l.amount_cents)::bigint as amt
  from public.ledger_entries e
  join public.ledger_lines l on l.entry_id = e.id
  join public.ledger_accounts a on a.id = l.account_id
 where e.instance_id is not null
 group by 1, 2, 3;

-- ---------------------------------------------------------------------
-- Payout
-- ---------------------------------------------------------------------
select public.post_instance_payout('30000000-0000-0000-0000-000000000001');
-- 1
select is((select amt from t_effect where instance_id = '30000000-0000-0000-0000-000000000001'
                                    and user_id = '00000000-0000-0000-0000-0000000000a1'),
          1000::bigint, 'k>=1: the winner takes both failed stakes');
-- 2
select is((select amt from t_effect where instance_id = '30000000-0000-0000-0000-000000000001' and kind = 'pot'),
          0::bigint, 'pot ends at 0');
-- 3
select public.post_instance_payout('30000000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.ledger_entries where instance_id = '30000000-0000-0000-0000-000000000001'),
          2, 'post_instance_payout is idempotent (stake + payout only)');

select public.post_instance_payout('30000000-0000-0000-0000-000000000002');
-- 4
select is((select balance_cents from public.account_balances where kind = 'carry'
            and pact_id = '20000000-0000-0000-0000-0000000000e1'),
          1000::bigint, 'k=0: failed stakes roll into the carry');
-- 5
select is((select array_agg(idempotency_key order by idempotency_key) from public.ledger_entries
            where instance_id = '30000000-0000-0000-0000-000000000002'),
          array['rollover:30000000-0000-0000-0000-000000000002', 'stake:30000000-0000-0000-0000-000000000002'],
          'k=0 posts stake then rollover');

select public.post_instance_payout('30000000-0000-0000-0000-000000000003');
-- 6
select is((select carry_in_cents from public.pact_instances where id = '30000000-0000-0000-0000-000000000003'),
          1000::bigint, 'carry_in_cents recorded at first posting');
-- 7
select is((select amt from t_effect where instance_id = '30000000-0000-0000-0000-000000000003'
                                    and user_id = '00000000-0000-0000-0000-0000000000b1'),
          1500::bigint, 'the winner collects the failed stake plus the carry');
-- 8
select is((select balance_cents from public.account_balances where kind = 'carry'
            and pact_id = '20000000-0000-0000-0000-0000000000e1'),
          0::bigint, 'the carry is emptied');

-- ---------------------------------------------------------------------
-- Correction: c's failure on instance 1 becomes excluded (appeal defaulted)
-- ---------------------------------------------------------------------
update public.results set status = 'excluded'
 where instance_id = '30000000-0000-0000-0000-000000000001' and user_id = '00000000-0000-0000-0000-0000000000c1';
select public.apply_instance_correction('30000000-0000-0000-0000-000000000001');
-- 9
select is((select amt from t_effect where instance_id = '30000000-0000-0000-0000-000000000001'
                                    and user_id = '00000000-0000-0000-0000-0000000000a1'),
          500::bigint, 'correction reduces the winner to one stake');
-- 10
select is((select count(*)::int from public.ledger_entries
            where idempotency_key = 'correction:30000000-0000-0000-0000-000000000001:1' and kind = 'correction'),
          1, 'one correction entry, numbered 1');

-- ---------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
-- 11
select throws_ok($$ select public.post_instance_payout('30000000-0000-0000-0000-000000000001') $$,
                 '42501', null, 'authenticated cannot execute post_instance_payout');
-- 12
select throws_ok($$ select public.settle_due_groups() $$, '42501', null, 'authenticated cannot execute settle_due_groups');
reset role;

-- ---------------------------------------------------------------------
-- Settlement timing (Monday 12:00 America/Los_Angeles, DST week)
-- ---------------------------------------------------------------------
-- 13
select is(public.settle_due_groups('2026-11-02T19:59:00Z'), 0, 'not due at Monday 11:59 PST');
-- 14
select is(public.settle_due_groups('2026-11-02T20:00:00Z'), 1, 'due at Monday 12:00 PST');
-- 15
select is((select count(*)::int from public.pact_instances
            where pact_id = '20000000-0000-0000-0000-0000000000e1' and status = 'settled'),
          3, 'closed instances of the week are settled');
-- 16  balances: a 0, b +500, c -500 -> one obligation c -> b 500
select is((select array_agg(from_user::text || '>' || to_user::text || ':' || amount_cents)
             from public.obligations where group_id = '10000000-0000-0000-0000-0000000000e1'),
          array['00000000-0000-0000-0000-0000000000c1>00000000-0000-0000-0000-0000000000b1:500'],
          'obligations simplify the balances');
-- 17
select throws_ok($$ select public.apply_instance_correction('30000000-0000-0000-0000-000000000003') $$,
                 '23514', null, 'settled instances reject corrections');

-- ---------------------------------------------------------------------
-- Settle-up
-- ---------------------------------------------------------------------
create temp table t_ob as select id from public.obligations where group_id = '10000000-0000-0000-0000-0000000000e1';
grant select on t_ob to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
select public.mark_obligation_paid((select id from t_ob));
-- 18
select throws_ok($$ select public.confirm_obligation((select id from t_ob)) $$, '42501', null, 'the payer cannot confirm');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
select public.confirm_obligation((select id from t_ob));
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
-- 19
select is((select count(*)::int from public.obligations), 0, 'outsiders see no obligations (RLS)');
reset role;
-- 20
select is((select array_agg(balance_cents order by user_id) from public.member_balances
            where group_id = '10000000-0000-0000-0000-0000000000e1'),
          array[0, 0, 0]::bigint[], 'confirmed payment zeroes the balances');

select * from finish();
rollback;
