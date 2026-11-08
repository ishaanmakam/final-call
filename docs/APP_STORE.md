# App Store readiness: Final Call

What App Store Connect asks for, answered from the code as it is on `night-1`. Re-check every row
when a dependency or permission changes. Companion docs: `docs/legal/PRIVACY.md`, `docs/legal/TERMS.md`
(the same text the app shows under Settings → About and on the sign-in footer), `docs/DEPLOY.md` (backend),
`docs/TESTING.md` (Maestro / EAS), `app/README.md` (build profiles, OTA updates).

## Identity

| Field | Value |
|---|---|
| Name | Final Call |
| Bundle id | `com.ishaanmakam.finalcall` (`app/app.config.ts`; `IOS_BUNDLE_ID` overrides) |
| URL scheme | `finalcall://` (`finalcall://join/<code>`, `finalcall://auth-callback`) |
| Version / build | `version: '0.1.0'` in `app.config.ts`; build number auto-increments (`eas.json` production profile, `appVersionSource: remote`) |
| Category | Lifestyle (secondary: Productivity). Not Finance, not Games. |
| Age rating | 17+ is **not** required by the questionnaire (no gambling, no unrestricted web, no mature content); the questionnaire answers below give 4+. We still set the minimum age to 17 in the policy/terms and state it in the review notes, because the tally involves dollars between adults. Pick **12+** or **17+** in Connect's age-rating override if you want the store to enforce it; the product decision is 17+. |
| Required URLs | Privacy policy URL and Support URL (both mandatory). See "URLs" below. |

## URLs

App Store Connect needs public `https://` URLs for the privacy policy and support. The text is
`docs/legal/PRIVACY.md` and `docs/legal/TERMS.md` (generated from `app/src/features/legal/content.ts`;
`content.test.ts` fails if they drift). They are not hosted yet. Options, in order of effort:

1. **GitHub Pages of this repo** (planned: the web simulator repo page will host them). Enable Pages on
   `ishaanmakam/final-call` for the `docs/` folder or a `web/` build; the URLs become
   `https://ishaanmakam.github.io/final-call/legal/PRIVACY` and `.../legal/TERMS`.
2. Until then, the raw GitHub URLs work for review (`https://github.com/ishaanmakam/final-call/blob/main/docs/legal/PRIVACY.md`),
   but a rendered page is better.
3. Support URL: the same site with a contact line, or `mailto:` is **not** accepted; use a page that shows
   `ishaan.makam@gmail.com` (placeholder; replace with a product address before launch).

Also set the in-app contact (`LEGAL_CONTACT` in `app/src/features/legal/content.ts`) to the same address.

## App Privacy ("nutrition label")

Answers for **App Store Connect → App Privacy**. Source of truth: the privacy policy and the schema
(`docs/CONTRACT.md`). "Linked to you" = tied to the account (everything here is, because every row carries
the user id). "Used for tracking" = No for every item (no cross-app/site tracking, no ad identifiers, no
data brokers).

