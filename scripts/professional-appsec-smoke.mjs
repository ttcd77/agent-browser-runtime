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
  const capabilityMap = await callTool(baseUrl, "devtools_capability_map", {
    profile: "professional",
  });
  assert(capabilityMap.panels?.some((panel) => panel.category === "network"), "professional capability map missing Network route");
  assert(capabilityMap.panels?.some((panel) => panel.category === "evidence-workflow"), "professional capability map missing Evidence route");
  assert(capabilityMap.panels?.some((panel) => panel.category === "sources-debugger"), "professional capability map missing Sources route");
  const workflowGuide = await callTool(baseUrl, "devtools_workflow_guide", {
    profile: "professional",
    task: "professional-appsec",
  });
  assert(workflowGuide.defaultPath?.join(" -> ") === "browser_open -> browser_capture -> browser_inspect -> browser_security_pack -> drilldownPlan", `professional workflow guide default path is not fixed: ${JSON.stringify(workflowGuide.defaultPath)}`);
  assert(workflowGuide.defaultTools?.includes("browser_raw"), "professional workflow guide missing browser_raw escape hatch");
  assert(workflowGuide.steps?.some((step) => step.tool === "devtools_professional_readiness"), "professional workflow guide missing readiness step");
  assert(workflowGuide.steps?.some((step) => step.tool === "browser_security_pack"), "professional workflow guide missing browser_security_pack step");
  assert(workflowGuide.exitCriteria?.some((entry) => String(entry).includes("drilldown plan")), "professional workflow guide missing drilldown exit criteria");
  const initialReadiness = await callTool(baseUrl, "devtools_professional_readiness", {
    profile: "professional",
  });
  assert(initialReadiness.backend === "managed-cdp", `professional readiness wrong backend: ${JSON.stringify(initialReadiness)}`);
  assert(initialReadiness.workflowPath?.join(" -> ") === "browser_open -> browser_capture -> browser_inspect -> browser_security_pack -> drilldownPlan", "professional readiness missing workflow path");
  assert(initialReadiness.checks?.some((check) => check.name === "f12ParityMatrix" && check.present), `professional readiness missing parity check: ${JSON.stringify(initialReadiness.checks)}`);
  assert(initialReadiness.nextActions?.some((entry) => entry.tool === "browser_security_pack"), `professional readiness missing evidence-pack next action: ${JSON.stringify(initialReadiness.nextActions)}`);
  assert(initialReadiness.objectiveBoundary?.includes("does not judge vulnerabilities"), "professional readiness crossed objective boundary");
  const firstInspect = await callTool(baseUrl, "browser_inspect", {
    profile: "professional",
    mode: "overview",
    limit: 8,
  });
  assert(firstInspect.facade === "browser_inspect", "professional browser_inspect facade marker missing");
  assert(firstInspect.result?.toolPlan?.firstPass?.length >= 1, "professional browser_inspect missing first-pass tool plan");
  assert(firstInspect.result?.professionalWorkflow?.defaultPath?.join(" -> ") === "browser_open -> browser_capture -> browser_inspect -> browser_security_pack -> drilldownPlan", "professional browser_inspect missing professional workflow summary");
  assert(firstInspect.result?.professionalWorkflow?.readinessTool === "devtools_professional_readiness", "professional browser_inspect missing readiness tool route");
  assert(firstInspect.result?.professionalWorkflow?.objectiveBoundary?.includes("does not classify vulnerabilities"), "professional browser_inspect workflow summary crossed objective-tool boundary");
  const captureStatus = await callTool(baseUrl, "browser_capture", {
    profile: "professional",
    action: "status",
  });
  assert(captureStatus.facade === "browser_capture", "professional browser_capture facade marker missing");
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
  assert(pack.summary?.workflowTask === "professional-appsec", "professional pack missing workflow task summary");
  assert(pack.summary?.capture?.enabled === true && typeof pack.summary?.capture?.trafficCount === "number", `professional pack missing capture summary: ${JSON.stringify(pack.summary?.capture)}`);
  assert(pack.artifacts?.captureStatus?.capture?.enabled === true, "professional pack missing capture status artifact");
  assert(pack.summary?.handoffReady === true, `professional pack handoff not ready: ${JSON.stringify(pack.summary?.handoffMissing)}`);
  assert(pack.handoffCompleteness?.ready === true, `professional pack missing handoff completeness: ${JSON.stringify(pack.handoffCompleteness)}`);
  assert(pack.summary?.artifactCoverageReady === true, `professional pack artifact coverage not ready: ${JSON.stringify(pack.summary?.artifactCoverageMissing)}`);
  assert(pack.artifactCoverage?.rows?.some((row) => row.name === "har" && row.status === "present"), `professional pack missing HAR artifact coverage: ${JSON.stringify(pack.artifactCoverage)}`);
  assert(pack.summary?.drilldownPlanPath, "professional pack missing drilldown plan path");
  assert(pack.summary?.researchPackPath, "professional pack missing handoff path");
  assert(pack.artifacts?.researchPack?.sha256, "professional pack missing handoff hash");
  assert(pack.agentEntryPoints?.defaultMode === "facade-first", "professional pack missing agent entry points");
  assert(pack.agentEntryPoints?.professionalPath?.includes("browser_security_pack"), "professional pack missing professional agent route");
  assert(pack.toolCatalogSummary?.toolCount >= 1, "professional pack missing tool catalog summary");
  assert(pack.workflow?.defaultPath?.join(" -> ") === "browser_open -> browser_capture -> browser_inspect -> browser_security_pack -> drilldownPlan", "professional pack missing workflow snapshot");
  assert(pack.handoffDrilldowns?.some((entry) => entry.tool === "devtools_artifact_read" && entry.input?.path === pack.summary.researchPackPath), "professional pack missing handoff read drilldown");
  assert(pack.parityMatrix?.summary?.strongestBackend === "managed-cdp", "professional pack missing Managed Browser parity snapshot");
  assert(pack.artifacts?.artifactIndex?.totalFileCount >= 1, "professional pack missing artifact index payload");
  assert(pack.artifacts?.artifactIndex?.kinds?.["research-pack"] >= 1, `professional pack artifact index missing handoff kind: ${JSON.stringify(pack.artifacts?.artifactIndex?.kinds)}`);
  assert(pack.artifacts?.evidenceTimeline?.eventCount >= 1, "professional pack missing evidence timeline payload");
  const finalReadiness = await callTool(baseUrl, "devtools_professional_readiness", {
    profile: "professional",
  });
  assert(finalReadiness.ready === true, `professional readiness not mechanically ready after pack: ${JSON.stringify(finalReadiness.missing)}`);
  assert(finalReadiness.evidenceReady === true, `professional readiness missing evidence after pack: ${JSON.stringify(finalReadiness)}`);
  assert(finalReadiness.artifactCount >= 1, "professional readiness missing artifact count after pack");
  assert(finalReadiness.timelineEventCount >= 1, "professional readiness missing timeline count after pack");
  assert(finalReadiness.latestResearchPackHandoff?.path, "professional readiness missing latest research pack handoff route");
  assert(finalReadiness.latestResearchPackHandoff?.inspect?.tool === "devtools_artifact_inspect", "professional readiness missing latest handoff inspect route");
  assert(finalReadiness.nextActions?.some((entry) => entry.tool === "devtools_artifact_inspect"), "professional readiness missing handoff inspect next action");
  assert(pack.drilldownPlan?.drilldowns?.some((entry) => entry.tool === "devtools_request_detail"), "professional pack missing request-detail drilldown");
  assert(pack.drilldownPlan?.planPath === pack.summary.drilldownPlanPath, "professional pack drilldown path mismatch");
  const requestDetailStep = pack.drilldownPlan.drilldowns.find((entry) => entry.tool === "devtools_request_detail");
  const requestDetail = await callTool(baseUrl, requestDetailStep.tool, requestDetailStep.input);
  assert(requestDetail.detail?.requestId || requestDetail.requestId, `professional request-detail drilldown returned no request id: ${JSON.stringify(requestDetail)}`);
  assert(requestDetail.detail?.url || requestDetail.url, `professional request-detail drilldown returned no URL: ${JSON.stringify(requestDetail)}`);
  const replayStep = pack.drilldownPlan.drilldowns.find((entry) => entry.tool === "devtools_request_replay_batch");
  assert(replayStep, "professional pack missing replay-batch drilldown");
  const replayBatch = await callTool(baseUrl, replayStep.tool, replayStep.input);
  assert(Array.isArray(replayBatch.results) || Array.isArray(replayBatch.replays), `professional replay-batch drilldown missing replay results: ${JSON.stringify(replayBatch)}`);
  assert(replayBatch.replayBoundary || replayBatch.boundaries || replayBatch.results?.some((entry) => entry.replayBoundary), `professional replay-batch missing replay boundary: ${JSON.stringify(replayBatch)}`);
  const traceStep = pack.drilldownPlan.drilldowns.find((entry) => entry.tool === "devtools_trace_query");
  assert(traceStep, "professional pack missing trace-query drilldown");
  const traceDrilldown = await callTool(baseUrl, traceStep.tool, traceStep.input);
  assert(traceDrilldown.backend === "managed-cdp", `professional trace drilldown wrong backend: ${JSON.stringify(traceDrilldown)}`);
  assert(typeof traceDrilldown.totalEvents === "number", "professional trace drilldown missing total event count");
  assert(traceDrilldown.recommendedDrilldowns?.some((entry) => entry.tool === "devtools_chrome_trace"), "professional trace drilldown missing fresh trace recommendation");
  const handoffPreview = await callTool(baseUrl, "devtools_artifact_read", {
    profile: "professional",
    path: pack.summary.researchPackPath,
    mode: "line",
    startLine: 1,
    lineCount: 320,
  });
  assert(handoffPreview.contentText?.includes("security-research-pack-handoff"), "professional handoff preview missing schema marker");
  assert(handoffPreview.contentText?.includes("professional-appsec"), "professional handoff preview missing workflow marker");
  assert(handoffPreview.contentText?.includes("agentEntryPoints"), "professional handoff preview missing agent entry points");
  assert(handoffPreview.contentText?.includes("artifactCoverage"), "professional handoff preview missing artifact coverage marker");
  const drilldownPreview = await callTool(baseUrl, "devtools_artifact_inspect", {
    profile: "professional",
    path: pack.summary.drilldownPlanPath,
    maxBytes: 12000,
  });
  assert(drilldownPreview.json?.ok === true, "professional drilldown plan did not parse as JSON");
  assert(drilldownPreview.previewText?.includes("devtools_request_detail"), "professional drilldown preview missing request detail route");
  const handoffInspect = await callTool(baseUrl, "devtools_artifact_inspect", {
    profile: "professional",
    path: pack.summary.researchPackPath,
    maxBytes: 300000,
  });
  assert(handoffInspect.researchPackHandoff?.ready === true, `professional handoff inspect missing readiness summary: ${JSON.stringify(handoffInspect.researchPackHandoff)}`);
  assert(handoffInspect.researchPackHandoff?.agentEntryMode === "facade-first", "professional handoff inspect missing agent route summary");
  assert(handoffInspect.researchPackHandoff?.professionalPath?.includes("browser_security_pack"), "professional handoff inspect missing professional facade path");
  assert(handoffInspect.researchPackHandoff?.objectiveBoundary?.includes("does not judge vulnerabilities"), "professional handoff inspect crossed objective boundary");

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
  const sourceSearch = await callTool(baseUrl, "devtools_sources_search", {
    profile: "professional",
    query: "loadProfile",
    reload: true,
    ignoreCache: true,
    waitMs: 800,
    maxMatches: 10,
  });
  assert(sourceSearch.matchCount >= 1, `professional source search missing loadProfile marker: ${JSON.stringify(sourceSearch)}`);
  assert(sourceSearch.recommendedDrilldowns?.some((entry) => entry.tool === "devtools_source_get"), "professional source search missing source_get drilldown");
  assert(sourceSearch.recommendedDrilldowns?.some((entry) => entry.tool === "devtools_source_pretty_print"), "professional source search missing pretty-print drilldown");
  const debuggerProbe = await callTool(baseUrl, "devtools_debugger_control", {
    profile: "professional",
    action: "pauseOnExpression",
    expression: "const professionalDebuggerMarker = 42; debugger; professionalDebuggerMarker;",
    waitMs: 600,
    autoResume: true,
    evaluateExpressions: ["professionalDebuggerMarker"],
    maxFrames: 4,
  });
  assert(debuggerProbe.action === "pauseOnExpression", "professional debugger probe did not run pauseOnExpression");
  assert(debuggerProbe.paused?.callFrames?.length >= 1, `professional debugger probe missing paused call frames: ${JSON.stringify(debuggerProbe)}`);
  assert(debuggerProbe.autoResumed === true, "professional debugger probe did not auto resume");

  const artifactIndex = await callTool(baseUrl, "devtools_artifact_index", {
    profile: "professional",
    maxFiles: 100,
  });
  assert(artifactIndex.totalFileCount >= 1, "professional artifact index missing files");
  assert(artifactIndex.kinds?.["research-pack"] >= 1, `professional artifact index missing research-pack kind: ${JSON.stringify(artifactIndex.kinds)}`);
  assert(artifactIndex.kinds?.["drilldown-plan"] >= 1, `professional artifact index missing drilldown-plan kind: ${JSON.stringify(artifactIndex.kinds)}`);

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
  console.log(`- Drilldown plan: ${pack.summary.drilldownPlanPath}`);
  console.log(`- Research pack handoff: ${pack.summary.researchPackPath}`);
  console.log(`- F12 parity rows: ${parity.summary.panelCount}`);
  console.log(`- capability panels: ${capabilityMap.panelCount}`);
  console.log(`- source search drilldowns: ${sourceSearch.recommendedDrilldowns.length}`);
  console.log(`- trace drilldown events: ${traceDrilldown.totalEvents}`);
  console.log(`- debugger paused frames: ${debuggerProbe.paused.callFrames.length}`);
  console.log(`- artifact files: ${artifactIndex.totalFileCount}`);
} finally {
  await fetch(`http://127.0.0.1:${serverPort}/shutdown`, { method: "POST" }).catch(() => {});
  setTimeout(() => child.kill(), 500);
  setTimeout(() => rmSync(tempDir, { recursive: true, force: true }), 1000);
  fixture.server.close();
}
