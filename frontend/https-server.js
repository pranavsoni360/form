// HTTPS static server for the V3 Vite SPA.
// ESM module (package.json has "type": "module").
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT = process.env.PORT || 3001;
const DIST = path.join(__dirname, 'dist');
const KEY  = '/etc/letsencrypt/live/virtualvaani.vgipl.com-0002/privkey.pem';
const CERT = '/etc/letsencrypt/live/virtualvaani.vgipl.com-0002/fullchain.pem';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.map':  'application/json',
  '.txt':  'text/plain; charset=utf-8',
};

const opts = { key: fs.readFileSync(KEY), cert: fs.readFileSync(CERT) };

function safeJoin(root, p) {
  const r = path.resolve(root, '.' + p);
  if (!r.startsWith(root)) return null;
  return r;
}

https.createServer(opts, (req, res) => {
  const u = url.parse(req.url || '/');
  let p = u.pathname || '/';
  if (p === '/') p = '/index.html';
  let fp = safeJoin(DIST, p);
  if (!fp || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    fp = path.join(DIST, 'index.html');
  }
  const ext = path.extname(fp).toLowerCase();
  const ct = MIME[ext] || 'application/octet-stream';
  const cache = (p === '/index.html' || p === '/')
    ? 'no-store, must-revalidate'
    : 'public, max-age=31536000, immutable';
  res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': cache });
  fs.createReadStream(fp).pipe(res);
}).listen(PORT, () => {
  console.log('[frontend] HTTPS serving ' + DIST + ' on :' + PORT);
});
