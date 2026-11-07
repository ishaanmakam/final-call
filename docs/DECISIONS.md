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
| D7 | Unpaid obligations from last week | Unpaid (`pending`) ones are superseded each settlement. Ones marked paid survive until the payee confirms or disputes. Obligations bill only settled instances. | The first version could bill a Venmo payment twice and could bill Monday-morning results before their review window closed (found by the reviewer). |
| D8 | Instance with fewer than 2 active participants | Voided; carry untouched. | From the design. |
| D9 | Venmo username | Stored on the profile, optional. | Needed for deep links. |
| D10 | How the database is tested here | Vitest + PGlite (real Postgres in WASM) in `supabase/tests/`; pgTAP mirrors in `supabase/tests/pgtap/` for `supabase test db` once Docker works on your machine. | The design's Docker-on-Windows-ARM risk; this avoids it entirely. |

| D11 | Changing your place | New places take effect 12 hours after you set them, and changes are refused once a window has opened. | Otherwise you could move your fence to your bed at 7:59 (found by the attack tests). |
| D12 | Leaving a group | Also leaves its pacts; ownership passes to the longest-standing member; you can still see obligations you're party to. | Keeps settle-ups possible after someone leaves. |
| D13 | Valid time zones | Must be a real IANA name from `pg_timezone_names`. Abbreviations like `PST` are rejected. | Abbreviations ignore daylight saving. |
| D14 | Check-in retries | `check_in` takes an optional `p_client_attempt_id`; the app sends a stable id per attempt so a retry after a timed-out-but-delivered request doesn't record a second tap. | Found by the app agent. |
| D15 | A phone that can't get any GPS fix | The app still submits the attempt with no coordinates; it's judged Unverified. | Fail-open. |
| D16 | Push delivery | A 5-minute lease on each outbox row (`claimed_until`) prevents overlapping runs from double-sending. | Found by the notifications agent. |

| D17 | DST edge cases when generating instances | A time skipped by spring-forward moves forward by the gap (02:30 → 03:30); a time repeated by fall-back uses the first occurrence. | Deterministic and tested on 2027-03-14 and 2026-11-01. |
| D18 | Who counts in an instance | Participants who joined at or before the window opened and haven't left. | Prevents joining mid-window to grab a pot. |
| D19 | Resuming a paused pact | Future instances voided by the pause come back if they never closed. | Pausing shouldn't permanently delete the schedule. |
| D20 | Changing a vote | Allowed while the review is open. | Normal group-chat behaviour. |
| D21 | Correcting a result after the carry was already paid out | The money is clawed back from the later instance(s) that drew that carry, oldest first, as if the result had been right from the start. Carry can never go negative. | The only rule that never creates money from nowhere. |
| D22 | Which reviews close at settlement | Open reviews on instances whose deadline was before Monday 00:00 (settlement zone) of the week being settled. | Monday-morning instances of the new week keep their review window. |
| D24 | Leaving during a window | Refused while you're counted in an instance whose window is open; once the window opened you're scored even if you leave. | Leaving at 8:58 used to dodge the forfeit (found by the attack tests). |
| D25 | Repeat reviews | One appeal and one challenge per person per instance, ever. | A loser could re-appeal late on Sunday until nobody voted and it defaulted to Excluded. |
| D26 | Check-in spam | 20 per person per instance. | Each late check-in triggers recomputation. |
| D27 | Late out-of-fence check-in | Stays Failed; only a late in-fence tap becomes Unverified. | Consistent with D4. |
| D28 | Phone clock running fast | Ignored for on-time check-ins; only checked for late ones. | A fast clock used to reject an on-time tap. |
| D23 | Settlement catch-up | Missed weeks are settled in order; only the latest week sends a settlement notification. | Earlier weeks' obligations are superseded immediately. |

## Open questions for you

1. Should someone be able to leave a group while they owe money? Right now they can (their obligations stay visible to them).
2. Is $100 the right maximum pledge per instance?
3. Should challenges be anonymous? Right now the opener is visible.
4. An appeal nobody votes on defaults to Excluded (no money moves). That's from the design, but it means someone can appeal every loss and hope the group ignores it. Consider defaulting unvoted appeals to the original result, or requiring a photo.
5. A forged capture time on a late check-in can turn Failed into Unverified until settlement; the only defence is a challenge. Fine for friends, worth revisiting before strangers.

## Why fail-open matters

Pact (formerly GymPact) settled with the FTC in 2017 after charging users who met their goals when the app failed to recognize their activity. Any path where our tracking fails must end in Unverified, never Failed.

## Before real money (not MVP)

Stripe prohibits peer-to-peer money transmission and restricts prize-promising entry fees; Apple guideline 5.3.4 requires licensing and geo-restriction for real-money gaming; Washington is strict on paid skill contests. Run `/security-review` and get a gaming-law opinion first.
