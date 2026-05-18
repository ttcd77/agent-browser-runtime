# Agent Browser Runtime

A local CDP browser runtime for AI agents.

It gives Codex, Claude, OpenClaw, or a custom agent SDK a browser it can operate through simple tools:

- create a named browser profile,
- navigate, click, type, evaluate JavaScript, snapshot, and screenshot,
- capture profile-scoped network traffic,
- keep evidence under that profile's directory,
- reuse an existing CDP browser when one is already open.

The OpenClaw plugin adapter is included, but the main product is now framework-neutral: agents call a small `browser_*` facade first, then drill into the unified `devtools_*` API only when they need exact F12 evidence. Backend-specific names are kept for debugging and compatibility.

## Why

Agents should not need to reason about Chrome DevTools Protocol target ids, tab ids, ports, body stores, or browser internals.

The user-facing model is deliberately small:

- Personal Profile: inspect the Chrome profile the user is already using.
- Agent Browser: start a browser for agents; use `default` for simple work, or
  create extra profiles for separate roles, targets, and identities.

Both modes expose the same `browser_*` facade and the same `devtools_*` tool names. Profiles, ports, browser processes, and extension details are routing choices underneath that tool layer.

In product terms, a `profile` is an agent-facing operating space. It can mean a role, a target, or an identity:

- `default`
- `researcher`
- `shop-buyer`
- `shop-seller`
- `target-a-tester`

Each profile owns:

- one browser tab,
- one evidence directory,
- one traffic journal,
- one event journal,
- its own screenshots and snapshots.

By default everything runs through one local CDP endpoint, usually `http://127.0.0.1:9222`. The profile layer is product-level separation on top of that endpoint. Stronger process-level isolation with multiple browser ports can be added later.

## What This Is Not

- Not a stealth browser or anti-bot bypass toolkit.
- Not a vulnerability scanner.
- Not a hosted dashboard.
- Not a replacement for Burp Suite.
- Not for inspecting accounts, targets, or traffic you are not authorized to access.

Browser profiles can contain live authentication state. Treat screenshots, cookies, headers, bodies, and script sources as sensitive evidence.

## Safety Boundaries

Use this runtime only with browser profiles, accounts, and targets you are
authorized to inspect. Public demos should use Managed Browser mode with
`example.com` or local fixtures. Personal Chrome mode is for explicit local
operator-authorized debugging of the user's own browser state.

## Install

```bash
npm install
npm run build
npm run test
```

## Quickstart

Managed Browser mode is the safest public demo path because it uses a fresh
agent-owned browser profile instead of the user's daily Chrome profile.

```bash
$env:CDP_LAUNCH_BROWSER="1"
npm run agent:server
```

In another terminal:

```bash
npm run research:pack -- --url https://example.com --profile researcher
```

The command prints local artifact paths for the HAR, Application export, trace,
manifest, correlation graph, and evidence bundle when those artifacts are
available.

For agent operators, start with `docs/agent-operator-runbook.md`. For the
complete product contract, read `docs/agent-devtools-api.md`.

Run all local checks:

```bash
npm run check
npm run contract:devtools
npm run smoke:product
npm run smoke:server
npm run smoke:f12
npm run smoke:browser
```

Professional evidence-runtime gate:

```bash
npm run check:professional
```

This gate runs the build, schema tests, CLI handoff smoke, DevTools contract,
F12 smoke, professional workflow smoke, and runnable example smoke.

Open-source readiness gate:

```bash
npm run release:readiness
```

## Run The Standalone Agent Server

Start a visible Edge/Chrome browser if no CDP browser is already listening:

```bash
CDP_LAUNCH_BROWSER=1 npm run agent:server
```

Windows PowerShell:

```powershell
$env:CDP_LAUNCH_BROWSER="1"
npm run agent:server
```

The server listens on `http://127.0.0.1:17335` by default.

Health check:

```bash
curl http://127.0.0.1:17335/health
```

Local dashboard:

```text
http://127.0.0.1:17335/panel
```

