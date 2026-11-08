-- =====================================================================
-- Strava integration storage. Spec: docs/superpowers/specs/2026-11-08-challenge-kinds-design.md
-- ("Strava"); decisions CC-* in docs/DECISIONS.md. Owner: challenges lane C.
--
-- The Edge Function supabase/functions/strava-sync is the only writer here, with the service role:
--   * integration_tokens: one row per (user, provider) with the OAuth tokens. RLS is on and no
--     client policy exists; the only client-visible surface is the view my_integrations below,
--     which exposes provider, athlete_id and connected_at for the caller's own rows. Column-level
--     grants on the table make `select *`, and any read of access_token / refresh_token /
--     expires_at / scope, a permission error for authenticated (PostgREST therefore never serves
--     them either).
--   * strava_webhook_events: a log of every webhook delivery; processed_at / error / attempts
--     record what the function did with it. Service only.
--   * upsert_integration_token(...) (service): insert or replace the tokens; connected_at is kept
--     from the first connect. An athlete that re-authorizes from another account moves: the old
--     row for that (provider, athlete_id) is deleted first (one athlete, one account).
--   * disconnect_integration(p_provider) (client): deletes the caller's row. Idempotent. The
--     activities Strava already submitted stay (append-only evidence), which the test asserts
--     against submit_activities_for from 20261109000100.
-- Tokens reference auth.users (not profiles): delete_my_account deletes the auth.users row and
-- keeps an anonymized profile, and the tokens must go with the identity.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table public.integration_tokens (
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('strava')),
  athlete_id text not null check (char_length(athlete_id) between 1 and 64),
  access_token text not null check (char_length(access_token) between 1 and 4096),
  refresh_token text not null check (char_length(refresh_token) between 1 and 4096),
  expires_at timestamptz not null,
  scope text null,
  connected_at timestamptz not null default now(),
  primary key (user_id, provider)
);
create unique index integration_tokens_provider_athlete_idx on public.integration_tokens (provider, athlete_id);
alter table public.integration_tokens enable row level security;
revoke all on public.integration_tokens from public, anon, authenticated;
grant all on public.integration_tokens to service_role;
-- Non-secret columns only, and only the caller's rows (policy below). This is what my_integrations
-- reads as the invoker.
grant select (user_id, provider, athlete_id, connected_at) on public.integration_tokens to authenticated;
create policy integration_tokens_select_own on public.integration_tokens
  for select to authenticated using (user_id = (select auth.uid()));

create table public.strava_webhook_events (
  id bigserial primary key,
  event jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz null,
  error text null,
  attempts int not null default 0
);
create index strava_webhook_events_pending_idx on public.strava_webhook_events (received_at) where processed_at is null;
alter table public.strava_webhook_events enable row level security;
revoke all on public.strava_webhook_events from public, anon, authenticated;
revoke all on sequence public.strava_webhook_events_id_seq from public, anon, authenticated;
grant all on public.strava_webhook_events to service_role;
grant all on sequence public.strava_webhook_events_id_seq to service_role;

-- ---------------------------------------------------------------------
-- View: what the owner may see
-- ---------------------------------------------------------------------

create view public.my_integrations with (security_invoker = true) as
  select provider, athlete_id, connected_at
    from public.integration_tokens
   where user_id = (select auth.uid());
revoke all on public.my_integrations from public, anon;
grant select on public.my_integrations to authenticated, service_role;

-- ---------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------

-- Service role (the Edge Function after the OAuth exchange or a token refresh).
create function public.upsert_integration_token(
  p_user uuid,
  p_provider text,
  p_athlete_id text,
  p_access_token text,
  p_refresh_token text,
  p_expires_at timestamptz,
  p_scope text default null
) returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if p_provider is null or p_provider not in ('strava') then
    raise exception 'unknown provider' using errcode = '22023';
  end if;
  if p_athlete_id is null or char_length(btrim(p_athlete_id)) = 0 then
    raise exception 'athlete id is required' using errcode = '22023';
  end if;
  if p_access_token is null or char_length(p_access_token) = 0
     or p_refresh_token is null or char_length(p_refresh_token) = 0 then
    raise exception 'access and refresh tokens are required' using errcode = '22023';
  end if;
  if p_expires_at is null then
    raise exception 'expires_at is required' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users where id = p_user) then
    raise exception 'user not found' using errcode = 'P0002';
  end if;

  -- One athlete, one account: a Strava athlete who connects from a second account moves there.
  delete from public.integration_tokens
   where provider = p_provider and athlete_id = btrim(p_athlete_id) and user_id <> p_user;

  insert into public.integration_tokens as t
    (user_id, provider, athlete_id, access_token, refresh_token, expires_at, scope, connected_at)
  values (p_user, p_provider, btrim(p_athlete_id), p_access_token, p_refresh_token, p_expires_at, p_scope, now())
  on conflict (user_id, provider) do update
     set athlete_id = excluded.athlete_id,
         access_token = excluded.access_token,
         refresh_token = excluded.refresh_token,
         expires_at = excluded.expires_at,
         scope = coalesce(excluded.scope, t.scope);
end;
$$;

-- Client: forget my connection. Activities already submitted stay.
create function public.disconnect_integration(p_provider text) returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_provider is null or p_provider not in ('strava') then
    raise exception 'unknown provider' using errcode = '22023';
  end if;
  delete from public.integration_tokens where user_id = v_uid and provider = p_provider;
end;
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke all on function public.upsert_integration_token(uuid, text, text, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.upsert_integration_token(uuid, text, text, text, text, timestamptz, text) to service_role;

revoke all on function public.disconnect_integration(text) from public, anon;
grant execute on function public.disconnect_integration(text) to authenticated, service_role;
