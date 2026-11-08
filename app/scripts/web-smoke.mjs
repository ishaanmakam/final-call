#!/usr/bin/env node
/**
 * Smoke test of the web app as GitHub Pages serves it: builds the demo export (unless --skip-build),
 * serves it under /final-call/app/ with the SPA fallback (scripts/serve-web.mjs), opens each route in
 * Chrome at 1280x800 light and dark, asserts a known heading, no page errors and no console errors,
 * and saves the captures to app/screenshots-web/ with a contact sheet (index.html).
 *
 *   node scripts/web-smoke.mjs                 # build + smoke (CI and before claiming the web app works)
 *   node scripts/web-smoke.mjs --skip-build    # reuse dist-web
 *   node scripts/web-smoke.mjs --only groups   # substring filter on route names
 *
 * Uses the installed Chrome (Playwright channel 'chrome'); no browser download needed.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { buildWeb } from './build-web.mjs';
import { serveWeb } from './serve-web.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const BASE = '/final-call/app';
const DIST = resolve(appDir, opt('--dist') ?? 'dist-web');
const OUT = resolve(appDir, opt('--out') ?? 'screenshots-web');
const VIEWPORT = { width: 1280, height: 800 };
const SCHEMES = opt('--scheme') ? [opt('--scheme')] : ['light', 'dark'];
const ONLY = opt('--only');

/**
 * name: file stem. path: route under the base (the deep links Pages must serve through the SPA
 * fallback). heading: text that proves the right screen rendered. absent: text that must NOT appear.
 * label: a form field that must be present. button: a button that must be present. endsAt: the path a
 * redirect must land on.
 */
const ROUTES = [
  // the site root redirects to /groups ((app)/index.tsx); query params do not survive that redirect,
  // so the signed-out sign-in screen is reached by its own path (as scripts/screenshot.mjs does)
  { name: 'root', path: '/', heading: 'Groups', endsAt: '/groups' },
  // Apple: the native AppleAuthenticationButton renders only on iOS outside demo (sign-in.tsx); the demo build
  // shows a look-alike Button for the screenshot harness, so this build cannot prove its absence. What is
  // checked: the email field and the magic-link button, which is the whole web sign-in.
  { name: 'sign-in', path: '/sign-in?signedOut=1', heading: 'Final Call', label: 'Email', button: 'Email me a sign-in link' },
  { name: 'groups', path: '/groups?freeze=1', heading: 'Groups' },
  { name: 'group-home', path: '/groups/g1?freeze=1', heading: 'Invite code' },
  { name: 'checkin', path: '/checkin/i-open?freeze=1', heading: 'Check in' },
  { name: 'legal.privacy', path: '/legal/privacy?signedOut=1', heading: 'Privacy policy' },
];

/** Console noise that is not a defect of the web app (none known yet; add exact substrings only). */
const IGNORED_CONSOLE = [];

