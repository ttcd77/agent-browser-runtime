# Dev Report: Capture Console Evidence in Demo Fixture

**Date**: 2026-05-19  
**Commit**: see `git log` for the commit that added this report  
**Task**: Fix `smoke:demo` Console evidence so the local F12 demo covers Network, Application, Frame/Worker, and Console surfaces.

---

## Modified Files

| File | Change |
|---|---|
| `scripts/agent-cdp-server.mjs` | Added a Console-first reload capture inside `devtools_security_research_pack` and derived `summary.consoleEntryCount` from real Console tool output. |
| `scripts/demo-fixture-smoke.mjs` | Added strict assertions for `console.log`, `console.warn`, and `console.error` markers from real captured Console evidence. |
| `docs/demo-fixture.md` | Updated demo documentation to describe verified Console capture and the listener-before-reload boundary. |

---

## Root Cause

The demo fixture page already emitted:

- `console.log("demo-fixture: page load started")`
- `console.warn("demo-fixture: intentional warning signal for F12 Console")`
- `console.error("demo-fixture: intentional error signal for F12 Console")`

However, `devtools_security_research_pack` previously relied on a post-load `agent_inspect focus=console` path. That registers Console listeners after the page has already emitted its load-time messages, so the summary reported:

```text
consoleEntryCount = 0
```

This is the same boundary as human DevTools: if Console recording is not open before reproduction, earlier Console events cannot be reconstructed later.

---

## Fix

`devtools_security_research_pack` now keeps the existing hard reload path for Network evidence, then runs a Console-specific reload capture:

```text
browser_console_log(reload=true, ignoreCache=true)
```

That enables `Runtime.consoleAPICalled` / `Log.entryAdded` before the reload window and captures real Console output. The pack summary now derives `consoleEntryCount` from the actual Console tool output first, with older overview-derived fields as fallback.

No Console count is fabricated. The smoke test reads the captured Console event text and asserts the exact fixture markers.

---

## Final Console Evidence

Latest local run:

```text
npm run smoke:demo
```

Result:

```text
console entries: 8
```

Required markers verified from captured evidence:

- `demo-fixture: page load started`
- `demo-fixture: intentional warning signal for F12 Console`
- `demo-fixture: intentional error signal for F12 Console`

---

## Test Commands and Results

```text
node --check scripts/demo-fixture-smoke.mjs       OK
node --check scripts/agent-cdp-server.mjs         OK
npm run smoke:demo                                EXIT 0
npm run smoke:cli                                 EXIT 0
npm run smoke:example                             EXIT 0
npm run check                                     EXIT 0
```

`npm run check` included:

- TypeScript build
- plugin manifest copy
- 83 unit tests
- `smoke:cli`

---

## Objective Boundary

The fix only improves evidence collection. It does not classify Console errors, HTTP 500 responses, redirects, or any other signal as vulnerabilities.

The demo remains local-only and does not access real targets.

---

## Unresolved Issues

None for this scope.

One product note: the research pack now performs a hard reload for Network evidence and a Console-specific reload for Console evidence. This is reliable and explicit, but a future refinement could merge both into one shared listener-before-reload capture window.

---

## Next Steps

1. Add a committed sample operator report generated from the local fixture so reviewers can inspect output without running the project.
2. Add a short "5-minute reviewer demo" section to `README.md`.
3. Consider a future shared capture primitive that enables Network, Runtime, Log, Page, and Storage listeners before a single reproduction window.
