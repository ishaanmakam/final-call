# Night log (night-1)

Resume file for the unattended run started 2026-11-07 evening. If context is lost: read this, `CLAUDE.md`, `docs/CONTRACT.md`, `docs/DECISIONS.md`, then continue from "Next".

Repo: https://github.com/ishaanmakam/final-call · branch `night-1` (from `ui-overhaul`, which is from `main`).
Verification per phase: `cd supabase/tests && npx tsc -p tsconfig.json && npx vitest run` (~2.5 min), `cd packages/rules && npx vitest run && npx tsc --noEmit`, `cd supabase/functions/push-outbox && npx vitest run && npx tsc --noEmit`, `cd app && npx tsc --noEmit && npx vitest run`, later `cd web && npm test && npx tsc --noEmit`.

## Step 0 — done
- Remote `origin` added; `master` renamed `main` and pushed; `ui-overhaul` pushed; `night-1` created from `ui-overhaul` and pushed. `gh` 2.102 is installed.
- Baseline test status at branch point: db 220, rules 33, push-outbox 49, app 417, all green.

## Phase 1 — devil's advocate (agents done, integrating)
Landed (uncommitted until integration is green):
- N1 places: `20261108000100_place_accountability.sql` (place gate: first place immediate but objectable 24 h; changes count after another member confirms, never before 12 h, or after 24 h without objection; objection blocks; objected/no-place participants are off later rosters), `place_events`, view `pact_places_visible`, RPCs `acknowledge_place`, `object_place`, `pact_place_distances`; app pact detail / place picker / feed show and act on places. 17 tests.
- N2 precise location: client refuses Approximate Location with explicit "would count as Missed" copy (`features/checkin/precision.ts`); server Unverified budget: 3rd unverified in a pact-month auto-opens a `system_opened` challenge (`20261108000200_unverified_budget.sql`, view `unverified_month_counts`). 10 tests.
- N3 appeal default: unvoted appeal leaves the original result standing (`20261108000300_appeal_default.sql` replaces `_refresh_result`); oracle `applyReviews` in packages/rules; differential-results has a 160-scenario review test; e2e week recomputed. `excluded` is now a reserved status.
- Integrator applying cross-lane patches (test allowlists for the new RPCs, e2e outbox kinds, push copy for `place_changed` and automatic reviews, types/view for the budget, removal of the vestigial Excluded counter).

### Phase 1 original plan
Plan: three parallel agents, each test-first, each with its own migration file:
1. Places accountability → `supabase/migrations/20261108000100_place_accountability.sql`, `supabase/tests/places.test.ts`, app pact detail / place picker / feed / queries.
2. Precise Location refusal + Unverified budget → `20261108000200_unverified_budget.sql`, `supabase/tests/unverified-budget.test.ts`, `app/src/lib/location.ts`, check-in screen.
3. Appeal default → `20261108000300_appeal_default.sql`, `packages/rules`, differential + e2e tests, CONTRACT.
Then a fresh red-team agent, fixes test-first.

## Phase 1a — committed and pushed (4272671)
Suites: db 251, rules 41, push-outbox 55, app 446; 138 screenshots.

## Phase 1b + Phase 2 — committed and pushed
- Red-team (`docs/REDTEAM.md`): 4 proven holes fixed in `20261108000400_redteam_fixes.sql` (challenge opener is not a voter; unverified days can no longer hide behind a voided 2-person day; mark-paid/dispute notify the counterparty; late taps re-run the budget check); 35 attacks confirmed safe; accepted risks RT-5/RT-6. Oracle RULES_VERSION 3.
- P1: `supabase/config.toml` rewritten, `supabase/seed.sql` + `seed.test.ts`, `scripts/smoke.ts` (skips without .env), `docs/DEPLOY.md` (Windows), root `.env.example`.
- P2: local Boarding / Final-call notifications planned from the query cache (`lib/localNotifications.ts`), cron heartbeat + `job_health` + `check_job_health` ops alerts (`20261108000500_heartbeat.sql`), Sentry behind env flags (app + Edge Function, location scrubbed), server-vs-device clock notice on check-in.
- P3: renamed to Final Call (`com.ishaanmakam.finalcall`, `finalcall://`), `delete_my_account` (`20261108000600_account_deletion.sql`, profile anonymized, ledger kept), privacy + terms screens and `docs/legal/*.md`, `docs/APP_STORE.md`, Sign in with Apple nonce, expo-updates, cross-lane patches.
- P4: `.maestro/` flows + lint, `app/.eas/workflows/maestro.yml`, CI extended, `docs/TESTING.md`.
Suites: db 21 files green, rules 42, push-outbox 57, app 496, scripts tsc, maestro lint ok; 146 screenshots.

