# Contributing to VideoSave

Thank you for your interest in contributing to VideoSave!

## Core Engineering Principles
1. **Zero third-party npm dependencies**: All JavaScript uses Node.js 24+ built-ins and standard browser ES modules.
2. **Local-first privacy & strict authorization boundaries**: Never add telemetry, never access system browser profile folders, and never implement DRM or anti-bot bypasses.
3. **Hermetic test isolation**: Every test MUST use `tests/test-sandbox.mjs` (`createTestSandbox`). Never write test artifacts to the user's real `Downloads` or configured `outDir`.
4. **Honest, reproducible evidence**: Every claimed capability or benchmark must be backed by automated tests or JSON reports under `docs/compatibility-data/`.

## Running Tests Locally
```bash
# Syntax check
node --check tools/media-downloads.mjs

# Full automated test suite (isolated inside .ots/tmp/videosave-tests/)
node --test --test-concurrency=2 tests/*.test.mjs

# Build & verify deterministic release archives + CycloneDX SBOM
python tools/build_release.py
python tools/verify_release.py
```

## Pull Request Checklist
- Keep changes focused and well-tested.
- Add regression tests for every bug fix and security hardening change.
- Update EN/zh-CN documentation when changing public CLI, HTTP API, or MCP schemas.
- Never commit personal file paths, cookies, tokens, or private URLs.
