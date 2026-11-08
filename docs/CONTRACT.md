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
pact_kind:         'show_up' | 'distance' | 'workouts' | 'steps' | 'custom'      -- 20261109000100 (Kinds)
pact_period:       'daily' | 'weekly' | 'once'
activity_source:   'healthkit' | 'strava' | 'manual'
activity_verdict:  'accepted' | 'rejected_manual' | 'rejected_duplicate' | 'rejected_type' | 'rejected_future'
```

## Tables

```
profiles(id uuid pk, display_name text not null, venmo_username text null, deleted_at timestamptz null, created_at)
   -- id = the auth.users id; the FK was dropped in 20261108000600 so the auth row can be deleted while history stays
groups(id uuid pk, name text, invite_code text unique, settlement_tz text not null, created_by uuid, created_at)
group_members(group_id, user_id, role text check in ('owner','member'), joined_at, left_at null, pk(group_id,user_id))
   -- at most 8 current members per group
pacts(id uuid pk, group_id, title, days_of_week smallint[] (ISO 1=Mon..7=Sun), window_open_local time,
      deadline_local time, stake_cents int default 500 check 1..10000, tz text, paused bool default false,
      created_by, created_at,
      season_start date null, season_weeks smallint null check 1..12)   -- window_open_local < deadline_local (same local day);
                                 -- season columns both set or both null (20261108000700; see Seasons and stats)
   -- 20261109000100 (Kinds): kind pact_kind default 'show_up', period pact_period default 'daily', goal_value numeric null,
   --   goal_unit text null check in ('m','count','steps'), activity_types text[] null, race_start date null, race_end date null,
   --   proof_required boolean not null default false (20261109000300; custom only; mark_done then needs a photo);
   --   days_of_week is null for weekly / once pacts (check pacts_days_by_period); per-kind checks pacts_kind_rules, pacts_race_dates,
   --   pacts_activity_types_known; trigger pacts_lock_after_open: kind, period, goal_*, activity_types, race_*, tz cannot change
   --   once an instance has opened (23514)
pact_participants(pact_id, user_id, place_lat float8 null, place_lng float8 null, place_radius_m int null check 25..500,
      place_label text, joined_at, left_at null, pk(pact_id,user_id))   -- place columns null for goal kinds (20261109000100)
pact_instances(id uuid pk, pact_id, local_date date, window_open_at timestamptz, deadline_at timestamptz,
      status instance_status default 'scheduled', carry_in_cents bigint null, closed_at null, unique(pact_id, local_date))
checkins(id uuid pk, instance_id, user_id, client_captured_at timestamptz, server_received_at timestamptz default now(),
      lat float8 null, lng float8 null, accuracy_m float8 null, distance_m float8 null, is_simulated bool default false,
      verdict checkin_verdict not null)   -- lat/lng nulled after 30 days
freezes(id uuid pk, pact_id, user_id, instance_id, declared_at timestamptz default now(), iso_week text,
      unique(pact_id, user_id, iso_week))
results(instance_id, user_id, status result_status, first_success_at timestamptz null, decided_at, pk(instance_id,user_id))
reviews(id uuid pk, instance_id, subject_user_id, opened_by, kind review_kind, reason text, photo_path text null,
      status review_status default 'open', opened_at, resolved_at null,
      system_opened bool default false)   -- true: the unverified-budget challenge (opened_by = subject)
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
activities(id uuid pk, user_id, source activity_source, external_id text (1..200), activity_type text, started_at timestamptz,
      ended_at timestamptz (> started_at), distance_m float8 null (>= 0), duration_s int (>= 0), steps int null (>= 0), device text null,
      app_bundle text null, is_manual bool default false, raw_hash text null, submitted_at timestamptz default now(),
      verdict activity_verdict, reject_reason text null, unique(user_id, source, external_id))   -- 20261109000100; see Activities
custom_completions(instance_id, user_id, marked_at timestamptz default now(), photo_path text null (<= 500), pk(instance_id, user_id))
      -- custom kind: written by mark_done only; select for the instance's group members
