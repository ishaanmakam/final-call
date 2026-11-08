# Challenge kinds, activity evidence, and the web app

Status: approved direction by Ishaan on 2026-11-08 ("IOU-only, build"). Details below are the lead's calls; each one is also a row in `docs/DECISIONS.md` ("Challenges defaults" table). Reverse any by editing both.

## Goal

Final Call stops being only "be at a place by a time". A group can run several kinds of challenges with the same pledge / forfeit / pool engine, the same ledger, reviews and weekly settle-up. Running is the first new kind (the Renno reference: weekly mileage goals and one-off races, verified runs, standings, a payout moment). Money stays IOU-only (decision F6): no wallet, no entry fees, Venmo links at settlement.

Non-goals for this round: real money, public races with strangers (friends-first: private groups and invite links), live in-app GPS run recording (verification comes from Apple Health and Strava), Android.

## Kinds

| kind | what success means per instance | evidence | period |
|---|---|---|---|
| `show_up` (today) | one in-fence check-in inside the window | GPS tap | daily on `days_of_week` |
| `distance` | accepted activities of the allowed types total ≥ `goal_value` meters | workouts | `weekly` (Mon–Sun) or `once` (race between two dates) |
| `workouts` | ≥ `goal_value` accepted workouts of the allowed types, each ≥ 10 min | workouts | weekly |
| `steps` | daily step total ≥ `goal_value` | daily step sample | daily on `days_of_week` |
| `custom` | the participant marks the day done before the deadline, with optional photo; anyone can challenge | self-report + review | daily or weekly |

Activity types: `running`, `walking`, `cycling`, `swimming`, `hiking`, `rowing`, `strength`, `yoga`, `other`. `distance` allows a subset (default `{running}`; "walk or run" = `{running, walking}`); `workouts` allows any subset.

## Rules (the parts that touch money)

- Instances are still the unit of money. For `weekly`, one instance per ISO week: `local_date` = Monday, `window_open_at` = Monday 00:00 in the pact zone, `deadline_at` = the following Monday 00:00 (end of Sunday). For `once`, one instance from `race_start` 00:00 to `race_end + 1 day` 00:00. Daily kinds keep today's generation.
- Progress is derived, never stored: view `instance_progress(instance_id, user_id, value, goal, activity_count, reached_at)` over accepted activities whose `started_at` lies in `[window_open_at, deadline_at)`. `reached_at` is the `ended_at` of the activity that first crossed the goal (ranking leftover cents and standings, same role as `first_success_at`).
- Result at close for goal kinds: `success` if `value ≥ goal`, else `failed`. There is no `unverified` for goal kinds: the evidence lives on the participant's device and a late sync is covered below. (Logged: a device that could not sync before Sunday night is a connectivity failure, and we treat it like a late offline check-in: evidence with `started_at` before the deadline that arrives within 24 h after it recomputes the result and posts a correction, billed at the next settlement. Evidence arriving later is ignored for money and still shown.)
- `frozen` for weekly pacts: one freeze per calendar month per pact (daily kinds keep one per ISO week).
- Payout, carry, corrections, settlement, obligations: unchanged. Roster rules unchanged (joined before the window opened, not left). The `places` gate applies only to `show_up`.
- Reviews: `challenge` on a `success` works for every kind (evidence: the activity list with source, device, manual flag, distance, duration, pace; no route). `appeal` on a `failed` works for every kind. Unverified budget applies only to `show_up`.
- `custom` kind: `mark_done(p_instance, p_photo_path)` before the deadline → `success`; default `failed`. Every success is challengeable; nothing else moves.

## Activities (evidence)

```
activity_source: 'healthkit' | 'strava' | 'manual'
activity_verdict: 'accepted' | 'rejected_manual' | 'rejected_duplicate' | 'rejected_type' | 'rejected_future'
activities(id uuid pk, user_id, source activity_source, external_id text, activity_type text,
  started_at timestamptz, ended_at timestamptz, distance_m float8 null, duration_s int, steps int null,
  device text null, app_bundle text null, is_manual bool default false, raw_hash text null,
  submitted_at timestamptz default now(), verdict activity_verdict not null, reject_reason text null,
  unique(user_id, source, external_id))
```

