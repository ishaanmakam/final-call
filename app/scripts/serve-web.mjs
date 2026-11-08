#!/usr/bin/env node
/**
 * Static server for a web export, mounted under a base path with an SPA fallback: the shape GitHub
 * Pages gives the app at https://ishaanmakam.github.io/final-call/app/. Also used by web-smoke.mjs.
 *
 *   node scripts/serve-web.mjs                       # serves dist-web at http://127.0.0.1:8081/final-call/app/
 *   node scripts/serve-web.mjs --dist dist-x --base / --port 5000
 *
 * Requests outside the base path get a 404 (Pages would too); a path under it that is not a file
 * serves index.html, so deep links like /final-call/app/groups/g1 render.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');

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

function normalizeBase(input) {
  const trimmed = (input ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/**
 * Serves `root` under `base` ("" for the site root). Resolves to { server, port, origin, url }.
 * `port` 0 picks a free one.
 */
export function serveWeb({ root, base = '', port = 0, host = '127.0.0.1' }) {
  const rootDir = resolve(root);
  const baseUrl = normalizeBase(base);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (baseUrl) {
      if (pathname === baseUrl) {
        res.writeHead(302, { location: `${baseUrl}/${url.search}` }).end();
        return;
      }
      if (!pathname.startsWith(`${baseUrl}/`)) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end(`not under ${baseUrl}/`);
        return;
      }
      pathname = pathname.slice(baseUrl.length);
    }
    let file = join(rootDir, pathname);
    if (!file.startsWith(rootDir)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      const candidate = `${file}.html`;
      file = existsSync(candidate) ? candidate : join(rootDir, 'index.html');
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const p = server.address().port;
      const origin = `http://${host}:${p}`;
      resolveServer({ server, port: p, origin, url: `${origin}${baseUrl}/` });
    });
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const root = resolve(appDir, opt('--dist') ?? 'dist-web');
  if (!existsSync(join(root, 'index.html'))) {
    console.error(`No web build at ${root}. Run: node scripts/build-web.mjs --demo`);
    process.exit(1);
  }
  serveWeb({ root, base: opt('--base') ?? process.env.EXPO_WEB_BASE_URL ?? '/final-call/app', port: Number(opt('--port') ?? 8081) })
    .then(({ url }) => console.log(`> serving ${root} at ${url}  (Ctrl+C to stop)`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
