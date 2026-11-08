# Implementation plan

Status legend: [x] done, [ ] next. Night-1 is the unattended run of 2026-11-07 (`docs/NIGHT_LOG.md`); everything below "Done" exists on branch `night-1` with green suites.

## Done

### Core (overnight build, 2026-11-07)

- [x] Design, contract, decision log, CLAUDE.md
- [x] `packages/rules`: TypeScript oracle for verdicts, results, reviews, payouts, debt simplification (property tests, `RULES_VERSION` 3)
- [x] Migrations: schema, append-only zero-sum ledger, idempotent `post_entry`, balances views, RLS; instances, check-ins, freezes, results, reviews; payouts, corrections, weekly settlement, obligations; pg_cron schedule (no-op where pg_cron is missing)
- [x] Differential tests: SQL payouts, settlement and review resolution vs `packages/rules` on random cases
- [x] Push-outbox Edge Function (Expo push, leases, retries)
- [x] Expo app: every MVP screen, offline check-in queue, Venmo links, design system (tokens, Dark Mode, Dynamic Type, motion, haptics), demo mode and the screenshot pipeline
- [x] Independent money review, malicious-user attack suite, full-week end-to-end simulation, app-vs-database review; every confirmed finding fixed with a test

### Night-1

- [x] Places are accountable: everyone sees everyone's place and distances; a first place counts at once but can be objected to for 24 h; a moved place counts after a friend confirms (never before 12 h) or 24 h without objection; objections block; feed events and pushes (`20261108000100`)
- [x] Precise Location refused on the client (an Approximate tap counts as Missed, with copy); server unverified budget: the third unverified day in a pact-month is challenged automatically and the group votes (`20261108000200`)
- [x] An unvoted appeal leaves the recorded result standing; `excluded` is reserved (`20261108000300`)
- [x] Red team: 4 proven holes fixed (challenge opener is not a voter; unverified stays on record on voided 2-person days and an accepted challenge revives the day; mark-paid / dispute notify the counterparty; late taps re-run the budget), 35 attacks confirmed safe (`20261108000400`, `docs/REDTEAM.md`)
- [x] Supabase project config, seed, smoke script, `docs/DEPLOY.md` (Windows)
- [x] Local Boarding / Final-call reminders planned from the query cache; cron heartbeat, `job_health`, `check_job_health` ops alerts (`20261108000500`); Sentry behind env flags with location scrubbed; clock-skew notice
- [x] Renamed to Final Call; `delete_my_account` (`20261108000600`); privacy policy and terms in the app and `docs/legal/`; `docs/APP_STORE.md`; Sign in with Apple nonce; expo-updates
- [x] Maestro flows + lint, EAS workflow, CI, `docs/TESTING.md`
- [x] Airport voice at three moments; gate-close money moment read from `instance_member_nets` (`20261108000800`) with reveal spring, count-up and one haptic
- [x] Seasons, streaks, settle-up completion rate (`20261108000700`), Stats screen, season card and sheet, wizard toggle
- [x] Web simulator on GitHub Pages (`web/`, `.github/workflows/pages.yml`)
- [x] Phase 5 verification: all suites green, impeccable audit and animation review on app and simulator with fresh screenshots, final money red team (`redteam-final.test.ts`, `20261108000900_final_fixes.sql`: `pot_cents` follows corrections, the ops user is cleared on account deletion), Stats colour and copy fixes, docs refreshed

## What the founder does next (in order)

1. **Merge.** Review the `night-1` → `main` PR; `main` deploys the simulator to Pages once Settings → Pages → Build and deployment → Source is set to **GitHub Actions** (one click; README "Web simulator").
2. **Supabase.** Create the project, then from the repo root `supabase link` and `supabase db push`; enable `pg_cron` and `pg_net`, set the Vault secrets, deploy `push-outbox`, configure Auth (Apple provider with the bundle id, email templates, `finalcall://auth-callback` redirect), create the private `review-photos` bucket. Every step with the exact commands: `docs/DEPLOY.md` §1–§9. Set yourself as the ops alert recipient (`update public.ops_settings set ops_user_id = '<your auth user id>'`).
3. **Smoke run.** `cd scripts && npm run smoke` against the project (`.env` from `.env.example`): creates a group, a pact, check-ins, a settlement, and checks the ledger invariants; `docs/DEPLOY.md` §10.
4. **Apple.** Join the Apple Developer Program; `npx eas-cli@latest init`, `device:create`, `build --profile development --platform ios`; install on your iPhone; `npx expo start --dev-client`. Sign in with Apple and push need the real device. `app/README.md` "Setup on Windows".
5. **Live with it for a week** with two friends and one pact. Watch `job_health`, the feed and Monday's settle-up; the things only a phone can tell you are listed at the end of `docs/NIGHT_LOG.md`.
6. **TestFlight.** `eas build --profile preview`, then App Store Connect with the answers in `docs/APP_STORE.md` (privacy label, review notes, the reviewer-access choice in P3-9). Run the Maestro flows on EAS (`docs/TESTING.md`) before each submission.

## Concierge test (in parallel with 2–5)

Two weeks, 2–3 friend groups. Measure check-in rate by week, settle-up completion (the Stats screen's first number), disputes, and whether any group goes silent. Decide kill/continue on those numbers, not on feel.

## v1.1 candidates

- iOS `CLLocationSourceInformation.isSimulatedBySoftware` through a small native module (spoof detection, A22)
- Address search in the place picker (today: current location plus a radius)
- A feed event and push for pausing a pact, or a 12-hour lead on pauses (RT-5)
- A per-person unverified budget across pacts if three-pact farming shows up (A27)
- 2-minute tolerance for a fast phone clock on the late offline path; 60-second clamp on cached fixes (REDTEAM "Honest-user hazards")
- Key the offline queue by user id for shared devices
- Null a deleted member's historical place coordinates after 30 days, like check-ins (V-9)
- Sentry Metro config for readable release stack traces (`getSentryExpoConfig`)
- HealthKit run pacts (verify `HKMetadataKeyWasUserEntered`, source bundle whitelist); Android (Health Connect, FCM)
