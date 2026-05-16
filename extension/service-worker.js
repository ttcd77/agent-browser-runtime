const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:17336/extension";
const DEBUGGER_PROTOCOL_VERSION = "1.3";
const MAX_DEVTOOLS_EVENTS = 1000;
let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
const debuggerSessions = new Map();
const tracingWaiters = new Map();

function log(...args) {
  console.log("[agent-browser-runtime]", ...args);
}

async function getBridgeUrl() {
  const stored = await chrome.storage.local.get({ bridgeUrl: DEFAULT_BRIDGE_URL });
  return stored.bridgeUrl || DEFAULT_BRIDGE_URL;
}

function send(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

function scheduleReconnect(delayMs = 1000) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBridge();
  }, delayMs);
}

async function connectBridge() {
  const bridgeUrl = await getBridgeUrl();
  if (socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(socket.readyState)) return;

  socket = new WebSocket(bridgeUrl);
  socket.onopen = () => {
    log("connected", bridgeUrl);
    send({
      type: "hello",
      name: "personal-chrome",
      userAgent: navigator.userAgent,
      extensionVersion: chrome.runtime.getManifest().version,
    });
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      send({ type: "heartbeat", timestamp: new Date().toISOString() });
    }, 15000);
  };
  socket.onclose = () => {
    log("disconnected");
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    scheduleReconnect(1000);
  };
  socket.onerror = () => {
    socket?.close();
  };
  socket.onmessage = async (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      log("bad message", error);
      return;
    }
    if (message.type !== "command") return;
    try {
      const result = await executeCommand(message.command, message.params || {});
      send({ type: "result", id: message.id, ok: true, result });
    } catch (error) {
      send({
        type: "result",
        id: message.id,
        ok: false,
        error: String(error?.message || error),
        stack: String(error?.stack || ""),
      });
    }
  };
}

chrome.runtime.onInstalled.addListener(() => {
  connectBridge();
});

chrome.runtime.onStartup.addListener(() => {
  connectBridge();
});

chrome.action.onClicked.addListener(() => {
  connectBridge();
});

connectBridge();

function tabsQuery(query) {
  return chrome.tabs.query(query);
}

async function getTargetTab(params = {}) {
  if (params.tabId) {
    const tab = await chrome.tabs.get(Number(params.tabId));
    if (!tab?.id) throw new Error(`tab not found: ${params.tabId}`);
    return tab;
  }
  if (params.urlContains) {
    const tabs = await tabsQuery({});
    const needle = String(params.urlContains).toLowerCase();
    const tab = tabs.find((entry) => String(entry.url || "").toLowerCase().includes(needle));
    if (!tab?.id) throw new Error(`no tab url contains: ${params.urlContains}`);
    return tab;
  }
  const [active] = await tabsQuery({ active: true, currentWindow: true });
  if (!active?.id) throw new Error("no active tab");
  return active;
}

async function runInTab(tabId, func, args = []) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  return result?.result;
}

async function executeCommand(command, params) {
  switch (command) {
    case "chrome_status":
      return await chromeStatus();
    case "chrome_extension_reload":
      return chrome.runtime.reload();
    case "chrome_tabs":
      return await chromeTabs();
    case "chrome_active_tab_snapshot":
      return await chromeSnapshot(params);
    case "chrome_screenshot":
      return await chromeScreenshot(params);
    case "chrome_click":
      return await chromeClick(params);
    case "chrome_type":
      return await chromeType(params);
    case "chrome_scroll":
      return await chromeScroll(params);
    case "chrome_eval":
      return await chromeEval(params);
    case "chrome_devtools_attach":
      return await chromeDevtoolsAttach(params);
    case "chrome_devtools_detach":
      return await chromeDevtoolsDetach(params);
    case "chrome_devtools_status":
      return await chromeDevtoolsStatus(params);
    case "chrome_capture_start":
      return await chromeCaptureStart(params);
    case "chrome_capture_stop":
      return await chromeCaptureStop(params);
    case "chrome_capture_clear":
      return await chromeCaptureClear(params);
    case "chrome_capture_status":
      return await chromeCaptureStatus(params);
    case "chrome_network_log":
      return await chromeNetworkLog(params);
    case "chrome_network_summary":
      return await chromeNetworkSummary(params);
    case "chrome_network_timeline":
      return await chromeNetworkTimeline(params);
    case "chrome_export_har":
      return await chromeExportHar(params);
    case "chrome_request_body":
      return await chromeRequestBody(params);
    case "chrome_request_detail":
      return await chromeRequestDetail(params);
    case "chrome_request_payload":
      return await chromeRequestPayload(params);
    case "chrome_request_replay":
      return await chromeRequestReplay(params);
    case "chrome_console_log":
      return await chromeConsoleLog(params);
    case "chrome_console_source_context":
      return await chromeConsoleSourceContext(params);
    case "chrome_security_summary":
      return await chromeSecuritySummary(params);
    case "chrome_page_diagnostics":
      return await chromePageDiagnostics(params);
    case "chrome_signal_summary":
      return await chromeRiskSummary(params);
    case "chrome_risk_summary":
      return await chromeRiskSummary(params);
    case "chrome_issues_log":
      return await chromeIssuesLog(params);
    case "chrome_frame_tree":
      return await chromeFrameTree(params);
    case "chrome_accessibility_snapshot":
      return await chromeAccessibilitySnapshot(params);
    case "chrome_hard_reload":
      return await chromeHardReload(params);
    case "chrome_storage_snapshot":
      return await chromeStorageSnapshot(params);
    case "chrome_storage_origin_summary":
      return await chromeStorageOriginSummary(params);
    case "chrome_cookie_summary":
      return await chromeCookieSummary(params);
    case "chrome_service_worker_summary":
      return await chromeServiceWorkerSummary(params);
    case "chrome_application_export":
      return await chromeApplicationExport(params);
    case "chrome_indexeddb_read":
      return await chromeIndexedDbRead(params);
    case "chrome_cache_entry_get":
      return await chromeCacheEntryGet(params);
    case "chrome_elements_snapshot":
      return await chromeElementsSnapshot(params);
    case "chrome_dom_snapshot":
      return await chromeDomSnapshot(params);
    case "chrome_dom_search":
      return await chromeDomSearch(params);
    case "chrome_event_listeners":
      return await chromeEventListeners(params);
    case "chrome_css_styles":
      return await chromeCssStyles(params);
    case "chrome_dom_mutation_watch":
      return await chromeDomMutationWatch(params);
    case "chrome_cdp_command":
      return await chromeCdpCommand(params);
    case "chrome_debugger_control":
      return await chromeDebuggerControl(params);
    case "chrome_memory_snapshot":
      return await chromeMemorySnapshot(params);
    case "chrome_sources_list":
      return await chromeSourcesList(params);
    case "chrome_source_get":
      return await chromeSourceGet(params);
    case "chrome_source_pretty_print":
      return await chromeSourcePrettyPrint(params);
    case "chrome_source_map_metadata":
      return await chromeSourceMapMetadata(params);
    case "chrome_global_search":
      return await chromeGlobalSearch(params);
    case "chrome_evidence_bundle":
      return await chromeEvidenceBundle(params);
    case "chrome_sources_search":
      return await chromeSourcesSearch(params);
    case "chrome_performance_trace":
      return await chromePerformanceTrace(params);
    case "chrome_chrome_trace":
      return await chromeChromeTrace(params);
    case "chrome_cpu_profile":
      return await chromeCpuProfile(params);
    case "chrome_coverage_snapshot":
      return await chromeCoverageSnapshot(params);
    case "chrome_coverage_detail":
      return await chromeCoverageDetail(params);
    case "chrome_token_scan":
      return await chromeTokenScan(params);
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

async function chromeStatus() {
  const tabs = await tabsQuery({});
  const active = await getTargetTab();
  return {
    ok: true,
    connected: true,
    tabs: tabs.length,
    activeTab: pickTab(active),
    extensionVersion: chrome.runtime.getManifest().version,
  };
}

function pickTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title,
    url: tab.url,
    active: tab.active,
    pinned: tab.pinned,
    audible: tab.audible,
    discarded: tab.discarded,
  };
}

function axValue(value) {
  if (!value || typeof value !== "object") return value ?? null;
  if ("value" in value) return value.value;
  return value;
}

function normalizeAccessibilityNode(node) {
  return {
    nodeId: node.nodeId,
    ignored: node.ignored,
    ignoredReasons: node.ignoredReasons,
    role: axValue(node.role),
    name: axValue(node.name),
    description: axValue(node.description),
    value: axValue(node.value),
    properties: Array.isArray(node.properties)
      ? Object.fromEntries(node.properties.map((property) => [property.name, axValue(property.value)]))
      : {},
    childIds: node.childIds || [],
    backendDOMNodeId: node.backendDOMNodeId,
    frameId: node.frameId,
  };
}

async function chromeTabs() {
  const tabs = await tabsQuery({});
  return { tabs: tabs.map(pickTab) };
}

async function chromeSnapshot(params) {
  const tab = await getTargetTab(params);
  const maxTextLength = Number(params.maxTextLength || 8000);
  const page = await runInTab(tab.id, (max) => ({
    title: document.title,
    url: location.href,
    selectedText: String(getSelection?.() || ""),
    text: (document.body?.innerText || "").slice(0, max),
    controls: [...document.querySelectorAll("button,a,input,textarea,select,[role=button]")]
      .slice(0, 100)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.value || el.getAttribute("aria-label") || el.placeholder || "").slice(0, 160),
        id: el.id || null,
        name: el.getAttribute("name"),
        type: el.getAttribute("type"),
        href: el.getAttribute("href"),
      })),
  }), [maxTextLength]);
  return { tab: pickTab(tab), page };
}

async function chromeScreenshot(params) {
  const tab = await getTargetTab(params);
  await chrome.tabs.update(tab.id, { active: true });
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  return { tab: pickTab(tab), dataUrl, mimeType: "image/png" };
}

async function chromeClick(params) {
  const tab = await getTargetTab(params);
  const result = await runInTab(tab.id, ({ selector, text, x, y }) => {
    if (typeof x === "number" && typeof y === "number") {
      const el = document.elementFromPoint(x, y);
      if (!el) return { ok: false, error: "no_element_at_point" };
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
      return { ok: true, mode: "coordinates" };
    }
    let el = null;
    if (selector) el = document.querySelector(selector);
    if (!el && text) {
      const wanted = String(text).toLowerCase();
      el = [...document.querySelectorAll("button,a,input,textarea,[role=button],label,summary")]
        .find((node) => (node.innerText || node.value || node.getAttribute("aria-label") || "").toLowerCase().includes(wanted));
    }
    if (!el) return { ok: false, error: "element_not_found" };
    el.scrollIntoView({ block: "center", inline: "center" });
    el.click();
    return { ok: true, mode: selector ? "selector" : "text" };
  }, [params]);
  return { tab: pickTab(tab), ...result };
}

async function chromeType(params) {
  const tab = await getTargetTab(params);
  if (!params.selector) throw new Error("selector is required");
  const result = await runInTab(tab.id, ({ selector, text, clear, pressEnter }) => {
    const el = document.querySelector(selector);
    if (!el) return { ok: false, error: "selector_not_found" };
    el.scrollIntoView({ block: "center", inline: "center" });
    el.focus();
    if (clear !== false) el.value = "";
    el.value = String(el.value || "") + String(text || "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (pressEnter) {
      el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
      el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", code: "Enter" }));
    }
    return { ok: true };
  }, [params]);
  return { tab: pickTab(tab), ...result };
}

async function chromeScroll(params) {
  const tab = await getTargetTab(params);
  const result = await runInTab(tab.id, ({ x, y }) => {
    scrollBy(Number(x || 0), Number(y || 600));
    return { ok: true, scrollX, scrollY };
  }, [params]);
  return { tab: pickTab(tab), ...result };
}

async function chromeEval(params) {
  const tab = await getTargetTab(params);
  if (!params.expression) throw new Error("expression is required");
  const result = await runInTab(tab.id, (expression) => {
    return Function(`"use strict"; return (${expression});`)();
  }, [String(params.expression)]);
  return { tab: pickTab(tab), result };
}

function debuggerTarget(tabId) {
  return { tabId: Number(tabId) };
}

function chromeDebuggerAttach(target, version) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, version, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

function chromeDebuggerDetach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.detach(target, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

function chromeDebuggerSendCommand(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result || {});
    });
  });
}

function sessionFor(tabId) {
  const key = String(tabId);
  let session = debuggerSessions.get(key);
  if (!session) {
    session = {
      tabId: Number(tabId),
      attachedAt: null,
      lastSeenAt: null,
      network: [],
      console: [],
      exceptions: [],
      issues: [],
      security: [],
      frames: [],
      errors: [],
      warnings: [],
      requests: new Map(),
      redirects: new Map(),
      websockets: new Map(),
      scripts: new Map(),
      paused: null,
      debuggerEvents: [],
      capture: {
        enabled: false,
        startedAt: null,
        stoppedAt: null,
        label: null,
      },
    };
    debuggerSessions.set(key, session);
  }
  return session;
}

function pushLimited(list, value) {
  list.push(value);
  if (list.length > MAX_DEVTOOLS_EVENTS) list.splice(0, list.length - MAX_DEVTOOLS_EVENTS);
}

function pushUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function looksSensitiveKey(key) {
  return /(token|secret|session|jwt|bearer|authorization|auth|cookie|csrf|xsrf|api[-_]?key|credential|password|passcode)/i.test(String(key || ""));
}

function looksSensitiveValue(value) {
  const text = String(value || "");
  return (
    /bearer\s+[a-z0-9._~+/=-]{16,}/i.test(text) ||
    /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/.test(text) ||
    /[a-zA-Z0-9_-]{24,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}/.test(text) ||
    /(?:sk|pk|rk|sess|csrf|xsrf|token|secret|key)[-_]?[a-zA-Z0-9]{12,}/i.test(text)
  );
}

function scanRecord(source, key, value, extra = {}) {
  if (!looksSensitiveKey(key) && !looksSensitiveValue(value)) return null;
  return {
    source,
    key: String(key || ""),
    value: value == null ? value : String(value),
    length: value == null ? 0 : String(value).length,
    reason: looksSensitiveKey(key) ? "sensitive-key" : "sensitive-value-pattern",
    ...extra,
  };
}

function cookieExpiry(cookie) {
  const raw = cookie?.expires ?? cookie?.expirationDate;
  if (raw === undefined || raw === null || raw === -1) return null;
  const milliseconds = Number(raw) > 10000000000 ? Number(raw) : Number(raw) * 1000;
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString();
}

function summarizeCookies(cookies = []) {
  const list = Array.isArray(cookies) ? cookies : [];
  const nowSeconds = Date.now() / 1000;
  const byDomain = {};
  const bySameSite = {};
  const findings = [];
  let secureCount = 0;
  let httpOnlyCount = 0;
  let sessionCount = 0;
  let persistentCount = 0;
  let expiredCount = 0;
  for (const cookie of list) {
    const domain = cookie.domain || "(host-only)";
    byDomain[domain] = (byDomain[domain] || 0) + 1;
    const sameSite = cookie.sameSite || "unspecified";
    bySameSite[sameSite] = (bySameSite[sameSite] || 0) + 1;
    if (cookie.secure) secureCount += 1;
    if (cookie.httpOnly) httpOnlyCount += 1;
    const expires = cookie.expires ?? cookie.expirationDate;
    const isSession = expires === undefined || expires === null || expires === -1;
    if (isSession) sessionCount += 1;
    else persistentCount += 1;
    if (!isSession && Number(expires) < nowSeconds) expiredCount += 1;
    const lowerName = String(cookie.name || "").toLowerCase();
    const likelySensitive = looksSensitiveKey(lowerName) || looksSensitiveValue(cookie.value);
    const risks = [];
    if (!cookie.secure) risks.push("missing-secure");
    if (likelySensitive && !cookie.httpOnly) risks.push("sensitive-not-httponly");
    if (!cookie.sameSite || /no_restriction|none/i.test(String(cookie.sameSite))) risks.push("samesite-none-or-unspecified");
    if (risks.length) {
      findings.push({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
        secure: Boolean(cookie.secure),
        httpOnly: Boolean(cookie.httpOnly),
        sameSite,
        session: isSession,
        expiresAt: cookieExpiry(cookie),
        likelySensitive,
        risks,
      });
    }
  }
  return {
    cookieCount: list.length,
    secureCount,
    insecureCount: list.length - secureCount,
    httpOnlyCount,
    scriptReadableCount: list.length - httpOnlyCount,
    sessionCount,
    persistentCount,
    expiredCount,
    byDomain,
    bySameSite,
    findings,
  };
}

function severityRank(severity) {
  return { high: 3, medium: 2, low: 1, info: 0 }[severity] ?? 0;
}

