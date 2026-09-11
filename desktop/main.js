'use strict';

/**
 * The Astra desktop app.
 *
 * It is the same site in a window, with the three things a browser tab cannot
 * give it: the system audio mix on Windows, a source picker that belongs to
 * the app, and an encoder that keeps running when the window loses focus -
 * which is precisely when somebody is sharing their screen.
 */

const { app, BrowserWindow, session, desktopCapturer, ipcMain, shell } = require('electron');
const path = require('node:path');
const { APP_URL } = require('./config');
const updater = require('./updater');

const APP_ORIGIN = new URL(APP_URL).origin;

/**
 * Signing in with Discord runs in the user's own browser.
 *
 * They are already signed in to Discord there, and typing a password into a
 * window an app drew is exactly the shape of a phishing page - so the app
 * hands the authorisation URL to the browser and asks to be called back.
 *
 * The call back is this scheme. Discord echoes `state` verbatim, and the web
 * app's callback knows to forward the token to it, so no second redirect URI
 * has to be registered: as far as Discord is concerned the redirect is still
 * the ordinary https one.
 */
const PROTOCOL = 'astra';
const DEEP_LINK = PROTOCOL + '://auth';

/** Room invitations, handed over by a browser: astra://room?code=ABC123 */
const ROOM_LINK = PROTOCOL + '://room';

/** Where the user was when they started signing in, to put them back after. */
let pendingReturnUrl = null;

/** Matches --titlebar-h in the stylesheet: the strip the page draws for it. */
const TITLEBAR_HEIGHT = 34;

let mainWindow = null;

/** A deep link that arrived before there was a window to send it to. */
let pendingDeepLink = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 880,
    minHeight: 560,
    icon: path.join(__dirname, 'build', 'icon.png'),
    // Painted before the page loads, so starting the app does not flash white.
    backgroundColor: '#0e0e0e',
    autoHideMenuBar: true,
    show: false,
    // The page draws the title bar; the system still draws the three buttons,
    // over the right end of it. Keeping the real ones means they behave the way
    // the OS expects - snap layouts on Windows, the traffic lights on macOS -
    // which hand-drawn copies never quite do.
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 12, y: 12 } }
      : { titleBarOverlay: { color: '#0a0a0a', symbolColor: '#9e9e9e', height: TITLEBAR_HEIGHT } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The whole point of the desktop build: Chromium otherwise throttles
      // timers and rendering in an unfocused window, which is the normal state
      // of a window you are sharing from.
      backgroundThrottling: false,
    },
  });

  // Shown once there is something to look at rather than as an empty frame.
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  guardNavigation(mainWindow.webContents);
  mainWindow.loadURL(APP_URL);
}

/**
 * Nothing but the app itself gets to take over this window. An invite link
 * someone pastes into chat should not replace the room they are sitting in,
 * and has no business running with this window's permissions - it goes to
 * their own browser, as does the Discord sign-in.
 */
function guardNavigation(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (isDiscordAuthorize(url)) {
      event.preventDefault();
      startDiscordLogin(url);
      return;
    }
    if (isAppOrigin(url)) return;

    event.preventDefault();
    // An unparseable target is not one we follow, nor one we hand to the OS.
    if (parseUrl(url)) shell.openExternal(url);
  });
}

function isDiscordAuthorize(url) {
  const parsed = parseUrl(url);
  return !!parsed
    && parsed.hostname === 'discord.com'
    && parsed.pathname.startsWith('/oauth2/authorize');
}

/**
 * Send the sign-in to the browser, with this app named as the place to come
 * back to. The destination the web app packed into `state` is kept here rather
 * than sent onward, so the round trip carries a fixed, known value.
 */
function startDiscordLogin(url) {
  const authorize = parseUrl(url);
  if (!authorize) return;
  pendingReturnUrl = authorize.searchParams.get('state') || null;
  authorize.searchParams.set('state', DEEP_LINK);
  shell.openExternal(authorize.toString());
}

