package live.astrascreen.app;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.graphics.Point;
import android.graphics.Rect;
import android.os.Build;
import android.util.DisplayMetrics;
import android.view.WindowManager;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.webrtc.DefaultVideoEncoderFactory;
import org.webrtc.DefaultVideoDecoderFactory;
import org.webrtc.EglBase;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpReceiver;
import org.webrtc.ScreenCapturerAndroid;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.AudioSource;
import org.webrtc.AudioTrack;
import org.webrtc.VideoSource;
import org.webrtc.VideoTrack;
import org.webrtc.audio.JavaAudioDeviceModule;

import java.nio.ByteBuffer;

import java.util.ArrayList;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Screen capture for the page running in the WebView.
 *
 * No mobile browser implements getDisplayMedia, so the page cannot ask for the
 * screen itself. This captures it natively and then hands it over the only way
 * a WebView will accept a video source it did not create: as a WebRTC track,
 * over a peer connection that never leaves the device.
 *
 * That costs an encode and a decode the desktop build does not pay, and buys
 * something worth far more - every line of the room's own WebRTC code, from
 * the mesh to the bitrate caps, goes on treating this like any other track.
 */
@CapacitorPlugin(
    name = "AstraScreen",
    permissions = {
        // Not for a microphone. Android hands an app the sound other apps are
        // playing through an AudioRecord like any other, so capturing it needs
        // RECORD_AUDIO even though nothing is being listened to.
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
    }
)
public class ScreenCapturePlugin extends Plugin {

    private PeerConnectionFactory factory;
    private EglBase eglBase;
    private PeerConnection connection;
    private ScreenCapturerAndroid capturer;
    private VideoSource videoSource;
    private VideoTrack videoTrack;
    private SurfaceTextureHelper textureHelper;

    private JavaAudioDeviceModule audioModule;
    private AudioSource audioSource;
    private AudioTrack audioTrack;

    /**
     * Set while a share is running. The device module is built once, at load,
     * and reads whatever is here at the time - so the capture can come and go
     * without rebuilding the factory underneath it.
     */
    private volatile ScreenAudioCapturer screenAudio;

    /** Held until the offer is ready, because consent arrives asynchronously. */
    private PluginCall pendingStart;

    /**
     * Where tearing a capture down happens.
     *
     * Disposing any of this blocks until the thread that owns it has finished,
     * and the two threads it would otherwise run on are both bad places to
     * wait: the main thread, where a few hundred milliseconds is a frozen app
     * and a few seconds is Android deciding it has hung, and libwebrtc's own
     * capture thread, which is one of the things being shut down.
     */
    private final ExecutorService closing = Executors.newSingleThreadExecutor();

    @Override
    public void load() {
        eglBase = EglBase.create();
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions
                .builder(getContext())
                .createInitializationOptions()
        );
        // Fed by the screen, never by a microphone. setAudioRecordEnabled(false)
        // stops the module opening one at all, which leaves the real
        // microphone to the WebView for the room's voice.
        audioModule = JavaAudioDeviceModule.builder(getContext())
            .setInputSampleRate(ScreenAudioCapturer.SAMPLE_RATE)
            .setUseStereoInput(true)
            .setAudioBufferCallback(this::fillAudioBuffer)
            // Both default to on, and both are built for a microphone in a
            // room. See screenAudioConstraints() for why that is the wrong
            // shape of help for a copy of what the phone is playing.
            .setUseHardwareAcousticEchoCanceler(false)
            .setUseHardwareNoiseSuppressor(false)
            // Nothing else will say when the record side gives up, and the
            // symptom of that is silence, which explains itself badly.
            .setAudioRecordErrorCallback(new JavaAudioDeviceModule.AudioRecordErrorCallback() {
                @Override
                public void onWebRtcAudioRecordInitError(String message) {
                    CrashLog.note("audio record init error: " + message);
                }

                @Override
                public void onWebRtcAudioRecordStartError(
                    JavaAudioDeviceModule.AudioRecordStartErrorCode code, String message) {
                    CrashLog.note("audio record start error: " + code + " " + message);
                }

                @Override
                public void onWebRtcAudioRecordError(String message) {
                    CrashLog.note("audio record error: " + message);
                }
            })
            .createAudioDeviceModule();
        audioModule.setAudioRecordEnabled(false);

        // Both ends of this connection are this handset, so there is no
        // network for it to be on and nothing to notice when the real one
        // changes. Saying so keeps libwebrtc away from ConnectivityManager
        // altogether, which is a whole class of failure this has no use for.
        PeerConnectionFactory.Options options = new PeerConnectionFactory.Options();
        options.disableNetworkMonitor = true;

