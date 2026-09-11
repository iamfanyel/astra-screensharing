'use strict';

/**
 * Pointing people at the desktop build.
 *
 * The link works with no script at all: it goes to the repository's latest
 * release, where the installer is. What this adds is a direct link to the
 * installer itself, so it downloads on the first click instead of the second.
 *
 * It also takes the row away where it makes no sense: inside the desktop app,
 * which is already the thing being offered, and inside the Android app, where
 * a Windows installer is no use to anybody.
 */
(function () {
  const link = document.getElementById('get-desktop');
  if (!link) return;

  /** Already running it, one way or another. */
  function alreadyHasAnApp() {
    if (document.documentElement.classList.contains('is-desktop-app')) return true;
    const capacitor = window.Capacitor;
    if (!capacitor) return false;
    return typeof capacitor.isNativePlatform !== 'function' || capacitor.isNativePlatform();
  }

  if (alreadyHasAnApp()) {
    link.hidden = true;
    return;
  }

  // Best effort, and deliberately unguarded by anything: if this fails the
  // link still goes to the releases page, which is where it was already going.
  fetch('https://api.github.com/repos/iamfanyel/astra-screensharing/releases/latest', {
    headers: { Accept: 'application/vnd.github+json' },
  })
    .then((res) => (res.ok ? res.json() : null))
    .then((release) => {
      if (!release || !Array.isArray(release.assets)) return;
      const installer = release.assets.find(
        (asset) => typeof asset.name === 'string' && asset.name.toLowerCase().endsWith('.exe'),
      );
      if (!installer || !installer.browser_download_url) return;
      link.href = installer.browser_download_url;
    })
    .catch(() => {
      // Offline, rate limited, or the release has no installer on it yet.
    });
})();
