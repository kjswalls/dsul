import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };

/** Serves OUT (default dist). `delays` maps a path substring to a response delay in ms. */
export function serve(out = process.env.OUT ?? 'dist', delays = {}) {
  const root = path.join(here, out);
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
      if (!file.startsWith(root) || !fs.existsSync(file)) {
        res.writeHead(404).end();
        return;
      }
      const delay = Object.entries(server.delays).find(([k]) => url.pathname.includes(k))?.[1] ?? 0;
      setTimeout(() => {
        res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
        fs.createReadStream(file).pipe(res);
      }, delay);
    });
    server.delays = delays;
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}
