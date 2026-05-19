#!/usr/bin/env node

/**
 * F12 Professional Demo Fixture Smoke
 *
 * Starts a local HTTP fixture that triggers representative F12 evidence signals,
 * runs devtools_security_research_pack, and generates an Operator Demo Report.
 * No real targets are accessed.
 *
 * Evidence surfaces covered:
 *   Network  - normal JSON fetch, 500 error response, 3-hop redirect chain
 *   Console  - console.log, console.warn, console.error
 *   DOM      - shadow DOM component with marker
 *   Frame    - iframe (/iframe.html)
 *   Storage  - localStorage, sessionStorage, cookies (main page + API)
 *   Worker   - Web Worker (/worker.js)
 */

import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { platform } from "node:process";
import { buildOperatorDemoReport } from "./security-research-demo-report.mjs";
import { adaptPackForReport } from "./security-research-pack-cli.mjs";

// ── Helpers ──────────────────────────────────────────────────────────────────

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForChildExit(child, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.killed) { resolve(); return; }
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

async function removePathWithRetry(dirPath, { maxRetries = 8, baseDelayMs = 250 } = {}) {
  const isWindows = platform === "win32";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      rmSync(dirPath, { recursive: true, force: true });
      return;
    } catch (err) {
      const retryable = err.code === "EBUSY" || err.code === "EPERM" || err.code === "ENOTEMPTY";
      if (retryable && attempt < maxRetries) {
        const delay = baseDelayMs * (attempt + 1) * (isWindows ? 2 : 1);
        await sleep(delay);
        continue;
      }
      console.warn(
        `[cleanup] Warning: could not remove ${dirPath} after ${attempt + 1} attempt(s): ` +
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
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitForHealth(port) {
  const url = `http://127.0.0.1:${port}/health`;
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch { /* keep waiting */ }
    await sleep(250);
  }
  throw new Error(`managed server did not become healthy: ${url}`);
}

async function callTool(serverUrl, name, input = {}) {
  const res = await fetch(`${serverUrl}/tool/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) throw new Error(`${name} failed: HTTP ${res.status} ${JSON.stringify(body)}`);
  return body;
}

// ── Demo Fixture Content ──────────────────────────────────────────────────────

const WORKER_JS = `\
// Demo fixture web worker — posts back a ready signal.
self.onmessage = function (e) {
  self.postMessage("worker-ready:" + e.data);
};
`;

const IFRAME_HTML = `\
<!doctype html>
<html>
  <head><title>F12 Demo Iframe</title><meta charset="utf-8"></head>
  <body>
    <div id="iframe-marker">iframe-content-ready</div>
    <script>
      console.log("demo-iframe: loaded");
      sessionStorage.setItem("iframe_marker", "iframe-storage-ready");
    <\/script>
  </body>
</html>
`;

// Main page HTML — all evidence signals embedded in one page load.
const MAIN_HTML = `\
<!doctype html>
<html>
  <head>
    <title>F12 Professional Demo Fixture</title>
    <meta charset="utf-8">
  </head>
  <body>
    <h1 id="demo-marker">F12 Professional Demo Fixture</h1>
    <p>This local fixture exercises Network, Console, Storage, Frame, and Worker
       evidence surfaces for the Agent Browser Runtime demo.</p>
    <div id="shadow-host"></div>
    <iframe src="/iframe.html" id="demo-iframe"
            width="300" height="100" title="demo iframe"></iframe>
    <script>
      // ── Storage signals ────────────────────────────────────────────────────
      localStorage.setItem("demo_fixture_marker", "local-storage-ready");
      sessionStorage.setItem("demo_fixture_session", "session-storage-ready");
      document.cookie =
        "demo_fixture_cookie=browser-runtime-demo; Path=/; SameSite=Lax";

      // ── Console signals ────────────────────────────────────────────────────
      console.log("demo-fixture: page load started");
      console.warn("demo-fixture: intentional warning signal for F12 Console");
      console.error("demo-fixture: intentional error signal for F12 Console");

      // ── Shadow DOM ─────────────────────────────────────────────────────────
      const host = document.getElementById("shadow-host");
      const shadow = host.attachShadow({ mode: "open" });
      const shadowDiv = document.createElement("div");
      shadowDiv.id = "shadow-marker";
      shadowDiv.textContent = "shadow-dom-ready";
      shadow.appendChild(shadowDiv);

      // ── Network: normal 200 JSON fetch ─────────────────────────────────────
      fetch("/api/data")
        .then(r => r.json())
        .then(d => console.log("demo-fixture: api/data ok marker=" + d.marker))
        .catch(err => console.error("demo-fixture: api/data failed", err));

      // ── Network: 500 error response ────────────────────────────────────────
      fetch("/api/error")
        .then(r => {
          console.warn("demo-fixture: api/error HTTP status=" + r.status);
          return r.json().catch(() => null);
        })
        .catch(err => console.error("demo-fixture: api/error network failed", err));

      // ── Network: 3-hop redirect chain ──────────────────────────────────────
      fetch("/redirect-start", { redirect: "follow" })
        .then(r => console.log(
          "demo-fixture: redirect chain done status=" + r.status + " url=" + r.url))
        .catch(err => console.error("demo-fixture: redirect chain failed", err));

      // ── Web Worker ─────────────────────────────────────────────────────────
      try {
        const worker = new Worker("/worker.js");
        worker.postMessage("demo-start");
        worker.onmessage = e => console.log("demo-fixture: worker replied " + e.data);
        worker.onerror  = e => console.warn("demo-fixture: worker error " + e.message);
      } catch (err) {
        console.warn("demo-fixture: worker unavailable " + err.message);
      }
    <\/script>
  </body>
</html>
`;

// ── Fixture Server ────────────────────────────────────────────────────────────

function startDemoFixture() {
  const server = http.createServer((req, res) => {
    // Redirect chain: /redirect-start → /redirect-middle → /redirect-final
    if (req.url === "/redirect-start") {
      res.writeHead(302, { location: "/redirect-middle" });
      res.end();
      return;
    }
    if (req.url === "/redirect-middle") {
      res.writeHead(302, { location: "/redirect-final" });
      res.end();
      return;
    }
    if (req.url === "/redirect-final") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("redirect-final-ok: demo fixture");
      return;
    }
    // API: normal 200 JSON + session cookie
    if (req.url === "/api/data") {
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "demo_api_session=demo-api-v1; Path=/; SameSite=Lax",
      });
      res.end(JSON.stringify({ ok: true, marker: "demo-fixture-api-data" }));
      return;
    }
    // API: intentional 500 error response
    if (req.url === "/api/error") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: "intentional-500-for-demo",
        marker: "demo-fixture-api-error",
        note: "This 500 is intentional fixture evidence; it is not a vulnerability finding.",
      }));
      return;
    }
    // Iframe page
    if (req.url === "/iframe.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(IFRAME_HTML);
      return;
    }
    // Web Worker script
    if (req.url === "/worker.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(WORKER_JS);
      return;
    }
    // Main page (all other paths)
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": "demo_session=main-page-v1; Path=/; SameSite=Lax",
    });
    res.end(MAIN_HTML);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/`, port });
    });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