function buildRiskSummary({ diagnostics = {}, cookieSummary = {}, serviceWorkerSummary = {}, tokenScan = null } = {}) {
  const findings = [];
  const network = diagnostics.network || {};
  const storage = diagnostics.storage || {};
  const page = diagnostics.page || {};
  const security = diagnostics.security || {};
  if (network.failedCount > 0) {
    findings.push({
      id: "network.failed-requests",
      severity: "medium",
      panel: "Network",
      title: "Failed Network requests",
      detail: `${network.failedCount} failed request(s) observed in the current capture.`,
      evidence: network.failed || [],
      nextTools: ["devtools_network_summary", "devtools_network_log", "devtools_request_body"],
    });
  }
  if (network.serviceWorkerCount > 0) {
    findings.push({
      id: "network.service-worker-responses",
      severity: "info",
      panel: "Network",
      title: "Responses served by Service Worker",
      detail: `${network.serviceWorkerCount} request(s) involved Service Worker handling.`,
      nextTools: ["devtools_network_log", "devtools_service_worker_summary"],
    });
  }
  const cookieFindings = cookieSummary.findings || storage.cookieSummary?.findings || [];
  for (const finding of cookieFindings.slice(0, 20)) {
    const hasSensitiveRisk = finding.risks?.includes("sensitive-not-httponly");
    findings.push({
      id: `cookie.${finding.domain || "domain"}.${finding.name || "cookie"}`,
      severity: hasSensitiveRisk ? "high" : "medium",
      panel: "Application",
      title: `Cookie risk: ${finding.name}`,
      detail: (finding.risks || []).join(", "),
      evidence: finding,
      nextTools: ["devtools_cookie_summary", "devtools_storage_snapshot", "devtools_application_export"],
    });
  }
  if (cookieSummary.insecureCount > 0 || storage.cookieSummary?.insecureCount > 0) {
    findings.push({
      id: "cookies.insecure-count",
      severity: "medium",
      panel: "Application",
      title: "Cookies without Secure flag",
      detail: `${cookieSummary.insecureCount ?? storage.cookieSummary?.insecureCount ?? 0} cookie(s) are not marked Secure.`,
      nextTools: ["devtools_cookie_summary"],
    });
  }
  if (page?.isSecureContext === false) {
    findings.push({
      id: "security.insecure-context",
      severity: "high",
      panel: "Security",
      title: "Page is not a secure context",
      detail: `Current protocol is ${page.protocol || "unknown"}.`,
      nextTools: ["devtools_security_summary"],
    });
  }
  const swRegistrations = serviceWorkerSummary.registrationCount ?? storage.serviceWorkerRegistrations ?? 0;
  const cacheCount = serviceWorkerSummary.cacheCount ?? storage.cacheStorageCaches ?? 0;
  if (swRegistrations > 0 || cacheCount > 0) {
    findings.push({
      id: "application.service-worker-cache-state",
      severity: "info",
      panel: "Application",
      title: "Service Worker / CacheStorage present",
      detail: `${swRegistrations} Service Worker registration(s), ${cacheCount} cache(s).`,
      evidence: {
        registrations: serviceWorkerSummary.page?.registrations || [],
        caches: serviceWorkerSummary.page?.cacheStorage?.caches || [],
      },
      nextTools: ["devtools_service_worker_summary", "devtools_application_export", "devtools_cache_entry_get"],
    });
  }
  if (tokenScan?.findingCount > 0 || tokenScan?.findings?.length > 0) {
    findings.push({
      id: "tokens.detected",
      severity: "high",
      panel: "Application",
      title: "Token-like values detected",
      detail: `${tokenScan.findingCount ?? tokenScan.findings.length} token-like finding(s) detected across Network/storage/cookies.`,
      evidence: tokenScan.findings?.slice(0, 20) || [],
      nextTools: ["devtools_token_scan", "devtools_network_log", "devtools_storage_snapshot"],
    });
  }
  if (security?.tlsHosts && Object.keys(security.tlsHosts).length === 0 && page?.protocol === "https:") {
    findings.push({
      id: "security.no-tls-metadata",
      severity: "low",
      panel: "Security",
      title: "No TLS metadata captured yet",
      detail: "The page is HTTPS, but the current capture does not include TLS securityDetails. Start capture and hard reload for complete evidence.",
      nextTools: ["devtools_capture_start", "devtools_hard_reload", "devtools_security_summary"],
    });
  }
  findings.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  return {
    summaryKind: "signals",
    signalCount: findings.length,
    riskCount: findings.length,
    signals: findings,
    highCount: findings.filter((finding) => finding.severity === "high").length,
    mediumCount: findings.filter((finding) => finding.severity === "medium").length,
    lowCount: findings.filter((finding) => finding.severity === "low").length,
    infoCount: findings.filter((finding) => finding.severity === "info").length,
    findings,
  };
}

function requestDurationMs(request) {
  if (!request?.timestamp || !request?.finishedAt) return null;
  const duration = new Date(request.finishedAt).getTime() - new Date(request.timestamp).getTime();
  return Number.isFinite(duration) ? Math.max(0, duration) : null;
}

function hostnameForUrl(url) {
  try {
    return new URL(url).hostname || "";
  } catch {
    return "";
  }
}

function summarizeNetworkRecords(requests, websockets = [], limit = 10) {
  const byStatus = {};
  const byHost = {};
  const byType = {};
  const failed = [];
  const redirects = [];
  const slowest = [];
  const largest = [];
  const fromCache = [];
  const fromServiceWorker = [];
  const initiators = {};

  for (const request of requests) {
    const statusKey = String(request.status || (request.failed ? "failed" : "pending"));
    byStatus[statusKey] = (byStatus[statusKey] || 0) + 1;
    const host = hostnameForUrl(request.url) || "(unknown)";
    byHost[host] = (byHost[host] || 0) + 1;
    const type = request.resourceType || "(unknown)";
    byType[type] = (byType[type] || 0) + 1;
    const initiatorType = request.initiator?.type || "(unknown)";
    initiators[initiatorType] = (initiators[initiatorType] || 0) + 1;
    if (request.failed || request.status >= 400) failed.push(request);
    if (Array.isArray(request.redirectChain) && request.redirectChain.length) redirects.push(request);
    if (request.fromDiskCache) fromCache.push(request);
    if (request.fromServiceWorker) fromServiceWorker.push(request);
    const durationMs = requestDurationMs(request);
    if (durationMs !== null) slowest.push({ requestId: request.requestId, url: request.url, status: request.status, durationMs });
    const bytes = request.encodedDataLength ?? request.bodyBytes;
    if (typeof bytes === "number") largest.push({ requestId: request.requestId, url: request.url, status: request.status, bytes });
  }

  slowest.sort((a, b) => b.durationMs - a.durationMs);
  largest.sort((a, b) => b.bytes - a.bytes);

  return {
    requestCount: requests.length,
    websocketCount: websockets.length,
    failedCount: failed.length,
    redirectCount: redirects.length,
    cacheHitCount: fromCache.length,
    serviceWorkerCount: fromServiceWorker.length,
    byStatus,
    byHost,
    byType,
    initiators,
    failed: failed.slice(-limit).map((request) => ({
      requestId: request.requestId,
      url: request.url,
      method: request.method,
      status: request.status,
      errorText: request.errorText,
      blockedReason: request.blockedReason,
      corsErrorStatus: request.corsErrorStatus,
    })),
    redirects: redirects.slice(-limit).map((request) => ({
      requestId: request.requestId,
      url: request.url,
      status: request.status,
      chainLength: request.redirectChain.length,
      chain: request.redirectChain.map((entry) => ({ url: entry.url, status: entry.status, protocol: entry.protocol })),
    })),
    slowest: slowest.slice(0, limit),
    largest: largest.slice(0, limit),
    websockets: websockets.slice(-limit).map((socket) => ({
      requestId: socket.requestId,
      url: socket.url,
      status: socket.status,
      frameCount: socket.frames?.length || 0,
      closedAt: socket.closedAt,
      errorMessage: socket.errorMessage,
    })),
  };
}

function timingPhase(timing, startKey, endKey) {
  if (!timing || typeof timing[startKey] !== "number" || typeof timing[endKey] !== "number") return null;
  if (timing[startKey] < 0 || timing[endKey] < 0) return null;
  return Math.max(0, timing[endKey] - timing[startKey]);
}

function buildNetworkTimeline(requests, limit = 100) {
  const rows = Array.isArray(requests) ? requests : [];
  return rows.slice(-limit).map((request) => {
    const timing = request.timing || null;
    const durationMs = requestDurationMs(request);
    return {
      requestId: request.requestId,
      url: request.url,
      method: request.method,
      status: request.status,
      failed: Boolean(request.failed),
      failReason: request.failReason || request.errorText || null,
      resourceType: request.resourceType,
      mimeType: request.mimeType,
      protocol: request.protocol,
      hostname: hostnameForUrl(request.url),
      timestamp: request.timestamp,
      responseTimestamp: request.responseTimestamp,
      finishedAt: request.finishedAt || null,
      durationMs,
      encodedDataLength: request.encodedDataLength ?? null,
      bodyBytes: request.bodyBytes ?? null,
      fromDiskCache: Boolean(request.fromDiskCache),
      fromServiceWorker: Boolean(request.fromServiceWorker),
      remoteAddress: request.remoteIPAddress ? `${request.remoteIPAddress}:${request.remotePort || ""}` : null,
      initiatorType: request.initiator?.type || request.initiatorType || null,
      initiator: request.initiator || null,
      redirectCount: Array.isArray(request.redirectChain) ? request.redirectChain.length : 0,
      timing,
      phases: timing ? {
        queueing: timingPhase(timing, "requestTime", "proxyStart"),
        proxy: timingPhase(timing, "proxyStart", "proxyEnd"),
        dns: timingPhase(timing, "dnsStart", "dnsEnd"),
        connect: timingPhase(timing, "connectStart", "connectEnd"),
        ssl: timingPhase(timing, "sslStart", "sslEnd"),
        send: timingPhase(timing, "sendStart", "sendEnd"),
        wait: timingPhase(timing, "sendEnd", "receiveHeadersEnd"),
      } : null,
    };
  });
}

function parseCookieHeader(headerValue = "") {
  return String(headerValue || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      if (index < 0) return { name: part, value: "" };
      return { name: part.slice(0, index).trim(), value: part.slice(index + 1) };
    });
}

function lowerHeaderMap(headers = {}) {
  return Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [String(key).toLowerCase(), value]));
}

function buildRequestDetail(entry, cookies = []) {
  if (!entry) return null;
  const requestHeadersLower = lowerHeaderMap(entry.requestHeaders || {});
  const responseHeadersLower = lowerHeaderMap(entry.responseHeaders || {});
  const cookieHeader = requestHeadersLower.cookie || "";
  const setCookieHeader = responseHeadersLower["set-cookie"] || "";
  return {
    requestId: entry.requestId,
    url: entry.url,
    method: entry.method,
    status: entry.status,
    statusText: entry.statusText,
    resourceType: entry.resourceType,
    mimeType: entry.mimeType,
    protocol: entry.protocol,
    frameId: entry.frameId,
    loaderId: entry.loaderId,
    documentURL: entry.documentURL,
    failed: Boolean(entry.failed),
    failReason: entry.failReason || entry.errorText || null,
    blockedReason: entry.blockedReason || null,
    fromDiskCache: Boolean(entry.fromDiskCache),
    fromServiceWorker: Boolean(entry.fromServiceWorker),
    remoteIPAddress: entry.remoteIPAddress || null,
    remotePort: entry.remotePort || null,
    requestHeaders: entry.requestHeaders || {},
    requestHeadersText: entry.requestHeadersText || null,
    responseHeaders: entry.responseHeaders || {},
    responseHeadersText: entry.responseHeadersText || null,
    cookieHeader,
    requestCookies: parseCookieHeader(cookieHeader),
    setCookieHeader,
    associatedCookies: entry.associatedCookies || [],
    blockedRequestCookies: entry.blockedRequestCookies || [],
    blockedResponseCookies: entry.blockedResponseCookies || [],
    browserCookiesForUrl: cookies,
    hasPostData: Boolean(entry.hasPostData),
    postDataLength: entry.postDataLength ?? null,
    bodyReadable: Boolean(entry.bodyReadable),
    bodyBytes: entry.bodyBytes ?? null,
    bodyBase64Encoded: Boolean(entry.bodyBase64Encoded),
    initiatorType: entry.initiator?.type || entry.initiatorType || null,
    initiator: entry.initiator || null,
    timing: entry.timing || null,
    timingPhases: entry.timing ? buildNetworkTimeline([entry], 1)[0]?.phases : null,
    securityDetails: entry.securityDetails || null,
    redirectChain: entry.redirectChain || [],
    connectTiming: entry.connectTiming || null,
    extraInfo: {
      requestWillBeSentExtraInfo: Boolean(entry.requestWillBeSentExtraInfoSeen),
      responseReceivedExtraInfo: Boolean(entry.responseReceivedExtraInfoSeen),
      statusCodeFromExtraInfo: entry.extraInfoStatusCode ?? null,
      resourceIPAddressSpace: entry.resourceIPAddressSpace ?? null,
    },
  };
}

function summarizeTraceEvents(events = [], limit = 10) {
  const byCategory = {};
  const byName = {};
  const longEvents = [];
  const screenshots = [];
  const networkLike = [];
  for (const event of events) {
    const categories = String(event.cat || "").split(",").filter(Boolean);
    for (const category of categories) byCategory[category] = (byCategory[category] || 0) + 1;
    const name = String(event.name || "(unknown)");
    byName[name] = (byName[name] || 0) + 1;
    if (typeof event.dur === "number" && event.dur >= 50_000) {
      longEvents.push({
        name,
        category: event.cat,
        ts: event.ts,
        durationMs: Math.round(event.dur / 1000),
        thread: event.tid,
        process: event.pid,
      });
    }
    if (name.toLowerCase().includes("screenshot")) {
      screenshots.push({ name, ts: event.ts, args: event.args });
    }
    if (String(event.cat || "").includes("netlog") || /^Resource|^Network|URLRequest/i.test(name)) {
      networkLike.push({ name, category: event.cat, ts: event.ts, args: event.args });
    }
  }
  longEvents.sort((a, b) => b.durationMs - a.durationMs);
  const topEntries = (object) => Object.entries(object)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
  return {
    eventCount: events.length,
    topCategories: topEntries(byCategory),
    topNames: topEntries(byName),
    longEventCount: longEvents.length,
    longEvents: longEvents.slice(0, limit),
    screenshotEventCount: screenshots.length,
    screenshots: screenshots.slice(0, limit),
    networkEventCount: networkLike.length,
    networkEvents: networkLike.slice(0, limit),
  };
}

function summarizeCpuProfile(profile = {}, limit = 20) {
  const nodes = Array.isArray(profile.nodes) ? profile.nodes : [];
  const samples = Array.isArray(profile.samples) ? profile.samples : [];
  const timeDeltas = Array.isArray(profile.timeDeltas) ? profile.timeDeltas : [];
  const hitsByNodeId = new Map();
  for (const sample of samples) {
    hitsByNodeId.set(sample, (hitsByNodeId.get(sample) || 0) + 1);
  }
  const topNodes = nodes
    .map((node) => {
      const frame = node.callFrame || {};
      const sampleHits = hitsByNodeId.get(node.id) || 0;
      return {
        nodeId: node.id,
        functionName: frame.functionName || "(anonymous)",
        url: frame.url || "",
        lineNumber: frame.lineNumber,
        columnNumber: frame.columnNumber,
        hitCount: Number(node.hitCount || 0),
        sampleHits,
        childCount: Array.isArray(node.children) ? node.children.length : 0,
        positionTickCount: Array.isArray(node.positionTicks) ? node.positionTicks.reduce((sum, tick) => sum + Number(tick.ticks || 0), 0) : 0,
      };
    })
    .filter((node) => node.hitCount || node.sampleHits || node.positionTickCount)
    .sort((a, b) => (b.sampleHits + b.hitCount + b.positionTickCount) - (a.sampleHits + a.hitCount + a.positionTickCount))
    .slice(0, limit);
  const totalTimeDeltaUs = timeDeltas.reduce((sum, value) => sum + Number(value || 0), 0);
  return {
    nodeCount: nodes.length,
    sampleCount: samples.length,
    timeDeltaCount: timeDeltas.length,
    totalTimeDeltaUs,
    totalTimeDeltaMs: totalTimeDeltaUs / 1000,
    startTime: profile.startTime,
    endTime: profile.endTime,
    topNodes,
  };
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId) return;
  const session = sessionFor(source.tabId);
  session.lastSeenAt = new Date().toISOString();
  const timestamp = new Date().toISOString();
  if (method === "Tracing.tracingComplete") {
    const waiter = tracingWaiters.get(String(source.tabId));
    if (waiter) {
      tracingWaiters.delete(String(source.tabId));
      waiter.resolve(params || {});
    }
    return;
  }
  if (method === "Debugger.scriptParsed") {
    session.scripts.set(params.scriptId, {
      timestamp,
      scriptId: params.scriptId,
      url: params.url,
      startLine: params.startLine,
      startColumn: params.startColumn,
      endLine: params.endLine,
      endColumn: params.endColumn,
      executionContextId: params.executionContextId,
      hash: params.hash,
      executionContextAuxData: params.executionContextAuxData,
      isLiveEdit: params.isLiveEdit,
      sourceMapURL: params.sourceMapURL,
      hasSourceURL: params.hasSourceURL,
      isModule: params.isModule,
      length: params.length,
      stackTrace: params.stackTrace,
    });
    return;
  }
  if (method === "Debugger.paused") {
    session.paused = { timestamp, ...params };
    pushLimited(session.debuggerEvents, { timestamp, method, reason: params.reason, hitBreakpoints: params.hitBreakpoints || [] });
    return;
  }
  if (method === "Debugger.resumed") {
    session.paused = null;
    pushLimited(session.debuggerEvents, { timestamp, method });
    return;
  }
  if (!session.capture.enabled) return;

  if (method === "Network.requestWillBeSent") {
    if (params.redirectResponse) {
      const chain = session.redirects.get(params.requestId) || [];
      chain.push({
        timestamp,
        url: params.redirectResponse.url,
        status: params.redirectResponse.status,
        statusText: params.redirectResponse.statusText,
        headers: params.redirectResponse.headers,
        mimeType: params.redirectResponse.mimeType,
        protocol: params.redirectResponse.protocol,
        remoteIPAddress: params.redirectResponse.remoteIPAddress,
        remotePort: params.redirectResponse.remotePort,
        securityDetails: params.redirectResponse.securityDetails,
      });
      session.redirects.set(params.requestId, chain);
    }
    const entry = {
      requestId: params.requestId,
      timestamp,
      url: params.request?.url,
      method: params.request?.method,
      requestHeaders: params.request?.headers,
      hasPostData: params.request?.hasPostData,
      postData: params.request?.postData,
      postDataLength: params.request?.postData ? String(params.request.postData).length : undefined,
      resourceType: params.type,
      frameId: params.frameId,
      loaderId: params.loaderId,
      initiator: params.initiator,
      documentURL: params.documentURL,
      redirectResponse: params.redirectResponse,
      redirectChain: session.redirects.get(params.requestId) || [],
    };
    session.requests.set(params.requestId, entry);
    pushLimited(session.network, entry);
    return;
  }

  if (method === "Network.responseReceived") {
    const existing = session.requests.get(params.requestId) || { requestId: params.requestId, timestamp };
    Object.assign(existing, {
      responseTimestamp: timestamp,
      status: params.response?.status,
      statusText: params.response?.statusText,
      mimeType: params.response?.mimeType,
      responseHeaders: params.response?.headers,
      fromDiskCache: params.response?.fromDiskCache,
      fromServiceWorker: params.response?.fromServiceWorker,
      encodedDataLength: params.response?.encodedDataLength,
      protocol: params.response?.protocol,
      timing: params.response?.timing,
      remoteIPAddress: params.response?.remoteIPAddress,
      remotePort: params.response?.remotePort,
      securityDetails: params.response?.securityDetails,
    });
    session.requests.set(params.requestId, existing);
    return;
  }

  if (method === "Network.requestWillBeSentExtraInfo") {
    const existing = session.requests.get(params.requestId) || { requestId: params.requestId, timestamp };
    Object.assign(existing, {
      requestWillBeSentExtraInfoSeen: true,
      associatedCookies: params.associatedCookies,
      blockedRequestCookies: params.blockedCookies,
      requestHeaders: params.headers,
      requestHeadersText: params.headersText,
      connectTiming: params.connectTiming,
      clientSecurityState: params.clientSecurityState,
      siteHasCookieInOtherPartition: params.siteHasCookieInOtherPartition,
    });
    session.requests.set(params.requestId, existing);
    return;
  }

  if (method === "Network.responseReceivedExtraInfo") {
    const existing = session.requests.get(params.requestId) || { requestId: params.requestId, timestamp };
    Object.assign(existing, {
      responseReceivedExtraInfoSeen: true,
      extraInfoStatusCode: params.statusCode,
      responseHeaders: params.headers,
      responseHeadersText: params.headersText,
      blockedResponseCookies: params.blockedCookies,
      resourceIPAddressSpace: params.resourceIPAddressSpace,
      cookiePartitionKey: params.cookiePartitionKey,
      cookiePartitionKeyOpaque: params.cookiePartitionKeyOpaque,
    });
    session.requests.set(params.requestId, existing);
    return;
  }

  if (method === "Network.loadingFinished") {
    const existing = session.requests.get(params.requestId) || { requestId: params.requestId, timestamp };
    Object.assign(existing, {
      finishedAt: timestamp,
      encodedDataLength: params.encodedDataLength,
      bodyReadable: true,
    });
    session.requests.set(params.requestId, existing);
    return;
  }

  if (method === "Network.loadingFailed") {
    const existing = session.requests.get(params.requestId) || { requestId: params.requestId, timestamp };
    Object.assign(existing, {
      failedAt: timestamp,
      failed: true,
      errorText: params.errorText,
      blockedReason: params.blockedReason,
      corsErrorStatus: params.corsErrorStatus,
    });
    session.requests.set(params.requestId, existing);
    return;
  }

  if (method.startsWith("Network.webSocket")) {
    const requestId = params.requestId;
    const socket = session.websockets.get(requestId) || {
      requestId,
      createdAt: timestamp,
      url: params.url,
      frames: [],
      events: [],
    };
    socket.updatedAt = timestamp;
    if (params.url) socket.url = params.url;
    if (method === "Network.webSocketCreated") {
      socket.url = params.url;
      socket.initiator = params.initiator;
    } else if (method === "Network.webSocketWillSendHandshakeRequest") {
      socket.requestHeaders = params.request?.headers;
      socket.wallTime = params.wallTime;
    } else if (method === "Network.webSocketHandshakeResponseReceived") {
      socket.status = params.response?.status;
      socket.statusText = params.response?.statusText;
      socket.responseHeaders = params.response?.headers;
    } else if (method === "Network.webSocketFrameSent" || method === "Network.webSocketFrameReceived") {
      socket.frames.push({
        timestamp,
        direction: method === "Network.webSocketFrameSent" ? "sent" : "received",
        opcode: params.response?.opcode,
        mask: params.response?.mask,
        payloadData: params.response?.payloadData,
        payloadLength: params.response?.payloadData ? String(params.response.payloadData).length : 0,
      });
      if (socket.frames.length > MAX_DEVTOOLS_EVENTS) socket.frames.splice(0, socket.frames.length - MAX_DEVTOOLS_EVENTS);
    } else if (method === "Network.webSocketFrameError") {
      socket.errorMessage = params.errorMessage;
    } else if (method === "Network.webSocketClosed") {
      socket.closedAt = timestamp;
    }
    socket.events.push({ timestamp, method, ...params });
    if (socket.events.length > MAX_DEVTOOLS_EVENTS) socket.events.splice(0, socket.events.length - MAX_DEVTOOLS_EVENTS);
    session.websockets.set(requestId, socket);
    pushLimited(session.network, { timestamp, method, ...params });
    return;
  }

  if (method === "Runtime.consoleAPICalled") {
    pushLimited(session.console, {
      timestamp,
      type: params.type,
      args: (params.args || []).map((arg) => arg.value ?? arg.description ?? arg.type),
      stackTrace: params.stackTrace,
      executionContextId: params.executionContextId,
    });
    return;
  }

  if (method === "Runtime.exceptionThrown") {
    pushLimited(session.exceptions, {
      timestamp,
      exceptionId: params.exceptionId,
      timestampRaw: params.timestamp,
      details: params.exceptionDetails,
    });
    return;
  }

  if (method === "Log.entryAdded") {
    pushLimited(session.console, {
      timestamp,
      type: "log-entry",
      entry: params.entry,
    });
    return;
  }

  if (method === "Audits.issueAdded") {
    pushLimited(session.issues, {
      timestamp,
      ...params,
    });
    return;
  }

  if (method === "Security.securityStateChanged") {
    pushLimited(session.security, { timestamp, ...params });
    return;
  }

  if (method.startsWith("Page.frame")) {
    pushLimited(session.frames, { timestamp, method, ...params });
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (!source.tabId) return;
  const session = sessionFor(source.tabId);
  session.detachedAt = new Date().toISOString();
  session.detachReason = reason;
});

