# Shared Browser Worker Integration

Agent Browser Runtime can run as one local Browser Worker for every agent on
the workstation. The worker is framework-neutral: Codex, Claude, Hermes,
OpenClaw-compatible adapters, and custom SDKs should all call the same HTTP
facade instead of binding to CDP target ids, extension internals, or per-agent
browser scripts.

## Contract

- Start the runtime once on the workstation.
- Expose one local base URL, defaulting to `http://127.0.0.1:17335`.
- Keep profiles target-scoped or role-scoped.
- Use `browser_*` facade tools first.
- Drill into `devtools_*` only through `browser_raw` or explicit operator
  workflow when exact F12 evidence is needed.
- Collect objective evidence only. The worker does not decide whether a signal
  is a vulnerability.

## Start The Worker

PowerShell:

```powershell
cd C:\Users\Tong\project\agent-browser-runtime
$env:CDP_LAUNCH_BROWSER="1"
npm run agent:server
```

Bash:

```bash
cd /path/to/agent-browser-runtime
CDP_LAUNCH_BROWSER=1 npm run agent:server
```

The professional default is a visible managed browser. Use
`CDP_BROWSER_HEADLESS=1` only for CI or non-interactive smoke tests.

## Backend Selection

There are two local browser workers:

| Worker | URL | Purpose |
|---|---|---|
| Managed Browser | `http://127.0.0.1:17335` | Agent-owned browser profiles, clean target identities, strongest CDP/F12 evidence capture |
| Personal Chrome | `http://127.0.0.1:17337` | User's already-open real Chrome via extension bridge, including logged-in tabs and real browser context |

Route by intent:

- Use Managed Browser when the agent owns the browser state or needs repeatable
  forensic artifacts.
- Use Personal Chrome when the user asks to inspect their current Chrome tab or
  a login/session only works in their real browser.
- Do not try to retrofit `--remote-debugging-port` onto already-running Chrome.
  That is not how CDP works. For mid-session takeover, use the extension bridge.
- Do not choose cookie/profile copying as the first path when Personal Chrome is
  connected; it is a fallback for unusual debugging cases.

## Health And Tool Discovery

```bash
npm run worker:doctor
curl http://127.0.0.1:17335/health
curl http://127.0.0.1:17335/tools
```

`worker:doctor` prints a machine-readable handoff with:

- `baseUrl`: the URL agents should call,
- `ok`: whether the worker is reachable,
- `facadeTools`: the supported `browser_*` surface,
- `sdk.toolRequestType`: the SDK request type,
- `startCommand`: copyable commands for a fresh workstation.
- `backendRouting`: when to use Managed Browser vs Personal Chrome.
- `personalChrome`: whether the extension bridge is currently connected.

## SDK Integration

The Agent Orchestration SDK already has a `browser_runtime_call` tool request
and a `BrowserRuntimeClient`. Point it at this worker:

```powershell
$env:AGENT_BROWSER_RUNTIME_URL="http://127.0.0.1:17335"
```

The SDK should keep Browser Runtime calls owned by `browser_worker` and should
not let Scout, Builder, or Manager call live browser tools directly. The worker
is an execution boundary; interpretation remains with the agent role and the
human operator.

Example SDK request:

```json
{
  "type": "browser_runtime_call",
  "toolName": "browser_open",
  "profile": "target-a-browser-worker",
  "params": {
    "url": "https://example.com",
    "waitMs": 1000
  },
  "reason": "Open an authorized page in a target-scoped browser profile."
}
```

## MCP Integration

For MCP-compatible clients such as Claude Desktop, Cursor, or other local agent
hosts, build the project and run the native stdio MCP server:

```bash
npm run build
npm run mcp:server
```

Example host config:

```json
{
  "mcpServers": {
    "agent-browser-runtime": {
      "command": "node",
      "args": ["C:/Users/Tong/project/agent-browser-runtime/dist/mcp-server/index.js"],
      "env": {
        "AGENT_BROWSER_RUNTIME_URL": "http://127.0.0.1:17335"
      }
    }
  }
}
```

The MCP server always exposes `browser_worker_doctor`. When the worker is
running, it dynamically reads the HTTP tool catalog from `/tools`, then filters
what is exposed through MCP according to `AGENT_BROWSER_MCP_TIER`.

Default MCP tier is `core`, which keeps the model-facing tool list small:

```text
browser_worker_doctor, browser_backend_status, profile_list, profile_resume,
browser_tabs, browser_open, browser_navigate, browser_snapshot, browser_text,
browser_find, browser_click, browser_type, browser_scroll, browser_screenshot,
browser_capture, browser_inspect, browser_security_pack, browser_feedback,
browser_raw
```

Other options:

```bash
AGENT_BROWSER_MCP_TIER=extended npm run mcp:server
AGENT_BROWSER_MCP_TIER=all npm run mcp:server
AGENT_BROWSER_MCP_TOOLS=browser_open,browser_raw npm run mcp:server
```

Use `browser_raw` as the escape hatch for hidden `devtools_*` tools. The worker
HTTP `/tools` endpoint remains full-fidelity for SDKs and debugging; only MCP
`tools/list` is narrowed for agent usability.

## Agent Workflow

Recommended first route:

```text
browser_open -> browser_capture -> browser_inspect -> browser_security_pack
```

When another agent resumes a task, read the returned `routeSummary` and
`operatorHandoff` before scanning large artifacts. They are designed to keep
handoffs bounded and avoid dumping full HARs or screenshots into chat.

## Profiles

Use stable, human-readable names:

- `default` for simple local tests,
- `target-a-browser-worker` for a target-scoped worker,
- `teacher-role` for a role-scoped agent,
- `demo-fixture` for public examples.

Do not mix unrelated targets or identities in one profile. A profile owns its
traffic journal, screenshots, snapshots, and evidence directory.

## Public Demo Boundary

Public examples should use `example.com` or local fixtures. Do not commit HARs,
screenshots, cookies, authorization headers, or evidence from real targets.
