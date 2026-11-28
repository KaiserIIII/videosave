package io.github.kaiseriiii.videosave;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.IBinder;
import android.os.StatFs;
import android.provider.MediaStore;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Properties;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.crypto.Cipher;
import javax.crypto.CipherInputStream;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * VideoSave Android Foreground Download Service (v1.3.0):
 * - Real Static DASH downloader + Android MediaExtractor/MediaMuxer MP4 muxing (NEVER saves MPD XML as MP4)
 * - Strict RFC 9110 HTTP 416 / 206 resume validation via HttpRangeValidator (NEVER trusts truncated 416 files)
 * - Streaming HLS downloader with SHA-256 segment checkpoints, binary container validation,
 *   clear-key AES-128 streaming decrypt, discontinuity detection, and separate audio track muxing
 * - Native Bilibili progressive MP4 + separate DASH video/audio mirror failover & MP4 muxing
 * - Persistent multi-task queue with Pause/Resume/Retry/Cancel, Wi-Fi-only check, free disk check,
 *   post-download MediaExtractor playability check, and Scoped Storage Downloads/VideoSave export.
 */
public final class DownloadService extends Service {

    public static final String CHANNEL_ID = "videosave_downloads";
    public static final String ACTION_ENQUEUE = "io.github.kaiseriiii.videosave.ENQUEUE";
    public static final String ACTION_PAUSE = "io.github.kaiseriiii.videosave.PAUSE";
    public static final String ACTION_RESUME_ALL = "io.github.kaiseriiii.videosave.RESUME_ALL";
    public static final String ACTION_RETRY = "io.github.kaiseriiii.videosave.RETRY";
    public static final String ACTION_CANCEL = "io.github.kaiseriiii.videosave.CANCEL";
    public static final String ACTION_PROGRESS = "io.github.kaiseriiii.videosave.PROGRESS";
    private static final int NOTIF_ID = 1301;
    private static final long MIN_FREE_BYTES = 50L * 1024L * 1024L;

    private final AtomicBoolean paused = new AtomicBoolean(false);
    private final AtomicBoolean cancelAll = new AtomicBoolean(false);
    private final Set<String> cancelledTaskIds = Collections.synchronizedSet(new HashSet<String>());
    private volatile String activeTaskId = null;
    private volatile boolean workerRunning = false;

    private boolean isTaskStopped(String taskId) {
        return paused.get() || cancelAll.get() || (taskId != null && cancelledTaskIds.contains(taskId));
    }

    private boolean isTaskCancelled(String taskId) {
        return cancelAll.get() || (taskId != null && cancelledTaskIds.contains(taskId));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        pruneStaleCaches();
    }

