# Final Call

Show-up pacts among friends. A group of 2 to 8 people pledges a few dollars to be somewhere by a time ("Kane Hall by 9:00, weekdays"); each person sets their own place. One tap inside the check-in window takes a single GPS fix; people who showed up split the forfeits of people who missed; a day that could not be judged is Unverified and never costs anyone. The app moves no money: it keeps an append-only ledger and hands out Venmo links at Monday's settle-up.

iOS app (Expo, bundle id `com.ishaanmakam.finalcall`, scheme `finalcall://`), a Supabase backend whose plpgsql functions hold every rule, a TypeScript oracle the database is differential-tested against, and a playable web simulator.

**Simulator:** https://ishaanmakam.github.io/final-call/

## Read first

- Why and what: [`docs/DESIGN.md`](docs/DESIGN.md)
- Exact tables, rules, RPCs: [`docs/CONTRACT.md`](docs/CONTRACT.md)
- Choices made without the founder and open questions: [`docs/DECISIONS.md`](docs/DECISIONS.md)
- What is done and what the founder does next: [`docs/PLAN.md`](docs/PLAN.md)
- Rules for Claude Code in this repo: [`CLAUDE.md`](CLAUDE.md)

## Ship it

- Supabase project, migrations, cron, push function, auth providers (Windows, step by step): [`docs/DEPLOY.md`](docs/DEPLOY.md)
- Device tests (Maestro flows on EAS) and what CI runs: [`docs/TESTING.md`](docs/TESTING.md)
- App Store Connect answers, privacy label, review notes: [`docs/APP_STORE.md`](docs/APP_STORE.md)
- Privacy policy and terms (also rendered in the app): [`docs/legal/PRIVACY.md`](docs/legal/PRIVACY.md), [`docs/legal/TERMS.md`](docs/legal/TERMS.md)
- Red team: who can dodge a pledge or take the pool, and what was fixed: [`docs/REDTEAM.md`](docs/REDTEAM.md)
- Money review and UX audit that shaped the build: [`docs/REVIEW.md`](docs/REVIEW.md), [`docs/UX_AUDIT.md`](docs/UX_AUDIT.md)

## Layout

| Path | What |
| --- | --- |
| `supabase/migrations/` | Every business rule as plpgsql: ledger, instances, check-ins, results, reviews, payouts, settlement, places, unverified budget, heartbeat, account deletion, seasons |
| `supabase/tests/` | Vitest + PGlite (Postgres in WASM) tests for every migration, including the differential and red-team suites |
| `supabase/functions/push-outbox/` | Edge Function that drains `notification_outbox` to Expo push |
| `packages/rules/` | TypeScript oracle for verdicts, results, reviews, payouts and debt simplification |
| `app/` | Expo iOS client (expo-router, Supabase JS, TanStack Query); `app/README.md` for setup, demo mode and screenshots |
| `web/` | Vite + React simulator on GitHub Pages, importing `packages/rules` from source |
| `scripts/` | Smoke test against a real Supabase project (`npm run smoke`, skips without `.env`) |
| `.maestro/` | Device flows run on EAS; `node .maestro/lint.mjs` checks them in CI |

## Run the tests

Five suites plus two checks; all run on Windows without Docker (the database tests run real Postgres compiled to WebAssembly).

```bash
cd supabase/tests && npm install && npx tsc -p tsconfig.json && npx vitest run     # ~1.5 min, 24 files
cd packages/rules && npm install && npx vitest run && npx tsc --noEmit
cd supabase/functions/push-outbox && npm install && npx vitest run && npx tsc --noEmit
cd app && npm install && npx tsc --noEmit && npx vitest run
cd web && npm install && npx tsc --noEmit && npm test && npm run build
cd scripts && npm install && npx tsc --noEmit
NODE_PATH=app/node_modules node .maestro/lint.mjs      # any node_modules with js-yaml
```

`supabase/tests/pgtap/` mirrors the key invariants for `supabase test db` against a Docker stack, when one is available.

## Screenshots

- App: `cd app; $env:EXPO_PUBLIC_DEMO='1'; node scripts/screenshot.mjs` renders every route of the demo build at iPhone 15 size, light and dark, into `app/screenshots/` with a contact sheet (`index.html`). The PNGs are committed; they are the review artifact.
- Simulator: `cd web && npm run screenshots` renders five states at 1440×900, light and dark, into `web/screenshots/`.

## Web simulator

A playable model of one group's week: an iPhone frame with the app's screens on the left, and on the right a fence playground (drag your GPS dot and accuracy ring and watch the verdict), your phone's online / location settings, your three friends' behaviour, a clock you fast-forward (Boarding, Final call, Gate closed, Next day, Monday noon), four preset weeks, and the live ledger. Every money number comes from `packages/rules`, the same oracle the database is differential-tested against.

```bash
cd packages/rules && npm install
cd ../web && npm install
npm run dev          # http://localhost:5173/final-call/
npm test             # engine + scenario + component tests (vitest, jsdom)
npm run build        # web/dist, base /final-call/ (VITE_BASE=/ for a root deploy)
npm run screenshots  # 1440×900 light + dark PNGs into web/screenshots/ (uses installed Chrome)
```

Deploys from `main` by `.github/workflows/pages.yml` whenever `web/**` or `packages/rules/**` change. One-time setup: in the GitHub repo, Settings → Pages → Build and deployment → Source: **GitHub Actions**.

## Words

UI copy says pledge, forfeit, pool, showed up, missed, unverified, frozen, didn't count. Code says stake, pot, ledger. Three moments borrow the departure board's words and nothing else does: Boarding (the window opens), Final call (fifteen minutes left), Gate closed (the deadline). No rake, ever.
