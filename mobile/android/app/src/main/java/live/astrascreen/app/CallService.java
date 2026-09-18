package live.astrascreen.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.annotation.Nullable;

/**
 * Keeps the app running while it is in a room.
 *
 * A call is a set of live connections held by the page. Once Astra is not the
 * app in front, Android is free to freeze it - no timers, no network - and a
 * minute later the room has written it off and the broker has dropped it:
 * leaving the app for a moment was enough to be thrown out of the call. A
 * foreground service is how an app tells Android it is doing something the
 * user is still relying on, the same way every calling app does.
 *
 * It holds the microphone type when the app may use the microphone - so the
 * user's voice also keeps going in the background - and the data-sync type
 * otherwise, which only keeps the process alive.
 *
 * A running process is not enough on its own, though. With the screen off,
 * Android lets the CPU sleep and the Wi-Fi radio doze a few minutes later,
 * and a call whose phone cannot answer for that long is dropped by the room -
 * then let back in when the phone next wakes, and dropped again. So it also
 * holds the CPU and the Wi-Fi awake for as long as it runs, the way calling
 * apps do.
 */
public class CallService extends Service {

    private static final String TAG = "AstraCallService";
    private static final String CHANNEL_ID = "astra_in_call";
    // Not the screen-share service's id: both can be up at once.
    private static final int NOTIFICATION_ID = 2;

    private static final long CPU_LOCK_LIMIT_MS = 12L * 60 * 60 * 1000;

    private PowerManager.WakeLock cpuLock;
    private WifiManager.WifiLock wifiLock;

    public static void start(Context context) {
        Intent intent = new Intent(context, CallService.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (Throwable error) {
            // Refused (the app was already in the background, say). The room
            // still works; it just will not survive being left.
            Log.w(TAG, "could not start: " + error);
            CrashLog.note("call service could not start: " + error);
        }
    }

    public static void stop(Context context) {
        try {
            context.stopService(new Intent(context, CallService.class));
        } catch (Throwable ignored) {
            // Nothing running.
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        createChannel();

        Intent open = new Intent(this, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        PendingIntent tap = PendingIntent.getActivity(
            this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);
        Notification notification = builder
            .setContentTitle("Astra")
            .setContentText("You are in a room")
            .setSmallIcon(android.R.drawable.stat_sys_phone_call)
            .setContentIntent(tap)
            .setOngoing(true)
            .build();

        if (!goForeground(notification)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        holdAwake();
        // If Android kills it anyway, the page it was keeping alive is gone
        // too; bringing this back alone would only leave a stale notification.
        return START_NOT_STICKY;
    }

    /**
     * Keep the CPU and the Wi-Fi radio up for the call. Started again each time
     * the page asks (see AppPlugin.setInCall), so it only takes them once.
     */
    private void holdAwake() {
        try {
            if (cpuLock == null) {
                PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (power != null) {
                    cpuLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Astra:call");
                    cpuLock.setReferenceCounted(false);
                    // Released when the call ends; the limit only guards
                    // against a service that somehow outlives it.
                    cpuLock.acquire(CPU_LOCK_LIMIT_MS);
                }
            }
            if (wifiLock == null) {
                WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wifi != null) {
                    int mode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                        ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                        : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                    wifiLock = wifi.createWifiLock(mode, "Astra:call");
                    wifiLock.setReferenceCounted(false);
                    wifiLock.acquire();
                }
            }
        } catch (Throwable error) {
            // The call still runs; it may just not survive a long sleep.
            CrashLog.note("could not hold the phone awake: " + error);
        }
    }

    private void letSleep() {
        try {
            if (cpuLock != null && cpuLock.isHeld()) cpuLock.release();
        } catch (Throwable ignored) {
            // Already gone.
        }
        try {
            if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        } catch (Throwable ignored) {
            // Already gone.
        }
        cpuLock = null;
        wifiLock = null;
    }

    @Override
    public void onDestroy() {
        letSleep();
        super.onDestroy();
    }

    /**
     * Claim the foreground with the best type allowed right now.
     *
     * The microphone type needs RECORD_AUDIO already granted from Android 14,
     * and asking without it throws inside onStartCommand, which ends the app.
     * So it is only asked for with the permission, and anything refused falls
     * back rather than taking the app down with it.
     */
    private boolean goForeground(Notification notification) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification);
            return true;
        }

        // The microphone type only exists from Android 11.
        boolean microphone = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
            && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        int[] attempts = microphone
            ? new int[] { ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC }
            : new int[] { ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC };

        for (int type : attempts) {
            try {
                startForeground(NOTIFICATION_ID, notification, type);
                return true;
            } catch (Throwable error) {
                Log.w(TAG, "foreground refused with type " + type + ": " + error);
                CrashLog.note("call service refused type " + type + ": " + error);
            }
        }
        return false;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID, "In a room", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Shown while you are in an Astra room, so the call keeps going when you leave the app.");
        manager.createNotificationChannel(channel);
    }

    /** Swiped away from recents: the room is gone, so is the reason to stay. */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
