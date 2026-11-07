# Edge Functions

## push-outbox

Drains `notification_outbox` and delivers rows as Expo push notifications. pg_cron calls it every
minute through pg_net with the service role key.

Per invocation it:

1. Calls `claim_outbox(100)`, which takes up to 100 rows with `sent_at is null and attempts < 5`
   in id order, bumps `attempts`, and sets a 5 minute lease (`claimed_until`) so an overlapping
   invocation cannot pick up the same rows (see `push-outbox/claim_outbox.sql`).
2. Loads `push_tokens` for those users and renders a title/body per kind (UI wording only: pledge,
   forfeit, pool).
3. Sends one message per (row, token) to `https://exp.host/--/api/v2/push/send` in batches of 100.
4. Outcomes per row:
   - any token got an `ok` ticket: `sent_at = now()`, `last_error = null`.
   - every token returned `DeviceNotRegistered`, the user has no tokens, or the kind/status can't be
     rendered: dropped (`attempts = 5`, `last_error` says why). Not retried.
   - anything else (HTTP 5xx/429, network, `MessageRateExceeded`, ...): `last_error` set, lease
     cleared, retried on the next tick until `attempts` reaches 5.
   - `DeviceNotRegistered` tokens are deleted from `push_tokens`.

Expo push receipts (the second-stage delivery check) are not polled in the MVP.

Layout:

```
push-outbox/
  index.ts           Deno entrypoint: auth check, supabase-js wiring, Deno.serve
  outbox.ts          all pure logic (rendering, batching, Expo transport, ticket handling); no Deno imports
  claim_outbox.sql   claim RPC + lease column; must be folded into a migration
  deno.json          nodeModulesDir "none" so Deno ignores the vitest node_modules
  package.json       vitest + pglite for Node tests
  test/              vitest suites (pure logic, and claim_outbox.sql against PGlite)
```

### Tests

```
cd supabase/functions/push-outbox
npm install
npm test            # vitest
npm run typecheck   # tsc on outbox.ts + tests
deno check index.ts # optional, needs Deno
```

### Payload expected per kind

Producers of outbox rows should include these keys in `payload` (all optional; missing ones fall back
to generic copy). `group_id`, `pact_id`, `instance_id`, `review_id`, `settlement_id` are passed
through in the push `data` for deep links, along with `kind` and `outbox_id`.

| kind | keys used |
|---|---|
| `window_open` | `pact_title`, `place_label`, `deadline_local` (`"09:00:00"`) or `deadline_at` + `tz`, `stake_cents` |
| `deadline_soon` | same as `window_open`; minutes left come from `deadline_at`, else `minutes_left`, else 15 |
| `result` | `status` (`success`/`failed`/`unverified`/`frozen`/`void`/`excluded`), `pact_title`, `stake_cents`, `net_cents` (winnings for success), `rolled_over` (bool, all-fail) |
| `review_opened` | `review_kind` (`appeal`/`challenge`), `subject_user_id`, `subject_name`, `opener_name`, `pact_title` |
| `settlement` | `group_name`, `net_cents` (negative = recipient owes, positive = owed) |

Example copy: `deadline_soon` gives "Kane Hall by 9:00 — 15 min left" / "Check in now or forfeit your $5 pledge."

### Deploy

```
supabase functions deploy push-outbox --no-verify-jwt
```

`--no-verify-jwt` is fine because the function itself rejects any request whose
`Authorization: Bearer <token>` is not exactly `SUPABASE_SERVICE_ROLE_KEY` (401), and only accepts
POST (405 otherwise). Deploying with JWT verification on also works as long as the key cron sends is
the legacy service role JWT.

Secrets:

| name | notes |
|---|---|
| `SUPABASE_URL` | injected by Supabase automatically |
| `SUPABASE_SERVICE_ROLE_KEY` | injected by Supabase automatically; cron must send this exact value |
| `EXPO_ACCESS_TOKEN` | optional; required only if "Enhanced push security" is on for the Expo project. `supabase secrets set EXPO_ACCESS_TOKEN=...` |

Local run: `supabase functions serve push-outbox --no-verify-jwt`, then
`curl -X POST -H "Authorization: Bearer $SERVICE_ROLE_KEY" http://127.0.0.1:54321/functions/v1/push-outbox`.
The response is a JSON summary: `{claimed, sent, retried, dropped, tokensDeleted}`.

### Schedule (pg_cron + pg_net)

Store the project URL and service role key in Vault once per environment (not in a migration,
since the key is a secret):

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<service-role-key>', 'service_role_key');
```

Then schedule (belongs in the cron migration owned by the foundation agent):

```sql
create extension if not exists pg_net;

select cron.schedule(
  'push-outbox',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/push-outbox',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
```

`cron.schedule` with an existing job name replaces it, so re-running is safe. Check runs with
`select * from cron.job_run_details order by start_time desc limit 10;` and responses with
`select * from net._http_response order by created desc limit 10;`.
