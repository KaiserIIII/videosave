package io.github.kaiseriiii.videosave;

import java.io.ByteArrayInputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

/**
 * Pure-Java static DASH MPD parser & segment planner for Android.
 * Hardened against XXE, explicitly rejects DRM and dynamic live MPDs before download,
 * and supports BaseURL, SegmentTemplate (duration & SegmentTimeline), and SegmentList
 * across separate video + audio AdaptationSets.
 */
public final class DashEngine {

    public static final class DashTrack {
        public final String id;
        public final String mediaType; // video | audio
        public final String mimeType;
        public final String codecs;
        public final int width;
        public final int height;
        public final long bandwidth;
        public final String initUrl;
        public final List<String> segmentUrls;

        public DashTrack(String id, String mediaType, String mimeType, String codecs,
                         int width, int height, long bandwidth, String initUrl, List<String> segmentUrls) {
            this.id = id;
            this.mediaType = mediaType;
            this.mimeType = mimeType;
            this.codecs = codecs;
            this.width = width;
            this.height = height;
            this.bandwidth = bandwidth;
            this.initUrl = initUrl;
            this.segmentUrls = segmentUrls;
        }
    }

    public static final class DashPlan {
        public final boolean supported;
        public final String errorCode; // null | DRM | DASH_DYNAMIC_UNSUPPORTED | DASH_UNSUPPORTED
        public final String message;
        public final double durationSec;
        public final List<DashTrack> videoTracks;
        public final List<DashTrack> audioTracks;

        public DashPlan(boolean supported, String errorCode, String message, double durationSec,
                        List<DashTrack> videoTracks, List<DashTrack> audioTracks) {
            this.supported = supported;
            this.errorCode = errorCode;
            this.message = message;
            this.durationSec = durationSec;
            this.videoTracks = videoTracks;
            this.audioTracks = audioTracks;
        }
    }

