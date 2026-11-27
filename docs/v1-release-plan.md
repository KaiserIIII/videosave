# VideoSave v1.0 delivery plan

The released v0.10.0 tag is the comparison baseline. Record first-pass misses and separate retests. Keep the existing extension, service, and standalone MCP entry points.

1. Start with owner-enabled browser-associated CDN sources in managed MCP. Keep browser evidence bound to the approved document. Restrict remote transfers, resolve and pin public CDN addresses on connection, and keep page credentials on the page's exact origin. Exercise rejection, redirect, credential isolation and signed-manifest paths before enabling the capability.
2. Stage supported static, unencrypted DASH into local files. Validate every remote reference through the managed request scope. Reuse the existing local muxing and verification path. Label unsupported MPD features with stable errors.
3. Reproduce pre-navigation browser timeouts on the same MCP fixture matrix. Fix only the failed startup phase with a bounded budget. Add execution modes and expose engine and task evidence through existing MCP operations where possible.
4. Expand fixtures by distinct behavior and use official public samples. Compare candidate and baseline under the same test conditions. Keep separate counts for extension, managed and standalone MCP, and companion service.
5. Review the changed authorization, networking, parsing, cleanup and subprocess boundaries. Check distribution and documentation against tested capabilities. Choose a release candidate if a v1.0 milestone is still missing. Attach verified builds and signed provenance only after CI and package acceptance.