```

Also: `billable_member_balances(group_id, user_id, balance_cents)` (what settlement bills), `job_failures` (server-only log; a failing group never blocks other groups' settlement).

Views: `account_balances(account_id, group_id, kind, user_id, pact_id, instance_id, balance_cents)` and `member_balances(group_id, user_id, balance_cents)`; both derived by summing `ledger_lines`. No stored balances anywhere. `unverified_month_counts(pact_id, user_id, month date, count int)`: unverified results per person, pact and calendar month of `local_date` on closed/settled instances (security_invoker; group members see their group's rows). `instance_member_nets(instance_id, group_id, user_id, net_cents, pot_cents)` (night-1, Q1): what one instance did to each member's ledger, summed from `ledger_lines` over that instance's entries (stake, payout, correction); one row per member whose lines sum to a non-zero amount, so a day that moved no money has none; `pot_cents` repeats on every row and is everything paid into that instance's pool as it stands now: every forfeit (the negative member nets) plus the carry the day drew (the carry account's negative net on the instance), so it follows corrections (`20261108000900_final_fixes.sql`, V-1; before that it was the first posting's pot lines and never moved). Security_invoker over the ledger tables' RLS (group members), read-only; the check-in screen and group home read it at gate close instead of computing money on the client. Zero-sum per instance: the member nets plus the carry account's lines for the instance sum to zero.

### Views for challenge kinds (`20261109000100_challenge_kinds.sql`; all `security_invoker`, `select` to `authenticated` and `service_role`, nothing to `anon`)

```
instance_progress(instance_id, user_id, value numeric, goal numeric, activity_count int, reached_at timestamptz)
   -- one row per roster member of every distance / workouts / steps instance (roster = results rows once closed, else
   -- participants with joined_at <= window_open_at and not left before it; no place gate). value = sum of distance_m /
   -- count / sum of steps over ACCEPTED activities with started_at in [window_open_at, deadline_at) whose type matches the
   -- pact (activity_matches_pact: steps pacts take type 'steps', the others their activity_types; workouts need
   -- duration_s >= 600), whenever they were submitted (late evidence is shown even when it no longer moves money).
   -- reached_at = ended_at of the activity that first brought the running total (started_at, id order) to the goal.
instance_standings(instance_id, user_id, rank int, value numeric, goal numeric, reached_at timestamptz)
   -- instance_progress ranked per instance: reached first (by reached_at), then by value desc, then user_id.
pact_activities(pact_id, instance_id, user_id, activity_id, source, activity_type, started_at, ended_at, distance_m, duration_s,
                steps, device, app_bundle, is_manual, verdict, reject_reason)
   -- every activity (accepted or rejected) of a roster member that matches the pact's types and started inside one of its
   -- instance windows; no coordinates, no routes. RLS on activities (policy activities_select): your own rows, plus other
   -- members' rows that match a shared goal pact and fall inside one of its windows; nothing else of theirs.
