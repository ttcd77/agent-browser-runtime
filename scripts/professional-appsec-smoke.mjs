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
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // keep waiting
    }
    await sleep(250);
  }
  throw new Error(`server did not become healthy: ${url}`);
}

async function callTool(baseUrl, name, body = {}) {
  const response = await fetch(`${baseUrl}/tool/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${name} failed: ${response.status} ${await response.text()}`);
  }
  return await response.json();
}

async function startFixtureServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": "agent_appsec_session=local-fixture; Path=/; SameSite=Lax",
      });
      res.end(`<!doctype html>
        <title>Agent AppSec F12 Fixture</title>
        <script>
          localStorage.setItem("agent-appsec-local", "local-fixture-value");
          sessionStorage.setItem("agent-appsec-session", "session-fixture-value");
          window.__fixtureReady = Promise.resolve("ready");
        </script>
        <script src="/app.js"></script>
        <h1>Agent AppSec F12 Fixture</h1>
        <button id="load-profile">Load profile</button>
        <div id="shadow-host"></div>
        <iframe id="same-origin-frame" src="/frame.html"></iframe>`);
      return;
    }
    if (url.pathname === "/frame.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>Frame</title><p id="frame-marker">agent-appsec-frame</p>`);
      return;
    }
    if (url.pathname === "/app.js") {
      res.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(`
        const host = document.getElementById("shadow-host");
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = "<span id='shadow-marker'>agent-appsec-shadow</span>";
        async function loadProfile() {
          const first = await fetch("/redirect-start", { headers: { "x-agent-fixture": "profile" } });
          const profile = await first.json();
          window.__agentProfile = profile;
          return profile;
        }
        document.getElementById("load-profile").addEventListener("click", () => loadProfile());
        window.__agentLoadProfile = loadProfile;
        if ("serviceWorker" in navigator) {
          navigator.serviceWorker.register("/sw.js").catch(() => {});
        }
        //# sourceMappingURL=/app.js.map
      `);
      return;
    }
    if (url.pathname === "/app.js.map") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        version: 3,
        file: "app.js",
        sources: ["src/appsec-fixture.ts"],
        sourcesContent: ["export async function loadProfile() { return fetch('/redirect-start'); }\n"],
        names: [],
        mappings: "",
      }));
      return;
    }
    if (url.pathname === "/sw.js") {
      res.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "service-worker-allowed": "/",
      });
      res.end(`
        self.addEventListener("install", event => {
          event.waitUntil(caches.open("agent-appsec-cache").then(cache => cache.put("/cached-profile.json", new Response('{"cached":true}', { headers: { "content-type": "application/json" } }))));
          self.skipWaiting();
        });
        self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
      `);
      return;
    }
    if (url.pathname === "/redirect-start") {
      res.writeHead(302, { location: "/api/profile", "cache-control": "no-store" });
      res.end("redirecting");
      return;
    }
    if (url.pathname === "/api/profile") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ ok: true, userId: "local-user", role: "fixture" }));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

