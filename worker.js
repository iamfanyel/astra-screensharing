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

      if (url.pathname === '/api/host' || url.pathname === '/api/host/') {
        return await handleHost(request, env);
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

/**
 * Who is hosting a room, decided in one place.
 *
 * A room's members all talk through one of them, and everybody else has to
 * agree on which one - including people who have not arrived yet, since the
 * room code has to lead them to the same peer the existing members are on.
 *
 * The browsers cannot settle that between themselves. They were trying to:
 * whoever holds the broker id `<prefix><CODE>` was treated as the host, but a
 * broker keeps that id registered for a while after its owner has gone, so
 * "the id is taken" never distinguished a live host from a departed one. Two
 * peers could each believe they were hosting, and the room quietly became two
 * rooms wearing the same code.
 *
 * A Durable Object has exactly one instance per name, and its handlers do not
 * run concurrently - so a claim either wins or loses, and everyone is told the
 * same answer. That is the whole reason this exists.
 *
 * The host holds a lease rather than a title: it says it is still there every
 * few seconds, and if it stops, the lease expires and somebody else may take
 * it. A host that has been away long enough to lose the lease is told so the
 * next time it checks in, which is how it learns to stand down instead of
 * carrying on as a second room.
 */
export class RoomHost {
  constructor(state) {
    this.state = state;
    this.room = null;
  }

  async load() {
    if (this.room === null) {
      this.room = (await this.state.storage.get('host')) || { hostId: null, generation: 0, lastSeen: 0 };
    }
    return this.room;
  }

  async save(room) {
    this.room = room;
    await this.state.storage.put('host', room);
  }

  /** A lease nobody has renewed for this long is nobody's. */
  static get LEASE_MS() {
    return 20000;
  }

  held(room, now) {
    return !!room.hostId && now - room.lastSeen < RoomHost.LEASE_MS;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();
    const room = await this.load();
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    const peerId = typeof body.peerId === 'string' ? body.peerId.slice(0, 128) : '';

    if (url.pathname === '/host') {
      return json({
        hostId: this.held(room, now) ? room.hostId : null,
        generation: room.generation,
      });
    }

    if (url.pathname === '/claim') {
      // Granted when the seat is free, when the last holder stopped saying it
      // was there, or when the asker already had it. Otherwise the asker is
      // told who does, which is the answer it actually needs.
      if (!this.held(room, now) || room.hostId === peerId) {
        const next = { hostId: peerId, generation: room.generation + 1, lastSeen: now };
        await this.save(next);
        return json({ ok: true, hostId: next.hostId, generation: next.generation });
      }
      return json({ ok: false, hostId: room.hostId, generation: room.generation });
    }

    if (url.pathname === '/heartbeat') {
      if (room.hostId === peerId) {
        await this.save({ hostId: peerId, generation: room.generation, lastSeen: now });
        return json({ ok: true, hostId: peerId, generation: room.generation });
      }
      // Somebody else holds it now. Saying so is what stops this peer going on
      // as a second host.
      return json({
        ok: false,
        hostId: this.held(room, now) ? room.hostId : null,
        generation: room.generation,
      });
    }

    if (url.pathname === '/release') {
      if (room.hostId === peerId) {
        await this.save({ hostId: null, generation: room.generation + 1, lastSeen: 0 });
      }
      return json({ ok: true });
    }

    return new Response('Not found', { status: 404 });
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS),
  });
}

/**
 * The host lease, over HTTP.
 *
 * Answers `available: false` when the binding is not configured rather than
 * failing, so a deployment without the Durable Object keeps working exactly as
 * it did before - the browsers fall back to the room code's own broker id.
 */