async function ensureDevtoolsAttached(params = {}) {
  const tab = await getTargetTab(params);
  const target = debuggerTarget(tab.id);
  const session = sessionFor(tab.id);
  if (!session.attachedAt || session.detachedAt) {
    await chromeDebuggerAttach(target, DEBUGGER_PROTOCOL_VERSION);
    session.attachedAt = new Date().toISOString();
    session.detachedAt = null;
    session.detachReason = null;
  }
  await chromeDebuggerSendCommand(target, "Network.enable", {
    maxTotalBufferSize: 100000000,
    maxResourceBufferSize: 50000000,
    maxPostDataSize: 50000000,
  });
  await chromeDebuggerSendCommand(target, "Page.enable");
  await chromeDebuggerSendCommand(target, "Runtime.enable");
  await chromeDebuggerSendCommand(target, "Debugger.enable").catch((error) => pushUnique(session.warnings, `Debugger.enable unavailable: ${String(error.message || error)}`));
  await chromeDebuggerSendCommand(target, "Log.enable").catch((error) => pushUnique(session.warnings, `Log.enable unavailable: ${String(error.message || error)}`));
  await chromeDebuggerSendCommand(target, "Audits.enable").catch((error) => pushUnique(session.warnings, `Audits.enable unavailable: ${String(error.message || error)}`));
  await chromeDebuggerSendCommand(target, "Security.enable").catch((error) => pushUnique(session.warnings, `Security.enable unavailable in this Chrome/debugger context: ${String(error.message || error)}`));
  session.lastSeenAt = new Date().toISOString();
  return { tab, target, session };
}

async function chromeDevtoolsAttach(params) {
  const { tab, session } = await ensureDevtoolsAttached(params);
  return {
    ok: true,
    tab: pickTab(tab),
    attachedAt: session.attachedAt,
    note: "Chrome may show a debug banner because this extension is attached through chrome.debugger.",
  };
}

async function chromeDevtoolsDetach(params) {
  const tab = await getTargetTab(params);
  const target = debuggerTarget(tab.id);
  await chromeDebuggerDetach(target);
  const session = sessionFor(tab.id);
  session.detachedAt = new Date().toISOString();
  return { ok: true, tab: pickTab(tab), detachedAt: session.detachedAt };
}

async function chromeDevtoolsStatus(params) {
  const tab = await getTargetTab(params);
  const session = debuggerSessions.get(String(tab.id));
  return {
    tab: pickTab(tab),
    attached: Boolean(session?.attachedAt && !session?.detachedAt),
    attachedAt: session?.attachedAt,
    detachedAt: session?.detachedAt,
    detachReason: session?.detachReason,
    networkEvents: session?.network?.length || 0,
    trackedRequests: session?.requests?.size || 0,
    consoleEvents: session?.console?.length || 0,
    frameEvents: session?.frames?.length || 0,
    securityEvents: session?.security?.length || 0,
    scriptEvents: session?.scripts?.size || 0,
    websocketCount: session?.websockets?.size || 0,
    errors: session?.errors || [],
    warnings: session?.warnings || [],
    capture: session?.capture || { enabled: false },
  };
}

function clearCapturedSessionData(session) {
  session.network = [];
  session.console = [];
  session.security = [];
  session.frames = [];
  session.requests = new Map();
  session.redirects = new Map();
  session.websockets = new Map();
  session.scripts = new Map();
}

async function chromeCaptureStart(params) {
  const { tab, session } = await ensureDevtoolsAttached(params);
  if (params.clear !== false) clearCapturedSessionData(session);
  session.capture = {
    enabled: true,
    startedAt: new Date().toISOString(),
    stoppedAt: null,
    label: params.label || null,
  };
  return {
    ok: true,
    tab: pickTab(tab),
    capture: session.capture,
    cleared: params.clear !== false,
  };
}

async function chromeCaptureStop(params) {
  const tab = await getTargetTab(params);
  const session = sessionFor(tab.id);
  session.capture.enabled = false;
  session.capture.stoppedAt = new Date().toISOString();
  return { ok: true, tab: pickTab(tab), capture: session.capture };
}

async function chromeCaptureClear(params) {
  const tab = await getTargetTab(params);
  const session = sessionFor(tab.id);
  clearCapturedSessionData(session);
  return { ok: true, tab: pickTab(tab), capture: session.capture, cleared: true };
}

async function chromeCaptureStatus(params) {
  return await chromeDevtoolsStatus(params);
}

async function chromeNetworkLog(params) {
  const { tab, session } = await ensureDevtoolsAttached(params);
  const limit = Number(params.limit || 100);
  const rows = [...session.requests.values()];
  return {
    tab: pickTab(tab),
    count: rows.length,
    requests: rows.slice(-limit),
    websockets: [...session.websockets.values()].slice(-limit),
    websocketAndOtherNetworkEvents: session.network
      .filter((entry) => !entry.requestId || String(entry.method || "").startsWith("Network.webSocket"))
      .slice(-limit),
  };
}

async function chromeNetworkSummary(params) {
  const { tab, session } = await ensureDevtoolsAttached(params);
  const limit = Number(params.limit || 10);
  const requests = [...session.requests.values()];
  const websockets = [...session.websockets.values()];
  return {
    tab: pickTab(tab),
    capture: session.capture,
    ...summarizeNetworkRecords(requests, websockets, limit),
  };
}

async function chromeNetworkTimeline(params) {
  const { tab, session } = await ensureDevtoolsAttached(params);
  const limit = Number(params.limit || 100);
  let requests = [...session.requests.values()];
  if (params.url_contains) {
    const needle = String(params.url_contains).toLowerCase();
    requests = requests.filter((entry) => String(entry.url || "").toLowerCase().includes(needle));
  }
  if (params.hostname) {
    const hostname = String(params.hostname).toLowerCase();
    requests = requests.filter((entry) => hostnameForUrl(entry.url).toLowerCase() === hostname);
  }
  if (params.method) {
    const method = String(params.method).toUpperCase();
    requests = requests.filter((entry) => String(entry.method || "").toUpperCase() === method);
  }
  if (typeof params.status === "number") {
    requests = requests.filter((entry) => entry.status === params.status);
  }
  return {
    tab: pickTab(tab),
    capture: session.capture,
    count: requests.length,
    timeline: buildNetworkTimeline(requests, limit),
  };
}

async function chromeExportHar(params) {
  const { tab, target, session } = await ensureDevtoolsAttached(params);
  const limit = Number.isFinite(Number(params.limit)) ? Number(params.limit) : 1000;
  const includeBodies = params.includeBodies === true;
  const maxBodyBytes = Number.isFinite(Number(params.maxBodyBytes)) ? Number(params.maxBodyBytes) : 200000;
  const requests = [...session.requests.values()].slice(0, limit);
  async function responseContent(request) {
    const content = {
      size: request.encodedDataLength ?? -1,
      mimeType: request.mimeType || "",
    };
    if (!includeBodies) return content;
    try {
      const body = await chromeDebuggerSendCommand(target, "Network.getResponseBody", {
        requestId: String(request.requestId),
      });
      if (body.base64Encoded) {
        const binary = atob(body.body || "");
        const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
        const limited = bytes.slice(0, maxBodyBytes);
        let raw = "";
        for (const byte of limited) raw += String.fromCharCode(byte);
        return {
          ...content,
          text: btoa(raw),
          encoding: "base64",
          _bodyIncluded: true,
          _bodyTruncated: bytes.length > maxBodyBytes,
        };
      }
      const text = String(body.body || "");
      return {
        ...content,
        text: text.slice(0, maxBodyBytes),
        _bodyIncluded: true,
        _bodyTruncated: text.length > maxBodyBytes,
      };
    } catch (error) {
      return {
        ...content,
        _bodyIncluded: false,
        _bodyUnavailable: true,
        _bodyError: String(error?.message || error),
      };
    }
  }
  const entries = await Promise.all(requests.map(async (request) => ({
    startedDateTime: request.timestamp,
    time: -1,
    request: {
      method: request.method || "",
      url: request.url || "",
      httpVersion: request.protocol || "",
      headers: Object.entries(request.requestHeaders || {}).map(([name, value]) => ({ name, value: String(value) })),
      queryString: (() => {
        try { return [...new URL(request.url).searchParams.entries()].map(([name, value]) => ({ name, value })); }
        catch { return []; }
      })(),
      cookies: [],
      headersSize: -1,
      bodySize: request.postDataLength ?? -1,
      ...(request.postData ? { postData: { mimeType: request.requestHeaders?.["Content-Type"] || request.requestHeaders?.["content-type"] || "", text: request.postData } } : {}),
    },
    response: {
      status: request.status || 0,
      statusText: request.statusText || "",
      httpVersion: request.protocol || "",
      headers: Object.entries(request.responseHeaders || {}).map(([name, value]) => ({ name, value: String(value) })),
      cookies: [],
      content: await responseContent(request),
      redirectURL: request.responseHeaders?.location || request.responseHeaders?.Location || "",
      headersSize: -1,
      bodySize: request.encodedDataLength ?? -1,
    },
    cache: {
      fromDiskCache: Boolean(request.fromDiskCache),
      fromServiceWorker: Boolean(request.fromServiceWorker),
    },
    timings: request.timing ? {
      blocked: request.timing.proxyStart >= 0 ? request.timing.proxyStart : 0,
      dns: request.timing.dnsEnd >= 0 && request.timing.dnsStart >= 0 ? request.timing.dnsEnd - request.timing.dnsStart : -1,
      connect: request.timing.connectEnd >= 0 && request.timing.connectStart >= 0 ? request.timing.connectEnd - request.timing.connectStart : -1,
      ssl: request.timing.sslEnd >= 0 && request.timing.sslStart >= 0 ? request.timing.sslEnd - request.timing.sslStart : -1,
      send: request.timing.sendEnd >= 0 && request.timing.sendStart >= 0 ? request.timing.sendEnd - request.timing.sendStart : -1,
      wait: request.timing.receiveHeadersEnd >= 0 && request.timing.sendEnd >= 0 ? request.timing.receiveHeadersEnd - request.timing.sendEnd : -1,
      receive: request.finishedAt && request.responseTimestamp ? Math.max(0, new Date(request.finishedAt).getTime() - new Date(request.responseTimestamp).getTime()) : -1,
    } : { send: -1, wait: -1, receive: -1 },
    _requestId: request.requestId,
    _resourceType: request.resourceType,
    _frameId: request.frameId,
    _initiator: request.initiator,
    _securityDetails: request.securityDetails,
    _bodyReadable: Boolean(request.bodyReadable),
  })));
  return {
    tab: pickTab(tab),
    includeBodies,
    maxBodyBytes,
    har: {
      log: {
        version: "1.2",
        creator: { name: "Agent Browser Runtime", version: chrome.runtime.getManifest().version },
        pages: [],
        entries,
      },
    },
  };
}

async function chromeRequestBody(params) {
  if (!params.requestId) throw new Error("requestId is required");
  const { tab, target, session } = await ensureDevtoolsAttached(params);
  const body = await chromeDebuggerSendCommand(target, "Network.getResponseBody", {
    requestId: String(params.requestId),
  });
  const existing = session.requests.get(String(params.requestId));
  return {
    tab: pickTab(tab),
    request: existing || null,
    base64Encoded: body.base64Encoded,
    body: body.body,
  };
}

async function chromeRequestDetail(params) {
  if (!params.requestId) throw new Error("requestId is required");
  const { tab, session } = await ensureDevtoolsAttached(params);
  const request = session.requests.get(String(params.requestId)) || null;
  const cookies = request?.url ? await chrome.cookies.getAll({ url: request.url }).catch(() => []) : [];
  return {
    tab: pickTab(tab),
    requestId: String(params.requestId),
    detail: buildRequestDetail(request, cookies),
    ...(request ? {} : { error: "request_not_found" }),
  };
}

async function chromeRequestPayload(params) {
  if (!params.requestId) throw new Error("requestId is required");
  const { tab, target, session } = await ensureDevtoolsAttached(params);
  const payload = await chromeDebuggerSendCommand(target, "Network.getRequestPostData", {
    requestId: String(params.requestId),
  });
  const existing = session.requests.get(String(params.requestId));
  return {
    tab: pickTab(tab),
    request: existing || null,
    postData: payload.postData,
    postDataLength: payload.postData ? String(payload.postData).length : 0,
    redacted: false,
  };
}

function prepareReplayHeaders(rawHeaders = {}, overrides = {}) {
  const forbidden = new Set([
    "accept-encoding",
    "connection",
    "content-length",
    "cookie",
    "host",
    "origin",
    "referer",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    "sec-fetch-user",
    "te",
    "upgrade-insecure-requests",
  ]);
  const headers = {};
  const skipped = [];
  for (const [key, value] of Object.entries({ ...rawHeaders, ...overrides })) {
    const lower = String(key).toLowerCase();
    if (forbidden.has(lower) || lower.startsWith("sec-ch-")) {
      skipped.push(key);
      continue;
    }
    headers[key] = String(value);
  }
  return { headers, skipped };
}

