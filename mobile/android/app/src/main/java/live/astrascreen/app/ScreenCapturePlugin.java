package live.astrascreen.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.graphics.Point;
import android.graphics.Rect;
import android.os.Build;
import android.util.DisplayMetrics;
import android.view.WindowManager;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

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
@CapacitorPlugin(name = "AstraScreen")
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
            .createAudioDeviceModule();
        audioModule.setAudioRecordEnabled(false);

        factory = PeerConnectionFactory.builder()
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
        MediaProjectionManager manager =
            (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (manager == null) {
            call.reject("This device has no screen capture support.");
            return;
        }
        pendingStart = call;
        startActivityForResult(call, manager.createScreenCaptureIntent(), "onConsent");
    }

    @ActivityCallback
    private void onConsent(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            pendingStart = null;
            // The same shape a cancelled browser picker produces, so the room
            // reads it as "changed their mind" rather than as a failure.
            call.reject("Screen sharing was cancelled.", "NotAllowedError");
            return;
        }

        // The service has to be up before the projection is taken, or Android
        // 14 and later refuse to grant it.
        ScreenCaptureService.start(getContext());

        try {
            beginCapture(result.getData(), call);
        } catch (Exception error) {
            teardown();
            call.reject("Could not start screen capture: " + error.getMessage());
        }
    }

    private void beginCapture(Intent consent, PluginCall call) {
        capturer = new ScreenCapturerAndroid(consent, new MediaProjection.Callback() {
            @Override
            public void onStop() {
                // Stopped from the system's own notification rather than by us.
                notifyListeners("stopped", new JSObject());
                teardown();
            }
        });

        textureHelper = SurfaceTextureHelper.create("AstraCapture", eglBase.getEglBaseContext());
        videoSource = factory.createVideoSource(true);
        capturer.initialize(textureHelper, getContext(), videoSource.getCapturerObserver());

        // Capture at the panel's own size and let the room's quality setting do
        // the scaling downstream, the same as a desktop share.
        Point size = displaySize();
        capturer.startCapture(size.x, size.y, 30);

        videoTrack = factory.createVideoTrack("astra-screen", videoSource);
        startScreenAudio();

        // No ICE servers: both ends of this are the same handset, so the only
        // candidates that can matter are host ones.
        PeerConnection.RTCConfiguration config =
            new PeerConnection.RTCConfiguration(new ArrayList<>());
        config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;

        connection = factory.createPeerConnection(config, new LocalObserver());
        if (connection == null) throw new IllegalStateException("no peer connection");
        connection.addTrack(videoTrack, Collections.singletonList("astra-screen"));
        if (audioTrack != null) {
            connection.addTrack(audioTrack, Collections.singletonList("astra-screen"));
        }

        connection.createOffer(new SimpleSdpObserver() {
            @Override
            public void onCreateSuccess(SessionDescription description) {
                connection.setLocalDescription(new SimpleSdpObserver(), description);
                JSObject offer = new JSObject();
                offer.put("sdp", description.description);
                offer.put("type", description.type.canonicalForm());
                pendingStart = null;
                call.resolve(offer);
            }

            @Override
            public void onCreateFailure(String error) {
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
        MediaProjection projection = capturer.getMediaProjection();
        if (projection == null) return;
        try {
            screenAudio = new ScreenAudioCapturer(projection);
            audioSource = factory.createAudioSource(new MediaConstraints());
            audioTrack = factory.createAudioTrack("astra-screen-audio", audioSource);
        } catch (Exception error) {
            stopScreenAudio();
            android.util.Log.w("AstraScreen", "no screen audio: " + error.getMessage());
        }
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
        teardown();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        teardown();
        if (factory != null) factory.dispose();
        if (audioModule != null) audioModule.release();
        if (eglBase != null) eglBase.release();
    }

    /** Everything the capture holds, released in the order that is safe. */
    private void teardown() {
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
