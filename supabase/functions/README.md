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
   - every token returned `DeviceNotRegistered`, the user has no tokens, the kind/status can't be
     rendered, or a `window_open` / `deadline_soon` reminder's `deadline_at` has already passed
     (stale): dropped (`attempts = 5`, `last_error` says why). Not retried.
   - anything else (HTTP 5xx/429, network, `MessageRateExceeded`, ...): `last_error` set and the
     lease (`claimed_until`) moved to now + 1, 5, 15, 60 minutes by attempt number, so the row is
     retried with backoff until `attempts` reaches 5 (about 80 minutes in all).
   - `DeviceNotRegistered` tokens are deleted from `push_tokens`.
5. Each message's `data` carries `kind`, `outbox_id`, the ids from the payload, and `url`, the
   in-app path the client opens on tap: `/checkin/<instance_id>` for `window_open` /
   `deadline_soon`, `/groups/<group_id>/feed` for `result` / `review_opened`,
   `/groups/<group_id>/ledger` for `settlement`, `obligation_marked_paid` and `obligation_disputed`,
   `/settings` for `ops_alert`.

Expo push receipts (the second-stage delivery check) are not polled in the MVP; see
`docs/REVIEW.md` (F5) for what that means and the proposed `push_tickets` follow-up.
Sent rows and exhausted rows older than 30 days are deleted nightly by `purge_old_outbox()`
(20261107000600, scheduled in 20261107000400).

Layout:

```
push-outbox/
  index.ts           Deno entrypoint: auth check, supabase-js wiring, Deno.serve
  outbox.ts          all pure logic (rendering, batching, Expo transport, ticket handling); no Deno imports
  claim_outbox.sql   mirror of the claim RPC in 20261107000500_app_support.sql (a test asserts they match)
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
| `obligation_marked_paid` (to the payee) / `obligation_disputed` (to the payer) | `from_name`, `to_name`, `amount_cents`, `obligation_id`, `settlement_id`, `group_id`, `url` (`/groups/<group_id>/ledger`) |
| `ops_alert` (to `ops_settings.ops_user_id` only; `check_job_health`) | `job`, `reason` (the body; falls back to `message`), `url` (default `/settings`). Title "Final Call job <job>" |

Example copy: `deadline_soon` gives "Kane Hall by 9:00 — 15 min left" / "Check in now or forfeit your $5 pledge."

### Deploy

Full sequence for a new project (CLI install, link, `db push`, Vault secrets, cron checks, this
deploy, the smoke test) in [`docs/DEPLOY.md`](../../docs/DEPLOY.md) §6–§7. The deploy itself:

```powershell
supabase secrets set EXPO_ACCESS_TOKEN=<token>        # optional, see below
supabase functions deploy push-outbox --no-verify-jwt
Invoke-RestMethod -Method Post -Uri "https://<ref>.supabase.co/functions/v1/push-outbox" -Headers @{ Authorization = "Bearer <service_role key>" }
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

The schedule itself lives in `supabase/migrations/20261107000400_cron.sql` (job `push-outbox`,
every minute): a `DO` block that reads both secrets, raises if either is missing (so the gap shows
up in `cron.job_run_details` instead of silently skipping) and calls `net.http_post` with a 30 s
response timeout. `cron.schedule` with an existing job name replaces it, so re-applying is safe.
Check runs with `select * from cron.job_run_details order by start_time desc limit 10;` and
responses with `select * from net._http_response order by created desc limit 10;`.

The `service_role_key` secret must be the same value the function sees as
`SUPABASE_SERVICE_ROLE_KEY` (the legacy JWT-style service key). If the project is switched to the
new `sb_secret_...` API keys, update both sides together.
