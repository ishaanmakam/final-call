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
