#!/usr/bin/env node
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, "agent-browser-cli.mjs");
const calls = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, baseUrl: "agentic-burp-fixture" }));
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/tool/")) {
      const tool = decodeURIComponent(url.pathname.slice("/tool/".length));
      const raw = await readBody(req);
      const payload = raw ? JSON.parse(raw) : {};
      calls.push({ tool, payload });
      const rawToolName = payload.tool || payload.toolName;
      const rawParams = payload.input || payload.params || {};

      res.writeHead(200, { "content-type": "application/json" });
      if (tool === "browser_capture") {
        res.end(JSON.stringify({
          ok: true,
          schema: "agent-browser.capture.fixture",
          profile: payload.profile || "researcher",
          action: payload.action,
          captureEnabled: payload.action === "start",
        }));
        return;
      }
      if (tool === "browser_raw" && rawToolName === "profile_traffic_query") {
        res.end(JSON.stringify({
          profile: rawParams.profile || "researcher",
          returned: 1,
          total: 1,
          hasMore: false,
          requests: [{
            requestId: "req-graphql-1",
            method: "POST",
            status: 200,
            resourceType: "fetch",
            url: "https://target.example/graphql",
            hasRequestBody: true,
            hasResponseBody: true,
            f12Columns: {
              name: "graphql",
              method: "POST",
              status: 200,
              type: "fetch",
              initiator: "script",
              time: "31 ms",
            },
          }],
        }));
        return;
      }
      if (tool === "browser_raw" && rawToolName === "profile_request_payload") {
        res.end(JSON.stringify({
          profile: rawParams.profile || "researcher",
          requestId: rawParams.requestId,
          postData: JSON.stringify({
            operationName: "UpdateRole",
            query: "mutation UpdateRole($role: String!) { updateRole(role: $role) { id role } }",
            variables: { role: "user" },
          }),
        }));
        return;
      }
      if (tool === "browser_raw" && rawToolName === "profile_request_detail") {
        res.end(JSON.stringify({
          profile: rawParams.profile || "researcher",
          requestId: rawParams.requestId,
          method: "POST",
          url: "https://target.example/graphql",
          status: 200,
          headers: { "content-type": "application/json" },
        }));
        return;
      }
      if (tool === "cdp_fetch_intercept" && payload.action === "list") {
        res.end(JSON.stringify([{
          requestId: "fetch-paused-1",
          capturedRequestId: "fetch-paused-1",
          cdpRequestId: "cdp-request-1",
          method: "POST",
          url: "https://target.example/graphql",
          headers: { "content-type": "application/json" },
          hasBody: true,
          timerRemainingMs: 25000,
        }]));
        return;
      }
      if (tool === "browser_evidence_bundle") {
        res.end(JSON.stringify({
          schema: "agent-browser.evidence.bundle.v1",
          ok: true,
          profile: payload.profile || "researcher",
          summary: {
            url: "https://target.example/app",
            requestCount: 1,
            screenshotPath: "C:\\tmp\\agentic-burp-shot.png",
            unavailableCount: 0,
          },
          bundlePath: "C:\\tmp\\agentic-burp-evidence.json",
          nextCommands: ["agent-browser artifact inspect \"C:\\tmp\\agentic-burp-evidence.json\""],
          boundary: "Evidence bundle collects objective browser state.",
        }));
        return;
      }
      res.end(JSON.stringify({ ok: true, tool, payload }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address();
const baseArgs = ["--server", `http://127.0.0.1:${port}`];

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args, ...baseArgs], {
      cwd: join(__dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`CLI failed ${code}: ${stderr}`));
      else resolve(JSON.parse(stdout));
    });
  });
}

try {
  const profile = "researcher";
  const capture = await runCli(["capture", "start", "--profile", profile, "--label", "agentic-burp-smoke"]);
  assert(capture.captureEnabled === true, "capture did not start");

  const graphql = await runCli(["graphql", "requests", "--profile", profile, "--url-contains", "graphql", "--inspect-all"]);
  assert(graphql.schema === "agent-browser.graphql.requests.v1", "graphql requests returned wrong schema");
  assert(graphql.count === 1, "graphql requests did not inspect the fixture request");
  assert(graphql.operations[0].graphql[0].operationName === "UpdateRole", "graphql operation was not parsed");
  assert(graphql.coverage.payloadInspection.truncated === false, "graphql inspection should not be truncated");

  const plan = await runCli(["graphql", "intercept-plan", "req-graphql-1", "--profile", profile, "--variables-json", "{\"role\":\"admin\"}"]);
  assert(plan.schema === "agent-browser.graphql.intercept-plan.v1", "intercept plan returned wrong schema");
  assert(plan.mode === "cdp-fetch-in-flight", "intercept plan did not choose in-flight mode");
  assert(plan.idBoundary.doNotMix === true, "intercept plan did not expose ID boundary");
  assert(plan.workflow.some((step) => step.command.includes("intercept continue") && step.command.includes("admin")), "intercept plan missing patched continue step");

  const intercept = await runCli(["intercept", "diagnose", "fetch-paused-1", "--profile", profile]);
  assert(intercept.schema === "agent-browser.intercept.diagnose.v1", "intercept diagnose returned wrong schema");
  assert(intercept.state === "ready-to-continue", "intercept diagnose did not see paused request");
  assert(intercept.nextCommands.some((entry) => entry.includes("intercept continue fetch-paused-1")), "intercept diagnose missing continue command");

  const bundle = await runCli(["evidence", "bundle", "--profile", profile, "--include-har"]);
  assert(bundle.schema === "agent-browser.evidence.bundle.v1", "evidence bundle returned wrong schema");
  assert(bundle.bundlePath, "evidence bundle did not expose bundle path");
  assert(bundle.summary.screenshotPath, "evidence bundle did not expose screenshot path");

  assert(calls.some((entry) => entry.tool === "browser_capture" && entry.payload.action === "start"), "workflow did not call capture start");
  assert(calls.some((entry) => entry.tool === "browser_raw" && entry.payload.toolName === "profile_traffic_query"), "workflow did not query network log");
  assert(calls.some((entry) => entry.tool === "browser_raw" && entry.payload.toolName === "profile_request_payload"), "workflow did not read request payload");
  assert(calls.some((entry) => entry.tool === "cdp_fetch_intercept" && entry.payload.action === "list"), "workflow did not diagnose intercept state");
  assert(calls.some((entry) => entry.tool === "browser_evidence_bundle"), "workflow did not package evidence");

  console.log("Agentic Burp workflow smoke passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
