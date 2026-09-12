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

      if (url.pathname === '/api/friends' || url.pathname === '/api/friends/') {
        return await handleFriends(request, env);
      }

      if (url.pathname === '/api/presence' || url.pathname === '/api/presence/') {
        return await handlePresence(request, env);
      }

      // A friend link: /add/K7QM3XPA. The page is one static file; the code is
      // read from the path by js/add.js, so every code serves the same page.
      if (env.ASSETS && FRIEND_PATH_REGEX.test(url.pathname)) {
        // Without the trailing slash, so the page's ../ paths land on the root.
        if (url.pathname.endsWith('/')) {
          return Response.redirect(new URL(url.pathname.slice(0, -1) + url.search, url).toString(), 301);
        }
        return await env.ASSETS.fetch(new Request(new URL('/add/', url), request));
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
 * Tokens Discord has vouched for recently, per isolate.
 *
 * A signed-in lobby checks in and polls every 25 seconds and a room every 30,
 * and each of those would otherwise be its own round trip to Discord - slow,
 * and a rate limit waiting to happen. A minute is short enough that a revoked
 * token stops working almost at once.
 */
const VERIFIED_TOKEN_TTL_MS = 60 * 1000;
const MAX_VERIFIED_TOKENS = 500;
const verifiedTokens = new Map();

/**
 * Validates the Discord OAuth2 Bearer token directly with Discord API.
 * Returns the Discord user object if valid, or null.
 */
async function verifyDiscordToken(request) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;

  const token = auth.slice(7).trim();
  if (!token) return null;

  const now = Date.now();
  const known = verifiedTokens.get(token);
  if (known && now - known.at < VERIFIED_TOKEN_TTL_MS) return known.user;

  try {
    const res = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!res.ok) {
      verifiedTokens.delete(token);
      return null;
    }
    const user = await res.json();
    if (!user || !user.id) return null;
    if (verifiedTokens.size >= MAX_VERIFIED_TOKENS) verifiedTokens.clear();
    verifiedTokens.set(token, { user, at: now });
    return user;
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
/**
 * Whether somebody is around, and whether they are in a call.
 *
 * One of these per person, named by their Discord id. A Durable Object rather
 * than a value in KV for the same reason RoomHost is one: this changes every
 * half minute per person, and KV's write budget is spent by a single room
 * heartbeating - which is exactly the mistake that made rooms look expired
 * while somebody was sitting in them.
 *
 * It holds almost nothing, deliberately. `at` is when they last said they were
 * here, and anything older than PRESENCE_TTL_MS is simply not here any more -
 * so going offline needs no message, which is good, because a browser that has
 * been closed cannot send one.
 *
 * There is no room code in here. Being in a call is a thing a friend may see;
 * which call, and whether they may walk into it, is a separate decision and
 * not one this makes.
 */
export class Presence {
  constructor(state) {
    this.state = state;
    this.here = null;
    // When `here` last reached storage, as opposed to memory.
    this.storedAt = 0;
  }

  async load() {
    if (this.here === null) {
      this.here = (await this.state.storage.get('here')) || { status: 'offline', at: 0 };
      this.storedAt = this.here.at || 0;
    }
    return this.here;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();
    const here = await this.load();

    if (url.pathname === '/beat') {
      const body = await request.json().catch(() => ({}));
      const status = body.status === 'in-room' ? 'in-room' : 'online';
      const changed = status !== here.status;
      this.here = { status, at: now };
      // Memory answers every peek while this object is alive; storage only
      // matters if it is evicted. So a repeat beat is written at most every
      // PRESENCE_STORE_MS - a copy read back after an eviction is then at most
      // that plus one beat old, still well inside PRESENCE_TTL_MS.
      if (changed || now - this.storedAt >= PRESENCE_STORE_MS) {
        this.storedAt = now;
        await this.state.storage.put('here', this.here);
      }
      return json({ ok: true });
    }

    if (url.pathname === '/peek') {
      const fresh = now - (here.at || 0) < PRESENCE_TTL_MS;
      return json({ status: fresh ? here.status : 'offline' });
    }

    if (url.pathname === '/gone') {
      // Said on the way out, so a friend list does not take a minute to catch
      // up with somebody who closed the tab in front of them.
      this.here = { status: 'offline', at: 0 };
      this.storedAt = now;
      await this.state.storage.put('here', this.here);
      return json({ ok: true });
    }

    return new Response('Not found', { status: 404 });
  }
}

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

/**
 * Friends.
 *
 * Astra has no accounts of its own and is not getting any: the one durable,
 * verified name a person has here is their Discord id, which handleProfile
 * already trusts enough to key a profile on. Everything below hangs off the
 * same check, so a friend list is a second value under a name the server
 * already knows how to prove.
 *
 * There is deliberately no way to search for somebody. A directory of everyone
 * who has ever signed in is a thing to be abused and a thing to leak, and
 * Astra already shares rooms by passing a link around - so friends are added
 * the same way. Each person has one short code, made the first time they ask
 * for it and the same ever after, so their link can be pasted anywhere and
 * keeps working: astrascreen.live/add/K7QM3XPA.
 *
 * Who is online is not kept here: it changes every half minute per person,
 * which is a write budget KV does not have, so it lives in the Presence
 * Durable Object. What this does keep is room invitations, left where a friend
 * will find them - one write when sent, read when they next look at the lobby.
 */

/**
 * A friend code: eight characters from an alphabet without 0/O or 1/I, so it
 * survives being read aloud or typed off a screen. 32^8 is about a trillion,
 * which is far more than there are people to hand out and far too many to
 * guess one's way into somebody's friend list.
 */
const FRIEND_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const FRIEND_CODE_REGEX = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
const FRIEND_PATH_REGEX = /^\/add\/[A-Za-z0-9]{8}\/?$/;

/** How long a room invitation waits to be noticed. A room outlives it rarely. */
const ROOM_INVITE_TTL_S = 60 * 60;

/**
 * How long a heartbeat counts for.
 *
 * Comfortably more than twice the beat, so one dropped request does not make
 * somebody flicker offline in front of their friends.
 */
const PRESENCE_TTL_MS = 90 * 1000;

/** How often a Presence object re-stores an unchanged status. See its /beat. */
const PRESENCE_STORE_MS = 45 * 1000;

/**
 * How many friends' presence one request will go and ask for.
 *
 * Each is a separate Durable Object, so each is a subrequest, and a Worker has
 * a fixed budget of those. Reading the first few dozen and calling the rest
 * offline is a better failure than a request that is refused entirely.
 */
const MAX_PRESENCE_LOOKUPS = 40;

/** Nobody needs more than this, and it bounds every read below. */
const MAX_FRIENDS = 100;
const MAX_INVITES = 20;

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

/** A friend list, always an array, always bounded. */
async function readFriends(kv, id) {
  if (!kv) return [];
  try {
    const raw = await kv.get('friends:' + id);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.slice(0, MAX_FRIENDS) : [];
  } catch (_) {
    return [];
  }
}

/**
 * The public half of somebody's profile.
 *
 * Name and picture are what a friend row draws; the banner is for the page an
 * invite link opens, which shows it behind the invitation. Nothing else from a
 * profile is public, and nothing here is readable without either being their
 * friend or holding a link they made.
 */
async function readPublicProfile(kv, id) {
  const bare = { id, name: 'Someone', avatar: null, banner: null };
  if (!kv) return bare;
  try {
    const raw = await kv.get('profile:' + id);
    if (!raw) return bare;
    const profile = JSON.parse(raw) || {};
    return {
      id,
      name: typeof profile.name === 'string' && profile.name ? profile.name.slice(0, 32) : 'Someone',
      avatar: typeof profile.avatar === 'string' ? profile.avatar : null,
      banner: typeof profile.banner === 'string' ? profile.banner : null,
    };
  } catch (_) {
    return bare;
  }
}

/**
 * Room invitations waiting for somebody, oldest first.
 *
 * The key's TTL restarts with every write, so an old entry can outlive its
 * hour inside a list that keeps getting new ones; the age check drops it.
 */
async function readInvites(kv, id) {
  if (!kv) return [];
  try {
    const raw = await kv.get('roominvites:' + id);
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    const now = Date.now();
    return list
      .filter((invite) => invite && invite.from && now - (invite.at || 0) < ROOM_INVITE_TTL_S * 1000)
      .slice(-MAX_INVITES);
  } catch (_) {
    return [];
  }
}

/**
 * A short fingerprint of who is on a list and who is asking you to join what.
 *
 * Presence polls carry it, so a lobby can tell nothing changed and skip
 * fetching every friend's profile - pictures, banners and all - again.
 * dev-server.js computes the same thing.
 */
function friendsVersion(ids, invites) {
  const text = ids.join(',') + '|' + invites.map((invite) => invite.from + ':' + invite.code).join(',');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36) + '.' + ids.length + '.' + invites.length;
}