async function chromeRequestReplay(params) {
  if (!params.requestId) throw new Error("requestId is required");
  const { tab, session } = await ensureDevtoolsAttached(params);
  const request = session.requests.get(String(params.requestId));
  if (!request) throw new Error(`request not found: ${params.requestId}`);
  const url = params.url || request.url;
  const method = String(params.method || request.method || "GET").toUpperCase();
  const headerPrep = prepareReplayHeaders(request.requestHeaders || {}, params.headers || {});
  const body = params.body !== undefined ? String(params.body) : request.postData;
  const includeBody = !["GET", "HEAD"].includes(method) && body !== undefined;
  const replay = await runInTab(tab.id, async ({ url, method, headers, body, includeBody, credentials }) => {
    const startedAt = new Date().toISOString();
    const response = await fetch(url, {
      method,
      headers,
      credentials,
      cache: "no-store",
      redirect: "follow",
      ...(includeBody ? { body } : {}),
    });
    const text = await response.text();
    return {
      ok: response.ok,
      startedAt,
      finishedAt: new Date().toISOString(),
      url: response.url,
      redirected: response.redirected,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      bodyText: text,
      bodyBytes: text.length,
    };
  }, [{
    url,
    method,
    headers: headerPrep.headers,
    body,
    includeBody,
    credentials: params.credentials || "include",
  }]);
  return {
    tab: pickTab(tab),
    originalRequest: request,
    replayRequest: {
      url,
      method,
      headers: headerPrep.headers,
      skippedHeaders: headerPrep.skipped,
      bodyLength: includeBody ? String(body || "").length : 0,
      credentials: params.credentials || "include",
    },
    response: replay,
  };
}

async function chromeConsoleLog(params) {
  const { tab, session } = await ensureDevtoolsAttached(params);
  const limit = Number(params.limit || 100);
  if (params.reload) {
    session.console = [];
    session.exceptions = [];
    await chromeDebuggerSendCommand(debuggerTarget(tab.id), "Page.reload", { ignoreCache: Boolean(params.ignoreCache) }).catch(() => {});
    await delay(Number(params.waitMs || 1000));
  } else {
    await delay(Number(params.waitMs || 200));
  }
  return {
    tab: pickTab(tab),
    counts: {
      console: session.console.length,
      exceptions: session.exceptions.length,
      security: session.security.length,
      scripts: session.scripts.size,
    },
    count: session.console.length,
    console: session.console.slice(-limit),
    exceptions: session.exceptions.slice(-limit),
    security: session.security.slice(-limit),
    scripts: [...session.scripts.values()].slice(-limit),
  };
}

async function chromeConsoleSourceContext(params) {
  const { tab, target, session } = await ensureDevtoolsAttached(params);
  if (params.reload) {
    session.scripts = new Map();
    await chromeDebuggerSendCommand(target, "Page.reload", { ignoreCache: Boolean(params.ignoreCache) }).catch(() => {});
    await delay(Number(params.waitMs || 1000));
  } else {
    await delay(Number(params.waitMs || 300));
  }
  let script = params.scriptId ? session.scripts.get(String(params.scriptId)) : null;
  if (!script && params.urlContains) {
    const needle = String(params.urlContains).toLowerCase();
    script = [...session.scripts.values()].find((entry) => String(entry.url || "").toLowerCase().includes(needle)) || null;
  }
  if (!script) throw new Error("matching script not found");
  const source = await chromeDebuggerSendCommand(target, "Debugger.getScriptSource", { scriptId: script.scriptId });
  const lineNumber = Number(params.lineNumber || 0);
  const contextLines = Number(params.contextLines || 5);
  return {
    tab: pickTab(tab),
    script,
    location: {
      scriptId: script.scriptId,
      url: script.url,
      lineNumber,
      columnNumber: typeof params.columnNumber === "number" ? params.columnNumber : null,
    },
    contextLines,
    lines: sourceContextLines(source.scriptSource || "", lineNumber, contextLines),
  };
}

async function chromeIssuesLog(params) {
  const { tab, target, session } = await ensureDevtoolsAttached(params);
  const limit = Number(params.limit || 100);
  if (params.reload) {
    session.issues = [];
    await chromeDebuggerSendCommand(target, "Page.reload", { ignoreCache: Boolean(params.ignoreCache) }).catch(() => {});
    await delay(Number(params.waitMs || 1200));
  } else {
    await delay(Number(params.waitMs || 200));
  }
  return {
    tab: pickTab(tab),
    auditsAvailable: !session.warnings.some((warning) => String(warning).includes("Audits.enable unavailable")),
    issueCount: session.issues.length,
    issues: session.issues.slice(-limit),
  };
}

async function chromeSecuritySummary(params) {
  const { tab, session } = await ensureDevtoolsAttached(params);
  const page = await runInTab(tab.id, () => ({
    url: location.href,
    origin: location.origin,
    protocol: location.protocol,
    isSecureContext,
    mixedContentType: document.mixedContentType || null,
    referrer: document.referrer,
  }));
  const requests = [...session.requests.values()];
  const tls = requests
    .filter((request) => request.securityDetails)
    .map((request) => ({
      requestId: request.requestId,
      url: request.url,
      protocol: request.securityDetails.protocol,
      subjectName: request.securityDetails.subjectName,
      issuer: request.securityDetails.issuer,
      validFrom: request.securityDetails.validFrom,
      validTo: request.securityDetails.validTo,
      certificateTransparencyCompliance: request.securityDetails.certificateTransparencyCompliance,
      sanList: request.securityDetails.sanList,
    }));
  const byHost = {};
  for (const entry of tls) {
    let host = "";
    try { host = new URL(entry.url).hostname; } catch { host = ""; }
    if (!host || byHost[host]) continue;
    byHost[host] = entry;
  }
  return {
    tab: pickTab(tab),
    page,
    tlsByHost: byHost,
    tlsCount: tls.length,
    recentSecurityEvents: session.security.slice(-50),
    warnings: session.warnings,
  };
}

async function chromePageDiagnostics(params) {
  const { tab, session, target } = await ensureDevtoolsAttached(params);
  const page = await runInTab(tab.id, () => ({
    title: document.title,
    url: location.href,
    origin: location.origin,
    protocol: location.protocol,
    isSecureContext,
    readyState: document.readyState,
    visibilityState: document.visibilityState,
    selectedTextLength: String(getSelection?.() || "").length,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
  }));
  const requests = [...session.requests.values()];
  const websockets = [...session.websockets.values()];
  const storage = await runInTab(tab.id, async () => {
    const indexedDbDatabases = indexedDB?.databases ? await indexedDB.databases().catch(() => []) : [];
    const cacheNames = caches?.keys ? await caches.keys().catch(() => []) : [];
    const serviceWorkers = navigator.serviceWorker?.getRegistrations ? await navigator.serviceWorker.getRegistrations().catch(() => []) : [];
    return {
      localStorageKeys: Object.keys(localStorage || {}).length,
      sessionStorageKeys: Object.keys(sessionStorage || {}).length,
      documentCookieBytes: document.cookie?.length || 0,
      indexedDbDatabases: indexedDbDatabases.length || 0,
      cacheStorageCaches: cacheNames.length || 0,
      serviceWorkerRegistrations: serviceWorkers.length || 0,
    };
  });
  const cookies = await chrome.cookies.getAll({ url: tab.url }).catch(() => []);
  let accessibility = null;
  try {
    await chromeDebuggerSendCommand(target, "Accessibility.enable").catch(() => {});
    const ax = await chromeDebuggerSendCommand(target, "Accessibility.getFullAXTree", { interestingOnly: true });
    accessibility = { nodeCount: Array.isArray(ax.nodes) ? ax.nodes.length : 0 };
  } catch (error) {
    accessibility = { error: String(error?.message || error) };
  }
  const tlsHosts = {};
  for (const request of requests.filter((entry) => entry.securityDetails)) {
    const host = hostnameForUrl(request.url);
    if (!host || tlsHosts[host]) continue;
    tlsHosts[host] = {
      protocol: request.securityDetails.protocol,
      subjectName: request.securityDetails.subjectName,
      issuer: request.securityDetails.issuer,
      certificateTransparencyCompliance: request.securityDetails.certificateTransparencyCompliance,
    };
  }
  return {
    tab: pickTab(tab),
    page,
    capture: session.capture,
    network: summarizeNetworkRecords(requests, websockets, Number(params.limit || 5)),
    security: {
      isSecureContext: page.isSecureContext,
      tlsHosts,
      recentSecurityEventCount: session.security.length,
      warnings: session.warnings,
    },
    console: {
      eventCount: session.console.length,
      recentErrors: session.console
        .filter((entry) => ["error", "assert", "log-entry"].includes(String(entry.type)))
        .slice(-5),
    },
    storage: {
      ...storage,
      browserCookieCount: Array.isArray(cookies) ? cookies.length : 0,
      cookieSummary: summarizeCookies(cookies),
    },
    accessibility,
  };
}

async function chromeRiskSummary(params) {
  const diagnostics = await chromePageDiagnostics(params);
  const cookieResult = await chromeCookieSummary(params);
  const serviceWorkerSummary = await chromeServiceWorkerSummary(params).catch((error) => ({
    error: String(error?.message || error),
  }));
  const tokenScan = params.includeTokenScan
    ? await chromeTokenScan(params).catch((error) => ({ error: String(error?.message || error), findings: [], findingCount: 0 }))
    : null;
  const summary = buildRiskSummary({
    diagnostics,
    cookieSummary: cookieResult.summary,
    serviceWorkerSummary,
    tokenScan,
  });
  return {
    tab: diagnostics.tab,
    page: diagnostics.page,
    capture: diagnostics.capture,
    includeTokenScan: Boolean(params.includeTokenScan),
    ...summary,
  };
}

async function chromeFrameTree(params) {
  const { tab, target, session } = await ensureDevtoolsAttached(params);
  const tree = await chromeDebuggerSendCommand(target, "Page.getFrameTree");
  return {
    tab: pickTab(tab),
    frameTree: tree.frameTree,
    recentFrameEvents: session.frames.slice(-50),
  };
}

async function chromeAccessibilitySnapshot(params) {
  const { tab, target } = await ensureDevtoolsAttached(params);
  const interestingOnly = params.interestingOnly !== false;
  const maxNodes = Number(params.maxNodes || 500);
  await chromeDebuggerSendCommand(target, "Accessibility.enable").catch(() => {});
  const response = await chromeDebuggerSendCommand(target, "Accessibility.getFullAXTree", {
    interestingOnly,
  });
  const nodes = Array.isArray(response.nodes) ? response.nodes.slice(0, maxNodes) : [];
  return {
    tab: pickTab(tab),
    interestingOnly,
    nodeCount: Array.isArray(response.nodes) ? response.nodes.length : 0,
    returned: nodes.length,
    truncated: Array.isArray(response.nodes) ? response.nodes.length > nodes.length : false,
    nodes: nodes.map(normalizeAccessibilityNode),
  };
}

async function chromeHardReload(params) {
  const { tab, target, session } = await ensureDevtoolsAttached(params);
  if (params.clearLog !== false) {
    clearCapturedSessionData(session);
  }
  if (params.startCapture !== false) {
    session.capture.enabled = true;
    session.capture.startedAt = new Date().toISOString();
    session.capture.stoppedAt = null;
    session.capture.label = params.label || session.capture.label || "hard-reload";
  }
  await chromeDebuggerSendCommand(target, "Network.setCacheDisabled", { cacheDisabled: true });
  if (params.bypassServiceWorker !== false) {
    await chromeDebuggerSendCommand(target, "Network.setBypassServiceWorker", { bypass: true }).catch((error) => {
      pushUnique(session.warnings, `Network.setBypassServiceWorker unavailable: ${String(error.message || error)}`);
    });
  }
  await chromeDebuggerSendCommand(target, "Page.reload", { ignoreCache: true });
  return {
    ok: true,
    tab: pickTab(tab),
    cacheDisabled: true,
    bypassServiceWorker: params.bypassServiceWorker !== false,
    clearedPreviousLog: params.clearLog !== false,
    capture: session.capture,
  };
}

async function chromeStorageSnapshot(params) {
  const tab = await getTargetTab(params);
  const maxIndexedDbRecords = Number(params.maxIndexedDbRecords || 20);
  const maxCacheEntries = Number(params.maxCacheEntries || 50);
  const page = await runInTab(tab.id, async (limits) => {
    async function readIndexedDbDatabase(meta) {
      return await new Promise((resolve) => {
        const result = {
          name: meta.name,
          version: meta.version,
          objectStores: [],
        };
        const request = indexedDB.open(meta.name);
        request.onerror = () => resolve({ ...result, error: String(request.error?.message || request.error || "open_failed") });
        request.onsuccess = () => {
          const db = request.result;
          result.version = db.version;
          const storeNames = Array.from(db.objectStoreNames || []);
          if (storeNames.length === 0) {
            db.close();
            resolve(result);
            return;
          }
          let pending = storeNames.length;
          for (const storeName of storeNames) {
            const storeResult = {
              name: storeName,
              keyPath: null,
              autoIncrement: null,
              indexes: [],
              sampleRecords: [],
            };
            result.objectStores.push(storeResult);
            try {
              const tx = db.transaction(storeName, "readonly");
              const store = tx.objectStore(storeName);
              storeResult.keyPath = store.keyPath;
              storeResult.autoIncrement = store.autoIncrement;
              storeResult.indexes = Array.from(store.indexNames || []).map((indexName) => {
                const index = store.index(indexName);
                return { name: index.name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
              });
              const cursorRequest = store.openCursor();
              cursorRequest.onsuccess = () => {
                const cursor = cursorRequest.result;
                if (!cursor || storeResult.sampleRecords.length >= limits.maxIndexedDbRecords) return;
                storeResult.sampleRecords.push({
                  key: cursor.key,
                  primaryKey: cursor.primaryKey,
                  value: cursor.value,
                });
                cursor.continue();
              };
              tx.oncomplete = () => {
                pending -= 1;
                if (pending === 0) {
                  db.close();
                  resolve(result);
                }
              };
              tx.onerror = () => {
                storeResult.error = String(tx.error?.message || tx.error || "transaction_failed");
                pending -= 1;
                if (pending === 0) {
                  db.close();
                  resolve(result);
                }
              };
            } catch (error) {
              storeResult.error = String(error?.message || error);
              pending -= 1;
              if (pending === 0) {
                db.close();
                resolve(result);
              }
            }
          }
        };
      });
    }

    const indexedDBSnapshot = { databases: [], supported: Boolean(indexedDB) };
    try {
      if (indexedDB?.databases) {
        const databases = await indexedDB.databases();
        indexedDBSnapshot.databases = await Promise.all(
          databases
            .filter((database) => database?.name)
            .map((database) => readIndexedDbDatabase(database))
        );
      }
    } catch (error) {
      indexedDBSnapshot.error = String(error?.message || error);
    }

    const cacheSnapshot = { caches: [], supported: Boolean(caches) };
    try {
      if (caches?.keys) {
        const names = await caches.keys();
        cacheSnapshot.caches = await Promise.all(names.map(async (name) => {
          const cache = await caches.open(name);
          const requests = await cache.keys();
          const entries = [];
          for (const request of requests.slice(0, limits.maxCacheEntries)) {
            const response = await cache.match(request);
            entries.push({
              url: request.url,
              method: request.method,
              mode: request.mode,
              credentials: request.credentials,
              destination: request.destination,
              status: response?.status,
              statusText: response?.statusText,
              type: response?.type,
              headers: response ? Object.fromEntries(response.headers.entries()) : {},
            });
          }
          return { name, entryCount: requests.length, entries };
        }));
      }
    } catch (error) {
      cacheSnapshot.error = String(error?.message || error);
    }

    const serviceWorkerSnapshot = { supported: Boolean(navigator.serviceWorker) };
    try {
      if (navigator.serviceWorker?.getRegistrations) {
        serviceWorkerSnapshot.registrations = (await navigator.serviceWorker.getRegistrations()).map((registration) => ({
          scope: registration.scope,
          active: registration.active ? { scriptURL: registration.active.scriptURL, state: registration.active.state } : null,
          waiting: registration.waiting ? { scriptURL: registration.waiting.scriptURL, state: registration.waiting.state } : null,
          installing: registration.installing ? { scriptURL: registration.installing.scriptURL, state: registration.installing.state } : null,
        }));
      }
    } catch (error) {
      serviceWorkerSnapshot.error = String(error?.message || error);
    }

    return {
      url: location.href,
      localStorage: Object.fromEntries(Object.entries(localStorage || {})),
      sessionStorage: Object.fromEntries(Object.entries(sessionStorage || {})),
      cookieVisibleToDocument: document.cookie,
      indexedDB: indexedDBSnapshot,
      cacheStorage: cacheSnapshot,
      serviceWorker: serviceWorkerSnapshot,
    };
  }, [{ maxIndexedDbRecords, maxCacheEntries }]);
  const cookies = await chrome.cookies.getAll({ url: tab.url }).catch((error) => ({
    error: String(error.message || error),
  }));
  return { tab: pickTab(tab), page, cookies };
}

async function chromeStorageOriginSummary(params) {
  const { tab, target } = await ensureDevtoolsAttached(params);
  await chromeDebuggerSendCommand(target, "Storage.enable").catch(() => {});
  const page = await runInTab(tab.id, async () => ({
    url: location.href,
    origin: location.origin,
    protocol: location.protocol,
    host: location.host,
    storageEstimateSupported: Boolean(navigator.storage?.estimate),
    storageEstimate: navigator.storage?.estimate ? await navigator.storage.estimate().catch((error) => ({ error: String(error?.message || error) })) : null,
    cookieEnabled: navigator.cookieEnabled,
  }));
  const frameTree = await chromeDebuggerSendCommand(target, "Page.getFrameTree").catch(() => null);
  const frames = [];
  function walkFrame(node, parentId = null) {
    if (!node?.frame) return;
    let origin = "";
    try { origin = new URL(node.frame.url).origin; } catch {}
    frames.push({
      id: node.frame.id,
      parentId,
      url: node.frame.url,
      origin,
      name: node.frame.name,
      securityOrigin: node.frame.securityOrigin,
      mimeType: node.frame.mimeType,
    });
    for (const child of node.childFrames || []) walkFrame(child, node.frame.id);
  }
  walkFrame(frameTree?.frameTree);
  const framesWithStorage = [];
  for (const frame of frames) {
    const storageKeyResult = await chromeDebuggerSendCommand(target, "Storage.getStorageKeyForFrame", { frameId: frame.id }).catch(() => null);
    const usageAndQuota = frame.origin && frame.origin !== "null"
      ? await chromeDebuggerSendCommand(target, "Storage.getUsageAndQuota", { origin: frame.origin }).catch((error) => ({ error: String(error?.message || error) }))
      : null;
    framesWithStorage.push({ ...frame, storageKey: storageKeyResult?.storageKey || null, usageAndQuota });
  }
  const cookies = await chrome.cookies.getAll({ url: tab.url }).catch(() => []);
  return {
    tab: pickTab(tab),
    page,
    frames: framesWithStorage,
    cookieCount: Array.isArray(cookies) ? cookies.length : 0,
    cookiePartitions: Array.isArray(cookies) ? cookies.map((cookie) => ({
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      sameSite: cookie.sameSite,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      partitionKey: cookie.partitionKey,
      partitionKeyOpaque: cookie.partitionKeyOpaque,
      storeId: cookie.storeId,
    })) : cookies,
  };
}

async function chromeCookieSummary(params) {
  const tab = await getTargetTab(params);
  const cookies = await chrome.cookies.getAll({ url: tab.url }).catch((error) => ({
    error: String(error.message || error),
  }));
  return {
    tab: pickTab(tab),
    summary: summarizeCookies(cookies),
    cookies,
  };
}

async function chromeServiceWorkerSummary(params) {
  const tab = await getTargetTab(params);
  const page = await runInTab(tab.id, async () => {
    const result = {
      url: location.href,
      origin: location.origin,
      secureContext: isSecureContext,
      controlledBy: navigator.serviceWorker?.controller
        ? {
            scriptURL: navigator.serviceWorker.controller.scriptURL,
            state: navigator.serviceWorker.controller.state,
          }
        : null,
      registrations: [],
      cacheStorage: { supported: Boolean(caches), names: [] },
    };
    try {
      if (navigator.serviceWorker?.getRegistrations) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        result.registrations = registrations.map((registration) => ({
          scope: registration.scope,
          updateViaCache: registration.updateViaCache,
          active: registration.active ? { scriptURL: registration.active.scriptURL, state: registration.active.state } : null,
          waiting: registration.waiting ? { scriptURL: registration.waiting.scriptURL, state: registration.waiting.state } : null,
          installing: registration.installing ? { scriptURL: registration.installing.scriptURL, state: registration.installing.state } : null,
        }));
      }
    } catch (error) {
      result.registrationError = String(error?.message || error);
    }
    try {
      if (caches?.keys) {
        const names = await caches.keys();
        result.cacheStorage.names = names;
        result.cacheStorage.caches = await Promise.all(names.map(async (name) => {
          const cache = await caches.open(name);
          const requests = await cache.keys();
          return {
            name,
            entryCount: requests.length,
            sampleUrls: requests.slice(0, 10).map((request) => request.url),
          };
        }));
      }
    } catch (error) {
      result.cacheStorage.error = String(error?.message || error);
    }
    return result;
  });
  let debuggerTargets = [];
  try {
    const targets = await chrome.debugger.getTargets();
    debuggerTargets = targets
      .filter((target) => ["service_worker", "worker", "shared_worker"].includes(target.type))
      .map((target) => ({
        id: target.id,
        type: target.type,
        title: target.title,
        url: target.url,
        tabId: target.tabId,
        attached: target.attached,
      }));
  } catch (error) {
    debuggerTargets = [{ error: String(error?.message || error) }];
  }
  return {
    tab: pickTab(tab),
    page,
    registrationCount: page.registrations?.length || 0,
    cacheCount: page.cacheStorage?.names?.length || 0,
    debuggerTargets,
    debuggerTargetCount: debuggerTargets.filter((target) => !target.error).length,
  };
}

