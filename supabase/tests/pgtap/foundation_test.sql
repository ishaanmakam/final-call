-- pgTAP: foundation invariants. Run with `supabase test db` against a local stack.
-- (Copy/symlink into supabase/tests/database/ if your CLI version only looks there.)
-- Everything runs in one transaction and is rolled back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(26);

-- ---------------------------------------------------------------------
-- Fixtures (as postgres). a = owner, b = member, c = outsider, d = joiner.
-- Group g1 (invite code PGTAP00001) with pact p1.
-- ---------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@pgtap.local'),
  ('00000000-0000-0000-0000-00000000000b', 'b@pgtap.local'),
  ('00000000-0000-0000-0000-00000000000c', 'c@pgtap.local'),
  ('00000000-0000-0000-0000-00000000000d', 'd@pgtap.local');

insert into public.groups (id, name, invite_code, settlement_tz, created_by) values
  ('10000000-0000-0000-0000-000000000001', 'pgtap', 'PGTAP00001', 'America/Los_Angeles', '00000000-0000-0000-0000-00000000000a');
insert into public.group_members (group_id, user_id, role) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'owner'),
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000b', 'member');
insert into public.pacts (id, group_id, title, days_of_week, window_open_local, deadline_local, tz, created_by) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'pgtap pact', '{1,2,3,4,5}',
   '08:00', '09:00', 'America/Los_Angeles', '00000000-0000-0000-0000-00000000000a');

-- 1
select is((select count(*)::int from public.profiles where id::text like '00000000-0000-0000-0000-00000000000_'),
          4, 'auth.users insert creates profiles');

-- 2
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity),
          0, 'RLS enabled on every public table');

-- ---------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
-- 3
select throws_ok($$ select public.create_group('x', 'UTC') $$, '28000', null, 'create_group requires a user');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
-- 4
select isnt(public.create_group('a group', 'Europe/Berlin'), null, 'create_group returns an id');
-- 5
select throws_ok($$ select public.create_group('x', 'PST') $$, '22023', null, 'abbreviation time zones are rejected');
-- 6
select throws_ok($$ select public.create_group('x', 'Mars/Olympus_Mons') $$, '22023', null, 'unknown time zones are rejected');
-- 7
select throws_ok($$ select public.create_pact('10000000-0000-0000-0000-000000000001', 'x', '{1}', '09:00', '09:00', 500, 'UTC') $$,
                 '22023', null, 'window_open must be before deadline');
-- 8
select throws_ok($$ select public.create_pact('10000000-0000-0000-0000-000000000001', 'x', '{1}', '08:00', '09:00', 10001, 'UTC') $$,
                 '22023', null, 'stake above 10000 is rejected');
-- 9
select isnt(public.create_pact('10000000-0000-0000-0000-000000000001', 'ok', '{1,3}', '08:00', '09:00', 500, null),
            null, 'create_pact happy path');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', true);
-- 10
select throws_ok($$ select public.create_pact('10000000-0000-0000-0000-000000000001', 'x', '{1}', '08:00', '09:00', 500, 'UTC') $$,
                 '42501', null, 'non-member cannot create a pact');
-- 11
select throws_ok($$ select public.join_pact('20000000-0000-0000-0000-000000000001', 47.6, -122.3, 100, 'x') $$,
                 '42501', null, 'non-member cannot join a pact');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', true);
-- 12
select is(public.join_group('pgtap00001'), '10000000-0000-0000-0000-000000000001'::uuid, 'join_group by invite code');
-- 13
select lives_ok($$ select public.join_pact('20000000-0000-0000-0000-000000000001', 47.6, -122.3, 100, 'gym') $$,
                'member can join a pact');
reset role;

-- 14: 8-member cap (group now has a, b, d; add 5 more, then a 9th fails)
insert into auth.users (id, email)
  select ('30000000-0000-0000-0000-00000000000' || i)::uuid, 'cap' || i || '@pgtap.local' from generate_series(1, 6) i;
insert into public.group_members (group_id, user_id)
  select '10000000-0000-0000-0000-000000000001', ('30000000-0000-0000-0000-00000000000' || i)::uuid from generate_series(1, 5) i;
select throws_ok($$ insert into public.group_members (group_id, user_id)
                    values ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000006') $$,
                 '23514', null, 'ninth current member is rejected');

