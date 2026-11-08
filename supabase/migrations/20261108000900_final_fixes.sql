-- =====================================================================
-- Final red-team fixes (night-1, phase 5). Spec: docs/REDTEAM.md "Final pass (night-1)",
-- docs/DECISIONS.md V-1 / V-2, docs/CONTRACT.md. Nothing here changes a verdict, a result, a
-- payout or a settlement (RULES_VERSION stays 3); both are read-model / housekeeping fixes.
--
-- V-1  instance_member_nets.pot_cents was the sum of the lines paid INTO the pot account, i.e. the
--      first posting's figure forever: corrections never touch the pot (they move member and carry
--      lines only), so after an accepted appeal, a late tap or a challenge the gate-close card would
--      have said "pool $25.00 split 2 ways" while each winner had $10.00. Now pot_cents is derived from
--      the same lines the nets are: every forfeit (negative member net) plus the carry the day drew
--      (the carry account's negative net on the instance). Identical to the old value on a day with
--      no correction; right after one.
-- V-2  delete_my_account() clears ops_settings.ops_user_id when the deleted account is the ops user,
--      so check_job_health never queues ops_alert rows for a dead account (its push tokens are gone
--      and the rows would sit unsent). The founder re-points the setting with the documented UPDATE.
-- =====================================================================

-- ---------------------------------------------------------------------
-- V-1: pool = forfeits paid in + carry drawn, from the posted lines, corrections included
-- ---------------------------------------------------------------------
create or replace view public.instance_member_nets with (security_invoker = true) as
with lines as (
  select e.instance_id, e.group_id, a.kind, a.user_id, l.amount_cents
    from public.ledger_entries e
    join public.ledger_lines l on l.entry_id = e.id
    join public.ledger_accounts a on a.id = l.account_id
   where e.instance_id is not null
), nets as (
  select instance_id, group_id, user_id, sum(amount_cents)::bigint as net_cents
    from lines
   where kind = 'member'
   group by instance_id, group_id, user_id
), pots as (
  -- everything paid into the day's pool: each member's forfeit plus whatever the carry put in
  select instance_id,
         coalesce(sum(-net_cents) filter (where net_cents < 0), 0)::bigint
         + coalesce((select greatest(0, -sum(c.amount_cents))::bigint from lines c where c.instance_id = n.instance_id and c.kind = 'carry'), 0)
           as pot_cents
    from nets n
   group by instance_id
)
select n.instance_id,
       n.group_id,
       n.user_id,
       n.net_cents,
       coalesce(p.pot_cents, 0)::bigint as pot_cents
  from nets n
  left join pots p on p.instance_id = n.instance_id
 where n.net_cents <> 0;

revoke all on public.instance_member_nets from public, anon, authenticated;
grant select on public.instance_member_nets to authenticated, service_role;

-- ---------------------------------------------------------------------
-- V-2: the ops user deleting their account stops the alerts
-- ---------------------------------------------------------------------
create or replace function public.delete_my_account() returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_group uuid;
  v_left int := 0;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- Idempotent: a second call (retry, double tap, stale session) does nothing.
  if exists (select 1 from public.profiles where id = v_uid and deleted_at is not null) then
    return;
  end if;
  if not exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'profile not found' using errcode = 'P0002';
  end if;

  -- 1. Leave every group under the normal rules. One refusal rolls the whole call back.
  for v_group in
    select group_id from public.group_members where user_id = v_uid and left_at is null order by joined_at
  loop
    begin
      perform public.leave_group(v_group);
    exception
      when check_violation then
        raise exception 'You''re in an open check-in window; try again after the deadline.'
          using errcode = '23514', hint = 'leave_group refused: ' || sqlerrm;
    end;
    v_left := v_left + 1;
  end loop;

  -- 2. Anonymize and freeze the profile.
  update public.profiles
     set display_name = 'Deleted member',
         venmo_username = null,
         deleted_at = now()
   where id = v_uid;

  -- 3. Device- and person-level data.
  delete from public.push_tokens where user_id = v_uid;
  delete from public.notification_outbox where user_id = v_uid and sent_at is null;
  delete from public.pact_participant_places
   where user_id = v_uid and effective_from > now();
  delete from public.review_votes rv
   using public.reviews r
   where r.id = rv.review_id and rv.voter_id = v_uid and r.status = 'open';
  update public.checkins set lat = null, lng = null
   where user_id = v_uid and (lat is not null or lng is not null);
  -- V-2: no ops alerts for a dead account
  update public.ops_settings set ops_user_id = null where ops_user_id = v_uid;

  -- 4. Results, ledger, obligations, reviews, settled votes, historical places: untouched.

  -- 5. Audit.
  insert into public.account_audit (user_id, kind, groups_left) values (v_uid, 'account_deleted', v_left);

  -- 6. The identity. Storage objects may still name the owner on older Supabase schemas; clear it
  --    best-effort (no storage schema in PGlite; some projects deny writes there).
  if to_regclass('storage.objects') is not null then
    begin
      execute 'update storage.objects set owner = null where owner = $1' using v_uid;
    exception when others then
      null;
    end;
  end if;
  if exists (select 1 from information_schema.tables where table_schema = 'auth' and table_name = 'users') then
    delete from auth.users where id = v_uid;
  end if;
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
