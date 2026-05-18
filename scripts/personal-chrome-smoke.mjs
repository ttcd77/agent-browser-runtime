import http from "node:http";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const baseUrl = process.env.PERSONAL_CHROME_HTTP_URL || "http://127.0.0.1:17337";

async function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": "agent_personal_smoke=session-fixture; Path=/; SameSite=Lax",
      });
      res.end(`<!doctype html>
        <title>Agent Browser Runtime Personal Smoke</title>
        <link rel="stylesheet" href="/style.css">
        <h1 id="title">Agent Browser Runtime Personal Smoke</h1>
        <button id="action">Run fixture action</button>
        <div id="personal-shadow-host"></div>
        <iframe id="same-origin-frame" src="/frame.html"></iframe>
        <script src="/app.js"></script>`);
      return;
    }
    if (url.pathname === "/style.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      res.end(`#action { color: rgb(20, 80, 140); padding: 4px; }`);
      return;
    }
    if (url.pathname === "/app.js") {
      res.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(`
        window.AGENT_PERSONAL_SMOKE_MARKER = "fixture-ready";
        localStorage.setItem("agent-personal-smoke-local", "local-fixture-value");
        sessionStorage.setItem("agent-personal-smoke-session", "session-fixture-value");
        document.cookie = "agent_personal_chips=partitioned; path=/; Secure; SameSite=None; Partitioned";
        const shadowHost = document.getElementById("personal-shadow-host");
        const shadow = shadowHost.attachShadow({ mode: "open" });
        shadow.innerHTML = "<span>PERSONAL_SHADOW_MARKER</span>";
        window.__chipsCookieAttempt = {
          name: "agent_personal_chips",
          attempted: true,
          documentCookieVisible: document.cookie.includes("agent_personal_chips="),
        };
        window.__idbReady = new Promise((resolve) => {
          const open = indexedDB.open("agent-personal-smoke-db", 1);
          open.onupgradeneeded = () => open.result.createObjectStore("records", { keyPath: "id" });
          open.onerror = () => resolve("idb-error");
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction("records", "readwrite");
            tx.objectStore("records").put({ id: "one", value: "personal indexeddb smoke" });
            tx.oncomplete = () => { db.close(); resolve("idb-ready"); };
            tx.onerror = () => { db.close(); resolve("idb-tx-error"); };
          };
        });
        window.__cacheReady = caches?.open
          ? caches.open("agent-personal-smoke-cache")
              .then((cache) => cache.put("/personal-cached.txt", new Response("personal cached smoke")))
              .then(() => "cache-ready")
              .catch((error) => String(error && error.message || error))
          : Promise.resolve("cache-unsupported");
        document.getElementById("action").addEventListener("click", () => {
          document.body.dataset.clicked = "yes";
        });
        fetch("/api/data", { headers: { "X-Agent-Smoke": "fixture" } })
          .then((response) => response.json())
          .then((value) => { window.AGENT_PERSONAL_SMOKE_API = value; })
          .catch((error) => { window.AGENT_PERSONAL_SMOKE_ERROR = String(error && error.message || error); });
      `);
      return;
    }
    if (url.pathname === "/api/data") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ ok: true, marker: "agent-personal-smoke-api" }));
      return;
    }
    if (url.pathname === "/redirect-start") {
      res.writeHead(302, { location: "/redirect-end", "cache-control": "no-store" });
      res.end("redirecting");
      return;
    }
    if (url.pathname === "/redirect-end") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ ok: true, marker: "agent-personal-redirect-end" }));
      return;
    }
    if (url.pathname === "/frame.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>Fixture Frame</title><p id="frame-marker">agent-personal-smoke-frame</p>`);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}/`,
  };
}

