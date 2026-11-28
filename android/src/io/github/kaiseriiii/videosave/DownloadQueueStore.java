package io.github.kaiseriiii.videosave;

import android.content.Context;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Persistent JSON queue store supporting multi-task Pause/Resume/Retry,
 * service restart recovery, and device reboot recovery.
 */
public final class DownloadQueueStore {

    private static final String FILE_NAME = "download_queue_v1.json";

    public static final class QueuedTask {
        public String id;
        public String url;
        public String audioUrl;
        public String title;
        public String kind;
        public String userAgent;
        public String referer;
        public String folder;
        public List<String> mirrorUrls = new ArrayList<String>();
        public List<String> audioMirrorUrls = new ArrayList<String>();
        public String status; // queued | downloading | paused | done | error | cancelled
        public int percent;
        public long bytes;
        public long totalBytes;
        public String statusText;
        public long updatedAt;
    }

    public static synchronized List<QueuedTask> load(Context ctx) {
        List<QueuedTask> out = new ArrayList<QueuedTask>();
        File f = new File(ctx.getFilesDir(), FILE_NAME);
        if (!f.exists()) return out;
        FileInputStream fis = null;
        try {
            fis = new FileInputStream(f);
            byte[] data = new byte[(int) Math.min(f.length(), 2 * 1024 * 1024)];
            int n = fis.read(data);
            if (n <= 0) return out;
            JSONArray arr = new JSONArray(new String(data, 0, n, StandardCharsets.UTF_8));
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                QueuedTask t = new QueuedTask();
                t.id = o.optString("id", "");
                t.url = o.optString("url", "");
                t.audioUrl = o.optString("audioUrl", "");
                t.title = o.optString("title", "video");
                t.kind = o.optString("kind", "mp4");
                t.userAgent = o.optString("userAgent", "");
                t.referer = o.optString("referer", "");
                t.folder = o.optString("folder", "VideoSave");
                t.status = o.optString("status", "queued");
                t.percent = o.optInt("percent", 0);
                t.bytes = o.optLong("bytes", 0);
                t.totalBytes = o.optLong("totalBytes", 0);
                t.statusText = o.optString("statusText", "");
                t.updatedAt = o.optLong("updatedAt", 0);
                JSONArray vm = o.optJSONArray("mirrorUrls");
                if (vm != null) for (int k = 0; k < vm.length(); k++) t.mirrorUrls.add(vm.optString(k));
                JSONArray am = o.optJSONArray("audioMirrorUrls");
                if (am != null) for (int k = 0; k < am.length(); k++) t.audioMirrorUrls.add(am.optString(k));
                out.add(t);
            }
        } catch (Exception ignored) {
        } finally {
            if (fis != null) try { fis.close(); } catch (Exception ignored) {}
        }
        return out;
    }

    public static synchronized void save(Context ctx, List<QueuedTask> tasks) {
        JSONArray arr = new JSONArray();
        int limit = Math.min(tasks.size(), 50);
        for (int i = 0; i < limit; i++) {
            QueuedTask t = tasks.get(i);
            try {
                JSONObject o = new JSONObject();
                o.put("id", t.id);
                o.put("url", t.url);
                o.put("audioUrl", t.audioUrl == null ? "" : t.audioUrl);
                o.put("title", t.title);
                o.put("kind", t.kind);
                o.put("userAgent", t.userAgent == null ? "" : t.userAgent);
                o.put("referer", t.referer == null ? "" : t.referer);
                o.put("folder", t.folder == null ? "VideoSave" : t.folder);
                o.put("status", t.status);
                o.put("percent", t.percent);
                o.put("bytes", t.bytes);
                o.put("totalBytes", t.totalBytes);
                o.put("statusText", t.statusText == null ? "" : t.statusText);
                o.put("updatedAt", t.updatedAt);
                JSONArray vm = new JSONArray();
                for (String u : t.mirrorUrls) vm.put(u);
                o.put("mirrorUrls", vm);
                JSONArray am = new JSONArray();
                for (String u : t.audioMirrorUrls) am.put(u);
                o.put("audioMirrorUrls", am);
                arr.put(o);
            } catch (Exception ignored) {}
        }
        File f = new File(ctx.getFilesDir(), FILE_NAME);
        File tmp = new File(ctx.getFilesDir(), FILE_NAME + ".tmp");
        FileOutputStream fos = null;
        try {
            fos = new FileOutputStream(tmp);
            fos.write(arr.toString().getBytes(StandardCharsets.UTF_8));
            fos.flush();
            fos.close();
            fos = null;
            if (f.exists()) f.delete();
            tmp.renameTo(f);
        } catch (Exception ignored) {
        } finally {
            if (fos != null) try { fos.close(); } catch (Exception ignored) {}
        }
    }

    public static synchronized void upsert(Context ctx, QueuedTask task) {
        List<QueuedTask> list = load(ctx);
        boolean found = false;
        for (int i = 0; i < list.size(); i++) {
            if (list.get(i).id.equals(task.id)) {
                list.set(i, task);
                found = true;
                break;
            }
        }
        if (!found) list.add(0, task);
        save(ctx, list);
    }

    public static synchronized void clearCompleted(Context ctx) {
        List<QueuedTask> list = load(ctx);
        List<QueuedTask> kept = new ArrayList<QueuedTask>();
        for (QueuedTask t : list) {
            if (!"done".equals(t.status) && !"cancelled".equals(t.status)) kept.add(t);
        }
        save(ctx, kept);
    }
}
