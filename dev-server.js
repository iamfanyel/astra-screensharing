'use strict';
/**
 * Zero-dependency static server for local development.
 *
 * The site itself is 100% static (that is what lets it live on GitHub Pages),
 * but screen capture only works in a secure context — so you cannot just
 * double-click the HTML. Run `npm start` and use http://localhost:3000.
 *
 * Directory URLs behave as GitHub Pages serves them: `/room` redirects to
 * `/room/`, which serves `room/index.html`.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
    if (!file.startsWith(ROOT)) return send(res, 403, 'Forbidden');

    // A directory without its trailing slash would break relative asset paths.
    if (!url.pathname.endsWith('/') && isDirectory(file)) {
      res.writeHead(301, { Location: url.pathname + '/' + url.search });
      return res.end();
    }
    if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');

    fs.readFile(file, (err, body) => {
      if (err) return send(res, 404, 'Not found');
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(body);
    });
  })
  .listen(PORT, () => console.log(`Astra dev server → http://localhost:${PORT}`));

function isDirectory(file) {
  try {
    return fs.statSync(file).isDirectory();
  } catch (_) {
    return false;
  }
}

function send(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}
