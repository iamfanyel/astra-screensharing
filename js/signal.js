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
  const PEER_FLAGS = ['sharing', 'mic', 'deafened'];

  /** A peer as it looks the moment it joins. */
  function newMember(id, name, host) {
    const member = { id, name: cleanName(name), avatar: null, host: !!host };
    for (const flag of PEER_FLAGS) member[flag] = false;
    return member;
  }

  /**
   * Peers can only tell the room about the fields below; everything else is
   * ignored. Pictures come from someone else's browser, so they are validated,
   * never trusted - see AstraProfile.isAvatar.
   */
  function statePatch(patch) {
    const out = {};
    if (!patch) return out;
    for (const flag of PEER_FLAGS) {
      if (typeof patch[flag] === 'boolean') out[flag] = patch[flag];
    }
    if ('avatar' in patch) {
      out.avatar = window.AstraProfile.isAvatar(patch.avatar) ? patch.avatar : null;
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
          throw err;
        }
      }
      throw lastError || new Error('Could not create a room. Try again.');
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
          this.roster.set(peer.id, {
            id: peer.id,
            name,
            sharing: false,
            mic: false,
            deafened: false,
            avatar: null,
            host: true,
          });
          this._hubListening = true;
          peer.on('connection', (conn) => this._acceptMember(conn));
          peer.on('disconnected', () => !this.left && peer.reconnect());
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
        }

        this.conns.set(member.id, conn);
        this.roster.set(member.id, member);

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

    _dropMember(id) {
      if (!this.conns.has(id) && !this.roster.has(id)) return;
      this.conns.delete(id);
      this.roster.delete(id);
      this._fanout({ t: 'left', id });
      this.emit('peer-left', { id });
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

    static join(code, name) {
      const signal = new Signal();
      const roomCode = String(code || '').trim().toUpperCase();

      return new Promise((resolve, reject) => {
        const peer = new Peer(undefined, peerOptions());
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
          const conn = peer.connect(window.ASTRA.idPrefix + roomCode, {
            metadata: { name: cleanName(name) },
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
          const friendly =
            err && err.type === 'peer-unavailable'
              ? new Error('No room with that code. It may have expired.')
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
        this.roster.set(p.id, p);
      }
      this.roster.set(this.selfId, newMember(this.selfId, name, false));
      peer.on('connection', (c) => this._acceptMember(c));
      peer.on('disconnected', () => !this.left && peer.reconnect());
    }

    _onMemberData(msg) {
      switch (msg.t) {
        case 'joined':
          this.roster.set(msg.peer.id, msg.peer);
          this.emit('peer-joined', { peer: msg.peer });
          break;
        case 'left':
          this.roster.delete(msg.id);
          this.emit('peer-left', { id: msg.id });
          break;
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

    _handleHostLoss() {
      if (this.left) return;

      const oldHostId = this.hostId;
      if (oldHostId && this.roster.has(oldHostId)) {
        this.roster.delete(oldHostId);
        this.emit('peer-left', { id: oldHostId });
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
        this.roster.delete(oldHostId);
        this.emit('peer-left', { id: oldHostId });
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

      for (const [id, peer] of this.roster) {
        peer.host = (id === this.selfId);
      }

      if (this.conn) {
        try { this.conn.close(); } catch (_) {}
        this.conn = null;
      }

      if (this.peer && !this._hubListening) {
        this._hubListening = true;
        this.peer.on('connection', (conn) => this._acceptMember(conn));
      }

      this._bindGatewayPeer();

      const me = this.roster.get(this.selfId);
      this.emit('host-changed', { hostId: this.selfId, hostName: me ? me.name : 'You' });
    }

    _reconnectToNewHost(newHostId) {
      this.isHub = false;
      this.hostId = newHostId;

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
          metadata: {
            name: me ? me.name : 'Guest',
            rejoin: true,
            sharing: me ? me.sharing : false,
            mic: me ? me.mic : false,
            deafened: me ? me.deafened : false,
            avatar: me ? me.avatar : null,
          },
          reliable: true,
        });

        conn.on('open', () => {
          this.conn = conn;
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
          text: body,
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
      if (this.peer) {
        try { this.peer.destroy(); } catch (_) {}
        this.peer = null;
      }
    }
  }

  window.Signal = Signal;
})();