/** Both directions, because a friendship only one side knows about is a bug. */
async function linkFriends(kv, a, b) {
  if (!kv || a === b) return false;
  const [aList, bList] = await Promise.all([readFriends(kv, a), readFriends(kv, b)]);
  if (aList.includes(b) && bList.includes(a)) return false;  // already friends
  if (aList.length >= MAX_FRIENDS || bList.length >= MAX_FRIENDS) return false;
  if (!aList.includes(b)) aList.push(b);
  if (!bList.includes(a)) bList.push(a);
  await Promise.all([
    kv.put('friends:' + a, JSON.stringify(aList)),
    kv.put('friends:' + b, JSON.stringify(bList)),
  ]);
  return true;
}

function randomFriendCode() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  // 256 is a multiple of 32, so the modulo is unbiased.
  return Array.from(bytes, (b) => FRIEND_CODE_ALPHABET[b % 32]).join('');
}

/** Codes are shown in capitals but typed however; read them back the same way. */
function normalizeFriendCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return FRIEND_CODE_REGEX.test(code) ? code : null;
}

/**
 * Somebody's friend code, made on first ask and kept for good.
 *
 * Two keys, one each way. A collision with an existing code is checked for and
 * re-rolled; two first asks racing for the same person can each make one, and
 * then both work, which costs nothing.
 */
