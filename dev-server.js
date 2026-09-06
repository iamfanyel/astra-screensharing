'use strict';
/**
 * Zero-dependency static server for local development.
 *
 * Screen capture only works in a secure context — so you cannot just
 * double-click the HTML. Run `npm start` and use http://localhost:3000.
 *
 * Directory URLs automatically redirect to trailing slashes: `/room` redirects to
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

    if (url.pathname === '/api/profile' || url.pathname === '/api/profile/') {
      return handleApiProfile(req, res);
    }

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

const PROFILES_FILE = path.join(ROOT, '.dev-profiles.json');

function loadDevProfiles() {
  try {
    return fs.existsSync(PROFILES_FILE) ? JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8')) : {};
  } catch (_) {
    return {};
  }
}

function saveDevProfiles(data) {
  try {
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) {}
}

async function handleApiProfile(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Unauthorized' }));
  }

  const token = auth.slice(7).trim();
  let user = null;
  try {
    const discordRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (discordRes.ok) user = await discordRes.json();
  } catch (_) {}

  if (!user || !user.id) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid Discord token' }));
  }

  const store = loadDevProfiles();

  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ profile: store[user.id] || null, user: { id: user.id, username: user.username } }));
  }

  if (req.method === 'PUT') {
    let bodyStr = '';
    req.on('data', (chunk) => (bodyStr += chunk));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(bodyStr);
      } catch (_) {}

      const existing = store[user.id] || {};
      const cleanName =
        'name' in body ? String(body.name || '').trim().slice(0, 32) : (existing.name || user.global_name || user.username);
      let cleanAvatar = existing.avatar || null;
      if ('avatar' in body) {
        cleanAvatar =
          typeof body.avatar === 'string' && body.avatar.length <= 35000 && body.avatar.startsWith('data:image/')
            ? body.avatar
            : null;
      }

        let cleanBanner = existing.banner || null;
        if ('banner' in body) {
          cleanBanner =
            typeof body.banner === 'string' && body.banner.length <= 50000 && body.banner.startsWith('data:image/')
              ? body.banner
              : null;
        }

        const profile = {
          id: user.id,
          name: cleanName,
          avatar: cleanAvatar,
          banner: cleanBanner,
          updatedAt: Date.now(),
        };

      store[user.id] = profile;
      saveDevProfiles(store);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, profile }));
    });
    return;
  }

  res.writeHead(405, { 'Content-Type': 'text/plain' });
  res.end('Method not allowed');
}

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