    private static final Pattern ISO_DUR = Pattern.compile(
            "PT(?:(\\d+(?:\\.\\d+)?)H)?(?:(\\d+(?:\\.\\d+)?)M)?(?:(\\d+(?:\\.\\d+)?)S)?",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern NUMBER_FMT = Pattern.compile("\\$Number(?:%0(\\d+)d)?\\$");

    public static double parseIsoDurationSeconds(String raw) {
        if (raw == null || raw.trim().isEmpty()) return 0.0;
        Matcher m = ISO_DUR.matcher(raw.trim());
        if (!m.find()) return 0.0;
        double h = m.group(1) != null ? Double.parseDouble(m.group(1)) : 0.0;
        double min = m.group(2) != null ? Double.parseDouble(m.group(2)) : 0.0;
        double s = m.group(3) != null ? Double.parseDouble(m.group(3)) : 0.0;
        return h * 3600.0 + min * 60.0 + s;
    }

    public static DashPlan parseMpd(String mpdUrl, String xml) {
        if (xml == null || !xml.contains("<MPD")) {
            return new DashPlan(false, "DASH_UNSUPPORTED", "Invalid DASH MPD manifest", 0,
                    Collections.<DashTrack>emptyList(), Collections.<DashTrack>emptyList());
        }
        try {
            DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
            factory.setNamespaceAware(false);
            try {
                factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
                factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
                factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
            } catch (Exception ignored) {
                // Some Android XML parsers do not expose Xerces feature names; expandEntityReferences=false still protects.
            }
            factory.setExpandEntityReferences(false);
            DocumentBuilder builder = factory.newDocumentBuilder();
            Document doc = builder.parse(new ByteArrayInputStream(xml.getBytes(StandardCharsets.UTF_8)));
            Element root = doc.getDocumentElement();
            if (root == null || !"MPD".equalsIgnoreCase(root.getTagName())) {
                return new DashPlan(false, "DASH_UNSUPPORTED", "Root element is not <MPD>", 0,
                        Collections.<DashTrack>emptyList(), Collections.<DashTrack>emptyList());
            }

            String type = root.getAttribute("type");
            if ("dynamic".equalsIgnoreCase(type)) {
                return new DashPlan(false, "DASH_DYNAMIC_UNSUPPORTED",
                        "Live dynamic DASH streams are not supported on Android yet (use VideoSave Desktop for bounded live DASH recording).",
                        0, Collections.<DashTrack>emptyList(), Collections.<DashTrack>emptyList());
            }

            if (hasDrmContentProtection(root)) {
                return new DashPlan(false, "DRM",
                        "DRM-protected DASH stream (Widevine/PlayReady/CENC) is strictly not supported.",
                        0, Collections.<DashTrack>emptyList(), Collections.<DashTrack>emptyList());
            }

            double durationSec = parseIsoDurationSeconds(root.getAttribute("mediaPresentationDuration"));
            List<Element> periods = directChildren(root, "Period");
            if (periods.isEmpty()) {
                return new DashPlan(false, "DASH_UNSUPPORTED", "MPD contains no <Period>", durationSec,
                        Collections.<DashTrack>emptyList(), Collections.<DashTrack>emptyList());
            }
            if (periods.size() > 1) {
                return new DashPlan(false, "DASH_UNSUPPORTED",
                        "Multi-Period DASH manifests (" + periods.size() + " periods) are not supported on Android yet.",
                        durationSec, Collections.<DashTrack>emptyList(), Collections.<DashTrack>emptyList());
            }

            URL mpdBase = new URL(mpdUrl);
            URL rootBase = resolveChildBaseUrl(mpdBase, root);
            Element period = periods.get(0);
            double periodDur = parseIsoDurationSeconds(period.getAttribute("duration"));
            if (periodDur > 0) durationSec = periodDur;
            URL periodBase = resolveChildBaseUrl(rootBase, period);

            List<DashTrack> videos = new ArrayList<DashTrack>();
            List<DashTrack> audios = new ArrayList<DashTrack>();

            for (Element as : directChildren(period, "AdaptationSet")) {
                if (hasDrmContentProtection(as)) {
                    return new DashPlan(false, "DRM", "DRM-protected AdaptationSet is not supported.", durationSec,
                            Collections.<DashTrack>emptyList(), Collections.<DashTrack>emptyList());
                }
                URL asBase = resolveChildBaseUrl(periodBase, as);
                String asContentType = as.getAttribute("contentType").toLowerCase(Locale.US);
                String asMime = as.getAttribute("mimeType").toLowerCase(Locale.US);
                Element asSegTemplate = firstDirectChild(as, "SegmentTemplate");
                Element asSegList = firstDirectChild(as, "SegmentList");

                for (Element rep : directChildren(as, "Representation")) {
                    if (hasDrmContentProtection(rep)) continue;
                    String repMime = rep.getAttribute("mimeType").isEmpty() ? asMime : rep.getAttribute("mimeType").toLowerCase(Locale.US);
                    String mediaType = detectMediaType(asContentType, repMime);
                    if (mediaType == null) continue;
                    // Android MediaMuxer natively muxes MP4/ISOBMFF (H.264/HEVC/AAC) and WebM; reject exotic containers cleanly
                    if (!repMime.isEmpty() && !repMime.contains("mp4") && !repMime.contains("webm")) continue;

                    String repId = rep.getAttribute("id");
                    String codecs = rep.getAttribute("codecs").isEmpty() ? as.getAttribute("codecs") : rep.getAttribute("codecs");
                    int width = parseIntSafe(rep.getAttribute("width"), parseIntSafe(as.getAttribute("width"), 0));
                    int height = parseIntSafe(rep.getAttribute("height"), parseIntSafe(as.getAttribute("height"), 0));
                    long bw = parseLongSafe(rep.getAttribute("bandwidth"), 0);
                    URL repBase = resolveChildBaseUrl(asBase, rep);

                    Element segTemplate = firstDirectChild(rep, "SegmentTemplate");
                    if (segTemplate == null) segTemplate = asSegTemplate;
                    Element segList = firstDirectChild(rep, "SegmentList");
                    if (segList == null) segList = asSegList;

                    DashTrack track = null;
                    if (segTemplate != null) {
                        track = buildFromSegmentTemplate(repId, mediaType, repMime, codecs, width, height, bw,
                                repBase, segTemplate, durationSec);
                    } else if (segList != null) {
                        track = buildFromSegmentList(repId, mediaType, repMime, codecs, width, height, bw,
                                repBase, segList);
                    } else {
                        // Single-file BaseURL representation
                        Element baseEl = firstDirectChild(rep, "BaseURL");
                        if (baseEl != null && baseEl.getTextContent() != null && !baseEl.getTextContent().trim().isEmpty()) {
                            String singleUrl = new URL(asBase, baseEl.getTextContent().trim()).toString();
                            List<String> segs = new ArrayList<String>();
                            segs.add(singleUrl);
                            track = new DashTrack(repId, mediaType, repMime, codecs, width, height, bw, null, segs);
                        }
                    }

                    if (track != null && !track.segmentUrls.isEmpty()) {
                        if ("video".equals(mediaType)) videos.add(track);
                        else audios.add(track);
                    }
                }
            }

            if (videos.isEmpty() && audios.isEmpty()) {
                return new DashPlan(false, "DASH_UNSUPPORTED",
                        "No supported static DASH SegmentTemplate/SegmentList/BaseURL tracks found.",
                        durationSec, videos, audios);
            }

            Collections.sort(videos, new Comparator<DashTrack>() {
                @Override
                public int compare(DashTrack a, DashTrack b) {
                    if (a.height != b.height) return b.height - a.height;
                    return Long.compare(b.bandwidth, a.bandwidth);
                }
            });
            Collections.sort(audios, new Comparator<DashTrack>() {
                @Override
                public int compare(DashTrack a, DashTrack b) {
                    return Long.compare(b.bandwidth, a.bandwidth);
                }
            });

            return new DashPlan(true, null,
                    "Static DASH ready (" + videos.size() + " video, " + audios.size() + " audio track(s))",
                    durationSec, videos, audios);
        } catch (Exception e) {
            return new DashPlan(false, "DASH_UNSUPPORTED",
                    "Failed to parse DASH MPD: " + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()),
                    0, Collections.<DashTrack>emptyList(), Collections.<DashTrack>emptyList());
        }
    }

