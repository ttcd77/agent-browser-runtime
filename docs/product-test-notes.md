# Product Test Notes

## User Problem

AI security agents need more than screenshots. They need a browser workbench that
can answer questions such as:

- What request did this button actually send?
- Did the browser receive a redirect, WebSocket frame, security warning, or
  hidden script?
- Which cookies are present, including HttpOnly cookies?
- Can two test identities, such as buyer and seller, stay isolated?

## Plain Language Vocabulary

| Technical term | Product term | Meaning |
|---|---|---|
| Profile | Agent operating space | A named role or target space with one tab and one evidence directory. |
| Lease | Reserve identity | Temporarily reserve a browser identity so two agents do not collide. |
| CDP | Browser evidence pipe | Chrome's low-level debugging interface for network, script, cookie, and page events. |
| OpenClaw plugin | Agent tool pack | Tools exposed to an AI agent inside OpenClaw. |

## Current Product Smoke

Run:

```bash
npm run smoke:product
```

What this proves:

- the compiled plugin entrypoints import successfully,
- browser identity reservation does not need the old Hub service,
- a busy identity is skipped,
- expired identities return to the pool.

What this does not prove yet:

- a live Chrome or Edge instance is attached,
- OpenClaw has loaded the plugin in a real gateway,
- captured traffic can be queried end to end.

## Standalone Agent Server Smoke

Run:

```bash
npm run smoke:server
```

It proves the framework-neutral path:

1. start a local browser with CDP,
2. start the local HTTP tool server,
3. verify capture is off by default,
4. explicitly start capture for the default and named profiles,
5. create a profile,
6. navigate, click, type, evaluate JavaScript, snapshot, and screenshot,
7. verify profile-local traffic can be queried and fetched,
8. verify `/panel` and `/panel-data` expose public-facing dashboard data without
   tab ids,
9. stop capture cleanly.

## Unified DevTools Contract Smoke

Run:

```bash
npm run contract:devtools
```

It proves the public `devtools_*` tool names stay aligned across Managed Browser
and Personal Chrome when the Personal bridge is running. If Personal Chrome is
not running, it still validates that Managed Browser exposes the contract.

Current verified contract:

- Managed Browser: 86 `devtools_*` tools.
- Personal Chrome: 86 `devtools_*` tools.
- Drift: none.
- Agent facade: 9 `browser_*` default tools over the detailed DevTools layer.

The contract smoke uses an isolated temporary browser profile so it does not
collide with a long-running browser on port 9222.

## Personal Chrome Smoke

Run after the extension bridge is running and the unpacked extension is loaded:

```bash
npm run smoke:personal
```

This smoke starts a local HTTP fixture and opens it in a new Personal Chrome tab.
It checks the connected extension, `devtools_backend_capabilities`,
`chrome.debugger` attachment, `Runtime.evaluate`, frame tree access, and
Application storage-boundary summary against that repeatable fixture instead of
whatever page the user already had focused. It also verifies facade calls:
`browser_open`, `browser_inspect`, `browser_capture`, `browser_raw`, and
`browser_security_pack`.
It verifies `devtools_capture_bisect` as a non-judgmental captured-evidence
splitter for Network, page/frame, and realtime buckets.
It verifies `devtools_capability_map` as the panel-level navigation contract.

## Managed F12 Smoke

Run:

```bash
npm run smoke:f12
```

It starts an isolated temporary managed browser and verifies:

- Security summary on a real HTTPS page,
- CDP protocol schema discovery for raw command planning,
- dashboard-friendly page diagnostics,
- Network summary from an explicit F12 capture,
- Network Timing/Initiator-style timeline rows,
- captured-evidence bisection into Network, page/frame, and realtime buckets,
- HAR completeness reporting for body, timing, redirect, and security evidence,
- panel-level capability map for agent navigation,
- WebSocket frame and EventSource/SSE evidence through `devtools_realtime_log`,
- per-request Network detail including headers, cookies, timing, initiator, and
  ExtraInfo fields where Chrome exposes them,
- Accessibility tree extraction,
- raw Chrome `DOMSnapshot.captureSnapshot`,
- live DOM search through Chrome `DOM.performSearch`,
- selected-node Event Listeners from the Elements panel,
- selected-node Styles/Computed/Box Model evidence from the Elements panel,
- selected-node DOM mutation watch for Elements breakpoint-style evidence,
- raw CDP command escape hatch for F12 features not yet wrapped,
- Debugger pause/resume/step controls, temporary URL breakpoint probes, and
  paused call-frame/scope previews,
- JS heap, DOM counters, and Performance Monitor metrics,
- Chrome Tracing stream capture and trace file output,
- Chrome Tracing summary extraction,
- saved Chrome trace query by category/event/duration/thread/time range,
- saved Chrome trace comparison by event/category/phase/thread/duration buckets,
- Performance insights summary for agent first-pass triage,
- PerformanceObserver entries for LCP, layout shift, long tasks, event timing,
  and long animation frames where Chrome exposes them,
- JavaScript heap snapshot artifact capture in Managed Browser, with structured
  `notApplicable` fallback in Personal Chrome,
- JavaScript CPU profile capture, saved full profile, and hotspot summary,
- short JavaScript/CSS coverage snapshot and range drilldown,
- Sources-panel literal source search, heuristic pretty-print, and source map metadata,
- global literal search across Network, Sources, and Application evidence,
- compact F12 evidence bundle export,
- one-call security research pack workflow with artifact paths,
- default `browser_*` facade tools over the detailed F12 layer,
- Console exceptions and source context around stack frames,
- HAR file save.
- Service Worker registration and CacheStorage summary on a local page.
- Application panel export to JSON, including IndexedDB and CacheStorage data.
- Direct IndexedDB store reads and CacheStorage response-body reads on smoke
  fixtures.
