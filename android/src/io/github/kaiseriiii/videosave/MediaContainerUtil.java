package io.github.kaiseriiii.videosave;

import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;

/**
 * Binary container & payload integrity verifier for Android downloads.
 * Strictly prevents HTML, XML (including DASH MPD manifests), JSON, or M3U8 text
 * from ever being saved as .mp4 / .m4a / .ts and marked complete.
 */
public final class MediaContainerUtil {

    public static final class CheckResult {
        public final boolean valid;
        public final String format;
        public final String reason;

        public CheckResult(boolean valid, String format, String reason) {
            this.valid = valid;
            this.format = format;
            this.reason = reason;
        }
    }

    public static boolean looksLikeTextOrManifest(byte[] head, int len) {
        if (head == null || len < 4) return true;
        int start = 0;
        // Skip UTF-8 BOM if present
        if (len >= 3 && (head[0] & 0xff) == 0xEF && (head[1] & 0xff) == 0xBB && (head[2] & 0xff) == 0xBF) {
            start = 3;
        }
        while (start < len && (head[start] == ' ' || head[start] == '\t' || head[start] == '\r' || head[start] == '\n')) {
            start++;
        }
        if (start >= len) return true;
        String sample = new String(head, start, Math.min(len - start, 128), StandardCharsets.UTF_8).toLowerCase();
        if (sample.startsWith("<!doctype") || sample.startsWith("<html") || sample.startsWith("<?xml")
                || sample.startsWith("<mpd") || sample.startsWith("#extm3u") || sample.startsWith("{")
                || sample.startsWith("[{") || sample.startsWith("error")) {
            return true;
        }
        if (sample.contains("<mpd ") || sample.contains("<adaptationSet".toLowerCase()) || sample.contains("<html")) {
            return true;
        }
        return false;
    }

    public static boolean looksLikeImage(byte[] head, int len) {
        if (head == null || len < 8) return false;
        // JPEG FF D8 FF
        if ((head[0] & 0xff) == 0xFF && (head[1] & 0xff) == 0xD8 && (head[2] & 0xff) == 0xFF) return true;
        // PNG 89 50 4E 47
        if ((head[0] & 0xff) == 0x89 && head[1] == 'P' && head[2] == 'N' && head[3] == 'G') return true;
        // GIF87a / GIF89a
        if (head[0] == 'G' && head[1] == 'I' && head[2] == 'F' && head[3] == '8') return true;
        // WebP RIFF....WEBP
        if (len >= 12 && head[0] == 'R' && head[1] == 'I' && head[2] == 'F' && head[3] == 'F'
                && head[8] == 'W' && head[9] == 'E' && head[10] == 'B' && head[11] == 'P') return true;
        return false;
    }

    public static CheckResult inspectHeaderBytes(byte[] head, int len) {
        if (head == null || len < 12) {
            return new CheckResult(false, "empty", "Payload too small (< 12 bytes)");
        }
        if (looksLikeTextOrManifest(head, len)) {
            return new CheckResult(false, "text-manifest", "Payload is HTML/XML/JSON/M3U8 text, not binary media");
        }
        if (looksLikeImage(head, len)) {
            return new CheckResult(false, "image", "Payload is an image file, not video/audio media");
        }
        // ISOBMFF (MP4 / M4A / M4S / fMP4 / MOV): 4-byte size + 4-byte ASCII box type
        String box = new String(head, 4, 4, StandardCharsets.US_ASCII);
        if ("ftyp".equals(box) || "styp".equals(box) || "moov".equals(box) || "moof".equals(box)
                || "sidx".equals(box) || "mdat".equals(box) || "free".equals(box) || "wide".equals(box)) {
            return new CheckResult(true, "isobmff", "Valid ISOBMFF box: " + box);
        }
        // EBML (WebM / Matroska): 1A 45 DF A3
        if ((head[0] & 0xff) == 0x1A && (head[1] & 0xff) == 0x45 && (head[2] & 0xff) == 0xDF && (head[3] & 0xff) == 0xA3) {
            return new CheckResult(true, "ebml", "Valid WebM/MKV EBML header");
        }
        // MPEG-TS: 0x47 sync byte at offset 0 (and at 188 if buffer long enough)
        if ((head[0] & 0xff) == 0x47 && (len < 189 || (head[188] & 0xff) == 0x47)) {
            return new CheckResult(true, "mpegts", "Valid MPEG-TS sync packets");
        }
        // ID3-prefixed MPEG-TS / MP3 / AAC
        if (head[0] == 'I' && head[1] == 'D' && head[2] == '3') {
            return new CheckResult(true, "id3-media", "Valid ID3-prefixed media");
        }
        // ADTS AAC / MP3 frame sync (0xFF 0xE0 mask)
        if ((head[0] & 0xff) == 0xFF && ((head[1] & 0xE0) == 0xE0)) {
            return new CheckResult(true, "mpeg-audio", "Valid ADTS/MP3 audio sync");
        }
        // OggS / fLaC / FLV / RIFF WAV/AVI
        String fourcc = new String(head, 0, 4, StandardCharsets.US_ASCII);
        if ("OggS".equals(fourcc) || "fLaC".equals(fourcc) || "RIFF".equals(fourcc)) {
            return new CheckResult(true, fourcc.toLowerCase(), "Valid container: " + fourcc);
        }
        if (head[0] == 'F' && head[1] == 'L' && head[2] == 'V') {
            return new CheckResult(true, "flv", "Valid FLV container");
        }
        // Scan first 512 bytes for offset-wrapped MPEG-TS (e.g. PNG/custom header wrapper before 0x47...0x47)
        int limit = Math.min(len - 189, 512);
        for (int off = 1; off < limit; off++) {
            if ((head[off] & 0xff) == 0x47 && (head[off + 188] & 0xff) == 0x47) {
                return new CheckResult(true, "mpegts-wrapped", "Valid wrapped MPEG-TS at offset " + off);
            }
        }
        return new CheckResult(false, "unknown", "Unrecognized binary header (rejected for safety)");
    }

    public static CheckResult inspectFile(File file) {
        if (file == null || !file.isFile() || file.length() < 64) {
            return new CheckResult(false, "missing", "File missing or smaller than 64 bytes");
        }
        FileInputStream fis = null;
        try {
            fis = new FileInputStream(file);
            byte[] buf = new byte[Math.min(1024, (int) file.length())];
            int read = 0;
            while (read < buf.length) {
                int n = fis.read(buf, read, buf.length - read);
                if (n < 0) break;
                read += n;
            }
            return inspectHeaderBytes(buf, read);
        } catch (Exception e) {
            return new CheckResult(false, "io-error", e.getMessage());
        } finally {
            if (fis != null) try { fis.close(); } catch (Exception ignored) {}
        }
    }
}
