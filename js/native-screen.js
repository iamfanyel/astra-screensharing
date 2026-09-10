'use strict';

/**
 * Screen capture on Android, where the browser has none.
 *
 * No mobile browser or WebView implements getDisplayMedia, so inside the
 * Android app the page cannot ask for the screen at all. The app captures it
 * natively instead and offers it here over a WebRTC connection that never
 * leaves the handset - which is the one way a WebView will accept a video
 * source it did not create itself.
 *
 * What comes back is an ordinary MediaStream. Everything downstream - the
 * mesh, the bitrate caps, the tiles - cannot tell the difference, which is the
 * whole point of doing it this way.
 *
 * In a browser none of this loads: there is no Capacitor bridge to talk to,
 * `available()` is false, and media.js falls back to getDisplayMedia.
 */
(function () {
  /** The native half, or null anywhere that is not the Android app. */
  function plugin() {
    const capacitor = window.Capacitor;
    if (!capacitor) return null;
    if (typeof capacitor.isNativePlatform === 'function' && !capacitor.isNativePlatform()) return null;
    if (capacitor.Plugins && capacitor.Plugins.AstraScreen) return capacitor.Plugins.AstraScreen;
    if (typeof capacitor.registerPlugin === 'function') {
      try {
        const p = capacitor.registerPlugin('AstraScreen');
        if (p) return p;
      } catch (_) {}
    }
    return (capacitor.Plugins && capacitor.Plugins.AstraScreen) || null;
  }

  function available() {
    const capacitor = window.Capacitor;
    if (!capacitor) return false;
    if (typeof capacitor.isNativePlatform === 'function') {
      if (!capacitor.isNativePlatform()) return false;
      if (typeof capacitor.isPluginAvailable === 'function') {
        return capacitor.isPluginAvailable('AstraScreen') || plugin() !== null;
      }
      return true;
    }
    return plugin() !== null;
  }

  /**
   * Ask the app for the screen.
   *
   * Rejects with a NotAllowedError when the system's consent dialog is
   * dismissed, so the room reads a refusal here the same way it reads a
   * cancelled picker in a browser.
   *
   * Resolves with the stream and what the app could tell us about its sound.
   */
  async function capture() {
    const native = plugin();
    if (!native) throw new Error('Native screen capture is not available here.');

    const connection = new RTCPeerConnection();
    const listeners = [];
    const cleanUp = () => {
      for (const handle of listeners) {
        if (handle && typeof handle.remove === 'function') handle.remove();
      }
      listeners.length = 0;
    };

    try {
      // The tracks arrive once both sides have described themselves; wait for
      // them rather than for the connection state, which says nothing about
      // whether there is anything to show.
      //
      // Sound is not promised. Android only learned to capture what other apps
      // are playing in version 10, an app can refuse to be captured, and
      // nothing protected by DRM is ever included - so the picture is what is
      // waited for, and audio joins the same stream if it comes.
      const stream = new MediaStream();
      const ready = new Promise((resolve, reject) => {
        let grace = null;
        connection.ontrack = (event) => {
          stream.addTrack(event.track);
          if (!stream.getVideoTracks().length) return;
          if (stream.getAudioTracks().length) {
            clearTimeout(grace);
            resolve(stream);
            return;
          }
          clearTimeout(grace);
          grace = setTimeout(() => resolve(stream), 1200);
        };
        setTimeout(() => reject(new Error('The screen never arrived.')), 15000);
      });

      listeners.push(await native.addListener('iceCandidate', (candidate) => {
        connection.addIceCandidate(candidate).catch(() => {
          // A candidate that arrives after the connection is up is not fatal.
        });
      }));

      // The app stops sharing when Android's own notification is used to end
      // it, which the room notices through the track ending.
      listeners.push(await native.addListener('stopped', () => connection.close()));

      connection.onicecandidate = (event) => {
        if (!event.candidate) return;
        native.addIceCandidate({
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        }).catch(() => {});
      };

      const offer = await native.start();
      // The app answers more than the SDP: whether it managed to capture any
      // sound, and whether that sound will survive the app being left.
      const captured = {
        audio: offer.audio === true,
        backgroundAudio: offer.backgroundAudio === true,
      };
      await connection.setRemoteDescription(offer);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      await native.answer({ sdp: answer.sdp });

      await ready;

      // Ending the picture has to end the capture too, or the notification
      // stays up and the projection keeps running with nobody watching it.
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        cleanUp();
        connection.close();
        native.stop().catch(() => {});
      });

      return { stream, ...captured };
    } catch (error) {
      cleanUp();
      connection.close();
      native.stop().catch(() => {});
      throw error;
    }
  }

  window.AstraNativeScreen = { available, capture };
})();
