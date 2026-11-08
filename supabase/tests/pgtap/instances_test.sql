-- pgTAP: instances, check-ins, freezes, results, reviews. Run with `supabase test db` against a local stack.
-- (Copy/symlink into supabase/tests/database/ if your CLI version only looks there.)
-- Dry-run against a pgTAP shim in tests/instances.test.ts. Everything is rolled back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(27);

-- Fixtures (as postgres): a, b, c, d participants; o outsider.
-- Pact p1: Mon-Fri 08:00-09:00 America/Los_Angeles. Monday 2030-01-07 = 16:00Z..17:00Z (PST).
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000001a1', 'a@inst.pgtap'),
  ('00000000-0000-0000-0000-0000000001b1', 'b@inst.pgtap'),
  ('00000000-0000-0000-0000-0000000001c1', 'c@inst.pgtap'),
  ('00000000-0000-0000-0000-0000000001d1', 'd@inst.pgtap'),
  ('00000000-0000-0000-0000-0000000001e1', 'o@inst.pgtap');
insert into public.groups (id, name, invite_code, settlement_tz, created_by) values
  ('10000000-0000-0000-0000-0000000001a1', 'inst', 'PGTAPINST1', 'America/Los_Angeles', '00000000-0000-0000-0000-0000000001a1');
insert into public.group_members (group_id, user_id, role)
select '10000000-0000-0000-0000-0000000001a1', u::uuid, case when u like '%1a1' then 'owner' else 'member' end
  from unnest(array['00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000001b1',
                    '00000000-0000-0000-0000-0000000001c1', '00000000-0000-0000-0000-0000000001d1']) u;
insert into public.pacts (id, group_id, title, days_of_week, window_open_local, deadline_local, tz, created_by) values
  ('20000000-0000-0000-0000-0000000001a1', '10000000-0000-0000-0000-0000000001a1', 'p1', '{1,2,3,4,5}', '08:00', '09:00',
   'America/Los_Angeles', '00000000-0000-0000-0000-0000000001a1'),
  ('20000000-0000-0000-0000-0000000001a2', '10000000-0000-0000-0000-0000000001a1', 'spring', '{7}', '01:30', '02:30',
   'America/Los_Angeles', '00000000-0000-0000-0000-0000000001a1'),
  ('20000000-0000-0000-0000-0000000001a3', '10000000-0000-0000-0000-0000000001a1', 'fall', '{7}', '01:00', '01:30',
   'America/Los_Angeles', '00000000-0000-0000-0000-0000000001a1');
insert into public.pact_participants (pact_id, user_id, place_lat, place_lng, place_radius_m, joined_at)
select '20000000-0000-0000-0000-0000000001a1', u::uuid, 47.6553, -122.3035, 100, '2020-01-01Z'
  from unnest(array['00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000001b1',
                    '00000000-0000-0000-0000-0000000001c1', '00000000-0000-0000-0000-0000000001d1']) u;

-- generation ------------------------------------------------------------------------------
-- 1
select is(public.generate_instances(7, '2030-01-06T12:00:00Z'), 7,
          'generate_instances: Mon-Fri for p1 plus next Sunday for the two Sunday pacts (today''s Sunday windows are past)');
-- 2
select is(public.generate_instances(7, '2030-01-06T12:00:00Z'), 0, 'generate_instances is idempotent');
-- 3
select is((select window_open_at from public.pact_instances
            where pact_id = '20000000-0000-0000-0000-0000000001a1' and local_date = '2030-01-07'),
          '2030-01-07T16:00:00Z'::timestamptz, 'window opens 08:00 local (PST)');
-- 4
select lives_ok($$ select public.generate_instances(1, '2027-03-13T12:00:00Z') $$, 'generate across spring forward');
-- 5
select is((select deadline_at from public.pact_instances
            where pact_id = '20000000-0000-0000-0000-0000000001a2' and local_date = '2027-03-14'),
          '2027-03-14T10:30:00Z'::timestamptz, 'spring forward: nonexistent 02:30 shifts forward to 03:30 PDT');