async function chromeApplicationExport(params) {
  const tab = await getTargetTab(params);
  const maxIndexedDbRecords = Number(params.maxIndexedDbRecords || 1000);
  const maxCacheEntries = Number(params.maxCacheEntries || 500);
  const includeCacheBodies = params.includeCacheBodies !== false;
  const maxCacheBodyChars = Number(params.maxCacheBodyChars || 200000);
  const page = await runInTab(tab.id, async ({ maxIndexedDbRecords, maxCacheEntries, includeCacheBodies, maxCacheBodyChars }) => {
    async function readIndexedDbDatabase(meta) {
      return await new Promise((resolve) => {
        const result = { name: meta.name, version: meta.version, objectStores: [] };
        const request = indexedDB.open(meta.name);
        request.onerror = () => resolve({ ...result, error: String(request.error?.message || request.error || "open_failed") });
        request.onsuccess = () => {
          const db = request.result;
          result.version = db.version;
          const storeNames = Array.from(db.objectStoreNames || []);
          if (!storeNames.length) {
            db.close();
            resolve(result);
            return;
          }
          let pending = storeNames.length;
          for (const storeName of storeNames) {
            const storeResult = {
              name: storeName,
              keyPath: null,
              autoIncrement: null,
              indexes: [],
              records: [],
              truncated: false,
            };
            result.objectStores.push(storeResult);
            try {
              const tx = db.transaction(storeName, "readonly");
              const store = tx.objectStore(storeName);
              storeResult.keyPath = store.keyPath;
              storeResult.autoIncrement = store.autoIncrement;
              storeResult.indexes = Array.from(store.indexNames || []).map((indexName) => {
                const index = store.index(indexName);
                return { name: index.name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
              });
              const cursorRequest = store.openCursor();
              cursorRequest.onsuccess = () => {
                const cursor = cursorRequest.result;
                if (!cursor) return;
                if (storeResult.records.length >= maxIndexedDbRecords) {
                  storeResult.truncated = true;
                  return;
                }
                storeResult.records.push({ key: cursor.key, primaryKey: cursor.primaryKey, value: cursor.value });
                cursor.continue();
              };
              tx.oncomplete = () => {
                pending -= 1;
                if (pending === 0) {
                  db.close();
                  resolve(result);
                }
              };
              tx.onerror = () => {
                storeResult.error = String(tx.error?.message || tx.error || "transaction_failed");
                pending -= 1;
                if (pending === 0) {
                  db.close();
                  resolve(result);
                }
              };
            } catch (error) {
              storeResult.error = String(error?.message || error);
              pending -= 1;
              if (pending === 0) {
                db.close();
                resolve(result);
              }
            }
          }
        };
      });
    }

    const indexedDBExport = { supported: Boolean(indexedDB), databases: [] };
    try {
      if (indexedDB?.databases) {
        const databases = await indexedDB.databases();
        indexedDBExport.databases = await Promise.all(
          databases.filter((database) => database?.name).map((database) => readIndexedDbDatabase(database))
        );
      }
    } catch (error) {
      indexedDBExport.error = String(error?.message || error);
    }

    const cacheExport = { supported: Boolean(caches), caches: [] };
    try {
      if (caches?.keys) {
        const names = await caches.keys();
        cacheExport.caches = await Promise.all(names.map(async (name) => {
          const cache = await caches.open(name);
          const requests = await cache.keys();
          const entries = [];
          for (const request of requests.slice(0, maxCacheEntries)) {
            const response = await cache.match(request);
            const entry = {
              url: request.url,
              method: request.method,
              mode: request.mode,
              credentials: request.credentials,
              destination: request.destination,
              status: response?.status,
              statusText: response?.statusText,
              type: response?.type,
              headers: response ? Object.fromEntries(response.headers.entries()) : {},
            };
            if (response && includeCacheBodies) {
              try {
                const bodyText = await response.clone().text();
                entry.bodyText = bodyText.slice(0, maxCacheBodyChars);
                entry.bodyBytes = bodyText.length;
                entry.bodyTruncated = bodyText.length > maxCacheBodyChars;
              } catch (error) {
                entry.bodyError = String(error?.message || error);
              }
            }
            entries.push(entry);
          }
          return { name, entryCount: requests.length, entries, truncated: requests.length > maxCacheEntries };
        }));
      }
    } catch (error) {
      cacheExport.error = String(error?.message || error);
    }

    const serviceWorkerExport = { supported: Boolean(navigator.serviceWorker), registrations: [] };
    try {
      if (navigator.serviceWorker?.getRegistrations) {
        serviceWorkerExport.controller = navigator.serviceWorker.controller
          ? { scriptURL: navigator.serviceWorker.controller.scriptURL, state: navigator.serviceWorker.controller.state }
          : null;
        serviceWorkerExport.registrations = (await navigator.serviceWorker.getRegistrations()).map((registration) => ({
          scope: registration.scope,
          updateViaCache: registration.updateViaCache,
          active: registration.active ? { scriptURL: registration.active.scriptURL, state: registration.active.state } : null,
          waiting: registration.waiting ? { scriptURL: registration.waiting.scriptURL, state: registration.waiting.state } : null,
          installing: registration.installing ? { scriptURL: registration.installing.scriptURL, state: registration.installing.state } : null,
        }));
      }
    } catch (error) {
      serviceWorkerExport.error = String(error?.message || error);
    }

    return {
      exportedAt: new Date().toISOString(),
      url: location.href,
      origin: location.origin,
      localStorage: Object.fromEntries(Object.entries(localStorage || {})),
      sessionStorage: Object.fromEntries(Object.entries(sessionStorage || {})),
      cookieVisibleToDocument: document.cookie,
      indexedDB: indexedDBExport,
      cacheStorage: cacheExport,
      serviceWorker: serviceWorkerExport,
    };
  }, [{ maxIndexedDbRecords, maxCacheEntries, includeCacheBodies, maxCacheBodyChars }]);
  const cookies = await chrome.cookies.getAll({ url: tab.url }).catch((error) => ({
    error: String(error.message || error),
  }));
  return {
    tab: pickTab(tab),
    export: {
      ...page,
      browserCookies: cookies,
    },
  };
}

async function chromeIndexedDbRead(params) {
  if (!params.database) throw new Error("database is required");
  if (!params.store) throw new Error("store is required");
  const tab = await getTargetTab(params);
  const limit = Number(params.limit || 50);
  const offset = Number(params.offset || 0);
  const page = await runInTab(tab.id, async ({ database, storeName, limit, offset }) => {
    return await new Promise((resolve) => {
      const records = [];
      const open = indexedDB.open(database);
      open.onerror = () => resolve({ ok: false, error: String(open.error?.message || open.error || "open_failed"), database, store: storeName, records });
      open.onsuccess = () => {
        const db = open.result;
        if (!Array.from(db.objectStoreNames || []).includes(storeName)) {
          db.close();
          resolve({ ok: false, error: "store_not_found", database, store: storeName, records });
          return;
        }
        const tx = db.transaction(storeName, "readonly");
        const store = tx.objectStore(storeName);
        let skipped = 0;
        const cursorRequest = store.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor || records.length >= limit) return;
          if (skipped < offset) {
            skipped += 1;
            cursor.continue();
            return;
          }
          records.push({ key: cursor.key, primaryKey: cursor.primaryKey, value: cursor.value });
          cursor.continue();
        };
        tx.oncomplete = () => {
          db.close();
          resolve({ ok: true, database, store: storeName, limit, offset, returned: records.length, records });
        };
        tx.onerror = () => {
          db.close();
          resolve({ ok: false, error: String(tx.error?.message || tx.error || "transaction_failed"), database, store: storeName, records });
        };
      };
    });
  }, [{ database: String(params.database), storeName: String(params.store), limit, offset }]);
  return { tab: pickTab(tab), page };
}

async function chromeCacheEntryGet(params) {
  if (!params.cacheName) throw new Error("cacheName is required");
  if (!params.url) throw new Error("url is required");
  const tab = await getTargetTab(params);
  const page = await runInTab(tab.id, async ({ cacheName, url }) => {
    const cache = await caches.open(cacheName);
    const response = await cache.match(url);
    if (!response) return { ok: false, error: "cache_entry_not_found", cacheName, url };
    const bodyText = await response.clone().text();
    return {
      ok: true,
      cacheName,
      url,
      status: response.status,
      statusText: response.statusText,
      type: response.type,
      headers: Object.fromEntries(response.headers.entries()),
      bodyText,
      bodyBytes: bodyText.length,
    };
  }, [{ cacheName: String(params.cacheName), url: String(params.url) }]);
  return { tab: pickTab(tab), page };
}

async function chromeElementsSnapshot(params) {
  const tab = await getTargetTab(params);
  const maxNodes = Number(params.maxNodes || 250);
  const maxDepth = Number(params.maxDepth || 6);
  const selector = params.selector ? String(params.selector) : null;
  const page = await runInTab(tab.id, ({ maxNodes, maxDepth, selector }) => {
    let seen = 0;
    function nodeLabel(node) {
      if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
      const el = node;
      const id = el.id ? `#${el.id}` : "";
      const cls = typeof el.className === "string" && el.className.trim()
        ? `.${el.className.trim().split(/\s+/).slice(0, 4).join(".")}`
        : "";
      return `${el.tagName.toLowerCase()}${id}${cls}`;
    }
    function cssPath(el) {
      const parts = [];
      let current = el;
      while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
        let part = current.tagName.toLowerCase();
        if (current.id) {
          part += `#${CSS.escape(current.id)}`;
          parts.unshift(part);
          break;
        }
        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
        parts.unshift(part);
        current = parent;
      }
      return parts.join(" > ");
    }
    function serialize(el, depth = 0) {
      if (!el || seen >= maxNodes || depth > maxDepth) return null;
      seen += 1;
      const rect = el.getBoundingClientRect();
      const attrs = {};
      for (const attr of Array.from(el.attributes || [])) {
        if (["id", "class", "name", "role", "aria-label", "type", "href", "src", "alt", "title"].includes(attr.name)) {
          attrs[attr.name] = attr.value;
        }
      }
      return {
        label: nodeLabel(el),
        path: cssPath(el),
        text: (el.innerText || el.textContent || "").trim().slice(0, 160),
        attrs,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          visible: rect.width > 0 && rect.height > 0,
        },
        children: Array.from(el.children || [])
          .map((child) => serialize(child, depth + 1))
          .filter(Boolean),
      };
    }
    function inspectElement(el) {
      if (!el) return null;
      const computed = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        label: nodeLabel(el),
        path: cssPath(el),
        outerHTML: el.outerHTML.slice(0, 4000),
        text: (el.innerText || el.textContent || "").trim().slice(0, 2000),
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          left: rect.left,
        },
        computedStyle: {
          display: computed.display,
          visibility: computed.visibility,
          opacity: computed.opacity,
          position: computed.position,
          zIndex: computed.zIndex,
          pointerEvents: computed.pointerEvents,
          overflow: computed.overflow,
          color: computed.color,
          backgroundColor: computed.backgroundColor,
          font: computed.font,
        },
      };
    }
    const selected = selector ? document.querySelector(selector) : null;
    return {
      url: location.href,
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      doctype: document.doctype ? `<!doctype ${document.doctype.name}>` : null,
      root: serialize(document.documentElement),
      selected: selector ? inspectElement(selected) : null,
      selectedFound: selector ? Boolean(selected) : undefined,
      nodeCountReturned: seen,
      truncated: seen >= maxNodes,
    };
  }, [{ maxNodes, maxDepth, selector }]);
  return { tab: pickTab(tab), page };
}

async function chromeDomSnapshot(params) {
  const { tab, target } = await ensureDevtoolsAttached(params);
  const computedStyles = Array.isArray(params.computedStyles) && params.computedStyles.length
    ? params.computedStyles.map(String)
    : [
        "display",
        "visibility",
        "opacity",
        "position",
        "z-index",
        "color",
        "background-color",
        "font-family",
        "font-size",
        "font-weight",
        "pointer-events",
      ];
  const snapshot = await chromeDebuggerSendCommand(target, "DOMSnapshot.captureSnapshot", {
    computedStyles,
    includeDOMRects: params.includeDOMRects !== false,
    includePaintOrder: params.includePaintOrder !== false,
    includeBlendedBackgroundColors: Boolean(params.includeBlendedBackgroundColors),
    includeTextColorOpacities: Boolean(params.includeTextColorOpacities),
  });
  return {
    tab: pickTab(tab),
    computedStyles,
    documentCount: Array.isArray(snapshot.documents) ? snapshot.documents.length : 0,
    stringCount: Array.isArray(snapshot.strings) ? snapshot.strings.length : 0,
    snapshot,
  };
}

async function chromeDomSearch(params) {
  if (!params.query) throw new Error("query is required");
  const { tab, target } = await ensureDevtoolsAttached(params);
  const query = String(params.query || "");
  const maxResults = Number(params.maxResults || 20);
  const maxOuterHTMLChars = Number(params.maxOuterHTMLChars || 1200);
  await chromeDebuggerSendCommand(target, "DOM.enable").catch(() => {});
  const search = await chromeDebuggerSendCommand(target, "DOM.performSearch", {
    query,
    includeUserAgentShadowDOM: Boolean(params.includeUserAgentShadowDOM),
  });
  const count = Number(search.resultCount || 0);
  const endIndex = Math.min(count, Math.max(0, maxResults));
  const ids = endIndex > 0
    ? await chromeDebuggerSendCommand(target, "DOM.getSearchResults", { searchId: search.searchId, fromIndex: 0, toIndex: endIndex })
    : { nodeIds: [] };
  const results = [];
  for (const nodeId of ids.nodeIds || []) {
    const described = await chromeDebuggerSendCommand(target, "DOM.describeNode", { nodeId, depth: 1, pierce: true })
      .catch((error) => ({ error: String(error?.message || error), node: { nodeId } }));
    const outer = await chromeDebuggerSendCommand(target, "DOM.getOuterHTML", { nodeId })
      .catch((error) => ({ error: String(error?.message || error), outerHTML: "" }));
    results.push({
      source: "cdp",
      ...domSearchNodeSummary(described.node || { nodeId }, outer, maxOuterHTMLChars),
      describeError: described.error,
      outerHTMLError: outer.error,
    });
  }
  await chromeDebuggerSendCommand(target, "DOM.discardSearchResults", { searchId: search.searchId }).catch(() => {});
  const validResultCount = results.filter((entry) => entry.outerHTML || entry.nodeName || entry.localName).length;
  let fallback = null;
  if (validResultCount < Math.min(count, maxResults)) {
    const fallbackResult = await chromeDebuggerSendCommand(target, "Runtime.evaluate", {
      expression: `(${domSearchFallbackPageFunction.toString()})(${JSON.stringify({ query, maxResults, maxOuterHTMLChars })})`,
      awaitPromise: true,
      returnByValue: true,
    }).catch((error) => ({ error: String(error?.message || error) }));
    fallback = fallbackResult.error ? { error: fallbackResult.error, results: [] } : fallbackResult.result?.value;
  }
  const fallbackResults = Array.isArray(fallback?.results) ? fallback.results : [];
  const merged = [
    ...results.filter((entry) => entry.outerHTML || entry.nodeName || entry.localName),
    ...fallbackResults,
  ].slice(0, maxResults);
  return {
    tab: pickTab(tab),
    query,
    includeUserAgentShadowDOM: Boolean(params.includeUserAgentShadowDOM),
    resultCount: count,
    returnedCount: merged.length,
    truncated: count > merged.length,
    fallbackUsed: Boolean(fallbackResults.length || fallback?.error),
    fallbackError: fallback?.error,
    results: merged,
  };
}

