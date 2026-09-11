'use strict';

/**
 * The room's small noises: somebody arriving, a message, a camera going on.
 *
 * Made here, from oscillators, rather than shipped as files or taken from
 * anywhere else. Eight recordings would be a few hundred kilobytes of assets
 * to host and cache-bust for sounds a fifth of a second long, and the site has
 * no build step to shrink them with. Generating them costs nothing, starts
 * instantly, and is tuned by changing a number rather than opening an editor.
 *
 * What stops that sounding like a microwave is the shaping. A bare oscillator
 * with a volume envelope is a beep; three things turn it into a tone:
 *
 *   Partials. A real struck object rings at several frequencies at once, and
 *   the higher ones die away first. Each voice below is a stack of them with
 *   its own decay, which is most of the difference between "bell" and "beep".
 *
 *   A filter that closes. Brightness fading faster than loudness is what every
 *   physical sound does, and its absence is what makes a synthesised one sit
 *   on top of everything instead of inside it.
 *
 *   A curved attack. Six milliseconds of ramp removes the click without being
 *   slow enough to hear as a fade.
 *
 * They share nothing with the mixer in media.js, deliberately: that one's
 * destination is the outgoing track, so anything connected to it would be
 * played to the whole room rather than to the person it is meant for.
 */
window.AstraSounds = (function () {
  /**
   * Partial stacks, shared between voices so related sounds are related.
   *
   * Each entry is [frequency ratio, loudness, how much of the decay it gets].
   */
  const BELL = [[1, 1, 1], [2.01, 0.30, 0.55], [3.02, 0.11, 0.32]];
  const WOOD = [[1, 1, 1], [1.5, 0.34, 0.6], [2.98, 0.12, 0.28]];
  const SOFT = [[1, 1, 1], [2, 0.18, 0.5]];

  /**
   * Eight sounds in four pairs, each pair one gesture reversed.
   *
   * Up means starting, arriving, turning on; down means the opposite, which
   * needs no learning. The pairs are told apart by character rather than by
   * pitch alone: sharing is the low wooden one, people are the bright bell,
   * the camera slides instead of stepping, and messages are a single note.
   */
  const VOICES = {
    'share-start': { steps: [[392, 0], [587.33, 0.075]], partials: WOOD, decay: 0.36, level: 0.26, open: [2600, 700] },
    'share-stop': { steps: [[587.33, 0], [392, 0.075]], partials: WOOD, decay: 0.36, level: 0.23, open: [2200, 600] },

    joined: { steps: [[659.25, 0], [987.77, 0.07]], partials: BELL, decay: 0.30, level: 0.22, open: [5000, 1400] },
    left: { steps: [[987.77, 0], [659.25, 0.07]], partials: BELL, decay: 0.30, level: 0.19, open: [4200, 1100] },

    // A slide rather than two notes: nothing else here moves, so the camera is
    // recognisable before the pitch has even finished.
    'camera-on': { steps: [[493.88, 0]], glide: 1.5, partials: SOFT, decay: 0.26, level: 0.21, open: [3400, 1000] },
    'camera-off': { steps: [[740, 0]], glide: 0.667, partials: SOFT, decay: 0.26, level: 0.19, open: [3000, 900] },

    message: { steps: [[880, 0]], partials: BELL, decay: 0.26, level: 0.20, open: [5200, 1500] },
    // Yours is a confirmation, not a call: higher, shorter, and much quieter.
    'message-sent': { steps: [[1318.51, 0]], partials: SOFT, decay: 0.13, level: 0.09, open: [5200, 2000] },
  };

  /** Ten people arriving at once should be a sound, not ten of them. */
  const REPEAT_GAP_MS = 140;

  /** Long enough to shape the attack, short enough not to hear as a fade. */
  const ATTACK = 0.006;

  let ctx = null;
  let master = null;
  let enabled = true;
  let muted = false;
  let volume = 1;
  let sinkId = '';
  const lastPlayed = new Map();

  /**
   * Built on first use, not on load.
   *
   * A context made before the page has been interacted with starts suspended
   * and stays that way, and the lobby has no sounds to play anyway.
   */
  function engine() {
    if (ctx) return ctx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      ctx = new Ctx();
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
      applySink();
    } catch (_) {
      ctx = null;
      master = null;
    }
    return ctx;
  }

  /** Follow the room's chosen speaker, where the browser allows it. */
  function applySink() {
    if (!ctx || typeof ctx.setSinkId !== 'function') return;
    try {
      ctx.setSinkId(sinkId || '').catch(() => {});
    } catch (_) {
      // Older engine, or a device that has gone: the default is fine.
    }
  }

  /** One partial of one note. */
  function partial(out, at, frequency, glide, ratio, loudness, decay, level) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequency * ratio, at);
    if (glide && glide !== 1) {
      // Most of the way in the first third, so it reads as a movement rather
      // than a slow bend.
      osc.frequency.exponentialRampToValueAtTime(frequency * ratio * glide, at + decay * 0.34);
    }
    // Exponential ramps cannot touch zero, hence the near-silent endpoints.
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(level * loudness, at + ATTACK);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);
    osc.connect(gain).connect(out);
    osc.start(at);
    osc.stop(at + decay + 0.02);
  }

  /**
   * Play one. Silent rather than throwing, always: a missing sound is never
   * worth breaking the thing that asked for it.
   */
  function play(name) {
    if (!enabled || muted || volume <= 0) return;
    const voice = VOICES[name];
    if (!voice) return;

    const now = Date.now();
    if (now - (lastPlayed.get(name) || 0) < REPEAT_GAP_MS) return;
    lastPlayed.set(name, now);

    const audio = engine();
    if (!audio || !master) return;
    if (audio.state === 'suspended') audio.resume().catch(() => {});

    try {
      const start = audio.currentTime + 0.01;
      const span = voice.decay + (voice.steps[voice.steps.length - 1][1] || 0);

      // One filter for the whole sound, closing as it fades.
      const tone = audio.createBiquadFilter();
      tone.type = 'lowpass';
      tone.Q.value = 0.7;
      tone.frequency.setValueAtTime(voice.open[0], start);
      tone.frequency.exponentialRampToValueAtTime(voice.open[1], start + span);
      tone.connect(master);

      for (const [frequency, offset] of voice.steps) {
        for (const [ratio, loudness, decayScale] of voice.partials) {
          partial(tone, start + offset, frequency, voice.glide, ratio, loudness,
                  voice.decay * decayScale, voice.level);
        }
      }
    } catch (_) {
      // A context that died under us; the next call builds a new one.
      ctx = null;
      master = null;
    }
  }

  /** Whether the user wants these at all. */
  function setEnabled(on) {
    enabled = !!on;
  }

  /** Deafened means deafened; these are part of what is being silenced. */
  function setMuted(on) {
    muted = !!on;
  }

  /** Rides the room's output volume, so one slider governs everything. */
  function setVolume(value) {
    volume = Math.max(0, Math.min(1, Number(value) || 0));
    if (master) master.gain.value = volume;
  }

  function setSinkId(id) {
    sinkId = id || '';
    applySink();
  }

  return { play, setEnabled, setMuted, setVolume, setSinkId, names: Object.keys(VOICES) };
})();
