-- push-outbox claim RPC. The canonical copy lives in
-- supabase/migrations/20261107000500_app_support.sql (section 3); this file is kept only so
-- test/claim_outbox.test.ts can exercise the function against a bare table, and a test asserts
-- the two function bodies are identical. Edit the migration first, then mirror it here.
--
-- Why a lease column: FOR UPDATE SKIP LOCKED only protects rows for the duration of the claim
-- transaction, and that transaction commits as soon as the RPC returns, long before the Edge
-- Function finishes sending. Without a lease, an overlapping invocation would re-claim the same
-- unsent rows and double-send. claimed_until hides a claimed row for 5 minutes (well past the
-- function's runtime); the function clears it on retryable failure so the next tick retries, and
-- a crashed invocation's rows come back on their own when the lease expires.
-- This adds one column to the CONTRACT's notification_outbox (deviation flagged to the lead).

alter table public.notification_outbox
  add column if not exists claimed_until timestamptz null;

create index if not exists notification_outbox_claim_idx
  on public.notification_outbox (id)
  where sent_at is null and attempts < 5;

create or replace function public.claim_outbox(p_limit int default 100, p_now timestamptz default now())
returns setof public.notification_outbox
language sql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  update public.notification_outbox o
     set attempts = o.attempts + 1,
         claimed_until = p_now + interval '5 minutes'
   where o.id in (
           select c.id
             from public.notification_outbox c
            where c.sent_at is null
              and c.attempts < 5
              and (c.claimed_until is null or c.claimed_until <= p_now)
            order by c.id
            limit greatest(coalesce(p_limit, 100), 0)
            for update skip locked
         )
  returning o.*;
$$;

revoke all on function public.claim_outbox(int, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_outbox(int, timestamptz) to service_role;
