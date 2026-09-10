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

  function bridge() {
    const capacitor = window.Capacitor;
    if (!capacitor) return null;
    if (typeof capacitor.isNativePlatform === 'function' && !capacitor.isNativePlatform()) {
      return null;
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

    // Reload rather than set-and-hope: changing only the fragment is a
    // same-document navigation, and nothing would read the token.
    window.location.hash = pending.fragment;
    window.location.reload();
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

  if (available()) {
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
