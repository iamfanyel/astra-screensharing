'use strict';

/**
 * The media mesh: one RTCPeerConnection per pair of peers, carrying whatever
 * that peer is publishing right now.
 *
 * Both ends may need to offer (either can start sharing at any moment), so this
 * uses the "perfect negotiation" pattern: each side takes a polite or impolite
 * role, decided by comparing peer ids, and the polite side rolls back when two
 * offers collide.
 */
(function () {
  /**
   * Handshake blobs cross a data channel, so they have to be plain JSON -
   * native RTCSessionDescription / RTCIceCandidate objects do not survive the
   * trip.
   */
  /** Real video codecs in an m=video section - not the repair/FEC payloads. */
  const VIDEO_CODEC = /^a=rtpmap:(\d+) (VP8|VP9|AV1|H264|H265)\/90000/i;

  /**
   * Tell the far end how fast it may start sending.
   *
   * Left alone, the browser opens its bandwidth estimate at ~300 kbps and
   * climbs from there, which is why a share looks soft for the first minute and
   * then snaps into focus. `x-google-start-bitrate` is read from the
   * description a peer receives, so putting it on everything we send is what
   * configures *their* encoder - and since both ends run this code, both get
   * it. It only moves the starting point; congestion control still corrects
   * within a second or two if the line cannot take it.
   */
  function withStartBitrate(sdp, kbps) {
    if (!kbps) return sdp;
    const eol = sdp.indexOf('\r\n') === -1 ? '\n' : '\r\n';
    const lines = sdp.split(/\r?\n/);

    let inVideo = false;
    const videoPayloads = new Map(); // payload type -> its rtpmap line index
    const hasFmtp = new Set();
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('m=')) inVideo = lines[i].startsWith('m=video');
      if (!inVideo) continue;
      const codec = lines[i].match(VIDEO_CODEC);
      if (codec) videoPayloads.set(codec[1], i);
      const fmtp = lines[i].match(/^a=fmtp:(\d+) /);
      if (fmtp) hasFmtp.add(fmtp[1]);
    }
    if (!videoPayloads.size) return sdp;

    const param = 'x-google-start-bitrate=' + Math.round(kbps);
    const out = [];
    for (const line of lines) {
      const fmtp = line.match(/^a=fmtp:(\d+) /);
      if (fmtp && videoPayloads.has(fmtp[1]) && line.indexOf('x-google-start-bitrate') === -1) {
        out.push(line + ';' + param);
        continue;
      }
      out.push(line);
      // VP8 usually arrives with no fmtp line of its own, so give it one.
      const codec = line.match(VIDEO_CODEC);
      if (codec && !hasFmtp.has(codec[1])) out.push('a=fmtp:' + codec[1] + ' ' + param);
    }
    return out.join(eol);
  }

  function plainDescription(description, startKbps) {
    return { type: description.type, sdp: withStartBitrate(description.sdp, startKbps) };
  }

  function plainCandidate(candidate) {
    if (typeof candidate.toJSON === 'function') return candidate.toJSON();
    return {
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid,
      sdpMLineIndex: candidate.sdpMLineIndex,
      usernameFragment: candidate.usernameFragment,
    };
  }

  /**
   * How long a connection may sit in 'disconnected' before we go looking for a
   * new candidate pair. Long enough that an ordinary blip settles by itself,
   * short enough that a real route change is not a long stall.
   */
  const DISCONNECT_GRACE_MS = 4000;

  class Mesh extends EventTarget {
    constructor({ selfId, signal, iceServers }) {
      super();
      this.selfId = selfId;
      this.signal = signal;
      this.iceServers = iceServers;
      this.peers = new Map(); // id -> peer record
      this.localStream = null;
      this.maxVideoBitrate = 3500000;
      this.maxVideoFramerate = 30;
      this.degradationPreference = 'balanced';
      // What _reapplyEncoding last wrote, so an unchanged pass costs nothing.
      this._applied = null;
      this.closing = false;
    }

    emit(type, detail) {
      this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    add(id) {
      if (this.peers.has(id)) return this.peers.get(id);

      const pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle' });
      const peer = {
        id,
        pc,
        // Ids are unique, so exactly one side of every pair is polite.
        polite: this.selfId < id,
        makingOffer: false,
        ignoreOffer: false,
        settingRemoteAnswer: false,
        /**
         * One { sender, track, kind } per outgoing slot. `track` shadows
         * sender.track deliberately: replaceTrack updates sender.track in a
         * queued task, so within a single _sync the park pass and the fill
         * pass would not see each other's work through the platform's copy.
         * A parked slot holds null, which is how the next share finds a spare.
         */
        slots: [],
        // Tracks already wired for end/mute events, so a renegotiation that
        // re-fires ontrack does not subscribe to the same track twice.
        boundTracks: new WeakSet(),
        recoverTimer: null,
        closed: false,
      };
      this.peers.set(id, peer);
      // One more person to send to, so everyone's share of the uplink shrinks.
      this._reapplyEncoding();

      pc.onnegotiationneeded = async () => {
        try {
          peer.makingOffer = true;
          await pc.setLocalDescription();
          this.signal.send(id, { description: plainDescription(pc.localDescription, this._videoBitrate() / 1000) });
        } catch (err) {
          console.warn('[mesh] negotiation failed', err);
        } finally {
          peer.makingOffer = false;
        }
      };

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) this.signal.send(id, { candidate: plainCandidate(candidate) });
      };

      pc.ontrack = ({ track, streams }) => {
        const stream = streams[0];
        if (!stream) return;
        this.emit('stream', { id, stream, track });
        if (peer.boundTracks.has(track)) return;
        peer.boundTracks.add(track);
        track.addEventListener('ended', () => this.emit('trackended', { id, track }));
        track.addEventListener('mute', () => this.emit('trackmuted', { id, track }));
        track.addEventListener('unmute', () => this.emit('trackunmuted', { id, track }));
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        this.emit('connectionstate', { id, state });
        clearTimeout(peer.recoverTimer);
        if (state === 'failed') {
          pc.restartIce();
        } else if (state === 'disconnected') {
          // Give it a moment to come back by itself - most blips do - and only
          // then go looking for a new path.
          peer.recoverTimer = setTimeout(() => {
            if (!peer.closed && pc.connectionState === 'disconnected') pc.restartIce();
          }, DISCONNECT_GRACE_MS);
        }
      };

      this._sync(peer);
      return peer;
    }

    remove(id) {
      const peer = this.peers.get(id);
      if (!peer) return;
      peer.closed = true;
      clearTimeout(peer.recoverTimer);
      try {
        peer.pc.close();
      } catch (_) {
        /* already closed */
      }
      this.peers.delete(id);
      this._reapplyEncoding();
    }

    close() {
      // No point recomputing everyone's share of the uplink on the way out.
      this.closing = true;
      for (const id of Array.from(this.peers.keys())) this.remove(id);
    }

    /**
     * The video tracks this peer is sending us right now, read from the
     * connection rather than from anything we cached.
     *
     * ontrack fires once per transceiver, and slots are reused rather than torn
     * down, so a cache built from those events can never be rebuilt from them
     * if it is lost. The receivers are the standing truth and always answer.
     */
    videoTracksFor(id) {
      const peer = this.peers.get(id);
      if (!peer) return [];
      return peer.pc
        .getReceivers()
        .map((receiver) => receiver.track)
        .filter((track) => track && track.kind === 'video' && track.readyState === 'live');
    }

    /** Swap what everybody receives from us. Pass null to publish nothing. */
    setLocalStream(stream) {
      this.localStream = stream;
      this.publish();
    }

    /** Re-sync senders after tracks are added to or removed from localStream. */
    publish() {
      for (const peer of this.peers.values()) this._sync(peer);
    }

    setMaxVideoBitrate(bitrate, maxFramerate) {
      this.maxVideoBitrate = bitrate;
      if (maxFramerate) this.maxVideoFramerate = maxFramerate;
      this._reapplyEncoding();
    }

    setDegradationPreference(preference) {
      this.degradationPreference = preference;
      this._reapplyEncoding();
    }

    /**
     * The per-connection cap: the quality that was picked, unless sending that
     * much to everyone would exceed the room-wide upload ceiling.
     *
     * A mesh sends one copy of the same video per peer, so a per-connection cap
     * quietly multiplies by the room size. One-to-one is untouched; only a room
     * big enough to overrun the line gets clamped, and never below the point
     * where a share stops being worth watching.
     */
    _videoBitrate() {
      // Only ever reached with at least one peer: every caller is iterating
      // this.peers or acting on a peer that is already in it.
      return Math.min(this.maxVideoBitrate, Math.round(window.ASTRA.maxUploadBitrate / this.peers.size));
    }

    _reapplyEncoding() {
      if (this.closing) return;
      const encoding = this._encoding();
      if (
        this._applied &&
        this._applied.bitrate === encoding.bitrate &&
        this._applied.framerate === encoding.framerate &&
        this._applied.preference === encoding.preference
      ) {
        return;
      }
      this._applied = encoding;
      for (const peer of this.peers.values()) {
        for (const slot of peer.slots) this._applyEncoding(slot, encoding);
      }
    }

    /** What every video sender should be carrying right now. */
    _encoding() {
      return {
        bitrate: this._videoBitrate(),
        framerate: this.maxVideoFramerate,
        preference: this.degradationPreference,
      };
    }

    /**
     * Reconcile what this connection sends with localStream.
     *
     * Slots are parked with replaceTrack(null) rather than torn down with
     * removeTrack. removeTrack leaves behind a transceiver that the next
     * addTrack will not reuse, so every stop/start of a share added another
     * video m-line - and another track on every receiver that stays
     * `readyState: "live"` while permanently muted. Reusing the slot keeps the
     * connection's shape fixed however many times sharing is toggled, and
     * swapping a track of the same kind needs no renegotiation at all.
     */
    _sync(peer) {
      if (peer.closed) return;
      // Tracks still looking for a slot. The park pass claims the ones already
      // on the wire, so the fill pass only sees what actually changed.
      const missing = new Set(this.localStream ? this.localStream.getTracks() : []);

      for (const slot of peer.slots) {
        if (missing.delete(slot.track)) continue;
        if (slot.track) this._carry(slot, null);
      }

      for (const track of missing) {
        const spare = peer.slots.find((slot) => !slot.track && slot.kind === track.kind);
        if (spare) {
          this._carry(spare, track);
          continue;
        }
        try {
          const sender = peer.pc.addTrack(track, this.localStream);
          const slot = { sender, track, kind: track.kind };
          peer.slots.push(slot);
          this._applyEncoding(slot);
        } catch (err) {
          console.warn('[mesh] could not publish track', err);
        }
      }
    }

    /** Put a track on a slot, or null to park it. */
    _carry(slot, track) {
      slot.track = track;
      slot.sender.replaceTrack(track).catch((err) => {
        // Parking races with teardown often enough not to be worth reporting.
        if (track) console.warn('[mesh] could not swap track', err);
      });
      if (track) this._applyEncoding(slot);
    }

    async _applyEncoding(slot, encoding = this._encoding()) {
      if (slot.kind !== 'video' || !slot.track) return;
      const sender = slot.sender;
      try {
        const params = sender.getParameters();
        params.encodings = params.encodings && params.encodings.length ? params.encodings : [{}];
        params.encodings[0].maxBitrate = encoding.bitrate;
        if (encoding.framerate) {
          params.encodings[0].maxFramerate = encoding.framerate;
        }
        params.degradationPreference = encoding.preference;
        await sender.setParameters(params);
      } catch (_) {
        // Not every browser lets you set this; the default behaviour is fine.
      }
    }

    /** Handle one signalling blob from `from`. */
    async handleSignal(from, data) {
      if (!data) return;
      const peer = this.peers.get(from) || this.add(from);
      const { pc } = peer;

      try {
        if (data.description) {
          const description = data.description;
          const readyForOffer =
            !peer.makingOffer && (pc.signalingState === 'stable' || peer.settingRemoteAnswer);
          const offerCollision = description.type === 'offer' && !readyForOffer;

          peer.ignoreOffer = !peer.polite && offerCollision;
          if (peer.ignoreOffer) return;

          peer.settingRemoteAnswer = description.type === 'answer';
          await pc.setRemoteDescription(description);
          peer.settingRemoteAnswer = false;

          if (description.type === 'offer') {
            await pc.setLocalDescription();
            this.signal.send(from, { description: plainDescription(pc.localDescription, this._videoBitrate() / 1000) });
          }
        } else if (data.candidate) {
          try {
            await pc.addIceCandidate(data.candidate);
          } catch (err) {
            if (!peer.ignoreOffer) throw err;
          }
        }
      } catch (err) {
        console.warn('[mesh] signalling error', err);
      }
    }
  }

  window.Mesh = Mesh;
})();
