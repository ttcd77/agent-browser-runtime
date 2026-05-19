#!/usr/bin/env node

import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

async function waitForHealth(baseUrl) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return await response.json();
    } catch {
      // keep waiting
    }
    await sleep(300);
  }
  throw new Error(`agent server did not become healthy: ${baseUrl}/health`);
}

function waitForExit(child, timeoutMs = 10000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function startFixtureServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/mcp-smoke") {
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: true, source: "mcp-smoke" }));
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
<title>MCP Smoke</title>
<button id="load" onclick="fetch('/api/mcp-smoke')">Load</button>
<script>fetch('/api/mcp-smoke').then(r => r.json()).then(v => console.log(v.source));</script>`);
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function textContent(result) {
  return result.content?.find((entry) => entry.type === "text")?.text || "";
}

const serverPort = await freePort();
const browserPort = await freePort();
const baseUrl = `http://127.0.0.1:${serverPort}`;
const fixtureServer = await startFixtureServer();
const fixturePort = fixtureServer.address().port;
const child = spawn(process.execPath, ["scripts/agent-cdp-server.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    CDP_LAUNCH_BROWSER: "1",
    CDP_BROWSER_HEADLESS: "1",
    CDP_AGENT_SERVER_PORT: String(serverPort),
    CDP_BROWSER_PORT: String(browserPort),
    CDP_AGENT_PROFILE: "mcp-smoke",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

let client = null;
try {
  await waitForHealth(baseUrl);

  client = new Client({
    name: "agent-browser-runtime-mcp-smoke",
    version: "0.1.0",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/mcp-server/index.js"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_BROWSER_RUNTIME_URL: baseUrl,
    },
    stderr: "pipe",
  });
  await client.connect(transport);

  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name);
  assert(toolNames.includes("browser_worker_doctor"), "MCP tools/list missing browser_worker_doctor");
  assert(toolNames.includes("browser_open"), "MCP tools/list missing browser_open");
  assert(toolNames.includes("browser_inspect"), "MCP tools/list missing browser_inspect");
  assert(toolNames.includes("browser_security_pack"), "MCP tools/list missing browser_security_pack");
  assert(toolNames.length >= 50, `MCP tools/list returned too few tools: ${toolNames.length}`);

  const doctor = await client.callTool({ name: "browser_worker_doctor", arguments: {} });
  const doctorText = textContent(doctor);
  assert(doctorText.includes("\"ok\": true"), `doctor did not report ok=true: ${doctorText}`);
  assert(doctorText.includes("\"browser_open\""), `doctor did not report facade tools: ${doctorText}`);

  const opened = await client.callTool({
    name: "browser_open",
    arguments: {
      profile: "mcp-smoke",
      url: `http://127.0.0.1:${fixturePort}/`,
      waitMs: 700,
    },
  });
  const openedText = textContent(opened);
  assert(openedText.includes("MCP Smoke"), `browser_open did not return page title: ${openedText}`);

  const inspect = await client.callTool({
    name: "browser_inspect",
    arguments: {
      profile: "mcp-smoke",
      focus: "overview",
      limit: 5,
    },
  });
  const inspectText = textContent(inspect);
  assert(inspectText.includes("routeSummary") || inspectText.includes("nextTools"), `browser_inspect returned unexpected content: ${inspectText.slice(0, 500)}`);

  console.log("MCP server smoke passed:");
  console.log(`- worker: ${baseUrl}`);
  console.log(`- tools listed: ${toolNames.length}`);
  console.log("- calls: browser_worker_doctor, browser_open, browser_inspect");
} finally {
  if (client) await client.close().catch(() => {});
  await fetch(`${baseUrl}/shutdown`, { method: "POST" }).catch(() => {});
  const exited = await waitForExit(child, 10000);
  if (!exited) child.kill();
  fixtureServer.close();
  if (child.exitCode && child.exitCode !== 0) {
    console.error(stdout);
    console.error(stderr);
    process.exit(child.exitCode);
  }
}
