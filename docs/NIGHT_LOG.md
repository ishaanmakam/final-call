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
