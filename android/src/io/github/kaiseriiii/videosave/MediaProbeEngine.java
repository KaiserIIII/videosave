package io.github.kaiseriiii.videosave;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Native Android media probe engine (v1.3.0) supporting:
 * - Native Bilibili (bare BV, bilibili.com/video, b23.tv) with CDN mirror ranking
 * - Direct HTTP media (2-byte Range probe)
 * - HLS Master/Variant playlists (with 2-byte Range availability check & independent audio track parsing)
 * - Static DASH MPDs (strictly validating static/non-DRM/supported templates via DashEngine)
 * - HTML page static media extraction
 * Strictly respects HTTP 401/403/451 access controls and DRM declarations without circumvention.
 */
public final class MediaProbeEngine {

    public static final class QualityCandidate {
        public final String label;
        public final String url;
        public final String kind; // mp4 | hls | dash | audio | bilibili-mp4 | bilibili-dash
        public final int height;
        public final long bandwidth;
        public final long contentLength;
        public final String availability; // available | unavailable | restricted | drm | unsupported | unknown
        public final int probeStatus;
        public final String audioUrl;
        public final List<String> mirrorUrls;
        public final List<String> audioMirrorUrls;
        public final String refererOverride;

        public QualityCandidate(String label, String url, String kind, int height,
                                long bandwidth, long contentLength, String availability, int probeStatus) {
            this(label, url, kind, height, bandwidth, contentLength, availability, probeStatus,
                    null, Collections.<String>emptyList(), Collections.<String>emptyList(), null);
        }

        public QualityCandidate(String label, String url, String kind, int height,
                                long bandwidth, long contentLength, String availability, int probeStatus,
                                String audioUrl, List<String> mirrorUrls, List<String> audioMirrorUrls,
                                String refererOverride) {
            this.label = label;
            this.url = url;
            this.kind = kind;
            this.height = height;
            this.bandwidth = bandwidth;
            this.contentLength = contentLength;
            this.availability = availability;
            this.probeStatus = probeStatus;
            this.audioUrl = audioUrl;
            this.mirrorUrls = mirrorUrls == null ? Collections.<String>emptyList() : mirrorUrls;
            this.audioMirrorUrls = audioMirrorUrls == null ? Collections.<String>emptyList() : audioMirrorUrls;
            this.refererOverride = refererOverride;
        }
    }

    public static final class ProbeResult {
        public final String inputUrl;
        public final String title;
        public final String status; // ok | restricted | drm | unsupported | no-media | error
        public final String message;
        public final List<QualityCandidate> candidates;

        public ProbeResult(String inputUrl, String title, String status, String message, List<QualityCandidate> candidates) {
            this.inputUrl = inputUrl;
            this.title = title;
            this.status = status;
            this.message = message;
            this.candidates = candidates;
        }
    }

    private static final Pattern RES_PATTERN = Pattern.compile("RESOLUTION=\\d+x(\\d+)");
    private static final Pattern BW_PATTERN = Pattern.compile("BANDWIDTH=(\\d+)");
    private static final Pattern AUDIO_GROUP_PATTERN = Pattern.compile("AUDIO=\"([^\"]+)\"");
    private static final Pattern GROUP_ID_PATTERN = Pattern.compile("GROUP-ID=\"([^\"]+)\"");
    private static final Pattern URI_ATTR_PATTERN = Pattern.compile("URI=\"([^\"]+)\"");
    private static final Pattern TITLE_PATTERN = Pattern.compile("<title[^>]*>([^<]{1,140})</title>", Pattern.CASE_INSENSITIVE);
    private static final Pattern MEDIA_URL_PATTERN = Pattern.compile(
            "(https?://[^\"'\\s<>]+\\.(?:m3u8|mpd|mp4|m4a|mp3|webm)(?:\\?[^\"'\\s<>]*)?)",
            Pattern.CASE_INSENSITIVE);

    public static HttpURLConnection openConnection(String rawUrl, String userAgent, String referer, String rangeHeader) throws Exception {
        return openConnection(rawUrl, userAgent, referer, rangeHeader, null);
    }

