# Show Up: iOS app (Expo)

The client for show-up pacts. Expo SDK 58, React Native 0.88, TypeScript (strict), expo-router, Supabase JS, TanStack Query. Design: `../docs/DESIGN.md`. Interfaces: `../docs/CONTRACT.md`.

Native modules are limited to expo-location (foreground only), expo-notifications, expo-apple-authentication, expo-secure-store, expo-linking, expo-image-picker (appeal photos) and AsyncStorage (offline queue). One EAS development build covers all of them, and everything else is JavaScript that reloads without a rebuild.

## Setup on Windows (no Mac needed)

You need Node 22 LTS (the Windows ARM64 installer works), an Expo account, a paid Apple Developer Program membership (needed for device builds, Sign in with Apple and push), and an iPhone with a cable or the same Wi-Fi as the PC.

```powershell
cd app
npm install
copy .env.example .env      # then fill in the values (see "Environment variables")

npx eas-cli@latest login
npx eas-cli@latest init     # links the project and prints its projectId; put it in EAS_PROJECT_ID
```

Register your iPhone once (EAS builds an ad hoc profile that includes it):

```powershell
npx eas-cli@latest device:create
```

Open the link or QR code it prints on the iPhone and install the profile. On iOS 16 and later, also turn on Settings > Privacy & Security > Developer Mode and restart.

Build the development client in the EAS cloud (it asks for your Apple ID the first time and manages certificates for you):

```powershell
npx eas-cli@latest build --profile development --platform ios
```

When it finishes, open the install link on the iPhone. Then start Metro on the PC and open the app on the phone:

```powershell
npx expo start --dev-client
# if the phone can't reach the PC on your network (e.g. campus Wi-Fi), use:
npx expo start --dev-client --tunnel
```

You only need to rebuild when native config changes (app.config.ts, plugins, a new native module). Screens, queries and logic reload instantly.

Other profiles in `eas.json`: `preview` (internal ad hoc build without the dev menu) and `production` (App Store, auto-incrementing build number).

## Environment variables

| Name | Where it's used |
| --- | --- |
| `EXPO_PUBLIC_SUPABASE_URL` | Supabase project URL, inlined into the JS bundle |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key (safe to ship, RLS protects data) |
| `EAS_PROJECT_ID` | read by `app.config.ts` into `extra.eas.projectId`, needed for Expo push tokens |
| `IOS_BUNDLE_ID` | optional override of the placeholder `com.ishaanmakam.showup` |

`.env` is gitignored, so EAS cloud builds don't see it. Add the same values to EAS for each environment the profiles use (`development`, `preview`, `production`):

```powershell
npx eas-cli@latest env:create --environment development --name EXPO_PUBLIC_SUPABASE_URL --value https://xyz.supabase.co --visibility plaintext
npx eas-cli@latest env:create --environment development --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value <anon key> --visibility plaintext
npx eas-cli@latest env:create --environment development --name EAS_PROJECT_ID --value <project id> --visibility plaintext
```

With the dev client, Metro on your PC reads the local `.env`, so JS changes pick up new values after restarting `npx expo start`.

If the URL or key is missing the app shows a "Setup needed" screen instead of crashing.

## Supabase dashboard settings the app relies on

- Auth > URL Configuration > Redirect URLs: add `showup://auth-callback`. Magic links use the PKCE flow and land on that route, which exchanges the `code` for a session.
- Auth > Providers > Apple: enable it and add the bundle id (`com.ishaanmakam.showup`) under Client IDs. Native Sign in with Apple sends the identity token straight to `signInWithIdToken`; no Services ID or secret is needed for native-only.
- Storage: a private bucket named `review-photos` (see "Schema additions").

## Scripts

```powershell
npm run typecheck        # tsc --noEmit
npm test                 # vitest run (pure modules in src/lib and src/theme)
npm run doctor           # expo-doctor
npm run web:export       # expo export --platform web (set EXPO_PUBLIC_DEMO=1 for fixture data)
npm run screenshots      # export the demo web build, then capture every screen (see below)
npm run screenshots:quick  # capture again without re-exporting
```

## Design system