- RPC `submit_activities(p_activities jsonb) returns int` (client; `auth.uid()`): each item `{source, external_id, activity_type, started_at, ended_at, distance_m, duration_s, steps, device, app_bundle, is_manual, raw_hash}`. Idempotent per `(user, source, external_id)`; a re-submit with the same hash is a no-op, a different hash updates only `steps`-type rows (daily step totals grow during the day) and otherwise is rejected 23514.
- Service RPC `submit_activities_for(p_user uuid, p_activities jsonb)` for the Strava function.
- Verdicts: `is_manual` (HealthKit `HKWasUserEntered`, Strava `manual`) → `rejected_manual`; `ended_at > now() + 5 min` → `rejected_future`; overlap ≥ 80 % in time with an already accepted activity of the same user from another source → `rejected_duplicate` (first accepted wins); unknown type → `rejected_type`; else `accepted`.
- After accepting activities, recompute results for any closed, unsettled-or-settled instance whose window contains them (same path as a late check-in: correction entry, pushed to the roster).
- Privacy: no routes or coordinates are stored for activities. Group members can read each other's activities that count toward a shared pact (view `pact_activities(pact_id, instance_id, user_id, …)`), not the rest.
- Views for the UI: `instance_progress`, `instance_standings(instance_id, user_id, rank, value, goal, reached_at)` (ties by `reached_at`, then user_id), both security-invoker, members only.

## Schema deltas

```
pact_kind: 'show_up' | 'distance' | 'workouts' | 'steps' | 'custom'
pact_period: 'daily' | 'weekly' | 'once'
pacts + kind pact_kind not null default 'show_up', period pact_period not null default 'daily',
        goal_value numeric null, goal_unit text null check in ('m','count','steps'),
        activity_types text[] null, race_start date null, race_end date null
   checks: show_up ⇒ period daily, goal null; distance/workouts ⇒ goal > 0, types not null;
           steps ⇒ period daily, goal > 0; once ⇒ race_start <= race_end; weekly ⇒ days_of_week null allowed
create_pact gains optional params: p_kind, p_period, p_goal_value, p_goal_unit, p_activity_types, p_race_start, p_race_end
join_pact: place args nullable; required only for show_up
```

New client RPCs: `submit_activities`, `mark_done`. New service RPC: `submit_activities_for`. Views: `instance_progress`, `instance_standings`, `pact_activities`.

## Oracle (`packages/rules`)

- `computeProgress(kind, goal, activityTypes, window, activities)` → `{ value, count, reachedAt }`.
- `goalResult(progress, goal)` → `success | failed`.
- `computeResults` takes a `kind` and uses check-ins for `show_up`, progress for the rest; payouts unchanged.
- Differential tests: random activity sets per instance (sources, manual flags, overlaps, late arrivals) vs SQL.

## App

