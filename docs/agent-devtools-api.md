# Agent DevTools API

Agent DevTools is the product-level contract.

The user should not need to know whether the browser is:

- their real Chrome, connected through the extension bridge, or
- a managed CDP browser started by the runtime.

The agent should call the same `devtools_*` tools in both modes. Backend-specific
tools may exist for debugging, but they are not the product contract.

## Product Shape

```text
User / Agent
  -> Agent DevTools API
      -> Personal Chrome Extension + chrome.debugger
      -> Managed Browser + CDP
```

## User Mental Model

There are two clear ways to run the same tool layer:

1. Personal Profile: the user's already-open Chrome profile, connected through
   the extension bridge.
2. Agent Browser: a browser started by the runtime for agents. The default
   profile is enough for simple use; extra profiles can be added for separate
   roles, targets, or identities.

The tools do not change between these modes. A profile, port, or browser process
is runtime routing. The agent still asks for the same operation:

```text
devtools_capture_start
devtools_click
devtools_network_log
devtools_storage_snapshot
```

For Agent Browser mode, profiles are product-level operating spaces. They can
share one CDP port, or future versions can place profiles on separate browser
ports such as 9223/9224 for stronger isolation. That routing choice should not
change the tool names.

The goal is F12 parity for agents:

- see what the human sees,
- see the browser-level evidence behind the page,
- know when a view is incomplete,
- reload with cache disabled when necessary,
- preserve evidence in a structured form.

## Unified Tools

Page operation:

- `devtools_tabs`
- `devtools_extension_reload`
- `devtools_snapshot`
- `devtools_screenshot`
- `devtools_click`
- `devtools_type`
- `devtools_scroll`
- `devtools_eval`

DevTools/F12 data layer:

- `devtools_attach`
- `devtools_detach`
- `devtools_status`
- `devtools_capture_start`
- `devtools_capture_stop`
- `devtools_capture_clear`
- `devtools_capture_status`
- `devtools_network_log`
- `devtools_network_summary`
- `devtools_network_timeline`
- `devtools_export_har`
- `devtools_save_har`
- `devtools_request_body`
- `devtools_request_detail`
- `devtools_request_payload`
- `devtools_request_replay`
- `devtools_console_log`
- `devtools_console_source_context`
- `devtools_security_summary`
- `devtools_page_diagnostics`
- `devtools_signal_summary`
- `devtools_risk_summary`
- `devtools_issues_log`
- `devtools_accessibility_snapshot`
- `devtools_frame_tree`
- `devtools_hard_reload`
- `devtools_storage_snapshot`
- `devtools_storage_origin_summary`
- `devtools_cookie_summary`
- `devtools_service_worker_summary`
- `devtools_application_export`
- `devtools_indexeddb_read`
- `devtools_cache_entry_get`
- `devtools_elements_snapshot`
- `devtools_dom_snapshot`
- `devtools_event_listeners`
- `devtools_css_styles`
- `devtools_dom_mutation_watch`
- `devtools_sources_list`
- `devtools_source_get`
- `devtools_source_pretty_print`
- `devtools_source_map_metadata`
- `devtools_global_search`
- `devtools_evidence_bundle`
- `devtools_sources_search`
- `devtools_performance_trace`
- `devtools_chrome_trace`
- `devtools_coverage_snapshot`
- `devtools_coverage_detail`
- `devtools_token_scan`

Backend compatibility rule: every runtime should expose this full `devtools_*`
set. If a tool is meaningful only in one backend, the other backend should still
return a successful structured no-op with `notApplicable: true`, not disappear.

## Current F12 Coverage

Implemented:

- Elements/Page snapshot: visible text, controls, screenshots, click/type/scroll, DOM tree, selected element inspection, layout boxes, key computed styles, raw Chrome DOMSnapshot data, Elements-panel Event Listeners, Styles/Computed/Box Model evidence, and selected-node DOM mutation watch for breakpoint-style evidence.
- Sources/Search: parsed script metadata, source map URL metadata, module flag, script source by script id, heuristic pretty-printing, inline/external source map metadata, literal source search, global literal search across Network/Sources/Application evidence, and compact F12 evidence bundle export.
- Performance: navigation timing, resource timing, paint timing, marks/measures, long-task entries, Chrome Tracing capture with full trace file output, trace event summaries, short JS/CSS coverage snapshots, and Coverage-panel range drilldown with bounded source snippets.
- Network: request URL, method, headers, status, response headers, request-detail evidence including cookies and ExtraInfo events, initiator, Timing/Initiator-style rows, frame id, redirect chain, cache/service-worker flags, TLS details where exposed, WebSocket lifecycle and frames, request replay/edit-and-resend, HAR-like object export, HAR file save, and low-token summary for dashboards/triage.
- Payload/Body: response body by request id; request postData/payload by request id when Chrome exposes it.
- Console/Issues: console API, log entries, exceptions, stack traces, source
  context around stack frames, and Chrome DevTools Issues-panel events where
  the backend exposes them.