The panel is intentionally simple: it shows human-readable profile names and a
page diagnostics summary. It hides CDP target ids and tab ids from the first
screen. Agents and SDKs should still use the `devtools_*` tools for automation.

## Agent-Facing Tools

Expose these facade tools to agents by default:

| Tool | Use it for |
|---|---|
| `browser_open` | Open/switch a page and get diagnostics. |
| `browser_act` | Click, type, scroll, eval, screenshot, or snapshot. |
| `browser_inspect` | Ask for `overview`, `network`, `storage`, `console`, `dom`, `sources`, `performance`, `search`, `evidence`, or `debug` without choosing low-level tools. |
| `browser_capture` | Start, stop, clear, inspect, or reload F12-style recording. |
| `browser_security_pack` | Generate an objective local evidence pack with artifact paths. |
| `browser_auth_boundary` | Collect auth/cookie/storage/request boundary evidence without judging impact. |
| `browser_diff` | Compare before/after evidence or captured traffic. |
| `browser_replay` | Replay one captured request or a batch of variants. |
| `browser_raw` | Advanced escape hatch for one exact `devtools_*` tool. |

Default professional workflow:

```text
browser_open -> browser_capture -> browser_inspect -> browser_security_pack -> drilldownPlan
```

Use `devtools_workflow_guide` with `task="professional-appsec"` to get this path
as machine-readable steps and exit criteria. The detailed `devtools_*` tools are
still available for drill-down and parity with DevTools panels, but they are not
the first interface. Use `browser_raw` only when the facade cannot express the
required F12 operation.

Use `devtools_professional_readiness` when an agent needs to check whether the
workflow, F12 parity map, capture status, artifact inventory, and evidence
timeline are mechanically ready before continuing. It returns next tool calls;
it does not classify vulnerabilities.

When evidence already exists, read `routeSummary` first. It compresses the
handoff path into the first step, latest handoff inspect/read commands, first
concrete drilldown, and evidence entrypoint count. This is the fastest way for a
new agent to resume work without scanning every tool or artifact.

`browser_inspect` / `agent_inspect` also return this professional workflow
summary, so a first-screen agent call can route itself without scanning the full
tool catalog.

Example tool calls:

```bash
curl -X POST http://127.0.0.1:17335/tool/profile_create \
  -H "content-type: application/json" \
  -d "{\"profile\":\"researcher\"}"

curl -X POST http://127.0.0.1:17335/tool/browser_capture \
  -H "content-type: application/json" \
  -d "{\"profile\":\"researcher\",\"action\":\"start\",\"label\":\"first-capture\"}"

curl -X POST http://127.0.0.1:17335/tool/browser_open \
  -H "content-type: application/json" \
  -d "{\"profile\":\"researcher\",\"url\":\"https://example.com\"}"

curl -X POST http://127.0.0.1:17335/tool/browser_act \
  -H "content-type: application/json" \
  -d "{\"profile\":\"researcher\",\"action\":\"snapshot\"}"

curl -X POST http://127.0.0.1:17335/tool/profile_traffic_query \
  -H "content-type: application/json" \
  -d "{\"profile\":\"researcher\",\"limit\":20}"

curl -X POST http://127.0.0.1:17335/tool/devtools_save_har \
  -H "content-type: application/json" \
  -d "{\"profile\":\"researcher\",\"includeBodies\":true,\"maxBodyBytes\":200000}"

curl -X POST http://127.0.0.1:17335/tool/devtools_request_replay \
  -H "content-type: application/json" \
  -d "{\"profile\":\"researcher\",\"requestId\":\"<request-id>\",\"form\":{\"role\":\"tester\"},\"headers\":{\"Host\":\"example.invalid\",\"Content-Type\":null}}"
```

If `profile` is omitted, browser tools use the server default profile. The default is `default`, or `CDP_AGENT_PROFILE` if set.

Network, Console, Frame, and Security evidence recording is an explicit switch.
Use `devtools_capture_start` before the activity you want to record, or use
`devtools_hard_reload` when you want a clean F12-style reload capture. If capture
is off, browser action tools still work, but they do not write a traffic journal.