-- 6
select lives_ok($$ select public.generate_instances(1, '2026-10-31T12:00:00Z') $$, 'generate across fall back');
-- 7
select is((select window_open_at from public.pact_instances
            where pact_id = '20000000-0000-0000-0000-0000000001a3' and local_date = '2026-11-01'),
          '2026-11-01T08:00:00Z'::timestamptz, 'fall back: ambiguous 01:00 resolves to the earlier instant (PDT)');

-- freezes -------------------------------------------------------------------------------
-- 8
select lives_ok($$ select public.declare_freeze_at('00000000-0000-0000-0000-0000000001c1',
  (select id from public.pact_instances where pact_id = '20000000-0000-0000-0000-0000000001a1' and local_date = '2030-01-07'),
  '2030-01-07T15:00:00Z') $$, 'freeze declared before the window');
-- 9
select throws_ok($$ select public.declare_freeze_at('00000000-0000-0000-0000-0000000001c1',
  (select id from public.pact_instances where pact_id = '20000000-0000-0000-0000-0000000001a1' and local_date = '2030-01-08'),
  '2030-01-07T15:00:00Z') $$, '23514', null, 'second freeze in the same ISO week is rejected');

-- opening and check-ins ------------------------------------------------------------------
select public.tick_instances('2030-01-07T16:00:00Z');
-- 10
select is((select status::text from public.pact_instances
            where pact_id = '20000000-0000-0000-0000-0000000001a1' and local_date = '2030-01-07'),
          'open', 'tick opens the instance at window_open_at');
-- 11
select is((select verdict::text from public.check_in_at('00000000-0000-0000-0000-0000000001a1',
  (select id from public.pact_instances where pact_id = '20000000-0000-0000-0000-0000000001a1' and local_date = '2030-01-07'),
  47.6553, -122.3035, 10, '2030-01-07T16:05:00Z', false, '30000000-0000-0000-0000-0000000001a1', '2030-01-07T16:05:00Z')),
  'in_fence', 'check-in at the place is in_fence');
-- 12
select is((select verdict::text from public.check_in_at('00000000-0000-0000-0000-0000000001a1',
  (select id from public.pact_instances where pact_id = '20000000-0000-0000-0000-0000000001a1' and local_date = '2030-01-07'),
  0, 0, 10, '2030-01-07T16:06:00Z', false, '30000000-0000-0000-0000-0000000001a1', '2030-01-07T16:06:00Z')),
  'in_fence', 'retry with the same client_attempt_id returns the stored row');
-- 13
select is((select count(*)::int from public.checkins where client_attempt_id = '30000000-0000-0000-0000-0000000001a1'),
          1, 'retries are deduplicated');
-- 14
select is((select verdict::text from public.check_in_at('00000000-0000-0000-0000-0000000001b1',
  (select id from public.pact_instances where pact_id = '20000000-0000-0000-0000-0000000001a1' and local_date = '2030-01-07'),
  null, null, null, '2030-01-07T16:10:00Z', false, null, '2030-01-07T16:10:00Z')),
  'unjudgeable', 'no fix is unjudgeable');
-- 15
select throws_ok($$ select public.check_in_at('00000000-0000-0000-0000-0000000001e1',
  (select id from public.pact_instances where pact_id = '20000000-0000-0000-0000-0000000001a1' and local_date = '2030-01-07'),
  47.6553, -122.3035, 10, '2030-01-07T16:10:00Z', false, null, '2030-01-07T16:10:00Z') $$,
  '42501', null, 'non-participants cannot check in');

-- closing ----------------------------------------------------------------------------------
select public.tick_instances('2030-01-07T17:00:00Z');
-- 16
select is((select status::text from public.pact_instances
            where pact_id = '20000000-0000-0000-0000-0000000001a1' and local_date = '2030-01-07'),
          'closed', 'tick closes the instance at the deadline');
