package io.github.kaiseriiii.videosave;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.IBinder;
import android.provider.MediaStore;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Android Foreground Service (dataSync) supporting:
 * - Resumable HTTP Range downloads (.part checkpoint)
 * - Native HLS VOD segment downloader with checkpoint resume & authorized AES-128 decryption
 * - Batch serial queue with Pause/Cancel controls
 * - Android 10+ Scoped Storage export to Downloads/VideoSave (MediaStore.Downloads)
 */
public final class DownloadService extends Service {

    public static final String CHANNEL_ID = "videosave_downloads";
    public static final String ACTION_ENQUEUE = "io.github.kaiseriiii.videosave.ENQUEUE";
    public static final String ACTION_CANCEL = "io.github.kaiseriiii.videosave.CANCEL";
    public static final String ACTION_PROGRESS = "io.github.kaiseriiii.videosave.PROGRESS";
    private static final int NOTIF_ID = 1201;

    private static final class Task {
        final String id;
        final String url;
        final String title;
        final String kind;
        final String userAgent;
        final String referer;
        final String folder;
        Task(String id, String url, String title, String kind, String ua, String ref, String folder) {
            this.id = id; this.url = url; this.title = title; this.kind = kind;
            this.userAgent = ua; this.referer = ref; this.folder = folder;
        }
    }