```

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
- unverified: no success, and there is a check-in that is `unjudgeable`, OR an `in_fence` check-in with `server_received_at > deadline_at` and `client_captured_at <= deadline_at` (a late offline tap). Late `out_of_fence` / `rejected_simulated` check-ins stay failed.
- failed: otherwise (no check-in, or only out_of_fence / rejected_simulated).
- void (instance-level): if fewer than 2 participants are active (success or failed), every `success` / `failed` result becomes `void` and the instance status is `voided` (`closed_at` set). Unverified participants are not active; since RT-2 (`20261108000400`) their result stays `unverified` on the voided day (it counts toward the unverified budget and can be challenged; see Review), and `frozen` stays `frozen`. A late offline tap on such a day is recomputed like on a closed one (no money moves unless the day is revived by an accepted challenge).
- excluded: reserved. No rule sets it since `20261108000300_appeal_default.sql` (N3-1); the enum value stays because history may hold it.
Reviews then override, in resolution order: appeal accepted → success (first_success_at = deadline_at); appeal rejected/defaulted (no votes) → unchanged; challenge accepted → failed; challenge rejected/defaulted → unchanged. A defaulted appeal therefore posts no correction and changes no obligation (`_refresh_result`, oracle `applyReview`, `RULES_VERSION` 2).

**Payout** for a closed, non-void instance (active = success + failed, k = successes, C = carry balance of the pact at close, stored in `carry_in_cents`):
- k = 0: each failed member's stake moves member → pot → carry (entries `stake` then `rollover`). Carry grows.
- k ≥ 1: pot = stake × (n − k) + C. Failed members pay stake into pot (`stake`), carry pays C into pot (`stake`), pot pays winners (`payout`): each gets floor(pot/k); leftover cents go one each to winners ordered by `first_success_at` ascending, then user_id ascending. Pot ends at 0.
- Idempotency keys: `stake:<instance_id>`, `payout:<instance_id>`, `rollover:<instance_id>`.
- Corrections: when a result changes after posting (review or late check-in), recompute the instance's target net per member account using the same rules and the stored `carry_in_cents`, compare with what is posted for that instance, post the difference as one `correction` entry keyed `correction:<instance_id>:<n>` (n increments). Never mutate past entries.

**Roster**: an instance counts participants with `joined_at <= window_open_at` and (`left_at` null or `left_at > window_open_at`) **and, for `show_up` pacts, a place in force at `window_open_at`** (`_place_at` not null; see Places; goal kinds have no place gate, `20261109000100`); once closed, the roster is fixed as the users with a result row. A participant whose only place was objected to has no place in force: they get no result row and no ledger line for that instance (and if that leaves fewer than 2 active, the instance is void). `leave_group` is refused (23514) while you're on the roster of a **show_up** instance in its window (`20261109000400`, RK-9; it was every daily pact, which locked members of a 00:00–23:59 steps pact into the group); goal and custom kinds are open for hours or days, so leaving is allowed and keeps you on the open instance's roster (`left_at > window_open_at`): you are scored at close (CA-7). Rejoining a goal pact while you are still on such a roster (left after it opened, not closed yet) keeps your `joined_at`, so the instance still scores you (RK-1); any other rejoin counts from now (next roster).

**Kinds** (`20261109000100_challenge_kinds.sql`; spec `docs/superpowers/specs/2026-11-08-challenge-kinds-design.md`). `pacts.kind` picks what success means; `pacts.period` how instances are cut. Everything below the result (void rule, payout, carry, corrections, reviews, settlement, obligations) is unchanged.

| kind | period | success at close | evidence |
|---|---|---|---|
| `show_up` | daily | one in-fence check-in in the window (rules above) | GPS tap |
| `distance` | weekly or once | accepted activities of `activity_types` started in the window total `>= goal_value` metres (`goal_unit = 'm'`) | activities |
| `workouts` | weekly | `>= goal_value` accepted activities of `activity_types`, each `duration_s >= 600` (`goal_unit = 'count'`) | activities |
| `steps` | daily | accepted `steps` samples started in the day total `>= goal_value` (`goal_unit = 'steps'`) | activities of type `steps` |
| `custom` | daily or weekly | a `custom_completions` row with `marked_at <= deadline_at` (`mark_done`) | self-report |

- Instances: `daily` as before (`days_of_week`, `window_open_local`, `deadline_local`). `weekly`: one instance per ISO week, `local_date` = the Monday, `window_open_at` = Monday 00:00 and `deadline_at` = the following Monday 00:00 in the pact zone (`_local_to_utc` at both ends, so a DST week is 167 or 169 h); generated for every Monday within the 7-day horizon whose open is still ahead (the current week while it has not started, and the next one). `once`: one instance, `local_date` = `race_start`, window `race_start` 00:00 → `race_end + 1 day` 00:00; a race whose start is already past is never generated (CA-12). Weekly / once pacts store `days_of_week` null and nominal `window_open_local` 00:00 / `deadline_local` 23:59 (CA-3). The body under the `generate_instances` heartbeat wrapper (`_generate_instances_v1`) was replaced in place with the per-period version (CA-1).
- Result for `distance` / `workouts` / `steps`: `success` with `first_success_at` = `reached_at` when the progress at the deadline is `>= goal_value`, else `failed`. **Never `unverified`** (C0-2). Only activities with `submitted_at <= deadline_at + 24 h` count for the result (`_goal_progress(instance, user, cutoff)`); `_base_result` dispatches on kind (the show_up body is `_base_result_v1`), so `_close_instance`, `_computed_result`, `_refresh_result` and `_reclose_instance` are unchanged. `frozen` applies to every kind; the void rule is unchanged.
- Late evidence: after `submit_activities` writes an accepted activity whose `started_at` lies in the window of an already closed (closed, settled or voided-at-close) instance of a goal pact the user is on, and `now() <= deadline_at + 24 h`, that user's result is recomputed (`_refresh_result`) and `apply_instance_correction` posts the difference, pushed as a `result` correction, exactly like a late offline check-in. Later evidence is stored and shown (`pact_activities`, `instance_progress`) but moves no money.
- `custom`: `mark_done` before the deadline → `success` at `marked_at`; nothing marked → `failed`. Every success is challengeable; appeals work on every kind.
- Freeze: `declared_at < window_open_at` as before; weekly and once pacts allow **one per calendar month** per pact (`freezes.iso_week` holds `YYYY-MM` of the instance's `local_date`; daily pacts keep `IYYY-"W"IW`).
- Settlement boundary: a week's instance ends exactly at the settlement week's end (Monday 00:00), so `_settle_group_week` settles instances with `deadline_at <= week_end`, and `default_open_reviews(group, p_until)` (same signature) also resolves reviews on weekly / once instances with `deadline_at = p_until`; daily instances never end exactly at midnight, so nothing changes for them (CA-8).
- Pushes: weekly / once instances open **without** a `window_open` push (CA-5); their one `deadline_soon` ("Final call") goes out at 18:00 local on the day before the deadline (Sunday 18:00 for a week, `race_end` 18:00 for a race; `minutes_left` 360) to roster members who are not frozen and have not reached the goal (custom: have not marked done). `result` pushes are unchanged. `_instance_payload` now also carries `kind`, `period`, `goal_value`, `goal_unit`. `tick_instances` is wrapped once more: the previous public body is `_tick_instances_v3`; `_tick_periodic(p_now)` runs first in its own subtransaction.

**Activities** (`20261109000100`). `submit_activities(p_activities jsonb) returns int` (client, `auth.uid()`) and `submit_activities_for(p_user uuid, p_activities jsonb) returns int` (service role; the Strava function) both call the core `submit_activities_at(p_user, p_activities, p_now)` (service-only, tests). `p_activities` is a JSON array of at most 1000 items (RK-8) `{source, external_id, activity_type, started_at, ended_at, distance_m, duration_s, steps, device, app_bundle, is_manual, raw_hash}`; `duration_s` null = elapsed seconds, and a `duration_s` above elapsed + 60 s is stored as elapsed (moving time never exceeds the activity; RK-6). Validation (22023, the whole batch is refused): source in the enum, `external_id` 1..200, `activity_type` present, instants parse and `ended_at > started_at`, `distance_m` 0..1e7, `duration_s >= 0`, `steps >= 0`, a `steps` sample needs `steps`. The client RPC also refuses any item with `source = 'strava'` (22023): that source only ever arrives through `submit_activities_for` from the Strava function (RK-7). Known types: running, walking, cycling, swimming, hiking, rowing, strength, yoga, other (`known_activity_types()`), plus `steps` for a daily step sample (CA-2). Verdict (`_activity_verdict`, `20261109000400`), in this order: unknown type → `rejected_type` 'unknown activity type'; `is_manual` **or `source = 'manual'`** → `rejected_manual` (RK-7); `ended_at > now() + 5 min` → `rejected_future`; `distance_m / greatest(duration_s, 1)` above 12 m/s (running, walking, hiking, swimming, rowing) or 25 m/s (cycling) → `rejected_type` 'implausible pace' (CA-4); time overlap `>= 80 %` of the shorter activity with an already **accepted** activity of the same user from **any** source, the same one included (steps samples excluded) → `rejected_duplicate` 'duplicate of <source> <external_id>', first accepted wins (CA-6, RK-5: a watch and a phone both writing HealthKit, or an edit that mints a new UUID, count once); else `accepted`. Idempotency per `(user, source, external_id)`: same `raw_hash` (nulls equal) → no-op, except that a `rejected_future` row whose end has passed is re-judged with the whole chain above (CA-10, RK-2); a different hash updates a `steps` row (steps, ended_at, duration_s, hash, verdict; a daily total grows) when its `started_at` is unchanged (a re-send that moves the day is a no-op, RK-3) and its `ended_at` is later than the stored one (or equal with more steps; an older snapshot is a no-op), and only until 24 h after the deadline of the earliest steps instance the user is on whose window holds it (after that the day's total is final for everyone, a no-op: RK-4); a changed hash is `23514` for anything else. Returns the number of rows inserted or updated (CA-13). Clients never write `activities` directly (select only, RLS above).

`mark_done(p_instance uuid, p_photo_path text default null) returns void` (client; core `mark_done_at(p_user, p_instance, p_photo_path, p_now)`): custom pacts only (23514), roster members only (42501), while `window_open_at <= now() <= deadline_at` and the instance is not closed (23514 'the deadline has passed'); `photo_path <= 500` (22023); a repeat keeps the first `marked_at` and may add the photo. `pacts.proof_required` (20261109000300; `create_pact(..., p_proof_required boolean default false)`, custom kind only, 22023 otherwise, locked once a window has opened): when true, a mark without a photo is refused with 23514 'This challenge needs a photo' unless the caller's earlier mark already carries one.

`create_pact` (full signature in the RPC list): the 7-argument call is unchanged (`show_up`, daily). `p_kind` / `p_period` must agree with the Kinds table (22023); `p_goal_value` required `> 0` for distance / workouts / steps (whole number for workouts and steps), `p_goal_unit` defaults to the kind's unit and must match it; `p_activity_types` defaults to `{running}` for distance and to all nine types for workouts (CA-14), must be known and non-empty, and must be null for other kinds; `p_race_start` / `p_race_end` required for `once` (`start <= end`, start not in the past in the pact zone), null otherwise; `p_days` is used for daily pacts only (ignored for weekly / once); steps pacts always open at 00:00 and default the deadline to 23:59 (CA-3). `join_pact`: place arguments are required for `show_up` only (22023 when missing); for goal kinds they are ignored, no `pact_participant_places` row is written and the open-window refusal does not apply (the roster rule keeps a mid-week joiner off the open week; CA-9); a rejoin while still on the roster of an instance that has opened and not closed keeps `joined_at` (RK-1).

**Places** (`20261108000100_place_accountability.sql`): `pact_participant_places(id uuid unique, pact_id, user_id, lat, lng, radius_m, label, effective_from, created_at, requires_ack bool, acknowledged_at, acknowledged_by, objected_at, objected_by, objection_reason text ≤280, effective_event_at)` is the place history, written only by `join_pact`, `acknowledge_place`, `object_place` and the tick.
- A **first place** (joining the pact) is in force at once (`requires_ack = false`, `effective_from = now()`).
- A **changed place** (any later `join_pact` with different lat/lng/radius, a rejoin included) is **gated** when any other current member is in the group: `requires_ack = true`, `effective_from = created_at + 24 h`. `acknowledge_place` by another current member moves `effective_from` to `greatest(now(), created_at + 12 h)`. With nobody else in the group a change is not gated and `effective_from = created_at + 12 h` (D11). A new request deletes a change that has not started to count (objected rows stay).
- **Objection**: `object_place` by another current member, reason required, allowed until `created_at + 24 h` unless the place was confirmed or already replaced by a newer place in force. An objected row never counts for a window opening at or after `objected_at` (a first place objected to stops counting from the objection; windows that opened before still used it).
- A check-in for a window opening at `t` is judged against `_place_at(pact, user, t)`: the latest row with `effective_from <= t` and (`objected_at` null or `> t`); failing that, the earliest row with `requires_ack = false` and no objection; failing that (no history at all), `pact_participants`. Null = no place in force (see Roster).
- `join_pact` is still refused once any instance's window has opened and it isn't closed; `pact_participants.place_*` still hold the requested place.
- Read models: view `pact_places_visible(place_id, pact_id, group_id, user_id, user_name, lat, lng, radius_m, label, created_at, effective_from, requires_ack, acknowledged_at, acknowledged_by, acknowledged_by_name, objected_at, objected_by, objected_by_name, objection_reason, is_current, state in ('effective','pending','objected','superseded'), acknowledgeable, objectable)` (security invoker; current participants of pacts in the caller's groups) and RPC `pact_place_distances(p_pact)` → `(pact_id, place_id, user_id, label, state, other_user_id, other_place_id, other_label, distance_m)`: metres from each place in force or pending to every other participant's place in force.

**Place events**: `place_events(id bigserial, group_id, pact_id, place_id null (set null when a pending place is replaced), user_id (owner), actor_id, kind in ('created','acknowledged','objected','effective'), label, lat, lng, radius_m, prev_label, prev_lat, prev_lng, prev_radius_m, distance_from_prev_m, reason, created_at)`; select for current group members, no client writes. One row per place creation, confirmation, objection, and per gated change that starts to count by timeout (posted once by `tick_instances`, which calls `_place_timeouts(p_now)` first in its own subtransaction; the previous body is `_tick_instances_v1`). Each event also queues `notification_outbox` kind `place_changed` with payload `{event, place_id, pact_id, group_id, pact_title, user_id, user_name, actor_id, actor_name, label, radius_m, prev_label?, distance_from_prev_m?, requires_ack, effective_from, reason?, url}`: `created` goes to every other current member, the others to the place's owner.

**Check-in limits**: at most 20 per user per instance (retries with the same `p_client_attempt_id` don't count). Client time is only validated on the late path. Late check-ins are accepted until `deadline_at + 24h`, even on settled instances; they post a correction billed at the next settlement.

**Freeze**: `declared_at < window_open_at`; one per (pact, user, ISO week of the instance's local_date) for daily pacts; one per (pact, user, calendar month of local_date) for weekly / once pacts (see Kinds).

**Review**: subject appeals their own `failed`; any other roster member challenges `success` or `unverified`. At most one appeal and one challenge per (instance, subject), ever. Voters = the instance roster except the subject, limited to current group members, **and except the opener of a challenge** (RT-1, `20261108000400`: they profit from acceptance; in a 2-person pact a human challenge therefore has no voters and defaults, while the automatic unverified-budget challenge, opened in the subject's name, is decided by the other member). Former members may appeal their own result but not challenge. A settled instance accepts only a challenge of a result that a late tap changed after settlement (`results.decided_at > pact_instances.settled_at`). A day **voided at close** (`status = 'voided'`, `closed_at` set) accepts only a challenge of an `unverified` result (RT-2); accepting it recomputes every result on the day and, if that leaves 2 or more active, revives the day: `status = 'closed'` (same `closed_at`), payout posted with `carry_in_cents = 0` (a revived day never draws carry deposited after it), `result` pushes queued. Majority of votes cast decides (`supports` = true means agree with the opener); ties → rejected. Reviews still open at settlement time → `defaulted`, which leaves the result standing for both kinds (an unvoted appeal keeps the `failed`; it is not `excluded`). When any review of a result resolves, the unverified budget is re-checked for that result (RT-4).

**Unverified budget** (`20261108000200`): when a participant's result is set to `unverified` (at close, or by a recompute such as a late offline tap) and that makes more than 2 `unverified` results for them in the same pact in the same calendar month (the instances' `local_date`, i.e. the pact's zone), the system opens a `challenge` on that result: `reviews.system_opened = true`, `opened_by` = the subject, `reason` 'Automatic: more than 2 unverified days this month'. Voters, votes, defaults and the correction on acceptance are those of any challenge (nobody voting leaves the result standing). Never more than one per (instance, subject) however often results are recomputed; never while another review of that result is open; a human challenge, open or resolved, suppresses it; never on a day cancelled by a pause (no results), but days voided at close count and are challenged like closed ones (RT-2). Fired by triggers (`results_unverified_budget` after update of `results`, `instances_unverified_budget` when `pact_instances.status` becomes `closed`, `instances_unverified_budget_void` when it becomes `voided` with `closed_at` set) and re-run by `_resolve_review` once a review of the result resolves (RT-4: an open appeal no longer hides a late tap's third unverified day for good), so overriding `_close_instance` / `_refresh_result` does not disable it. Posts `review_opened` to the whole roster (payload adds `system_opened: true`, `unverified_this_month`; no `opener_name`).

**Settlement**: weekly per group, Mondays 12:00 in `settlement_tz`, for the week Mon–Sun just ended (plus a 12h review grace is implied by noon). Steps: default open reviews for instances in the week, apply corrections, mark previous `pending` obligations `superseded` (`marked_paid` ones survive and count as provisionally paid), compute obligations from `billable_member_balances` (lines of settled instances plus settlement payments only) by greedy largest-debtor-to-largest-creditor (ties by user_id), insert `settlements` row (idempotent per group+week). Money still in carry is not owed to anyone yet.

**Settle-up**: payer calls `mark_obligation_paid`; payee calls `confirm_obligation`, or `dispute_obligation` to send a `marked_paid` one back to `pending`. `confirm_obligation` posts a `settlement_payment` entry (payee member −amount, payer member +amount) keyed `payment:<obligation_id>`. `mark_obligation_paid` queues `notification_outbox` kind `obligation_marked_paid` for the payee and `dispute_obligation` queues `obligation_disputed` for the payer (RT-3; payload `{obligation_id, settlement_id, group_id, group_name, from_user, from_name, to_user, to_name, amount_cents, url: /groups/<group_id>/ledger}`); repeat calls that change nothing queue nothing.

## RPCs (client-callable; SECURITY DEFINER; must verify `auth.uid()` membership)

```
create_group(p_name text, p_settlement_tz text) returns uuid
join_group(p_invite_code text) returns uuid
leave_group(p_group uuid) returns void
create_pact(p_group uuid, p_title text, p_days smallint[], p_window_open time, p_deadline time, p_stake_cents int, p_tz text,
            p_kind pact_kind default 'show_up', p_period pact_period default 'daily', p_goal_value numeric default null,
            p_goal_unit text default null, p_activity_types text[] default null, p_race_start date default null,
            p_race_end date default null, p_proof_required boolean default false) returns uuid
                                                       -- 20261109000100 (+ p_proof_required 20261109000300); the 7-argument call is a daily show_up pact
