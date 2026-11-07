# Build contract (shared by all agents)

This is the interface every part of the system builds against. `docs/DESIGN.md` explains why; this file says exactly what. If you need to change anything here, say so in your report instead of silently diverging.

Conventions: Postgres (Supabase). Schema `public`. All money `bigint`/`int` cents. All instants `timestamptz`. Every pact stores an IANA zone. Enum and column names below are exact.

## Enums

```
instance_status:   'scheduled' | 'open' | 'closed' | 'settled' | 'voided'
result_status:     'pending' | 'success' | 'failed' | 'unverified' | 'frozen' | 'void' | 'excluded'
checkin_verdict:   'in_fence' | 'out_of_fence' | 'unjudgeable' | 'rejected_simulated'
review_kind:       'appeal' | 'challenge'
review_status:     'open' | 'accepted' | 'rejected' | 'defaulted'
ledger_account_kind: 'member' | 'pot' | 'carry'
entry_kind:        'stake' | 'payout' | 'rollover' | 'settlement_payment' | 'correction'
obligation_status: 'pending' | 'marked_paid' | 'confirmed' | 'superseded'
```

## Tables

```
profiles(id uuid pk references auth.users, display_name text not null, created_at)
groups(id uuid pk, name text, invite_code text unique, settlement_tz text not null, created_by uuid, created_at)
group_members(group_id, user_id, role text check in ('owner','member'), joined_at, left_at null, pk(group_id,user_id))
   -- at most 8 current members per group
pacts(id uuid pk, group_id, title, days_of_week smallint[] (ISO 1=Mon..7=Sun), window_open_local time,
      deadline_local time, stake_cents int default 500 check 1..10000, tz text, paused bool default false,
      created_by, created_at)   -- window_open_local < deadline_local (same local day)
pact_participants(pact_id, user_id, place_lat float8, place_lng float8, place_radius_m int check 25..500,
      place_label text, joined_at, left_at null, pk(pact_id,user_id))
pact_instances(id uuid pk, pact_id, local_date date, window_open_at timestamptz, deadline_at timestamptz,
      status instance_status default 'scheduled', carry_in_cents bigint null, closed_at null, unique(pact_id, local_date))
checkins(id uuid pk, instance_id, user_id, client_captured_at timestamptz, server_received_at timestamptz default now(),
      lat float8 null, lng float8 null, accuracy_m float8 null, distance_m float8 null, is_simulated bool default false,
      verdict checkin_verdict not null)   -- lat/lng nulled after 30 days
freezes(id uuid pk, pact_id, user_id, instance_id, declared_at timestamptz default now(), iso_week text,
      unique(pact_id, user_id, iso_week))
results(instance_id, user_id, status result_status, first_success_at timestamptz null, decided_at, pk(instance_id,user_id))
reviews(id uuid pk, instance_id, subject_user_id, opened_by, kind review_kind, reason text, photo_path text null,
      status review_status default 'open', opened_at, resolved_at null)
review_votes(review_id, voter_id, supports bool, cast_at, pk(review_id, voter_id))
ledger_accounts(id uuid pk, group_id, kind ledger_account_kind, user_id null, instance_id null, pact_id null)
   -- unique: one member account per (group,user); one pot per instance; one carry per pact
ledger_entries(id uuid pk, group_id, kind entry_kind, idempotency_key text unique not null, instance_id null,
      memo text, created_at)
ledger_lines(id bigserial pk, entry_id, account_id, amount_cents bigint check (amount_cents <> 0))
settlements(id uuid pk, group_id, week_start date, ran_at, unique(group_id, week_start))
obligations(id uuid pk, settlement_id, group_id, from_user, to_user, amount_cents bigint check > 0,
      status obligation_status default 'pending', marked_paid_at null, confirmed_at null)
notification_outbox(id bigserial pk, user_id, kind text, payload jsonb, created_at, sent_at null, attempts int default 0, last_error text null)
push_tokens(user_id, token text, platform text, updated_at, pk(user_id, token))
```

Views: `account_balances(account_id, group_id, kind, user_id, pact_id, instance_id, balance_cents)` and `member_balances(group_id, user_id, balance_cents)`; both derived by summing `ledger_lines`. No stored balances anywhere.

## Ledger invariants (enforced in the database)

1. `ledger_entries` and `ledger_lines` are append-only (UPDATE/DELETE raise).
2. Lines of each entry sum to 0 (deferred constraint trigger, checked at commit).
3. `idempotency_key` unique. Internal helper `post_entry(p_group uuid, p_kind entry_kind, p_key text, p_instance uuid, p_memo text, p_lines jsonb) returns uuid`: `p_lines` is `[{"account_id": uuid, "amount_cents": int}]`; if the key exists with identical lines return the existing id and insert nothing; if it exists with different lines raise; zero lines (all amounts net to nothing) → return null, insert nothing. Lines with the same account are merged; zero-amount lines dropped.
4. Helper `ensure_account(p_group, p_kind, p_user, p_instance, p_pact) returns uuid` (get-or-create).
5. Client roles never write ledger, results, instances, obligations status (except through RPCs below).

## Rules

**Check-in verdict** (computed in `check_in`): if `is_simulated` → `rejected_simulated`. Else if accuracy is null, <0, or >200 m → `unjudgeable`. Else distance = haversine(fix, participant place); `in_fence` if `distance_m - accuracy_m <= place_radius_m`, else `out_of_fence`. Check-ins are accepted only for current participants, only when `server_received_at >= window_open_at` (or, for offline submissions arriving late, `client_captured_at` between window_open_at and deadline_at).

