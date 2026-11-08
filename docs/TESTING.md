# Testing

How every suite runs locally, how the device flows run without a Mac, and how to read a failure.
The database is the source of truth, so most of the weight is in `supabase/tests`; the device flows
only prove the client wiring on a real iOS build.

## The suites

| Suite | Where | Command | What it proves | Time |
| --- | --- | --- | --- | --- |
| Rules oracle | `packages/rules` | `cd packages/rules && npx tsc --noEmit && npx vitest run` | Verdicts, results, payouts, debt simplification in TS (the oracle the SQL is checked against) | seconds |
| Database | `supabase/tests` | `cd supabase/tests && npx tsc -p tsconfig.json && npx vitest run` | Every migration applied to a fresh PGlite Postgres; ledger invariants, RPC permission checks, attacks, red-team, differential tests against the oracle | ~2.5 min (slower when several runs share the machine) |
| pgTAP mirrors | `supabase/tests/pgtap` | `supabase test db` (needs the Supabase CLI + Docker) | The key invariants again on a real local stack; `pgtap-dryrun.test.ts` runs one file inside the PGlite suite so it is known to pass | minutes |
| Push drainer | `supabase/functions/push-outbox` | `cd supabase/functions/push-outbox && npx tsc --noEmit && npx vitest run` | Outbox batching, Expo receipts, token pruning (`index.ts` itself is Deno-only; CI runs `deno check` advisory) | seconds |
| App | `app` | `cd app && npx tsc --noEmit && npx vitest run` | Strict types for every screen; unit tests for every `features/*` copy and state table and every `lib/*` helper | ~1 min |
| Screenshots | `app` | `cd app; $env:EXPO_PUBLIC_DEMO='1'; npm run screenshots` | Every route in demo mode, light and dark, as the review artifact in `app/screenshots/` | minutes |
| Device flows | `.maestro` | `maestro test .maestro/` (Mac) or the EAS workflow below (no Mac) | Sign-in, check-in, settle-up and appeal on a real iOS Simulator build | ~5 min + a build |
| Maestro lint | `.maestro/lint.mjs` | `node .maestro/lint.mjs` | Every flow parses, uses known commands and declared `${VARS}`, `runFlow` targets exist; the EAS workflow and `eas.json` agree | instant |

Run all of the first five before claiming anything is done (CLAUDE.md). First time in a folder: `npm ci`.
On Windows all of them run natively; nothing needs Docker except the pgTAP mirrors.

### Test-driven rule changes

Anything touching results, payouts, ledger, settlement or obligations starts with a failing test in
`supabase/tests/<area>.test.ts` (helpers in `supabase/tests/README.md`: `createDb`, `asUser`,
`asService`, `createGroupFixture`, `expectError`, `rows`, `scalar`), then a new migration. A changed
payout or result rule also changes `packages/rules` and must keep `differential.test.ts` and
`differential-results.test.ts` green: they run the same scenarios through SQL and TS and diff them.

## Device flows (Maestro)

The flows in `.maestro/` drive the **demo build**: `EXPO_PUBLIC_DEMO=1` is read at bundle time
(`app/src/api/demo/settings.ts`), so the build itself must be made with it. `app/eas.json` has the
profile for that:

```json
"demo-simulator": {
  "distribution": "internal",
  "ios": { "simulator": true },
  "env": { "EXPO_PUBLIC_DEMO": "1" }
}
```

A demo build talks to nobody: auth is a fake session (`demo-user`, "Sam Okafor"), location is a fake
fix after 1.2 s, every query reads `app/src/api/demo/fixtures.ts`, and demo RPCs mutate those
fixtures in memory so a check-in, a vote or "I paid" shows up on refetch. Relaunching resets it.

### How a flow reaches a state

Flows open screens by deep link through the helper `_open.yaml`:

```yaml
- runFlow:
    file: _open.yaml
    env:
      ROUTE: 'groups/g1/ledger?settle=owe'
```

which runs `openLink: ${APP_SCHEME}://<ROUTE>` and taps through iOS's one-time "Open in ...?" prompt.
`APP_SCHEME` defaults to `finalcall` (the scheme in `app/app.config.ts`) in every flow header and
`APP_NAME` to `Final Call`; a build under another scheme or name overrides them with
`-e APP_SCHEME=... -e APP_NAME=...`. `appId` is `com.ishaanmakam.finalcall` in each flow header.

The query string is the demo scenario. In demo mode `DemoParamsSync` reads the *global* route params
(`useGlobalSearchParams`), so a deep link sets them for the whole app until the next navigation,
which drops them back to the defaults. The params and the states they select:

