# Code review: backend, push function, app plumbing (2026-11-07)

Reviewer: agent C (phase 1 of the UI overhaul). Scope: everything in `supabase/`, `packages/rules` (read only), and the app's non-UI plumbing (`app/src/api/supabase.ts`, `app/src/lib/*`). Agent A's files (`app/src/api/queries.ts`, `rpc.ts`, `lib/auth.tsx`, `lib/push.ts`, `lib/location.ts`, `lib/useNow.ts`) and every screen/component got findings only; the patches for those are written out below for phase 3.

Method: read all six migrations, the Edge Function, and the app plumbing; ran `EXPLAIN` in PGlite for the hot paths; wrote failing tests before every fix (`supabase/tests/review-fixes.test.ts`, the F-sections of `supabase/functions/push-outbox/test/*.test.ts`, `app/src/lib/secureChunks.test.ts`, the DST case in `app/src/lib/time.test.ts`).

## Executive summary

The backend is in good shape: every RPC checks `auth.uid()` membership, every SECURITY DEFINER function pins `search_path`, clients can write nothing but their own profile and push tokens, the ledger is append-only and balanced, and the money paths are covered by 212 PGlite tests plus the differential oracle. Nothing found changes a business rule.

What was wrong and is now fixed (test-first, all suites green):

- **The one real bug**: `20261107000500` tried to add the outbox claim index under a name `20261107000100` had already used, with `IF NOT EXISTS`, so the index never existed and permanently-dropped rows were rescanned on every claim (R1).
- Push delivery had **no backoff** (five retries in five minutes, then silence forever), no stale-reminder guard (a "15 min left" push could arrive an hour late saying "1 min left"), and no `url` in the payload even though the app prefers it (F1–F3).
- A pact created in the morning got **no instance until the next midnight UTC** because `generate_instances` ran once a day (C1).
- Missing Vault secrets made the push cron **silently skip** forever (C2).
- The Supabase session JSON (2.5–4.5 KB) was written to SecureStore, whose **2048-byte limit** truncates or rejects it; sessions now go through a chunked adapter (A1).
- The client and server disagreed on **fall-back-ambiguous local times** (01:30 on the DST day): client picked the later instant, SQL the earlier (A2).
- RLS policies that call `auth.uid()` per row now use the InitPlan form (R4); hot queries got the indexes they were missing (R2–R3); the outbox is purged after 30 days (R5); appeal photos are capped at 5 MB / images only (R6).

