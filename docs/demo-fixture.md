# F12 Professional Demo Fixture

`npm run smoke:demo` runs an end-to-end demonstration of the Agent Browser Runtime
using a local HTTP fixture. No real targets are accessed.

## What the Demo Proves

| Capability | Evidence |
|---|---|
| Complex local page capture | Network, Console, Frame, Storage, Worker signals |
| F12 evidence capture | HAR, application export, worker/frame boundary, drilldown plan |
| Bounded operator report | Compact Markdown with artifact paths and tool call routes |
| Agent handoff | `operatorHandoff` with firstRead, routeArtifacts, firstRequest, drilldowns |
| Objective tool boundary | No vulnerability conclusions, no risk scores |

## Running the Demo

Start the Managed Browser server first:

```bash
CDP_LAUNCH_BROWSER=1 npm run agent:server
```

Then run the demo smoke (which also starts its own Managed Browser internally):

```powershell
npm run smoke:demo
```

The smoke starts a fresh managed server and headless Chrome internally, so no
separate server process is needed.

This is a smoke-test exception. For professional target validation, Managed
Browser should run headful by leaving `CDP_BROWSER_HEADLESS` unset, so the
operator can see the same browser surface the agent is controlling.

## Evidence Surfaces

The fixture at `http://127.0.0.1:<random-port>/` serves:

### Network
| Path | Signal |
|---|---|
| `/` | Main page — initiates all other requests |
| `/api/data` | 200 JSON response + `set-cookie` header |
| `/api/error` | 500 error response (intentional fixture evidence) |
| `/redirect-start` | 302 → `/redirect-middle` |
| `/redirect-middle` | 302 → `/redirect-final` |
| `/redirect-final` | 200 final response |
| `/iframe.html` | Iframe page loaded by the main page |
| `/worker.js` | Web Worker script |

### Console
The main page fires `console.log`, `console.warn`, and `console.error` on load.
The research pack enables Console capture before a reload window, then verifies
the real CDP Console output contains the demo log, warning, and error markers.

### Storage / Application
- `localStorage.setItem("demo_fixture_marker", ...)`
- `sessionStorage.setItem("demo_fixture_session", ...)`
- `document.cookie = "demo_fixture_cookie=..."` plus API `set-cookie` response

### Frame Boundary
An `<iframe src="/iframe.html">` creates a child frame that is captured by the
worker/frame boundary report.

### Shadow DOM
A shadow root is attached to `#shadow-host` with an inner `#shadow-marker` element.

### Worker Boundary
A `new Worker("/worker.js")` is started from the main page. The worker posts
a ready message back.

## Assertions

`smoke:demo` verifies:

- Research pack JSON artifact exists on disk.
- HAR file exists (contains all requests: normal, 500, redirect chain, iframe).
- Application export exists (localStorage, sessionStorage, cookie capture).
- Worker/frame boundary report exists (iframe frame captured).
- `requestCount >= 4` (main page + api/data + api/error + at least one redirect hop).
- `consoleEntryCount >= 3` and the real Console evidence contains the demo
  log, warning, and error markers.
- Operator Demo Report exists on disk.
- Report contains `## Operator Handoff`.
- Report contains `## Objective Boundary`.
- Report contains `devtools_artifact_read` tool reference.
- Report does **not** contain: `vulnerability found`, `high risk`, `critical risk`,
  `exploitable`, `security score`.

## Output

On success, `smoke:demo` prints:

```
F12 demo fixture smoke passed:
- fixture url:          http://127.0.0.1:<PORT>/
- requests:             <N>
- failed requests:      0
- console entries:      <N>
- artifact files:       <N>
- research pack:        <path>/security-research-pack.json
- har:                  <path>/capture.har
- application export:   <path>/application-export.json
- worker/frame:         <path>/worker-frame-boundary.json
- pack dump:            <tmp>/demo-security-research-pack.json
- demo report:          <tmp>/demo-operator-report.md (<N> chars)
```

All temporary paths are cleaned up automatically after the smoke completes.

## Design Notes

- The fixture server is entirely local (`127.0.0.1`, random ephemeral port).
- The 500 response at `/api/error` is **intentional fixture evidence** — it
  demonstrates that the runtime captures all HTTP responses, not just successful
  ones. It is not a vulnerability finding.
- Redirects generate multiple CDP `Network.requestWillBeSent` events (one per
  hop), so the total `requestCount` reflects the full redirect chain.
- The demo report is generated via `adaptPackForReport` (CLI adapter) +
  `buildOperatorDemoReport` (shared helper), which is the same path used by
  `npm run research:pack -- --report-md <path>`.
- Console capture is intentionally enabled before a reload window. This mirrors
  opening DevTools before reproducing an issue: Console events emitted before
  listeners are attached cannot be reconstructed later.
- `smoke:demo` is intentionally **excluded from `npm run check`** to keep
  the daily check fast. Run it manually for portfolio demonstrations or
  integration validation.