    private final BlockingQueue<Task> queue = new LinkedBlockingQueue<Task>();
    private final AtomicBoolean cancelled = new AtomicBoolean(false);
    private volatile boolean workerRunning = false;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_NOT_STICKY;
        String action = intent.getAction();
        if (ACTION_CANCEL.equals(action)) {
            cancelled.set(true);
            queue.clear();
            broadcastProgress("cancelled", "Download cancelled", 0, 0, "");
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_ENQUEUE.equals(action)) {
            cancelled.set(false);
            String url = intent.getStringExtra("url");
            String title = intent.getStringExtra("title");
            String kind = intent.getStringExtra("kind");
            String ua = intent.getStringExtra("ua");
            String ref = intent.getStringExtra("referer");
            String folder = intent.getStringExtra("folder");
            if (url != null && !url.trim().isEmpty()) {
                Task t = new Task(
                        UUID.randomUUID().toString().substring(0, 8),
                        url.trim(),
                        (title == null || title.trim().isEmpty()) ? MediaProbeEngine.inferTitle(url) : title.trim(),
                        kind == null ? "mp4" : kind,
                        ua, ref,
                        (folder == null || folder.trim().isEmpty()) ? "VideoSave" : folder.trim());
                queue.offer(t);
                startForeground(NOTIF_ID, buildNotification("VideoSave", "Queued: " + t.title, 0, true));
                ensureWorker();
            }
        }
        return START_NOT_STICKY;
    }

    private synchronized void ensureWorker() {
        if (workerRunning) return;
        workerRunning = true;
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    while (!cancelled.get()) {
                        Task task = queue.poll();
                        if (task == null) break;
                        executeTask(task);
                    }
                } finally {
                    workerRunning = false;
                    stopForeground(false);
                    stopSelf();
                }
            }
        }, "VideoSave-DownloadWorker").start();
    }

    private void executeTask(Task task) {
        try {
            File cacheDir = new File(getCacheDir(), "staging-" + shaShort(task.url));
            if (!cacheDir.exists()) cacheDir.mkdirs();
            File stagedFile;
            String mime;
            String ext;
            if ("hls".equals(task.kind) || task.url.toLowerCase().contains(".m3u8")) {
                stagedFile = downloadHlsResumable(task, cacheDir);
                mime = stagedFile.getName().endsWith(".mp4") ? "video/mp4" : "video/mp2t";
                ext = stagedFile.getName().endsWith(".mp4") ? ".mp4" : ".ts";
            } else {
                ext = "audio".equals(task.kind) ? ".m4a" : ".mp4";
                mime = "audio".equals(task.kind) ? "audio/mp4" : "video/mp4";
                stagedFile = downloadHttpRangeResumable(task, new File(cacheDir, "payload" + ext + ".part"));
            }
            if (cancelled.get()) return;

            String safeName = task.title.replaceAll("[^a-zA-Z0-9\\u4e00-\\u9fa5._ -]", "_");
            if (safeName.isEmpty()) safeName = "video_" + task.id;
            if (!safeName.toLowerCase().endsWith(ext)) safeName = safeName + ext;

            Uri savedUri = exportToDownloads(stagedFile, safeName, mime, task.folder);
            long size = stagedFile.length();
            deleteRecursive(cacheDir);

            String displayPath = "Downloads/" + task.folder + "/" + safeName;
            DownloadHistoryStore.append(this, new DownloadHistoryStore.Record(
                    task.id, safeName, task.url, task.kind, "done",
                    savedUri != null ? savedUri.toString() : "",
                    displayPath, size, System.currentTimeMillis()));

            updateNotification("Completed: " + safeName, MediaProbeEngine.formatSize(size), 100, false);
            broadcastProgress("done", "Saved: " + displayPath + " (" + MediaProbeEngine.formatSize(size) + ")", 100, size,
                    savedUri != null ? savedUri.toString() : "");
        } catch (Exception e) {
            String msg = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
            DownloadHistoryStore.append(this, new DownloadHistoryStore.Record(
                    task.id, task.title, task.url, task.kind, "error", "", msg, 0, System.currentTimeMillis()));
            updateNotification("Failed: " + task.title, msg, 0, false);
            broadcastProgress("error", msg, 0, 0, "");
        }
    }

    private File downloadHttpRangeResumable(Task task, File partFile) throws Exception {
        long existing = partFile.exists() ? partFile.length() : 0L;
        HttpURLConnection conn = MediaProbeEngine.openConnection(
                task.url, task.userAgent, task.referer, existing > 0 ? ("bytes=" + existing + "-") : null);
        int code = conn.getResponseCode();
        if (code == 401 || code == 402 || code == 403 || code == 451) {
            conn.disconnect();
            throw new IllegalStateException("HTTP " + code + " — Access denied by server (not bypassed)");
        }
        if (code == 416 && existing > 0) {
            conn.disconnect();
            return partFile;
        }
        if (code < 200 || code >= 300) {
            conn.disconnect();
            throw new IllegalStateException("HTTP " + code + " download error");
        }
        boolean append = (code == 206 && existing > 0);
        long total = MediaProbeEngine.parseContentLength(conn);
        if (!append) existing = 0L;
        if (total <= 0 && conn.getContentLengthLong() > 0) {
            total = existing + conn.getContentLengthLong();
        }

        RandomAccessFile raf = new RandomAccessFile(partFile, "rw");
        InputStream in = conn.getInputStream();
        try {
            if (append) raf.seek(existing);
            else raf.setLength(0);
            byte[] buf = new byte[32 * 1024];
            long done = existing;
            long lastEmit = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                if (cancelled.get()) return partFile;
                raf.write(buf, 0, n);
                done += n;
                long now = System.currentTimeMillis();
                if (now - lastEmit >= 350) {
                    lastEmit = now;
                    int pct = total > 0 ? (int) Math.min(99, (done * 100L) / total) : 0;
                    String text = MediaProbeEngine.formatSize(done) + (total > 0 ? " / " + MediaProbeEngine.formatSize(total) : "");
                    updateNotification(task.title, text, pct, total <= 0);
                    broadcastProgress("downloading", text, pct, done, "");
                }
            }
        } finally {
            in.close();
            raf.close();
            conn.disconnect();
        }
        return partFile;
    }

    private File downloadHlsResumable(Task task, File cacheDir) throws Exception {
        HttpURLConnection conn = MediaProbeEngine.openConnection(task.url, task.userAgent, task.referer, null);
        int code = conn.getResponseCode();
        if (code == 401 || code == 402 || code == 403 || code == 451) {
            conn.disconnect();
            throw new IllegalStateException("HTTP " + code + " on HLS playlist");
        }
        String playlist = MediaProbeEngine.readLimitedText(conn.getInputStream(), 1024 * 1024);
        conn.disconnect();
        if (playlist.contains("SAMPLE-AES")) {
            throw new IllegalStateException("DRM-protected HLS (SAMPLE-AES) is not supported");
        }

        URL base = new URL(task.url);
        List<String> segments = new ArrayList<String>();
        String initUri = null;
        String keyUri = null;
        byte[] explicitIv = null;
        int mediaSeq = 0;

        for (String raw : playlist.split("\\r?\\n")) {
            String line = raw.trim();
            if (line.isEmpty()) continue;
            if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
                mediaSeq = Integer.parseInt(line.substring(22).trim());
            } else if (line.startsWith("#EXT-X-MAP:")) {
                Matcher m = Pattern.compile("URI=\"([^\"]+)\"").matcher(line);
                if (m.find()) initUri = new URL(base, m.group(1)).toString();
            } else if (line.startsWith("#EXT-X-KEY:")) {
                if (line.contains("METHOD=AES-128")) {
                    Matcher um = Pattern.compile("URI=\"([^\"]+)\"").matcher(line);
                    if (um.find()) keyUri = new URL(base, um.group(1)).toString();
                    Matcher ivm = Pattern.compile("IV=0x([0-9a-fA-F]{32})").matcher(line);
                    if (ivm.find()) explicitIv = hexToBytes(ivm.group(1));
                }
            } else if (!line.startsWith("#")) {
                segments.add(new URL(base, line).toString());
            }
        }
        if (segments.isEmpty()) throw new IllegalStateException("HLS playlist contains no media segments");

        byte[] aesKey = null;
        if (keyUri != null) {
            aesKey = fetchBytes(keyUri, task.userAgent, task.referer);
            if (aesKey.length != 16) throw new IllegalStateException("Invalid AES-128 key length");
        }

        File checkpointFile = new File(cacheDir, "checkpoint.properties");
        Properties cp = new Properties();
        if (checkpointFile.exists()) {
            FileInputStream fis = new FileInputStream(checkpointFile);
            try { cp.load(fis); } finally { fis.close(); }
        }

        boolean isFmp4 = initUri != null;
        File initFile = null;
        if (isFmp4) {
            initFile = new File(cacheDir, "init.mp4");
            if (!initFile.exists() || initFile.length() == 0) {
                byte[] initBytes = fetchBytes(initUri, task.userAgent, task.referer);
                writeBytes(initFile, initBytes);
            }
        }

        long totalBytes = 0;
        int restored = 0;
        for (int i = 0; i < segments.size(); i++) {
            if (cancelled.get()) break;
            File segFile = new File(cacheDir, String.format("seg-%05d.bin", i));
            if ("1".equals(cp.getProperty("s" + i)) && segFile.exists() && segFile.length() > 0) {
                restored++;
                totalBytes += segFile.length();
                continue;
            }
            byte[] rawBytes = fetchBytes(segments.get(i), task.userAgent, task.referer);
            if (aesKey != null) {
                byte[] iv = explicitIv != null ? explicitIv : sequenceIv(mediaSeq + i);
                Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
                cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(aesKey, "AES"), new IvParameterSpec(iv));
                rawBytes = cipher.doFinal(rawBytes);
            }
            if (looksLikeHtmlError(rawBytes)) {
                throw new IllegalStateException("Segment " + i + " returned an HTML error page instead of media");
            }
            writeBytes(segFile, rawBytes);
            totalBytes += rawBytes.length;
            cp.setProperty("s" + i, "1");
            FileOutputStream fos = new FileOutputStream(checkpointFile);
            try { cp.store(fos, "VideoSave HLS checkpoint"); } finally { fos.close(); }

            int pct = (int) Math.min(99, ((i + 1) * 100L) / segments.size());
            String status = "HLS " + (i + 1) + "/" + segments.size() +
                    (restored > 0 ? " (resumed " + restored + ")" : "") +
                    " · " + MediaProbeEngine.formatSize(totalBytes);
            updateNotification(task.title, status, pct, false);
            broadcastProgress("downloading", status, pct, totalBytes, "");
        }

        File assembled = new File(cacheDir, isFmp4 ? "assembled.mp4" : "assembled.ts");
        FileOutputStream out = new FileOutputStream(assembled);
        try {
            if (initFile != null && initFile.exists()) copyStream(initFile, out);
            for (int i = 0; i < segments.size(); i++) {
                copyStream(new File(cacheDir, String.format("seg-%05d.bin", i)), out);
            }
        } finally {
            out.close();
        }
        return assembled;
    }

    private Uri exportToDownloads(File source, String fileName, String mimeType, String subFolder) throws Exception {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues cv = new ContentValues();
            cv.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
            cv.put(MediaStore.Downloads.MIME_TYPE, mimeType);
            cv.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + subFolder);
            cv.put(MediaStore.Downloads.IS_PENDING, 1);
            ContentResolver resolver = getContentResolver();
            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
            if (uri == null) throw new IllegalStateException("MediaStore rejected output creation");
            OutputStream os = resolver.openOutputStream(uri);
            if (os == null) throw new IllegalStateException("Could not open MediaStore output stream");
            try { copyStream(source, os); } finally { os.close(); }
            cv.clear();
            cv.put(MediaStore.Downloads.IS_PENDING, 0);
            resolver.update(uri, cv, null, null);
            return uri;
        }
        File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), subFolder);
        if (!dir.exists()) dir.mkdirs();
        File dest = new File(dir, fileName);
        FileOutputStream fos = new FileOutputStream(dest);
        try { copyStream(source, fos); } finally { fos.close(); }
        return Uri.fromFile(dest);
    }

    private byte[] fetchBytes(String url, String ua, String referer) throws Exception {
        HttpURLConnection conn = MediaProbeEngine.openConnection(url, ua, referer, null);
        int code = conn.getResponseCode();
        if (code == 401 || code == 402 || code == 403 || code == 451) {
            conn.disconnect();
            throw new IllegalStateException("HTTP " + code + " on segment/key (not bypassed)");
        }
        if (code < 200 || code >= 300) {
            conn.disconnect();
            throw new IllegalStateException("HTTP " + code + " fetching " + url);
        }
        InputStream in = conn.getInputStream();
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        try {
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) baos.write(buf, 0, n);
        } finally {
            in.close();
            conn.disconnect();
        }
        return baos.toByteArray();
    }

    private static boolean looksLikeHtmlError(byte[] data) {
        if (data == null || data.length < 12) return true;
        String head = new String(data, 0, Math.min(data.length, 64), StandardCharsets.UTF_8).trim().toLowerCase();
        return head.startsWith("<!doctype html") || head.startsWith("<html") || head.startsWith("{\"error");
    }

    private static byte[] sequenceIv(int seq) {
        byte[] iv = new byte[16];
        iv[12] = (byte) ((seq >>> 24) & 0xff);
        iv[13] = (byte) ((seq >>> 16) & 0xff);
        iv[14] = (byte) ((seq >>> 8) & 0xff);
        iv[15] = (byte) (seq & 0xff);
        return iv;
    }

    private static byte[] hexToBytes(String hex) {
        byte[] out = new byte[hex.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    private static String shaShort(String text) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 6; i++) sb.append(String.format("%02x", d[i] & 0xff));
            return sb.toString();
        } catch (Exception e) {
            return Integer.toHexString(text.hashCode());
        }
    }

    private static void writeBytes(File f, byte[] data) throws Exception {
        FileOutputStream fos = new FileOutputStream(f);
        try { fos.write(data); } finally { fos.close(); }
    }

    private static void copyStream(File src, OutputStream out) throws Exception {
        FileInputStream fis = new FileInputStream(src);
        try {
            byte[] buf = new byte[32 * 1024];
            int n;
            while ((n = fis.read(buf)) > 0) out.write(buf, 0, n);
        } finally {
            fis.close();
        }
    }

    private static void deleteRecursive(File f) {
        if (f.isDirectory()) {
            File[] children = f.listFiles();
            if (children != null) for (File c : children) deleteRecursive(c);
        }
        f.delete();
    }

    private void createNotificationChannel() {
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "VideoSave Downloads", NotificationManager.IMPORTANCE_LOW);
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.createNotificationChannel(ch);
    }

    private Notification buildNotification(String title, String text, int pct, boolean indeterminate) {
        Intent cancelIntent = new Intent(this, DownloadService.class);
        cancelIntent.setAction(ACTION_CANCEL);
        PendingIntent cancelPi = PendingIntent.getService(this, 1, cancelIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent openIntent = new Intent(this, MainActivity.class);
        PendingIntent openPi = PendingIntent.getActivity(this, 0, openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        return new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_launcher)
                .setContentTitle(title)
                .setContentText(text)
                .setProgress(100, pct, indeterminate)
                .setContentIntent(openPi)
                .addAction(new Notification.Action.Builder(null, "Cancel", cancelPi).build())
                .build();
    }

    private void updateNotification(String title, String text, int pct, boolean indeterminate) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIF_ID, buildNotification(title, text, pct, indeterminate));
    }

    private void broadcastProgress(String status, String message, int pct, long bytes, String uri) {
        Intent i = new Intent(ACTION_PROGRESS);
        i.setPackage(getPackageName());
        i.putExtra("status", status);
        i.putExtra("message", message);
        i.putExtra("percent", pct);
        i.putExtra("bytes", bytes);
        i.putExtra("uri", uri);
        sendBroadcast(i);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