        factory = PeerConnectionFactory.builder()
            .setOptions(options)
            .setAudioDeviceModule(audioModule)
            // Hardware where there is any: this is a phone encoding its own
            // screen while the WebView re-encodes it for everybody in the room.
            .setVideoEncoderFactory(new DefaultVideoEncoderFactory(
                eglBase.getEglBaseContext(), true, true))
            .setVideoDecoderFactory(new DefaultVideoDecoderFactory(
                eglBase.getEglBaseContext()))
            .createPeerConnectionFactory();
    }

    /**
     * Ask for the screen. Resolves with an SDP offer for the page to answer,
     * or rejects if the user declines the system's consent dialog.
     */
    @PluginMethod
    public void start(PluginCall call) {
        if (connection != null) {
            call.reject("A screen share is already running.");
            return;
        }
        // Asked for before the screen rather than after, so the user answers
        // both questions up front instead of being interrupted mid-share. The
        // room may already hold it for the microphone, in which case nothing
        // is shown.
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "afterMicrophone");
            return;
        }
        askForScreen(call);
    }

    /** Refusing only costs the sound; the screen is still worth sharing. */
    @PermissionCallback
    private void afterMicrophone(PluginCall call) {
        askForScreen(call);
    }

    private void askForScreen(PluginCall call) {
        MediaProjectionManager manager =
            (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (manager == null) {
            call.reject("This device has no screen capture support.");
            return;
        }
        pendingStart = call;
        CrashLog.note("share requested, asking for consent");
        startActivityForResult(call, manager.createScreenCaptureIntent(), "onConsent");
    }

    @ActivityCallback
    private void onConsent(PluginCall call, ActivityResult result) {
        if (call == null) return;
        CrashLog.note("consent came back: code=" + result.getResultCode()
            + " data=" + (result.getData() != null));
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            pendingStart = null;
            CrashLog.clear();
            // The same shape a cancelled browser picker produces, so the room
            // reads it as "changed their mind" rather than as a failure.
            call.reject("Screen sharing was cancelled.", "NotAllowedError");
            return;
        }

        // Nothing may touch the projection until the service is actually in
        // the foreground - Android 14 and later refuse it otherwise - and it
        // cannot get there until this thread lets go. So the capture waits to
        // be called back rather than running now.
        final Intent consent = result.getData();
        final boolean withAudio = canRecordAudio();
        CrashLog.note("starting the foreground service, microphone=" + withAudio);
        try {
            ScreenCaptureService.start(getContext(), withAudio, () -> {
                CrashLog.note("service is in the foreground");
                try {
                    beginCapture(consent, call);
                } catch (Throwable error) {
                    // Throwable, not Exception: a missing method or a failed
                    // native load arrives as an Error, and letting one of
                    // those past here is the difference between a message and
                    // the app disappearing.
                    CrashLog.note("beginCapture failed: " + error);
                    teardown();
                    call.reject("Could not start screen capture: " + error);
                }
            });
        } catch (Throwable error) {
            CrashLog.note("the foreground service would not start: " + error);
            pendingStart = null;
            call.reject("Could not start screen capture: " + error);
        }
    }

    /**
     * Whether sound can come along.
     *
     * Playback capture reads through an AudioRecord like any other, so it
     * needs RECORD_AUDIO - and on Android 14 the foreground service cannot
     * even claim to be using a microphone without it. When it is missing the
     * screen is still shared; it is just silent.
     */
    private boolean canRecordAudio() {
        return getContext().checkSelfPermission(Manifest.permission.RECORD_AUDIO)
            == PackageManager.PERMISSION_GRANTED;
    }

    private void beginCapture(Intent consent, PluginCall call) {
        CrashLog.note("building the capturer");
        capturer = new ScreenCapturerAndroid(consent, new MediaProjection.Callback() {
            @Override
            public void onStop() {
                // Stopped from the system's own notification rather than by
                // us. This arrives on libwebrtc's own thread, where an
                // exception would take the process with it rather than the
                // share.
                CrashLog.note("the system stopped the projection");
                notifyListeners("stopped", new JSObject());
                closeLater();
            }
        });

        CrashLog.note("building the texture helper and video source");
        textureHelper = SurfaceTextureHelper.create("AstraCapture", eglBase.getEglBaseContext());
        videoSource = factory.createVideoSource(true);
        capturer.initialize(textureHelper, getContext(), videoSource.getCapturerObserver());

        // Capture at the panel's own size and let the room's quality setting do
        // the scaling downstream, the same as a desktop share.
        Point size = displaySize();
        CrashLog.note("starting capture at " + size.x + "x" + size.y);
        capturer.startCapture(size.x, size.y, 30);

        CrashLog.note("capture started, building the video track");
        videoTrack = factory.createVideoTrack("astra-screen", videoSource);
        startScreenAudio();

        // No ICE servers: both ends of this are the same handset, so the only
        // candidates that can matter are host ones.
        PeerConnection.RTCConfiguration config =
            new PeerConnection.RTCConfiguration(new ArrayList<>());
        config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;

        CrashLog.note("building the peer connection");
        connection = factory.createPeerConnection(config, new LocalObserver());
        if (connection == null) throw new IllegalStateException("no peer connection");
        connection.addTrack(videoTrack, Collections.singletonList("astra-screen"));
        if (audioTrack != null) {
            connection.addTrack(audioTrack, Collections.singletonList("astra-screen"));
        }

        CrashLog.note("describing the screen");
        connection.createOffer(new SimpleSdpObserver() {
            @Override
            public void onCreateSuccess(SessionDescription description) {
                // Running, so there is nothing left to explain next launch.
                CrashLog.clear();
                connection.setLocalDescription(new SimpleSdpObserver(), description);
                JSObject offer = new JSObject();
                offer.put("sdp", description.description);
                offer.put("type", description.type.canonicalForm());
                // So the room can say the share is silent rather than leaving
                // people wondering why they cannot hear it.
                offer.put("audio", audioTrack != null);
                offer.put("backgroundAudio", ScreenCaptureService.keepsAudioInBackground());
                pendingStart = null;
                call.resolve(offer);
            }

            @Override
            public void onCreateFailure(String error) {
                CrashLog.note("could not describe the screen: " + error);
                pendingStart = null;
                teardown();
                call.reject("Could not describe the screen: " + error);
            }
        }, new MediaConstraints());
    }

    /**
     * How big the screen being captured is.
     *
     * The maximum metrics rather than the current ones: in split screen the
     * app's own window is a slice of the display, but what is being shared is
     * the whole of it. getDefaultDisplay() would answer the same and is
     * deprecated, so it is only the fallback for Android 10 and below.
     */
    private Point displaySize() {
        WindowManager windows = (WindowManager) getContext().getSystemService(Context.WINDOW_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Rect bounds = windows.getMaximumWindowMetrics().getBounds();
            return new Point(bounds.width(), bounds.height());
        }
        DisplayMetrics metrics = new DisplayMetrics();
        windows.getDefaultDisplay().getRealMetrics(metrics);
        return new Point(metrics.widthPixels, metrics.heightPixels);
    }

    /**
     * The sound the phone is playing, on the same consent as the picture.
     *
     * Only from Android 10, which is where AudioPlaybackCapture arrives; below
     * that a phone share is silent and there is nothing to be done about it.
     * A failure here is not worth losing the screen over, so it is logged and
     * the share goes on without sound.
     */
    private void startScreenAudio() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;
        if (!canRecordAudio()) return;
        CrashLog.note("reaching for the projection to capture sound");
        MediaProjection projection = capturer.getMediaProjection();
        if (projection == null) return;
        try {
            screenAudio = new ScreenAudioCapturer(projection);
            CrashLog.note("playback capture is recording, building the audio track");
            audioSource = factory.createAudioSource(screenAudioConstraints());
            audioTrack = factory.createAudioTrack("astra-screen-audio", audioSource);
            CrashLog.note("audio track built");
        } catch (Throwable error) {
            stopScreenAudio();
            CrashLog.note("no screen audio: " + error);
        }
    }

    /**
     * Keep WebRTC's microphone processing away from the screen's sound.
     *
     * All of it is built to pull one voice out of a room, and every part of it
     * is wrong here. The echo canceller's whole job is to remove what the
     * phone is playing from what was captured - and what was captured *is*
     * what the phone is playing, so it cancels the share itself. It adapts as
     * it goes, which is why a share starts out fine and fades to nothing
     * rather than simply never working. The noise suppressor hears music as
     * noise, and the gain control rides over anything with dynamics.
     *
     * The browser build has said the same thing since the beginning - see
     * captureScreen() in media.js - and this is the same decision, made in the
     * one place the native path builds its own source.
     */
    private static MediaConstraints screenAudioConstraints() {
        MediaConstraints constraints = new MediaConstraints();
        String[] off = {
            "googEchoCancellation",
            "googAutoGainControl",
            "googNoiseSuppression",
            "googHighpassFilter",
            "googTypingNoiseDetection",
        };
        for (String key : off) {
            constraints.mandatory.add(new MediaConstraints.KeyValuePair(key, "false"));
        }
        return constraints;
    }

    private void stopScreenAudio() {
        ScreenAudioCapturer audio = screenAudio;
        screenAudio = null;
        if (audio != null) audio.release();
        if (audioTrack != null) {
            audioTrack.dispose();
            audioTrack = null;
        }
        if (audioSource != null) {
            audioSource.dispose();
            audioSource = null;
        }
    }

    /**
     * Called by the device module for every outgoing frame. Silence whenever
     * nothing is being shared, which is the honest answer then.
     */
    private long fillAudioBuffer(ByteBuffer buffer, int audioFormat, int channelCount,
                                 int sampleRate, int bytesRead, long captureTimeNs) {
        ScreenAudioCapturer audio = screenAudio;
        if (audio == null) return captureTimeNs;
        return audio.onBuffer(buffer, audioFormat, channelCount, sampleRate, bytesRead, captureTimeNs);
    }

    /** The page's reply to the offer. */
    @PluginMethod
    public void answer(PluginCall call) {
        if (connection == null) {
            call.reject("There is no screen share to answer.");
            return;
        }
        String sdp = call.getString("sdp");
        if (sdp == null) {
            call.reject("An answer needs an sdp.");
            return;
        }
        connection.setRemoteDescription(new SimpleSdpObserver(),
            new SessionDescription(SessionDescription.Type.ANSWER, sdp));
        call.resolve();
    }

    /** One of the page's ICE candidates. */
    @PluginMethod
    public void addIceCandidate(PluginCall call) {
        if (connection == null) {
            call.resolve();
            return;
        }
        String candidate = call.getString("candidate");
        String mid = call.getString("sdpMid");
        Integer index = call.getInt("sdpMLineIndex");
        if (candidate != null && mid != null && index != null) {
            connection.addIceCandidate(new IceCandidate(mid, index, candidate));
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        closeLater();
        call.resolve();
    }

    /** Shut the capture down somewhere it is safe to block. */
    private void closeLater() {
        try {
            closing.execute(this::teardown);
        } catch (Throwable error) {
            // The executor is gone, which only happens on the way out anyway.
            CrashLog.note("could not hand off the teardown: " + error);
        }
    }

    @Override
    protected void handleOnDestroy() {
        closing.shutdown();
        // The process is going either way, so this one waits where it is.
        teardown();
        if (factory != null) factory.dispose();
        if (audioModule != null) audioModule.release();
        if (eglBase != null) eglBase.release();
    }

    /**
     * Everything the capture holds, released in the order that is safe.
     *
     * Synchronized because it is now reached from three directions - the page
     * stopping, Android stopping the projection, and the plugin going away -
     * and disposing any of this twice is not survivable.
     */
    private synchronized void teardown() {
        stopScreenAudio();
        if (capturer != null) {
            try {
                capturer.stopCapture();
            } catch (Exception ignored) {
            }
            capturer.dispose();
            capturer = null;
        }
        if (videoTrack != null) {
            videoTrack.dispose();
            videoTrack = null;
        }
        if (videoSource != null) {
            videoSource.dispose();
            videoSource = null;
        }
        if (textureHelper != null) {
            textureHelper.dispose();
            textureHelper = null;
        }
        if (connection != null) {
            connection.close();
            connection.dispose();
            connection = null;
        }
        pendingStart = null;
        ScreenCaptureService.stop(getContext());
    }

    /** Only the candidates matter here; the rest of the events are noise. */
    private class LocalObserver extends SimplePeerConnectionObserver {
        @Override
        public void onIceCandidate(IceCandidate candidate) {
            JSObject event = new JSObject();
            event.put("candidate", candidate.sdp);
            event.put("sdpMid", candidate.sdpMid);
            event.put("sdpMLineIndex", candidate.sdpMLineIndex);
            notifyListeners("iceCandidate", event);
        }
    }

    /** libwebrtc's interfaces want every method; these want almost none. */
    private static class SimpleSdpObserver implements SdpObserver {
        @Override public void onCreateSuccess(SessionDescription description) {}
        @Override public void onSetSuccess() {}
        @Override public void onCreateFailure(String error) {}
        @Override public void onSetFailure(String error) {}
    }

    private static class SimplePeerConnectionObserver implements PeerConnection.Observer {
        @Override public void onSignalingChange(PeerConnection.SignalingState state) {}
        @Override public void onIceConnectionChange(PeerConnection.IceConnectionState state) {}
        @Override public void onIceConnectionReceivingChange(boolean receiving) {}
        @Override public void onIceGatheringChange(PeerConnection.IceGatheringState state) {}
        @Override public void onIceCandidate(IceCandidate candidate) {}
        @Override public void onIceCandidatesRemoved(IceCandidate[] candidates) {}
        @Override public void onAddStream(MediaStream stream) {}
        @Override public void onRemoveStream(MediaStream stream) {}
        @Override public void onDataChannel(org.webrtc.DataChannel channel) {}
        @Override public void onRenegotiationNeeded() {}
        @Override public void onAddTrack(RtpReceiver receiver, MediaStream[] streams) {}
    }
}