join_pact(p_pact uuid, p_lat float8 default null, p_lng float8 default null, p_radius_m int default null, p_label text default null) returns void
                                                       -- place required for show_up only (see Kinds)
submit_activities(p_activities jsonb) returns int      -- see Activities; rows inserted or updated
mark_done(p_instance uuid, p_photo_path text default null) returns void   -- custom kind; see Kinds
set_pact_paused(p_pact uuid, p_paused bool) returns void
check_in(p_instance uuid, p_lat float8, p_lng float8, p_accuracy_m float8, p_client_captured_at timestamptz, p_is_simulated bool) returns checkins
declare_freeze(p_instance uuid) returns uuid
open_review(p_instance uuid, p_subject uuid, p_kind review_kind, p_reason text, p_photo_path text) returns uuid
cast_vote(p_review uuid, p_supports bool) returns void
mark_obligation_paid(p_obligation uuid) returns void
confirm_obligation(p_obligation uuid) returns void
register_push_token(p_token text, p_platform text) returns void
dispute_obligation(p_obligation uuid) returns void
acknowledge_place(p_place uuid) returns void          -- another current member; not the owner (42501); pending gated places only (23514)
object_place(p_place uuid, p_reason text) returns void -- another current member; reason required (22023); within 24 h, not confirmed (23514)
pact_place_distances(p_pact uuid) returns table(...)   -- members of the pact's group (42501); see Places
delete_my_account() returns void                       -- the caller only; see Account deletion
set_pact_season(p_pact uuid, p_start date, p_weeks smallint) returns void
                                                       -- owner or pact creator (42501); (null, null) clears; half a season 22023; weeks 1..12 (23514)
