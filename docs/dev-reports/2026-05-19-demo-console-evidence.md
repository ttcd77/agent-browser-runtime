# Dev Report: Console Evidence Capture in Demo Fixture

**Date**: 2026-05-19
**Commit**: 05b21a2
**Task**: Fix `consoleEntryCount = 0` in `npm run smoke:demo`

---

## Modified Files

| File | Change |
|---|---|
| `scripts/agent-cdp-server.mjs` | Add `cdp_query {type:"console"}` call; use persistent buffer for `consoleEntryCount`; expose `persistentConsole` in evidence |
| `scripts/demo-fixture-smoke.mjs` | Extract markers from `persistentConsole.logs`; assert `consoleEntryCount >= 3` and three marker strings |

---

## Commit Hash

```
05b21a2 Capture console evidence in demo fixture
```

---

## Test Commands and True Results

```
node --check scripts/agent-cdp-server.mjs   → Syntax OK
node --check scripts/demo-fixture-smoke.mjs → Syntax OK
npm run smoke:demo                          → F12 demo fixture smoke passed
npm run smoke:example                       → Security research pack example smoke passed
npm run smoke:cli                           → Research pack CLI smoke passed
npm run check                              → build OK, 83 tests passed, smoke:cli OK
```

### `npm run smoke:demo` actual output

```
F12 demo fixture smoke passed:
- fixture url:          http://127.0.0.1:52358/
- requests:             7
- failed requests:      0
- console entries:      9 (persistent buffer: 9)
- artifact files:       20
- research pack:        ...\runtime\profiles\demo-fixture-smoke\research-packs\...-security-research-pack.json
- har:                  ...\runtime\profiles\demo-fixture-smoke\har\...-network.har
- application export:   ...\runtime\profiles\demo-fixture-smoke\application\...-application-export.json
- worker/frame:         ...\runtime\profiles\demo-fixture-smoke\boundaries\...-worker-frame-deep-dive.json
- pack dump:            ...\demo-security-research-pack.json
- demo report:          ...\demo-operator-report.md (5671 chars)
```

`consoleEntryCount` is now **9** (3 explicit log/warn/error calls, plus follow-on
fetch/redirect/worker console events captured during the hard reload window).

---

## Root Cause

Two-part root cause:

### 1. Architectural: per-call CDP connection misses page-load events

`browser_console_log` (and the `agent_inspect focus=console` path that calls it)
opens a **new CDP connection** per call. Even with `reload: true`, the sequence is:

1. New connection opens
2. `Runtime.enable()` + listener registered
3. `Page.reload()` triggered
4. Wait `waitMs`

Chrome delivers `Runtime.consoleAPICalled` events to connections that have called
`Runtime.enable()`. However, the page-load scripts fire synchronously during
navigation, and in practice the events arrive before the per-call listener is
ready — resulting in 0 captured entries in the `browser_console_log` result.

The `cdp-traffic-capture` plugin, by contrast, runs a **persistent CDP connection**
that calls `Runtime.enable()` during `attachProfile` — before any navigation. Its
`Runtime.consoleAPICalled` listener is already active when the page loads, so all
console events during `hard_reload` are captured in `ProfileState.consoleLogs`.

### 2. Formula bug (secondary)

The fallback lines in the `consoleEntryCount` formula read
`overview?.evidence?.console?.entryCount` and
`overview?.evidence?.console?.entries?.length`. Neither field exists in the
`browser_console_log` result (`{ counts: {console:N, logs:N}, console:[...] }`),
so the fallback always returned 0. The primary `countConsoleEntries` helper
already handled the correct shape, but the redundant fallbacks masked this.

---

## Fix

### `agent-cdp-server.mjs`

In `browser_security_research_pack.execute()`, after the `agent_inspect` calls,
add a `cdp_query` call to read the persistent buffer:

