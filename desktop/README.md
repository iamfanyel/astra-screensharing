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

## Size

About 235 MB installed, and roughly 180 MB of that is `Astra.exe` - Chromium
and Node, statically linked. That part is Electron's floor and cannot be cut
without building Electron from source.

What was cut: Electron ships 55 Chromium translations, 40 MB of them. The
app's own interface is the web page, which handles its own language, so those
files only cover Chromium's built-in strings - the right-click menu, error
pages. `electronLanguages` in package.json keeps eight and drops the rest,
which is 36 MB. Add to that list rather than removing it if somebody needs
their language in the context menu.

What was deliberately kept:

- `LICENSES.chromium.html` (8.7 MB) - Chromium's licence requires shipping it.
- `vk_swiftshader.dll` and `vulkan-1.dll` (6.2 MB) - software rendering, used
  when there is no working GPU driver. A screen-sharing app gets run over
  remote desktop and in virtual machines, which is exactly where this is the
  difference between a window and a black rectangle.
- `icudtl.dat` (10 MB), `d3dcompiler_47.dll`, `ffmpeg.dll` - all load-bearing.

`compression: maximum` applies to the installer, not the install: it makes the
download and every update delta smaller and costs only build time.

## Releasing

Releases go to GitHub. The repository is public, so the app checks for updates
anonymously and ships no token.

```
npm version patch          # or minor / major - the updater compares versions
GH_TOKEN=<token> npm run release
```

`release` builds and uploads the installer, `latest.yml` and the block map to a
GitHub release for the current version. The token needs `repo` scope and is only
used on the machine doing the release. `release:draft` does the same but leaves
the release unpublished, so it can be checked before anyone is offered it.

Two things decide whether an installed copy updates itself: the release must be
**published** (a draft is invisible to the updater), and its version must be
**higher** than the installed one. Nothing else is required - no server, and no
change to the site.

Check `dist/` before uploading by hand: old builds are not cleaned out, so an
installer from a previous run can still be sitting there.

## Updating

`updater.js`, and the shape of it is deliberate:

- It only runs in a packaged build. In a checkout there is nothing to update.
- It downloads in the background and installs **when the app is next closed**.
- The only thing shown is one notification saying so.

No dialog, ever. This app exists to be shared from, and a window that takes
focus in the middle of a screen share is shared along with everything else -
so the update never asks for anything. Anyone who wants it sooner restarts.

Failures are swallowed: offline, rate-limited, or no release yet are all normal
and none of them are the user's problem.

Not yet done, and needed before this goes to anyone else:

- **Code signing.** The installer is unsigned, so Windows SmartScreen shows
  "Windows protected your PC" and hides Run behind *More info*. An OV
  certificate (~$200-400/yr) still has to build reputation before that stops;
  an EV certificate or Azure Trusted Signing clears it immediately. macOS needs
  notarisation (Apple Developer, $99/yr) or it refuses to open at all.
  Updates still work unsigned - Windows just warns on the first install.
- An `.icns` for macOS; `build/icon.png` is the source and electron-builder
  will convert it.

## Layout

| File | What it does |
| --- | --- |
| `main.js` | Window, permissions, navigation guard, the display-media handler |
| `config.js` | Which origin to load |
| `preload.js` | The little the page is told about its host |
| `picker/` | The source picker window: its own document, preload and renderer |
| `updater.js` | Background update check, applied on quit |
| `build/icon.ico` | The Windows icon, every size baked in rather than downscaled |
