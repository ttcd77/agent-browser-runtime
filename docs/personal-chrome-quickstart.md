# Personal Chrome Quickstart

Personal Chrome mode lets an agent inspect the Chrome tab the operator is
already using. It is for explicit local personal/ad hoc tasks, such as debugging
a page the operator can see, filling a user-authorized form, or reading a
current tab after the operator asks for that help.

It is not the default path for target research. Use Managed Browser for repeatable
security evidence, target-scoped profiles, HARs, traces, replay, and public demos.

## When To Use It

Use Personal Chrome only when the operator says one of these things:

- "use my Chrome"
- "look at my current tab"
- "this is already logged in in my browser"
- "the managed browser cannot reproduce what I see"
- "help me with this personal page"

Do not use Personal Chrome for target/bounty testing, target account state,
public examples, or unattended crawling.

## Architecture

```text
Agent / SDK / MCP host
  -> main worker facade or direct Personal Chrome bridge
  -> local HTTP bridge on http://127.0.0.1:17337
  -> WebSocket bridge on ws://127.0.0.1:17336/extension
  -> unpacked Chrome extension
  -> operator-authorized real Chrome tab
```

The bridge uses Chrome extension `chrome.debugger`. It does not require the
operator to close Chrome or relaunch Chrome with `--remote-debugging-port`.

## Install Once

1. Start the bridge:

   ```powershell
   cd <agent-browser-runtime>
   npm run personal:chrome
   ```

2. In Chrome, open `chrome://extensions`.
3. Turn on Developer mode.
4. Click "Load unpacked".
5. Select the repository `extension/` directory.
6. Check the bridge:

   ```powershell
   Invoke-RestMethod http://127.0.0.1:17337/health
   ```

Expected result: `connected` is at least `1`.

If `connected` is `0`, keep the bridge running and click the extension icon or
reload the unpacked extension. The extension retries the WebSocket connection.

## Standard Agent Entry

Preferred path for agents that already use the main worker:

```json
{
  "tool": "browser_inspect",
  "params": {
    "backend": "personal",
    "currentTab": true,
    "focus": "overview",
    "limit": 10
  }
}
```

Equivalent direct HTTP path:

```powershell
Invoke-RestMethod http://127.0.0.1:17337/tool/browser_inspect `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"focus":"overview","limit":10}'
```

Use the same facade names as Managed Browser:

- `browser_snapshot`
- `browser_text`
- `browser_screenshot`
- `browser_click`
- `browser_type`
- `browser_capture`
- `browser_inspect`
- `browser_security_pack`
- `browser_raw` for one explicit `devtools_*` drilldown

## MCP Configuration

For a dedicated Personal Chrome MCP entry, point the MCP server at the Personal
Chrome bridge:

```json
{
  "mcpServers": {
    "agent-browser-runtime-personal": {
      "command": "node",
      "args": ["<agent-browser-runtime>/dist/mcp-server/index.js"],
      "env": {
        "AGENT_BROWSER_RUNTIME_URL": "http://127.0.0.1:17337",
        "AGENT_BROWSER_MCP_TIER": "core"
      }
    }
  }
}
```

For a unified worker entry, keep `AGENT_BROWSER_RUNTIME_URL` on
`http://127.0.0.1:17335` and pass `backend: "personal"` or `currentTab: true`
for personal tasks.

## Safety Boundary

Personal Chrome can expose the operator's real page text, screenshots, cookies,
storage, requests, and account state to the local agent. The operator must
explicitly authorize the task. Do not commit Personal Chrome artifacts, private
screenshots, HARs, cookies, tokens, or account state.

Public examples should use local fixtures or `example.com`, not real accounts.
