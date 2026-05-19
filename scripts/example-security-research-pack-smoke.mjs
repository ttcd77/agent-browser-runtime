#!/usr/bin/env node

import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { platform } from "node:process";
import { buildOperatorDemoReport } from "./security-research-demo-report.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wait for a child process to exit, with a hard timeout fallback.
function waitForChildExit(child, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.killed) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// Remove a directory with limited retries to handle Windows EBUSY / EPERM
// caused by browser processes that haven't released file handles yet.
// If all retries are exhausted the failure is warned but not thrown, because
// a cleanup race must not mask a passing test result.
async function removePathWithRetry(dirPath, { maxRetries = 8, baseDelayMs = 250 } = {}) {
  const isWindows = platform === "win32";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      rmSync(dirPath, { recursive: true, force: true });
      return;
    } catch (err) {
      const retryable = err.code === "EBUSY" || err.code === "EPERM" || err.code === "ENOTEMPTY";
      if (retryable && attempt < maxRetries) {
        // Exponential backoff; Windows needs more time for handle release.
        const delay = baseDelayMs * (attempt + 1) * (isWindows ? 2 : 1);
        await sleep(delay);
        continue;
      }
      // Final attempt failed — warn so it is visible but do not rethrow.
      console.warn(
        `[cleanup] Warning: could not fully remove ${dirPath} after ${attempt + 1} attempt(s): ` +
          `${err.code || err.message}. Temp files may remain. This does not affect test results.`,
      );
      return;
    }
  }
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
  assert(output.afterReadiness?.routeSummary?.firstF12RequestDetail?.tool === "devtools_request_detail", `example missing routeSummary F12 request detail: ${JSON.stringify(output.afterReadiness?.routeSummary)}`);
  assert(output.afterReadiness?.routeSummary?.firstConcreteDrilldown?.tool === "devtools_request_detail", `example missing routeSummary concrete drilldown: ${JSON.stringify(output.afterReadiness?.routeSummary)}`);
  assert(output.afterReadiness?.routeArtifacts?.f12Navigation?.inspect?.tool === "devtools_artifact_inspect", `example missing compact F12 navigation route artifact: ${JSON.stringify(output.afterReadiness?.routeArtifacts)}`);
  assert(output.afterReadiness?.routeArtifacts?.harCompleteness?.read?.tool === "devtools_artifact_read", `example missing compact HAR completeness route artifact: ${JSON.stringify(output.afterReadiness?.routeArtifacts)}`);
  assert(output.afterReadiness?.routeArtifacts?.correlationGraph?.inspect?.tool === "devtools_artifact_inspect", `example missing compact correlation graph route artifact: ${JSON.stringify(output.afterReadiness?.routeArtifacts)}`);
  assert(output.afterReadiness?.routeArtifacts?.authBoundary?.read?.tool === "devtools_artifact_read", `example missing compact auth boundary route artifact: ${JSON.stringify(output.afterReadiness?.routeArtifacts)}`);
  assert(output.afterReadiness?.routeArtifacts?.workerFrameBoundary?.inspect?.tool === "devtools_artifact_inspect", `example missing compact worker/frame route artifact: ${JSON.stringify(output.afterReadiness?.routeArtifacts)}`);
  assert(output.afterReadiness?.f12NavigationRequestCount >= 1, `example missing readiness F12 navigation count: ${JSON.stringify(output.afterReadiness)}`);
  assert(output.f12Navigation?.requestNodeCount >= 1, `example missing pack F12 navigation: ${JSON.stringify(output.f12Navigation)}`);
  assert(output.f12Navigation?.firstDetailRoute?.tool === "devtools_request_detail", `example missing pack F12 detail route: ${JSON.stringify(output.f12Navigation)}`);
  assert(output.firstF12RequestDetail?.sectionAvailability?.headers === true, `example missing first F12 request detail summary: ${JSON.stringify(output.firstF12RequestDetail)}`);
  assert(output.firstF12RequestDetail?.headerSummary?.requestHeaderCount >= 1, `example missing first F12 request header summary: ${JSON.stringify(output.firstF12RequestDetail)}`);
  assert(output.handoff?.ready === true, `handoff not ready: ${JSON.stringify(output.handoff)}`);
  assert(output.artifactCoverage?.ready === true, `artifact coverage not ready: ${JSON.stringify(output.artifactCoverage)}`);
  assert(output.artifactPaths?.researchPackPath, "example missing research pack path");
  assert(output.artifactPaths?.drilldownPlanPath, "example missing drilldown plan path");
  assert(Array.isArray(output.firstDrilldowns) && output.firstDrilldowns.length >= 1, "example missing drilldown routes");
  assert(output.objectiveBoundary?.includes("does not judge vulnerabilities"), "example crossed objective boundary");
  // operatorHandoff assertions
  assert(output.operatorHandoff, "missing operatorHandoff");
  assert(output.operatorHandoff.firstRead, "operatorHandoff missing firstRead");
  assert(
    Array.isArray(output.operatorHandoff.routeArtifacts) && output.operatorHandoff.routeArtifacts.length >= 1,
    `operatorHandoff missing routeArtifacts: ${JSON.stringify(output.operatorHandoff?.routeArtifacts)}`,
  );
  assert(
    output.operatorHandoff.firstRequest?.tool === "devtools_request_detail",
    `operatorHandoff firstRequest must be devtools_request_detail: ${JSON.stringify(output.operatorHandoff?.firstRequest)}`,
  );
  assert(
    Array.isArray(output.operatorHandoff.drilldowns) && output.operatorHandoff.drilldowns.length >= 1,
    `operatorHandoff missing drilldowns: ${JSON.stringify(output.operatorHandoff?.drilldowns)}`,
  );
  assert(
    output.operatorHandoff.objectiveBoundary?.toLowerCase().includes("collect browser evidence") ||
      output.operatorHandoff.objectiveBoundary?.toLowerCase().includes("does not classify"),
    `operatorHandoff crossed objective boundary: ${output.operatorHandoff?.objectiveBoundary}`,
  );
  // ── Demo report generation and assertions ──────────────────────────────────
  const demoReportPath = join(tempDir, "operator-demo-report.md");
  const demoReportMd = buildOperatorDemoReport(output);
  writeFileSync(demoReportPath, demoReportMd, "utf8");

  assert(demoReportMd.length > 0, "demo report is empty");
  assert(
    demoReportMd.includes("## Operator Handoff"),
    "demo report missing Operator Handoff section",
  );
  assert(
    demoReportMd.includes("## Objective Boundary"),
    "demo report missing Objective Boundary section",
  );
  assert(
    demoReportMd.includes(output.artifactPaths.researchPackPath),
    "demo report missing at least one artifact path",
  );
  assert(
    demoReportMd.includes("devtools_artifact_read"),
    "demo report missing devtools_artifact_read tool reference",
  );
  // Confirm forbidden content is absent
  assert(
    !demoReportMd.toLowerCase().includes("vulnerability found"),
    "demo report contains forbidden text 'vulnerability found'",
  );
  assert(
    !demoReportMd.toLowerCase().includes("high risk"),
    "demo report contains forbidden text 'high risk'",
  );
  assert(
    !demoReportMd.toLowerCase().includes("exploitable"),
    "demo report contains forbidden text 'exploitable'",
  );

  console.log("Security research pack example smoke passed:");
  console.log(`- fixture: ${fixture.url}`);
  console.log(`- requests: ${output.summary.requestCount}`);
  console.log(`- research pack: ${output.artifactPaths.researchPackPath}`);
  console.log(`- drilldowns: ${output.firstDrilldowns.length}`);
  console.log(`- route artifacts: ${Object.keys(output.afterReadiness.routeArtifacts || {}).length}`);
  console.log(`- operatorHandoff.routeArtifacts: ${output.operatorHandoff.routeArtifacts.length}`);
  console.log(`- operatorHandoff.firstRequest.tool: ${output.operatorHandoff.firstRequest?.tool}`);
  console.log(`- operatorHandoff.drilldowns: ${output.operatorHandoff.drilldowns.length}`);
  console.log(`- demo report: ${demoReportPath} (${demoReportMd.length} chars)`);
} finally {
  // 1. Ask the agent server to shut down gracefully.
  await fetch(`http://127.0.0.1:${serverPort}/shutdown`, { method: "POST" }).catch(() => {});
  // 2. Give the server a moment to begin closing before we kill the child.
  await sleep(300);
  // 3. Kill the browser / runtime child process.
  runtime.kill();
  // 4. Close the fixture HTTP server.
  fixture.server.close();
  // 5. Wait for the child process to actually exit so the OS can release its
  //    file handles before we try to delete the temp directory.
  await waitForChildExit(runtime, 5000);
  // 6. Extra grace period on Windows where handle release is asynchronous.
  await sleep(platform === "win32" ? 400 : 100);
  // 7. Remove temp dir with retry; EBUSY on Windows is handled inside.
  await removePathWithRetry(tempDir);
}
