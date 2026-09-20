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
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
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

    if (url.pathname === '/api/friends' || url.pathname === '/api/friends/') {
      return handleApiFriends(req, res);
    }

    if (url.pathname === '/api/presence' || url.pathname === '/api/presence/') {
      return handleApiPresence(req, res);
    }

    // A friend link's preview card, as live: the stored one, or the plain art.
    const cardMatch = url.pathname.match(/^\/add\/([A-Za-z0-9]{8})\/card\.jpg$/);
    if (cardMatch) {
      const card = loadDevFriends().cards[cardMatch[1].toUpperCase()];
      if (!card) {
        res.writeHead(302, { Location: '/astrabannerfriends.png' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' });
      return res.end(Buffer.from(card.image, 'base64'));
    }

    // A friend link, /add/K7QM3XPA: the same page for every code, as live.
    if (/^\/add\/[A-Za-z0-9]{8}\/?$/.test(url.pathname)) {
      if (url.pathname.endsWith('/')) {
        res.writeHead(301, { Location: url.pathname.slice(0, -1) + url.search });
        return res.end();
      }
      return fs.readFile(path.join(ROOT, 'add', 'index.html'), 'utf8', (err, body) => {
        if (err) return send(res, 404, 'Not found');
        res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' });
        res.end(body.replace('</head>', devFriendPreviewTags(req, url) + '\n</head>'));
      });
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
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function handleApiRoom(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
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
      headers: {
        Authorization: 'Bearer ' + token,
        'User-Agent': 'AstraScreensharing/1.0 (+https://astrascreen.live)',
      },
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
          typeof body.avatar === 'string' && body.avatar.length <= 50000 && body.avatar.startsWith('data:image/')
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

/**
 * Friends and presence, locally.
 *
 * The deployed versions live in worker.js, on KV and a Durable Object. Neither
 * exists on a laptop, so this keeps the same shapes in one JSON file beside
 * the room and profile stores - enough to click through the whole feature
 * before it goes anywhere near a deploy.
 *
 * The sign-in is real. Like the profile endpoint above, this asks Discord
 * whether the token is good, so a local run exercises the same identity the
 * live one does rather than a fake id that would hide the interesting bugs.
 *
 * Kept deliberately close to the worker: the same limits, the same lifetimes,
 * the same refusals. A local run that behaves differently from production is
 * worse than no local run, because it teaches you the wrong thing.
 */
const FRIENDS_FILE = path.join(ROOT, '.dev-friends.json');

const FRIEND_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const FRIEND_CODE_REGEX = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
const ROOM_INVITE_TTL_MS = 60 * 60 * 1000;
const PRESENCE_TTL_MS = 90 * 1000;
const MAX_FRIENDS = 100;
const MAX_INVITES = 20;

function loadDevFriends() {
  try {
    if (fs.existsSync(FRIENDS_FILE)) {
      const data = JSON.parse(fs.readFileSync(FRIENDS_FILE, 'utf8'));
      return {
        friends: data.friends || {},
        codes: data.codes || {},
        cards: data.cards || {},
        invites: data.invites || {},
        presence: data.presence || {},
      };
    }
  } catch (_) {}
  return { friends: {}, codes: {}, cards: {}, invites: {}, presence: {} };
}

function saveDevFriends(data) {
  try {
    fs.writeFileSync(FRIENDS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) {}
}

/** The signed-in Discord user, or null. Asked of Discord, exactly as live. */
async function discordUser(req) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) return null;
  try {
    const answer = await fetch('https://discord.com/api/users/@me', {
      headers: {
        Authorization: auth,
        'User-Agent': 'AstraScreensharing/1.0 (+https://astrascreen.live)',
      },
    });
    if (!answer.ok) return null;
    const user = await answer.json();
    return user && user.id ? user : null;
  } catch (_) {
    return null;
  }
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(text));
      } catch (_) {
        resolve({});
      }
    });
  });
}

function devCors(res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  });
  res.end();
}

/**
 * What a friend row needs, from the same store the profile endpoint writes.
 * Pass the store in when drawing a whole list, so the file is read once.
 */
function devPublicProfile(id, profiles = loadDevProfiles()) {
  const profile = profiles[id] || {};
  return {
    id,
    name: typeof profile.name === 'string' && profile.name ? profile.name.slice(0, 32) : 'Someone',
    avatar: typeof profile.avatar === 'string' ? profile.avatar : null,
    banner: typeof profile.banner === 'string' ? profile.banner : null,
  };
}

function normalizeFriendCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return FRIEND_CODE_REGEX.test(code) ? code : null;
}

