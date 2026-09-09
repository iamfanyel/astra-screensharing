package live.astrascreen.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.annotation.Nullable;

/**
 * Holds the screen capture up while it runs.
 *
 * Android will not give an app a MediaProjection unless a foreground service
 * is already running to keep it honest, and from Android 14 that service has
 * to declare `mediaProjection` as its type. The service does no work itself -
 * the capture lives in the plugin - it exists so the system can see that
 * something visible to the user is responsible for it.
 */
public class ScreenCaptureService extends Service {

    private static final String CHANNEL_ID = "astra_screen_share";
    private static final int NOTIFICATION_ID = 1;

    public static void start(Context context) {
        Intent intent = new Intent(context, ScreenCaptureService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    public static void stop(Context context) {
        context.stopService(new Intent(context, ScreenCaptureService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        createChannel();

        Notification notification = new Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Astra")
            .setContentText("Sharing your screen")
            .setSmallIcon(android.R.drawable.ic_menu_share)
            .setOngoing(true)
            .build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
                    | ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }

        // Restarting this on its own would be pointless: the projection it was
        // holding up does not survive, and the room has to ask again anyway.
        return START_NOT_STICKY;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID, "Screen sharing", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Shown while Astra is sharing your screen.");
        manager.createNotificationChannel(channel);
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