/** The token, arriving back from the browser as `astra://auth#access_token=...`. */
function handleDeepLink(url) {
  if (typeof url !== 'string') return;
  if (url.startsWith(ROOM_LINK)) return openRoomFromLink(url);
  if (!url.startsWith(DEEP_LINK)) return;
  const cut = url.indexOf('#');
  if (cut === -1) return;

  if (!mainWindow || mainWindow.isDestroyed()) return;

  const params = new URLSearchParams(url.slice(cut + 1));
  if (!params.get('access_token')) return;

  // Put the destination back where the web app expects to find it, encoded the
  // way its own login() encodes it, so its callback reads it unchanged.
  const parts = [];
  for (const [key, value] of params) {
    if (key === 'state') continue;
    parts.push(key + '=' + encodeURIComponent(value));
  }
  if (pendingReturnUrl) parts.push('state=' + encodeURIComponent(pendingReturnUrl));
  pendingReturnUrl = null;

  const target = new URL(APP_URL);
  target.hash = parts.join('&');

  const contents = mainWindow.webContents;
  if (stripHash(contents.getURL()) === stripHash(target.toString())) {
    // Same document, only a different fragment - which the browser treats as
    // an in-page jump and runs not one script for. Reading the token out of
    // the fragment is a script, so nothing would happen. This is the ordinary
    // case, too: signing in starts from the lobby and comes back to it.
    // Reloading starts the page over on the callback URL, which is exactly
    // what an https redirect would have done.
    contents.executeJavaScript('location.hash = ' + JSON.stringify(target.hash))
      .then(() => contents.reload())
      .catch(() => contents.loadURL(target.toString()));
  } else {
    contents.loadURL(target.toString());
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

/**
 * A room invitation, opened here instead of in the browser.
 *
 * The site sends people this way when it recognises a room link and finds the
 * app installed - see js/open-in-app.js. All that arrives is the code, which
 * is turned back into the same URL a browser would have loaded, so the room
 * opens exactly as it would have there.
 */
function openRoomFromLink(url) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  let code = null;
  try {
    // A URL rather than string-slicing: the scheme has no authority component
    // the parser will agree about, so the query is read from what is left.
    const query = url.indexOf('?');
    if (query !== -1) code = new URLSearchParams(url.slice(query + 1)).get('code');
  } catch (_) {
    code = null;
  }

  // Room codes are letters and digits, and nothing else gets appended to a URL
  // this window is about to load.
  if (!code || !/^[A-Za-z0-9]{4,12}$/.test(code)) return;

  const target = new URL('room/', APP_URL);
  target.searchParams.set('room', code.toUpperCase());
  target.searchParams.set('go', '1');
  mainWindow.webContents.loadURL(target.toString());

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

/** Two URLs are the same document when only their fragments differ. */
function stripHash(url) {
  const parsed = parseUrl(url);
  if (!parsed) return url;
  parsed.hash = '';
  return parsed.toString();
}

/** Whichever argument is a deep link, if the OS launched us with one. */
function deepLinkIn(argv) {
  return (argv || []).find(
    (arg) => typeof arg === 'string' && arg.startsWith(PROTOCOL + '://'),
  ) || null;
}

/**
 * Claim the scheme. In a packaged build the executable is the app; running
 * from source it is Electron, which has to be told which app to start.
 */
function registerProtocol() {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

/**
 * Camera, microphone and screen capture are granted to the app itself and
 * refused to everything else. Electron would otherwise approve these for any
 * page that ends up loaded in this window.
 */
function guardPermissions(ses) {
  const ALLOWED = new Set([
    'media',
    'display-capture',
    // What setSinkId asks for. Without it the room can enumerate outputs and
    // still not be allowed to play through the one you pick.
    'speaker-selection',
    'fullscreen',
    'clipboard-sanitized-write',
  ]);

  ses.setPermissionRequestHandler((contents, permission, callback) => {
    callback(ALLOWED.has(permission) && isAppOrigin(contents.getURL()));
  });

  // The synchronous twin of the above. It is asked about an origin directly,
  // which is the one to trust: the window's current URL is not necessarily the
  // frame doing the asking.
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
    return ALLOWED.has(permission) && isAppOrigin(requestingOrigin);
  });
}

/** A URL, or null for anything this cannot reason about. */
function parseUrl(value) {
  try {
    return new URL(value);
  } catch (_) {
    return null;
  }
}

/**
 * Whether something came from the app.
 *
 * Compared as parsed origins rather than as text: Electron hands the
 * permission check an origin with a trailing slash and URL.origin has none, so
 * a string comparison silently refuses the app its own camera and microphone.
 */
function isAppOrigin(value) {
  const parsed = parseUrl(value);
  return !!parsed && parsed.origin === APP_ORIGIN;
}

/**
 * Astra's own source picker, in place of the one the browser draws.
 *
 * Resolves to a desktopCapturer source, or to null if the window was dismissed
 * - which getDisplayMedia reports as a denial, the same thing a cancelled
 * browser picker produces, and which room.js already reads as "cancelled".
 */
function pickSource(sources) {
  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      width: 820,
      height: 620,
      parent: mainWindow,
      modal: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      frame: false,
      // The shadow stays: taking it away makes Windows draw a hard border
      // around a frameless window instead, which is the one edge this panel
      // should not have. Nothing to drag it by either - it reads as something
      // the app put up, the way the settings window does.
      backgroundColor: '#141414',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'picker', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('picker:choose', onChoose);
      if (!picker.isDestroyed()) picker.destroy();
      resolve(value);
    };

    const onChoose = (event, choice) => {
      // Ignore a message from any window other than the one we opened.
      if (event.sender !== picker.webContents) return;
      if (!choice || !choice.id) return finish(null);
      const source = sources.find((item) => item.id === choice.id);
      if (!source) return finish(null);
      finish({ source, quality: choice.quality || null, audio: choice.audio });
    };

    ipcMain.on('picker:choose', onChoose);
    // Closing the window is a decision too, and the only one available if the
    // page inside fails to load.
    picker.on('closed', () => finish(null));

    picker.once('ready-to-show', async () => {
      picker.webContents.send('picker:sources', {
        sources: sources.map(toPickerItem),
        settings: await readShareSettings(),
      });
      picker.show();
    });

    picker.loadFile(path.join(__dirname, 'picker', 'index.html'));
  });
}

