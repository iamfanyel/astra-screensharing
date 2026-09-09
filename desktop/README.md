# Astra Desktop

The same site in a window, with the three things a browser tab will not do:

- **System audio on Windows.** The share hands Electron `audio: 'loopback'`,
  which is the actual output mix. A browser can only offer the audio a captured
  tab or window happens to emit, which is why audio routed through a virtual
  device - a second output, a mixer like SteelSeries Sonar - goes missing there.
- **Astra's own source picker**, instead of Chrome's dialog: a segmented
  screen/application switcher over a two-column grid of live thumbnails, with
  the room's current quality shown along the bottom.
- **No background throttling.** Chromium slows timers and rendering in an
  unfocused window, which is the normal state of a window you are sharing from.

The window is also frameless: the page draws a 34px strip with the app's mark
and name centred, and the system paints the real minimise/maximise/close
buttons over the right end of it, repainted to match whenever the theme or the
hue changes. The strip lives in the web app behind an `is-desktop-app` class
that only this preload sets, so a browser never sees it - which does mean the
title bar only appears once the web changes are **deployed**, or when
`ASTRA_URL` points at a local server.

Everything else - the room, the mesh, profiles - is the deployed site, loaded
over https. Nothing is bundled, so shipping a fix stays a deploy.

## Signing in with Discord

The sign-in runs in the user's own browser, where they are already signed in to
Discord, rather than in a window this app drew - which is the shape of a
phishing page and would ask for the password again.

Getting the answer back without registering a second redirect URI:

1. The app catches the navigation to `discord.com/oauth2/authorize`, keeps the
   destination the web app packed into `state`, replaces `state` with
   `astra://auth`, and hands the URL to the browser.
2. Discord returns to the ordinary https redirect - the same one already
   registered - with the token in the fragment.
3. `js/discord.js` sees `state` is exactly `astra://auth` and forwards the
   fragment to that scheme instead of signing in. The tab does nothing else.
4. Windows hands the URL to the running app, which loads the site with the
   token and the original destination, and the web app's own callback takes it
   from there. If the app is already sitting on that page - the usual case,
   since sign-in starts from the lobby and comes back to it - only the fragment
   changes, which is a same-document navigation that re-runs no scripts at all.
   The app reloads in that case, so the callback actually runs.

`astra://` is claimed with `setAsDefaultProtocolClient`, so this only works
once the app has been run at least once. **Step 3 lives in the deployed site**,
so the flow needs the web change published before it works against production.

One tradeoff worth knowing: step 4 carries the token through a command line
argument, which other processes on the same machine can read. The scope is
`identify` and nothing else, but a loopback redirect with PKCE would be the
stronger design if that ever matters.

## Running it

```bash
cd desktop
npm install
npm start
```

`npm start` opens the deployed site. To point at a local server instead, start
the site on port 3000 in the repo root (`npm start` there) and then:

```bash
npm run dev
```

## Which site it opens

`config.js` holds one constant, `APP_URL`, pointing at `https://astrascreen.live`.
`ASTRA_URL` in the environment overrides it, which is how `npm run dev` aims a
build at the local server instead.

It has to be the real origin rather than bundled files, because the Discord
sign-in redirects back to the page it started from and the `/api` routes are
same-origin. Bundling would mean registering a second redirect URI and adding
CORS for a `file://` caller, for no gain in an app that needs the network to do
anything at all.

## Packaging

```bash
npm run pack   # unpacked build in dist/, for a quick look
npm run dist   # the installer
```

`npm run dist` produces **`dist/Astra-Setup-1.0.0.exe`** - 78 MB, NSIS, and a
`.blockmap` beside it that lets a future auto-updater download only what
changed. It installs per user, so it never asks for an administrator, and it
offers a directory choice rather than dumping itself somewhere on one click.
Both it and the unpacked build are known good on Windows; no macOS or Linux
build has been run.

The first `dist` on a machine needs the `winCodeSign` tooling, whose archive
contains macOS symlinks Windows will not create without Developer Mode. If the
extraction fails, unpack `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\*.7z`
by hand into a `winCodeSign-2.6.0` folder beside it and run again.

Not yet done, and needed before this goes to anyone else:

- **Code signing.** The installer is unsigned, so Windows SmartScreen shows
  "Windows protected your PC" and hides Run behind *More info*. An OV
  certificate (~$200-400/yr) still has to build reputation before that stops;
  an EV certificate or Azure Trusted Signing clears it immediately. macOS needs
  notarisation (Apple Developer, $99/yr) or it refuses to open at all.
- **Auto-update.** `electron-updater` plus somewhere to host the feed.
- An `.ico` and `.icns`; `build/icon.png` is the source and electron-builder
  will convert, but a hand-made `.ico` looks better at small sizes.

## Layout

| File | What it does |
| --- | --- |
| `main.js` | Window, permissions, navigation guard, the display-media handler |
| `config.js` | Which origin to load |
| `preload.js` | The little the page is told about its host |
| `picker/` | The source picker window: its own document, preload and renderer |