## Phase 3 — committed and pushed
- Q1 voice: Boarding / Final call / Gate closed in push, local reminders, the check-in clock and TodayCard; `app/DESIGN.md` Voice section. Gate-close card shows result + money from the new `instance_member_nets` view (`20261108000800_instance_nets.sql`), 10 s polling up to 3 min, reveal spring + count-up, one haptic.
- Q2 retention: `20261108000700_seasons.sql` (pacts.season_start/season_weeks, `set_pact_season`, views `pact_season_recaps`, `pact_streaks`, `group_settlement_stats`), Stats screen (settle-up completion = confirmed / created obligations), season card + sheet on pact detail, wizard season toggle, streak lines.
Suites: db 23 files / 314, rules 42, push-outbox 57, app 533; 166 screenshots.
Polish notes for phase 5: Stats recap shows negative nets in red (decision UB2 says neutral; red only for Missed); the completion card repeats "81%" twice.

## Phase 4 — committed and pushed
- `web/`: Vite + React + motion simulator importing the real `packages/rules` oracle (alias to source); pure engine `web/src/sim` with scenarios and conservation invariants (36 tests); iPhone-frame screens (home, check-in, gate-closed reveal, feed, settle up) + control panel (fence playground, online/offline, precise/approximate/denied, friend behaviours, fast-forward, presets, live ledger); `.github/workflows/pages.yml` deploys to https://ishaanmakam.github.io/final-call/ on push to main (manual step: Settings → Pages → Source: GitHub Actions); 10 screenshots in `web/screenshots/`.

## Next
Phase 5 fresh verification agent: all suites incl. web, impeccable audit + review-animations on app and simulator with fresh screenshots, final money red-team, README/PLAN/DECISIONS updates; then push, open PR night-1 → main, finish this log.

## Phase 5 — verification and polish (fresh agent, uncommitted until the lead commits)
- All six checks green before and after: db 24 files / 327 (was 23 / 314), rules 42, push-outbox 57, app 533, web 36 + build, scripts tsc, maestro lint.
- Final money red team: `supabase/tests/redteam-final.test.ts` (13 tests), `20261108000900_final_fixes.sql` (V-1 `instance_member_nets.pot_cents` follows corrections; V-2 account deletion clears the ops alert recipient), table in `docs/REDTEAM.md` "Final pass (night-1)". No money hole found.
- Audit fixes: Stats negative nets neutral and "behind / ahead" wording (V-4), completion card no longer repeats the percentage (V-3), Stats in the group More menu (V-5), segmented pill 180 ms app + web (V-6), simulator negative balances neutral (V-7). 166 app screenshots and 10 simulator screenshots regenerated.
- Docs: README (product summary, all suites, links, simulator URL), PLAN (done / founder next / v1.1), DECISIONS V-1..V-9 (Night-1 table made well-formed), CONTRACT (pot_cents, deletion step 3).

