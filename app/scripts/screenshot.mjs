#!/usr/bin/env node
/**
 * Renders every screen of the demo-mode web build at iPhone 15 size (393x852 @3x), light and
 * dark, with reduced motion so captures are deterministic, into app/screenshots/, and writes a
 * contact sheet (screenshots/index.html).
 *
 *   node scripts/screenshot.mjs            # exports the web bundle first (EXPO_PUBLIC_DEMO=1)
 *   node scripts/screenshot.mjs --skip-export
 *   node scripts/screenshot.mjs --only checkin   # substring filter on route names
 *   node scripts/screenshot.mjs --scheme dark    # one scheme only
 *   node scripts/screenshot.mjs --dist dist-2 --out screenshots-2   # private build + output dirs
 *
 * Uses the installed Chrome (Playwright channel 'chrome'); no browser download needed.
 */
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// --dist <dir> and --out <dir> let parallel workers export and capture without clobbering each other.
const distDir = resolve(appDir, opt('--dist') ?? 'dist');
const outDir = resolve(appDir, opt('--out') ?? 'screenshots');

const VIEWPORT = { width: 393, height: 852 };
const SCALE = 3;
const SCHEMES = opt('--scheme') ? [opt('--scheme')] : ['light', 'dark'];
const ONLY = opt('--only');

const G = 'g1';
const CHECKIN = (q = '') => `/checkin/i-open${q}`;
const tap = (text) => ({ click: text });
const wait = (ms) => ({ wait: ms });

/**
 * name: file stem. path: route (+ demo params). actions: run before the capture.
 * `click` matches an accessible name or visible text; `fill` types into a labelled field.
 */
