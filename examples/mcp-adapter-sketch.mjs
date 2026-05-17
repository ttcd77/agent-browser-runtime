#!/usr/bin/env node

// Minimal adapter sketch: expose Agent Browser Runtime HTTP tools through a
// tiny MCP-like callTool function. Real MCP servers can wrap the same client.

const server = process.env.AGENT_BROWSER_SERVER || "http://127.0.0.1:17335";

export async function callAgentBrowserTool(name, input = {}) {
  const response = await fetch(`${server.replace(/\/$/, "")}/tool/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${name} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

export const tools = [
  {
    name: "browser_security_research_pack",
    description: "Run an objective F12 security research evidence workflow.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        profile: { type: "string" },
        includeTokenScan: { type: "boolean" },
      },
      required: ["url"],
    },
    async execute(input) {
      if (input.profile) {
        await callAgentBrowserTool("profile_create", { profile: input.profile });
      }
      return await callAgentBrowserTool("devtools_security_research_pack", {
        profile: input.profile || "researcher",
        url: input.url,
        includeTokenScan: Boolean(input.includeTokenScan),
      });
    },
  },
  {
    name: "browser_agent_inspect",
    description: "Route to the first useful F12 evidence area for an agent.",
    inputSchema: {
      type: "object",
      properties: {
        profile: { type: "string" },
        focus: { type: "string" },
        query: { type: "string" },
        requestId: { type: "string" },
      },
    },
    async execute(input) {
      return await callAgentBrowserTool("agent_inspect", input);
    },
  },
];

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  const url = process.argv[2] || "https://example.com";
  const result = await tools[0].execute({ url, profile: "researcher" });
  console.log(JSON.stringify({
    backend: result.backend,
    summary: result.summary,
    nextTools: result.nextTools,
  }, null, 2));
}
