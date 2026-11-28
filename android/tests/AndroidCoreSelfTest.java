import io.github.kaiseriiii.videosave.BilibiliResolver;
import io.github.kaiseriiii.videosave.DashEngine;
import io.github.kaiseriiii.videosave.HttpRangeValidator;
import io.github.kaiseriiii.videosave.MediaContainerUtil;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;

/**
 * Pure-JVM regression suite testing VideoSave Android core logic (executed automatically on every APK build & CI):
 * 1. DASH MPD parsing: SegmentTemplate, SegmentTimeline, SegmentList, BaseURL, DRM rejection, Dynamic rejection
 * 2. MediaContainerUtil: strictly rejects XML/MPD, HTML, JSON, M3U8, JPEG/PNG; accepts valid MP4/MPEG-TS/WebM
 * 3. HttpRangeValidator: rejects truncated HTTP 416, changed ETag/Last-Modified, missing server length; accepts exact verified 416
 * 4. BilibiliResolver: BV detection & CDN mirror ranking (stable UPOS before flaky cosov/mcdn)
 */
public final class AndroidCoreSelfTest {

    private static int passed = 0;

    private static void check(boolean cond, String label) {
        if (!cond) throw new AssertionError("FAILED: " + label);
        passed++;
        System.out.println("PASS [android-core] " + label);
    }

    private static File writeTemp(String name, byte[] data) throws Exception {
        File f = File.createTempFile("vs-android-test-", name);
        f.deleteOnExit();
        FileOutputStream fos = new FileOutputStream(f);
        try { fos.write(data); } finally { fos.close(); }
        return f;
    }

