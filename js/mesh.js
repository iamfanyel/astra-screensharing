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

  /**
   * The DTLS certificate fingerprint a description was made with, or null.
   *
   * Every RTCPeerConnection makes its own certificate, so a different one in an
   * offer means the far end threw its connection away and started a new one.
   */
  function fingerprintOf(sdp) {
    const match = /^a=fingerprint:(.+)$/m.exec(sdp || '');
    return match ? match[1].trim() : null;
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

  /**
   * The lowest resolution the fluidity option will adapt down to on a bad
   * connection. Never less than 720p (720px on the short edge).
   */
  const MIN_FLUIDITY_HEIGHT = 720;
  const FLUIDITY_720P_BITRATE_30 = 2000000;
  const FLUIDITY_720P_BITRATE_60 = 3000000;

  /** How often the screen sender's connection health is evaluated. */
  const ADAPTATION_INTERVAL_MS = 2000;

  function getTrackShortEdge(track) {
    const s = track && typeof track.getSettings === 'function' ? track.getSettings() : null;
    if (s && s.height && s.width) return Math.min(s.height, s.width);
    return (s && s.height) || 0;
  }

  /**
   * What to ask for instead when the engine does not know a preference.
   * 'maintain-framerate-and-resolution' - adapt the bitrate only, the way
   * Discord does - is recent; without it, holding the resolution is what
   * matters most, so that is what is kept.
   */
  const FALLBACK_PREFERENCE = { 'maintain-framerate-and-resolution': 'maintain-resolution' };

  /**
   * Preferences this engine has refused. It is the same engine for every
   * connection and every room on the page, so it is learned once, here.
   */
  const refusedPreferences = new Set();

  /** The preference to ask for, given what this engine has refused before. */
  function usablePreference(preference) {
    return refusedPreferences.has(preference) ? FALLBACK_PREFERENCE[preference] : preference;
  }

  /**
   * Which video codecs to offer, best first.
   *
   * With the resolution held, a tight link has to be met by the codec alone,
   * and they are far from equal at it. Measured on a
   * busy 1080p share squeezed to 800 kbps: VP8 - the browser's default -
   * dropped to about 12 fps, VP9 to 23, while H.264 and AV1 both held 30.
   * H.264 goes first because it is encoded in hardware almost everywhere,
   * phones included, so holding the frame rate costs no CPU; AV1 next, which
   * looks better per bit but is encoded in software on most machines. Anything
   * a peer cannot handle is simply skipped in negotiation.
   */
  const VIDEO_CODEC_ORDER = ['video/H264', 'video/AV1', 'video/VP9', 'video/VP8'];

  /**
   * This engine's video codecs in VIDEO_CODEC_ORDER, or null where it cannot
   * say. The capabilities never change on a page, so it is worked out once.
   */
  let orderedCodecs;
  function preferredCodecs() {
    if (orderedCodecs !== undefined) return orderedCodecs;
    const caps = window.RTCRtpReceiver && RTCRtpReceiver.getCapabilities
      ? RTCRtpReceiver.getCapabilities('video')
      : null;
    if (!caps || !caps.codecs) return (orderedCodecs = null);
    const rank = (codec) => {
      const i = VIDEO_CODEC_ORDER.indexOf(codec.mimeType);
      // Repair and FEC formats keep their place behind the real codecs.
      return i === -1 ? VIDEO_CODEC_ORDER.length : i;
    };
    // Stable: codecs of one kind (the H.264 profiles, say) keep their order.
    orderedCodecs = caps.codecs
      .map((codec, index) => ({ codec, index }))
      .sort((a, b) => rank(a.codec) - rank(b.codec) || a.index - b.index)
      .map((entry) => entry.codec);
    return orderedCodecs;
  }

  /** Put our preferred codecs first on a sending transceiver, where supported. */
  function preferCodecs(transceiver) {
    const codecs = preferredCodecs();
    if (!codecs || !transceiver || typeof transceiver.setCodecPreferences !== 'function') return;
    try {
      transceiver.setCodecPreferences(codecs);
    } catch (_) {
      // Left at the browser's own order.
    }
  }

  /** Two sets of peer ids - or two nothings - holding the same people. */
  function sameIds(a, b) {
    if (a === b) return true;
    if (!a || !b || a.size !== b.size) return false;
    for (const id of a) if (!b.has(id)) return false;
    return true;
  }

  /** What a slot can be announced as carrying. Anything else is ignored. */
  const ROLES = ['screen', 'camera', 'screen-audio', 'voice'];

  class Mesh extends EventTarget {
    constructor({ selfId, signal, iceServers, roleOf, fluidity = true }) {
      super();
      this.selfId = selfId;
      // What a local track is for - 'screen', 'camera', 'screen-audio',
      // 'voice' - or null. Announced per connection; see _announceRoles.
      this.roleOf = typeof roleOf === 'function' ? roleOf : () => null;
      this.signal = signal;
      this.iceServers = iceServers;
      this.peers = new Map(); // id -> peer record
      this.localStream = null;
      this.maxVideoBitrate = 3500000;
      this.maxVideoFramerate = 30;
      this.degradationPreference = 'maintain-framerate-and-resolution';
      this.fluidity = Boolean(fluidity);
      this._adaptationTimer = null;
      this._adapting = false;
      // Who wants the screen share right now - see setScreenViewers. null
      // until the room says, which means everybody.
      this.screenViewers = null;
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
        // What each of our slots carries, as last told to this peer.
        sentRoles: null,
        // What each of theirs carries, keyed by transceiver mid; null until a
        // peer running this build says.
        remoteRoles: null,
        // Named a mid we had no transceiver for yet, so the next completed
        // negotiation is worth telling the room about.
        rolesPending: false,
      };
      this.peers.set(id, peer);
      // One more person to send to, so everyone's share of the uplink shrinks.
      this._reapplyEncoding();

      pc.onnegotiationneeded = async () => {
        try {
          peer.makingOffer = true;
          await pc.setLocalDescription();
          this.signal.send(id, { description: plainDescription(pc.localDescription, this._videoBitrate() / 1000) });
          // New slots have mids now.
          this._announceRoles(peer);
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
      this._checkAdaptationState();
    }

    close() {
      // No point recomputing everyone's share of the uplink on the way out.
      this.closing = true;
      this._stopAdaptation();
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

    /**
     * What this peer is sending, by role - `{ screen, camera, voice,
     * 'screen-audio' }`, each a live track or null - in one pass.
     *
     * Null when the peer has never said (an older build), so the caller can
     * fall back to guessing from the tracks themselves.
     */
    tracksByRole(id) {
      const peer = this.peers.get(id);
      if (!peer || !peer.remoteRoles) return null;
      const out = { screen: null, camera: null, voice: null, 'screen-audio': null };
      for (const transceiver of peer.pc.getTransceivers()) {
        const role = transceiver.mid && peer.remoteRoles[transceiver.mid];
        const track = role && transceiver.receiver.track;
        if (track && track.readyState === 'live') out[role] = track;
      }
      return out;
    }

    /** Throw this connection away and negotiate a new one. */
    restart(id) {
      if (!this.peers.has(id)) return;
      this.remove(id);
      this.add(id);
      this.emit('reset', { id });
    }

    /**
     * Frames received so far on the receiver carrying `track`, or null.
     *
     * The honest test of whether a share is still running: a parked sender
     * leaves the far track looking live and unmuted in Chrome, but this count
     * stops moving the moment frames do.
     */
    async framesReceived(id, track) {
      const peer = this.peers.get(id);
      if (!peer || !track) return null;
      const receiver = peer.pc.getReceivers().find((r) => r.track === track);
      if (!receiver) return null;
      try {
        for (const report of (await receiver.getStats()).values()) {
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            return typeof report.framesReceived === 'number' ? report.framesReceived : null;
          }
        }
      } catch (_) {
        /* closed mid-read */
      }
      return null;
    }

    /** Swap what everybody receives from us. Pass null to publish nothing. */
    setLocalStream(stream) {
      this.localStream = stream;
      this.publish();
    }

    /** Re-sync senders after tracks are added to or removed from localStream. */
    publish() {
      for (const peer of this.peers.values()) this._sync(peer);
      this._checkAdaptationState();
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
     * When fluidity is enabled, the stream prioritizes frame rate and smoothness.
     * On a bad connection, it automatically scales down resolution to 720p (never below)
     * to relieve bandwidth/CPU pressure without over-compressing or dropping FPS.
     */
    setFluidity(fluidity) {
      const on = Boolean(fluidity);
      if (this.fluidity === on) return;
      this.fluidity = on;
      if (!on) {
        this._resetResolutionAdaptation();
        this._stopAdaptation();
      } else {
        this._checkAdaptationState();
      }
    }

    _hasActiveScreenTrack() {
      if (!this.localStream) return false;
      return this.localStream.getVideoTracks().some((t) => this.roleOf(t) === 'screen');
    }

    _checkAdaptationState() {
      if (this.closing || !this.fluidity || !this._hasActiveScreenTrack()) {
        if (!this._hasActiveScreenTrack()) this._resetResolutionAdaptation();
        this._stopAdaptation();
      } else {
        this._startAdaptation();
      }
    }

    _startAdaptation() {
      if (this._adaptationTimer || this.closing) return;
      this._adaptationTimer = setInterval(() => {
        this._runAdaptationPass();
      }, ADAPTATION_INTERVAL_MS);
    }

    _stopAdaptation() {
      if (this._adaptationTimer) {
        clearInterval(this._adaptationTimer);
        this._adaptationTimer = null;
      }
    }

    _resetResolutionAdaptation() {
      for (const peer of this.peers.values()) {
        for (const slot of peer.slots) {
          if (slot.downscaled) {
            slot.downscaled = false;
            slot.scaleFactor = 1.0;
            slot.badStreak = 0;
            slot.goodStreak = 0;
            this._applyEncoding(slot);
          }
        }
      }
    }

    async _evaluateSenderConnection(sender) {
      if (!sender || typeof sender.getStats !== 'function') {
        return { bad: false, good: true };
      }
      try {
        const stats = await sender.getStats();
        let bad = false;
        let good = true;
        let foundOutbound = false;

        for (const report of stats.values()) {
          if (report.type === 'outbound-rtp' && report.kind === 'video') {
            foundOutbound = true;
            // WebRTC congestion/overuse flags
            if (report.qualityLimitationReason === 'bandwidth' || report.qualityLimitationReason === 'cpu') {
              bad = true;
              good = false;
            } else if (report.qualityLimitationReason && report.qualityLimitationReason !== 'none') {
              good = false;
            }

            // Struggling to maintain target frame rate
            if (typeof report.framesPerSecond === 'number' && this.maxVideoFramerate) {
              if (report.framesPerSecond > 0 && report.framesPerSecond < this.maxVideoFramerate * 0.65) {
                bad = true;
                good = false;
              } else if (report.framesPerSecond < this.maxVideoFramerate * 0.85) {
                good = false;
              }
            }
          }

          if (report.type === 'remote-inbound-rtp' && report.kind === 'video') {
            // Receiver packet loss
            if (typeof report.fractionLost === 'number') {
              if (report.fractionLost > 0.05) {
                bad = true;
                good = false;
              } else if (report.fractionLost > 0.02) {
                good = false;
              }
            }
            // High latency spike
            if (typeof report.roundTripTime === 'number') {
              if (report.roundTripTime > 0.4) {
                bad = true;
                good = false;
              } else if (report.roundTripTime > 0.25) {
                good = false;
              }
            }
          }

          if (report.type === 'candidate-pair' && (report.state === 'succeeded' || report.nominated)) {
            const targetBitrate = this._videoBitrate();
            if (typeof report.availableOutgoingBitrate === 'number' && targetBitrate) {
              if (report.availableOutgoingBitrate < targetBitrate * 0.6) {
                bad = true;
                good = false;
              } else if (report.availableOutgoingBitrate < targetBitrate * 0.85) {
                good = false;
              }
            }
          }
        }

        return { bad: foundOutbound && bad, good: foundOutbound && good };
      } catch (_) {
        return { bad: false, good: false };
      }
    }

    async _runAdaptationPass() {
      if (this.closing || this._adapting || !this.fluidity) return;
      this._adapting = true;
      try {
        const screenSlots = [];
        for (const peer of this.peers.values()) {
          if (peer.closed) continue;
          for (const slot of peer.slots) {
            if (slot.kind === 'video' && slot.track && this.roleOf(slot.track) === 'screen' && this._sendsScreenTo(slot.peerId)) {
              screenSlots.push(slot);
            }
          }
        }
        if (!screenSlots.length) return;

        await Promise.all(screenSlots.map(async (slot) => {
          const shortEdge = getTrackShortEdge(slot.track);
          // Fluidity adaptation should only reduce down to 720p, not less than that.
          // If the track is already <= 720p, it never drops lower.
          if (shortEdge <= MIN_FLUIDITY_HEIGHT) {
            if (slot.downscaled) {
              slot.downscaled = false;
              slot.scaleFactor = 1.0;
              slot.badStreak = 0;
              slot.goodStreak = 0;
              this._applyEncoding(slot);
            }
            return;
          }

          const targetScale = Math.round((shortEdge / MIN_FLUIDITY_HEIGHT) * 100) / 100;
          const health = await this._evaluateSenderConnection(slot.sender);

          if (health.bad) {
            slot.badStreak = (slot.badStreak || 0) + 1;
            slot.goodStreak = 0;
          } else if (health.good) {
            slot.goodStreak = (slot.goodStreak || 0) + 1;
            slot.badStreak = 0;
          } else {
            slot.badStreak = 0;
            slot.goodStreak = 0;
          }

          // Downscale to 720p after 2 consecutive bad intervals (~4s)
          if (!slot.downscaled && slot.badStreak >= 2) {
            slot.downscaled = true;
            slot.scaleFactor = targetScale;
            slot.badStreak = 0;
            slot.goodStreak = 0;
            this._applyEncoding(slot);
            this.emit('screen-adapted', { peerId: slot.peerId, downscaled: true, resolution: '720p' });
          }
          // Recover to full resolution after 4 consecutive good intervals (~8s)
          else if (slot.downscaled && slot.goodStreak >= 4) {
            slot.downscaled = false;
            slot.scaleFactor = 1.0;
            slot.badStreak = 0;
            slot.goodStreak = 0;
            this._applyEncoding(slot);
            this.emit('screen-adapted', { peerId: slot.peerId, downscaled: false });
          }
        }));
      } catch (_) {
      } finally {
        this._adapting = false;
      }
    }

    /**
     * Who is watching our screen share, by id - null for everybody.
     *
     * A mesh encodes and uploads its own copy of the share for every peer, so
     * somebody who is not watching costs exactly as much as somebody who is.
     * Their copy is switched off at the encoder instead: no frames, no upload,
     * and nothing to renegotiate either way.
     *
     * It comes back the moment they ask for it, and it comes back new. An
     * encoder that has spent a bad minute grinding the picture down stays
     * ground down long after the line recovers, because nothing tells it to
     * try again; switching the copy off and on builds it afresh, at the
     * quality that was picked. Stop watching and watch again is that reset,
     * and it is why one does not have to reload the room to get the picture
     * back.
     */
    setScreenViewers(ids) {
      const next = ids ? new Set(ids) : null;
      // Said afresh on every roster change, and usually the same answer.
      if (sameIds(this.screenViewers, next)) return;
      this.screenViewers = next;
      // Every sender is rewritten, not only the ones that changed hands: one
      // viewer fewer also leaves the rest a larger share of the uplink.
      this._applied = null;
      this._reapplyEncoding();
    }

    /** Whether this peer's copy of the share is worth encoding. */
    _sendsScreenTo(id) {
      return !this.screenViewers || this.screenViewers.has(id);
    }

    /**
     * The per-connection cap: the quality that was picked, unless sending that
     * much to everyone would exceed the room-wide upload ceiling.
     *
     * A mesh sends one copy of the same video per peer, so a per-connection cap
     * quietly multiplies by the room size. One-to-one is untouched; only a room
     * big enough to overrun the line gets clamped, and never below the point
     * where a share stops being worth watching.
     *
     * Only the copies actually being encoded count against it: somebody who is
     * not watching sends nothing (see setScreenViewers), so they should not be
     * taking a share of the line away from the people who are.
     */
    _videoBitrate() {
      let watching = 0;
      for (const id of this.peers.keys()) if (this._sendsScreenTo(id)) watching += 1;
      // Nobody watching would divide by nothing, and the answer would not be
      // used by anyone either - there is no copy being encoded to cap.
      const share = window.ASTRA.maxUploadBitrate / Math.max(1, watching);
      return Math.min(this.maxVideoBitrate, Math.round(share));
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
          if (track.kind === 'video') {
            preferCodecs(peer.pc.getTransceivers().find((t) => t.sender === sender));
          }
          const slot = {
            sender,
            track,
            kind: track.kind,
            peerId: peer.id,
            downscaled: false,
            scaleFactor: 1.0,
            badStreak: 0,
            goodStreak: 0,
          };
          peer.slots.push(slot);
          this._applyEncoding(slot);
        } catch (err) {
          console.warn('[mesh] could not publish track', err);
        }
      }
      this._announceRoles(peer);
      this._checkAdaptationState();
    }

    /**
     * Tell this peer which of our slots carries what.
     *
     * Track ids cannot do it: a reused slot keeps the id of the first track it
     * ever carried. And a parked slot cannot be told apart by looking - Chrome
     * leaves it live and unmuted at the far end - so a receiver guessing could
     * attach a share to a slot that will never send a frame, and spin forever.
     * The transceiver's mid is the same at both ends of one connection, so
     * mid -> role is exact. Sent only when it changes.
     */
    _announceRoles(peer) {
      if (peer.closed) return;
      const bySender = new Map(peer.slots.map((slot) => [slot.sender, slot]));
      const roles = {};
      for (const transceiver of peer.pc.getTransceivers()) {
        const slot = transceiver.mid && bySender.get(transceiver.sender);
        const role = slot && slot.track ? this.roleOf(slot.track) : null;
        if (role) roles[transceiver.mid] = role;
      }
      const text = JSON.stringify(roles);
      if (text === peer.sentRoles) return;
      peer.sentRoles = text;
      this.signal.send(peer.id, { roles });
    }

    /** Put a track on a slot, or null to park it. */
    _carry(slot, track) {
      if (slot.track !== track) {
        slot.downscaled = false;
        slot.scaleFactor = 1.0;
        slot.badStreak = 0;
        slot.goodStreak = 0;
      }
      slot.track = track;
      slot.sender.replaceTrack(track).catch((err) => {
        // Parking races with teardown often enough not to be worth reporting.
        if (track) console.warn('[mesh] could not swap track', err);
      });
      if (track) this._applyEncoding(slot);
      this._checkAdaptationState();
    }

    async _applyEncoding(slot, encoding = this._encoding()) {
      if (slot.kind !== 'video' || !slot.track) return;
      const sender = slot.sender;
      // Only the share is switched off for people not watching it; a camera
      // is small and is either on or not sent at all.
      const isScreen = this.roleOf(slot.track) === 'screen';
      const active = !isScreen || this._sendsScreenTo(slot.peerId);
      const isDownscaled = isScreen && this.fluidity && slot.downscaled && slot.scaleFactor > 1;

      // When downscaled to 720p on a weak connection, cap the max bitrate to 720p's
      // optimal rate (3 Mbps for 60fps, 2 Mbps for 30fps) so the link is not choked,
      // maintaining the framerate without over-compressing.
      let effectiveBitrate = encoding.bitrate;
      if (isDownscaled) {
        const cap720 = (encoding.framerate && encoding.framerate >= 50) ? FLUIDITY_720P_BITRATE_60 : FLUIDITY_720P_BITRATE_30;
        effectiveBitrate = Math.min(encoding.bitrate, cap720);
      }

      const apply = (preference) => {
        const params = sender.getParameters();
        params.encodings = params.encodings && params.encodings.length ? params.encodings : [{}];
        params.encodings[0].active = active;
        params.encodings[0].maxBitrate = effectiveBitrate;
        if (encoding.framerate) {
          params.encodings[0].maxFramerate = encoding.framerate;
        }
        if (isDownscaled) {
          params.encodings[0].scaleResolutionDownBy = slot.scaleFactor;
        } else if ('scaleResolutionDownBy' in params.encodings[0]) {
          params.encodings[0].scaleResolutionDownBy = 1.0;
        }
        params.degradationPreference = preference;
        return sender.setParameters(params);
      };
      const preference = usablePreference(encoding.preference);
      try {
        await apply(preference);
      } catch (err) {
        // An engine that does not know the preference rejects the whole set,
        // bitrate included - so learn that once and settle for its nearest.
        // Anything else: not every browser lets you set this, and its
        // defaults are fine.
        const fallback = FALLBACK_PREFERENCE[preference];
        if (!fallback || !err || err.name !== 'TypeError') return;
        refusedPreferences.add(preference);
        try {
          await apply(fallback);
        } catch (_) {
          // Its defaults, then.
        }
      }
    }

    /** Handle one signalling blob from `from`. */
    async handleSignal(from, data) {
      if (!data) return;
      let peer = this.peers.get(from) || this.add(from);

      if (data.roles && typeof data.roles === 'object') {
        // From another browser: keep only string mids naming a known role.
        const roles = {};
        for (const [mid, role] of Object.entries(data.roles)) {
          if (ROLES.includes(role)) roles[mid] = role;
        }
        peer.remoteRoles = roles;
        const mids = new Set(peer.pc.getTransceivers().map((t) => t.mid));
        peer.rolesPending = Object.keys(roles).some((mid) => !mids.has(mid));
        this.emit('roles', { id: from });
        return;
      }

      // The far end rebuilt its connection to us - it saw us leave and come
      // back, or reloaded - while ours is still the old one. The old one can
      // never accept that offer (a new certificate needs a new transport), and
      // media between us would stay dead until somebody refreshed. Start
      // fresh to match; the new connection answers this offer.
      if (data.description && data.description.type === 'offer' && peer.pc.remoteDescription) {
        const incoming = fingerprintOf(data.description.sdp);
        const known = fingerprintOf(peer.pc.remoteDescription.sdp);
        if (incoming && known && incoming !== known) {
          this.remove(from);
          peer = this.add(from);
          this.emit('reset', { id: from });
        }
      }
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
          // Mids settle once a round completes, on whichever side offered.
          this._announceRoles(peer);
          // So do the encodings: a sender set up before its first negotiation
          // has none yet, the settings it was given were refused, and the
          // engine would otherwise run on its defaults - which shrink the
          // picture - until something else happened to re-apply them.
          if (pc.signalingState === 'stable') {
            const encoding = this._encoding();
            for (const slot of peer.slots) this._applyEncoding(slot, encoding);
          }
          // A role that named a slot we did not have yet can resolve now.
          if (peer.rolesPending) {
            peer.rolesPending = false;
            this.emit('roles', { id: from });
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
