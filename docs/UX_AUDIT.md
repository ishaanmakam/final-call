# UX audit: Show Up (iOS, Expo)

Method: design review only (detector not applicable, native platform). Assessment A run alone in this context, which `critique.md` names as the complete native method; no degraded banner applies.

Branch `ui-overhaul`, 2026-11-07. Mode for every screen is **Operate**: the visitor is in a task, familiarity is a feature, and ambition shows as precision. Copy throughout uses pledge / forfeit / pool. Current UI copy is already clean of bet / stake / pot / wager (grep of `app/src` finds only code identifiers and one code comment in `lib/errors.ts:36`); the `/stake must be between/` pattern at `lib/errors.ts:77` is correctly a server-message matcher, not UI copy.

---

## 1. Method and provenance

- Platform: native iOS (Expo SDK 58, RN 0.88, expo-router). No running app, no screenshots exist yet; the web contact sheet (`app/scripts/screenshot.mjs`) lands in a later phase. Everything below is read from source, so anything about feel (gesture timing, haptic sync, scroll performance) is a prediction to confirm on hardware, and is marked as such.
- Read in full: `docs/DESIGN.md`, `docs/CONTRACT.md`, `docs/DECISIONS.md`, `app/README.md`, `CLAUDE.md`; impeccable `SKILL.md`, `reference/critique.md`, `audit.native.md`, `ios.md`, `operate.md`, `clarify.md`, `harden.md`, `onboard.md`, `craft-floor.md`; `animate-expo/SKILL.md`; `apple-design/SKILL.md`; `emil-design-eng/SKILL.md`; `find-animation-opportunities/SKILL.md`.
- Read in full, with line numbers: every route in `app/src/app/**` (16 files), every component in `app/src/components/**` (5 files), `app/src/lib/{time,instanceStatus,errors,places,reviews,obligations,money,venmo,checkinQueue,checkinAttempt,checkinQueueRuntime,location,openVenmo,useNow,links,auth,push}.ts(x)`, `app/app.config.ts`, `app/package.json`, and the exports of `app/src/api/queries.ts`.
- Scored: the five-dimension native audit (`audit.native.md`), Nielsen's ten heuristics (`critique.md`), the cognitive-load checklist, personas, and the iOS slop test (`ios.md`).

---

## 2. Audit health score and platform conformance verdict

### Audit health score

| # | Dimension | Score | Key finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | 2 | Buttons and the slider carry labels, but every text size is a hard-coded point value (`components/ui.tsx:211-231`, `checkin/[instanceId].tsx:235,248`), so Dynamic Type does nothing. `accessibilityLiveRegion` is Android-only (`checkin/[instanceId].tsx:137`); VoiceOver never hears the verdict. Stepper and slider buttons are 36-40 pt (`RadiusSlider.tsx:101`, `TimeStepper.tsx:39`). |
| 2 | Performance | 2 | `useNow(1000)` re-renders the whole group home, every card and every badge once a second (`groups/[groupId]/index.tsx:67`). `RadiusSlider` is a `PanResponder` calling `onChange` (a `setState`) per move event (`RadiusSlider.tsx:44`). Lists are `ScrollView` + `map` (`ui.tsx:39`), fine at 8 members, not fine for a feed of weeks. |
| 3 | Appearance & theming | 1 | Raw hex everywhere (`components/theme.ts:1-16`), `userInterfaceStyle: 'light'` (`app.config.ts:17`), `StatusBar style="dark"` forced (`app/_layout.tsx:43`). Dark Mode does not exist. One tint colour is used correctly. |
| 4 | Platform conformance | 1 | No SF Symbols (`expo-symbols` not installed), a text link as the Settings header button (`(app)/_layout.tsx:57-61`), cards standing in for inset grouped lists on every screen, a hand-rolled time stepper and segmented control, free-text IANA time zone fields, eight `Alert.alert` calls, no large titles, no haptics (`expo-haptics` not in `package.json`), no swipe actions, no context menus. |
| 5 | Adaptivity | 2 | iPhone-only portrait is a defensible MVP call (`supportsTablet: false`, `orientation: 'portrait'`), but there is no keyboard avoidance anywhere (sign-in email, wizard title, place label, review reason all sit inside a plain `ScrollView`), and the fixed type scale clips at accessibility sizes. |
| **Total** | | **8/20** | **Poor (major overhaul)** |

### Platform conformance verdict: ported website

A fluent iPhone user would pause on the first screen after sign-in. The app is built from one `Card` primitive and one `Button` primitive, and nothing else from the platform's vocabulary appears. Specific violations, worst first:

