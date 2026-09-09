package live.astrascreen.app;

import android.annotation.SuppressLint;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.projection.MediaProjection;
import android.os.Build;

import androidx.annotation.RequiresApi;

import org.webrtc.Logging;
import org.webrtc.audio.JavaAudioDeviceModule;

import java.nio.ByteBuffer;

/**
 * The audio the phone is playing, captured alongside the screen.
 *
 * Android 10 added AudioPlaybackCapture, which hands an app a mix of what
 * other apps are playing - and it takes the same MediaProjection consent the
 * screen capture already asked for, so sharing sound costs the user nothing
 * extra. What arrives is only ever media: the system refuses to include voice
 * calls, and any app can opt out of being captured at all.
 *
 * WebRTC pulls its outgoing audio from a device module that normally reads the
 * microphone. This fills that module's buffer instead, with the module told
 * not to open a microphone at all - so the WebView keeps sole ownership of the
 * real one for the room's voice.
 */
@RequiresApi(api = Build.VERSION_CODES.Q)
public class ScreenAudioCapturer implements JavaAudioDeviceModule.AudioBufferCallback {

    private static final String TAG = "AstraScreenAudio";

    /** Matches what the device module is built with, so the frames line up. */
    public static final int SAMPLE_RATE = 48000;
    public static final int CHANNELS = 2;

    private AudioRecord record;

    @SuppressLint("MissingPermission")
    public ScreenAudioCapturer(MediaProjection projection) {
        AudioPlaybackCaptureConfiguration config =
            new AudioPlaybackCaptureConfiguration.Builder(projection)
                // Everything the platform is willing to give: what apps play
                // as media, what games play, and anything that never said.
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .build();

        AudioFormat format = new AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(SAMPLE_RATE)
            .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
            .build();

        int minimum = AudioRecord.getMinBufferSize(
            SAMPLE_RATE, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT);

        record = new AudioRecord.Builder()
            .setAudioFormat(format)
            // Room for a few of WebRTC's 10ms frames, so a late thread does not
            // drop audio the moment the phone is busy.
            .setBufferSizeInBytes(Math.max(minimum, SAMPLE_RATE * CHANNELS) * 2)
            .setAudioPlaybackCaptureConfig(config)
            .build();

        record.startRecording();
    }

    /**
     * Called by the device module for every frame it is about to send, with an
     * empty buffer to fill. The read blocks, which is what paces this: the
     * module has no microphone to pace it any more.
     */
    @Override
    public long onBuffer(ByteBuffer buffer, int audioFormat, int channelCount,
                         int sampleRate, int bytesRead, long captureTimeNs) {
        AudioRecord source = record;
        if (source == null) return captureTimeNs;

        int wanted = buffer.capacity();
        buffer.clear();
        int read = source.read(buffer, wanted, AudioRecord.READ_BLOCKING);
        if (read < 0) {
            Logging.w(TAG, "screen audio read failed: " + read);
            // Leave the buffer as it was: silence is better than a stall.
            return captureTimeNs;
        }
        if (read < wanted) {
            // A short read would otherwise send whatever was in the buffer
            // before, which is the previous frame played twice.
            for (int i = read; i < wanted; i++) buffer.put(i, (byte) 0);
        }
        return captureTimeNs;
    }

    public void release() {
        AudioRecord source = record;
        record = null;
        if (source == null) return;
        try {
            source.stop();
        } catch (IllegalStateException ignored) {
            // Already stopped, which is the state we wanted anyway.
        }
        source.release();
    }
}