    public static HttpURLConnection openConnection(String rawUrl, String userAgent, String referer,
                                                   String rangeHeader, String ifRange) throws Exception {
        URL u = new URL(rawUrl);
        if (!"http".equalsIgnoreCase(u.getProtocol()) && !"https".equalsIgnoreCase(u.getProtocol())) {
            throw new IllegalArgumentException("Only HTTP/HTTPS URLs are supported");
        }
        HttpURLConnection conn = (HttpURLConnection) u.openConnection();
        conn.setConnectTimeout(12000);
        conn.setReadTimeout(20000);
        conn.setInstanceFollowRedirects(true);
        conn.setRequestProperty("User-Agent", (userAgent != null && !userAgent.trim().isEmpty())
                ? userAgent.trim()
                : "VideoSave-Android/1.3.0");
        if (referer != null && !referer.trim().isEmpty()) {
            conn.setRequestProperty("Referer", referer.trim());
        }
        if (rangeHeader != null && !rangeHeader.isEmpty()) {
            conn.setRequestProperty("Range", rangeHeader);
        }
        if (ifRange != null && !ifRange.isEmpty()) {
            conn.setRequestProperty("If-Range", ifRange);
        }
        return conn;
    }

    public static ProbeResult probe(String rawUrl, String userAgent, String referer) {
        try {
            String trimmed = rawUrl == null ? "" : rawUrl.trim();
            if (trimmed.isEmpty()) {
                return new ProbeResult("", "", "error", "Empty URL", Collections.<QualityCandidate>emptyList());
            }

            // 1. Native Bilibili support (bare BV, bilibili.com/video, b23.tv)
            if (BilibiliResolver.isBilibiliInput(trimmed)) {
                return BilibiliResolver.probe(trimmed);
            }

            String lower = trimmed.toLowerCase(Locale.US);

            // 2. HLS Playlist
            if (lower.contains(".m3u8")) {
                return probeHls(trimmed, userAgent, referer);
            }
            // 3. DASH MPD (validated through real DashEngine!)
            if (lower.contains(".mpd")) {
                return probeDash(trimmed, userAgent, referer);
            }

            // 4. Direct HTTP Range probe (2 bytes)
            HttpURLConnection conn = openConnection(trimmed, userAgent, referer, "bytes=0-1");
            int code = conn.getResponseCode();
            String ct = conn.getContentType() == null ? "" : conn.getContentType().toLowerCase(Locale.US);
            long totalLen = parseContentLength(conn);
            conn.disconnect();

            if (code == 401 || code == 402 || code == 403 || code == 451) {
                return new ProbeResult(trimmed, inferTitle(trimmed), "restricted",
                        "HTTP " + code + " — Access restricted by server (not bypassed)", Collections.<QualityCandidate>emptyList());
            }
            if (code >= 400) {
                return new ProbeResult(trimmed, inferTitle(trimmed), "no-media",
                        "HTTP " + code + " — Resource unavailable", Collections.<QualityCandidate>emptyList());
            }
            if (ct.contains("mpegurl")) {
                return probeHls(trimmed, userAgent, referer);
            }
            if (ct.contains("dash+xml")) {
                return probeDash(trimmed, userAgent, referer);
            }
            if (ct.startsWith("video/") || ct.startsWith("audio/") || ct.equals("application/octet-stream")
                    || lower.matches(".*\\.(mp4|m4a|mp3|webm|mkv|mov|aac|flac)(\\?.*)?$")) {
                String kind = ct.startsWith("audio/") || lower.matches(".*\\.(m4a|mp3|aac|flac)(\\?.*)?$") ? "audio" : "mp4";
                List<QualityCandidate> list = new ArrayList<QualityCandidate>();
                list.add(new QualityCandidate(
                        ("audio".equals(kind) ? "Audio" : "Direct Media") + (totalLen > 0 ? " (" + formatSize(totalLen) + ")" : ""),
                        trimmed, kind, 0, 0, totalLen, "available", code));
                return new ProbeResult(trimmed, inferTitle(trimmed), "ok", "Direct media ready", list);
            }

            // 5. HTML page scan
            return probeHtmlPage(trimmed, userAgent, referer);
        } catch (Exception e) {
            return new ProbeResult(rawUrl, "", "error", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage(),
                    Collections.<QualityCandidate>emptyList());
        }
    }

