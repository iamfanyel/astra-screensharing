'use strict';

/**
 * What the Android app tells the page, and what the page asks it for.
 *
 * Two things, both of which a browser handles by itself and the app cannot:
 * where the screen edges are, and how to sign in to Discord.
 *
 * Discord will not authorise anybody inside an embedded browser, and the app
 * is one - so the sign-in has to happen in the real browser, where the user is
 * already signed in to Discord anyway. What comes back cannot come back to a
 * browser tab, though: the token has to reach the app.
 *
 * So the app names itself in `state`, the page Discord redirects to forwards
 * the token to `astra://auth`, and Android hands that to the app. All of that
 * already exists for the desktop build; this is the half that asks for it.
 *
 * None of this loads in a browser: `available()` is false and discord.js goes
 * on navigating to Discord itself.
 */
(function () {
  /** Where the app asked to be called back. Matches DESKTOP_CALLBACK. */
  const CALLBACK = 'astra://auth';

  /** Where to put the user once they are signed in, across the round trip. */
  const RETURN_KEY = 'astra:auth-return';

  /** Whether this is the app at all, which is knowable before any plugin is. */
  function isNative() {
    const capacitor = window.Capacitor;
    if (!capacitor) return false;
    return typeof capacitor.isNativePlatform !== 'function' || capacitor.isNativePlatform();
  }

  function bridge() {
    const capacitor = window.Capacitor;
    if (!capacitor || !isNative()) return null;
    if (capacitor.Plugins && capacitor.Plugins.AstraApp) return capacitor.Plugins.AstraApp;
    // Plugins are not always on Capacitor.Plugins by the time this file runs;
    // registerPlugin builds the same handle on demand.
    if (typeof capacitor.registerPlugin === 'function') {
      try {
        const handle = capacitor.registerPlugin('AstraApp');
        if (handle) return handle;
      } catch (_) {
        // Fall through to whatever Plugins has, if anything.
      }
    }
    return (capacitor.Plugins && capacitor.Plugins.AstraApp) || null;
  }

  function available() {
    return bridge() !== null;
  }

  /** Hand a URL to the system browser rather than opening it in here. */
  async function openExternal(url) {
    const native = bridge();
    if (!native) return false;
    try {
      await native.openExternal({ url });
      return true;
    } catch (_) {
      return false;
    }
  }

  function rememberReturn(url) {
    try {
      localStorage.setItem(RETURN_KEY, url);
    } catch (_) {
      // Without it the sign-in still works; it just lands on the lobby.
    }
  }

  function takeReturn() {
    try {
      const url = localStorage.getItem(RETURN_KEY);
      localStorage.removeItem(RETURN_KEY);
      return url;
    } catch (_) {
      return null;
    }
  }

  /**
   * Collect a token the app is holding for us, if there is one.
   *
   * The app cannot simply push it into the page: on a cold start there is no
   * page yet, and a fragment-only change never re-runs a script. So the app
   * parks it and this asks - on load, and again whenever the app comes back to
   * the front, which is exactly when the browser has just handed it over.
   */
  async function collect() {
    const native = bridge();
    if (!native) return;
    let pending = null;
    try {
      pending = await native.consumePendingAuth();
    } catch (_) {
      return;
    }
    if (!pending || !pending.fragment) return;

    // The fragment has to be on the URL either way: it is where the callback
    // reads the token from, and leaving it off would mean handing it over by
    // some other route than the one every other build uses.
    window.location.hash = forApp(pending.fragment);

    // Changing only the fragment is a same-document navigation, so no script
    // re-runs and nothing would notice the token. Reloading would fix that -
    // and cost a round trip to the site plus everything the page does on
    // load, which is the pause between coming back from the browser and
    // actually being signed in. Calling the callback directly is the same
    // work without the wait.
    const discord = window.AstraDiscord;
    if (discord && typeof discord.handleCallback === 'function') {
      discord.handleCallback();
      return;
    }
    window.location.reload();
  }

  /**
   * Take `state` back out of the fragment before the page reads it.
   *
   * `state` had to name the app on the way out, so the browser would send the
   * token here rather than sign itself in. On the way back that same value
   * tells the callback the token belongs to somebody else, and it forwards it
   * to `astra://auth` - which is this app, which collects it and forwards it
   * again. The token arrived; it just kept being handed straight back out.
   *
   * Where the user was going is not lost by dropping it: it was put aside
   * locally at the same time, and takeReturn() is what reads it.
   */
  function forApp(fragment) {
    const text = fragment.charAt(0) === '#' ? fragment.slice(1) : fragment;
    let params;
    try {
      params = new URLSearchParams(text);
    } catch (_) {
      return text;
    }
    if (params.get('state') !== CALLBACK) return text;
    params.delete('state');
    return params.toString();
  }

  function watch() {
    applyInsets();
    collect();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      // Coming back from the browser is both when a token may be waiting and
      // when the bars may have changed - a rotation, or a keyboard closing.
      applyInsets();
      collect();
    });
    // A rotation changes which edges are inset without the page reloading.
    window.addEventListener('resize', applyInsets);
  }

  // Wired on the platform, not on the plugin: whether the plugin handle exists
  // yet is a question of timing, and getting it wrong here meant the token came
  // back to an app with nobody waiting for it.
  if (isNative()) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', watch, { once: true });
    } else {
      watch();
    }
  }

  /**
   * Tell the page how much of it the system is sitting on top of.
   *
   * The app draws edge to edge, so the status bar and the gesture bar overlap
   * it. A browser would report that through env(safe-area-inset-*), but the
   * Android WebView does not do so dependably - the stylesheet takes the
   * larger of that and these, so wherever env() does work nothing here makes
   * it worse.
   */
  async function applyInsets() {
    const native = bridge();
    if (!native) return;
    let insets = null;
    try {
      insets = await native.getInsets();
    } catch (_) {
      return;
    }
    if (!insets) return;
    const root = document.documentElement.style;
    if (typeof insets.top === 'number') {
      root.setProperty('--safe-area-inset-top', insets.top + 'px');
    }
    if (typeof insets.bottom === 'number') {
      root.setProperty('--safe-area-inset-bottom', insets.bottom + 'px');
    }
  }

  window.AstraNativeAuth = {
    available, openExternal, rememberReturn, takeReturn, applyInsets, CALLBACK,
  };
})();