const ROUTES = [
  { name: 'sign-in', path: '/sign-in?signedOut=1' },
  { name: 'sign-in.invalid', path: '/sign-in?signedOut=1', actions: [{ fill: 'Email', value: 'sam@uw' }, tap('Email me a sign-in link'), wait(300)] },
  { name: 'sign-in.sent', path: '/sign-in?signedOut=1', actions: [{ fill: 'Email', value: 'sam@uw.edu' }, tap('Email me a sign-in link'), wait(600)] },
  { name: 'auth-callback', path: '/auth-callback?signedOut=1' },
  { name: 'auth-callback.expired', path: '/auth-callback?signedOut=1&error=access_denied&error_code=otp_expired' },
  { name: 'groups', path: '/groups?freeze=1' },
  { name: 'groups.empty', path: '/groups?empty=1' },
  { name: 'groups.offline', path: '/groups?state=offline' },
  { name: 'groups.error', path: '/groups?state=error' },
  { name: 'group-home', path: `/groups/${G}?freeze=1` },
  { name: 'group-home.empty', path: `/groups/${G}?empty=1` },
  { name: 'group-home.pacts', path: `/groups/${G}?freeze=1`, actions: [{ scrollTo: 'Weekdays' }, wait(300)] },
  { name: 'group-home.members', path: `/groups/${G}?freeze=1`, actions: [{ scrollTo: 'Invite code' }, wait(300)] },
  { name: 'group-home.menu', path: `/groups/${G}?freeze=1`, actions: [tap('More'), wait(600)] },
  { name: 'group-home.offline', path: `/groups/${G}?state=offline` },
  { name: 'new-group.create', path: '/groups/new?mode=create' },
  { name: 'new-group.create.zone', path: '/groups/new?mode=create', actions: [tap('Settles up in'), wait(700)] },
  { name: 'new-group.join', path: '/groups/new?mode=join' },
  { name: 'new-group.join.error', path: '/groups/new?mode=join', actions: [{ fill: 'Invite link or code', value: 'NOPE123' }, tap('Join'), wait(900)] },
  { name: 'join-link', path: '/join/KANE9AM' },
  { name: 'join-link.error', path: '/join/WRONG42', actions: [tap('Join group'), wait(900)] },
  { name: 'new-pact.step1', path: `/groups/${G}/new-pact` },
  { name: 'new-pact.step1.error', path: `/groups/${G}/new-pact`, actions: [tap('Next'), wait(300)] },
  { name: 'new-pact.step2', path: `/groups/${G}/new-pact`, actions: [{ fill: 'Title', value: '9am class' }, tap('Next'), wait(300)] },
  { name: 'new-pact.timezone', path: `/groups/${G}/new-pact`, actions: [{ fill: 'Title', value: '9am class' }, tap('Next'), wait(300), tap('Time zone'), wait(600)] },
  { name: 'new-pact.step3', path: `/groups/${G}/new-pact`, actions: [{ fill: 'Title', value: '9am class' }, tap('Next'), wait(200), tap('Next'), wait(300)] },
  { name: 'pact-detail', path: '/pacts/p1?freeze=1' },
  { name: 'pact-detail.paused', path: '/pacts/p4?freeze=1' },
  { name: 'pact-detail.unjoined', path: '/pacts/p1?empty=1&freeze=1' },
  { name: 'pact-detail.error', path: '/pacts/p1?state=error' },
  { name: 'pact-detail.upcoming', path: '/pacts/p1?freeze=1', actions: [{ scrollTo: 'Upcoming' }, wait(400)] },
  { name: 'pact-detail.place-pending', path: '/pacts/p1?freeze=1', actions: [{ scrollTo: "Who's in" }, wait(400)] },
  { name: 'pact-detail.place-objected', path: '/pacts/p1?freeze=1', actions: [{ scrollTo: 'Lander Hall' }, wait(400)] },
  { name: 'pact-detail.place-object', path: '/pacts/p1?freeze=1', actions: [{ scrollTo: "Who's in" }, wait(300), tap("Object to Maya Chen's place"), wait(700)] },
  { name: 'place-picker', path: '/pacts/p2/place?freeze=1' },
  { name: 'place-picker.located', path: '/pacts/p2/place?freeze=1', actions: [tap('current location'), wait(1800)] },
  { name: 'place-picker.saved', path: '/pacts/p2/place?freeze=1', actions: [tap('current location'), wait(1800), tap('Save place'), wait(1400)] },
  { name: 'place-picker.locked', path: '/pacts/p1/place?freeze=1' },
  { name: 'place-picker.denied', path: '/pacts/p2/place?freeze=1&perm=denied', actions: [tap('current location'), wait(500)] },
  { name: 'checkin.idle', path: CHECKIN('?freeze=1') },
  { name: 'checkin.locating', path: CHECKIN('?freeze=1'), actions: [tap('Check in'), wait(350)] },
  { name: 'checkin.in_fence', path: CHECKIN('?freeze=1&verdict=in_fence'), actions: [tap('Check in'), wait(2300)] },
  { name: 'checkin.out_of_fence', path: CHECKIN('?freeze=1&verdict=out_of_fence'), actions: [tap('Check in'), wait(2300)] },
  { name: 'checkin.unjudgeable', path: CHECKIN('?freeze=1&verdict=unjudgeable'), actions: [tap('Check in'), wait(2300)] },
  { name: 'checkin.rejected_simulated', path: CHECKIN('?freeze=1&verdict=rejected_simulated'), actions: [tap('Check in'), wait(2300)] },
  { name: 'checkin.no_fix', path: CHECKIN('?freeze=1&fix=none'), actions: [tap('Check in'), wait(2300)] },
  { name: 'checkin.permission', path: CHECKIN('?freeze=1&perm=blocked'), actions: [tap('Check in'), wait(500)] },
  { name: 'checkin.permission.denied', path: CHECKIN('?freeze=1&perm=denied'), actions: [tap('Check in'), wait(500)] },
  { name: 'checkin.approximate', path: CHECKIN('?freeze=1&precise=0'), actions: [tap('Check in'), wait(500)] },
  { name: 'checkin.budget', path: CHECKIN('?freeze=1&budget=2') },
  { name: 'checkin.skew', path: CHECKIN('?freeze=1&skew=300') },
  { name: 'checkin.before', path: '/checkin/i-before?freeze=1' },
  { name: 'checkin.frozen', path: '/checkin/i-frozen?freeze=1' },
  { name: 'checkin.closed', path: '/checkin/i-closed?freeze=1' },
  // the gate-close money moment (Q1): tallying right after the deadline, then each posted outcome
  { name: 'checkin.gate-tallying', path: CHECKIN('?freeze=1&state=gate-closed') },
  { name: 'checkin.gate-win', path: '/checkin/i-closed?freeze=1&outcome=win' },
  { name: 'checkin.gate-forfeit', path: '/checkin/i-closed?freeze=1&outcome=forfeit' },
  { name: 'checkin.gate-unverified', path: '/checkin/i-closed?freeze=1&outcome=unverified' },
  { name: 'checkin.not_participant', path: '/checkin/i-notin?freeze=1' },
  { name: 'checkin.offline', path: CHECKIN('?freeze=1&state=offline') },
  { name: 'feed', path: `/groups/${G}/feed` },
  { name: 'feed.empty', path: `/groups/${G}/feed?empty=1` },
  { name: 'feed.review', path: `/groups/${G}/feed`, actions: [tap('Challenge'), wait(600)] },
  { name: 'feed.place-event', path: `/groups/${G}/feed?freeze=1` },
  { name: 'feed.place-object', path: `/groups/${G}/feed?freeze=1`, actions: [tap("Object to Maya Chen's place"), wait(700)] },
  { name: 'feed.votes', path: `/groups/${G}/feed`, actions: [{ scrollTo: 'appealed' }, wait(300)] },
  { name: 'feed.offline', path: `/groups/${G}/feed?state=offline` },
  { name: 'settle-up', path: `/groups/${G}/ledger` },
  { name: 'settle-up.owe', path: `/groups/${G}/ledger?settle=owe` },
  { name: 'settle-up.owed', path: `/groups/${G}/ledger?settle=owed` },
  { name: 'settle-up.empty', path: `/groups/${G}/ledger?empty=1` },
  { name: 'stats', path: `/groups/${G}/stats?freeze=1` },
  { name: 'stats.streaks', path: `/groups/${G}/stats?freeze=1`, actions: [{ scrollTo: 'A streak is days in a row' }, wait(300)] },
  { name: 'stats.empty', path: `/groups/${G}/stats?empty=1` },
  { name: 'pact-detail.season', path: '/pacts/p1?freeze=1', actions: [{ scrollTo: 'End season' }, wait(400)] },
  { name: 'pact-detail.season-sheet', path: '/pacts/p2?freeze=1', actions: [tap('Start a 4-week season'), wait(700)] },
  { name: 'new-pact.step3.season', path: `/groups/${G}/new-pact`, actions: [{ fill: 'Title', value: '9am class' }, tap('Next'), wait(200), tap('Next'), wait(300), tap('Run as a 4-week season'), wait(400)] },
  { name: 'settings', path: '/settings' },
  { name: 'settings.about', path: '/settings', actions: [{ scrollTo: 'Delete account' }, wait(300)] },
  { name: 'settings.offline', path: '/settings?state=offline' },
  { name: 'legal.privacy', path: '/legal/privacy?signedOut=1' },
  { name: 'legal.terms', path: '/legal/terms?signedOut=1' },
  // last of all: it leaves an attempt in the offline queue, which the next signed-in route would
  // flush (a toast and an extra tap would then show on an unrelated capture)
  { name: 'checkin.queued', path: CHECKIN('?freeze=1&state=queued'), actions: [tap('Check in'), wait(2300)] },
];

