'use strict';

/**
 * Capture and audio mixing.
 *
 * Every peer publishes exactly one outgoing MediaStream, and that stream always
 * carries the same audio track: the output of a Web Audio mixer. Microphone and
 * system audio are sources plugged into that mixer, so toggling either one is
 * instant and never forces a WebRTC renegotiation - only starting or stopping
 * the video track does.
 */
(function () {
  const QUALITY = {
    '720': { height: 720, frameRate: 30, bitrate: 2000000 },
    '1080': { height: 1080, frameRate: 30, bitrate: 3500000 },
    '1080-60': { height: 1080, frameRate: 60, bitrate: 5500000 },
    max: { height: null, frameRate: 60, bitrate: 8000000 },
  };

  function canShareScreen() {
    if (navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function') {
      return true;
    }
    if (window.AstraNativeScreen && typeof window.AstraNativeScreen.available === 'function') {
      return window.AstraNativeScreen.available();
    }
    return false;
  }

  class AudioMixer {
    constructor() {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      this.destination = this.ctx.createMediaStreamDestination();
      this.sources = new Map(); // key -> { node, gain, stream }

      // A context can be suspended out from under us: a device change, or the
      // OS handing the endpoint to something else. Nothing surfaces that - the
      // outgoing track simply goes quiet - so pick it back up when it happens.
      // The first-gesture case is already covered by wakeAudio in room.js.
      this.ctx.addEventListener('statechange', () => {
        if (this.ctx.state === 'suspended') this.resume();
      });
    }

    /** The single audio track every peer sends. Silent until something is added. */
    get track() {
      return this.destination.stream.getAudioTracks()[0];
    }

    /** Browsers start the audio graph suspended until a user gesture. */
    resume() {
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return Promise.resolve();
    }

    add(key, stream) {
      if (!stream || stream.getAudioTracks().length === 0) return false;
      this.remove(key);
      const node = this.ctx.createMediaStreamSource(stream);
      const gain = this.ctx.createGain();
      node.connect(gain).connect(this.destination);
      this.sources.set(key, { node, gain, stream });
      return true;
    }

    /**
     * Scale one source, 1 being untouched. The microphone rides its own gain
     * node already, so input volume is a value change rather than a re-route.
     */
    setSourceGain(key, value) {
      const source = this.sources.get(key);
      if (source) source.gain.gain.value = value;
    }

    /**
     * Play a remote <audio> through the graph so it can be amplified past
     * what the element alone allows - its own `volume` stops at 1.
     *
     * Routing is one-way and permanent per element, and it makes that audio
     * depend on a healthy context, so it only happens once someone actually
     * asks for more than 100%. Below that the element plays natively, exactly
     * as it did before.
     */
    amplify(el) {
      if (el.__astraAmplified) return true;
      if (!this.outputGain) {
        this.outputGain = this.ctx.createGain();
        this.outputGain.connect(this.ctx.destination);
      }
      try {
        this.ctx.createMediaElementSource(el).connect(this.outputGain);
        el.__astraAmplified = true;
        return true;
      } catch (_) {
        // Already bound to another graph, or the browser refused.
        return false;
      }
    }

    /** Extra gain on everything routed through amplify(). */
    setOutputGain(value) {
      if (this.outputGain) this.outputGain.gain.value = value;
    }

    /** Detach a source. Tracks are stopped by whoever owns the stream. */
    remove(key) {
      const source = this.sources.get(key);
      if (!source) return;
      try {
        source.node.disconnect();
        source.gain.disconnect();
      } catch (_) {
        /* already torn down */
      }
      this.sources.delete(key);
    }

    close() {
      for (const key of Array.from(this.sources.keys())) this.remove(key);
      this.ctx.close().catch(() => {});
    }
  }

  /**
   * Ask for a screen, window or tab. `systemAudio` requests the audio playing on
   * the shared surface - Chrome and Edge offer it as a "Share audio" tick box,
   * Firefox and Safari mostly do not, so treat it as best effort.
   */
  async function captureScreen(qualityKey, systemAudio) {
    const quality = QUALITY[qualityKey] || QUALITY['1080'];

    // Inside the Android app the screen comes from the app itself: no mobile
    // browser implements getDisplayMedia, so there is nothing here to ask.
    // It carries no audio - Android has no system-audio capture to offer a
    // single app - so the room simply shares picture there.
    const native = window.AstraNativeScreen;
    if (native && native.available()) {
      return { stream: hintAudio(await native.capture()), quality };
    }

    const video = { frameRate: { ideal: quality.frameRate } };
    if (quality.height) video.height = { ideal: quality.height };

    const request = { video, audio: false };
    if (systemAudio) {
      request.audio = {
        // Screen audio is not a voice signal. Left on, the microphone
        // processing chain gates and ducks music, and on a loopback feed the
        // echo canceller sees a copy of what is playing out and removes it.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        // Keep the audio audible on this machine while it is being shared.
        suppressLocalAudioPlayback: false,
        // Leave out whatever this tab is playing - otherwise the voices of the
        // other people in the room are captured and sent straight back to them.
        restrictOwnAudio: true,
      };
      // Ask for system audio by name rather than leaving the choice to the
      // browser's default.
      request.systemAudio = 'include';
      // The one that decides *which* audio arrives. Without it the browser
      // picks a per-surface feed, which on Windows is a loopback of the default
      // playback device alone - so an app routed to any other output (a
      // separate Sonar / Voicemeeter channel, say) is silent in the share.
      // 'system' asks for the whole machine's audio instead.
      request.windowAudio = 'system';
    }

    const stream = await navigator.mediaDevices.getDisplayMedia(request);

    // The video track's contentHint belongs to the caller, which sets it from
    // the fluidity toggle and keeps changing it while sharing.
    return { stream: hintAudio(stream), quality };
  }

  /**
   * Shared audio is music, not speech, wherever it came from - the browser's
   * loopback or the phone's. Saying so keeps the encoder from treating it the
   * way it treats a voice.
   */
  function hintAudio(stream) {
    for (const audio of stream.getAudioTracks()) {
      if ('contentHint' in audio) audio.contentHint = 'music';
    }
    return stream;
  }

  /** Capture camera video (front/user facing by default, or specific deviceId). */
  async function captureCamera(qualityKey, facingMode = 'user', deviceId = null) {
    const quality = QUALITY[qualityKey] || QUALITY['720'];
    const video = {
      frameRate: { ideal: quality.frameRate || 30 },
    };
    if (deviceId) {
      video.deviceId = { ideal: deviceId };
    } else if (facingMode) {
      video.facingMode = { ideal: facingMode };
    }
    if (quality.height) video.height = { ideal: quality.height };
    const stream = await navigator.mediaDevices.getUserMedia({
      video,
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    if (track && 'contentHint' in track) track.contentHint = 'motion';
    return { stream, quality };
  }

  function captureMicrophone(deviceId) {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    // `ideal`, not `exact`: a remembered microphone that has since been
    // unplugged should fall back to the default rather than throw.
    if (deviceId) audio.deviceId = { ideal: deviceId };
    return navigator.mediaDevices.getUserMedia({ audio, video: false });
  }

  function stopStream(stream) {
    if (!stream) return;
    for (const track of stream.getTracks()) track.stop();
  }

  window.AstraMedia = {
    QUALITY,
    AudioMixer,
    captureScreen,
    captureCamera,
    captureMicrophone,
    stopStream,
  };
  Object.defineProperty(window.AstraMedia, 'canShareScreen', {
    get: canShareScreen,
    configurable: true,
    enumerable: true,
  });
})();
