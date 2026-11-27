# Contributing

Use a topic branch and keep fixes scoped. Run `node --test`, the relevant `tests/compatibility.mjs` scenarios, and the release verifier for packaging changes. On Windows the full browser matrix needs Edge, Chrome, Firefox and FFmpeg. See the [architecture](docs/architecture.md) and [compatibility report](docs/compatibility-report.zh-CN.md).

Create fixtures from test media you can legally use. Include the expected candidate, relevant browser and executable verification command. Report missing verification and observed failures. Export a diagnostic from the extension before filing a probe issue. Review any file you attach for private URLs, credentials and personal data. Send security reports as described in [SECURITY.md](SECURITY.md).
