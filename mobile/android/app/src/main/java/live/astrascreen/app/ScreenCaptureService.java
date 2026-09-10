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
import android.util.Log;

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

    private static final String TAG = "AstraScreenService";
    private static final String CHANNEL_ID = "astra_screen_share";
    private static final int NOTIFICATION_ID = 1;

    /** Whether this run is allowed to claim the microphone type as well. */
    private static volatile boolean withMicrophone;

    /**
     * Run once the service is actually in the foreground.
     *
     * Nothing may touch the projection before that. startForegroundService()
     * only queues the start, and the caller is on the main thread - the same
     * thread onStartCommand needs - so the service cannot possibly be up until
     * the caller has returned. Capturing straight after starting it therefore
     * always ran too early, and Android 14 and later refuse the projection.
     */
    private static volatile Runnable onReady;

    public static void start(Context context, boolean claimMicrophone, Runnable ready) {
        withMicrophone = claimMicrophone;
        onReady = ready;
        Intent intent = new Intent(context, ScreenCaptureService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    public static void stop(Context context) {
        onReady = null;
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

        if (!goForeground(notification)) {
            // Nothing can be captured without this, and the caller is waiting.
            CrashLog.note("the service could not reach the foreground");
            onReady = null;
            stopSelf();
            return START_NOT_STICKY;
        }

        Runnable ready = onReady;
        onReady = null;
        // Whatever this runs is the whole capture. An exception escaping it
        // here would be an uncaught one inside a service, which ends the
        // process rather than the share.
        try {
            if (ready != null) ready.run();
        } catch (Throwable error) {
            CrashLog.note("the capture threw out of the service: " + error);
            stopSelf();
        }

        // Restarting this on its own would be pointless: the projection it was
        // holding up does not survive, and the room has to ask again anyway.
        return START_NOT_STICKY;
    }

    /**
     * Claim the foreground, with the microphone type only when it is safe to.
     *
     * From Android 14 a service claiming the microphone type must already hold
     * RECORD_AUDIO, and asking for it without that throws - inside a service's
     * onStartCommand, where nothing catches it and the whole app goes down.
     * So the type is only asked for when the permission is there, and even
     * then it falls back rather than taking the app with it.
     */
    private boolean goForeground(Notification notification) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification);
            return true;
        }

        int types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
        if (withMicrophone) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;

        try {
            startForeground(NOTIFICATION_ID, notification, types);
            return true;
        } catch (Throwable error) {
            Log.w(TAG, "foreground service refused with those types: " + error);
            CrashLog.note("foreground refused with microphone: " + error);
        }

        if (types == ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION) return false;

        // Without sound is far better than without a share.
        try {
            startForeground(NOTIFICATION_ID, notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
            return true;
        } catch (Throwable error) {
            Log.w(TAG, "foreground service refused outright: " + error);
            CrashLog.note("foreground refused outright: " + error);
            return false;
        }
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
