'use strict';

/**
 * Which Astra this is running inside, answered once.
 *
 * The same page is served to three places - a browser, the Electron app, and
 * the Android app - and several scripts need to tell them apart: the download
 * row should not offer the app to the app, a room link should not be handed to
 * the app it is already in, and the native screen capture only exists in one
 * of them.
 *
 * Each of those had grown its own copy of the test, and the copies had already
 * started to disagree with each other. One of them is enough.
 *
 * Loaded before anything that asks, and it asks nothing itself: the desktop
 * marker is a class the Electron preload puts on <html> before the page
 * parses, and Capacitor defines its global before any page script runs.
 */
window.AstraPlatform = (function () {
  /** Electron sets this class from its preload, before the document exists. */
  function isDesktopApp() {
    return document.documentElement.classList.contains('is-desktop-app');
  }

  /**
   * The Android app.
   *
   * A Capacitor that cannot say where it is running is treated as native: the
   * global only exists because something put it there, and in a browser there
   * is nothing to put it there.
   */
  function isNativeApp() {
    const capacitor = window.Capacitor;
    if (!capacitor) return false;
    return typeof capacitor.isNativePlatform !== 'function' || capacitor.isNativePlatform();
  }

  /** Either app, as opposed to a browser tab. */
  function insideAnApp() {
    return isDesktopApp() || isNativeApp();
  }

  return { isDesktopApp, isNativeApp, insideAnApp };
})();
