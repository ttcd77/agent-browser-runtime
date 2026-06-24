# ABR usage for agents

This file is the first page an agent should read before using Agent Browser
Runtime. It describes the current production model, not old worktree ports or
removed managed-browser terminology.

## Product model

ABR has three lanes:

| Lane | Meaning | Use when |
|---|---|---|
| Personal Chrome | The operator's real Chrome through the extension bridge. | The user says "my Chrome", "current tab", "already logged in", or a login wall needs real browser reputation. |
| Agent Browser | A fresh isolated Chrome profile created for the agent with `profile_create`. | New target work, anonymous recon, test accounts, attacker/victim isolation, or any task where the agent should own the browser state. |
| Raw HTTP | Direct HTTP requests using captured cookies/tokens. | After login/session capture, for API testing, replay, IDOR/BOLA checks, and batch variants. |

Avoid the word `managed` in new docs and prompts. It is legacy terminology and
currently conflicts with the production runtime state.

## Current ports

| Service | URL | Purpose |
|---|---|---|
| Personal Chrome bridge | `http://127.0.0.1:17337` | Drives Personal Chrome and creates Agent Browser profiles. |
| Worker compatibility endpoint | `http://127.0.0.1:17335` | Legacy/compatibility worker. Check health before relying on it. |

Do not use `17347` unless a specific worktree session explicitly says it started
a bridge there.

## First commands

Check what is really running:

```powershell
Invoke-RestMethod http://127.0.0.1:17337/health
Invoke-RestMethod -Method Post http://127.0.0.1:17337/tool/personal_chrome_list_browsers -Body '{}' -ContentType 'application/json'
```

Read the available tool catalog:

```powershell
Invoke-RestMethod http://127.0.0.1:17337/tools
Invoke-RestMethod -Method Post http://127.0.0.1:17337/tool/browser_workflow_guide -Body '{"task":"first-pass"}' -ContentType 'application/json'
```

## Use Personal Chrome

Use this when the user explicitly wants the already-open real Chrome session.

```powershell
$base = 'http://127.0.0.1:17337'
Invoke-RestMethod -Method Post "$base/tool/personal_chrome_list_browsers" -Body '{}' -ContentType 'application/json'
Invoke-RestMethod -Method Post "$base/tool/personal_chrome_select_browser" -Body '{"browser":"Windows-0fa5"}' -ContentType 'application/json'
Invoke-RestMethod -Method Post "$base/tool/personal_chrome_read_page" -Body '{"maxChars":8000}' -ContentType 'application/json'
```

If operating on the user's current tab, keep actions minimal and explicit.
Prefer opening a background test tab for experiments.

## Create an Agent Browser

Use this when the agent should own an isolated browser.

```powershell
$base = 'http://127.0.0.1:17337'
Invoke-RestMethod -Method Post "$base/tool/profile_create" -Body '{"name":"target-attacker"}' -ContentType 'application/json'
Invoke-RestMethod -Method Post "$base/tool/profile_create" -Body '{"name":"target-victim"}' -ContentType 'application/json'
Invoke-RestMethod -Method Post "$base/tool/profile_list" -Body '{}' -ContentType 'application/json'
```

Each Agent Browser is a real `chrome.exe` with its own `--user-data-dir`,
cookies, history, and remote-debugging port. It is the replacement term for
"spawn profile" in agent-facing docs.

One-time setup: `profile_create` needs the template profile to contain the ABR
extension.

```powershell
powershell -File .\scripts\setup-template-profile.ps1
```

## Warm an Agent Browser from Personal Chrome

When a site needs the operator's browser reputation, copy only the required
origin state into an Agent Browser:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:17337/tool/profile_clone_origin_state `
  -ContentType 'application/json' `
  -Body '{"source":{"browser":"Windows-0fa5"},"destination":{"profile":"target-attacker"},"origins":["https://app.example.com"]}'
```

This is an Agent Browser capability. It should not be treated as a fourth lane.

## After session capture

Once cookies or tokens are captured, API testing should move to Raw HTTP where
possible. Browser clicks are for login, discovery, and evidence capture; Raw
HTTP is for exact replay, authorization checks, and batch variants.

## Agent rules

- Do not guess which port or browser lane is alive. Check health first.
- Do not use Personal Chrome for isolated target work unless the user asked for
  real Chrome state.
- Do not mix attacker and victim in one Agent Browser.
- Do not trust a click result by `ok:true` alone. Verify URL, DOM, request, or
  screenshot effect after the action.
- If a tool or workflow guide recommends a tool name that 404s, fix the tool
  contract or this document. Do not work around it silently.