-- 17
select is((select string_agg(r.status::text, ',' order by r.user_id) from public.results r
             join public.pact_instances i on i.id = r.instance_id
            where i.pact_id = '20000000-0000-0000-0000-0000000001a1' and i.local_date = '2030-01-07'),
          'success,unverified,frozen,failed', 'results: success, unverified, frozen, failed');
-- 18
select lives_ok($$ select public.tick_instances('2030-01-07T17:00:00Z') $$, 're-running tick is harmless');
-- 19
select is((select count(*)::int from public.results), 4, 're-running tick adds no results');

-- late offline check-in -----------------------------------------------------------------------
select public.check_in_at('00000000-0000-0000-0000-0000000001d1',
  (select id from public.pact_instances where pact_id = '20000000-0000-0000-0000-0000000001a1' and local_date = '2030-01-07'),
  47.6553, -122.3035, 10, '2030-01-07T16:50:00Z', false, null, '2030-01-07T17:20:00Z');
-- 20
select is((select r.status::text from public.results r join public.pact_instances i on i.id = r.instance_id
            where i.pact_id = '20000000-0000-0000-0000-0000000001a1' and i.local_date = '2030-01-07'
              and r.user_id = '00000000-0000-0000-0000-0000000001d1'),
          'unverified', 'late offline check-in turns failed into unverified');

-- reviews -------------------------------------------------------------------------------------
select public.open_review_at('00000000-0000-0000-0000-0000000001a1',
  (select id from public.pact_instances where pact_id = '20000000-0000-0000-0000-0000000001a1' and local_date = '2030-01-07'),
  '00000000-0000-0000-0000-0000000001b1', 'challenge', 'was at home', null, '2030-01-07T18:00:00Z');
-- 21
select throws_ok($$ select public.cast_vote_at('00000000-0000-0000-0000-0000000001b1',
  (select id from public.reviews where subject_user_id = '00000000-0000-0000-0000-0000000001b1'), true, '2030-01-07T18:01:00Z') $$,
  '42501', null, 'the subject cannot vote');
-- 21b (RT-1: the opener of a challenge is not one of its voters)
select throws_ok($$ select public.cast_vote_at('00000000-0000-0000-0000-0000000001a1',
  (select id from public.reviews where subject_user_id = '00000000-0000-0000-0000-0000000001b1'), true, '2030-01-07T18:01:00Z') $$,
  '42501', null, 'the opener of a challenge cannot vote on it');
select public.cast_vote_at('00000000-0000-0000-0000-0000000001c1',
  (select id from public.reviews where subject_user_id = '00000000-0000-0000-0000-0000000001b1'), true, '2030-01-07T18:02:00Z');
select public.cast_vote_at('00000000-0000-0000-0000-0000000001d1',
  (select id from public.reviews where subject_user_id = '00000000-0000-0000-0000-0000000001b1'), true, '2030-01-07T18:03:00Z');
-- 22
select is((select status::text from public.reviews where subject_user_id = '00000000-0000-0000-0000-0000000001b1'),
          'accepted', 'the two eligible voters (not the opener) accept the challenge early');
-- 23
select is((select r.status::text from public.results r join public.pact_instances i on i.id = r.instance_id
            where i.pact_id = '20000000-0000-0000-0000-0000000001a1' and i.local_date = '2030-01-07'
              and r.user_id = '00000000-0000-0000-0000-0000000001b1'),
          'failed', 'accepted challenge turns unverified into failed');

-- privacy and privileges -------------------------------------------------------------------------
-- 24
select is(public.purge_old_locations('2030-03-01T00:00:00Z'), 2, 'purge nulls coordinates older than 30 days');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001e1', true);
-- 25
select throws_ok($$ select public.tick_instances('2030-01-08T00:00:00Z') $$, '42501', null, 'clients cannot run tick_instances');
-- 26
select is((select count(*)::int from public.results), 0, 'a non-member sees no results');
reset role;

select * from finish();
rollback;
