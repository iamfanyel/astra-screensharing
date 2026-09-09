package live.astrascreen.app;

import android.os.Bundle;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private int statusBarDp = 0;
    private int navBarDp = 0;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Registered before the bridge starts, so the page can find it as soon
        // as it loads rather than having to wait and retry.
        registerPlugin(ScreenCapturePlugin.class);
        super.onCreate(savedInstanceState);

        ViewCompat.setOnApplyWindowInsetsListener(getWindow().getDecorView(), (v, windowInsets) -> {
            Insets insets = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars());
            float density = getResources().getDisplayMetrics().density;
            statusBarDp = Math.round(insets.top / density);
            navBarDp = Math.round(insets.bottom / density);
            applyInsetsToWebView();
            return windowInsets;
        });
    }

    private void applyInsetsToWebView() {
        if (getBridge() != null && getBridge().getWebView() != null) {
            String js = String.format(
                "document.documentElement.style.setProperty('--safe-area-inset-top', '%dpx');" +
                "document.documentElement.style.setProperty('--safe-area-inset-bottom', '%dpx');",
                statusBarDp, navBarDp
            );
            getBridge().getWebView().evaluateJavascript(js, null);
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        applyInsetsToWebView();
    }
}
