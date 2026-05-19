# Next Implementation: MCP Server for Agent Browser Runtime

**Date**: 2026-05-19
**Author**: Hermes Agent (AppSec review)
**Scope**: Full source scan (src/, scripts/, docs/, examples/, package.json)

---

## Highest-Impact Task

**Implement a proper MCP (Model Context Protocol) server** that exposes the full
tool surface so any MCP-compatible agent can discover and invoke browser tools
natively — no curl, no OpenClaw adapter, no ad-hoc SDK.

---

## Why This Over Other Candidates

| Candidate | Why not #1 |
|-----------|-----------|
| Unit test coverage | Important, but 2 test files already exist + 14 smoke scripts. A consumer cannot use the runtime with any agent without integration code. |
| Docs/README polish | Purely cosmetic. Does not change what an agent can *do*. |
| More smoke tests | Adds safety but no new capability. The project already has product, server, live-browser, F12, professional, CLI, example, and demo fixture smokes. |
| Personal Chrome parity | Already runs. Managed vs Personal contract check passes. Improvements here are incremental. |
| Prof scorecard missing panels | Already at "professional-core-ready" verdict. Remaining gaps (sources breakpoints, layout paint flamecharts) are deep browser-protocol work with diminishing returns. |

MCP is called out in:
- **Roadmap v0.3**: "Add a small SDK client helper"
- **Open-source checklist**: "Turn the minimal MCP adapter sketch into a full MCP server package"
- It directly *unlocks* the entire project for any MCP agent (Claude Desktop, Copilot, Cursor, Windsurf)

---

## What Exists Today

The `examples/mcp-adapter-sketch.mjs` wraps exactly **2 of the 9 facade tools**
(`browser_security_pack`, `browser_inspect`) with no `tools/list` endpoint, no
tool schema discovery, and no MCP transport compliance (stdio or SSE). It is
explicitly labeled a sketch.

The actual HTTP server (`scripts/agent-cdp-server.mjs`, 14k LOC) has:
- `GET /tools` — returns full tool list with descriptions
- `POST /tool/{name}` — routes to the right executor
- Zod schemas in `src/plugins/cdp-traffic-capture/schemas.ts` — 120+ schemas
  ready to convert to JSON Schema for MCP `inputSchema`

The server has ~218 `devtools_*` tools + the `browser_*` facade + backend tools.
Every one is available through the HTTP endpoint. MCP is just a transport adapter.

---

## Implementation Sketch

### Files to Create

| File | Purpose |
|------|---------|
| `src/mcp-server/index.ts` | MCP server entry — stdio + optional SSE transport. Implements `tools/list`, `tools/call`. |
| `src/mcp-server/tool-catalog.ts` | Convert agent-cdp-server tool catalog + Zod schemas into MCP `Tool` definitions (`name`, `description`, `inputSchema`). |
| `src/mcp-server/tool-executor.ts` | HTTP client to `POST /tool/{name}` on the existing server. Reuses the same `fetch` pattern from `examples/mcp-adapter-sketch.mjs`. |

### Files to Modify

| File | Change |
|------|--------|
| `package.json` | Add `@modelcontextprotocol/sdk` dependency (or implement raw stdio transport without it — only ~50 LOC needed). Add script: `"mcp:server": "node dist/mcp-server/index.js"` and `"mcp:dev": "tsx src/mcp-server/index.ts"`. |

### Core Logic

```typescript
// src/mcp-server/index.ts — stdio transport (no SDK dependency)
import { getToolCatalog, type McpTool } from "./tool-catalog.js";
import { executeTool } from "./tool-executor.js";

const tools: McpTool[] = await getToolCatalog();

// MCP over stdio — line-delimited JSON-RPC 2.0
process.stdin.on("data", async (chunk) => {
  const req = JSON.parse(chunk.toString());
  if (req.method === "tools/list") {
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      id: req.id,
      result: { tools },
    }));
  } else if (req.method === "tools/call") {
    const { name, arguments: args } = req.params;
    const result = await executeTool(name, args);
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      id: req.id,
      result: { content: [{ type: "text", text: result }] },
    }));
  }
});
```

