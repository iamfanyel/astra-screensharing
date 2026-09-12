package live.astrascreen.app;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Which speaker the room plays out of, on a phone.
 *
 * The web has an answer for this - enumerateDevices() lists outputs and
 * setSinkId() picks one - and Chrome on Android implements neither. It reports
 * microphones and cameras and no outputs at all, so the room's output menu had
 * nothing to put in it and came up empty. Nothing the page can do changes
 * that; the list only exists on the Android side of the bridge.
 *
 * Android's own answer is the communication device. From API 31 the audio
 * manager will name every output that can carry a call - earpiece, speaker,
 * wired, Bluetooth - and route to a chosen one. Below that there is no list to
 * ask for, so the two that every handset has are offered and the old
 * speakerphone switch does the routing.
 *
 * The catch, and the reason for the mode change: routing only applies to audio
 * the system considers part of a conversation. The room's audio comes out of
 * a WebView, which plays as media by default and follows the media route no
 * matter what is asked for here. MODE_IN_COMMUNICATION is what moves it onto
 * the call route, and it is also what the volume keys follow - which is right
 * for a room full of people talking, and is what every voice app does.
 *
 * Everything here is best effort and says so: a refused route resolves with
 * the list unchanged rather than failing, because an output menu that throws
 * is worse than one that did not move.
 */
@CapacitorPlugin(name = "AstraAudio")
public class AudioRoutePlugin extends Plugin {

    /** Ids for the two that are always there, when Android will not name them. */
    private static final String LEGACY_EARPIECE = "earpiece";
    private static final String LEGACY_SPEAKER = "speaker";

    /** What the audio mode was before a route was chosen, to put back after. */
    private Integer modeBefore;

    private AudioManager audio() {
        Context context = getContext();
        if (context == null) return null;
        return (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
    }

    /**
     * Every output the room could play through, and which one it is using.
     *
     * Resolves with an empty list rather than an error when the device cannot
     * answer - the menu then falls back to whatever the browser knows, which
     * is what a phone did before this existed.
     */
    @PluginMethod
    public void list(PluginCall call) {
        JSObject result = new JSObject();
        JSArray outputs = new JSArray();
        AudioManager manager = audio();

        if (manager == null) {
            result.put("outputs", outputs);
            call.resolve(result);
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AudioDeviceInfo current = manager.getCommunicationDevice();
            String currentId = current == null ? null : String.valueOf(current.getId());
            for (AudioDeviceInfo device : manager.getAvailableCommunicationDevices()) {
                String label = labelFor(device);
                if (label == null) continue;  // a type nobody would recognise
                JSObject entry = new JSObject();
                entry.put("id", String.valueOf(device.getId()));
                entry.put("label", label);
                entry.put("selected", String.valueOf(device.getId()).equals(currentId));
                outputs.put(entry);
            }
        } else {
            // No list to ask for. Both of these exist on every handset, and the
            // speakerphone switch is the only routing there is.
            boolean onSpeaker = manager.isSpeakerphoneOn();
            outputs.put(legacyEntry(LEGACY_EARPIECE, "Phone", !onSpeaker));
            outputs.put(legacyEntry(LEGACY_SPEAKER, "Speaker", onSpeaker));
        }

        result.put("outputs", outputs);
        call.resolve(result);
    }

    /** Play through one of them. Unknown ids are ignored, not an error. */
    @PluginMethod
    public void select(PluginCall call) {
        String id = call.getString("id");
        AudioManager manager = audio();
        if (manager == null || id == null) {
            call.resolve(new JSObject().put("ok", false));
            return;
        }

        // Media follows the call route only in this mode - see the note above.
        if (modeBefore == null) modeBefore = manager.getMode();
        manager.setMode(AudioManager.MODE_IN_COMMUNICATION);

        boolean ok = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            for (AudioDeviceInfo device : manager.getAvailableCommunicationDevices()) {
                if (!String.valueOf(device.getId()).equals(id)) continue;
                ok = manager.setCommunicationDevice(device);
                break;
            }
        } else {
            manager.setSpeakerphoneOn(LEGACY_SPEAKER.equals(id));
            ok = true;
        }

        call.resolve(new JSObject().put("ok", ok));
    }

    /**
     * Hand routing back to the system.
     *
     * Called when the room is left. Leaving the mode where it was matters as
     * much as the route: MODE_IN_COMMUNICATION is what makes the volume keys
     * adjust call volume, and a phone left in it after the room has closed
     * would go on doing that with nothing running.
     */
    @PluginMethod
    public void clear(PluginCall call) {
        AudioManager manager = audio();
        if (manager != null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                manager.clearCommunicationDevice();
            } else {
                manager.setSpeakerphoneOn(false);
            }
            if (modeBefore != null) {
                manager.setMode(modeBefore);
                modeBefore = null;
            }
        }
        call.resolve();
    }

    private JSObject legacyEntry(String id, String label, boolean selected) {
        JSObject entry = new JSObject();
        entry.put("id", id);
        entry.put("label", label);
        entry.put("selected", selected);
        return entry;
    }

    /**
     * What to call an output.
     *
     * The built-in two are named the way a phone names them rather than the
     * way Android does - "Phone" is the earpiece you hold to your head, which
     * is what everybody else calls it. Anything with a name of its own uses
     * that, because "Bluetooth" is no help when two pairs are paired.
     */
    private String labelFor(AudioDeviceInfo device) {
        switch (device.getType()) {
            case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE:
                return "Phone";
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER:
                return "Speaker";
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
                return named(device, "Headphones");
            case AudioDeviceInfo.TYPE_USB_HEADSET:
            case AudioDeviceInfo.TYPE_USB_DEVICE:
                return named(device, "USB audio");
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
            case AudioDeviceInfo.TYPE_BLE_HEADSET:
                return named(device, "Bluetooth");
            case AudioDeviceInfo.TYPE_HEARING_AID:
                return named(device, "Hearing aid");
            default:
                return null;
        }
    }

    private String named(AudioDeviceInfo device, String fallback) {
        CharSequence name = device.getProductName();
        if (name == null) return fallback;
        String text = name.toString().trim();
        return text.isEmpty() ? fallback : text;
    }

    /** A room left behind should not leave the phone routed for a call. */
    @Override
    protected void handleOnDestroy() {
        AudioManager manager = audio();
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) manager.clearCommunicationDevice();
        if (modeBefore != null) {
            manager.setMode(modeBefore);
            modeBefore = null;
        }
    }
}
