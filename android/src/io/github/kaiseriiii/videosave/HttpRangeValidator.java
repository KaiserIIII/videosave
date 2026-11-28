package io.github.kaiseriiii.videosave;

import java.io.File;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Strict RFC 9110 HTTP Range & 416 resume validator.
 * Fixes the v1.2.0 defect where HTTP 416 blindly treated any existing .part file as complete.
 */
public final class HttpRangeValidator {

    private static final Pattern CONTENT_RANGE_COMPLETE = Pattern.compile("^bytes\\s+\\*/(\\d+)$", Pattern.CASE_INSENSITIVE);
    private static final Pattern CONTENT_RANGE_PARTIAL = Pattern.compile("^bytes\\s+(\\d+)-(\\d+)/(\\d+|\\*)$", Pattern.CASE_INSENSITIVE);

    public enum Decision {
        COMPLETE_VERIFIED,
        APPEND_VERIFIED,
        RESTART_FROM_ZERO,
        REJECT_ERROR
    }

    public static final class ValidationOutcome {
        public final Decision decision;
        public final long verifiedTotalLength;
        public final String reason;

        public ValidationOutcome(Decision decision, long verifiedTotalLength, String reason) {
            this.decision = decision;
            this.verifiedTotalLength = verifiedTotalLength;
            this.reason = reason;
        }
    }

    public static long parse416TotalLength(String contentRangeHeader) {
        if (contentRangeHeader == null) return -1L;
        Matcher m = CONTENT_RANGE_COMPLETE.matcher(contentRangeHeader.trim());
        if (!m.matches()) return -1L;
        try {
            return Long.parseLong(m.group(1));
        } catch (NumberFormatException e) {
            return -1L;
        }
    }

    public static long[] parse206ContentRange(String contentRangeHeader) {
        if (contentRangeHeader == null) return null;
        Matcher m = CONTENT_RANGE_PARTIAL.matcher(contentRangeHeader.trim());
        if (!m.matches()) return null;
        try {
            long start = Long.parseLong(m.group(1));
            long end = Long.parseLong(m.group(2));
            long total = "*".equals(m.group(3)) ? -1L : Long.parseLong(m.group(3));
            return new long[]{start, end, total};
        } catch (NumberFormatException e) {
            return null;
        }
    }

    public static boolean resourceIdentityMatches(String storedEtag, String responseEtag,
                                                  String storedLastMod, String responseLastMod) {
        if (storedEtag != null && !storedEtag.isEmpty() && responseEtag != null && !responseEtag.isEmpty()) {
            if (!storedEtag.trim().equals(responseEtag.trim())) return false;
        }
        if (storedLastMod != null && !storedLastMod.isEmpty() && responseLastMod != null && !responseLastMod.isEmpty()) {
            if (!storedLastMod.trim().equals(responseLastMod.trim())) return false;
        }
        return true;
    }

    /**
     * Evaluate an HTTP 416 response strictly.
     * ONLY returns COMPLETE_VERIFIED if:
     * 1. Server reported exact total length (via Content-Range: bytes * /TOTAL or verified HEAD/probe total)
     * 2. existingBytes == verifiedTotal && verifiedTotal > 0
     * 3. Resource ETag / Last-Modified identity matches stored checkpoint metadata
     * 4. Local file passes binary container magic verification (not HTML/XML/JSON/empty)
     */
    public static ValidationOutcome evaluate416(long existingBytes,
                                                long storedExpectedTotal,
                                                String responseContentRange,
                                                long probedHeadTotal,
                                                String storedEtag,
                                                String responseEtag,
                                                String storedLastMod,
                                                String responseLastMod,
                                                File partFile) {
        long serverTotal = parse416TotalLength(responseContentRange);
        if (serverTotal <= 0 && probedHeadTotal > 0) {
            serverTotal = probedHeadTotal;
        }
        if (serverTotal <= 0) {
            return new ValidationOutcome(Decision.RESTART_FROM_ZERO, -1L,
                    "HTTP 416 without authoritative server total length; refusing to trust partial file");
        }
        if (!resourceIdentityMatches(storedEtag, responseEtag, storedLastMod, responseLastMod)) {
            return new ValidationOutcome(Decision.RESTART_FROM_ZERO, serverTotal,
                    "Remote resource ETag/Last-Modified changed since checkpoint; restarting cleanly");
        }
        if (storedExpectedTotal > 0 && storedExpectedTotal != serverTotal) {
            return new ValidationOutcome(Decision.RESTART_FROM_ZERO, serverTotal,
                    "Server total length changed (" + storedExpectedTotal + " -> " + serverTotal + "); restarting");
        }
        if (existingBytes != serverTotal) {
            return new ValidationOutcome(Decision.RESTART_FROM_ZERO, serverTotal,
                    "Local .part size (" + existingBytes + ") != server total (" + serverTotal + "); truncated/oversized file rejected");
        }
        MediaContainerUtil.CheckResult container = MediaContainerUtil.inspectFile(partFile);
        if (!container.valid) {
            return new ValidationOutcome(Decision.RESTART_FROM_ZERO, serverTotal,
                    "Local .part failed media container verification: " + container.reason);
        }
        return new ValidationOutcome(Decision.COMPLETE_VERIFIED, serverTotal,
                "Verified exact length (" + serverTotal + " B), identity, and container (" + container.format + ")");
    }

    /**
     * Validate an HTTP 206 resume response before appending to an existing .part file.
     */
    public static ValidationOutcome evaluate206(long existingBytes,
                                                long storedExpectedTotal,
                                                String responseContentRange,
                                                String storedEtag,
                                                String responseEtag,
                                                String storedLastMod,
                                                String responseLastMod) {
        long[] range = parse206ContentRange(responseContentRange);
        if (range == null) {
            return new ValidationOutcome(Decision.RESTART_FROM_ZERO, -1L,
                    "HTTP 206 missing valid Content-Range header");
        }
        long start = range[0];
        long end = range[1];
        long total = range[2];
        if (start != existingBytes || end < start) {
            return new ValidationOutcome(Decision.RESTART_FROM_ZERO, total,
                    "HTTP 206 offset mismatch (expected start=" + existingBytes + ", got " + start + ")");
        }
        if (storedExpectedTotal > 0 && total > 0 && storedExpectedTotal != total) {
            return new ValidationOutcome(Decision.RESTART_FROM_ZERO, total,
                    "HTTP 206 total length changed (" + storedExpectedTotal + " -> " + total + ")");
        }
        if (!resourceIdentityMatches(storedEtag, responseEtag, storedLastMod, responseLastMod)) {
            return new ValidationOutcome(Decision.RESTART_FROM_ZERO, total,
                    "HTTP 206 ETag/Last-Modified mismatch; resource modified on server");
        }
        return new ValidationOutcome(Decision.APPEND_VERIFIED, total, "Valid 206 resume range");
    }
}
