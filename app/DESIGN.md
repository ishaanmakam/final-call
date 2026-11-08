---
name: Final Call
description: A quiet, trustworthy utility about keeping your word to friends. The one loud moment is the check-in.
colors:
  bg: "#F5F6F8"
  surface: "#FFFFFF"
  surface-elevated: "#FFFFFF"
  fill: "#E9ECF1"
  fill-strong: "#DCE0E7"
  label: "#101418"
  secondary: "#5E6773"
  tertiary: "#7E8793"
  separator: "#D9DEE5"
  tint: "#2B4ACB"
  on-tint: "#FFFFFF"
  tint-soft: "#E6EAFB"
  success: "#187A47"
  success-soft: "#DCF4E5"
  forfeit: "#B42331"
  forfeit-soft: "#FBE3E5"
  unverified: "#8A5A00"
  unverified-soft: "#FBEFD0"
  frozen: "#2F6E9B"
  frozen-soft: "#DCEDF8"
  void: "#5B6472"
  void-soft: "#E7EAEF"
  pending: "#5B6472"
  pending-soft: "#EEF0F3"
  excluded: "#6A4FA3"
  excluded-soft: "#ECE6F7"
  dark-bg: "#0C1017"
  dark-surface: "#161C26"
  dark-surface-elevated: "#1D2432"
  dark-fill: "#1F2632"
  dark-fill-strong: "#2A3240"
  dark-label: "#F3F5F8"
  dark-secondary: "#A6AFBD"
  dark-tertiary: "#7F8896"
  dark-separator: "#2A3240"
  dark-tint: "#8DA2FF"
  dark-on-tint: "#0C1017"
  dark-tint-soft: "#1C2545"
  dark-success: "#4FD08B"
  dark-success-soft: "#113826"
  dark-forfeit: "#FF7B86"
  dark-forfeit-soft: "#44191E"
  dark-unverified: "#F2B544"
  dark-unverified-soft: "#3C2E0D"
  dark-frozen: "#79B8E6"
  dark-frozen-soft: "#15314A"
  dark-void: "#A6AFBD"
  dark-void-soft: "#262D39"
  dark-pending: "#A6AFBD"
  dark-pending-soft: "#222935"
  dark-excluded: "#BFA8F0"
  dark-excluded-soft: "#2C2340"
typography:
  large-title:
    fontFamily: "SF Pro (system)"
    fontSize: "34pt"
    fontWeight: 700
    lineHeight: "41pt"
    letterSpacing: "0.37pt"
  title1:
    fontFamily: "SF Pro (system)"
    fontSize: "28pt"
    fontWeight: 700
    lineHeight: "34pt"
    letterSpacing: "0.36pt"
  title2:
    fontFamily: "SF Pro (system)"
    fontSize: "22pt"
    fontWeight: 700
    lineHeight: "28pt"
    letterSpacing: "0.35pt"
  title3:
    fontFamily: "SF Pro (system)"
    fontSize: "20pt"
    fontWeight: 600
    lineHeight: "25pt"
    letterSpacing: "0.38pt"
  headline:
    fontFamily: "SF Pro (system)"
    fontSize: "17pt"
    fontWeight: 600
    lineHeight: "22pt"
    letterSpacing: "-0.41pt"
  body:
    fontFamily: "SF Pro (system)"
    fontSize: "17pt"
    fontWeight: 400
    lineHeight: "22pt"
    letterSpacing: "-0.41pt"
  callout:
    fontFamily: "SF Pro (system)"
    fontSize: "16pt"
    fontWeight: 400
    lineHeight: "21pt"
    letterSpacing: "-0.32pt"
  subheadline:
    fontFamily: "SF Pro (system)"
    fontSize: "15pt"
    fontWeight: 400
    lineHeight: "20pt"
    letterSpacing: "-0.24pt"
  footnote:
    fontFamily: "SF Pro (system)"
    fontSize: "13pt"
    fontWeight: 400
    lineHeight: "18pt"
    letterSpacing: "-0.08pt"
  caption1:
    fontFamily: "SF Pro (system)"
    fontSize: "12pt"
    fontWeight: 400
    lineHeight: "16pt"
    letterSpacing: "0pt"
  caption2:
    fontFamily: "SF Pro (system)"
    fontSize: "11pt"
    fontWeight: 400
    lineHeight: "13pt"
    letterSpacing: "0.07pt"
