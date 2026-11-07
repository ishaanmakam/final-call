# Show-up pacts: project rules for Claude Code

Read `docs/DESIGN.md` (why) and `docs/CONTRACT.md` (exact tables, rules and RPC signatures) before changing anything. `docs/DECISIONS.md` records choices made without the founder; respect them unless he overrides one.

## Layout

- `supabase/migrations/` — all business rules live here as plpgsql. The database is the source of truth.
- `supabase/tests/` — vitest + PGlite (Postgres in WASM) tests for every migration. `supabase/tests/pgtap/` mirrors key invariants for `supabase test db`.
- `supabase/functions/push-outbox/` — Edge Function that drains `notification_outbox` to Expo push.
- `packages/rules/` — TypeScript reference implementation of verdicts, results, payouts and debt simplification. It is the oracle for differential tests against SQL. Change both together or neither.
- `app/` — Expo (expo-router) iOS client. Never contains business rules beyond display.

## Money rules (non-negotiable)

- All money is integer cents (`bigint` in SQL, safe integers in TS). Never floats. Dollars appear only in UI formatting.
- Double-entry ledger. `ledger_entries`/`ledger_lines` are append-only; lines of an entry sum to zero; balances are derived by views, never stored.
- Every entry has a deterministic `idempotency_key` derived from its cause. Re-running any job must be a no-op.
- Past entries are never edited. A changed result produces a `correction` entry with the difference.
- The client never writes ledger, results, instances or obligation status directly. Only SECURITY DEFINER RPCs listed in CONTRACT.md, each checking `auth.uid()` membership, with an explicit `search_path`.
- A tracking or connectivity failure must never cost anyone money: such cases resolve to `unverified` (no money moves). See the Pact/GymPact FTC case in DECISIONS.md.

## Engineering rules

- TDD for anything touching results, payouts, ledger, settlement or obligations: write a failing test first (superpowers:test-driven-development), then the code. Run the whole suite, not one file.
- Any change to payout/result rules must update `packages/rules` and keep the differential test (`supabase/tests/differential.test.ts`) green.
- Instants are `timestamptz` in UTC. Pacts store an IANA zone; local deadlines are converted when instances are generated. Deadline comparisons use server receive time.
- Location is read only on a Check In tap inside an open window. No background location. Raw coordinates are nulled after 30 days.
- UI copy says pledge / forfeit / pool. Code says stake / pot / ledger. No rake, ever.
- Run before claiming done: `cd supabase/tests && npx vitest run`, `cd packages/rules && npx vitest run`, `cd app && npx tsc --noEmit && npx vitest run`.
- Before anything touches real money (not in MVP), run `/security-review` and get a legal opinion; see DECISIONS.md.