    private static DashTrack buildFromSegmentTemplate(String repId, String mediaType, String mime, String codecs,
                                                      int width, int height, long bw, URL base, Element tmpl,
                                                      double durationSec) throws Exception {
        String initTpl = tmpl.getAttribute("initialization");
        String mediaTpl = tmpl.getAttribute("media");
        if (mediaTpl == null || mediaTpl.isEmpty()) return null;

        String initUrl = (initTpl != null && !initTpl.isEmpty())
                ? new URL(base, expandTemplate(initTpl, repId, bw, -1, -1)).toString()
                : null;
        long startNumber = parseLongSafe(tmpl.getAttribute("startNumber"), 1);
        long timescale = Math.max(1L, parseLongSafe(tmpl.getAttribute("timescale"), 1));
        long segDuration = parseLongSafe(tmpl.getAttribute("duration"), 0);

        List<String> urls = new ArrayList<String>();
        Element timeline = firstDirectChild(tmpl, "SegmentTimeline");
        if (timeline != null) {
            long currentTime = 0;
            long num = startNumber;
            for (Element s : directChildren(timeline, "S")) {
                String tAttr = s.getAttribute("t");
                if (tAttr != null && !tAttr.isEmpty()) currentTime = parseLongSafe(tAttr, currentTime);
                long d = parseLongSafe(s.getAttribute("d"), 0);
                long r = parseLongSafe(s.getAttribute("r"), 0);
                if (d <= 0 || r < 0 || r > 10000) return null;
                for (long k = 0; k <= r; k++) {
                    urls.add(new URL(base, expandTemplate(mediaTpl, repId, bw, num, currentTime)).toString());
                    num++;
                    currentTime += d;
                    if (urls.size() > 5000) return null;
                }
            }
        } else if (segDuration > 0 && durationSec > 0) {
            double segSec = (double) segDuration / (double) timescale;
            int count = (int) Math.ceil(durationSec / segSec);
            if (count <= 0 || count > 5000) return null;
            for (int i = 0; i < count; i++) {
                long num = startNumber + i;
                long t = i * segDuration;
                urls.add(new URL(base, expandTemplate(mediaTpl, repId, bw, num, t)).toString());
            }
        } else {
            return null;
        }
        return new DashTrack(repId, mediaType, mime, codecs, width, height, bw, initUrl, urls);
    }

