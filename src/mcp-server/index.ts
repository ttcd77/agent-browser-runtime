#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { BrowserWorkerClient, DOCTOR_TOOL, toolResultText } from "./http-client.js";

const client = new BrowserWorkerClient();

const CORE_TOOL_NAMES = [
  DOCTOR_TOOL.name,
  "browser_backend_status",
  "profile_list",
  "profile_resume",
  "browser_tabs",
  "browser_open",
  "browser_navigate",
  "browser_snapshot",
  "browser_text",
  "browser_find",
  "browser_click",
  "browser_type",
  "browser_scroll",
  "browser_screenshot",
  "browser_capture",
  "browser_inspect",
  "browser_security_pack",
  "browser_feedback",
  "browser_raw",
] as const;

const EXTENDED_EXTRA_TOOL_NAMES = [
  "browser_act",
  "browser_auth_boundary",
  "browser_diff",
  "browser_replay",
  "browser_resume_profile",
  "browser_auth_bootstrap",
  "browser_evidence_bundle",
  "browser_evidence_manifest",
  "browser_evidence_timeline",
  "browser_request_correlation_graph",
  "browser_capture_diff",
  "browser_capture_bisect",
  "browser_worker_frame_deep_dive",
  "browser_storage_snapshot",
  "browser_cookie_summary",
  "browser_application_export",
  "browser_console_log",
  "browser_issues_log",
  "browser_network_timeline",
  "browser_page_diagnostics",
] as const;

const CORE_TOOL_SET = new Set<string>(CORE_TOOL_NAMES);
const EXTENDED_TOOL_SET = new Set<string>([...CORE_TOOL_NAMES, ...EXTENDED_EXTRA_TOOL_NAMES]);

const server = new Server(
  {
    name: "agent-browser-runtime",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {
        listChanged: false,
      },
    },
    instructions: [
      "Agent Browser Runtime exposes browser_* facade tools and devtools_* F12 evidence tools.",
      "Use browser_worker_doctor first when the worker may not be running.",
      "Prefer browser_open -> browser_capture -> browser_inspect -> browser_security_pack.",
      "Collect objective browser evidence only; do not classify vulnerabilities inside the tool.",
    ].join("\n"),
  },
);

server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => {
  const tools: Tool[] = [DOCTOR_TOOL];
  try {
    const workerTools = await client.tools();
    const seen = new Set(tools.map((tool) => tool.name));
    for (const tool of workerTools) {
      if (!seen.has(tool.name)) tools.push(tool);
    }
  } catch {
    // Keep the MCP server useful even when the worker is not started yet.
  }
  return { tools: filterToolsForMcpTier(tools) };
});

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  const name = request.params.name;
  const args = isRecord(request.params.arguments) ? request.params.arguments : {};

  if (name === DOCTOR_TOOL.name) {
    return {
      content: [
        {
          type: "text",
          text: toolResultText(await client.doctor()),
        },
      ],
    };
  }

  try {
    const result = await client.callTool(name, args);
    // If the worker returned MCP-shaped content (text + image, etc.) under `_mcp.content`,
    // pass it through so the agent receives images and other non-text resources directly.
    if (
      isRecord(result) &&
      isRecord(result._mcp) &&
      Array.isArray((result._mcp as Record<string, unknown>).content)
    ) {
      const content = (result._mcp as Record<string, unknown>).content as Array<Record<string, unknown>>;
      // Defensive: replace the bundled text payload with a clean copy of the worker result
      // minus the bulky `_mcp` echo, so the text element stays readable.
      const cleaned: Record<string, unknown> = { ...result };
      delete cleaned._mcp;
      const passthrough = content.map((entry) => {
        if (entry && entry.type === "text") {
          return { ...entry, text: toolResultText(cleaned) };
        }
        return entry;
      });
      return { content: passthrough as CallToolResult["content"] };
    }
    return {
      content: [
        {
          type: "text",
          text: toolResultText(result),
        },
      ],
    };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: toolResultText({
            error: String((error as Error)?.message || error),
            toolName: name,
            baseUrl: client.baseUrl,
            nextTool: "browser_worker_doctor",
          }),
        },
      ],
    };
  }
});

await server.connect(new StdioServerTransport());

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function filterToolsForMcpTier(tools: Tool[]): Tool[] {
  const custom = parseCustomToolSet(process.env.AGENT_BROWSER_MCP_TOOLS);
  if (custom) return filterToolsBySet(tools, custom);

  const tier = String(process.env.AGENT_BROWSER_MCP_TIER || "core").trim().toLowerCase();
  if (tier === "all" || tier === "*") return tools;
  if (tier === "extended") return filterToolsBySet(tools, EXTENDED_TOOL_SET);
  return filterToolsBySet(tools, CORE_TOOL_SET);
}

function parseCustomToolSet(value: string | undefined): Set<string> | null {
  if (!value || value.trim() === "") return null;
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) return null;
  return new Set([DOCTOR_TOOL.name, ...names]);
}

function filterToolsBySet(tools: Tool[], allowed: Set<string>): Tool[] {
  const selected = tools.filter((tool) => allowed.has(tool.name));
  if (!selected.some((tool) => tool.name === DOCTOR_TOOL.name)) {
    return [DOCTOR_TOOL, ...selected];
  }
  return selected;
}