**Result per participant** (computed when an instance closes, and recomputed for that user if a late offline check-in arrives before the instance is settled):
- frozen: a freeze exists for this instance.
- success: some `in_fence` check-in with `server_received_at <= deadline_at`. `first_success_at` = earliest such.
- unverified: no success, and there is a check-in that is `unjudgeable`, OR there is a check-in with `server_received_at > deadline_at` and `client_captured_at <= deadline_at`.
- failed: otherwise (no check-in, or only out_of_fence / rejected_simulated).
- void (instance-level): if fewer than 2 participants are active (success or failed), every non-frozen participant's result is `void` and the instance status is `voided`. Unverified participants are not active.
- excluded: only set by review outcomes.
Reviews then override: appeal accepted → success (first_success_at = deadline_at); appeal defaulted (no votes) → excluded; challenge accepted → failed; challenge rejected/defaulted → unchanged.

**Payout** for a closed, non-void instance (active = success + failed, k = successes, C = carry balance of the pact at close, stored in `carry_in_cents`):
- k = 0: each failed member's stake moves member → pot → carry (entries `stake` then `rollover`). Carry grows.
- k ≥ 1: pot = stake × (n − k) + C. Failed members pay stake into pot (`stake`), carry pays C into pot (`stake`), pot pays winners (`payout`): each gets floor(pot/k); leftover cents go one each to winners ordered by `first_success_at` ascending, then user_id ascending. Pot ends at 0.
- Idempotency keys: `stake:<instance_id>`, `payout:<instance_id>`, `rollover:<instance_id>`.
- Corrections: when a result changes after posting (review or late check-in), recompute the instance's target net per member account using the same rules and the stored `carry_in_cents`, compare with what is posted for that instance, post the difference as one `correction` entry keyed `correction:<instance_id>:<n>` (n increments). Never mutate past entries.

**Freeze**: `declared_at < window_open_at`; one per (pact, user, ISO week of the instance's local_date).

**Review**: subject appeals their own `failed`; any other participant challenges `success` or `unverified`. Voters = current participants of the pact except subject (and except the opener for challenges? No: opener may vote). Majority of votes cast decides (`supports` = true means agree with the opener); ties → rejected. Reviews still open at settlement time → `defaulted`.

**Settlement**: weekly per group, Mondays 12:00 in `settlement_tz`, for the week Mon–Sun just ended (plus a 12h review grace is implied by noon). Steps: default open reviews for instances in the week, apply corrections, mark previous `pending`/`marked_paid` obligations `superseded`, compute obligations from current `member_balances` by greedy largest-debtor-to-largest-creditor (ties by user_id), insert `settlements` row (idempotent per group+week). Money still in carry is not owed to anyone yet.

**Settle-up**: payer calls `mark_obligation_paid`; payee calls `confirm_obligation`, which posts a `settlement_payment` entry (payee member −amount, payer member +amount) keyed `payment:<obligation_id>`.

## RPCs (client-callable; SECURITY DEFINER; must verify `auth.uid()` membership)

```
create_group(p_name text, p_settlement_tz text) returns uuid
join_group(p_invite_code text) returns uuid
leave_group(p_group uuid) returns void
create_pact(p_group uuid, p_title text, p_days smallint[], p_window_open time, p_deadline time, p_stake_cents int, p_tz text) returns uuid
join_pact(p_pact uuid, p_lat float8, p_lng float8, p_radius_m int, p_label text) returns void
set_pact_paused(p_pact uuid, p_paused bool) returns void
check_in(p_instance uuid, p_lat float8, p_lng float8, p_accuracy_m float8, p_client_captured_at timestamptz, p_is_simulated bool) returns checkins
declare_freeze(p_instance uuid) returns uuid
open_review(p_instance uuid, p_subject uuid, p_kind review_kind, p_reason text, p_photo_path text) returns uuid
cast_vote(p_review uuid, p_supports bool) returns void
mark_obligation_paid(p_obligation uuid) returns void
confirm_obligation(p_obligation uuid) returns void
register_push_token(p_token text, p_platform text) returns void
```

## Server jobs (service role / pg_cron only; revoke from anon, authenticated)

```
generate_instances(p_days_ahead int default 7, p_now timestamptz default now()) returns int
tick_instances(p_now timestamptz default now()) returns void     -- open due, close due (compute results + post payout)
settle_due_groups(p_now timestamptz default now()) returns int
purge_old_locations(p_now timestamptz default now()) returns int -- null lat/lng older than 30 days
```
All jobs take `p_now` so tests can control time. Re-running any job is a no-op.

Notification outbox rows are inserted by: instance opening (kind `window_open`), 15 min before deadline for participants without a success (`deadline_soon`), result posted (`result`), review opened (`review_opened`), settlement (`settlement`).

## File ownership (parallel agents must stay in their lane)

- `supabase/migrations/20261107000100_foundation.sql` → foundation agent
- `supabase/migrations/20261107000200_instances_checkins_reviews.sql` → instances agent
- `supabase/migrations/20261107000300_payouts_settlement.sql` → payouts agent
- `supabase/migrations/20261107000400_cron.sql` → foundation agent (pg_cron schedule, guarded if extension missing)
- `supabase/tests/` harness → foundation agent; test files `supabase/tests/<area>.test.ts` per agent
- `supabase/functions/push-outbox/` → notifications agent
- `app/` → app agent
- `packages/rules/` → lead (TypeScript reference oracle for payouts)
- `docs/`, `CLAUDE.md`, root files → lead
