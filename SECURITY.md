# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities through the repository’s private advisory form. If private reporting is unavailable, open a general issue asking for a private contact channel and omit the technical details. [Report a vulnerability](https://github.com/KaiserIIII/videosave/security/advisories/new)

Include the VideoSave version, affected component, operating system, browser version, impact, and reproducible steps using test data. Remove pairing codes, cookies, access tokens, signed URLs and personal data before sending a report.

The maintainer will confirm receipt when available, investigate affected versions, and coordinate any public disclosure after a mitigation or fix is ready.

## Trust boundaries

- The HTTP companion binds to IPv4 loopback. It checks the request host, browser origin and bearer pairing code. Enter the code displayed in the launcher terminal into the trusted extension. Treat that terminal output and the local settings database as private.
- An MCP client and authenticated HTTP client can submit URLs, manage downloads and read or change the local settings allowed by their tools. Configure only clients you trust. Run the companion on the same machine as its users and keep its port off public interfaces and proxies.
- The media client can reach URLs that the machine is allowed to access, including local origins. Its network access follows the machine’s network policy. The companion is designed for single-user local operation.
- Managed MCP clients use a dedicated loopback endpoint and a profile-scoped authentication value derived locally from the existing pairing. Management requests require the owner pairing. Current-tab grants expire and belong to one profile. Downloads use only the candidates approved for that profile, and job lookups check ownership.
- Optional browser cookies apply only to the observed direct resource that the user approved. The managed transfer rejects redirects, checks cookie scope and expiry before each request, and gives FFmpeg a local staged file. Browser confirmation and the short lease limit exposure after navigation or loss of contact.
- Page titles, descriptions, source URLs and embedded configuration are untrusted data. MCP clients must treat them as inputs and use the user’s request to authorize tool calls.
- A local diagnostic export provides a small list of detection codes and candidate types. Review your attachments before including them in an issue. [Privacy policy](docs/privacy.md)
