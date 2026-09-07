/**
 * Astra configuration. Everything you are likely to change lives here.
 */
window.ASTRA = {
  /**
   * Signalling broker. `null` uses the free PeerJS cloud broker.
   * It is rate limited and best-effort - for anything you depend on, run your own:
   *
   *   npx peerjs --port 9000 --key astra
   *
   * and point at it:
   *   peerServer: { host: 'signal.example.com', port: 443, path: '/', secure: true, key: 'astra' }
   *
   * Only room codes and WebRTC handshakes go through the broker. Screen and
   * audio always travel directly between browsers.
   */
  peerServer: null,

  /**
   * STUN lets two peers find each other through ordinary home routers. TURN
   * relays media when a network refuses direct connections (strict corporate
   * firewalls, some mobile carriers) - add one here if people report a tile
   * that stays black and never connects.
   */
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    // { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' },
  ],

  /**
   * Room codes share one global namespace on a public broker, so they carry a
   * prefix to avoid colliding with other apps using the same one.
   */
  idPrefix: 'astra1-',

  /**
   * What counts as a room code. Astra generates six characters; the range is
   * wider so a code typed by hand, or minted by an older build, still resolves.
   * The server copies of this rule live in worker.js and dev-server.js - they
   * run in different runtimes and cannot share this file.
   */
  roomCodePattern: /^[A-Z0-9]{4,12}$/,

  /** A mesh gets expensive fast: every peer sends its stream to every other. */
  maxPeers: 8,

  /**
   * Ceiling on what this machine uploads in video, across the whole room.
   *
   * A mesh sends one copy of your screen to every other person, so the quality
   * you pick is multiplied by the number of viewers. Left unbounded, a full
   * room asks the line for more than it can carry and the streams take turns
   * stalling and recovering. Raise it if you have plenty of upload; lower it if
   * sharing makes your connection struggle.
   *
   * Note this also caps a one-to-one call: at 6 Mbps the "max" quality preset
   * (8 Mbps, see QUALITY in js/media.js) can never be reached. Raise this above
   * that preset if you want the top of the dropdown to mean what it says.
   */
  maxUploadBitrate: 6000000,

  /** Discord OAuth2 Client ID for account connection. */
  discordClientId: '1545790115236945940',
};
