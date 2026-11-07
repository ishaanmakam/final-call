-- =====================================================================
-- pg_cron schedules for server jobs + pg_net call to the push-outbox
-- Edge Function. No-op where pg_cron is unavailable (PGlite tests).
-- Job functions are owned by other migrations; they are referenced only
-- inside command strings, so this file applies even before they exist.
--
-- push-outbox call reads two Vault secrets (create them once per project):
--   select vault.create_secret('https://<ref>.supabase.co', 'project_url');
--   select vault.create_secret('<service role key>', 'service_role_key');
-- If either is missing the HTTP call is skipped (the command returns null).
-- cron.schedule(name, ...) upserts by name, so re-applying is safe.
-- =====================================================================
do $outer$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;

    perform cron.schedule('generate-instances', '7 0 * * *',
      $cmd$select public.generate_instances()$cmd$);

    perform cron.schedule('tick-instances', '* * * * *',
      $cmd$select public.tick_instances()$cmd$);

    perform cron.schedule('settle-due-groups', '2 * * * *',
      $cmd$select public.settle_due_groups()$cmd$);

    perform cron.schedule('purge-old-locations', '23 3 * * *',
      $cmd$select public.purge_old_locations()$cmd$);

    if exists (select 1 from pg_available_extensions where name = 'pg_net') then
      create extension if not exists pg_net;

      perform cron.schedule('push-outbox', '* * * * *', $cmd$
        select net.http_post(
          url := s.url || '/functions/v1/push-outbox',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || s.key
          ),
          body := jsonb_build_object('source', 'pg_cron', 'at', now()),
          timeout_milliseconds := 10000
        )
        from (
          select
            (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') as url,
            (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key') as key
        ) s
        where s.url is not null and s.key is not null
      $cmd$);
    end if;
  end if;
end;
$outer$;
