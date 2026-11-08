# Final Call

Show-up pacts among friends (renamed from "Show Up" on 2026-11-07; iOS bundle id `com.ishaanmakam.finalcall`, scheme `finalcall://`).

Friend groups pledge money on showing up: "be at Kane Hall by 9:00 on weekdays." One tap checks you in with a single location fix. People who show up split the forfeits of people who don't. Money never moves in the app; it keeps an IOU ledger and gives you Venmo links each Monday.

- Why and what: [`docs/DESIGN.md`](docs/DESIGN.md)
- Exact tables, rules, RPCs: [`docs/CONTRACT.md`](docs/CONTRACT.md)
- Choices made and open questions: [`docs/DECISIONS.md`](docs/DECISIONS.md)
- What's done and what you do next: [`docs/PLAN.md`](docs/PLAN.md)
- Rules for Claude Code in this repo: [`CLAUDE.md`](CLAUDE.md)
- Deploy to a real Supabase project (Windows, step by step): [`docs/DEPLOY.md`](docs/DEPLOY.md)

## Run the tests

```bash
cd packages/rules && npm install && npx vitest run
cd supabase/tests && npm install && npx vitest run
cd supabase/functions/push-outbox && npm install && npx vitest run
cd app && npm install && npx tsc --noEmit && npx vitest run
```

The database tests run real Postgres (PGlite, compiled to WebAssembly) inside Node, so they work on Windows ARM without Docker.

## Web simulator

**https://ishaanmakam.github.io/final-call/** — a playable model of one group's week: an iPhone frame with the app's screens on the left, and on the right a fence playground (drag your GPS dot and accuracy ring and watch the verdict), your phone's online / location settings, your three friends' behaviour, a clock you fast-forward (Boarding, Final call, Gate closed, Next day, Monday noon), four preset weeks, and the live ledger. Every money number on it comes from `packages/rules` (the same oracle the database is differential-tested against), imported straight from source.

```bash
cd packages/rules && npm install
cd ../web && npm install
npm run dev          # http://localhost:5173/final-call/
npm test             # engine + scenario + component tests (vitest, jsdom)
npm run build        # web/dist, base /final-call/ (VITE_BASE=/ for a root deploy)
npm run screenshots  # 1440×900 light + dark PNGs into web/screenshots/ (uses installed Chrome)
```

Deploys from `main` by `.github/workflows/pages.yml` whenever `web/**` or `packages/rules/**` change. One-time setup: in the GitHub repo, Settings → Pages → Build and deployment → Source: **GitHub Actions**.