    private static ProbeResult probeHls(String m3u8Url, String ua, String referer) throws Exception {
        HttpURLConnection conn = openConnection(m3u8Url, ua, referer, null);
        int code = conn.getResponseCode();
        if (code == 401 || code == 402 || code == 403 || code == 451) {
            conn.disconnect();
            return new ProbeResult(m3u8Url, inferTitle(m3u8Url), "restricted",
                    "HTTP " + code + " on HLS playlist", Collections.<QualityCandidate>emptyList());
        }
        if (code >= 400) {
            conn.disconnect();
            return new ProbeResult(m3u8Url, inferTitle(m3u8Url), "no-media",
                    "HTTP " + code + " on HLS playlist", Collections.<QualityCandidate>emptyList());
        }
        String body = readLimitedText(conn.getInputStream(), 512 * 1024);
        conn.disconnect();
        if (!body.trim().startsWith("#EXTM3U")) {
            return new ProbeResult(m3u8Url, inferTitle(m3u8Url), "no-media", "Invalid HLS playlist", Collections.<QualityCandidate>emptyList());
        }
        if (body.contains("SAMPLE-AES") || body.contains("KEYFORMAT=\"com.apple.streamingkeydelivery\"")) {
            return new ProbeResult(m3u8Url, inferTitle(m3u8Url), "drm", "DRM-protected HLS stream is not supported", Collections.<QualityCandidate>emptyList());
        }

        List<QualityCandidate> variants = new ArrayList<QualityCandidate>();
        URL base = new URL(m3u8Url);
        String[] lines = body.split("\\r?\\n");

        // Parse EXT-X-MEDIA TYPE=AUDIO independent audio renditions
        java.util.Map<String, String> audioGroups = new java.util.HashMap<String, String>();
        for (String raw : lines) {
            String line = raw.trim();
            if (line.startsWith("#EXT-X-MEDIA:") && line.contains("TYPE=AUDIO")) {
                Matcher gm = GROUP_ID_PATTERN.matcher(line);
                Matcher um = URI_ATTR_PATTERN.matcher(line);
                if (gm.find() && um.find()) {
                    String g = gm.group(1);
                    if (!audioGroups.containsKey(g) || line.contains("DEFAULT=YES")) {
                        audioGroups.put(g, new URL(base, um.group(1)).toString());
                    }
                }
            }
        }

        if (body.contains("#EXT-X-STREAM-INF:")) {
            for (int i = 0; i < lines.length; i++) {
                String line = lines[i].trim();
                if (line.startsWith("#EXT-X-STREAM-INF:")) {
                    int height = 0;
                    long bw = 0;
                    Matcher rm = RES_PATTERN.matcher(line);
                    if (rm.find()) height = Integer.parseInt(rm.group(1));
                    Matcher bm = BW_PATTERN.matcher(line);
                    if (bm.find()) bw = Long.parseLong(bm.group(1));
                    String audioUri = null;
                    Matcher am = AUDIO_GROUP_PATTERN.matcher(line);
                    if (am.find()) audioUri = audioGroups.get(am.group(1));

                    String nextUri = null;
                    for (int j = i + 1; j < lines.length; j++) {
                        String cand = lines[j].trim();
                        if (!cand.isEmpty() && !cand.startsWith("#")) {
                            nextUri = new URL(base, cand).toString();
                            break;
                        }
                    }
                    if (nextUri != null && variants.size() < 8) {
                        int probeStatus = probeVariant2Byte(nextUri, ua, referer);
                        String avail = (probeStatus >= 200 && probeStatus < 300) ? "available"
                                : (probeStatus == 401 || probeStatus == 403 || probeStatus == 451) ? "restricted"
                                : "unavailable";
                        String label = (height > 0 ? height + "p" : "HLS") +
                                (bw > 0 ? " · " + (bw / 1000) + " kbps" : "") +
                                (audioUri != null ? " + Audio" : "") +
                                " [" + avail + "]";
                        variants.add(new QualityCandidate(label, nextUri, "hls", height, bw, -1, avail, probeStatus,
                                audioUri, Collections.<String>emptyList(), Collections.<String>emptyList(), null));
                    }
                }
            }
            Collections.sort(variants, new Comparator<QualityCandidate>() {
                @Override
                public int compare(QualityCandidate a, QualityCandidate b) {
                    int avA = "available".equals(a.availability) ? 1 : 0;
                    int avB = "available".equals(b.availability) ? 1 : 0;
                    if (avA != avB) return avB - avA;
                    if (a.height != b.height) return b.height - a.height;
                    return Long.compare(b.bandwidth, a.bandwidth);
                }
            });
            return new ProbeResult(m3u8Url, inferTitle(m3u8Url), "ok",
                    "Detected " + variants.size() + " HLS variants", variants);
        }

        variants.add(new QualityCandidate("HLS Stream [available]", m3u8Url, "hls", 0, 0, -1, "available", 200));
        return new ProbeResult(m3u8Url, inferTitle(m3u8Url), "ok", "HLS media playlist ready", variants);
    }

