## Summary
-

## DSH / User Impact & Compatibility
- [ ] Verified in isolated test sandbox (zero writes to real Downloads/configured `outDir`)
- [ ] Regression tests added/updated
- [ ] Cross-origin credential isolation & security boundaries preserved
- [ ] Docs / CHANGELOG updated if user-facing behavior changed

## Verification Commands & Results
```powershell
node --test --test-concurrency=2 tests/*.test.mjs
```