async function callTool(name, body = {}) {
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

async function fetchHealth() {
  const response = await fetch(`${baseUrl}/health`);
  if (!response.ok) throw new Error(`health failed: ${response.status} ${await response.text()}`);
  return await response.json();
}

const health = await fetchHealth();
assert(health.connected >= 1, `personal Chrome extension is not connected: ${JSON.stringify(health)}`);

const fixture = await startFixtureServer();
process.once("exit", () => fixture.server.close());

const opened = await callTool("browser_open", {
  url: fixture.url,
  newTab: true,
  waitMs: 1000,
});
assert(opened.diagnostics?.page?.url?.startsWith(fixture.url), `Personal Chrome did not navigate to fixture page: ${JSON.stringify(opened)}`);

const capabilities = await callTool("devtools_backend_capabilities");
assert(capabilities.backend === "personal-chrome", `wrong backend: ${JSON.stringify(capabilities)}`);
assert(capabilities.layer === "chrome.debugger", `wrong layer: ${JSON.stringify(capabilities)}`);
assert(capabilities.domainAccess?.allowedDomains?.includes("Network"), "capabilities missing Network domain");
assert(capabilities.domainAccess?.allowedDomains?.includes("Runtime"), "capabilities missing Runtime domain");
const protocolSchema = await callTool("devtools_protocol_schema", { domain: "Network", query: "getResponseBody" });
assert(protocolSchema.notApplicable === true, `Personal Chrome protocol schema should be structured notApplicable: ${JSON.stringify(protocolSchema)}`);
assert(protocolSchema.allowedDomains?.includes("Network"), "Personal Chrome protocol schema missing allowed domain guidance");
const browserCdp = await callTool("devtools_browser_cdp_command", { method: "Browser.getVersion" });
assert(browserCdp.notApplicable === true, `Personal Chrome browser-process CDP should be structured notApplicable: ${JSON.stringify(browserCdp)}`);
const browserVersion = await callTool("devtools_browser_version");
assert(browserVersion.backend === "personal-chrome" && browserVersion.userAgent, `Personal Chrome browser version missing userAgent: ${JSON.stringify(browserVersion)}`);
const browserTargets = await callTool("devtools_browser_targets");
assert(browserTargets.targetCount >= 1, `Personal Chrome browser targets missing tabs: ${JSON.stringify(browserTargets)}`);
const systemInfo = await callTool("devtools_system_info");
assert(systemInfo.notApplicable === true, `Personal Chrome system info should be structured notApplicable: ${JSON.stringify(systemInfo)}`);

const attached = await callTool("devtools_attach");
assert(attached.ok === true || attached.attached === true, `debugger did not attach: ${JSON.stringify(attached)}`);

const status = await callTool("devtools_status");
assert(status.attached === true, `debugger status not attached: ${JSON.stringify(status)}`);
assert(status.tab?.url, `status missing active tab URL: ${JSON.stringify(status)}`);

await callTool("devtools_capture_start", {
  clear: true,
  label: "personal-redirect-smoke",
});

const runtime = await callTool("devtools_cdp_command", {
  method: "Runtime.evaluate",
  params: {
    expression: "({ ok: true, href: location.href, title: document.title })",
    returnByValue: true,
  },
});
assert(runtime.result?.result?.value?.ok === true, `Runtime.evaluate did not return expected value: ${JSON.stringify(runtime)}`);

const applicationReady = await callTool("devtools_cdp_command", {
  method: "Runtime.evaluate",
  params: {
    expression: "Promise.all([window.__idbReady, window.__cacheReady])",
    awaitPromise: true,
    returnByValue: true,
  },
});
assert(Array.isArray(applicationReady.result?.result?.value), `Personal fixture storage did not settle: ${JSON.stringify(applicationReady)}`);

const sourceSearch = await callTool("devtools_sources_search", {
  query: "AGENT_PERSONAL_SMOKE_MARKER",
  reload: true,
  ignoreCache: true,
  waitMs: 500,
  maxMatches: 5,
});
assert(sourceSearch.matchCount > 0, `Personal Chrome source search did not find marker script: ${JSON.stringify(sourceSearch)}`);
assert(sourceSearch.recommendedDrilldowns?.some((entry) => entry.tool === "devtools_source_get" && entry.input?.scriptId), `Personal Chrome source search missing source_get drilldown: ${JSON.stringify(sourceSearch.recommendedDrilldowns)}`);
assert(sourceSearch.recommendedDrilldowns?.some((entry) => entry.tool === "devtools_source_pretty_print" && entry.input?.scriptId), `Personal Chrome source search missing pretty-print drilldown: ${JSON.stringify(sourceSearch.recommendedDrilldowns)}`);
assert(sourceSearch.captureBoundaries?.some((entry) => String(entry).includes("parsed")), `Personal Chrome source search missing capture boundaries: ${JSON.stringify(sourceSearch.captureBoundaries)}`);

await callTool("devtools_cdp_command", {
  method: "Runtime.evaluate",
  params: {
    expression: "fetch('/redirect-start').then(response => response.json()).then(value => { window.__agentPersonalRedirectSmoke = value; return value; })",
    awaitPromise: true,
    returnByValue: true,
  },
});
const redirectSummary = await callTool("devtools_network_summary", {
  limit: 50,
});
const redirectRow = redirectSummary.redirects?.find((row) => row.chainLength >= 1 && String(row.url || "").includes("/redirect-end"));
assert(redirectRow, `Personal network summary missing redirect chain evidence: ${JSON.stringify(redirectSummary.redirects)}`);
assert(redirectSummary.recommendedDrilldowns?.some((entry) => entry.label === "Inspect latest redirect chain" && entry.input?.requestId === redirectRow.requestId), `Personal network summary missing redirect drilldown: ${JSON.stringify(redirectSummary.recommendedDrilldowns)}`);
const redirectDetail = await callTool("devtools_request_detail", {
  requestId: redirectRow.requestId,
});
assert(redirectDetail.detail?.redirectChain?.some((entry) => String(entry.url || "").includes("/redirect-start") && Number(entry.status) === 302), `Personal request detail missing redirect start evidence: ${JSON.stringify(redirectDetail.detail?.redirectChain)}`);
const requestGraph = await callTool("devtools_request_correlation_graph", {
  limit: 200,
});
assert(requestGraph.edges?.some((edge) => edge.type === "redirects-to"), `Personal request correlation graph missing redirect edge: ${JSON.stringify(requestGraph.edges)}`);
assert(requestGraph.detailRequestsInspected >= 1, `Personal request correlation graph did not inspect request details: ${JSON.stringify(requestGraph)}`);
const filteredRedirects = await callTool("devtools_network_log", {
  redirected: true,
  status_min: 200,
  status_max: 299,
  resource_type: "Fetch",
  response_header: { name: "content-type", valueContains: "json" },
  sort_by: "status",
  limit: 10,
});
assert(filteredRedirects.requests?.some((entry) => entry.requestId === redirectRow.requestId), `Personal network log filters missed redirect row: ${JSON.stringify(filteredRedirects)}`);
const filteredTimeline = await callTool("devtools_network_timeline", {
  url_contains: "/redirect-end",
  redirected: true,
  sort_by: "start",
  sort_dir: "asc",
  limit: 10,
});
assert(filteredTimeline.timeline?.some((entry) => entry.requestId === redirectRow.requestId), `Personal network timeline filters missed redirect row: ${JSON.stringify(filteredTimeline)}`);
const replay = await callTool("devtools_request_replay", {
  requestId: redirectRow.requestId,
  headers: {
    Host: "example.invalid",
    "X-Agent-Replay": "personal-smoke",
  },
});
assert(replay.replayBoundary?.replayLayer === "browser-fetch", `Personal replay missing browser-fetch boundary: ${JSON.stringify(replay.replayBoundary)}`);
assert(replay.replayBoundary?.headerHandling?.skippedHeaderNames?.includes("Host"), `Personal replay boundary missing skipped Host header: ${JSON.stringify(replay.replayBoundary)}`);
assert(replay.replayBoundary?.captureBoundaries?.some((line) => line.includes("not raw socket-level replay")), `Personal replay boundary missing raw-socket note: ${JSON.stringify(replay.replayBoundary)}`);
assert(replay.response?.status === 200, `Personal replay failed: ${JSON.stringify(replay)}`);

const frameTree = await callTool("devtools_frame_tree");
assert(frameTree.frameCount >= 1 || frameTree.frames?.length >= 1 || frameTree.frameTree?.frame?.id, `frame tree missing frames: ${JSON.stringify(frameTree)}`);
assert(frameTree.shadowRootCount >= 1, `Personal frame tree missing shadow root summary: ${JSON.stringify(frameTree)}`);
assert(frameTree.shadowRoots?.some((root) => root.host?.id === "personal-shadow-host" && root.sampleText.includes("PERSONAL_SHADOW_MARKER")), `Personal frame tree missing shadow root evidence: ${JSON.stringify(frameTree.shadowRoots)}`);

const storage = await callTool("devtools_storage_origin_summary");
assert(storage.page?.url || storage.page?.origin, `storage summary missing page evidence: ${JSON.stringify(storage)}`);
assert(storage.storageBoundarySummary?.frameCount >= 1, `storage boundary summary missing frames: ${JSON.stringify(storage)}`);
assert(typeof storage.storageBoundarySummary?.quotaUsageBytes === "number", `storage boundary summary missing quota usage bytes: ${JSON.stringify(storage)}`);
assert(storage.storageBoundarySummary?.quotaByOrigin && typeof storage.storageBoundarySummary.quotaByOrigin === "object", `storage boundary summary missing quota by origin: ${JSON.stringify(storage)}`);
assert(typeof storage.storageBucketSummary?.supported === "boolean", `storage bucket summary missing support flag: ${JSON.stringify(storage)}`);
assert(typeof storage.storageBucketSummary?.bucketCount === "number", `storage bucket summary missing bucket count: ${JSON.stringify(storage)}`);
assert(Array.isArray(storage.captureBoundaries), `storage origin summary missing capture boundaries: ${JSON.stringify(storage)}`);
assert(storage.cookiePartitionSummary?.cookieCount >= 1, `Personal cookie partition summary missing cookie count: ${JSON.stringify(storage)}`);
assert(typeof storage.cookiePartitionSummary?.partitionMetadataExposed === "boolean", `Personal cookie partition summary missing metadata flag: ${JSON.stringify(storage)}`);
const chipsAttempt = await callTool("devtools_cdp_command", {
  method: "Runtime.evaluate",
  params: {
    expression: "window.__chipsCookieAttempt",
    returnByValue: true,
  },
});
const chipsAttemptValue = chipsAttempt.result?.result?.value || chipsAttempt.result?.value || chipsAttempt.result;
assert(chipsAttemptValue?.attempted === true, `Personal CHIPS fixture did not attempt cookie write: ${JSON.stringify(chipsAttempt)}`);
assert(storage.page?.documentCookieNames?.includes("agent_personal_chips") === Boolean(chipsAttemptValue?.documentCookieVisible), `Personal document cookie names do not match fixture visibility: ${JSON.stringify(storage.page)}`);
const chipsCookie = storage.cookiePartitions?.find((cookie) => cookie.name === "agent_personal_chips");
if (chipsCookie) {
  assert(chipsCookie?.name === "agent_personal_chips", `Personal CHIPS cookie was visible to document.cookie but missing from backend cookie evidence: ${JSON.stringify(storage.cookiePartitions)}`);
}
const indexedDbList = await callTool("devtools_indexeddb_list", {
  maxDatabases: 20,
});
assert(indexedDbList.page?.ok === true, `Personal IndexedDB list failed: ${JSON.stringify(indexedDbList)}`);
const personalSmokeDb = indexedDbList.page?.databases?.find((db) => db.name === "agent-personal-smoke-db");
assert(personalSmokeDb?.objectStores?.some((store) => store.name === "records" && store.recordCount >= 1), `Personal IndexedDB list missing smoke store/count: ${JSON.stringify(indexedDbList.page)}`);
const indexedDbRead = await callTool("devtools_indexeddb_read", {
  database: "agent-personal-smoke-db",
  store: "records",
  limit: 10,
});
assert(indexedDbRead.page?.ok === true, `Personal IndexedDB read failed: ${JSON.stringify(indexedDbRead)}`);
assert(indexedDbRead.page?.records?.some((record) => record.value?.value === "personal indexeddb smoke"), `Personal IndexedDB read missing smoke record: ${JSON.stringify(indexedDbRead)}`);
const expectedCacheUrl = new URL("/personal-cached.txt", fixture.url).toString();
let cacheStorageList = null;
let personalSmokeCache = null;
let personalSmokeCacheEntry = null;
for (let attempt = 0; attempt < 12; attempt += 1) {
  cacheStorageList = await callTool("devtools_cache_storage_list", {
    maxCaches: 20,
    maxEntries: 50,
  });
  personalSmokeCache = cacheStorageList.page?.caches?.find((cache) => cache.name === "agent-personal-smoke-cache");
  personalSmokeCacheEntry = personalSmokeCache?.entries?.find((entry) => entry.url === expectedCacheUrl && entry.status === 200);
  if (personalSmokeCacheEntry) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
assert(cacheStorageList.page?.ok === true, `Personal CacheStorage list failed: ${JSON.stringify(cacheStorageList)}`);
assert(personalSmokeCacheEntry, `Personal CacheStorage list missing current smoke entry ${expectedCacheUrl}: ${JSON.stringify(cacheStorageList.page)}`);
const cacheEntry = await callTool("devtools_cache_entry_get", {
  cacheName: "agent-personal-smoke-cache",
  url: expectedCacheUrl,
});
assert(cacheEntry.page?.ok === true, `Personal CacheStorage entry read failed: ${JSON.stringify(cacheEntry)}`);
assert(String(cacheEntry.page?.bodyText || "").includes("personal cached smoke"), `Personal CacheStorage body missing smoke text: ${JSON.stringify(cacheEntry)}`);
const applicationSearch = await callTool("devtools_global_search", {
  query: "personal indexeddb smoke",
  includeNetwork: false,
  includeSources: false,
  includeStorage: true,
  maxMatches: 10,
});
assert(applicationSearch.results?.some((entry) => entry.category === "application" && entry.source === "application-export"), `Personal global search did not inspect Application export records: ${JSON.stringify(applicationSearch)}`);

const performanceInsights = await callTool("devtools_performance_insights", {
  durationMs: 250,
  includeChromeTrace: false,
  maxItems: 5,
});
assert(performanceInsights.backend === "personal-chrome", `performance insights wrong backend: ${JSON.stringify(performanceInsights)}`);
assert(performanceInsights.insights?.source?.performanceEntries === true, "performance insights missing performance entry source marker");
assert(typeof performanceInsights.insights?.resourceCount === "number", "performance insights missing resource count");
assert(Array.isArray(performanceInsights.insights?.captureBoundaries), "performance insights missing capture boundaries");

const performanceObserver = await callTool("devtools_performance_observer", {
  durationMs: 250,
  maxItems: 5,
  maxEntries: 50,
});
assert(performanceObserver.backend === "personal-chrome", `performance observer wrong backend: ${JSON.stringify(performanceObserver)}`);
assert(Array.isArray(performanceObserver.snapshot?.supportedEntryTypes), "performance observer missing supported entry types");
assert(typeof performanceObserver.summary?.entryCount === "number", "performance observer missing entry count");
assert(Array.isArray(performanceObserver.summary?.captureBoundaries), "performance observer missing capture boundaries");

const realtimeLog = await callTool("devtools_realtime_log", {
  limit: 5,
});
assert(realtimeLog.tab?.url, `Personal Chrome realtime log missing tab context: ${JSON.stringify(realtimeLog)}`);
assert(Array.isArray(realtimeLog.websockets), "Personal Chrome realtime log missing websockets array");
assert(Array.isArray(realtimeLog.eventSources), "Personal Chrome realtime log missing eventSources array");
const heapSnapshot = await callTool("devtools_heap_snapshot");
assert(heapSnapshot.notApplicable === true, `Personal Chrome heap snapshot should be structured notApplicable: ${JSON.stringify(heapSnapshot)}`);
assert(heapSnapshot.managedFallbackTool === "devtools_heap_snapshot", "Personal Chrome heap snapshot missing managed fallback guidance");

const chromeTrace = await callTool("devtools_chrome_trace", {
  durationMs: 250,
  maxEvents: 5,
  saveScreenshots: false,
});
assert(chromeTrace.tracePath, `Personal Chrome trace missing path: ${JSON.stringify(chromeTrace)}`);
assert(Array.isArray(chromeTrace.traceSummary?.layoutPaintFlameChart?.rows), `Personal Chrome trace missing layout/paint flame chart rows: ${JSON.stringify(chromeTrace.traceSummary)}`);
assert(Array.isArray(chromeTrace.traceSummary?.layoutPaintFlameChart?.captureBoundaries), `Personal Chrome trace missing layout/paint flame chart boundaries: ${JSON.stringify(chromeTrace.traceSummary)}`);
const traceQuery = await callTool("devtools_trace_query", {
  tracePath: chromeTrace.tracePath,
  limit: 5,
  contextEvents: 2,
  contextWindows: 2,
});
assert(traceQuery.backend === "personal-chrome", `Personal Chrome trace query wrong backend: ${JSON.stringify(traceQuery)}`);
assert(traceQuery.totalEvents > 0, "Personal Chrome trace query missing total event count");
assert(Array.isArray(traceQuery.events), "Personal Chrome trace query missing events array");
assert(Array.isArray(traceQuery.contextWindows), "Personal Chrome trace query missing context windows");
assert(traceQuery.recommendedDrilldowns?.some((entry) => entry.tool === "devtools_chrome_trace"), `Personal Chrome trace query missing fresh trace drilldown: ${JSON.stringify(traceQuery.recommendedDrilldowns)}`);
if (traceQuery.events.length) {
  assert(traceQuery.recommendedDrilldowns?.some((entry) => entry.tool === "devtools_trace_query" && entry.input?.tracePath === chromeTrace.tracePath), `Personal Chrome trace query missing trace-query drilldown: ${JSON.stringify(traceQuery.recommendedDrilldowns)}`);
}
assert(traceQuery.drilldown?.contextWindowBasis?.includes("same-thread"), `Personal Chrome trace query missing drilldown context basis: ${JSON.stringify(traceQuery.drilldown)}`);

const secondChromeTrace = await callTool("devtools_chrome_trace", {
  durationMs: 250,
  maxEvents: 5,
  saveScreenshots: false,
});
const traceCompare = await callTool("devtools_trace_compare", {
  beforeTracePath: chromeTrace.tracePath,
  afterTracePath: secondChromeTrace.tracePath,
  limit: 5,
});
assert(traceCompare.backend === "personal-chrome", `Personal Chrome trace compare wrong backend: ${JSON.stringify(traceCompare)}`);
assert(typeof traceCompare.deltas?.eventCount === "number", "Personal Chrome trace compare missing event delta");

const researchPack = await callTool("devtools_security_research_pack", {
  limit: 5,
  waitMs: 500,
  includeTrace: false,
  includeHar: true,
  includeApplicationExport: true,
});
assert(researchPack.backend === "personal-chrome", `Personal Chrome security research pack wrong backend: ${JSON.stringify(researchPack)}`);
assert(researchPack.summary?.evidenceBundlePath, "Personal Chrome security research pack missing bundle path");
assert(researchPack.summary?.evidenceManifestPath, "Personal Chrome security research pack missing evidence manifest path");
assert(researchPack.summary?.correlationGraphPath, "Personal Chrome security research pack missing correlation graph path");
assert(researchPack.summary?.authBoundaryReportPath, "Personal Chrome security research pack missing auth boundary report path");
assert(researchPack.summary?.workerFrameReportPath, "Personal Chrome security research pack missing worker/frame report path");
assert(researchPack.summary?.artifactFileCount >= 1, "Personal Chrome security research pack missing artifact index count");
assert(researchPack.summary?.evidenceTimelineEventCount >= 1, "Personal Chrome security research pack missing evidence timeline count");
assert(researchPack.summary?.f12ParityPanelCount >= 1, "Personal Chrome security research pack missing F12 parity count");
assert(researchPack.summary?.drilldownCount >= 3, "Personal Chrome security research pack missing drilldown count");
assert(researchPack.summary?.drilldownPlanPath, "Personal Chrome security research pack missing drilldown plan path");
assert(researchPack.summary?.researchPackPath, "Personal Chrome security research pack missing handoff path");
assert(researchPack.artifacts?.researchPack?.sha256, "Personal Chrome security research pack missing handoff hash");
assert(researchPack.agentEntryPoints?.defaultMode === "facade-first", "Personal Chrome security research pack missing agent entry points");
assert(researchPack.agentEntryPoints?.professionalPath?.includes("browser_security_pack"), "Personal Chrome security research pack missing professional agent route");
assert(researchPack.agentUsage?.defaultRoute?.some((step) => step.tool === "browser_security_pack"), "Personal Chrome security research pack missing default agent usage route");
assert(researchPack.agentUsage?.panelRoutes?.network?.some((step) => step.tool === "devtools_request_detail"), "Personal Chrome security research pack missing network panel usage route");
assert(researchPack.handoffCompleteness?.checks?.some((check) => check.name === "agentUsageRoute" && check.present), `Personal Chrome handoff completeness missing agent route check: ${JSON.stringify(researchPack.handoffCompleteness?.checks)}`);
assert(researchPack.handoffDrilldowns?.some((entry) => entry.tool === "devtools_artifact_inspect" && entry.input?.path === researchPack.summary.researchPackPath), "Personal Chrome security research pack missing handoff inspect drilldown");
assert(researchPack.parityMatrix?.backend === "personal-chrome", "Personal Chrome security research pack missing parity snapshot");
assert(researchPack.artifacts?.artifactIndex?.kinds?.["research-pack"] >= 1, `Personal Chrome security research pack artifact index missing handoff kind: ${JSON.stringify(researchPack.artifacts?.artifactIndex?.kinds)}`);
assert(researchPack.drilldownPlan?.drilldowns?.some((entry) => entry.tool === "devtools_evidence_timeline"), "Personal Chrome security research pack missing evidence timeline drilldown");
assert(researchPack.drilldownPlan?.planPath === researchPack.summary.drilldownPlanPath, "Personal Chrome security research pack drilldown path mismatch");
assert(typeof researchPack.summary?.requestCount === "number", "Personal Chrome security research pack missing request count");
const researchPackInspect = await callTool("devtools_artifact_inspect", {
  path: researchPack.summary.researchPackPath,
  maxBytes: 300000,
});
assert(researchPackInspect.researchPackHandoff?.ready === true, `Personal Chrome handoff inspect missing readiness summary: ${JSON.stringify(researchPackInspect.researchPackHandoff)}`);
assert(researchPackInspect.researchPackHandoff?.agentEntryMode === "facade-first", "Personal Chrome handoff inspect missing agent route summary");
assert(researchPackInspect.researchPackHandoff?.professionalPath?.includes("browser_security_pack"), "Personal Chrome handoff inspect missing professional facade path");
assert(researchPackInspect.researchPackHandoff?.handoffChecks?.some((check) => check.name === "agentUsageRoute" && check.present), "Personal Chrome handoff inspect missing handoff check rows");
assert(researchPackInspect.researchPackHandoff?.artifactCoverageRows?.some((row) => row.name === "har" && row.status === "present"), "Personal Chrome handoff inspect missing artifact coverage rows");
assert(researchPackInspect.researchPackHandoff?.recommendedRoute?.some((step) => step.tool === "browser_security_pack"), "Personal Chrome handoff inspect missing recommended agent route");
assert(researchPackInspect.researchPackHandoff?.panelRoutes?.network?.some((step) => step.tool === "devtools_request_detail"), "Personal Chrome handoff inspect missing network panel route");

const facadeInspect = await callTool("browser_inspect", {
  mode: "overview",
  limit: 5,
});
assert(facadeInspect.facade === "browser_inspect", `Personal Chrome browser_inspect facade marker missing: ${JSON.stringify(facadeInspect)}`);
assert(facadeInspect.result?.focus === "overview", "Personal Chrome browser_inspect did not route to agent_inspect overview");
const facadeCapture = await callTool("browser_capture", {
  action: "status",
});
assert(facadeCapture.facade === "browser_capture", `Personal Chrome browser_capture facade marker missing: ${JSON.stringify(facadeCapture)}`);
const facadeRaw = await callTool("browser_raw", {
  tool: "devtools_page_diagnostics",
  input: { limit: 5 },
});
assert(facadeRaw.facade === "browser_raw", `Personal Chrome browser_raw facade marker missing: ${JSON.stringify(facadeRaw)}`);
assert(facadeRaw.result?.page?.url, "Personal Chrome browser_raw did not return wrapped diagnostics");
const facadePack = await callTool("browser_security_pack", {
  limit: 5,
  waitMs: 500,
  includeTrace: false,
  includeHar: true,
  includeApplicationExport: true,
});
assert(facadePack.facade === "browser_security_pack", `Personal Chrome browser_security_pack facade marker missing: ${JSON.stringify(facadePack)}`);
assert(facadePack.summary?.evidenceBundlePath, "Personal Chrome browser_security_pack missing bundle path");
assert(facadePack.summary?.artifactFileCount >= 1, "Personal Chrome browser_security_pack missing artifact index count");
assert(facadePack.summary?.evidenceTimelineEventCount >= 1, "Personal Chrome browser_security_pack missing evidence timeline count");
assert(facadePack.summary?.f12ParityPanelCount >= 1, "Personal Chrome browser_security_pack missing F12 parity count");
assert(facadePack.summary?.drilldownCount >= 3, "Personal Chrome browser_security_pack missing drilldown count");
assert(facadePack.summary?.drilldownPlanPath, "Personal Chrome browser_security_pack missing drilldown plan path");
assert(facadePack.summary?.researchPackPath, "Personal Chrome browser_security_pack missing handoff path");
assert(facadePack.parityMatrix?.backend === "personal-chrome", "Personal Chrome browser_security_pack missing parity snapshot");

const captureBisect = await callTool("devtools_capture_bisect", {
  limit: 20,
  save: false,
});
assert(captureBisect.backend === "personal-chrome", `Personal Chrome capture bisect wrong backend: ${JSON.stringify(captureBisect)}`);
assert(captureBisect.buckets?.network, "Personal Chrome capture bisect missing network bucket");
assert(captureBisect.buckets?.pages, "Personal Chrome capture bisect missing page bucket");
const harCompleteness = await callTool("devtools_har_completeness", {
  limit: 20,
  includeBodies: false,
  save: false,
});
assert(harCompleteness.backend === "personal-chrome", `Personal Chrome HAR completeness wrong backend: ${JSON.stringify(harCompleteness)}`);
assert(typeof harCompleteness.entryCount === "number", "Personal Chrome HAR completeness missing entry count");
assert(harCompleteness.coverage?.bodiesIncluded && typeof harCompleteness.coverage.bodiesIncluded.present === "number", `Personal Chrome HAR completeness missing body coverage: ${JSON.stringify(harCompleteness.coverage)}`);
assert(harCompleteness.coverage?.totalTiming && typeof harCompleteness.coverage.totalTiming.present === "number", `Personal Chrome HAR completeness missing timing coverage: ${JSON.stringify(harCompleteness.coverage)}`);
assert(Array.isArray(harCompleteness.drilldownSamples?.bodyMissing), `Personal Chrome HAR completeness missing body drilldown samples: ${JSON.stringify(harCompleteness.drilldownSamples)}`);
assert(Array.isArray(harCompleteness.drilldownSamples?.timingMissing), `Personal Chrome HAR completeness missing timing drilldown samples: ${JSON.stringify(harCompleteness.drilldownSamples)}`);
assert(Array.isArray(harCompleteness.recommendedDrilldowns), `Personal Chrome HAR completeness missing recommended drilldowns: ${JSON.stringify(harCompleteness)}`);
if (
  harCompleteness.drilldownSamples.bodyMissing.length ||
  harCompleteness.drilldownSamples.timingMissing.length ||
  harCompleteness.drilldownSamples.redirects.length ||
  harCompleteness.drilldownSamples.securityMissing.length
) {
  assert(harCompleteness.recommendedDrilldowns.some((entry) => entry.tool === "devtools_request_detail"), `Personal Chrome HAR completeness missing request detail recommendation: ${JSON.stringify(harCompleteness.recommendedDrilldowns)}`);
}
assert(harCompleteness.body, "Personal Chrome HAR completeness missing body summary");
assert(harCompleteness.timing, "Personal Chrome HAR completeness missing timing summary");
const harWithBodies = await callTool("devtools_export_har", {
  limit: 20,
  includeBodies: true,
  maxBodyBytes: 2000,
});
assert(harWithBodies.bodyIndexSummary?.entryCount >= 1, `Personal Chrome HAR body index missing entries: ${JSON.stringify(harWithBodies.bodyIndexSummary)}`);
assert(Array.isArray(harWithBodies.bodyIndex), "Personal Chrome HAR body index missing array");
const savedHar = await callTool("devtools_save_har", {
  limit: 20,
  includeBodies: false,
});
assert(savedHar.harPath, "Personal Chrome saved HAR path missing");
const harArtifact = await callTool("devtools_artifact_inspect", {
  path: savedHar.harPath,
  query: "Agent Browser Runtime",
  maxBytes: 120000,
});
assert(harArtifact.backend === "personal-chrome", `Personal Chrome artifact inspect wrong backend: ${JSON.stringify(harArtifact)}`);
assert(harArtifact.exists && harArtifact.bytes > 0, `Personal Chrome artifact inspect could not read saved HAR: ${JSON.stringify(harArtifact)}`);
assert(harArtifact.json?.ok === true, `Personal Chrome artifact inspect did not parse HAR JSON: ${JSON.stringify(harArtifact.json)}`);
assert(harArtifact.json?.harEntryCount >= 1, `Personal Chrome artifact inspect missing HAR entry count: ${JSON.stringify(harArtifact.json)}`);
const artifactIndex = await callTool("devtools_artifact_index", {
  kind: "har",
  maxFiles: 20,
});
assert(artifactIndex.backend === "personal-chrome", `Personal Chrome artifact index wrong backend: ${JSON.stringify(artifactIndex)}`);
assert(artifactIndex.totalFileCount >= 1, `Personal Chrome artifact index missing files: ${JSON.stringify(artifactIndex)}`);
assert(artifactIndex.artifacts?.some((artifact) => artifact.kind === "har" && artifact.path === savedHar.harPath), `Personal Chrome artifact index missing saved HAR: ${JSON.stringify(artifactIndex.artifacts)}`);
assert(artifactIndex.latestByKind?.har?.inspectInput?.path, `Personal Chrome artifact index missing latest HAR inspect pointer: ${JSON.stringify(artifactIndex.latestByKind)}`);
assert(artifactIndex.recommendedDrilldowns?.some((entry) => entry.tool === "devtools_artifact_inspect" && entry.input?.path), `Personal Chrome artifact index missing recommended inspect drilldown: ${JSON.stringify(artifactIndex.recommendedDrilldowns)}`);
const handoffArtifactIndex = await callTool("devtools_artifact_index", {
  maxFiles: 200,
});
assert(handoffArtifactIndex.kinds?.["research-pack"] >= 1, `Personal Chrome artifact index missing research-pack kind: ${JSON.stringify(handoffArtifactIndex.kinds)}`);
assert(handoffArtifactIndex.kinds?.["drilldown-plan"] >= 1, `Personal Chrome artifact index missing drilldown-plan kind: ${JSON.stringify(handoffArtifactIndex.kinds)}`);
assert(handoffArtifactIndex.latestByKind?.["research-pack"]?.inspectInput?.path, `Personal Chrome artifact index missing latest research-pack pointer: ${JSON.stringify(handoffArtifactIndex.latestByKind)}`);
assert(handoffArtifactIndex.recommendedDrilldowns?.some((entry) => entry.tool === "devtools_artifact_inspect" && entry.input?.path === handoffArtifactIndex.latestByKind?.["research-pack"]?.path), `Personal Chrome artifact index missing latest research-pack drilldown: ${JSON.stringify(handoffArtifactIndex.recommendedDrilldowns)}`);
const artifactSearch = await callTool("devtools_artifact_search", {
  query: "Agent Browser Runtime",
  kind: "har",
  maxFiles: 20,
});
assert(artifactSearch.backend === "personal-chrome", `Personal Chrome artifact search wrong backend: ${JSON.stringify(artifactSearch)}`);
assert(artifactSearch.totalMatches >= 1, `Personal Chrome artifact search found no matches: ${JSON.stringify(artifactSearch)}`);
assert(artifactSearch.fileMatches?.some((artifact) => artifact.path === savedHar.harPath), `Personal Chrome artifact search missing saved HAR: ${JSON.stringify(artifactSearch.fileMatches)}`);
const artifactRead = await callTool("devtools_artifact_read", {
  path: savedHar.harPath,
  startLine: 1,
  lineCount: 12,
});
assert(artifactRead.backend === "personal-chrome", `Personal Chrome artifact read wrong backend: ${JSON.stringify(artifactRead)}`);
assert(artifactRead.mode === "line" && artifactRead.returnedLineCount >= 1, `Personal Chrome artifact read did not return line slice: ${JSON.stringify(artifactRead)}`);
assert(artifactRead.contentText.includes("Agent Browser Runtime"), `Personal Chrome artifact read slice missing expected content: ${artifactRead.contentText}`);
const evidenceTimeline = await callTool("devtools_evidence_timeline", {
  maxEvents: 100,
  maxArtifacts: 30,
});
assert(evidenceTimeline.backend === "personal-chrome", `Personal Chrome evidence timeline wrong backend: ${JSON.stringify(evidenceTimeline)}`);
assert(evidenceTimeline.eventCount >= 1, `Personal Chrome evidence timeline missing events: ${JSON.stringify(evidenceTimeline)}`);
assert(evidenceTimeline.events?.some((event) => event.type === "network-request"), `Personal Chrome evidence timeline missing network event: ${JSON.stringify(evidenceTimeline.events)}`);
assert(evidenceTimeline.events?.some((event) => event.type === "artifact"), `Personal Chrome evidence timeline missing artifact event: ${JSON.stringify(evidenceTimeline.events)}`);
const artifactTimeline = await callTool("devtools_evidence_timeline", {
  eventType: "artifact",
  query: "har",
  maxEvents: 20,
  maxArtifacts: 50,
});
assert(artifactTimeline.filters?.eventType === "artifact", `Personal Chrome evidence timeline filter not applied: ${JSON.stringify(artifactTimeline.filters)}`);
assert(artifactTimeline.eventCount >= 1, `Personal Chrome filtered artifact timeline missing events: ${JSON.stringify(artifactTimeline)}`);
assert(artifactTimeline.events.every((event) => event.type === "artifact"), `Personal Chrome filtered artifact timeline returned non-artifact events: ${JSON.stringify(artifactTimeline.events)}`);

const toolCatalog = await callTool("devtools_tool_catalog", { query: "auth" });
assert(toolCatalog.toolCount >= 1, "Personal Chrome tool catalog did not return auth tools");
assert(toolCatalog.tools.some((tool) => tool.name === "devtools_auth_boundary_report"), "Personal Chrome tool catalog missing auth boundary report");
assert(toolCatalog.agentEntryPoints?.defaultMode === "facade-first", "Personal Chrome tool catalog missing facade-first entry plan");
assert(toolCatalog.agentEntryPoints?.professionalPath?.includes("browser_security_pack"), "Personal Chrome tool catalog missing professional facade path");
assert(toolCatalog.agentEntryPoints?.professionalRouteSummary?.firstStep?.tool === "devtools_professional_readiness", "Personal Chrome tool catalog missing route summary first step");
assert(toolCatalog.agentEntryPoints?.professionalRouteSummary?.evidencePack?.tool === "browser_security_pack", "Personal Chrome tool catalog missing route summary evidence pack");
assert(toolCatalog.agentEntryPoints?.professionalRouteSummary?.handoffInspectTemplate?.tool === "devtools_artifact_inspect", "Personal Chrome tool catalog missing route summary handoff inspect template");
assert(toolCatalog.agentEntryPoints?.professionalRouteSummary?.firstConcreteDrilldownSources?.some((entry) => entry.includes("routeSummary")), "Personal Chrome tool catalog missing route summary drilldown source");
const toolHelp = await callTool("devtools_tool_help", { tool: "devtools_security_research_pack" });
assert(toolHelp.description, "Personal Chrome tool help missing description");
const capabilityMap = await callTool("devtools_capability_map", {});
assert(capabilityMap.backend === "personal-chrome", `Personal Chrome capability map wrong backend: ${JSON.stringify(capabilityMap)}`);
assert(capabilityMap.panels?.some((panel) => panel.category === "network"), "Personal Chrome capability map missing Network panel");
assert(capabilityMap.panels?.some((panel) => panel.category === "sources-debugger"), "Personal Chrome capability map missing Sources panel");
assert(capabilityMap.panels?.some((panel) => panel.category === "performance"), "Personal Chrome capability map missing Performance panel");
assert(capabilityMap.agentUsage?.defaultRoute?.some((step) => step.tool === "browser_security_pack"), "Personal Chrome capability map missing agent default evidence-pack route");
assert(capabilityMap.agentUsage?.panelRoutes?.network?.some((step) => step.tool === "devtools_request_detail" && step.input?.requestId), "Personal Chrome capability map missing request-detail panel route");
assert(capabilityMap.agentUsage?.panelRoutes?.evidence?.some((step) => step.tool === "devtools_artifact_inspect" && step.input?.path), "Personal Chrome capability map missing artifact inspect panel route");
const parityMatrix = await callTool("devtools_f12_parity_matrix", {});
assert(parityMatrix.backend === "personal-chrome", `Personal Chrome F12 parity matrix wrong backend: ${JSON.stringify(parityMatrix)}`);
assert(parityMatrix.rows?.some((row) => row.panel === "Network" && row.personal === "supported"), "Personal Chrome F12 parity matrix missing Network support");
assert(parityMatrix.rows?.some((row) => row.panel === "Raw CDP / Escape Hatch" && row.personal === "partial"), "Personal Chrome F12 parity matrix missing raw CDP boundary");
assert(parityMatrix.objectiveBoundaries?.some((entry) => String(entry).includes("does not classify vulnerabilities")), "Personal Chrome F12 parity matrix missing objective boundary");
const professionalReadiness = await callTool("devtools_professional_readiness", {});
assert(professionalReadiness.backend === "personal-chrome", `Personal Chrome professional readiness wrong backend: ${JSON.stringify(professionalReadiness)}`);
assert(professionalReadiness.summary?.ready === true && professionalReadiness.summary?.evidenceReady === true, `Personal Chrome professional readiness summary not ready: ${JSON.stringify(professionalReadiness.summary)}`);
assert(professionalReadiness.summary?.latestResearchPackReady === true, `Personal Chrome professional readiness summary missing research-pack readiness: ${JSON.stringify(professionalReadiness.summary)}`);
assert(professionalReadiness.summary?.latestArtifactKinds?.includes("har"), `Personal Chrome professional readiness summary missing latest artifact kinds: ${JSON.stringify(professionalReadiness.summary)}`);
assert(professionalReadiness.workflowPath?.includes("browser_security_pack"), `Personal Chrome professional readiness missing workflow path: ${JSON.stringify(professionalReadiness)}`);
assert(professionalReadiness.checks?.some((check) => check.name === "f12ParityMatrix" && check.present), `Personal Chrome professional readiness missing parity check: ${JSON.stringify(professionalReadiness.checks)}`);
assert(professionalReadiness.checks?.some((check) => check.name === "agentUsageRoute" && check.present), `Personal Chrome professional readiness missing agent usage route check: ${JSON.stringify(professionalReadiness.checks)}`);
assert(professionalReadiness.checks?.some((check) => check.name === "artifactDrilldownsReachable" && check.present), `Personal Chrome professional readiness missing artifact drilldown check: ${JSON.stringify(professionalReadiness.checks)}`);
assert(professionalReadiness.latestResearchPackHandoff?.path, "Personal Chrome professional readiness missing latest research pack handoff route");
assert(professionalReadiness.latestResearchPackHandoff?.inspect?.tool === "devtools_artifact_inspect", "Personal Chrome professional readiness missing latest handoff inspect route");
assert(professionalReadiness.latestResearchPackSummary?.handoffChecks?.some((check) => check.name === "agentUsageRoute" && check.present), `Personal Chrome professional readiness missing latest research-pack handoff summary: ${JSON.stringify(professionalReadiness.latestResearchPackSummary)}`);
assert(professionalReadiness.latestResearchPackSummary?.artifactCoverageRows?.some((row) => row.name === "har" && row.status === "present"), `Personal Chrome professional readiness missing latest research-pack artifact coverage: ${JSON.stringify(professionalReadiness.latestResearchPackSummary)}`);
assert(professionalReadiness.checks?.some((check) => check.name === "latestResearchPackSummaryReachable" && check.present), `Personal Chrome professional readiness missing latest research-pack summary check: ${JSON.stringify(professionalReadiness.checks)}`);
assert(professionalReadiness.researchPackDrilldowns?.some((entry) => entry.tool === "devtools_request_detail" && entry.input?.requestId), `Personal Chrome professional readiness missing research-pack request drilldown: ${JSON.stringify(professionalReadiness.researchPackDrilldowns)}`);
assert(professionalReadiness.checks?.some((check) => check.name === "researchPackDrilldownsReachable" && check.present), `Personal Chrome professional readiness missing research-pack drilldown check: ${JSON.stringify(professionalReadiness.checks)}`);
assert(professionalReadiness.artifactKinds?.["research-pack"] >= 1, `Personal Chrome professional readiness missing artifact kind distribution: ${JSON.stringify(professionalReadiness.artifactKinds)}`);
assert(professionalReadiness.latestArtifacts?.har?.inspect?.tool === "devtools_artifact_inspect", `Personal Chrome professional readiness missing latest HAR artifact pointer: ${JSON.stringify(professionalReadiness.latestArtifacts)}`);
assert(professionalReadiness.latestArtifacts?.["research-pack"]?.read?.tool === "devtools_artifact_read", `Personal Chrome professional readiness missing latest research-pack artifact pointer: ${JSON.stringify(professionalReadiness.latestArtifacts)}`);
assert(professionalReadiness.checks?.some((check) => check.name === "latestArtifactsReachable" && check.present), `Personal Chrome professional readiness missing latest artifacts check: ${JSON.stringify(professionalReadiness.checks)}`);
assert(professionalReadiness.evidenceEntrypoints?.correlationGraph?.inspect?.tool === "devtools_artifact_inspect", `Personal Chrome professional readiness missing correlation graph entrypoint: ${JSON.stringify(professionalReadiness.evidenceEntrypoints)}`);
assert(professionalReadiness.evidenceEntrypoints?.authBoundary?.read?.tool === "devtools_artifact_read", `Personal Chrome professional readiness missing auth boundary entrypoint: ${JSON.stringify(professionalReadiness.evidenceEntrypoints)}`);
assert(professionalReadiness.evidenceEntrypoints?.workerFrameBoundary?.read?.tool === "devtools_artifact_read", `Personal Chrome professional readiness missing worker/frame boundary entrypoint: ${JSON.stringify(professionalReadiness.evidenceEntrypoints)}`);
assert(professionalReadiness.checks?.some((check) => check.name === "evidenceEntrypointsReachable" && check.present), `Personal Chrome professional readiness missing evidence entrypoints check: ${JSON.stringify(professionalReadiness.checks)}`);
assert(professionalReadiness.routeSummary?.latestHandoffInspect?.tool === "devtools_artifact_inspect", `Personal Chrome professional readiness missing route handoff inspect: ${JSON.stringify(professionalReadiness.routeSummary)}`);
assert(professionalReadiness.routeSummary?.firstConcreteDrilldown?.tool === "devtools_request_detail", `Personal Chrome professional readiness missing route concrete request drilldown: ${JSON.stringify(professionalReadiness.routeSummary)}`);
assert(professionalReadiness.routeSummary?.artifactEntrypointCount >= 3, `Personal Chrome professional readiness missing route entrypoint count: ${JSON.stringify(professionalReadiness.routeSummary)}`);
assert(professionalReadiness.timelineTypes?.artifact >= 1 || professionalReadiness.timelineTypes?.["network-request"] >= 1, `Personal Chrome professional readiness missing timeline type distribution: ${JSON.stringify(professionalReadiness.timelineTypes)}`);
assert(professionalReadiness.f12Coverage?.panelCount >= 8, `Personal Chrome professional readiness missing F12 coverage summary: ${JSON.stringify(professionalReadiness.f12Coverage)}`);
assert(professionalReadiness.f12Coverage?.strongPanels?.includes("Network"), `Personal Chrome professional readiness missing Network strong panel: ${JSON.stringify(professionalReadiness.f12Coverage)}`);
assert(professionalReadiness.f12Coverage?.partialPanels?.includes("Performance / Memory"), `Personal Chrome professional readiness missing partial panel boundary: ${JSON.stringify(professionalReadiness.f12Coverage)}`);
assert(professionalReadiness.captureBuckets?.networkRequestCount >= 1, `Personal Chrome professional readiness missing capture bucket summary: ${JSON.stringify(professionalReadiness.captureBuckets)}`);
assert(professionalReadiness.checks?.some((check) => check.name === "captureBisectReachable" && check.present), `Personal Chrome professional readiness missing capture bisect check: ${JSON.stringify(professionalReadiness.checks)}`);
assert(professionalReadiness.harCoverage?.entryCount >= 1, `Personal Chrome professional readiness missing HAR coverage summary: ${JSON.stringify(professionalReadiness.harCoverage)}`);
assert(typeof professionalReadiness.harCoverage?.totalTiming?.ratio === "number", `Personal Chrome professional readiness missing HAR timing coverage: ${JSON.stringify(professionalReadiness.harCoverage)}`);
assert(professionalReadiness.checks?.some((check) => check.name === "harCompletenessReachable" && check.present), `Personal Chrome professional readiness missing HAR completeness check: ${JSON.stringify(professionalReadiness.checks)}`);
assert(professionalReadiness.recommendedRoute?.some((step) => step.tool === "browser_security_pack"), "Personal Chrome professional readiness missing recommended route");
assert(professionalReadiness.panelRoutes?.network?.some((step) => step.tool === "devtools_request_detail"), "Personal Chrome professional readiness missing network panel route");
assert(professionalReadiness.artifactDrilldowns?.some((entry) => entry.tool === "devtools_artifact_inspect" && entry.input?.path), "Personal Chrome professional readiness missing artifact drilldown route");
assert(professionalReadiness.nextActions?.some((entry) => entry.tool === "devtools_request_detail" && entry.input?.requestId), "Personal Chrome professional readiness missing research-pack request-detail next action");
assert(professionalReadiness.nextActions?.some((entry) => entry.tool === "devtools_artifact_read" && entry.input?.path), "Personal Chrome professional readiness missing artifact-read next action");
assert(professionalReadiness.objectiveBoundary?.includes("does not judge vulnerabilities"), "Personal Chrome professional readiness crossed objective boundary");
const workflowGuide = await callTool("devtools_workflow_guide", { task: "auth-boundary" });
assert(workflowGuide.steps?.some((step) => step.tool === "devtools_auth_boundary_report"), "Personal Chrome workflow guide missing auth boundary step");
const professionalWorkflowGuide = await callTool("devtools_workflow_guide", { task: "professional-appsec" });
assert(professionalWorkflowGuide.steps?.some((step) => step.tool === "devtools_professional_readiness"), "Personal Chrome professional workflow guide missing readiness step");
assert(professionalWorkflowGuide.routeSummaryTemplate?.firstStep?.tool === "devtools_professional_readiness", "Personal Chrome professional workflow guide missing route template first step");
assert(professionalWorkflowGuide.routeSummaryTemplate?.evidencePack?.tool === "browser_security_pack", "Personal Chrome professional workflow guide missing route template evidence pack");
assert(professionalWorkflowGuide.routeSummaryTemplate?.latestHandoffInspect?.tool === "devtools_artifact_inspect", "Personal Chrome professional workflow guide missing route template handoff inspect");

console.log("Personal Chrome smoke passed:");
console.log(`- bridge: ${baseUrl}`);
console.log(`- fixture: ${fixture.url}`);
console.log(`- active tab: ${status.tab.title || "(untitled)"} ${status.tab.url}`);
console.log(`- allowed domains: ${capabilities.domainAccess.allowedDomains.length}`);
console.log(`- layer: ${capabilities.layer}`);
console.log(`- facade tools: ${facadeInspect.facade}/${facadeCapture.facade}/${facadePack.facade}`);
console.log(`- capture bisect buckets: ${captureBisect.buckets.network.requestCount}/${captureBisect.buckets.pages.pageCount}`);
console.log(`- HAR completeness entries/body-included: ${harCompleteness.entryCount}/${harCompleteness.body.includedCount}`);
console.log(`- HAR artifact inspect: ${harArtifact.json.harEntryCount} entries`);
console.log(`- artifact index files/kinds: ${artifactIndex.totalFileCount}/${Object.keys(artifactIndex.kinds).length}`);
console.log(`- artifact search matches/files: ${artifactSearch.totalMatches}/${artifactSearch.matchedFileCount}`);
console.log(`- artifact read mode/lines: ${artifactRead.mode}/${artifactRead.returnedLineCount}`);
console.log(`- evidence timeline events/types: ${evidenceTimeline.eventCount}/${Object.keys(evidenceTimeline.byType).length}`);
console.log(`- evidence timeline filtered artifacts: ${artifactTimeline.eventCount}`);
console.log(`- capability panels: ${capabilityMap.panelCount}`);
console.log(`- F12 parity rows: ${parityMatrix.summary.panelCount}`);
console.log(`- professional readiness: ${professionalReadiness.ready}/${professionalReadiness.evidenceReady}`);
console.log(`- realtime channels ws/sse: ${realtimeLog.websocketCount}/${realtimeLog.eventSourceMessageCount}`);

fixture.server.close();
