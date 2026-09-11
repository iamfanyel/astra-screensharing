'use strict';

/**
 * Keeping the app up to date without getting in the way.
 *
 * The site updates itself - it is a web page, and a reload is enough. This is
 * only for the shell around it: the window, the source picker, the system
 * audio, the things a browser cannot do. Those change rarely, so the update
 * matters less than not interrupting whoever is using it.
 *
 * Which is the whole design here. A screen share is exactly the wrong moment
 * for a modal dialog demanding a restart, and there is no way from here to
 * know whether one is running - so nothing is ever demanded. The update
 * downloads quietly and is applied the next time the app is closed, and the
 * only thing the user sees is one notification telling them that is what will
 * happen. Anyone who wants it sooner just restarts.
 *
 * Releases come from GitHub. The repository is public, so the check is an
 * anonymous request and no token is shipped in the app.
 */

const { app, Notification } = require('electron');
const path = require('node:path');

/** Long enough for the window to be up and the room to have settled. */
const FIRST_CHECK_MS = 30000;

/** A desktop app is not a web page; once every few hours is plenty. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

let started = false;
let timer = null;

function install() {
  // Nothing to update in a checkout, and electron-updater throws rather than
  // shrugging when it cannot find the metadata a packaged build carries.
  if (started || !app.isPackaged) return;
  started = true;

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.warn('[astra] no updater in this build:', err.message);
    return;
  }

  // Fetch in the background, apply on the way out. Both are the defaults;
  // they are written down because the whole behaviour depends on them.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('update-downloaded', (info) => {
    const version = info && info.version ? info.version : '';
    console.log('[astra] update ready:', version);
    announce(version);
  });

  autoUpdater.on('error', (err) => {
    // Offline, rate limited, no release yet: none of it is the user's
    // problem, and none of it should reach them.
    console.warn('[astra] update check failed:', err && err.message ? err.message : err);
  });

  const check = () => {
    autoUpdater.checkForUpdates().catch(() => {
      // Already reported through the error handler above.
    });
  };

  setTimeout(check, FIRST_CHECK_MS);
  timer = setInterval(check, CHECK_EVERY_MS);
  app.on('before-quit', () => {
    if (timer) clearInterval(timer);
    timer = null;
  });
}

/**
 * One notification, once, and nothing that has to be dismissed.
 *
 * Deliberately not a dialog: this app exists to be shared from, and a window
 * that steals focus mid-share would be shared along with everything else.
 */
function announce(version) {
  if (!Notification.isSupported()) return;
  try {
    new Notification({
      title: version ? `Astra ${version} is ready` : 'Astra update ready',
      body: 'It will be installed the next time you close Astra.',
      icon: path.join(__dirname, 'build', 'icon.png'),
      silent: true,
    }).show();
  } catch (err) {
    console.warn('[astra] could not show the update notice:', err.message);
  }
}

module.exports = { install };