disconnect_integration(p_provider text) returns void   -- deletes the caller's integration_tokens row ('strava' only, 22023 otherwise); idempotent; activities stay.
                                                       -- Strava storage (20261109000200): integration_tokens(user_id, provider, athlete_id, access_token, refresh_token, expires_at, scope, connected_at; pk(user_id, provider); service only,
                                                       -- clients may read only (provider, athlete_id, connected_at) of their own rows through view my_integrations), strava_webhook_events(id, event, received_at, processed_at, error, attempts; service only)
```

### Seasons and stats (`20261108000700_seasons.sql`, night-1 Q2)

Read models only: nothing here moves money or changes a result. A **season** is an optional window on a pact, `pacts.season_start` (a local date in the pact's zone) and `pacts.season_weeks` (1..12), set or cleared together by `set_pact_season` (same permission as `set_pact_paused`: group owner or pact creator). The window is the local dates `[season_start, season_start + 7 × weeks)`; its last day is `season_end`. Nothing about scheduling, results or payouts changes while a season runs.

Views (all `security_invoker`, so RLS on pacts / instances / results / ledger / groups / obligations limits them to the caller's groups; `select` to `authenticated` and `service_role`, nothing to `anon`):

```
pact_season_recaps(pact_id, user_id, season_start, season_end, days, showed_up, missed, unverified, frozen, net_cents)
   -- one row per (pact with a season, member with a result row) over closed/settled instances with local_date in the window;
   -- days = success + failed + unverified + frozen; net_cents = that member's ledger lines on those instances (stake, payout,
   -- correction), so across members plus the carry account's lines on the same instances the sum is 0. No row until a day closes.
