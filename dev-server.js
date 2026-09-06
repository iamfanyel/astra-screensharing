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

    if (url.pathname === '/api/room' || url.pathname === '/api/room/') {
      return handleApiRoom(req, res, url);
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

const ROOMS_FILE = path.join(ROOT, '.dev-rooms.json');
const EMPTY_ROOM_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const STALE_HEARTBEAT_MS = 3 * 60 * 1000; // 3 minutes without heartbeat = treated as empty (allows background tabs)
// Must match `roomCodePattern` in js/config.js.
const ROOM_CODE_REGEX = /^[A-Z0-9]{4,12}$/;

let devRoomsCache = null;
let devRoomsLastMtime = 0;

function loadDevRooms() {
  try {
    if (fs.existsSync(ROOMS_FILE)) {
      const mtime = fs.statSync(ROOMS_FILE).mtimeMs;
      if (!devRoomsCache || mtime !== devRoomsLastMtime) {
        devRoomsCache = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
        devRoomsLastMtime = mtime;
      }
    } else {
      devRoomsCache = devRoomsCache || {};
    }
  } catch (_) {
    devRoomsCache = devRoomsCache || {};
  }
  return devRoomsCache;
}

function saveDevRooms() {
  if (!devRoomsCache) return;
  try {
    const now = Date.now();
    for (const [code, r] of Object.entries(devRoomsCache)) {
      if (r.emptySince && now - r.emptySince > 3600000) {
        delete devRoomsCache[code];
      }
    }
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(devRoomsCache, null, 2), 'utf8');
    if (fs.existsSync(ROOMS_FILE)) {
      devRoomsLastMtime = fs.statSync(ROOMS_FILE).mtimeMs;
    }
  } catch (_) {}
}

function checkRoomState(room) {
  const now = Date.now();
  let effectiveEmptySince = room.emptySince;
  if (effectiveEmptySince === null || effectiveEmptySince === undefined) {
    if (now - (room.lastActive || room.createdAt) > STALE_HEARTBEAT_MS) {
      effectiveEmptySince = room.lastActive || room.createdAt;
    }
  }

  if (effectiveEmptySince !== null && effectiveEmptySince !== undefined) {
    const elapsed = now - effectiveEmptySince;
    if (elapsed >= EMPTY_ROOM_TIMEOUT_MS) {
      return { expired: true, empty: true, needsHost: false, remainingMs: 0 };
    }
    return { expired: false, empty: true, needsHost: true, remainingMs: EMPTY_ROOM_TIMEOUT_MS - elapsed };
  }

  return { expired: false, empty: false, needsHost: false, remainingMs: EMPTY_ROOM_TIMEOUT_MS };
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function handleApiRoom(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const rooms = loadDevRooms();

  if (req.method === 'GET') {
    const code = (url.searchParams.get('code') || '').trim().toUpperCase();
    if (!ROOM_CODE_REGEX.test(code)) {
      return sendJson(res, 400, { error: 'Invalid room code format' });
    }

    const room = rooms[code];
    if (!room) {
      return sendJson(res, 200, { exists: false, error: 'Room does not exist or has expired.' });
    }

    const state = checkRoomState(room);
    if (state.expired) {
      return sendJson(res, 200, { exists: true, expired: true, error: 'This room has expired (empty for more than 5 minutes).' });
    }

    return sendJson(res, 200, {
      exists: true,
      expired: false,
      active: true,
      needsHost: state.needsHost,
      empty: state.empty,
      remainingMs: state.remainingMs,
    });
  }

  if (req.method === 'POST') {
    let bodyStr = '';
    req.on('data', (chunk) => (bodyStr += chunk));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(bodyStr);
      } catch (_) {}

      const code = String(body.code || '').trim().toUpperCase();
      if (!ROOM_CODE_REGEX.test(code)) {
        return sendJson(res, 400, { error: 'Invalid room code' });
      }

      const action = body.action || 'heartbeat';
      const now = Date.now();
      let room = rooms[code];

      if (action === 'create') {
        room = {
          code,
          createdAt: now,
          lastActive: now,
          emptySince: null,
          peerCount: 1,
        };
        rooms[code] = room;
        saveDevRooms();
        return sendJson(res, 200, { success: true, room });
      }

      if (action === 'heartbeat') {
        if (!room) {
          room = { code, createdAt: now, lastActive: now, emptySince: null, peerCount: 1 };
        }
        const count = typeof body.peerCount === 'number' ? body.peerCount : (room.peerCount || 1);
        room.lastActive = now;
        room.peerCount = count;
        if (count > 0) {
          room.emptySince = null;
        } else if (count === 0 && !room.emptySince) {
          room.emptySince = now;
        }
        rooms[code] = room;
        saveDevRooms();
        return sendJson(res, 200, { success: true });
      }

      if (action === 'empty') {
        if (!room) {
          room = { code, createdAt: now, lastActive: now, emptySince: now, peerCount: 0 };
        } else {
          room.emptySince = now;
          room.lastActive = now;
          room.peerCount = 0;
        }
        rooms[code] = room;
        saveDevRooms();
        return sendJson(res, 200, { success: true });
      }

      if (action === 'leave') {
        if (room) {
          const count = typeof body.peerCount === 'number' ? body.peerCount : Math.max(0, (room.peerCount || 1) - 1);
          room.peerCount = count;
          room.lastActive = now;
          if (count === 0) {
            room.emptySince = now;
          }
          rooms[code] = room;
          saveDevRooms();
        }
        return sendJson(res, 200, { success: true });
      }

      sendJson(res, 400, { error: 'Unknown action' });
    });
    return;
  }

  res.writeHead(405, { 'Content-Type': 'text/plain' });
  res.end('Method not allowed');
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
          // Deliberately looser than the client's own caps (MAX_LENGTH 30000 /
          // BANNER_MAX_LENGTH 45000 in js/profile.js): slack for older payloads,
          // never a licence to store something the client would then reject.
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
