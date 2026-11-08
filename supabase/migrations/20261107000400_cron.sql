-- =====================================================================
-- pg_cron schedules for server jobs + pg_net call to the push-outbox
-- Edge Function. No-op where pg_cron is unavailable (PGlite tests).
-- Job functions are owned by other migrations; they are referenced only
-- inside command strings, so this file applies even before they exist.
--
-- Real Supabase notes (see docs/REVIEW.md "Cron / pg_net / Vault"):
--   * pg_cron installs into pg_catalog (its control file fixes the schema); pg_net goes into
--     `extensions` when that schema exists (Supabase) and creates its own `net` schema either way.
--   * Jobs run as the role that scheduled them (`postgres` under `supabase db push`), which owns
--     the SECURITY DEFINER job functions and can read vault.decrypted_secrets.
--   * cron.schedule(name, ...) upserts by job name (pg_cron >= 1.4), so re-applying is safe.
--   * generate_instances runs every 15 minutes (not daily): it is idempotent and cheap, and a
--     pact created in the morning must get its first instance before the next midnight UTC.
--   * push-outbox reads two Vault secrets (create them once per project, never in a migration):
--       select vault.create_secret('https://<ref>.supabase.co', 'project_url');
--       select vault.create_secret('<service role key>', 'service_role_key');
--     If either is missing the job raises, so the gap is visible in cron.job_run_details instead
--     of silently skipping. The key must equal the function's SUPABASE_SERVICE_ROLE_KEY (the
--     legacy JWT), because the function compares the bearer token with that env var.
--   * net.http_post is asynchronous: the command returns a request id at once; the 30 s timeout
--     only bounds how long the pg_net worker waits for the function's response (which is logged
--     in net._http_response). A slow run is not re-fired early: claim_outbox's 5-minute lease
--     keeps the next minute's run off the same rows.
-- =====================================================================
do $outer$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;

    perform cron.schedule('generate-instances', '*/15 * * * *',
      $cmd$select public.generate_instances()$cmd$);

    perform cron.schedule('tick-instances', '* * * * *',
      $cmd$select public.tick_instances()$cmd$);

    perform cron.schedule('settle-due-groups', '2 * * * *',
      $cmd$select public.settle_due_groups()$cmd$);

    perform cron.schedule('purge-old-locations', '23 3 * * *',
      $cmd$select public.purge_old_locations()$cmd$);

    perform cron.schedule('purge-old-outbox', '37 3 * * *',
      $cmd$select public.purge_old_outbox()$cmd$);

    if exists (select 1 from pg_available_extensions where name = 'pg_net') then
      if exists (select 1 from pg_namespace where nspname = 'extensions') then
        create extension if not exists pg_net with schema extensions;
      else
        create extension if not exists pg_net;
      end if;

      perform cron.schedule('push-outbox', '* * * * *', $cmd$
        do $job$
        declare
          v_url text := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url');
          v_key text := (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key');
        begin
          if v_url is null or v_key is null then
            raise exception 'push-outbox: Vault secrets project_url / service_role_key are missing';
          end if;
          perform net.http_post(
            url := rtrim(v_url, '/') || '/functions/v1/push-outbox',
            headers := jsonb_build_object(
              'Content-Type', 'application/json',
              'Authorization', 'Bearer ' || v_key
            ),
            body := jsonb_build_object('source', 'pg_cron', 'at', now()),
            timeout_milliseconds := 30000
          );
        end
        $job$;
      $cmd$);
    end if;
  end if;
end;
$outer$;