| Param | Flow that uses it | State |
| --- | --- | --- |
| `?signedOut=1` | sign-in | no session: the sign-in screen (Apple fallback button, email field) |
| none, on `/groups` | sign-in | the fake session returns: groups list with "Morning crew" |
| `?freeze=1` | check-in, settle-up | clock stopped at the fixture anchor; the open window stays open and countdowns are deterministic |
| `?verdict=in_fence` (default) | check-in | the demo check-in returns in-fence: "You're in", pill "Showed up" |
| `?verdict=out_of_fence \| unjudgeable \| rejected_simulated` | (not in smoke) | "Not inside your circle yet" / "GPS too weak to judge" / "Location rejected" |
| `?fix=none`, `?perm=denied \| blocked`, `?precise=0` | (not in smoke) | no GPS fix / permission panels / Precise Location off |
| `?state=offline \| error \| queued` | (not in smoke) | every query fails / server error / only the check-in is queued |
| `?settle=owe` | settle-up | you owe Maya $5.00 and Diego $3.00 (headline "You owe $8.00"): the "I paid" side |
| `?settle=owed` | settle-up | Diego $8.25 and Priya $4.25 pay you ("You're owed $12.50"): the "Confirm received" side |
| none, on `/groups/g1/ledger` | settle-up | the mixed week ("You're owed $10.50"); your only payable row is under "Earlier weeks" |
| `?empty=1` | (not in smoke) | a group with nothing in it: every empty state |
| `?budget=N` | (not in smoke) | "N unverified this month" line on the check-in screen |

Demo ids: group `g1`, pacts `p1`..`p6`, today's instances `i-open` (9am in Kane Hall, window open),
`i-before`, `i-closed`, `i-void`, `i-frozen`, `i-notin`, `i-missed` ("Lab notebook by noon", closed 3 h
ago: you missed, Maya showed up, no review yet, so `appeal.yaml` always has a "You, Forfeited" row);
invite code `KANE9AM`. The full list is in
`app/README.md` ("Demo mode") and `app/scripts/screenshot.mjs` (`ROUTES`, which also shows how each
screen is reached and which texts appear).

### What the flows cover

| Flow | Path | Asserts |
| --- | --- | --- |
| `sign-in.yaml` | `sign-in?signedOut=1` → tap "Sign in with Apple" if shown → email `sam@uw.edu` → "Email me a sign-in link" → deep link `groups` | app title, privacy line, "Check your email" with the address, then "Morning crew" on "Groups". Demo cannot mint a session (`lib/auth.tsx` returns early), so the groups list is reached by leaving the `?signedOut` route (DECISIONS.md P4-2). |
| `check-in.yaml` | `groups/g1?freeze=1` → tap the "9am in Kane Hall" card → "Check in" | the screen titled with the pact, "Today's taps", then "You're in", "Counted at …", pill "Showed up", your row "Checked in" in the taps list |
| `settle-up.yaml` | group → "Settle up" row; `ledger?settle=owe` → "I paid" → alert "Mark paid"; `ledger?settle=owed` → "Confirm received" | "You're owed $10.50"; "Marked paid. Maya confirms when it lands." + pill "Marked paid"; "Confirmed $8.25 from Diego." + pill "Confirmed" |
| `appeal.yaml` | `groups/g1/feed` → scroll to a row "You, Forfeited …" → reason → "Send" | sheet "Appeal <date>" with "What happened?", "Add a photo", the default-stands rule; toast "Appeal sent. …", thread "You appealed", pill "Voting open", your reason. The Missed day of yours is today's `i-missed` (pact `p6`), always present (P4-3, resolved by P3-6). |
| `smoke-all.yaml` | the four above in that order | one report; each subflow relaunches with `clearState` |

Selectors are the exact visible strings or accessibility labels from the code. Two iOS facts shape
them: a React Native `Pressable` is one accessibility element, so Maestro sees the TodayCard as
`"9am in Kane Hall, 9:00 AM deadline, …"` and a feed row as `"You, Forfeited $2.00 …"`, never the
"Check in" / "Appeal" texts inside them (the flows match those labels with `.*`); and the check-in
screen titles itself with the pact name, so "Check in" on it is only the big button. No `testID` was
added to any screen; the optional ones are listed in DECISIONS.md P4-4.

### Running Maestro on a Mac