Agent router:

```bash
curl -X POST http://127.0.0.1:17335/tool/agent_inspect \
  -H "content-type: application/json" \
  -d "{\"profile\":\"researcher\",\"focus\":\"overview\",\"limit\":10}"
```

`agent_inspect` is the agent-facing router. It does not replace the low-level
F12 tools; it chooses the first useful evidence set for `overview`, `network`,
`storage`, `console`, `dom`, `sources`, `performance`, `search`, `evidence`, or
`debug`, then returns `nextTools` and a `toolPlan` for drill-down. It is
intentionally objective: it organizes browser evidence but does not decide
whether something is a vulnerability.

One-call security research evidence pack:

```bash
curl -X POST http://127.0.0.1:17335/tool/devtools_security_research_pack \
  -H "content-type: application/json" \
  -d "{\"profile\":\"researcher\",\"url\":\"https://example.com\",\"includeHar\":true,\"includeTrace\":true,\"includeApplicationExport\":true}"
```

This starts a capture window, hard reloads the page, collects the first-pass
F12 evidence areas, and returns saved HAR, Application export, Chrome trace, and
evidence bundle paths. See `docs/security-research-pack.md`.

CLI shortcut:

```bash
npm run research:pack -- --url https://example.com --profile researcher
```

The CLI prints key artifact paths plus the professional workflow, agent entry
route, handoff readiness, artifact coverage, professional readiness, capture
status, artifact kind counts, route summary, F12 request-detail navigation, and
the first F12 request-detail section summary plus handoff read/inspect commands.
Use `--json` when an agent or script needs the full response.

Runnable example:

```bash
node examples/security-research-pack.mjs https://example.com
```

The example prints pre/post professional readiness, handoff paths, artifact
coverage, F12 request-detail navigation, and first drill-down routes.

Example smoke:

```bash
npm run smoke:example
```

`npm run check:professional` includes this example smoke so the public agent
workflow stays executable, not just documented.

## Tools

### Agent Router

- `agent_inspect`
- `devtools_tool_catalog`
- `devtools_tool_help`
- `devtools_capability_map`
- `devtools_f12_parity_matrix`
- `devtools_workflow_guide`
- `devtools_professional_readiness`

The `devtools_tool_*`, capability, parity, workflow, and readiness tools are for usability:
they help agents choose a tool, inspect one tool's parameters, and follow a
deterministic workflow without guessing across the full tool list.
`devtools_tool_catalog` also returns `agentEntryPoints`, a compressed facade-first
route for agents that should not scan the full `devtools_*` surface before acting.

### Unified Agent DevTools API

These names are the product-level contract. They are available in both Personal
Chrome Extension Mode and Managed Browser Mode:

