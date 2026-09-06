'use strict';

/**
 * The app tint: one hue, spread across every neutral surface.
 *
 * The stylesheet writes its greys as `hsl(var(--tint-h) var(--tint-s) L%)`,
 * where L is that colour's own lightness. So this only ever sets a hue and a
 * saturation - nothing here can make the app lighter or darker, and every
 * contrast ratio in the design survives whatever hue is picked.
 *
 * Loaded from <head> rather than with the other scripts, so the tint is in
 * place before the first paint instead of flashing grey first.
 */
(function () {
  const KEY = 'astra:tint-hue';

  /**
   * How much colour the dark surfaces take. High enough to read as a theme,
   * low enough that the app still looks like itself; light values take a third
   * of it, via --tint-s-text in the stylesheet.
   */
  const SATURATION = 35;

  /** The chosen hue in 0-359, or null when the app is left neutral grey. */
  function getHue() {
    let stored = null;
    try {
      stored = localStorage.getItem(KEY);
    } catch (_) {
      // Private windows and blocked site data both throw rather than return.
    }
    if (stored === null) return null;
    const hue = Number(stored);
    if (!Number.isFinite(hue)) return null;
    return ((Math.round(hue) % 360) + 360) % 360;
  }

  /** Pass null to go back to the untinted greys. */
  function setHue(hue) {
    try {
      if (hue === null) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, String(hue));
    } catch (_) {
      // Not persisting is survivable; the tint still applies for this page.
    }
    paint(hue);
  }

  /**
   * Push the tint onto the document. Removing the properties rather than
   * setting a zero saturation hands the question back to the stylesheet, so
   * the neutral default lives in exactly one place.
   */
  function paint(hue) {
    const style = document.documentElement.style;
    const value = hue === undefined ? getHue() : hue;
    if (value === null) {
      style.removeProperty('--tint-h');
      style.removeProperty('--tint-s');
      return;
    }
    style.setProperty('--tint-h', String(value));
    style.setProperty('--tint-s', SATURATION + '%');
  }

  paint();

  window.AstraTheme = { getHue, setHue, paint, SATURATION };
})();