/**
 * What the room is set to share at, for the picker to show and to change.
 *
 * Read out of the page rather than duplicated here, because the room owns
 * these settings and the picker is only another way to reach them. It works
 * through the room's own controls by id, so a rename in the web app costs this
 * readout and nothing else - the picker hides the whole control when this
 * comes back with nothing.
 */
async function readShareSettings() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  try {
    const settings = await mainWindow.webContents.executeJavaScript(`(function () {
      const select = document.getElementById('quality');
      const audio = document.getElementById('system-audio');
      if (!select) return null;
      return {
        quality: select.value,
        options: Array.from(select.options).map(function (o) {
          return { value: o.value, label: o.textContent.trim() };
        }),
        audio: audio ? audio.checked : false,
      };
    })()`, true);
    if (!settings || !Array.isArray(settings.options) || !settings.options.length) return null;
    // Only Windows has a system mix to offer, so only there is the switch real.
    settings.audioSupported = process.platform === 'win32';
    return settings;
  } catch (_) {
    return null;
  }
}

/**
 * Put the picker's answers back where the room keeps them.
 *
 * The room reads its own controls when a share starts, so writing to them is
 * what makes the choice take effect - and it leaves the app agreeing with
 * itself afterwards, rather than sharing at one setting while its own menu
 * claims another.
 */
async function writeShareSettings(chosen) {
  if (!mainWindow || mainWindow.isDestroyed() || !chosen) return;
  const quality = JSON.stringify(chosen.quality == null ? null : String(chosen.quality));
  const audio = JSON.stringify(typeof chosen.audio === 'boolean' ? chosen.audio : null);
  try {
    await mainWindow.webContents.executeJavaScript(`(function () {
      const quality = ${quality};
      const audio = ${audio};
      const select = document.getElementById('quality');
      if (select && quality && select.value !== quality) {
        select.value = quality;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const box = document.getElementById('system-audio');
      if (box && audio !== null && box.checked !== audio) {
        box.checked = audio;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`, true);
  } catch (_) {
    // The share still goes ahead; only the menu is left out of step.
  }
}