async function main() {
  if (!flag('--skip-build')) buildWeb({ outputDir: opt('--dist') ?? 'dist-web', base: BASE, demo: true });
  if (!existsSync(join(DIST, 'index.html'))) throw new Error(`No web build at ${DIST}. Run without --skip-build.`);
  mkdirSync(OUT, { recursive: true });

  const { server, origin } = await serveWeb({ root: DIST, base: BASE });
  console.log(`> serving ${DIST} at ${origin}${BASE}/`);

  // a request outside the base must 404 (Pages would), and the bare base must redirect to base/
  const outside = await fetch(`${origin}/groups`);
  if (outside.status !== 404) throw new Error(`expected 404 outside the base path, got ${outside.status}`);
  const bare = await fetch(`${origin}${BASE}`, { redirect: 'manual' });
  if (bare.status !== 302) throw new Error(`expected 302 for the bare base path, got ${bare.status}`);

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const failures = [];
  const done = [];
  try {
    for (const scheme of SCHEMES) {
      const context = await browser.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        colorScheme: scheme,
        reducedMotion: 'reduce',
        locale: 'en-US',
        timezoneId: 'America/Los_Angeles',
      });
      for (const route of ROUTES) {
        if (ONLY && !route.name.includes(ONLY)) continue;
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(`pageerror: ${String(e)}`));
        page.on('console', (m) => {
          if (m.type() === 'error' && !IGNORED_CONSOLE.some((s) => m.text().includes(s))) errors.push(`console: ${m.text()}`);
        });
        page.on('response', (r) => {
          if (r.status() >= 400 && r.url().startsWith(origin)) errors.push(`http ${r.status()}: ${r.url()}`);
        });
        const file = join(OUT, `${route.name}.${scheme}.png`);
        const url = `${origin}${BASE}${route.path}`;
        try {
          await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
          await page.waitForLoadState('networkidle').catch(() => undefined);
          await page.waitForTimeout(900);
          // capture first, so a failed assertion still leaves a picture to look at
          await page.screenshot({ path: file, fullPage: false });
          await page.getByText(route.heading, { exact: false }).first().waitFor({ state: 'visible', timeout: 10_000 });
          for (const text of route.absent ?? []) {
            if (await page.getByText(text, { exact: false }).count()) throw new Error(`"${text}" must not render on the web`);
          }
          if (route.label) await page.getByLabel(route.label, { exact: false }).first().waitFor({ state: 'visible', timeout: 5_000 });
          if (route.button) await page.getByRole('button', { name: route.button, exact: false }).first().waitFor({ state: 'visible', timeout: 5_000 });
          // the SPA fallback must have left the deep link in the address bar (not bounced to the index)
          const finalPath = new URL(page.url()).pathname;
          if (!finalPath.startsWith(`${BASE}/`)) throw new Error(`left the base path: ${page.url()}`);
          if (route.endsAt && finalPath !== `${BASE}${route.endsAt}`) throw new Error(`expected to land on ${BASE}${route.endsAt}, got ${finalPath}`);
          if (errors.length) throw new Error(errors.join('\n    '));
          done.push({ ...route, scheme, file });
          console.log(`  ok   ${route.name}.${scheme}  ${finalPath}`);
        } catch (e) {
          failures.push({ route: route.name, scheme, error: String(e) });
          console.log(`  FAIL ${route.name}.${scheme}: ${String(e).split('\n').join('\n       ')}`);
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
  if (failures.length) {
    console.log(`\n${failures.length} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log(`\n${done.length} routes ok at 1280x800 light + dark under ${BASE}/; captures in ${OUT}`);
  }
}

function writeContactSheet() {
  const files = readdirSync(OUT).filter((f) => f.endsWith('.png'));
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
<html lang="en"><head><meta charset="utf-8"><title>Final Call web app screenshots</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; --fg: #101418; --muted: #5E6773; --bg: #F5F6F8; --card: #fff; --line: #D9DEE5; }
  @media (prefers-color-scheme: dark) { :root { --fg: #F3F5F8; --muted: #A6AFBD; --bg: #0C1017; --card: #161C26; --line: #2A3240; } }
  body { margin: 0; padding: 24px; font: 15px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--fg); background: var(--bg); }
  h1 { font-size: 22px; margin: 0 0 4px; } p { margin: 0 0 24px; color: var(--muted); }
  main { display: grid; gap: 24px; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 12px 12px 8px; }
  h2 { font-size: 14px; font-weight: 600; margin: 0 0 10px 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  figure { margin: 0; } figcaption { font-size: 12px; color: var(--muted); text-align: center; padding: 6px 0 2px; }
  img, .missing div { width: 100%; aspect-ratio: 1280 / 800; border-radius: 12px; border: 1px solid var(--line); display: block; object-fit: cover; object-position: top; background: #000; }
</style></head>
<body>
<h1>Final Call web app</h1>
<p>${names.length} routes served under /final-call/app/, 1280x800, light and dark, reduced motion, demo fixtures. Generated ${new Date().toISOString()} by app/scripts/web-smoke.mjs.</p>
<main>
${cards}
</main>
</body></html>`;
  writeFileSync(join(OUT, 'index.html'), html);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