```bash
curl -fsSL "https://get.maestro.mobile.dev" | bash      # Maestro CLI
cd app && npx eas-cli@latest build --profile demo-simulator --platform ios --local   # or download the EAS artifact
# install the .app on a booted simulator
xcrun simctl install booted <path-to>.app
maestro test .maestro/                                 # the four flows, in config.yaml order
maestro test .maestro/smoke-all.yaml                   # as one flow
maestro test -e APP_SCHEME=<other> .maestro/              # a build with an IOS_BUNDLE_ID / scheme override
maestro studio                                         # inspect the live hierarchy, try selectors
```

`maestro studio` is the fastest way to fix a selector: it shows the accessibility tree the flow
sees and lets you tap and assert interactively, then copy the YAML.

### Running Maestro on EAS (no Mac)

Everything runs in Expo's cloud: a macOS worker builds the simulator app, another runs Maestro on it
and keeps a screen recording. One-time setup, from `app/`:

```powershell
cd app
npx eas-cli@latest login
npx eas-cli@latest init          # links the project and prints its projectId
# app.config.ts reads EAS_PROJECT_ID into extra.eas.projectId: make it available to cloud builds
npx eas-cli@latest env:create --name EAS_PROJECT_ID --value <projectId> --environment preview --visibility plaintext
```

(Alternatively put `"EAS_PROJECT_ID": "<id>"` next to `EXPO_PUBLIC_DEMO` in the `demo-simulator`
profile's `env`.) Then:

```powershell
npx eas-cli@latest workflow:run maestro.yml     # from app/; the file is app/.eas/workflows/maestro.yml
```

The run appears under the project's Workflows tab on expo.dev with both jobs; the `maestro` job page
has the per-flow result, the Maestro log, and the screen recording (`record_screen: true`).

To have it run on its own: on expo.dev, project → GitHub, install the GitHub app and link
`ishaanmakam/final-call`, and set the **base directory** to `app` (the Expo project root, where
`eas.json` and `.eas/workflows` live). The workflow then triggers on pushes to `main` and
`night-1`, on pull requests, and from the Workflows tab (`workflow_dispatch`). Simulator builds use
no Apple credentials, so nothing about signing is needed.

`flow_path` in the workflow is `../.maestro/smoke-all.yaml`, relative to `app/`. If an EAS run
refuses the parent path, move the folder (`git mv .maestro app/.maestro`) and change that one line
plus the paths in `.github/workflows/ci.yml` (`maestro-lint`) and this file.

### Debugging a failing flow

1. **Read the step that failed.** Maestro reports the command and the selector; most failures are a
   changed string. Grep the app for the old text (`features/*/copy.ts`, `reviewCopy.ts`,
   `settle/summary.ts`, `components/status.ts`) and update the flow, never the copy, unless the copy
   change was intended.
2. **Look at the artefacts.** Locally, `~/.maestro/tests/<run>/` has a screenshot of the failing
   step and the full hierarchy dump. On EAS, the job page has the recording and the same logs.
3. **Reproduce the state by hand.** The deep link in the flow works in any demo build; on web,
   `cd app; $env:EXPO_PUBLIC_DEMO='1'; npx expo start --web` and open the same route with the
   same query, or capture it with `node scripts/screenshot.mjs --skip-export --only <route>`.
4. **Check the precondition.** `appeal.yaml` needs a Missed day of yours with no appeal: today's
   `i-missed` ("Lab notebook by noon") in `app/src/api/demo/fixtures.ts` is that row; keep it un-reviewed.
5. **Try the selector live** in `maestro studio` (Mac). If a string is genuinely unreachable (the
   iOS driver does not expose it), prefer a composite accessibility label with `.*` over a `testID`;
   if a `testID` is unavoidable, add it to the primitive (`TextField` forwards `testID` to its
   `TextInput`) and use `id:` in the flow.
6. **Lint before pushing.** `node .maestro/lint.mjs` catches indentation slips (a command with two
   keys), unknown commands, undeclared `${VARS}` and missing `runFlow` files; CI runs the same script.

## Continuous integration

`.github/workflows/ci.yml` runs on every push, pull request and by hand (`workflow_dispatch`), with
superseded runs cancelled (`concurrency`). Jobs: `rules`, `db`, `push-outbox`, `app` (the four
suites above), `maestro-lint`, `scripts-typecheck` (only when `scripts/package.json` exists) and
`web` (only when `web/package.json` exists; runs that package's `typecheck`, `test` and `build`
scripts when present). The last two detect their folder in a step after checkout rather than in a
job-level `if: hashFiles(...)`, which is evaluated before the workspace exists and always skips.

The EAS workflow `app/.eas/workflows/maestro.yml` is the device half; GitHub Actions has no iOS
Simulator with the demo build, so the Maestro flows are only linted there.
