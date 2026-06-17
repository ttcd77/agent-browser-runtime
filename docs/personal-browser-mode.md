# Personal Browser Mode

Personal Browser Mode means the agent can inspect or operate a Chrome tab that
the operator is already using.

This is different from the default Managed Browser path:

- Managed Browser: the runtime owns a dedicated browser profile for agents and
  talks to Chrome through direct Chrome DevTools Protocol (CDP).
- Personal Browser: a Chrome extension uses `chrome.debugger` as an authorized
  bridge to the user's current tab. This still routes many DevTools-style
  commands, but it is scoped by extension permission and the selected tab.

## Why It Exists

Sometimes the human sees a strange browser state first: a broken login, a UI that
only appears with their cookies, an unexpected network request, or a page that
does not behave like the agent's clean test profile.

In that case the user can ask an agent to inspect the same already-open tab
through the Personal Chrome extension bridge.

## Important Limit

Personal Browser is not a clean test profile. It shares the user's real browser
state, so it is not suitable for two-account isolation, public demos, or
repeatable evidence packages.

If the Personal Chrome extension bridge is not available, the older fallback is
to start a separate personal debugging browser with a remote debugging port.
That fallback is still not the Managed Browser mainline and it does not attach
to an ordinary Chrome process that is already running without debugging enabled.

## Extension Bridge Path

```powershell
npm run personal:chrome
```

Then load the repository `extension/` directory in `chrome://extensions` and
check:

```powershell
Invoke-RestMethod http://127.0.0.1:17337/health
```

Expected: `connected` is at least `1`.

## Legacy Debugging Browser Fallback

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --remote-debugging-port=9222 `
  --remote-allow-origins=* `
  --user-data-dir="$env:USERPROFILE\.agent-browser-runtime\personal-edge" `
  --no-first-run `
  --no-default-browser-check
```

Then start the runtime:

```powershell
npm run agent:server
```

Shortcut:

```powershell
npm run personal:browser
npm run agent:server
```

Check:

```powershell
Invoke-RestMethod http://127.0.0.1:17335/health
```

Expected:

```json
{
  "browserAttachMode": "attached-existing-cdp",
  "cdpEndpoint": "http://127.0.0.1:9222"
}
```

## Checking Which Mode Is Active

If an agent is confused about whether managed or personal mode is running, use:

```bash
agent-browser backend status
```

This calls `browser_backend_status` and `/health`, then returns normalized JSON
with a `backend` field (`"managed"` or `"personal"`), live health info, and
boundary text explaining when each mode is appropriate.

The `warning` boundary field explicitly says: do not attach to already-running
ordinary Chrome through managed CDP. The extension bridge (`npm run personal:chrome`)
is the correct path for personal mode.

## Security Note

Do not use personal mode for public demos or shared evidence. Personal mode may
expose your own cookies, headers, screenshots, page text, and account-specific
storage to the local agent runtime.
