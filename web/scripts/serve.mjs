// Tiny static server for `dist/` under the Pages base path, used by the screenshot script and
// handy for a local look at the production build: `node scripts/serve.mjs` → http://localhost:4178/final-call/
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };

export function serveDist({ base = '/final-call/', port = 0 } = {}) {
  const server = createServer((req, res) => {
    let url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (url === base.slice(0, -1)) url = base;
    if (!url.startsWith(base)) {
      res.writeHead(404);
      return res.end('not under base');
    }
    let rel = url.slice(base.length) || 'index.html';
    let file = normalize(join(dist, rel));
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: p } = server.address();
      resolve({ server, url: `http://127.0.0.1:${p}${base}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { url } = await serveDist({ port: 4178 });
  console.log(`serving dist at ${url}`);
}