async function chromeEventListeners(params) {
  const { tab, target } = await ensureDevtoolsAttached(params);
  const selector = params.selector ? String(params.selector) : "document";
  const expression = selector === "document" ? "document" : `document.querySelector(${JSON.stringify(selector)})`;
  const node = await chromeDebuggerSendCommand(target, "Runtime.evaluate", {
    expression,
    objectGroup: "agent-browser-runtime-event-listeners",
    returnByValue: false,
  });
  const objectId = node.result?.objectId;
  if (!objectId) {
    return {
      tab: pickTab(tab),
      selector,
      found: false,
      listeners: [],
      count: 0,
    };
  }
  const result = await chromeDebuggerSendCommand(target, "DOMDebugger.getEventListeners", {
    objectId,
    depth: typeof params.depth === "number" ? params.depth : -1,
    pierce: params.pierce !== false,
  });
  await chromeDebuggerSendCommand(target, "Runtime.releaseObjectGroup", { objectGroup: "agent-browser-runtime-event-listeners" }).catch(() => {});
  const listeners = (result.listeners || []).map((listener) => ({
    type: listener.type,
    useCapture: listener.useCapture,
    passive: listener.passive,
    once: listener.once,
    scriptId: listener.scriptId,
    lineNumber: listener.lineNumber,
    columnNumber: listener.columnNumber,
    handler: listener.handler ? {
      type: listener.handler.type,
      subtype: listener.handler.subtype,
      className: listener.handler.className,
      description: listener.handler.description,
      objectId: listener.handler.objectId,
    } : null,
    originalHandler: listener.originalHandler ? {
      type: listener.originalHandler.type,
      subtype: listener.originalHandler.subtype,
      className: listener.originalHandler.className,
      description: listener.originalHandler.description,
      objectId: listener.originalHandler.objectId,
    } : null,
    backendNodeId: listener.backendNodeId,
  }));
  return {
    tab: pickTab(tab),
    selector,
    found: true,
    count: listeners.length,
    listeners,
  };
}

async function chromeCssStyles(params) {
  const { tab, target } = await ensureDevtoolsAttached(params);
  const selector = params.selector ? String(params.selector) : "body";
  const maxRules = Number(params.maxRules || 80);
  await chromeDebuggerSendCommand(target, "DOM.enable");
  await chromeDebuggerSendCommand(target, "CSS.enable");
  const documentNode = await chromeDebuggerSendCommand(target, "DOM.getDocument", { depth: -1, pierce: true });
  const query = await chromeDebuggerSendCommand(target, "DOM.querySelector", {
    nodeId: documentNode.root.nodeId,
    selector,
  });
  if (!query.nodeId) {
    return {
      tab: pickTab(tab),
      selector,
      found: false,
    };
  }
  const matchedStyles = params.includeMatchedRules === false
    ? null
    : await chromeDebuggerSendCommand(target, "CSS.getMatchedStylesForNode", { nodeId: query.nodeId }).catch((error) => ({ error: String(error?.message || error) }));
  const computedStyle = params.includeComputed === false
    ? null
    : await chromeDebuggerSendCommand(target, "CSS.getComputedStyleForNode", { nodeId: query.nodeId }).catch((error) => ({ error: String(error?.message || error) }));
  const boxModel = params.includeBoxModel === false
    ? null
    : await chromeDebuggerSendCommand(target, "DOM.getBoxModel", { nodeId: query.nodeId }).catch((error) => ({ error: String(error?.message || error) }));
  return {
    tab: pickTab(tab),
    selector,
    found: true,
    nodeId: query.nodeId,
    matchedStyles: matchedStyles ? {
      inlineStyle: matchedStyles.inlineStyle,
      attributesStyle: matchedStyles.attributesStyle,
      matchedCSSRules: Array.isArray(matchedStyles.matchedCSSRules) ? matchedStyles.matchedCSSRules.slice(0, maxRules) : matchedStyles.matchedCSSRules,
      inherited: Array.isArray(matchedStyles.inherited) ? matchedStyles.inherited.slice(0, maxRules) : matchedStyles.inherited,
      pseudoElements: matchedStyles.pseudoElements,
      cssKeyframesRules: matchedStyles.cssKeyframesRules,
      parentLayoutNodeId: matchedStyles.parentLayoutNodeId,
      positionFallbackRules: matchedStyles.positionFallbackRules,
      error: matchedStyles.error,
      truncatedRules: Array.isArray(matchedStyles.matchedCSSRules) && matchedStyles.matchedCSSRules.length > maxRules,
    } : null,
    computedStyle,
    boxModel,
  };
}

async function chromeDomMutationWatch(params) {
  if (!params.selector) throw new Error("selector is required");
  const { tab, target } = await ensureDevtoolsAttached(params);
  const durationMs = Math.min(Math.max(Number(params.durationMs || 1000), 100), 10000);
  const maxEvents = Number(params.maxEvents || 100);
  await chromeDebuggerSendCommand(target, "Runtime.enable").catch(() => {});
  const expression = `(${domMutationWatchPageFunction.toString()})(${JSON.stringify({
    selector: String(params.selector || ""),
    durationMs,
    maxEvents,
    subtree: params.subtree !== false,
    childList: params.childList !== false,
    attributes: params.attributes !== false,
    characterData: Boolean(params.characterData),
    attributeOldValue: params.attributeOldValue !== false,
    characterDataOldValue: Boolean(params.characterDataOldValue),
    triggerExpression: params.triggerExpression ? String(params.triggerExpression) : "",
  })})`;
  const result = await chromeDebuggerSendCommand(target, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "DOM mutation watch failed");
  }
  return {
    tab: pickTab(tab),
    ...(result.result?.value || {}),
  };
}

async function chromeCdpCommand(params) {
  const method = String(params.method || "").trim();
  if (!/^[A-Za-z0-9_.]+$/.test(method) || !method.includes(".")) {
    throw new Error("method must be a Chrome DevTools Protocol method like Runtime.evaluate");
  }
  const { tab, target } = await ensureDevtoolsAttached(params);
  const result = await chromeDebuggerSendCommand(target, method, params.params && typeof params.params === "object" ? params.params : {});
  return {
    tab: pickTab(tab),
    method,
    result,
  };
}

async function chromeDebuggerControl(params) {
  const { tab, target, session } = await ensureDevtoolsAttached(params);
  const action = String(params.action || "snapshot");
  const waitMs = Math.min(Math.max(Number(params.waitMs || 1000), 50), 10000);
  let commandResult = null;
  let pendingCommand = null;
  if (action === "setBreakpointByUrl") {
    commandResult = await chromeDebuggerSendCommand(target, "Debugger.setBreakpointByUrl", {
      lineNumber: Number(params.lineNumber || 0),
      url: params.url ? String(params.url) : undefined,
      urlRegex: params.urlRegex ? String(params.urlRegex) : undefined,
      columnNumber: Number(params.columnNumber || 0),
      condition: params.condition ? String(params.condition) : undefined,
    });
  } else if (action === "removeBreakpoint") {
    commandResult = await chromeDebuggerSendCommand(target, "Debugger.removeBreakpoint", { breakpointId: String(params.breakpointId || "") });
  } else if (action === "setXHRBreakpoint") {
    commandResult = await chromeDebuggerSendCommand(target, "DOMDebugger.setXHRBreakpoint", { url: String(params.xhrUrlContains || "") });
  } else if (action === "removeXHRBreakpoint") {
    commandResult = await chromeDebuggerSendCommand(target, "DOMDebugger.removeXHRBreakpoint", { url: String(params.xhrUrlContains || "") });
  } else if (action === "pause") {
    commandResult = await chromeDebuggerSendCommand(target, "Debugger.pause");
    await delay(waitMs);
  } else if (action === "resume") {
    commandResult = await chromeDebuggerSendCommand(target, "Debugger.resume").catch((error) => ({ error: String(error?.message || error) }));
    await delay(50);
  } else if (action === "stepOver") {
    commandResult = await chromeDebuggerSendCommand(target, "Debugger.stepOver").catch((error) => ({ error: String(error?.message || error) }));
    await delay(waitMs);
  } else if (action === "stepInto") {
    commandResult = await chromeDebuggerSendCommand(target, "Debugger.stepInto").catch((error) => ({ error: String(error?.message || error) }));
    await delay(waitMs);
  } else if (action === "stepOut") {
    commandResult = await chromeDebuggerSendCommand(target, "Debugger.stepOut").catch((error) => ({ error: String(error?.message || error) }));
    await delay(waitMs);
  } else if (action === "pauseOnExpression") {
    const expression = params.expression ? String(params.expression) : "debugger;";
    pendingCommand = chromeDebuggerSendCommand(target, "Runtime.evaluate", {
      expression,
      awaitPromise: false,
      returnByValue: false,
    }).catch((error) => ({ error: String(error?.message || error) }));
    commandResult = { pending: true, reason: "Runtime.evaluate may remain pending while JavaScript is paused." };
    await delay(waitMs);
  } else if (action !== "snapshot") {
    throw new Error(`unsupported debugger action: ${action}`);
  }

  const paused = await debuggerPausedSummary(target, session.paused, params || {});
  const shouldResume = params.autoResume !== false && ["pause", "pauseOnExpression", "stepOver", "stepInto", "stepOut"].includes(action);
  let resumeResult = null;
  if (paused && shouldResume) {
    resumeResult = await chromeDebuggerSendCommand(target, "Debugger.resume").catch((error) => ({ error: String(error?.message || error) }));
    await delay(50);
  }
  if (pendingCommand) {
    commandResult = await Promise.race([
      pendingCommand,
      delay(1000).then(() => ({ pending: true, reason: "Runtime.evaluate did not settle after resume timeout." })),
    ]);
  }
  return {
    tab: pickTab(tab),
    action,
    commandResult,
    paused,
    debuggerEvents: (session.debuggerEvents || []).slice(-20),
    autoResumed: Boolean(paused && shouldResume),
    resumeResult,
  };
}

async function chromeMemorySnapshot(params) {
  const { tab, target } = await ensureDevtoolsAttached(params);
  await chromeDebuggerSendCommand(target, "Runtime.enable").catch(() => {});
  await chromeDebuggerSendCommand(target, "Performance.enable").catch(() => {});
  const heap = await chromeDebuggerSendCommand(target, "Runtime.getHeapUsage").catch((error) => ({ error: String(error?.message || error) }));
  const domCounters = await chromeDebuggerSendCommand(target, "Memory.getDOMCounters").catch((error) => ({ error: String(error?.message || error) }));
  const metrics = await chromeDebuggerSendCommand(target, "Performance.getMetrics").catch((error) => ({ error: String(error?.message || error), metrics: [] }));
  return {
    tab: pickTab(tab),
    timestamp: new Date().toISOString(),
    heap,
    domCounters,
    performanceMetrics: Array.isArray(metrics.metrics) ? metrics.metrics : [],
    performanceError: metrics.error,
  };
}

async function chromeSourcesList(params) {
  const { tab, session } = await ensureDevtoolsAttached(params);
  const limit = Number(params.limit || 200);
  let scripts = [...session.scripts.values()];
  if (params.urlContains) {
    const needle = String(params.urlContains).toLowerCase();
    scripts = scripts.filter((script) => String(script.url || "").toLowerCase().includes(needle));
  }
  if (typeof params.hasSourceMap === "boolean") {
    scripts = scripts.filter((script) => Boolean(script.sourceMapURL) === params.hasSourceMap);
  }
  if (typeof params.isModule === "boolean") {
    scripts = scripts.filter((script) => Boolean(script.isModule) === params.isModule);
  }
  return {
    tab: pickTab(tab),
    count: scripts.length,
    scripts: scripts.slice(-limit),
  };
}

async function chromeSourceGet(params) {
  if (!params.scriptId) throw new Error("scriptId is required");
  const { tab, target, session } = await ensureDevtoolsAttached(params);
  const source = await chromeDebuggerSendCommand(target, "Debugger.getScriptSource", {
    scriptId: String(params.scriptId),
  });
  const script = session.scripts.get(String(params.scriptId)) || null;
  return {
    tab: pickTab(tab),
    script,
    scriptId: String(params.scriptId),
    scriptSource: source.scriptSource,
    bytecode: source.bytecode,
    length: source.scriptSource ? String(source.scriptSource).length : 0,
  };
}

function sourceMatches(script, params = {}) {
  if (params.urlContains) {
    const needle = String(params.urlContains).toLowerCase();
    if (!String(script.url || "").toLowerCase().includes(needle)) return false;
  }
  if (typeof params.hasSourceMap === "boolean" && Boolean(script.sourceMapURL) !== params.hasSourceMap) return false;
  if (typeof params.isModule === "boolean" && Boolean(script.isModule) !== params.isModule) return false;
  return true;
}

function findSourceMatches(sourceText, query, options = {}) {
  const caseSensitive = Boolean(options.caseSensitive);
  const maxMatches = Number(options.maxMatches || 50);
  const contextChars = Number(options.contextChars || 80);
  const haystack = caseSensitive ? sourceText : sourceText.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches = [];
  let index = 0;
  while (needle && matches.length < maxMatches) {
    const found = haystack.indexOf(needle, index);
    if (found < 0) break;
    const before = sourceText.slice(0, found);
    const line = before.split(/\r?\n/).length;
    const column = found - Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r"), -1) - 1;
    matches.push({
      index: found,
      line,
      column,
      snippet: sourceText.slice(Math.max(0, found - contextChars), Math.min(sourceText.length, found + query.length + contextChars)),
    });
    index = found + Math.max(needle.length, 1);
  }
  return matches;
}

function pushTextSearchMatches(results, { category, source, locator = {}, text, query, options = {} }) {
  const maxMatches = Number(options.maxMatches || 50);
  const remaining = Math.max(0, maxMatches - results.length);
  if (!remaining) return;
  const matches = findSourceMatches(String(text || ""), String(query || ""), {
    caseSensitive: Boolean(options.caseSensitive),
    maxMatches: remaining,
    contextChars: Number(options.contextChars || 120),
  });
  for (const match of matches) {
    results.push({
      category,
      source,
      ...locator,
      ...match,
    });
    if (results.length >= maxMatches) break;
  }
}

function utf8Bytes(text) {
  return new TextEncoder().encode(String(text || "")).length;
}

function truncateText(text, maxChars = 120000) {
  const value = String(text || "");
  if (!Number.isFinite(maxChars) || maxChars <= 0 || value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  return { text: value.slice(0, maxChars), truncated: true };
}

function rangeLength(range = {}) {
  return Math.max(0, Number(range.endOffset || 0) - Number(range.startOffset || 0));
}

function summarizeCoverageRanges(functions = []) {
  const ranges = [];
  for (const fn of functions || []) {
    for (const range of fn.ranges || []) {
      ranges.push({
        functionName: fn.functionName || "",
        startOffset: Number(range.startOffset || 0),
        endOffset: Number(range.endOffset || 0),
        count: Number(range.count || 0),
        used: Number(range.count || 0) > 0,
        bytes: rangeLength(range),
      });
    }
  }
  ranges.sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);
  return ranges;
}

function coverageSnippet(sourceText, range = {}, maxChars = 300) {
  const text = String(sourceText || "");
  const start = Math.max(0, Math.min(text.length, Number(range.startOffset || 0)));
  const end = Math.max(start, Math.min(text.length, Number(range.endOffset || start)));
  const raw = text.slice(start, end);
  const limited = truncateText(raw, maxChars);
  return {
    startOffset: start,
    endOffset: end,
    text: limited.text,
    truncated: limited.truncated,
  };
}

function coverageByteSummary(ranges = [], fallbackTotalBytes = 0) {
  const totalBytes = Math.max(
    Number(fallbackTotalBytes || 0),
    ...ranges.map((range) => Number(range.endOffset || 0)),
    0,
  );
  let usedBytes = 0;
  let unusedBytes = 0;
  for (const range of ranges) {
    if (range.used) usedBytes += range.bytes;
    else unusedBytes += range.bytes;
  }
  return {
    totalBytes,
    usedBytes,
    unusedBytes,
    usedRatio: totalBytes > 0 ? usedBytes / totalBytes : null,
  };
}

function domMutationWatchPageFunction(options) {
  const startedAt = new Date().toISOString();
  const selector = String(options.selector || "");
  const node = document.querySelector(selector);
  const maxEvents = Math.max(1, Number(options.maxEvents || 100));
  const durationMs = Math.max(100, Number(options.durationMs || 1000));
  function describeNode(target) {
    if (!target) return null;
    if (target.nodeType === Node.TEXT_NODE) {
      return {
        nodeType: "text",
        text: String(target.textContent || "").slice(0, 200),
        parent: describeNode(target.parentElement),
      };
    }
    if (!(target instanceof Element)) {
      return {
        nodeType: target.nodeType,
        nodeName: target.nodeName,
      };
    }
    return {
      nodeType: "element",
      tagName: target.tagName.toLowerCase(),
      id: target.id || "",
      className: typeof target.className === "string" ? target.className : "",
      text: String(target.textContent || "").trim().slice(0, 200),
    };
  }
  function pathFor(target) {
    if (!(target instanceof Element)) return "";
    const parts = [];
    let current = target;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        part += `#${current.id}`;
        parts.unshift(part);
        break;
      }
      const parent = current.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter((child) => child.tagName === current.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ");
  }
  return new Promise((resolve) => {
    if (!node) {
      resolve({
        found: false,
        selector,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs,
        eventCount: 0,
        events: [],
      });
      return;
    }
    const events = [];
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (events.length >= maxEvents) break;
        events.push({
          timestamp: new Date().toISOString(),
          type: mutation.type,
          target: describeNode(mutation.target),
          targetPath: pathFor(mutation.target),
          attributeName: mutation.attributeName || null,
          attributeNamespace: mutation.attributeNamespace || null,
          oldValue: mutation.oldValue ?? null,
          addedNodes: [...mutation.addedNodes].slice(0, 10).map(describeNode),
          removedNodes: [...mutation.removedNodes].slice(0, 10).map(describeNode),
          addedNodeCount: mutation.addedNodes.length,
          removedNodeCount: mutation.removedNodes.length,
        });
      }
    });
    observer.observe(node, {
      subtree: options.subtree !== false,
      childList: options.childList !== false,
      attributes: options.attributes !== false,
      characterData: Boolean(options.characterData),
      attributeOldValue: options.attributeOldValue !== false,
      characterDataOldValue: Boolean(options.characterDataOldValue),
    });
    let triggerError = null;
    if (options.triggerExpression) {
      try {
        const fn = new Function(String(options.triggerExpression));
        setTimeout(() => {
          try { fn(); }
          catch (error) { triggerError = String(error?.message || error); }
        }, 0);
      } catch (error) {
        triggerError = String(error?.message || error);
      }
    }
    setTimeout(() => {
      observer.disconnect();
      resolve({
        found: true,
        selector,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs,
        target: describeNode(node),
        targetPath: pathFor(node),
        observerOptions: {
          subtree: options.subtree !== false,
          childList: options.childList !== false,
          attributes: options.attributes !== false,
          characterData: Boolean(options.characterData),
          attributeOldValue: options.attributeOldValue !== false,
          characterDataOldValue: Boolean(options.characterDataOldValue),
        },
        triggerError,
        eventCount: events.length,
        events,
        truncated: events.length >= maxEvents,
      });
    }, durationMs);
  });
}