/** Who a code belongs to. Codes are stored code -> id, as the worker's KV is. */
function devCodeOwner(store, code) {
  return code && Object.prototype.hasOwnProperty.call(store.codes, code) ? store.codes[code] : null;
}

/** Somebody's existing code, or null. */
function devCodeOf(store, id) {
  for (const [code, owner] of Object.entries(store.codes)) {
    if (owner === id) return code;
  }
  return null;
}

/** Somebody's code, made on first ask and kept for good. */
function devFriendCodeFor(store, id) {
  const existing = devCodeOf(store, id);
  if (existing) return existing;
  let code;
  do {
    code = Array.from(crypto.randomBytes(8), (b) => FRIEND_CODE_ALPHABET[b % 32]).join('');
  } while (devCodeOwner(store, code));
  store.codes[code] = id;
  return code;
}

function devEscape(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** The link-preview tags withFriendLinkPreview writes live, for a local look. */
function devFriendPreviewTags(req, url) {
  const origin = 'http://' + (req.headers.host || 'localhost:' + PORT);
  const code = url.pathname.split('/')[2].toUpperCase();
  const store = loadDevFriends();
  const owner = devCodeOwner(store, code);
  const name = owner ? devPublicProfile(owner).name : null;
  const card = store.cards[code];
  const title = name ? name + ' wants to be friends on Astra' : 'A friend request on Astra';
  const description = 'Open the link to accept and add ' + (name || 'them') + ' as a friend on Astra.';
  const image = card
    ? origin + '/add/' + code + '/card.jpg?v=' + encodeURIComponent(card.version)
    : origin + '/astrabannerfriends.png';
  return [
    ['property', 'og:type', 'website'],
    ['property', 'og:site_name', 'Astra'],
    ['property', 'og:url', origin + url.pathname],
    ['property', 'og:title', title],
    ['property', 'og:description', description],
    ['property', 'og:image', image],
    ['property', 'og:image:width', card ? '1200' : '2400'],
    ['property', 'og:image:height', card ? '675' : '1350'],
    ['name', 'twitter:card', 'summary_large_image'],
    ['name', 'twitter:title', title],
    ['name', 'twitter:image', image],
  ].map(([attr, key, value]) => '<meta ' + attr + '="' + key + '" content="' + devEscape(value) + '" />').join('\n');
}

/** Invitations still inside their hour. */
function devInvites(store, id, now) {
  return (store.invites[id] || [])
    .filter((invite) => invite && invite.from && now - (invite.at || 0) < ROOM_INVITE_TTL_MS)
    .slice(-MAX_INVITES);
}

/** Same fingerprint as friendsVersion in worker.js - see there. */
function devFriendsVersion(ids, invites) {
  const text = ids.join(',') + '|' + invites.map((invite) => invite.from + ':' + invite.code).join(',');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36) + '.' + ids.length + '.' + invites.length;
}

function devFriendList(store, id) {
  const list = store.friends[id];
  return Array.isArray(list) ? list.slice(0, MAX_FRIENDS) : [];
}