    private static DashTrack buildFromSegmentList(String repId, String mediaType, String mime, String codecs,
                                                  int width, int height, long bw, URL base, Element listEl) throws Exception {
        Element initEl = firstDirectChild(listEl, "Initialization");
        String initUrl = (initEl != null && !initEl.getAttribute("sourceURL").isEmpty())
                ? new URL(base, initEl.getAttribute("sourceURL")).toString()
                : null;
        List<String> urls = new ArrayList<String>();
        for (Element segEl : directChildren(listEl, "SegmentURL")) {
            String media = segEl.getAttribute("media");
            if (media != null && !media.isEmpty()) {
                urls.add(new URL(base, media).toString());
            }
        }
        if (urls.isEmpty()) return null;
        return new DashTrack(repId, mediaType, mime, codecs, width, height, bw, initUrl, urls);
    }

    private static String expandTemplate(String tpl, String repId, long bw, long number, long time) {
        String out = tpl.replace("$$", "\u0000")
                .replace("$RepresentationID$", repId == null ? "" : repId)
                .replace("$Bandwidth$", String.valueOf(bw));
        if (time >= 0) out = out.replace("$Time$", String.valueOf(time));
        if (number >= 0) {
            Matcher m = NUMBER_FMT.matcher(out);
            StringBuffer sb = new StringBuffer();
            while (m.find()) {
                String widthStr = m.group(1);
                String formatted = (widthStr != null)
                        ? String.format(Locale.US, "%0" + Integer.parseInt(widthStr) + "d", number)
                        : String.valueOf(number);
                m.appendReplacement(sb, Matcher.quoteReplacement(formatted));
            }
            m.appendTail(sb);
            out = sb.toString();
        }
        return out.replace("\u0000", "$");
    }

    private static boolean hasDrmContentProtection(Element parent) {
        NodeList list = parent.getElementsByTagName("ContentProtection");
        for (int i = 0; i < list.getLength(); i++) {
            Element el = (Element) list.item(i);
            String scheme = el.getAttribute("schemeIdUri").toLowerCase(Locale.US);
            String val = el.getAttribute("value").toLowerCase(Locale.US);
            if (scheme.contains("edef8ba9") || scheme.contains("9a04f079") || scheme.contains("mp4protection")
                    || val.contains("cenc") || val.contains("cbcs") || val.contains("widevine") || val.contains("playready")) {
                return true;
            }
        }
        return false;
    }

    private static String detectMediaType(String contentType, String mime) {
        if ("video".equals(contentType) || mime.startsWith("video/")) return "video";
        if ("audio".equals(contentType) || mime.startsWith("audio/")) return "audio";
        return null;
    }

    private static URL resolveChildBaseUrl(URL parentBase, Element el) throws Exception {
        Element baseEl = firstDirectChild(el, "BaseURL");
        if (baseEl != null && baseEl.getTextContent() != null && !baseEl.getTextContent().trim().isEmpty()) {
            return new URL(parentBase, baseEl.getTextContent().trim());
        }
        return parentBase;
    }

    private static List<Element> directChildren(Element parent, String tag) {
        List<Element> out = new ArrayList<Element>();
        NodeList children = parent.getChildNodes();
        for (int i = 0; i < children.getLength(); i++) {
            Node n = children.item(i);
            if (n.getNodeType() == Node.ELEMENT_NODE && tag.equalsIgnoreCase(n.getNodeName())) {
                out.add((Element) n);
            }
        }
        return out;
    }

    private static Element firstDirectChild(Element parent, String tag) {
        List<Element> list = directChildren(parent, tag);
        return list.isEmpty() ? null : list.get(0);
    }

    private static int parseIntSafe(String s, int def) {
        if (s == null || s.isEmpty()) return def;
        try { return Integer.parseInt(s.trim()); } catch (Exception e) { return def; }
    }

    private static long parseLongSafe(String s, long def) {
        if (s == null || s.isEmpty()) return def;
        try { return Long.parseLong(s.trim()); } catch (Exception e) { return def; }
    }
}
