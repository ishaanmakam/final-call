-- 20261108000300_appeal_default.sql
-- N3-1 (night-1): an appeal that nobody votes on leaves the ORIGINAL result standing.
--
-- Before: a defaulted appeal turned the subject's result into `excluded` (stake returned, neither
-- winner nor loser). That rewarded appealing every miss late on Sunday and hoping the group stayed
-- silent (DECISIONS.md open question 4). Now, exactly like a defaulted challenge, a defaulted appeal
-- changes nothing: `failed` stays `failed`, no correction entry posts, obligations are the same as if
-- the appeal had never been opened. The review row still becomes `defaulted` (one appeal per
-- instance, ever, so it cannot be retried).
--
-- `result_status` keeps the value `excluded` (append-only history and ledger memos may hold it, and
-- the app still renders it) but no rule sets it any more; treat it as reserved.
--
-- Replaces: public._refresh_result(uuid, uuid, timestamptz), last defined in
-- 20261107000200_instances_checkins_reviews.sql. Signature, volatility, search_path and privileges
-- (not executable by anon / authenticated) are unchanged; `create or replace` keeps the grants.
-- Vote rules, tie rules, `default_open_reviews`, `_resolve_review` and `_review_voters` are untouched.
-- Oracle: packages/rules `applyReview` (RULES_VERSION 2).

create or replace function public._refresh_result(p_instance uuid, p_user uuid, p_now timestamptz) returns boolean
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_inst public.pact_instances;
  v_cur public.results;
  v_status public.result_status;
  v_first timestamptz;
  v_rev record;
begin
  select * into v_inst from public.pact_instances where id = p_instance;
  if not found or v_inst.status not in ('closed', 'settled') then
    return false;
  end if;
  select * into v_cur from public.results where instance_id = p_instance and user_id = p_user for update;
  if not found then
    return false;
  end if;
  select b.status, b.first_success_at into v_status, v_first from public._base_result(p_instance, p_user) b;
  -- Resolved reviews in resolution order. Accepted appeal -> success at the deadline (D1); accepted
  -- challenge -> failed; rejected or defaulted reviews of either kind -> unchanged (N3-1).
  for v_rev in
    select r.kind, r.status from public.reviews r
     where r.instance_id = p_instance and r.subject_user_id = p_user and r.status <> 'open'
     order by r.resolved_at, r.opened_at, r.id
  loop
    if v_rev.kind = 'appeal' and v_rev.status = 'accepted' then
      v_status := 'success';
      v_first := v_inst.deadline_at;
    elsif v_rev.kind = 'challenge' and v_rev.status = 'accepted' then
      v_status := 'failed';
      v_first := null;
    end if;
  end loop;
  if v_status is distinct from v_cur.status or v_first is distinct from v_cur.first_success_at then
    update public.results set status = v_status, first_success_at = v_first, decided_at = p_now
     where instance_id = p_instance and user_id = p_user;
    return true;
  end if;
  return false;
end;
$$;

comment on function public._refresh_result(uuid, uuid, timestamptz) is
  'Recompute one participant''s result on a closed/settled instance: base result, then resolved reviews in order. '
  'Accepted appeal -> success at deadline; accepted challenge -> failed; rejected/defaulted -> unchanged (N3-1). '
  'Returns true if the row changed.';

comment on type public.result_status is
  'pending | success | failed | unverified | frozen | void | excluded. '
  '`excluded` is reserved: no rule has set it since 20261108000300 (a defaulted appeal leaves the result standing).';