pact_streaks(pact_id, user_id, current_streak, best_streak)
   -- consecutive `success` results over the person's closed/settled instances in local_date order: frozen (and the historical
   -- excluded) is neutral (neither breaks nor extends), failed / unverified break; voided instances are not counted at all.
   -- current_streak = successes since the last break (0 when the last counted day was a break). No row until a counted day exists.
group_settlement_stats(group_id, obligations_created, obligations_confirmed, completion_rate numeric(.,4) null, weeks_settled, last_settled_week date null)
   -- one row per visible group; created = obligations whose status <> 'superseded', confirmed = status 'confirmed',
   -- completion_rate = confirmed / created (null when created = 0): obligations confirmed on Venmo out of those created,
   -- the group's north-star metric; weeks_settled / last_settled_week from `settlements`.
```

### Account deletion (`20261108000600_account_deletion.sql`)

`delete_my_account()` (SECURITY DEFINER, no arguments: it only ever acts on `auth.uid()`), in one transaction:

1. calls `leave_group` for every current membership (oldest first). The leave rules apply unchanged: on the roster of an instance whose window is open or due, the whole call is refused with `23514` and the message "You're in an open check-in window; try again after the deadline." (nothing changes);
2. `profiles`: `display_name = 'Deleted member'`, `venmo_username = null`, `deleted_at = now()`. The `profiles_update_own` policy now also requires `deleted_at is null`, so a stale JWT cannot edit it back;
3. deletes `push_tokens`, unsent `notification_outbox` rows, pending `pact_participant_places` (`effective_from > now()`, an objected one included) and `review_votes` on reviews still `open`; nulls `checkins.lat/lng` (verdict, distance and accuracy stay); clears `ops_settings.ops_user_id` when it named this account (V-2);
4. keeps `results`, `ledger_entries`/`ledger_lines`, `obligations`, `reviews` (including ones they opened), votes on resolved reviews and historical places. Balances are still derived; the counterparty still sees the obligation, with the name "Deleted member" (`shares_group_with` matches former co-members);
5. inserts one `account_audit(user_id, kind = 'account_deleted', groups_left, created_at)` row (service-only table);
6. deletes the `auth.users` row (identities, sessions and refresh tokens cascade inside the auth schema). `profiles.id` no longer references `auth.users`.

A second call for an already-deleted profile returns without error. The client (Settings → Delete account) confirms, calls the RPC, signs out and returns to the sign-in screen.

## Server jobs (service role / pg_cron only; revoke from anon, authenticated)

```
generate_instances(p_days_ahead int default 7, p_now timestamptz default now()) returns int   -- daily, weekly and once (see Kinds)
tick_instances(p_now timestamptz default now()) returns void     -- open due, close due (compute results + post payout)
submit_activities_for(p_user uuid, p_activities jsonb) returns int   -- the Strava function; same rules as submit_activities (Activities)
default_open_reviews(p_group uuid, p_until timestamptz) returns int   -- unchanged signature; since 20261109000100 also instances of
                                                                 -- weekly / once pacts with deadline_at = p_until (see Kinds, CA-8)