    private static int probeVariant2Byte(String variantUrl, String ua, String referer) {
        try {
            HttpURLConnection c1 = openConnection(variantUrl, ua, referer, null);
            int code = c1.getResponseCode();
            if (code < 200 || code >= 300) {
                c1.disconnect();
                return code;
            }
            String body = readLimitedText(c1.getInputStream(), 64 * 1024);
            c1.disconnect();
            URL base = new URL(variantUrl);
            for (String raw : body.split("\\r?\\n")) {
                String line = raw.trim();
                if (!line.isEmpty() && !line.startsWith("#")) {
                    String segUrl = new URL(base, line).toString();
                    HttpURLConnection c2 = openConnection(segUrl, ua, referer, "bytes=0-1");
                    int segCode = c2.getResponseCode();
                    c2.disconnect();
                    return segCode;
                }
            }
            return 200;
        } catch (Exception e) {
            return 0;
        }
    }

    private static ProbeResult probeDash(String mpdUrl, String ua, String referer) throws Exception {
        HttpURLConnection conn = openConnection(mpdUrl, ua, referer, null);
        int code = conn.getResponseCode();
        if (code == 401 || code == 402 || code == 403 || code == 451) {
            conn.disconnect();
            return new ProbeResult(mpdUrl, inferTitle(mpdUrl), "restricted", "HTTP " + code + " on DASH MPD", Collections.<QualityCandidate>emptyList());
        }
        if (code >= 400) {
            conn.disconnect();
            return new ProbeResult(mpdUrl, inferTitle(mpdUrl), "no-media", "HTTP " + code + " on DASH MPD", Collections.<QualityCandidate>emptyList());
        }
        String xml = readLimitedText(conn.getInputStream(), 1024 * 1024);
        conn.disconnect();

        DashEngine.DashPlan plan = DashEngine.parseMpd(mpdUrl, xml);
        if (!plan.supported) {
            String status = "DRM".equals(plan.errorCode) ? "drm" : "unsupported";
            return new ProbeResult(mpdUrl, inferTitle(mpdUrl), status, plan.message, Collections.<QualityCandidate>emptyList());
        }

        List<QualityCandidate> list = new ArrayList<QualityCandidate>();
        for (int i = 0; i < Math.min(plan.videoTracks.size(), 6); i++) {
            DashEngine.DashTrack v = plan.videoTracks.get(i);
            String label = "DASH " + (v.height > 0 ? v.height + "p" : "Video")
                    + (v.bandwidth > 0 ? " · " + (v.bandwidth / 1000) + " kbps" : "")
                    + (!plan.audioTracks.isEmpty() ? " + Audio" : "")
                    + " [static]";
            // Encode selected representation ID into candidate URL fragment (#vsrep=ID) so DownloadService picks exact track
            String repTag = v.id != null && !v.id.isEmpty() ? (mpdUrl + "#vsrep=" + v.id) : mpdUrl;
            list.add(new QualityCandidate(label, repTag, "dash", v.height, v.bandwidth, -1, "available", 200));
        }
        if (list.isEmpty() && !plan.audioTracks.isEmpty()) {
            DashEngine.DashTrack a = plan.audioTracks.get(0);
            list.add(new QualityCandidate("DASH Audio · " + (a.bandwidth / 1000) + " kbps", mpdUrl, "dash", 0, a.bandwidth, -1, "available", 200));
        }
        return new ProbeResult(mpdUrl, inferTitle(mpdUrl), "ok", plan.message, list);
    }

