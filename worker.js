/**
 * Cloudflare Worker for Astra Screensharing.
 *
 * Provides cross-device user profile sync (name, photo) tied to the user's
 * Discord account using Cloudflare KV, and serves static assets for everything else.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // API routes
    if (url.pathname === '/api/profile' || url.pathname === '/api/profile/') {
      return handleProfile(request, env);
    }

    if (url.pathname === '/api/room' || url.pathname === '/api/room/') {
      return handleRoom(request, env);
    }

    // Static assets fallback
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not found', { status: 404 });
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

  const kv = env.PROFILES_KV || env.KV;


  if (request.method === 'GET') {
    let profile = null;
    if (kv) {
      const raw = await kv.get('profile:' + user.id);
      if (raw) {
        try {
          profile = JSON.parse(raw);
        } catch (_) {}
      }
    }
    return new Response(JSON.stringify({ profile, user: { id: user.id, username: user.username } }), {
      headers: Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS),
    });
  }


  if (request.method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    let existing = {};

    if (kv) {
      const raw = await kv.get('profile:' + user.id);
      if (raw) {
        try {
          existing = JSON.parse(raw);
        } catch (_) {}
      }
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
      await kv.put('profile:' + user.id, JSON.stringify(profile));
    }

    return new Response(JSON.stringify({ success: true, profile }), {
      headers: Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS),
    });
  }

  return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
}

const EMPTY_ROOM_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const STALE_HEARTBEAT_MS = 45 * 1000; // 45 seconds without heartbeat = treated as empty
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

async function handleRoom(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const kv = env.PROFILES_KV || env.KV;
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const code = (url.searchParams.get('code') || '').trim().toUpperCase();
    if (!ROOM_CODE_REGEX.test(code)) {
      return jsonResponse({ error: 'Invalid room code format' }, 400);
    }

    if (!kv) {
      return jsonResponse({ exists: true, active: true, needsHost: false });
    }

    const raw = await kv.get('room:' + code);
    if (!raw) {
      return jsonResponse({ exists: false, error: 'Room does not exist or has expired.' });
    }

    let room;
    try {
      room = JSON.parse(raw);
    } catch (_) {
      return jsonResponse({ exists: false, error: 'Invalid room data.' });
    }

    const state = checkRoomState(room);
    if (state.expired) {
      await kv.delete('room:' + code).catch(() => {});
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

    if (!kv) {
      return jsonResponse({ success: true });
    }

    const now = Date.now();
    let room = null;
    const raw = await kv.get('room:' + code);
    if (raw) {
      try {
        room = JSON.parse(raw);
      } catch (_) {}
    }

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
      await kv.put('room:' + code, JSON.stringify(room), { expirationTtl: 86400 });
    }

    return jsonResponse({ success: true, room });
  }

  return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
}
