'use strict';

/**
 * The app's look: one base theme, plus one hue spread across every neutral.
 *
 * The two are independent. The theme decides how light each surface is, by
 * moving the lightness axis the stylesheet measures its greys against, while
 * the hue only ever sets `--tint-h` and `--tint-s` - so recolouring the app
 * can never lighten or darken it, and every contrast ratio in the design
 * survives whatever hue is picked.
 *
 * Loaded from <head> rather than with the other scripts, so both are in place
 * before the first paint instead of flashing the default first.
 */
(function () {
  const HUE_KEY = 'astra:tint-hue';
  const THEME_KEY = 'astra:theme';

  /**
   * How much colour the surfaces take. High enough to read as a theme, low
   * enough that the app still looks like itself; light values take a third of
   * it, via --tint-s-text in the stylesheet.
   */
  const SATURATION = 35;

  /**
   * What the user can pick. 'dark' is the original and carries no attribute,
   * so its values stay the plain `:root` block in the stylesheet. 'system' is
   * not a palette of its own - it defers to the OS and resolves to one of the
   * others every time that preference changes.
   */
  const THEMES = ['dark', 'light', 'oled', 'system'];
  const DEFAULT_THEME = 'dark';

  const prefersLight = window.matchMedia('(prefers-color-scheme: light)');

  function read(key) {
    try {
      return localStorage.getItem(key);
    } catch (_) {
      // Private windows and blocked site data both throw rather than return.
      return null;
    }
  }

  function write(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (_) {
      // Not persisting is survivable; the choice still applies for this page.
    }
  }

  /** The chosen hue in 0-359, or null when the theme is left untinted. */
  function getHue() {
    const stored = read(HUE_KEY);
    if (stored === null) return null;
    const hue = Number(stored);
    if (!Number.isFinite(hue)) return null;
    return ((Math.round(hue) % 360) + 360) % 360;
  }

  /** Pass null to go back to the theme's own neutrals. */
  function setHue(hue) {
    write(HUE_KEY, hue === null ? null : String(hue));
    paint();
  }

  function getTheme() {
    const stored = read(THEME_KEY);
    return THEMES.indexOf(stored) === -1 ? DEFAULT_THEME : stored;
  }

  function setTheme(theme) {
    write(THEME_KEY, THEMES.indexOf(theme) === -1 ? null : theme);
    paint();
  }

  /** The palette actually painted: 'system' stands in for what the OS asks. */
  function resolveTheme() {
    const theme = getTheme();
    if (theme !== 'system') return theme;
    return prefersLight.matches ? 'light' : 'dark';
  }

  /**
   * Push both onto the document. Removing a property rather than setting a
   * neutral value hands the question back to the stylesheet, so each default
   * lives in exactly one place.
   */
  function paint() {
    const root = document.documentElement;
    const theme = resolveTheme();
    if (theme === DEFAULT_THEME) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);

    const hue = getHue();
    if (hue === null) {
      root.style.removeProperty('--tint-h');
      root.style.removeProperty('--tint-s');
      return;
    }
    root.style.setProperty('--tint-h', String(hue));
    root.style.setProperty('--tint-s', SATURATION + '%');
  }

  paint();

  // Only matters while 'system' is the choice, but the listener is cheap and
  // costs nothing to leave attached for the others.
  prefersLight.addEventListener('change', paint);

  // Four accessors is the whole surface: everything else here is only ever
  // called from inside this file.
  window.AstraTheme = { getHue, setHue, getTheme, setTheme };
})();