    private static ProbeResult probeHtmlPage(String pageUrl, String ua, String referer) throws Exception {
        HttpURLConnection conn = openConnection(pageUrl, ua, referer, null);
        int code = conn.getResponseCode();
        if (code == 401 || code == 402 || code == 403 || code == 451) {
            conn.disconnect();
            return new ProbeResult(pageUrl, inferTitle(pageUrl), "restricted", "HTTP " + code + " on page", Collections.<QualityCandidate>emptyList());
        }
        String html = readLimitedText(conn.getInputStream(), 512 * 1024);
        conn.disconnect();
        String title = inferTitle(pageUrl);
        Matcher tm = TITLE_PATTERN.matcher(html);
        if (tm.find()) title = tm.group(1).trim();

        Set<String> found = new LinkedHashSet<String>();
        Matcher mm = MEDIA_URL_PATTERN.matcher(html);
        while (mm.find() && found.size() < 12) {
            found.add(mm.group(1));
        }
        if (found.isEmpty()) {
            return new ProbeResult(pageUrl, title, "no-media",
                    "No direct media stream found in static HTML. For JS-rendered pages, paste the stream URL or use VideoSave Desktop.",
                    Collections.<QualityCandidate>emptyList());
        }
        List<QualityCandidate> list = new ArrayList<QualityCandidate>();
        for (String u : found) {
            String kind = u.toLowerCase(Locale.US).contains(".m3u8") ? "hls"
                    : u.toLowerCase(Locale.US).contains(".mpd") ? "dash" : "mp4";
            list.add(new QualityCandidate(kind.toUpperCase(Locale.US) + " · " + inferTitle(u), u, kind, 0, 0, -1, "unknown", 200));
        }
        return new ProbeResult(pageUrl, title, "ok", "Found " + list.size() + " media candidate(s) on page", list);
    }

    public static long parseContentLength(HttpURLConnection conn) {
        String cr = conn.getHeaderField("Content-Range");
        if (cr != null && cr.contains("/")) {
            try {
                String tail = cr.substring(cr.lastIndexOf('/') + 1).trim();
                if (!"*".equals(tail)) return Long.parseLong(tail);
            } catch (Exception ignored) {}
        }
        return conn.getContentLengthLong();
    }

    public static String readLimitedText(InputStream in, int maxBytes) throws Exception {
        StringBuilder sb = new StringBuilder();
        BufferedReader br = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
        char[] buf = new char[4096];
        int total = 0;
        int n;
        while ((n = br.read(buf)) > 0 && total < maxBytes) {
            sb.append(buf, 0, n);
            total += n;
        }
        return sb.toString();
    }

    public static String inferTitle(String url) {
        try {
            String path = new URL(url).getPath();
            int slash = path.lastIndexOf('/');
            String seg = slash >= 0 ? path.substring(slash + 1) : path;
            seg = seg.replaceAll("\\.[a-zA-Z0-9]{1,5}$", "").replaceAll("[^a-zA-Z0-9\\u4e00-\\u9fa5._ -]", "_").trim();
            return seg.isEmpty() ? "videosave_media" : seg.substring(0, Math.min(seg.length(), 64));
        } catch (Exception e) {
            return "videosave_media";
        }
    }

    public static String formatSize(long bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return String.format(Locale.US, "%.1f KB", bytes / 1024.0);
        return String.format(Locale.US, "%.2f MB", bytes / (1024.0 * 1024.0));
    }
}