function domSearchAttributes(attributes = []) {
  const result = {};
  for (let index = 0; index < attributes.length; index += 2) {
    result[String(attributes[index])] = String(attributes[index + 1] ?? "");
  }
  return result;
}

function domSearchNodeSummary(node = {}, outerHTMLResult = null, maxOuterHTMLChars = 1200) {
  const outer = outerHTMLResult?.outerHTML ? truncateText(outerHTMLResult.outerHTML, maxOuterHTMLChars) : null;
  return {
    nodeId: node.nodeId,
    backendNodeId: node.backendNodeId,
    nodeType: node.nodeType,
    nodeName: node.nodeName,
    localName: node.localName,
    nodeValue: node.nodeValue,
    attributes: domSearchAttributes(node.attributes || []),
    childNodeCount: node.childNodeCount || 0,
    frameId: node.frameId || null,
    shadowRootType: node.shadowRootType || null,
    outerHTML: outer?.text || "",
    outerHTMLTruncated: Boolean(outer?.truncated),
  };
}

function domSearchFallbackPageFunction(options) {
  const query = String(options.query || "");
  const maxResults = Math.max(0, Number(options.maxResults || 20));
  const maxOuterHTMLChars = Math.max(0, Number(options.maxOuterHTMLChars || 1200));
  const seen = new Set();
  const results = [];
  function push(element, source) {
    if (!element || !(element instanceof Element) || seen.has(element) || results.length >= maxResults) return;
    seen.add(element);
    const outerHTML = String(element.outerHTML || "");
    results.push({
      source,
      nodeType: element.nodeType,
      nodeName: element.nodeName,
      localName: element.localName,
      attributes: Object.fromEntries([...element.attributes].map((attr) => [attr.name, attr.value])),
      text: String(element.textContent || "").trim().slice(0, 300),
      outerHTML: outerHTML.slice(0, maxOuterHTMLChars),
      outerHTMLTruncated: outerHTML.length > maxOuterHTMLChars,
    });
  }
  try {
    document.querySelectorAll(query).forEach((element) => push(element, "querySelectorAll"));
  } catch {
    // Not a CSS selector; text and XPath passes below can still match.
  }
  try {
    const xpath = document.evaluate(query, document, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
    let node = xpath.iterateNext();
    while (node && results.length < maxResults) {
      push(node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement, "xpath");
      node = xpath.iterateNext();
    }
  } catch {
    // Not an XPath expression.
  }
  const needle = query.toLowerCase();
  if (needle) {
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node && results.length < maxResults) {
      const haystack = `${node.id || ""} ${node.className || ""} ${node.getAttribute?.("name") || ""} ${node.getAttribute?.("aria-label") || ""} ${node.textContent || ""} ${node.outerHTML || ""}`.toLowerCase();
      if (haystack.includes(needle)) push(node, "text");
      node = walker.nextNode();
    }
  }
  return {
    query,
    returnedCount: results.length,
    results,
  };
}

async function debuggerScopePreview(target, scopeChain = [], maxScopes = 5, maxProperties = 20) {
  const scopes = [];
  for (const scope of scopeChain.slice(0, maxScopes)) {
    const row = {
      type: scope.type,
      name: scope.name || "",
      startLocation: scope.startLocation || null,
      endLocation: scope.endLocation || null,
      object: scope.object ? {
        type: scope.object.type,
        subtype: scope.object.subtype,
        className: scope.object.className,
        description: scope.object.description,
      } : null,
      properties: [],
      propertyError: null,
    };
    if (scope.object?.objectId && scope.type !== "global") {
      try {
        const properties = await chromeDebuggerSendCommand(target, "Runtime.getProperties", {
          objectId: scope.object.objectId,
          ownProperties: true,
          accessorPropertiesOnly: false,
          generatePreview: true,
        });
        row.properties = (properties.result || []).slice(0, maxProperties).map((property) => ({
          name: property.name,
          enumerable: property.enumerable,
          configurable: property.configurable,
          writable: property.writable,
          isOwn: property.isOwn,
          value: property.value ? {
            type: property.value.type,
            subtype: property.value.subtype,
            className: property.value.className,
            description: property.value.description,
            value: property.value.value,
            unserializableValue: property.value.unserializableValue,
          } : null,
        }));
        row.propertiesTruncated = (properties.result || []).length > maxProperties;
      } catch (error) {
        row.propertyError = String(error?.message || error);
      }
    }
    scopes.push(row);
  }
  return scopes;
}

async function debuggerPausedSummary(target, event, options = {}) {
  if (!event) return null;
  const maxFrames = Number(options.maxFrames || 10);
  const maxScopes = Number(options.maxScopes || 5);
  const maxProperties = Number(options.maxProperties || 20);
  const frames = [];
  for (const frame of (event.callFrames || []).slice(0, maxFrames)) {
    frames.push({
      callFrameId: frame.callFrameId,
      functionName: frame.functionName,
      url: frame.url,
      location: frame.location,
      functionLocation: frame.functionLocation || null,
      this: frame.this ? {
        type: frame.this.type,
        subtype: frame.this.subtype,
        className: frame.this.className,
        description: frame.this.description,
        value: frame.this.value,
      } : null,
      scopeChain: await debuggerScopePreview(target, frame.scopeChain || [], maxScopes, maxProperties),
    });
  }
  return {
    reason: event.reason,
    data: event.data || null,
    hitBreakpoints: event.hitBreakpoints || [],
    asyncStackTrace: event.asyncStackTrace || null,
    asyncStackTraceId: event.asyncStackTraceId || null,
    callFrameCount: event.callFrames?.length || 0,
    callFrames: frames,
    callFramesTruncated: (event.callFrames?.length || 0) > maxFrames,
  };
}

function prettyPrintJavaScript(sourceText, options = {}) {
  const text = String(sourceText || "");
  const indentText = typeof options.indent === "string" ? options.indent : "  ";
  let indent = 0;
  let output = "";
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let pendingSpace = false;

  function trimRightOutput() {
    output = output.replace(/[ \t]+$/g, "");
  }
  function newline(extraIndent = 0) {
    trimRightOutput();
    if (!output.endsWith("\n")) output += "\n";
    output += indentText.repeat(Math.max(0, indent + extraIndent));
    pendingSpace = false;
  }
  function write(ch) {
    if (pendingSpace && output && !/[\s({[.;,:]$/.test(output) && !/[)\]}.,;:]/.test(ch)) {
      output += " ";
    }
    pendingSpace = false;
    output += ch;
  }

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (lineComment) {
      output += ch;
      if (ch === "\n" || ch === "\r") {
        lineComment = false;
        newline();
      }
      continue;
    }
    if (blockComment) {
      output += ch;
      if (ch === "*" && next === "/") {
        output += next;
        i += 1;
        blockComment = false;
        newline();
      }
      continue;
    }
    if (quote) {
      output += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if ((ch === "/" && next === "/") || (ch === "/" && next === "*")) {
      if (!output.endsWith("\n")) newline();
      output += ch + next;
      i += 1;
      lineComment = next === "/";
      blockComment = next === "*";
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") {
      write(ch);
      quote = ch;
      escaped = false;
      continue;
    }
    if (/\s/.test(ch)) {
      pendingSpace = true;
      continue;
    }
    if (ch === "{") {
      write(ch);
      indent += 1;
      newline();
      continue;
    }
    if (ch === "}") {
      indent = Math.max(0, indent - 1);
      newline();
      write(ch);
      if (next && !/[),.;\]}]/.test(next)) newline();
      continue;
    }
    if (ch === ";") {
      write(ch);
      newline();
      continue;
    }
    if (ch === ",") {
      write(ch);
      pendingSpace = true;
      continue;
    }
    write(ch);
  }

  return {
    mode: "heuristic",
    prettyText: output.trimEnd(),
    originalBytes: utf8Bytes(text),
    prettyBytes: utf8Bytes(output.trimEnd()),
  };
}

function extractSourceMapReference(sourceText) {
  const text = String(sourceText || "");
  const matches = [...text.matchAll(/(?:\/\/[#@]\s*sourceMappingURL=([^\s"'<>]+)|\/\*[#@]\s*sourceMappingURL=([^*]+?)\s*\*\/)/g)];
  const last = matches.at(-1);
  return last ? String(last[1] || last[2] || "").trim() : "";
}

function sourceMapSummary(map, rawText = "") {
  const sources = Array.isArray(map?.sources) ? map.sources : [];
  const names = Array.isArray(map?.names) ? map.names : [];
  const sourcesContent = Array.isArray(map?.sourcesContent) ? map.sourcesContent : [];
  return {
    version: map?.version ?? null,
    file: map?.file ?? null,
    sourceRoot: map?.sourceRoot ?? null,
    sourcesCount: sources.length,
    namesCount: names.length,
    mappingsBytes: typeof map?.mappings === "string" ? utf8Bytes(map.mappings) : 0,
    hasSourcesContent: sourcesContent.length > 0,
    sourcesContentCount: sourcesContent.length,
    sourcesSample: sources.slice(0, 20),
    rawBytes: utf8Bytes(rawText),
  };
}

function decodeDataUrlText(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^,]*?),(.*)$/s);
  if (!match) throw new Error("not a data URL");
  const meta = match[1] || "";
  const payload = match[2] || "";
  if (/;base64/i.test(meta)) {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return decodeURIComponent(payload);
}

function sourceContextLines(sourceText, lineNumber = 0, contextLines = 5) {
  const lines = String(sourceText || "").split(/\r?\n/);
  const zeroBased = Math.max(0, Number(lineNumber) || 0);
  const radius = Math.max(0, Number(contextLines) || 0);
  const before = Math.max(0, zeroBased - radius);
  const after = Math.min(lines.length - 1, zeroBased + radius);
  const rows = [];
  for (let index = before; index <= after; index += 1) {
    rows.push({
      lineNumber: index,
      line: index + 1,
      text: lines[index] ?? "",
      selected: index === zeroBased,
    });
  }
  return rows;
}

async function parseSourceMapMetadata(reference, scriptUrl, options = {}) {
  const sourceMapURL = String(reference || "").trim();
  if (!sourceMapURL) {
    return { sourceMapURL: "", kind: "none", resolvedURL: null, map: null };
  }
  if (sourceMapURL.startsWith("data:")) {
    try {
      const text = decodeDataUrlText(sourceMapURL);
      const map = JSON.parse(text);
      return {
        sourceMapURL,
        kind: "data-url",
        resolvedURL: null,
        mediaType: sourceMapURL.slice(5, sourceMapURL.indexOf(",")).split(";")[0] || null,
        map: sourceMapSummary(map, text),
      };
    } catch (err) {
      return { sourceMapURL, kind: "data-url", resolvedURL: null, map: null, error: String(err?.message || err) };
    }
  }
  let resolvedURL = sourceMapURL;
  try {
    resolvedURL = new URL(sourceMapURL, scriptUrl || "about:blank").toString();
  } catch {
    // Keep raw reference when the page URL cannot be used as a base.
  }
  const result = { sourceMapURL, kind: "external", resolvedURL, fetched: false, map: null };
  if (options.fetchMap) {
    try {
      const response = await fetch(resolvedURL);
      const text = await response.text();
      result.fetched = true;
      result.httpStatus = response.status;
      result.contentType = response.headers.get("content-type");
      if (response.ok) result.map = sourceMapSummary(JSON.parse(text), text);
      else result.error = `HTTP ${response.status}`;
    } catch (err) {
      result.error = String(err?.message || err);
    }
  }
  return result;
}

async function pickScriptSource(params, options = {}) {
  const { tab, target, session } = await ensureDevtoolsAttached(params);
  if (params.reload !== false) {
    session.scripts = new Map();
    await chromeDebuggerSendCommand(target, "Debugger.enable").catch(() => {});
    await chromeDebuggerSendCommand(target, "Page.enable").catch(() => {});
    await chromeDebuggerSendCommand(target, "Page.reload", { ignoreCache: Boolean(params.ignoreCache) }).catch(() => {});
    await delay(Number(params.waitMs || 1200));
  }
  const maxScripts = Number(params.maxScripts || 120);
  const scripts = [...session.scripts.values()]
    .filter((script) => !params.scriptId || String(script.scriptId) === String(params.scriptId))
    .filter((script) => sourceMatches(script, params))
    .slice(-maxScripts);
  let lastError = null;
  for (const script of scripts) {
    try {
      const source = await chromeDebuggerSendCommand(target, "Debugger.getScriptSource", { scriptId: script.scriptId });
      const text = String(source?.scriptSource || "");
      if (params.query && !text.includes(String(params.query))) continue;
      return { tab, target, session, script, source, text };
    } catch (err) {
      lastError = String(err?.message || err);
      if (!options.skipErrors) throw err;
    }
  }
  throw new Error(lastError || "no matching source found");
}

async function chromeSourcePrettyPrint(params) {
  const { tab, script, text } = await pickScriptSource(params, { skipErrors: true });
  const pretty = prettyPrintJavaScript(text, params || {});
  const limited = truncateText(pretty.prettyText, Number(params.maxChars || 120000));
  return {
    tab: pickTab(tab),
    script,
    mode: pretty.mode,
    originalBytes: pretty.originalBytes,
    prettyBytes: pretty.prettyBytes,
    prettyText: limited.text,
    truncated: limited.truncated,
  };
}

async function chromeSourceMapMetadata(params) {
  const { tab, target, session } = await ensureDevtoolsAttached(params);
  if (params.reload !== false) {
    session.scripts = new Map();
    await chromeDebuggerSendCommand(target, "Debugger.enable").catch(() => {});
    await chromeDebuggerSendCommand(target, "Page.enable").catch(() => {});
    await chromeDebuggerSendCommand(target, "Page.reload", { ignoreCache: Boolean(params.ignoreCache) }).catch(() => {});
    await delay(Number(params.waitMs || 1200));
  }
  const maxScripts = Number(params.maxScripts || 120);
  const scripts = [...session.scripts.values()]
    .filter((script) => !params.scriptId || String(script.scriptId) === String(params.scriptId))
    .filter((script) => sourceMatches(script, params))
    .slice(-maxScripts);
  const results = [];
  let lastError = null;
  for (const script of scripts) {
    try {
      const source = await chromeDebuggerSendCommand(target, "Debugger.getScriptSource", { scriptId: script.scriptId });
      const text = String(source?.scriptSource || "");
      if (params.query && !text.includes(String(params.query))) continue;
      const reference = script.sourceMapURL || extractSourceMapReference(text);
      const metadata = await parseSourceMapMetadata(reference, script.url, { fetchMap: Boolean(params.fetchMap) });
      results.push({
        script,
        sourceMapURLFromDebugger: script.sourceMapURL || "",
        sourceMapURLFromComment: extractSourceMapReference(text),
        metadata,
      });
    } catch (err) {
      lastError = String(err?.message || err);
      results.push({ script, error: lastError });
    }
  }
  if (!results.length) throw new Error(lastError || "no matching source found");
  return {
    tab: pickTab(tab),
    count: results.length,
    results,
  };
}

async function chromeGlobalSearch(params) {
  if (!params.query) throw new Error("query is required");
  const { tab, target, session } = await ensureDevtoolsAttached(params);
  const query = String(params.query);
  const maxMatches = Number(params.maxMatches || 80);
  const options = {
    caseSensitive: Boolean(params.caseSensitive),
    contextChars: Number(params.contextChars || 120),
    maxMatches,
  };
  const results = [];
  const searched = { networkRecords: 0, scripts: 0, storage: false };

  if (params.includeNetwork !== false) {
    const records = [...session.requests.values()].slice(-(Number(params.maxNetworkRecords || 1000)));
    searched.networkRecords = records.length;
    for (const record of records) {
      if (results.length >= maxMatches) break;
      pushTextSearchMatches(results, {
        category: "network",
        source: "request",
        locator: { requestId: record.requestId, url: record.url, method: record.method, status: record.status, field: "request-record-json" },
        text: JSON.stringify({
          url: record.url,
          method: record.method,
          status: record.status,
          requestHeaders: record.requestHeaders,
          responseHeaders: record.responseHeaders,
          postData: record.postData,
          bodyText: record.bodyText,
          mimeType: record.mimeType,
          initiator: record.initiator,
        }),
        query,
        options,
      });
    }
  }

  if (params.includeSources !== false && results.length < maxMatches) {
    if (params.reloadSources !== false) {
      session.scripts = new Map();
      await chromeDebuggerSendCommand(target, "Debugger.enable").catch(() => {});
      await chromeDebuggerSendCommand(target, "Page.enable").catch(() => {});
      await chromeDebuggerSendCommand(target, "Page.reload", { ignoreCache: Boolean(params.ignoreCache) }).catch(() => {});
      await delay(Number(params.waitMs || 1000));
    }
    const scripts = [...session.scripts.values()].slice(-(Number(params.maxScripts || 150)));
    searched.scripts = scripts.length;
    for (const script of scripts) {
      if (results.length >= maxMatches) break;
      let source = null;
      try {
        source = await chromeDebuggerSendCommand(target, "Debugger.getScriptSource", { scriptId: script.scriptId });
      } catch {
        continue;
      }
      pushTextSearchMatches(results, {
        category: "sources",
        source: "script",
        locator: { scriptId: script.scriptId, url: script.url, sourceMapURL: script.sourceMapURL, isModule: script.isModule },
        text: source?.scriptSource || "",
        query,
        options,
      });
    }
  }

  if (params.includeStorage !== false && results.length < maxMatches) {
    searched.storage = true;
    const storage = await runInTab(tab.id, async () => {
      const out = {
        url: location.href,
        localStorage: Object.fromEntries(Object.entries(localStorage || {})),
        sessionStorage: Object.fromEntries(Object.entries(sessionStorage || {})),
        documentCookie: document.cookie || "",
        indexedDB: { supported: Boolean(indexedDB), databases: [] },
        cacheStorage: { supported: Boolean(caches), caches: [] },
      };
      try {
        if (indexedDB?.databases) out.indexedDB.databases = await indexedDB.databases();
      } catch (error) {
        out.indexedDB.error = String(error?.message || error);
      }
      try {
        if (caches?.keys) {
          const names = await caches.keys();
          out.cacheStorage.caches = await Promise.all(names.map(async (name) => {
            const cache = await caches.open(name);
            const requests = await cache.keys();
            return { name, entryCount: requests.length, urls: requests.slice(0, 200).map((request) => request.url) };
          }));
        }
      } catch (error) {
        out.cacheStorage.error = String(error?.message || error);
      }
      return out;
    });
    pushTextSearchMatches(results, {
      category: "application",
      source: "storage",
      locator: { url: storage?.url, field: "storage-json" },
      text: JSON.stringify(storage || {}),
      query,
      options,
    });
  }

  return {
    tab: pickTab(tab),
    query,
    searched,
    matchCount: results.length,
    results,
  };
}

async function chromeEvidenceBundle(params) {
  const tab = await getTargetTab(params);
  const bundle = {
    generatedAt: new Date().toISOString(),
    backend: "personal-chrome",
    tab: pickTab(tab),
    diagnostics: await chromePageDiagnostics({ ...params, tabId: tab.id, limit: params.networkLimit || 10 }),
    networkSummary: await chromeNetworkSummary({ ...params, tabId: tab.id, limit: params.networkLimit || 10 }),
    issues: await chromeIssuesLog({ ...params, tabId: tab.id, reload: false, waitMs: 100, limit: 50 }),
    security: await chromeSecuritySummary({ ...params, tabId: tab.id }),
    storage: await chromeStorageSnapshot({ ...params, tabId: tab.id }),
    sources: await chromeSourcesList({ ...params, tabId: tab.id, limit: params.sourceLimit || 100 }),
  };
  return {
    summary: {
      url: bundle.tab?.url || "",
      requestCount: bundle.networkSummary?.requestCount || 0,
      issueCount: bundle.issues?.issueCount || 0,
      cookieCount: Array.isArray(bundle.storage?.cookies) ? bundle.storage.cookies.length : 0,
      sourceCount: bundle.sources?.count || 0,
    },
    bundle,
  };
}

async function chromeSourcesSearch(params) {
  if (!params.query) throw new Error("query is required");
  const { tab, target, session } = await ensureDevtoolsAttached(params);
  const query = String(params.query);
  const maxScripts = Number(params.maxScripts || 120);
  const maxMatches = Number(params.maxMatches || 50);
  if (params.reload !== false) {
    session.scripts = new Map();
    await chromeDebuggerSendCommand(target, "Debugger.enable").catch(() => {});
    await chromeDebuggerSendCommand(target, "Page.enable").catch(() => {});
    await chromeDebuggerSendCommand(target, "Page.reload", { ignoreCache: Boolean(params.ignoreCache) }).catch(() => {});
    await delay(Number(params.waitMs || 1200));
  }
  const scripts = [...session.scripts.values()].filter((script) => sourceMatches(script, params)).slice(-maxScripts);
  const results = [];
  for (const script of scripts) {
    if (results.length >= maxMatches) break;
    let source = null;
    let error = null;
    try {
      source = await chromeDebuggerSendCommand(target, "Debugger.getScriptSource", { scriptId: script.scriptId });
    } catch (err) {
      error = String(err?.message || err);
    }
    if (error) {
      results.push({ scriptId: script.scriptId, url: script.url, error });
      continue;
    }
    const text = String(source?.scriptSource || "");
    const matches = findSourceMatches(text, query, { ...params, maxMatches: maxMatches - results.length });
    for (const match of matches) {
      results.push({
        scriptId: script.scriptId,
        url: script.url,
        sourceMapURL: script.sourceMapURL,
        isModule: script.isModule,
        ...match,
      });
      if (results.length >= maxMatches) break;
    }
  }
  return {
    tab: pickTab(tab),
    query,
    searchedScripts: scripts.length,
    matchCount: results.filter((entry) => !entry.error).length,
    errorCount: results.filter((entry) => entry.error).length,
    results,
  };
}

async function chromePerformanceTrace(params) {
  const tab = await getTargetTab(params);
  const durationMs = Math.min(Number(params.durationMs || 3000), 15000);
  const page = await runInTab(tab.id, async (durationMs) => {
    const startedAt = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    const navigation = performance.getEntriesByType("navigation").map((entry) => entry.toJSON?.() || entry);
    const resources = performance.getEntriesByType("resource").map((entry) => entry.toJSON?.() || entry);
    const marks = performance.getEntriesByType("mark").map((entry) => entry.toJSON?.() || entry);
    const measures = performance.getEntriesByType("measure").map((entry) => entry.toJSON?.() || entry);
    const paints = performance.getEntriesByType("paint").map((entry) => entry.toJSON?.() || entry);
    const longTasks = performance.getEntriesByType("longtask").map((entry) => entry.toJSON?.() || ({
      name: entry.name,
      startTime: entry.startTime,
      duration: entry.duration,
    }));
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs,
      timeOrigin: performance.timeOrigin,
      navigation,
      resources,
      paints,
      marks,
      measures,
      longTasks,
      resourceCount: resources.length,
      longTaskCount: longTasks.length,
    };
  }, [durationMs]);
  return { tab: pickTab(tab), page };
}

function waitForTracingComplete(tabId, timeoutMs = 15000) {
  const key = String(tabId);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      tracingWaiters.delete(key);
      reject(new Error("Tracing.tracingComplete timed out"));
    }, timeoutMs);
    tracingWaiters.set(key, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
    });
  });
}