function exportWeb() {
  console.log('> expo export --platform web (EXPO_PUBLIC_DEMO=1)');
  const r = spawnSync('npx', ['expo', 'export', '--platform', 'web', '--output-dir', distDir], {
    cwd: appDir,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, EXPO_PUBLIC_DEMO: '1', CI: '1' },
  });
  if (r.status !== 0) {
    console.error('expo export failed');
    process.exit(r.status ?? 1);
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

/** Tiny static server over dist/ with SPA fallback to index.html. */
function serve(root) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let file = join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      const candidate = `${file}.html`;
      file = existsSync(candidate) ? candidate : join(root, 'index.html');
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => resolveServer({ server, port: server.address().port }));
  });
}

async function runActions(page, actions = []) {
  for (const a of actions) {
    if (a.wait) await page.waitForTimeout(a.wait);
    if (a.fill) {
      const field = page.getByLabel(a.fill, { exact: false }).first();
      await field.click();
      await field.fill(a.value);
    }
    if (a.click) {
      const byRole = page.getByRole('button', { name: a.click, exact: false }).first();
      if (await byRole.count()) await byRole.click();
      else await page.getByText(a.click, { exact: false }).first().click();
    }
    // `scrollTo` brings the first element containing the text to the top of the viewport
    if (a.scrollTo) {
      await page.getByText(a.scrollTo, { exact: false }).first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
    }
  }
}

async function settle(page) {
  // wait for the demo queries (350 ms latency) and any skeletons to resolve
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(900);
}

