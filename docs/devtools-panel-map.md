# DevTools Panel Map

This runtime exposes Chrome/Edge DevTools data as agent-callable tools. The goal
is not to copy the DevTools UI one-to-one. The goal is to make every important
F12 evidence surface available through a stable, low-token tool contract.

## First Screen

Use this for an agent dashboard or a quick diagnosis before drilling down:

| Question | Tool |
|---|---|
| What page am I on and is the browser healthy? | `devtools_page_diagnostics` |
| Which backend layer am I using and what can it see? | `devtools_backend_capabilities` |
| Which tool should I use? | `devtools_tool_catalog` |
| How do I call this specific tool? | `devtools_tool_help` |
| What workflow should I follow for this task? | `devtools_workflow_guide` |
| Which raw CDP methods/events can this browser expose? | `devtools_protocol_schema` |
| What F12 signals should I inspect first? | `devtools_signal_summary` |
| Is capture running? | `devtools_capture_status` |
| What failed or slow requests happened? | `devtools_network_summary` |
| What browser-reported Issues exist? | `devtools_issues_log` |
| What console errors or exceptions exist? | `devtools_console_log` |
| Is the page secure and what TLS details were seen? | `devtools_security_summary` |

## Network Panel

| Human F12 action | Agent tool |
|---|---|
| Start recording | `devtools_capture_start` |
| Stop recording | `devtools_capture_stop` |
| Clear recording | `devtools_capture_clear` |
| Reload with cache disabled | `devtools_hard_reload` |
| Inspect request table | `devtools_network_log` |
| Summarize request table | `devtools_network_summary` |
| Inspect Timing/Initiator rows | `devtools_network_timeline` |
| Read response body | `devtools_request_body` |
| Inspect one request's headers/cookies/timing/initiator | `devtools_request_detail` |
| Read request payload | `devtools_request_payload` |
| Replay/edit a request | `devtools_request_replay` |
| Replay request variants and compare responses | `devtools_request_replay_batch` |
| Export HAR object | `devtools_export_har` |
| Save HAR file | `devtools_save_har` |

## Elements And Accessibility Panels

| Human F12 action | Agent tool |
|---|---|
| Inspect visible page state | `devtools_snapshot` |
| Inspect DOM tree and styles | `devtools_elements_snapshot` |
| Capture raw DOMSnapshot | `devtools_dom_snapshot` |
| Search live DOM | `devtools_dom_search` |
| Inspect iframe/frame tree | `devtools_frame_tree` |
| Inspect accessibility tree | `devtools_accessibility_snapshot` |
| Inspect selected node event listeners | `devtools_event_listeners` |
| Inspect selected node Styles/Computed/Box Model | `devtools_css_styles` |
| Watch selected-node DOM mutations | `devtools_dom_mutation_watch` |
| Unwrapped CDP/F12 feature | `devtools_cdp_command` |
| Browser-process CDP feature in Managed Browser | `devtools_browser_cdp_command` |
| Browser version metadata | `devtools_browser_version` |
| Browser targets/tabs | `devtools_browser_targets` |
| Browser/system information | `devtools_system_info` |
| Click/type/scroll | `devtools_click`, `devtools_type`, `devtools_scroll` |
| Screenshot | `devtools_screenshot` |

## Sources Panel

| Human F12 action | Agent tool |
|---|---|
| List parsed scripts | `devtools_sources_list` |
| Read source by script id | `devtools_source_get` |
| Pretty-print parsed JavaScript source | `devtools_source_pretty_print` |
| Inspect source map reference and metadata | `devtools_source_map_metadata` |
| Search script source | `devtools_sources_search` |
| Pause/resume/step and inspect call frames/scopes | `devtools_debugger_control` |
| Trace token-like data through fetch/XHR/storage/cookies | `devtools_token_flow_trace` |
| Search Network, Sources, and Application evidence | `devtools_global_search` |
| Export compact F12 evidence bundle | `devtools_evidence_bundle` |
| Write artifact manifest with hashes and provenance | `devtools_evidence_manifest` |
| Build request/script/frame/console correlation graph | `devtools_request_correlation_graph` |
| Compare before/after captured evidence | `devtools_capture_diff` |
| Collect auth boundary evidence | `devtools_auth_boundary_report` |
| Inspect worker, Service Worker, iframe, and target boundaries | `devtools_worker_frame_deep_dive` |
| Run one-call security research evidence workflow | `devtools_security_research_pack` |
| Read source context around a console stack frame | `devtools_console_source_context` |

Current boundary: breakpoints, scopes, live debugging, and AST-lossless
formatting are not fully implemented yet. Pretty-printing is currently
heuristic, and source maps are exposed as metadata rather than a full
original-source tree.

## Application Panel

| Human F12 action | Agent tool |
|---|---|
| Inspect cookies/storage/cache/service workers | `devtools_storage_snapshot` |
| Inspect origin, storage key, quota, and cookie partition metadata | `devtools_storage_origin_summary` |
| Summarize cookie security attributes | `devtools_cookie_summary` |
| Summarize Service Worker and cache state | `devtools_service_worker_summary` |
| Export Application panel data | `devtools_application_export` |
| Read IndexedDB page | `devtools_indexeddb_read` |
| Read CacheStorage response body | `devtools_cache_entry_get` |
| Scan authorized browser data for token-like values | `devtools_token_scan` |

## Performance Panel

| Human F12 action | Agent tool |
|---|---|
| Navigation/resource/paint timing | `devtools_performance_trace` |
| Agent-readable timing/resource/long-task summary | `devtools_performance_insights` |
| LCP/layout shift/long task/event timing/long animation frame observer entries | `devtools_performance_observer` |
| Chrome trace capture | `devtools_chrome_trace` |
| Query saved trace events by name/category/duration/thread/time range | `devtools_trace_query` |
| Compare two saved trace captures | `devtools_trace_compare` |
| JavaScript CPU profile and hotspot summary | `devtools_cpu_profile` |
| JS/CSS coverage summary | `devtools_coverage_snapshot` |
| JS/CSS coverage range drilldown | `devtools_coverage_detail` |
| Memory/Performance Monitor counters | `devtools_memory_snapshot` |

`devtools_performance_insights` is the first-pass agent route: it combines
browser-exposed performance entries with optional trace summaries and reports
capture boundaries. `devtools_chrome_trace` saves the full raw trace and returns
a first-pass summary with top categories, top event names, long events,
screenshot events, and network-like events.

## Personal And Managed Backends

The same `devtools_*` names are exposed by both modes:

- Managed Browser: local CDP browser launched or attached by the runtime.
- Personal Chrome: Chrome extension bridge using `chrome.debugger` against the
  user's real browser after explicit local installation.

Agents should use the `devtools_*` names. Backend-specific names are retained for
debugging and compatibility only.