async function friendCodeFor(kv, id) {
  const existing = await kv.get('friendcodeof:' + id);
  if (existing) return existing;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomFriendCode();
    if (await kv.get('friendcode:' + code)) continue;
    await Promise.all([
      kv.put('friendcode:' + code, id),
      kv.put('friendcodeof:' + id, code),
    ]);
    return code;
  }
  return null;
}

/** The stub for one person's presence, or null when there is no binding. */
function presenceStub(env, id) {
  if (!env || !env.PRESENCE || typeof env.PRESENCE.idFromName !== 'function') return null;
  try {
    return env.PRESENCE.get(env.PRESENCE.idFromName(id));
  } catch (_) {
    return null;
  }
}

/**
 * Say you are here, and find out who else is.
 *
 * Both halves need the sign-in: you can only speak for yourself, and you can
 * only ask about people who have agreed to be your friend. There is no way to
 * ask about somebody else - that would make this a way to watch anybody whose
 * id you could guess.
 */
async function handlePresence(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const user = await verifyDiscordToken(request);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  if (request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const mine = presenceStub(env, user.id);
    if (!mine) return jsonResponse({ ok: false, available: false });
    const path = body.status === 'offline' ? '/gone' : '/beat';
    try {
      await mine.fetch('https://presence' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: body.status }),
      });
    } catch (_) {
      return jsonResponse({ ok: false });
    }
    return jsonResponse({ ok: true });
  }

  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
  }

  const kv = getKvNamespace(env);
  const [friendIds, invites] = await Promise.all([readFriends(kv, user.id), readInvites(kv, user.id)]);
  const ids = friendIds.slice(0, MAX_PRESENCE_LOOKUPS);
  const people = {};

  await Promise.all(ids.map(async (id) => {
    const stub = presenceStub(env, id);
    if (!stub) {
      people[id] = 'offline';
      return;
    }
    try {
      const answer = await stub.fetch('https://presence/peek');
      const data = await answer.json();
      people[id] = data && data.status ? data.status : 'offline';
    } catch (_) {
      people[id] = 'offline';
    }
  }));

  return jsonResponse({ people, version: friendsVersion(friendIds, invites), available: !!env.PRESENCE });
}