- `devtools_tabs`
- `devtools_extension_reload`
- `devtools_snapshot`
- `devtools_screenshot`
- `devtools_click`
- `devtools_type`
- `devtools_scroll`
- `devtools_eval`
- `devtools_tool_catalog`
- `devtools_tool_help`
- `devtools_capability_map`
- `devtools_f12_parity_matrix`
- `devtools_workflow_guide`
- `devtools_professional_readiness`
- `devtools_attach`
- `devtools_detach`
- `devtools_status`
- `devtools_backend_capabilities`
- `devtools_protocol_schema`
- `devtools_browser_cdp_command`
- `devtools_browser_version`
- `devtools_browser_targets`
- `devtools_system_info`
- `devtools_capture_start`
- `devtools_capture_stop`
- `devtools_capture_clear`
- `devtools_capture_status`
- `devtools_capture_bisect`
- `devtools_network_log`
- `devtools_network_summary`
- `devtools_network_timeline`
- `devtools_export_har`
- `devtools_save_har`
- `devtools_har_completeness`
- `devtools_request_body`
- `devtools_request_detail`
- `devtools_request_payload`
- `devtools_request_replay`
- `devtools_request_replay_batch`
- `devtools_console_log`
- `devtools_console_source_context`
- `devtools_security_summary`
- `devtools_page_diagnostics`
- `devtools_signal_summary`
- `devtools_issues_log`
- `devtools_accessibility_snapshot`
- `devtools_frame_tree`
- `devtools_hard_reload`
- `devtools_storage_snapshot`
- `devtools_storage_origin_summary`
- `devtools_cookie_summary`
- `devtools_service_worker_summary`
- `devtools_service_worker_detail`
- `devtools_application_export`
- `devtools_indexeddb_read`
- `devtools_cache_entry_get`
- `devtools_elements_snapshot`
- `devtools_dom_snapshot`
- `devtools_dom_search`
- `devtools_event_listeners`
- `devtools_css_styles`
- `devtools_dom_mutation_watch`
- `devtools_cdp_command`
- `devtools_debugger_control`
- `devtools_token_flow_trace`
- `devtools_memory_snapshot`
- `devtools_sources_list`
- `devtools_source_get`
- `devtools_source_pretty_print`
- `devtools_source_map_metadata`
- `devtools_source_map_sources`
- `devtools_source_map_source_get`
- `devtools_global_search`
- `devtools_evidence_bundle`
- `devtools_evidence_manifest`
- `devtools_artifact_inspect`
- `devtools_artifact_index`
- `devtools_artifact_search`
- `devtools_artifact_read`
- `devtools_evidence_timeline`
- `devtools_request_correlation_graph`
- `devtools_capture_diff`
- `devtools_auth_boundary_report`
- `devtools_worker_frame_deep_dive`
- `devtools_security_research_pack`
- `devtools_sources_search`
- `devtools_performance_trace`
- `devtools_performance_insights`
- `devtools_performance_observer`
- `devtools_chrome_trace`
- `devtools_trace_query`
- `devtools_trace_compare`
- `devtools_cpu_profile`
- `devtools_coverage_snapshot`
- `devtools_coverage_detail`
- `devtools_token_scan`

See `docs/agent-devtools-api.md`.
For an F12-to-tool lookup table, see `docs/devtools-panel-map.md`.
For the one-call research workflow, see `docs/security-research-pack.md`.
For public release readiness, see `docs/open-source-release-checklist.md`.
For a minimal adapter sketch, see `examples/mcp-adapter-sketch.mjs`.

## Known Backend Boundaries

- Managed Browser uses direct CDP and is the preferred backend for repeatable
  target work, clean profiles, raw CDP discovery, and artifact generation.
- Personal Chrome uses a local extension bridge and `chrome.debugger`. It is best
  when the user wants the agent to inspect the browser state they are already
  seeing.
- The two modes expose the same `devtools_*` contract, but Chrome may expose more
  browser-process CDP data to Managed Browser than to Personal Chrome.
- Capture is explicit. If recording was not enabled before an action, neither
  humans nor agents can recover network events Chrome did not retain.
- Tools return objective evidence, signals, paths, and completeness boundaries.
  They do not decide whether something is a vulnerability.

Backend/debug tools:

These are lower-level aliases used by the local server and older integrations.
New agents and SDKs should prefer the `devtools_*` names above.

- `profile_create`
- `profile_list`
- `profile_delete`
- `profile_traffic_query`
- `profile_traffic_get`
- `browser_tabs`
- `browser_navigate`
- `browser_click`
- `browser_type`
- `browser_screenshot`
- `browser_snapshot`
- `browser_eval`

OpenClaw-compatible CDP evidence tools:

- `cdp_query`
- `cdp_get`
- `cdp_cookies`
- `cdp_fetch_intercept`
- `cdp_stats`
- `cdp_self_test`
- `register_browser_profile`
- `acquire_browser_profile`

## Personal Browser Attach Mode

This project can attach to an existing browser only if that browser already exposes a CDP endpoint.

That means the browser must be launched with a flag such as:

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --remote-debugging-port=9222 `
  --remote-allow-origins=* `
  --user-data-dir="$env:USERPROFILE\.agent-browser-runtime\personal-edge" `
  --no-first-run `
  --no-default-browser-check