- Cookie security summary, including Secure, HttpOnly, SameSite, session vs
  persistent, and objective attribute signals.
- Origin/storage-key/quota evidence, quota usage breakdown, Storage Buckets support/bucket summary, and cookie partition evidence where Chrome exposes it.
- Cross-panel signal summary that points agents to the next drill-down tools
  without claiming a vulnerability.
- Chrome DevTools Issues-panel event access.

## F12 Parity Live Checks

Verified manually during development:

- `scripts/personal-chrome-smoke.mjs`
  - Starts a local fixture with script execution, storage, cookies, fetch
    traffic, and a same-origin iframe, then opens it in a new Personal Chrome
    tab for repeatable F12 evidence.
- `devtools_accessibility_snapshot`
  - Managed Browser on `https://example.com`: returned AX nodes including
    `RootWebArea`, heading, and paragraph roles.
  - Personal Chrome on the active tab: returned hundreds of AX nodes from the
    user's real Chrome tab.
- `devtools_dom_snapshot`
  - Managed Browser: returned Chrome `DOMSnapshot.captureSnapshot` data with
    document and string tables.
  - Personal Chrome: returned Chrome `DOMSnapshot.captureSnapshot` data from the
    user's real Chrome tab through `chrome.debugger`.
- `devtools_chrome_trace`
  - Managed Browser: captured Chrome Tracing stream and wrote a full trace JSON
    file under the profile evidence directory, with a dashboard-friendly trace
    summary.
  - Personal Chrome: captured Chrome Tracing stream through `chrome.debugger`
    and wrote a full trace JSON file under `tmp/personal-chrome-traces`, with
    the same trace summary shape.
- `devtools_chrome_trace traceSummary.renderingTimeline`
  - Managed Browser and Personal Chrome group observed loading, scripting,
    rendering, painting, and screenshot trace events into an objective timeline
    with relative offsets and durations.
- `devtools_sources_search`
  - Managed Browser: searched parsed script sources and found a known smoke-test
    marker in a data URL page.
  - Personal Chrome: searched parsed script sources from the active real Chrome
    tab through `chrome.debugger`.
- `devtools_source_pretty_print`
  - Managed Browser: returned a heuristic formatted view of parsed JavaScript
    source for inspection.
- `devtools_source_map_metadata`
  - Managed Browser: parsed an inline source map data URL and returned source
    count, names count, mappings size, and sourcesContent presence without
    returning the whole original-source tree.
- `devtools_source_map_sources`
  - Managed Browser: extracts source-map original files from `sourcesContent`
    into local evidence artifacts and returns manifest/file paths.
  - Personal Chrome: receives source-map originals through `chrome.debugger`
    and persists them under `tmp/personal-chrome-sources`.
- `devtools_source_map_source_get`
  - Managed Browser: reads one saved source-map original file by path or by
    source selector and returns bounded text plus artifact hash/provenance.
  - Personal Chrome: uses the same unified tool name and reads persisted
    source-map evidence from `tmp/personal-chrome-sources`.
- `devtools_debugger_control action=probeBreakpointByUrl`
  - Managed Browser: sets a temporary URL breakpoint, triggers a test function,
    captures paused frames/scopes, auto-resumes, and removes the breakpoint.
  - Personal Chrome: same action was verified through the bridge against the
    connected real Chrome session without navigating away from the active page.
- `devtools_debugger_control evaluateExpressions`
  - Managed Browser: evaluates expressions in the paused call frame and returns
    objective values/exception details alongside scope previews.
  - Personal Chrome: exposes the same parameter through `chrome.debugger` and
    CDP `Debugger.evaluateOnCallFrame`.
- `devtools_save_har`
  - Managed Browser: saved captured traffic as a HAR file under profile
    evidence.
  - Personal Chrome: saved captured traffic as a HAR file under
    `tmp/personal-chrome-har`.
- `devtools_network_summary`
  - Managed Browser: summarized captured requests by status, host, resource
    type, redirects, failures, cache/service-worker involvement, slowest, and
    largest entries.
  - Personal Chrome: summarized the active tab's captured request log after a
    hard reload.
- `devtools_page_diagnostics`
  - Managed Browser: returned first-screen dashboard data for page state,
    Network, Security, Storage, and Accessibility.
  - Personal Chrome: returned equivalent dashboard data from the user's active
    Chrome tab.
- `devtools_coverage_snapshot`
  - Managed Browser: captured CSS rule usage and JavaScript precise coverage
    where available.
  - Personal Chrome: captured JavaScript precise coverage and CSS rule usage
    through `chrome.debugger`.
- `devtools_coverage_detail`
  - Managed Browser and Personal Chrome expose raw JavaScript/CSS coverage
    ranges, byte counts, and bounded source snippets for Coverage-panel
    drilldown without classifying the result as a vulnerability.

## Live OpenClaw-Compatible Browser Smoke

The live browser smoke is now available:

```bash
npm run smoke:browser
```

It:

1. start a dedicated Chrome or Edge debug instance,
2. register or select one browser identity,
3. navigate to a local test page,
4. trigger a fetch request,
5. verify `cdp_query` can find the request,
6. verify `cdp_get` can retrieve the body path.

It uses a temporary browser profile and deletes it after the run.
