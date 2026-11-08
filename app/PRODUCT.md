# Product

<!-- impeccable:product-schema 1 -->

Facts below come from `docs/DESIGN.md`, `docs/CONTRACT.md`, `docs/DECISIONS.md` and the founder's brief. Lines marked *(inferred)* were not confirmed by the founder and were written during the unattended UI overhaul; correct them rather than designing around them.

## Platform

ios

## Users

Small groups of friends, 2 to 8 people, who want to hold each other to showing up somewhere on time: the 9am lecture, the gym before dinner, a sunrise run. The first users are UW students around campus *(inferred from the concierge test and the place names in the brief)*. They use the app in three moments:

- **Walking in, minutes before a deadline.** One hand, outdoors or in a corridor, often in a hurry. They open the app to tap Check In and want to know, in one glance, whether it counted.
- **Glancing during the day.** "Did everyone make it?" Who is checked in, who is still out, what today's pacts are.
- **Settling up on Monday.** Reading who owes whom, paying a friend a few dollars on Venmo, confirming they received theirs; occasionally voting on an appeal.

Everyone is a peer. The person who created the group is an owner only for pausing pacts.

## Product Purpose

Show Up turns "I'll be there" into a small pledge among friends. Each person sets their own place for a pact; one tap during the check-in window takes a single GPS fix; whoever shows up splits the forfeits of whoever doesn't. No real money moves: the app keeps the ledger and gives Venmo links at the weekly settle-up.

Success is a group that keeps using it: check-in rate holds week over week, settle-ups complete, disputes stay rare, and nobody feels cheated by the app itself.

## Positioning

The mechanism a neighbor cannot copy honestly: **a tracking failure never costs anyone money.** Weak GPS, no fix, a dead network, a late offline delivery all resolve to *Unverified*, which moves nothing. Only a verified absence forfeits a pledge, and any result can be appealed or challenged by the group before Monday. The app is the referee's notebook, not the referee: friends decide, the ledger remembers.

## Operating Context

- One foreground GPS fix per Check In tap inside an open window (default 60 minutes before the deadline). Location is read at no other time and raw coordinates are nulled after 30 days.
- Windows and deadlines follow the pact's IANA time zone; comparisons use server time.
- Weekly settle-up Monday at noon in the group's zone, after a 12-hour review grace. Obligations are simplified so each person makes at most a few payments; each carries a Venmo deep link with recipient, amount and note. Payer marks paid, payee confirms.
- Reviews: the subject can appeal a Missed day (optional photo); anyone else can challenge a Showed up or Unverified day. The others vote; majority of votes cast; ties and silence keep the status quo except an unvoted appeal, which excludes the person.
- Push notifications for window open, 15 minutes before the deadline, results, reviews and settle-up. The app also works with notifications off.
- Offline check-ins are queued and retried; a late in-fence delivery becomes Unverified, never Missed.

## Capabilities and Constraints

- Groups (2 to 8, invite code or link), pacts (title, days, window, deadline, pledge $0.01 to $100, time zone), per-person places (current location plus a 25 to 500 m radius; no map, no address search in MVP), check-in, freezes (one per week per pact, declared before the window), feed with reviews and votes, ledger with running balances and obligations, settings (name, Venmo username, notifications).
- Result states: Showed up, Missed, Unverified, Frozen, Didn't count (void: fewer than two active people), Excluded (review outcome). Each person's Excluded count for the month is visible to the group.
- **Terminology.** UI says *pledge*, *forfeit*, *pool*, *settle-up*, *showed up*, *missed*. Code says stake, pot, ledger, settlement. Never "bet", "wager", "rake".
- Expo SDK 58 on iOS, expo-router, Supabase; business rules live in the database and are not the app's to change. Android, maps, HealthKit, real money and background geofencing are out of scope for MVP.
- Undecided *(founder's open questions)*: leaving a group while owing money; the $100 cap; anonymous challenges; whether an unvoted appeal should default to Excluded.

## Brand Commitments

- Name: **Show Up**. No logo or wordmark beyond the name has been made; the icon in `assets/` is a placeholder.
- Voice: plain, short, friendly, factual. It tells people what happened and what they can do; it never scolds, never celebrates with confetti, never hides a rule.
- The reassurance that tracking failures do not cost money is part of the product's promise and must be visible in every failure state.

## Evidence on Hand

- Backend and rules are implemented and tested (`supabase/`, `packages/rules`), including the fail-open paths.
- No real user data, testimonials or usage numbers exist yet. Demo fixtures in `src/api/demo/` are synthetic (names, balances, history) and must not be presented as real.
- The Pact/GymPact FTC case (2017) is the cautionary reference for why fail-open matters.

## Product Principles

1. **Fail open, always.** Any path where the app cannot prove an absence ends in Unverified. The interface says so wherever it could be doubted.
2. **One glance, one tap.** The check-in moment is the product. Everything else is quiet and gets out of the way.
3. **The group is the referee.** Results, appeals and votes are visible to everyone; the app never decides a dispute on its own.
4. **Small money, serious bookkeeping.** Cents are exact, balances are derived, nothing is edited after the fact. The UI inherits that honesty: numbers are tabular and never rounded away.
5. **Native first.** Standard iOS controls, Dynamic Type, Dark Mode, VoiceOver. Brand lives in the details, not in reinvented chrome.

## Accessibility & Inclusion

VoiceOver labels on every control and state, Dynamic Type through the system text styles with sane ceilings on titles, 44 pt touch targets, Reduce Motion honored (fade instead of slide, no overshoot), WCAG AA contrast in both appearances, and color never the only carrier of a state (each has a word).
