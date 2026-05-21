# Agent Browser Runtime Agent Guide

This repository builds a local DevTools / F12 evidence runtime for AI agents.

## First Read

| File | Use |
|---|---|
| `README.md` | Product overview and quickstart |
| `docs/codex-agent-manual.md` | Detailed Codex/Claude/Hermes operating manual |
| `docs/agent-devtools-api.md` | Full facade and low-level tool contract |
| `docs/browser-worker-integration.md` | Worker / SDK / MCP integration |
| `docs/feedback-and-gaps.md` | Bug, capability-gap, and feedback protocol |

## Product Contract

- Use the `browser_*` facade first.
- Standard workflow: `browser_open -> browser_capture -> browser_inspect -> browser_security_pack`.
- Drill down to `devtools_*` only when exact F12 evidence is needed.
- Use `browser_raw`, `devtools_cdp_command`, or `devtools_browser_cdp_command` as escape hatches.
- If a tool is broken, confusing, or missing evidence, call `browser_feedback` before moving on.
- Keep the objective-tool boundary: collect evidence and expose browser/F12 boundaries; do not decide whether a signal is a vulnerability.

## Browser Worker

Default worker URL:

```text
http://127.0.0.1:17335
```

Start a managed browser-backed worker:

```powershell
$env:CDP_LAUNCH_BROWSER="1"
npm run agent:server
```

Health check:

```powershell
npm run worker:doctor
```

MCP server for Codex / Claude / Cursor-style clients:

```powershell
npm run build
npm run mcp:server
```

Set `AGENT_BROWSER_RUNTIME_URL=http://127.0.0.1:17335` when another agent or SDK needs to call the worker.

## Browser Modes

- Managed Browser / Agent Browser: main professional path. The runtime launches a visible Edge/Chrome profile for the agent.
- Personal Profile: user's real Chrome tab through the extension bridge. Use only with explicit operator authorization.

The product contract should stay the same across both modes. Backend-specific names are for debugging and compatibility.

## Profile Rules

Use stable, readable, target/role scoped names:

- `default` for simple public tests only.
- `demo-fixture` for local fixture/demo work.
- `<target>-guest-clean` for unauthenticated target work.
- `<target>-attacker-auth` / `<target>-victim-auth` for separated identity state.
- `<role>-scratch-<date>` for temporary role/session work.

Do not mix unrelated targets, accounts, or identities in one profile.

If a visible browser page does not respond through the expected profile, first
call `browser_tabs` and `profile_list`. A healthy profile should be `attached`
to a live tab. If the tab exists on the same CDP endpoint but the profile is
stale or wrong, bind it with `browser_adopt_tab`. If the page is not in
`browser_tabs`, it belongs to another browser process or CDP port and this
worker cannot control it until it is opened through Browser Runtime or attached
through the right backend.

## Local Checks

Fast development check:

```bash
npm run check
```

Browser/tool checks:

```bash
npm run check:full
```

Professional evidence-runtime gate:

```bash
npm run check:professional
```

Release/readiness check:

```bash
npm run release:readiness
```

`smoke:personal` requires the Personal Chrome extension and bridge to be running.

## Feedback And Gaps

If the tool is confusing, broken, or missing an F12/AppSec capability, record a local note before continuing:

```json
{
  "toolName": "browser_feedback",
  "params": {
    "type": "gap",
    "title": "Short title",
    "summary": "What objective tool behavior was missing.",
    "tool": "browser_inspect",
    "profile": "demo-fixture"
  }
}
```

Local web page:

```text
http://127.0.0.1:17335/feedback
```

CLI fallback:

```bash
npm run feedback:note -- --type gap --title "Short title" --summary "What objective tool behavior was missing."
```

Feedback note types: `bug`, `gap`, `docs`, `product`, `idea`.

Local `feedback/*.md` notes are intentionally ignored by git. Public-safe items can be converted into GitHub issues with `.github/ISSUE_TEMPLATE/`.

## Safety

Do not commit local evidence, browser profiles, logs, captured HAR files, cookies, tokens, screenshots with accounts, or private target data. Use `example.com` or local fixtures in public examples.