async function handleApiFriends(req, res) {
  if (req.method === 'OPTIONS') return devCors(res);

  const user = await discordUser(req);
  if (!user) return sendJson(res, 401, { error: 'Unauthorized' });

  const store = loadDevFriends();
  const now = Date.now();

  // Whose link this is - the page an invite opens has to name whose
  // invitation it is before anybody agrees to anything.
  const link = new URL(req.url, 'http://localhost').searchParams.get('link');
  if (req.method === 'GET' && link !== null) {
    const code = normalizeFriendCode(link);
    if (!code) return sendJson(res, 400, { error: 'That link is not a friend link.' });
    const owner = devCodeOwner(store, code);
    if (!owner) return sendJson(res, 404, { error: 'That link does not belong to anyone.' });
    return sendJson(res, 200, {
      from: devPublicProfile(owner),
      mine: owner === user.id,
      already: devFriendList(store, user.id).includes(owner),
    });
  }

  if (req.method === 'GET') {
    const profiles = loadDevProfiles();
    const ids = devFriendList(store, user.id);
    const pending = devInvites(store, user.id, now);
    const friends = ids.map((id) => devPublicProfile(id, profiles));
    const invites = pending.map((invite) => ({
      code: invite.code,
      at: invite.at,
      from: devPublicProfile(invite.from, profiles),
    }));
    return sendJson(res, 200, { friends, invites, version: devFriendsVersion(ids, pending), available: true });
  }

  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });

  const body = await readJsonBody(req);
  const action = String(body.action || '');

  if (action === 'card') {
    const code = devCodeOf(store, user.id);
    if (!code) return sendJson(res, 200, { ok: false, linked: false });
    if (!body.image) {
      return sendJson(res, 200, { ok: true, linked: true, version: store.cards[code] ? store.cards[code].version : null });
    }
    const version = String(body.version || '');
    const image = String(body.image || '');
    const prefix = 'data:image/jpeg;base64,';
    if (!/^[a-z0-9.]{1,40}$/.test(version)) return sendJson(res, 400, { error: 'Bad version' });
    if (!image.startsWith(prefix) || image.length > 400 * 1000) return sendJson(res, 400, { error: 'Bad image' });
    const bytes = Buffer.from(image.slice(prefix.length), 'base64');
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      return sendJson(res, 400, { error: 'Bad image' });
    }
    store.cards[code] = { version, image: bytes.toString('base64') };
    saveDevFriends(store);
    return sendJson(res, 200, { ok: true, linked: true, version });
  }

  if (action === 'link') {
    const code = devFriendCodeFor(store, user.id);
    saveDevFriends(store);
    return sendJson(res, 200, { code, card: store.cards[code] ? store.cards[code].version : null });
  }

  if (action === 'accept') {
    const code = normalizeFriendCode(body.code);
    if (!code) return sendJson(res, 400, { error: 'That link is not a friend link.' });

    const owner = devCodeOwner(store, code);
    if (!owner) return sendJson(res, 404, { error: 'That link does not belong to anyone.' });
    if (owner === user.id) return sendJson(res, 400, { error: 'That is your own link.' });

    const mine = devFriendList(store, user.id);
    const theirs = devFriendList(store, owner);
    if (!mine.includes(owner) && (mine.length >= MAX_FRIENDS || theirs.length >= MAX_FRIENDS)) {
      return sendJson(res, 200, { ok: true, added: false, friend: devPublicProfile(owner) });
    }
    const added = !mine.includes(owner) || !theirs.includes(user.id);
    if (!mine.includes(owner)) mine.push(owner);
    if (!theirs.includes(user.id)) theirs.push(user.id);
    store.friends[user.id] = mine;
    store.friends[owner] = theirs;
    saveDevFriends(store);
    return sendJson(res, 200, { ok: true, added, friend: devPublicProfile(owner) });
  }

  if (action === 'remove') {
    const other = String(body.id || '');
    if (!/^[0-9]{5,25}$/.test(other)) return sendJson(res, 400, { error: 'Bad id' });
    store.friends[user.id] = devFriendList(store, user.id).filter((id) => id !== other);
    store.friends[other] = devFriendList(store, other).filter((id) => id !== user.id);
    saveDevFriends(store);
    return sendJson(res, 200, { ok: true });
  }

  if (action === 'invite') {
    const to = String(body.to || '');
    const code = String(body.code || '').trim().toUpperCase();
    if (!ROOM_CODE_REGEX.test(code)) return sendJson(res, 400, { error: 'Bad room code' });
    if (!devFriendList(store, user.id).includes(to)) {
      return sendJson(res, 403, { error: 'Not a friend' });
    }
    // One per sender, so asking twice does not fill somebody's list.
    const pending = devInvites(store, to, now).filter((invite) => invite.from !== user.id);
    pending.push({ from: user.id, code, at: now });
    store.invites[to] = pending.slice(-MAX_INVITES);
    saveDevFriends(store);
    return sendJson(res, 200, { ok: true });
  }

  if (action === 'dismiss') {
    const from = String(body.from || '');
    store.invites[user.id] = devInvites(store, user.id, now).filter((invite) => invite.from !== from);
    saveDevFriends(store);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 400, { error: 'Unknown action' });
}

async function handleApiPresence(req, res) {
  if (req.method === 'OPTIONS') return devCors(res);

  const user = await discordUser(req);
  if (!user) return sendJson(res, 401, { error: 'Unauthorized' });

  const store = loadDevFriends();
  const now = Date.now();

  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    if (body.status === 'offline') {
      store.presence[user.id] = { status: 'offline', at: 0 };
    } else {
      store.presence[user.id] = {
        status: body.status === 'in-room' ? 'in-room' : 'online',
        at: now,
      };
    }
    saveDevFriends(store);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });

  // Only your own friends, and anything unheard for PRESENCE_TTL_MS is gone -
  // which is also how somebody who closed the tab stops showing as here.
  const people = {};
  const ids = devFriendList(store, user.id);
  for (const id of ids) {
    const here = store.presence[id];
    const fresh = here && now - (here.at || 0) < PRESENCE_TTL_MS;
    people[id] = fresh ? here.status : 'offline';
  }
  const version = devFriendsVersion(ids, devInvites(store, user.id, now));
  return sendJson(res, 200, { people, version, available: true });
}

function send(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}
