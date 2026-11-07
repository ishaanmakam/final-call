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
npm run typecheck   # tsc --noEmit
npm test            # vitest run (pure modules in src/lib)
npm run doctor      # expo-doctor
```

## Layout

```
app.config.ts            Expo config: bundle id, permissions text, plugins
eas.json                 development / preview / production build profiles
src/app/                 expo-router routes
  sign-in.tsx            Sign in with Apple + email magic link
  auth-callback.tsx      showup://auth-callback?code=... (magic link landing)
  (app)/_layout.tsx      signed-in guard, push registration, offline queue runner
  (app)/groups/...       list, create/join, group home, feed, ledger, pact wizard
  (app)/pacts/[pactId]/  pact detail, per-person place picker
  (app)/checkin/[id]     the big Check In button
  (app)/join/[code]      showup://join/<code> invite links
  (app)/settings.tsx     profile + Venmo username, notifications, sign out
src/api/
  types.ts               hand-written row types + Database type matching CONTRACT.md
  rpc.ts                 typed wrapper for every client RPC (exact names)
  queries.ts             TanStack Query hooks: my groups, group home, pact, instance, feed, ledger
  supabase.ts            client with Keychain (secure-store) session storage
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
2. Tapping asks for When-In-Use permission if needed, then takes exactly one `getCurrentPositionAsync({ accuracy: Accuracy.Highest })` fix (25 s timeout). Location is read nowhere else except when you set your place.
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
3. A private Storage bucket `review-photos` with policies: members insert under `<instance_id>/<auth.uid()>/...`, members of the instance's group can read. Appeal photos pass that object path as `p_photo_path`.
4. An RLS delete policy on `push_tokens` for `user_id = auth.uid()` (Settings > Notifications off and sign-out delete the device token; there is no unregister RPC).
5. `check_in` should accept null `p_lat`/`p_lng`/`p_accuracy_m` ("no fix", judged `unjudgeable` by the existing rule).
6. A `profiles` row is created for each new auth user (trigger), since the app only updates it.
7. Notification payload `data` should include `instance_id` (opens check-in), `group_id` (opens group) or `url` (an in-app path).

## Known limitations

- No NetInfo module, so "network regained" is detected by the foreground event and the backoff timer, not by a connectivity callback. Queued check-ins don't send while the app is backgrounded.
- A timed-out check-in may have reached the server; the retry then records a second tap. That is harmless (first in-fence tap wins) but the contract has no client idempotency key.
- Sign in with Apple doesn't pass a nonce (would need a SHA-256 implementation or expo-crypto).
- expo-updates isn't installed, so "ship over the air" means reloading from Metro in the dev client; add expo-updates and `eas update` before TestFlight.
- No address search for places (v1.1); the place picker uses your current location plus a radius.
