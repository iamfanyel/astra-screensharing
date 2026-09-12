'use strict';

/**
 * The build line at the foot of the settings categories.
 *
 * It exists for the moment somebody says "it does this on mine" - the first
 * question back is always which Astra, in what, on what, and none of that is
 * otherwise visible. The site is the same for everyone; the thing around it is
 * not, which is exactly what this names.
 *
 * The desktop app knows its own version and answers for itself. A browser is
 * asked what it is instead, which is a guess made from the user agent and
 * treated as one: an engine it cannot place is left unnamed rather than
 * reported wrongly, because a build line that invents things is worse than no
 * build line at all.
 *
 * Selectable on purpose. The whole point is that it can be copied into a
 * message, so it must not be text you have to transcribe by eye.
 */
(function () {
  const out = document.getElementById('settings-build');
  if (!out) return;

  /**
   * A user agent's version, with its invented precision taken off.
   *
   * Browsers have stopped giving out the real lower parts: Chrome says
   * `153.0.0.0` whatever build it actually is, and printing that claims three
   * digits of accuracy that were never there. `153` says the same thing
   * honestly. A user agent that does still carry them - the app's own, which
   * reports a real `152.0.7977.78` - keeps every one.
   *
   * Only for versions read out of a user agent. The ones a process reports
   * about itself are exact, and trimming those would turn Electron 44.3.0 into
   * 44.3, which is a different release.
   */
  function trimZeroes(version) {
    const short = String(version).replace(/(\.0)+$/, '');
    return short || String(version);
  }

  /**
   * The engine, from the user agent.
   *
   * Named for the engine rather than the brand, because the engine is what
   * decides how Astra behaves. Edge, Opera, Brave, Samsung Internet and Chrome
   * are one answer to every question that matters here, and they all report
   * the same `Chrome/` version - so they are all Chromium. Firefox is Gecko,
   * Safari is WebKit, and a bug report is better for saying so.
   *
   * The number beside each name is the one that actually identifies a build,
   * which is not always the one named after the engine: every Chromium sends a
   * frozen `AppleWebKit/537.36`, and every Safari a frozen
   * `AppleWebKit/605.1.15`, neither of which has moved in years. `Chrome/` and
   * `Version/` are what change, so those are what get reported.
   *
   * Order matters and is the reverse of how much each claims to be. Gecko is
   * the only one that says nothing about Chrome. Chromium claims to be Safari
   * as well, so it has to be ruled out before Safari is believed. The bare
   * `AppleWebKit/` line last of all, for the iOS browsers that are WebKit
   * underneath whatever name they wear and match none of the above.
   */
  const ENGINES = [
    [/\brv:([\d.]+).*\bGecko\//, 'Gecko'],
    [/\bFirefox\/([\d.]+)/, 'Gecko'],
    [/\bChrome\/([\d.]+)/, 'Chromium'],
    [/\bVersion\/([\d.]+).*\bSafari\//, 'WebKit'],
    [/\bAppleWebKit\/([\d.]+)/, 'WebKit'],
  ];

  function engine() {
    const agent = navigator.userAgent || '';
    for (const [pattern, name] of ENGINES) {
      const found = agent.match(pattern);
      if (found) return name + ' ' + trimZeroes(found[1]);
    }
    return null;
  }

  /**
   * What to show, most specific first.
   *
   * Each entry is one line. Anything that could not be determined is dropped
   * rather than printed as "unknown", which tells nobody anything.
   */
  async function lines() {
    const platform = window.AstraPlatform;

    // The desktop app, which can say precisely what it is.
    if (window.astraBuild && platform && platform.isDesktopApp()) {
      try {
        const version = await window.astraBuild.versions();
        if (version && version.app) {
          return [
            'Astra ' + version.app + (version.arch ? ' ' + version.arch : ''),
            version.electron ? 'Electron ' + version.electron : null,
            version.chrome ? 'Chromium ' + version.chrome : null,
          ];
        }
      } catch (_) {
        // An older app with no such handler: fall through and describe the
        // engine inside it, which is still true and still useful.
      }
    }

    if (platform && platform.isNativeApp()) {
      return ['Astra for Android', engine()];
    }

    return ['Astra on the web', engine()];
  }

  lines()
    .then((found) => {
      const text = found.filter(Boolean).join('\n');
      if (!text) return;
      out.textContent = text;
      out.hidden = false;
    })
    .catch(() => {
      // Nothing to say is a fine outcome; the row simply stays away.
    });
})();