/** Only what the picker draws: a NativeImage cannot cross the IPC boundary. */
function toPickerItem(source) {
  return {
    id: source.id,
    name: source.name,
    kind: source.id.startsWith('screen:') ? 'screen' : 'window',
    thumbnail: source.thumbnail.toDataURL(),
    icon: source.appIcon ? source.appIcon.toDataURL() : null,
  };
}

/**
 * The window buttons follow whatever the page says its title strip looks like,
 * so a theme change repaints them too. Windows and Linux only: macOS draws the
 * traffic lights in its own colours and has no overlay to set.
 */
function followTitlebarColors() {
  if (process.platform === 'darwin') return;
  ipcMain.on('astra:titlebar-colors', (event, colors) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (event.sender !== mainWindow.webContents) return;
    if (!colors || !colors.color || !colors.symbolColor) return;
    try {
      mainWindow.setTitleBarOverlay({ ...colors, height: TITLEBAR_HEIGHT });
    } catch (err) {
      // A malformed colour is not worth taking the window down for.
      console.warn('[astra] could not repaint the window buttons', err.message);
    }
  });
}

function handleDisplayMedia(ses) {
  ses.setDisplayMediaRequestHandler(
    async (request, callback) => {
      let sources = [];
      try {
        sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 320, height: 180 },
          fetchWindowIcons: true,
        });
      } catch (err) {
        console.error('[astra] could not enumerate capture sources', err);
      }

      const chosen = sources.length ? await pickSource(sources) : null;
      if (!chosen) {
        // No source and no audio: the request is refused.
        callback();
        return;
      }

      // Written back before the capture starts, so the room's own controls
      // agree with what is about to be shared.
      await writeShareSettings(chosen);
      callback({ video: chosen.source, audio: systemAudioFor(request, chosen) });
    },
    // Astra draws its own, so that the picker matches the app and behaves the
    // same on every Windows version rather than only where the OS supplies one.
    { useSystemPicker: false },
  );
}

/**
 * The system audio mix, where the platform has one to give.
 *
 * 'loopback' is the real output mix, which is what makes the desktop build
 * worth installing: the browser can only offer the audio a captured tab or
 * window happens to emit, so anything routed through a virtual device - a
 * second output, a mixer, a game on another device - goes missing. Electron
 * implements it on Windows only; elsewhere this stays undefined and system
 * audio behaves exactly as it does in the browser.
 */
function systemAudioFor(request, chosen) {
  if (process.platform !== 'win32') return undefined;
  // The picker's switch wins where it was shown, because it is the last thing
  // the user said about it. With no answer from there, the page's request
  // stands, which is what happens on every other platform anyway.
  const wanted = chosen && typeof chosen.audio === 'boolean' ? chosen.audio : request.audioRequested;
  return wanted ? 'loopback' : undefined;
}

// One window per app: a second launch focuses the one already open rather than
// starting a rival copy holding its own room connection.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Windows and Linux deliver a deep link by launching the app again; the
  // instance already running is the one that should act on it.
  app.on('second-instance', (_event, argv) => {
    const link = deepLinkIn(argv);
    if (!mainWindow) {
      pendingDeepLink = link;
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    handleDeepLink(link);
  });

  // macOS delivers it as an event instead, and may do so before there is a
  // window to load it into.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (mainWindow) handleDeepLink(url);
    else pendingDeepLink = url;
  });

  app.whenReady().then(() => {
    const ses = session.defaultSession;
    guardPermissions(ses);
    handleDisplayMedia(ses);
    followTitlebarColors();
    // Quiet, and only in a packaged build - see updater.js. The window is
    // passed as a getter rather than a value: an update can land long after
    // this runs, by which time the window may have been closed and reopened.
    updater.install(() => mainWindow);
    registerProtocol();
    createWindow();

    // A link that started the app arrives in argv rather than as an event, and
    // only once the window exists is there anywhere to put it.
    const launchLink = pendingDeepLink || deepLinkIn(process.argv);
    pendingDeepLink = null;
    if (launchLink) mainWindow.once('ready-to-show', () => handleDeepLink(launchLink));

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // macOS keeps the app running with no windows; everywhere else, closing the
    // window means closing the app.
    if (process.platform !== 'darwin') app.quit();
  });
}