| Data type | Collected? | Linked to you | Tracking | Purpose(s) | Where it comes from |
|---|---|---|---|---|---|
| Contact Info → Email Address | Yes | Yes | No | App Functionality (sign-in, magic link) | `auth.users` (Supabase Auth), magic-link sign-in |
| Contact Info → Name | Yes | Yes | No | App Functionality (shown to your group) | `profiles.display_name` (typed, or Apple's shared name on first sign-in) |
| Contact Info → Other (Venmo username) | Yes (optional) | Yes | No | App Functionality (friends pay you at settle-up) | `profiles.venmo_username` |
| Identifiers → User ID | Yes | Yes | No | App Functionality | `auth.users.id` / `profiles.id`; Apple user identifier |
| Identifiers → Device ID | No | | | | Expo push tokens are opaque per-install tokens, declared under "Other Data Types" below, not as a device id |
| Location → Precise Location | Yes | Yes | No | App Functionality (judging a check-in against your place; setting a place) | `checkins.lat/lng` (nulled after 30 days), `pact_participants.place_*`, `pact_participant_places` |
| Location → Coarse Location | No | | | | the app refuses to send an Approximate-Location fix (it cannot be judged) |
| User Content → Photos or Videos | Yes (optional) | Yes | No | App Functionality (evidence attached to an appeal) | Storage bucket `review-photos` |
| User Content → Other User Content | Yes | Yes | No | App Functionality | review reasons, place labels, pact titles, group names, votes |
| Financial Info → Payment Info / Purchase History | **No** | | | | no payments in the app; the pledge tally is integer cents between friends, declared as "Other Data Types" |
| Usage Data → Product Interaction | Only when Sentry is on | Yes | No | Analytics (crash/performance diagnostics) | `@sentry/react-native`, `tracesSampleRate 0.1`, `sendDefaultPii false`; off in builds without `EXPO_PUBLIC_SENTRY_DSN` |
| Diagnostics → Crash Data, Performance Data | Only when Sentry is on | Yes | No | App Functionality / Analytics | same; coordinates stripped by `sentryScrub.ts` before sending |
| Other Data Types | Yes | Yes | No | App Functionality | push notification token (`push_tokens`), the pledge/forfeit/settle-up tally and obligation status, check-in verdicts and distances, freezes |
| Health & Fitness, Contacts, Browsing/Search History, Sensitive Info, Purchases | No | | | | |

If you ship a build without the Sentry DSN, answer "No" for Usage Data and Diagnostics. If you ship with
it, Sentry is a third-party processor: keep `sendDefaultPii: false` so IP addresses are not stored, or
declare them.

Tracking: **No**. Do not add the App Tracking Transparency prompt; there is nothing to request.

## Permissions and purpose strings

| Key | String (from `app.config.ts`) | Why Review will accept it |
|---|---|---|
| `NSLocationWhenInUseUsageDescription` | "Final Call reads your location once, only when you tap Check In during a pact window, to confirm you made it to your place. Keep Precise Location on: an approximate location cannot be judged. It never tracks you in the background." | Says when (the tap), what for (confirm your place), and what it does not do. No Always/background keys exist in the plist (`isIosBackgroundLocationEnabled: false`). |
| `NSPhotoLibraryUsageDescription` | "Choose a photo to attach as evidence when you appeal a result." | Optional, user-initiated. Camera and microphone are off in the plugin config. |
| Push notifications | permission requested on first sign-in (`registerForPush`), toggle in Settings → Notifications | The app works without them; Settings says what they are for. |
| Sign in with Apple | `usesAppleSignIn: true`; nonce-protected (`features/auth/appleNonce.ts`) | Guideline 4.8: offered because a third-party (email magic link) login exists. |
| `ITSAppUsesNonExemptEncryption: false` | export compliance: only HTTPS/standard OS crypto (expo-crypto SHA-256 for the Apple nonce is exempt as authentication) | no annual self-classification report needed |

## Review notes (paste into "Notes" in App Review Information)

> Final Call is a scorekeeper for small friend groups: each person pledges a few dollars to be at a place by a
> time; one tap during the window takes a single foreground location fix; people who showed up split the pledges
> of people who did not. **No real money is handled anywhere in the app**: there is no payment processor, no
> in-app purchase, no wallet. The app keeps an IOU tally in whole cents and, once a week, shows who owes whom
> with an optional Venmo deep link; settling is voluntary and happens outside the app. Pledges are capped at
> $100. Outcomes depend only on the person's own action (being somewhere), so this is not gambling (5.3).
>
> **Demo mode for review**: the build submitted for review can run against built-in fixture data with no
> backend. Sign in is not required to reach it: [describe how the reviewer reaches demo mode in the submitted
> build; see "Demo build" below]. In demo mode the group "Morning crew" has four pacts; "9am in Kane Hall" has an
> open window: tap it, then Check in, to see the location flow (the demo uses a fake fix; no real location is
> read). Settings → Delete account shows the deletion flow.
>
> **Location**: read once per Check In tap inside an open window and when the person sets their place; never in
> the background (no background modes). Raw coordinates are deleted after 30 days. A weak or missing fix
> resolves to "Unverified", which never costs a pledge.
>
> **Account deletion**: Settings → Delete account (5.1.1(v)). It leaves every group, erases the sign-in identity
> and push tokens, anonymizes the name; the group's shared history (who showed up, past settle-ups) stays under
> "Deleted member" because other people's balances were computed from it, as the privacy policy explains.
>
> **Sign in with Apple** is offered alongside email magic links (4.8).
>
> Test account: not needed in demo mode. For the live backend use the reviewer email below; the magic link
> arrives within a minute. [Provide a reviewer email you control, or an Apple test account.]

### Demo build

The real builds talk to Supabase; the Maestro/demo build (`eas.json` profile `demo-simulator`,
`EXPO_PUBLIC_DEMO=1`) talks to nobody. For review you have two options: (a) submit the production build
and give the reviewer a working account (magic-link email you can read, or a group pre-seeded so the
reviewer sees content immediately); (b) add a hidden "Try the demo" entry on the sign-in screen that
switches to demo mode at runtime. (b) is not built: `DEMO` is a build-time constant
(`app/src/api/demo/settings.ts`). Decide before submission; (a) is the usual path and needs a seeded
group so the first screen is not empty.

## Pre-submission checklist

- [ ] **Account deletion visible** (5.1.1(v)): Settings → Delete account → confirmation → RPC `delete_my_account` → sign-in screen. Verified on device, including the open-window refusal message.
- [ ] **Sign in with Apple** (4.8): nonce flows end to end on a device with the hosted project (`skip_nonce_check = false`); `usesAppleSignIn: true`; the Apple capability is on the App ID in the developer portal; Apple provider in Supabase has the bundle id as Client ID (DEPLOY §8).
- [ ] **Permission strings** (5.1.1(i)): the two strings above appear in the build's Info.plist; no `NSLocationAlwaysUsageDescription`, no `UIBackgroundModes: location`.
- [ ] **Data minimization** (5.1.1(iii)): sign-up asks only for email or Apple id; name and Venmo are optional and editable; location is read only on explicit taps; photos are optional. Nothing is required that the feature does not need.
- [ ] **5.3.4 / gambling**: the review notes state no real money, no chance, no house, no fee; the legal pages say so; the UI never says bet / wager / stake (tests: `features/legal/content.test.ts`, push-outbox `never uses internal money wording`).
- [ ] **Privacy policy URL and Support URL** live and matching the in-app text; the in-app links (sign-in footer, Settings → About) open.
- [ ] **App Privacy** answers entered as in the table; tracking = No; no ATT prompt.
- [ ] **Export compliance**: `ITSAppUsesNonExemptEncryption: false` present (it is in `app.config.ts`), so no compliance questions at upload.
- [ ] **Age rating** questionnaire: everything "None"; set the 17+ override if you want the store to gate it.
- [ ] **Push**: APNs key uploaded to Expo (`eas credentials`); `EAS_PROJECT_ID` set in the production environment; a real push received on a TestFlight build.
- [ ] **expo-updates**: `runtimeVersion` policy `appVersion`, channel `production` in `eas.json`; one `eas update --channel production` tested on a TestFlight build.
- [ ] **Crash reporting** decided: DSN present or absent in the production environment; App Privacy answers match.
- [ ] **Deep links**: `finalcall://join/<code>` and `finalcall://auth-callback` open the app (Supabase Redirect URLs updated, DEPLOY §8).
- [ ] **Legal**: no real money in MVP; before anything touches real money run `/security-review` and get a legal opinion (DECISIONS.md).
- [ ] **Screenshots** uploaded (see below), app icon final (the one in `app/assets` is a placeholder), description and keywords without money words.

## Screenshots

Reuse `app/screenshots/*.png` (393×852 @3x = 1179×2556, the 6.1" iPhone size App Store Connect accepts;
light and dark exist for every route). A sensible set of six for the 6.9"/6.7"/6.1" slots (Connect scales
the 6.1" set up when the others are missing, but a native 6.9" capture looks better; re-run
`scripts/screenshot.mjs` with a 440×956 viewport for that):

1. `groups.light` (your groups)
2. `group-home.light` (today's pacts, including "Lab notebook by noon")
3. `checkin.idle.light` and `checkin.in_fence.light` (the moment)
4. `feed.light` (results and a review)
5. `settle-up.light` (who owes whom; Venmo link)
6. `settings.about.light` (privacy, terms, delete account visible)

No screenshot may show a real person's data; the demo fixtures are fictional names.

## Test the submission build without a Mac

`eas build --profile production --platform ios` (cloud) → `eas submit --platform ios` uploads to
TestFlight; install on the registered iPhone; walk the checklist. `docs/TESTING.md` covers the Maestro
flows on an EAS macOS worker for the demo build.
