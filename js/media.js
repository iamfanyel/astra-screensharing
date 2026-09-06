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

  const canShareScreen = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

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
    for (const audio of stream.getAudioTracks()) {
      if ('contentHint' in audio) audio.contentHint = 'music';
    }
    return { stream, quality };
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

  function captureMicrophone() {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
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
    canShareScreen,
  };
})();
