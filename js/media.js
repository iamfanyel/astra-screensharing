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
    '720': { height: 720, frameRate: 30, bitrate: 1500000, hint: 'detail' },
    '1080': { height: 1080, frameRate: 30, bitrate: 3000000, hint: 'detail' },
    '1080-60': { height: 1080, frameRate: 60, bitrate: 5000000, hint: 'motion' },
    max: { height: null, frameRate: 60, bitrate: 8000000, hint: 'motion' },
  };

  const canShareScreen = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);


  class AudioMixer {
    constructor() {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      this.destination = this.ctx.createMediaStreamDestination();
      this.sources = new Map(); // key -> { node, gain, stream }
    }

    /** The single audio track every peer sends. Silent until something is added. */
    get track() {
      return this.destination.stream.getAudioTracks()[0];
    }

    /** Browsers start the audio graph suspended until a user gesture. */
    resume() {
      if (this.ctx.state === 'suspended') return this.ctx.resume().catch(() => {});
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

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video,
      audio: !!systemAudio,
    });

    const track = stream.getVideoTracks()[0];
    if (track && 'contentHint' in track) track.contentHint = quality.hint;
    for (const audio of stream.getAudioTracks()) {
      if ('contentHint' in audio) audio.contentHint = 'music';
    }
    return { stream, quality };
  }

  /** Fallback for phones and tablets, where getDisplayMedia does not exist. */
  async function captureCamera(qualityKey) {
    const quality = QUALITY[qualityKey] || QUALITY['1080'];
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        height: { ideal: quality.height || 1080 },
        frameRate: { ideal: quality.frameRate },
      },
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