settle_due_groups(p_now timestamptz default now()) returns int
purge_old_locations(p_now timestamptz default now()) returns int -- null lat/lng older than 30 days
upsert_integration_token(p_user uuid, p_provider text, p_athlete_id text, p_access_token text, p_refresh_token text, p_expires_at timestamptz, p_scope text default null) returns void
                                                                 -- strava-sync Edge Function only; replaces tokens, keeps connected_at; an athlete re-connecting from another account moves (old row deleted)
```
All jobs take `p_now` so tests can control time. Re-running any job is a no-op. `tick_instances` and `settle_due_groups` process each instance/group in its own subtransaction; failures go to `job_failures` and are retried next run. Global lock order (deadlock avoidance) is documented at the top of `20261107000300_payouts_settlement.sql`.

### Heartbeat and ops alerts (`20261108000500_heartbeat.sql`)

Every job above (plus `purge_old_outbox` from `20261107000600`) is wrapped: the previous body is renamed (`_tick_instances_v2`, `_generate_instances_v1`, `_settle_due_groups_v1`, `_purge_old_locations_v1`, `_purge_old_outbox_v1`) and the public name keeps its exact signature, return value and grants. The wrapper runs the body, and on an error that escaped the body's own subtransactions writes a `job_failures` row (`job` = the public name, `group_id` null) and returns (`void` / `0`) instead of raising, so the heartbeat below is never rolled back with the run.

```
job_heartbeats(job text pk, last_started_at, last_finished_at, last_ok_at timestamptz, last_error text, runs bigint)
_heartbeat(p_job text, p_ok boolean, p_error text) returns void              -- upsert; called at the end of every run
record_push_heartbeat(p_ok boolean, p_error text default null) returns void  -- the push-outbox Edge Function's beat (job 'push_outbox')
_job_health_at(p_now timestamptz default now()) returns table (job, expected_every interval, last_ok_at, last_error, runs, overdue boolean, never_ran boolean, recent_failures int)
job_health                                                                   -- view: _job_health_at(now())
ops_settings(one boolean pk, ops_user_id uuid null references profiles)      -- exactly one row; who gets alerts (null = nobody)
check_job_health(p_now timestamptz default now()) returns int                -- alerts inserted; cron every 10 min ('check-job-health')
```

Expected cadences: `tick_instances` 1 min, `generate_instances` 15 min, `settle_due_groups` 60 min, `purge_old_locations` and `purge_old_outbox` 1 day, `push_outbox` 1 min. `overdue` = the job has run at least once and has no success inside 3x its cadence (a job that has only ever failed is overdue at once); a job with no heartbeat row yet is `never_ran` and not overdue (a fresh deploy must not alert for the daily purges before 03:23 UTC). `recent_failures` = `job_failures` rows of the last hour for that job (`place_timeouts` counts towards `tick_instances`).

`check_job_health(p_now)`: when `ops_settings.ops_user_id` is set, for every job that is `overdue` or has `recent_failures >= 5`, insert one `notification_outbox` row of kind `ops_alert` for that user, at most one per job per hour (keyed on `payload->>'job'` and `created_at`). Payload: `job`, `reason` ("overdue: last ok ... (expected every ...)" and/or "N failures in the last hour"), `message` ("Final Call job <job> needs a look: <reason>"), `overdue`, `last_ok_at`, `last_error`, `recent_failures`, `url` (`/settings`). Setting the ops user: `update public.ops_settings set ops_user_id = '<auth user id>'` (service role / SQL editor; the row is service-only).

Everything in this section is service-role only (RLS on, nothing granted to `anon`/`authenticated`, functions revoked from `public`).

Notification outbox rows are inserted by: instance opening (kind `window_open`; daily pacts only, weekly / once open silently), 15 min before deadline for participants without a success (`deadline_soon`; for weekly / once instances at 18:00 local the day before the deadline, to those short of the goal; see Kinds), result posted or a voided day revived (`result`), review opened (`review_opened`), settlement (`settlement`), place set / confirmed / objected / counting by timeout (`place_changed`, see Place events), an obligation marked paid (`obligation_marked_paid`, to the payee) or disputed (`obligation_disputed`, to the payer).

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