async function main() {
  if (!flag('--skip-export')) exportWeb();
  if (!existsSync(join(distDir, 'index.html'))) {
    console.error(`No web build at ${distDir}. Run without --skip-export.`);
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  const { server, port } = await serve(distDir);
  const base = `http://127.0.0.1:${port}`;
  console.log(`> serving ${distDir} at ${base}`);

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const failures = [];
  const done = [];
  try {
    for (const scheme of SCHEMES) {
      const context = await browser.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: SCALE,
        isMobile: true,
        hasTouch: true,
        colorScheme: scheme,
        reducedMotion: 'reduce',
        locale: 'en-US',
        timezoneId: 'America/Los_Angeles',
      });
      for (const route of ROUTES) {
        if (ONLY && !route.name.includes(ONLY)) continue;
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        page.on('console', (m) => {
          if (m.type() === 'error') errors.push(m.text());
        });
        const file = join(outDir, `${route.name}.${scheme}.png`);
        try {
          await page.goto(`${base}${route.path}`, { waitUntil: 'load', timeout: 30_000 });
          await settle(page);
          await runActions(page, route.actions);
          await page.screenshot({ path: file, fullPage: false });
          done.push({ ...route, scheme, file, errors });
          console.log(`  ok   ${route.name}.${scheme}${errors.length ? `  (${errors.length} console error${errors.length === 1 ? '' : 's'})` : ''}`);
        } catch (e) {
          failures.push({ route: route.name, scheme, error: String(e), errors });
          console.log(`  FAIL ${route.name}.${scheme}: ${String(e).split('\n')[0]}`);
        } finally {
          await page.close();
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  writeContactSheet();
  const withErrors = done.filter((d) => d.errors.length);
  if (withErrors.length) {
    console.log('\nConsole errors during capture:');
    for (const d of withErrors) console.log(`  ${d.name}.${d.scheme}: ${d.errors[0]}`);
  }
  if (failures.length) {
    console.log(`\n${failures.length} capture(s) failed`);
    for (const f of failures) console.log(`  ${f.route}.${f.scheme}: ${f.error.split('\n')[0]}`);
    process.exitCode = 1;
  }
  console.log(`\n${done.length} screenshots in ${outDir}\nopen ${join(outDir, 'index.html')}`);
}

function writeContactSheet() {
  const files = readdirSync(outDir).filter((f) => f.endsWith('.png'));
  const names = [...new Set(files.map((f) => f.replace(/\.(light|dark)\.png$/, '')))];
  const order = new Map(ROUTES.map((r, i) => [r.name, i]));
  names.sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999) || a.localeCompare(b));
  const cards = names
    .map((n) => {
      const pair = ['light', 'dark']
        .map((s) => (files.includes(`${n}.${s}.png`) ? `<figure><img src="${n}.${s}.png" alt="${n} ${s}" loading="lazy"><figcaption>${s}</figcaption></figure>` : `<figure class="missing"><div></div><figcaption>${s} (missing)</figcaption></figure>`))
        .join('');
      return `<section><h2>${n}</h2><div class="pair">${pair}</div></section>`;
    })
    .join('\n');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Final Call screenshots</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; --fg: #101418; --muted: #5E6773; --bg: #F5F6F8; --card: #fff; --line: #D9DEE5; }
  @media (prefers-color-scheme: dark) { :root { --fg: #F3F5F8; --muted: #A6AFBD; --bg: #0C1017; --card: #161C26; --line: #2A3240; } }
  body { margin: 0; padding: 24px; font: 15px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--fg); background: var(--bg); }
  h1 { font-size: 22px; margin: 0 0 4px; } p { margin: 0 0 24px; color: var(--muted); }
  main { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 24px; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 12px 12px 8px; }
  h2 { font-size: 14px; font-weight: 600; margin: 0 0 10px 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  figure { margin: 0; } figcaption { font-size: 12px; color: var(--muted); text-align: center; padding: 6px 0 2px; }
  img, .missing div { width: 100%; aspect-ratio: 393 / 852; border-radius: 12px; border: 1px solid var(--line); display: block; object-fit: cover; object-position: top; background: #000; }
</style></head>
<body>
<h1>Final Call screenshots</h1>
<p>${names.length} routes, light and dark, 393x852 @3x, reduced motion, demo fixtures. Generated ${new Date().toISOString()}.</p>
<main>
${cards}
</main>
</body></html>`;
  writeFileSync(join(outDir, 'index.html'), html);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