rounded:
  xs: "6pt"
  sm: "8pt"
  md: "12pt"
  lg: "16pt"
  xl: "20pt"
  pill: "999pt"
spacing:
  xxs: "2pt"
  xs: "4pt"
  sm: "8pt"
  md: "12pt"
  lg: "16pt"
  xl: "20pt"
  xxl: "24pt"
  xxxl: "32pt"
  huge: "40pt"
  giant: "48pt"
components:
  button-primary:
    backgroundColor: "{colors.tint}"
    textColor: "{colors.on-tint}"
    typography: "{typography.headline}"
    rounded: "{rounded.md}"
    height: "50pt"
    padding: "0 20pt"
  button-secondary:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.label}"
    typography: "{typography.headline}"
    rounded: "{rounded.md}"
    height: "50pt"
    padding: "0 20pt"
  button-tertiary:
    backgroundColor: "transparent"
    textColor: "{colors.tint}"
    typography: "{typography.headline}"
    rounded: "{rounded.md}"
    height: "50pt"
    padding: "0 12pt"
  button-destructive:
    backgroundColor: "{colors.forfeit}"
    textColor: "{colors.on-tint}"
    typography: "{typography.headline}"
    rounded: "{rounded.md}"
    height: "50pt"
    padding: "0 20pt"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "16pt"
  list-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.label}"
    typography: "{typography.body}"
    height: "44pt"
    padding: "10pt 16pt"
  status-pill:
    backgroundColor: "{colors.success-soft}"
    textColor: "{colors.success}"
    typography: "{typography.footnote}"
    rounded: "{rounded.pill}"
    padding: "4pt 10pt"
  text-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.label}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    height: "44pt"
    padding: "10pt 12pt"
  segmented-control:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.secondary}"
    typography: "{typography.subheadline}"
    rounded: "{rounded.sm}"
    height: "36pt"
    padding: "2pt"
  check-in-button:
    backgroundColor: "{colors.tint}"
    textColor: "{colors.on-tint}"
    typography: "{typography.title2}"
    rounded: "{rounded.pill}"
    size: "220pt"
---

# Design System: Final Call

Tokens live in `src/theme/tokens.ts` (the normative source; the frontmatter mirrors it and `src/theme/tokens.test.ts` verifies the contrast claims below). Mode on every surface is **Operate**: the person is in a task, the interface is a working product of its category first, and the world shows through type, palette, density and one signature move.

## Overview

**Creative North Star: "The Roll Call"**

The world: a quiet, trustworthy utility about keeping your word to friends. It is the attendance sheet a good TA keeps: plain, exact, never dramatic, and everyone can read it. Most of the app is still, legible and system-native: inset-grouped lists, one tint, SF Pro at Dynamic Type sizes, hairline cards, state words that say exactly what happened. The one loud moment is the check-in: a 220 pt circle you tap inside a draining ring that is the window's clock, a GPS sweep, and a result that lands with a color, a word and a haptic. Nothing else on any screen competes with that moment.

The world lends four things and only these: the type (SF, tighter weights than the default iOS app), the palette (cool neutrals with a single ultramarine tint and seven state colors), the density (tight groups, generous separation, one action per screen), and the signature move (the check-in ring). Navigation, controls and sheets are iOS's own.

The use scene decides light and dark: walking into a lecture hall at 8:55 in daylight, or glancing at the ledger in bed. Both appearances are first-class; the palette was tuned for each, not inverted.

**Key Characteristics:**
- Quiet by default; one loud, earned moment (the check-in reveal).
- Every result is a word in a tone, never a color alone: *Showed up*, *Missed*, *Unverified*, *Frozen*, *Didn't count*, *Excluded*.
- The reassurance "unverified never costs you" is visible in every failure state.
- Numbers are tabular and exact (cents, seconds). Nothing rounds away.
- Native iOS structure: large titles, inset-grouped lists, form sheets, system transitions.

## Colors

Cool neutrals tinted a touch toward the ink of the tint, a single ultramarine for every interactive thing, and a state vocabulary that reads at a glance without ever being the only signal. Strategy: **Restrained** (neutrals from the world plus one accent), with color doing real jobs: state, selection, the ring, the result.

