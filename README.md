# Agent Browser Runtime

**DevTools-grade browser evidence runtime for AI agents.**

Give your agent a browser with 143 Managed + 9 Personal tools — navigate, click, capture F12
Network/Storage/Console/Sources evidence, replay requests, and collect one-call
security research packs. Works over HTTP or CLI.

---

## Why not Playwright or Chrome DevTools MCP?

| | Playwright | **Agent Browser Runtime** |
|---|---|---|
| Interface | Script API (code, not tools) | HTTP + CLI, 143 Managed + 9 Personal tools |
| Network evidence | Basic HAR | F12-grade: Network/Storage/Console/Sources/Performance |
| Backends | One browser | Managed (clean profiles) + Personal Chrome (extension) |
| Profile isolation | Manual | Named profiles, per-profile evidence dirs |
| Replay/Intruder | External | Built-in replay, batch variants, intercept |
| Agent-first design | No | Yes — facade → drill-down, bounded outputs, `next` hints |

Playwright is a library you code against. ABR is an HTTP service your agent calls
directly — no wrapper needed.

---

## Architecture

```
Agent (CLI / HTTP POST)
          |
          v
  Worker :17335  (Managed Browser — Playwright + direct CDP)
          |
          +---> Named profile: one tab, one evidence dir, one traffic journal
          |
  Bridge :17337  (Personal Chrome — extension bridge via chrome.debugger)
          |
          +---> User's already-open Chrome tab (operator-authorized only)
```

Both backends expose the same `browser_*` facade. Route by backend/profile, not
by port or browser process.

---

## Quickstart (30 seconds)

### Install

```bash
# npm (global)
npm install -g agent-browser-runtime

# from source
git clone https://github.com/ttcd77/agent-browser-runtime.git
cd agent-browser-runtime
npm install && npm run build
```

### Start the worker

**Linux / macOS:**
```bash
CDP_LAUNCH_BROWSER=1 npm run agent:server
```

**Windows (PowerShell):**
```powershell
$env:CDP_LAUNCH_BROWSER="1"
npm run agent:server
```

### First tool call

> **Global install?** `agent-browser doctor` works directly.
> **Source install?** Use `npx agent-browser doctor` or `node scripts/agent-browser-cli.mjs doctor`.

```bash
# Health check
agent-browser doctor

# Open a page, capture evidence, print artifact paths
agent-browser open https://example.com --profile demo
agent-browser capture start --profile demo --label first
agent-browser inspect network --profile demo
agent-browser pack https://example.com --profile demo
```

Now try your own URL: `agent-browser pack https://your-site.com --profile mine`.

---

## Auto-start on login

| Platform | Script | Mechanism |
|---|---|---|
| Windows | `scripts/install-agent-server-task.ps1` | Scheduled Task (user-level) |
| Linux | `scripts/install-systemd-units.sh` | systemd user units |
| macOS | `scripts/install-launchd-plists.sh` | launchd LaunchAgents |

**Windows:**
```powershell
pwsh -File scripts/install-agent-server-task.ps1
pwsh -File scripts/install-personal-bridge-task.ps1
```

**Linux / macOS:**
```bash
bash scripts/install-systemd-units.sh   # Linux
bash scripts/install-launchd-plists.sh  # macOS
# follow printed instructions to enable units
```

---

## Personal Chrome (extension bridge)

When you need to inspect your already-open Chrome tab:

**Linux / macOS:**
```bash
npm run personal:chrome
```

**Windows (PowerShell):**
```powershell
npm run personal:chrome
```

Load the unpacked extension from `extension/`, then:

```bash
agent-browser backend status --intent personal-current-tab
```

Read `docs/personal-chrome-quickstart.md` before using this mode.

---

## Tools (143 Managed + 9 Personal, 7 categories)

| Category | Count | Example tools |
|---|---|---|
| Navigation & interaction | ~20 | `browser_open`, `browser_click`, `browser_type`, `browser_fill`, `browser_scroll`, `browser_drag`, `browser_wait` |
| Page observation | ~10 | `browser_snapshot`, `browser_screenshot`, `browser_text`, `browser_find`, `browser_eval`, `browser_observe` |
| Capture & traffic | ~25 | `browser_capture`, `profile_traffic_query`, `profile_request_detail`, `profile_export_har`, `cdp_query` |
| Evidence & artifacts | ~20 | `browser_security_pack`, `browser_inspect`, `browser_evidence_bundle`, `browser_artifact_read`, `browser_auth_boundary` |
| Storage / cookies | ~15 | `browser_storage_snapshot`, `browser_cookies_get`, `browser_cookies_set`, `browser_cookie_summary`, `browser_indexeddb_read` |
| Replay & attack | ~15 | `browser_replay`, `profile_request_replay`, `profile_race_request`, `profile_jwt_forge`, `attack_intruder_*` |
| Health & routing | ~10 | `browser_ready`, `browser_backend_status`, `browser_capabilities`, `agent_inspect`, `browser_worker_doctor` |

Full tool reference: `docs/agent-devtools-api.md`.
F12-to-tool lookup: `docs/devtools-panel-map.md`.

Default professional workflow:

```
browser_open → browser_capture → browser_inspect → browser_security_pack
```

Use `agent_inspect` as the agent router — it picks the right evidence tools
based on a `focus` parameter (`overview`, `network`, `storage`, `console`,
`dom`, `sources`, `performance`, `evidence`, `debug`) without requiring the
agent to scan all tools.

---

## HTTP API

Any tool is callable as a plain HTTP POST:

