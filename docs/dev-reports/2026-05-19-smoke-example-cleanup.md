# Dev Report: Stabilize smoke:example cleanup on Windows

**Date**: 2026-05-19  
**Commit**: see below  
**Author**: Claude

---

## Modified Files

| File | Change |
|---|---|
| `scripts/example-security-research-pack-smoke.mjs` | Added `waitForChildExit`, `removePathWithRetry` helpers; rewrote `finally` block to await proper shutdown sequence |

No product files (examples, docs, src) were changed.

---

## Was EBUSY Reproduced?

Yes. Before this fix, `npm run smoke:example` printed all passing assertions then threw:

```
Error: EBUSY: resource busy or locked, unlink '...\browser\Default\Affiliation Database'
```

and exited with code **1**, even though all test assertions passed.

**Root cause**: the old `finally` block used two un-awaited `setTimeout` calls:

```js
setTimeout(() => runtime.kill(), 500);   // kill browser at T+500ms
setTimeout(() => rmSync(tempDir, ...), 1000);  // delete at T+1000ms
```

The `finally` block returned immediately (before either timer fired). Node kept the event loop alive for the timers. When `rmSync` ran at T+1000ms, Chrome had only been killed 500ms earlier — on Windows, the OS had not yet released the `Default/Affiliation Database` file handle, causing `EBUSY`.

---

## How It Was Fixed

Three changes to `scripts/example-security-research-pack-smoke.mjs`:

### 1. `waitForChildExit(child, timeoutMs)`

Waits for the child process `exit` event (or a hard timeout fallback). Checks `exitCode !== null` first to handle already-exited processes.

### 2. `removePathWithRetry(dirPath, { maxRetries, baseDelayMs })`

Retries `rmSync` up to 8 times with exponential backoff on `EBUSY`, `EPERM`, or `ENOTEMPTY`. Doubles the delay on Windows (`platform === "win32"`). If all retries are exhausted, it **warns** (`console.warn`) but does **not** throw — a cleanup race must not convert a passing test into a failing one.

### 3. Rewritten `finally` block

```js
} finally {
  // 1. Ask the agent server to shut down gracefully.
  await fetch(`http://127.0.0.1:${serverPort}/shutdown`, { method: "POST" }).catch(() => {});
  // 2. Give the server a moment to begin closing before we kill the child.
  await sleep(300);
  // 3. Kill the browser / runtime child process.
  runtime.kill();
  // 4. Close the fixture HTTP server.
  fixture.server.close();
  // 5. Wait for the child process to actually exit so the OS can release its
  //    file handles before we try to delete the temp directory.
  await waitForChildExit(runtime, 5000);
  // 6. Extra grace period on Windows where handle release is asynchronous.
  await sleep(platform === "win32" ? 400 : 100);
  // 7. Remove temp dir with retry; EBUSY on Windows is handled inside.
  await removePathWithRetry(tempDir);
}
```

Key properties:
- Main test failure still propagates: `removePathWithRetry` only suppresses cleanup errors, not assertion errors.
- No infinite loops: max 8 retries, plus a 5 s hard timeout on process exit.
- Non-silent: final cleanup failure prints a clearly-labelled `[cleanup] Warning`.

---

## Test Commands and Results

```
node --check scripts/example-security-research-pack-smoke.mjs   → OK (syntax)
npm run smoke:example                                            → EXIT 0 ✅
npm run check  (build + 83 unit tests + CLI smoke)               → EXIT 0 ✅
```

`npm run smoke:example` output (post-fix):

```
Security research pack example smoke passed:
- fixture: http://127.0.0.1:24336/
- requests: 3
- research pack: ...\1779157652773-security-research-pack.json
- drilldowns: 5
- route artifacts: 11
- operatorHandoff.routeArtifacts: 11
- operatorHandoff.firstRequest.tool: devtools_request_detail
- operatorHandoff.drilldowns: 3
EXIT: 0
```

No EBUSY error, no warning from `removePathWithRetry` (cleanup succeeded on first attempt after the extra grace period).

---

## Commit Hash

<!-- filled in after commit -->
**`<filled below>`**

---

## Unresolved Issues

None. The EBUSY race is resolved. If a future machine is slower to release handles, `removePathWithRetry` will retry up to 8 times (total ~9 s worst case on Windows) before warning — well within acceptable CI timeouts.

---

## Next Steps

- No further action required for this issue.
- If the project adds a second smoke test that launches a browser, extract `waitForChildExit` and `removePathWithRetry` into a shared test helper (e.g. `scripts/test-helpers.mjs`) to avoid duplication.