```

Then start the server without launching another browser:

```powershell
npm run agent:server
```

There is also a helper:

```powershell
npm run personal:browser
npm run agent:server
```

The health endpoint will report:

- `browserAttachMode: "attached-existing-cdp"` when it reused an already-running CDP browser,
- `browserAttachMode: "launched-managed-browser"` when it launched a browser itself.

Important boundary: a normal browser that was started without remote debugging cannot usually be "taken over" afterward. For a private debugging workflow, start a browser window with remote debugging enabled first, then use it normally. When something looks strange, the agent can attach to that same window and inspect tabs, DOM, screenshots, and traffic.

See `docs/personal-browser-mode.md` for the dedicated workflow and safety notes.

## Personal Chrome Extension Mode

If you want the agent to inspect the Chrome window you are already using, use the
extension bridge instead of CDP port attach:

```powershell
npm run personal:chrome
```

Then load the unpacked extension from:

```text
extension/
```

The bridge exposes tools at `http://127.0.0.1:17337`, including:

- `personal_chrome_tabs`
- `personal_chrome_active_tab_snapshot`
- `personal_chrome_screenshot`
- `personal_chrome_click`
- `personal_chrome_type`
- `personal_chrome_scroll`
- `personal_chrome_eval`
- `personal_chrome_devtools_attach`
- `personal_chrome_devtools_status`
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
- `personal_chrome_issues_log`
- `personal_chrome_accessibility_snapshot`
- `personal_chrome_frame_tree`
- `personal_chrome_hard_reload`
- `personal_chrome_storage_snapshot`
- `personal_chrome_storage_origin_summary`
- `personal_chrome_cookie_summary`
- `personal_chrome_service_worker_summary`
- `personal_chrome_service_worker_detail`
- `personal_chrome_application_export`
- `personal_chrome_indexeddb_read`
- `personal_chrome_cache_entry_get`
- `personal_chrome_elements_snapshot`
- `personal_chrome_dom_snapshot`
- `personal_chrome_dom_search`
- `personal_chrome_event_listeners`
- `personal_chrome_css_styles`
- `personal_chrome_dom_mutation_watch`
- `personal_chrome_cdp_command`
- `personal_chrome_debugger_control`
- `personal_chrome_memory_snapshot`
- `personal_chrome_sources_list`
- `personal_chrome_source_get`
- `personal_chrome_source_pretty_print`
- `personal_chrome_source_map_metadata`
- `personal_chrome_source_map_sources`
- `personal_chrome_source_map_source_get`
- `personal_chrome_global_search`
- `personal_chrome_evidence_bundle`
- `personal_chrome_evidence_manifest`
- `personal_chrome_artifact_inspect`
- `personal_chrome_artifact_index`
- `personal_chrome_artifact_search`
- `personal_chrome_artifact_read`
- `personal_chrome_evidence_timeline`
- `personal_chrome_request_correlation_graph`
- `personal_chrome_capture_diff`
- `personal_chrome_auth_boundary_report`
- `personal_chrome_worker_frame_deep_dive`
- `personal_chrome_sources_search`
- `personal_chrome_performance_trace`
- `personal_chrome_chrome_trace`
- `personal_chrome_cpu_profile`
- `personal_chrome_coverage_snapshot`
- `personal_chrome_coverage_detail`
- `personal_chrome_token_scan`

See `docs/personal-chrome-extension.md`.

## SDK Integration Shape

An SDK only needs to call local HTTP tools:

```ts
const baseUrl = "http://127.0.0.1:17335";

async function callTool(name: string, params: unknown) {
  const response = await fetch(`${baseUrl}/tool/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!response.ok) throw new Error(await response.text());
  return await response.json();
}

await callTool("devtools_capture_start", {
  profile: "researcher",
  label: "investigation",
});

await callTool("browser_navigate", {
  profile: "researcher",
  url: "https://example.com",
});

const snapshot = await callTool("browser_snapshot", {
  profile: "researcher",
});

