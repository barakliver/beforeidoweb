#!/usr/bin/env node
// Local preview that mimics Vercel's cleanUrls, so /terms resolves here the
// same way it will in production — and a missing path serves 404.html.
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const PORT = +process.argv[2] || 8099;
const TYPES = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
  '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain;charset=utf-8' };

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);

  // Run the real /api handlers, so the notification path can be exercised
  // locally exactly as it runs on Vercel.
  if (p.startsWith('/api/')) {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      console.log(`\n${req.method} ${p}\n${body}`);
      try {
        const mod = await import(path.join(ROOT, p + '.js'));
        req.body = body;
        await mod.default(req, {
          status(c) { res.statusCode = c; return this; },
          json(o) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); },
        });
      } catch (e) {
        res.statusCode = 500; res.end(String(e && e.message));
      }
    });
    return;
  }

  if (p === '/') p = '/index.html';
  let f = path.join(ROOT, p);
  if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    if (fs.existsSync(f + '.html')) f += '.html';
    else {
      res.writeHead(404, { 'content-type': TYPES['.html'] });
      return res.end(fs.readFileSync(path.join(ROOT, '404.html')));
    }
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
}).listen(PORT, '127.0.0.1', () => console.log(`http://127.0.0.1:${PORT}`));