- Wizard step 0 "What kind of challenge?": Show up / Run / Ride / Walk / Workouts / Steps / Custom (icons, one-line glosses). Kind-specific step: goal with unit (mi/km from the device locale, stored as meters), weekly vs race dates, allowed activity types for workouts; the rest as today. Pledge copy adapts ("Miss 15 mi in a week and your $5 goes to the pool").
- Pact detail for goal kinds: your progress ring ("16.5 / 15.0 mi"), standings list ("1st of 4" with `AvatarStack`, value, pace to goal), "Sync now" (HealthKit) and "Connect Strava" rows, activity list with source/device chips and a "Challenge" affordance on others' entries, season and streaks as today.
- Group home TodayCard generalizes to "This week" cards for weekly pacts (progress instead of the check-in ring), same Boarding / Final call (Sunday 11:45 PM local? no: "Final call" for weekly pacts is Sunday 6:00 PM local, one push) / Gate closed voice; the gate-close card shows the same money moment Sunday night.
- Health sync (`features/health`): `@kingstinct/react-native-healthkit` (v16, Nitro) behind a dev build; permissions requested when joining the first goal pact; sync on foreground, after a run (observer query if cheap), and from the Sync row; batches to `submit_activities`; shows "Synced 3 runs · 12.4 mi this week" and the manual-entry rejections plainly ("A manually entered 5.0 mi run from Apple Health doesn't count"). Web and demo: fake sources.
- Local reminders for weekly pacts: Friday evening "12 mi to go" if behind, Sunday 6 PM "Final call", computed from progress.
- Copy: pledge / forfeit / pool; the three voice words; never bet/stake/pot.

## Strava (`supabase/functions/strava-sync`)

- OAuth: app opens `https://www.strava.com/oauth/authorize?...redirect_uri=<function>/callback&state=<signed user id>`; the function exchanges the code, stores tokens in `integration_tokens(user_id, provider, athlete_id, access_token, refresh_token, expires_at)` (service-only table), subscribes to the Strava webhook once per app, and backfills 30 days.
- Webhook `POST /webhook` → fetch the activity → `submit_activities_for`. `GET /webhook` answers the verify challenge. Token refresh on 401. Rate limits respected (100 / 15 min).
- Manual activities → `rejected_manual`; `trainer` runs allowed; `device_name` → `device`; `external_id` = Strava activity id.
- Settings: "Connect Strava" / "Connected as <athlete>" / Disconnect (deletes tokens; activities stay).
- Secrets: `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_VERIFY_TOKEN`, `STRAVA_STATE_SECRET`. Tests with a fake fetch like push-outbox.

## Web app

- The real app on the web: `npx expo export --platform web` of `app/` with `experiments.baseUrl = '/final-call/app'`, deployed by the Pages workflow next to the simulator: site root = simulator, `/app/` = Final Call. The simulator's header links to it and vice versa.
- Web differences handled in `*.web.tsx` / `Platform` guards: sign-in by email only (Apple needs a Services ID; later); auth callback at `https://ishaanmakam.github.io/final-call/app/auth-callback` (added to Supabase redirect URLs and `supabase/config.toml`); location via the browser geolocation API (expo-location web) with the same Precise rule (browser has none → treat as precise; the fence math is identical); Health sync unavailable ("Runs sync from your iPhone; Strava works here"); Strava connect works; push unavailable (local reminders no-op); Venmo links open venmo.com.
- Supabase session storage on web: localStorage (already the default when `Platform.OS === 'web'`).
- A `web` CI job builds the app for web too.

## Red-team list for this round

Manual workouts relabelled, duplicates across HealthKit and Strava, backdated activities, treadmill runs with no GPS (allowed by rule; challengeable), a 20-second "run" of 15 mi (sanity: max speed per type → `rejected_type`? logged as an accepted risk unless cheap: reject pace faster than world-record × 0.9), step totals edited in Health (`HKWasUserEntered` on step samples → rejected), two people sharing a watch, time-zone games on the Sunday boundary, a race whose `race_end` is edited after it starts (refuse edits once the window opened), leaving a weekly pact mid-week (roster rule holds).

## Delivery lanes

- A (backend + oracle): migration `20261109000100_challenge_kinds.sql`, tests `challenge-kinds.test.ts` + differential, `packages/rules`, CONTRACT.
- B (app): wizard, pact detail standings, health sync, TodayCard generalization, reminders, demo, screenshots.
- C (Strava): the Edge Function, migration `20261109000200_strava.sql`, tests, `features/integrations/strava.ts` client helper.
- D (web app): Expo web export under `/app/`, web fallbacks, Pages workflow, CI job, simulator cross-link.
- E (verification): red-team the list above, audit, docs, PR.
