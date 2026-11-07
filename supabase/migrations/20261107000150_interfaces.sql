-- Cross-migration interfaces.
-- 20261107000200 (instances/check-ins/reviews) and 20261107000300 (payouts/settlement) call each other.
-- These no-op stubs let either migration be applied and tested alone. The owning migration
-- replaces each one with CREATE OR REPLACE:
--   post_instance_payout, apply_instance_correction  -> owned by 20261107000300
--   default_open_reviews                             -> owned by 20261107000200

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
