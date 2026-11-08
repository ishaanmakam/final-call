# Deploying Final Call's backend (Windows / PowerShell)

Step-by-step from an empty Supabase account to a project the app and the smoke test run against.
Every command is PowerShell 5.1-safe (no `&&`; chain with `;`). SQL goes into **Dashboard → SQL
Editor** so you need no local `psql`. Where a step is optional it says so.

What you end up with:

- the schema from `supabase/migrations/` on a hosted project, cron jobs scheduled (`pg_cron`),
  push delivery wired through `pg_net` → Edge Function `push-outbox`;
- Auth configured for magic links (`finalcall://auth-callback`) and native Sign in with Apple;
- the private `review-photos` bucket;
- `scripts/smoke.ts` green against the project;
- the app pointed at it through EAS environment variables.

Keys used below: the project **ref** (`abcdefghijklmnop` in `https://abcdefghijklmnop.supabase.co`),
the **anon** key (ships in the app), the **service role** key (server only: Vault, Edge Function,
smoke test) and the **database password** you choose when creating the project. Keep the last two
out of the repo; `.env` is gitignored.

Contents: [0 Prerequisites](#0-prerequisites) · [1 CLI](#1-install-and-sign-in-to-the-supabase-cli) ·
[2 Project](#2-create-the-hosted-project) · [3 Link](#3-link-the-repo-to-the-project) ·
[4 Migrations](#4-push-the-migrations) · [5 Extensions and cron](#5-pg_cron-and-pg_net) ·
[6 Vault](#6-vault-secrets-for-push-outbox) · [7 Function](#7-deploy-the-push-outbox-edge-function) ·
[8 Auth](#8-auth-settings) · [9 Storage](#9-storage-bucket) · [10 Smoke](#10-smoke-test) ·
[11 App](#11-point-the-app-at-the-project-eas) · [12 Local stack](#12-optional-local-stack-supabase-start) ·
[Troubleshooting](#troubleshooting) · [Checklist](#checklist)

---

## 0. Prerequisites

- Node 22+ (`node --version`). The repo's test suites already run on this machine, so npm works.
- A Supabase account (free tier is enough for the MVP).
- For Sign in with Apple: an Apple Developer account with the app id `com.ishaanmakam.finalcall`
  (`app/app.config.ts`; `IOS_BUNDLE_ID` overrides it, in which case add that id wherever the bundle
  id appears below).
- No Docker needed for anything in sections 1–11. Docker Desktop is only for the optional local
  stack in section 12 (it is a known risk on Windows ARM, see DECISIONS.md D10).

## 1. Install and sign in to the Supabase CLI

Pick one. Both give the `supabase` command used in the rest of this guide.

**Option A – Scoop (recommended; `supabase` on PATH, `scoop update supabase` to upgrade):**

```powershell
# Scoop itself, if you do not have it (https://scoop.sh):
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
Invoke-RestMethod -Uri https://get.scoop.sh | Invoke-Expression

scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase
supabase --version
```

**Option B – npx, no install (what this repo's agents used; CLI 3.0.0 at the time of writing):**

```powershell
npx -y supabase@latest --version
```

Then prefix every `supabase ...` command below with `npx -y supabase@latest ...`. Note that
`npm install -g supabase` is **refused** by the package ("Installing Supabase CLI as a global
module is not supported"); use Scoop or npx. (A per-project `npm i -D supabase` in `scripts/`
also works if you prefer `npx supabase` without `@latest`.)

Sign in (opens a browser; paste the token it shows if the browser flow does not return):

```powershell
supabase login
```

Non-interactive alternative (CI, or if the browser hand-off fails): create a personal access token
at https://supabase.com/dashboard/account/tokens and either pass `supabase login --token <token>`
or set `$env:SUPABASE_ACCESS_TOKEN = "<token>"` for the session.

## 2. Create the hosted project

In https://supabase.com/dashboard → **New project**:

| Field | Value |
|---|---|
| Name | `final-call` (or `final-call-smoke` for a throwaway smoke/staging project; see §10) |
| Database password | generate one, store it in your password manager; the CLI asks for it in §3 |
| Region | closest to your users (US West for Seattle) |
| Postgres version | 17 (must match `major_version = 17` in `supabase/config.toml`; check later with `show server_version;`) |

Wait until the project status is *Active*. Then copy from **Project Settings → API**:
Project URL, `anon` key, `service_role` key. (If the project only shows `sb_publishable_…` /
`sb_secret_…` keys, read "New API keys" in §6 before going on.)

## 3. Link the repo to the project

From the repo root (the folder with `supabase/config.toml`):

```powershell
cd C:\Users\ishaa\Projects\bet-app
supabase link --project-ref <ref>
```

It asks for the database password (or set `$env:SUPABASE_DB_PASSWORD = "<password>"` first; pass
`-p <password>` to skip the prompt). The link is stored in `supabase/.temp/` (gitignored; add it
if your `.gitignore` lacks it). Verify:

```powershell
supabase projects list        # the linked project has a ● marker
supabase migration list       # Local column lists the 10+ migrations, Remote is empty
```

If `link` warns that `config.toml` differs from the remote (auth/storage sections), that is
expected: the dashboard steps in §8–§9 bring the hosted project in line (or `supabase config push`
does, see §8).

## 4. Push the migrations

```powershell
supabase db push
```

It lists the migrations it is about to apply (all of `supabase/migrations/*.sql`, in filename
order) and asks for confirmation. `--dry-run` shows the plan without applying. Never add
`--include-seed`: `supabase/seed.sql` creates local-only users with a known password.

Verify:

```powershell
supabase migration list
```

Every file must show the same version in **Local** and **Remote**. Then in the SQL Editor:

```sql
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('create_group','join_pact','check_in','tick_instances','settle_due_groups');
-- 5
select version from supabase_migrations.schema_migrations order by version;
```

Re-running `supabase db push` later applies only new files; it never re-runs an applied one. That
matters for the cron file (§5).

## 5. pg_cron and pg_net

`20261107000400_cron.sql` enables both extensions itself when they are *available*
(`pg_available_extensions`), which they are on every hosted project, so after §4 the jobs are
normally already scheduled. Check:

```sql
select extname, extversion from pg_extension where extname in ('pg_cron', 'pg_net');
-- expect both rows
select jobid, jobname, schedule, active from cron.job order by jobname;
-- expect 7 jobs: generate-instances (*/15), tick-instances (*), settle-due-groups (2 * * * *),
--                purge-old-locations (23 3), purge-old-outbox (37 3), push-outbox (*),
--                check-job-health (*/10, from 20261108000500_heartbeat.sql)
```

If `pg_extension` lacks one of them (older projects need them switched on by hand) the migration
ran as a no-op for the missing part and `cron.job` is empty or lacks `push-outbox`:

1. **Dashboard → Database → Extensions**, search `pg_cron`, enable (schema `pg_catalog`); search
   `pg_net`, enable (schema `extensions`).
2. Re-run the schedule block. `db push` will not do it (the file is recorded as applied), so either
   paste the whole of `supabase/migrations/20261107000400_cron.sql` into the SQL Editor and run it
   (it is idempotent: `cron.schedule` upserts by job name), or mark it unapplied and push again:

   ```powershell
   supabase migration repair --status reverted 20261107000400
   supabase db push
   ```

3. Re-run the `cron.job` query above.

How the jobs run: pg_cron executes each command as the role that scheduled it (`postgres`), which
owns the SECURITY DEFINER job functions and can read Vault. Job history:

```sql
select jobname, status, return_message, start_time
  from cron.job_run_details d join cron.job j on j.jobid = d.jobid
 order by start_time desc limit 20;
```

Until §6 is done the `push-outbox` job fails every minute with
`push-outbox: Vault secrets project_url / service_role_key are missing`. That is by design (a
silent skip was review finding C2); it stops as soon as the secrets exist. Application-level
failures (one group's settlement failing, a place-timeout error) go to `public.job_failures`:

```sql
select job, ref_id, error, created_at from public.job_failures order by created_at desc limit 20;
```

Heartbeats (`20261108000500_heartbeat.sql`): every job writes `public.job_heartbeats` at the end of
a run and the view `public.job_health` says which job is overdue (`never_ran` right after a deploy
is normal for the nightly purges). Name who gets the `ops_alert` pushes once you have signed in
to the app on a device:

```sql
select * from public.job_health;
update public.ops_settings set ops_user_id = '<your auth user id>';   -- from auth.users / Dashboard → Authentication → Users
```

## 6. Vault secrets for push-outbox

The `push-outbox` cron job reads two Vault secrets and POSTs to the Edge Function with the service
role key as bearer. Create them once per project, in the SQL Editor (never in a migration):

```sql
select vault.create_secret('https://<ref>.supabase.co', 'project_url');
select vault.create_secret('<service_role key>', 'service_role_key');
-- verify names only (do not select decrypted_secret on a shared screen):
select name, created_at from vault.decrypted_secrets where name in ('project_url', 'service_role_key');
```

To rotate later: `select vault.update_secret(id, '<new value>') from vault.secrets where name = 'service_role_key';`.

**New API keys (`sb_secret_…`), review finding C4.** The Edge Function compares the bearer with its
`SUPABASE_SERVICE_ROLE_KEY` environment variable, which Supabase injects as the **legacy JWT**
service role key. The Vault value must be that same string. If you disable legacy keys in
**Project Settings → API Keys**, every cron call becomes 401 until the function reads a non-reserved
secret name (`supabase secrets set` refuses names starting with `SUPABASE_`), which is a code change
in `supabase/functions/push-outbox/index.ts`. For the MVP keep legacy keys enabled; when you
switch, change the function, `supabase secrets set PUSH_OUTBOX_KEY=<sb_secret…>`, and
`vault.update_secret` together. supabase-js in the app and in the smoke test accepts either key
style.

## 7. Deploy the push-outbox Edge Function

Function secrets (optional ones; `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected):

```powershell
supabase secrets set EXPO_ACCESS_TOKEN=<token>     # only if Expo "Enhanced push security" is on
supabase secrets set SENTRY_DSN=<dsn>              # optional; see supabase/functions/push-outbox/sentry.ts for the name it reads
supabase secrets list
```

Deploy:

```powershell
supabase functions deploy push-outbox --no-verify-jwt
```

`verify_jwt = false` is also set in `config.toml` (`[functions.push-outbox]`), so the flag is a
safety net. The function authenticates callers itself: anything but `POST` with
`Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>` gets 401/405. Smoke it by hand:

```powershell
$key = "<service_role key>"
Invoke-RestMethod -Method Post -Uri "https://<ref>.supabase.co/functions/v1/push-outbox" -Headers @{ Authorization = "Bearer $key" }
# {claimed: 0, sent: 0, retried: 0, dropped: 0, tokensDeleted: 0}
```

Then confirm cron reaches it (give it two minutes):

```sql
select status, return_message, start_time
  from cron.job_run_details d join cron.job j on j.jobid = d.jobid
 where j.jobname = 'push-outbox' order by start_time desc limit 5;      -- status 'succeeded'
select id, status_code, left(content, 120) content, created
  from net._http_response order by created desc limit 5;              -- status_code 200
```

Logs: **Dashboard → Edge Functions → push-outbox → Logs** (one JSON line per run,
`{"fn":"push-outbox","claimed":…}`). Redeploy after every change to `supabase/functions/push-outbox/`.

## 8. Auth settings

**Dashboard → Authentication → URL Configuration**

| Setting | Value |
|---|---|
| Site URL | `finalcall://auth-callback` |
| Redirect URLs | `finalcall://auth-callback`, `finalcall://auth-callback/**`, `exp://**/--/auth-callback` (dev client on the LAN) |

The app sends magic links with `emailRedirectTo = Linking.createURL('auth-callback')`
(`app/src/lib/auth.tsx`); a URL not in this list makes the link land on the Site URL with an
error. Wildcards: `*` one path segment, `**` any.

**Authentication → Providers → Email**: enabled; *Confirm email* **off** (the magic link is the
confirmation); *Secure email change* on. Magic-link / OTP expiry 3600 s (matches
`lib/pendingNext.ts`'s one-hour TTL).

**Authentication → Providers → Apple**: enable. For **native** Sign in with Apple (what the app
does: `signInWithIdToken` with Apple's identity token) only one field matters:

| Field | Value |
|---|---|
| Client IDs | `com.ishaanmakam.finalcall` (the iOS bundle id; several may be comma-separated) |
| Secret Key (for OAuth) | leave empty for native-only |

Fill the OAuth part only if you later add web sign-in: Services ID (e.g. `com.ishaanmakam.finalcall.web`),
Team ID (Apple Developer → Membership), Key ID + the `.p8` private key from Certificates →
Keys → *Sign in with Apple*; the dashboard turns those into the 6-month JWT that goes in Secret
Key, and the Services ID's return URL must be `https://<ref>.supabase.co/auth/v1/callback`.
Keep the renewal date in the calendar: the secret expires.

**Authentication → Email Templates → Magic Link**: the default template works (it must keep
`{{ .ConfirmationURL }}`). Suggested subject: `Your Final Call sign-in link`; body in the product's
voice ("Tap to sign in. The link works once and expires in an hour."). No money words.

**Authentication → SMTP Settings** (before TestFlight): the built-in sender is limited to a handful
of emails per hour and is for development only. Configure a provider (Resend, Postmark, …) with a
sender on your domain; then raise **Authentication → Rate Limits → Emails sent** to a real number
(e.g. 30/hour).

Optional: `supabase config push` writes the `[auth]` and `[storage]` sections of `config.toml` to
the hosted project in one go (same values as the tables above; the Apple secret is read from
`$env:SUPABASE_AUTH_EXTERNAL_APPLE_SECRET` and may be empty). It **overwrites** those sections'
dashboard values, so review its diff prompt before confirming.

## 9. Storage bucket

`20261107000500_app_support.sql` inserts the private bucket `review-photos` and its two RLS
policies, and `20261107000600_review_fixes.sql` caps it at 5 MB / image MIME types, wherever
`storage.buckets` exists, which includes hosted projects. Verify:

```sql
select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'review-photos';
select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'review_photos%';
-- review_photos_insert, review_photos_select
```

If the bucket row is missing (the migration could not write `storage.buckets` on your project):
**Dashboard → Storage → New bucket**: name `review-photos`, *Public* off, file size limit 5 MB,
allowed MIME types `image/jpeg, image/png, image/heic, image/heif, image/webp`. Then run the two
`create policy review_photos_… on storage.objects …` statements from
`supabase/migrations/20261107000500_app_support.sql` in the SQL Editor (object path is
`<group_id>/<user_id>/<file>`; members write under their own folder, group members read).

## 10. Smoke test

`scripts/smoke.ts` runs one pact day through the real API as two throwaway users plus the
service role: group → invite → pact with places → instance → open → A checks in, B does not →
close → results and balances (+500/−500) → settlement → one obligation B→A → mark paid → confirm →
balances 0 and a `settlement_payment` entry. Each step prints `✓`; the first mismatch exits 1.

```powershell
cd C:\Users\ishaa\Projects\bet-app
Copy-Item .env.example .env            # then fill SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
cd scripts
npm install
npm run smoke
```

Without a `.env` it prints `Smoke skipped: no .env` and exits 0. It takes about a minute (it
waits for the pact window it created to open on the server clock).

What it leaves behind: the ledger is append-only and `groups.created_by`, `results`,
`ledger_accounts` reference the users, so nothing can be deleted from the client. The group,
pact (paused at the end so cron stops generating days for it), instance, results, ledger entries,
settlement and confirmed obligation stay; the two users are hard-deleted when the schema allows it
and otherwise soft-deleted (GoTrue scrubs the email and bans sign-in, keeping the row). **Point
`.env` at a dedicated smoke/staging project**, or accept one extra settled group per run in
production's tables (it is invisible to real users: nobody else is a member).

If `signInWithPassword` fails with "Email logins are disabled", the Email provider is off (§8); if
`createUser` fails with 401/403, the service role key is wrong or is an `sb_publishable_` key.

## 11. Point the app at the project (EAS)

The client reads `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` (anon key only;
RLS protects every table, the service role key never goes near the app).

Local development (Metro reads `app/.env`):

```powershell
cd C:\Users\ishaa\Projects\bet-app\app
Copy-Item .env.example .env            # fill the two EXPO_PUBLIC_ values (+ EAS_PROJECT_ID)
```

EAS builds (one set per environment; `development` for the dev client, `preview` for internal
TestFlight, `production` for the store):

```powershell
cd C:\Users\ishaa\Projects\bet-app\app
foreach ($envName in @('development', 'preview', 'production')) {
  npx eas-cli@latest env:create --environment $envName --name EXPO_PUBLIC_SUPABASE_URL --value https://<ref>.supabase.co --visibility plaintext --non-interactive
  npx eas-cli@latest env:create --environment $envName --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value <anon key> --visibility plaintext --non-interactive
}
npx eas-cli@latest env:list --environment production
```

`EXPO_PUBLIC_` values are inlined into the JS bundle, so `plaintext` is the honest visibility. Use a
separate Supabase project per environment if you want preview builds off production data; then the
values differ per `$envName`. After changing them, rebuild (`eas build`) or publish an OTA update
(`eas update --channel <profile>`; see `app/README.md` "Ship an OTA fix").

Crash reporting (optional, `app/src/lib/sentry.ts`): the DSN is a public value, the auth token is a
secret used only by the build to upload source maps.

```powershell
foreach ($envName in @('preview', 'production')) {
  npx eas-cli@latest env:create --environment $envName --name EXPO_PUBLIC_SENTRY_DSN --value https://<key>@o<org>.ingest.sentry.io/<project> --visibility plaintext --non-interactive
  npx eas-cli@latest env:create --environment $envName --name SENTRY_ORG --value <org-slug> --visibility plaintext --non-interactive
  npx eas-cli@latest env:create --environment $envName --name SENTRY_PROJECT --value <project-slug> --visibility plaintext --non-interactive
  npx eas-cli@latest env:create --environment $envName --name SENTRY_AUTH_TOKEN --value <token> --visibility secret --non-interactive
}
```

The Edge Function side is `supabase secrets set SENTRY_DSN=<dsn> SENTRY_ENVIRONMENT=production` (§7).

## 12. Optional: local stack (`supabase start`)

Needs Docker Desktop (or Podman). From the repo root:

```powershell
supabase start                 # pulls images once (several GB), applies migrations + seed.sql
supabase status                # prints local URL (http://127.0.0.1:54321), anon and service keys
```

- Studio: http://127.0.0.1:54323. Mailpit (magic links land here): http://127.0.0.1:54324.
- Seed users: `alice@example.com` / `bob@example.com`, password `password123`, in group
  "Kane Hall crew" (invite `SEEDKANE01`) with the pact "9am class" and a week of instances.
  `supabase db reset` rebuilds the database from the migrations and re-seeds.
- Cron runs locally too. Create the two Vault secrets with the local values
  (`project_url` = `http://host.docker.internal:54321`, `service_role_key` = the local service key
  from `supabase status`), then `supabase functions serve push-outbox --no-verify-jwt`.
- Point the smoke test at it: `.env` with the local URL and keys from `supabase status`.
- `supabase test db` runs the pgTAP files in `supabase/tests/pgtap/` (copy them to
  `supabase/tests/database/` if your CLI only looks there).

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `npm install -g supabase` → "Installing Supabase CLI as a global module is not supported" | Use Scoop (§1 A) or `npx -y supabase@latest` (§1 B). |
| `supabase login` hangs after the browser opens | Paste the verification code shown in the browser into the terminal, or use `supabase login --token <PAT>`. |
| `supabase link` → `failed to connect to postgres: password authentication failed` | Wrong database password (not your account password). Reset it in Project Settings → Database → Reset database password, then relink. |
| `supabase link` → `Access token not provided` in CI | Set `$env:SUPABASE_ACCESS_TOKEN` (PAT) and `$env:SUPABASE_DB_PASSWORD`. |
| `db push` → `Remote migration versions not found in local migrations directory` | Someone applied a migration from another checkout or renamed a file. `supabase migration list`, then `supabase migration repair --status reverted <version>` for versions that do not exist locally (never delete rows from `schema_migrations` by hand). |
| `db push` → `extension "pg_net" is not available` | Project predates pg_net being bundled: enable it in Database → Extensions, then §5 step 2. |
| `db push` → `permission denied for table buckets` | Your project forbids `postgres` writing `storage.buckets`. Create the bucket and policies by hand (§9). The rest of the migration still applied: check `migration list`. |
| `cron.job` is empty after `db push` | pg_cron was not available when the file ran: §5 (enable, then re-run the block). |
| `push-outbox` job: `Vault secrets project_url / service_role_key are missing` | §6 not done, or a typo in the secret **name**. `select name from vault.decrypted_secrets;` |
| `net._http_response` shows 401 | Vault `service_role_key` ≠ the function's `SUPABASE_SERVICE_ROLE_KEY` (legacy JWT). Re-copy from Project Settings → API; see "New API keys" in §6. |
| `net._http_response` shows 404 or `could not resolve host` | `project_url` wrong (must be `https://<ref>.supabase.co`, no trailing path) or the function is not deployed (`supabase functions list`). |
| Function returns 405 | Called with GET. Cron and the smoke POST. |
| Push never arrives, `last_error = DeviceNotRegistered` | The device's Expo token is stale; it is deleted automatically. Reinstall the dev build and sign in again. |
| Push never arrives, `last_error` mentions `EXPO_ACCESS_TOKEN` / 401 from exp.host | Expo project has enhanced push security on: `supabase secrets set EXPO_ACCESS_TOKEN=…` and redeploy. |
| Magic link opens the browser with `error=invalid_request` / `redirect_to is not allowed` | The app's callback URL is not in Redirect URLs (§8). Dev client URLs look like `exp://192.168.x.y:8081/--/auth-callback`; the `exp://**/--/auth-callback` wildcard covers them. |
| Magic link email never comes | Built-in SMTP rate limit (a few per hour) or the address bounced. Authentication → Logs; configure custom SMTP (§8). |
| Apple sign-in → `Unacceptable audience in id_token` | The bundle id of the build is not in the Apple provider's Client IDs (`com.ishaanmakam.finalcall`, or your `IOS_BUNDLE_ID` override). |
| Apple sign-in → `Passed nonce and nonce in id_token should either both exist or not` / `Nonces mismatch` | The app hashes a random nonce for Apple and sends the raw one to Supabase (`app/src/features/auth/appleNonce.ts`). Keep `skip_nonce_check = false`; the error means an old build without the nonce talks to a project that expects one, or vice versa: rebuild. |
| Ops alerts never arrive | `ops_settings.ops_user_id` is null (§5), the push function was deployed before the `ops_alert` renderer (redeploy, §7), or the ops user has no push token (sign in on a phone and allow notifications). |
| App shows "Setup needed" | `EXPO_PUBLIC_SUPABASE_URL` / `_ANON_KEY` missing in `app/.env` (Metro) or in the EAS environment of that build profile (§11). |
| App RPC errors `42501` for everything | The user is not a member of the group they act on, or the JWT is stale after a key rotation: sign out and back in. |
| `smoke`: `generate_instances created 0 instances` | The script's window-open instant was already past when the server generated instances: a very slow network. Re-run; if it repeats, raise the 25 s margin in `scripts/smoke.ts` (`windowOpenMs`). |
| `smoke`: `check_in: ... window not open` or `server clock ... still before window open` | Local clock far off the server's; the script uses the HTTP `Date` header to correct, but a skew of minutes with a frozen clock still fails. Fix the PC clock (`w32tm /resync`). |
| `smoke`: `expected 1 obligation, got 0` | Settlement found nothing billable: the instance was not closed, or `settle_due_groups` ran with a `p_now` before the week's Monday noon. The script computes it from the group's zone; check the printed instant. |
| `supabase start` → `Cannot connect to the Docker daemon` | Docker Desktop not running / not installed; everything in §1–§11 works without it. |
| `supabase start` → port 54321/54322 in use | Another local stack: `supabase stop --project-id <other>` or change the ports in `config.toml`. |

## Checklist

Copy into the deploy issue and tick:

- [ ] §2 Project created (PG 17), keys copied
- [ ] §3 `supabase link` done, `migration list` shows local files
- [ ] §4 `supabase db push`; Local = Remote for every version
- [ ] §5 `cron.job` lists 7 jobs; `pg_cron` + `pg_net` in `pg_extension`; `ops_settings.ops_user_id` set
- [ ] §6 Vault `project_url` + `service_role_key`; `push-outbox` job succeeding
- [ ] §7 `push-outbox` deployed; manual POST returns the summary; `net._http_response` 200s
- [ ] §8 Redirect URLs, Email provider (confirm off), Apple Client IDs, magic-link template, SMTP + rate limits
- [ ] §9 `review-photos` bucket private, 5 MB, image MIME; two policies present
- [ ] §10 `npm run smoke` green against the smoke project
- [ ] §11 EAS env vars for development / preview / production
- [ ] REVIEW.md "Before production checklist" items 5–9 (push receipts, security review, legal opinion, dashboard advisors, first-two-weeks watch)
