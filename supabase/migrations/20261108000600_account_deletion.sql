-- =====================================================================
-- In-app account deletion. Spec: docs/CONTRACT.md "Account deletion"; docs/DECISIONS.md P3-*.
-- Owner: night-1 agent P3 (App Store readiness).
--
-- App Store Review Guideline 5.1.1(v): an app with account creation must let the person delete the
-- account from inside the app. The ledger is append-only and every money record (results, ledger
-- lines, obligations, reviews) points at the profile, so "delete" means:
--
--   1. leave every group through the existing leave rules (leave_group: refused while the caller is
--      on the roster of an open check-in window, so nobody dodges a pledge by deleting mid-window);
--   2. anonymize the profile (display_name 'Deleted member', venmo_username null, deleted_at set)
--      and freeze it against further client edits;
--   3. drop what identifies the device or the person: push tokens, unsent notifications, pending
--      (not yet counting) place changes, votes on reviews still open, raw check-in coordinates;
--   4. keep results, ledger entries/lines, obligations, reviews, past places and settled votes:
--      history other people's balances were computed from, shown under "Deleted member";
--   5. write one account_audit row;
--   6. delete the auth.users row (identity, sessions, refresh tokens go with it).
--
-- profiles.id no longer references auth.users: that cascade would have deleted the profile and
-- failed on every FK pointing at it. The profile trigger (handle_new_user) still creates profiles.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------

alter table public.profiles add column if not exists deleted_at timestamptz null;

-- Drop the FK to auth.users (whatever it was named) so the identity can go while history stays.
do $$
declare
  v_name text;
begin
  select c.conname into v_name
    from pg_constraint c
   where c.conrelid = 'public.profiles'::regclass
     and c.contype = 'f'
     and c.confrelid = to_regclass('auth.users');
  if v_name is not null then
    execute format('alter table public.profiles drop constraint %I', v_name);
  end if;
end;
$$;

-- A deleted profile is frozen: the client grant (display_name, venmo_username) no longer reaches it,
-- so a stale JWT cannot put a name back.
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.uid()) and deleted_at is null)
  with check (id = (select auth.uid()) and deleted_at is null);

create table public.account_audit (
  id bigserial primary key,
  user_id uuid not null,
  kind text not null check (kind in ('account_deleted')),
  groups_left int not null default 0,
  created_at timestamptz not null default now()
);
create index account_audit_user_idx on public.account_audit (user_id);
alter table public.account_audit enable row level security;
revoke all on public.account_audit from public, anon, authenticated;
grant all on public.account_audit to service_role;
grant usage, select on sequence public.account_audit_id_seq to service_role;

-- ---------------------------------------------------------------------
-- RPC
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