async function readDebuggerStream(target, handle) {
  const chunks = [];
  let eof = false;
  while (!eof) {
    const part = await chromeDebuggerSendCommand(target, "IO.read", { handle });
    chunks.push(part.data || "");
    eof = Boolean(part.eof);
  }
  await chromeDebuggerSendCommand(target, "IO.close", { handle }).catch(() => {});
  return chunks.join("");
}

async function chromeChromeTrace(params) {
  const { tab, target } = await ensureDevtoolsAttached(params);
  const durationMs = Math.min(Math.max(Number(params.durationMs || 1500), 250), 10000);
  const categories = Array.isArray(params.categories) && params.categories.length
    ? params.categories.map(String)
    : [
        "devtools.timeline",
        "blink.user_timing",
        "loading",
        "netlog",
        "disabled-by-default-devtools.screenshot",
      ];
  const maxEvents = Number(params.maxEvents || 200);
  const completed = waitForTracingComplete(tab.id, durationMs + 12000);
  await chromeDebuggerSendCommand(target, "Tracing.start", {
    categories: categories.join(","),
    transferMode: "ReturnAsStream",
  });
  const startedAt = new Date().toISOString();
  await delay(durationMs);
  await chromeDebuggerSendCommand(target, "Tracing.end");
  const tracingComplete = await completed;
  const traceText = tracingComplete.stream
    ? await readDebuggerStream(target, tracingComplete.stream)
    : "";
  let trace = null;
  let parseError = null;
  try {
    trace = traceText ? JSON.parse(traceText) : null;
  } catch (error) {
    parseError = String(error?.message || error);
  }
  const events = Array.isArray(trace?.traceEvents) ? trace.traceEvents : [];
  return {
    tab: pickTab(tab),
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs,
    categories,
    traceText,
    traceTextBytes: traceText.length,
    traceEventCount: events.length,
    traceSummary: summarizeTraceEvents(events, maxEvents),
    traceEvents: events.slice(0, maxEvents),
    truncated: events.length > maxEvents,
    parseError,
  };
}

async function chromeCpuProfile(params) {
  const { tab, target } = await ensureDevtoolsAttached(params);
  const durationMs = Math.min(Math.max(Number(params.durationMs || 1000), 100), 30000);
  const maxNodes = Number(params.maxNodes || 20);
  await chromeDebuggerSendCommand(target, "Runtime.enable").catch(() => {});
  await chromeDebuggerSendCommand(target, "Profiler.enable").catch(() => {});
  await chromeDebuggerSendCommand(target, "Profiler.start");
  const startedAt = new Date().toISOString();
  let triggerResult = null;
  if (params.triggerExpression) {
    triggerResult = await chromeDebuggerSendCommand(target, "Runtime.evaluate", {
      expression: String(params.triggerExpression),
      awaitPromise: true,
      returnByValue: true,
    }).catch((error) => ({ error: String(error?.message || error) }));
  }
  await delay(durationMs);
  const stopped = await chromeDebuggerSendCommand(target, "Profiler.stop");
  const cpuProfile = stopped.profile || {};
  return {
    tab: pickTab(tab),
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs,
    triggerResult,
    profile: cpuProfile,
    summary: summarizeCpuProfile(cpuProfile, maxNodes),
  };
}

async function chromeCoverageSnapshot(params) {
  const { tab, target } = await ensureDevtoolsAttached(params);
  const durationMs = Math.min(Math.max(Number(params.durationMs || 1000), 250), 10000);
  const maxEntries = Number(params.maxEntries || 200);
  await chromeDebuggerSendCommand(target, "DOM.enable").catch(() => {});
  await chromeDebuggerSendCommand(target, "CSS.enable").catch(() => {});
  await chromeDebuggerSendCommand(target, "Profiler.enable").catch(() => {});
  await chromeDebuggerSendCommand(target, "Profiler.startPreciseCoverage", {
    callCount: true,
    detailed: true,
  });
  await chromeDebuggerSendCommand(target, "CSS.startRuleUsageTracking").catch(() => {});
  const startedAt = new Date().toISOString();
  await delay(durationMs);
  const jsCoverage = await chromeDebuggerSendCommand(target, "Profiler.takePreciseCoverage").catch((error) => ({ error: String(error?.message || error), result: [] }));
  await chromeDebuggerSendCommand(target, "Profiler.stopPreciseCoverage").catch(() => {});
  const cssCoverage = await chromeDebuggerSendCommand(target, "CSS.stopRuleUsageTracking").catch((error) => ({ error: String(error?.message || error), ruleUsage: [] }));
  const scripts = Array.isArray(jsCoverage.result) ? jsCoverage.result : [];
  const jsSummary = scripts.map((script) => {
    let usedRanges = 0;
    let unusedRanges = 0;
    let totalRanges = 0;
    for (const fn of script.functions || []) {
      for (const range of fn.ranges || []) {
        totalRanges += 1;
        if ((range.count || 0) > 0) usedRanges += 1;
        else unusedRanges += 1;
      }
    }
    return {
      scriptId: script.scriptId,
      url: script.url,
      functionCount: script.functions?.length || 0,
      totalRanges,
      usedRanges,
      unusedRanges,
    };
  });
  const rules = Array.isArray(cssCoverage.ruleUsage) ? cssCoverage.ruleUsage : [];
  const usedCssRules = rules.filter((rule) => rule.used).length;
  return {
    tab: pickTab(tab),
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs,
    js: {
      scriptCount: scripts.length,
      entries: jsSummary.slice(0, maxEntries),
      truncated: jsSummary.length > maxEntries,
      error: jsCoverage.error,
    },
    css: {
      ruleCount: rules.length,
      usedRuleCount: usedCssRules,
      unusedRuleCount: rules.length - usedCssRules,
      entries: rules.slice(0, maxEntries),
      truncated: rules.length > maxEntries,
      error: cssCoverage.error,
    },
  };
}

async function chromeCoverageDetail(params) {
  const { tab, target } = await ensureDevtoolsAttached(params);
  const durationMs = Math.min(Math.max(Number(params.durationMs || 1000), 250), 10000);
  const maxEntries = Number(params.maxEntries || 50);
  const maxRangesPerEntry = Number(params.maxRangesPerEntry || 20);
  const maxSnippetChars = Number(params.maxSnippetChars || 300);
  const includeSource = params.includeSource !== false;
  const includeUsed = params.includeUsed !== false;
  const includeUnused = params.includeUnused !== false;
  await chromeDebuggerSendCommand(target, "Page.enable").catch(() => {});
  await chromeDebuggerSendCommand(target, "Debugger.enable").catch(() => {});
  await chromeDebuggerSendCommand(target, "DOM.enable").catch(() => {});
  await chromeDebuggerSendCommand(target, "CSS.enable").catch(() => {});
  await chromeDebuggerSendCommand(target, "Profiler.enable").catch(() => {});
  await chromeDebuggerSendCommand(target, "Profiler.startPreciseCoverage", {
    callCount: true,
    detailed: true,
  });
  await chromeDebuggerSendCommand(target, "CSS.startRuleUsageTracking").catch(() => {});
  const startedAt = new Date().toISOString();
  if (params.reload) {
    await chromeDebuggerSendCommand(target, "Page.reload", { ignoreCache: Boolean(params.ignoreCache) }).catch(() => {});
  }
  await delay(durationMs);
  const jsCoverage = await chromeDebuggerSendCommand(target, "Profiler.takePreciseCoverage").catch((error) => ({ error: String(error?.message || error), result: [] }));
  await chromeDebuggerSendCommand(target, "Profiler.stopPreciseCoverage").catch(() => {});
  const cssCoverage = await chromeDebuggerSendCommand(target, "CSS.stopRuleUsageTracking").catch((error) => ({ error: String(error?.message || error), ruleUsage: [] }));
  const scriptEntries = [];
  const scripts = Array.isArray(jsCoverage.result) ? jsCoverage.result : [];
  for (const script of scripts) {
    if (params.scriptId && String(script.scriptId) !== String(params.scriptId)) continue;
    if (params.urlContains && !String(script.url || "").toLowerCase().includes(String(params.urlContains).toLowerCase())) continue;
    const allRanges = summarizeCoverageRanges(script.functions || [])
      .filter((range) => (range.used ? includeUsed : includeUnused));
    let sourceText = "";
    let sourceError = null;
    if (includeSource) {
      try {
        const source = await chromeDebuggerSendCommand(target, "Debugger.getScriptSource", { scriptId: script.scriptId });
        sourceText = String(source?.scriptSource || "");
      } catch (err) {
        sourceError = String(err?.message || err);
      }
    }
    const byteSummary = coverageByteSummary(allRanges, sourceText ? sourceText.length : script.length);
    scriptEntries.push({
      scriptId: script.scriptId,
      url: script.url,
      functionCount: script.functions?.length || 0,
      rangeCount: allRanges.length,
      ...byteSummary,
      sourceError,
      ranges: allRanges.slice(0, maxRangesPerEntry).map((range) => ({
        ...range,
        ...(includeSource && sourceText ? { snippet: coverageSnippet(sourceText, range, maxSnippetChars) } : {}),
      })),
      rangesTruncated: allRanges.length > maxRangesPerEntry,
    });
    if (scriptEntries.length >= maxEntries) break;
  }

  const cssRules = [];
  const cssRaw = Array.isArray(cssCoverage.ruleUsage) ? cssCoverage.ruleUsage : [];
  const cssTextCache = new Map();
  for (const rule of cssRaw) {
    if (params.styleSheetId && String(rule.styleSheetId) !== String(params.styleSheetId)) continue;
    const used = Boolean(rule.used);
    if (used && !includeUsed) continue;
    if (!used && !includeUnused) continue;
    let snippet = null;
    let sourceError = null;
    if (includeSource) {
      try {
        let text = cssTextCache.get(rule.styleSheetId);
        if (text === undefined) {
          const sheet = await chromeDebuggerSendCommand(target, "CSS.getStyleSheetText", { styleSheetId: rule.styleSheetId });
          text = String(sheet?.text || "");
          cssTextCache.set(rule.styleSheetId, text);
        }
        snippet = coverageSnippet(text, rule, maxSnippetChars);
      } catch (err) {
        sourceError = String(err?.message || err);
      }
    }
    cssRules.push({
      styleSheetId: rule.styleSheetId,
      startOffset: rule.startOffset,
      endOffset: rule.endOffset,
      used,
      bytes: rangeLength(rule),
      sourceError,
      ...(snippet ? { snippet } : {}),
    });
    if (cssRules.length >= maxEntries) break;
  }
  return {
    tab: pickTab(tab),
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs,
    filters: {
      urlContains: params.urlContains || null,
      scriptId: params.scriptId || null,
      styleSheetId: params.styleSheetId || null,
      includeUsed,
      includeUnused,
      includeSource,
    },
    js: {
      scriptCount: scripts.length,
      returnedCount: scriptEntries.length,
      entries: scriptEntries,
      truncated: scripts.length > scriptEntries.length && scriptEntries.length >= maxEntries,
      error: jsCoverage.error,
    },
    css: {
      ruleCount: cssRaw.length,
      returnedCount: cssRules.length,
      entries: cssRules,
      truncated: cssRaw.length > cssRules.length && cssRules.length >= maxEntries,
      error: cssCoverage.error,
    },
  };
}

async function chromeTokenScan(params) {
  const { tab, session } = await ensureDevtoolsAttached(params);
  const findings = [];

  for (const request of session.requests.values()) {
    for (const [key, value] of Object.entries(request.requestHeaders || {})) {
      const finding = scanRecord("request-header", key, value, {
        requestId: request.requestId,
        url: request.url,
      });
      if (finding) findings.push(finding);
    }
    for (const [key, value] of Object.entries(request.responseHeaders || {})) {
      const finding = scanRecord("response-header", key, value, {
        requestId: request.requestId,
        url: request.url,
      });
      if (finding) findings.push(finding);
    }
    if (request.postData || request.hasPostData) {
      const finding = scanRecord("request-payload", "postData", request.postData || "present", {
        requestId: request.requestId,
        url: request.url,
        postDataLength: request.postDataLength,
      });
      if (finding) findings.push(finding);
    }
  }

  const storage = await chromeStorageSnapshot(params);
  for (const [key, value] of Object.entries(storage.page?.localStorage || {})) {
    const finding = scanRecord("localStorage", key, value);
    if (finding) findings.push(finding);
  }
  for (const [key, value] of Object.entries(storage.page?.sessionStorage || {})) {
    const finding = scanRecord("sessionStorage", key, value);
    if (finding) findings.push(finding);
  }
  if (storage.page?.cookieVisibleToDocument) {
    const finding = scanRecord("document.cookie", "cookie", storage.page.cookieVisibleToDocument);
    if (finding) findings.push(finding);
  }
  if (Array.isArray(storage.cookies)) {
    for (const cookie of storage.cookies) {
      const finding = scanRecord("chrome.cookies", cookie.name, cookie.value, {
        domain: cookie.domain,
        path: cookie.path,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite,
      });
      if (finding) findings.push(finding);
    }
  }

  return {
    tab: pickTab(tab),
    redacted: false,
    findingCount: findings.length,
    findings,
    note: "Full values are returned by design in authorized Personal Mode.",
  };
}
