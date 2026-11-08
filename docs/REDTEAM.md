# Red team: who can dodge a pledge, take the pool, or be charged unfairly (night-1)

Reviewer with no prior context, working from `CLAUDE.md`, `docs/*.md`, every migration in order, the TypeScript
oracle, the push function and the client's check-in and money code. Brief: *"Find every way a member of a friend
group can avoid paying or take money they didn't earn, and every way honest users can be charged unfairly."*

Method: for each suspected hole a PGlite test in `supabase/tests/redteam.test.ts` that fails while the hole exists;
fixes test-first in `supabase/migrations/20261108000400_redteam_fixes.sql` (plus `packages/rules`, the push
function and the client where a rule or copy changed). Decisions taken without the founder are rows RT-1..RT-6 in
`docs/DECISIONS.md`; rule changes are in `docs/CONTRACT.md`.

Outcome: 4 proven holes, all fixed (RT-1..RT-4); 2 accepted risks recorded as decisions (RT-5, RT-6); everything
else already safe. Suites at hand-off: `supabase/tests` 302 tests (21 files, two of them other night-1 lanes'),
`packages/rules` 42, `push-outbox` 56, `app` 489; green except two failures owned by concurrent lanes (see the
hand-off note), `tsc` clean in all four.

## Attack table

Attacker: L = lazy member (never wants to pay), G = greedy member (wants the pool), 2 = two colluding members,
O = group owner / pact creator, R = leaver who rejoins, M = modified client (any RPC, any argument, replay, race,
forged client time / accuracy / coordinates / `p_is_simulated`), T = time-zone / calendar manipulation,
H = honest user (charged unfairly).

| ID | Attacker | Attack | Outcome |
|----|----------|--------|---------|
| A1 | G, M | Challenge the other person's GPS-verified success in a 2-person pact and vote for it yourself (1 of 1 eligible): they fail and pay you | **Proven + fixed (RT-1)**: the opener of a challenge is not a voter |
| A2 | G | Challenge a success and vote yes; the rest of the group stays silent, so "majority of votes cast" at settlement is your single vote | **Proven + fixed (RT-1)** |
| A3 | 2 | Two colluders in a 4-person pact: A challenges C, A and B vote yes (2 of 3 eligible), D never consulted | Partly fixed (RT-1): A's vote no longer counts, so D's "no" now ties it (rejected); a silent D still loses. **Accepted**: a colluding majority of the *other* voters is majority rule; visible in the feed |
| A4 | L, M | In a 2-person pact send an unjudgeable tap every day (GPS off, metal box, null coordinates): every day voids, the unverified results are erased to `void`, the budget never counts them, nothing is challengeable, you never pay | **Proven + fixed (RT-2)**: unverified stays on record on voided days, counts toward the budget, is challengeable; an accepted challenge revives the day and posts the forfeit |
| A5 | L | Same in a 3-person pact on days the third person is frozen or also unverified | **Proven + fixed (RT-2)** (same test family) |
| A6 | L, M | Appeal the miss first (review open), then land a forged late tap: the third unverified day of the month is never auto-challenged because the trigger fired while the appeal was open | **Proven + fixed (RT-4)**: the budget is re-checked when any review of the result resolves |
| A7 | L | Mark an obligation paid on Venmo without paying; the payee hears nothing, the next settlement treats it as paid (D7) and can bill the payee for the difference | **Proven + fixed (RT-3)**: `obligation_marked_paid` push to the payee, `obligation_disputed` push to the payer; the ledger never moved (already safe), now the defence is announced |
| A8 | L, M | Forge `client_captured_at` inside the window on a tap sent up to 24 h after the deadline: miss becomes Unverified, forfeit refunded | **Accepted (RT-6)**: bounded by the budget (2 per pact-month, RT-4 closes the bypass), pushed to the roster as a correction, challengeable even after settlement (D31) |
| A9 | L, M | Send null coordinates / accuracy > 200 m on every on-time tap | Already safe by design: Unverified, 2 free per pact-month, then the group votes (N2); human challenge any time; iOS Approximate Location refused on the client (N2-5) |
| A10 | O | Pause the pact minutes before a window you will miss, resume after: the day is voided for everyone | **Accepted (RT-5)**: nobody gains, carry untouched, visible pill, only the creator/owner can; recommend a feed event + push before strangers |
| A11 | O | Pause mid-window to cancel the day you are already missing | Already safe: open instances are not voided; closes and pays (regression test) |
| A12 | O | Pause, then resume to re-roll a closed day or change its times | Already safe: revive touches only `voided` + `closed_at null` + no results; pact times are immutable |
| A13 | L | Leave the group at 8:58 to dodge the forfeit, rejoin later | Already safe (D24, attacks suite): refused while on an open or due roster; rejoin resets `joined_at` |
| A14 | R | Leave and rejoin with a new place to skip the 12 h / confirmation gate | Already safe: a rejoin with another place is a gated change (N1); same place is not gated but puts you on no already-open roster |
| A15 | G | Join the pact after the window opened to grab the pool | Already safe (D18, attacks suite) |
| A16 | G, M | Move the fence to where you are right before the window | Already safe (D11/N1, places suite): gated 24 h or a friend's confirmation ≥ 12 h; judged against the old place meanwhile |
| A17 | 2 | A colluder confirms your dorm-room place at 12 h | **Accepted**: places are public with distances ("2.3 km from the others"); anyone can object within 24 h |
| A18 | G | Object to a friend's first place so they are off the roster and the day voids (2-person) or they cannot win | **Accepted**: no money moves on an objection; objection is public with a reason; N1-2 |
| A19 | G | Object to a place after its window opened to knock the person off that day | Already safe: an objection never affects a window that opened before it (regression test) |
| A20 | M | `check_in_at`, `declare_freeze_at`, `open_review_at`, `cast_vote_at`, `post_entry`, `_post_initial`, every `_` helper, as `authenticated` or `anon` | Already safe: catalog sweep + per-function denial (attacks suite; `_post_initial`'s new 4-arg form is revoked too) |
| A21 | M | Replay `check_in` with another user's attempt id, or 60 attempt ids | Already safe: attempt ids are per user; 20 per instance including late taps (regression test) |
| A22 | M | `p_is_simulated = false` from a jailbroken phone with a spoofed location | **Accepted** (D4 note): no server-side detection; places are public and challengeable |
| A23 | M | Claim a late tap on a day cancelled by a pause | Already safe: 23514 (regression test) |
| A24 | M | Late tap to flip a success or a freeze | Already safe: base result keeps success / frozen (regression test) |
| A25 | M | Late tap after the 20-tap cap to force endless recomputations | Already safe: the cap counts before insert (regression test) |
| A26 | T | Two freezes in one ISO week across a month or year boundary | Already safe: `IYYY-"W"IW` (regression test on 2030-12-30 / 2031-01-03) |
| A27 | T | Three unverified days across a month boundary, or across pacts | **Accepted** by design (N2-1): budget is per pact and calendar month; the human challenge has no budget |
| A28 | T | Pact in a far-off zone vs the group's settlement zone to shorten others' review window | Already safe: all comparisons are instants; the minimum review window is 12 h for a deadline just before Monday 00:00 settlement-zone, whatever the pact zone |
| A29 | T | DST day: ambiguous or missing local times | Already safe (D17, instances suite): deterministic, window keeps its length |
| A30 | G, M | Confirm an obligation nobody paid (payee) | Harmless: the entry reduces only the payee's own credit |
| A31 | L | Dispute after confirming; confirm a superseded obligation; mark paid twice | Already safe: confirmed is final, superseded raises, repeats are no-ops (attacks + settlement suites) |
| A32 | L | Ping-pong: mark paid before every Monday noon, let the payee dispute after | Delay only: the ledger balance never changes, the superseded debt is re-billed; RT-3 makes each step visible |
| A33 | G | Appeal every miss on Sunday night and hope nobody votes | Already safe (N3-1): a defaulted appeal keeps the miss |
| A34 | G | Re-appeal / re-challenge after losing | Already safe (D25): one of each per (instance, subject), ever |
| A35 | G | Vote after leaving the group, or have a leaver's earlier vote counted | Already safe (rereview fix 3) |
| A36 | G | Join the pact after the day to vote on its reviews | Already safe (attacks suite) |
| A37 | M | Direct writes to ledger / results / instances / obligations / places / events; cross-group reads | Already safe: RLS select-only, append-only ledger triggers, catalog sweeps |
| A38 | G | Carry: make a correction create money, or draw carry twice | Already safe (D21, payouts suite): claw-back oldest draw first, carry never negative, every entry zero-sum (checked at commit) |
| A39 | L | Leave the group while owing | **Accepted** (open question 1): obligations stay visible to both parties; no app-side enforcement |
| A40 | M | Fast phone clock on an on-time tap | Already safe (D28) |
| A41 | M | Register a victim's Expo push token to steal their notifications | **Accepted**: requires the device token (a secret) |

## Proven holes

### RT-1  A challenge decided by its own opener

**How it worked.** `_review_voters` = roster minus the subject, current members only, "the opener of a challenge may
vote" (D3). Early resolution needs *more than half of the eligible voters*; settlement resolves by *majority of votes
cast*. In a 2-person pact the opener was the only eligible voter: `A` challenges `B`'s in-fence success, votes yes,
`2 * 1 > 1` → accepted on the spot, `B` is Failed and pays `A`; `B`'s appeal has `A` as its only voter. In a bigger
pact a lone challenger whose group never voted was accepted at settlement (1 yes, 0 no). The accused was one push
notification away from losing their pledge to the person who profited.

**Test.** `redteam.test.ts` › RT-1 (three cases: 2-person pact, lone challenger + silence, the other members still decide).

**Fix.** `_review_voters` excludes `opened_by` for challenges. The automatic unverified-budget challenge is opened in
the subject's name, so its voters are unchanged (the other members, also in a 2-person pact). Human challenges in a
2-person pact now have no voters and default: a GPS-verified result can only be overturned by someone who does not
profit from it. Client `canVoteOn` hides the buttons from the opener; `reviews`, `rereview-findings`, `e2e`,
`differential-results` and the pgTAP mirror were updated to the new rule.

### RT-2  Unverified results erased on voided days (2-person pacts could be farmed)

**How it worked.** The void rule set *every* non-frozen result to `void` when fewer than 2 were active. The unverified
budget (N2) counts `unverified` results on closed/settled instances only, and reviews require a closed instance. In a
2-person pact `B`'s unjudgeable tap left `A` as the only active participant, so the day voided, `B`'s `unverified`
became `void`, the counter stayed at zero forever, nobody could challenge anything, and `B` never paid while `A`
could never win. Any physical way to make every tap unjudgeable (GPS off at the tap, a basement, a modified client
sending null coordinates) worked; the automatic challenge built to stop exactly this never fired.

**Test.** `redteam.test.ts` › RT-2 (three cases) and the rewritten `unverified-budget` "voided day" case.

**Fix.** `_close_instance` voids only `success`/`failed`; `unverified` (and `frozen`) stay. `unverified_month_counts`
and `_auto_challenge_if_over_budget` count days voided at close (`status = 'voided' and closed_at is not null`; a
pause's void has no results and never counts). `open_review_at` / `cast_vote_at` accept a challenge of an unverified
result on such a day. `_refresh_result` on a voided day calls the new `_reclose_instance`: every participant's
result is recomputed from check-ins + resolved reviews (`_computed_result`), the void rule is re-applied, and if 2+
are now active the day is revived: `status = 'closed'`, payout via `_post_initial(..., p_carry_in => 0)` (a revived
day never draws carry deposited after it), `result` pushes. Late taps recompute on any closed-at day
(`check_in_at` checks `closed_at`). Oracle `computeResults` matches; `RULES_VERSION` 3; `differential-results` green.

### RT-3  Silent "marked paid"

**How it worked.** `mark_obligation_paid` wrote the row and nothing else. The payee saw it only by opening settle-up.
At the next settlement a `marked_paid` obligation counts as provisionally paid (D7): the payer's new obligations shrink
by the amount and the payee's credit is spent, until the payee disputes. The ledger itself never moved (verified by a
regression test), so nothing was lost permanently, but the only defence was a tap nobody was told to make.

**Test.** `redteam.test.ts` › RT-3 (two cases); push copy in `push-outbox/test/outbox.test.ts`; route in
`app/src/lib/pushRoute.test.ts`; the e2e outbox sweep now checks recipients.

**Fix.** Outbox kinds `obligation_marked_paid` (to the payee) and `obligation_disputed` (to the payer), payload via
`_obligation_payload`, deep link to settle-up; no row for calls that change nothing. Rendered by the push function
("Maya marked $7.25 as paid" / "Diego says $7.25 did not arrive"); the client routes both to the ledger.

### RT-4  Budget bypass through an open appeal

**How it worked.** The automatic challenge is suppressed while any review of the result is open, and it is fired by
triggers at the moment the result lands on `unverified`. Appeal the miss (open), then let a late tap land: the trigger
runs, sees the open appeal, returns; the appeal defaults at settlement and nothing re-checks. Every later unverified
day of the month (each one "lands" once, with its own open appeal if wanted) escaped the vote.

**Test.** `redteam.test.ts` › RT-4.

**Fix.** `_resolve_review` calls `_auto_challenge_if_over_budget(instance, subject, p_now)` after refreshing the
result (idempotent: a prior challenge of any kind still suppresses it). A challenge opened this way at settlement
sits on the just-settled instance and is resolved by the next settlement's `default_open_reviews`, as for any late
challenge.

## Accepted risks for friends, revisit before strangers

1. **Pause as a free skip (RT-5).** Owner/creator can void any not-yet-opened day. No money moves. Add a
   `pact_paused`/`pact_resumed` feed row + push, or make a pause apply only to windows 12+ hours out.
2. **Forged late taps (RT-6, open question 5).** A client-side capture time cannot be verified; the design accepts a
   refund-to-Unverified path bounded by the budget and challengeable after settlement.
3. **Colluding majority (A3).** Two of three other voters can still convict; majority rule. The feed names voters.
4. **Colluding confirmation of a far place (A17)** and **griefing objections (A18)**: both public with names and
   distances; neither moves money.
5. **Location spoofing with `p_is_simulated = false` (A22).** No server detection is possible; the fence and the
   group's eyes are the control. iOS `isSimulatedBySoftware` is v1.1.
6. **Leaving while owing (A39).** Obligations stay visible; nothing blocks it.
7. **Budget is per pact-month (A27).** Three pacts = six free unverified days a month. A per-person-per-month budget
   across pacts is a one-line change in `_auto_challenge_if_over_budget` if abuse shows.
8. **Push-token takeover (A41)** needs the device token.

## Honest-user hazards

Found while looking for the opposite; none moves money by itself.

- **Your real place change is not confirmed in time.** A legitimate move on Sunday night is judged against the old
  place on Monday (N1). The screen says so before saving; Appeal with a photo is the remedy. Unchanged.
- **Fast clock + offline tap.** On time, a fast clock is ignored (D28). Offline, `client_captured_at` must be inside
  the window: a phone 3 minutes fast tapping at a real 8:58 for a 9:00 deadline, whose tap arrives late, is refused
  (23514) and the day is a miss. iPhones are NTP-synced; a 2-minute tolerance on the late path (Unverified only) would
  close it. Not changed.
- **Cached GPS fix older than the window.** `attemptFromFix` takes the earlier of tap and fix (D29); a cached fix from
  before the window opened plus an offline send gives a capture time before `window_open_at`, refused on the late
  path. Only in the first seconds of a window. Not changed; a 60 s clamp in `attemptFromFix` would close it.
- **One device, two accounts.** The offline queue (`finalcall.checkinQueue.v1`) is not keyed by user; after a sign-out /
  sign-in on the same phone a queued tap is sent as the new user (refused with 42501 unless both are in the pact).
  Key the storage by user id when shared devices matter.
- **Paid on Venmo but never marked paid before Monday noon.** The pending obligation is superseded and the debt
  rerouted, possibly to a different creditor (D7 handles the marked case only). The group fixes it outside the app.
- **A fake "marked paid" can produce a bogus obligation in the payee's name** at the next settlement when the debt
  has since shrunk (payer appears to have overpaid). The payee's dispute un-does it at the following settlement; no
  ledger movement happens without the payee's own confirm. RT-3 makes the original tap visible.
- **Catch-up settlement** (cron down for weeks) defaults reviews of week N at week N's end even if people were still
  voting in week N+1. Rare; result stands either way.
- **Revived days (RT-2) draw no carry.** The winner of a day revived by a challenge gets the stakes only; the carry
  waits for the next normally posted day (documented in CONTRACT).
- **Unverified on a voided day now reads "Unverified", not "Void"** in the feed for that person (RT-2). Intended: it
  is the count the budget line shows.
- **Notifications are best-effort.** Nothing in the result rules depends on a push arriving; the one place silence
  used to cost money (a lone challenger, A2) is closed by RT-1.

## Files

- `supabase/migrations/20261108000400_redteam_fixes.sql` (new)
- `supabase/tests/redteam.test.ts` (new); updated `reviews`, `rereview-findings`, `e2e`, `instances`,
  `unverified-budget`, `differential-results` tests and `pgtap/instances_test.sql`
- `packages/rules/src/index.ts` (+ tests): void rule, `RULES_VERSION` 3
- `supabase/functions/push-outbox/outbox.ts` (+ tests, README): two obligation kinds
- `app/src/lib/pushRoute.ts`, `app/src/features/feed/reviewCopy.ts` (+ tests)
- `docs/CONTRACT.md`, `docs/DECISIONS.md` (RT-1..RT-6), this file
