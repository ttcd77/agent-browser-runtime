#!/usr/bin/env node

import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

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

async function waitForHealth(port) {
  const url = `http://127.0.0.1:${port}/health`;
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // keep waiting
    }
    await sleep(250);
  }
  throw new Error(`managed server did not become healthy: ${url}`);
}

function startFixture() {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/data") {
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "fixture_session=demo; Path=/; SameSite=Lax",
      });
      res.end(JSON.stringify({ ok: true, marker: "example-security-research-pack-smoke" }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
      <html>
        <head><title>Example Security Pack Smoke</title></head>
        <body>
          <h1>Example Security Pack Smoke</h1>
          <script>
            localStorage.setItem("example_pack_marker", "ready");
            fetch("/api/data").catch(() => {});
          </script>
        </body>
      </html>`);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/`,
      });
    });
  });
}

function runNode(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...options.env },
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
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

const serverPort = await freePort();
const browserPort = await freePort();
const tempDir = mkdtempSync(join(tmpdir(), "agent-example-security-pack-smoke-"));
const fixture = await startFixture();
const runtime = spawn(process.execPath, ["scripts/agent-cdp-server.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    CDP_LAUNCH_BROWSER: "1",
    CDP_AGENT_SERVER_PORT: String(serverPort),
    CDP_BROWSER_PORT: String(browserPort),
    CDP_BROWSER_HEADLESS: "1",
    CDP_SECURITY_DATA_DIR: join(tempDir, "runtime"),
    CDP_BROWSER_USER_DATA_DIR: join(tempDir, "browser"),
  },
  stdio: "ignore",
});

try {
  await waitForHealth(serverPort);
  const result = await runNode(["examples/security-research-pack.mjs", fixture.url], {
    env: {
      AGENT_BROWSER_SERVER: `http://127.0.0.1:${serverPort}`,
      AGENT_BROWSER_PROFILE: "example-smoke",
    },
  });
  assert(result.code === 0, `example failed: ${result.stderr || result.stdout}`);
  const output = JSON.parse(result.stdout);
  assert(output.backend === "managed-cdp", `example wrong backend: ${JSON.stringify(output)}`);
  assert(output.summary?.requestCount >= 1, `example missing requests: ${JSON.stringify(output.summary)}`);
  assert(output.beforeReadiness?.objectiveBoundary?.includes("does not judge vulnerabilities"), "before readiness crossed objective boundary");
  assert(output.afterReadiness?.ready === true, `after readiness not ready: ${JSON.stringify(output.afterReadiness)}`);
  assert(output.afterReadiness?.evidenceReady === true, `after readiness missing evidence: ${JSON.stringify(output.afterReadiness)}`);
  assert(output.afterReadiness?.routeSummary?.latestHandoffInspect?.tool === "devtools_artifact_inspect", `example missing routeSummary handoff inspect: ${JSON.stringify(output.afterReadiness?.routeSummary)}`);
  assert(output.afterReadiness?.routeSummary?.latestHandoffRead?.tool === "devtools_artifact_read", `example missing routeSummary handoff read: ${JSON.stringify(output.afterReadiness?.routeSummary)}`);
  assert(output.afterReadiness?.routeSummary?.firstConcreteDrilldown?.tool === "devtools_request_detail", `example missing routeSummary concrete drilldown: ${JSON.stringify(output.afterReadiness?.routeSummary)}`);
  assert(output.handoff?.ready === true, `handoff not ready: ${JSON.stringify(output.handoff)}`);
  assert(output.artifactCoverage?.ready === true, `artifact coverage not ready: ${JSON.stringify(output.artifactCoverage)}`);
  assert(output.artifactPaths?.researchPackPath, "example missing research pack path");
  assert(output.artifactPaths?.drilldownPlanPath, "example missing drilldown plan path");
  assert(Array.isArray(output.firstDrilldowns) && output.firstDrilldowns.length >= 1, "example missing drilldown routes");
  assert(output.objectiveBoundary?.includes("does not judge vulnerabilities"), "example crossed objective boundary");
  console.log("Security research pack example smoke passed:");
  console.log(`- fixture: ${fixture.url}`);
  console.log(`- requests: ${output.summary.requestCount}`);
  console.log(`- research pack: ${output.artifactPaths.researchPackPath}`);
  console.log(`- drilldowns: ${output.firstDrilldowns.length}`);
} finally {
  await fetch(`http://127.0.0.1:${serverPort}/shutdown`, { method: "POST" }).catch(() => {});
  setTimeout(() => runtime.kill(), 500);
  fixture.server.close();
  setTimeout(() => rmSync(tempDir, { recursive: true, force: true }), 1000);
}
