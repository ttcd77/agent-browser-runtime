# Personal Chrome Extension

This mode lets an agent inspect the Chrome browser the human is already using.

It does not use `--remote-debugging-port`. Instead:

```text
Claude / Codex / SDK
  -> local HTTP bridge
  -> Chrome extension WebSocket
  -> real Chrome tabs
```

## Start The Bridge

```powershell
cd C:\Users\Tong\project\agent-browser-runtime
npm run personal:chrome
```

The bridge listens on:

- HTTP tools: `http://127.0.0.1:17337`
- extension socket: `ws://127.0.0.1:17336/extension`

## Install The Extension

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Click "Load unpacked".
4. Select:

```text
C:\Users\Tong\project\agent-browser-runtime\extension
```

Then check:

```powershell
Invoke-RestMethod http://127.0.0.1:17337/health
```

You should see `connected: 1`.

## Tool Examples

```powershell
Invoke-RestMethod http://127.0.0.1:17337/tool/personal_chrome_tabs `
  -Method Post `
  -ContentType "application/json" `
  -Body "{}"

Invoke-RestMethod http://127.0.0.1:17337/tool/personal_chrome_active_tab_snapshot `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"maxTextLength":4000}'

Invoke-RestMethod http://127.0.0.1:17337/tool/personal_chrome_screenshot `
  -Method Post `
  -ContentType "application/json" `
  -Body "{}"
```

## Current Tools

Unified Agent DevTools tools:

- `devtools_tabs`
- `devtools_extension_reload`
- `devtools_snapshot`
- `devtools_screenshot`
- `devtools_click`
- `devtools_type`
- `devtools_scroll`
- `devtools_eval`
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

Backend-specific aliases:

- `personal_chrome_status`
- `personal_chrome_tabs`
- `personal_chrome_active_tab_snapshot`
- `personal_chrome_screenshot`
- `personal_chrome_click`
- `personal_chrome_type`
- `personal_chrome_scroll`
- `personal_chrome_eval`
- `personal_chrome_devtools_attach`
- `personal_chrome_devtools_detach`
- `personal_chrome_devtools_status`
- `personal_chrome_capture_start`
- `personal_chrome_capture_stop`
- `personal_chrome_capture_clear`
- `personal_chrome_capture_status`
- `personal_chrome_network_log`
- `personal_chrome_network_summary`
- `personal_chrome_network_timeline`
- `personal_chrome_export_har`
- `personal_chrome_save_har`
- `personal_chrome_request_body`
- `personal_chrome_request_detail`
- `personal_chrome_request_payload`
- `personal_chrome_request_replay`
- `personal_chrome_console_log`
- `personal_chrome_console_source_context`
- `personal_chrome_security_summary`
- `personal_chrome_page_diagnostics`
- `personal_chrome_signal_summary`
- `personal_chrome_risk_summary`
- `personal_chrome_issues_log`
- `personal_chrome_accessibility_snapshot`
- `personal_chrome_frame_tree`
- `personal_chrome_hard_reload`
- `personal_chrome_storage_snapshot`
- `personal_chrome_storage_origin_summary`
- `personal_chrome_cookie_summary`
- `personal_chrome_service_worker_summary`
- `personal_chrome_application_export`
- `personal_chrome_indexeddb_read`
- `personal_chrome_cache_entry_get`
- `personal_chrome_elements_snapshot`
- `personal_chrome_dom_snapshot`
- `personal_chrome_event_listeners`
- `personal_chrome_css_styles`
- `personal_chrome_sources_list`
- `personal_chrome_source_get`
- `personal_chrome_source_pretty_print`
- `personal_chrome_source_map_metadata`
- `personal_chrome_global_search`
- `personal_chrome_evidence_bundle`
- `personal_chrome_sources_search`
- `personal_chrome_performance_trace`
- `personal_chrome_chrome_trace`
- `personal_chrome_coverage_snapshot`
- `personal_chrome_coverage_detail`
- `personal_chrome_token_scan`

## Agent DevTools Tools

The first group of tools works at the page level: read text, click, type, scroll,
and screenshot.

The DevTools group uses Chrome's `chrome.debugger` extension API. This is closer
to F12 DevTools:

```powershell
Invoke-RestMethod http://127.0.0.1:17337/tool/personal_chrome_devtools_attach `
  -Method Post `
  -ContentType "application/json" `
  -Body "{}"

Invoke-RestMethod http://127.0.0.1:17337/tool/personal_chrome_capture_start `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"label":"manual-investigation"}'

Invoke-RestMethod http://127.0.0.1:17337/tool/personal_chrome_hard_reload `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"clearLog":true}'

Invoke-RestMethod http://127.0.0.1:17337/tool/personal_chrome_network_log `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"limit":50}'
```

Important: just like a human opening F12 after a page has already loaded, the
debugger only sees network events after it attaches. Use
`personal_chrome_hard_reload` when the agent needs a clean from-the-start network
capture.

Recording is explicit. Attach means "make DevTools data available"; capture
means "start writing Network, Console, Frame, and Security evidence into the
tab-local in-memory log." Use `personal_chrome_capture_stop` when the agent
should stop recording.

## Boundary

This is for private troubleshooting and local automation. The extension can read
page text and screenshots from real Chrome tabs. Do not use it on accounts or
pages you do not want a local agent to inspect.
