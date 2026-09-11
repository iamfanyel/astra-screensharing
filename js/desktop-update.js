'use strict';

/**
 * The one thing an update needs from the page: somewhere to say it is ready.
 *
 * The desktop app fetches updates quietly and installs them when it is next
 * closed, so nothing here is required - close Astra at any point and the next
 * launch is the new version. This is only for the case where somebody would
 * rather have it now: a button appears beside the settings gear, and pressing
 * it restarts into the update straight away.
 *
 * It is a button rather than a dialog on purpose. This app exists to be shared
 * from, and a window that takes focus in the middle of a screen share is
 * shared along with everything else.
 *
 * In a browser, and in the app until an update has actually finished
 * downloading, `window.astraUpdate` is absent and the button stays hidden.
 */
(function () {
  const button = document.getElementById('apply-update');
  // Taken once. Everything below runs later - a microtask, a click - and
  // reading the global again at those points would depend on nothing having
  // touched it in between.
  const bridge = window.astraUpdate;
  if (!button || !bridge) return;

  let offered = false;

  function offer(version) {
    if (offered) return;
    offered = true;
    if (version) {
      const label = `Update to ${version} and restart`;
      button.title = `Update to ${version}`;
      button.setAttribute('aria-label', label);
    }
    button.hidden = false;
  }

  button.addEventListener('click', () => {
    // Nothing to confirm: the download is already on disk, and the only thing
    // this changes is whether it is applied now or at the next close.
    button.disabled = true;
    button.title = 'Restarting…';
    try {
      bridge.install();
    } catch (_) {
      // If the restart will not start, leave the button usable rather than
      // stuck - it still installs on quit either way.
      button.disabled = false;
      button.title = 'Update Astra';
    }
  });

  // Two ways it can arrive: already waiting when this page loaded - a reload,
  // or a move between the lobby and a room - or landing while it is open.
  Promise.resolve()
    .then(() => bridge.ready())
    .then((version) => {
      if (version !== null && version !== undefined) offer(version);
    })
    .catch(() => {
      // Nothing waiting, which is the ordinary case.
    });

  bridge.onReady((version) => offer(version));
})();
