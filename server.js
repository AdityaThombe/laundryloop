'use strict';
// Local server: serves public/ and the API. On Vercel, api/index.js and
// vercel.json do the same job.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { handleApi, init } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};
function serveStatic(pathname, res) {
  let p;
  try { p = decodeURIComponent(pathname); } catch { p = '/'; }
  if (p === '/') p = '/index.html';
  if (!path.extname(p)) p += '.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname.startsWith('/api/')) return handleApi(req, res);
  serveStatic(pathname, res);
});

init().then(() => {
  server.listen(PORT, () => console.log(`LaundryLoop running at http://localhost:${PORT}`));
}).catch((e) => { console.error('Database setup failed:', e); process.exit(1); });