const traffic = await callTool("profile_traffic_query", {
  profile: "researcher",
  limit: 20,
});
```

The SDK does not need to know CDP target ids, tab ids, browser ports, or evidence paths. It chooses a profile name and calls tools.

## OpenClaw Adapter

Build first:

```bash
npm run build
```

Then add the built plugin entrypoints to OpenClaw:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "C:/path/to/agent-browser-runtime/dist/plugins/cdp-traffic-capture/index.js",
        "C:/path/to/agent-browser-runtime/dist/plugins/browser-profile-pool/index.js"
      ]
    }
  }
}
```

See `examples/openclaw.config.example.json`.

## Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `CDP_AGENT_SERVER_PORT` | Local HTTP tool server port. | `17335` |
| `CDP_AGENT_PROFILE` | Default profile used when tool calls omit `profile`. | `default` |
| `CDP_BROWSER_PORT` | Browser CDP port. | `9222` |
| `CDP_LAUNCH_BROWSER` | Launch Edge/Chrome if no CDP browser is available. | unset |
| `CDP_BROWSER_EXECUTABLE` | Explicit Edge/Chrome executable path. | auto-detected |
| `CDP_BROWSER_USER_DATA_DIR` | Browser user-data directory when launching a browser. | `$CDP_SECURITY_DATA_DIR/browser-identities/$CDP_AGENT_PROFILE` |
| `CDP_BROWSER_HEADLESS` | Use headless mode for test runs. | unset |
| `CDP_SECURITY_DATA_DIR` | Base data directory for captured bodies, events, profiles, and logs. | `~/.agent-browser-runtime` |
| `CDP_PROFILE_REGISTRY_FILE` | Standalone server profile registry. | `$CDP_SECURITY_DATA_DIR/profiles.json` |
| `CDP_SECURITY_BODY_STORE_DIR` | Response body storage directory for CDP evidence tools. | `$CDP_SECURITY_DATA_DIR/cdp-traffic` |
| `CDP_SECURITY_SPOOL_DIR` | Ring-buffer eviction spool directory. | `$CDP_SECURITY_DATA_DIR/cdp-spool` |
| `CDP_SECURITY_ERROR_LOG_DIR` | Tool validation/internal error log directory. | `$CDP_SECURITY_DATA_DIR/cdp-traffic/_errors` |
| `CDP_SECURITY_LEASE_FILE` | Local browser profile lease store for the OpenClaw adapter. | `$CDP_SECURITY_DATA_DIR/profile-leases.json` |
| `OPENCLAW_CONFIG_PATH` | OpenClaw config path for adapter mode. | standalone generated config |
| `BROWSER_BRIDGE_URL` | OpenClaw browser bridge endpoint used by profile registration. | `http://127.0.0.1:9302` |
| `BROWSER_BRIDGE_TOKEN` | Explicit browser bridge token. | unset |
| `OPENCLAW_GATEWAY_TOKEN` | Fallback browser bridge token. | unset |
| `PERSONAL_CHROME_HTTP_PORT` | Local HTTP bridge for real Chrome extension mode. | `17337` |
| `PERSONAL_CHROME_WS_PORT` | WebSocket port used by the extension. | `17336` |

Use `127.0.0.1`, not `localhost`, when you care about deterministic endpoint ownership. Some systems resolve `localhost` to IPv6 `::1`, which can confuse agents and make it look like two different browsers are using the same numeric port.

## Evidence Layout

By default evidence is stored under:

```text
~/.agent-browser-runtime/
  profiles/
    <profile>/
      events/events.jsonl
      traffic/traffic.jsonl
      screenshots/*.png
```

Do not commit captured evidence from real targets unless it has been reviewed and sanitized.

## Current Status

Working now:

- standalone local HTTP tool server,
- profile-scoped browser operations,
- profile-scoped screenshots and traffic journals,
- clean local build without the original OpenClaw checkout,
- OpenClaw adapter compatibility,
- product smoke tests and live browser smoke tests.

Next likely steps:

- extract the CDP capture internals into a smaller framework-neutral library,
- add a minimal UI for profile browsing and evidence review,
- add stronger process-level isolation through multiple browser ports,
- add an SDK client package.
