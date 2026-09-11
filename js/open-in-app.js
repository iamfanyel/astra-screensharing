'use strict';

/**
 * Handing a room link to the Astra app, when there is one to hand it to.
 *
 * A room link opened in a browser works perfectly well in the browser - that
 * is the whole point of the site - so this never takes anything away. What it
 * does is offer the app to people who have it, and try once on its own.
 *
 * Two things it has to get right, both of them about not being annoying:
 *
 * There is no way to ask a browser whether a scheme has a handler. The only
 * way to find out is to try, and watch: if the app opens, this page loses
 * focus within a moment. If it does not, nothing was installed, and that is
 * remembered so the same machine is not asked again for a fortnight.
 *
 * And the attempt is not reliable. Browsers block launching another
 * application from a script that no click led to, so the automatic try only
 * works where the page has already been interacted with. The button is the
 * part that always works, which is why it is there rather than hidden behind
 * the automatic path succeeding.
 *
 * Nothing here runs inside either app: they load this same site, and handing
 * the room back to the app it is already in is a loop.
 */
(function () {
  const button = document.getElementById('open-in-app');
  if (!button) return;

  // Already in an Astra app: handing the room to the app it is already in is
  // a loop, and the one failure worth ruling out first.
  if (!window.AstraPlatform || window.AstraPlatform.insideAnApp()) return;

  // Only a room link. Creating a room, or the lobby, has nothing to hand over.
  const code = (new URLSearchParams(location.search).get('room') || '').trim().toUpperCase();
  const pattern = window.ASTRA && window.ASTRA.roomCodePattern;
  if (!code || !pattern || !pattern.test(code)) return;

  const TARGET = 'astra://room?code=' + encodeURIComponent(code);

  /** Where a machine with no app is remembered, and for how long. */
  const MEMORY = 'astra:no-app';
  const FORGET_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

  /** Long enough for a handler to take over, short enough not to be a pause. */
  const DECIDE_MS = 1400;

  function remembered() {
    try {
      const when = Number(localStorage.getItem(MEMORY)) || 0;
      return when > 0 && Date.now() - when < FORGET_AFTER_MS;
    } catch (_) {
      return false;
    }
  }

  function remember(missing) {
    try {
      if (missing) localStorage.setItem(MEMORY, String(Date.now()));
      else localStorage.removeItem(MEMORY);
    } catch (_) {
      // Private browsing, or storage turned off. It only means asking again.
    }
  }

  /**
   * Try it, and find out whether anything happened.
   *
   * `silent` is the automatic attempt: it must not leave a button offering
   * something that has just been shown not to exist.
   */
  function handOver(silent) {
    let opened = false;
    const noticed = () => {
      opened = true;
      remember(false);
    };

    const onHidden = () => {
      if (document.visibilityState === 'hidden') noticed();
    };
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('blur', noticed, { once: true });
    window.addEventListener('pagehide', noticed, { once: true });

    setTimeout(() => {
      document.removeEventListener('visibilitychange', onHidden);
      if (opened) return;
      // Still here, so nothing took it.
      remember(true);
      if (silent) button.hidden = true;
    }, DECIDE_MS);

    location.href = TARGET;
  }

  button.addEventListener('click', () => handOver(false));

  if (remembered()) return;

  // Offered first, so it is already there if the automatic try is blocked -
  // which is the ordinary case in a browser the user has not clicked in yet.
  button.hidden = false;
  handOver(true);
})();
