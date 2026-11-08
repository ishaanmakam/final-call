# Design: show-up pacts (MVP)

Source: design session approved by Ishaan on 2026-11-07. Exact interfaces live in docs/CONTRACT.md; deliberate deviations and assumptions live in docs/DECISIONS.md.


## Product rules

Core objects. A Group has 2 to 8 members and an invite link. A Pact belongs to a group and defines the game: title, days of week, window-open time, deadline time, stake, and time zone. Each participant in a pact sets their own target Place, so one pact can cover “9am class” with each person in a different building. The pot is shared, the target is personal. Each scheduled day produces a Pact Instance with a concrete UTC deadline.

Check-in. A big button that is active only inside the window. Tapping takes one foreground high-accuracy fix and sends it. Location is read at no other time. A check-in counts if the uncertainty circle of the fix touches the fence, which tolerates indoor GPS. Default window opens 60 minutes before the deadline, pact-adjustable. Users can tap more than once; the first in-fence tap wins.

Result states at deadline.

Success: at least one in-fence check-in before the deadline, by server time.
Failed: no check-in at all, or only out-of-fence check-ins. Both are verified negatives.
Unverified: a check-in was attempted but could not be judged, for example accuracy worse than 200 meters, no fix, or an offline attempt that arrived after the deadline with a client time before it. This is the fail-open path and never costs money by default.
Frozen: declared before the window opened, one per person per ISO week per pact.
Void: fewer than two active participants, so no stakes are posted.

Review flow. Any result can be reviewed before weekly settlement. The subject can appeal a Failed result with optional photo evidence. Any other participant can challenge a Success or Unverified result. Non-subject participants vote; simple majority of votes cast decides. If nobody votes by settlement, the result stands, whichever kind of review it was: an unvoted appeal keeps the Failed and the forfeit (so appealing every miss and hoping for silence gains nothing), an unvoted challenge keeps the Success or Unverified. Excluded (stake returned, neither winner nor loser) was the old default for an unvoted appeal; since night-1 (N3-1) no rule produces it, the status is kept only for history (the pill still renders old rows), and the monthly "Excluded this month" count the feed and group home used to show is gone (NI-2). Unverified has a budget: a person's third Unverified day in a pact in one calendar month is challenged automatically and the group votes on it like any challenge (N2), and the check-in screen counts down to it from the first one; iOS Approximate Location is refused outright on the check-in tap because it is a setting, not a tracking failure, so such a day counts as Missed, never Unverified.

Payout. With n active participants, k successes, and carry C from previous all-fail instances: pot is (n-k) times stake plus C, each winner gets floor(pot/k), and the leftover cents go one each to the earliest check-ins. All-fail moves the stakes into the pact’s carry. Rollover and void instances leave the carry untouched.

Settlement. The group has a settlement time zone. Weeks run Monday to Sunday. Settlement runs Monday noon local, after a 12 hour review grace. It snapshots net balances into obligations, simplified so each person makes at most a few payments, each with a Venmo deep link carrying recipient, amount, and note. The payer marks paid, the payee confirms, and the confirmation posts the ledger entry. Reviews resolved after settlement produce correction entries that appear in the next week. Groups can pause a pact, which voids its future instances until resumed.

Wording. Code uses stake, pot, and ledger. UI copy uses pledge, forfeit, and pool. No rake, ever.

## System design

Backend is Postgres. All business rules live in plpgsql functions in Supabase, called by the client through RPC. The client never writes to ledger, result, or instance tables. Row-level security lets members read only their groups. pg_cron runs four jobs: generate instances seven days ahead daily, open and close due instances every minute, settle due groups hourly, and drain a notification outbox every minute through an Edge Function that calls the Expo push API.

Ledger. Double-entry journal with entries and lines. Accounts are group-scoped: one per member, one pot per instance, one carry per pact. Entry kinds are stake, payout, rollover, settlement payment, and correction. Every entry has a unique idempotency key derived from its cause, such as instance id plus kind, so re-running any job is a no-op. Balances are a view summing lines, never a column. Payouts and settlements are integer cents.

Time. Pacts store an IANA zone, local deadline time, and local window time. Instances store local date plus the computed UTC deadline, so DST is handled by Postgres at generation time. Deadline comparisons use server receive time. Client time is stored but only consulted for the offline-late unverified case.

Client. Expo SDK with TypeScript, expo-router, Supabase JS, TanStack Query. Native modules limited to expo-location foreground, expo-notifications, expo-apple-authentication, and secure storage, so one EAS development build covers the MVP and everything else ships over the air. Auth is Sign in with Apple plus email magic link. Check-in attempts are queued locally and retried, so a dead network at 8:59 becomes an unverified result rather than a fail.

Screens. Sign in, groups list, group home with today’s instances and live “2 of 4 checked in” status, pact creation wizard with per-person place picker, check-in screen, feed with results and reviews, ledger with obligations and Venmo links, settings. No maps SDK; the place picker uses the current location plus a radius, with address search as v1.1.

Places are accountable. Everyone in the group sees everyone's place: the label, the circle, who set it and when, and how far it is from the others' places ("2.3 km from the others"), so a dorm room labelled "class" is visible on day one. Your first place counts right away; anyone in the group can object to it within 24 hours. A moved place counts once another member confirms it (never sooner than 12 hours after the move) or after 24 hours if nobody objects; until then you are judged against your old place. An objection blocks the place and you have to set a new one. If no place of yours counts when a window opens, you are simply not in that day: no result, no pledge either way. Every move, confirmation and objection shows in the feed with Confirm / Object, and the people involved get a push.

Privacy. Location is collected only on a check-in tap inside a window. The raw coordinates are kept 30 days for reviews, then nulled, leaving only distance and the in-fence verdict.

## Testing and validation

Tests. Ledger, payout, settlement, and instance-closing logic are plpgsql and get pgTAP tests through the Supabase CLI against a local Docker stack. The TDD rule applies: no change to those functions without a failing pgTAP test first. Client logic such as the offline queue and deadline display gets Vitest. Docker on Windows ARM is a known risk, and the fallback is a hosted Supabase project used only for tests.

Concierge test. Two weeks, two or three groups, one running show-up and one running fitness, iMessage plus a shared sheet plus Venmo on Sunday. Measures: check-in rate by week, settlement completion rate, number of disputes, and whether a group goes silent. Runs while the app is built and feeds the defaults.

Explicit non-goals for MVP. HealthKit, run recording, Android, real money, public groups, maps, charity pots, personalized baselines, background geofencing.