### Only a real iPhone or the founder's accounts can verify
- Sign in with Apple (nonce round trip), push delivery and the notification tap routes, local Boarding / Final-call reminders, `expo-updates` OTA.
- Location: the When-In-Use prompt, Precise vs Approximate refusal, GPS accuracy indoors, the 25 s fix timeout, `mocked` detection, the offline queue flushing on foreground.
- Haptics and the feel of every spring on device (release build): check-in press, verdict and gate-close reveal, sheet drag, toast swipe, radius slider detents.
- Dynamic Type at accessibility sizes, VoiceOver focus after the verdict panel and gate-close card, Reduce Motion crossfades; the screenshots are a Chromium render with Segoe UI, not SF.
- Supabase: `db push` on a hosted project, pg_cron and pg_net, Vault secrets, the push function's Expo receipts, `job_health` after a day, the `review-photos` bucket policies, Auth redirect `finalcall://auth-callback`, the smoke script.
- Apple: the developer account, EAS device registration, TestFlight review, App Store Connect privacy answers (`docs/APP_STORE.md`), the reviewer-access choice (P3-9).
- Venmo deep links on a phone with and without Venmo installed.

## End of night-1

### What shipped (branch `night-1`, PR to `main`)
- Fairness: places visible to the group with distances, confirm/object gate (24 h or a friend's confirmation, never under 12 h for changes), place events in the feed and push; Approximate Location refused as a choice (not fail-open); an automatic group challenge on the 3rd unverified day in a pact-month; an unvoted appeal leaves the result standing; the challenge opener no longer votes; six more holes closed by two independent red-team passes (`docs/REDTEAM.md`, 41 + 13 attacks considered).
- Real deployment: `supabase/config.toml`, `seed.sql`, `scripts/smoke.ts`, `docs/DEPLOY.md` (Windows). Reliability: local Boarding / Final-call reminders, cron heartbeats + `job_health` + ops alerts, Sentry opt-in with location scrubbing, server-vs-device clock notice.
- App Store: renamed to Final Call (`com.ishaanmakam.finalcall`, `finalcall://`), in-app account deletion (profile anonymized, ledger kept), privacy + terms screens and `docs/legal/*`, `docs/APP_STORE.md`, Sign in with Apple nonce, expo-updates.
- Device testing: Maestro flows (`.maestro/`), EAS workflow building a demo simulator build and running them, CI for all suites + lint, `docs/TESTING.md`.
- Product: the airport voice (Boarding / Final call / Gate closed, nowhere else), the gate-close card with today's result and money from the ledger, 4-week seasons with recaps, streaks, and the settle-up completion rate on a Stats screen.
- Web simulator (`web/`, GitHub Pages at https://ishaanmakam.github.io/final-call/) running the real `packages/rules` oracle, with fence playground, behaviour scripts, fast-forward clock, presets and live ledger.

### Test counts (final run)
| Suite | Count |
|---|---|
| supabase/tests (PGlite) + tsc | 24 files, 327 tests |
| packages/rules + tsc | 42 |
| push-outbox + tsc | 57 |
| app (tsc + vitest) | 40 files, 533 |
| web (tsc + vitest + build) | 36 |
| scripts tsc, Maestro lint | clean |
Screenshots: 166 app (`app/screenshots/index.html`), 10 simulator (`web/screenshots/index.html`).

### Needs your iPhone or your accounts
See "Only a real iPhone or the founder's accounts can verify" above. Two one-time repo settings: GitHub → Settings → Pages → Source: GitHub Actions (for the simulator), and the EAS project id / Apple credentials for `.eas/workflows/maestro.yml`.

### The 5 decisions to review first
1. **N1-1 / N1-2** — place gate: a changed place counts only after a friend confirms it (≥ 12 h) or 24 h pass without objection; an objected place drops you from later rosters (no money moves, day voids under 2 actives). This is the biggest product-rule change of the night.
2. **N3-1** — an unvoted appeal leaves the original result standing (resolves your open question 4). The `excluded` status is now reserved.
3. **RT-1** — the opener of a challenge can no longer vote (reverses D3); a 2-person pact's challenges are decided by the other person alone, which is also why the automatic budget challenge is opened in the subject's name.
4. **N2-1 … N2-9 + RT-6** — the Unverified budget: the 3rd unverified day in a calendar month per pact auto-opens a challenge; forged late taps remain accepted for friends but are bounded by this (open question 5).
5. **P3-1 / P3-9** — account deletion drops the `profiles → auth.users` FK so the anonymized profile outlives the identity; App Store reviewer access (seeded account vs runtime demo switch) is still your call before submission.
