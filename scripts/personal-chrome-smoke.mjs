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

console.log("Personal Chrome smoke passed:");
console.log(`- bridge: ${baseUrl}`);
console.log(`- active tab: ${status.tab.title || "(untitled)"} ${status.tab.url}`);
console.log(`- allowed domains: ${capabilities.domainAccess.allowedDomains.length}`);
console.log(`- layer: ${capabilities.layer}`);
