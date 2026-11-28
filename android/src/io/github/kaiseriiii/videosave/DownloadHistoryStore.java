package io.github.kaiseriiii.videosave;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Local private download history persistence (zero telemetry, zero external storage leakage).
 */
public final class DownloadHistoryStore {

    public static final class Record {
        public final String id;
        public final String title;
        public final String url;
        public final String kind;
        public final String status;
        public final String contentUri;
        public final String displayPath;
        public final long bytes;
        public final long completedAt;

        public Record(String id, String title, String url, String kind, String status,
                      String contentUri, String displayPath, long bytes, long completedAt) {
            this.id = id;
            this.title = title;
            this.url = url;
            this.kind = kind;
            this.status = status;
            this.contentUri = contentUri;
            this.displayPath = displayPath;
            this.bytes = bytes;
            this.completedAt = completedAt;
        }
    }

    private static File historyFile(Context ctx) {
        return new File(ctx.getFilesDir(), "videosave-history.json");
    }

    public static synchronized List<Record> load(Context ctx) {
        List<Record> out = new ArrayList<Record>();
        File f = historyFile(ctx);
        if (!f.exists()) return out;
        try {
            byte[] data = new byte[(int) Math.min(f.length(), 1024 * 1024)];
            FileInputStream fis = new FileInputStream(f);
            try {
                int read = fis.read(data);
                if (read <= 0) return out;
                JSONArray arr = new JSONArray(new String(data, 0, read, StandardCharsets.UTF_8));
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject o = arr.getJSONObject(i);
                    out.add(new Record(
                            o.optString("id"),
                            o.optString("title"),
                            o.optString("url"),
                            o.optString("kind"),
                            o.optString("status"),
                            o.optString("contentUri"),
                            o.optString("displayPath"),
                            o.optLong("bytes", 0),
                            o.optLong("completedAt", 0)));
                }
            } finally {
                fis.close();
            }
        } catch (Exception ignored) {}
        return out;
    }

    public static synchronized void append(Context ctx, Record rec) {
        List<Record> all = load(ctx);
        all.add(0, rec);
        if (all.size() > 100) all = all.subList(0, 100);
        try {
            JSONArray arr = new JSONArray();
            for (Record r : all) {
                JSONObject o = new JSONObject();
                o.put("id", r.id);
                o.put("title", r.title);
                o.put("url", r.url);
                o.put("kind", r.kind);
                o.put("status", r.status);
                o.put("contentUri", r.contentUri);
                o.put("displayPath", r.displayPath);
                o.put("bytes", r.bytes);
                o.put("completedAt", r.completedAt);
                arr.put(o);
            }
            FileOutputStream fos = new FileOutputStream(historyFile(ctx));
            try {
                fos.write(arr.toString(2).getBytes(StandardCharsets.UTF_8));
            } finally {
                fos.close();
            }
        } catch (Exception ignored) {}
    }
}