```js
// Read the persistent console buffer captured by the traffic-capture plugin.
// This buffer is populated via Runtime.consoleAPICalled + Log.entryAdded on the
// persistent CDP connection, which is active before hard_reload, so all page-load
// events are captured.
const persistentConsole = await safeCall("cdp_query", { type: "console", limit: Math.max(limit, 100) });
```

`consoleEntryCount` now uses the persistent buffer as primary source:

```js
const consoleEntryCount =
  (typeof persistentConsole?.total === "number" ? persistentConsole.total : null) ??
  (countConsoleEntries(consoleEvidence) || countConsoleEntries(consoleReloadCapture) || 0);
```

`persistentConsole` is included in the returned `evidence` object so downstream
tools can access the log entries directly.

### Why the persistent buffer works

The `cdp-traffic-capture` plugin calls `Runtime.enable()` and `Log.enable()` on
its persistent connection during `attachProfile` — **before any page navigation**.
`Runtime.consoleAPICalled` and `Log.entryAdded` events are then delivered to that
connection for the lifetime of the browser session, including during `hard_reload`.

`cdp_query { type: "console" }` reads directly from `ProfileState.consoleLogs`
and returns `{ total, bufferSize, returned, logs }`. `total` is the unfiltered
entry count — the correct value for `consoleEntryCount`.

### `demo-fixture-smoke.mjs`

Console texts are now extracted from both the persistent buffer and the per-call
fallback:

```js
const persistentLogs = pack.evidence?.persistentConsole?.logs || [];
const consoleTexts = [
  // Persistent buffer: each entry has args[].value (string)
  ...persistentLogs.flatMap((entry) =>
    (entry.args || []).map((a) => String(a.value ?? a.description ?? "")),
  ),
  // Per-call fallback: browser_console_log already maps args to primitive values
  ...consoleEvents
    .flatMap((entry) => entry.args || entry.text || [])
    .map((value) => String(value)),
];
```

Assertions restored:
- `summary.consoleEntryCount >= 3`
- `consoleTexts` includes `"demo-fixture: page load started"` (log)
- `consoleTexts` includes `"intentional warning signal"` (warn)
- `consoleTexts` includes `"intentional error signal"` (error)

---

## Assertion Coverage — Console Evidence

| Assertion | Before Fix | After Fix |
|---|---|---|
| `consoleEntryCount >= 3` | Failed (count = 0) | Passes (count = 9) |
| log marker `"demo-fixture: page load started"` | Failed (texts empty) | Passes |
| warn marker `"intentional warning signal"` | Failed (texts empty) | Passes |
| error marker `"intentional error signal"` | Failed (texts empty) | Passes |

---

## Why 9 Entries (not 3)

The fixture page fires 3 explicit `console.log/warn/error` calls, but also
produces additional entries:
- `console.log("demo-fixture: api/data ok marker=...")` after the fetch resolves
- `console.warn("demo-fixture: api/error HTTP status=500")` from the error handler
- `console.log("demo-fixture: redirect chain done ...")` after redirects complete
- `console.log("demo-fixture: worker replied ...")` from the Web Worker message
- Entries from the iframe `console.log("demo-iframe: loaded")`

All 9 are real CDP `Runtime.consoleAPICalled` events from the fixture page.

---

## Design Notes

- `cdp_query` is registered by the plugin into `harness.tools`, the same map used
  inside `browser_security_research_pack.execute()` via `safeCall`. No new IPC or
  HTTP round-trips are needed.
- `safeCall` wraps the call in try/catch and returns `{ unavailable: true }` on
  failure. The formula `typeof persistentConsole?.total === "number" ? ... : null`
  safely falls back to per-call counts if the plugin is unavailable.
- `smoke:demo` remains excluded from `npm run check` to keep the daily check fast.

---

## Objective Boundary

The fix only improves evidence collection. It does not classify console events,
HTTP 500 responses, or any other signal as vulnerabilities. The demo remains
local-only and does not access real targets.

---

## Unresolved Issues

None. `consoleEntryCount = 0` is fully resolved. All console assertions pass.