-- ---------------------------------------------------------------------
-- Ledger (as postgres)
-- ---------------------------------------------------------------------
create temp table t_acct on commit drop as select
  public.ensure_account('10000000-0000-0000-0000-000000000001', 'member', '00000000-0000-0000-0000-00000000000a', null, null) as a,
  public.ensure_account('10000000-0000-0000-0000-000000000001', 'member', '00000000-0000-0000-0000-00000000000b', null, null) as b;

-- 15
select is(public.ensure_account('10000000-0000-0000-0000-000000000001', 'member', '00000000-0000-0000-0000-00000000000a', null, null),
          (select a from t_acct), 'ensure_account is get-or-create');

create temp table t_entry on commit drop as select public.post_entry(
  '10000000-0000-0000-0000-000000000001', 'stake', 'pgtap:k1', null, 'test',
  jsonb_build_array(jsonb_build_object('account_id', a, 'amount_cents', -300),
                    jsonb_build_object('account_id', a, 'amount_cents', -200),
                    jsonb_build_object('account_id', b, 'amount_cents', 500))) as id
  from t_acct;

-- 16
select is((select public.post_entry('10000000-0000-0000-0000-000000000001', 'stake', 'pgtap:k1', null, 'again',
             jsonb_build_array(jsonb_build_object('account_id', b, 'amount_cents', 500),
                               jsonb_build_object('account_id', a, 'amount_cents', -500))) from t_acct),
          (select id from t_entry), 'post_entry is idempotent on identical merged lines');
-- 17
select is((select count(*)::int from public.ledger_lines where entry_id = (select id from t_entry)), 2,
          'lines are merged per account');
-- 18
select throws_ok($$ select public.post_entry('10000000-0000-0000-0000-000000000001', 'stake', 'pgtap:k1', null, 'conflict',
                      jsonb_build_array(jsonb_build_object('account_id', a, 'amount_cents', -1),
                                        jsonb_build_object('account_id', b, 'amount_cents', 1))) from t_acct $$,
                 '23505', null, 'reusing a key with different lines raises');
-- 19
select is((select public.post_entry('10000000-0000-0000-0000-000000000001', 'stake', 'pgtap:zero', null, 'z',
             jsonb_build_array(jsonb_build_object('account_id', a, 'amount_cents', 7),
                               jsonb_build_object('account_id', a, 'amount_cents', -7))) from t_acct),
          null::uuid, 'all-zero lines return null and insert nothing');
-- 20
select throws_ok($$ select public.post_entry('10000000-0000-0000-0000-000000000001', 'stake', 'pgtap:unbalanced', null, 'u',
                      jsonb_build_array(jsonb_build_object('account_id', a, 'amount_cents', -5),
                                        jsonb_build_object('account_id', b, 'amount_cents', 4))) from t_acct $$,
                 '23514', null, 'unbalanced lines are rejected');
-- 21
select throws_ok($$ update public.ledger_entries set memo = 'x' where idempotency_key = 'pgtap:k1' $$,
                 '55000', null, 'ledger_entries is append-only');
-- 22
select throws_ok($$ delete from public.ledger_lines where entry_id = (select id from t_entry) $$,
                 '55000', null, 'ledger_lines is append-only');

-- ---------------------------------------------------------------------
-- RLS / grants
-- ---------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', true);
-- 23
select is((select count(*)::int from public.ledger_entries), 0, 'non-member sees no ledger entries');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', true);
-- 24
select is((select count(*)::int from public.ledger_entries), 1, 'member sees their group ledger');
-- 25
select throws_ok($$ select public.post_entry('10000000-0000-0000-0000-000000000001', 'stake', 'evil', null, '', '[]') $$,
                 '42501', null, 'authenticated cannot execute post_entry');
reset role;

-- 26: zero-sum is checked by the deferred constraint trigger (forced now instead of at commit).
-- Kept last: the failed check leaves a pending unbalanced entry that the final ROLLBACK discards.
insert into public.ledger_entries (group_id, kind, idempotency_key)
  values ('10000000-0000-0000-0000-000000000001', 'correction', 'pgtap:direct');
insert into public.ledger_lines (entry_id, account_id, amount_cents)
  select e.id, t.a, 1 from public.ledger_entries e, t_acct t where e.idempotency_key = 'pgtap:direct';
select throws_ok($$ set constraints all immediate $$, '23514', null, 'zero-sum enforced by deferred constraint trigger');

select * from finish();
rollback;
