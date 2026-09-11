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
 * downloads quietly and is applied the next time the app is closed: close
 * Astra at any point and the next launch is the new version, with nothing
 * asked of anybody.
 *
 * For anyone who would rather have it sooner, the page is told, and it shows a
 * button beside the settings gear. Pressing it restarts into the update. A
 * button in the window the user is already looking at, rather than a window of
 * its own that would appear on top of whatever they are sharing.
 *
 * Releases come from GitHub. The repository is public, so the check is an
 * anonymous request and no token is shipped in the app.
 */

const { app, ipcMain } = require('electron');

/** Long enough for the window to be up and the room to have settled. */
const FIRST_CHECK_MS = 30000;

/** A desktop app is not a web page; once every few hours is plenty. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

let started = false;
let timer = null;

/** Set once a download has finished, so a page that loads later can ask. */
let readyVersion = null;

/** What to restart into it, once there is something to restart into. */
let applyUpdate = null;

function install(getWindow) {
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

  applyUpdate = () => {
    // Closes every window and runs the installer. autoInstallOnAppQuit would
    // have done this on the way out anyway; this is the same thing, sooner.
    autoUpdater.quitAndInstall();
  };

  autoUpdater.on('update-downloaded', (info) => {
    readyVersion = info && info.version ? info.version : '';
    console.log('[astra] update ready:', readyVersion);
    const window = typeof getWindow === 'function' ? getWindow() : null;
    if (window && !window.isDestroyed()) {
      window.webContents.send('astra:update-ready', readyVersion);
    }
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

  ipcMain.handle('astra:update-ready', () => readyVersion);
  ipcMain.on('astra:update-install', () => {
    if (applyUpdate) applyUpdate();
  });

  setTimeout(check, FIRST_CHECK_MS);
  timer = setInterval(check, CHECK_EVERY_MS);
  app.on('before-quit', () => {
    if (timer) clearInterval(timer);
    timer = null;
  });
}

module.exports = { install };
