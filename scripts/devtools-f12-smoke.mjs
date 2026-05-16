import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
const appServer = http.createServer((req, res) => {
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
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html>
    <title>Application Smoke</title>
    <script>
      localStorage.setItem('agent-f12-local', 'local-value');
      sessionStorage.setItem('agent-f12-session', 'session-value');
      document.cookie = 'agent_f12_cookie=plain; path=/; SameSite=Lax';
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
  });
  assert(trace.traceTextBytes > 0, "Chrome trace was empty");
  assert(trace.tracePath, "Chrome trace path missing");
  assert(trace.traceSummary?.eventCount > 0, "Chrome trace summary missing events");

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
    </style>
    <script>
      window.${sourceMarker}="source-search-smoke";function ${sourceMarker.toLowerCase()}(){return window.${sourceMarker};}
      console.error("AGENT_CONSOLE_ERROR_MARKER", window.${sourceMarker});
      setTimeout(() => { throw new Error("AGENT_CONSOLE_THROW_MARKER " + window.${sourceMarker}); }, 0);
      addEventListener("DOMContentLoaded", () => {
        document.getElementById("agent-listener-button").addEventListener("click", function agentListenerSmoke() {
          window.AGENT_EVENT_LISTENER_MARKER = true;
        });
      });
      //# sourceMappingURL=data:application/json;base64,${sourceMap}
    </script>
    <h1>Source Search Smoke</h1>
    <button id="agent-listener-button">Listener Smoke</button>`)}`;
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
  });
  assert(debuggerPause.paused?.callFrameCount >= 1, `debugger control did not capture paused frames: ${JSON.stringify(debuggerPause)}`);
  assert(debuggerPause.autoResumed === true, "debugger control did not auto-resume after pauseOnExpression");
  const memorySnapshot = await callTool(baseUrl, "devtools_memory_snapshot", {
    profile: "default",
  });
  assert(memorySnapshot.heap?.usedSize >= 0 || memorySnapshot.heap?.error, "memory snapshot missing heap usage or explicit heap error");
  assert(memorySnapshot.domCounters?.nodes >= 0 || memorySnapshot.domCounters?.error, "memory snapshot missing DOM counters or explicit DOM counter error");
  assert(Array.isArray(memorySnapshot.performanceMetrics), "memory snapshot missing performance metrics array");
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
  });
  assert(evidenceBundle.bundlePath, "evidence bundle path missing");
  assert(evidenceBundle.summary?.sourceCount >= 0, "evidence bundle summary missing source count");

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

  const applicationExport = await callTool(baseUrl, "devtools_application_export", {
    profile: "default",
    maxIndexedDbRecords: 50,
    maxCacheEntries: 50,
  });
  assert(applicationExport.exportPath, "application export path missing");
  assert(applicationExport.exportBytes > 0, "application export was empty");
  assert(applicationExport.indexedDbDatabaseCount >= 1, `application export missing IndexedDB: ${JSON.stringify(applicationExport)}`);
  assert(applicationExport.cacheCount >= 1, `application export missing CacheStorage: ${JSON.stringify(applicationExport)}`);

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

  const signalSummary = await callTool(baseUrl, "devtools_signal_summary", {
    profile: "default",
  });
  assert(signalSummary.signalCount >= 1, `signal summary did not report any signals: ${JSON.stringify(signalSummary)}`);
  assert(signalSummary.signals.some((finding) => String(finding.id).startsWith("cookie.")), `signal summary missing cookie signal: ${JSON.stringify(signalSummary)}`);

  const savedHar = await callTool(baseUrl, "devtools_save_har", {
    profile: "default",
    limit: 20,
  });
  assert(savedHar.harPath, "saved HAR path missing");
  assert(savedHar.harBytes > 0, "saved HAR was empty");

  console.log("F12 smoke passed:");
  console.log(`- security page: ${security.page.url}`);
  console.log(`- diagnostics page: ${diagnostics.page.url}`);
  console.log(`- network requests: ${networkSummary.requestCount}`);
  console.log(`- network timeline rows: ${networkTimeline.timeline.length}`);
  console.log(`- request detail id: ${requestDetail.detail.requestId}`);
  console.log(`- DevTools issues: ${issuesLog.issueCount}`);
  console.log(`- accessibility nodes: ${accessibility.nodeCount}`);
  console.log(`- DOMSnapshot documents: ${domSnapshot.documentCount}`);
  console.log(`- Chrome trace bytes: ${trace.traceTextBytes}`);
  console.log(`- Chrome trace summary events: ${trace.traceSummary.eventCount}`);
  console.log(`- Chrome trace path: ${trace.tracePath}`);
  console.log(`- coverage scripts/rules: ${coverage.js.scriptCount}/${coverage.css.ruleCount}`);
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
  console.log(`- application export dbs/caches/bytes: ${applicationExport.indexedDbDatabaseCount}/${applicationExport.cacheCount}/${applicationExport.exportBytes}`);
  console.log(`- cookie summary count/script-readable: ${cookieSummary.summary.cookieCount}/${cookieSummary.summary.scriptReadableCount}`);
  console.log(`- storage origin frames/cookies: ${storageOrigin.frames.length}/${storageOrigin.cookieCount}`);
  console.log(`- signal summary signals/high-priority/medium: ${signalSummary.signalCount}/${signalSummary.highCount}/${signalSummary.mediumCount}`);
  console.log(`- saved HAR entries/bytes: ${savedHar.entryCount}/${savedHar.harBytes}`);
} finally {
  await fetch(`http://127.0.0.1:${serverPort}/shutdown`, { method: "POST" }).catch(() => {});
  await new Promise((resolve) => appServer.close(resolve));
  setTimeout(() => child.kill(), 500);
  setTimeout(() => rmSync(tempDir, { recursive: true, force: true }), 1000);
}
