# Codex Agent Manual

This manual is for a new Codex, Claude, Hermes, or SDK worker that needs to use
Agent Browser Runtime without asking the operator how it works.

## Product In One Sentence

Agent Browser Runtime is a local F12 / DevTools evidence runtime for agents.
Use it when an agent needs browser state, DOM, Network, Storage, Console,
Sources, WebSocket, Service Worker, HAR, trace, or portable evidence-pack data.

It is not a vulnerability scanner. It collects objective browser evidence.

## First Five Minutes

1. Read `AGENTS.md`.
2. Check whether the local Browser Worker is running:

   ```bash
   npm run worker:doctor
   ```

3. If it is not running, start it from the project root:

   PowerShell:

   ```powershell
   $env:CDP_LAUNCH_BROWSER="1"
   npm run agent:server
   ```

4. Use the facade tools first:

   ```text
   browser_open -> browser_capture -> browser_inspect -> browser_security_pack
   ```

5. Only drill into `devtools_*` when a facade response gives you a concrete
   `requestId`, `scriptId`, `frameId`, artifact path, or drilldown route.

## Which Interface Should I Use?

| Situation | Use |
|---|---|
| You are an MCP-capable agent | `npm run mcp:server` / `agent-browser-mcp` |
| You are inside Agent Orchestration SDK | `browser_runtime_call` |
| You are scripting locally | HTTP `POST /tool/<toolName>` |
| You only need a one-shot evidence pack | `npm run research:pack -- --url <url> --profile <profile>` |
| You are checking setup | `npm run worker:doctor` |

Default worker URL:

```text
http://127.0.0.1:17335
```

Set a custom URL with:

```text
AGENT_BROWSER_RUNTIME_URL=http://127.0.0.1:<port>
```

## Backend Routing: Managed vs Personal

Do not assume every browser request should go to the managed worker.

| Situation | Backend | URL |
|---|---|---|
| Clean agent-owned profile, repeatable F12 evidence, isolated identity, HAR, traces, replay, heap, coverage | Managed Browser | `http://127.0.0.1:17335` |
| User says "my Chrome", "personal browser", "current tab", "already logged in", or managed login is blocked | Personal Chrome extension bridge | `http://127.0.0.1:17337` |

Why this matters:

- Managed Browser uses CDP on a browser process that Browser Runtime launched or
  that was started with `--remote-debugging-port`.
- It cannot attach after the fact to a normal already-running Chrome tab.
- Personal Chrome uses the unpacked extension plus `chrome.debugger`, so it can
  inspect/control the user's real Chrome after local authorization.
- Cookie export, copied profiles, and DPAPI cookie injection are fallback/debug
  tactics. If the Personal Chrome bridge is connected, use it first for
  already-logged-in user tabs.

Check both routes with:

```bash
npm run worker:doctor
```

The doctor output includes `backendRouting` and `personalChrome` fields so a new
agent can route correctly without asking the operator.

## MCP Setup

Build first:

```bash
npm run build
```

Host config:

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

The MCP server always exposes `browser_worker_doctor`. When the Browser Worker
is running, it dynamically exposes the full `/tools` catalog.

## Profile Rules

A profile is an agent-facing operating space. It owns the tab, evidence
directory, traffic journal, screenshots, snapshots, HARs, traces, and research
packs for that task.

Use stable names:

| Profile | Use |
|---|---|
| `default` | simple public tests only |
| `demo-fixture` | public docs and CI fixtures |
| `<target>-guest-clean` | unauthenticated target work |
| `<target>-attacker-auth` | attacker account state |
| `<target>-victim-auth` | victim account state |
| `<target>-browser-worker-1` | scratch profile |
| `<role>-scratch-<date>` | temporary role/session work |

Do not mix unrelated targets or identities in one profile.

## Profile / Tab Drift

Browser Runtime stores durable profile records, but Chrome/Edge tabs are live
objects. After a browser restart, manual tab movement, or a tool crash, a
profile can point at a stale tab. Diagnose this before assuming the page itself
is broken:

1. Call `browser_tabs`.
2. Call `profile_list`.
3. Check whether the profile status is `attached`, `stale`, or `unbound`.
4. If the desired tab appears in `browser_tabs`, call `browser_adopt_tab` with
   `profile` plus `tabId`, `urlContains`, or `titleContains`.
5. If the desired tab does not appear in `browser_tabs`, it is not attached to
   the current CDP endpoint. Open it through `browser_open`/`browser_navigate`
   or connect the worker to the browser process that owns that tab.

This is the first check for “the managed browser is stuck” reports.