### Primary
- **Ultramarine Ink** (`#2B4ACB` light / `#8DA2FF` dark): the one tint. Primary buttons, links, selection, the draining ring, "you" rings on avatars. On a tint fill the text is `on-tint` (white in light, near-black `#0C1017` in dark, so the dark tint can stay bright enough to read as text on the dark ground).
- **Tint Soft** (`#E6EAFB` / `#1C2545`): tint-colored things at rest (a selected segment, the check-in button before its window opens).

### Neutral
- **Paper** `bg` (`#F5F6F8` / `#0C1017`): the grouped page ground.
- **Card** `surface` (`#FFFFFF` / `#161C26`) and **Floating** `surface-elevated` (`#FFFFFF` / `#1D2432`): cards and rows; sheets and toasts. In dark mode elevation is a lighter surface, not a shadow.
- **Fill** (`#E9ECF1` / `#1F2632`) and **Fill Strong** (`#DCE0E7` / `#2A3240`): secondary buttons, the segmented track, skeletons, the ring's track.
- **Label** (`#101418` / `#F3F5F8`), **Secondary** (`#5E6773` / `#A6AFBD`, also placeholders), **Tertiary** (`#7E8793` / `#7F8896`, ornaments only: chevrons, grabbers).
- **Separator** (`#D9DEE5` / `#2A3240`): hairlines between rows and around flat cards.

### State colors
Each state is a pair: `fg` for text, icon or stroke, and `soft` for the pill it sits on. The check-in button fills with `fg` after a verdict and uses `on-state` for its label.

| State | Meaning | Light fg / soft | Dark fg / soft |
|---|---|---|---|
| success | Showed up, Checked in | `#187A47` / `#DCF4E5` | `#4FD08B` / `#113826` |
| forfeit | Missed (a verified absence; the pledge is forfeited) | `#B42331` / `#FBE3E5` | `#FF7B86` / `#44191E` |
| unverified | Unverified, Weak GPS, Late, Not there yet, Unpaid | `#8A5A00` / `#FBEFD0` | `#F2B544` / `#3C2E0D` |
| frozen | Frozen, Marked paid | `#2F6E9B` / `#DCEDF8` | `#79B8E6` / `#15314A` |
| void | Didn't count | `#5B6472` / `#E7EAEF` | `#A6AFBD` / `#262D39` |
| pending | Waiting, Replaced | `#5B6472` / `#EEF0F3` | `#A6AFBD` / `#222935` |
| excluded | Excluded (review outcome) | `#6A4FA3` / `#ECE6F7` | `#BFA8F0` / `#2C2340` |

Avatars use six soft/ink pairs (`colors.avatar`), assigned by a hash of the person's id so a friend keeps their color everywhere.

### Verified contrast (WCAG 2.1 AA)
`tokens.test.ts` asserts, in both schemes: label and secondary on bg, surface, surface-elevated, fill and tint-soft ≥ 4.5:1; tertiary ≥ 3:1; tint on bg, surface and tint-soft ≥ 4.5:1; on-tint on tint ≥ 4.5:1; every state fg on its soft, on bg and on surface ≥ 4.5:1; label on every soft ≥ 4.5:1; on-state on the success, forfeit and unverified fills ≥ 4.5:1; every avatar pair ≥ 4.5:1. Placeholders use `secondary`, never `tertiary`.

### Named Rules
**The One Tint Rule.** Ultramarine is the only decorative-looking color and it is never decoration: it marks what you can tap, what is selected, and the ring. If something is blue, it does something.

**The Word Rule.** A state is always a word on a soft tone. Color is never the only carrier, and no state is "red" or "green" in copy.

**The Soft-Fill Rule.** State colors fill a control only in the check-in reveal. Everywhere else they appear as text on their soft background.

## Typography

**Display Font:** SF Pro (system) via Dynamic Type text styles
**Body Font:** SF Pro (system)
**Label/Mono Font:** SF Pro with `tabular-nums` for anything that changes in place (countdowns, money, radius)