- Security: page secure-context summary and TLS/certificate details collected from Network security metadata.
- Accessibility: AX tree nodes, roles, names, values, descriptions, properties, child ids, and backend DOM node ids where Chrome exposes them.
- Frames: frame tree and recent frame lifecycle events.
- Storage: localStorage, sessionStorage, document-visible cookies, backend cookie API/CDP cookies, cookie security summaries, origin/storage-key/quota evidence, cookie partition metadata where Chrome exposes it, IndexedDB database/object-store/index/sample records, IndexedDB paged record reads, Cache Storage request/response metadata and body reads, Service Worker registrations, Service Worker target summary, CacheStorage summary, and Application panel JSON export.
- Token scan: full-value scan across headers, payloads, storage, and cookies in authorized browser mode.

Not fully implemented yet:

- Fully lossless HAR export with exact timings and all bodies.
- Sources panel parity beyond raw/searchable script source: breakpoints, scopes, live debugging, and AST-lossless formatting. Heuristic pretty-print and source map metadata are already exposed.
- Performance panel parity beyond current tracing: trace interpretation, screenshots, layout/paint flame chart, and CPU profiles.
- Application panel deep browsing beyond current reads: deeper Service Worker script/status detail and cookie partition metadata.
- Network replay edge cases: exact forbidden header behavior, raw socket-level replay, multipart helpers, and replay UI.
- Browser UI/system dialogs and Chrome internal pages.
- Complete JavaScript heap/closure inspection. Tokens that exist only in live JS memory and never enter storage/network are not generally visible unless the debugger pauses in the right execution context.

## Backends

### Personal Chrome

Run:

```powershell
npm run personal:chrome
```

Load the extension from:

```text
extension/
```

Call tools at:

```text
http://127.0.0.1:17337/tool/devtools_network_log
```

This mode uses `chrome.debugger`, so Chrome may show a banner that the extension
is debugging the browser. That is expected.

### Managed Browser

Run:

```powershell
$env:CDP_LAUNCH_BROWSER="1"
npm run agent:server
```

Call tools at:

```text
http://127.0.0.1:17335/tool/devtools_network_log
```

This mode uses CDP directly and stores evidence under the runtime data directory.

## Completeness Rule

If the agent attaches after the page has already loaded, it may not see earlier
network events. This is true for a human opening F12 late as well.

When the agent needs a complete capture, it should:

1. call `devtools_attach`,
2. call `devtools_capture_start`,
3. call `devtools_hard_reload` with cache disabled and service worker bypass,
4. call `devtools_network_log`,
5. call `devtools_request_detail` for request headers/cookies/timing/initiator,
6. call `devtools_request_body` for specific response bodies.

Capture is explicit. If capture is not enabled, page operation tools may still
work, but background Network/Console/Frame evidence should not be treated as a
complete recording.

This is a tool switch, not a workflow rule. Users and agents decide when to
record. The runtime provides the switch and reports the current state.

## Summary Layer For Agent Panels

Raw F12 data can be huge. Agent-facing panels should start with summary tools:

- `devtools_network_summary` for request counts, failed requests, hosts,
  redirects, cache/service-worker involvement, WebSockets, slowest requests, and
  largest responses.
- `devtools_network_timeline` for per-request Timing/Initiator evidence before
  deciding whether a request chain needs deeper analysis.
- `devtools_security_summary` for secure-context and TLS/certificate state.
- `devtools_page_diagnostics` for the first dashboard screen: page state,
  Network summary, Security summary, Storage counts, Console error count, and
  Accessibility node count.
- `devtools_signal_summary` for the agent's first evidence pass across Network,
  Cookies, Storage, Service Workers, Security, and optional token scan. It does
  not decide whether something is a vulnerability; it lists objective F12
  signals and `nextTools` for drill-down. `devtools_risk_summary` remains as a
  compatibility alias.
- `devtools_coverage_snapshot` for short JS/CSS usage snapshots.

The raw tools remain available for drill-down:

- `devtools_network_log`
- `devtools_request_body`
- `devtools_dom_snapshot`
- `devtools_sources_search`
- `devtools_global_search`
- `devtools_chrome_trace`

## Token Visibility

Plain browser MCP tools often miss tokens because they only read what is visible
in the page or accessibility tree.

Agent DevTools checks more places:

- request headers, including `Authorization` and `Cookie`,
- response headers, including `Set-Cookie`,
- request payload / postData,
- localStorage and sessionStorage,
- document-visible cookies,
- browser cookie APIs / CDP cookies, including HttpOnly metadata where the backend exposes it.

Use:

```text
devtools_token_scan
```

Values are returned in full by design after the operator has authorized the
browser backend. Product-level authorization and confirmation should sit above
this API, not inside every low-level tool.

The agent should report when data may be incomplete instead of pretending it has
seen everything.