The server-side `tool-catalog.ts` fetches `GET /tools` from the agent server and
converts each entry's Zod schema (already defined in `src/plugins/cdp-traffic-capture/schemas.ts`)
to MCP `inputSchema` format. Many schemas are already `z.object({...})` — perfect
for `.describe()` extraction.

### Optional Enhancement: SSE Transport

For environments that prefer HTTP over stdio (VS Code extensions, web dashboards),
a second entry at `src/mcp-server/sse-transport.ts` can serve SSE on a port.
This is optional — stdio covers Claude Desktop, CLI agents, and most MCP hosts.

---

## Acceptance Criteria

1. **`npm run mcp:dev`** starts the MCP server on stdio and does not crash.
2. **`tools/list`** returns all facade tools + at least the 50 most common
   `devtools_*` tools with descriptions and `inputSchema` populated.
3. **`tools/call`** with `browser_open`, `browser_inspect`, `devtools_tool_catalog`
   works and returns valid results.
4. Connecting the server as an MCP client (e.g. via `claude_desktop_config.json`
   or `mcp-cli`) works:

   ```json
   {
     "mcpServers": {
       "agent-browser-runtime": {
         "command": "node",
         "args": ["path/to/dist/mcp-server/index.js"],
         "env": { "AGENT_BROWSER_SERVER": "http://127.0.0.1:17335" }
       }
     }
   }
   ```

5. **`npm run test`** and **`npm run check`** still pass. `npm run contract:devtools`
   still reports zero drift.

---

## Tests to Run

```bash
# After implementation
npm run build
npm run test
npm run check

# Smoke: start agent server, start MCP server, call tools/list and tools/call
node scripts/agent-cdp-server.mjs &      # or existing running instance
node dist/mcp-server/index.js &

# Verify with a simple MCP client
# tools/list should produce JSON with tool count >= 50
# tools/call(browser_open, {url:"https://example.com"}) should succeed
```

A dedicated `scripts/mcp-server-smoke.mjs` would be ideal but not required for
the first pass.

---

## Risks

| Risk | Mitigation |
|------|-----------|
| **Transport coupling** — if MCP SDK changes protocol format, the raw stdio transport breaks. | Implement JSON-RPC 2.0 manually (~50 LOC). The MCP spec is stable and the message format is trivial. No SDK dependency needed. |
| **Schema mismatch** — Zod schemas have `z.enum()` / `z.union()` features that don't map 1:1 to JSON Schema. | The existing `schemas.ts` already exports JSON Schema via `zod-to-json-schema`. Use that library (already in `package.json` deps!). |
| **Server dependency** — MCP server is a thin client; if the agent server changes its tool contract, MCP must update. | MCP server calls `GET /tools` at startup. No hardcoded tool list to maintain. Any HTTP tool contract change propagates automatically. |
| **Performance** — MCP over stdio forwards every tool call through the agent server HTTP endpoint. | Acceptable. The agent server is localhost. Each call adds ~1ms HTTP latency on top of CDP round-trips that already take 50-500ms. No caching needed. |

---

## Why This Is The Highest-Impact Task

Before MCP:
- An agent must use an OpenClaw adapter (framework-specific), raw curl, or a
  custom SDK — none of which ship with this project.
- Every integration requires reading `browser-worker-integration.md` and writing
  HTTP client code.
- No discovery — the agent doesn't know which tools exist unless the prompt
  hardcodes the list.

After MCP:
- Any MCP-compatible agent (Claude, Codex, Copilot, Cursor, etc.) discovers all
  tools automatically via `tools/list`.
- Invocation is native `tools/call(name, args)` — no HTTP constructs in agent
  reasoning.
- Configuration is one JSON block in the MCP host config.
- The existing agent server, tool logic, evidence workflow, and smoke tests
  remain completely unchanged — MCP is purely additive.

This turns a "you'll need to write integration code" project into a
"install + configure + go" project for every MCP agent on the planet.
