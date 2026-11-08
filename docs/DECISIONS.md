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
| D29 | Which time a tap claims | The earlier of the tap and the GPS fix. A tap at 8:59:50 whose fix finishes at 9:00:05 counts as on time. | A slow GPS fix shouldn't turn an on-time tap into a late one. |
| D30 | Location permission denied | Nothing is sent and the app asks you to enable location. | Sending a no-location attempt would let anyone make every day Unverified by turning location off. |
| D31 | Challenging a result changed after settlement | Allowed (challenges only, not appeals) when a late tap changed the result after its week settled. | Otherwise a forged late tap couldn't be challenged at all (found by the final re-review). |
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

## UI overhaul defaults (2026-11-07)

Made during the UI/UX overhaul on branch `ui-overhaul` without the founder. Same reversal rule as above.

| # | Question | Default | Why |
|---|----------|---------|-----|
| U1 | The brief named `impeccable` as an installed skill, but it was not on this machine (only the Emil Kowalski skills under `~/.agents/skills`). | Fetched the public `pbakaus/impeccable` repo and installed its markdown (SKILL.md + `reference/`) to `~/.agents/skills/impeccable`; the CLI launcher was not installed, so agents follow its documented "launcher unavailable" path. | The brief made it the design authority; the references are plain markdown. |
| U2 | UA4 vs UB2: colour of a settled `Unverified` result | Neutral grey, like Frozen/Void (UB2). Amber stays for live in-window guidance (`Weak GPS`, `Not there yet`, `Late`) and for `Unpaid`, where another tap or a payment changes the outcome. | A settled Unverified moved no money; amber on it reads as a loss. Amber during the window means "act now", which is what it is for. |
| UB1 | Check in: single tap or press-and-hold? | Single tap. | Once a day is the "occasional" tier; a mistaken tap costs nothing (first in-fence tap wins, 20 cap), while a hold costs time at 8:59. See `docs/UX_AUDIT.md` section 6. |
| UB2 | Colour for Unverified, Frozen, Void, Excluded and negative balances | Neutral (secondary label / grey pill), never red or amber. Red is reserved for `Missed` and destructive actions. | These states move no money; colouring them like a loss contradicts the fail-open promise. |
| UB3 | How offline-queue outcomes (`sent` / `rejected` / `expired`) reach the user | A top-edge Toast plus a 24 h notice row in the feed; never `Alert.alert`. The expired case says the day stands as recorded and points to Appeal. | A modal about a background flush interrupts whatever the person is doing, and the current "dropped" text hides a money consequence. |
| UB4 | Is check-in a modal/sheet or a pushed screen? | A pushed screen (inline title), deep-linked from the group's today card and from push notifications. | The screen has one object (countdown + button) and a below-fold history; a sheet would hide the countdown and fight swipe-to-dismiss while locating. |
| UB5 | Screen name for the money screen | "Settle up" in the nav title and all copy; `ledger` stays in code and routes. | "Ledger" is code vocabulary (CLAUDE.md); users think in paying and being paid. |
| UC1 | Push retry policy when Expo or the network fails | The outbox lease doubles as the backoff: a failed row is re-claimed after 1, 5, 15, then 60 minutes (5 attempts in all, about 80 minutes), instead of five back-to-back minutes. | A five-minute Expo blip used to kill every queued notification for good (`docs/REVIEW.md` F3). |
| UC2 | Reminders that are late when they finally send | `window_open` / `deadline_soon` rows whose `deadline_at` has passed are dropped, never sent. Result, review and settlement pushes are sent however late. | A "1 min left" push after the deadline is worse than none (F2). |
| UC3 | How often `generate_instances` runs | Every 15 minutes (was daily at 00:07 UTC). It is idempotent. | A pact created in the morning got no instance until the next midnight UTC; Asia-Pacific zones lost a whole day (C1). |
| UC4 | Push cron when the Vault secrets are missing | The job raises (visible in `cron.job_run_details`) instead of returning nothing. | Silent skipping was invisible (C2). |
| UC5 | Outbox retention | Sent rows and exhausted rows (`attempts = 5`) older than 30 days are deleted nightly by `purge_old_outbox`. Retryable rows are kept. | Matches the 30-day location purge; the table otherwise grows forever (R5). |
| UC6 | Appeal photo limits | 5 MB per file; JPEG, PNG, HEIC/HEIF, WebP only (bucket-level caps). No delete policy. | Unbounded uploads were the one write a member could abuse; evidence should not vanish once cited (R6). |
| UC7 | Where review fixes to the cron schedule live | `20261107000400_cron.sql` was edited in place; everything else went into the new `20261107000600_review_fixes.sql`. | The cron file has never been applied anywhere and is declarative config; a second set of `cron.schedule` calls in a later migration would be two sources of truth. |
| UC8 | SecureStore value size | Sessions are split into chunks of at most 1900 UTF-8 bytes under `<key>.__chunk<i>` with a `__chunks__:<n>` marker; a torn read (chunk missing) returns `null`, i.e. "signed out", never a truncated value. | SecureStore caps values at 2048 bytes and a Supabase session is 2.5 to 4.5 KB (A1). |
| UC9 | CI coverage of the Deno entrypoint | `deno check index.ts` runs in CI but is advisory (`continue-on-error`) until it has been seen green once. | No Deno on the dev machine to verify the step; the four required jobs are the ones the brief named. |
| UA1 | Visual world for the app | "The Roll Call": a quiet, system-native utility (SF via Dynamic Type, inset-grouped lists, one ultramarine tint `#2B4ACB` / `#8DA2FF` dark, cool neutrals, seven state tones) where the check-in moment is the one loud, earned interaction. Written in `app/DESIGN.md`; tokens in `app/src/theme/tokens.ts`. | Operate mode: the world may lend only type, palette, density and one signature move; nothing competes with the check-in. |
| UA2 | Check-in interaction | Single tap (agrees with UB1). Anatomy: a 240 pt ring that is the window's clock (drains to the deadline), a 220 pt tint button, tabular countdown; tap → indeterminate sweep while locating → one `reveal` spring (350 ms, damping 1) fills the ring and button in the verdict's tone with a notification haptic (Success / Warning / Error by verdict). Exact states in `app/DESIGN.md`. | Weight should come from the GPS wait and the result, not from holding a button at 8:59. |
| UA3 | Dark-mode tint and text-on-tint | Dark tint is bright (`#8DA2FF`) with near-black label on tint fills (`onTint` = `#0C1017`), instead of white on a darker blue. | White on any blue bright enough to read as text on `#0C1017` fails 4.5:1; the swap passes in both roles (verified by `tokens.test.ts`). |
| UA4 | Unverified's tone | Kept a distinct amber pair (`#8A5A00` / `#FBEFD0`, dark `#F2B544` / `#3C2E0D`) for `unverified` and the live "Weak GPS / Late / Not there yet" states, plus icy blue for `frozen`, grey for `void` / `pending`, muted purple for `excluded`. Red (`forfeit`) is only for Missed and destructive actions. | Partly overlaps UB2 (which asks for neutral grey on Unverified). The palette keeps amber as "worth another tap" guidance during the window; the pill mapping lives in one place (`components/status.ts`) so phase 2 can flip it to neutral without touching tokens. Lead decides. |
| UA5 | Reduced motion policy in code | Every spring passes `reduceMotion: ReduceMotion.System`; components also branch on `useReducedMotion()` to keep opacity/color and drop translate/scale (sheet crossfades in place, GPS sweep becomes an opacity pulse, skeleton goes static, stack uses `animation: 'fade'`). The pure mapper is unit-tested. | The motion contract says keep what explains state, drop what moves. |
| UA6 | Haptics map | `pressPrimary` impact Light (primary/destructive press-in, incl. Check In); `selection` for segmented/chips/steppers/slider every 25 m; `snap` impact Light (sheet detent, toast dismiss); `commit` impact Medium (leave group, dispute, pause); `success` / `warning` / `error` notification by verdict. No-op on web. | One per action, same frame as the visual, never the only feedback. |
| UA7 | Press feedback implementation | Reanimated CSS transition (`transitionProperty: 'transform'`, 120 ms, ease-out `cubic-bezier(0.23, 1, 0.32, 1)`) built by `theme/motion.ts#transition()` and cast to `ViewStyle`, because `css.create` output does not type-check against `Animated.View` in RN 0.88 + Reanimated 4.7. | Keeps the press on the UI thread with no shared value, and keeps tsc strict. |
| UA8 | Gesture handler API | Installed version is v3 (`~3.3`): sheets, toast and the radius slider use the hook API (`usePanGesture` with `onActivate` / `onUpdate` / `onDeactivate`) and `scheduleOnRN`; the `Gesture.Pan()` builder in the animate-expo recipes is the legacy path. `RadiusSlider` was rewritten off `PanResponder` (React hears a value only when it crosses a 5 m step, via `useAnimatedReaction`). | The motion contract forbids `PanResponder` and per-frame JS. |
| UA9 | Legacy screens in dark mode (phase 1 only) | `components/theme.ts` (the old static palette the phase-1 screens import) now resolves colors from `Appearance.getColorScheme()` at access time. Correct at launch and for screenshots, stale if the user flips appearance while the app runs; deleted when phase 2 migrates the screens. | The dark screenshots showed the old check-in countdown drawn in light-mode ink (invisible); screens are out of this phase's lane. |
| UA10 | Demo mode plumbing | `EXPO_PUBLIC_DEMO=1` swaps every hook/RPC at module level (`export const useX = DEMO ? demo.useX : useXReal`) in `queries.ts` / `rpc.ts`; the demo keeps the same query keys (plus a scenario suffix) so screens' invalidations work; route params (`verdict`, `empty`, `state`, `perm`, `signedOut`, `freeze`) steer scenarios; `useNow` can freeze for deterministic captures. Fixtures anchor "today" to the load instant so every window state is on screen regardless of the wall clock. | Screens must not know they are in demo mode; the harness needs every state addressable by URL. |
| UA11 | Web build scope | Web exists only for the screenshot harness and demos (`web.output: 'single'`); native-only modules have web fallbacks (`push.web.ts`, fake location, haptics no-op, SF Symbols replaced by stroke SVGs in `Icon.tsx` off-iOS). Captures use the platform system font stack (Segoe UI on Windows), so letterforms differ from SF on device. | Chrome is installed; Playwright drove it with `channel: 'chrome'` (62/62 routes captured, no browser download). |