const serverPort = await freePort();
const browserPort = await freePort();
const tempDir = mkdtempSync(join(tmpdir(), "agent-demo-fixture-smoke-"));
const fixture = await startDemoFixture();
const profile = "demo-fixture-smoke";
const serverUrl = `http://127.0.0.1:${serverPort}`;

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

  await callTool(serverUrl, "profile_create", { profile });

  // Run the full security research pack against the local demo fixture.
  const pack = await callTool(serverUrl, "devtools_security_research_pack", {
    profile,
    url: fixture.url,
    limit: 30,
    waitMs: 1500,
    includeHar: true,
    includeTrace: false,
    includeApplicationExport: true,
  });

  // Attach professional readiness for the operator demo report adapter.
  try {
    pack.professionalReadiness = await callTool(serverUrl, "devtools_professional_readiness", {
      profile,
    });
  } catch {
    pack.professionalReadiness = {
      objectiveBoundary:
        "Collect browser evidence only; does not classify findings as vulnerabilities.",
    };
  }

  // Write the raw pack to temp dir for post-smoke inspection.
  const packDumpPath = join(tempDir, "demo-security-research-pack.json");
  writeFileSync(packDumpPath, JSON.stringify(pack, null, 2), "utf8");

  // Generate the Operator Demo Report via the CLI adapter.
  const adapted = adaptPackForReport(pack, profile);
  const demoReportMd = buildOperatorDemoReport(adapted, {
    title: "Agent Browser Runtime — F12 Professional Demo",
  });
  const demoReportPath = join(tempDir, "demo-operator-report.md");
  writeFileSync(demoReportPath, demoReportMd, "utf8");

  // ── Assertions ─────────────────────────────────────────────────────────────

  const summary = pack.summary || {};

  // Research pack artifact on disk
  assert(summary.researchPackPath, "research pack path missing from pack summary");
  assert(
    existsSync(summary.researchPackPath),
    `research pack file not found at: ${summary.researchPackPath}`,
  );

  // HAR — captures all requests including 500 response and redirect hops
  assert(summary.harPath, "HAR path missing — 500/redirect evidence not persisted");
  assert(existsSync(summary.harPath), `HAR file not found: ${summary.harPath}`);

  // Application export — captures localStorage, sessionStorage, cookies
  assert(
    summary.applicationExportPath,
    "application export path missing — storage evidence (localStorage/sessionStorage/cookie) not captured",
  );

  // Worker/frame boundary report — captures iframe and frame boundaries
  assert(
    summary.workerFrameReportPath,
    "worker/frame boundary path missing — iframe frame boundary evidence not captured",
  );

  // Network coverage: main + api/data + api/error + redirect hops + iframe >= 4 requests
  assert(
    (summary.requestCount ?? 0) >= 4,
    `expected >= 4 network requests (main, api/data, api/error, redirect chain, iframe), got: ${summary.requestCount}`,
  );

  // Operator Demo Report on disk
  assert(existsSync(demoReportPath), "demo operator report file was not written to disk");
  assert(demoReportMd.length > 0, "demo operator report is empty");

  // Required report sections
  assert(demoReportMd.includes("## Operator Handoff"), "demo report missing ## Operator Handoff section");
  assert(demoReportMd.includes("## Objective Boundary"), "demo report missing ## Objective Boundary section");
  assert(
    demoReportMd.includes("devtools_artifact_read"),
    "demo report missing devtools_artifact_read tool reference",
  );

  // Forbidden content: report must NOT make vulnerability judgments
  const lower = demoReportMd.toLowerCase();
  assert(!lower.includes("vulnerability found"), "demo report contains forbidden text 'vulnerability found'");
  assert(!lower.includes("high risk"), "demo report contains forbidden text 'high risk'");
  assert(!lower.includes("critical risk"), "demo report contains forbidden text 'critical risk'");
  assert(!lower.includes("exploitable"), "demo report contains forbidden text 'exploitable'");
  assert(!lower.includes("security score"), "demo report contains forbidden text 'security score'");

  // ── Summary output ──────────────────────────────────────────────────────────
  console.log("F12 demo fixture smoke passed:");
  console.log(`- fixture url:          ${fixture.url}`);
  console.log(`- requests:             ${summary.requestCount}`);
  console.log(`- failed requests:      ${summary.failedRequestCount ?? 0}`);
  console.log(`- console entries:      ${summary.consoleEntryCount}`);
  console.log(`- artifact files:       ${summary.artifactFileCount}`);
  console.log(`- research pack:        ${summary.researchPackPath}`);
  console.log(`- har:                  ${summary.harPath}`);
  console.log(`- application export:   ${summary.applicationExportPath}`);
  console.log(`- worker/frame:         ${summary.workerFrameReportPath}`);
  console.log(`- pack dump:            ${packDumpPath}`);
  console.log(`- demo report:          ${demoReportPath} (${demoReportMd.length} chars)`);
} finally {
  await fetch(`${serverUrl}/shutdown`, { method: "POST" }).catch(() => {});
  await sleep(300);
  runtime.kill();
  fixture.server.close();
  await waitForChildExit(runtime, 5000);
  await sleep(platform === "win32" ? 400 : 100);
  await removePathWithRetry(tempDir);
}
