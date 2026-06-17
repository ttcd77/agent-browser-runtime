# Agent Browser Runtime — Architecture

This document covers the two backends, the tool layer, security boundaries,
and cross-platform support.

---

## Overview

```
Agent (CLI / HTTP)
        |
        v
  Worker :17335  ←→  Managed Browser (Playwright + direct CDP)
        |
  Bridge :17337  ←→  Personal Chrome (chrome.debugger extension bridge)
```

The worker is the single entry point. It routes incoming tool calls to the
correct backend based on the `backend` parameter or the profile's registered
backend.

---

## Two backends

### Managed Browser (`:17335`)

The primary backend. The worker launches or attaches to a browser process it
owns and talks to it directly over Chrome DevTools Protocol (CDP).

- Clean named profiles — no shared cookies, storage, or history.
- Full CDP access: capture start/stop, HAR export, replay, trace, coverage.
- Playwright drives interaction (click, type, fill, navigate); CDP drives
  evidence collection (network events, body capture, console, storage).
- Evidence is written to `~/.agent-browser-runtime/profiles/<name>/`.
- Default port: `:17335`. CDP port is ephemeral (runtime-assigned) when the
  worker launches the browser.

**Use for:** target research, two-account tests, replay, artifact generation,
repeatable evidence, clean identities.

### Personal Chrome (`:17337`)

The secondary backend. A Chrome extension uses `chrome.debugger` as an
authorized bridge into the user's already-open Chrome tab.

- Scoped by extension permission and the current tab.
- Does not create new browser processes or profiles.
- Fewer CDP domains are available than Managed (extension sandbox limits).
- The bridge must be running (`npm run personal:chrome`) and the extension
  loaded before this backend is usable.

**Use for:** inspecting the user's current live session when they say "my
Chrome", "already logged in", or when a managed login path is blocked.

### Unified facade

Both backends expose the same `browser_*` tool names. The worker resolves the
backend at call time using:

1. `backend: "managed"` or `backend: "personal"` in the tool call params.
2. The profile's registered backend (set at `browser_open` time or via
   `profile_create`).
3. `backend: "auto"` — routes to Personal only when explicitly requested.

If the Personal bridge is not running and a personal-backend call arrives, the
worker returns a structured `personal_bridge_unavailable` error with startup
instructions.

---

## Tool families (143 Managed + 9 Personal)

### `browser_*` — unified facade (101 tools)

The product-level interface. Each tool handles backend routing, profile
resolution, and bounded output (with `next` hints and `ok` fields). Agents
should start here.

Sub-families:

| Sub-family | Tools | Purpose |
|---|---|---|
| Interaction | click, type, fill, scroll, press, select, wait, hover, drag, upload, double_click | Drive the page |
| Observation | snapshot, screenshot, text, find, eval, observe, stuck, accessibility_snapshot | Read page state |
| Capture / traffic | capture, inspect, security_pack, capture_bisect, evidence_timeline | F12 evidence collection |
| Profile lifecycle | open, navigate, tabs, tab_close, adopt_tab | Profile and tab management |
| Storage / cookies | storage_snapshot, cookie_summary, cookies_get/set, service_worker_*, indexeddb_*, cache_* | Application storage evidence |
| Evidence / replay | auth_boundary, evidence_bundle, evidence_manifest, replay, diff, artifact_* | Evidence handoff and replay |
| DOM / sources | dom_*, elements_snapshot, frame_tree, css_styles, event_listeners, sources_* | DOM and script evidence |
| Deep forensics | cdp_command, debugger_control, token_flow_trace, token_scan, memory/heap/cpu/coverage/performance | Advanced evidence |
| Health / routing | capabilities, ready, backend_status, feedback, worker_frame_deep_dive, security_research_pack | Readiness and diagnostics |

### `devtools_*` — F12-namespace aliases (111 tools)

91 of these are pure aliases of `browser_*` tools with a `devtools_` prefix,
for agents that prefer F12 terminology. The remaining 20 have independent
implementations: capture control, meta/usability tools, browser-process CDP
commands.

New agents should use `browser_*`. Reach `devtools_*` tools via
`browser_raw(toolName, params)` to avoid flooding the MCP context with aliases.

### `profile_*` — traffic and replay layer (22 tools)

Direct access to the CDP capture buffer and network data. No aliases — all
have independent implementations.

Includes: traffic query/summary/get, HAR export, request replay, raw request,
race request, JWT forge, OOB allocator/poller.

### `attack_intruder_*` — batch variant attack (7 tools)

Burp Intruder-style state machine: create, run, pause, resume, results, status,
evidence. Used for IDOR/BOLA variant testing.

### `cdp_*` — raw CDP plugin (6 tools)

Exposed by the cdp-traffic-capture plugin (compiled TypeScript): query, get,
cookies, fetch_intercept, stats, self_test. For scenarios where `browser_*`
facade cannot express the required CDP operation.

### `agent_inspect` — F12 router (1 tool)

