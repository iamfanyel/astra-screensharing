'use strict';

/**
 * Discord Account Connection for Astra Screensharing.
 *
 * Uses Discord's OAuth2 Implicit Grant (response_type=token, scope=identify)
 * to allow 100% serverless client-side profile sync (name + avatar).
 */
window.AstraDiscord = (function () {
  const DISCORD_KEY = 'astra:discord';
  const DISCORD_TOKEN_KEY = 'astra:discord:token';
  const DISCORD_AVATARS_KEY = 'astra:discord:custom_avatars';
  const DISCORD_LAST_USER_KEY = 'astra:discord:last_user_id';

  /**
   * Returns the stored Discord user metadata or null if not connected.
   */
  function getUser() {
    try {
      const raw = localStorage.getItem(DISCORD_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function getToken() {
    try {
      return localStorage.getItem(DISCORD_TOKEN_KEY);
    } catch (_) {
      return null;
    }
  }

  function setToken(token) {
    try {
      if (token) localStorage.setItem(DISCORD_TOKEN_KEY, token);
      else localStorage.removeItem(DISCORD_TOKEN_KEY);
    } catch (_) {}
  }

  /**
   * Clears Discord connection state from localStorage, remembering the last
   * user ID so preferences can persist if reconnected.
   */
  function disconnect() {
    try {
      const current = getUser();
      if (current && current.id) {
        localStorage.setItem(DISCORD_LAST_USER_KEY, current.id);
      }
      localStorage.removeItem(DISCORD_KEY);
      localStorage.removeItem(DISCORD_TOKEN_KEY);
    } catch (_) {}
  }

  const DEV_USERNAMES = new Set(['imraphy', 'raphy']);

  const DEV_BADGE_SVG =
    '<svg class="badge-dev-icon" viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden="true">' +
    '<path d="M12 2L3 6.5V12C3 17.5 6.8 22.1 12 23.5C17.2 22.1 21 17.5 21 12V6.5L12 2Z" fill="#23A55A"/>' +
    '<path d="M8.5 10L6.5 12L8.5 14" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M15.5 10L17.5 12L15.5 14" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M13 9L11 15" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round"/>' +
    '</svg>';

  let devBadgeTemplate = null;

  /**
   * How a connected account is written wherever it is shown - the profile
   * editor, your own popup, and now other people's popups, which read it from
   * the roster rather than from storage they cannot see. Empty when no account
   * is connected.
   */
  function accountLabel(user) {
    const u = user === undefined ? getUser() : user;
    if (!u || !u.username) return '';
    return '@' + (u.global_name ? u.global_name + ' (' + u.username + ')' : u.username);
  }

  function isDev(user) {
    const u = user || getUser();
    if (!u) return false;
    const username = String(u.username || '').trim().toLowerCase();
    const globalName = String(u.global_name || '').trim().toLowerCase();
    const displayName = String(u.displayName || '').trim().toLowerCase();
    return DEV_USERNAMES.has(username) || DEV_USERNAMES.has(globalName) || DEV_USERNAMES.has(displayName);
  }

  function createDevBadge(title = 'Developer') {
    if (!devBadgeTemplate) {
      devBadgeTemplate = document.createElement('span');
      devBadgeTemplate.className = 'badge-dev';
      devBadgeTemplate.innerHTML = DEV_BADGE_SVG;
    }
    const span = devBadgeTemplate.cloneNode(true);
    span.title = title;
    span.setAttribute('aria-label', title);
    return span;
  }

  /**
   * Pushes profile updates (name and/or photo) to Cloudflare.
   */
  async function syncProfileToCloud(patch, explicitToken) {
    const token = explicitToken || getToken();
    if (!token || !patch) return;

    try {
      await fetch('/api/profile', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: JSON.stringify(patch),
      });
    } catch (err) {
      console.warn('[discord] Cloud profile sync failed:', err);
    }
  }

  /**
   * Fetches saved profile from Cloudflare.
   */
  async function fetchCloudProfile(explicitToken) {
    const token = explicitToken || getToken();
    if (!token) return null;

    try {
      const res = await fetch('/api/profile', {
        headers: {
          Authorization: 'Bearer ' + token,
        },
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data && data.profile ? data.profile : null;
    } catch (err) {
      console.warn('[discord] Cloud profile fetch failed:', err);
      return null;
    }
  }

  let lastSyncedName = null;
  let syncNameTimeout = null;

  function syncName(name) {
    const clean = String(name || '').trim().slice(0, 32);
    if (!clean || clean === lastSyncedName) return;
    clearTimeout(syncNameTimeout);
    syncNameTimeout = setTimeout(() => {
      lastSyncedName = clean;
      syncProfileToCloud({ name: clean });
    }, 400);
  }

  let lastSyncedBanner = null;
  let syncBannerTimeout = null;

  function syncBanner(banner) {
    if (banner === lastSyncedBanner) return;
    clearTimeout(syncBannerTimeout);
    syncBannerTimeout = setTimeout(() => {
      lastSyncedBanner = banner;
      syncProfileToCloud({ banner: banner || null });
    }, 400);
  }

  function getCustomAvatarsMap() {
    try {
      const raw = localStorage.getItem(DISCORD_AVATARS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  /**
   * Returns the saved custom avatar preference for a Discord user ID, or null.
   */
  function getAccountAvatar(userId) {
    try {
      if (!userId) return null;
      const map = getCustomAvatarsMap();
      return map && map[userId] ? map[userId] : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Associates a custom profile picture (or null) with the active Discord account.
   * If the user disconnects or reconnects, this picture is preferred over the Discord CDN picture.
   */
  function saveAccountAvatar(avatarDataUrl, skipCloudSync) {
    try {
      const current = getUser();
      const userId = (current && current.id) || localStorage.getItem(DISCORD_LAST_USER_KEY);
      if (!userId) return;

      const map = getCustomAvatarsMap();
      map[userId] = {
        avatar: avatarDataUrl || null,
        custom: true,
        updatedAt: Date.now(),
      };
      localStorage.setItem(DISCORD_AVATARS_KEY, JSON.stringify(map));

      // Push avatar change to Cloudflare
      if (!skipCloudSync) {
        syncProfileToCloud({ avatar: avatarDataUrl || null });
      }
    } catch (_) {}
  }

  /**
   * Determines the canonical Redirect URI for Discord OAuth2.
   * Resolves to the base site URL (e.g. http://localhost:3000/ or /astra-screensharing/)
   * so users only need to register one redirect URI in the Discord Developer Portal.
   */
  function getRedirectUri() {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    // Always come back through the site root, so only one redirect URI has to
    // be registered in the Discord Developer Portal.
    url.pathname = url.pathname.replace(/room\/?$/, '');
    return url.toString();
  }

  /**
   * Initiates Discord OAuth2 Implicit Grant authorization.
   * @param {string} [returnUrl] - Optional URL to return to after authorization.
   */
  function login(returnUrl) {
    // config.js is the one documented place to change this - no shadow copy.
    const clientId = window.ASTRA && window.ASTRA.discordClientId;
    if (!clientId) {
      console.error('Discord client id is missing from js/config.js.');
      return;
    }

    const redirectUri = getRedirectUri();
    const destination = returnUrl || location.href;
    const state = encodeURIComponent(destination);

    const authUrl =
      'https://discord.com/oauth2/authorize' +
      '?client_id=' + encodeURIComponent(clientId) +
      '&response_type=token' +
      '&scope=identify' +
      '&redirect_uri=' + encodeURIComponent(redirectUri) +
      '&state=' + state;

    window.location.href = authUrl;
  }

  /**
   * Converts a Discord avatar image URL to a 256x256 square data URL
   * compatible with Astra's WebRTC profile exchange.
   */
  async function rasterizeAvatar(url) {
    // Ensure high-resolution (512px) source from Discord CDN if size param is present
    const hiResUrl = typeof url === 'string' ? url.replace(/(\?size=)\d+/, '$1512') : url;
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const size = (window.AstraProfile && window.AstraProfile.SIZE) || 256;
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';

          // Fill neutral background in case of transparency
          ctx.fillStyle = '#161616';
          ctx.fillRect(0, 0, size, size);

          // Center crop to square
          const minDim = Math.min(img.naturalWidth, img.naturalHeight) || size;
          const sx = (img.naturalWidth - minDim) / 2;
          const sy = (img.naturalHeight - minDim) / 2;

          ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, size, size);

          const dataUrl = window.AstraProfile.encode(canvas);
          img.onload = null;
          img.onerror = null;
          resolve(dataUrl);
        } catch (err) {
          img.onload = null;
          img.onerror = null;
          reject(err);
        }
      };
      img.onerror = () => {
        img.onload = null;
        img.onerror = null;
        reject(new Error('Failed to load avatar image from Discord CDN'));
      };
      img.src = hiResUrl;
    });
  }

  /**
   * Converts a Discord banner image URL to a 300x100 JPEG data URL
   * compatible with Astra's WebRTC profile exchange.
   */
  async function rasterizeBanner(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const w = (window.AstraProfile && window.AstraProfile.BANNER_WIDTH) || 300;
          const h = (window.AstraProfile && window.AstraProfile.BANNER_HEIGHT) || 100;
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';

          ctx.fillStyle = '#161616';
          ctx.fillRect(0, 0, w, h);

          // Center crop to 3:1 aspect ratio
          const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
          const bw = img.naturalWidth * scale;
          const bh = img.naturalHeight * scale;
          const sx = (w - bw) / 2;
          const sy = (h - bh) / 2;

          ctx.drawImage(img, sx, sy, bw, bh);

          const bannerUrl = window.AstraProfile ? window.AstraProfile.encodeBanner(canvas) : null;
          img.onload = null;
          img.onerror = null;
          resolve(bannerUrl);
        } catch (err) {
          img.onload = null;
          img.onerror = null;
          reject(err);
        }
      };
      img.onerror = () => {
        img.onload = null;
        img.onerror = null;
        reject(new Error('Failed to load banner image from Discord CDN'));
      };
      img.src = url;
    });
  }

  /**
   * Handles OAuth2 redirect callback containing `#access_token=...` in the URL hash.
   * Extracts token, fetches Discord profile, updates AstraProfile, and cleans URL.
   * If a return destination is in state, redirects there.
   *
   * @param {Object} [options]
   * @param {Function} [options.onSuccess] - Callback when user is loaded successfully.
   * @param {Function} [options.onError] - Callback on failure.
   * @returns {Promise<Object|null>} The loaded Discord user metadata, or null if not a callback.
   */
  async function handleCallback(options) {
    const hash = window.location.hash;
    if (!hash || !hash.includes('access_token=')) {
      return null;
    }

    const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
    const accessToken = params.get('access_token');
    const stateParam = params.get('state');

    // Clean hash from URL without reloading
    if (window.history && window.history.replaceState) {
      const cleanUrl = window.location.pathname + window.location.search;
      window.history.replaceState(null, document.title, cleanUrl);
    }

    if (!accessToken) {
      return null;
    }

    try {
      const res = await fetch('https://discord.com/api/users/@me', {
        headers: {
          Authorization: 'Bearer ' + accessToken,
        },
      });

      if (!res.ok) {
        throw new Error('Discord API responded with ' + res.status);
      }

      const discordUser = await res.json();

      // Modern Discord uses global_name (display name), fallback to username
      const displayName = discordUser.global_name || discordUser.username;

      // Construct avatar URL (handle both custom avatar and default embeds)
      let defaultIndex = 0;
      try {
        defaultIndex =
          discordUser.discriminator && discordUser.discriminator !== '0'
            ? parseInt(discordUser.discriminator, 10) % 5
            : Number((BigInt(discordUser.id) >> 22n) % 6n);
      } catch (_) {
        defaultIndex = 0;
      }

      const avatarCdnUrl = discordUser.avatar
        ? 'https://cdn.discordapp.com/avatars/' + discordUser.id + '/' + discordUser.avatar + '.png?size=512'
        : 'https://cdn.discordapp.com/embed/avatars/' + defaultIndex + '.png';

      const bannerCdnUrl = discordUser.banner
        ? 'https://cdn.discordapp.com/banners/' + discordUser.id + '/' + discordUser.banner + '.png?size=600'
        : null;

      setToken(accessToken);

      const userRecord = {
        id: discordUser.id,
        username: discordUser.username,
        global_name: discordUser.global_name || null,
        displayName: displayName,
        avatarHash: discordUser.avatar || null,
        avatarCdnUrl: avatarCdnUrl,
        bannerHash: discordUser.banner || null,
        bannerCdnUrl: bannerCdnUrl,
        connectedAt: Date.now(),
      };

      try {
        localStorage.setItem(DISCORD_KEY, JSON.stringify(userRecord));
      } catch (_) {}

      // Check Cloudflare for previously saved cross-device profile
      const cloud = await fetchCloudProfile(accessToken);

      if (cloud) {
        // Restore name and avatar from Cloudflare
        if (cloud.name && window.AstraProfile) {
          lastSyncedName = cloud.name;
          window.AstraProfile.setName(cloud.name);
        }
        if (cloud.avatar && window.AstraProfile && window.AstraProfile.isAvatar(cloud.avatar)) {
          window.AstraProfile.setAvatar(cloud.avatar);
          saveAccountAvatar(cloud.avatar, true);
        } else if (cloud.avatar === null && window.AstraProfile) {
          window.AstraProfile.setAvatar(null);
          saveAccountAvatar(null, true);
        }
        if (cloud.banner !== undefined && window.AstraProfile) {
          lastSyncedBanner = cloud.banner;
          window.AstraProfile.setBanner(cloud.banner);
        } else if (bannerCdnUrl && window.AstraProfile && !window.AstraProfile.getBanner()) {
          try {
            const dataUrl = await rasterizeBanner(bannerCdnUrl);
            if (dataUrl && window.AstraProfile.isBanner(dataUrl)) {
              window.AstraProfile.setBanner(dataUrl);
              lastSyncedBanner = dataUrl;
              syncProfileToCloud({ banner: dataUrl }, accessToken);
            }
          } catch (bannerErr) {
            console.warn('AstraDiscord: Could not rasterize banner:', bannerErr);
          }
        }
      } else {
        // First time connecting: initialize from Discord & save to Cloudflare
        if (displayName && window.AstraProfile) {
          window.AstraProfile.setName(displayName);
        }

        const savedPref = getAccountAvatar(discordUser.id);
        let activeAvatar = null;
        if (savedPref && savedPref.custom) {
          if (savedPref.avatar && window.AstraProfile && window.AstraProfile.isAvatar(savedPref.avatar)) {
            window.AstraProfile.setAvatar(savedPref.avatar);
            activeAvatar = savedPref.avatar;
          } else if (savedPref.avatar === null && window.AstraProfile) {
            window.AstraProfile.setAvatar(null);
          }
        } else if (window.AstraProfile) {
          try {
            const dataUrl = await rasterizeAvatar(avatarCdnUrl);
            if (dataUrl && window.AstraProfile.isAvatar(dataUrl)) {
              window.AstraProfile.setAvatar(dataUrl);
              activeAvatar = dataUrl;
            }
          } catch (avatarErr) {
            console.warn('AstraDiscord: Could not rasterize avatar:', avatarErr);
          }
        }

        let activeBanner = window.AstraProfile ? window.AstraProfile.getBanner() : null;
        if (!activeBanner && bannerCdnUrl && window.AstraProfile) {
          try {
            const dataUrl = await rasterizeBanner(bannerCdnUrl);
            if (dataUrl && window.AstraProfile.isBanner(dataUrl)) {
              window.AstraProfile.setBanner(dataUrl);
              activeBanner = dataUrl;
            }
          } catch (bannerErr) {
            console.warn('AstraDiscord: Could not rasterize banner:', bannerErr);
          }
        }

        syncProfileToCloud({
          name: displayName,
          avatar: activeAvatar,
          banner: activeBanner,
        }, accessToken);
      }

      if (options && typeof options.onSuccess === 'function') {
        options.onSuccess(userRecord);
      }

      // Check if state holds a return destination
      if (stateParam) {
        try {
          const target = decodeURIComponent(stateParam);
          const parsed = new URL(target, location.origin);
          if (parsed.origin === location.origin && parsed.href !== location.href) {
            location.href = parsed.href;
            return userRecord;
          }
        } catch (_) {}
      }

      return userRecord;
    } catch (err) {
      console.error('AstraDiscord callback error:', err);
      if (options && typeof options.onError === 'function') {
        options.onError(err);
      }
      return null;
    }
  }

  /**
   * Wire the connect button / connected badge pair that both pages show, and
   * pick up an OAuth redirect if this load is one. Returns the render function
   * so a caller can refresh the badge after the profile changes elsewhere.
   */
  function bindUI(options) {
    const connectBtn = options.connectBtn;
    const badge = options.badge;
    const usernameEl = options.usernameEl;
    const onChange = options.onChange || function () {};
    const onError = options.onError || function () {};

    function render() {
      const user = getUser();
      const connected = !!(user && user.username);
      if (connectBtn) connectBtn.hidden = connected;
      if (badge) badge.hidden = !connected;
      if (connected && usernameEl) usernameEl.textContent = '@' + user.username;
    }

    if (connectBtn) connectBtn.addEventListener('click', () => login());
    if (options.disconnectBtn) {
      options.disconnectBtn.addEventListener('click', () => {
        disconnect();
        render();
        onChange();
      });
    }

    // If already connected with an active token, fetch latest cloud profile in background
    const currentToken = getToken();
    const currentUser = getUser();
    if (currentToken && currentUser) {
      fetchCloudProfile(currentToken).then((cloud) => {
        if (!cloud) return;
        let changed = false;
        if (cloud.name && window.AstraProfile && window.AstraProfile.getName() !== cloud.name) {
          lastSyncedName = cloud.name;
          window.AstraProfile.setName(cloud.name);
          changed = true;
        }
        if (cloud.avatar !== undefined && window.AstraProfile && window.AstraProfile.getAvatar() !== cloud.avatar) {
          if (cloud.avatar && window.AstraProfile.isAvatar(cloud.avatar)) {
            window.AstraProfile.setAvatar(cloud.avatar);
            saveAccountAvatar(cloud.avatar, true);
            changed = true;
          } else if (cloud.avatar === null) {
            window.AstraProfile.setAvatar(null);
            saveAccountAvatar(null, true);
            changed = true;
          }
        }
        if (cloud.banner !== undefined && window.AstraProfile && window.AstraProfile.getBanner() !== cloud.banner) {
          lastSyncedBanner = cloud.banner;
          window.AstraProfile.setBanner(cloud.banner);
          changed = true;
        }
        if (changed) {
          render();
          onChange();
        }
      });
    }

    // Auto-upgrade legacy low-res Discord avatar (< 200px natural width) in background
    if (currentUser && currentUser.avatarCdnUrl) {
      const savedPref = getAccountAvatar(currentUser.id);
      if (!savedPref || !savedPref.custom) {
        const curAvatar = window.AstraProfile ? window.AstraProfile.getAvatar() : null;
        if (curAvatar) {
          const probe = new Image();
          probe.onload = () => {
            if (probe.naturalWidth > 0 && probe.naturalWidth < 200) {
              rasterizeAvatar(currentUser.avatarCdnUrl).then((upgraded) => {
                if (upgraded && window.AstraProfile && window.AstraProfile.isAvatar(upgraded)) {
                  window.AstraProfile.setAvatar(upgraded);
                  saveAccountAvatar(upgraded, false);
                  render();
                  onChange(upgraded);
                }
              }).catch(() => {});
            }
          };
          probe.src = curAvatar;
        }
      }
    }

    handleCallback({
      onSuccess: () => {
        render();
        onChange();
      },
      onError: (err) => onError('Discord connection failed: ' + (err.message || err)),
    });

    render();
    return render;
  }

  return {
    getUser: getUser,
    getToken: getToken,
    disconnect: disconnect,
    login: login,
    handleCallback: handleCallback,
    bindUI: bindUI,
    saveAccountAvatar: saveAccountAvatar,
    getAccountAvatar: getAccountAvatar,
    syncName: syncName,
    syncBanner: syncBanner,
    syncProfileToCloud: syncProfileToCloud,
    fetchCloudProfile: fetchCloudProfile,
    accountLabel: accountLabel,
    isDev: isDev,
    createDevBadge: createDevBadge,
    DEV_BADGE_SVG: DEV_BADGE_SVG,
  };
})();