What is proposed for phase 3 (agent A's lane) or later: notification routing by kind, keeping `next` through the magic-link flow, three query-invalidation gaps, Expo push receipts, `tick_instances` sargability, and a `before production` checklist at the end.

## Findings table

Severity: P0 money/safety, P1 breaks a user flow, P2 degrades at scale or in an edge case, P3 hygiene.

| ID | Sev | Area | Where | Finding | Status |
|----|-----|------|-------|---------|--------|
| R1 | P2 | DB perf | `20261107000500_app_support.sql:28`, `20261107000100_foundation.sql:294` | Claim index never created (name collision + `IF NOT EXISTS`); dropped rows (`attempts = 5`, never sent) stay in the old `(created_at) WHERE sent_at IS NULL` index and are rescanned on every claim | Fixed (`20261107000600`) |
| R2 | P2 | DB perf | `pact_instances` | No `(pact_id, deadline_at)` index; feed (28 days by group), pact detail (next 10), `_settle_group_week`, `_post_initial`, `_correct_instance` all filter by pact + deadline | Fixed |
| R3 | P3 | DB perf | `ledger_accounts` | No plain `(group_id, kind)` index; the partial unique indexes only apply when `kind` is a constant | Fixed |
| R4 | P3 | DB perf | `20261107000100_foundation.sql:712-751`, `0500:16` | Six policies call `auth.uid()` per row instead of `(select auth.uid())` (Supabase lint `auth_rls_initplan`) | Fixed |
| R5 | P3 | DB hygiene | `notification_outbox` | Never purged; sent and exhausted rows grow forever | Fixed (`purge_old_outbox`, nightly) |
| R6 | P2 | Security | `storage.buckets` `review-photos` | No size or MIME cap on appeal photo uploads | Fixed (5 MB, images only) |
| R7 | P3 | DB perf | `20261107000200:447,494` | `deadline_at - interval '15 minutes' <= now()` is not sargable; `(status, deadline_at)` index only narrows on `status = 'open'` | Proposed |
| R8 | P3 | DB perf | `20261107000100:741` | `ledger_lines_select` runs a subselect + SECURITY DEFINER call per line; fine for member-scoped reads, costly for any whole-ledger read by a client | Won't fix now (documented) |
| R9 | P2 | Scale | `account_balances`, `member_balances`, `billable_member_balances` | Balances sum the whole history per account; verified the planner pushes `group_id = ?` down (see "Balances at scale"), so cost is O(lines of that group), not the whole ledger. Needs attention only past ~1e6 lines | Won't fix (CLAUDE.md forbids stored balances); plan below |
| C1 | P1 | Cron | `20261107000400_cron.sql` | `generate-instances` ran daily at 00:07 UTC; a pact created after that got its first instance up to 24 h later (Asia-Pacific zones lose a whole day) | Fixed: every 15 min (idempotent) |
| C2 | P2 | Cron | `20261107000400_cron.sql` | Missing Vault secrets made the push job return NULL silently every minute | Fixed: raises, visible in `cron.job_run_details` |
| C3 | P3 | Cron | `20261107000400_cron.sql` | `pg_net` created without `with schema extensions`; 10 s response timeout too short to record the function's reply | Fixed: `extensions` when present; 30 s |
| C4 | P2 | Cron / keys | push-outbox auth | The function compares the bearer with `SUPABASE_SERVICE_ROLE_KEY` (legacy JWT). If the project moves to `sb_secret_...` keys the Vault value and env var must change together or every call is 401 | Documented (config.toml, README) |
| C5 | P3 | Docs | `app/README.md:151` | Says photo paths are `<instance_id>/<auth.uid()>/...`; migration and `reviewPhoto.ts` use `<group_id>/<user_id>/...` (the code agrees with itself; the doc is wrong) | Fixed (phase 3: README) |
| F1 | P2 | Push | `outbox.ts` `renderNotification` | No `url` in `data`; the app's `routeFromData` sent every instance notification (results, reviews) to the check-in screen and settlements to the group home | Fixed: `url` by kind |
| F2 | P2 | Push | `outbox.ts` `planMessages` | `window_open` / `deadline_soon` were sent however late; with retries a "1 min left" push could arrive after the deadline | Fixed: stale reminders dropped |
| F3 | P2 | Push | `index.ts` `markFailed` | Lease cleared on failure: 5 retries in 5 minutes, then the row is dead for good. An Expo/network blip of five minutes lost every notification queued in it | Fixed: `claimed_until` = now + 1/5/15/60 min by attempt |
| F4 | P3 | Push | `claim_outbox.sql` | Drifted copy of the migration's function (`search_path = public`); the Node test exercised the copy, not the migration | Fixed: synced + drift test |
| F5 | P2 | Push | `outbox.ts` | Expo receipts not polled: a ticket `ok` can still end in `DeviceNotRegistered` at delivery, so uninstalled devices keep their tokens and Expo may throttle the project | Proposed (needs a `push_tickets` table) |
| F6 | P3 | Push | `index.ts:65` | If `markSent` fails after Expo accepted the batch, the rows are re-sent when the lease expires (at most 4 more times, now with backoff). No 2PC is possible; acceptable for notifications | Won't fix (documented) |
| A1 | P1 | App | `app/src/api/supabase.ts:19` | Session JSON exceeds SecureStore's 2048-byte value limit (iOS warns and may truncate, Android rejects): sign-in could silently not persist | Fixed: chunked adapter (`lib/secureChunks.ts`) |
| A2 | P3 | App | `app/src/lib/time.ts:362` | Fall-back-ambiguous wall times resolved to the later instant; SQL `_local_to_utc` takes the earlier. Only affects "next occurrence" display for 01:00–02:00 on the DST day | Fixed |
| A3 | P2 | App | `app/src/lib/push.ts:82-88` | Routes by `instance_id` before `group_id`; with F1 the server now sends `url` so this works, but the fallback should route by `kind` too | Fixed (phase 3: `routeFromData` routes result / review kinds to the feed, settlement to settle-up, then by instance, then by group) |
| A4 | P3 | App | `app/src/lib/push.ts:97` | `getLastNotificationResponse()` re-fires on every mount of the signed-in tree (sign-out/in reopens an old notification); no dedupe by identifier | Fixed (phase 3: module-level `handledResponseId`; a response is acted on once per process) |
| A5 | P2 | App | `app/src/app/auth-callback.tsx:19`, `app/src/lib/auth.tsx:76` | Magic-link flow drops `next`: open invite → sign-in?next=/join/CODE → email → callback → `/groups`. The invite is lost | Fixed (phase 3: `lib/pendingNext.ts`, a pure store over AsyncStorage with a one-hour TTL and `safeNext` on both ends, 6 tests; sign-in parks `next` before sending the link, auth-callback takes it once) |
| A6 | P3 | App | `app/src/api/queries.ts:70` | Profile update invalidates only `['profile']`; names cached inside group/feed/ledger queries stay stale until refetch | Fixed (phase 3: `PROFILE_DEPENDENT_KEYS` = profile, `['group']`, `['groups']`, in the real and demo hooks) |
| A7 | P3 | App | `app/src/app/(app)/pacts/[pactId]/index.tsx:34-35,53` | Freeze does not invalidate `['instance', …]` (check-in screen shows no freeze); pause/resume does not invalidate `['group', …]` (home still lists the paused pact's instance) | Fixed (phase 3: freeze invalidates `['pact']`, `['instance', id]`, `['group', gid]`; pause/resume already invalidated `['group', gid]` after phase 2) |
| A8 | P3 | App | `app/src/lib/checkinQueue.ts:56` | Two taps in the same window produce two attempts (different capture times). Harmless by rule (first in-fence wins, cap 20) and the button is disabled while busy; noted so nobody "fixes" it into a client-side dedupe that drops a real retry | Won't fix |
| A9 | P3 | App | `app/src/lib/errors.ts:9-18` | Classification is right for PostgREST (`PGRST301-303` auth, 5xx/0/408/429 network, SQLSTATE rejected). `57014` statement timeout maps to network via message, which is the right retry behaviour | No change |
| S1 | P3 | Security | all RPCs | Every client RPC checks `auth.uid()` and membership/roster/party before acting; all SECURITY DEFINER functions pin `search_path`; the foundation guard test keeps it so | Verified |
| S2 | P3 | Security | grants | Clients can write only `profiles(display_name, venmo_username)` on their own row and delete their own `push_tokens`. Nothing else | Verified |
| S3 | P3 | Security | invite codes | 50 bits of Crockford base32 from `gen_random_uuid()`; `join_group` locks the group row; brute force infeasible | Verified |
| S4 | P3 | Security | check-in cap | 20 per user per instance, retries with the same `p_client_attempt_id` do not count | Verified |

## DB performance

### Index coverage of hot paths (EXPLAIN in PGlite, `enable_seqscan = off` to expose index availability)

| Path | Query shape | Index | Status |
|------|-------------|-------|--------|
| Group home today | `pact_instances where pact_id in (…) and local_date in (…)` | `unique (pact_id, local_date)` | ok |
| Group home check-ins/results | `checkins where instance_id in (…)`, `results where instance_id in (…)` | `checkins_instance_user_idx`, results PK | ok |
| Instance detail | `checkins where instance_id = ? and user_id = ?`, `freezes where instance_id and user_id`, `pact_participant_places (pact_id, user_id)` | existing | ok |
| Feed 28 days | `pact_instances where pact_id in (…) and deadline_at >= ? and status in (…)` | was `(status, deadline_at)` with a filter on pact_id; now `(pact_id, deadline_at)` | **added (R2)** |
| Pact detail | `pact_instances where pact_id = ? and deadline_at >= ? order by deadline_at limit 10` | `(pact_id, deadline_at)` | **added (R2)** |
| Ledger balances | `member_balances where group_id = ?` | `ledger_accounts_member_uniq (group_id, user_id) where kind = 'member'` + `ledger_lines_account_idx` | ok (see below) |
| Ledger obligations | `obligations where group_id = ? and status in (…)` | `obligations_group_idx (group_id, status)` | ok |
| Settlements | `settlements where group_id = ? order by week_start desc limit 1` | `unique (group_id, week_start)` | ok |
| My groups | `group_members where user_id = ? and left_at is null` | `group_members_user_idx` (partial) | ok |
| `tick_instances` (a) | `status = 'scheduled' and window_open_at <= now` | `pact_instances_status_open_idx` | ok |
| `tick_instances` (b)/(c) | `status = 'open' and deadline_at - 15min <= now` | `(status, deadline_at)` narrows on status only | ok today (R7 proposed) |
| `settle_due_groups` | per group: `pact_instances join pacts where group_id = ? and status = 'closed' and deadline_at < ?` | `pacts_group_idx` + `(pact_id, deadline_at)` | **added (R2)** |
| `_correct_instance` later captures | `pact_instances where pact_id = ? and status in (…) and carry_in_cents > 0 and (deadline_at, id) > (…)` | `(pact_id, deadline_at)` | **added (R2)** |
| `claim_outbox` | `sent_at is null and attempts < 5 and (claimed_until is null or <= now) order by id limit 100` | `notification_outbox_claim_idx (id) where sent_at is null and attempts < 5` | **fixed (R1)** |
| `purge_old_locations` | `server_received_at < ? and (lat or lng not null)` | `checkins_received_with_location_idx` (partial) | ok |
| `purge_old_outbox` | `sent_at < ?` / `attempts >= 5 and created_at < ?` | sequential once a night on a small table | ok |
| `ensure_account` | `group_id = ? and kind = ? and case …` | partial unique indexes when `kind` is a literal (custom plan); `(group_id, kind)` otherwise | **added (R3)** |

### Indexes added in `20261107000600_review_fixes.sql`

```sql
create index notification_outbox_claim_idx on public.notification_outbox (id) where sent_at is null and attempts < 5;
drop index public.notification_outbox_unsent_idx;   -- (created_at) where sent_at is null: superseded
create index pact_instances_pact_deadline_idx on public.pact_instances (pact_id, deadline_at);
create index ledger_accounts_group_kind_idx on public.ledger_accounts (group_id, kind);
```

Not added on purpose: `ledger_lines(account_id)` and `ledger_entries(group_id)`, `(instance_id)` already exist in the foundation; `obligations(from_user)` / `(to_user)` are not queried by the app (the RLS `OR` clause is not index-usable anyway); `results(user_id)` exists.

### Balances at scale (R9)

`account_balances` is `group by a.id` over `ledger_accounts left join ledger_lines`. I expected the planner to refuse to push `group_id = ?` through the aggregate (it is not a grouping column), which would have meant summing the whole ledger for every ledger screen. EXPLAIN shows it does push it down (PK functional dependency), so the read cost is O(lines of that group's accounts). `billable_member_balances` groups by `a.group_id` explicitly and behaves the same, with two extra index joins per line.

Growth: 8 members x 1 pact x 5 instances/week x ~3 lines each ≈ 120 lines/week/group, 6k/year/group. At 1,000 active groups that is 6M lines/year. Reads stay per group (fine); the client-side RLS cost per line (R8) is the first thing to hurt. Before that scale, the options that respect "balances are derived, never stored" are:

1. Add `group_id` to `ledger_lines` (denormalised, set by `post_entry`, checked by the existing consistency trigger) so `ledger_lines_select` becomes `is_group_member(group_id)` with no subselect, and index `(group_id, account_id)`.
2. A `materialized view` of per-account balances refreshed by `settle_due_groups` (still derived, rebuildable, never written by business code), with the live view used only for the current week's delta.

Neither is needed for the MVP; do (1) first when `ledger_lines` passes ~1M rows.

### R7 (proposed): sargable deadline_soon scan

```sql
-- 20261107000200_instances_checkins_reviews.sql:447 and :494
-        or (i.status = 'open' and i.deadline_at - interval '15 minutes' <= v_now)
+        or (i.status = 'open' and i.deadline_at <= v_now + interval '15 minutes')
```

Same predicate, lets `(status, deadline_at)` serve both bounds. Requires `create or replace function tick_instances` in a new migration (100 lines duplicated); not worth it until open instances number in the thousands.

### RLS review

- All 19 tables have RLS enabled; every policy is `for select to authenticated` except `profiles_update_own` and `push_tokens_delete_own`. No `anon` policies.
- Policy helpers (`is_group_member`, `is_pact_group_member`, `is_instance_group_member`, `shares_group_with`) are `stable security definer` with pinned `search_path`, executable by `authenticated` only because policies need them.
- Direct `auth.uid()` calls (6 policies) rewritten to `(select auth.uid())` (R4); a test now fails if a future policy uses the bare form.
- Views `account_balances`, `member_balances`, `billable_member_balances` are `security_invoker`, so RLS applies through them.

## Cron / pg_net / Vault

What `20261107000400_cron.sql` does on a real project, and what changed (edited in place: the file has never been applied anywhere and is declarative schedule config; a second copy of the same `cron.schedule` calls in a later migration would have been two sources of truth):

| Topic | Verdict |
|-------|---------|
| Extension schemas | `pg_cron`'s control file fixes `pg_catalog`, so `create extension pg_cron` is right. `pg_net` now uses `with schema extensions` when that schema exists (Supabase) and creates its own `net` schema regardless, so `net.http_post` is correct either way. |
| Who runs the jobs | pg_cron runs a job as the role that scheduled it: `postgres` under `supabase db push`. That role owns the SECURITY DEFINER job functions and can read `vault.decrypted_secrets`. No `supabase_admin` dependency. |
| `cron.schedule` upsert | `cron.schedule(name, schedule, command)` replaces a job with the same name (pg_cron ≥ 1.4; Supabase ships 1.6), so re-applying is safe. |
| `net.http_post` signature | Named args `url, headers, body, timeout_milliseconds` match pg_net 0.8+; the call is asynchronous and returns a request id. Response goes to `net._http_response`. |
| Auth header | `Bearer <service_role_key>`; the function compares it to `SUPABASE_SERVICE_ROLE_KEY` with a constant-time compare. Deploy with `--no-verify-jwt` (`config.toml` sets `verify_jwt = false`). See C4 for the new-API-keys caveat. |
| Missing secrets | Previously `where s.url is not null and s.key is not null` made the command return nothing, forever, invisibly. Now a `DO` block raises `push-outbox: Vault secrets … are missing`, which pg_cron records as a failed run in `cron.job_run_details`. |
| Timeouts | 30 s response timeout (was 10 s). The function processes ≤ 100 rows per run (≤ 3 Expo batches of 20 s max each) and the 5-minute lease keeps the next minute's run off the same rows, so a slow run is never double-fired. |
| Schedules | `tick-instances` every minute; `generate-instances` every 15 minutes (C1); `settle-due-groups` hourly at :02 (half-hour zones settle ≤ 32 min after noon); `purge-old-locations` 03:23 UTC; `purge-old-outbox` 03:37 UTC; `push-outbox` every minute. |
| `supabase start` locally | pg_cron, pg_net and Vault are in the local image. Create the two secrets once (`project_url` = `http://host.docker.internal:54321` locally) and run `supabase functions serve push-outbox --no-verify-jwt`. |

`20261107000500_app_support.sql` against the app's "Schema additions" list: 1 `venmo_username` + own-row update ok; 2 co-member profile reads ok (`profiles_select`); 3 bucket + policies ok, path is `<group_id>/<user_id>/…` (doc wrong, C5); 4 `push_tokens_delete_own` ok; 5 `check_in` accepts null lat/lng/accuracy → `unjudgeable` ok; 6 `handle_new_user` trigger on `auth.users` ok (Supabase lets `postgres` create it); 7 payload `instance_id` / `group_id` present from `_instance_payload`, `url` now added by the function (F1).

## push-outbox Edge Function

| Topic | Verdict |
|-------|---------|
| Lease | `claim_outbox` bumps `attempts` and sets `claimed_until = now + 5 min` inside one `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`; an overlapping run cannot take the same rows (tested). |
| Batching | 100 messages per Expo request (`chunk`), tickets aligned by index, a missing ticket counts as retryable. |
| `DeviceNotRegistered` | Token deleted (deduped per run); a row whose tokens are all dead is dropped, not retried. |
| Retries / cap | `attempts < 5` at claim. **Was**: lease cleared on failure, so retries were back-to-back minutes. **Now**: `claimed_until` = now + 1/5/15/60 min by attempt (F3). |
| Stale reminders | **New**: `window_open` / `deadline_soon` with `deadline_at` in the past are dropped (F2). |
| Deep link | **New**: `data.url` by kind (F1); other ids still passed through. |
| Auth | Exact bearer match, POST only. |
| Error paths | `claim` or `tokensFor` failure → 500, rows stay leased and come back after 5 min with `attempts` already bumped (bounded). `markSent` failure after a successful send → possible duplicate later (F6, accepted). `markDropped` sets `attempts = 5` so dropped rows are terminal. |
| Timeouts | 20 s per Expo batch via `AbortSignal.timeout`; a timeout is a retryable `network:` error. |
| Test harness | Pure logic in `outbox.ts` runs under vitest (Node) and Deno; `index.ts` is Deno-only and not type-checked locally. CI runs `deno check index.ts` (advisory until seen green once). `claim_outbox.sql` is now asserted identical to the migration (F4). |

### F5 (proposed): receipts

Expo returns a ticket id per message; delivery errors such as `DeviceNotRegistered` can surface only in the receipt 15 minutes later. Without polling, tokens of uninstalled apps are never cleaned and Expo may rate-limit the project. Plan: table `push_tickets(ticket_id text pk, user_id, token, outbox_id, created_at, checked_at null)` written by `markSent`; a second cron job (every 15 min) posts ids to `https://exp.host/--/api/v2/push/getReceipts` in batches of 1000 and deletes tokens with `DeviceNotRegistered`. Needs a migration + a second entrypoint; out of scope for this pass.

## App logic (non-UI)

### A1 (fixed): chunked SecureStore

`app/src/lib/secureChunks.ts` (pure, 15 tests): values that fit are stored as-is; bigger ones as a marker `__chunks__:<n>` plus `<key>.__chunk<i>` pieces split by UTF-8 bytes (≤ 1900, never inside a surrogate pair). Writes replace the marker last and delete chunks a shorter value no longer needs; a torn read returns `null` (supabase-js treats it as signed out) instead of a truncated JSON. `app/src/api/supabase.ts` wraps the SecureStore adapter with it. Legacy unchunked values still read.

### A2 (fixed): DST ambiguity

`zonedLocalToUtc` now returns the earlier instant for a wall time that occurs twice, matching `_local_to_utc`'s `least(c1, c2)`. Spring-forward gaps already matched (pre-transition offset). Only `nextOccurrence` display was affected.

### Deep links

- `showup://join/<code>` → `(app)/join/[code]` with a confirm button (good: no auto-join). Signed-out cold start → `(app)/_layout` redirects to `/sign-in?next=/join/CODE`; `safeNext` accepts only `/…` paths and refuses `/sign-in`. Apple sign-in then redirects to `next`.
- `showup://auth-callback?code=` → PKCE exchange → `/groups`. **A5**: `next` is lost on the email path. Proposed patch (A's lane):

```ts
// app/src/app/sign-in.tsx: before sendMagicLink
await AsyncStorage.setItem('showup.pendingNext', safeNext(params.next));
// app/src/app/auth-callback.tsx
-      .then(() => router.replace('/groups'))
+      .then(async () => {
+        const next = (await AsyncStorage.getItem('showup.pendingNext')) ?? '/groups';
+        await AsyncStorage.removeItem('showup.pendingNext');
+        router.replace(safeNext(next) as never);
+      })
```
(Not via `emailRedirectTo` query params: Supabase only keeps the redirect URL when it is allow-listed, and a wildcard entry widens the allow-list.)

- Notification taps: `routeFromData` prefers `data.url`, which the function now sends (F1). **A3** proposed fallback by kind for payloads from older function versions:

```ts
// app/src/lib/push.ts:82
 function routeFromData(data) {
   if (!data) return null;
   if (typeof data.url === 'string' && data.url.startsWith('/')) return data.url;
+  const kind = typeof data.kind === 'string' ? data.kind : '';
+  if ((kind === 'result' || kind === 'review_opened') && typeof data.group_id === 'string') return `/groups/${data.group_id}/feed`;
+  if (kind === 'settlement' && typeof data.group_id === 'string') return `/groups/${data.group_id}/ledger`;
   if (typeof data.instance_id === 'string') return `/checkin/${data.instance_id}`;
```

- **A4** proposed: remember the last handled `response.notification.request.identifier` in a module-level variable and skip it in `open()`; also prefer `Notifications.useLastNotificationResponse()` for cold start.

### Query invalidation (findings only; `queries.ts`/screens are A's)

| Action | Invalidates today | Gap |
|--------|-------------------|-----|
| check-in (live and queued) | `['instance', id]`, `['group', gid]` / `['group']` | none |
| create pact | `['group', gid]` | none |
| join pact / set place | `['pact', id]`, `['group', gid]` | none |
| create / join / leave group | `['groups']` | none |
| vote, open review (feed) | `['group', gid]` | none (covers feed + ledger) |
| mark paid / confirm / dispute | `ledger(gid)` | none |
| profile update | `['profile', uid]` | **A6**: add `['group']`, `['groups']` (names are embedded in those queries) |
| freeze | `['pact', id]`, `['group', gid]` | **A7**: add `['instance']` (check-in screen's `myFreeze`) |
| pause / resume | `['pact', id]` | **A7**: add `['group', gid]` (home lists today's instance of the paused pact) |

### Double taps and the queue

- Check in: button disabled while locating/sending; two separate taps make two attempts (different `clientCapturedAt`), each with its own `p_client_attempt_id`; the server keeps both (first in-fence wins). Correct, not a bug (A8).
- Retries: `attemptId` is a stable FNV hash of `(instance, capturedAt)` so a retry after a timed-out-but-delivered request returns the stored row (`checkins_user_attempt_uniq`). Good.
- Mark paid / confirm / dispute / vote: RPCs are idempotent on repeat (`no-op` or upsert); screens disable buttons while busy.
- Create group twice: `busy` guard; the RPC has no idempotency key, so a double submit past the guard would make two groups. Acceptable; the guard holds.

### Time handling

`windowState` uses UTC instants from the server; display uses `Intl` with the pact zone; `deviceTimeZone()` only decides whether to show the zone suffix. DST tests cover 2026-11-01 and 2027-03-14 for LA plus the ambiguity case (A2). `nextOccurrence` iterates local dates and converts each with `zonedLocalToUtc`, so a device in a different zone than the pact shows the pact's wall time correctly.

### `errors.ts`

Classification matches what PostgREST returns through supabase-js: `status` is attached by `rpc.ts` (`RpcError`); 0/408/425/429/5xx → network (queued), 401 or `PGRST301-303` → auth (queued, the client refreshes), everything else → rejected (shown, not queued). `userMessage` maps every SQLSTATE the migrations raise and never shows raw database text. No change.

## What differs on real Supabase vs PGlite

| | PGlite (tests) | Supabase |
|-|----------------|----------|
| `pg_cron`, `pg_net`, Vault | absent; cron migration is a no-op (asserted) | present; jobs scheduled as `postgres`; create the two Vault secrets by hand |
| Storage | `storage.*` absent; bucket/policy blocks skipped | bucket `review-photos` created, 5 MB / image MIME caps, insert/select policies |
| `auth.users` | stub with `id, email`; `handle_new_user` reads metadata via `to_jsonb(new)` | real table; `postgres` may create the trigger (Supabase convention) |
| `auth.uid()` | `request.jwt.claim.sub` setting | JWT claims via PostgREST |
| Roles | `postgres` is superuser | `postgres` is not superuser but owns the functions and has `bypassrls` |
| Concurrency | single connection; lock order documented, not exercised | real; see GLOBAL LOCK ORDER in `20261107000300` |
| Edge Function | `outbox.ts` under Node | `index.ts` under Deno (`npm:@supabase/supabase-js@2`) |

## Security sweep (light)

- `search_path` pinned on every SECURITY DEFINER function (guard test).
- Membership: `create_pact`, `join_pact`, `set_pact_paused` check `is_group_member`; `check_in`, `declare_freeze`, `open_review` check the instance roster; `cast_vote` checks `_review_voters`; obligation RPCs check payer/payee; `leave_group` checks current membership. `join_group` needs only the code (by design).
- Client writes: `profiles(display_name, venmo_username)` own row, `push_tokens` delete own, storage insert under own folder in own group. Nothing else; `authenticated` has `SELECT` only elsewhere, RLS-filtered.
- Invite codes: 50 random bits, Crockford alphabet, O/I/L normalised on input.
- Rate limits: 20 check-ins per user per instance (tested); no per-IP limits (Supabase gateway's job).
- Appeal photos: now capped (R6). No delete policy: evidence cannot be removed after it is cited.
- Secrets: none in the repo; `.env` gitignored; `config.toml` references `env(SUPABASE_AUTH_EXTERNAL_APPLE_SECRET)`.

## CI

`.github/workflows/ci.yml`: four jobs on push and pull_request, Node 22, npm cache keyed per lockfile, `npm ci` everywhere (all four packages have lockfiles): `packages/rules` (tsc + vitest), `supabase/tests` (tsc + vitest, 15 min timeout, no services), `supabase/functions/push-outbox` (tsc + vitest + advisory `deno check index.ts`), `app` (tsc + vitest).

## Before production checklist

1. Create Vault secrets `project_url` and `service_role_key` in each environment; confirm `select * from cron.job_run_details` shows `push-outbox` succeeding and `net._http_response` shows 200s.
2. Deploy `push-outbox` with `--no-verify-jwt`; set `EXPO_ACCESS_TOKEN` if Expo "enhanced push security" is on.
3. Decide on API keys (legacy JWT vs `sb_secret_`) and keep the Vault value and the function's env var identical (C4).
4. Add `finalcall://auth-callback` to Auth → Redirect URLs; enable the Apple provider with the bundle id.
5. Implement push receipts (F5) before the user count makes dead tokens matter.
6. ~~Apply the phase-3 app patches (A3–A7) and fix the README path (C5).~~ Done in phase 3.
7. Run `/security-review` and get the legal opinion before any real money (CLAUDE.md).
8. Watch `job_failures` and `cron.job_run_details` for the first two weeks; set up a weekly `select count(*) from ledger_lines` to know when R9's plan is due.
9. Re-run the RLS lints in the Supabase dashboard (Advisors) after the first deploy; R4 clears `auth_rls_initplan`, nothing else should be flagged.