async function handleHost(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const isPost = request.method === 'POST';
  const body = isPost ? await request.clone().json().catch(() => ({})) : {};
  const code = String((isPost ? body.code : url.searchParams.get('code')) || '')
    .trim()
    .toUpperCase();
  if (!ROOM_CODE_REGEX.test(code)) {
    return jsonResponse({ error: 'Invalid room code' }, 400);
  }

  if (!env.ROOM_HOST || typeof env.ROOM_HOST.idFromName !== 'function') {
    return jsonResponse({ available: false });
  }

  const action = isPost ? String(body.action || 'heartbeat') : 'host';
  if (!['host', 'claim', 'heartbeat', 'release'].includes(action)) {
    return jsonResponse({ error: 'Unknown action' }, 400);
  }

  try {
    const stub = env.ROOM_HOST.get(env.ROOM_HOST.idFromName(code));
    const answer = await stub.fetch('https://room/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerId: isPost ? body.peerId : null }),
    });
    const data = await answer.json();
    return jsonResponse(Object.assign({ available: true }, data));
  } catch (err) {
    console.warn('host lease failed:', err);
    // Same shape as a missing binding: the browsers carry on without it.
    return jsonResponse({ available: false });
  }
}

const EMPTY_ROOM_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const STALE_HEARTBEAT_MS = 3 * 60 * 1000; // 3 minutes without heartbeat = treated as empty (tolerant of background tabs)
// Must match `roomCodePattern` in js/config.js.
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

/**
 * Whether anybody is holding this room open at this instant, or null.
 *
 * The stored record cannot answer that. A host says it is alive once a minute,
 * and those heartbeats are deliberately kept out of KV for fifteen minutes at
 * a time because writing one per minute per room would exhaust the day's quota
 * on a single room. They land in `memoryRooms` instead, which belongs to one
 * isolate - so an isolate that has not seen this room falls back to a KV copy
 * whose `lastActive` may be a quarter of an hour behind, and checkRoomState
 * calls anything five minutes behind expired.
 *
 * The host lease has none of that problem. The host renews it every six
 * seconds against a twenty second expiry, and a Durable Object answers for the
 * whole world rather than per isolate, so it is never stale and never differs
 * between two people asking at once. When the cheap answer says a room is
 * gone, this is the one worth asking before believing it.
 *
 * Null for every failure, including no binding at all: that is exactly the
 * state before the lease existed, and the old answer stands.
 */
async function hostHolding(env, code) {
  if (!env || !env.ROOM_HOST || typeof env.ROOM_HOST.idFromName !== 'function') return null;
  try {
    const stub = env.ROOM_HOST.get(env.ROOM_HOST.idFromName(code));
    const answer = await stub.fetch('https://room/host', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerId: null }),
    });
    const data = await answer.json();
    return data && data.hostId ? data.hostId : null;
  } catch (_) {
    return null;
  }
}

async function handleRoom(request, env, ctx) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const url = new URL(request.url);

  if (request.method === 'GET') {
    const code = (url.searchParams.get('code') || '').trim().toUpperCase();
    if (!ROOM_CODE_REGEX.test(code)) {
      return jsonResponse({ error: 'Invalid room code format' }, 400);
    }

    const room = await getStoredRoom(request, env, code);
    const state = room ? checkRoomState(room) : null;

    // Every unhappy answer here - gone, expired, or empty and in need of a new
    // host - is read from a record that may be a quarter of an hour behind
    // what is actually happening, and turning somebody away from a room their
    // friends are sitting in is the worst of the three mistakes. So whenever
    // the stored copy says anything other than "alive and hosted", ask the
    // lease, which cannot be out of date.
    if (!room || state.expired || state.needsHost) {
      // Answered from the lease and not written back: caching this would mean
      // the room went on looking alive here for another five minutes after the
      // host actually left, and asking again costs one Durable Object read.
      if (await hostHolding(env, code)) {
        return jsonResponse({
          exists: true,
          expired: false,
          active: true,
          needsHost: false,
          empty: false,
          remainingMs: EMPTY_ROOM_TIMEOUT_MS,
        });
      }
    }

    if (!room) {
      return jsonResponse({ exists: false, error: 'Room does not exist or has expired.' });
    }

    if (state.expired) {
      // Nobody holds the lease either, so it really has gone.
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
