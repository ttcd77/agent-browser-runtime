# Personal Browser Mode

Personal Browser Mode means the runtime attaches to a browser window you are
using yourself.

This is different from the default managed mode:

- managed mode: the runtime starts a dedicated browser profile for agents;
- personal mode: you start a visible browser with remote debugging, then the runtime attaches to it.

## Why It Exists

Sometimes the human sees a strange browser state first: a broken login, a UI that
only appears with their cookies, an unexpected network request, or a page that
does not behave like the agent's clean test profile.

In that case the user can open a personal debugging browser and ask an agent to
inspect the same window.

## Important Limit

A normal already-running browser usually cannot be taken over after the fact.
The browser must expose a CDP endpoint from startup.

## Windows Edge Example

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

## Security Note

Do not use personal mode for public demos or shared evidence. Personal mode may
expose your own cookies, headers, screenshots, page text, and account-specific
storage to the local agent runtime.