async function handleFriends(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const user = await verifyDiscordToken(request);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  const kv = getKvNamespace(env);
  if (!kv) return jsonResponse({ friends: [], invites: [], available: false });

  /*
   * Whose link this is.
   *
   * The page an invite opens has to say whose invitation it is before anybody
   * agrees to anything - an unnamed "become friends?" is a thing nobody should
   * click. A code that matches nobody says only that.
   */
  if (request.method === 'GET' && new URL(request.url).searchParams.has('link')) {
    const code = normalizeFriendCode(new URL(request.url).searchParams.get('link'));
    if (!code) return jsonResponse({ error: 'That link is not a friend link.' }, 400);
    const inviter = await kv.get('friendcode:' + code);
    if (!inviter) return jsonResponse({ error: 'That link does not belong to anyone.' }, 404);
    const already = (await readFriends(kv, user.id)).includes(inviter);
    return jsonResponse({
      from: await readPublicProfile(kv, inviter),
      mine: inviter === user.id,
      already,
    });
  }

  // Everything the friends panel draws, in one round trip: who they are, and
  // anything waiting for them.
  if (request.method === 'GET') {
    const [ids, pending] = await Promise.all([readFriends(kv, user.id), readInvites(kv, user.id)]);

    // An invitation is nearly always from a friend, whose profile is being
    // read anyway - so each person is read once, whichever list names them.
    const profiles = new Map();
    const profileOf = (id) => {
      if (!profiles.has(id)) profiles.set(id, readPublicProfile(kv, id));
      return profiles.get(id);
    };

    // A room the sender has since closed is not worth showing, but this
    // cannot know that - the age limit is what keeps the list from going stale.
    const [friends, invites] = await Promise.all([
      Promise.all(ids.map(profileOf)),
      Promise.all(pending.map(async (invite) => ({
        code: invite.code,
        at: invite.at,
        from: await profileOf(invite.from),
      }))),
    ]);

    return jsonResponse({ friends, invites, version: friendsVersion(ids, pending), available: true });
  }

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
  }

  const body = await request.json().catch(() => ({}));
  const action = String(body.action || '');

  // Your link. The same every time, so it is one read after the first ask.
  if (action === 'link') {
    const code = await friendCodeFor(kv, user.id);
    if (!code) return jsonResponse({ error: 'Could not make a link.' }, 500);
    return jsonResponse({ code });
  }

  if (action === 'accept') {
    const code = normalizeFriendCode(body.code);
    if (!code) return jsonResponse({ error: 'That link is not a friend link.' }, 400);

    const inviter = await kv.get('friendcode:' + code);
    if (!inviter) return jsonResponse({ error: 'That link does not belong to anyone.' }, 404);
    if (inviter === user.id) return jsonResponse({ error: 'That is your own link.' }, 400);

    const added = await linkFriends(kv, inviter, user.id);
    return jsonResponse({ ok: true, added, friend: await readPublicProfile(kv, inviter) });
  }

  if (action === 'remove') {
    const other = String(body.id || '');
    if (!/^\d{5,25}$/.test(other)) return jsonResponse({ error: 'Bad id' }, 400);
    const [mine, theirs] = await Promise.all([readFriends(kv, user.id), readFriends(kv, other)]);
    // Both sides, for the same reason they were linked on both sides - and
    // only the sides that change, since KV writes are the scarce budget.
    const writes = [];
    if (mine.includes(other)) {
      writes.push(kv.put('friends:' + user.id, JSON.stringify(mine.filter((id) => id !== other))));
    }
    if (theirs.includes(user.id)) {
      writes.push(kv.put('friends:' + other, JSON.stringify(theirs.filter((id) => id !== user.id))));
    }
    await Promise.all(writes);
    return jsonResponse({ ok: true });
  }

  // Leave a room invitation where a friend will find it. Only for friends:
  // otherwise this is a way to put a link in a stranger's face.
  if (action === 'invite') {
    const to = String(body.to || '');
    const code = String(body.code || '').trim().toUpperCase();
    if (!ROOM_CODE_REGEX.test(code)) return jsonResponse({ error: 'Bad room code' }, 400);

    const mine = await readFriends(kv, user.id);
    if (!mine.includes(to)) return jsonResponse({ error: 'Not a friend' }, 403);

    // One invitation per sender: asking twice should not fill somebody's list.
    const pending = (await readInvites(kv, to)).filter((invite) => invite.from !== user.id);
    pending.push({ from: user.id, code, at: Date.now() });
    await kv.put('roominvites:' + to, JSON.stringify(pending.slice(-MAX_INVITES)), {
      expirationTtl: ROOM_INVITE_TTL_S,
    });
    return jsonResponse({ ok: true });
  }

  if (action === 'dismiss') {
    const from = String(body.from || '');
    const pending = await readInvites(kv, user.id);
    const left = pending.filter((invite) => invite.from !== from);
    if (left.length !== pending.length) {
      await kv.put('roominvites:' + user.id, JSON.stringify(left), {
        expirationTtl: ROOM_INVITE_TTL_S,
      });
    }
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: 'Unknown action' }, 400);
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