const serverPort = await freePort();
const browserPort = await freePort();
const tempDir = mkdtempSync(join(tmpdir(), "agent-professional-appsec-smoke-"));
const fixture = await startFixtureServer();
const child = spawn(process.execPath, ["scripts/agent-cdp-server.mjs"], {
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
  const baseUrl = `http://127.0.0.1:${serverPort}`;
  await callTool(baseUrl, "browser_open", {
    profile: "professional",
    url: fixture.url,
    waitMs: 1200,
  });
  const pack = await callTool(baseUrl, "devtools_security_research_pack", {
    profile: "professional",
    url: fixture.url,
    waitMs: 1200,
    includeHar: true,
    includeTrace: true,
    includeApplicationExport: true,
    limit: 30,
  });
  assert(pack.backend === "managed-cdp", `professional pack wrong backend: ${JSON.stringify(pack)}`);
  assert(pack.summary?.harPath, "professional pack missing HAR path");
  assert(pack.summary?.applicationExportPath, "professional pack missing Application export path");
  assert(pack.summary?.evidenceBundlePath, "professional pack missing evidence bundle path");
  assert(pack.summary?.correlationGraphPath, "professional pack missing correlation graph path");
  assert(pack.summary?.workerFrameReportPath, "professional pack missing worker/frame report path");
  assert(pack.summary?.artifactFileCount >= 1, "professional pack missing artifact index count");
  assert(pack.summary?.evidenceTimelineEventCount >= 1, "professional pack missing evidence timeline count");
  assert(pack.summary?.f12ParityPanelCount >= 1, "professional pack missing F12 parity count");
  assert(pack.summary?.drilldownCount >= 3, "professional pack missing drilldown count");
  assert(pack.parityMatrix?.summary?.strongestBackend === "managed-cdp", "professional pack missing Managed Browser parity snapshot");
  assert(pack.artifacts?.artifactIndex?.totalFileCount >= 1, "professional pack missing artifact index payload");
  assert(pack.artifacts?.evidenceTimeline?.eventCount >= 1, "professional pack missing evidence timeline payload");
  assert(pack.drilldownPlan?.drilldowns?.some((entry) => entry.tool === "devtools_request_detail"), "professional pack missing request-detail drilldown");

  const parity = await callTool(baseUrl, "devtools_f12_parity_matrix", { profile: "professional" });
  assert(parity.summary?.strongestBackend === "managed-cdp", "parity matrix should point to Managed Browser as strongest backend");
  assert(parity.rows?.some((row) => row.panel === "Application" && row.managed === "supported"), "parity matrix missing Application support");

  await callTool(baseUrl, "devtools_capture_start", {
    profile: "professional",
    clear: true,
    label: "professional-redirect-drilldown",
  });
  await callTool(baseUrl, "browser_open", {
    profile: "professional",
    url: new URL("/redirect-start", fixture.url).toString(),
    waitMs: 600,
  });
  await sleep(300);
  const network = await callTool(baseUrl, "devtools_network_summary", {
    profile: "professional",
    limit: 50,
  });
  assert(network.redirects?.some((row) => row.chainLength >= 1), `professional fixture missing redirect evidence: ${JSON.stringify(network, null, 2)}`);

  await callTool(baseUrl, "browser_open", {
    profile: "professional",
    url: fixture.url,
    waitMs: 1000,
  });
  const frameTree = await callTool(baseUrl, "devtools_frame_tree", {
    profile: "professional",
  });
  assert(JSON.stringify(frameTree).includes("shadow"), "professional fixture missing shadow/frame boundary evidence");

  const sourceMaps = await callTool(baseUrl, "devtools_source_map_sources", {
    profile: "professional",
    query: "sourceMappingURL",
    waitMs: 500,
    maxSources: 10,
    fetchMap: true,
  });
  const sourceMapEntries = sourceMaps.results?.flatMap((entry) => entry.sources || []) || [];
  assert(sourceMapEntries.some((entry) => String(entry.source || "").includes("appsec-fixture")), `professional fixture missing source map evidence: ${JSON.stringify(sourceMaps)}`);

  const artifactIndex = await callTool(baseUrl, "devtools_artifact_index", {
    profile: "professional",
    maxFiles: 100,
  });
  assert(artifactIndex.totalFileCount >= 1, "professional artifact index missing files");

  console.log("Professional AppSec F12 smoke passed:");
  console.log(`- fixture: ${fixture.url}`);
  console.log(`- requests: ${pack.summary.requestCount}`);
  console.log(`- HAR: ${pack.summary.harPath}`);
  console.log(`- Application export: ${pack.summary.applicationExportPath}`);
  console.log(`- Evidence bundle: ${pack.summary.evidenceBundlePath}`);
  console.log(`- Correlation graph: ${pack.summary.correlationGraphPath}`);
  console.log(`- Worker/frame report: ${pack.summary.workerFrameReportPath}`);
  console.log(`- Pack artifact index/timeline/parity: ${pack.summary.artifactFileCount}/${pack.summary.evidenceTimelineEventCount}/${pack.summary.f12ParityPanelCount}`);
  console.log(`- Pack drilldowns: ${pack.summary.drilldownCount}`);
  console.log(`- F12 parity rows: ${parity.summary.panelCount}`);
  console.log(`- artifact files: ${artifactIndex.totalFileCount}`);
} finally {
  await fetch(`http://127.0.0.1:${serverPort}/shutdown`, { method: "POST" }).catch(() => {});
  setTimeout(() => child.kill(), 500);
  setTimeout(() => rmSync(tempDir, { recursive: true, force: true }), 1000);
  fixture.server.close();
}
