# Astra

Screen and audio sharing rooms that run entirely in the browser. Create a room,
send someone the six-character code, and share your screen — no install, no
account, and no media server: video and audio go straight from one browser to
another over WebRTC.

The whole site is static, so it deploys easily as-is.

## Features

- **Rooms** — press create and you are in, with a code like `KXP4BB` to share.
  An invite link asks a newcomer for a name first; if you already set one on the
  landing page, you go straight through.
- **Screen sharing** — whole screen, a single window, or one browser tab.
- **Audio** — system audio and microphone, mixed together into one stream.
- **Everyone can share** — the grid holds a tile per person who is sharing.
- **Layout follows the count** — one share takes the whole stage, two stack,
  three sit as a pair over a centred tile, four make a 2x2, and more fall into
  rows of three. Every tile stays 16:9, as large as its share of the stage allows.
- **Profile** — a name and an optional picture, set on the landing page or in
  the room by clicking your own avatar. Pick a file and an editor opens: drag to
  reposition, and sliders for size and rotation (plus a 90 degree button). Kept
  in your browser, never uploaded: the result is cropped square, scaled to 96px
  and sent to the room over the same data channel as everything else.
- **Chat and a people list**, with live "sharing" and "mic" badges.
- **Resizable side panel** — drag its left edge for width, and the handle between
  People and Chat to change the split. Both are remembered per browser.
- **Click a tile to focus it** (click again to go back); fullscreen from the
  icon in its corner.
- **Quality control** — 720p/1080p at 30 or 60fps, with a matching bitrate cap.
- Works on phones as a viewer today; sharing falls back to the camera where
  screen capture does not exist.

## Running it locally

Screen capture only works in a secure context, so open it over `http://localhost`
rather than double-clicking the HTML file:

```bash
npm start
```

Then visit http://localhost:3000. There are no dependencies to install — the dev
server is a ~40 line static file server, used only for local development.

## Deployment

The application runs as a static site and can be served over HTTPS by any static host or Cloudflare Workers (`npm run deploy`). HTTPS is required for screen capture permissions.

## How it works

There is no backend, so one browser holds each room open:

- Whoever creates a room claims the id `astra1-<CODE>` on a **PeerJS broker** and
  becomes the **hub**. Everybody else opens a data connection to the hub.
- The hub relays **signalling only** — the roster, chat, and WebRTC handshakes.
- Media is a **full mesh**: every peer connects directly to every other peer, so
  screen and audio never pass through any server.
- Negotiation uses the *perfect negotiation* pattern, because either side may
  start sharing at any moment.

Each peer publishes exactly one outgoing stream. Its audio track is always the
output of a Web Audio mixer, with the microphone and system audio plugged in as
sources — so toggling either is instant, and only starting or stopping the video
track needs a renegotiation.

```
index.html     the landing page, served at /
room/index.html  the room, served at /room/ - no .html in the address bar
room.html      redirect stub: keeps invite links shared before that move alive
js/config.js   settings: broker, ICE servers, room size
js/profile.js  your name and picture: storage, cropping, validation
js/signal.js   PeerJS hub/member signalling and the room roster
js/media.js    capture (screen, camera, mic) and the audio mixer
js/mesh.js     one RTCPeerConnection per peer, perfect negotiation
js/room.js     the room UI
js/lobby.js    the landing page
```

### Consequences worth knowing

- **If the host closes the tab, the room closes.** Everyone else sees "Room
  closed". Rooms are ephemeral by design; there is nothing to clean up.
- **A mesh is not a conference server.** Each sharer uploads one copy of their
  stream per viewer, so 1080p to seven people is roughly 20 Mbit/s up. `maxPeers`
  in `js/config.js` caps a room at 8; lower it if your uplink is modest.
- **Use headphones** if you share system audio with the microphone on — nothing
  here cancels the echo of your own speakers.

## Configuration

Everything adjustable lives in [`js/config.js`](js/config.js).

**Signalling broker.** The default (`peerServer: null`) is the free PeerJS cloud
broker: zero setup, rate limited, best effort. For anything you depend on, run
your own and point at it:

```bash
npx peerjs --port 9000 --key astra
```

```js
peerServer: { host: 'signal.example.com', port: 443, path: '/', secure: true, key: 'astra' }
```

**TURN.** STUN alone connects most home and office networks. If someone sees a
tile that stays black and never connects — strict corporate firewalls, some
mobile carriers — add a TURN server to `iceServers`.

## Browser support

| | Screen | System audio | Mic | Viewing |
|---|---|---|---|---|
| Chrome / Edge (desktop) | yes | yes (tick "Share audio" in the picker) | yes | yes |
| Firefox (desktop) | yes | no | yes | yes |
| Safari (desktop) | yes | no | yes | yes |
| iOS / Android | camera only | no | yes | yes |

System audio is a browser limitation, not an app one: only Chromium exposes it,
and on Windows it is offered for a whole screen or a tab, not an arbitrary
window.

## Roadmap

- Screen capture on mobile, once browsers expose it.
- Recording a session locally.
- Optional room passwords.