**Character:** One family, tuned weights. Titles are bold and slightly tracked open (Apple's own table), body is regular and tracked tight, nothing is thin. Hierarchy comes from size and weight steps, not from a second face.

### Hierarchy
Every variant is a Dynamic Type ramp (`dynamicTypeRamp` on iOS) with its own tracking and leading from the SF tables, and its own ceiling for accessibility sizes (`maxFontSizeMultiplier`) so titles stop growing before body text does.

- **largeTitle** (700, 34/41, +0.37, max 1.3x): top-level screen titles in the navigation bar (collapses to inline on scroll).
- **title1** (700, 28/34, +0.36, max 1.4x): the countdown on the check-in screen; one per screen at most.
- **title2** (700, 22/28, +0.35, max 1.5x): the label inside the check-in button.
- **title3** (600, 20/25, +0.38, max 1.5x): empty-state titles, sheet titles when they lead.
- **headline** (600, 17/22, -0.41, max 1.8x): section headers, card titles, button labels.
- **body** (400, 17/22, -0.41, max 2x): rows, prose, inputs.
- **callout** (400, 16/21, -0.32): secondary prose inside a card.
- **subheadline** (400, 15/20, -0.24): row subtitles, field labels (semibold), segment labels.
- **footnote** (400, 13/18, -0.08): pills, helper and error text, list headers and footers.
- **caption1** (400, 12/16, 0) and **caption2** (400, 11/13, +0.07): compact pills, avatar initials, timestamps. 11 pt is the floor.

### Named Rules
**The Tabular Rule.** Anything that ticks or sums uses `fontVariant: ['tabular-nums']`, so a countdown never re-lays-out and a column of money lines up.

**The Ceiling Rule.** Dynamic Type is on everywhere; titles cap at 1.3 to 1.5x, text at 2x. Never a hard-coded point size outside `tokens.ts`.

## Layout

A single column on a 16 pt gutter (the iOS inset-grouped margin), content inside the safe area, bottom inset respected for the home indicator. The spacing scale is a 4 pt grid: 2, 4, 8, 12, 16, 20, 24, 32, 40, 48. Rhythm: 8 inside a group (title to subtitle, pill to pill), 12 between items in a list, 16 between groups and as card padding, 24 above a section header (more above a heading than below it).

Screens are `Screen` roots: a `ScrollView` with `contentInsetAdjustmentBehavior="automatic"` under a native large-title header, pull-to-refresh, and an optional pinned footer for the screen's one primary action. Settings-shaped content is a `ListGroup` of `ListRow`s (44 pt minimum, leading / title + subtitle / trailing / chevron). Cards are for things that are one object with several facts (a pact today); rows are for lists of peers. Never a card inside a card.

Touch targets are 44 pt minimum; a visual smaller than that gets `hitSlop`, not a bigger drawing. Density is medium: more than a marketing page, less than a spreadsheet; a group home fits today's pacts and the first actions in one viewport on an iPhone 15.

## Elevation & Depth

A hybrid with a strict rule: **one elevation declaration per surface.** Flat surfaces (cards, rows, inputs, the segmented track) sit on the page with a hairline `separator` border and no shadow. Floating surfaces (the toast, the in-screen sheet, the segmented indicator pill, the slider thumb) use `surface-elevated` with an offset, blurred shadow and no border. In dark mode floating surfaces are also one step lighter.

Materials: `expo-blur` is permitted behind the sheet handle region and the toast at intensity 60, with `surface-elevated` as the opaque fallback on web and when Reduce Transparency is on. Blur is never decoration and never animated (crossfade a static layer instead).

### Shadow Vocabulary
- **Floating** (`shadowColor label/black, opacity 0.16-0.20, radius 16-24, offset 0 6-8`): toast, sheet (offset upward), raised card.
- **Control** (`opacity 0.12-0.15, radius 4, offset 0 2`): the segmented indicator pill, the slider thumb.

### Named Rules
**The Border-or-Shadow Rule.** A surface has a hairline border or a soft offset shadow, never both. A bordered card under a shadow is the ghost card and is a bug.

## Shapes

Gently rounded. Cards and list groups 16 pt; buttons, inputs and the segmented track 12 pt / 8 pt; the floating indicator pill 8 pt; pills and the check-in button are full circles (999). Corner radius scales with the object: small controls are tighter than cards. No side stripes, no hard offset shadows, no gradients.

## Components

All primitives live in `src/components/` and are documented by their props. Character in one phrase: **precise and calm; the check-in button is the only thing that raises its voice.**

### Buttons
- **Shape:** 12 pt radius, 50 pt tall (44 pt `small`), headline label, 20 pt side padding.
- **Primary:** tint fill, on-tint label. **Secondary:** fill, label. **Tertiary:** no fill, tint label. **Destructive:** forfeit fill, on-tint label.
- **Press:** scale to 0.97 in 120 ms ease-out (Reanimated CSS transition), feedback on press-in; haptic `pressPrimary` (impact Light) on press-in for primary and destructive only. **Disabled:** 45% opacity. **Loading:** label hidden, spinner in place, width kept.

### Pills (StatusPill / Pill)
- **Style:** footnote semibold on the state's soft background, full radius, 4/10 pt padding; `compact` uses caption1 and 2/8 pt.
- **State:** `StatusPill state="success" ...` takes the result or live day-state enum and maps it to the glossary word and tone in `status.ts`.

### Cards / Containers
- **Corner Style:** 16 pt. **Background:** surface. **Shadow Strategy:** flat (hairline border) by default, `raised` only for floating things. **Internal Padding:** 16 pt, 8 pt gap.

### List rows (ListRow / ListGroup)
- 44 pt minimum, inset-grouped corners handled by `ListGroup`, hairline separators between rows, pressed background `fill` (120 ms), disclosure chevron in tertiary.

### Inputs / Fields (TextField)
- **Style:** surface, hairline separator border, 12 pt radius, 44 pt, label above in subheadline semibold, placeholder in `secondary`, clear button while editing single-line.
- **Focus:** border turns tint and 1.5 pt (color transition 180 ms). **Error:** border forfeit, footnote message in forfeit, `accessibilityState` invalid. **Helper:** footnote secondary.

### Segmented control
- fill track, 2 pt inset, absolutely positioned childless indicator pill (surface-elevated, control shadow) animating `translateX` and `width` over 250 ms ease-in-out; `Haptics.selectionAsync` on the press, not on landing.

### Navigation
- Native stack: large title on top-level screens, inline on detail; modal presentation for create flows; form sheets for short pickers. Header tint = tint, no header shadow, bg matches the page. Tab switches (if added) never slide. Reduce Motion: `animation: 'fade'`.

### Sheet (in-screen)
- surface-elevated, 20 pt top corners, 36x5 grabber in tertiary at 50%. Opens on the `sheet` curve (300 ms timing: nobody dragged it, so it does not bounce), once per open. Pan on shared values: `onActivate` captures the current position, upward past the top rubber-bands (`rubberband(overshoot, height, 0.55)`), release projects momentum (`project(velocity)`); dismiss when the projected rest is past 40% of the height, else snap home with the `sheet` spring and a `snap` haptic. Dismiss uses `sheetDismiss` (critically damped, overshoot clamped) so it never flashes a gap. Backdrop opacity derives from the same value. Reduce Motion crossfades in place.

### Toast
- One at a time, top, under the status bar, surface-elevated with a floating shadow (no border), subheadline semibold, leading icon in its tone. Enters down 250 ms ease-out, exits up 200 ms, both timing curves; the off-screen offset is the toast's own measured height. Swipe up to dismiss (velocity or distance) with the release spring carrying the finger's velocity, `snap` haptic. `accessibilityRole="alert"`, `accessibilityLiveRegion="polite"`.

### Progress ring, Countdown, Avatar stack, Skeleton, Empty state
- **ProgressRing:** react-native-svg stroke on `useAnimatedProps`; `reveal` spring to new values, `step` jumps for a ticking clock; `indeterminate` sweeps a quarter arc at 1200 ms linear (Reduce Motion: opacity pulse instead).
- **Countdown:** title1 tabular, h:mm:ss / mm:ss, forfeit tone in the last minute, VoiceOver label in words, announcements at 5 and 1 minutes only.
- **AvatarStack:** 28 pt initials circles overlapping 30%, bg-colored 2 pt ring, "+n" tail, tint ring for "you". Initials are 36% of the diameter (a glyph, not Dynamic Type text) and a single letter under 28 pt.
- **Skeleton:** fill-strong block, opacity shimmer 1 to 0.45 at 900 ms ease-in-out (static at 0.7 under Reduce Motion).
- **EmptyState:** title3 + subheadline body + one primary small button; the body says what will appear and how to make it appear.

### The signature interaction: the check-in moment
**Decision: a tap, not press-and-hold.** The server already judges every tap (first in-fence tap wins, 20 per day), an accidental tap costs nothing, and at 8:59:50 a second of holding is a second the person does not have. Weight comes from the GPS wait and the reveal, not from the gesture.

Anatomy, centered on the screen: a 240 pt `ProgressRing` (6 pt stroke, track `fill-strong`) around a 220 pt circular button (title2 label); the `Countdown` (title1, tabular) directly below; the target line ("Kane Hall, 75 m. Your location is read once, right now, and nowhere else.") in subheadline secondary under that.

States, in order:
1. **Before the window:** button `tint-soft` with tint label "Opens in 1:12:08" (countdown to the open, `until it opens`), ring empty, disabled but readable. "Freeze today" as a tertiary button below.
2. **Idle (window open):** button tint / on-tint "Check In"; the ring is the window's clock, full at open and draining toward the deadline (`animate="step"`, re-drawn each second with no interpolation); the countdown counts down to the deadline and both turn forfeit in the last minute. Press-in: scale 0.97 in 120 ms + `pressPrimary` haptic.
3. **Locating (tap to fix):** label crossfades to "Finding you…" (180 ms), ring switches to the indeterminate quarter-arc sweep in tint (1200 ms per turn, linear). This is the only continuous motion in the app. Up to 25 s; then:
4. **Sending:** same sweep, label "Sending…" (300 ms typical).
5. **Reveal, per verdict** (one spring, `reveal`: 350 ms, damping 1):
   - *in_fence:* ring stroke crossfades to success and fills to 100% with the reveal spring; the button fills success (color 180 ms) with label "You're in" and a checkmark; haptic `success` on the first frame of the fill; below, a card: "Showed up. Counted at 8:41." Button stays success and disabled: "Checked in."
   - *out_of_fence:* ring stroke goes unverified and settles back to the clock; button returns to idle (another tap is allowed); a card slides up 8 pt and fades in (250 ms ease-out): "Not at your place yet. About 212 m from the center (circle is 75 m). Get closer and tap again." Haptic `warning`.
   - *unjudgeable (weak GPS / no fix):* ring stroke unverified; button idle; card: "GPS too weak to judge. Try again near a window. If nothing better lands, today counts as unverified, not missed." Haptic `warning`.
   - *queued (offline):* ring stroke unverified, dashed; button idle; card "Saved offline. It sends when you're back online; if it lands after the deadline it counts as unverified, not missed." Haptic `warning`.
   - *rejected_simulated:* ring stroke forfeit; card "Location rejected. That location looked simulated, so it was not counted." Haptic `error`.
   - *permission denied / blocked:* button becomes secondary "Allow location"; card with the one-line reason and "Open Settings" when blocked. Haptic `error`.
6. **Closed:** button fill with secondary label "Closed", ring empty, the result pill above.

Reduce Motion: the sweep becomes a pulse, the reveal fill jumps, the card fades without moving, the press scale is dropped (color change remains).

## Do's and Don'ts

### Do:
- **Do** take every color from `useTheme().colors`; both schemes are in `tokens.ts` and tested.
- **Do** use `Text variant=...` for all text and `tabular` for anything that changes in place.
- **Do** keep one primary action per screen, 50 pt, at the bottom or as the screen's footer.
- **Do** state the fail-open rule ("counts as unverified, not missed; it never costs you") in every GPS, offline and late state.
- **Do** honor Reduce Motion in every animation: opacity and color stay, translation, scale and overshoot go.
- **Do** fire one haptic per user action, on the same frame as the visual, from the `haptics` map by name.

### Don't:
- **Don't** put a card inside a card, or a border under a shadow.
- **Don't** use a second tint, a gradient, glass as decoration, a side stripe, or an emoji as an icon.
- **Don't** animate layout (`height`, `width`, `margin`, `top`); the segmented indicator is the one sanctioned `width` animation because it is absolute and childless.
- **Don't** use `ease-in`, `scale(0)` entrances, `PanResponder`, core `Animated`, `runOnJS` or a `setState` per frame.
- **Don't** write "bet", "wager", "stake", "pot" or "rake" in copy. UI says pledge, forfeit, pool, settle-up.
- **Don't** use the three voice words (Boarding, Final call, Gate closed) anywhere but their three moments, and no other aviation words at all (see Voice).

## Voice

Final Call speaks plainly (pledge / forfeit / pool / showed up / missed) except at three moments of the day, where it borrows three words from the departure board. The words are consistent everywhere they appear and sparing: nothing else in the app is airport-themed, and they never appear outside their moment.

| Moment | Word | Where it appears (and the exact form) |
|---|---|---|
| The window opens | **Boarding** | Push and local reminder title `Boarding: {pact title}` (body `Check in by 9:00 AM.`); the check-in clock's big line `Boarding · 54:12` (footnote `left · by 9:00 AM`); the Today card's timing line `Boarding · 54:12 left · by 9:00 AM`; VoiceOver `Boarding. 54 minutes left, deadline 9:00 AM`. |
| Fifteen minutes before the deadline | **Final call** | Push and local reminder title `Final call: {pact title}` (body `15 minutes left to check in.`); the clock switches to `Final call · 14:59` in the forfeit tone (digits too) until the deadline, with the last-minute footnote `Tap now. Your tap time is what counts.` unchanged; the Today card's timing line `Final call · 14:59 left · by 9:00 AM` in the forfeit tone. The fifteen-minute lead is `FINAL_CALL_MS` in `features/checkin/copy.ts`, the same lead as the `deadline_soon` push and the local reminder. |
| The deadline | **Gate closed** | The clock's big line `Gate closed` (footnote `Deadline was 9:00 AM`); the result push title `Gate closed: {pact title}`; the Today card's timing line `Gate closed 9:00 AM`; the gate-close card while the server tallies, `Gate closed · tallying…`. Once the result is posted the card's headline is the result and the money (`You're +$3.34 today`, `You forfeited $5.00`, `Unverified · no pledge moved`), not the word. |

Banned everywhere else: those three words in any other context (a settle-up is never a "gate", a missed day is never "the gate closed on you"), and every other aviation word (passengers, runway, takeoff, departures, terminal, seat, flight). The pact's own title can be whatever the group named it. Code constants: `VOICE` in `features/checkin/copy.ts`; the push copy lives in `supabase/functions/push-outbox/outbox.ts`, the local reminders in `lib/localNotifications.ts`; all three are unit-tested.

### The gate-close card

At the deadline the check-in screen's status line becomes the gate-close card (the verdict panel's shape), and the Today card's status line becomes its compact form. The money is read from the ledger (`instance_member_nets`), never computed on the phone.

| Outcome | Headline | Subline | Compact (Today card) |
|---|---|---|---|
| Tallying (server not yet posted; polled every 10 s for 3 min) | `Gate closed · tallying…` | `Results post within a minute.` (after 3 min: `Results post within a minute or two; pull to refresh.`) | `Gate closed · tallying…` |
| Showed up, winnings | `You're +$3.34 today` (figure counts up) | `Dev and Jordan missed · pool $10.00 split 3 ways` (one winner: `the $5.00 pool is yours`; carry: `pool $9.00 ($4.00 carried over)`) | `+$3.34 · Dev and Jordan missed` |
| Showed up, nothing moved | `You made it` | `Everyone made it · no pledge moved` | `Showed up · Everyone made it` |
| Missed | `You forfeited $5.00` (figure counts up) | `Maya, Priya and Dev showed up` / `Nobody made it · the $10.00 pool carries over`; footnote `If that's wrong, appeal it in the feed before Monday's settle-up.` | `Forfeited $5.00 · Maya, Priya and Dev showed up` |
| Unverified | `Unverified · no pledge moved` | who showed up / missed; footnote repeats the never-costs rule | `Unverified · no pledge moved` |
| Frozen | `Frozen · no pledge moved` | who showed up / missed, or `You called today off in advance.` | `Frozen · no pledge moved` |
| Didn't count | `Didn't count · fewer than two people were in it` | `No pledge moved.` | same |

Motion: the card enters with spring `reveal` (opacity, translateY 8, scale 0.97; opacity only under Reduce Motion), the money figure counts from $0.00 over 350 ms ease-out on the UI thread (`AnimatedHeadline`, a read-only `TextInput` driven by `animatedProps`; no count-up under Reduce Motion), the check-in ring settles full in the result tone for winnings and forfeits and stays empty when no pledge moved. Haptic: `success` for winnings, `warning` for a forfeit, none otherwise, on the frame the posted card mounts. VoiceOver hears headline and subline once and focus lands on the headline.

## Copy glossary

| Code | UI | Where |
|---|---|---|
| stake | **pledge** | "Pledge $5 per day", "your pledge goes to the pool" |
| pot | **pool** | "split among everyone who showed up" |
| forfeit | **forfeit** | what a missed day costs: "forfeits your pledge" |
| settlement | **settle-up** | "Monday's settle-up", "To settle now" |
| success | **Showed up** (live: *Checked in*) | pills, feed, result cards |
| failed | **Missed** | pills, feed; appeals say "a missed day" |
| unverified | **Unverified** (live: *Weak GPS*, *Late*, *Not there yet*) | always paired with "never costs you" the first time it appears on a screen |
| frozen | **Frozen** | "Freeze today", "won't count for or against you" |
| void | **Didn't count** | fewer than two people were in it |
| excluded | **Excluded** | historical rows only (no rule sets it since night-1, N3-1); the monthly counter is gone |
| pending | **Waiting** | before a result exists |
| in_fence / out_of_fence | **at your place** / **not at your place yet** | verdict copy |
| obligation pending / marked_paid / confirmed / superseded | **Unpaid** / **Marked paid** / **Confirmed** / **Replaced** | ledger |
| review open / accepted / rejected / defaulted | **Voting open** / **Upheld** / **Turned down** / **No votes, default applied** | feed |

## Motion tokens

From `tokens.ts` (`springs`, `easings`, `durations`); `motion.ts` turns them into Reanimated configs with `reduceMotion: ReduceMotion.System` on every spring.

| Name | Value | Use |
|---|---|---|
| spring `settle` | duration 400, dampingRatio 1 | any state change with no finger on it |
| spring `reveal` | duration 350, dampingRatio 1 | the check-in ring reaching its result |
| spring `snapBack` | duration 400, dampingRatio 0.8, velocity | reposition after a drag release (momentum) |
| spring `sheet` | duration 300, dampingRatio 0.8, velocity | sheet returning to its detent (momentum) |
| spring `sheetDismiss` | duration 300, dampingRatio 1, velocity, overshootClamping | sheet leaving the screen |
| easing `out` | cubic-bezier(0.23, 1, 0.32, 1) | entering, exiting, default |
| easing `inOut` | cubic-bezier(0.77, 0, 0.175, 1) | moving on screen (segment pill) |
| easing `sheet` | cubic-bezier(0.32, 0.72, 0, 1) | timed sheet motion when a spring is not available |
| easing `linear` | cubic-bezier(0, 0, 1, 1) | the GPS sweep only |
| duration `press` 120 ms, `state` 180, `enter` 250, `exit` 200, `move` 250, `sheet` 300, `sweep` 1200 | | exits are faster than entries |
| press scale | 0.97 | every pressable |

## Haptics map

| Name | expo-haptics call | Moment |
|---|---|---|
| `pressPrimary` | `impactAsync(Light)` | press-in on a primary or destructive button, including Check In |
| `selection` | `selectionAsync()` | segmented control, day chips, time stepper, radius slider every 25 m |
| `snap` | `impactAsync(Light)` | sheet catches its detent, toast dismissed, toggle committed |
| `commit` | `impactAsync(Medium)` | leave group, "Didn't receive it", pause a pact |
| `success` | `notificationAsync(Success)` | verdict in_fence |
| `warning` | `notificationAsync(Warning)` | out_of_fence, weak GPS, no fix, saved offline |
| `error` | `notificationAsync(Error)` | rejected_simulated, permission blocked, request refused |

One per user action, same frame as the visual, never the only feedback; no-op on web.
