# VideoSave 1.0 release candidate security review

## Browser authority and transfer boundary

- The paired extension submits playback evidence. The managed client can request an approval and choose candidate IDs. It cannot submit playback observations or change the allowed origins. Test coverage includes independent standing download consent, caller ownership, tab reload and logout, and revoking paused work.
- Related public HTTPS media requires owner consent and successful playback evidence tied to the approved document and frame. A manifest can reference its own origin. A different origin needs an exact observed resource tied to the same frame and player origin. Redirects require an exact approved target and are capped at three hops.
- For related CDN requests, DNS lookup runs inside the HTTPS connection. Private, loopback, reserved and mixed public/private answers are rejected. The CDN path requires direct routing because the existing proxy cannot enforce this lookup policy. The exact approved site can still be a local host for legitimate local media and fixtures.
- Only sanitized playback Referer, Origin and User-Agent enter the managed transport. The selected direct file may use its same-origin Cookie subject to its domain, path, expiry and Secure rules. Cross-origin and redirect requests do not inherit those cookies. CDN-specific login credentials are unsupported in this candidate.
- Managed candidate, task and approval responses use allowlists. Signed resources are held in the extension's session storage and the companion's in-memory grant. Approval outputs and compatibility reports contain no raw resource evidence. The separate legacy local HTTP and standalone MCP interfaces can still return URLs to their trusted operator.
- An HTTP access denial or a browser challenge stops the managed transfer. A known expired URL requires fresh approved playback. A new signature or additional origin does not silently expand an active job's authorization.

## Media parsing and output

- The DASH parser rejects entity declarations, unsupported structures, oversized manifests and unbounded segment expansions. Track initialization is checked for declared protection before segment transfer. The staged outputs are checked for expected tracks and duration. DRM, denied access or an out-of-scope URL is a terminal outcome.
- Managed FFmpeg operates on companion-generated local staging files with protocol restrictions. File verification resolves the output under the recorded destination and checks it with FFprobe. The release introduces no new executable dependency. Installer sources, commits and checksums remain in the packaged SBOM.
- Strategy imports accept only exact origins and supported strategy values. They cannot execute code. Adaptive probe history contains aggregated outcomes and no media URL, credential, page content or download record.

## Verification scope

The changed paths are exercised by `tests/mcp-control.test.mjs`, `tests/managed-batch-controls.test.mjs`, `tests/mcp-control-browser.test.mjs`, `tests/dash-prefetch.test.mjs`, and `tests/compatibility-policy.test.mjs`. The optional public acceptance run uses a Mozilla CC0 sample and normal embedded playback. A public cross-CDN adaptive stream with every segment and redirect covered was not validated. The review does not cover a fresh independent audit of FFmpeg, browser binaries, yt-dlp, or their transitive dependencies.
