// Hybrid HTTPS server:
//   /api/*                                  -> proxy to V3 backend     (HTTPS 127.0.0.1:8200)
//   /loan-form/*, /form/*, /success, /_next/*, /  -> proxy to v1 Next.js (HTTP  127.0.0.1:3002)
//   everything else                         -> V3 Vite SPA from dist/
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT = process.env.PORT || 3001;
const V1_HTTP    = { host: '127.0.0.1', port: 3002 };           // v1 Next.js
const BACKEND    = { host: '127.0.0.1', port: 8200 };           // V3 FastAPI (HTTPS)
const DIST       = path.join(__dirname, 'dist');
const KEY        = '/etc/letsencrypt/live/virtualvaani.vgipl.com-0002/privkey.pem';
const CERT       = '/etc/letsencrypt/live/virtualvaani.vgipl.com-0002/fullchain.pem';

const MIME = {
  '.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8',
  '.mjs':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg',
  '.jpeg':'image/jpeg','.gif':'image/gif','.svg':'image/svg+xml','.ico':'image/x-icon',
  '.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.map':'application/json',
};

const opts = { key: fs.readFileSync(KEY), cert: fs.readFileSync(CERT) };

function shouldProxyToV1(p) {
  if (p === '/') return true;
  if (p === '/loan-form' || p.startsWith('/loan-form/')) return true;
  if (p === '/success'   || p.startsWith('/success/'))   return true;
  if (p.startsWith('/form/'))     return true;
  if (p.startsWith('/_next/'))    return true;
  if (p === '/__nextjs_original-stack-frame') return true;
  return false;
}

function shouldProxyToBackend(p) {
  return p.startsWith('/api/');
}

function proxyTo(target, useTls, req, res) {
  const lib  = useTls ? https : http;
  const opt  = {
    host: target.host, port: target.port,
    method: req.method, path: req.url, headers: req.headers,
    rejectUnauthorized: false,   // backend cert is for the public hostname, not 127.0.0.1
  };
  opt.headers['x-forwarded-proto'] = 'https';
  opt.headers['x-forwarded-host']  = req.headers.host || '';
  const upstream = lib.request(opt, (ur) => {
    res.writeHead(ur.statusCode || 502, ur.headers);
    ur.pipe(res);
  });
  upstream.on('error', (e) => {
    if (!res.headersSent) {
      res.writeHead(502, {'Content-Type':'text/plain'});
      res.end('upstream unreachable: ' + e.message);
    }
  });
  req.pipe(upstream);
}

function safeJoin(root, p) {
  const r = path.resolve(root, '.' + p);
  if (!r.startsWith(root)) return null;
  return r;
}
function serveStatic(req, res) {
  const u = url.parse(req.url || '/');
  let p = u.pathname || '/';
  if (p === '/') p = '/index.html';
  let fp = safeJoin(DIST, p);
  if (!fp || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) fp = path.join(DIST, 'index.html');
  const ext = path.extname(fp).toLowerCase();
  const ct  = MIME[ext] || 'application/octet-stream';
  const cache = (p === '/index.html') ? 'no-store, must-revalidate' : 'public, max-age=31536000, immutable';
  res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': cache });
  fs.createReadStream(fp).pipe(res);
}

https.createServer(opts, (req, res) => {
  const u = url.parse(req.url || '/');
  const p = u.pathname || '/';
  if (shouldProxyToBackend(p))   return proxyTo(BACKEND, true, req, res);
  if (shouldProxyToV1(p))        return proxyTo(V1_HTTP, false, req, res);
  serveStatic(req, res);
}).listen(PORT, () => {
  console.log('[hybrid] HTTPS :' + PORT
            + '  api -> ' + BACKEND.host + ':' + BACKEND.port
            + '  v1  -> ' + V1_HTTP.host + ':' + V1_HTTP.port);
});
