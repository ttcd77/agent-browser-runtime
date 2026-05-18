import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocketServer } from "ws";

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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const serverPort = await freePort();
const browserPort = await freePort();
const appPort = await freePort();
const tempDir = mkdtempSync(join(tmpdir(), "agent-devtools-f12-smoke-"));
const appServer = http.createServer(async (req, res) => {
  if (req.url === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    });
    res.write("event: smoke\n");
    res.write("id: sse-1\n");
    res.write("data: AGENT_SSE_MARKER\n\n");
    setTimeout(() => res.end(), 250);
    return;
  }
  if (req.url === "/sw.js") {
    res.writeHead(200, {
      "content-type": "application/javascript",
      "service-worker-allowed": "/",
    });
    res.end(`
      self.addEventListener('install', event => {
        event.waitUntil(caches.open('agent-f12-smoke-cache').then(cache => cache.put('/cached.txt', new Response('cached smoke'))));
        self.skipWaiting();
      });
      self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', event => {});
    `);
    return;
  }
  if (req.url === "/echo") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      method: req.method,
      headers: req.headers,
      body,
      bodyBytes: Buffer.byteLength(body, "utf8"),
    }));
    return;
  }
  if (req.url === "/redirect-start") {
    res.writeHead(302, { location: "/redirect-end", "cache-control": "no-store" });
    res.end("redirecting");
    return;
  }
  if (req.url === "/redirect-end") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, marker: "agent-f12-redirect-end" }));
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html>
    <title>Application Smoke</title>
    <script>
      localStorage.setItem('agent-f12-local', 'local-value');
      sessionStorage.setItem('agent-f12-session', 'session-value');
      document.cookie = 'agent_f12_cookie=plain; path=/; SameSite=Lax';
      document.cookie = 'agent_f12_chips=partitioned; path=/; Secure; SameSite=None; Partitioned';
      window.__chipsCookieAttempt = {
        name: 'agent_f12_chips',
        attempted: true,
        documentCookieVisible: document.cookie.includes('agent_f12_chips='),
      };
      window.__agentFetchEchoFromFixture = function __agentFetchEchoFromFixture() {
        return fetch('/echo', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-smoke-original': 'yes' },
          body: JSON.stringify({ hello: 'world', source: 'fixture-function' })
        }).then(response => response.text());
      };
      window.__idbReady = new Promise((resolve) => {
        const open = indexedDB.open('agent-f12-smoke-db', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('records', { keyPath: 'id' });
        open.onerror = () => resolve('idb-error');
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('records', 'readwrite');
          tx.objectStore('records').put({ id: 'one', value: 'indexeddb smoke' });
          tx.oncomplete = () => { db.close(); resolve('idb-ready'); };
          tx.onerror = () => { db.close(); resolve('idb-tx-error'); };
        };
      });
      window.__swReady = navigator.serviceWorker
        ? navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(() => 'ready').catch(error => String(error))
        : Promise.resolve('unsupported');
      Promise.all([window.__idbReady, window.__swReady]).then(value => window.__appReady = value);
    </script>
    <h1>Application Smoke</h1>`);
});
const wsServer = new WebSocketServer({ server: appServer, path: "/ws" });
wsServer.on("connection", (socket) => {
  socket.send("AGENT_WS_SERVER_HELLO");
  socket.on("message", (message) => socket.send(`AGENT_WS_ECHO:${message.toString()}`));
});
await new Promise((resolve) => appServer.listen(appPort, "127.0.0.1", resolve));
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
  await callTool(baseUrl, "browser_navigate", {
    profile: "default",
    url: "https://example.com",
    waitMs: 800,
  });
  await callTool(baseUrl, "devtools_capture_start", {
    profile: "default",
    clear: true,
    label: "f12-smoke",
  });
  await callTool(baseUrl, "devtools_hard_reload", {
    profile: "default",
    waitMs: 800,
  });

  const security = await callTool(baseUrl, "devtools_security_summary", { profile: "default" });
  assert(security.page?.url?.startsWith("https://example.com"), "security summary did not inspect example.com");
  const backendCapabilities = await callTool(baseUrl, "devtools_backend_capabilities", { profile: "default" });
  assert(backendCapabilities.backend === "managed-cdp", `backend capabilities reported wrong backend: ${JSON.stringify(backendCapabilities)}`);
  assert(backendCapabilities.domainAccess?.expectedBroaderThanChromeDebugger === true, "backend capabilities missing managed CDP domain access marker");
  const protocolSchema = await callTool(baseUrl, "devtools_protocol_schema", { domain: "Network", query: "getResponseBody", limit: 5 });
  assert(protocolSchema.backend === "managed-cdp", `protocol schema wrong backend: ${JSON.stringify(protocolSchema)}`);
  assert(protocolSchema.domains?.some((domain) => domain.domain === "Network"), "protocol schema missing Network domain");
  assert(protocolSchema.domains?.[0]?.commands?.some((command) => command.method === "Network.getResponseBody"), "protocol schema missing Network.getResponseBody command");
  const browserCdp = await callTool(baseUrl, "devtools_browser_cdp_command", { method: "Browser.getVersion" });
  assert(browserCdp.result?.product, `browser-process CDP command missing Browser.getVersion product: ${JSON.stringify(browserCdp)}`);
  const browserVersion = await callTool(baseUrl, "devtools_browser_version");
  assert(browserVersion.result?.product, `browser version missing product: ${JSON.stringify(browserVersion)}`);
  const browserTargets = await callTool(baseUrl, "devtools_browser_targets");
  assert(browserTargets.targetCount >= 1, `browser targets missing targets: ${JSON.stringify(browserTargets)}`);
  const systemInfo = await callTool(baseUrl, "devtools_system_info");
  assert(systemInfo.result?.gpu || systemInfo.result?.modelName || systemInfo.result, `system info missing result: ${JSON.stringify(systemInfo)}`);

  const diagnostics = await callTool(baseUrl, "devtools_page_diagnostics", {
    profile: "default",
    limit: 5,
  });
  assert(diagnostics.page?.url?.startsWith("https://example.com"), "page diagnostics did not inspect example.com");
  assert(diagnostics.network?.requestCount > 0, "page diagnostics returned no network requests");

  const networkSummary = await callTool(baseUrl, "devtools_network_summary", {
    profile: "default",
    limit: 5,
  });
  assert(networkSummary.requestCount > 0, "network summary returned no requests");
  assert(networkSummary.recommendedDrilldowns?.some((entry) => entry.tool === "devtools_request_detail"), `network summary missing request detail drilldown: ${JSON.stringify(networkSummary.recommendedDrilldowns)}`);
  const networkTimeline = await callTool(baseUrl, "devtools_network_timeline", {
    profile: "default",
    limit: 5,
  });
  assert(networkTimeline.timeline?.length > 0, "network timeline did not return requests");
  assert("initiatorType" in networkTimeline.timeline[0], "network timeline missing initiatorType");
  const detailRequest = networkTimeline.timeline.find((entry) => entry.requestId)?.requestId;
  const requestDetail = await callTool(baseUrl, "devtools_request_detail", {
    profile: "default",
    requestId: detailRequest,
  });
  assert(requestDetail.detail?.requestId === detailRequest, "request detail did not return the requested entry");
  assert("initiatorSummary" in requestDetail.detail, "request detail missing initiator summary");
  assert(requestDetail.detail?.lifecycleFlags && typeof requestDetail.detail.lifecycleFlags === "object", "request detail missing lifecycle flags");
  assert(requestDetail.detail?.requestHeaders && typeof requestDetail.detail.requestHeaders === "object", "request detail missing headers");
  const issuesLog = await callTool(baseUrl, "devtools_issues_log", {
    profile: "default",
    reload: false,
    waitMs: 100,
    limit: 5,
  });
  assert(Array.isArray(issuesLog.issues), "issues log did not return an issues array");

  const accessibility = await callTool(baseUrl, "devtools_accessibility_snapshot", {
    profile: "default",
    maxNodes: 40,
  });
  assert(accessibility.nodeCount > 0, "accessibility snapshot returned no nodes");

  const domSnapshot = await callTool(baseUrl, "devtools_dom_snapshot", {
    profile: "default",
    computedStyles: ["display", "color"],
  });
  assert(domSnapshot.documentCount > 0, "DOMSnapshot returned no documents");
  assert(domSnapshot.stringCount > 0, "DOMSnapshot returned no string table");
  const domSearch = await callTool(baseUrl, "devtools_dom_search", {
    profile: "default",
    query: "Example Domain",
    maxResults: 5,
  });
  assert(domSearch.resultCount > 0, "DOM search did not find Example Domain");
  assert(domSearch.results?.some((entry) => String(entry.outerHTML || "").includes("Example Domain")), "DOM search result missing expected outerHTML");

  const trace = await callTool(baseUrl, "devtools_chrome_trace", {
    profile: "default",
    durationMs: 500,
    maxEvents: 5,
    maxScreenshots: 3,
  });
  assert(trace.traceTextBytes > 0, "Chrome trace was empty");
  assert(trace.tracePath, "Chrome trace path missing");
  assert(trace.traceSummary?.eventCount > 0, "Chrome trace summary missing events");
  assert(Array.isArray(trace.traceSummary?.durationByPhase), "Chrome trace summary missing durationByPhase");
  assert(Array.isArray(trace.traceSummary?.topDurations), "Chrome trace summary missing topDurations");
  assert(Array.isArray(trace.traceSummary?.renderingTimeline?.rows), "Chrome trace summary missing rendering timeline rows");
  assert(Array.isArray(trace.traceSummary?.renderingTimeline?.captureBoundaries), "Chrome trace rendering timeline missing capture boundaries");
  assert(Array.isArray(trace.traceSummary?.layoutPaintFlameChart?.rows), "Chrome trace summary missing layout/paint flame chart rows");
  assert(Array.isArray(trace.traceSummary?.layoutPaintFlameChart?.captureBoundaries), "Chrome trace layout/paint flame chart missing capture boundaries");
  assert(Array.isArray(trace.traceScreenshots), "Chrome trace did not return screenshot frame evidence array");

  const traceQuery = await callTool(baseUrl, "devtools_trace_query", {
    profile: "default",
    tracePath: trace.tracePath,
    category: "devtools.timeline",
    limit: 5,
    contextEvents: 2,
    contextWindows: 2,
  });
  assert(traceQuery.backend === "managed-cdp", `trace query wrong backend: ${JSON.stringify(traceQuery)}`);
  assert(traceQuery.totalEvents > 0, "trace query missing total event count");
  assert(Array.isArray(traceQuery.events), "trace query missing events array");
  assert(Array.isArray(traceQuery.contextWindows), "trace query missing context windows");
  assert(traceQuery.recommendedDrilldowns?.some((entry) => entry.tool === "devtools_chrome_trace"), `trace query missing fresh trace drilldown: ${JSON.stringify(traceQuery.recommendedDrilldowns)}`);
  if (traceQuery.events.length) {
    assert(traceQuery.recommendedDrilldowns?.some((entry) => entry.tool === "devtools_trace_query" && entry.input?.tracePath === trace.tracePath), `trace query missing trace-query drilldown: ${JSON.stringify(traceQuery.recommendedDrilldowns)}`);
  }
  assert(traceQuery.drilldown?.contextWindowBasis?.includes("same-thread"), `trace query missing drilldown context basis: ${JSON.stringify(traceQuery.drilldown)}`);
  assert(Array.isArray(traceQuery.captureBoundaries), "trace query missing capture boundaries");

  const secondTrace = await callTool(baseUrl, "devtools_chrome_trace", {
    profile: "default",
    durationMs: 250,
    maxEvents: 5,
    maxScreenshots: 1,
  });
  const traceCompare = await callTool(baseUrl, "devtools_trace_compare", {
    profile: "default",
    beforeTracePath: trace.tracePath,
    afterTracePath: secondTrace.tracePath,
    limit: 5,
  });
  assert(traceCompare.backend === "managed-cdp", `trace compare wrong backend: ${JSON.stringify(traceCompare)}`);
  assert(typeof traceCompare.deltas?.eventCount === "number", "trace compare missing event delta");
  assert(Array.isArray(traceCompare.deltas?.names), "trace compare missing name deltas");

  const performanceInsights = await callTool(baseUrl, "devtools_performance_insights", {
    profile: "default",
    durationMs: 250,
    includeChromeTrace: true,
    maxItems: 5,
    maxEvents: 5,
    maxScreenshots: 1,
  });
  assert(performanceInsights.backend === "managed-cdp", `performance insights wrong backend: ${JSON.stringify(performanceInsights)}`);
  assert(performanceInsights.insights?.source?.performanceEntries === true, "performance insights missing performance entry source marker");
  assert(typeof performanceInsights.insights?.resourceCount === "number", "performance insights missing resource count");
  assert(Array.isArray(performanceInsights.insights?.captureBoundaries), "performance insights missing capture boundaries");

  const performanceObserver = await callTool(baseUrl, "devtools_performance_observer", {
    profile: "default",
    durationMs: 250,
    maxItems: 5,
    maxEntries: 50,
  });
  assert(performanceObserver.backend === "managed-cdp", `performance observer wrong backend: ${JSON.stringify(performanceObserver)}`);
  assert(Array.isArray(performanceObserver.snapshot?.supportedEntryTypes), "performance observer missing supported entry types");
  assert(typeof performanceObserver.summary?.entryCount === "number", "performance observer missing entry count");
  assert(Array.isArray(performanceObserver.summary?.entryTypeCoverage), "performance observer missing entry type coverage");
  assert(performanceObserver.summary.entryTypeCoverage.some((row) => row.type === "navigation" && row.supported === true), "performance observer missing navigation coverage row");
  assert(performanceObserver.summary.entryTypeCoverage.every((row) => typeof row.count === "number"), "performance observer entry type coverage missing counts");
  assert(Array.isArray(performanceObserver.summary?.captureBoundaries), "performance observer missing capture boundaries");

  const cpuProfile = await callTool(baseUrl, "devtools_cpu_profile", {
    profile: "default",
    durationMs: 300,
    maxNodes: 10,
    triggerExpression: "(() => { let total = 0; for (let i = 0; i < 50000; i++) total += Math.sqrt(i); return total; })()",
  });
  assert(cpuProfile.cpuProfilePath, "CPU profile path missing");
  assert(cpuProfile.summary?.nodeCount > 0, "CPU profile summary missing nodes");

  const coverage = await callTool(baseUrl, "devtools_coverage_snapshot", {
    profile: "default",
    durationMs: 500,
    maxEntries: 5,
  });
  assert(coverage.js?.scriptCount >= 0, "coverage JS result missing");
  assert(coverage.css?.ruleCount >= 0, "coverage CSS result missing");

  const sourceMarker = "AGENT_SOURCE_SEARCH_MARKER";
  const sourceMap = Buffer.from(JSON.stringify({
    version: 3,
    file: "source-search-smoke.min.js",
    sources: ["source-search-smoke.ts"],
    names: [sourceMarker],
    mappings: "AAAA",
    sourcesContent: [`export const ${sourceMarker} = "source-search-smoke";`],
  })).toString("base64");
  const sourcePage = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
    <title>source search smoke</title>
    <style>
      #agent-listener-button { color: rgb(12, 34, 56); padding: 7px; border: 1px solid rgb(1, 2, 3); }
      #agent-listener-button:hover { color: rgb(111, 22, 33); }
    </style>
    <script>
      window.${sourceMarker}="source-search-smoke";function ${sourceMarker.toLowerCase()}(){return window.${sourceMarker};}
      console.error("AGENT_CONSOLE_ERROR_MARKER", window.${sourceMarker});
      setTimeout(() => { throw new Error("AGENT_CONSOLE_THROW_MARKER " + window.${sourceMarker}); }, 0);
      addEventListener("DOMContentLoaded", () => {
        document.getElementById("agent-listener-button").addEventListener("click", function agentListenerSmoke() {
          window.AGENT_EVENT_LISTENER_MARKER = true;
        });
        const frame = document.getElementById("agent-frame");
        const marker = "FRAME_" + "SECRET_MARKER";
        frame.contentDocument.open();
        frame.contentDocument.write("<!doctype html><title>frame smoke</title><style>#frame-action{color:rgb(45, 67, 89);}</style><h2 id='frame-marker'>" + marker + "</h2><button id='frame-action' aria-label='Frame Action'>Inside Frame</button><input id='frame-input' aria-label='Frame Input'>");
        frame.contentDocument.close();
        frame.contentDocument.getElementById("frame-action").addEventListener("click", () => {
          frame.contentDocument.body.dataset.frameClicked = "yes";
        });
        const host = document.getElementById("agent-shadow-host");
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = "<button id='shadow-action'>Shadow Action</button><span>SHADOW_SECRET_MARKER</span>";
      });
      //# sourceMappingURL=data:application/json;base64,${sourceMap}
    </script>
    <h1>Source Search Smoke</h1>
    <button id="agent-listener-button">Listener Smoke</button>
    <div id="agent-shadow-host"></div>
    <iframe id="agent-frame"></iframe>
    <iframe id="opaque-frame" sandbox srcdoc="<p>Opaque frame</p>"></iframe>`)}`;
  await callTool(baseUrl, "browser_navigate", {
    profile: "default",
    url: sourcePage,
    waitMs: 500,
  });
  const sourceSearch = await callTool(baseUrl, "devtools_sources_search", {
    profile: "default",
    query: sourceMarker,
    waitMs: 500,
    maxMatches: 5,
  });
  assert(sourceSearch.matchCount > 0, "source search did not find the marker script");
  assert(sourceSearch.recommendedDrilldowns?.some((entry) => entry.tool === "devtools_source_get" && entry.input?.scriptId), `source search missing source_get drilldown: ${JSON.stringify(sourceSearch.recommendedDrilldowns)}`);
  assert(sourceSearch.recommendedDrilldowns?.some((entry) => entry.tool === "devtools_source_pretty_print" && entry.input?.scriptId), `source search missing pretty-print drilldown: ${JSON.stringify(sourceSearch.recommendedDrilldowns)}`);
  assert(sourceSearch.captureBoundaries?.some((entry) => String(entry).includes("parsed")), `source search missing capture boundaries: ${JSON.stringify(sourceSearch.captureBoundaries)}`);
  const frameSearch = await callTool(baseUrl, "devtools_dom_search", {
    profile: "default",
    query: "FRAME_SECRET_MARKER",
    includeFrames: true,
    maxResults: 10,
  });
  const framePath = frameSearch.results?.find((entry) => entry.frame?.path?.includes("frame"))?.frame?.path;
  assert(framePath, `iframe DOM search did not report frame context: ${JSON.stringify(frameSearch)}`);
  const frameStyles = await callTool(baseUrl, "devtools_css_styles", {
    profile: "default",
    selector: "#frame-action",
    framePath,
    maxRules: 20,
  });
  assert(frameStyles.found === true, `iframe css styles did not find frame button: ${JSON.stringify(frameStyles)}`);
  assert(frameStyles.computedStyle?.computedStyle?.some((entry) => entry.name === "color" && entry.value.includes("45")), "iframe css styles missing computed frame color");
  const frameListeners = await callTool(baseUrl, "devtools_event_listeners", {
    profile: "default",
    selector: "#frame-action",
    framePath,
  });
  assert(frameListeners.listeners?.some((listener) => listener.type === "click"), `iframe event listeners missing click handler: ${JSON.stringify(frameListeners)}`);
  const frameClick = await callTool(baseUrl, "devtools_click", {
    profile: "default",
    selector: "#frame-action",
    framePath,
    waitMs: 100,
  });
  assert(frameClick.ok === true, `iframe click failed: ${JSON.stringify(frameClick)}`);
  const frameType = await callTool(baseUrl, "devtools_type", {
    profile: "default",
    selector: "#frame-input",
    framePath,
    text: "typed-in-frame",
    waitMs: 100,
  });
  assert(frameType.ok === true, `iframe type failed: ${JSON.stringify(frameType)}`);
  const frameState = await callTool(baseUrl, "devtools_eval", {
    profile: "default",
    expression: "(() => ({ clicked: document.getElementById('agent-frame').contentDocument.body.dataset.frameClicked, value: document.getElementById('agent-frame').contentDocument.getElementById('frame-input').value }))()",
  });
  const frameStateValue = frameState.page || frameState.result;
  assert(frameStateValue?.clicked === "yes" && frameStateValue?.value === "typed-in-frame", `iframe action state mismatch: ${JSON.stringify(frameState)}`);
  const frameTree = await callTool(baseUrl, "devtools_frame_tree", {
    profile: "default",
  });
  assert(frameTree.frameAccess?.some((frame) => frame.path === framePath && frame.accessible === true), `frame tree missing accessible same-origin frame: ${JSON.stringify(frameTree)}`);
  assert(frameTree.frameAccess?.some((frame) => frame.id === "opaque-frame" && frame.accessible === false), `frame tree missing inaccessible sandbox frame boundary: ${JSON.stringify(frameTree)}`);
  assert(frameTree.shadowRootCount >= 1, `frame tree missing shadow root boundary summary: ${JSON.stringify(frameTree)}`);
  assert(frameTree.shadowRoots?.some((root) => root.host?.id === "agent-shadow-host" && root.sampleText.includes("SHADOW_SECRET_MARKER")), `frame tree missing shadow root sample evidence: ${JSON.stringify(frameTree.shadowRoots)}`);
  assert(Array.isArray(frameTree.captureBoundaries) && frameTree.captureBoundaries.some((entry) => entry.includes("Closed shadow roots")), `frame tree missing shadow/root boundary notes: ${JSON.stringify(frameTree)}`);
  const prettySource = await callTool(baseUrl, "devtools_source_pretty_print", {
    profile: "default",
    query: sourceMarker,
    waitMs: 500,
    maxChars: 20000,
  });
  assert(prettySource.prettyText.includes(sourceMarker), "pretty print lost source marker");
  assert(prettySource.prettyText.includes("\n"), "pretty print did not add line breaks");
  const sourceMapMetadata = await callTool(baseUrl, "devtools_source_map_metadata", {
    profile: "default",
    query: sourceMarker,
    waitMs: 500,
  });
  const sourceMapResult = sourceMapMetadata.results.find((entry) => entry.metadata?.kind === "data-url");
  assert(sourceMapResult?.metadata?.map?.sourcesCount >= 1, "source map metadata did not parse inline source map");
  const sourceMapSources = await callTool(baseUrl, "devtools_source_map_sources", {
    profile: "default",
    query: sourceMarker,
    waitMs: 500,
    maxSources: 5,
  });
  const originalSource = sourceMapSources.results
    ?.flatMap((entry) => entry.sources || [])
    .find((entry) => entry.source === "source-search-smoke.ts");
  assert(originalSource?.saved === true && originalSource?.path, `source map original source was not saved: ${JSON.stringify(sourceMapSources)}`);
  const sourceMapSourceGet = await callTool(baseUrl, "devtools_source_map_source_get", {
    profile: "default",
    path: originalSource.path,
    maxChars: 2000,
  });
  assert(sourceMapSourceGet.contentText?.includes(sourceMarker), "source map source_get lost original source marker");
  assert(sourceMapSourceGet.source?.sha256, "source map source_get did not return artifact hash");
  const consoleLog = await callTool(baseUrl, "devtools_console_log", {
    profile: "default",
    reload: true,
    waitMs: 800,
    limit: 20,
  });
  assert(consoleLog.counts?.exceptions >= 1, "console log did not capture thrown exception");
  const markerException = consoleLog.exceptions.find((entry) => JSON.stringify(entry).includes("AGENT_CONSOLE_THROW_MARKER")) || consoleLog.exceptions[0];
  const frame = markerException?.details?.stackTrace?.callFrames?.[0] || markerException?.details;
  assert(frame?.scriptId, `exception stack frame missing scriptId: ${JSON.stringify(markerException)}`);
  const consoleSourceContext = await callTool(baseUrl, "devtools_console_source_context", {
    profile: "default",
    scriptId: frame.scriptId,
    lineNumber: frame.lineNumber,
    columnNumber: frame.columnNumber,
    contextLines: 20,
    reload: false,
  });
  assert(consoleSourceContext.lines?.some((line) => line.text.includes("AGENT_CONSOLE_THROW_MARKER")), "console source context missing throw marker");
  const eventListeners = await callTool(baseUrl, "devtools_event_listeners", {
    profile: "default",
    selector: "#agent-listener-button",
  });
  assert(eventListeners.listeners?.some((listener) => listener.type === "click"), `event listeners missing click handler: ${JSON.stringify(eventListeners)}`);
  const cssStyles = await callTool(baseUrl, "devtools_css_styles", {
    profile: "default",
    selector: "#agent-listener-button",
    maxRules: 20,
  });
  assert(cssStyles.found === true, "css styles did not find smoke button");
  assert(cssStyles.boxModel?.model, "css styles missing box model");
  assert(cssStyles.computedStyle?.computedStyle?.some((entry) => entry.name === "color"), "css styles missing computed color");
  const hoverStyles = await callTool(baseUrl, "devtools_css_styles", {
    profile: "default",
    selector: "#agent-listener-button",
    forcePseudoClasses: ["hover"],
    maxRules: 20,
  });
  const hoverColor = hoverStyles.computedStyle?.computedStyle?.find((entry) => entry.name === "color")?.value || "";
  assert(hoverStyles.forcePseudoState?.applied === true, `css pseudo-state was not applied: ${JSON.stringify(hoverStyles)}`);
  assert(hoverStyles.forcedPseudoClasses?.includes("hover"), "css styles did not report forced :hover");
  assert(hoverColor.includes("111") && hoverColor.includes("22") && hoverColor.includes("33"), `forced :hover did not affect computed color: ${hoverColor}`);
  const mutationWatch = await callTool(baseUrl, "devtools_dom_mutation_watch", {
    profile: "default",
    selector: "#agent-listener-button",
    durationMs: 300,
    maxEvents: 10,
    triggerExpression: "document.querySelector('#agent-listener-button').setAttribute('data-agent-watch', 'changed'); document.querySelector('#agent-listener-button').appendChild(document.createElement('span')).textContent = ' mutation';",
  });
  assert(mutationWatch.found === true, "DOM mutation watch did not find smoke button");
  assert(mutationWatch.eventCount >= 2, `DOM mutation watch missed attribute/child mutations: ${JSON.stringify(mutationWatch)}`);
  const rawCdp = await callTool(baseUrl, "devtools_cdp_command", {
    profile: "default",
    method: "Runtime.evaluate",
    params: {
      expression: "window.AGENT_SOURCE_SEARCH_MARKER",
      returnByValue: true,
    },
  });
  assert(rawCdp.result?.result?.value === "source-search-smoke", `raw CDP command did not return marker: ${JSON.stringify(rawCdp)}`);
  const debuggerPause = await callTool(baseUrl, "devtools_debugger_control", {
    profile: "default",
    action: "pauseOnExpression",
    expression: "const agentDebuggerSmoke = 42; debugger; agentDebuggerSmoke;",
    waitMs: 500,
    autoResume: true,
    maxFrames: 5,
    maxScopes: 3,
    maxProperties: 10,
    evaluateExpressions: ["agentDebuggerSmoke", "agentDebuggerSmoke + 1"],
    maxEvaluateExpressions: 5,
  });
  assert(debuggerPause.paused?.callFrameCount >= 1, `debugger control did not capture paused frames: ${JSON.stringify(debuggerPause)}`);
  const debuggerEvaluations = debuggerPause.paused.callFrames?.[0]?.evaluations || [];
  assert(debuggerEvaluations.some((entry) => entry.expression === "agentDebuggerSmoke" && entry.result?.value === 42), `debugger control did not evaluate local variable: ${JSON.stringify(debuggerPause)}`);
  assert(debuggerEvaluations.some((entry) => entry.expression === "agentDebuggerSmoke + 1" && entry.result?.value === 43), `debugger control did not evaluate expression in paused frame: ${JSON.stringify(debuggerPause)}`);
  assert(debuggerPause.autoResumed === true, "debugger control did not auto-resume after pauseOnExpression");
  await callTool(baseUrl, "devtools_cdp_command", {
    profile: "default",
    method: "Runtime.evaluate",
    params: {
      expression: `eval('globalThis.agentBreakpointTarget = function agentBreakpointTarget() {\\n  const agentBreakpointScopeMarker = "AGENT_BREAKPOINT_SCOPE_MARKER";\\n  return agentBreakpointScopeMarker;\\n};\\n//# sourceURL=agent-breakpoint-smoke.js')`,
      returnByValue: true,
    },
  });
  const breakpointProbe = await callTool(baseUrl, "devtools_debugger_control", {
    profile: "default",
    action: "probeBreakpointByUrl",
    urlRegex: "agent-breakpoint-smoke\\.js$",
    lineNumber: 2,
    triggerExpression: "agentBreakpointTarget()",
    waitMs: 600,
    autoResume: true,
    maxFrames: 5,
    maxScopes: 5,
    maxProperties: 20,
  });
  assert(breakpointProbe.commandResult?.breakpointId, `breakpoint probe did not create breakpoint: ${JSON.stringify(breakpointProbe)}`);
  assert(breakpointProbe.paused?.hitBreakpoints?.includes(breakpointProbe.commandResult.breakpointId), `breakpoint probe did not hit expected breakpoint: ${JSON.stringify(breakpointProbe)}`);
  assert(JSON.stringify(breakpointProbe.paused).includes("AGENT_BREAKPOINT_SCOPE_MARKER"), "breakpoint probe did not capture local scope marker");
  assert(breakpointProbe.autoResumed === true, "breakpoint probe did not auto-resume");
  const tokenFlow = await callTool(baseUrl, "devtools_token_flow_trace", {
    profile: "default",
    durationMs: 600,
    maxEvents: 20,
    triggerExpression: `
      try { localStorage.setItem('agent-flow-token', 'token=flow_secret_1234567890'); } catch {}
      try { sessionStorage.setItem('agent-flow-session', 'Bearer flow_header_1234567890'); } catch {}
      fetch('data:text/plain,token=flow_fetch_1234567890', { headers: { Authorization: 'Bearer flow_auth_1234567890' } }).catch(() => {});
      const xhr = new XMLHttpRequest();
      xhr.open('GET', 'data:text/plain,token=flow_xhr_1234567890');
      xhr.setRequestHeader('X-Agent-Auth', 'Bearer flow_xhr_header_1234567890');
      xhr.send();
    `,
  });
  assert(tokenFlow.trace?.eventCount >= 3, `token flow trace did not capture enough events: ${JSON.stringify(tokenFlow)}`);
  assert(tokenFlow.trace?.tokenLikeEventCount >= 2, `token flow trace did not detect token-like events: ${JSON.stringify(tokenFlow)}`);
  const memorySnapshot = await callTool(baseUrl, "devtools_memory_snapshot", {
    profile: "default",
  });
  assert(memorySnapshot.heap?.usedSize >= 0 || memorySnapshot.heap?.error, "memory snapshot missing heap usage or explicit heap error");
  assert(memorySnapshot.domCounters?.nodes >= 0 || memorySnapshot.domCounters?.error, "memory snapshot missing DOM counters or explicit DOM counter error");
  assert(Array.isArray(memorySnapshot.performanceMetrics), "memory snapshot missing performance metrics array");
  const heapSnapshot = await callTool(baseUrl, "devtools_heap_snapshot", {
    profile: "default",
    reportProgress: false,
  });
  assert(heapSnapshot.heapSnapshotPath, `heap snapshot path missing: ${JSON.stringify(heapSnapshot)}`);
  assert(heapSnapshot.heapSnapshotBytes > 0, "heap snapshot was empty");
  assert(heapSnapshot.chunkCount > 0, "heap snapshot did not report chunks");
  assert(heapSnapshot.meta?.nodeCount === null || heapSnapshot.meta?.nodeCount >= 0, "heap snapshot metadata missing node count");
  const coverageDetail = await callTool(baseUrl, "devtools_coverage_detail", {
    profile: "default",
    durationMs: 800,
    maxEntries: 10,
    maxRangesPerEntry: 10,
    maxSnippetChars: 500,
    includeSource: true,
    reload: true,
  });
  assert(coverageDetail.js?.scriptCount >= 0, "coverage detail JS result missing");
  assert(coverageDetail.css?.ruleCount >= 0, "coverage detail CSS result missing");
  assert(JSON.stringify(coverageDetail.js?.entries || []).includes(sourceMarker), "coverage detail did not include source marker snippets");
  const globalSearch = await callTool(baseUrl, "devtools_global_search", {
    profile: "default",
    query: sourceMarker,
    waitMs: 500,
    maxMatches: 30,
  });
  assert(globalSearch.matchCount > 0, "global search did not find the source/storage marker");
  assert(globalSearch.results.some((entry) => entry.category === "sources" || entry.category === "application"), "global search did not include expected evidence categories");
  const evidenceBundle = await callTool(baseUrl, "devtools_evidence_bundle", {
    profile: "default",
    sourceLimit: 10,
    networkLimit: 5,
    includeHar: true,
    includeTokenScan: true,
    includeTokenFlow: true,
    tokenFlowTriggerExpression: "fetch('data:text/plain,token=bundle_flow_1234567890', { headers: { Authorization: 'Bearer bundle_flow_header_1234567890' } }).catch(() => {});",
  });
  assert(evidenceBundle.bundlePath, "evidence bundle path missing");
  assert(evidenceBundle.summary?.sourceCount >= 0, "evidence bundle summary missing source count");
  assert(evidenceBundle.summary?.harEntryCount >= 1, "evidence bundle missing HAR entries");
  assert(evidenceBundle.summary?.tokenFlowTokenLikeEventCount >= 1, "evidence bundle missing token flow evidence");

  const researchPack = await callTool(baseUrl, "devtools_security_research_pack", {
    profile: "default",
    limit: 5,
    waitMs: 500,
    includeTrace: true,
    includeHar: true,
    includeApplicationExport: true,
  });
  assert(researchPack.backend === "managed-cdp", `security research pack wrong backend: ${JSON.stringify(researchPack)}`);
  assert(researchPack.summary?.evidenceBundlePath, "security research pack missing bundle path");
  assert(researchPack.summary?.evidenceManifestPath, "security research pack missing evidence manifest path");
  assert(researchPack.summary?.correlationGraphPath, "security research pack missing correlation graph path");
  assert(researchPack.summary?.authBoundaryReportPath, "security research pack missing auth boundary report path");
  assert(researchPack.summary?.workerFrameReportPath, "security research pack missing worker/frame report path");
  assert(researchPack.summary?.artifactFileCount >= 1, "security research pack missing artifact index count");
  assert(researchPack.summary?.evidenceTimelineEventCount >= 1, "security research pack missing evidence timeline count");
  assert(researchPack.summary?.f12ParityPanelCount >= 1, "security research pack missing F12 parity count");
  assert(researchPack.summary?.drilldownCount >= 3, "security research pack missing drilldown plan count");
  assert(researchPack.summary?.capture?.enabled === true && typeof researchPack.summary?.capture?.trafficCount === "number", `security research pack missing capture summary: ${JSON.stringify(researchPack.summary?.capture)}`);
  assert(researchPack.summary?.handoffReady === true, `security research pack handoff not ready: ${JSON.stringify(researchPack.summary?.handoffMissing)}`);
  assert(researchPack.summary?.artifactCoverageReady === true, `security research pack artifact coverage not ready: ${JSON.stringify(researchPack.summary?.artifactCoverageMissing)}`);
  assert(researchPack.summary?.drilldownPlanPath, "security research pack missing drilldown plan path");
  assert(researchPack.summary?.researchPackPath, "security research pack missing handoff path");
  assert(researchPack.artifacts?.researchPack?.sha256, "security research pack missing handoff hash");
  assert(researchPack.handoffDrilldowns?.some((entry) => entry.tool === "devtools_artifact_inspect" && entry.input?.path === researchPack.summary.researchPackPath), "security research pack missing handoff inspect drilldown");
  assert(researchPack.parityMatrix?.summary?.strongestBackend === "managed-cdp", "security research pack missing Managed Browser parity snapshot");
  assert(researchPack.artifacts?.artifactIndex?.kinds?.["research-pack"] >= 1, `security research pack artifact index missing handoff kind: ${JSON.stringify(researchPack.artifacts?.artifactIndex?.kinds)}`);
  assert(researchPack.drilldownPlan?.drilldowns?.some((entry) => entry.tool === "devtools_evidence_timeline"), "security research pack missing evidence timeline drilldown");
  assert(researchPack.drilldownPlan?.planPath === researchPack.summary.drilldownPlanPath, "security research pack drilldown path mismatch");
  assert(researchPack.nextTools?.includes("devtools_artifact_index"), "security research pack nextTools missing artifact index");
  assert(typeof researchPack.summary?.requestCount === "number", "security research pack missing request count");
  assert(Array.isArray(researchPack.captureBoundaries), "security research pack missing capture boundaries");
  const toolCatalog = await callTool(baseUrl, "devtools_tool_catalog", {
    profile: "default",
    query: "auth",
  });
  assert(toolCatalog.toolCount >= 1, "tool catalog did not return auth tools");
  assert(toolCatalog.tools.some((tool) => tool.name === "devtools_auth_boundary_report"), "tool catalog missing auth boundary report");
  assert(toolCatalog.agentEntryPoints?.defaultMode === "facade-first", "tool catalog missing facade-first entry plan");
  assert(toolCatalog.agentEntryPoints?.professionalPath?.includes("browser_security_pack"), "tool catalog missing professional facade path");
  const toolHelp = await callTool(baseUrl, "devtools_tool_help", {
    profile: "default",
    tool: "devtools_security_research_pack",
  });
  assert(toolHelp.parameters?.properties, "tool help missing parameter schema");
  const capabilityMap = await callTool(baseUrl, "devtools_capability_map", {
    profile: "default",
  });
  assert(capabilityMap.backend === "managed-cdp", `capability map wrong backend: ${JSON.stringify(capabilityMap)}`);
  assert(capabilityMap.panels?.some((panel) => panel.category === "network" && panel.firstPass.includes("devtools_network_summary")), "capability map missing Network first-pass tools");
  assert(capabilityMap.panels?.some((panel) => panel.category === "sources-debugger"), "capability map missing Sources panel");
  assert(capabilityMap.panels?.some((panel) => panel.category === "performance"), "capability map missing Performance panel");
  assert(capabilityMap.agentUsage?.defaultRoute?.some((step) => step.tool === "browser_security_pack"), "capability map missing agent default evidence-pack route");
  assert(capabilityMap.agentUsage?.panelRoutes?.network?.some((step) => step.tool === "devtools_request_detail" && step.input?.requestId), "capability map missing request-detail panel route");
  assert(capabilityMap.agentUsage?.panelRoutes?.evidence?.some((step) => step.tool === "devtools_artifact_inspect" && step.input?.path), "capability map missing artifact inspect panel route");
  const parityMatrix = await callTool(baseUrl, "devtools_f12_parity_matrix", {
    profile: "default",
  });
  assert(parityMatrix.backend === "managed-cdp", `F12 parity matrix wrong backend: ${JSON.stringify(parityMatrix)}`);
  assert(parityMatrix.rows?.some((row) => row.panel === "Network" && row.managed === "supported"), "F12 parity matrix missing supported Network row");
  assert(parityMatrix.rows?.some((row) => row.panel === "Raw CDP / Escape Hatch" && row.managed === "supported"), "F12 parity matrix missing Managed raw CDP support");
  assert(parityMatrix.objectiveBoundaries?.some((entry) => String(entry).includes("does not classify vulnerabilities")), "F12 parity matrix missing objective boundary");
  const workflowGuide = await callTool(baseUrl, "devtools_workflow_guide", {
    profile: "default",
    task: "auth-boundary",
  });
  assert(workflowGuide.steps?.some((step) => step.tool === "devtools_auth_boundary_report"), "workflow guide missing auth boundary step");

  await callTool(baseUrl, "browser_navigate", {
    profile: "default",
    url: `http://127.0.0.1:${appPort}/`,
    waitMs: 1200,
  });
  const serviceWorker = await callTool(baseUrl, "devtools_service_worker_summary", {
    profile: "default",
  });
  assert(serviceWorker.page?.secureContext === true, "localhost service worker smoke should run in a secure context");
  assert(serviceWorker.registrationCount >= 1, `service worker registration missing: ${JSON.stringify(serviceWorker)}`);
  assert(serviceWorker.cacheCount >= 1, `service worker cache missing: ${JSON.stringify(serviceWorker)}`);
  const serviceWorkerDetail = await callTool(baseUrl, "devtools_service_worker_detail", {
    profile: "default",
    maxScriptChars: 10000,
    maxCacheEntries: 20,
  });
  assert(serviceWorkerDetail.registrationCount >= 1, `service worker detail registration missing: ${JSON.stringify(serviceWorkerDetail)}`);
  assert(serviceWorkerDetail.scriptCount >= 1, `service worker detail script missing: ${JSON.stringify(serviceWorkerDetail)}`);
  assert(JSON.stringify(serviceWorkerDetail.page?.scripts || []).includes("install"), "service worker detail script content did not include expected install handler");
  assert(serviceWorkerDetail.page?.cacheStorage?.caches?.some((cache) => cache.entryCount >= 1), "service worker detail cache entries missing");
  const workerFrameDeepDive = await callTool(baseUrl, "devtools_worker_frame_deep_dive", {
    profile: "default",
    save: true,
  });
  assert(workerFrameDeepDive.reportPath, "worker/frame deep dive report path missing");
  assert(workerFrameDeepDive.summary?.frameCount >= 1, "worker/frame deep dive frame count missing");

  await callTool(baseUrl, "devtools_capture_start", {
    profile: "default",
    clear: false,
    label: "replay-smoke",
  });
  await callTool(baseUrl, "devtools_eval", {
    profile: "default",
    expression: `
      window.__agentRealtimeDone = new Promise((resolve) => {
        const seen = { wsOpen: false, wsEcho: false, sse: false };
        const finish = () => {
          if (seen.wsEcho && seen.sse) resolve(seen);
        };
        const ws = new WebSocket('ws://127.0.0.1:${appPort}/ws');
        ws.addEventListener('open', () => { seen.wsOpen = true; ws.send('AGENT_WS_MARKER'); });
        ws.addEventListener('message', (event) => {
          if (String(event.data).includes('AGENT_WS_ECHO')) {
            seen.wsEcho = true;
            try { ws.close(); } catch {}
            finish();
          }
        });
        const sse = new EventSource('/events');
        sse.addEventListener('smoke', (event) => {
          if (String(event.data).includes('AGENT_SSE_MARKER')) {
            seen.sse = true;
            try { sse.close(); } catch {}
            finish();
          }
        });
        setTimeout(() => resolve(seen), 1500);
      })`,
  });
  await callTool(baseUrl, "devtools_eval", {
    profile: "default",
    expression: "window.__agentRealtimeDone",
    awaitPromise: true,
  });
  const realtimeLog = await callTool(baseUrl, "devtools_realtime_log", {
    profile: "default",
    limit: 20,
  });
  assert(realtimeLog.websocketCount >= 1, `realtime log missing WebSocket evidence: ${JSON.stringify(realtimeLog)}`);
  assert(JSON.stringify(realtimeLog.websockets || []).includes("AGENT_WS_MARKER"), "realtime log missing WebSocket frame payload");
  assert(realtimeLog.eventSourceMessageCount >= 1, `realtime log missing EventSource evidence: ${JSON.stringify(realtimeLog)}`);
  assert(JSON.stringify(realtimeLog.eventSources || []).includes("AGENT_SSE_MARKER"), "realtime log missing EventSource payload");

  await callTool(baseUrl, "devtools_eval", {
    profile: "default",
    expression: `window.__agentFetchEchoFromFixture()`,
    awaitPromise: true,
  });
  await callTool(baseUrl, "devtools_eval", {
    profile: "default",
    expression: `fetch('/redirect-start').then(response => response.json()).then(value => { window.__agentRedirectSmoke = value; return value; })`,
    awaitPromise: true,
  });
  const redirectSummary = await callTool(baseUrl, "devtools_network_summary", {
    profile: "default",
    limit: 50,
  });
  const redirectRow = redirectSummary.redirects?.find((row) => row.chainLength >= 1 && String(row.url || "").includes("/redirect-end"));
  assert(redirectRow, `network summary missing redirect chain evidence: ${JSON.stringify(redirectSummary.redirects)}`);
  assert(redirectSummary.recommendedDrilldowns?.some((entry) => entry.label === "Inspect latest redirect chain" && entry.input?.requestId === redirectRow.requestId), `network summary missing redirect drilldown: ${JSON.stringify(redirectSummary.recommendedDrilldowns)}`);
  const redirectDetail = await callTool(baseUrl, "devtools_request_detail", {
    profile: "default",
    requestId: redirectRow.requestId,
  });
  assert(redirectDetail.detail?.redirectChain?.some((entry) => String(entry.url || "").includes("/redirect-start") && Number(entry.status) === 302), `request detail missing redirect start evidence: ${JSON.stringify(redirectDetail.detail?.redirectChain)}`);
  const filteredRedirects = await callTool(baseUrl, "devtools_network_log", {
    profile: "default",
    redirected: true,
    status_min: 200,
    status_max: 299,
    resource_type: "Fetch",
    response_header: { name: "content-type", valueContains: "json" },
    sort_by: "status",
    limit: 10,
  });
  assert(filteredRedirects.requests?.some((entry) => entry.requestId === redirectRow.requestId), `network log filters missed redirect row: ${JSON.stringify(filteredRedirects)}`);
  const filteredTimeline = await callTool(baseUrl, "devtools_network_timeline", {
    profile: "default",
    url_contains: "/redirect-end",
    redirected: true,
    sort_by: "start",
    sort_dir: "asc",
    limit: 10,
  });
  assert(filteredTimeline.timeline?.some((entry) => entry.requestId === redirectRow.requestId), `network timeline filters missed redirect row: ${JSON.stringify(filteredTimeline)}`);
  const requestGraph = await callTool(baseUrl, "devtools_request_correlation_graph", {
    profile: "default",
    limit: 200,
  });
  assert(requestGraph.edges?.some((edge) => edge.type === "redirects-to"), `request correlation graph missing redirect edge: ${JSON.stringify(requestGraph.edges)}`);
  const replayTraffic = await callTool(baseUrl, "devtools_network_log", {
    profile: "default",
    limit: 20,
  });
  const echoRequest = (replayTraffic.entries || replayTraffic.requests || []).find((entry) => String(entry.url || "").endsWith("/echo"));
  assert(echoRequest?.requestId, `echo request was not captured for replay: ${JSON.stringify(replayTraffic)}`);
  const echoDetail = await callTool(baseUrl, "devtools_request_detail", {
    profile: "default",
    requestId: echoRequest.requestId,
  });
  assert(echoDetail.detail?.initiatorSummary?.stackDepth >= 1, `echo request detail missing initiator stack depth: ${JSON.stringify(echoDetail.detail?.initiatorSummary)}`);
  assert(echoDetail.detail?.initiatorSourceContext, `echo request detail missing initiator source context: ${JSON.stringify(echoDetail.detail)}`);
  if (echoDetail.detail.initiatorSourceContext.available) {
    assert(echoDetail.detail.initiatorSourceContext.lines?.some((line) => line.text.includes("__agentFetchEchoFromFixture")), `echo initiator source context missing fixture function: ${JSON.stringify(echoDetail.detail.initiatorSourceContext)}`);
  }
  const initiatorGraph = await callTool(baseUrl, "devtools_request_correlation_graph", {
    profile: "default",
    limit: 200,
  });
  assert(initiatorGraph.nodes?.some((node) => node.type === "initiator-frame"), `request correlation graph missing initiator stack frames: ${JSON.stringify(initiatorGraph.nodes)}`);
  const formReplay = await callTool(baseUrl, "devtools_request_replay", {
    profile: "default",
    requestId: echoRequest.requestId,
    headers: {
      Host: "example.invalid",
      "Content-Type": null,
      "X-Smoke-Replay": "form",
    },
    form: { answer: 42, mode: "form" },
  });
  assert(formReplay.replayRequest?.bodyKind === "form", `form replay bodyKind mismatch: ${JSON.stringify(formReplay.replayRequest)}`);
  assert(formReplay.replayRequest?.skippedHeaderNames?.includes("Host"), "form replay did not report skipped forbidden Host header");
  assert(formReplay.replayRequest?.removedHeaders?.includes("Content-Type"), "form replay did not report removed Content-Type header");
  assert(formReplay.replayBoundary?.replayLayer === "browser-fetch", `form replay missing browser-fetch boundary: ${JSON.stringify(formReplay.replayBoundary)}`);
  assert(formReplay.replayBoundary?.headerHandling?.skippedHeaderNames?.includes("Host"), `form replay boundary missing skipped Host header: ${JSON.stringify(formReplay.replayBoundary)}`);
  assert(formReplay.replayBoundary?.captureBoundaries?.some((line) => line.includes("not raw socket-level replay")), `form replay boundary missing raw-socket note: ${JSON.stringify(formReplay.replayBoundary)}`);
  assert(formReplay.response?.status === 200, `form replay failed: ${JSON.stringify(formReplay.response)}`);
  assert(String(formReplay.response?.bodyText || "").includes("answer=42"), "form replay response did not include encoded form body");
  const multipartReplay = await callTool(baseUrl, "devtools_request_replay", {
    profile: "default",
    requestId: echoRequest.requestId,
    headers: {
      "Content-Type": "text/plain",
      "X-Smoke-Replay": "multipart",
    },
    multipart: {
      fields: { field: "field-value" },
      files: [{ field: "upload", filename: "smoke.txt", type: "text/plain", content: "file-value" }],
    },
  });
  assert(multipartReplay.replayRequest?.bodyKind === "multipart", `multipart replay bodyKind mismatch: ${JSON.stringify(multipartReplay.replayRequest)}`);
  assert(multipartReplay.replayRequest?.contentTypeNote, "multipart replay did not report browser boundary Content-Type handling");
  assert(String(multipartReplay.response?.bodyText || "").includes("field-value"), "multipart replay response did not include field body");
  const batchReplay = await callTool(baseUrl, "devtools_request_replay_batch", {
    profile: "default",
    requestId: echoRequest.requestId,
    variants: [
      { label: "json-variant", json: { hello: "batch" } },
      { label: "form-variant", headers: { "Content-Type": null }, form: { answer: 7, mode: "batch" } },
    ],
  });
  assert(batchReplay.variantCount === 2, `batch replay variant count mismatch: ${JSON.stringify(batchReplay)}`);
  assert(batchReplay.results?.[0]?.response?.status === 200, `batch replay first variant failed: ${JSON.stringify(batchReplay.results?.[0])}`);
  assert(batchReplay.results?.[0]?.responseDiff?.replayStatus === 200, `batch replay missing response diff: ${JSON.stringify(batchReplay.results?.[0])}`);
  assert(batchReplay.results?.[0]?.replayBoundary?.replayLayer === "browser-fetch", `batch replay missing boundary: ${JSON.stringify(batchReplay.results?.[0])}`);
  assert(batchReplay.results?.[1]?.responseDiff?.bodyComparable === true, `batch replay second variant missing body comparison: ${JSON.stringify(batchReplay.results?.[1])}`);

  const applicationExport = await callTool(baseUrl, "devtools_application_export", {
    profile: "default",
    maxIndexedDbRecords: 50,
    maxCacheEntries: 50,
  });
  assert(applicationExport.exportPath, "application export path missing");
  assert(applicationExport.exportBytes > 0, "application export was empty");
  assert(applicationExport.indexedDbDatabaseCount >= 1, `application export missing IndexedDB: ${JSON.stringify(applicationExport)}`);
  assert(applicationExport.cacheCount >= 1, `application export missing CacheStorage: ${JSON.stringify(applicationExport)}`);
  const indexedDbList = await callTool(baseUrl, "devtools_indexeddb_list", {
    profile: "default",
    maxDatabases: 20,
  });
  assert(indexedDbList.page?.ok === true, `IndexedDB list failed: ${JSON.stringify(indexedDbList)}`);
  const smokeDb = indexedDbList.page?.databases?.find((db) => db.name === "agent-f12-smoke-db");
  assert(smokeDb?.objectStores?.some((store) => store.name === "records" && store.recordCount >= 1), `IndexedDB list missing smoke store/count: ${JSON.stringify(indexedDbList.page)}`);
  const indexedDbRead = await callTool(baseUrl, "devtools_indexeddb_read", {
    profile: "default",
    database: "agent-f12-smoke-db",
    store: "records",
    limit: 10,
  });
  assert(indexedDbRead.page?.ok === true, `IndexedDB read failed: ${JSON.stringify(indexedDbRead)}`);
  assert(indexedDbRead.page?.records?.some((record) => record.value?.value === "indexeddb smoke"), `IndexedDB read missing smoke record: ${JSON.stringify(indexedDbRead)}`);
  const cacheStorageList = await callTool(baseUrl, "devtools_cache_storage_list", {
    profile: "default",
    maxCaches: 20,
    maxEntries: 20,
  });
  assert(cacheStorageList.page?.ok === true, `CacheStorage list failed: ${JSON.stringify(cacheStorageList)}`);
  const smokeCache = cacheStorageList.page?.caches?.find((cache) => cache.name === "agent-f12-smoke-cache");
  assert(smokeCache?.entries?.some((entry) => String(entry.url).endsWith("/cached.txt") && entry.status === 200), `CacheStorage list missing smoke entry: ${JSON.stringify(cacheStorageList.page)}`);
  const cacheEntry = await callTool(baseUrl, "devtools_cache_entry_get", {
    profile: "default",
    cacheName: "agent-f12-smoke-cache",
    url: `http://127.0.0.1:${appPort}/cached.txt`,
  });
  assert(cacheEntry.page?.ok === true, `Cache entry read failed: ${JSON.stringify(cacheEntry)}`);
  assert(String(cacheEntry.page?.bodyText || "").includes("cached smoke"), `Cache entry body missing smoke text: ${JSON.stringify(cacheEntry)}`);
  const applicationSearch = await callTool(baseUrl, "devtools_global_search", {
    profile: "default",
    query: "indexeddb smoke",
    includeNetwork: false,
    includeSources: false,
    includeStorage: true,
    maxMatches: 10,
  });
  assert(applicationSearch.results?.some((entry) => entry.category === "application" && entry.source === "application-export"), `global search did not inspect Application export records: ${JSON.stringify(applicationSearch)}`);

  const cookieSummary = await callTool(baseUrl, "devtools_cookie_summary", {
    profile: "default",
  });
  assert(cookieSummary.summary?.cookieCount >= 1, `cookie summary missing test cookie: ${JSON.stringify(cookieSummary)}`);
  assert(cookieSummary.summary?.scriptReadableCount >= 1, `cookie summary missing script-readable count: ${JSON.stringify(cookieSummary)}`);
  const storageOrigin = await callTool(baseUrl, "devtools_storage_origin_summary", {
    profile: "default",
  });
  assert(storageOrigin.page?.origin === `http://127.0.0.1:${appPort}`, `storage origin mismatch: ${JSON.stringify(storageOrigin.page)}`);
  assert(Array.isArray(storageOrigin.frames) && storageOrigin.frames.length >= 1, "storage origin summary missing frames");
  assert(storageOrigin.storageBoundarySummary?.frameCount >= 1, `storage boundary summary missing frame count: ${JSON.stringify(storageOrigin)}`);
  assert(storageOrigin.storageBoundarySummary?.originCount >= 1, `storage boundary summary missing origin count: ${JSON.stringify(storageOrigin)}`);
  assert(typeof storageOrigin.storageBoundarySummary?.quotaUsageBytes === "number", `storage boundary summary missing quota usage bytes: ${JSON.stringify(storageOrigin)}`);
  assert(storageOrigin.storageBoundarySummary?.quotaByOrigin && typeof storageOrigin.storageBoundarySummary.quotaByOrigin === "object", `storage boundary summary missing quota by origin: ${JSON.stringify(storageOrigin)}`);
  assert(typeof storageOrigin.storageBucketSummary?.supported === "boolean", `storage bucket summary missing support flag: ${JSON.stringify(storageOrigin)}`);
  assert(typeof storageOrigin.storageBucketSummary?.bucketCount === "number", `storage bucket summary missing bucket count: ${JSON.stringify(storageOrigin)}`);
  assert(Array.isArray(storageOrigin.captureBoundaries), `storage origin summary missing capture boundaries: ${JSON.stringify(storageOrigin)}`);
  assert(storageOrigin.cookiePartitionSummary?.cookieCount >= 1, `cookie partition summary missing cookie count: ${JSON.stringify(storageOrigin)}`);
  assert(typeof storageOrigin.cookiePartitionSummary?.partitionMetadataExposed === "boolean", `cookie partition summary missing metadata flag: ${JSON.stringify(storageOrigin)}`);
  const chipsAttempt = await callTool(baseUrl, "devtools_eval", {
    profile: "default",
    expression: "window.__chipsCookieAttempt",
    returnByValue: true,
  });
  const chipsAttemptValue = chipsAttempt.result?.result?.value || chipsAttempt.result?.value || chipsAttempt.result;
  assert(chipsAttemptValue?.attempted === true, `CHIPS fixture did not attempt cookie write: ${JSON.stringify(chipsAttempt)}`);
  assert(storageOrigin.page?.documentCookieNames?.includes("agent_f12_chips") === Boolean(chipsAttemptValue?.documentCookieVisible), `document cookie names do not match CHIPS fixture visibility: ${JSON.stringify(storageOrigin.page)}`);
  const chipsCookie = storageOrigin.cookiePartitions?.find((cookie) => cookie.name === "agent_f12_chips");
  if (chipsCookie) {
    assert(chipsCookie?.name === "agent_f12_chips", `CHIPS cookie was visible to document.cookie but missing from backend cookie evidence: ${JSON.stringify(storageOrigin.cookiePartitions)}`);
  }

  const signalSummary = await callTool(baseUrl, "devtools_signal_summary", {
    profile: "default",
  });
  assert(signalSummary.signalCount >= 1, `signal summary did not report any signals: ${JSON.stringify(signalSummary)}`);
  assert(signalSummary.signals.some((finding) => String(finding.id).startsWith("cookie.")), `signal summary missing cookie signal: ${JSON.stringify(signalSummary)}`);

  const agentOverview = await callTool(baseUrl, "agent_inspect", {
    profile: "default",
    focus: "overview",
    limit: 5,
  });
  assert(agentOverview.backend === "managed-cdp", `agent_inspect reported wrong backend: ${JSON.stringify(agentOverview)}`);
  assert(agentOverview.evidence?.backendCapabilities?.backend === "managed-cdp", "agent_inspect overview missing backend capabilities");
  assert(agentOverview.evidence?.diagnostics, "agent_inspect overview missing diagnostics evidence");
  assert(Array.isArray(agentOverview.nextTools) && agentOverview.nextTools.length >= 1, "agent_inspect overview missing nextTools");
  assert(agentOverview.toolPlan?.firstPass?.length >= 1, "agent_inspect overview missing toolPlan");
  assert(agentOverview.completeness?.status, "agent_inspect overview missing completeness status");

  const agentSearch = await callTool(baseUrl, "agent_inspect", {
    profile: "default",
    focus: "search",
    query: sourceMarker,
    limit: 10,
  });
  assert(agentSearch.evidence?.search?.matchCount > 0, `agent_inspect search did not find marker: ${JSON.stringify(agentSearch)}`);

  const facadeOpen = await callTool(baseUrl, "browser_open", {
    profile: "default",
    url: `http://127.0.0.1:${appPort}/`,
    waitMs: 500,
  });
  assert(facadeOpen.facade === "browser_open", `browser_open facade marker missing: ${JSON.stringify(facadeOpen)}`);
  assert(facadeOpen.diagnostics?.page?.url?.startsWith(`http://127.0.0.1:${appPort}/`), "browser_open did not return diagnostics for the opened page");
  const facadeInspect = await callTool(baseUrl, "browser_inspect", {
    profile: "default",
    mode: "overview",
    limit: 5,
  });
  assert(facadeInspect.facade === "browser_inspect", `browser_inspect facade marker missing: ${JSON.stringify(facadeInspect)}`);
  assert(facadeInspect.result?.focus === "overview", "browser_inspect did not route to agent_inspect overview");
  const facadeCapture = await callTool(baseUrl, "browser_capture", {
    profile: "default",
    action: "status",
  });
  assert(facadeCapture.facade === "browser_capture", `browser_capture facade marker missing: ${JSON.stringify(facadeCapture)}`);
  const facadeRaw = await callTool(baseUrl, "browser_raw", {
    tool: "devtools_page_diagnostics",
    input: { profile: "default", limit: 5 },
  });
  assert(facadeRaw.facade === "browser_raw", `browser_raw facade marker missing: ${JSON.stringify(facadeRaw)}`);
  assert(facadeRaw.result?.page?.url, "browser_raw did not return wrapped devtools_page_diagnostics evidence");
  const facadePack = await callTool(baseUrl, "browser_security_pack", {
    profile: "default",
    limit: 5,
    waitMs: 500,
    includeTrace: false,
    includeHar: true,
    includeApplicationExport: true,
  });
  assert(facadePack.facade === "browser_security_pack", `browser_security_pack facade marker missing: ${JSON.stringify(facadePack)}`);
  assert(facadePack.summary?.evidenceBundlePath, "browser_security_pack missing evidence bundle path");

  const captureBisect = await callTool(baseUrl, "devtools_capture_bisect", {
    profile: "default",
    limit: 20,
  });
  assert(captureBisect.backend === "managed-cdp", `capture bisect wrong backend: ${JSON.stringify(captureBisect)}`);
  assert(captureBisect.buckets?.network?.requestCount >= 1, `capture bisect missing network bucket: ${JSON.stringify(captureBisect)}`);
  assert(captureBisect.buckets?.pages?.pageCount >= 1, `capture bisect missing page bucket: ${JSON.stringify(captureBisect)}`);
  assert(captureBisect.bisectPath, "capture bisect did not save an artifact");

  const savedHar = await callTool(baseUrl, "devtools_save_har", {
    profile: "default",
    limit: 20,
  });
  assert(savedHar.harPath, "saved HAR path missing");
  assert(savedHar.harBytes > 0, "saved HAR was empty");
  const harArtifact = await callTool(baseUrl, "devtools_artifact_inspect", {
    path: savedHar.harPath,
    query: "Agent Browser Runtime",
    maxBytes: 120000,
  });
  assert(harArtifact.backend === "managed-cdp", `artifact inspect wrong backend: ${JSON.stringify(harArtifact)}`);
  assert(harArtifact.exists && harArtifact.bytes > 0, `artifact inspect could not read saved HAR: ${JSON.stringify(harArtifact)}`);
  assert(harArtifact.json?.ok === true, `artifact inspect did not parse HAR JSON: ${JSON.stringify(harArtifact.json)}`);
  assert(harArtifact.json?.harEntryCount >= 1, `artifact inspect missing HAR entry count: ${JSON.stringify(harArtifact.json)}`);
  assert(harArtifact.matchCount >= 1, `artifact inspect did not find query match: ${JSON.stringify(harArtifact.matches)}`);
  const artifactIndex = await callTool(baseUrl, "devtools_artifact_index", {
    profile: "default",
    kind: "har",
    maxFiles: 20,
  });
  assert(artifactIndex.backend === "managed-cdp", `artifact index wrong backend: ${JSON.stringify(artifactIndex)}`);
  assert(artifactIndex.totalFileCount >= 1, `artifact index missing files: ${JSON.stringify(artifactIndex)}`);
  assert(artifactIndex.artifacts?.some((artifact) => artifact.kind === "har" && artifact.path === savedHar.harPath), `artifact index missing saved HAR: ${JSON.stringify(artifactIndex.artifacts)}`);
  assert(artifactIndex.latestByKind?.har?.inspectInput?.path, `artifact index missing latest HAR inspect pointer: ${JSON.stringify(artifactIndex.latestByKind)}`);
  assert(artifactIndex.recommendedDrilldowns?.some((entry) => entry.tool === "devtools_artifact_inspect" && entry.input?.path), `artifact index missing recommended inspect drilldown: ${JSON.stringify(artifactIndex.recommendedDrilldowns)}`);
  const handoffArtifactIndex = await callTool(baseUrl, "devtools_artifact_index", {
    profile: "default",
    maxFiles: 200,
  });
  assert(handoffArtifactIndex.latestByKind?.["research-pack"]?.inspectInput?.path, `artifact index missing latest research-pack pointer: ${JSON.stringify(handoffArtifactIndex.latestByKind)}`);
  assert(handoffArtifactIndex.recommendedDrilldowns?.some((entry) => entry.tool === "devtools_artifact_inspect" && entry.input?.path === handoffArtifactIndex.latestByKind?.["research-pack"]?.path), `artifact index missing latest research-pack drilldown: ${JSON.stringify(handoffArtifactIndex.recommendedDrilldowns)}`);
  const artifactSearch = await callTool(baseUrl, "devtools_artifact_search", {
    profile: "default",
    query: "Agent Browser Runtime",
    kind: "har",
    maxFiles: 20,
  });
  assert(artifactSearch.backend === "managed-cdp", `artifact search wrong backend: ${JSON.stringify(artifactSearch)}`);
  assert(artifactSearch.totalMatches >= 1, `artifact search found no matches: ${JSON.stringify(artifactSearch)}`);
  assert(artifactSearch.fileMatches?.some((artifact) => artifact.path === savedHar.harPath), `artifact search missing saved HAR: ${JSON.stringify(artifactSearch.fileMatches)}`);
  const artifactRead = await callTool(baseUrl, "devtools_artifact_read", {
    path: savedHar.harPath,
    startLine: 1,
    lineCount: 12,
  });
  assert(artifactRead.backend === "managed-cdp", `artifact read wrong backend: ${JSON.stringify(artifactRead)}`);
  assert(artifactRead.mode === "line" && artifactRead.returnedLineCount >= 1, `artifact read did not return line slice: ${JSON.stringify(artifactRead)}`);
  assert(artifactRead.contentText.includes("Agent Browser Runtime"), `artifact read slice missing expected content: ${artifactRead.contentText}`);
  const evidenceTimeline = await callTool(baseUrl, "devtools_evidence_timeline", {
    profile: "default",
    maxEvents: 100,
    maxArtifacts: 30,
  });
  assert(evidenceTimeline.backend === "managed-cdp", `evidence timeline wrong backend: ${JSON.stringify(evidenceTimeline)}`);
  assert(evidenceTimeline.eventCount >= 1, `evidence timeline missing events: ${JSON.stringify(evidenceTimeline)}`);
  assert(evidenceTimeline.events?.some((event) => event.type === "network-request"), `evidence timeline missing network event: ${JSON.stringify(evidenceTimeline.events)}`);
  assert(evidenceTimeline.events?.some((event) => event.type === "artifact"), `evidence timeline missing artifact event: ${JSON.stringify(evidenceTimeline.events)}`);
  const artifactTimeline = await callTool(baseUrl, "devtools_evidence_timeline", {
    profile: "default",
    eventType: "artifact",
    query: "har",
    maxEvents: 20,
    maxArtifacts: 50,
  });
  assert(artifactTimeline.filters?.eventType === "artifact", `evidence timeline filter not applied: ${JSON.stringify(artifactTimeline.filters)}`);
  assert(artifactTimeline.eventCount >= 1, `filtered artifact timeline missing events: ${JSON.stringify(artifactTimeline)}`);
  assert(artifactTimeline.events.every((event) => event.type === "artifact"), `filtered artifact timeline returned non-artifact events: ${JSON.stringify(artifactTimeline.events)}`);

  const harWithBodies = await callTool(baseUrl, "devtools_export_har", {
    profile: "default",
    limit: 20,
    includeBodies: true,
    maxBodyBytes: 2000,
  });
  const bodyEntries = harWithBodies.har?.log?.entries?.filter((entry) => entry.response?.content?._bodyIncluded) || [];
  assert(bodyEntries.length >= 1, `HAR body export did not include any response bodies: ${JSON.stringify(harWithBodies.har?.log?.entries || [])}`);
  assert(harWithBodies.bodyIndexSummary?.includedCount >= 1, `HAR body index missing included bodies: ${JSON.stringify(harWithBodies.bodyIndexSummary)}`);
  assert(harWithBodies.bodyIndex?.some((entry) => entry.bodyIncluded && entry.bodySource), `HAR body index missing body source handles: ${JSON.stringify(harWithBodies.bodyIndex)}`);
  assert((harWithBodies.har?.log?.entries || []).some((entry) => "_timingPhases" in entry && "_durationMs" in entry), "HAR export missing timing phase extensions");
  const harCompleteness = await callTool(baseUrl, "devtools_har_completeness", {
    profile: "default",
    limit: 20,
    includeBodies: true,
    maxBodyBytes: 2000,
  });
  assert(harCompleteness.backend === "managed-cdp", `HAR completeness wrong backend: ${JSON.stringify(harCompleteness)}`);
  assert(harCompleteness.entryCount >= 1, "HAR completeness missing entries");
  assert(typeof harCompleteness.coverage?.bodiesIncluded?.ratio === "number", `HAR completeness missing body coverage ratio: ${JSON.stringify(harCompleteness.coverage)}`);
  assert(typeof harCompleteness.coverage?.totalTiming?.ratio === "number", `HAR completeness missing timing coverage ratio: ${JSON.stringify(harCompleteness.coverage)}`);
  assert(Array.isArray(harCompleteness.drilldownSamples?.bodyMissing), `HAR completeness missing body drilldown samples: ${JSON.stringify(harCompleteness.drilldownSamples)}`);
  assert(Array.isArray(harCompleteness.drilldownSamples?.timingMissing), `HAR completeness missing timing drilldown samples: ${JSON.stringify(harCompleteness.drilldownSamples)}`);
  assert(Array.isArray(harCompleteness.recommendedDrilldowns), `HAR completeness missing recommended drilldowns: ${JSON.stringify(harCompleteness)}`);
  if (harCompleteness.drilldownSamples.bodyMissing.length || harCompleteness.drilldownSamples.timingMissing.length || harCompleteness.drilldownSamples.redirects.length || harCompleteness.drilldownSamples.securityMissing.length) {
    assert(harCompleteness.recommendedDrilldowns.some((entry) => entry.tool === "devtools_request_detail"), `HAR completeness missing request detail recommendation: ${JSON.stringify(harCompleteness.recommendedDrilldowns)}`);
  }
  assert(harCompleteness.body?.includedCount >= 1, `HAR completeness missing included bodies: ${JSON.stringify(harCompleteness.body)}`);
  assert(harCompleteness.timing?.entriesWithTotalTime >= 1, `HAR completeness missing timing evidence: ${JSON.stringify(harCompleteness.timing)}`);
  assert(harCompleteness.reportPath, "HAR completeness did not save a report");

  console.log("F12 smoke passed:");
  console.log(`- security page: ${security.page.url}`);
  console.log(`- diagnostics page: ${diagnostics.page.url}`);
  console.log(`- network requests: ${networkSummary.requestCount}`);
  console.log(`- network timeline rows: ${networkTimeline.timeline.length}`);
  console.log(`- capture bisect: ${captureBisect.buckets.network.requestCount} requests -> ${captureBisect.bisectPath}`);
  console.log(`- HAR artifact inspect: ${harArtifact.json.harEntryCount} entries / ${harArtifact.matchCount} matches`);
  console.log(`- artifact index files/kinds: ${artifactIndex.totalFileCount}/${Object.keys(artifactIndex.kinds).length}`);
  console.log(`- artifact search matches/files: ${artifactSearch.totalMatches}/${artifactSearch.matchedFileCount}`);
  console.log(`- artifact read mode/lines: ${artifactRead.mode}/${artifactRead.returnedLineCount}`);
  console.log(`- evidence timeline events/types: ${evidenceTimeline.eventCount}/${Object.keys(evidenceTimeline.byType).length}`);
  console.log(`- evidence timeline filtered artifacts: ${artifactTimeline.eventCount}`);
  console.log(`- request detail id: ${requestDetail.detail.requestId}`);
  console.log(`- DevTools issues: ${issuesLog.issueCount}`);
  console.log(`- accessibility nodes: ${accessibility.nodeCount}`);
  console.log(`- DOMSnapshot documents: ${domSnapshot.documentCount}`);
  console.log(`- Chrome trace bytes: ${trace.traceTextBytes}`);
  console.log(`- Chrome trace summary events: ${trace.traceSummary.eventCount}`);
  console.log(`- Chrome trace phase buckets/top durations: ${trace.traceSummary.durationByPhase.length}/${trace.traceSummary.topDurations.length}`);
  console.log(`- Chrome trace screenshot frames: ${trace.traceScreenshotCount}`);
  console.log(`- Chrome trace path: ${trace.tracePath}`);
  console.log(`- coverage scripts/rules: ${coverage.js.scriptCount}/${coverage.css.ruleCount}`);
  console.log(`- heap snapshot bytes/chunks: ${heapSnapshot.heapSnapshotBytes}/${heapSnapshot.chunkCount}`);
  console.log(`- source search matches: ${sourceSearch.matchCount}`);
  console.log(`- source pretty bytes: ${prettySource.prettyBytes}`);
  console.log(`- source map results: ${sourceMapMetadata.count}`);
  console.log(`- console exceptions: ${consoleLog.counts.exceptions}`);
  console.log(`- console source context lines: ${consoleSourceContext.lines.length}`);
  console.log(`- event listeners: ${eventListeners.count}`);
  console.log(`- css matched rules: ${cssStyles.matchedStyles?.matchedCSSRules?.length || 0}`);
  console.log(`- global search matches: ${globalSearch.matchCount}`);
  console.log(`- evidence bundle: ${evidenceBundle.bundlePath}`);
  console.log(`- service worker registrations/caches: ${serviceWorker.registrationCount}/${serviceWorker.cacheCount}`);
  console.log(`- service worker detail scripts/caches: ${serviceWorkerDetail.scriptCount}/${serviceWorkerDetail.cacheCount}`);
  console.log(`- realtime channels ws/sse: ${realtimeLog.websocketCount}/${realtimeLog.eventSourceMessageCount}`);
  console.log(`- request replay form/multipart status: ${formReplay.response.status}/${multipartReplay.response.status}`);
  console.log(`- application export dbs/caches/bytes: ${applicationExport.indexedDbDatabaseCount}/${applicationExport.cacheCount}/${applicationExport.exportBytes}`);
  console.log(`- cookie summary count/script-readable: ${cookieSummary.summary.cookieCount}/${cookieSummary.summary.scriptReadableCount}`);
  console.log(`- storage origin frames/cookies: ${storageOrigin.frames.length}/${storageOrigin.cookieCount}`);
  console.log(`- signal summary signals/high-priority/medium: ${signalSummary.signalCount}/${signalSummary.highCount}/${signalSummary.mediumCount}`);
  console.log(`- agent router focus/search matches: ${agentOverview.focus}/${agentSearch.evidence.search.matchCount}`);
  console.log(`- capability panels: ${capabilityMap.panelCount}`);
  console.log(`- facade tools: ${facadeOpen.facade}/${facadeInspect.facade}/${facadeCapture.facade}/${facadePack.facade}`);
  console.log(`- saved HAR entries/bytes: ${savedHar.entryCount}/${savedHar.harBytes}`);
  console.log(`- HAR entries with bodies: ${bodyEntries.length}`);
  console.log(`- HAR completeness bodies/timing: ${harCompleteness.body.includedCount}/${harCompleteness.timing.entriesWithTotalTime}`);
} finally {
  await fetch(`http://127.0.0.1:${serverPort}/shutdown`, { method: "POST" }).catch(() => {});
  await new Promise((resolve) => wsServer.close(resolve));
  await new Promise((resolve) => appServer.close(resolve));
  setTimeout(() => child.kill(), 500);
  setTimeout(() => rmSync(tempDir, { recursive: true, force: true }), 1000);
}
