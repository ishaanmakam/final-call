# Night log (night-1)

Resume file for the unattended run started 2026-11-07 evening. If context is lost: read this, `CLAUDE.md`, `docs/CONTRACT.md`, `docs/DECISIONS.md`, then continue from "Next".

Repo: https://github.com/ishaanmakam/final-call · branch `night-1` (from `ui-overhaul`, which is from `main`).
Verification per phase: `cd supabase/tests && npx tsc -p tsconfig.json && npx vitest run` (~2.5 min), `cd packages/rules && npx vitest run && npx tsc --noEmit`, `cd supabase/functions/push-outbox && npx vitest run && npx tsc --noEmit`, `cd app && npx tsc --noEmit && npx vitest run`, later `cd web && npm test && npx tsc --noEmit`.

## Step 0 — done
- Remote `origin` added; `master` renamed `main` and pushed; `ui-overhaul` pushed; `night-1` created from `ui-overhaul` and pushed. `gh` 2.102 is installed.
- Baseline test status at branch point: db 220, rules 33, push-outbox 49, app 417, all green.

## Phase 1 — devil's advocate (in progress)
Plan: three parallel agents, each test-first, each with its own migration file:
1. Places accountability → `supabase/migrations/20261108000100_place_accountability.sql`, `supabase/tests/places.test.ts`, app pact detail / place picker / feed / queries.
2. Precise Location refusal + Unverified budget → `20261108000200_unverified_budget.sql`, `supabase/tests/unverified-budget.test.ts`, `app/src/lib/location.ts`, check-in screen.
3. Appeal default → `20261108000300_appeal_default.sql`, `packages/rules`, differential + e2e tests, CONTRACT.
Then a fresh red-team agent, fixes test-first.

## Next
Dispatch phase 1 agents.
