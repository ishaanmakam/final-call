-- =====================================================================
-- Unverified budget (night-1, agent N2). Spec: docs/CONTRACT.md "Review", docs/DECISIONS.md N2-*.
--
-- Unverified never costs money (a tracking failure must not). That makes it farmable: a person
-- whose every tap is unjudgeable (Approximate Location, a phone that never gets a fix) is never
-- charged. Rule: when a participant's result on an instance is set to 'unverified' and that makes
-- MORE THAN 2 unverified results for them in the same pact in the same calendar month (the
-- instance's local_date, i.e. the pact's zone), the system opens a challenge on that result. The
-- group votes as on any challenge; nobody voting leaves the result standing.
--
-- Contract additions:
--   reviews.system_opened boolean not null default false   -- true for automatic challenges;
--       opened_by stays the subject so _review_voters (roster minus subject) is unchanged
--   view unverified_month_counts(pact_id, user_id, month date, count int)   -- security_invoker,
--       closed/settled instances only; the client shows "2 unverified this month"
--   _auto_challenge_if_over_budget(p_instance, p_user, p_now) returns uuid   -- internal, idempotent
--   Fired by two triggers rather than by overriding _close_instance / _refresh_result (other
--   night-1 migrations replace those functions, and whichever file sorts last would silently
--   drop a hook placed in a body):
--     results_unverified_budget   AFTER UPDATE on results, when the row lands on 'unverified'
--                                 (late offline tap after close, review resolution)
--     instances_unverified_budget AFTER UPDATE on pact_instances, when status becomes 'closed'
--                                 (every unverified result of the instance; voided instances never)
--   Idempotent: never a second challenge per (instance, subject) (reviews_one_per_kind), never
--       while any review of that result is open, never on an instance that is not closed/settled.
--       A human challenge (open or resolved) suppresses it. Posts 'review_opened' to the whole
--       roster (voters and the subject) with system_opened = true and no opener_name.
--   p_now: the result's decided_at (the time the recompute or close used), so tests stay deterministic.
-- =====================================================================

alter table public.reviews add column system_opened boolean not null default false;

-- ---------------------------------------------------------------------
-- Month counts, readable by group members (RLS on results / pact_instances applies).
-- ---------------------------------------------------------------------
create view public.unverified_month_counts with (security_invoker = true) as
select i.pact_id,
       r.user_id,
       date_trunc('month', i.local_date::timestamp)::date as month,
       count(*)::int as count
  from public.results r
  join public.pact_instances i on i.id = r.instance_id
 where r.status = 'unverified'
   and i.status in ('closed', 'settled')
 group by i.pact_id, r.user_id, date_trunc('month', i.local_date::timestamp);

revoke all on public.unverified_month_counts from public, anon, authenticated;
grant select on public.unverified_month_counts to authenticated, service_role;

-- ---------------------------------------------------------------------
-- The automatic challenge
-- ---------------------------------------------------------------------
create function public._auto_challenge_if_over_budget(p_instance uuid, p_user uuid, p_now timestamptz) returns uuid
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_inst public.pact_instances;
  v_n int;
  v_id uuid;
begin
  select * into v_inst from public.pact_instances where id = p_instance;
  if not found or v_inst.status not in ('closed', 'settled') then
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
     and i.status in ('closed', 'settled')
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

-- A recompute that lands on unverified (late offline tap after close, a resolved review).
-- Inside _close_instance the first write is an insert ... on conflict do update while the instance
-- is still 'open', so the helper returns null there; the instance trigger below covers the close.
create function public._results_unverified_budget_trg() returns trigger
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._auto_challenge_if_over_budget(new.instance_id, new.user_id, new.decided_at);
  return null;
end;
$$;

create trigger results_unverified_budget
  after update on public.results
  for each row
  when (new.status = 'unverified' and old.status is distinct from 'unverified')
  execute function public._results_unverified_budget_trg();

-- The close: every unverified result of an instance that just became 'closed' (never a voided one).
create function public._instances_unverified_budget_trg() returns trigger
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user uuid;
begin
  for v_user in
    select r.user_id from public.results r
     where r.instance_id = new.id and r.status = 'unverified'
     order by r.user_id
  loop
    perform public._auto_challenge_if_over_budget(new.id, v_user, new.closed_at);
  end loop;
  return null;
end;
$$;

create trigger instances_unverified_budget
  after update of status on public.pact_instances
  for each row
  when (new.status = 'closed' and old.status is distinct from 'closed')
  execute function public._instances_unverified_budget_trg();

-- ---------------------------------------------------------------------
-- Privileges: internal helpers, never client-callable.
-- ---------------------------------------------------------------------
revoke all on function public._auto_challenge_if_over_budget(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public._results_unverified_budget_trg() from public, anon, authenticated;
revoke all on function public._instances_unverified_budget_trg() from public, anon, authenticated;
