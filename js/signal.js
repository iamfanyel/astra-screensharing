'use strict';

/**
 * Signalling over PeerJS.
 *
 * There is no server, so one browser has to hold the room open: whoever creates
 * a room claims the broker id `<prefix><CODE>` and becomes the hub. Everybody
 * else opens a data connection to the hub, and the hub relays handshakes and
 * roster updates between them.
 *
 * The hub relays *signalling only* - audio and video are a direct mesh between
 * every pair of peers (see mesh.js). If the host closes the tab, the room ends.
 */
(function () {
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I: readable aloud
  const JOIN_TIMEOUT_MS = 20000;
  const HEARTBEAT_INTERVAL_MS = 3000;
  const HEARTBEAT_TIMEOUT_MS = 25000;
  const BROKER_RECONNECT_TIMEOUT_MS = 25000;

  /** How often the host renews its claim. Must be well inside the lease. */
  const LEASE_RENEW_MS = 6000;

  /** How long to wait on the lease before carrying on without it. */
  const LEASE_TIMEOUT_MS = 4000;

  /**
   * How long to wait before each attempt to get the broker back.
   *
   * PeerJS says `disconnected` when the socket drops, and reconnecting from
   * that event without a pause is a loop: the attempt fails while the network
   * is still down, which says `disconnected` again, which attempts again, for
   * as long as the outage lasts. A dropped wifi connection can turn that into
   * hundreds of connections a minute, and the public broker sits behind a rate
   * limiter that counts them - so the room comes back to a working network and
   * a broker that now refuses it for the better part of an hour.
   *
   * The first wait is short enough that a momentary blip recovers as quickly as
   * it used to; after that they lengthen, so an outage costs a handful of
   * attempts rather than thousands. Jittered, so a room full of people whose
   * shared wifi dropped does not come back in lockstep.
   */
  const RECONNECT_DELAYS_MS = [250, 1000, 3000, 8000, 20000];

  /**
   * Ask the server who is hosting a room, or say that it is us.
   *
   * The browsers cannot settle this between themselves - see RoomHost in
   * worker.js for why - so one place answers for all of them. Every failure
   * here is silent and returns null: a room must still work when the lease is
   * unreachable, and without it the code's own broker id is the fallback,
   * which is exactly how this worked before.
   */
  async function hostLease(action, code, peerId) {
    if (!code) return null;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const giveUp = setTimeout(() => controller && controller.abort(), LEASE_TIMEOUT_MS);
    try {
      const options = action === 'host'
        ? { method: 'GET' }
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, action, peerId }),
          };
      if (controller) options.signal = controller.signal;
      const url = action === 'host'
        ? '/api/host?code=' + encodeURIComponent(code)
        : '/api/host';
      const res = await fetch(url, options);
      if (!res.ok) return null;
      const answer = await res.json();
      return answer && answer.available === false ? null : answer;
    } catch (_) {
      return null;
    } finally {
      clearTimeout(giveUp);
    }
  }

  function randomCode(length = 6) {
    const bytes = new Uint32Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  }

  function cleanName(name) {
    return String(name || '').trim().slice(0, 32) || 'Guest';
  }

  function peerOptions() {
    const opts = { config: { iceServers: window.ASTRA.iceServers } };
    return window.ASTRA.peerServer ? Object.assign(opts, window.ASTRA.peerServer) : opts;
  }

  // Peers can only tell the room about these; everything else is ignored.
  // Pictures come from someone else's browser, so they are validated, never
  // trusted - see AstraProfile.isAvatar.
  /**
   * The per-peer state the room shares, in one place. Adding a flag here is the
   * only edit needed: the patch filter, new members, rejoins and host migration
   * all read from this list.
   */
  const PEER_FLAGS = ['sharing', 'camera', 'mic', 'deafened', 'dev'];

  /** A peer as it looks the moment it joins. */
  function newMember(id, name, host, dev = false) {
    const member = { id, name: cleanName(name), avatar: null, banner: null, discord: null, badge: '', host: !!host, screenTrackId: null, cameraTrackId: null, screenAudioTrackId: null, watching: [] };
    for (const flag of PEER_FLAGS) member[flag] = false;
    member.dev = !!dev;
    if (dev) member.badge = 'dev';
    return member;
  }

  /**
   * Peers can only tell the room about the fields below; everything else is
   * ignored. Pictures come from someone else's browser, so they are validated,
   * never trusted - see AstraProfile.isAvatar and isBanner.
   */
  function statePatch(patch) {
    const out = {};
    if (!patch) return out;
    for (const flag of PEER_FLAGS) {
      if (typeof patch[flag] === 'boolean') out[flag] = patch[flag];
    }
    if ('name' in patch && patch.name) {
      out.name = cleanName(patch.name);
    }
    if ('avatar' in patch) {
      out.avatar = window.AstraProfile && window.AstraProfile.isAvatar(patch.avatar) ? patch.avatar : null;
    }
    if ('banner' in patch) {
      out.banner = window.AstraProfile && window.AstraProfile.isBanner(patch.banner) ? patch.banner : null;
    }
    if ('badge' in patch) {
      // Only ids this build can draw; anything else is treated as no badge.
      out.badge = window.AstraDiscord && window.AstraDiscord.isBadge(patch.badge) ? patch.badge : '';
    } else if (typeof patch.dev === 'boolean') {
      // A peer on the older build announces `dev` and nothing else.
      out.badge = patch.dev ? 'dev' : '';
    }
    if ('discord' in patch) {
      // A short label from someone else's browser: trimmed and capped, and
      // rendered as text, never as markup.
      const label = typeof patch.discord === 'string' ? patch.discord.trim().slice(0, 80) : '';
      out.discord = label || null;
    }
    if ('screenTrackId' in patch) {
      out.screenTrackId = typeof patch.screenTrackId === 'string' ? patch.screenTrackId : null;
    }
    if ('cameraTrackId' in patch) {
      out.cameraTrackId = typeof patch.cameraTrackId === 'string' ? patch.cameraTrackId : null;
    }
    if ('screenAudioTrackId' in patch) {
      out.screenAudioTrackId = typeof patch.screenAudioTrackId === 'string' ? patch.screenAudioTrackId : null;
    }
    if ('watching' in patch) {
      out.watching = Array.isArray(patch.watching)
        ? patch.watching.filter((id) => typeof id === 'string').slice(0, 50)
        : [];
    }
    return out;
  }

  class Signal extends EventTarget {
    constructor() {
      super();
      this.code = null;
      this.selfId = null;
      this.hostId = null;
      this.isHub = false;
      this.roster = new Map(); // id -> { id, name, sharing, mic, host }
      this.conns = new Map(); // hub only: member id -> DataConnection
      this.left = false;
      this._gatewayPeer = null;
      this._hubListening = false;
      this._heartbeatInterval = null;
      this._memberLastSeen = new Map(); // hub only: member id -> timestamp
      this._hostLastSeen = 0; // member only: timestamp of last message from host
      this._brokerDisconnectTimer = null;
      this._reconnectTimer = null;
      this._reconnectAttempts = 0;
      this._waitingForOnline = false;
      this._reconnecting = false;
    }

    /**
     * Ask for the broker back, after a wait that grows with each failure.
     *
     * Nothing is attempted while the browser says it is offline: there is no
     * point, and it is exactly the moment the old code tried hardest. The
     * browser tells us when the network returns, and that is when to try.
     */
    _scheduleReconnect(peer) {
      if (this.left || this._reconnectTimer) return;

      // Said once per outage, not once per attempt: the room puts a screen up
      // on the first of these and takes it down on `reconnected`, and a dozen
      // of them would only make it flicker.
      if (!this._reconnecting) {
        this._reconnecting = true;
        this.emit('reconnecting', {});
      }

      // Nothing can be attempted while the browser says there is no network,
      // and that is exactly the moment the old code tried hardest. Wait to be
      // told it is back - once, however many times this is asked - and treat
      // that as a fresh start: the failures behind us were a missing network
      // rather than a busy broker, so making somebody sit through the longest
      // delay afterwards would punish them for an outage that has ended.
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        if (this._waitingForOnline) return;
        this._waitingForOnline = true;
        window.addEventListener('online', () => {
          this._waitingForOnline = false;
          this._reconnectAttempts = 0;
          this._scheduleReconnect(peer);
        }, { once: true });
        return;
      }

      const step = Math.min(this._reconnectAttempts, RECONNECT_DELAYS_MS.length - 1);
      const base = RECONNECT_DELAYS_MS[step];
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        if (this.left || peer.destroyed || !peer.disconnected) return;
        // Counted here rather than when it was scheduled: an attempt that was
        // never made should not push the next one further away.
        this._reconnectAttempts += 1;
        try {
          peer.reconnect();
        } catch (_) {
          // Already reconnecting, or gone. The next `disconnected` asks again.
        }
      }, base + Math.random() * base * 0.3);
    }

    /** The broker is back, so the next drop starts counting from scratch. */
    _reconnected() {
      this._reconnectAttempts = 0;
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
      if (this._reconnecting) {
        this._reconnecting = false;
        this.emit('reconnected', {});
      }
    }

    emit(type, detail) {
      this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    get self() {
      return this.roster.get(this.selfId);
    }

    others() {
      return Array.from(this.roster.values()).filter((p) => p.id !== this.selfId);
    }

    // ---------------------------------------------------------------- create

    static async create(name) {
      let lastError = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const signal = new Signal();
        try {
          return await signal._openHub(randomCode(), cleanName(name));
        } catch (err) {
          lastError = err;
          if (err && err.type === 'unavailable-id') continue; // code taken, roll another
          if (attempt < 4 && (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error')) {
            await new Promise((r) => setTimeout(r, 600));
            continue;
          }
          throw err;
        }
      }
      throw lastError || new Error('Could not create a room. Try again.');
    }

    /** Reclaim an empty room within grace period, becoming the host. */
    static async reclaim(code, name) {
      const roomCode = String(code || '').trim().toUpperCase();
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const signal = new Signal();
        try {
          return await signal._openHub(roomCode, cleanName(name));
        } catch (err) {
          lastError = err;
          if (err && err.type === 'unavailable-id') {
            return await Signal.join(roomCode, name);
          }
          if (attempt < 2 && (err && (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error'))) {
            await new Promise((r) => setTimeout(r, 600));
            continue;
          }
          throw err;
        }
      }
      throw lastError || new Error('Could not reclaim room. Try again.');
    }

    _openHub(code, name) {
      return new Promise((resolve, reject) => {
        const peer = new Peer(window.ASTRA.idPrefix + code, peerOptions());
        let settled = false;

        peer.on('open', () => {
          // PeerJS says `open` again each time it gets the broker back, and
          // everything below is one-time setup: running it twice adds a second
          // `connection` listener, so every future member would be accepted
          // twice. A reconnect only has to reset the backoff.
          if (this._hubListening) {
            this._reconnected();
            return;
          }
          settled = true;
          this.peer = peer;
          this.isHub = true;
          this.code = code;
          this.selfId = peer.id;
          this.hostId = peer.id;
          const selfDev = !!(window.AstraDiscord && window.AstraDiscord.isDev());
          const selfDiscord = window.AstraDiscord ? window.AstraDiscord.accountLabel() || null : null;
          const selfBadge = window.AstraDiscord ? window.AstraDiscord.badgeFor() : '';
          this.roster.set(peer.id, {
            id: peer.id,
            name,
            sharing: false,
            camera: false,
            mic: false,
            deafened: false,
            dev: selfDev,
            badge: selfBadge,
            discord: selfDiscord,
            avatar: window.AstraProfile ? window.AstraProfile.getAvatar() : null,
            banner: window.AstraProfile ? window.AstraProfile.getBanner() : null,
            host: true,
            watching: [],
          });
          this._hubListening = true;
          this._startHeartbeat();
          this._claimHostLease();
          peer.on('connection', (conn) => this._acceptMember(conn));
          peer.on('disconnected', () => {
            if (this.left) return;
            this._scheduleReconnect(peer);
            if (!this._brokerDisconnectTimer) {
              this._brokerDisconnectTimer = setTimeout(() => {
                if (peer.disconnected && !this.left) {
                  this.emit('closed', { reason: 'Disconnected: connection to the signalling server was lost.' });
                }
              }, BROKER_RECONNECT_TIMEOUT_MS);
            }
          });
          peer.on('close', () => {
            if (!this.left) this._handleHostLoss();
          });
          resolve(this);
        });

        peer.on('error', (err) => {
          if (settled) return this.emit('error', err);
          settled = true;
          peer.destroy();
          reject(err);
        });
      });
    }

    _acceptMember(conn) {
      conn.on('open', () => {
        const metadata = conn.metadata || {};
        const isRejoin = Boolean(metadata.rejoin && this.roster.has(conn.peer));

        if (!isRejoin && this.roster.size >= window.ASTRA.maxPeers) {
          conn.send({ t: 'denied', reason: 'That room is full.' });
          setTimeout(() => {
            try { conn.close(); } catch (_) {}
          }, 500);
          return;
        }

        let member;
        if (isRejoin) {
          member = this.roster.get(conn.peer);
          if (metadata.name) member.name = cleanName(metadata.name);
          Object.assign(member, statePatch(metadata));
        } else {
          member = newMember(conn.peer, metadata.name, false);
          Object.assign(member, statePatch(metadata));
        }

        this.conns.set(member.id, conn);
        this.roster.set(member.id, member);
        this._memberLastSeen.set(member.id, Date.now());

        conn.send({
          t: 'welcome',
          selfId: conn.peer,
          hostId: this.selfId,
          code: this.code,
          peers: Array.from(this.roster.values()),
        });

        if (!isRejoin) {
          this._fanout({ t: 'joined', peer: member }, member.id);
          this.emit('peer-joined', { peer: member });
        }
      });

      conn.on('data', (msg) => this._onHubData(conn, msg));
      conn.on('close', () => this._dropMember(conn.peer));
      conn.on('error', () => this._dropMember(conn.peer));
    }

    kick(targetId) {
      if (!this.isHub || !this.self?.host) {
        console.warn('[signal] Only the host can kick participants.');
        return;
      }
      if (!targetId || targetId === this.selfId) return;

      const target = this.roster.get(targetId);
      if (!target) return;

      const conn = this.conns.get(targetId);
      if (conn && conn.open) {
        conn.send({ t: 'kicked', reason: 'You were kicked from the room by the host.' });
        setTimeout(() => {
          try { conn.close(); } catch (_) {}
        }, 100);
      }

      this._dropMember(targetId);
    }

    _onHubData(conn, msg) {
      if (!msg || !this.roster.has(conn.peer)) return;
      this._memberLastSeen.set(conn.peer, Date.now());

      if (msg.t === 'ping') {
        if (conn && conn.open) {
          try { conn.send({ t: 'pong' }); } catch (_) {}
        }
        return;
      }
      if (msg.t === 'pong') {
        return;
      }

      switch (msg.t) {
        case 'signal':
          if (msg.to === this.selfId) this.emit('signal', { from: conn.peer, data: msg.data });
          else this._sendTo(msg.to, { t: 'signal', from: conn.peer, data: msg.data });
          break;
        case 'state': {
          const patch = statePatch(msg.patch);
          Object.assign(this.roster.get(conn.peer), patch);
          this._fanout({ t: 'state', id: conn.peer, patch }, conn.peer);
          this.emit('peer-state', { id: conn.peer, patch });
          break;
        }
        case 'chat': {
          const text = String(msg.text || '').slice(0, 500);
          if (!text.trim()) break;
          const member = this.roster.get(conn.peer);
          const message = {
            t: 'chat',
            id: conn.peer,
            name: member ? member.name : 'Guest',
            avatar: member ? member.avatar : null,
            text,
            at: Date.now(),
          };
          this._fanout(message);
          this.emit('chat', message);
          break;
        }
      }
    }

    _dropMember(id, reason = 'left') {
      if (!this.conns.has(id) && !this.roster.has(id)) return;
      const member = this.roster.get(id);
      const name = member ? member.name : 'A participant';
      this.conns.delete(id);
      this.roster.delete(id);
      this._memberLastSeen.delete(id);
      this._fanout({ t: 'left', id, name, reason });
      this.emit('peer-left', { id, name, reason });
    }

    _sendTo(id, msg) {
      const conn = this.conns.get(id);
      if (conn && conn.open) conn.send(msg);
    }

    _fanout(msg, exceptId) {
      for (const [id, conn] of this.conns) {
        if (id !== exceptId && conn.open) conn.send(msg);
      }
    }

    // ------------------------------------------------------------------ join

    static join(code, name, attempts = 0) {
      const signal = new Signal();
      const roomCode = String(code || '').trim().toUpperCase();

      return new Promise((resolve, reject) => {
        // Explicit unique client ID bypasses PeerJS's HTTP GET /peerjs/id
        // which triggers "Could not reach the signalling broker" under network/CORS hiccups
        const clientId = 'c-' + randomCode(16);
        const peer = new Peer(clientId, peerOptions());
        let settled = false;

        const settle = (fn, arg) => {
          if (settled) return false;
          settled = true;
          clearTimeout(timer);
          fn(arg);
          return true;
        };

        const timer = setTimeout(() => {
          if (settle(reject, new Error('The room did not respond. Check the code and try again.'))) {
            peer.destroy();
          }
        }, JOIN_TIMEOUT_MS);

        // Asked for straight away so it is usually answered by the time the
        // broker connection is up.
        const whoIsHosting = hostLease('host', roomCode, null)
          .then((answer) => (answer && answer.hostId) || null)
          .catch(() => null);

        let opened = false;
        peer.on('open', async () => {
          // As in _openHub: this fires again on every reconnect, and below it
          // registers listeners and reaches for the host.
          if (opened) {
            signal._reconnected();
            return;
          }
          opened = true;
          peer.on('disconnected', () => {
            if (signal.left) return;
            signal._scheduleReconnect(peer);
            if (!signal._brokerDisconnectTimer) {
              signal._brokerDisconnectTimer = setTimeout(() => {
                if (peer.disconnected && !signal.left) {
                  signal.emit('closed', { reason: 'Disconnected: connection to the signalling server was lost.' });
                }
              }, BROKER_RECONNECT_TIMEOUT_MS);
            }
          });

          // Where the room actually is. The code's own broker id is only the
          // room's first host; once that host has been replaced, the id can be
          // left registered to somebody who is no longer running the room, and
          // joining it is how people ended up in a room of their own. The
          // lease knows who took over. Started before the peer opened, so the
          // two waits overlap, and it falls back to the old answer when the
          // lease cannot be reached.
          const fallbackId = window.ASTRA.idPrefix + roomCode;
          const known = await whoIsHosting;
          if (settled) return;
          const hostId = known || fallbackId;

          // Connect metadata is relayed by the broker inside a single
          // signalling message, so it has to stay small. Pictures go over the
          // data channel once the connection is open - see setState below and
          // the push in room.js right after joining.
          const conn = peer.connect(hostId, {
            metadata: {
              name: cleanName(name),
              dev: !!(window.AstraDiscord && window.AstraDiscord.isDev()),
              badge: window.AstraDiscord ? window.AstraDiscord.badgeFor() : '',
              discord: window.AstraDiscord ? window.AstraDiscord.accountLabel() : '',
            },
            reliable: true,
          });

          conn.on('data', (msg) => {
            if (!msg) return;
            if (!settled && msg.t === 'welcome') {
              signal._setupMember(peer, conn, msg, cleanName(name));
              settle(resolve, signal);
              return;
            }
            if (!settled && msg.t === 'denied') {
              if (settle(reject, new Error(msg.reason || 'The room refused the connection.'))) {
                peer.destroy();
              }
              return;
            }
            signal._onMemberData(msg);
          });

          conn.on('close', () => {
            const wasJoining = settle(reject, new Error('No room with that code, or the host has closed it.'));
            if (wasJoining) {
              peer.destroy();
            } else if (!signal.left) {
              signal._handleHostLoss();
            }
          });
        });

        peer.on('error', (err) => {
          if (settled) {
            // A peer we were sent to that is not on the broker. Waiting out
            // the heartbeat would leave the room looking empty for half a
            // minute, and the raw message means nothing to anybody, so this
            // goes back and asks who is hosting instead of showing it.
            if (err && err.type === 'peer-unavailable' && signal._reachingFor) {
              signal._reachingFor = null;
              signal._handleHostLoss('unreachable');
              return;
            }
            return signal.emit('error', err);
          }
          if (
            attempts < 2 &&
            err &&
            (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error' || err.type === 'socket-closed')
          ) {
            settle(() => {}, null);
            try { peer.destroy(); } catch (_) {}
            setTimeout(() => {
              Signal.join(code, name, attempts + 1).then(resolve, reject);
            }, 600);
            return;
          }
          const friendly =
            err && err.type === 'peer-unavailable'
              ? Object.assign(new Error('No room with that code. It may have expired.'), { type: 'peer-unavailable' })
              : err;
          if (settle(reject, friendly)) peer.destroy();
          else signal.emit('error', err);
        });
      });
    }

    _setupMember(peer, conn, welcome, name) {
      this.peer = peer;
      this.conn = conn;
      this.isHub = false;
      this.code = welcome.code;
      this.selfId = welcome.selfId;
      this.hostId = welcome.hostId;
      for (const p of welcome.peers) {
        // The hub is just another browser: check what it hands us.
        if (!window.AstraProfile.isAvatar(p.avatar)) p.avatar = null;
        if (!window.AstraProfile.isBanner(p.banner)) p.banner = null;
        if (!Array.isArray(p.watching)) p.watching = [];
        this.roster.set(p.id, p);
      }
      const selfDev = !!(window.AstraDiscord && window.AstraDiscord.isDev());
      this.roster.set(this.selfId, newMember(this.selfId, name, false, selfDev));
      this._hostLastSeen = Date.now();
      this._startHeartbeat();
      peer.on('connection', (c) => this._acceptMember(c));
      peer.on('disconnected', () => {
        if (this.left) return;
        this._scheduleReconnect(peer);
        if (!this._brokerDisconnectTimer) {
          this._brokerDisconnectTimer = setTimeout(() => {
            if (peer.disconnected && !this.left) {
              this.emit('closed', { reason: 'Disconnected: connection to the signalling server was lost.' });
            }
          }, BROKER_RECONNECT_TIMEOUT_MS);
        }
      });
    }

    _onMemberData(msg) {
      this._hostLastSeen = Date.now();

      if (msg.t === 'ping') {
        if (this.conn && this.conn.open) {
          try { this.conn.send({ t: 'pong' }); } catch (_) {}
        }
        return;
      }
      if (msg.t === 'pong') {
        return;
      }

      switch (msg.t) {
        case 'joined':
          this.roster.set(msg.peer.id, msg.peer);
          this.emit('peer-joined', { peer: msg.peer });
          break;
        case 'left': {
          const leftMember = this.roster.get(msg.id);
          const leftName = msg.name || (leftMember ? leftMember.name : 'A participant');
          this.roster.delete(msg.id);
          this.emit('peer-left', { id: msg.id, name: leftName, reason: msg.reason || 'left' });
          break;
        }
        case 'signal':
          this.emit('signal', { from: msg.from, data: msg.data });
          break;
        case 'state': {
          const peer = this.roster.get(msg.id);
          const patch = statePatch(msg.patch);
          if (peer) Object.assign(peer, patch);
          this.emit('peer-state', { id: msg.id, patch });
          break;
        }
        case 'chat':
          this.emit('chat', msg);
          break;
        case 'closed':
          this.left = true;
          this.emit('closed', { reason: msg.reason || 'The host closed the room.' });
          break;
        case 'kicked':
          this.left = true;
          this.emit('kicked', { reason: msg.reason || 'You were kicked from the room by the host.' });
          if (this.conn) {
            try { this.conn.close(); } catch (_) {}
            this.conn = null;
          }
          if (this.peer) {
            try { this.peer.destroy(); } catch (_) {}
            this.peer = null;
          }
          break;
        case 'migrate-host':
          this._handleHostMigration(msg.newHostId, msg.oldHostId);
          break;
      }
    }

    _handleHostLoss(reason = 'left') {
      if (this.left || this.isHub) return;

      const oldHostId = this.hostId;
      if (oldHostId === this.selfId) return; // Self is already host, ignore

      let oldHostName = 'The host';
      if (oldHostId && this.roster.has(oldHostId)) {
        const oldHost = this.roster.get(oldHostId);
        if (oldHost) oldHostName = oldHost.name;
        this.roster.delete(oldHostId);
        this.emit('peer-left', { id: oldHostId, name: oldHostName, reason });
      }

      // Ensure self is in roster
      if (!this.roster.has(this.selfId)) {
        const selfDev = !!(window.AstraDiscord && window.AstraDiscord.isDev());
        this.roster.set(this.selfId, newMember(this.selfId, 'Guest', false, selfDev));
      }

      if (this.roster.size === 0) {
        this.emit('closed', { reason: 'All participants have left the room.' });
        return;
      }

      // One search at a time. Several things can notice the host is gone at
      // once - the heartbeat, a closed connection, a peer that turned out not
      // to be there - and each starting its own would have them racing.
      if (this._findingHost) return;
      this._findingHost = true;
      this._findNextHost(oldHostId).then(
        () => { this._findingHost = false; },
        () => { this._findingHost = false; },
      );
    }

    /**
     * Work out who is hosting now, asking the one thing that knows.
     *
     * The roster is not that thing. It says who was here the last time anybody
     * told us, so electing from it can pick somebody who has already gone -
     * and then there is nothing at that id, the connection fails with
     * "could not connect to peer", and the room sits alone until the heartbeat
     * comes round again. The lease only ever names a host that said it was
     * still there within the last few seconds.
     *
     * The old election is still here, for when the lease cannot be reached at
     * all. It is a guess, but a guess beats giving up.
     */
    async _findNextHost(oldHostId) {
      const answer = await hostLease('host', this.code, null);
      if (this.left || this.isHub) return;

      if (answer && answer.hostId && answer.hostId !== oldHostId) {
        if (answer.hostId === this.selfId) this._promoteToHub();
        else this._handleHostMigration(answer.hostId, oldHostId);
        return;
      }

      if (answer && !answer.hostId) {
        // Nobody holds it. Taking it is also how we find out who beat us to
        // it, which is the answer we needed either way.
        const claim = await hostLease('claim', this.code, this.selfId);
        if (this.left || this.isHub) return;
        if (claim && claim.ok) {
          this._promoteToHub();
          return;
        }
        if (claim && claim.hostId && claim.hostId !== this.selfId) {
          this._handleHostMigration(claim.hostId, oldHostId);
          return;
        }
      }

      this._electFromRoster(oldHostId);
    }

    /** The old way: lowest id wins. Only when there is no lease to ask. */
    _electFromRoster(oldHostId) {
      const remaining = Array.from(this.roster.values());
      if (remaining.length === 0) {
        this.emit('closed', { reason: 'All participants have left the room.' });
        return;
      }
      const candidates = remaining.slice().sort((a, b) => a.id.localeCompare(b.id));
      this._handleHostMigration(candidates[0].id, oldHostId);
    }

    _handleHostMigration(newHostId, oldHostId) {
      if (this.left) return;

      if (oldHostId && oldHostId !== this.selfId && this.roster.has(oldHostId)) {
        const oldHost = this.roster.get(oldHostId);
        const oldHostName = oldHost ? oldHost.name : 'The host';
        this.roster.delete(oldHostId);
        this.emit('peer-left', { id: oldHostId, name: oldHostName, reason: 'host-migration' });
      }

      // Detach close/error listeners from old connection before closing so it doesn't re-trigger host loss
      if (this.conn) {
        const oldConn = this.conn;
        this.conn = null;
        try {
          if (typeof oldConn.removeAllListeners === 'function') {
            oldConn.removeAllListeners('close');
            oldConn.removeAllListeners('error');
          }
          oldConn.onclose = null;
          oldConn.onerror = null;
          oldConn.close();
        } catch (_) {}
      }

      if (newHostId === this.selfId) {
        this._promoteToHub();
      } else {
        this._reconnectToNewHost(newHostId);
      }
    }

    _promoteToHub() {
      if (this.isHub) return;
      this.isHub = true;
      this.hostId = this.selfId;
      this._hostLastSeen = 0;

      for (const [id, peer] of this.roster) {
        peer.host = (id === this.selfId);
      }

      if (this.conn) {
        const oldConn = this.conn;
        this.conn = null;
        try {
          if (typeof oldConn.removeAllListeners === 'function') {
            oldConn.removeAllListeners('close');
            oldConn.removeAllListeners('error');
          }
          oldConn.onclose = null;
          oldConn.onerror = null;
          oldConn.close();
        } catch (_) {}
      }

      if (this.peer && !this._hubListening) {
        this._hubListening = true;
        this.peer.on('connection', (conn) => this._acceptMember(conn));
      }

      this._bindGatewayPeer();
      this._startHeartbeat();
      // Claimed rather than assumed. If somebody else already holds it this
      // comes back and puts us where the room actually is - which is the
      // difference between one room and two wearing the same code.
      this._claimHostLease();

      const me = this.roster.get(this.selfId);
      this.emit('host-changed', { hostId: this.selfId, hostName: me ? me.name : 'You' });
    }

    /**
     * Say we are hosting, and believe the answer if we are not.
     *
     * Optimistic on purpose: the hub carries on immediately and is corrected a
     * moment later if it lost. Waiting would stall the room every time the
     * network is slow, and being briefly wrong costs nothing because the
     * correction is authoritative - unlike the broker's "that id is taken",
     * which a departed host leaves behind and which used to be read as proof
     * somebody was there.
     */
    async _claimHostLease() {
      if (this.left || !this.isHub || !this.code) return;
      const answer = await hostLease('claim', this.code, this.selfId);
      if (!answer || this.left || !this.isHub) return;
      if (answer.ok) {
        this._leaseHeld = true;
        return;
      }
      this._leaseHeld = false;
      if (!answer.hostId || answer.hostId === this.selfId) return;
      this._standDownTo(answer.hostId);
    }

    /**
     * Stop hosting and join the peer that really is.
     *
     * Only ever reached from an answer given by the lease, which is the one
     * thing in the system that can tell a live host from a departed one.
     */
    _standDownTo(hostId) {
      if (this.left || !this.isHub || !hostId || hostId === this.selfId) return;
      console.warn('[signal] another peer holds the host lease; joining it instead');

      // Told before their connections close, so they follow rather than hold
      // an election among themselves and scatter.
      this._fanout({ t: 'migrate-host', newHostId: hostId, oldHostId: this.selfId });
      for (const [id, conn] of this.conns) {
        if (id === this.selfId) continue;
        try { conn.close(); } catch (_) {}
      }
      this.conns.clear();
      if (this._memberLastSeen) this._memberLastSeen.clear();
      if (this._gatewayPeer) {
        try { this._gatewayPeer.destroy(); } catch (_) {}
        this._gatewayPeer = null;
      }
      this._leaseHeld = false;
      this._reconnectToNewHost(hostId);
    }

    _reconnectToNewHost(newHostId) {
      this.isHub = false;
      this.hostId = newHostId;
      // Watched by the broker's error handler: if nothing answers at this id,
      // that is a dead end to be reported rather than waited out.
      this._reachingFor = newHostId;
      this._hostLastSeen = Date.now();
      this._startHeartbeat();

      for (const [id, peer] of this.roster) {
        peer.host = (id === newHostId);
      }

      if (this.conn) {
        try { this.conn.close(); } catch (_) {}
        this.conn = null;
      }

      const me = this.roster.get(this.selfId);

      const connectToHost = () => {
        if (this.left || this.isHub || !this.peer || this.peer.destroyed) return;
        const conn = this.peer.connect(newHostId, {
          // Flags only: pictures are too big for the broker to relay here.
          metadata: {
            name: me ? me.name : 'Guest',
            rejoin: true,
            sharing: me ? me.sharing : false,
            mic: me ? me.mic : false,
            deafened: me ? me.deafened : false,
            dev: me ? !!me.dev : false,
            badge: me ? me.badge || '' : '',
            discord: me ? me.discord : null,
          },
          reliable: true,
        });

        conn.on('open', () => {
          this.conn = conn;
          this._reachingFor = null;
          // The new host received flags in the metadata but no pictures, so
          // send those on now that a data channel exists.
          if (me && (me.avatar || me.banner)) {
            this.setState({ avatar: me.avatar || null, banner: me.banner || null });
          }
        });

        conn.on('data', (msg) => {
          if (!msg) return;
          this._onMemberData(msg);
        });

        conn.on('close', () => {
          if (!this.left && this.hostId === newHostId) {
            this._handleHostLoss();
          }
        });

        conn.on('error', (err) => {
          console.warn('[signal] reconnect to host error', err);
        });
      };

      setTimeout(connectToHost, 350);

      const newHost = this.roster.get(newHostId);
      this.emit('host-changed', { hostId: newHostId, hostName: newHost ? newHost.name : 'A participant' });
    }

    _startHeartbeat() {
      this._stopHeartbeat();
      const check = () => this._checkHeartbeat();
      try {
        if (typeof Worker !== 'undefined' && typeof Blob !== 'undefined') {
          const blob = new Blob([
            `let t; self.onmessage = (e) => { if (e.data === 'start') t = setInterval(() => self.postMessage(1), ${HEARTBEAT_INTERVAL_MS}); else if (t) clearInterval(t); };`
          ], { type: 'application/javascript' });
          const url = URL.createObjectURL(blob);
          const worker = new Worker(url);
          URL.revokeObjectURL(url);
          worker.onmessage = () => check();
          worker.postMessage('start');
          this._heartbeatWorker = worker;
          return;
        }
      } catch (_) {}
      this._heartbeatInterval = setInterval(check, HEARTBEAT_INTERVAL_MS);
    }

    _stopHeartbeat() {
      if (this._heartbeatWorker) {
        try {
          this._heartbeatWorker.postMessage('stop');
          this._heartbeatWorker.terminate();
        } catch (_) {}
        this._heartbeatWorker = null;
      }
      if (this._heartbeatInterval) {
        clearInterval(this._heartbeatInterval);
        this._heartbeatInterval = null;
      }
    }

    _checkHeartbeat() {
      if (this.left) {
        this._stopHeartbeat();
        return;
      }

      if (this.peer && !this.peer.disconnected && this._brokerDisconnectTimer) {
        clearTimeout(this._brokerDisconnectTimer);
        this._brokerDisconnectTimer = null;
      }

      const now = Date.now();
      if (this.isHub) {
        this._renewHostLease(now);
        for (const [id, conn] of this.conns) {
          if (id === this.selfId) continue;
          const lastSeen = this._memberLastSeen.get(id) || now;
          if (now - lastSeen > HEARTBEAT_TIMEOUT_MS) {
            console.warn(`[signal] Member ${id} timed out after ${now - lastSeen}ms`);
            try { conn.close(); } catch (_) {}
            this._dropMember(id, 'timeout');
          } else if (conn && conn.open) {
            try { conn.send({ t: 'ping' }); } catch (_) {}
          }
        }
      } else {
        if (this.conn && this.conn.open) {
          try { this.conn.send({ t: 'ping' }); } catch (_) {}
        }
        if (this._hostLastSeen && (now - this._hostLastSeen > HEARTBEAT_TIMEOUT_MS)) {
          console.warn(`[signal] Host ${this.hostId} timed out after ${now - this._hostLastSeen}ms`);
          this._handleHostLoss('timeout');
        }
      }
    }

    /**
     * Keep saying we are still hosting.
     *
     * A lease that stops being renewed expires, and somebody else may take it
     * - which is what lets a room recover from a host that vanished. The same
     * call is how a host that was away too long finds out it has been replaced
     * and goes to join whoever took over.
     */
    _renewHostLease(now) {
      if (this.left || !this.code) return;
      if (this._leaseRenewedAt && now - this._leaseRenewedAt < LEASE_RENEW_MS) return;
      this._leaseRenewedAt = now;
      hostLease('heartbeat', this.code, this.selfId).then((answer) => {
        if (!answer || this.left || !this.isHub) return;
        if (answer.ok) {
          this._leaseHeld = true;
          return;
        }
        this._leaseHeld = false;
        // Not ours any more. If the seat is simply empty, take it back;
        // if somebody is in it, go and join them.
        if (!answer.hostId) this._claimHostLease();
        else if (answer.hostId !== this.selfId) this._standDownTo(answer.hostId);
      });
    }

    _bindGatewayPeer() {
      if (this._gatewayPeer || this.left || !this.isHub || !this.code) return;

      const gatewayId = window.ASTRA.idPrefix + this.code;
      if (this.selfId === gatewayId) return;

      try {
        const gw = new Peer(gatewayId, peerOptions());
        this._gatewayPeer = gw;

        gw.on('open', () => {
          gw.on('connection', (conn) => this._acceptMember(conn));
        });

        gw.on('error', (err) => {
          if (this._gatewayPeer === gw) {
            try { gw.destroy(); } catch (_) {}
            this._gatewayPeer = null;
          }
          if (err && err.type === 'unavailable-id' && !this.left && this.isHub) {
            setTimeout(() => this._bindGatewayPeer(), 1500);
          }
        });
      } catch (err) {
        console.warn('[signal] Failed to bind gateway peer', err);
      }
    }

    // -------------------------------------------------------------- outbound

    /** Send a WebRTC handshake blob to one peer. */
    send(to, data) {
      if (this.isHub) this._sendTo(to, { t: 'signal', from: this.selfId, data });
      else if (this.conn && this.conn.open) this.conn.send({ t: 'signal', to, data });
    }

    /** Tell the room that something about me changed (sharing / mic). */
    setState(patch) {
      const clean = statePatch(patch);
      Object.assign(this.roster.get(this.selfId), clean);
      if (this.isHub) this._fanout({ t: 'state', id: this.selfId, patch: clean });
      else if (this.conn && this.conn.open) this.conn.send({ t: 'state', patch: clean });
    }

    chat(text) {
      const body = String(text || '').slice(0, 500);
      if (!body.trim()) return;
      if (this.isHub) {
        const me = this.self || { name: 'Host' };
        const message = {
          t: 'chat',
          id: this.selfId,
          name: me.name,
          avatar: me.avatar || null,
          text,
          at: Date.now(),
        };
        this._fanout(message);
        this.emit('chat', message);
      } else if (this.conn && this.conn.open) {
        this.conn.send({ t: 'chat', text: body });
      }
    }

    leave() {
      // Handing the seat back rather than letting it time out means the next
      // host can take over immediately instead of waiting out the lease.
      if (this.isHub && this.code && this._leaseHeld) {
        hostLease('release', this.code, this.selfId);
      }
      this.left = true;
      this._stopHeartbeat();
      if (this._brokerDisconnectTimer) {
        clearTimeout(this._brokerDisconnectTimer);
        this._brokerDisconnectTimer = null;
      }
      if (this.isHub) {
        const others = this.others();
        if (others.length === 0) {
          this._fanout({ t: 'closed', reason: 'The room ended.' });
        } else {
          const candidates = others.slice().sort((a, b) => a.id.localeCompare(b.id));
          const nextHost = candidates[0];
          this._fanout({ t: 'migrate-host', newHostId: nextHost.id, oldHostId: this.selfId });
        }
      }
      if (this._gatewayPeer) {
        try { this._gatewayPeer.destroy(); } catch (_) {}
        this._gatewayPeer = null;
      }
      const p = this.peer;
      this.peer = null;
      if (p) {
        setTimeout(() => {
          try { p.destroy(); } catch (_) {}
        }, 150);
      }
    }
  }

  window.Signal = Signal;
})();
