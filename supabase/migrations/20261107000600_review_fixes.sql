-- =====================================================================
-- Review fixes (docs/REVIEW.md, 2026-11-07). No business rule changes.
--   R1  notification_outbox: the (id) partial index 0500 meant to add never existed, because
--       0100 had already created an index with the same name on (created_at) and 0500 used
--       IF NOT EXISTS. claim_outbox filters sent_at is null AND attempts < 5, so dropped rows
--       (attempts = 5, never sent) stayed in the old partial index forever and were scanned on
--       every claim. New precise index; old one dropped.
--   R2  pact_instances (pact_id, deadline_at): feed (28 days by group), pact detail (next 10 by
--       deadline), _settle_group_week, _post_initial / _correct_instance (later captures by
--       deadline) all filter by pact and deadline.
--   R3  ledger_accounts (group_id, kind): account_balances / ensure_account by group when the
--       partial unique indexes (which need a constant kind) do not apply.
--   R4  RLS: auth.uid() wrapped in (select auth.uid()) so it is an InitPlan evaluated once per
--       statement instead of once per row (Supabase lint auth_rls_initplan). Same predicates.
--   R5  purge_old_outbox(p_now): sent rows and exhausted (attempts >= 5) rows older than 30 days
--       are deleted; retryable and fresh rows are kept. Scheduled in 20261107000400_cron.sql.
--   R6  review-photos bucket: 5 MB cap and image-only MIME types (Supabase Storage only).
-- =====================================================================

-- R1 ------------------------------------------------------------------------------------------
create index if not exists notification_outbox_claim_idx
  on public.notification_outbox (id)
  where sent_at is null and attempts < 5;
drop index if exists public.notification_outbox_unsent_idx;

-- R2 ------------------------------------------------------------------------------------------
create index if not exists pact_instances_pact_deadline_idx on public.pact_instances (pact_id, deadline_at);

-- R3 ------------------------------------------------------------------------------------------
create index if not exists ledger_accounts_group_kind_idx on public.ledger_accounts (group_id, kind);

-- R4 ------------------------------------------------------------------------------------------
alter policy profiles_select on public.profiles
  using (id = (select auth.uid()) or public.shares_group_with(id));
alter policy profiles_update_own on public.profiles
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
alter policy obligations_select on public.obligations
  using (public.is_group_member(group_id) or from_user = (select auth.uid()) or to_user = (select auth.uid()));
alter policy notification_outbox_select_own on public.notification_outbox
  using (user_id = (select auth.uid()));
alter policy push_tokens_select_own on public.push_tokens
  using (user_id = (select auth.uid()));
alter policy push_tokens_delete_own on public.push_tokens
  using (user_id = (select auth.uid()));

-- R5 ------------------------------------------------------------------------------------------
create function public.purge_old_outbox(p_now timestamptz default now())
returns int
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_cutoff timestamptz := coalesce(p_now, now()) - interval '30 days';
  v_n int;
begin
  delete from public.notification_outbox
   where (sent_at is not null and sent_at < v_cutoff)
      or (sent_at is null and attempts >= 5 and created_at < v_cutoff);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.purge_old_outbox(timestamptz) from public, anon, authenticated;
grant execute on function public.purge_old_outbox(timestamptz) to service_role;

-- R6 ------------------------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is not null then
    update storage.buckets
       set file_size_limit = 5 * 1024 * 1024,
           allowed_mime_types = array['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp']
     where id = 'review-photos';
  end if;
end;
$$;
