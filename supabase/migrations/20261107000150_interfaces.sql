-- Cross-migration interfaces.
-- 20261107000200 (instances/check-ins/reviews) and 20261107000300 (payouts/settlement) call each other.
-- These no-op stubs let either migration be applied and tested alone. The owning migration
-- replaces each one with CREATE OR REPLACE:
--   post_instance_payout, apply_instance_correction  -> owned by 20261107000300
--   default_open_reviews                             -> owned by 20261107000200
-- Shared by both (real implementations, not stubs): _lock_pact_carry (the per-pact money lock; lock
-- order is documented at the top of 20261107000300) and the job_failures log (settle_due_groups,
-- tick_instances).

create or replace function public.post_instance_payout(p_instance uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  return;
end;
$$;

create or replace function public.apply_instance_correction(p_instance uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  return;
end;
$$;

create or replace function public.default_open_reviews(p_group uuid, p_until timestamptz)
returns int
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  return 0;
end;
$$;

revoke all on function public.post_instance_payout(uuid) from public, anon, authenticated;
revoke all on function public.apply_instance_correction(uuid) from public, anon, authenticated;
revoke all on function public.default_open_reviews(uuid, timestamptz) from public, anon, authenticated;

-- Get the pact's carry account and take the per-pact money lock (see the lock order in
-- 20261107000300). Get-or-create, so it also serializes the carry account's creation.
create or replace function public._lock_pact_carry(p_group uuid, p_pact uuid)
returns uuid
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_carry uuid;
begin
  v_carry := public.ensure_account(p_group, 'carry', null, null, p_pact);
  perform 1 from public.ledger_accounts where id = v_carry for update;
  return v_carry;
end;
$$;
revoke all on function public._lock_pact_carry(uuid, uuid) from public, anon, authenticated, service_role;

-- Failures of scheduled jobs (one row per failed group / instance). Server-only (RLS on, no client grants).
create table if not exists public.job_failures (
  id bigserial primary key,
  job text not null,
  group_id uuid null references public.groups (id),
  error text not null,
  failed_at timestamptz not null default now()
);
alter table public.job_failures enable row level security;
revoke all on public.job_failures from public, anon, authenticated;
