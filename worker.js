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