    private void pruneStaleCaches() {
        try {
            File[] entries = getCacheDir().listFiles();
            if (entries == null) return;
            long cutoff = System.currentTimeMillis() - 48L * 60L * 60L * 1000L;
            for (File f : entries) {
                if (f.isDirectory() && f.getName().startsWith("staging-") && f.lastModified() < cutoff) {
                    deleteRecursive(f);
                }
            }
        } catch (Exception ignored) {}
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            ensureWorker();
            return START_STICKY;
        }
        String action = intent.getAction();
        if (ACTION_CANCEL.equals(action)) {
            String targetId = intent.getStringExtra("taskId");
            boolean all = (targetId == null || targetId.isEmpty());
            if (all) cancelAll.set(true);
            else cancelledTaskIds.add(targetId);

            List<DownloadQueueStore.QueuedTask> tasks = DownloadQueueStore.load(this);
            for (DownloadQueueStore.QueuedTask t : tasks) {
                if (all || targetId.equals(t.id)) {
                    if (!"done".equals(t.status)) {
                        t.status = "cancelled";
                        t.statusText = "Cancelled";
                        t.updatedAt = System.currentTimeMillis();
                        File stDir = new File(getCacheDir(), "staging-" + shaShort(t.url + "|" + (t.audioUrl == null ? "" : t.audioUrl)));
                        if (stDir.exists()) deleteRecursive(stDir);
                    }
                }
            }
            DownloadQueueStore.save(this, tasks);
            broadcastProgress("cancelled", "Download cancelled", 0, 0, "", all ? "" : targetId);
            if (all) {
                stopForeground(true);
                stopSelf();
            }
            return START_NOT_STICKY;
        }
        if (ACTION_PAUSE.equals(action)) {
            paused.set(true);
            List<DownloadQueueStore.QueuedTask> tasks = DownloadQueueStore.load(this);
            for (DownloadQueueStore.QueuedTask t : tasks) {
                if ("downloading".equals(t.status) || "queued".equals(t.status)) {
                    t.status = "paused";
                    t.statusText = "Paused (checkpoint saved)";
                    t.updatedAt = System.currentTimeMillis();
                }
            }
            DownloadQueueStore.save(this, tasks);
            updateNotification("VideoSave", "Downloads paused", 0, false, true);
            broadcastProgress("paused", "Paused (checkpoints preserved)", 0, 0, "", activeTaskId == null ? "" : activeTaskId);
            return START_STICKY;
        }
        if (ACTION_RESUME_ALL.equals(action)) {
            paused.set(false);
            cancelAll.set(false);
            cancelledTaskIds.clear();
            List<DownloadQueueStore.QueuedTask> tasks = DownloadQueueStore.load(this);
            for (DownloadQueueStore.QueuedTask t : tasks) {
                if ("paused".equals(t.status) || "downloading".equals(t.status)) {
                    t.status = "queued";
                    t.statusText = "Resuming...";
                    t.updatedAt = System.currentTimeMillis();
                }
            }
            DownloadQueueStore.save(this, tasks);
            startForeground(NOTIF_ID, buildNotification("VideoSave", "Resuming download queue...", 0, true, false));
            ensureWorker();
            return START_STICKY;
        }
        if (ACTION_RETRY.equals(action)) {
            String taskId = intent.getStringExtra("taskId");
            paused.set(false);
            cancelAll.set(false);
            if (taskId != null) cancelledTaskIds.remove(taskId);
            List<DownloadQueueStore.QueuedTask> tasks = DownloadQueueStore.load(this);
            for (DownloadQueueStore.QueuedTask t : tasks) {
                if (taskId != null && taskId.equals(t.id)) {
                    t.status = "queued";
                    t.statusText = "Retrying...";
                    t.updatedAt = System.currentTimeMillis();
                }
            }
            DownloadQueueStore.save(this, tasks);
            startForeground(NOTIF_ID, buildNotification("VideoSave", "Retrying task...", 0, true, false));
            ensureWorker();
            return START_STICKY;
        }
        if (ACTION_ENQUEUE.equals(action)) {
            paused.set(false);
            cancelAll.set(false);
            String url = intent.getStringExtra("url");
            if (url != null && !url.trim().isEmpty()) {
                String cleanUrl = url.trim();
                String audioUrl = intent.getStringExtra("audioUrl");
                // Prevent duplicate concurrent/queued identical tasks caused by double-tap or network reconnect
                for (DownloadQueueStore.QueuedTask existing : DownloadQueueStore.load(this)) {
                    if (cleanUrl.equals(existing.url) && ("queued".equals(existing.status) || "downloading".equals(existing.status))) {
                        ensureWorker();
                        return START_STICKY;
                    }
                }
                DownloadQueueStore.QueuedTask t = new DownloadQueueStore.QueuedTask();
                t.id = UUID.randomUUID().toString().substring(0, 8);
                t.url = cleanUrl;
                t.audioUrl = audioUrl;
                String title = intent.getStringExtra("title");
                t.title = (title == null || title.trim().isEmpty()) ? MediaProbeEngine.inferTitle(t.url) : title.trim();
                String kind = intent.getStringExtra("kind");
                t.kind = (kind == null || kind.isEmpty()) ? inferKindFromUrl(t.url) : kind;
                t.userAgent = intent.getStringExtra("ua");
                t.referer = intent.getStringExtra("referer");
                String folder = intent.getStringExtra("folder");
                t.folder = (folder == null || folder.trim().isEmpty()) ? "VideoSave" : folder.trim();
                ArrayList<String> vm = intent.getStringArrayListExtra("mirrorUrls");
                if (vm != null) t.mirrorUrls.addAll(vm);
                ArrayList<String> am = intent.getStringArrayListExtra("audioMirrorUrls");
                if (am != null) t.audioMirrorUrls.addAll(am);
                t.status = "queued";
                t.percent = 0;
                t.statusText = "Queued";
                t.updatedAt = System.currentTimeMillis();

                DownloadQueueStore.upsert(this, t);
                startForeground(NOTIF_ID, buildNotification("VideoSave", "Queued: " + t.title, 0, true, false));
                ensureWorker();
            }
        }
        return START_STICKY;
    }

    private static String inferKindFromUrl(String url) {
        String lower = url.toLowerCase(Locale.US);
        if (lower.contains(".m3u8")) return "hls";
        if (lower.contains(".mpd")) return "dash";
        if (lower.matches(".*\\.(m4a|mp3|aac|flac|ogg)(\\?.*)?$")) return "audio";
        return "mp4";
    }

    private synchronized void ensureWorker() {
        if (workerRunning) return;
        workerRunning = true;
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    while (!paused.get() && !cancelAll.get()) {
                        DownloadQueueStore.QueuedTask next = findNextQueuedTask();
                        if (next == null) break;
                        activeTaskId = next.id;
                        executeTask(next);
                        activeTaskId = null;
                    }
                } finally {
                    workerRunning = false;
                    activeTaskId = null;
                    if (!paused.get()) {
                        stopForeground(false);
                        stopSelf();
                    }
                }
            }
        }, "VideoSave-DownloadWorker").start();
    }

    private DownloadQueueStore.QueuedTask findNextQueuedTask() {
        List<DownloadQueueStore.QueuedTask> tasks = DownloadQueueStore.load(this);
        for (int i = tasks.size() - 1; i >= 0; i--) {
            DownloadQueueStore.QueuedTask t = tasks.get(i);
            if ("queued".equals(t.status)) return t;
        }
        return null;
    }

    private boolean isWifiRequiredAndMissing() {
        SharedPreferences sp = getSharedPreferences("videosave_prefs", MODE_PRIVATE);
        if (!sp.getBoolean("wifi_only", false)) return false;
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return false;
        Network active = cm.getActiveNetwork();
        if (active == null) return true;
        NetworkCapabilities caps = cm.getNetworkCapabilities(active);
        return caps == null || !caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
    }

    private long getFreeStorageBytes() {
        try {
            StatFs sf = new StatFs(getCacheDir().getAbsolutePath());
            return sf.getAvailableBytes();
        } catch (Exception e) {
            return Long.MAX_VALUE;
        }
    }

    private void executeTask(DownloadQueueStore.QueuedTask task) {
        try {
            if (isWifiRequiredAndMissing()) {
                task.status = "paused";
                task.statusText = "Waiting for Wi-Fi (Wi-Fi-only mode enabled)";
                task.updatedAt = System.currentTimeMillis();
                DownloadQueueStore.upsert(this, task);
                paused.set(true);
                broadcastProgress("paused", task.statusText, task.percent, task.bytes, "", task.id);
                return;
            }
            if (getFreeStorageBytes() < MIN_FREE_BYTES) {
                throw new IllegalStateException("Insufficient storage space (< 50 MB free)");
            }

            task.status = "downloading";
            task.statusText = "Starting...";
            task.updatedAt = System.currentTimeMillis();
            DownloadQueueStore.upsert(this, task);

            File cacheDir = new File(getCacheDir(), "staging-" + shaShort(task.url + "|" + (task.audioUrl == null ? "" : task.audioUrl)));
            if (!cacheDir.exists()) cacheDir.mkdirs();

            File stagedFile;
            String mime;
            String ext;
            String lowerUrl = task.url.toLowerCase(Locale.US);

            if ("dash".equals(task.kind) || lowerUrl.contains(".mpd")) {
                stagedFile = downloadStaticDash(task, cacheDir);
                mime = stagedFile.getName().endsWith(".webm") ? "video/webm" : "video/mp4";
                ext = stagedFile.getName().endsWith(".webm") ? ".webm" : ".mp4";
            } else if ("bilibili-dash".equals(task.kind)) {
                stagedFile = downloadBilibiliSeparateDash(task, cacheDir);
                mime = "video/mp4";
                ext = ".mp4";
            } else if ("bilibili-mp4".equals(task.kind)) {
                List<String> mirrors = !task.mirrorUrls.isEmpty() ? task.mirrorUrls : Collections.singletonList(task.url);
                stagedFile = downloadWithMirrorFailover(task, mirrors, new File(cacheDir, "bili.mp4.part"), "video", 0, 100);
                mime = "video/mp4";
                ext = ".mp4";
            } else if ("hls".equals(task.kind) || lowerUrl.contains(".m3u8")) {
                stagedFile = downloadHlsResumable(task, cacheDir);
                mime = stagedFile.getName().endsWith(".mp4") ? "video/mp4" : "video/mp2t";
                ext = stagedFile.getName().endsWith(".mp4") ? ".mp4" : ".ts";
            } else {
                ext = "audio".equals(task.kind) ? ".m4a" : ".mp4";
                mime = "audio".equals(task.kind) ? "audio/mp4" : "video/mp4";
                List<String> mirrors = !task.mirrorUrls.isEmpty() ? task.mirrorUrls : Collections.singletonList(task.url);
                stagedFile = downloadWithMirrorFailover(task, mirrors, new File(cacheDir, "payload" + ext + ".part"), task.kind, 0, 100);
            }

            if (isTaskStopped(task.id)) {
                if (isTaskCancelled(task.id)) deleteRecursive(cacheDir);
                return;
            }

            // Mandatory final binary container + Android MediaExtractor verification before saving!
            MediaContainerUtil.CheckResult check = MediaContainerUtil.inspectFile(stagedFile);
            if (!check.valid) {
                throw new IllegalStateException("Output rejected — invalid media container: " + check.reason);
            }
            verifyPlayableTracksWithMediaExtractor(stagedFile, "audio".equals(task.kind));

            String safeName = sanitizeFilename(task.title, task.id, ext);
            Uri savedUri = exportToDownloads(stagedFile, safeName, mime, task.folder);
            long size = stagedFile.length();
            deleteRecursive(cacheDir);

            String displayPath = "Downloads/" + task.folder + "/" + safeName;
            task.status = "done";
            task.percent = 100;
            task.bytes = size;
            task.totalBytes = size;
            task.statusText = "Saved: " + displayPath + " (" + MediaProbeEngine.formatSize(size) + ")";
            task.updatedAt = System.currentTimeMillis();
            DownloadQueueStore.upsert(this, task);

            DownloadHistoryStore.append(this, new DownloadHistoryStore.Record(
                    task.id, safeName, task.url, task.kind, "done",
                    savedUri != null ? savedUri.toString() : "",
                    displayPath, size, System.currentTimeMillis()));

            updateNotification("Completed: " + safeName, MediaProbeEngine.formatSize(size), 100, false, false);
            broadcastProgress("done", task.statusText, 100, size,
                    savedUri != null ? savedUri.toString() : "", task.id);
        } catch (Exception e) {
            if (isTaskStopped(task.id)) {
                if (isTaskCancelled(task.id)) {
                    File cDir = new File(getCacheDir(), "staging-" + shaShort(task.url + "|" + (task.audioUrl == null ? "" : task.audioUrl)));
                    if (cDir.exists()) deleteRecursive(cDir);
                }
                return;
            }
            String msg = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
            // Prune unrecoverable caches (access denied / DRM / invalid media) while preserving checkpoints for transient errors
            if (e instanceof AccessDeniedException || msg.contains("DRM") || msg.contains("invalid media")) {
                File cDir = new File(getCacheDir(), "staging-" + shaShort(task.url + "|" + (task.audioUrl == null ? "" : task.audioUrl)));
                if (cDir.exists()) deleteRecursive(cDir);
            }
            task.status = "error";
            task.percent = 0;
            task.statusText = msg;
            task.updatedAt = System.currentTimeMillis();
            DownloadQueueStore.upsert(this, task);

            DownloadHistoryStore.append(this, new DownloadHistoryStore.Record(
                    task.id, task.title, task.url, task.kind, "error", "", msg, 0, System.currentTimeMillis()));
            updateNotification("Failed: " + task.title, msg, 0, false, false);
            broadcastProgress("error", msg, 0, 0, "", task.id);
        }
    }

    /**
     * Real Static DASH downloader: parses MPD via DashEngine, rejects dynamic/DRM/unsupported
     * BEFORE writing any output, streams init + segments to disk with binary validation,
     * and muxes separate video + audio tracks into standards-compliant MP4 via MediaMuxer.
     */
    private File downloadStaticDash(DownloadQueueStore.QueuedTask task, File cacheDir) throws Exception {
        String rawUrl = task.url;
        String wantedRepId = null;
        int hashIdx = rawUrl.indexOf("#vsrep=");
        if (hashIdx > 0) {
            wantedRepId = rawUrl.substring(hashIdx + 7);
            rawUrl = rawUrl.substring(0, hashIdx);
        }

        HttpURLConnection conn = MediaProbeEngine.openConnection(rawUrl, task.userAgent, task.referer, null);
        int code = conn.getResponseCode();
        if (code == 401 || code == 402 || code == 403 || code == 451) {
            conn.disconnect();
            throw new IllegalStateException("HTTP " + code + " on DASH MPD (access denied, not bypassed)");
        }
        if (code < 200 || code >= 300) {
            conn.disconnect();
            throw new IllegalStateException("HTTP " + code + " fetching DASH MPD");
        }
        String xml = MediaProbeEngine.readLimitedText(conn.getInputStream(), 1024 * 1024);
        conn.disconnect();

        DashEngine.DashPlan plan = DashEngine.parseMpd(rawUrl, xml);
        if (!plan.supported) {
            throw new IllegalStateException("[" + plan.errorCode + "] " + plan.message);
        }

        DashEngine.DashTrack videoTrack = null;
        if (!plan.videoTracks.isEmpty()) {
            videoTrack = plan.videoTracks.get(0);
            if (wantedRepId != null) {
                for (DashEngine.DashTrack vt : plan.videoTracks) {
                    if (wantedRepId.equals(vt.id)) { videoTrack = vt; break; }
                }
            }
        }
        DashEngine.DashTrack audioTrack = !plan.audioTracks.isEmpty() ? plan.audioTracks.get(0) : null;
        if (videoTrack == null && audioTrack == null) {
            throw new IllegalStateException("DASH manifest contains no downloadable tracks");
        }

        boolean isWebm = (videoTrack != null && videoTrack.mimeType.contains("webm"))
                || (audioTrack != null && audioTrack.mimeType.contains("webm"));
        String trackExt = isWebm ? ".webm" : ".mp4";

        File videoFile = null;
        if (videoTrack != null) {
            videoFile = new File(cacheDir, "dash-video" + trackExt);
            downloadDashTrack(task, videoTrack, videoFile, audioTrack != null ? 0 : 0, audioTrack != null ? 70 : 95);
        }
        if (paused.get() || isTaskCancelled(task.id)) return videoFile != null ? videoFile : new File(cacheDir, "aborted");

        File audioFile = null;
        if (audioTrack != null) {
            audioFile = new File(cacheDir, "dash-audio" + trackExt);
            downloadDashTrack(task, audioTrack, audioFile, videoFile != null ? 70 : 0, 95);
        }
        if (isTaskStopped(task.id)) return audioFile != null ? audioFile : videoFile;

        if (videoFile != null && audioFile != null) {
            emitProgress(task, 96, videoFile.length() + audioFile.length(), 0, "Muxing DASH video + audio...");
            File muxed = new File(cacheDir, isWebm ? "dash-muxed.webm" : "dash-muxed.mp4");
            muxVideoAndAudio(videoFile, audioFile, muxed, isWebm, task.id);
            return muxed;
        }
        return videoFile != null ? videoFile : audioFile;
    }

    private void downloadDashTrack(DownloadQueueStore.QueuedTask task, DashEngine.DashTrack track,
                                   File outFile, int pctStart, int pctEnd) throws Exception {
        File segDir = new File(outFile.getParentFile(), "dash-" + track.mediaType + "-" + shaShort(track.id + track.segmentUrls.get(0)));
        if (!segDir.exists()) segDir.mkdirs();
        File cpFile = new File(segDir, "checkpoint.properties");
        Properties cp = loadProps(cpFile);

        int totalSteps = (track.initUrl != null ? 1 : 0) + track.segmentUrls.size();
        int doneSteps = 0;
        long totalBytes = 0;

        File initFile = null;
        if (track.initUrl != null) {
            initFile = new File(segDir, "init.bin");
            if (!"1".equals(cp.getProperty("init")) || !initFile.exists() || initFile.length() == 0) {
                streamUrlToFile(track.initUrl, task.userAgent, task.referer, initFile, task.id);
                if (isTaskStopped(task.id)) return;
                MediaContainerUtil.CheckResult check = MediaContainerUtil.inspectFile(initFile);
                if (!check.valid) throw new IllegalStateException("DASH init segment invalid: " + check.reason);
                cp.setProperty("init", "1");
                saveProps(cpFile, cp);
            }
            doneSteps++;
            totalBytes += initFile.length();
        }

        for (int i = 0; i < track.segmentUrls.size(); i++) {
            if (isTaskStopped(task.id)) return;
            File segFile = new File(segDir, String.format(Locale.US, "seg-%05d.bin", i));
            String expectedSha = cp.getProperty("s" + i);
            if (expectedSha != null && segFile.exists() && segFile.length() > 0 && expectedSha.equals(sha256File(segFile))) {
                totalBytes += segFile.length();
                doneSteps++;
                continue;
            }
            streamUrlToFile(track.segmentUrls.get(i), task.userAgent, task.referer, segFile, task.id);
            if (isTaskStopped(task.id)) return;
            // Validate every segment isn't an HTML/XML/JSON error page
            MediaContainerUtil.CheckResult check = MediaContainerUtil.inspectFile(segFile);
            if (!check.valid) {
                segFile.delete();
                throw new IllegalStateException("DASH " + track.mediaType + " segment " + i + " rejected: " + check.reason);
            }
            cp.setProperty("s" + i, sha256File(segFile));
            saveProps(cpFile, cp);
            totalBytes += segFile.length();
            doneSteps++;
            int pct = pctStart + (int) (((long) doneSteps * (pctEnd - pctStart)) / Math.max(1, totalSteps));
            emitProgress(task, pct, totalBytes, 0, "DASH " + track.mediaType + " " + doneSteps + "/" + totalSteps);
        }

        FileOutputStream fos = new FileOutputStream(outFile);
        try {
            if (initFile != null && initFile.exists()) copyStream(initFile, fos);
            for (int i = 0; i < track.segmentUrls.size(); i++) {
                copyStream(new File(segDir, String.format(Locale.US, "seg-%05d.bin", i)), fos);
            }
        } finally {
            fos.close();
        }
    }

    /**
     * Native Bilibili separate DASH video + audio download with official CDN mirror failover + MediaMuxer MP4 output.
     */
    private File downloadBilibiliSeparateDash(DownloadQueueStore.QueuedTask task, File cacheDir) throws Exception {
        List<String> vMirrors = !task.mirrorUrls.isEmpty() ? task.mirrorUrls : Collections.singletonList(task.url);
        File videoFile = downloadWithMirrorFailover(task, vMirrors, new File(cacheDir, "bili-video.m4s.part"), "video", 0, 75);
        if (isTaskStopped(task.id)) return videoFile;

        if (task.audioUrl != null && !task.audioUrl.isEmpty()) {
            List<String> aMirrors = !task.audioMirrorUrls.isEmpty() ? task.audioMirrorUrls : Collections.singletonList(task.audioUrl);
            File audioFile = downloadWithMirrorFailover(task, aMirrors, new File(cacheDir, "bili-audio.m4s.part"), "audio", 75, 95);
            if (isTaskStopped(task.id)) return audioFile;
            emitProgress(task, 96, videoFile.length() + audioFile.length(), 0, "Muxing Bilibili MP4...");
            File muxed = new File(cacheDir, "bili-muxed.mp4");
            muxVideoAndAudio(videoFile, audioFile, muxed, false, task.id);
            return muxed;
        }
        return videoFile;
    }

    private File downloadWithMirrorFailover(DownloadQueueStore.QueuedTask task, List<String> mirrors,
                                            File partFile, String label, int pctStart, int pctEnd) throws Exception {
        Exception lastErr = null;
        for (int i = 0; i < mirrors.size(); i++) {
            if (isTaskStopped(task.id)) return partFile;
            String mirrorUrl = mirrors.get(i);
            try {
                return downloadHttpRangeStrict(task, mirrorUrl, partFile, label, pctStart, pctEnd, 0);
            } catch (AccessDeniedException ade) {
                throw ade; // NEVER fail over or retry HTTP 401/402/403/451/567 access/policy denials!
            } catch (Exception e) {
                lastErr = e;
            }
        }
        throw lastErr != null ? lastErr : new IllegalStateException("All mirrors failed for " + label);
    }

    private static final class AccessDeniedException extends IllegalStateException {
        AccessDeniedException(String msg) { super(msg); }
    }

    /**
     * Strict RFC 9110 resumable HTTP Range downloader using HttpRangeValidator.
     * - Persists expectedTotal, ETag, and Last-Modified in range-meta.properties.
     * - Sends If-Range on resume.
     * - On HTTP 416: verifies Content-Range / HEAD total, ETag, Last-Modified, and binary media magic
     *   before EVER accepting partFile as complete; otherwise wipes stale .part and restarts cleanly.
     * - Verifies received bytes == expectedTotal on stream completion (never accepts truncated EOF).
     */
    private File downloadHttpRangeStrict(DownloadQueueStore.QueuedTask task, String targetUrl, File partFile,
                                         String label, int pctStart, int pctEnd, int restartDepth) throws Exception {
        File metaFile = new File(partFile.getParentFile(), partFile.getName() + ".meta");
        Properties meta = loadProps(metaFile);
        long existing = partFile.exists() ? partFile.length() : 0L;
        long storedTotal = parseLongSafe(meta.getProperty("total"), -1L);
        String storedEtag = meta.getProperty("etag", "");
        String storedLastMod = meta.getProperty("lastMod", "");

        String rangeHeader = existing > 0 ? ("bytes=" + existing + "-") : null;
        String ifRange = existing > 0 ? (!storedEtag.isEmpty() ? storedEtag : (!storedLastMod.isEmpty() ? storedLastMod : null)) : null;

        HttpURLConnection conn = MediaProbeEngine.openConnection(targetUrl, task.userAgent, task.referer, rangeHeader, ifRange);
        int code = conn.getResponseCode();
        String respEtag = conn.getHeaderField("ETag");
        String respLastMod = conn.getHeaderField("Last-Modified");
        String respContentRange = conn.getHeaderField("Content-Range");
        String respContentType = conn.getContentType() == null ? "" : conn.getContentType().toLowerCase(Locale.US);

        if (code == 401 || code == 402 || code == 403 || code == 451 || code == 567) {
            conn.disconnect();
            throw new AccessDeniedException("HTTP " + code + " — Access denied by server (not bypassed)");
        }

        if (code == 416) {
            conn.disconnect();
            long headTotal = -1L;
            if (HttpRangeValidator.parse416TotalLength(respContentRange) <= 0) {
                headTotal = probeServerLength(targetUrl, task.userAgent, task.referer);
            }
            HttpRangeValidator.ValidationOutcome outcome = HttpRangeValidator.evaluate416(
                    existing, storedTotal, respContentRange, headTotal,
                    storedEtag, respEtag, storedLastMod, respLastMod, partFile);
            if (outcome.decision == HttpRangeValidator.Decision.COMPLETE_VERIFIED) {
                return partFile;
            }
            // Reject broken/truncated 416 partial file and cleanly restart once from byte 0
            partFile.delete();
            metaFile.delete();
            if (restartDepth < 1) {
                return downloadHttpRangeStrict(task, targetUrl, partFile, label, pctStart, pctEnd, restartDepth + 1);
            }
            throw new IllegalStateException("HTTP 416 range validation failed: " + outcome.reason);
        }

        if (code < 200 || code >= 300) {
            conn.disconnect();
            throw new IllegalStateException("HTTP " + code + " download error");
        }
        if (respContentType.contains("text/html") || respContentType.contains("application/json")
                || respContentType.contains("dash+xml") || respContentType.contains("text/xml")) {
            conn.disconnect();
            throw new IllegalStateException("Server returned non-media Content-Type: " + respContentType);
        }

        boolean append = false;
        long total = -1L;
        if (code == 206 && existing > 0) {
            HttpRangeValidator.ValidationOutcome v206 = HttpRangeValidator.evaluate206(
                    existing, storedTotal, respContentRange, storedEtag, respEtag, storedLastMod, respLastMod);
            if (v206.decision == HttpRangeValidator.Decision.APPEND_VERIFIED) {
                append = true;
                total = v206.verifiedTotalLength > 0 ? v206.verifiedTotalLength : storedTotal;
            } else {
                conn.disconnect();
                partFile.delete();
                metaFile.delete();
                if (restartDepth < 1) {
                    return downloadHttpRangeStrict(task, targetUrl, partFile, label, pctStart, pctEnd, restartDepth + 1);
                }
                throw new IllegalStateException("HTTP 206 resume validation failed: " + v206.reason);
            }
        } else {
            existing = 0L;
            total = MediaProbeEngine.parseContentLength(conn);
        }

        if (total > 0) meta.setProperty("total", String.valueOf(total));
        if (respEtag != null && !respEtag.isEmpty()) meta.setProperty("etag", respEtag);
        if (respLastMod != null && !respLastMod.isEmpty()) meta.setProperty("lastMod", respLastMod);
        saveProps(metaFile, meta);

        RandomAccessFile raf = new RandomAccessFile(partFile, "rw");
        InputStream in = conn.getInputStream();
        long done = existing;
        try {
            if (append) raf.seek(existing);
            else raf.setLength(0);
            byte[] buf = new byte[32 * 1024];
            long lastEmit = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                if (isTaskStopped(task.id)) return partFile;
                raf.write(buf, 0, n);
                done += n;
                long now = System.currentTimeMillis();
                if (now - lastEmit >= 350) {
                    lastEmit = now;
                    int frac = total > 0 ? (int) Math.min(100, (done * 100L) / total) : 50;
                    int pct = pctStart + ((frac * (pctEnd - pctStart)) / 100);
                    String text = label + " · " + MediaProbeEngine.formatSize(done)
                            + (total > 0 ? " / " + MediaProbeEngine.formatSize(total) : "");
                    emitProgress(task, pct, done, total, text);
                }
            }
        } finally {
            in.close();
            raf.close();
            conn.disconnect();
        }

        if (total > 0 && done != total) {
            throw new IllegalStateException("Truncated download (" + done + " / " + total + " bytes) — checkpoint kept for resume");
        }
        MediaContainerUtil.CheckResult check = MediaContainerUtil.inspectFile(partFile);
        if (!check.valid) {
            partFile.delete();
            metaFile.delete();
            throw new IllegalStateException("Downloaded payload failed media verification: " + check.reason);
        }
        return partFile;
    }

    private long probeServerLength(String urlStr, String ua, String referer) {
        try {
            HttpURLConnection c = MediaProbeEngine.openConnection(urlStr, ua, referer, "bytes=0-0");
            int code = c.getResponseCode();
            long len = (code == 206 || code == 200) ? MediaProbeEngine.parseContentLength(c) : -1L;
            c.disconnect();
            return len;
        } catch (Exception e) {
            return -1L;
        }
    }

    /**
     * Streaming HLS downloader with SHA-256 checkpoints, binary header inspection,
     * streaming AES-128 decryption, discontinuity guard, and independent audio track muxing.
     */
    private File downloadHlsResumable(DownloadQueueStore.QueuedTask task, File cacheDir) throws Exception {
        File videoAssembled = downloadSingleHlsPlaylist(task, task.url, new File(cacheDir, "hls-video"),
                task.audioUrl != null && !task.audioUrl.isEmpty() ? 0 : 0,
                task.audioUrl != null && !task.audioUrl.isEmpty() ? 75 : 95);
        if (isTaskStopped(task.id)) return videoAssembled;

        if (task.audioUrl != null && !task.audioUrl.isEmpty()) {
            File audioAssembled = downloadSingleHlsPlaylist(task, task.audioUrl, new File(cacheDir, "hls-audio"), 75, 95);
            if (isTaskStopped(task.id)) return audioAssembled;
            emitProgress(task, 96, videoAssembled.length() + audioAssembled.length(), 0, "Muxing HLS video + audio...");
            File muxed = new File(cacheDir, "hls-muxed.mp4");
            muxVideoAndAudio(videoAssembled, audioAssembled, muxed, false, task.id);
            return muxed;
        }
        return videoAssembled;
    }

    private File downloadSingleHlsPlaylist(DownloadQueueStore.QueuedTask task, String playlistUrl,
                                           File workDir, int pctStart, int pctEnd) throws Exception {
        if (!workDir.exists()) workDir.mkdirs();
        HttpURLConnection conn = MediaProbeEngine.openConnection(playlistUrl, task.userAgent, task.referer, null);
        int code = conn.getResponseCode();
        if (code == 401 || code == 402 || code == 403 || code == 451) {
            conn.disconnect();
            throw new AccessDeniedException("HTTP " + code + " on HLS playlist");
        }
        if (code < 200 || code >= 300) {
            conn.disconnect();
            throw new IllegalStateException("HTTP " + code + " fetching HLS playlist");
        }
        String playlist = MediaProbeEngine.readLimitedText(conn.getInputStream(), 1024 * 1024);
        conn.disconnect();
        if (playlist.contains("SAMPLE-AES") || playlist.contains("com.apple.streamingkeydelivery")) {
            throw new IllegalStateException("DRM-protected HLS (SAMPLE-AES/FairPlay) is not supported");
        }

        URL base = new URL(playlistUrl);
        List<String> segments = new ArrayList<String>();
        List<String> initUris = new ArrayList<String>();
        String keyUri = null;
        byte[] explicitIv = null;
        int mediaSeq = 0;
        boolean hasDiscontinuity = false;

        for (String raw : playlist.split("\\r?\\n")) {
            String line = raw.trim();
            if (line.isEmpty()) continue;
            if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
                mediaSeq = Integer.parseInt(line.substring(22).trim());
            } else if (line.startsWith("#EXT-X-DISCONTINUITY")) {
                hasDiscontinuity = true;
            } else if (line.startsWith("#EXT-X-MAP:")) {
                Matcher m = Pattern.compile("URI=\"([^\"]+)\"").matcher(line);
                if (m.find()) initUris.add(new URL(base, m.group(1)).toString());
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
        if (hasDiscontinuity && initUris.size() > 1) {
            throw new IllegalStateException("Multi-init discontinuous fMP4 HLS requires desktop FFmpeg remux (not concatenated blindly)");
        }

        byte[] aesKey = null;
        if (keyUri != null) {
            File keyFile = new File(workDir, "aes.key");
            streamUrlToFile(keyUri, task.userAgent, task.referer, keyFile, task.id);
            if (isTaskStopped(task.id)) return new File(workDir, "aborted");
            if (keyFile.length() != 16) throw new IllegalStateException("Invalid AES-128 key length");
            aesKey = readAllSmall(keyFile);
            keyFile.delete();
        }

        File cpFile = new File(workDir, "checkpoint.properties");
        Properties cp = loadProps(cpFile);
        boolean isFmp4 = !initUris.isEmpty();
        File initFile = null;
        if (isFmp4) {
            initFile = new File(workDir, "init.mp4");
            if (!"1".equals(cp.getProperty("init")) || !initFile.exists() || initFile.length() == 0) {
                streamUrlToFile(initUris.get(0), task.userAgent, task.referer, initFile, task.id);
                if (isTaskStopped(task.id)) return new File(workDir, "aborted");
                MediaContainerUtil.CheckResult ic = MediaContainerUtil.inspectFile(initFile);
                if (!ic.valid) throw new IllegalStateException("Invalid HLS init segment: " + ic.reason);
                cp.setProperty("init", "1");
                saveProps(cpFile, cp);
            }
        }

        long totalBytes = initFile != null && initFile.exists() ? initFile.length() : 0;
        int restored = 0;
        String firstFormat = null;

        for (int i = 0; i < segments.size(); i++) {
            if (isTaskStopped(task.id)) return new File(workDir, "aborted");
            File segFile = new File(workDir, String.format(Locale.US, "seg-%05d.bin", i));
            String savedSha = cp.getProperty("s" + i);
            if (savedSha != null && segFile.exists() && segFile.length() > 0 && savedSha.equals(sha256File(segFile))) {
                restored++;
                totalBytes += segFile.length();
                continue;
            }
            if (aesKey != null) {
                byte[] iv = explicitIv != null ? explicitIv : sequenceIv(mediaSeq + i);
                streamUrlDecryptedToFile(segments.get(i), task.userAgent, task.referer, aesKey, iv, segFile, task.id);
            } else {
                streamUrlToFile(segments.get(i), task.userAgent, task.referer, segFile, task.id);
            }
            if (isTaskStopped(task.id)) {
                segFile.delete();
                return new File(workDir, "aborted");
            }
            MediaContainerUtil.CheckResult sc = MediaContainerUtil.inspectFile(segFile);
            if (!sc.valid) {
                segFile.delete();
                throw new IllegalStateException("HLS segment " + i + " rejected: " + sc.reason);
            }
            if (firstFormat == null) firstFormat = sc.format;
            else if (!firstFormat.equals(sc.format) && !(firstFormat.startsWith("mpegts") && sc.format.startsWith("mpegts"))) {
                throw new IllegalStateException("Incompatible HLS segment container switch (" + firstFormat + " -> " + sc.format + "); refusing blind concat");
            }
            cp.setProperty("s" + i, sha256File(segFile));
            saveProps(cpFile, cp);
            totalBytes += segFile.length();

            int pct = pctStart + (int) (((long) (i + 1) * (pctEnd - pctStart)) / segments.size());
            String status = "HLS " + (i + 1) + "/" + segments.size()
                    + (restored > 0 ? " (resumed " + restored + ")" : "")
                    + " · " + MediaProbeEngine.formatSize(totalBytes);
            emitProgress(task, pct, totalBytes, 0, status);
        }

        File assembled = new File(workDir, isFmp4 ? "assembled.mp4" : "assembled.ts");
        FileOutputStream out = new FileOutputStream(assembled);
        try {
            if (initFile != null && initFile.exists()) copyStream(initFile, out);
            for (int i = 0; i < segments.size(); i++) {
                copyStream(new File(workDir, String.format(Locale.US, "seg-%05d.bin", i)), out);
            }
        } finally {
            out.close();
        }
        return assembled;
    }

    /**
     * Mux separate video and audio files into a single playable MP4/WebM using Android's built-in
     * MediaExtractor + MediaMuxer (zero external binaries, streaming sample-by-sample, low RAM).
     */
    private void muxVideoAndAudio(File videoFile, File audioFile, File outFile, boolean isWebm, String taskId) throws Exception {
        MediaExtractor vEx = new MediaExtractor();
        MediaExtractor aEx = new MediaExtractor();
        MediaMuxer muxer = null;
        try {
            vEx.setDataSource(videoFile.getAbsolutePath());
            aEx.setDataSource(audioFile.getAbsolutePath());

            int vSrcIdx = findTrackIndex(vEx, "video/");
            int aSrcIdx = findTrackIndex(aEx, "audio/");
            if (vSrcIdx < 0) throw new IllegalStateException("No decodable video track found for muxing");
            if (aSrcIdx < 0) throw new IllegalStateException("No decodable audio track found for muxing");

            int format = isWebm ? MediaMuxer.OutputFormat.MUXER_OUTPUT_WEBM : MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4;
            muxer = new MediaMuxer(outFile.getAbsolutePath(), format);
            vEx.selectTrack(vSrcIdx);
            aEx.selectTrack(aSrcIdx);

            int vDstIdx = muxer.addTrack(vEx.getTrackFormat(vSrcIdx));
            int aDstIdx = muxer.addTrack(aEx.getTrackFormat(aSrcIdx));
            muxer.start();

            ByteBuffer buffer = ByteBuffer.allocate(512 * 1024);
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            copyExtractorTrack(vEx, muxer, vDstIdx, buffer, info, taskId);
            if (!isTaskStopped(taskId)) copyExtractorTrack(aEx, muxer, aDstIdx, buffer, info, taskId);
            muxer.stop();
        } finally {
            if (muxer != null) try { muxer.release(); } catch (Exception ignored) {}
            try { vEx.release(); } catch (Exception ignored) {}
            try { aEx.release(); } catch (Exception ignored) {}
        }
    }

    private void copyExtractorTrack(MediaExtractor ex, MediaMuxer muxer, int dstTrack,
                                    ByteBuffer buf, MediaCodec.BufferInfo info, String taskId) {
        long lastPts = -1;
        while (!isTaskStopped(taskId)) {
            buf.clear();
            int sampleSize = ex.readSampleData(buf, 0);
            if (sampleSize < 0) break;
            long pts = ex.getSampleTime();
            if (pts < 0) pts = lastPts >= 0 ? lastPts + 1 : 0;
            if (pts < lastPts) pts = lastPts;
            lastPts = pts;
            info.offset = 0;
            info.size = sampleSize;
            info.presentationTimeUs = pts;
            info.flags = ex.getSampleFlags();
            muxer.writeSampleData(dstTrack, buf, info);
            ex.advance();
        }
    }

    private static int findTrackIndex(MediaExtractor ex, String mimePrefix) {
        int count = ex.getTrackCount();
        for (int i = 0; i < count; i++) {
            MediaFormat fmt = ex.getTrackFormat(i);
            String mime = fmt.getString(MediaFormat.KEY_MIME);
            if (mime != null && mime.startsWith(mimePrefix)) return i;
        }
        return -1;
    }

    private static void verifyPlayableTracksWithMediaExtractor(File file, boolean audioOnly) throws Exception {
        if (file == null || !file.exists() || file.length() < 128) {
            throw new IllegalStateException("Output media file missing or truncated");
        }
        MediaExtractor ex = new MediaExtractor();
        try {
            ex.setDataSource(file.getAbsolutePath());
            int tracks = ex.getTrackCount();
            if (tracks <= 0) throw new IllegalStateException("Output media contains zero playable tracks");
            int vIdx = findTrackIndex(ex, "video/");
            int aIdx = findTrackIndex(ex, "audio/");
            if (audioOnly && aIdx < 0) throw new IllegalStateException("Audio output contains no audio track");
            if (!audioOnly && vIdx < 0) throw new IllegalStateException("Video output contains no playable video track");
        } finally {
            try { ex.release(); } catch (Exception ignored) {}
        }
    }

    private void streamUrlToFile(String url, String ua, String referer, File dest, String taskId) throws Exception {
        HttpURLConnection conn = MediaProbeEngine.openConnection(url, ua, referer, null);
        int code = conn.getResponseCode();
        if (code == 401 || code == 402 || code == 403 || code == 451 || code == 567) {
            conn.disconnect();
            throw new AccessDeniedException("HTTP " + code + " on segment/key (not bypassed)");
        }
        if (code < 200 || code >= 300) {
            conn.disconnect();
            throw new IllegalStateException("HTTP " + code + " fetching " + url);
        }
        InputStream in = conn.getInputStream();
        FileOutputStream fos = new FileOutputStream(dest);
        try {
            byte[] buf = new byte[32 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                if (isTaskStopped(taskId)) return;
                fos.write(buf, 0, n);
            }
        } finally {
            fos.close();
            in.close();
            conn.disconnect();
        }
    }

    private void streamUrlDecryptedToFile(String url, String ua, String referer,
                                          byte[] key, byte[] iv, File dest, String taskId) throws Exception {
        HttpURLConnection conn = MediaProbeEngine.openConnection(url, ua, referer, null);
        int code = conn.getResponseCode();
        if (code == 401 || code == 402 || code == 403 || code == 451 || code == 567) {
            conn.disconnect();
            throw new AccessDeniedException("HTTP " + code + " on encrypted segment");
        }
        if (code < 200 || code >= 300) {
            conn.disconnect();
            throw new IllegalStateException("HTTP " + code + " fetching " + url);
        }
        Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new IvParameterSpec(iv));
        InputStream cin = new CipherInputStream(conn.getInputStream(), cipher);
        FileOutputStream fos = new FileOutputStream(dest);
        try {
            byte[] buf = new byte[32 * 1024];
            int n;
            while ((n = cin.read(buf)) > 0) {
                if (isTaskStopped(taskId)) return;
                fos.write(buf, 0, n);
            }
        } finally {
            fos.close();
            cin.close();
            conn.disconnect();
        }
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
        File dest = uniqueFile(dir, fileName);
        FileOutputStream fos = new FileOutputStream(dest);
        try { copyStream(source, fos); } finally { fos.close(); }
        return Uri.fromFile(dest);
    }

    private static File uniqueFile(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) return f;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 2; i < 1000; i++) {
            File cand = new File(dir, base + " (" + i + ")" + ext);
            if (!cand.exists()) return cand;
        }
        return new File(dir, base + "_" + System.currentTimeMillis() + ext);
    }

    private static String sanitizeFilename(String title, String id, String ext) {
        String safe = (title == null ? "" : title).replaceAll("[^a-zA-Z0-9\\u4e00-\\u9fa5._ -]", "_").trim();
        if (safe.length() > 80) safe = safe.substring(0, 80).trim();
        if (safe.isEmpty()) safe = "video_" + id;
        if (!safe.toLowerCase(Locale.US).endsWith(ext)) safe = safe + ext;
        return safe;
    }

    private void emitProgress(DownloadQueueStore.QueuedTask task, int pct, long bytes, long total, String text) {
        task.percent = Math.max(0, Math.min(99, pct));
        task.bytes = bytes;
        if (total > 0) task.totalBytes = total;
        task.statusText = text;
        task.updatedAt = System.currentTimeMillis();
        DownloadQueueStore.upsert(this, task);
        updateNotification(task.title, text, task.percent, false, false);
        broadcastProgress("downloading", text, task.percent, bytes, "", task.id);
    }

    private static Properties loadProps(File f) {
        Properties p = new Properties();
        if (!f.exists()) return p;
        FileInputStream fis = null;
        try {
            fis = new FileInputStream(f);
            p.load(fis);
        } catch (Exception ignored) {
        } finally {
            if (fis != null) try { fis.close(); } catch (Exception ignored) {}
        }
        return p;
    }

    private static void saveProps(File f, Properties p) {
        FileOutputStream fos = null;
        try {
            fos = new FileOutputStream(f);
            p.store(fos, "VideoSave checkpoint");
        } catch (Exception ignored) {
        } finally {
            if (fos != null) try { fos.close(); } catch (Exception ignored) {}
        }
    }

    private static String sha256File(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        FileInputStream fis = new FileInputStream(f);
        try {
            byte[] buf = new byte[32 * 1024];
            int n;
            while ((n = fis.read(buf)) > 0) md.update(buf, 0, n);
        } finally {
            fis.close();
        }
        byte[] d = md.digest();
        StringBuilder sb = new StringBuilder();
        for (byte b : d) sb.append(String.format(Locale.US, "%02x", b & 0xff));
        return sb.toString();
    }

    private static byte[] readAllSmall(File f) throws Exception {
        byte[] buf = new byte[(int) f.length()];
        FileInputStream fis = new FileInputStream(f);
        try {
            int off = 0;
            while (off < buf.length) {
                int n = fis.read(buf, off, buf.length - off);
                if (n < 0) break;
                off += n;
            }
        } finally {
            fis.close();
        }
        return buf;
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
            for (int i = 0; i < 6; i++) sb.append(String.format(Locale.US, "%02x", d[i] & 0xff));
            return sb.toString();
        } catch (Exception e) {
            return Integer.toHexString(text.hashCode());
        }
    }

    private static long parseLongSafe(String s, long def) {
        if (s == null || s.isEmpty()) return def;
        try { return Long.parseLong(s.trim()); } catch (Exception e) { return def; }
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

    private Notification buildNotification(String title, String text, int pct, boolean indeterminate, boolean isPaused) {
        Intent toggleIntent = new Intent(this, DownloadService.class);
        toggleIntent.setAction(isPaused ? ACTION_RESUME_ALL : ACTION_PAUSE);
        PendingIntent togglePi = PendingIntent.getService(this, 2, toggleIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

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
                .addAction(new Notification.Action.Builder(null, isPaused ? "Resume" : "Pause", togglePi).build())
                .addAction(new Notification.Action.Builder(null, "Cancel", cancelPi).build())
                .build();
    }

    private void updateNotification(String title, String text, int pct, boolean indeterminate, boolean isPaused) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIF_ID, buildNotification(title, text, pct, indeterminate, isPaused));
    }

    private void broadcastProgress(String status, String message, int pct, long bytes, String uri, String taskId) {
        Intent i = new Intent(ACTION_PROGRESS);
        i.setPackage(getPackageName());
        i.putExtra("status", status);
        i.putExtra("message", message);
        i.putExtra("percent", pct);
        i.putExtra("bytes", bytes);
        i.putExtra("uri", uri);
        i.putExtra("taskId", taskId);
        sendBroadcast(i);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