The agent-facing router. Accepts a `focus` parameter and selects the right
evidence tools without the agent having to choose from all tools. Modes:
`overview`, `network`, `storage`, `console`, `dom`, `sources`, `performance`,
`search`, `evidence`, `debug`. Returns `nextTools` and a `toolPlan`.

---

## Dual-backend completeness protocol

`scripts/lib/dual-backend-completeness.test.mjs` enforces that tools which
operate on page state either work on both backends or are explicitly declared
Managed-only. This is the canonical gate before a tool is considered complete.

The devtools contract check (`npm run contract:devtools`) verifies that the
`devtools_*` alias surface matches the Managed and Personal backend
implementations. A "contract drift" failure means a tool exists in one backend
but not the other and is not whitelisted.

---

## Profile model

A profile is a named operating space:

```
profile: "researcher"
  → one browser tab
  → one evidence directory:  ~/.agent-browser-runtime/profiles/researcher/
  → one traffic journal:     traffic/traffic.jsonl
  → one event journal:       events/events.jsonl
  → screenshots:             screenshots/*.png
```

Profiles provide product-level isolation on top of one CDP endpoint. For
stronger process-level isolation (separate browser ports), multiple browser
processes can be launched with different `CDP_BROWSER_PORT` values.

---

## Security boundaries

### Artifact whitelist

`browser_artifact_read` validates artifact paths against a per-profile
whitelist. Absolute paths outside the evidence directory are rejected. This
prevents directory traversal through artifact reads.

### HTTP body cap

CDP body capture is capped per request to prevent runaway storage. The cap is
enforced at the CDP event level before writing to disk.

### DNS rebinding

The worker binds to `127.0.0.1` by default. Binding to `0.0.0.0` requires
setting `AGENT_BROWSER_RUNTIME_TOKEN` so all tool calls must include a bearer
token. Do not bind to `0.0.0.0` without a token.

### Personal Chrome scope

The Personal Chrome extension uses `chrome.debugger` which requires explicit
user permission in the browser. The bridge never attaches to a tab
automatically — the operator must authorize the connection.

### Evidence sensitivity

Screenshots, cookies, headers, request bodies, and script sources are sensitive
evidence. They are stored locally under `CDP_SECURITY_DATA_DIR` and are excluded
from `npm publish` via the `files` field in `package.json`. Do not commit
captured evidence from real targets.

Full boundary documentation: `docs/safety-boundaries.md`.

---

## Cross-platform support

| Platform | Worker start | Auto-start mechanism | Notes |
|---|---|---|---|
| Windows | `$env:CDP_LAUNCH_BROWSER="1"; npm run agent:server` | Scheduled Task (`scripts/install-agent-server-task.ps1`) | PowerShell recommended |
| Linux | `CDP_LAUNCH_BROWSER=1 npm run agent:server` | systemd user units (`scripts/install-systemd-units.sh`) | Headless CI: set `CDP_BROWSER_HEADLESS=1` |
| macOS | `CDP_LAUNCH_BROWSER=1 npm run agent:server` | launchd LaunchAgents (`scripts/install-launchd-plists.sh`) | Same as Linux for env vars |

The auto-start scripts write unit/plist files but do not enable them
automatically. Follow the printed instructions after running each script.

Browser detection order (Managed Browser): CloakBrowser → Microsoft Edge →
Google Chrome. Set `CDP_BROWSER_EXECUTABLE` to override.

---

## Key source files

| File | Role |
|---|---|
| `scripts/agent-cdp-server.mjs` | Main worker: HTTP server, backend routing, `routeToPersonal()` |
| `scripts/agent-browser-cli.mjs` | CLI entry point |
| `scripts/lib/register-*.mjs` | Tool registration families |
| `scripts/lib/result-format.mjs` | `toolResult()` — the single output wrapper |
| `scripts/lib/dual-backend-completeness.test.mjs` | Backend completeness gate |
| `scripts/devtools-contract-check.mjs` | devtools_* alias contract check |
| `src/plugins/cdp-traffic-capture/` | TypeScript CDP capture plugin |
| `src/plugins/browser-profile-pool/` | TypeScript profile pool plugin |
| `src/plugin-sdk/` | `definePluginEntry` — generic plugin adapter interface |

---

## OOB (Out-of-Band) Callback Server

The OOB server (`scripts/oob-server.mjs`) catches blind callbacks for testing blind SSRF, blind SSTI, blind XXE, log4j JNDI, and blind injection. It is a separate process from the browser worker and personal bridge.

**Physical host:** your remote host, port **17338**.

Why separate: OOB needs to be reachable from the target application, not the browser worker. Run it on a host with a stable address reachable from your test targets. The port is reserved exclusively for OOB to avoid collisions with the worker (17335/17336/17337).

**Default in oob-client.mjs:** `http://YOUR-OOB-SERVER.example` (placeholder). Override via `OOB_SERVER_BASE` env var or `params.serverBase` with your actual collector URL.

**Do not expose on the public internet without authentication.** The OOB server records raw HTTP requests (headers, bodies) from callback targets. Reverse-proxy with auth or restrict to your test network.

See `docs/oob-server-setup.md` for deployment instructions (nohup / systemd).
