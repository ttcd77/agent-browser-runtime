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
  return { tools };
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
