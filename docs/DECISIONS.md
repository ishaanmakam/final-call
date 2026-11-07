# Decision log

Decisions are either **founder** (Ishaan chose) or **default** (made overnight by Claude without asking, because the design didn't specify). Reverse any default by editing this file and the matching rule in `docs/CONTRACT.md`, `packages/rules`, and the SQL. The differential test will tell you if they drift apart.

## Founder decisions (2026-11-07)

| # | Decision |
|---|----------|
| F1 | MVP is show-up check-ins only. HealthKit, run recording, Android, maps and background geofencing are v1.1 or later. |
| F2 | When everyone fails an instance, the forfeits roll into the pact's carry, which pays out to the next instance with at least one success. No charity pot. |
| F3 | A freeze must be declared before the window opens. One per person per ISO week per pact. |
| F4 | Default pledge is $5 per missed instance (allowed range $0.01 to $100). |
| F5 | The design in `docs/DESIGN.md` (pacts with a personal place each, success/failed/unverified, review voting, Monday-noon settlement, Venmo obligations) is the spec. |
| F6 | The MVP moves no real money. The app records IOUs; people pay on Venmo. No rake, ever. |

## Defaults chosen overnight

| # | Question | Default | Why |
|---|----------|---------|-----|
| D1 | What does an accepted appeal turn a Failed result into? | Success, with `first_success_at` = deadline (so they rank last for leftover cents). | The group voted that they did show up. |
| D2 | What does an accepted challenge turn a Success/Unverified result into? | Failed. | The group voted that they didn't show up. |
| D3 | Who votes, and how are ties decided? | Every current participant except the subject; the opener of a challenge may vote. Majority of votes cast; a tie means rejected. | Ties should favour the status quo. |
| D4 | A check-in flagged as a simulated location? | `rejected_simulated`, which counts as Failed, not Unverified. | Spoofing is evidence of not being there, not a tracking failure. Note: expo-location does not expose iOS `isSimulatedBySoftware` yet, so the client sends `false` until a small native module is added (v1.1). |
| D5 | Accuracy limit for judging a fix | 200 m inclusive; worse is Unverified. | From the design. |
| D6 | Late offline check-ins | Accepted if the fix was captured inside the window; result becomes Unverified (no money moves), recomputed with a correction entry if the instance already closed. | Fail-open rule. |
| D7 | Unpaid obligations from last week | Superseded each settlement; new obligations are computed from all-time member balances. | Avoids stacking stale IOUs. |
| D8 | Instance with fewer than 2 active participants | Voided; carry untouched. | From the design. |
| D9 | Venmo username | Stored on the profile, optional. | Needed for deep links. |
| D10 | How the database is tested here | Vitest + PGlite (real Postgres in WASM) in `supabase/tests/`; pgTAP mirrors in `supabase/tests/pgtap/` for `supabase test db` once Docker works on your machine. | The design's Docker-on-Windows-ARM risk; this avoids it entirely. |

## Why fail-open matters

Pact (formerly GymPact) settled with the FTC in 2017 after charging users who met their goals when the app failed to recognize their activity. Any path where our tracking fails must end in Unverified, never Failed.

## Before real money (not MVP)

Stripe prohibits peer-to-peer money transmission and restricts prize-promising entry fees; Apple guideline 5.3.4 requires licensing and geo-restriction for real-money gaming; Washington is strict on paid skill contests. Run `/security-review` and get a gaming-law opinion first.
