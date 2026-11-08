#!/usr/bin/env node
/**
 * Builds the real app for the web: `expo export --platform web` into app/dist-web (single-page
 * output, SPA fallback) with the base path the site is served under.
 *
 *   node scripts/build-web.mjs                       # EXPO_PUBLIC_* from the environment; base path from
 *                                                    # EXPO_WEB_BASE_URL (default /final-call/app)
 *   node scripts/build-web.mjs --demo                # EXPO_PUBLIC_DEMO=1: fixtures, no backend (CI, smoke test)
 *   node scripts/build-web.mjs --base /              # a root deploy / local preview at http://localhost:<port>/
 *   node scripts/build-web.mjs --output-dir dist-x   # private output dir (parallel workers)
 *
 * The Pages workflow runs it with EXPO_WEB_BASE_URL=/final-call/app and the Supabase URL + anon key as
 * repository secrets; without those the app renders its "Setup needed" screen, so the workflow passes
 * --demo when the WEB_APP_DEMO repository variable is 'true' (docs/DEPLOY.md "Web app").
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

export const DEFAULT_BASE = '/final-call/app';

/** "/final-call/app" → "/final-call/app"; "/" or "" → "" (root). Always "/segment…" without a trailing slash. */
export function normalizeBase(input) {
  const trimmed = (input ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export function buildWeb({ outputDir = 'dist-web', base = process.env.EXPO_WEB_BASE_URL ?? DEFAULT_BASE, demo = false } = {}) {
  const distDir = resolve(appDir, outputDir);
  const baseUrl = normalizeBase(base);
  const env = { ...process.env, CI: '1', EXPO_WEB_BASE_URL: baseUrl };
  if (demo) env.EXPO_PUBLIC_DEMO = '1';
  const configured = Boolean(env.EXPO_PUBLIC_SUPABASE_URL && env.EXPO_PUBLIC_SUPABASE_ANON_KEY);
  console.log(
    `> expo export --platform web --output-dir ${outputDir}  (base "${baseUrl || '/'}", ${
      env.EXPO_PUBLIC_DEMO === '1' ? 'demo fixtures' : configured ? 'Supabase configured' : 'NO Supabase config: the app will show "Setup needed"'
    })`,
  );
  // a stale export must never be mistaken for this one
  rmSync(distDir, { recursive: true, force: true });
  // one command string: npx is a .cmd on Windows, so a shell is needed; args as a string avoids DEP0190
  const r = spawnSync(`npx expo export --platform web --output-dir "${distDir}"`, {
    cwd: appDir,
    stdio: 'inherit',
    shell: true,
    env,
  });
  if (r.status !== 0) throw new Error(`expo export failed (exit ${r.status ?? 'signal'})`);

  const index = join(distDir, 'index.html');
  if (!existsSync(index)) throw new Error(`expo export produced no ${index}`);
  // every script/link URL in the page must sit under the base path, or Pages serves 404s for the bundle
  const html = readFileSync(index, 'utf8');
  const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => u.startsWith('/'));
  const outside = baseUrl ? urls.filter((u) => !u.startsWith(`${baseUrl}/`)) : [];
  if (outside.length) throw new Error(`index.html references assets outside the base path ${baseUrl}:\n  ${outside.join('\n  ')}`);
  console.log(`> ${outputDir}/index.html ok: ${urls.length} absolute asset URL(s) under "${baseUrl || '/'}"`);
  return { distDir, baseUrl };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    buildWeb({ outputDir: opt('--output-dir') ?? 'dist-web', base: opt('--base') ?? process.env.EXPO_WEB_BASE_URL ?? DEFAULT_BASE, demo: flag('--demo') });
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
