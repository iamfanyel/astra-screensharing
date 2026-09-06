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
    const member = { id, name: cleanName(name), avatar: null, banner: null, discord: null, host: !!host, screenTrackId: null, cameraTrackId: null };
    for (const flag of PEER_FLAGS) member[flag] = false;
    member.dev = !!dev;
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
          settled = true;
          this.peer = peer;
          this.isHub = true;
          this.code = code;
          this.selfId = peer.id;
          this.hostId = peer.id;
          const selfDev = !!(window.AstraDiscord && window.AstraDiscord.isDev());
          const selfDiscord = window.AstraDiscord ? window.AstraDiscord.accountLabel() || null : null;
          this.roster.set(peer.id, {
            id: peer.id,
            name,
            sharing: false,
            camera: false,
            mic: false,
            deafened: false,
            dev: selfDev,
            discord: selfDiscord,
            avatar: window.AstraProfile ? window.AstraProfile.getAvatar() : null,
            banner: window.AstraProfile ? window.AstraProfile.getBanner() : null,
            host: true,
          });
          this._hubListening = true;
          this._startHeartbeat();
          peer.on('connection', (conn) => this._acceptMember(conn));
          peer.on('disconnected', () => {
            if (this.left) return;
            peer.reconnect();
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

        peer.on('open', () => {
          peer.on('disconnected', () => {
            if (signal.left) return;
            peer.reconnect();
            if (!signal._brokerDisconnectTimer) {
              signal._brokerDisconnectTimer = setTimeout(() => {
                if (peer.disconnected && !signal.left) {
                  signal.emit('closed', { reason: 'Disconnected: connection to the signalling server was lost.' });
                }
              }, BROKER_RECONNECT_TIMEOUT_MS);
            }
          });

          // Connect metadata is relayed by the broker inside a single
          // signalling message, so it has to stay small. Pictures go over the
          // data channel once the connection is open - see setState below and
          // the push in room.js right after joining.
          const conn = peer.connect(window.ASTRA.idPrefix + roomCode, {
            metadata: {
              name: cleanName(name),
              dev: !!(window.AstraDiscord && window.AstraDiscord.isDev()),
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
          if (settled) return signal.emit('error', err);
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
        this.roster.set(p.id, p);
      }
      const selfDev = !!(window.AstraDiscord && window.AstraDiscord.isDev());
      this.roster.set(this.selfId, newMember(this.selfId, name, false, selfDev));
      this._hostLastSeen = Date.now();
      this._startHeartbeat();
      peer.on('connection', (c) => this._acceptMember(c));
      peer.on('disconnected', () => {
        if (this.left) return;
        peer.reconnect();
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

      const remaining = Array.from(this.roster.values());
      if (remaining.length === 0) {
        this.emit('closed', { reason: 'All participants have left the room.' });
        return;
      }

      // Deterministically elect the next host
      const candidates = remaining.slice().sort((a, b) => a.id.localeCompare(b.id));
      const elected = candidates[0];
      this._handleHostMigration(elected.id, oldHostId);
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

      const me = this.roster.get(this.selfId);
      this.emit('host-changed', { hostId: this.selfId, hostName: me ? me.name : 'You' });
    }

    _reconnectToNewHost(newHostId) {
      this.isHub = false;
      this.hostId = newHostId;
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
            discord: me ? me.discord : null,
          },
          reliable: true,
        });

        conn.on('open', () => {
          this.conn = conn;
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
