package live.astrascreen.app;

import android.content.Intent;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.view.WindowInsets;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The two things the page needs from the app that are not about capture.
 *
 * Signing in has to leave the app: Discord will not authorise anybody inside
 * an embedded browser. It comes back as an `astra://auth` link, which Android
 * routes here - and the token in it has to wait, because on a cold start there
 * is no page to give it to yet, and a fragment cannot be pushed into a page
 * that is already loaded without reloading it anyway.
 *
 * So it is parked, and the page asks for it: on load, and again whenever the
 * app comes back to the front, which is the moment the browser hands over.
 */
@CapacitorPlugin(name = "AstraApp")
public class AppPlugin extends Plugin {

    /** The fragment of the last astra://auth link, until a page takes it. */
    private static volatile String pendingAuthFragment;

    /** The code from the last astra://room link, until a page takes it. */
    private static volatile String pendingRoomCode;

    /** Called from the activity, which is where Android delivers the link. */
    public static void offerAuthLink(Uri link) {
        if (link == null || !"astra".equals(link.getScheme())) return;
        String fragment = link.getFragment();
        if (fragment == null || !fragment.contains("access_token=")) return;
        pendingAuthFragment = fragment;
    }

    /**
     * Called from the activity for a room invitation opened elsewhere.
     *
     * Parked rather than acted on, for the same reason the token is: on a cold
     * start there is no page yet to send anywhere, and once there is, it asks.
     */
    public static void offerRoomLink(Uri link) {
        if (link == null || !"astra".equals(link.getScheme())) return;
        if (!"room".equals(link.getHost())) return;
        String code = link.getQueryParameter("code");
        if (code == null) return;
        code = code.trim().toUpperCase(java.util.Locale.US);
        // Letters and digits only: this ends up in a URL the WebView loads.
        if (!code.matches("[A-Z0-9]{4,12}")) return;
        pendingRoomCode = code;
    }

    /** Takes the parked room code, if there is one. Only ever answered once. */
    @PluginMethod
    public void consumePendingRoom(PluginCall call) {
        String code = pendingRoomCode;
        pendingRoomCode = null;
        JSObject result = new JSObject();
        if (code != null) result.put("code", code);
        call.resolve(result);
    }

    /** Hand a URL to whatever the user browses with. */
    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url");
        if (url == null) {
            call.reject("openExternal needs a url.");
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("Nothing here can open that: " + error.getMessage());
        }
    }

    /**
     * How much of the window the system bars are sitting on top of, in CSS
     * pixels.
     *
     * The app draws edge to edge, and the Android WebView does not reliably
     * report that through env(safe-area-inset-*) - so the page asks instead.
     * Reported when the page is ready for it rather than pushed from here,
     * because on a cold start there is no page to push to.
     */
    @PluginMethod
    public void getInsets(PluginCall call) {
        JSObject result = new JSObject();
        int top = 0;
        int bottom = 0;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && getBridge() != null
            && getBridge().getWebView() != null) {
            WindowInsets insets = getBridge().getWebView().getRootWindowInsets();
            if (insets != null) {
                Insets bars = insets.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                float density = getContext().getResources().getDisplayMetrics().density;
                if (density > 0) {
                    top = Math.round(bars.top / density);
                    bottom = Math.round(bars.bottom / density);
                }
            }
        }

        result.put("top", top);
        result.put("bottom", bottom);
        call.resolve(result);
    }

    /** Takes the parked token, if there is one. Only ever answered once. */
    @PluginMethod
    public void consumePendingAuth(PluginCall call) {
        String fragment = pendingAuthFragment;
        pendingAuthFragment = null;
        JSObject result = new JSObject();
        if (fragment != null) result.put("fragment", fragment);
        call.resolve(result);
    }
}