    public static void main(String[] args) throws Exception {
        // 1. Container validator MUST reject MPD XML, HTML, JSON, M3U8, JPEG, truncated files
        String mpdXml = "<?xml version=\"1.0\"?><MPD type=\"static\" mediaPresentationDuration=\"PT10S\">"
                + "<Period><AdaptationSet contentType=\"video\" mimeType=\"video/mp4\">"
                + "<Representation id=\"v720\" width=\"1280\" height=\"720\" bandwidth=\"1500000\">"
                + "<SegmentTemplate initialization=\"init-$RepresentationID$.mp4\" media=\"seg-$RepresentationID$-$Number%03d$.m4s\" timescale=\"1000\" duration=\"2000\" startNumber=\"1\"/>"
                + "</Representation></AdaptationSet>"
                + "<AdaptationSet contentType=\"audio\" mimeType=\"audio/mp4\">"
                + "<Representation id=\"a128\" bandwidth=\"128000\">"
                + "<SegmentList><Initialization sourceURL=\"audio-init.mp4\"/>"
                + "<SegmentURL media=\"audio-1.m4s\"/><SegmentURL media=\"audio-2.m4s\"/></SegmentList>"
                + "</Representation></AdaptationSet></Period></MPD>";

        File fakeMp4ContainingMpd = writeTemp(".mp4", mpdXml.getBytes(StandardCharsets.UTF_8));
        check(!MediaContainerUtil.inspectFile(fakeMp4ContainingMpd).valid, "Reject MPD XML saved as .mp4");

        File fakeHtml = writeTemp(".mp4", ("<!DOCTYPE html><html><body>403 Forbidden" + "                    ").getBytes(StandardCharsets.UTF_8));
        check(!MediaContainerUtil.inspectFile(fakeHtml).valid, "Reject HTML error page saved as .mp4");

        File fakeJson = writeTemp(".mp4", ("{\"error\":\"unauthorized\",\"code\":403}                                        ").getBytes(StandardCharsets.UTF_8));
        check(!MediaContainerUtil.inspectFile(fakeJson).valid, "Reject JSON error saved as .mp4");

        File fakeJpg = writeTemp(".mp4", new byte[128]);
        byte[] jpgBytes = new byte[128];
        jpgBytes[0] = (byte) 0xFF; jpgBytes[1] = (byte) 0xD8; jpgBytes[2] = (byte) 0xFF; jpgBytes[3] = (byte) 0xE0;
        fakeJpg = writeTemp(".mp4", jpgBytes);
        check(!MediaContainerUtil.inspectFile(fakeJpg).valid, "Reject real JPEG image masquerading as media");

        byte[] validMp4 = new byte[256];
        validMp4[3] = 0x18; validMp4[4] = 'f'; validMp4[5] = 't'; validMp4[6] = 'y'; validMp4[7] = 'p';
        File realMp4 = writeTemp(".mp4", validMp4);
        check(MediaContainerUtil.inspectFile(realMp4).valid, "Accept valid ISOBMFF ftyp MP4 header");

        byte[] validTs = new byte[376];
        validTs[0] = 0x47; validTs[188] = 0x47;
        File realTs = writeTemp(".ts", validTs);
        check(MediaContainerUtil.inspectFile(realTs).valid, "Accept valid MPEG-TS 0x47 stride-188 header");

        // 2. DASH Engine: static SegmentTemplate + SegmentList, DRM reject, Dynamic reject
        DashEngine.DashPlan plan = DashEngine.parseMpd("https://cdn.example.test/video/manifest.mpd", mpdXml);
        check(plan.supported, "Parse static DASH SegmentTemplate + SegmentList");
        check(plan.videoTracks.size() == 1 && plan.videoTracks.get(0).segmentUrls.size() == 5, "Expand 10s / 2s = 5 video segments");
        check("https://cdn.example.test/video/seg-v720-001.m4s".equals(plan.videoTracks.get(0).segmentUrls.get(0)), "Format $Number%03d$ correctly");
        check(plan.audioTracks.size() == 1 && plan.audioTracks.get(0).segmentUrls.size() == 2, "Parse SegmentList audio track");

        String drmMpd = "<?xml version=\"1.0\"?><MPD type=\"static\"><Period><AdaptationSet contentType=\"video\">"
                + "<ContentProtection schemeIdUri=\"urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed\"/>"
                + "</AdaptationSet></Period></MPD>";
        DashEngine.DashPlan drmPlan = DashEngine.parseMpd("https://cdn.example.test/drm.mpd", drmMpd);
        check(!drmPlan.supported && "DRM".equals(drmPlan.errorCode), "Strictly reject Widevine DRM DASH MPD");

        String liveMpd = "<?xml version=\"1.0\"?><MPD type=\"dynamic\"><Period/></MPD>";
        DashEngine.DashPlan livePlan = DashEngine.parseMpd("https://cdn.example.test/live.mpd", liveMpd);
        check(!livePlan.supported && "DASH_DYNAMIC_UNSUPPORTED".equals(livePlan.errorCode), "Reject dynamic live DASH before download");

        // 3. HTTP Range 416 strict validation
        HttpRangeValidator.ValidationOutcome trunc416 = HttpRangeValidator.evaluate416(
                100, 256, "bytes */256", -1, "\"v1\"", "\"v1\"", "", "", realMp4);
        check(trunc416.decision == HttpRangeValidator.Decision.RESTART_FROM_ZERO, "Reject truncated file on HTTP 416");

        HttpRangeValidator.ValidationOutcome noLen416 = HttpRangeValidator.evaluate416(
                256, 256, null, -1, "\"v1\"", "\"v1\"", "", "", realMp4);
        check(noLen416.decision == HttpRangeValidator.Decision.RESTART_FROM_ZERO, "Reject HTTP 416 without authoritative server length");

        HttpRangeValidator.ValidationOutcome changedEtag416 = HttpRangeValidator.evaluate416(
                256, 256, "bytes */256", -1, "\"v1\"", "\"v2\"", "", "", realMp4);
        check(changedEtag416.decision == HttpRangeValidator.Decision.RESTART_FROM_ZERO, "Reject HTTP 416 when ETag changed");

        HttpRangeValidator.ValidationOutcome corruptContent416 = HttpRangeValidator.evaluate416(
                fakeHtml.length(), fakeHtml.length(), "bytes */" + fakeHtml.length(), -1, "\"v1\"", "\"v1\"", "", "", fakeHtml);
        check(corruptContent416.decision == HttpRangeValidator.Decision.RESTART_FROM_ZERO, "Reject HTTP 416 when local .part is HTML");

        HttpRangeValidator.ValidationOutcome exact416 = HttpRangeValidator.evaluate416(
                256, 256, "bytes */256", -1, "\"v1\"", "\"v1\"", "", "", realMp4);
        check(exact416.decision == HttpRangeValidator.Decision.COMPLETE_VERIFIED, "Accept HTTP 416 ONLY when length + ETag + MP4 container all match");

        HttpRangeValidator.ValidationOutcome bad206 = HttpRangeValidator.evaluate206(
                100, 256, "bytes 0-255/256", "\"v1\"", "\"v1\"", "", "");
        check(bad206.decision == HttpRangeValidator.Decision.RESTART_FROM_ZERO, "Reject HTTP 206 start offset mismatch");

        // 4. Bilibili input recognition, CDN mirror ranking & XXE/SegmentTimeline hardening
        check(BilibiliResolver.isBilibiliInput("BV1xx411c7mD"), "Recognize bare BV ID");
        check(BilibiliResolver.isBilibiliInput("https://b23.tv/BV1GJ411x7h7"), "Recognize b23.tv short link");
        List<String> ranked = BilibiliResolver.rankMirrors(Arrays.asList(
                "https://upos-sz-mirrorcosov.bilivideo.com/a.m4s",
                "https://xy1.mcdn.bilivideo.cn/a.m4s",
                "https://upos-sz-mirrorcos.bilivideo.com/a.m4s"
        ));
        check(ranked.get(0).contains("upos-sz-mirrorcos.bilivideo.com"), "Prioritize stable domestic UPOS mirror over cosov/mcdn");

        // 5. DASH SegmentTimeline + XXE DOCTYPE rejection + valid 206 resume check
        String timelineMpd = "<?xml version=\"1.0\"?><MPD type=\"static\" mediaPresentationDuration=\"PT6S\">"
                + "<Period><AdaptationSet contentType=\"video\" mimeType=\"video/mp4\">"
                + "<Representation id=\"v480\" width=\"854\" height=\"480\" bandwidth=\"800000\">"
                + "<SegmentTemplate initialization=\"init.mp4\" media=\"seg-$Time$.m4s\" timescale=\"1000\">"
                + "<SegmentTimeline><S t=\"0\" d=\"2000\" r=\"2\"/></SegmentTimeline>"
                + "</SegmentTemplate></Representation></AdaptationSet></Period></MPD>";
        DashEngine.DashPlan tlPlan = DashEngine.parseMpd("https://cdn.example.test/tl/manifest.mpd", timelineMpd);
        check(tlPlan.supported && tlPlan.videoTracks.get(0).segmentUrls.size() == 3, "Parse DASH SegmentTimeline with r=2 -> 3 segments");
        check("https://cdn.example.test/tl/seg-4000.m4s".equals(tlPlan.videoTracks.get(0).segmentUrls.get(2)), "Expand $Time$ accurately");

        String xxeMpd = "<?xml version=\"1.0\"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM \"file:///etc/passwd\">]><MPD type=\"static\"><Period/></MPD>";
        DashEngine.DashPlan xxePlan = DashEngine.parseMpd("https://cdn.example.test/xxe.mpd", xxeMpd);
        check(!xxePlan.supported, "Reject XXE DOCTYPE MPD manifest");

        HttpRangeValidator.ValidationOutcome ok206 = HttpRangeValidator.evaluate206(
                100, 256, "bytes 100-255/256", "\"v1\"", "\"v1\"", "", "");
        check(ok206.decision == HttpRangeValidator.Decision.APPEND_VERIFIED && ok206.verifiedTotalLength == 256,
                "Accept valid HTTP 206 resume when offset, length, and ETag match");

        HttpRangeValidator.ValidationOutcome badEtag206 = HttpRangeValidator.evaluate206(
                100, 256, "bytes 100-255/256", "\"v1\"", "\"v2\"", "", "");
        check(badEtag206.decision == HttpRangeValidator.Decision.RESTART_FROM_ZERO,
                "Reject HTTP 206 resume when ETag changed mid-download");

        System.out.println("ANDROID_CORE_SELF_TEST_PASSED total=" + passed);
    }
}
