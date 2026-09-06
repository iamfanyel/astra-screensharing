/**
 * Cloudflare Worker for Astra Screensharing.
 *
 * Provides cross-device user profile sync (name, photo) tied to the user's
 * Discord account using Cloudflare KV, and serves static assets for everything else.
 */

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      // API routes
      if (url.pathname === '/api/profile' || url.pathname === '/api/profile/') {
        return await handleProfile(request, env);
      }

      if (url.pathname === '/api/room' || url.pathname === '/api/room/') {
        return await handleRoom(request, env, ctx);
      }

      // Static assets fallback
      if (env.ASSETS) {
        return await env.ASSETS.fetch(request);
      }

      return new Response('Not found', { status: 404 });
    } catch (err) {
      console.error('Unhandled worker exception:', err);
      return new Response(JSON.stringify({ error: 'Internal Server Error', fallback: true }), {
        status: 200,
        headers: Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS),
      });
    }
  },
};

/**
 * Validates the Discord OAuth2 Bearer token directly with Discord API.
 * Returns the Discord user object if valid, or null.
 */
async function verifyDiscordToken(request) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;

  const token = auth.slice(7).trim();
  if (!token) return null;

  try {
    const res = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user && user.id ? user : null;
  } catch (_) {
    return null;
  }
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

async function handleProfile(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }


  const user = await verifyDiscordToken(request);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS),
    });
  }

  const kv = getKvNamespace(env);


  if (request.method === 'GET') {
    let profile = null;
    if (kv) {
      try {
        const raw = await kv.get('profile:' + user.id);
        if (raw) {
          profile = JSON.parse(raw);
        }
      } catch (_) {}
    }
    return new Response(JSON.stringify({ profile, user: { id: user.id, username: user.username } }), {
      headers: Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS),
    });
  }


  if (request.method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    let existing = {};

    if (kv) {
      try {
        const raw = await kv.get('profile:' + user.id);
        if (raw) {
          existing = JSON.parse(raw);
        }
      } catch (_) {}
    }


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

    if (kv) {
      try {
        await kv.put('profile:' + user.id, JSON.stringify(profile));
      } catch (_) {}
    }

    return new Response(JSON.stringify({ success: true, profile }), {
      headers: Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS),
    });
  }

  return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
}

const EMPTY_ROOM_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const STALE_HEARTBEAT_MS = 3 * 60 * 1000; // 3 minutes without heartbeat = treated as empty (tolerant of background tabs)
const ROOM_CODE_REGEX = /^[A-Z0-9]{4,12}$/;

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

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS),
  });
}

function getKvNamespace(env) {
  if (!env) return null;
  if (env.PROFILES_KV && typeof env.PROFILES_KV.get === 'function') return env.PROFILES_KV;
  if (env.KV && typeof env.KV.get === 'function') return env.KV;
  if (env.sync && typeof env.sync.get === 'function') return env.sync;
  if (env.SYNC && typeof env.SYNC.get === 'function') return env.SYNC;
  for (const key of Object.keys(env)) {
    if (env[key] && typeof env[key].get === 'function' && typeof env[key].put === 'function') {
      return env[key];
    }
  }
  return null;
}

// In-memory Map for fast local responses within the worker isolate
const memoryRooms = new Map();

function pruneMemoryRooms() {
  if (memoryRooms.size <= 50) return;
  const now = Date.now();
  for (const [c, r] of memoryRooms) {
    if (r.emptySince && now - r.emptySince > EMPTY_ROOM_TIMEOUT_MS) {
      memoryRooms.delete(c);
    } else if (now - (r.lastActive || r.createdAt || 0) > 3600000) {
      memoryRooms.delete(c);
    }
  }
}

async function getStoredRoom(request, env, code) {
  // 1. In-memory Map (local isolate)
  let room = memoryRooms.get(code) || null;

  // 2. Cloudflare KV (global persistence)
  if (!room) {
    const kv = getKvNamespace(env);
    if (kv) {
      try {
        const raw = await kv.get('room:' + code);
        if (raw) {
          room = JSON.parse(raw);
        }
      } catch (err) {
        console.warn('KV get failed:', err);
      }
    }
  }

  if (room) {
    memoryRooms.set(code, room);
  }
  return room;
}

