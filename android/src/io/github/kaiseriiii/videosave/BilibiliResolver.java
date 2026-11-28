package io.github.kaiseriiii.videosave;

import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Pure-Java native Bilibili public video resolver for Android (zero Root, zero Termux, zero Python).
 * Supports bare BV IDs, standard bilibili.com/video/BV.../?p=N links, and b23.tv short links,
 * ranks stable official UPOS CDN mirrors ahead of flaky cosov/mcdn nodes, and resolves both
 * progressive MP4 (durl) and separate DASH video + audio tracks for native Android MediaMuxer muxing.
 */
public final class BilibiliResolver {

    private static final String DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    private static final Pattern BVID_PATTERN = Pattern.compile("(BV[A-Za-z0-9]{10})");
    private static final Pattern PAGE_PARAM = Pattern.compile("[?&]p=(\\d+)");

    public static boolean isBilibiliInput(String raw) {
        if (raw == null) return false;
        String s = raw.trim();
        if (s.matches("^BV[A-Za-z0-9]{10}$")) return true;
        String lower = s.toLowerCase(Locale.US);
        return lower.contains("bilibili.com/video/") || lower.contains("b23.tv/");
    }

    public static List<String> rankMirrors(List<String> rawUrls) {
        Set<String> unique = new LinkedHashSet<String>();
        for (String u : rawUrls) {
            if (u != null && u.trim().startsWith("https://")) unique.add(u.trim());
        }
        List<String> list = new ArrayList<String>(unique);
        Collections.sort(list, new Comparator<String>() {
            @Override
            public int compare(String a, String b) {
                return mirrorScore(a) - mirrorScore(b);
            }
        });
        return list;
    }

    public static int mirrorScore(String urlStr) {
        try {
            String host = new URL(urlStr).getHost().toLowerCase(Locale.US);
            if (host.contains("mcdn.") || host.contains("mountaintoys.cn") || host.contains("szbdyd.com")
                    || host.contains("mirrorcosov") || host.contains("pcdn")) return 30;
            if (host.startsWith("upos-sz-mirrorcos") || host.startsWith("upos-sz-estgoss")
                    || host.startsWith("upos-sz-mirrorhw") || host.startsWith("upos-sz-mirrorali")) return 0;
            if (host.startsWith("upos-") && host.endsWith(".bilivideo.com")) return 5;
            if (host.startsWith("cn-") && host.endsWith(".bilivideo.com")) return 8;
            if (host.endsWith(".bilivideo.com") || host.endsWith(".bilivideo.cn")) return 12;
            return 20;
        } catch (Exception e) {
            return 50;
        }
    }

    public static String resolveCanonicalUrl(String raw) throws Exception {
        String trimmed = raw.trim();
        if (trimmed.matches("^BV[A-Za-z0-9]{10}$")) {
            return "https://www.bilibili.com/video/" + trimmed + "/";
        }
        URL parsed = new URL(trimmed);
        String host = parsed.getHost().toLowerCase(Locale.US);
        if ("b23.tv".equals(host)) {
            HttpURLConnection conn = (HttpURLConnection) parsed.openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(10000);
            conn.setRequestProperty("User-Agent", DESKTOP_UA);
            conn.getResponseCode();
            String loc = conn.getHeaderField("Location");
            conn.disconnect();
            if (loc == null || loc.isEmpty()) throw new IllegalStateException("b23.tv did not return a redirect");
            URL dest = new URL(parsed, loc);
            String destHost = dest.getHost().toLowerCase(Locale.US);
            if (!"www.bilibili.com".equals(destHost) && !"m.bilibili.com".equals(destHost) && !"bilibili.com".equals(destHost)) {
                throw new IllegalStateException("b23.tv redirect left bilibili.com");
            }
            trimmed = dest.toString();
        }
        Matcher m = BVID_PATTERN.matcher(trimmed);
        if (!m.find()) throw new IllegalStateException("No valid Bilibili BV ID found");
        String bvid = m.group(1);
        Matcher pm = PAGE_PARAM.matcher(trimmed);
        int part = pm.find() ? Integer.parseInt(pm.group(1)) : 1;
        return part > 1
                ? "https://www.bilibili.com/video/" + bvid + "/?p=" + part
                : "https://www.bilibili.com/video/" + bvid + "/";
    }

