package live.astrascreen.app;

import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * Back, offered to the page first.
     *
     * Everything the room opens - settings, the profile card, the sheet, a
     * focused tile - is a layer over one page, not a page of its own. Android
     * has no history to step through, so left alone it does the only thing it
     * can and closes the app. The page is asked whether it had something to
     * close; only if it did not does the press go on to mean what it usually
     * means.
     */
    private final OnBackPressedCallback backToPage = new OnBackPressedCallback(true) {
        @Override
        public void handleOnBackPressed() {
            WebView web = getBridge() == null ? null : getBridge().getWebView();
            if (web == null) {
                passItOn();
                return;
            }
            // Asking is asynchronous, so the press is held here and released
            // below if the page turns it down.
            web.evaluateJavascript(
                "(function(){try{return window.AstraNativeBack ? window.AstraNativeBack() === true : false}"
                    + "catch(e){return false}})()",
                value -> {
                    if (!"true".equals(value)) passItOn();
                }
            );
        }
    };

    /** Hand the press back to whoever would have had it. */
    private void passItOn() {
        backToPage.setEnabled(false);
        getOnBackPressedDispatcher().onBackPressed();
        backToPage.setEnabled(true);
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Registered before the bridge starts, so the page can find them as
        // soon as it loads rather than having to wait and retry.
        registerPlugin(ScreenCapturePlugin.class);
        registerPlugin(AppPlugin.class);
        super.onCreate(savedInstanceState);

        // Added after the bridge's own, so this one is asked first.
        getOnBackPressedDispatcher().addCallback(this, backToPage);

        // The lobby has nothing to scroll, but Android still lets it be
        // dragged and sprung back, which reads as the whole page being loose.
        // The stylesheet asks for this too; the WebView is the one that has
        // the final say.
        WebView web = getBridge() == null ? null : getBridge().getWebView();
        if (web != null) web.setOverScrollMode(View.OVER_SCROLL_NEVER);

        // A link that started the app cold: park it, and the page collects it
        // once there is a page.
        AppPlugin.offerAuthLink(getIntent() == null ? null : getIntent().getData());
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // The ordinary case: the app was already running behind the browser.
        AppPlugin.offerAuthLink(intent == null ? null : intent.getData());
    }
}
