// Builds the simulator, serves dist/ under the Pages base and captures 1440×900 light and dark
// screenshots of five states into web/screenshots/, plus an index.html contact sheet.
// Uses the installed Chrome (channel 'chrome'); no browser download.
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { serveDist } from './serve.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = fileURLToPath(new URL('../screenshots/', import.meta.url));
mkdirSync(out, { recursive: true });

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
if (!process.argv.includes('--no-build')) {
  console.log('building…');
  execSync('npm run build', { cwd: root, stdio: 'inherit' });
}

/** Each scene drives the page through the store exposed on window.__finalCallSim. */
const SCENES = [
  {
    name: 'initial',
    title: 'Initial state: Monday 7:00, an hour before Boarding',
    run: async (page) => {
      await page.evaluate(() => window.__finalCallSim.actions.setScreen('home'));
    },
  },
  {
    name: 'fence-drag',
    title: 'Fence playground mid-drag: the dot near the edge, the ring touching the fence',
    run: async (page) => {
      await page.evaluate(() => {
        const { actions } = window.__finalCallSim;
        actions.transition('next_window');
        actions.setGps({ dx: 68, dy: 32, accuracyM: 18 });
        actions.setScreen('checkin');
      });
      // a real pointer drag on the dot so the readout is the live one
      const dot = page.locator('[aria-roledescription="draggable point"]');
      const box = await dot.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 14, box.y + box.height / 2 - 10, { steps: 6 });
      await page.waitForTimeout(150);
    },
    after: async (page) => {
      await page.mouse.up();
    },
  },
  {
    name: 'gate-closed',
    title: 'Gate closed: the reveal after your check-in, Diego and Priya missed',
    run: async (page) => {
      await page.evaluate(() => {
        const { actions } = window.__finalCallSim;
        actions.reset();
        actions.setBehaviour('diego', 'no_show');
        actions.setBehaviour('priya', 'out_of_fence');
        actions.transition('next_window');
        actions.setGps({ dx: 0, dy: 0, accuracyM: 12 });
        actions.setScreen('checkin');
        actions.checkInNow();
        actions.transition('gate_closed');
      });
      await page.waitForTimeout(1200);
    },
  },
  {
    name: 'feed-drama',
    title: 'Feed after Drama week: an upheld appeal, a tie, late taps and corrections',
    run: async (page) => {
      await page.evaluate(() => {
        const { actions } = window.__finalCallSim;
        actions.runScenarioToEnd('drama_week');
        actions.markAllSeen();
        actions.setScreen('feed');
      });
      await page.waitForTimeout(300);
      // the appeal lives under Monday, the oldest day: bring it into view, and the ledger beside it
      await page.evaluate(() => {
        const blocks = document.querySelectorAll('.review-block');
        blocks[blocks.length - 1]?.closest('.feed-day')?.scrollIntoView({ block: 'start' });
        document.getElementById('ledger-h')?.closest('.panel')?.scrollIntoView({ block: 'start' });
      });
      await page.waitForTimeout(200);
    },
  },
  {
    name: 'settle-up',
    title: 'Settle up after Monday noon (Typical week): simplified Venmo payments',
    run: async (page) => {
      await page.evaluate(() => {
        const { actions } = window.__finalCallSim;
        actions.runScenarioToEnd('typical_week');
        actions.markAllSeen();
        actions.setScreen('settle');
        const o = window.__finalCallSim.getState().world.obligations.find((x) => x.to === 'you');
        if (o) actions.markPaid(o.id);
      });
      await page.waitForTimeout(300);
      await page.evaluate(() => document.getElementById('settle-h')?.closest('.panel')?.scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(200);
    },
  },
];

const { url, close } = await serveDist();
const browser = await chromium.launch({ channel: 'chrome' });
const shots = [];
try {
  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error('page error:', e.message));
    for (const scene of SCENES) {
      if (only && scene.name !== only) continue;
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.evaluate(() => window.__finalCallSim.setLocatingMs(0));
      await scene.run(page);
      await page.waitForTimeout(400);
      const file = `${scene.name}.${scheme}.png`;
      await page.screenshot({ path: out + file, fullPage: false });
      if (scene.after) await scene.after(page);
      shots.push({ file, title: scene.title, scheme });
      console.log('captured', file);
    }
    await context.close();
  }
} finally {
  await browser.close();
  await close();
}

const html = `<!doctype html><meta charset="utf-8"><title>Final Call simulator screenshots</title>
<style>body{font:14px/1.4 system-ui;margin:24px;background:#f5f6f8;color:#101418}h1{font-size:20px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}figure{margin:0}img{width:100%;border:1px solid #d9dee5;border-radius:8px}figcaption{margin-top:6px;color:#5e6773}</style>
<h1>Final Call web simulator · 1440×900</h1>
<div class="grid">${shots.map((s) => `<figure><img src="${s.file}" alt="${s.title} (${s.scheme})" loading="lazy"><figcaption>${s.title} · ${s.scheme}</figcaption></figure>`).join('\n')}</div>`;
writeFileSync(out + 'index.html', html);
console.log(`wrote ${shots.length} screenshots and index.html to ${out}`);
