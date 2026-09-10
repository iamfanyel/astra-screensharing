# Astra Mobile (Android)

The site in a Capacitor shell, plus the one thing a phone browser cannot do.

## Why there is native code here at all

No mobile browser or WebView implements `getDisplayMedia` - not Chrome for
Android, not Firefox, not Samsung Internet, not the Android WebView, not iOS
Safari at any version. A phone can watch a share and send its camera and
microphone through the ordinary web APIs, but it cannot offer its screen.

So the screen is captured natively, with `MediaProjection`, and handed to the
page over a WebRTC connection that never leaves the handset. That is the only
way a WebView will accept a video source it did not create itself. What the
page receives is an ordinary `MediaStream`, so `mesh.js` publishes it exactly
as it publishes a desktop share - the mesh, the bitrate caps and the tiles
never learn where it came from.

The cost is one extra encode and decode on the phone: the app encodes the
screen, the WebView decodes it, then re-encodes it for each person in the room.
The alternative was reimplementing the mesh, the signalling and Astra's data
channel protocol in Kotlin and maintaining two of everything forever.

## Audio

Android 10 added `AudioPlaybackCapture`, which hands an app a mix of what other
apps are playing - and it takes the same MediaProjection consent the screen
already asked for, so sound costs the user no extra prompt.

WebRTC pulls its outgoing audio from a device module that normally reads the
microphone. `ScreenAudioCapturer` fills that module's buffer instead, with the
module told via `setUseAudioRecord(false)` not to open a microphone at all - so
the real one stays with the WebView for the room's voice. That flag was checked
against the artifact's own bytecode, not assumed: with it false, the module
skips `initAudioRecord()` and `startRecording()` entirely.

What will not be in the mix, and cannot be:

- Anything below **Android 10** - the API does not exist, so those phones share
  picture only.
- Apps that set `allowAudioPlaybackCapture="false"`, which is any app that
  chooses to opt out.
- Anything with a **DRM** path, so most paid video.
- **Voice calls.** The platform only ever hands over `USAGE_MEDIA`,
  `USAGE_GAME` and `USAGE_UNKNOWN`.

## Signing in with Discord

Discord refuses to authorise anybody inside an embedded browser, and a WebView
is one - so the sign-in leaves the app for the real browser, where the user is
already signed in to Discord anyway.

Getting the token back to the app rather than leaving it in a browser tab:

1. `login()` sees the app, puts `astra://auth` in `state` instead of the page
   it started from, remembers that page locally, and asks `AstraApp` to open
   the URL in the system browser.
2. Discord returns to the ordinary https redirect, which is registered.
3. `js/discord.js` sees `state` is the app's callback and forwards the fragment
   to `astra://auth`. The tab does nothing else.
4. Android routes that to the app, where `AppPlugin` parks it - it cannot push
   it into the page, because on a cold start there is no page yet and a
   fragment-only change never re-runs a script.
5. The page collects it on load and whenever the app returns to the front,
   sets the fragment and reloads, and the ordinary callback signs in.

The same `astra://auth` scheme and the same branch in `discord.js` serve the
desktop build; only step 1 differs, because there the desktop app rewrites
`state` itself.

## Going back

Everything the room opens - settings, a category inside settings, the profile
card, the sheet, a menu, a focused tile - is a layer over one page, not a page
of its own. Android has no history to step through, so back closed the app.

The activity now asks the page first: `window.AstraNativeBack()` takes off the
topmost layer and says whether it found one. Only when it says no does the
press go on to mean what it usually means. The order is the one Escape already
follows on a desktop, and `dismissSettings()` is shared between them so a
category steps back to the list before the window closes.

## Where the screen edges are

The app draws edge to edge, and the Android WebView does not report that
reliably through `env(safe-area-inset-*)`. `AppPlugin.getInsets()` measures the
system bars and the display cutout, and the page sets `--safe-area-inset-top`
and `--safe-area-inset-bottom` from it. The stylesheet takes the larger of that
and `env()`, so wherever `env()` does work this changes nothing.

## What is where

| Path | What it is |
| --- | --- |
| `capacitor.config.json` | Points the app at `https://astrascreen.live`, same as the desktop build |
| `android/.../ScreenCapturePlugin.java` | The capture, and the on-device connection that carries it |
| `android/.../ScreenCaptureService.java` | The foreground service Android demands before it hands over a projection |
| `../js/native-screen.js` | The page's half of that connection - browser-safe, does nothing off-device |
| `android/.../AppPlugin.java` | The system browser, the token that comes back, and the screen insets |
| `../js/native-app.js` | The page's side of those - browser-safe, inert without the bridge |

`js/media.js` prefers the native path when it is there and falls back to
`getDisplayMedia` when it is not, so the same `captureScreen()` serves the
browser, the desktop app and this.

## Building it

Nothing here has been built or run. It needs tooling this machine does not
have:

- **Android Studio**, for the SDK (compileSdk 36), Gradle and adb. Java 21 is
  already required by Capacitor 8 and is installed.

Then:

```bash
cd mobile
npm install
npx cap sync android
npx cap open android      # or: npx cap run android
```

`cap sync` copies `www/` and refreshes the native project; `www/index.html` is
only the "cannot reach Astra" fallback, since the app loads the live site.

## Still to do

- **Build it once.** All of the Java is unverified - it has never been through
  a compiler, let alone a handset.
- **Permissions on first run.** Capacitor forwards the WebView's camera and
  microphone requests to the Android ones; `POST_NOTIFICATIONS` is needed on
  Android 13+ before the sharing notification will appear, and nothing asks
  for it yet.
- **A share button that knows where it is.** The room's mobile sheet still
  offers quality and system audio; on a phone the audio switch does nothing.
- **iOS.** Far worse than Android: screen capture there means ReplayKit and a
  Broadcast Upload Extension, which runs in a separate process with its own
  memory limits. None of this applies to it.
- Icons, a signing key, and a Play listing.
