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

  /** A mesh gets expensive fast: every peer sends its stream to every other. */
  maxPeers: 8,

  /** Discord OAuth2 Client ID for account connection. */
  discordClientId: '1545790115236945940',
};