```bash
curl -X POST http://127.0.0.1:17335/tool/browser_open \
  -H "content-type: application/json" \
  -d '{"profile":"researcher","url":"https://example.com"}'

curl -X POST http://127.0.0.1:17335/tool/browser_capture \
  -H "content-type: application/json" \
  -d '{"profile":"researcher","action":"start","label":"first-capture"}'

curl -X POST http://127.0.0.1:17335/tool/profile_traffic_query \
  -H "content-type: application/json" \
  -d '{"profile":"researcher","limit":20}'
```

Health check:

```bash
curl http://127.0.0.1:17335/health
```

Local dashboard: `http://127.0.0.1:17335/panel`

---

## Security

- Tools return objective evidence — they do not classify vulnerabilities.
- Use `AGENT_BROWSER_RUNTIME_TOKEN` to require a bearer token on all tool calls.
- `CDP_BROWSER_HEADLESS=1` for headless/CI mode (headful is default for AppSec work).
- Set `CDP_SECURITY_DATA_DIR` to control where evidence is stored.
- Artifact paths are validated against a whitelist; no directory traversal.
- HTTP body capture is capped to prevent runaway storage.
- Personal Chrome mode requires explicit operator authorization — never attaches silently.

For DNS rebinding protection and full boundary details: `docs/safety-boundaries.md`.

---

## Key environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CDP_AGENT_SERVER_PORT` | `17335` | Worker HTTP port |
| `CDP_AGENT_PROFILE` | `default` | Default profile when omitted |
| `CDP_LAUNCH_BROWSER` | unset | Launch Managed Browser on start |
| `CDP_BROWSER_HEADLESS` | unset | Headless mode (CI/test) |
| `CDP_SECURITY_DATA_DIR` | `~/.agent-browser-runtime` | Evidence storage root |
| `CDP_BROWSER_PORT_MODE` | `ephemeral` | `ephemeral` or `fixed` CDP port |
| `PERSONAL_CHROME_HTTP_PORT` | `17337` | Personal Chrome bridge port |
| `AGENT_BROWSER_RUNTIME_TOKEN` | unset | Bearer token for HTTP auth |

Full list: see the Environment Variables section of `docs/agent-operator-runbook.md`.

---

## Evidence layout

```
~/.agent-browser-runtime/
  profiles/
    <profile>/
      events/events.jsonl
      traffic/traffic.jsonl
      screenshots/*.png
      evidence/
```

Do not commit captured evidence from real targets until reviewed and sanitized.

---

## SDK integration

```ts
const baseUrl = "http://127.0.0.1:17335";

async function callTool(name: string, params: unknown) {
  const res = await fetch(`${baseUrl}/tool/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  return res.json();
}

await callTool("browser_open", { profile: "researcher", url: "https://example.com" });
await callTool("browser_capture", { profile: "researcher", action: "start" });
const snapshot = await callTool("browser_snapshot", { profile: "researcher" });
```

No CDP target ids, tab ids, or browser ports needed. Route by profile name.

---

## Architecture reference

See `docs/architecture.md` for a full breakdown of the two backends, tool
families, security boundaries, and cross-platform support.

---

## Contributing & Contact

- **Issues / questions**: [GitHub Issues](https://github.com/ttcd77/agent-browser-runtime/issues)
- **Pull requests**: see [CONTRIBUTING.md](CONTRIBUTING.md)
- **Security disclosures**: see [SECURITY.md](SECURITY.md)

---

## Troubleshooting

### "browser CDP endpoint is not available; no DevToolsActivePort appeared"

The Managed Browser worker tried to launch Chrome but the CDP port never came up. Common causes:

- **Playwright browser not installed**: run `npx playwright install chromium` once.
- **Port 17335 (worker) or 9222 (CDP) in use**: another worker may already be running. Stop it (`agent-browser doctor` to confirm) or set `CDP_AGENT_SERVER_PORT` and `CDP_DEBUG_PORT` to free ports.
- **No display on Linux server**: headful mode needs a display. Set `CDP_BROWSER_HEADLESS=1` or use a virtual framebuffer (`xvfb-run`).
- **Firewall blocking localhost**: most Linux containers ship without one, but check with `ss -tlnp | grep 17335`.

### "EADDRINUSE: address already in use 127.0.0.1:17335"

A previous worker is still running. Either:
- `pkill -f agent-cdp-server` (Linux/macOS)
- Find the PID with `netstat -ano | findstr :17335` (Windows) and `taskkill /F /PID <pid>`

### Personal Chrome bridge "extension not connected"

The Chrome extension must be installed and the personal bridge running. See [`docs/personal-chrome-quickstart.md`](docs/personal-chrome-quickstart.md).

### npm install reports HIGH-severity advisories

`ws` is at 8.21.0+ (patched). If you see advisories for `vite`, they are transitive dev-only and do not enter the production bundle.

### Where are my evidence files?

Per-profile under `~/.agent-browser-runtime/profiles/<profile>/`:
- `traffic/` — request/response journals
- `evidence/` — evidence bundles
- `screenshots/`, `events/` — page captures

Use `agent-browser doctor` to print the exact path on your machine.

### Reporting issues

- **Bugs**: [GitHub Issues](https://github.com/ttcd77/agent-browser-runtime/issues) using the `bug_report` template.
- **Capability gaps** (tool missing for a workflow): same Issues page, `capability_gap` template.
- **Security**: see [SECURITY.md](SECURITY.md).

---

## License

MIT — see [LICENSE](LICENSE).