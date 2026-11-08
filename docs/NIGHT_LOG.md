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

## In flight
- Fresh red-team agent: `supabase/tests/redteam.test.ts`, `supabase/migrations/20261108000400_redteam_fixes.sql`, `docs/REDTEAM.md`.
- Phase 2 in parallel: P1 Supabase-for-real (`supabase/config.toml`, `seed.sql`, `scripts/smoke.ts`, `docs/DEPLOY.md`), P2 reliability (local notifications, heartbeat migration `20261108000500_heartbeat.sql`, Sentry, clock skew), P4 device testing (`.maestro/`, `.eas/workflows/`, CI, `docs/TESTING.md`).
- After P2 finishes: P3 App Store readiness + global rename to Final Call (account deletion, privacy/terms, APP_STORE.md, Apple nonce, expo-updates, bundle id, scheme).

## Next
Collect red-team + P1/P2/P4 reports, integrate, run all suites, commit "Phase 1b/2a", push. Then P3, then phase 3.
