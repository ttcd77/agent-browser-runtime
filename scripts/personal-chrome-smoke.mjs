function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const baseUrl = process.env.PERSONAL_CHROME_HTTP_URL || "http://127.0.0.1:17337";

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

const runtime = await callTool("devtools_cdp_command", {
  method: "Runtime.evaluate",
  params: {
    expression: "({ ok: true, href: location.href, title: document.title })",
    returnByValue: true,
  },
});
assert(runtime.result?.result?.value?.ok === true, `Runtime.evaluate did not return expected value: ${JSON.stringify(runtime)}`);

const frameTree = await callTool("devtools_frame_tree");
assert(frameTree.frameCount >= 1 || frameTree.frames?.length >= 1 || frameTree.frameTree?.frame?.id, `frame tree missing frames: ${JSON.stringify(frameTree)}`);

const storage = await callTool("devtools_storage_origin_summary");
assert(storage.page?.url || storage.page?.origin, `storage summary missing page evidence: ${JSON.stringify(storage)}`);
assert(storage.storageBoundarySummary?.frameCount >= 1, `storage boundary summary missing frames: ${JSON.stringify(storage)}`);

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
const traceQuery = await callTool("devtools_trace_query", {
  tracePath: chromeTrace.tracePath,
  limit: 5,
});
assert(traceQuery.backend === "personal-chrome", `Personal Chrome trace query wrong backend: ${JSON.stringify(traceQuery)}`);
assert(traceQuery.totalEvents > 0, "Personal Chrome trace query missing total event count");
assert(Array.isArray(traceQuery.events), "Personal Chrome trace query missing events array");

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
assert(typeof researchPack.summary?.requestCount === "number", "Personal Chrome security research pack missing request count");

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

const toolCatalog = await callTool("devtools_tool_catalog", { query: "auth" });
assert(toolCatalog.toolCount >= 1, "Personal Chrome tool catalog did not return auth tools");
assert(toolCatalog.tools.some((tool) => tool.name === "devtools_auth_boundary_report"), "Personal Chrome tool catalog missing auth boundary report");
const toolHelp = await callTool("devtools_tool_help", { tool: "devtools_security_research_pack" });
assert(toolHelp.description, "Personal Chrome tool help missing description");
const workflowGuide = await callTool("devtools_workflow_guide", { task: "auth-boundary" });
assert(workflowGuide.steps?.some((step) => step.tool === "devtools_auth_boundary_report"), "Personal Chrome workflow guide missing auth boundary step");

console.log("Personal Chrome smoke passed:");
console.log(`- bridge: ${baseUrl}`);
console.log(`- active tab: ${status.tab.title || "(untitled)"} ${status.tab.url}`);
console.log(`- allowed domains: ${capabilities.domainAccess.allowedDomains.length}`);
console.log(`- layer: ${capabilities.layer}`);
console.log(`- facade tools: ${facadeInspect.facade}/${facadeCapture.facade}/${facadePack.facade}`);
console.log(`- realtime channels ws/sse: ${realtimeLog.websocketCount}/${realtimeLog.eventSourceMessageCount}`);
