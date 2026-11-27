# Changelog

## 0.9.0

- Combine visible player evidence, media request MIME, open Shadow DOM, public source metadata and adaptive manifests.
- Refresh the browser panel when players, sources or observed responses change. Group alternate qualities and suppress manifest initialization fragments.
- Give HTTP and MCP consumers candidate evidence, confidence and legal next actions. Recognize DRM and site access restrictions when the observable evidence identifies them.
- Export a diagnostic report through a local allowlist and back up, import or reset browser preferences.
- Produce portable Windows, Chromium, Firefox and experimental Android archives with SHA-256 checksums and a software bill of materials.
- Add cross-browser, packaging and local service security checks. See the [compatibility report](docs/compatibility-report.zh-CN.md) for the measurements and failures.

## 0.8.1

Added the Windows portable setup flow, adaptive prefetch, MCP batch waiting and failure details, headers and checkpoint-based recovery.