1. **Cards as the page structure, nested.** `groups/index.tsx:25` (group list), `groups/[groupId]/index.tsx:39,112` (today and pacts), `pacts/[pactId]/index.tsx:62,85,104`, `feed.tsx:140` with a `Card` inside a `Card` at `feed.tsx:160` for each review, `ledger.tsx:146` with `ObligationCard` (`ledger.tsx:71`) nested inside the week card. craft-floor: "nested cards are always wrong"; ios.md: grouped/inset lists for settings-shaped content.
2. **Reinvented platform controls.** `TimeStepper.tsx` (five buttons to set a time; iOS has `UIDatePicker` in time mode, `@react-native-community/datetimepicker`), `Chip` as a two-state segmented control at `groups/new.tsx:44-47` (iOS has `SegmentedControl`), `RadiusSlider.tsx` on `PanResponder` (banned by the motion contract; iOS has `UISlider`, `@react-native-community/slider`), a free-text IANA zone field at `groups/new.tsx:51-58` and `new-pact.tsx:123-130` where the device zone with a picker fallback is the native expectation.
3. **Hand-rolled navigation.** The Feed / Ledger / Invite button row at `groups/[groupId]/index.tsx:96-100` is a three-button nav bar drawn in content. Sections belong in a segmented header or a native tab bar; Invite belongs in the navigation bar as an SF Symbol button.
4. **No iconography at all.** Not one icon in the app. The Settings entry is the word "Settings" in 16 pt text (`(app)/_layout.tsx:59`); the share action is the word "Invite".
5. **Web-shaped forms.** Settings has a `Save` button under two fields and prints "Saved." (`settings.tsx:103-104`). iOS settings autosave on end-editing. The sign-out button is a full-width red `danger` button (`settings.tsx:130`); iOS uses a plain destructive-tinted row at the bottom of a grouped list.
6. **Alerts as the only secondary surface.** Eight `Alert.alert` calls carry confirmations, errors and background events (`(app)/_layout.tsx:34-38`, `groups/[groupId]/index.tsx:80,89`, `pacts/[pactId]/index.tsx:44`, `checkin/[instanceId].tsx:113`, `ledger.tsx:57`). Three of them (`_layout.tsx:34-38`) interrupt whatever screen the user is on with a modal about a background queue flush.
7. **No large titles, no header actions, no pull-to-refresh on the places that need it (feed has it, check-in has it; settings and the wizard don't need it).** `headerLargeTitle` is never set; top-level Groups should use it.
8. **Press feedback is an opacity dim (`ui.tsx:201`), not a scale**, and there is no haptic anywhere. The one scale is on the check-in button (`checkin/[instanceId].tsx:247`), which is right.
9. **Fixed type.** `title: 28`, `heading: 18`, `body: 15`, `hint: 12` (`ui.tsx:211-218`). ios.md: system text styles, 17 pt body, 11 pt floor. 12 pt hint and 12 pt badge text (`ui.tsx:231`) are above the floor but do not scale.

What is native and should stay: the native stack, `presentation: 'modal'` for the two creation flows (`(app)/_layout.tsx:65,69`), the native `Switch` for pause and notifications, `Share.share` for invites, `RefreshControl`, Sign in with Apple's own button, `Linking.openSettings()` for blocked permission.

---

## 3. Critique

### Design-specificity verdict

Category-interchangeable. Swap the strings and this is a to-do app, a habit tracker, or an admin panel: white cards with hairline borders on `#F6F7F9`, one blue, slate text. Nothing in the composition says "friends, a deadline, a place, a small amount of money on the line." The only authored moment is the 220 pt circular Check In button (`checkin/[instanceId].tsx:237-244`), and it is surrounded by six stacked cards that pull attention away from it. The product has a signature interaction (one tap, one GPS fix, one verdict) and the screen treats it as one card among many.

Missed character: a countdown that behaves like a countdown (tabular numerals, a change of register in the last minute), the group's progress ("2 of 4") as a thing you can see rather than a sentence, the result reveal as a moment rather than a border-colour change, money as something explained once and then trusted.

### Nielsen heuristics (Operate mode: all ten apply)

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of system status | 3 | Phases are honest ("Getting GPS…", "Sending…", `checkin/[instanceId].tsx:131`), countdowns are live, every mutation has a `loading` state. Gaps: spinners instead of skeletons (`ui.tsx:137-143`), a 25 s GPS wait with no progress or cancel, no "your tap at 8:58 is locked in" reassurance. |
| 2 | Match system / real world | 2 | Raw verdict codes shown to users: "in fence", "out of fence", "unjudgeable", "rejected simulated" (`checkin/[instanceId].tsx:224`). Raw coordinates to five decimals (`place.tsx:138`). Users type "America/Los_Angeles". "Frozen", "Excluded", "Void", "Unverified" appear without a one-line gloss. |
| 3 | User control and freedom | 3 | Back works everywhere, leave is guarded, dispute reverses mark-paid. Modals have no Cancel button in the header; the GPS wait cannot be cancelled; a permission "denied" has no re-ask control. |
| 4 | Consistency and standards | 2 | Three kinds of "section" (card, heading + cards, heading + text), buttons of four variants used interchangeably, confirmations sometimes `Alert`, sometimes inline, errors sometimes `ErrorText` at the bottom of the scroll, sometimes an `Alert`. "Check in" vs "Open check-in" vs "Check In". |
| 5 | Error prevention | 3 | Server rules are mapped to good copy (`lib/errors.ts`), wizard validates per step, window-before-deadline is checked client-side. Gaps: place change refusal discovered only after tapping save (`lib/errors.ts:98`), pledge accepted as free text, permission dead end. |
| 6 | Recognition rather than recall | 2 | Freeze exists on two screens but is never explained before the alert. "Set your place to join" is a badge, not a control (`groups/[groupId]/index.tsx:116`). Members are a comma-joined sentence (`:128`). The invite code is shown as text under the members list. |
| 7 | Flexibility and efficiency | 2 | Push notifications deep-link to check-in (`lib/push.ts`), pull-to-refresh exists. No swipe actions (mark paid, confirm), no context menu on a pact, no quick check-in from the group list, no widget. |
| 8 | Aesthetic and minimalist design | 2 | Headings doing body's job: "Running balance (includes this week, not settled yet)" (`ledger.tsx:178`). A three-line intro paragraph at the top of the feed (`feed.tsx:240-243`). Per-member pills repeated on every today card (`groups/[groupId]/index.tsx:47-51`). Card-in-card. |
| 9 | Error recovery | 3 | `lib/errors.ts` is the best-written file in the client: every SQLSTATE maps to plain copy with a recovery. GPS failure explains the fail-open rule. Gaps: "Something went wrong." fallback, `Alert('Could not leave', …)`, offline "dropped" alert that hides a money consequence. |
| 10 | Help and documentation | 2 | Good inline hints exist in the wizard and place picker. Nothing explains forfeit / pool / carry-over / settle-up where the money is shown. No footnotes under grouped sections, no "How this works". |
| **Total** | | **24/40** | **Acceptable (significant improvements needed before users are happy)** |

### Cognitive load

Checklist failures: 5 of 8 (high).

- **Single focus** fails on group home: a three-button nav row, a Check in button per today card, a New pact button, a Leave group button and tappable pact cards compete (`groups/[groupId]/index.tsx:96-130`). Eight actions visible at once.
- **Chunking** fails on today cards with 5+ members: one pill per member wraps into a wall (`:47-51`).
- **Visual hierarchy** fails on the check-in screen: after a tap, up to six cards of equal weight stack below the button (verdict, saved offline, no GPS fix, permission, result, your taps).
- **Working memory** fails three times: the invite code must be copied between screens (`groups/[groupId]/index.tsx:129` to `groups/new.tsx:62`), the time zone must be typed from memory, and the 12-hour place rule must be remembered from a hint to understand why a later check-in used the old place.
- **Progressive disclosure** fails on the ledger: the explanation paragraph comes before any number (`ledger.tsx:178-182`), and on the feed (`feed.tsx:240-243`).

Decision points with more than four visible options: group home (8), check-in after a failed tap (Check In, Try again, Open Settings, Freeze today = 4, plus five cards to read), ledger obligation as payer (Pay on Venmo, Mark paid) plus payee (Confirm received, Didn't receive it) are fine individually but the screen shows "Between others" obligations with no action, which adds reading without decision.

### Emotional journey (peak-end)

The two peaks the product is built around are the check-in verdict and the Monday settle-up. Today:

- **Check-in success** is a `Card` whose border turns green with "You're in / Check-in counted. Nice." (`checkin/[instanceId].tsx:32,173`). The button turns green and reads "Checked in". That is the entire payoff for a 25 s GPS wait at 8:58. It should be the loudest moment in the app and it is a border colour.
- **Monday settle-up** is a card reading "You pay Sam $5.00" with an amber "Unpaid" badge (`ledger.tsx:73-76`, `status.ts:32`), above a running balance in red (`ledger.tsx:191`). The person who showed up every day sees a green "+$5.00" and "Sam pays you $5.00", which is fine; the person who missed sees red and amber and no sentence explaining why. For the group this is the moment that decides whether anyone pays, and the screen does not make paying feel easy or finished.

Valleys:

- **Before the window**: a grey 50 %-opacity circle labelled "Check In" that does nothing when tapped (`:130-131,246`). It reads as broken, not as "not yet".
- **Permission denied once** (not blocked): the screen shows a card with text and no button (`:199-205`); the user has to guess that tapping the big button again re-prompts. Meanwhile the deadline runs.
- **"Excluded this month"** pinned at the top of the feed (`feed.tsx:244-253`), a shame board before any result.
- **"Offline check-in dropped / It could not be sent within 24 hours."** as a modal, anywhere in the app, with no mention that the day stands as recorded (`(app)/_layout.tsx:38`).
- **End of the wizard**: `router.replace` into the place picker with no acknowledgement that the pact exists and that friends now need to set their own places (`new-pact.tsx:87`).

The end of each session should be the verdict or the settled row; both need to be designed as endings.

### Persona red flags

**19-year-old at 8:58, weak campus Wi-Fi, walking into Kane Hall.**
- Taps at 8:58:30. `takeHighAccuracyFix` can run 25 s (`lib/location.ts:22`); the RPC then waits up to its own timeout before being classified as network (`lib/errors.ts`). The button says "Getting GPS…" then "Sending…" with no indication that the tap time was captured (D29) and will count. They will tap again, which is harmless (first in-fence wins, 20-cap) but they do not know that.
- If the request times out it is queued (`checkin/[instanceId].tsx:88-90`) and the screen says "Saved offline" with the right rule. Then, forty minutes later in lecture, `Alert.alert('Offline check-in delivered', 'You were at your place.')` pops over whatever they are doing (`(app)/_layout.tsx:34`).
- If Location is denied-not-blocked they get a card with no button and a running countdown.
- Countdown digits are proportional (`styles.countdown` has no `fontVariant: ['tabular-nums']`), so the whole line shifts every second.

**Friend who missed, owes $5, feels judged.**
- Feed: "Sam · 9am class" with a red "Missed" badge, visible to the whole group, with no line saying what happens next ("$5.00 to the pool, split by 3"). Correct and necessary, but it should be factual, not red-on-red.
- Ledger: "-$5.00" in `colors.danger` (`ledger.tsx:191`), then "You pay Sam $5.00" with an amber "Unpaid" pill. Negative balance in red is a bank's idiom for overdraft, not a friend's idiom for "you owe lunch".
- "Excluded this month" with their name and a count if they ever appealed and nobody voted (`feed.tsx:244-253`, D4 open question 4).
- Appeal: the group votes "Agree" / "Disagree" (`feed.tsx:177-189`) and the ambiguity ("agree with me or with the result?") makes a sympathetic friend vote the wrong way.

**Group owner setting up the first pact.**
- Create group: a text field asking for a "Settlement time zone" pre-filled with "America/Los_Angeles" and a hint about Monday noon (`groups/new.tsx:51-58`). They do not know what to do with it; the right answer is "leave it", so it should not be a field.
- Wizard step 2: ten buttons to set two times (`TimeStepper.tsx:25-29`), another time zone field, and a preview line (`new-pact.tsx:131-135`) that is the single most useful thing on the step and is the smallest text.
- Step 3: pledge as a text field with "5.00" (`new-pact.tsx:141-147`). The explanation paragraph (`:154-157`) is the best money copy in the app and should be kept.
- After "Create pact" they are in the place picker with "Use my current location" (`place.tsx:130`) and no message that they are now standing in for themselves only, and that each friend must do the same from the pact page. Back on group home, friends see a "Set your place to join" badge that is not tappable (`groups/[groupId]/index.tsx:116`).
- Inviting works (share sheet with link and code), but the code is only shown as body text at the bottom of the members section.

---

## 4. Top 10 issues, ranked

| # | Sev | Issue | Location | Fix |
|---|-----|-------|----------|-----|
| 1 | P0 | Location permission "denied" is a dead end with money on the line. Nothing is sent when permission is missing (D30), so the day counts as Missed, and the screen shows only text when `blocked` is false. | `checkin/[instanceId].tsx:98-101,199-205`; `lib/location.ts:6-13` | Add an "Allow location" button that re-runs `ensureForegroundPermission()`, and state the consequence plainly: "Without location this day counts as missed." Pre-prompt on the pact page when the person joins, not at 8:58. |
| 2 | P0 | Verdict jargon shown to users: `c.verdict.replace(/_/g, ' ')` prints "in fence", "out of fence", "unjudgeable", "rejected simulated". | `checkin/[instanceId].tsx:224` | Map through a `verdictLabel` table: "At your place", "Outside your circle (140 m away)", "GPS too weak (±320 m)", "Location rejected". |
| 3 | P1 | No Dark Mode, no Dynamic Type, hard-coded hex and point sizes. Fails HIG on every screen. | `components/theme.ts`, `ui.tsx:211-231`, `app.config.ts:17`, `app/_layout.tsx:43` | Semantic tokens with light/dark values via `useColorScheme`/`PlatformColor`; `userInterfaceStyle: 'automatic'`; text styles mapped to iOS roles (largeTitle 34, title2 22, headline 17 semibold, body 17, subheadline 15, footnote 13, caption 12) with `allowFontScaling` on and `maxFontSizeMultiplier` 1.6 on the countdown only. |
| 4 | P1 | The before-window state looks broken: a 50 % grey disabled circle labelled "Check In". Freeze is a ghost button under it. | `checkin/[instanceId].tsx:130-131,152,246`; `:208-210` | The circle shows the countdown to opening ("Opens in 12:04") and is non-tinted, not dimmed. Freeze moves to a secondary row with a one-line gloss. |
| 5 | P1 | Background queue outcomes arrive as modal Alerts on any screen, and "dropped" hides a money consequence. | `(app)/_layout.tsx:29-43` | Replace with a `Toast` (top edge, 4 s, tappable to open the day) plus a persistent row in the feed. "Dropped" copy must say the day stands as recorded and point to Appeal. |
| 6 | P1 | Group home is a wall of equal-weight buttons: Feed / Ledger / Invite row, a button per today card, New pact, Leave group, and per-member pills. | `groups/[groupId]/index.tsx:96-130` | Large-title screen with a segmented header (Today · Pacts · Members), Feed and Ledger as header icon buttons or a second row of `ListRow`s, Invite as a share icon in the nav bar, Leave group under Members at the bottom as a destructive row. Today card uses `AvatarStack` + `ProgressRing`, not pills. |
| 7 | P1 | Money is explained with headings and colour instead of structure: "Running balance (includes this week, not settled yet)", red negative balances, amber "Unpaid" for both parties, no footnotes about pool / carry / unverified / corrections. | `ledger.tsx:178-202`; `status.ts:31-36`; `components/ui.tsx:154-159` | Inset grouped sections with footnotes (section 8 has the exact copy). Balances in label colour with sign; only the "Missed" result and a destructive action use red. |
| 8 | P1 | Wizard reinvents platform controls and asks for things the device knows: free-text time zone, five-button time stepper, pledge as a text field. | `new-pact.tsx:118-130,141-147`; `groups/new.tsx:51-58`; `TimeStepper.tsx` | Native time picker rows, time zone defaulted to the device zone and shown as a disclosure row ("Pacific Time · change"), pledge as a currency field with `$` prefix and a 5 / 10 / 20 quick row. |
| 9 | P2 | Review voting is ambiguous and the shame board is pinned first. "Agree / Disagree" has no referent; "Excluded this month" opens the feed. | `feed.tsx:175-191,244-253` | Vote buttons name the outcome: appeal → "They showed up" / "They didn't"; challenge → "Didn't show up" / "Result stands". Excluded counts move to a footnote on the Members section. |
| 10 | P2 | Place picker leaks coordinates, discovers the open-window refusal only after save, and runs the slider on `PanResponder` with 36 pt buttons. | `place.tsx:138,105`; `RadiusSlider.tsx:35,101`; `lib/errors.ts:98` | Show "Captured ±12 m" and the label, not lat/lng. Disable Save with a footnote when a window is open (data is in `usePactDetail`). Replace the slider with the platform `Slider` and 44 pt steppers. |

Secondary (P2/P3, folded into section 5): no haptics and opacity-only press feedback (`ui.tsx:201`); header text link for Settings (`(app)/_layout.tsx:57-61`); Settings "Save" form (`settings.tsx:103`); comma-joined members (`groups/[groupId]/index.tsx:128`); "Nice." (`checkin/[instanceId].tsx:32`); "you@uw.edu" placeholder (`sign-in.tsx:91`); `accessibilityLiveRegion` on iOS (`checkin/[instanceId].tsx:137`); whole-screen re-render per second (`groups/[groupId]/index.tsx:67`).

---

## 5. Per-screen fixes with exact replacement copy

Primitives referenced below (to be built by the component agent): `Button` (primary / secondary / plain / destructive; scale 0.97 press), `Card` (only for the today card and the verdict card), `ListRow` (inset grouped row with title / detail / accessory), `StatusPill`, `AvatarStack`, `Countdown`, `ProgressRing`, `Sheet` (native `formSheet` route), `Toast`, `EmptyState`, `Skeleton`, `TextField`, `SegmentedControl`. Section headers and footnotes are the iOS grouped-list header (uppercase footnote-weight) and footer (footnote colour, sentence case).

### 5.1 Sign-in (`app/sign-in.tsx`)

Stays: Sign in with Apple's own button first; magic-link flow with the "check your email" state; the `safeNext` redirect; the one-line pitch.

Changes: the email section is a `Card` with heading "Or use email" even when Apple is unavailable (`:77-78`); the placeholder is a specific university domain (`:91`); no keyboard avoidance; `Title` is 28 pt.

- Layout: vertically centred stack, `KeyboardAvoidingView`. App name as largeTitle, pitch as body secondary, Apple button, a hairline "or" divider only when Apple is shown, `TextField`, primary `Button`.
- Copy:
  - Title: `Show Up`
  - Pitch: `Pledge a few dollars to be where you said you'd be. Show up and you split what the others forfeit. Miss, and your pledge goes to the pool.`
  - Divider (Apple available): `or`
  - Field label: `Email` · placeholder: `name@example.com`
  - Button: `Email me a sign-in link`
  - Sent state heading: `Check your email` · body: `We sent a sign-in link to {email}. Open it on this phone.` · plain button: `Use a different email`
  - Validation: `Enter a valid email address.` (keep)
- iOS pattern: plain screen, no nav bar, system Apple button. Primitives: `TextField`, `Button`.

### 5.2 Groups list (`app/(app)/groups/index.tsx`)

Stays: pull-to-refresh, Settings in the header, "you started it" detail.

Changes: cards for rows (`:25`); two bottom buttons in a row (`:36-44`); empty state in a card (`:17-20`); header text link.

- Nav bar: large title `Groups`, right item: SF Symbol `gearshape` (label "Settings"), left item none. Second right item: `plus` opening an action sheet `Create a group` / `Join with a code or link` / `Cancel`.
- Rows: `ListRow` with group name (headline), detail `3 members · you started it`, accessory chevron; a trailing `StatusPill` `Check in now` when any of today's instances for that group is open and you have not checked in (data: `useMyGroups` would need the open instance; otherwise omit).
- Empty state (`EmptyState`, icon `person.3`): heading `No groups yet` · body `A group is 2 to 8 friends who keep each other honest. Start one, or join with the link a friend sent you.` · primary `Start a group` · plain `Join with a code`.
- Loading: 3 `Skeleton` rows, not a spinner.
- Error: `QueryState` copy: `Couldn't load your groups.` + `userMessage(error)` + `Try again`.

### 5.3 Create group (`app/(app)/groups/new.tsx`, mode=create)

Stays: name field with 60 max, `createGroup` call, `router.replace` to the group.

Changes: Chip pair as mode switch (`:44-47`); free-text time zone (`:51-58`); no Cancel in the modal header.

- Presented as `formSheet`; nav bar title `New group`, left `Cancel`, right `Create` (disabled until name ≥ 2 chars; replaces the bottom button).
- Section 1: `TextField` label `Name`, placeholder `Morning crew`, autofocus.
- Section 2, one `ListRow`: title `Settles up in`, detail `{zone display name, e.g. Pacific Time}`, accessory chevron opening a searchable time-zone picker (device zone preselected). Footnote: `Every Monday at noon in this zone, the week's forfeits are totalled and everyone gets a Venmo link for what they owe.`
- Validation copy: `Give the group a name.` (keep). Zone picker makes the "Unknown time zone" error unreachable; keep the `lib/errors.ts` mapping for safety.
- Primitives: `Sheet`, `TextField`, `ListRow`.

### 5.4 Join by code / link (`groups/new.tsx` mode=join and `join/[code].tsx`)

Stays: `inviteCodeFromUrl` accepting both forms; the privacy sentence (good); "Not now".

Changes: `Body` reading `Invite code {code}` as the headline (`join/[code].tsx:32`) because the group name is unknown pre-join (RLS). Mode switch via chips.

- Join by code (sheet): title `Join a group`, `TextField` label `Invite link or code`, placeholder `Paste the link or type the code`, `autoCapitalize="none"`, paste button inside the field. Right nav item `Join`. Footnote: `Groups hold up to 8 people. Joining shows the group your check-in results, never your location.`
- Join from link (pushed screen, title `Invitation`): `EmptyState` icon `envelope.open`: heading `You're invited` · body `Code {code}. Join to see the group's pacts and set your own place for each one. The group sees whether you made it, never where you are.` · primary `Join group` · plain `Not now`.
- Errors (from `lib/errors.ts`, keep): `That invite code doesn't match any group.` · `That group is full (8 members max).`

### 5.5 Group home (`app/(app)/groups/[groupId]/index.tsx`)

Stays: `useNow` for live countdowns (move to the countdown component only), `Share.share` invite text (`:74-77`), leave confirmation copy, pact row detail text (`:118-121`), "Set your place to join" as a concept.

Changes: button-row nav (`:96-100`); per-member pills (`:47-51`); `summary.label` as plain body; "Members (3/8)" heading with a comma list (`:127-129`); `New pact` and `Leave group` as free-floating buttons.

- Nav bar: inline title `{group.name}`; right items `square.and.arrow.up` (Invite) and `ellipsis.circle` opening a menu: `Feed`, `Settle up`, `Leave group…` (destructive). Feed and Settle up also appear as a two-row `ListRow` group under Today so they are discoverable without the menu (`Feed` with detail `2 open reviews` when any; `Settle up` with detail `You owe $5.00` / `You're owed $3.20` / `Nothing to settle`).
- Section `TODAY`:
  - One `Card` per instance (this is the one place a card is right; it is a live object, not a list item). Title `{pact.title}` headline. Right: `ProgressRing` with `{checkedIn}/{total}` inside, filled proportionally. Below: `AvatarStack` of participants, each avatar with a state dot: green = at place, grey ring = waiting, amber = weak GPS / not there yet, dash = frozen. Tap the stack to see names and states in a popover-style sheet.
  - Timing line (`Countdown` in secondary colour): before `Opens 8:00 AM` · open `14:32 left · by 9:00 AM` · closed `Closed 9:00 AM`.
  - Status line: `2 of 4 checked in` (keep `summary.label`), replaced by `Everyone's in` when `checkedIn === total && total > 0`, `Nobody yet` when `checkedIn === 0`.
  - Action: when you are a participant and the window is open and you are not in: full-width primary `Check in`. Before the window: secondary `Opens in 12:04` (tappable, pushes check-in). After you are in: no button; your avatar shows the dot, status line says `You're in · 2 of 4`.
  - Frozen: `StatusPill` `Frozen` on your avatar, no button.
  - Empty: `Nothing today. Next: {pact} {Tue} by 9:00 AM.` (compute from `nextOccurrence`; else `Nothing scheduled this week.`)
- Section `PACTS`: `ListRow` per pact: title, detail `Weekdays · by 9:00 AM · $5.00 pledge`, trailing `StatusPill` `Paused` or `Set your place` (tinted, the row pushes straight to the place picker in that case). Footer row `New pact…` (tinted, plus icon). Empty: `No pacts yet. A pact is a place, a deadline and a pledge, like "Kane Hall by 9:00, weekdays".`
- Section `MEMBERS · 3 OF 8`: `ListRow` per member with avatar, name, detail `owner` where applicable; last row `Invite code {code}` with a `doc.on.doc` copy accessory, and footnote `Share the link or the code. Anyone with it can join until the group has 8 people.` Below, a destructive plain row `Leave group`.
- Leave alert (keep as alert, it is destructive): title `Leave {group.name}?` · body `You'll leave its pacts too. Anything you still owe or are owed stays visible in Settle up until it's paid.` · `Cancel` / destructive `Leave`.
- Primitives: `Card`, `ProgressRing`, `AvatarStack`, `Countdown`, `ListRow`, `StatusPill`, `EmptyState`.

### 5.6 Pact creation wizard (`app/(app)/groups/[groupId]/new-pact.tsx`)

Stays: three steps, step validation copy, the default weekdays 8:00 → 9:00 $5, the next-occurrence preview, the pledge explanation (`:154-157`, keep verbatim), `router.replace` to the place picker.

Changes: "Step 1 of 3: What" as body text (`:99-101`); seven `Chip`s with `accessibilityRole="checkbox"` (acceptable multi-select, keep but restyle as a 7-segment day strip); `TimeStepper`; time zone field; pledge text field; Back/Next inside the scroll.

Presented as `formSheet`. Nav bar: title changes per step, left `Cancel` (step 1) / `Back`, right `Next` / `Create`. A 3-dot page indicator under the title. Errors appear inline under the offending control, not at the bottom.

- **Step 1, title `What's the pact?`**
  - `TextField` label `Title`, placeholder `9am class`, autofocus.
  - Section `DAYS`: day strip `M T W T F S S` (44 pt cells, multi-select, selection haptic). Quick row of three `StatusPill`-style toggles: `Weekdays` · `Weekends` · `Every day`.
  - Footnote: `Everyone picks their own place next, so one pact can cover different buildings.` (keep)
  - Validation: `Give the pact a title, like "9am class".` · `Pick at least one day.` (keep)
- **Step 2, title `When?`**
  - `ListRow` `Deadline` with inline native time picker (compact), default 9:00 AM.
  - `ListRow` `Check-in opens` with compact time picker, default 60 min before; footnote `You can check in from {open} until {deadline}. Default is an hour before.`
  - `ListRow` `Time zone`, detail `{display name}`, chevron to the picker. Only shown expanded if the device zone differs from the group's settlement zone; otherwise a footnote `Times follow {Pacific Time}, including daylight-saving changes.`
  - Preview as a headline-weight line, not muted: `First day: {Mon, Nov 10} by 9:00 AM`.
  - Validation: `The window must open before the deadline on the same day.` (keep)
- **Step 3, title `Pledge`**
  - Currency `TextField` with a leading `$`, decimal pad, default `5.00`, label `Per missed day`. Quick row `$2` `$5` `$10` `$20`.
  - Footnote: `Between $0.01 and $100.00. Charged only on days you miss; unverified days never cost anything.`
  - Summary group (one `Card`): `{title}` headline; `{Weekdays}, {8:00 AM} to {9:00 AM}`; `Pledge {$5.00} per missed day`; then the kept paragraph: `Miss a day and your pledge is forfeited to the pool, which is split among everyone who showed up. If nobody shows up, the pool carries over. Balances settle up weekly on Venmo.`
  - Validation: `Enter a dollar amount like 5 or 2.50.` · `Pledge must be between $0.01 and $100.00.` (keep)
- After create: `Toast` `Pact created. Now set your place.` then the place picker; the picker's first line explains that each person sets their own.
- Primitives: `Sheet`, `TextField`, `ListRow`, `SegmentedControl` (day strip), `Card`, `Toast`.

### 5.7 Place picker (`app/(app)/pacts/[pactId]/place.tsx`)

Stays: current-location-plus-radius model, 75 m default, the "fuzzy fix" hint (`:142`), the "Bigger circles forgive indoor GPS drift" sentence (`:145`), the `NextWindowPlace` logic, `Linking.openSettings()`.

Changes: raw coordinates (`:138`); label field after the capture (`:148`); 12-hour rule only as a muted line (`:127`); the open-window refusal discovered on save (`lib/errors.ts:98`); `RadiusSlider` on `PanResponder` with 36 pt buttons.

- Nav bar title `Your place` (inline). Intro (body): `Stand where you need to be, like your seat in Kane Hall, then capture it. You're in when your GPS fix lands inside this circle.`
- Primary `Button` `Use my current location` → `Re-capture` after a fix. Locating label `Finding you…` with the ring pulse.
- Capture result `Card`: headline `Captured` · detail `Accurate to about {12} m` · when accuracy > 50: footnote `That's a rough fix. Try again near a window or just outside the entrance.`
- Section `CIRCLE`: platform `Slider` 25–500 m step 5, value label `{75} m` in tabular numerals, 44 pt `−25` / `+25` buttons. Footnote: `Bigger circles forgive indoor GPS drift; smaller ones are stricter. Your fix counts if its uncertainty circle touches this one.`
- `TextField` label `Name`, placeholder `Kane Hall 120`.
- Rules, as footnotes under the Save row:
  - First join: `Takes effect right away.`
  - Changing: `New places apply to check-in windows that open 12 or more hours from now. Until then you're judged against {old label}.`
  - A window is open right now (`upcoming` has an instance with `windowState === 'open'` and you are on its roster): Save disabled, footnote `You can't change your place while today's check-in window is open. Try again after {9:00 AM}.`
- Save button: `Join with this place` / `Save place`. Saved state replaces the button with a `ListRow` `Next window: {Mon, Nov 10 at 8:00 AM} · {Kane Hall 120} ({75} m)` and footnote when the change is deferred: `{New place} applies from {Tue, Nov 11 at 8:00 AM}.` Right nav item `Done`.
- Permission denied: inline `EmptyState` `Location is off for Show Up` · body `Setting a place needs your location once. Allow "While Using the App".` · `Allow location` (re-prompt) or `Open Settings` when blocked.
- Primitives: `Button`, `Card`, `Slider` (platform), `TextField`, `ListRow`, `EmptyState`.

### 5.8 Pact detail (`app/(app)/pacts/[pactId]/index.tsx`)

Stays: pause switch with its gloss (`:71-79`), freeze confirmation (`:44-57`), participants with label and radius, upcoming list, "Set my place and join".

Changes: four `Card`s; freeze as a ghost button per upcoming row; "Time zone America/Los_Angeles" line.

- Nav bar: inline title `{pact.title}`, right `ellipsis.circle` menu: `Pause pact` / `Resume pact`, `Change my place`.
- Section header-less summary `ListRow`s: `Weekdays · 8:00–9:00 AM` with detail `{Pacific Time}` only when it differs from the device; `Pledge $5.00 per missed day`; `Paused` row with the `Switch` and footnote `Paused pacts skip their days until resumed. Days already in progress still count.`
- Section `WHO'S IN · 3 OF 4 MEMBERS`: `ListRow` per participant: avatar, name, detail `{Kane Hall 120} · {75} m`. Members of the group who have not joined appear greyed with detail `No place yet`. Footer row: `Set my place and join` (tinted) or `Change my place`.
- Section `UPCOMING`: `ListRow` per instance: title `{Mon, Nov 10}` detail `by 9:00 AM`, trailing `StatusPill` `Frozen` / `Void` / `Open now` (tinted, row pushes check-in). Swipe action (leading, grey) `Freeze` on scheduled future days you have not frozen; also in the row's context menu. Footnote: `A freeze means a day doesn't count for or against you. One per week per pact, declared before the window opens.`
- Freeze alert (keep): title `Freeze {Mon, Nov 10}?` · body `That day won't count for or against you. You have one freeze per week for this pact.` · `Cancel` / `Freeze`.
- Empty upcoming: `Days appear here up to a week ahead.` (keep)

### 5.9 Check-in (`app/(app)/checkin/[instanceId].tsx`)

Full spec in section 6. Summary of what changes on this route: one object on the screen (countdown + button + one status line) above the fold; the verdict replaces the status line; everything else (your taps, target, freeze, result) moves below the fold into one grouped list.

### 5.10 Feed (`app/(app)/groups/[groupId]/feed.tsx`)

Stays: `reviewActions` gating, photo evidence, the review form reasons (`:70`), the vote tally, "Voting open" / "Upheld" / "Turned down" labels, `View photo`.

Changes: intro paragraph (`:240-243`); `Excluded this month` first (`:244-253`); card-in-card reviews; `Agree` / `Disagree`; `Appeal` and `Challenge` as always-visible buttons.

- Nav bar: inline title `Feed`. Section per day: header `{MON, NOV 10} · {9AM CLASS}` (date and pact), one `ListRow` per participant: avatar, name, trailing `StatusPill` with the result. Row detail for money: `+$3.33` (green only when positive and settled), `-$5.00` (label colour), `No money moved` for unverified / frozen / void / excluded. Rows with an open review carry a `bubble.left` accessory and expand inline.
- Result pills (`status.ts`): `Showed up` green · `Missed` red · `Unverified` neutral grey (not amber) · `Frozen` grey · `Void` grey · `Excluded` grey · `Pending` grey outline.
- Actions: on your own `Missed` row, a swipe action and context-menu item `Appeal…`; on others' `Showed up` / `Unverified`, context-menu `Challenge…`. A row with an available action also shows a small tinted text button so it is discoverable: `Appeal` / `Challenge`.
- Review (inline expansion under the row):
  - Appeal: `{You} appealed: "{reason}"` · `Challenge: {Sam} challenged: "{reason}"`.
  - Status line: `Voting open · 1 says they showed up, 0 say they didn't` / `Upheld` / `Turned down` / `No votes, so {excluded / result stands}`.
  - Vote buttons (appeal): primary `They showed up` · secondary `They didn't`. (Challenge): primary `They didn't show up` · secondary `Result stands`. After voting: `You said they showed up · Change`.
  - Footnote under an open appeal: `If nobody votes by Monday noon, the day is excluded: no pledge moves either way.` Under an open challenge: `If nobody votes by Monday noon, the result stands.`
- Review form (`formSheet`): title `Appeal {Mon, Nov 10}` / `Challenge {Sam}'s {Mon, Nov 10}`; `TextField` multiline label `What happened?` placeholder `I was in the back row, GPS put me in the courtyard.` (appeal) / `They left the building before 9.` (challenge); `Add a photo` row (appeal only) → `Photo attached · Change`; right nav `Send`. Validation: `Say briefly what happened.` (keep).
- Excluded counts: a footnote under the Members section on group home: `Excluded this month: {Sam} 1.` Not a card in the feed.
- Empty: `No results yet. Days show up here after their deadline.`
- Keep the one-line rule somewhere findable: a footnote at the bottom of the feed: `Missed a day you actually made? Appeal it. Something look off? Challenge it. The group votes before Monday's settle-up.`

### 5.11 Ledger / Settle up (`app/(app)/groups/[groupId]/ledger.tsx`)

Stays: `groupOpenObligations` split (mine / others), week grouping, Venmo note `Show Up pool, week of {date}`, mark paid → confirm → dispute flow, the dispute alert.

Changes: everything visual. Rename the route title to `Settle up` (the word "Ledger" is code vocabulary; CLAUDE.md allows "pool" and "settle-up" in copy).

Exact copy is in section 8. Structure:

- Header block (not a heading): `You owe $5.00` / `You're owed $3.20` / `You're settled up` as title2, with footnote `Settled every Monday at noon {Pacific}.`
- Section `TO PAY` (mine, payer): `ListRow` per obligation: avatar, `{Sam}`, detail `Week of Nov 3`, trailing amount; swipe action `Mark paid`; row tap opens a `Sheet` with `Pay $5.00 on Venmo` (primary) and `I paid another way` (secondary) and footnote.
- Section `TO RECEIVE` (mine, payee): rows with `StatusPill` `Marked paid` when applicable; swipe actions `Confirm` (green) and `Not received`.
- Section `BETWEEN OTHERS`: read-only rows.
- Section `RUNNING BALANCE`: one row per member with the signed amount in label colour (tabular numerals), footnote explaining what it includes.
- Empty before the first settlement: `EmptyState` `Nothing to settle yet` · `The first settle-up runs Monday at noon. Until then, this week's results are only in the running balance.`

### 5.12 Settings (`app/(app)/settings.tsx`)

Stays: fields, Venmo normalisation message, notifications switch with its gloss, queued count, sign-out.

Changes: `Save` button and "Saved." (`:103-104`); cards; full-width red sign-out (`:130`).

- Inset grouped list. Section `PROFILE`: `TextField` rows `Name` and `Venmo` (placeholder `@username`, autosave on end-editing, inline validation `Venmo usernames are 5 to 30 letters, numbers, - or _.`). Footnote: `Friends use your Venmo to pay you at settle-up. Leave it blank and they'll pay you however you agree.`
- Section `NOTIFICATIONS`: `Switch` row `Notifications`; footnote `When a window opens, 15 minutes before a deadline, results, reviews and settle-up.` When denied: footnote `Notifications are off in iOS Settings.` with a tinted `Open Settings` row.
- Section `OFFLINE`: shown only when `queued > 0`: row `{1} check-in waiting to send` with detail `Sends when you're back online` and a `Send now` action (calls `kickQueue`).
- Bottom: plain destructive row `Sign out`.

### 5.13 Auth callback (`app/auth-callback.tsx`)

Stays: logic. Change the failure screen to an `EmptyState`: heading `Couldn't finish signing in` · body `{userMessage(error)}` · primary `Back to sign in`. Specific messages: missing code → `This sign-in link is missing its code. Request a new one.` (keep); expired → map Supabase's `otp_expired` to `This link has expired. Links work once, for an hour.`

### 5.14 Not-configured screen (`app/_layout.tsx:27-37`)

A developer screen; keep it blunt but mark it as such so a TestFlight tester does not think the app is broken: heading `Setup needed (developer)` · body as today. No user-facing redesign.

### 5.15 Offline-queue events (`app/(app)/_layout.tsx:29-43`)

Replace all three `Alert.alert` calls with a `Toast` (top edge, slides in from the top, 4 s, swipe up to dismiss, tap opens `/checkin/{instanceId}`), and write the same text into a local "notices" list the feed shows at the top for 24 h.

- sent / in_fence: `Offline check-in delivered · You were at your place for {pact}. It counts as unverified if it arrived after 9:00 AM.` (The second sentence only when `server_received_at > deadline_at`; the client knows `deadline_at` from the cached instance.)
- sent / out_of_fence: `Offline check-in delivered · You were outside your circle for {pact}, so that day stands as missed. Appeal it in the feed if that's wrong.`
- sent / unjudgeable: `Offline check-in delivered · GPS was too weak to judge, so {pact} counts as unverified. No pledge moves.`
- sent / rejected_simulated: `Offline check-in not counted · That location looked simulated.`
- rejected: `Offline check-in not accepted · {userMessage}` (the mapped copy from `lib/errors.ts`).
- expired: `Offline check-in couldn't be sent · It never reached the server within 24 hours, so {Mon, Nov 10} stands as recorded. If you were there, appeal it in the feed.`

---

## 6. The check-in moment spec

### Decision: single tap, not press-and-hold

Frequency gate: this happens about once a day per person, the "occasional" tier, so it earns a standard animation and a haptic, but not friction. Press-and-hold is for actions whose accidental trigger is costly. An accidental check-in tap is free: it records one fix, the first in-fence tap wins, retries are capped at 20 and a wrong tap can be followed by a right one. Against that, the realistic failure is the opposite: a student at 8:59:40 with one hand on a door. Every extra 800 ms of hold is a chance to miss the window. Tap. (Recorded as a UI-overhaul default in `docs/DECISIONS.md`.)

### Layout at 393 × 852

Top to bottom, inside the safe area, inline nav title `{pact.title}`:

1. y 100–130: date line, subheadline secondary: `Mon, Nov 10 · Kane Hall 120 · 75 m`.
2. y 150–220: `Countdown`, 56 pt, semibold, `fontVariant: ['tabular-nums']`, `maxFontSizeMultiplier: 1.4`, centred; a 15 pt footnote beneath it (`until 9:00 AM`).
3. y 300–540: the button, a 240 pt circle centred horizontally (x 76–316), centre at y 420. This puts the whole circle inside the one-handed thumb reach of a 6.1" phone.
4. y 560–600: one status line, 17 pt body, centred, 2 lines max. Before a tap: `Your location is read once, when you tap.` This line is replaced by the verdict.
5. y 620–700: secondary row: `Freeze today` plain button (before the window only), or `Tap again if you've moved closer` after an out-of-fence verdict.
6. Below the fold, one inset grouped list: `TODAY'S TAPS` (time · label · accuracy), `RESULT` once posted, `YOUR PLACE` (label, radius, footnote `Judged against the place in force when the window opened.`).

Nothing is a card except the verdict panel, which is the status line growing into a 2-line panel with the result pill.

### Countdown

- Before the window: `Opens in 12:04` as the big line, footnote `8:00 AM · window until 9:00 AM`.
- Inside the window: `14:32` as the big line, footnote `left · by 9:00 AM`. Hours shown only when ≥ 1 h: `1:14:32`.
- Last 60 s: the big line drops the minutes and shows `0:42`, the digits take the warning colour, the footnote reads `Tap now. Your tap time is what counts.` (D29: the earlier of tap and fix is the claimed time.)
- After the deadline: `Closed` as the big line, footnote `Deadline was 9:00 AM`; the result pill appears in the status line as soon as `myResult` exists, else `Result posts within a minute.`
- Reduced motion: identical; the countdown never animates digits.
- The count updates in a `Countdown` component with its own `useNow`, so the rest of the screen does not re-render per second.

### The button

240 pt circle, label 24 pt semibold, tint fill, white label. States:

| State | Fill | Label | Enabled |
|---|---|---|---|
| disabled-before-window | secondary fill (grouped background 2), label colour secondary | `Opens in 12:04` (small `Opens in` over the time) | no (announces "dimmed") |
| idle | tint | `Check in` | yes |
| pressed | tint, `scale 0.97` | `Check in` | — |
| locating | tint, outer ring pulsing | `Finding you…` with footnote under the circle `Up to 25 seconds. Your tap at 8:58 is locked in.` | no |
| sending | tint, ring solid | `Sending…` | no |
| done (in_fence) | success green | `You're in` with checkmark SF Symbol | yes, secondary (a second tap does nothing harmful; keep it to let someone re-verify) |
| frozen | secondary fill | `Frozen` | no |
| closed | secondary fill | `Closed` | no |
| not a participant | hidden; status line `You haven't joined this pact.` with a tinted `Set my place` link | — |

Hit area is the circle; `pressRetentionOffset` 20. No disabled-at-50 %-opacity anywhere: the pre-window button is a distinct neutral state with full-contrast text.

### The result reveal, per verdict

The status line crossfades out (120 ms) and the verdict panel enters (spring below). Exact copy:

- **in_fence**: pill `Showed up` · headline `You're in` · body `Counted at 8:58 AM. 3 of 4 so far.`
- **out_of_fence**: pill none · headline `Not inside your circle yet` · body `About 140 m from the centre of Kane Hall 120 (circle is 75 m, GPS ±18 m). Get closer and tap again.` Footnote: `Only your best tap counts.`
- **unjudgeable** (weak GPS, > 200 m or no accuracy): headline `GPS too weak to judge` · body `Accuracy was ±320 m, more than the 200 m limit. Try again near a window. If nothing better lands, today is unverified: no pledge moves.`
- **rejected_simulated**: headline `Location rejected` · body `That location looked simulated, so it wasn't counted. A simulated fix counts as a miss.` (D4)
- **queued offline**: headline `Saved, will send` · body `No connection. Your tap at 8:58 is saved with its GPS fix and sends itself when you're back online. If it lands after 9:00 and you were inside your circle, today is unverified: no pledge moves.` (D6, CONTRACT "Result per participant")
- **no fix** (attempt sent with null coordinates): headline `No GPS fix` · body `Your tap was recorded without a location, so at worst today is unverified, which never costs you. Try again for a tap that counts.` Secondary button `Try again`.

### Haptics (expo-haptics; one per user action, same frame as the visual)

| Moment | Call | Visual it pairs with |
|---|---|---|
| Finger down on Check in | `Haptics.impactAsync(ImpactFeedbackStyle.Light)` | scale to 0.97 |
| in_fence verdict arrives | `Haptics.notificationAsync(NotificationFeedbackType.Success)` | fill turns green, panel enters |
| out_of_fence / unjudgeable / queued / no fix | `Haptics.notificationAsync(NotificationFeedbackType.Warning)` | panel enters |
| rejected_simulated / server rejection | `Haptics.notificationAsync(NotificationFeedbackType.Error)` | panel enters |
| Freeze confirmed | `Haptics.impactAsync(ImpactFeedbackStyle.Medium)` | pill `Frozen` appears |

No haptic on locating, sending, countdown ticks, or the last-60-s colour change.

### Springs and easing

- Press: Reanimated CSS transition on `transform`, 120 ms, `Easing.bezier(0.23, 1, 0.32, 1)`, scale 0.97 on press-in, back on release.
- Fill colour change (tint → green, tint → neutral): CSS transition on `backgroundColor`, 200 ms, same ease-out.
- Locating ring: a childless absolutely-positioned ring 8 pt outside the circle, CSS keyframe `opacity 0.35 → 1 → 0.35`, 1200 ms, `Easing.bezier(0.77, 0, 0.175, 1)`, infinite. Stops (opacity to 1, 150 ms) on `sending`.
- Verdict panel entrance: `opacity 0 → 1`, `translateY 8 → 0`, `scale 0.97 → 1`, `withSpring(1, { duration: 400, dampingRatio: 1, reduceMotion: ReduceMotion.System })`. No overshoot: no finger carried momentum into it.
- Status line exit: opacity 1 → 0, 120 ms ease-out, then unmount.
- Last-60-s colour: CSS transition on `color`, 300 ms.
- The circle never changes size by state. No `scale(0)` entrances anywhere.

### What "2 of 4 checked in" does when you succeed

On group home (and in the below-fold list on this screen when it is shown): your avatar's dot crossfades to green (200 ms), the `ProgressRing` arc fills from 1/4 to 2/4 over 300 ms `Easing.bezier(0.23, 1, 0.32, 1)`, the label crossfades `1 of 4 checked in` → `2 of 4 checked in` (120 ms). No count-up digits, no confetti, no sound. If everyone is in, the ring closes and the label reads `Everyone's in`. Reduced motion: the arc jumps, the crossfades stay.

### Reduced motion

Keep: colour changes, opacity crossfades, the ring's opacity pulse (it is opacity only). Drop: the panel's translateY and scale (opacity only), the press scale (use the opacity dim 0.85 instead). Screen push uses the native stack default, which iOS already crossfades under Reduce Motion.

### VoiceOver

- Countdown element: `accessibilityLabel` recomputed once a minute (`"14 minutes left, deadline 9 AM"`), and at 60 s (`"One minute left"`). Not a live region: a per-second live region is unusable.
- Button: label `Check in`; hint `Reads your location once and sends it`; `accessibilityState: { disabled, busy }`; pre-window label `Check-in opens in 12 minutes`.
- On verdict: `AccessibilityInfo.announceForAccessibility(headline + '. ' + body)` on iOS (replace the Android-only `accessibilityLiveRegion` at `checkin/[instanceId].tsx:137`).
- Focus: after the verdict panel enters, `AccessibilityInfo.setAccessibilityFocus` on the headline.

---

## 7. Failure states

For each: copy, visual treatment, whether money is at risk, recovery. "Never costs you" is only written where CONTRACT.md guarantees it.

| State | Copy (headline · body) | Treatment | Money at risk? (rule) | Recovery |
|---|---|---|---|---|
| Permission: first ask | iOS prompt text (`app.config.ts` `LOCATION_WHEN_IN_USE`, keep). Before the prompt, a pre-prompt panel on first check-in: `Location, once per tap` · `Show Up reads your location only when you tap Check in during a window. Never in the background.` · button `Continue` | panel in place of the status line | None yet | Continue → system prompt |
| Permission: denied, can ask again | `Location is off for Show Up` · `Without location, a tap can't be judged and today counts as missed. Allow "While Using the App" to check in.` | neutral panel, primary `Allow location` (re-runs the request), plain `Not now` | **Yes.** Nothing is sent (D30); no check-in = `failed` | Allow location |
| Permission: blocked | same headline · `Location is turned off for Show Up in iOS Settings. Turn it on, then come back and tap Check in.` | primary `Open Settings` | **Yes** (same) | Settings; the screen re-checks on foreground |
| No GPS fix (timeout 25 s / no position) | `No GPS fix` · `Your tap at 8:58 was recorded without a location, so at worst today is unverified, which never costs you. Try again for a tap that counts.` | panel, secondary `Try again` | No (D15; `unjudgeable` → `unverified`) | Try again |
| Weak GPS (> 200 m) | `GPS too weak to judge` · `Accuracy was ±320 m; the limit is 200 m. Try near a window. If nothing better lands, today is unverified: no pledge moves.` | panel | No (D5) | Tap again |
| Out of fence | `Not inside your circle yet` · `About 140 m from the centre (circle 75 m, GPS ±18 m). Get closer and tap again.` | panel, no colour | **Yes** if it stays the only tap (`failed`) | Move, tap again |
| Offline at tap | `Saved, will send` · `No connection. Your tap at 8:58 is saved with its fix and sends itself when you're back online. If it lands after 9:00 and you were inside your circle, today is unverified: no pledge moves.` | panel, footnote `Open the app once you have signal to speed it up.` | No if in-fence (D6); **yes** if the saved fix was out of fence (D27) or never arrives in 24 h | Foreground the app; Settings › Offline › `Send now` |
| Queued check-in delivered later | `Toast` texts in 5.15 | toast + feed notice | Depends on verdict, stated in the toast | Tap toast → day |
| Late: window closed while locating | panel: `Sent after the deadline` · `Your tap was at 8:59:50, which is what counts. Because it reached us at 9:00:05, today is unverified: no pledge moves.` | neutral panel | No (`in_fence` with `server_received_at > deadline_at` and `client_captured_at <= deadline_at` → `unverified`) | None needed; footnote `A friend can challenge an unverified day in the feed.` |
| Late and out of fence | `Not inside your circle` · `Your tap arrived after the deadline and was outside your circle, so today stands as missed.` | panel | **Yes** (D27) | Appeal in the feed |
| Simulated location | `Location rejected` · `That location looked simulated, so it wasn't counted. A simulated fix counts as a miss.` | panel, error haptic | **Yes** by design (D4) | Turn off the mock, tap again |
| Server: cap of 20 | `That's enough taps for today` · `You've checked in 20 times for this day. Your earlier taps still count.` (replace `CHECKIN_CAP_MESSAGE` in `lib/errors.ts:23`) | panel, button disabled | No new risk; earlier verdicts stand | — |
| Server: not a participant | `You're not counted for this day` · `Only people who joined before its window opened take part.` (keep `lib/errors.ts:44`) | panel | None (not on the roster) | `Set my place` for next time |
| Server: frozen | button state `Frozen`; status `You froze today. It counts for nothing either way.` | neutral | None | — |
| Server: window closed / day cancelled | `The check-in window is closed.` / `This day was cancelled because the pact is paused.` (keep) | panel | none new | — |
| Slow network (> 15 s) | button `Sending…` then falls into the offline path; footnote during sending: `Slow connection. Your tap time is already saved.` | ring solid | as offline | Automatic retry (`checkinQueue` backoff, attempt id dedupes per D14) |
| Session expired | `Your session expired. Sign in again.` (keep) with primary `Sign in`; the attempt is still queued locally | panel | as offline | Sign in → queue flushes |

---

## 8. Money clarity

Vocabulary: pledge (what you put up per missed day), forfeit (a pledge you lost), pool (where forfeits go on a day), carry-over (a pool nobody won, held for the next winning day), settle-up (Monday's totalling into Venmo payments). Never bet / stake / pot / wager / rake. Current UI copy is clean; "Ledger" as a screen title is the one code word leaking into the UI (`(app)/_layout.tsx:68`, `groups/[groupId]/index.tsx:98`), rename to **Settle up**.

Explain each concept once, at the point of use, as a grouped-section footnote (iOS has no hover tooltip; the footer under an inset grouped section is the native "tooltip"). Exact copy:

**Settle-up header (title2 + footnote)**
- Owe: `You owe $5.00` · footnote `From the week of Nov 3. Pay on Venmo, then mark it paid; {Sam} confirms and it's done.`
- Owed: `You're owed $3.20` · footnote `{Sam} pays you on Venmo. Confirm when it lands.`
- Settled: `You're settled up` · footnote `Next settle-up: Monday at noon {Pacific}. Only days before Monday are included, so Monday-morning results get their review time.`

**Obligation row**
- As payer: avatar · `Sam` · detail `Week of Nov 3 · 1 missed day` · trailing `$5.00` · pill `Unpaid` (neutral, not amber) → `Marked paid` → `Confirmed` (green). Tap → sheet: title `Pay Sam $5.00`; primary `Pay on Venmo`; secondary `I paid another way`; footnote `Opens Venmo with the amount and note filled in. After you pay, come back and mark it paid so Sam can confirm.` When Sam has no Venmo: body `Sam hasn't added a Venmo username. Pay however you both like, then mark it paid.`
- As payee: `Sam` · detail `Week of Nov 3` · trailing `$5.00` · pill `Waiting` → `Marked paid` with swipe/buttons `Confirm` / `Not received`. Footnote under the section: `Confirming records the payment in the group. "Not received" sends it back to unpaid so they can pay again.`
- Dispute alert (keep structure): `Didn't receive $5.00 from Sam?` · `This sends it back to unpaid so Sam can pay again. Nothing is deleted.` · `Cancel` / destructive `Not received`.

**Settlement notice (push payload `settlement` and the toast on open)**
- `Settle-up for the week of Nov 3` · `You owe $5.00 to Sam. Tap to pay on Venmo.` / `You're owed $3.20 from Sam.` / `You're settled up this week.`

**Superseded obligations** (pill `Replaced`, shown only in a collapsed `Earlier` group): footnote `Unpaid amounts roll into the next Monday's settle-up, so you only ever pay one total per friend. Anything you'd already marked paid stays until it's confirmed.` (D7)

**Correction line** (a feed row and a settle-up footnote when a correction entry exists for the week): `Correction · Mon, Nov 10 · Sam's appeal was upheld, so that day's $5.00 forfeit was returned and the pool re-split. The difference shows in next Monday's settle-up.` Generic form: `Correction · {date} · {reason}. The difference is included in next Monday's settle-up; nothing you've already paid is changed.` (CONTRACT "Corrections", D21)

**Running balance section footnote**: `What the group would owe each other if settle-up ran right now, including this week. Plus means the group owes you. Forfeits sitting in a carry-over pool aren't owed to anyone yet.`

**Unverified, everywhere it appears** (feed row detail, verdict panel, result section): `Unverified · no money moved`. The rule sentence, once, as the feed footnote: `Unverified means the app couldn't judge a tap (weak GPS, no fix, or a late offline send). It never costs a pledge and never wins one.`

**Carry-over** (today card footnote when `carry_in_cents > 0`, and in the feed day header): `Pool carried over: $10.00 from days nobody made it. Whoever shows up today splits it.`

**Pledge** (wizard step 3 and pact detail footnote): `Your pledge is what you forfeit to the pool on a day you miss. Show up and you split the pool with the others who did.`

**Frozen / Void / Excluded** (one footnote under the result section): `Frozen: you called the day off in advance. Void: fewer than two people were active, so nothing counts. Excluded: the group's review took you out of the day. None of these move money.`

---

## 9. Motion inventory

Vocabulary from the motion contract: `EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1)`, `EASE_IN_OUT = Easing.bezier(0.77, 0, 0.175, 1)`, `EASE_SHEET = Easing.bezier(0.32, 0.72, 0, 1)`; springs `withSpring(t, { duration, dampingRatio, reduceMotion: ReduceMotion.System })`.

| # | Location | Today | Purpose | Frequency | Tool and values |
|---|---|---|---|---|---|
| 1 | Check-in button press (`checkin/[instanceId].tsx:149-154`) | `scale 0.97` with no transition, snaps | Feedback | Occasional (once/day) | CSS transition `transform` 120 ms `EASE_OUT`, haptic Light on press-in |
| 2 | Verdict panel entrance (`:169-179`, currently a card appearing instantly) | Teleports in | Preventing a jarring change | Occasional | `opacity 0→1`, `translateY 8→0`, `scale 0.97→1`, `withSpring({ duration: 400, dampingRatio: 1 })`; reduced motion: opacity only |
| 3 | Locating ring (new) | Label swaps to "Getting GPS…" | State indication | Occasional, up to 25 s | CSS keyframes on `opacity` 0.35→1→0.35, 1200 ms `EASE_IN_OUT`, infinite; stop at `sending` |
| 4 | Toast for queue events (replaces `Alert.alert` at `(app)/_layout.tsx:34-38`) | Modal alert | Spatial consistency | Rare | enter `translateY(-100%)→0` + opacity, 250 ms `EASE_OUT`; exit same edge 200 ms; swipe-up dismiss via `Gesture.Pan` with velocity threshold, `withSpring({ duration: 300, dampingRatio: 0.8, velocity })` snap-back |
| 5 | Today card member dot and ring on a new check-in (`groups/[groupId]/index.tsx:47-51`) | Badge text swaps | State indication | Occasional | dot colour CSS transition 200 ms; ring arc 300 ms `EASE_OUT` (Skia/SVG path, UI thread); label crossfade 120 ms |
| 6 | Every `Button` and `ListRow` press (`ui.tsx:201`) | opacity 0.8 | Feedback | Tens/day | CSS transition `transform` scale 0.97, 100 ms `EASE_OUT` (under the 150 ms cap for this tier); no haptic |
| 7 | Review form / pay sheet presentation | `Alert` or inline expansion | Spatial consistency | Rare | `presentation: 'formSheet'` (native, no custom code) |

Must **not** animate:

- Tab or segment switches (`animation: 'none'`), including the Today / Pacts / Members segment.
- Countdown digits (no flip, no slide, no count-up); only the colour at 60 s.
- Balances and amounts (no count-up, no pulse). Money is read, not watched.
- Any confetti, particle, or celebration on a verdict or a settle-up. The green fill, the haptic and the sentence are the celebration.
- List rows on load or refetch (no stagger, no `entering` on virtualised rows).
- Skeletons: static, no shimmer loop.
- Screen pushes and pops: native stack defaults only.
- The `Switch` for pause and notifications: platform animation only.
- Badges and pills on group home, which re-render every second today; after the fix they re-render only on data change.

---

## 10. "Do not do" list

- No card inside a card (`feed.tsx:160`, `ledger.tsx:146`). Cards only for the today card and the verdict panel; everything list-shaped is an inset grouped list.
- No eyebrow or kicker above a heading (`Step 1 of 3: What` at `new-pact.tsx:99-101` is one; the nav title and a page indicator carry it).
- No headings that explain (`Running balance (includes this week, not settled yet)`). Headings name; footnotes explain.
- No sliding tab transitions; no custom screen transitions.
- No confetti, sound, or animated celebration on money or verdicts.
- No red for `Unverified`, `Frozen`, `Void`, `Excluded`, or a negative running balance. Red is for `Missed` and destructive actions only. No amber "Unpaid" for the payee.
- No modal for check-in. It is a pushed screen with one object on it; push notifications deep-link straight to it.
- No `Alert.alert` for background events, successes, or recoverable errors. Alerts only for destructive confirmations (leave, dispute, freeze).
- No disabled-at-50 %-opacity primary. Pre-window and closed are distinct neutral states with readable labels.
- No raw codes, coordinates, or IANA zone strings in copy (`in fence`, `47.65592, -122.30875`, `America/Los_Angeles`).
- No free-text fields for things the device knows (time zone) or that have a platform picker (time of day).
- No `PanResponder`, core `Animated`, `runOnJS`, or `setState` per frame (`RadiusSlider.tsx:35,44`).
- No hard-coded point sizes or hex colours in screens; tokens and text styles only.
- No text links in the navigation bar; SF Symbols with labels.
- No "Save" button under profile fields; autosave on end-editing with inline validation.
- No per-member pill rows; `AvatarStack` with state dots.
- No press-and-hold on check-in.
- No icon drawn as an emoji or Unicode glyph.
- No shame board at the top of the feed.
- No "Nice.", "Oops", or jokes near money, verdicts or permissions. Warm, plain, specific.
- No sentence that says "never costs you" where the contract does not guarantee it (out of fence, simulated, permission denied, late out-of-fence, expired queue).

---

## 11. Positive findings (keep)

- `lib/errors.ts` is a model of error copy: every SQLSTATE the migrations raise is mapped to a sentence that names the problem and the recovery, raw database text never reaches the UI, and the check-in cap and leave/join window rules are explained in the user's words. Keep it as the single source of error copy and extend it.
- The fail-open rule is already visible in the UI: `checkin/[instanceId].tsx:42,185,193-194` say "unverified, not missed" and "never costs you" in the right places (no fix, queued, weak GPS). The redesign keeps these sentences and adds the cases where money *is* at risk.
- The offline queue is genuinely good engineering (`lib/checkinQueue.ts`): dedupe by instance + fix time, earliest-first, 24 h expiry, serialised flushes, stable attempt ids (D14), tap time captured before the fix (D29). The UI just needs to say so.
- Location is read in exactly two places (`lib/location.ts`, used by check-in and the place picker), the permission string in `app.config.ts` is honest and specific, and the check-in screen says "Your location is read once, right now, and nowhere else." Keep that sentence.
- The pledge explanation at `new-pact.tsx:154-157` is the clearest money paragraph in the app and already uses pledge / forfeit / pool correctly.
- `verdictMessage` (`checkin/[instanceId].tsx:28-48`) gives distance, circle size and GPS accuracy for an out-of-fence tap, which is exactly what a person needs to decide whether to walk ten metres.
- Native pieces used correctly: Sign in with Apple's button, `Switch`, `Share.share`, `RefreshControl`, `Linking.openSettings()`, `presentation: 'modal'` for creation flows, `keyboardShouldPersistTaps="handled"`.
- The place picker already handles the 12-hour rule honestly after save (`NextWindowPlace`, `place.tsx:20-41`): it tells you which place the next window will use and when the new one applies.
- `RadiusSlider` exposes `accessibilityRole="adjustable"` with increment/decrement actions; the replacement slider must keep that.
- Review gating (`lib/reviews.ts`) is correct and simple: one appeal, one challenge, nothing while a review is open or after settlement; the UI only needs clearer verbs.
- The invite flow covers both a deep link and a typed code, and the share text includes both.

---

## 12. Systemic patterns and questions for the founder

Systemic (one fix, many screens):

- **One primitive for everything.** `Card` + `Button` + `Body muted` build 14 of 16 routes. Introducing `ListRow`, `StatusPill`, `AvatarStack`, `Countdown`, `ProgressRing`, `Sheet`, `Toast`, `EmptyState`, `Skeleton`, `TextField`, `SegmentedControl` and then deleting most `Card` uses fixes conformance, hierarchy and consistency at once.
- **Explanation before structure.** Feed, ledger and wizard each open with a paragraph. Moving every explanation into a grouped-section footnote under the thing it explains fixes heuristics 8 and 10 together.
- **Per-second re-render.** One `useNow(1000)` at the screen level (`groups/[groupId]/index.tsx:67`, `checkin/[instanceId].tsx:54`) should become a `Countdown` component with its own clock; nothing else on those screens changes per second.
- **Money states coloured like a bank.** Replacing `colors.danger` for negatives and `warn` for unverified/unpaid with label colour fixes the "feels judged" persona across feed, ledger and today card.
- **iOS announcements.** Every `accessibilityLiveRegion` and every verdict/toast needs `AccessibilityInfo.announceForAccessibility` on iOS; one helper, used in four places.

Questions to consider:

- What if the group home *was* the today card, and pacts and members lived one level down? Most days there is one thing to do.
- Does the first-run owner need a wizard at all, or a single sheet with three rows (title, deadline, pledge) and sensible defaults, with days and window as disclosures?
- Should "Unverified" be shown to the group at all before settlement, or only to the person, since it moves no money and invites challenges on GPS luck? (Open question 5 in DECISIONS.md touches the forged-late-tap case.)
- Is the Monday noon settle-up a push notification with Venmo links, or a screen? If most payments happen from the notification, the screen is a receipt, and should be designed as one.
- Would a confirmed payment read better as a feed event ("Sam paid Priya $5.00 · confirmed") than as a pill on a row that then disappears?