`PRODUCT.md` (product truth) and `DESIGN.md` (tokens, type scale, colors, motion, haptics, the check-in moment, copy glossary) are the design authority for the app. Tokens live in `src/theme/tokens.ts` and are tested (`src/theme/*.test.ts`: WCAG AA contrast for every documented pair in light and dark, spring/easing invariants, reduced-motion mapping, countdown formatting). Primitives live in `src/components/` (`Button`, `Card`, `ListRow`/`ListGroup`, `StatusPill`/`Pill`, `Avatar`/`AvatarStack`, `Countdown`, `ProgressRing`, `RadiusSlider`, `Sheet`, `Toast`, `EmptyState`, `Skeleton`, `TextField`, `TimePicker` (+ `.web`), `SegmentedControl`, `Screen`, `Text`, `Icon`); screens compose only these and the tokens. Motion goes through `src/theme/motion.ts` (`transition()`, `spring()`, `timing()`, every spring with `reduceMotion: System`) and haptics through `src/theme/haptics.ts` (`haptic('name')`, one per action, no-op on web).

## Demo mode

`EXPO_PUBLIC_DEMO=1` runs the whole app against in-memory fixtures (`src/api/demo/`): a group of four friends, four pacts, today's instances in every window state, four weeks of results with open/accepted/rejected/defaulted reviews, balances and obligations, a profile with a Venmo username. No Supabase call is made; auth is a fake session (`demo-user`), location is a fake fix after a 1.2 s pause, push is off. The demo RPCs mutate the fixtures, so a check-in, a vote or "Mark paid" shows up on refetch.

```powershell
$env:EXPO_PUBLIC_DEMO = '1'; npx expo start        # PowerShell
EXPO_PUBLIC_DEMO=1 npx expo start                   # bash
```

Route params steer the scenario (web: the URL query; native: any `router.push` with params):

| Param | Effect |
| --- | --- |
| `?verdict=in_fence\|out_of_fence\|unjudgeable\|rejected_simulated` | what a demo check-in returns |
| `?empty=1` | a group with nothing in it yet (empty states) |
| `?state=offline` / `?state=error` / `?state=queued` | every query fails like a dead network / fails with a server error / only the check-in request fails (so it is queued) |
| `?perm=denied\|blocked` | location permission outcome on the Check In tap |
| `?signedOut=1` | no session (shows sign-in) |
| `?freeze=1` | stops the clock at the fixture anchor (deterministic countdowns) |
| `?settle=owe\|owed` | settle-up variants: only obligations you pay / only ones paid to you |
| `?fix=none` | the GPS fix times out on the Check In tap (sent without coordinates: unverified, never missed) |
| `?precise=0` | iOS Approximate Location: the Check In tap sends nothing and points to Settings (the day would count as missed) |
| `?budget=N` | N unverified days this month in the open instance's pact (0-9): the check-in screen's "N unverified this month" line |

Demo ids: group `g1` (empty group `g-empty`), pacts `p1`..`p5` (`p5` "Chem lab by 2" is one you are not in), today's instances `i-open`, `i-before`, `i-closed`, `i-void`, `i-frozen`, `i-notin`, invite code `KANE9AM`.

## Screenshots

`scripts/screenshot.mjs` exports the demo web build (`dist/`, gitignored), serves it on a local port with an SPA fallback, and drives the installed Chrome through Playwright (`channel: 'chrome'`, no browser download) to capture every route in `ROUTES` at iPhone 15 size (393x852, 3x) in light and dark with reduced motion, into `screenshots/<route>.<light|dark>.png`, then writes `screenshots/index.html` (a contact sheet, light next to dark). The PNGs are committed; they are the review artifact.

```powershell
npm run screenshots                       # full run (export + capture)
node scripts/screenshot.mjs --skip-export # reuse dist/
node scripts/screenshot.mjs --only checkin --scheme dark
```

