'use strict';

/**
 * Which speaker the room plays out of, on a phone.
 *
 * The web already has this: enumerateDevices() names the outputs and
 * setSinkId() picks one. Chrome on Android has neither - it lists microphones
 * and cameras and stops - so the room's output menu had nothing to show and
 * came up empty on exactly the device where it matters most, because a phone
 * is the only thing anybody holds to their ear.
 *
 * The Android app can answer, so it does. See AudioRoutePlugin.java for what
 * it asks the system and why it has to change the audio mode to do it.
 *
 * In a browser none of this is reachable: there is no Capacitor bridge,
 * `available()` is false, and room.js goes on using enumerateDevices exactly
 * as it did.
 */
window.AstraNativeAudio = (function () {
  /** The native half, or null anywhere that is not the Android app. */
  function plugin() {
    const capacitor = window.Capacitor;
    if (!capacitor) return null;
    if (window.AstraPlatform && !window.AstraPlatform.isNativeApp()) return null;
    if (capacitor.Plugins && capacitor.Plugins.AstraAudio) return capacitor.Plugins.AstraAudio;
    if (typeof capacitor.registerPlugin === 'function') {
      try {
        const registered = capacitor.registerPlugin('AstraAudio');
        if (registered) return registered;
      } catch (_) {
        // An app built before this plugin existed.
      }
    }
    return (capacitor.Plugins && capacitor.Plugins.AstraAudio) || null;
  }

  /**
   * Not the same question as "is this the app": an older build of the app has
   * no such plugin, and asking is the only way to tell.
   */
  function available() {
    return !!plugin();
  }

  /**
   * The outputs, or an empty list for anything that cannot say.
   *
   * Never throws. The menu treats "no answer" and "nothing to offer" the same
   * way, and both mean it should fall back to what the browser knows.
   */
  async function outputs() {
    const native = plugin();
    if (!native || typeof native.list !== 'function') return [];
    try {
      const answer = await native.list();
      const found = answer && Array.isArray(answer.outputs) ? answer.outputs : [];
      return found.filter((output) => output && output.id && output.label);
    } catch (_) {
      return [];
    }
  }

  /** Route to one of them. False when it did not take. */
  async function select(id) {
    const native = plugin();
    if (!native || typeof native.select !== 'function' || !id) return false;
    try {
      const answer = await native.select({ id: String(id) });
      return !!(answer && answer.ok);
    } catch (_) {
      return false;
    }
  }

  /** Give routing back to the system, on the way out of a room. */
  async function clear() {
    const native = plugin();
    if (!native || typeof native.clear !== 'function') return;
    try {
      await native.clear();
    } catch (_) {
      // Leaving anyway; there is nothing useful to do about it.
    }
  }

  return { available, outputs, select, clear };
})();