async function putStoredRoom(request, env, ctx, code, room, persistToKv = true) {
  memoryRooms.set(code, room);
  pruneMemoryRooms();

  if (!persistToKv) return;

  const kv = getKvNamespace(env);
  if (kv) {
    try {
      await kv.put('room:' + code, JSON.stringify(room), { expirationTtl: 86400 });
    } catch (err) {
      console.warn('KV put failed (rate limited or unavailable):', err);
    }
  }
}

async function deleteStoredRoom(request, env, ctx, code) {
  memoryRooms.delete(code);

  const kv = getKvNamespace(env);
  if (kv) {
    try {
      await kv.delete('room:' + code);
    } catch (_) {}
  }
}

async function handleRoom(request, env, ctx) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const url = new URL(request.url);

  if (request.method === 'GET') {
    if (url.searchParams.get('diag') === '1') {
      const kv = getKvNamespace(env);
      let kvWriteOk = false;
      let kvError = null;
      let kvKeys = [];
      if (kv) {
        try {
          await kv.put('__diag_test__', JSON.stringify({ at: Date.now() }), { expirationTtl: 60 });
          kvWriteOk = true;
          const listRes = await kv.list({ prefix: 'room:', limit: 10 });
          kvKeys = (listRes && listRes.keys ? listRes.keys.map((k) => k.name) : []);
        } catch (err) {
          kvError = String(err && err.message ? err.message : err);
        }
      }
      return jsonResponse({
        kvDetected: !!kv,
        kvWriteOk,
        kvError,
        kvKeys,
        envKeys: Object.keys(env || {}),
        memoryRooms: Array.from(memoryRooms.keys()),
      });
    }

    const code = (url.searchParams.get('code') || '').trim().toUpperCase();
    if (!ROOM_CODE_REGEX.test(code)) {
      return jsonResponse({ error: 'Invalid room code format' }, 400);
    }

    const room = await getStoredRoom(request, env, code);
    if (!room) {
      return jsonResponse({ exists: false, error: 'Room does not exist or has expired.' });
    }

    const state = checkRoomState(room);
    if (state.expired) {
      await deleteStoredRoom(request, env, ctx, code);
      return jsonResponse({ exists: true, expired: true, error: 'This room has expired (empty for more than 5 minutes).' });
    }

    return jsonResponse({
      exists: true,
      expired: false,
      active: true,
      needsHost: state.needsHost,
      empty: state.empty,
      remainingMs: state.remainingMs,
    });
  }

  if (request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const code = String(body.code || '').trim().toUpperCase();
    if (!ROOM_CODE_REGEX.test(code)) {
      return jsonResponse({ error: 'Invalid room code' }, 400);
    }

    const now = Date.now();
    let room = await getStoredRoom(request, env, code);

    const action = body.action || 'heartbeat';

    if (action === 'create') {
      room = {
        code,
        createdAt: now,
        lastActive: now,
        emptySince: null,
        peerCount: 1,
      };
    } else if (action === 'heartbeat') {
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
    } else if (action === 'empty') {
      if (!room) {
        room = { code, createdAt: now, lastActive: now, emptySince: now, peerCount: 0 };
      } else {
        room.emptySince = now;
        room.lastActive = now;
        room.peerCount = 0;
      }
    } else if (action === 'leave') {
      if (room) {
        const count = typeof body.peerCount === 'number' ? body.peerCount : Math.max(0, (room.peerCount || 1) - 1);
        room.peerCount = count;
        room.lastActive = now;
        if (count === 0) {
          room.emptySince = now;
        }
      }
    }

    if (room) {
      const shouldWriteKv = action !== 'heartbeat' || !room.lastKvWrite || (now - room.lastKvWrite > 15 * 60 * 1000);
      if (shouldWriteKv) {
        room.lastKvWrite = now;
      }
      await putStoredRoom(request, env, ctx, code, room, shouldWriteKv);
    }

    return jsonResponse({ success: true, room });
  }

  return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
}