Routes that need interaction (the pact wizard's later steps, each check-in verdict, the located place picker) list `actions` in `ROUTES`: `fill` a labelled field, `click` a button by its accessible name, `wait` milliseconds. Web rendering uses the platform system font stack (Segoe UI on Windows), so letterforms differ from SF on a device; layout, color and copy are what the captures are for.

## Layout

```
app.config.ts            Expo config: bundle id, permissions text, plugins
eas.json                 development / preview / production build profiles
PRODUCT.md, DESIGN.md    design authority: product truth; tokens, motion, haptics, copy glossary
screenshots/             the review artifact: every route, light and dark (see "Screenshots")
scripts/screenshot.mjs   exports the demo web build and captures it with Playwright
src/app/                 expo-router routes (layout and data only; copy and state tables live in src/features)
  sign-in.tsx            Sign in with Apple + email magic link
  auth-callback.tsx      showup://auth-callback?code=... (magic link landing)
  (app)/_layout.tsx      signed-in guard, push registration, offline queue runner, queue toasts
  (app)/groups/...       list, create/join, group home, feed, settle-up (route name `ledger`), pact wizard
  (app)/pacts/[pactId]/  pact detail, per-person place picker
  (app)/checkin/[id]     the check-in moment (ring, button, verdict panel)
  (app)/join/[code]      showup://join/<code> invite links
  (app)/settings.tsx     profile + Venmo username (autosave), notifications, sign out
src/components/          the primitives (see "Design system"); `status.ts` maps every state to its word and tone
src/theme/               tokens (colors, type, space, radius, springs, easings, haptics map), ThemeProvider,
                         motion helpers, reduced-motion mapper, countdown formatting; all unit tested
src/features/            per-screen logic with no React Native imports, so it is unit tested
  auth/                  safe `next` redirect, email validation, magic-link error copy
  checkin/               the button state machine, verdict panel copy, clock copy, CheckinButton/VerdictPanel/WindowClock
  feed/                  day grouping, money sentences, review and vote copy
  group/                 today-card copy and status lines, nav-bar icon button
  groups/                create/join forms, nav-bar text and icon buttons
  pact/                  wizard draft, validation, window presets
  place/                 place-change lock rules, radius detents and labels
  settings/              profile autosave patch, destructive confirm (alert on iOS, confirm on web)
  settle/                headline, subline, pills and week split for settle-up
  shared/                time zones with friendly names (one list for the group and pact pickers)
src/api/
  types.ts               hand-written row types + Database type matching CONTRACT.md
  rpc.ts                 typed wrapper for every client RPC (exact names)
  queries.ts             TanStack Query hooks: my groups, group home, pact, instance, feed, ledger
  supabase.ts            client with Keychain (secure-store) session storage, chunked (secureChunks.ts)
  demo/                  EXPO_PUBLIC_DEMO=1 fixtures, settings (`?param` switches) and in-memory hooks/RPCs
src/lib/                 pure logic (unit tested) + small RN adapters
  checkinQueue.ts        offline queue: dedupe, backoff, 24h expiry, serialized flushes
  checkinQueueRuntime.ts AsyncStorage + AppState wiring for the queue
  time.ts                window state, countdown, display in pact tz, DST-correct local->UTC
  money.ts / venmo.ts    integer-cents formatting, Venmo deep links
  instanceStatus.ts      live "2 of 4 checked in" summary
  errors.ts              network vs rejected classification, user-facing error copy (check-in cap, rule violations)
  obligations.ts         open obligations (pending + marked_paid, any settlement) grouped by week
  places.ts              which saved place applies to a window (12 h lead time), next window
  reviews.ts             Appeal/Challenge availability (one of each per person per instance)
  pendingNext.ts         where to land after a magic link (the invite that sent you to sign in), AsyncStorage-backed
  push.ts / push.web.ts  Expo push registration and notification-tap routing (by `url`, then by kind)
  queueNotice.ts         toast copy for offline-queue outcomes (sent / rejected / expired)
```

UI copy says pledge, forfeit and pool; code says stake and pot.

## Regenerating types

`src/api/types.ts` is hand-written to match CONTRACT.md in the same shape `supabase gen types` produces. Once the migrations are applied:

```powershell
npx supabase gen types typescript --local > src/api/database.types.ts
# or against the hosted project:
npx supabase gen types typescript --project-id <ref> > src/api/database.types.ts
```

Then in `types.ts`, replace the hand-written `Database` with `export type { Database } from './database.types'` and derive the row aliases from it (for example `export type PactRow = Database['public']['Tables']['pacts']['Row']`). Run `npm run typecheck` to surface any drift.

## How check-in works

1. The button is enabled only while `window_open_at <= now <= deadline_at` and the instance isn't closed.
2. Tapping asks for When-In-Use permission if needed, then takes exactly one `getCurrentPositionAsync({ accuracy: Accuracy.Highest })` fix (25 s timeout). Location is read nowhere else except when you set your place. If the permission response reports reduced accuracy (iOS Approximate Location), nothing is sent: the screen explains that such a day counts as missed and offers Open Settings (`features/checkin/precision.ts`).
3. The fix goes to `check_in` with `p_client_captured_at` set to the fix's own timestamp and `p_is_simulated` from `mocked`.
4. If the request fails for network reasons (status 0, timeout after 15 s, 5xx, 401), the attempt is saved in the offline queue and the screen says so. Business-rule rejections are shown, not queued.
5. If no GPS fix arrives, you can send an attempt with null coordinates, which the contract judges `unjudgeable`, so the day becomes unverified instead of missed.

The queue retries on launch, every time the app returns to the foreground, and on an exponential backoff (5 s doubling to 5 min) while the app is open. It dedupes by (instance, fix time), keeps at most 5 attempts per instance (the earliest), and drops anything whose fix is over 24 h old. Retries always resend the original fix time.

## What is real vs mocked

| Area | Status |
| --- | --- |
| Supabase auth, queries, RPCs, storage upload | Real calls. Nothing works until the backend migrations are deployed. |
| Location, notifications, Apple sign-in, secure store | Real native modules; need the development build on a device (Apple sign-in and push don't work in the simulator). |
| Unit tests | Pure modules only, with in-memory storage and a fake transport/clock for the queue. No React Native code runs under Vitest. |
| Venmo | Real deep link (`venmo://paycharge?...`), web fallback if the app isn't installed. No payment API; the payer marks paid and the payee confirms. |

## Schema additions and backend assumptions

The client needs these, which are not in CONTRACT.md yet:

1. `profiles.venmo_username text null`, plus an RLS policy letting a user update their own profile row (`id = auth.uid()`), which Settings uses for display name and Venmo username.
2. RLS so group members can read co-members' `profiles` rows.
3. A private Storage bucket `review-photos` with policies: members insert under `<group_id>/<user_id>/...` (what `lib/reviewPhoto.ts` writes), members of that group can read. Appeal photos pass that object path as `p_photo_path`.
4. An RLS delete policy on `push_tokens` for `user_id = auth.uid()` (Settings > Notifications off and sign-out delete the device token; there is no unregister RPC).
5. `check_in` should accept null `p_lat`/`p_lng`/`p_accuracy_m` ("no fix", judged `unjudgeable` by the existing rule).
6. A `profiles` row is created for each new auth user (trigger), since the app only updates it.
7. Notification payload `data` should include `instance_id` (opens check-in), `group_id` (opens group) or `url` (an in-app path).
8. Place accountability (`20261108000100_place_accountability.sql`): view `pact_places_visible` (every current participant's place rows with `state`, `is_current`, `acknowledgeable`, `objectable`), table `place_events` (feed rows), RPCs `acknowledge_place(p_place)`, `object_place(p_place, p_reason)` and `pact_place_distances(p_pact)` (metres from each place to the others' places in force). `pact_participant_places` carries `id`, `requires_ack`, `acknowledged_*`, `objected_*`, `objection_reason`. A participant with no place in force at window open is not on that day's roster (`lib/places.ts#placeForWindow` returns null).
9. Notification kind `place_changed` (payload `event` = created / acknowledged / objected / effective, `url` = `/pacts/<id>`); the push function needs a renderer for it.
8. The view `unverified_month_counts(pact_id, user_id, month, count)` (`20261108000200`), read by `features/checkin/useUnverifiedBudget.ts`; `reviews.system_opened` marks the automatic challenge the third unverified day of a pact-month opens (CONTRACT.md "Unverified budget"). Neither is in `api/types.ts` yet.

## Known limitations

- No NetInfo module, so "network regained" is detected by the foreground event and the backoff timer, not by a connectivity callback. Queued check-ins don't send while the app is backgrounded.
- A timed-out check-in may have reached the server; the retry then records a second tap. That is harmless (first in-fence tap wins) but the contract has no client idempotency key.
- Sign in with Apple doesn't pass a nonce (would need a SHA-256 implementation or expo-crypto).
- expo-updates isn't installed, so "ship over the air" means reloading from Metro in the dev client; add expo-updates and `eas update` before TestFlight.
- No address search for places (v1.1); the place picker uses your current location plus a radius.
