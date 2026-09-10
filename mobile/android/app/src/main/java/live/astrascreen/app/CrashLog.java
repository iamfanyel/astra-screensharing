package live.astrascreen.app;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.FileInputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * A trail of breadcrumbs through the screen capture, written to survive the
 * process dying.
 *
 * Screen capture crosses from the page into Java, into the system's projection
 * service and into libwebrtc's native code, on several threads. When it takes
 * the app down there is nothing left to ask - and without a cable attached
 * there is no logcat to read either. So each step writes itself to disk as it
 * is reached, and the next launch reports whatever the last one did not get
 * past. An uncaught Java exception adds its stack; a native abort leaves none,
 * which is itself the answer, because it says the crash was below Java.
 *
 * The trail is cleared the moment a share is running, so a report only ever
 * appears when something actually went wrong.
 */
public final class CrashLog {

    private static final String TAG = "AstraCrash";
    private static final String TRAIL = "capture-trail.txt";
    private static final String CRASH = "last-crash.txt";

    private static File trailFile;
    private static File crashFile;
    private static String carriedOver;

    private CrashLog() {}

    /** Call first thing, before anything that might crash. */
    public static synchronized void install(Context context) {
        File dir = context.getFilesDir();
        trailFile = new File(dir, TRAIL);
        crashFile = new File(dir, CRASH);

        StringBuilder carried = new StringBuilder();
        String trail = read(trailFile);
        if (trail != null && !trail.trim().isEmpty()) {
            carried.append("A screen share stopped part way through.\n")
                   .append("How far it got:\n\n").append(trail);
        }
        String stack = read(crashFile);
        if (stack != null && !stack.trim().isEmpty()) {
            if (carried.length() > 0) carried.append('\n');
            carried.append(stack);
        }
        carriedOver = carried.length() == 0 ? null : carried.toString();

        trailFile.delete();
        crashFile.delete();

        final Thread.UncaughtExceptionHandler previous =
            Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try {
                StringWriter text = new StringWriter();
                text.append("Uncaught on thread ").append(thread.getName()).append("\n\n");
                error.printStackTrace(new PrintWriter(text));
                write(crashFile, text.toString());
            } catch (Throwable ignored) {
                // Already on the way down; there is nothing better to try.
            }
            // Still let the system do what it would have done, so the crash
            // is not swallowed and the app does not sit there half alive.
            if (previous != null) previous.uncaughtException(thread, error);
        });
    }

    /** Whatever the last run failed to get past, once. */
    public static synchronized String takeReport() {
        String report = carriedOver;
        carriedOver = null;
        return report;
    }

    /**
     * One step reached. Written through rather than buffered, because the
     * whole point is the step that never returns.
     */
    public static synchronized void note(String step) {
        Log.i(TAG, step);
        if (trailFile == null) return;
        String stamp = new SimpleDateFormat("HH:mm:ss.SSS", Locale.US).format(new Date());
        try (FileOutputStream out = new FileOutputStream(trailFile, true)) {
            out.write((stamp + "  " + step + "\n").getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        } catch (Throwable error) {
            Log.w(TAG, "could not write the trail: " + error);
        }
    }

    /** The capture got where it was going. Nothing to report next time. */
    public static synchronized void clear() {
        if (trailFile != null) trailFile.delete();
    }

    private static String read(File file) {
        if (file == null || !file.exists()) return null;
        try (FileInputStream in = new FileInputStream(file)) {
            byte[] bytes = new byte[(int) Math.min(file.length(), 64 * 1024)];
            int read = in.read(bytes);
            return read <= 0 ? null : new String(bytes, 0, read, StandardCharsets.UTF_8);
        } catch (Throwable error) {
            return null;
        }
    }

    private static void write(File file, String text) throws Exception {
        try (FileOutputStream out = new FileOutputStream(file, false)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        }
    }
}