If the previous agent chat/session was closed, start with `profile_resume` or
`browser_resume_profile`. The recovery semantics are deliberately explicit:

- `attached-existing-tab`: the original live tab is still present, so continue.
- `opened-new-tab-from-last-url`: the profile was stale; Browser Runtime opened
  the last known URL in a fresh managed tab and rebound the profile.
- `browser-storage-continuity-only`: cookies/storage remain in the managed
  browser identity, but live DOM, JS memory, and in-flight DevTools recording do
  not survive a closed tab or restarted browser.

After resume, start capture again before reproducing the action you care about.

## Operator-Assisted Auth Bootstrap

For login flows that include passwords, 2FA, passkeys, SSO, or anti-abuse
scoring, do not try to force a fully automated login as the default path. Use
`browser_auth_bootstrap`:

1. `action=start` with `profile` and `loginUrl`.
2. The human completes login in the visible managed browser.
3. `action=status` checks URL/cookie-name conditions without printing secrets.
4. `action=finish` stops capture on success.
5. Continue normal work with the now-authenticated profile.

This preserves the intended product model: Browser Runtime owns evidence,
profile state, and F12 capture; the operator owns account authentication.

## Standard AppSec Workflow

1. Open the page:

   ```json
   {
     "toolName": "browser_open",
     "profile": "demo-fixture",
     "params": {
       "url": "https://example.com",
       "waitMs": 1000
     }
   }
   ```

2. Start capture before the action you care about:

   ```json
   {
     "toolName": "browser_capture",
     "profile": "demo-fixture",
     "params": {
       "action": "start",
       "label": "initial-load"
     }
   }
   ```

3. Inspect the first screen:

   ```json
   {
     "toolName": "browser_inspect",
     "profile": "demo-fixture",
     "params": {
       "focus": "overview"
     }
   }
   ```

4. Generate the portable evidence pack:

   ```json
   {
     "toolName": "browser_security_pack",
     "profile": "demo-fixture",
     "params": {
       "includeHar": true,
       "includeTrace": true,
       "includeApplicationExport": true
     }
   }
   ```

5. Read `routeSummary`, `operatorHandoff`, and artifact paths before loading
   any large artifact into context.

## F12 Data Map

| F12 need | First tool |
|---|---|
| DOM / hidden fields / iframes | `browser_inspect` with `focus="dom"` |
| Network requests / headers / redirect chain | `browser_inspect` with `focus="network"` |
| Exact request detail | `devtools_request_detail` through `browser_raw` |
| Request body / payload | `devtools_request_body` or `devtools_request_payload` |
| Cookies / localStorage / sessionStorage | `browser_inspect` with `focus="storage"` |
| Service Worker / CacheStorage / IndexedDB | `devtools_application_export` through `browser_raw` |
| JS bundles / source maps | `browser_inspect` with `focus="sources"` |
| Console / browser issues | `browser_inspect` with `focus="console"` |
| WebSocket / SSE | `devtools_realtime_log` through `browser_raw` |
| Portable handoff | `browser_security_pack` |

## Troubleshooting

| Symptom | What to do |
|---|---|
| `worker:doctor` says `ok:false` | Start `npm run agent:server` with `CDP_LAUNCH_BROWSER=1` |
| No Network rows | Start capture before the action, then hard reload |
| Missing request body | Check `devtools_har_completeness`; Chrome may not expose old bodies |
| Profile seems polluted | Use a new target-scoped profile name |
| Too many tools in MCP | Start with `browser_*`; use low-level tools only from drilldown routes |
| Need personal Chrome state | Use Personal Chrome mode only with explicit operator authorization |

## Feedback And Capability Gaps

If the tool blocks you, record it immediately:

```json
{
  "toolName": "browser_feedback",
  "profile": "demo-fixture",
  "params": {
    "type": "gap",
    "title": "Need bounded WebSocket frame filter",
    "summary": "Agent could not filter realtime frames by room id.",
    "tool": "browser_inspect",
    "expected": "Facade points to a bounded realtime frame drilldown.",
    "actual": "Agent had to scan the raw realtime log manually."
  }
}
```

If the worker tool catalog is not available, use the CLI fallback:

```bash
npm run feedback:note -- --type gap --title "Need bounded WebSocket frame filter" --summary "Agent could not filter realtime frames by room id."
```

Human-readable local page:

```text
http://127.0.0.1:17335/feedback
```

Read `docs/feedback-and-gaps.md` for the full protocol.

Do not put tokens, cookies, private screenshots, real HARs, or account state in
public issues. Use local feedback notes for sensitive details.