    private static JSONObject fetchJson(String apiUrl, String referer) throws Exception {
        HttpURLConnection conn = MediaProbeEngine.openConnection(apiUrl, DESKTOP_UA, referer, null);
        conn.setRequestProperty("Origin", "https://www.bilibili.com");
        int code = conn.getResponseCode();
        if (code == 401 || code == 402 || code == 403 || code == 451) {
            conn.disconnect();
            throw new IllegalStateException("HTTP " + code + " from Bilibili API");
        }
        String text = MediaProbeEngine.readLimitedText(conn.getInputStream(), 1024 * 1024);
        conn.disconnect();
        return new JSONObject(text);
    }

    public static MediaProbeEngine.ProbeResult probe(String rawInput) {
        try {
            String canonical = resolveCanonicalUrl(rawInput);
            Matcher bm = BVID_PATTERN.matcher(canonical);
            if (!bm.find()) {
                return new MediaProbeEngine.ProbeResult(rawInput, "", "error", "Invalid Bilibili URL",
                        Collections.<MediaProbeEngine.QualityCandidate>emptyList());
            }
            String bvid = bm.group(1);
            Matcher pm = PAGE_PARAM.matcher(canonical);
            int partIndex = pm.find() ? Integer.parseInt(pm.group(1)) : 1;

            JSONObject view = fetchJson("https://api.bilibili.com/x/web-interface/view?bvid=" + bvid, canonical);
            int vCode = view.optInt("code", -1);
            if (vCode != 0) {
                String status = (vCode == -10403 || vCode == -101) ? "restricted" : "no-media";
                return new MediaProbeEngine.ProbeResult(canonical, bvid, status,
                        "Bilibili API code " + vCode + " (" + view.optString("message", "unavailable") + ")",
                        Collections.<MediaProbeEngine.QualityCandidate>emptyList());
            }
            JSONObject data = view.getJSONObject("data");
            String baseTitle = data.optString("title", bvid);
            long cid = data.optLong("cid", 0);
            int totalPages = 1;
            String title = baseTitle;
            JSONArray pages = data.optJSONArray("pages");
            if (pages != null && pages.length() > 0) {
                totalPages = pages.length();
                for (int i = 0; i < pages.length(); i++) {
                    JSONObject pg = pages.getJSONObject(i);
                    if (pg.optInt("page", i + 1) == partIndex) {
                        cid = pg.optLong("cid", cid);
                        String partName = pg.optString("part", "");
                        if (totalPages > 1 && !partName.isEmpty() && !partName.equals(baseTitle)) {
                            title = baseTitle + " - P" + partIndex + " " + partName;
                        }
                        break;
                    }
                }
            }

            JSONObject dashRes = fetchJson(
                    "https://api.bilibili.com/x/player/playurl?bvid=" + bvid + "&cid=" + cid + "&qn=120&fnval=4048&fnver=0&fourk=1",
                    canonical);
            JSONObject mp4Res = null;
            try {
                mp4Res = fetchJson(
                        "https://api.bilibili.com/x/player/playurl?bvid=" + bvid + "&cid=" + cid + "&qn=80&fnval=1&fnver=0&fourk=0",
                        canonical);
            } catch (Exception ignored) {}

            List<MediaProbeEngine.QualityCandidate> candidates = new ArrayList<MediaProbeEngine.QualityCandidate>();

            // 1. Progressive MP4 (durl) if available (often 720p for anonymous users; plays natively on every Android device)
            if (mp4Res != null && mp4Res.optInt("code", -1) == 0) {
                JSONObject mp4Data = mp4Res.optJSONObject("data");
                JSONArray durl = mp4Data != null ? mp4Data.optJSONArray("durl") : null;
                if (durl != null && durl.length() == 1) {
                    JSONObject d0 = durl.getJSONObject(0);
                    List<String> mirrors = collectMirrors(d0, "url", "backup_url");
                    if (!mirrors.isEmpty()) {
                        int qn = mp4Data.optInt("quality", 64);
                        int height = qn >= 80 ? 1080 : qn >= 64 ? 720 : qn >= 32 ? 480 : 360;
                        long size = d0.optLong("size", -1);
                        String label = "Bilibili " + height + "p MP4" + (size > 0 ? " · " + MediaProbeEngine.formatSize(size) : "");
                        candidates.add(new MediaProbeEngine.QualityCandidate(
                                label, mirrors.get(0), "bilibili-mp4", height, 0, size, "available", 200,
                                null, mirrors, Collections.<String>emptyList(), canonical));
                    }
                }
            }

            // 2. Separate DASH Video + Audio tracks (muxed via Android MediaMuxer!)
            if (dashRes.optInt("code", -1) == 0) {
                JSONObject dash = dashRes.optJSONObject("data") != null ? dashRes.getJSONObject("data").optJSONObject("dash") : null;
                if (dash != null) {
                    JSONArray audios = dash.optJSONArray("audio");
                    List<String> bestAudioMirrors = Collections.emptyList();
                    long bestAudioBw = -1;
                    if (audios != null) {
                        for (int i = 0; i < audios.length(); i++) {
                            JSONObject a = audios.getJSONObject(i);
                            long bw = a.optLong("bandwidth", 0);
                            if (bw > bestAudioBw) {
                                List<String> am = collectMirrors(a, "baseUrl", "backupUrl");
                                if (am.isEmpty()) am = collectMirrors(a, "base_url", "backup_url");
                                if (!am.isEmpty()) {
                                    bestAudioBw = bw;
                                    bestAudioMirrors = am;
                                }
                            }
                        }
                    }

                    JSONArray videos = dash.optJSONArray("video");
                    Set<Integer> seenHeights = new LinkedHashSet<Integer>();
                    if (videos != null) {
                        // Prefer H.264 (avc1) for widest Android MediaMuxer + hardware playback compatibility
                        List<JSONObject> vList = new ArrayList<JSONObject>();
                        for (int i = 0; i < videos.length(); i++) vList.add(videos.getJSONObject(i));
                        Collections.sort(vList, new Comparator<JSONObject>() {
                            @Override
                            public int compare(JSONObject a, JSONObject b) {
                                int hd = b.optInt("height", 0) - a.optInt("height", 0);
                                if (hd != 0) return hd;
                                int ca = a.optString("codecs", "").startsWith("avc1") ? 1 : 0;
                                int cb = b.optString("codecs", "").startsWith("avc1") ? 1 : 0;
                                if (ca != cb) return cb - ca;
                                return Long.compare(b.optLong("bandwidth", 0), a.optLong("bandwidth", 0));
                            }
                        });
                        for (JSONObject v : vList) {
                            int h = v.optInt("height", 0);
                            if (h <= 0 || seenHeights.contains(h)) continue;
                            List<String> vm = collectMirrors(v, "baseUrl", "backupUrl");
                            if (vm.isEmpty()) vm = collectMirrors(v, "base_url", "backup_url");
                            if (vm.isEmpty()) continue;
                            seenHeights.add(h);
                            long bw = v.optLong("bandwidth", 0);
                            String codec = v.optString("codecs", "").split("\\.")[0];
                            String audioPrimary = bestAudioMirrors.isEmpty() ? null : bestAudioMirrors.get(0);
                            String label = "Bilibili " + h + "p DASH (" + codec + ") · " + (bw / 1000) + " kbps";
                            candidates.add(new MediaProbeEngine.QualityCandidate(
                                    label, vm.get(0), "bilibili-dash", h, bw, -1, "available", 200,
                                    audioPrimary, vm, bestAudioMirrors, canonical));
                        }
                    }
                    if (!bestAudioMirrors.isEmpty()) {
                        candidates.add(new MediaProbeEngine.QualityCandidate(
                                "Bilibili Audio Only (M4A · " + (bestAudioBw / 1000) + " kbps)",
                                bestAudioMirrors.get(0), "audio", 0, bestAudioBw, -1, "available", 200,
                                null, bestAudioMirrors, Collections.<String>emptyList(), canonical));
                    }
                }
            }

            if (candidates.isEmpty()) {
                return new MediaProbeEngine.ProbeResult(canonical, title, "no-media",
                        "No public playable streams returned by Bilibili", candidates);
            }
            String msg = "Bilibili ready (" + candidates.size() + " tracks"
                    + (totalPages > 1 ? ", P" + partIndex + "/" + totalPages : "") + ")";
            return new MediaProbeEngine.ProbeResult(canonical, title, "ok", msg, candidates);
        } catch (Exception e) {
            return new MediaProbeEngine.ProbeResult(rawInput, "", "error",
                    "Bilibili probe error: " + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()),
                    Collections.<MediaProbeEngine.QualityCandidate>emptyList());
        }
    }

    private static List<String> collectMirrors(JSONObject obj, String primaryKey, String backupKey) {
        List<String> raw = new ArrayList<String>();
        String p = obj.optString(primaryKey, "");
        if (!p.isEmpty()) raw.add(p);
        JSONArray bak = obj.optJSONArray(backupKey);
        if (bak != null) {
            for (int i = 0; i < bak.length(); i++) {
                String u = bak.optString(i, "");
                if (!u.isEmpty()) raw.add(u);
            }
        }
        return rankMirrors(raw);
    }
}
