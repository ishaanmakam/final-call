# Implementation plan

Status legend: [x] done overnight, [ ] next.

## Phase 1: core (overnight build)

- [x] Design, contract, decision log, CLAUDE.md
- [x] `packages/rules`: TypeScript oracle for verdicts, results, payouts, debt simplification (property tests)
- [x] Foundation migration: schema, append-only zero-sum ledger, idempotent `post_entry`, balances views, RLS, group/pact RPCs
- [x] Instances, check-ins, freezes, results, reviews migration
- [x] Payouts, corrections, weekly settlement, obligations migration
- [x] pg_cron schedule (no-op where pg_cron is missing)
- [x] Differential test: SQL payouts vs `packages/rules` on random cases
- [x] Push-outbox Edge Function
- [x] Expo app: all MVP screens, offline check-in queue, Venmo links

## Phase 2: get it on your phone (you, in order)

1. Create a Supabase project (free tier). Run `supabase link` then `supabase db push` from the repo root to apply migrations.
2. In Supabase: enable Apple and email auth; enable `pg_cron` and `pg_net`; set the Edge Function secrets; deploy `push-outbox` (see `supabase/functions/README.md`).
3. Join the Apple Developer Program ($99/yr), needed for EAS device builds and Sign in with Apple.
4. In `app/`: copy `.env.example` to `.env` with the Supabase URL and anon key, then `eas build --profile development --platform ios`, register your iPhone with `eas device:create`, install, run `npx expo start --dev-client`.
5. Make a group with two friends and one pact (for example "Kane Hall by 9:00", weekdays). Live with it for a week.

## Phase 3: concierge test (run in parallel with phase 2)

Two weeks, 2–3 friend groups. Measure check-in rate by week, settlement completion, disputes, and whether any group goes silent. Decide kill/continue on those numbers, not on feel.

## Phase 4: v1.1 candidates

- Native module for iOS `CLLocationSourceInformation.isSimulatedBySoftware` (spoof detection)
- Address search in the place picker
- HealthKit run pacts (verify `HKMetadataKeyWasUserEntered`, source bundle whitelist)
- Android (Health Connect, FCM)
