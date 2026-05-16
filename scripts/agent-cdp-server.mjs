import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import http from "node:http";
import CDP from "chrome-remote-interface";

const root = process.cwd();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function browserExecutable() {
  if (process.env.CDP_BROWSER_EXECUTABLE) return process.env.CDP_BROWSER_EXECUTABLE;
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          ]
        : [
            "/usr/bin/microsoft-edge",
            "/usr/bin/microsoft-edge-stable",
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
          ];
  return candidates.find((candidate) => existsSync(candidate));
}

async function waitForCdp(port) {
  const url = `http://127.0.0.1:${port}/json/version`;
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // keep waiting
    }
    await sleep(250);
  }
  throw new Error(`browser CDP endpoint is not available: ${url}`);
}

async function cdpEndpointAvailable(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

async function cdpJson(port, path, init = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
  if (!response.ok) {
    throw new Error(`CDP HTTP ${path} failed: ${response.status} ${await response.text()}`);
  }
  return await response.json();
}

async function listPageTargets(port) {
  const targets = await cdpJson(port, "/json/list");
  return targets.filter((target) => target.type === "page");
}

async function ensurePageTarget(port, tabId) {
  const pages = await listPageTargets(port);
  if (tabId) {
    const exact = pages.find((target) => target.id === tabId);
    if (exact) return exact;
    throw new Error(`tab not found: ${tabId}`);
  }
  const usable = pages.find((target) => target.url !== "devtools://devtools/bundled/devtools_app.html");
  if (usable) return usable;
  return await cdpJson(port, `/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" });
}

async function createPageTarget(port, url = "about:blank") {
  return await cdpJson(port, `/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
}

async function withPageClient(port, tabId, fn) {
  const target = await ensurePageTarget(port, tabId);
  const client = await CDP({ port, target: target.id });
  try {
    return await fn(client, target);
  } finally {
    await client.close().catch(() => {});
  }
}

function toolResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: payload,
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

function normalizeProfileName(raw) {
  const name = String(raw || "default").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name)) {
    throw new Error("profile must start with a letter/number and contain only letters, numbers, dot, underscore, or dash");
  }
  return name;
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
  const milliseconds = Number(raw) > 10_000_000_000 ? Number(raw) : Number(raw) * 1000;
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
    bodyReadable: Boolean(entry.bodyReadable || entry.bodyText || entry.bodyPath),
    bodyBytes: entry.bodyBytes ?? null,
    bodyPath: entry.bodyPath || null,
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
  const maxMatches = typeof options.maxMatches === "number" ? options.maxMatches : 50;
  const contextChars = typeof options.contextChars === "number" ? options.contextChars : 80;
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
  const remaining = Math.max(0, (typeof options.maxMatches === "number" ? options.maxMatches : 50) - results.length);
  if (!remaining) return;
  const matches = findSourceMatches(String(text || ""), String(query || ""), {
    caseSensitive: Boolean(options.caseSensitive),
    maxMatches: remaining,
    contextChars: typeof options.contextChars === "number" ? options.contextChars : 120,
  });
  for (const match of matches) {
    results.push({
      category,
      source,
      ...locator,
      ...match,
    });
    if (results.length >= (typeof options.maxMatches === "number" ? options.maxMatches : 50)) break;
  }
}

function truncateText(text, maxChars = 120000) {
  const value = String(text || "");
  if (!Number.isFinite(maxChars) || maxChars <= 0 || value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  return { text: value.slice(0, maxChars), truncated: true };
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
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
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
    originalBytes: Buffer.byteLength(text, "utf8"),
    prettyBytes: Buffer.byteLength(output.trimEnd(), "utf8"),
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
    mappingsBytes: typeof map?.mappings === "string" ? Buffer.byteLength(map.mappings, "utf8") : 0,
    hasSourcesContent: sourcesContent.length > 0,
    sourcesContentCount: sourcesContent.length,
    sourcesSample: sources.slice(0, 20),
    rawBytes: Buffer.byteLength(String(rawText || ""), "utf8"),
  };
}

function decodeDataUrlText(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^,]*?),(.*)$/s);
  if (!match) throw new Error("not a data URL");
  const meta = match[1] || "";
  const payload = match[2] || "";
  if (/;base64/i.test(meta)) {
    return Buffer.from(payload, "base64").toString("utf8");
  }
  return decodeURIComponent(payload);
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
    // Keep the raw reference when the page uses a non-standard URL base.
  }
  const result = {
    sourceMapURL,
    kind: "external",
    resolvedURL,
    fetched: false,
    map: null,
  };
  if (options.fetchMap) {
    try {
      const response = await fetch(resolvedURL);
      const text = await response.text();
      result.fetched = true;
      result.httpStatus = response.status;
      result.contentType = response.headers.get("content-type");
      if (response.ok) {
        result.map = sourceMapSummary(JSON.parse(text), text);
      } else {
        result.error = `HTTP ${response.status}`;
      }
    } catch (err) {
      result.error = String(err?.message || err);
    }
  }
  return result;
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

function createProfileRegistry({ cdpPort, dataDir, onProfileReady }) {
  const registryFile = process.env.CDP_PROFILE_REGISTRY_FILE || join(dataDir, "profiles.json");
  const captureState = new Map();
  mkdirSync(dataDir, { recursive: true });

  function profileDir(name) {
    return join(dataDir, "profiles", name);
  }

  function trafficFile(name) {
    return join(profileDir(name), "traffic", "traffic.jsonl");
  }

  function websocketFile(name) {
    return join(profileDir(name), "traffic", "websockets.jsonl");
  }

  function eventsFile(name) {
    return join(profileDir(name), "events", "events.jsonl");
  }

  function bodyFile(name, requestId, extension = "body") {
    const safeRequestId = String(requestId || "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_");
    return join(profileDir(name), "bodies", `${safeRequestId}.${extension}`);
  }

  function readRegistry() {
    try {
      const parsed = JSON.parse(readFileSync(registryFile, "utf8"));
      return {
        profiles:
          parsed && typeof parsed === "object" && parsed.profiles && typeof parsed.profiles === "object"
            ? parsed.profiles
            : {},
      };
    } catch {
      return { profiles: {} };
    }
  }

  function writeRegistry(state) {
    mkdirSync(dirname(registryFile), { recursive: true });
    writeFileSync(registryFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  async function createProfile(raw, options = {}) {
    const name = normalizeProfileName(raw);
    const state = readRegistry();
    const now = new Date().toISOString();
    const existing = state.profiles[name];
    if (existing?.tabId) {
      try {
        const target = await ensurePageTarget(cdpPort, existing.tabId);
        const record = {
          ...existing,
          tabId: target.id,
          title: target.title || existing.title || "",
          url: target.url || existing.url || "about:blank",
          lastUsedAt: now,
        };
        state.profiles[name] = record;
        writeRegistry(state);
        return record;
      } catch {
        // stale tab; create a new one below
      }
    }
    const target = await createPageTarget(cdpPort, options.url || "about:blank");
    const record = {
      name,
      tabId: target.id,
      title: target.title || "",
      url: target.url || options.url || "about:blank",
      createdAt: existing?.createdAt || now,
      lastUsedAt: now,
      evidenceDir: profileDir(name),
    };
    mkdirSync(record.evidenceDir, { recursive: true });
    state.profiles[name] = record;
    writeRegistry(state);
    await onProfileReady?.(record);
    return record;
  }

  async function getProfile(raw = "default") {
    return await createProfile(raw);
  }

  function listProfiles() {
    return Object.values(readRegistry().profiles);
  }

  async function deleteProfile(raw) {
    const name = normalizeProfileName(raw);
    const state = readRegistry();
    const existing = state.profiles[name];
    if (!existing) return { ok: true, deleted: false, name };
    if (existing.tabId) {
      await cdpJson(cdpPort, `/json/close/${encodeURIComponent(existing.tabId)}`).catch(() => null);
    }
    delete state.profiles[name];
    writeRegistry(state);
    return { ok: true, deleted: true, name };
  }

  async function touchProfile(raw, patch = {}) {
    const profile = await getProfile(raw);
    const state = readRegistry();
    const next = {
      ...profile,
      ...patch,
      lastUsedAt: new Date().toISOString(),
    };
    state.profiles[profile.name] = next;
    writeRegistry(state);
    return next;
  }

  function appendTraffic(raw, entries) {
    const name = normalizeProfileName(raw);
    const file = trafficFile(name);
    mkdirSync(dirname(file), { recursive: true });
    for (const entry of entries) {
      appendFileSync(file, `${JSON.stringify({ ...entry, profile: name })}\n`, "utf8");
    }
    return file;
  }

  function appendWebSockets(raw, entries) {
    const name = normalizeProfileName(raw);
    const file = websocketFile(name);
    mkdirSync(dirname(file), { recursive: true });
    for (const entry of entries) {
      appendFileSync(file, `${JSON.stringify({ ...entry, profile: name })}\n`, "utf8");
    }
    return file;
  }

  function appendEvent(raw, event) {
    const name = normalizeProfileName(raw);
    const file = eventsFile(name);
    mkdirSync(dirname(file), { recursive: true });
    const payload = {
      timestamp: new Date().toISOString(),
      profile: name,
      ...event,
    };
    appendFileSync(file, `${JSON.stringify(payload)}\n`, "utf8");
    return file;
  }

  function writeBody(raw, requestId, body, base64Encoded = false) {
    const name = normalizeProfileName(raw);
    const file = bodyFile(name, requestId, base64Encoded ? "bin" : "txt");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, base64Encoded ? Buffer.from(String(body || ""), "base64") : String(body || ""), base64Encoded ? undefined : "utf8");
    return file;
  }

  function readTraffic(raw) {
    const name = normalizeProfileName(raw);
    const file = trafficFile(name);
    try {
      return readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  function readWebSockets(raw) {
    const name = normalizeProfileName(raw);
    const file = websocketFile(name);
    try {
      return readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  function queryTraffic(raw, filters = {}) {
    let rows = readTraffic(raw);
    if (filters.url_contains) {
      const needle = String(filters.url_contains).toLowerCase();
      rows = rows.filter((entry) => String(entry.url || "").toLowerCase().includes(needle));
    }
    if (filters.hostname) {
      const hostname = String(filters.hostname).toLowerCase();
      rows = rows.filter((entry) => {
        try { return new URL(entry.url).hostname.toLowerCase() === hostname; }
        catch { return false; }
      });
    }
    if (filters.method) {
      const method = String(filters.method).toUpperCase();
      rows = rows.filter((entry) => String(entry.method || "").toUpperCase() === method);
    }
    if (typeof filters.status === "number") {
      rows = rows.filter((entry) => entry.status === filters.status);
    }
    const limit = typeof filters.limit === "number" ? filters.limit : 50;
    return rows.slice(-limit);
  }

  function getTraffic(raw, requestId) {
    return readTraffic(raw).find((entry) => entry.requestId === requestId) || null;
  }

  function getCapture(raw) {
    const name = normalizeProfileName(raw);
    return captureState.get(name) || {
      enabled: false,
      startedAt: null,
      stoppedAt: null,
      label: null,
    };
  }

  function setCapture(raw, patch = {}) {
    const name = normalizeProfileName(raw);
    const next = {
      ...getCapture(name),
      ...patch,
    };
    captureState.set(name, next);
    return next;
  }

  function clearTraffic(raw) {
    const name = normalizeProfileName(raw);
    const file = trafficFile(name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "", "utf8");
    return file;
  }

  return {
    registryFile,
    profileDir,
    createProfile,
    getProfile,
    listProfiles,
    deleteProfile,
    touchProfile,
    appendTraffic,
    appendWebSockets,
    appendEvent,
    writeBody,
    queryTraffic,
    getTraffic,
    readWebSockets,
    getCapture,
    setCapture,
    clearTraffic,
  };
}

function registerStandaloneBrowserTools(tools, cdpPort, profileRegistry, defaultProfileName) {
  async function resolveProfile(raw) {
    return await profileRegistry.getProfile(raw || defaultProfileName);
  }

  async function captureNetworkForProfile(client, profileName, action, waitMs = 800) {
    const entries = new Map();
    const redirects = new Map();
    const websockets = new Map();
    const record = (requestId, patch) => {
      const existing = entries.get(requestId) || { requestId, timestamp: new Date().toISOString() };
      entries.set(requestId, { ...existing, ...patch });
    };
    await client.Network.enable({
      maxTotalBufferSize: 100000000,
      maxResourceBufferSize: 50000000,
      maxPostDataSize: 50000000,
    });
    client.Network.requestWillBeSent((event) => {
      if (event.redirectResponse) {
        const chain = redirects.get(event.requestId) || [];
        chain.push({
          timestamp: new Date().toISOString(),
          url: event.redirectResponse.url,
          status: event.redirectResponse.status,
          statusText: event.redirectResponse.statusText,
          headers: event.redirectResponse.headers,
          mimeType: event.redirectResponse.mimeType,
          protocol: event.redirectResponse.protocol,
          remoteIPAddress: event.redirectResponse.remoteIPAddress,
          remotePort: event.redirectResponse.remotePort,
          securityDetails: event.redirectResponse.securityDetails,
        });
        redirects.set(event.requestId, chain);
      }
      record(event.requestId, {
        url: event.request?.url,
        method: event.request?.method,
        requestHeaders: event.request?.headers,
        hasPostData: event.request?.hasPostData,
        postData: event.request?.postData,
        postDataLength: event.request?.postData ? String(event.request.postData).length : undefined,
        resourceType: event.type,
        frameId: event.frameId,
        initiatorType: event.initiator?.type,
        initiator: event.initiator,
        documentURL: event.documentURL,
        loaderId: event.loaderId,
        redirectChain: redirects.get(event.requestId) || [],
      });
    });
    client.Network.responseReceived((event) => {
      record(event.requestId, {
        status: event.response?.status,
        statusText: event.response?.statusText,
        mimeType: event.response?.mimeType,
        responseHeaders: event.response?.headers,
        timing: event.response?.timing,
        protocol: event.response?.protocol,
        fromDiskCache: event.response?.fromDiskCache,
        fromServiceWorker: event.response?.fromServiceWorker,
        remoteIPAddress: event.response?.remoteIPAddress,
        remotePort: event.response?.remotePort,
        securityDetails: event.response?.securityDetails,
      });
    });
    client.Network.requestWillBeSentExtraInfo((event) => {
      record(event.requestId, {
        requestWillBeSentExtraInfoSeen: true,
        associatedCookies: event.associatedCookies,
        blockedRequestCookies: event.blockedCookies,
        requestHeaders: event.headers,
        requestHeadersText: event.headersText,
        connectTiming: event.connectTiming,
        clientSecurityState: event.clientSecurityState,
        siteHasCookieInOtherPartition: event.siteHasCookieInOtherPartition,
      });
    });
    client.Network.responseReceivedExtraInfo((event) => {
      record(event.requestId, {
        responseReceivedExtraInfoSeen: true,
        extraInfoStatusCode: event.statusCode,
        responseHeaders: event.headers,
        responseHeadersText: event.headersText,
        blockedResponseCookies: event.blockedCookies,
        resourceIPAddressSpace: event.resourceIPAddressSpace,
        cookiePartitionKey: event.cookiePartitionKey,
        cookiePartitionKeyOpaque: event.cookiePartitionKeyOpaque,
      });
    });
    client.Network.loadingFailed((event) => {
      record(event.requestId, {
        failed: true,
        failReason: event.errorText,
        blockedReason: event.blockedReason,
      });
    });
    client.Network.loadingFinished(async (event) => {
      const existing = entries.get(event.requestId);
      if (!existing) return;
      record(event.requestId, {
        finishedAt: new Date().toISOString(),
        encodedDataLength: event.encodedDataLength,
        bodyReadable: true,
      });
      try {
        const body = await client.Network.getResponseBody({ requestId: event.requestId });
        const capture = profileRegistry.getCapture(profileName);
        const bodyPath = capture.enabled ? profileRegistry.writeBody(profileName, event.requestId, body.body, body.base64Encoded) : undefined;
        record(event.requestId, {
          bodyBase64Encoded: body.base64Encoded,
          bodyText: body.base64Encoded ? undefined : body.body,
          bodyPath,
          bodyBytes: body.base64Encoded ? Buffer.from(body.body, "base64").length : Buffer.byteLength(body.body || "", "utf8"),
        });
      } catch {
        // Some requests do not expose a body through CDP.
      }
    });
    const recordWebSocket = (requestId, method, event) => {
      const timestamp = new Date().toISOString();
      const socket = websockets.get(requestId) || {
        requestId,
        createdAt: timestamp,
        url: event.url,
        frames: [],
        events: [],
      };
      socket.updatedAt = timestamp;
      if (event.url) socket.url = event.url;
      if (method === "Network.webSocketCreated") {
        socket.url = event.url;
        socket.initiator = event.initiator;
      } else if (method === "Network.webSocketWillSendHandshakeRequest") {
        socket.requestHeaders = event.request?.headers;
        socket.wallTime = event.wallTime;
      } else if (method === "Network.webSocketHandshakeResponseReceived") {
        socket.status = event.response?.status;
        socket.statusText = event.response?.statusText;
        socket.responseHeaders = event.response?.headers;
      } else if (method === "Network.webSocketFrameSent" || method === "Network.webSocketFrameReceived") {
        socket.frames.push({
          timestamp,
          direction: method === "Network.webSocketFrameSent" ? "sent" : "received",
          opcode: event.response?.opcode,
          mask: event.response?.mask,
          payloadData: event.response?.payloadData,
          payloadLength: event.response?.payloadData ? String(event.response.payloadData).length : 0,
        });
      } else if (method === "Network.webSocketFrameError") {
        socket.errorMessage = event.errorMessage;
      } else if (method === "Network.webSocketClosed") {
        socket.closedAt = timestamp;
      }
      socket.events.push({ timestamp, method, ...event });
      websockets.set(requestId, socket);
    };
    client.Network.webSocketCreated((event) => recordWebSocket(event.requestId, "Network.webSocketCreated", event));
    client.Network.webSocketWillSendHandshakeRequest((event) => recordWebSocket(event.requestId, "Network.webSocketWillSendHandshakeRequest", event));
    client.Network.webSocketHandshakeResponseReceived((event) => recordWebSocket(event.requestId, "Network.webSocketHandshakeResponseReceived", event));
    client.Network.webSocketFrameSent((event) => recordWebSocket(event.requestId, "Network.webSocketFrameSent", event));
    client.Network.webSocketFrameReceived((event) => recordWebSocket(event.requestId, "Network.webSocketFrameReceived", event));
    client.Network.webSocketFrameError((event) => recordWebSocket(event.requestId, "Network.webSocketFrameError", event));
    client.Network.webSocketClosed((event) => recordWebSocket(event.requestId, "Network.webSocketClosed", event));
    const result = await action();
    await sleep(waitMs);
    const rows = [...entries.values()].filter((entry) => entry.url);
    const websocketRows = [...websockets.values()];
    const capture = profileRegistry.getCapture(profileName);
    const trafficFile = capture.enabled ? profileRegistry.appendTraffic(profileName, rows) : null;
    const websocketFile = capture.enabled && websocketRows.length ? profileRegistry.appendWebSockets(profileName, websocketRows) : null;
    return {
      result,
      observedTraffic: rows.length,
      observedWebSockets: websocketRows.length,
      recordedTraffic: capture.enabled ? rows.length : 0,
      capturedTraffic: capture.enabled ? rows.length : 0,
      captureEnabled: capture.enabled,
      trafficFile,
      websocketFile,
    };
  }

  async function runProfileAction({ client, profile, eventType, action, waitMs = 700, event = {} }) {
    const capture = await captureNetworkForProfile(client, profile.name, action, waitMs);
    const eventFile = profileRegistry.appendEvent(profile.name, {
      type: eventType,
      tabId: event.tabId,
      url: event.url,
      result: capture.result,
      capturedTraffic: capture.capturedTraffic,
      trafficFile: capture.trafficFile,
      ...event,
    });
    return { ...capture, eventFile };
  }

  tools.set("profile_create", {
    name: "profile_create",
    description: "Create or reopen a durable agent browser profile. A profile owns one tab and one evidence directory.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        url: { type: "string" },
      },
      required: ["profile"],
    },
    async execute(_id, params) {
      const profile = await profileRegistry.createProfile(params?.profile, { url: params?.url });
      return toolResult({ ok: true, profile });
    },
  });

  tools.set("profile_list", {
    name: "profile_list",
    description: "List durable agent browser profiles managed by this local server.",
    parameters: { type: "object", properties: {} },
    async execute() {
      return toolResult({
        profiles: profileRegistry.listProfiles(),
        registryFile: profileRegistry.registryFile,
      });
    },
  });

  tools.set("profile_delete", {
    name: "profile_delete",
    description: "Delete a managed browser profile record and close its tab. Evidence files are kept on disk.",
    parameters: {
      type: "object",
      properties: { profile: { type: "string" } },
      required: ["profile"],
    },
    async execute(_id, params) {
      return toolResult(await profileRegistry.deleteProfile(params?.profile));
    },
  });

  tools.set("devtools_capture_start", {
    name: "devtools_capture_start",
    description: "Unified Agent DevTools API: start explicit F12 capture for a managed browser profile. Clears previous network log by default.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        clear: { type: "boolean" },
        label: { type: "string" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      if (params?.clear !== false) profileRegistry.clearTraffic(profile.name);
      const capture = profileRegistry.setCapture(profile.name, {
        enabled: true,
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        label: params?.label || null,
      });
      return toolResult({ ok: true, backend: "managed-cdp", profile: profile.name, capture, cleared: params?.clear !== false });
    },
  });

  tools.set("devtools_capture_stop", {
    name: "devtools_capture_stop",
    description: "Unified Agent DevTools API: stop explicit F12 capture for a managed browser profile.",
    parameters: { type: "object", properties: { profile: { type: "string" } } },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const capture = profileRegistry.setCapture(profile.name, {
        enabled: false,
        stoppedAt: new Date().toISOString(),
      });
      return toolResult({ ok: true, backend: "managed-cdp", profile: profile.name, capture });
    },
  });

  tools.set("devtools_capture_clear", {
    name: "devtools_capture_clear",
    description: "Unified Agent DevTools API: clear captured F12 events for a managed browser profile.",
    parameters: { type: "object", properties: { profile: { type: "string" } } },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const trafficFile = profileRegistry.clearTraffic(profile.name);
      return toolResult({ ok: true, backend: "managed-cdp", profile: profile.name, trafficFile, capture: profileRegistry.getCapture(profile.name) });
    },
  });

  tools.set("devtools_capture_status", {
    name: "devtools_capture_status",
    description: "Unified Agent DevTools API: inspect explicit F12 capture status for a managed browser profile.",
    parameters: { type: "object", properties: { profile: { type: "string" } } },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      return toolResult({
        ok: true,
        backend: "managed-cdp",
        profile: profile.name,
        capture: profileRegistry.getCapture(profile.name),
        trafficCount: profileRegistry.queryTraffic(profile.name, { limit: 1000000 }).length,
      });
    },
  });

  tools.set("profile_traffic_query", {
    name: "profile_traffic_query",
    description: "Query captured network traffic for a managed profile. If profile is omitted, uses the server default profile.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        url_contains: { type: "string" },
        hostname: { type: "string" },
        method: { type: "string" },
        status: { type: "number" },
        limit: { type: "number" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const rows = profileRegistry.queryTraffic(profile.name, params);
      return toolResult({
        profile: profile.name,
        evidenceDir: profile.evidenceDir,
        requests: rows,
        websockets: profileRegistry.readWebSockets(profile.name).slice(-(typeof params?.limit === "number" ? params.limit : 50)),
        count: rows.length,
      });
    },
  });

  tools.set("profile_traffic_summary", {
    name: "profile_traffic_summary",
    description: "Summarize profile-local managed browser Network events for agent dashboards and triage.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        limit: { type: "number" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const rows = profileRegistry.queryTraffic(profile.name, { limit: 1000000 });
      const websockets = profileRegistry.readWebSockets(profile.name);
      return toolResult({
        profile: profile.name,
        evidenceDir: profile.evidenceDir,
        capture: profileRegistry.getCapture(profile.name),
        ...summarizeNetworkRecords(rows, websockets, typeof params?.limit === "number" ? params.limit : 10),
      });
    },
  });

  tools.set("profile_network_timeline", {
    name: "profile_network_timeline",
    description: "Return F12 Network Timing/Initiator-style rows for captured managed browser requests.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        limit: { type: "number" },
        url_contains: { type: "string" },
        hostname: { type: "string" },
        method: { type: "string" },
        status: { type: "number" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const limit = typeof params?.limit === "number" ? params.limit : 100;
      const rows = profileRegistry.queryTraffic(profile.name, { ...params, limit });
      return toolResult({
        profile: profile.name,
        evidenceDir: profile.evidenceDir,
        capture: profileRegistry.getCapture(profile.name),
        count: rows.length,
        timeline: buildNetworkTimeline(rows, limit),
      });
    },
  });

  tools.set("browser_issues_log", {
    name: "browser_issues_log",
    description: "Return Chrome DevTools Issues-panel events reported by the browser for the current page.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        reload: { type: "boolean" },
        ignoreCache: { type: "boolean" },
        waitMs: { type: "number" },
        limit: { type: "number" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const waitMs = typeof params?.waitMs === "number" ? params.waitMs : 1200;
      const limit = typeof params?.limit === "number" ? params.limit : 100;
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        const issues = [];
        let auditsAvailable = true;
        try {
          await client.Audits.enable();
          client.Audits.issueAdded((event) => {
            issues.push({ timestamp: new Date().toISOString(), ...event });
          });
        } catch (err) {
          auditsAvailable = false;
          issues.push({ error: String(err?.message || err) });
        }
        if (params?.reload !== false) {
          await client.Page.enable();
          await client.Page.reload({ ignoreCache: Boolean(params?.ignoreCache) });
          await sleep(waitMs);
        } else {
          await sleep(waitMs);
        }
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          auditsAvailable,
          issueCount: issues.filter((entry) => !entry.error).length,
          issues: issues.slice(-limit),
        };
      }));
    },
  });

  tools.set("browser_console_log", {
    name: "browser_console_log",
    description: "Capture Console panel events, Log entries, exceptions, stack traces, and parsed script metadata for the current profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        reload: { type: "boolean" },
        ignoreCache: { type: "boolean" },
        waitMs: { type: "number" },
        limit: { type: "number" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const waitMs = typeof params?.waitMs === "number" ? params.waitMs : 1000;
      const limit = typeof params?.limit === "number" ? params.limit : 100;
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        const consoleEvents = [];
        const exceptions = [];
        const logEntries = [];
        const scripts = new Map();
        await client.Runtime.enable();
        await client.Log.enable().catch(() => {});
        await client.Debugger.enable().catch(() => {});
        await client.Page.enable();
        client.Runtime.consoleAPICalled((event) => {
          consoleEvents.push({
            timestamp: new Date().toISOString(),
            type: event.type,
            args: (event.args || []).map((arg) => arg.value ?? arg.description ?? arg.type),
            stackTrace: event.stackTrace,
            executionContextId: event.executionContextId,
          });
        });
        client.Runtime.exceptionThrown((event) => {
          exceptions.push({
            timestamp: new Date().toISOString(),
            exceptionId: event.exceptionId,
            timestampRaw: event.timestamp,
            details: event.exceptionDetails,
          });
        });
        client.Log.entryAdded((event) => {
          logEntries.push({ timestamp: new Date().toISOString(), entry: event.entry });
        });
        client.Debugger.scriptParsed((event) => {
          scripts.set(event.scriptId, {
            scriptId: event.scriptId,
            url: event.url,
            startLine: event.startLine,
            startColumn: event.startColumn,
            endLine: event.endLine,
            endColumn: event.endColumn,
            executionContextId: event.executionContextId,
            hash: event.hash,
            sourceMapURL: event.sourceMapURL,
            isModule: event.isModule,
            length: event.length,
          });
        });
        if (params?.reload) {
          await client.Page.reload({ ignoreCache: Boolean(params?.ignoreCache) });
        }
        await sleep(waitMs);
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          counts: {
            console: consoleEvents.length,
            exceptions: exceptions.length,
            logs: logEntries.length,
            scripts: scripts.size,
          },
          console: consoleEvents.slice(-limit),
          exceptions: exceptions.slice(-limit),
          logs: logEntries.slice(-limit),
          scripts: [...scripts.values()].slice(-limit),
        };
      }));
    },
  });

  tools.set("browser_console_source_context", {
    name: "browser_console_source_context",
    description: "Return source lines around a Console/exception stack frame script location.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        scriptId: { type: "string" },
        urlContains: { type: "string" },
        lineNumber: { type: "number" },
        columnNumber: { type: "number" },
        contextLines: { type: "number" },
        reload: { type: "boolean" },
        waitMs: { type: "number" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const lineNumber = typeof params?.lineNumber === "number" ? params.lineNumber : 0;
      const contextLines = typeof params?.contextLines === "number" ? params.contextLines : 5;
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        const scripts = new Map();
        await client.Debugger.enable();
        client.Debugger.scriptParsed((event) => {
          scripts.set(event.scriptId, {
            scriptId: event.scriptId,
            url: event.url,
            startLine: event.startLine,
            startColumn: event.startColumn,
            endLine: event.endLine,
            endColumn: event.endColumn,
            sourceMapURL: event.sourceMapURL,
            isModule: event.isModule,
            length: event.length,
          });
        });
        if (params?.reload) {
          await client.Page.enable();
          await client.Page.reload({ ignoreCache: false });
          await sleep(typeof params?.waitMs === "number" ? params.waitMs : 1000);
        } else {
          await sleep(typeof params?.waitMs === "number" ? params.waitMs : 300);
        }
        let script = params?.scriptId ? scripts.get(String(params.scriptId)) : null;
        let source = null;
        if (params?.scriptId) {
          source = await client.Debugger.getScriptSource({ scriptId: String(params.scriptId) }).catch(() => null);
          if (source && !script) {
            script = { scriptId: String(params.scriptId), url: null };
          }
        }
        if (!script && params?.urlContains) {
          const needle = String(params.urlContains).toLowerCase();
          script = [...scripts.values()].find((entry) => String(entry.url || "").toLowerCase().includes(needle)) || null;
        }
        if (!script) throw new Error("matching script not found");
        if (!source) {
          source = await client.Debugger.getScriptSource({ scriptId: script.scriptId });
        }
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          script,
          location: {
            scriptId: script.scriptId,
            url: script.url,
            lineNumber,
            columnNumber: typeof params?.columnNumber === "number" ? params.columnNumber : null,
          },
          contextLines,
          lines: sourceContextLines(source.scriptSource || "", lineNumber, contextLines),
        };
      }));
    },
  });

  tools.set("profile_traffic_get", {
    name: "profile_traffic_get",
    description: "Get one captured traffic record for a managed profile. If profile is omitted, uses the server default profile.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        requestId: { type: "string" },
      },
      required: ["requestId"],
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const entry = profileRegistry.getTraffic(profile.name, params?.requestId);
      return toolResult({
        profile: profile.name,
        evidenceDir: profile.evidenceDir,
        entry,
        bodyPath: entry?.bodyPath,
        bodyText: entry?.bodyText,
        bodyBase64Encoded: entry?.bodyBase64Encoded,
        ...(entry ? {} : { error: "request_not_found", requestId: params?.requestId }),
      });
    },
  });

  tools.set("profile_request_detail", {
    name: "profile_request_detail",
    description: "Return F12 request-detail evidence for one captured managed browser request: headers, cookies, timing, initiator, redirects, and body availability.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        requestId: { type: "string" },
      },
      required: ["requestId"],
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const entry = profileRegistry.getTraffic(profile.name, params?.requestId);
      let cookies = [];
      if (entry?.url) {
        cookies = await withPageClient(cdpPort, profile.tabId, async (client) => {
          await client.Network.enable().catch(() => {});
          const result = await client.Network.getCookies({ urls: [entry.url] }).catch(() => ({ cookies: [] }));
          return result.cookies || [];
        }).catch(() => []);
      }
      return toolResult({
        profile: profile.name,
        evidenceDir: profile.evidenceDir,
        requestId: params?.requestId,
        detail: buildRequestDetail(entry, cookies),
        ...(entry ? {} : { error: "request_not_found" }),
      });
    },
  });

  tools.set("profile_request_payload", {
    name: "profile_request_payload",
    description: "Get request payload/postData for a captured managed browser requestId when CDP still has it available.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        requestId: { type: "string" },
      },
      required: ["requestId"],
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      return toolResult(await withPageClient(cdpPort, profile.tabId, async (client, target) => {
        await client.Network.enable({
          maxTotalBufferSize: 100000000,
          maxResourceBufferSize: 50000000,
          maxPostDataSize: 50000000,
        });
        const payload = await client.Network.getRequestPostData({ requestId: String(params.requestId) });
        const entry = profileRegistry.getTraffic(profile.name, params?.requestId);
        return {
          profile: profile.name,
          tabId: target.id,
          request: entry,
          postData: payload.postData,
          postDataLength: payload.postData ? String(payload.postData).length : 0,
          redacted: false,
        };
      }));
    },
  });

  tools.set("profile_request_replay", {
    name: "profile_request_replay",
    description: "Replay a captured managed browser request with optional URL, method, headers, and body overrides.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        requestId: { type: "string" },
        url: { type: "string" },
        method: { type: "string" },
        headers: { type: "object" },
        body: { type: "string" },
        credentials: { type: "string" },
      },
      required: ["requestId"],
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const request = profileRegistry.getTraffic(profile.name, params?.requestId);
      if (!request) throw new Error(`request not found: ${params?.requestId}`);
      const url = params?.url || request.url;
      const method = String(params?.method || request.method || "GET").toUpperCase();
      const headerPrep = prepareReplayHeaders(request.requestHeaders || {}, params?.headers || {});
      const body = params?.body !== undefined ? String(params.body) : request.postData;
      const includeBody = !["GET", "HEAD"].includes(method) && body !== undefined;
      return toolResult(await withPageClient(cdpPort, profile.tabId, async (client, target) => {
        const result = await client.Runtime.evaluate({
          expression: `(async () => {
            const replay = ${JSON.stringify({
              url,
              method,
              headers: headerPrep.headers,
              body,
              includeBody,
              credentials: params?.credentials || "include",
            })};
            const startedAt = new Date().toISOString();
            const response = await fetch(replay.url, {
              method: replay.method,
              headers: replay.headers,
              credentials: replay.credentials,
              cache: "no-store",
              redirect: "follow",
              ...(replay.includeBody ? { body: replay.body } : {}),
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
          })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          originalRequest: request,
          replayRequest: {
            url,
            method,
            headers: headerPrep.headers,
            skippedHeaders: headerPrep.skipped,
            bodyLength: includeBody ? String(body || "").length : 0,
            credentials: params?.credentials || "include",
          },
          response: result.result?.value,
          exception: result.exceptionDetails,
        };
      }));
    },
  });

  tools.set("profile_export_har", {
    name: "profile_export_har",
    description: "Export profile-local managed browser network traffic as a HAR-like object.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        limit: { type: "number" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const rows = profileRegistry.queryTraffic(profile.name, { limit: typeof params?.limit === "number" ? params.limit : 1000 });
      const entries = rows.map((request) => ({
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
          content: {
            size: request.encodedDataLength ?? request.bodyBytes ?? -1,
            mimeType: request.mimeType || "",
            ...(request.bodyText ? { text: request.bodyText } : {}),
          },
          redirectURL: request.responseHeaders?.location || request.responseHeaders?.Location || "",
          headersSize: -1,
          bodySize: request.encodedDataLength ?? request.bodyBytes ?? -1,
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
      }));
      return toolResult({
        profile: profile.name,
        har: {
          log: {
            version: "1.2",
            creator: { name: "Agent Browser Runtime", version: "0.1.0" },
            pages: [],
            entries,
          },
        },
      });
    },
  });

  tools.set("profile_save_har", {
    name: "profile_save_har",
    description: "Export profile-local managed browser network traffic as a HAR-like file and return the saved path.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        limit: { type: "number" },
        path: { type: "string" },
      },
    },
    async execute(id, params) {
      const profile = await resolveProfile(params?.profile);
      const result = await tools.get("profile_export_har").execute(id, params);
      const payload = JSON.parse(result.content?.[0]?.text || "{}");
      const harText = `${JSON.stringify(payload.har, null, 2)}\n`;
      const harPath = params?.path || join(profile.evidenceDir, "har", `${Date.now()}-network.har`);
      mkdirSync(dirname(harPath), { recursive: true });
      writeFileSync(harPath, harText, "utf8");
      return toolResult({
        profile: profile.name,
        harPath,
        harBytes: Buffer.byteLength(harText, "utf8"),
        entryCount: payload.har?.log?.entries?.length || 0,
      });
    },
  });

  tools.set("browser_tabs", {
    name: "browser_tabs",
    description: "List visible browser tabs available through the local CDP endpoint.",
    parameters: { type: "object", properties: {} },
    async execute() {
      const pages = await listPageTargets(cdpPort);
      return toolResult({
        tabs: pages.map((target) => ({
          id: target.id,
          title: target.title,
          url: target.url,
        })),
      });
    },
  });

  tools.set("browser_navigate", {
    name: "browser_navigate",
    description: "Navigate a browser tab to a URL.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        url: { type: "string" },
        tabId: { type: "string" },
        waitMs: { type: "number" },
      },
      required: ["url"],
    },
    async execute(_id, params) {
      const url = String(params?.url || "");
      if (!/^https?:\/\//i.test(url) && !/^data:/i.test(url) && !/^file:/i.test(url)) {
        throw new Error("url must start with http://, https://, data:, or file:");
      }
      const waitMs = typeof params?.waitMs === "number" ? params.waitMs : 800;
      const profile = await resolveProfile(params?.profile);
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        await client.Page.enable();
        const capture = await captureNetworkForProfile(client, profile.name, async () => {
          await client.Page.navigate({ url });
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, waitMs);
            client.Page.loadEventFired(() => {
              clearTimeout(timer);
              resolve();
            });
          });
        }, waitMs);
        await profileRegistry.touchProfile(profile.name, { tabId: target.id, url });
        return {
          ok: true,
          profile: profile.name,
          tabId: target.id,
          url,
          evidenceDir: profile.evidenceDir,
          capturedTraffic: capture.capturedTraffic,
          trafficFile: capture.trafficFile,
        };
      }));
    },
  });

  tools.set("browser_click", {
    name: "browser_click",
    description: "Click by CSS selector, visible text, or x/y coordinate.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        tabId: { type: "string" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        if (typeof params?.x === "number" && typeof params?.y === "number") {
          const capture = await runProfileAction({
            client,
            profile,
            eventType: "browser_click",
            waitMs: typeof params?.waitMs === "number" ? params.waitMs : 700,
            event: { tabId: target.id, mode: "coordinates", x: params.x, y: params.y },
            action: async () => {
              await client.Input.dispatchMouseEvent({ type: "mousePressed", x: params.x, y: params.y, button: "left", clickCount: 1 });
              await client.Input.dispatchMouseEvent({ type: "mouseReleased", x: params.x, y: params.y, button: "left", clickCount: 1 });
              return { ok: true, mode: "coordinates", x: params.x, y: params.y };
            },
          });
          await profileRegistry.touchProfile(profile.name, { tabId: target.id });
          return { ok: true, profile: profile.name, tabId: target.id, mode: "coordinates", x: params.x, y: params.y, capturedTraffic: capture.capturedTraffic, trafficFile: capture.trafficFile, eventFile: capture.eventFile };
        }
        const expression = params?.selector
          ? `(() => {
              const el = document.querySelector(${JSON.stringify(params.selector)});
              if (!el) return { ok: false, error: "selector_not_found" };
              el.scrollIntoView({ block: "center", inline: "center" });
              el.click();
              return { ok: true, mode: "selector" };
            })()`
          : `(() => {
              const wanted = ${JSON.stringify(String(params?.text || ""))}.toLowerCase();
              const all = [...document.querySelectorAll("button,a,input,textarea,[role=button],label,summary")];
              const el = all.find((node) => (node.innerText || node.value || node.getAttribute("aria-label") || "").toLowerCase().includes(wanted));
              if (!el) return { ok: false, error: "text_not_found" };
              el.scrollIntoView({ block: "center", inline: "center" });
              el.click();
              return { ok: true, mode: "text" };
            })()`;
        const capture = await runProfileAction({
          client,
          profile,
          eventType: "browser_click",
          waitMs: typeof params?.waitMs === "number" ? params.waitMs : 700,
          event: { tabId: target.id, mode: params?.selector ? "selector" : "text", selector: params?.selector, text: params?.text },
          action: async () => {
            const result = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
            return result.result?.value || { ok: false, error: "click_failed" };
          },
        });
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return { profile: profile.name, tabId: target.id, ...capture.result, capturedTraffic: capture.capturedTraffic, trafficFile: capture.trafficFile, eventFile: capture.eventFile };
      }));
    },
  });

  tools.set("browser_type", {
    name: "browser_type",
    description: "Type text into an input or textarea selected by CSS selector.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
        clear: { type: "boolean" },
        pressEnter: { type: "boolean" },
        tabId: { type: "string" },
      },
      required: ["selector", "text"],
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        const expression = `(() => {
          const el = document.querySelector(${JSON.stringify(params.selector)});
          if (!el) return { ok: false, error: "selector_not_found" };
          el.scrollIntoView({ block: "center", inline: "center" });
          el.focus();
          if (${params.clear !== false}) el.value = "";
          el.value = (el.value || "") + ${JSON.stringify(String(params.text || ""))};
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true };
        })()`;
        const capture = await runProfileAction({
          client,
          profile,
          eventType: "browser_type",
          waitMs: typeof params?.waitMs === "number" ? params.waitMs : 700,
          event: { tabId: target.id, selector: params.selector, textLength: String(params.text || "").length, pressEnter: Boolean(params.pressEnter) },
          action: async () => {
            const result = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
            if (params.pressEnter) {
              await client.Input.dispatchKeyEvent({ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
              await client.Input.dispatchKeyEvent({ type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
            }
            return result.result?.value || { ok: false, error: "type_failed" };
          },
        });
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return { profile: profile.name, tabId: target.id, ...capture.result, capturedTraffic: capture.capturedTraffic, trafficFile: capture.trafficFile, eventFile: capture.eventFile };
      }));
    },
  });

  tools.set("browser_scroll", {
    name: "browser_scroll",
    description: "Scroll the current browser tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        waitMs: { type: "number" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        const capture = await runProfileAction({
          client,
          profile,
          eventType: "browser_scroll",
          waitMs: typeof params?.waitMs === "number" ? params.waitMs : 300,
          event: { tabId: target.id, x: params?.x || 0, y: params?.y || 600 },
          action: async () => {
            const result = await client.Runtime.evaluate({
              expression: `(() => { scrollBy(${Number(params?.x || 0)}, ${Number(params?.y || 600)}); return { ok: true, scrollX, scrollY }; })()`,
              returnByValue: true,
              awaitPromise: true,
            });
            return result.result?.value || { ok: false, error: "scroll_failed" };
          },
        });
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return { profile: profile.name, tabId: target.id, ...capture.result, capturedTraffic: capture.capturedTraffic, trafficFile: capture.trafficFile, eventFile: capture.eventFile };
      }));
    },
  });

  tools.set("browser_screenshot", {
    name: "browser_screenshot",
    description: "Capture a PNG screenshot from the current browser tab and write it into the profile evidence directory by default.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        path: { type: "string" },
        fullPage: { type: "boolean" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        await client.Page.enable();
        const shot = await client.Page.captureScreenshot({
          format: "png",
          captureBeyondViewport: params?.fullPage === true,
        });
        const path = params?.path || join(profile.evidenceDir, "screenshots", `${Date.now()}.png`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, Buffer.from(shot.data, "base64"));
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        const eventFile = profileRegistry.appendEvent(profile.name, {
          type: "browser_screenshot",
          tabId: target.id,
          path,
          mimeType: "image/png",
          fullPage: params?.fullPage === true,
        });
        return {
          ok: true,
          profile: profile.name,
          tabId: target.id,
          path,
          mimeType: "image/png",
          eventFile,
        };
      }));
    },
  });

  tools.set("browser_snapshot", {
    name: "browser_snapshot",
    description: "Return title, URL, visible text, and basic input/button inventory from the current tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        maxTextLength: { type: "number" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        const max = typeof params?.maxTextLength === "number" ? params.maxTextLength : 4000;
        const expression = `(() => ({
          title: document.title,
          url: location.href,
          text: (document.body?.innerText || "").slice(0, ${max}),
          controls: [...document.querySelectorAll("button,a,input,textarea,select,[role=button]")]
            .slice(0, 80)
            .map((el) => ({
              tag: el.tagName.toLowerCase(),
              text: (el.innerText || el.value || el.getAttribute("aria-label") || el.placeholder || "").slice(0, 120),
              id: el.id || null,
              name: el.getAttribute("name"),
              type: el.getAttribute("type"),
            }))
        }))()`;
        const result = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
        await profileRegistry.touchProfile(profile.name, { tabId: target.id, url: result.result?.value?.url, title: result.result?.value?.title });
        const eventFile = profileRegistry.appendEvent(profile.name, {
          type: "browser_snapshot",
          tabId: target.id,
          url: result.result?.value?.url,
          title: result.result?.value?.title,
        });
        return { profile: profile.name, tabId: target.id, evidenceDir: profile.evidenceDir, eventFile, ...result.result?.value };
      }));
    },
  });

  tools.set("browser_eval", {
    name: "browser_eval",
    description: "Evaluate JavaScript in the current tab. Local trusted use only.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        expression: { type: "string" },
        tabId: { type: "string" },
      },
      required: ["expression"],
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        const capture = await runProfileAction({
          client,
          profile,
          eventType: "browser_eval",
          waitMs: typeof params?.waitMs === "number" ? params.waitMs : 700,
          event: { tabId: target.id },
          action: async () => await client.Runtime.evaluate({
            expression: String(params.expression || ""),
            returnByValue: true,
            awaitPromise: true,
          }),
        });
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        const result = capture.result;
        return { ok: !result.exceptionDetails, profile: profile.name, tabId: target.id, result: result.result?.value, exception: result.exceptionDetails, capturedTraffic: capture.capturedTraffic, trafficFile: capture.trafficFile, eventFile: capture.eventFile };
      }));
    },
  });

  tools.set("browser_frame_tree", {
    name: "browser_frame_tree",
    description: "Return the current Page frame tree for the profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        await client.Page.enable();
        const tree = await client.Page.getFrameTree();
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return { profile: profile.name, tabId: target.id, frameTree: tree.frameTree };
      }));
    },
  });

  tools.set("browser_security_summary", {
    name: "browser_security_summary",
    description: "Return current page security context and TLS/certificate summary for the profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        const pageResult = await client.Runtime.evaluate({
          expression: `(() => ({
            url: location.href,
            origin: location.origin,
            protocol: location.protocol,
            isSecureContext,
            mixedContentType: document.mixedContentType || null,
            referrer: document.referrer,
          }))()`,
          returnByValue: true,
        });
        const requests = profileRegistry.queryTraffic(profile.name, { limit: 1000000 });
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
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return { profile: profile.name, tabId: target.id, page: pageResult.result?.value, tlsByHost: byHost, tlsCount: tls.length };
      }));
    },
  });

  tools.set("browser_accessibility_snapshot", {
    name: "browser_accessibility_snapshot",
    description: "Return Accessibility panel-style AX tree for the current profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        interestingOnly: { type: "boolean" },
        maxNodes: { type: "number" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const interestingOnly = params?.interestingOnly !== false;
      const maxNodes = typeof params?.maxNodes === "number" ? params.maxNodes : 500;
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        await client.Accessibility.enable().catch(() => {});
        const response = await client.Accessibility.getFullAXTree({ interestingOnly });
        const allNodes = Array.isArray(response.nodes) ? response.nodes : [];
        const nodes = allNodes.slice(0, maxNodes).map(normalizeAccessibilityNode);
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          interestingOnly,
          nodeCount: allNodes.length,
          returned: nodes.length,
          truncated: allNodes.length > nodes.length,
          nodes,
        };
      }));
    },
  });

  tools.set("browser_page_diagnostics", {
    name: "browser_page_diagnostics",
    description: "Return a dashboard-friendly page health summary across Network, Security, Storage, Console, and Accessibility.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        limit: { type: "number" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const limit = typeof params?.limit === "number" ? params.limit : 5;
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        const pageResult = await client.Runtime.evaluate({
          expression: `(async () => {
            const indexedDbDatabases = indexedDB?.databases ? await indexedDB.databases().catch(() => []) : [];
            const cacheNames = caches?.keys ? await caches.keys().catch(() => []) : [];
            const serviceWorkers = navigator.serviceWorker?.getRegistrations ? await navigator.serviceWorker.getRegistrations().catch(() => []) : [];
            return {
              title: document.title,
              url: location.href,
              origin: location.origin,
              protocol: location.protocol,
              isSecureContext,
              readyState: document.readyState,
              visibilityState: document.visibilityState,
              selectedTextLength: String(getSelection?.() || "").length,
              viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
              storage: {
                localStorageKeys: Object.keys(localStorage || {}).length,
                sessionStorageKeys: Object.keys(sessionStorage || {}).length,
                documentCookieBytes: document.cookie?.length || 0,
                indexedDbDatabases: indexedDbDatabases.length || 0,
                cacheStorageCaches: cacheNames.length || 0,
                serviceWorkerRegistrations: serviceWorkers.length || 0,
              },
            };
          })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        const page = pageResult.result?.value || {};
        const rows = profileRegistry.queryTraffic(profile.name, { limit: 1000000 });
        const websockets = profileRegistry.readWebSockets(profile.name);
        const tlsHosts = {};
        for (const request of rows.filter((entry) => entry.securityDetails)) {
          const host = hostnameForUrl(request.url);
          if (!host || tlsHosts[host]) continue;
          tlsHosts[host] = {
            protocol: request.securityDetails.protocol,
            subjectName: request.securityDetails.subjectName,
            issuer: request.securityDetails.issuer,
            certificateTransparencyCompliance: request.securityDetails.certificateTransparencyCompliance,
          };
        }
        let accessibility = null;
        try {
          await client.Accessibility.enable().catch(() => {});
          const ax = await client.Accessibility.getFullAXTree({ interestingOnly: true });
          accessibility = { nodeCount: Array.isArray(ax.nodes) ? ax.nodes.length : 0 };
        } catch (error) {
          accessibility = { error: String(error?.message || error) };
        }
        const cookies = await client.Network.getCookies().catch(() => ({ cookies: [] }));
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          page: {
            title: page.title,
            url: page.url,
            origin: page.origin,
            protocol: page.protocol,
            isSecureContext: page.isSecureContext,
            readyState: page.readyState,
            visibilityState: page.visibilityState,
            selectedTextLength: page.selectedTextLength,
            viewport: page.viewport,
          },
          capture: profileRegistry.getCapture(profile.name),
          network: summarizeNetworkRecords(rows, websockets, limit),
          security: {
            isSecureContext: page.isSecureContext,
            tlsHosts,
          },
          storage: {
            ...(page.storage || {}),
            browserCookieCount: Array.isArray(cookies.cookies) ? cookies.cookies.length : 0,
            cookieSummary: summarizeCookies(cookies.cookies || []),
          },
          accessibility,
        };
      }));
    },
  });

  tools.set("browser_risk_summary", {
    name: "browser_risk_summary",
    description: "Return a first-screen risk summary across Network, Cookies, Storage, Service Workers, Security, and optional token scan.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        limit: { type: "number" },
        includeTokenScan: { type: "boolean" },
      },
    },
    async execute(id, params) {
      const readPayload = (result) => JSON.parse(result.content?.[0]?.text || "{}");
      const diagnostics = readPayload(await tools.get("browser_page_diagnostics").execute(id, params));
      const cookieResult = readPayload(await tools.get("browser_cookie_summary").execute(id, params));
      const serviceWorkerSummary = readPayload(await tools.get("browser_service_worker_summary").execute(id, params));
      const tokenScan = params?.includeTokenScan
        ? readPayload(await tools.get("browser_token_scan").execute(id, params))
        : null;
      const summary = buildRiskSummary({
        diagnostics,
        cookieSummary: cookieResult.summary,
        serviceWorkerSummary,
        tokenScan,
      });
      return toolResult({
        profile: diagnostics.profile,
        tabId: diagnostics.tabId,
        page: diagnostics.page,
        capture: diagnostics.capture,
        includeTokenScan: Boolean(params?.includeTokenScan),
        ...summary,
      });
    },
  });

  tools.set("browser_hard_reload", {
    name: "browser_hard_reload",
    description: "Disable cache, optionally bypass service worker, clear profile-local traffic, and reload the tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        clearLog: { type: "boolean" },
        bypassServiceWorker: { type: "boolean" },
        waitMs: { type: "number" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const waitMs = typeof params?.waitMs === "number" ? params.waitMs : 1000;
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        if (params?.startCapture !== false) {
          if (params?.clearLog !== false) profileRegistry.clearTraffic(profile.name);
          profileRegistry.setCapture(profile.name, {
            enabled: true,
            startedAt: new Date().toISOString(),
            stoppedAt: null,
            label: params?.label || "hard-reload",
          });
        }
        await client.Page.enable();
        await client.Network.enable();
        await client.Network.setCacheDisabled({ cacheDisabled: true });
        if (params?.bypassServiceWorker !== false) {
          await client.Network.setBypassServiceWorker({ bypass: true }).catch(() => {});
        }
        const capture = await captureNetworkForProfile(client, profile.name, async () => {
          await client.Page.reload({ ignoreCache: true });
        }, waitMs);
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        const eventFile = profileRegistry.appendEvent(profile.name, {
          type: "browser_hard_reload",
          tabId: target.id,
          cacheDisabled: true,
          bypassServiceWorker: params?.bypassServiceWorker !== false,
          capturedTraffic: capture.capturedTraffic,
          trafficFile: capture.trafficFile,
          capture: profileRegistry.getCapture(profile.name),
        });
        return {
          ok: true,
          profile: profile.name,
          tabId: target.id,
          cacheDisabled: true,
          bypassServiceWorker: params?.bypassServiceWorker !== false,
          capturedTraffic: capture.capturedTraffic,
          trafficFile: capture.trafficFile,
          eventFile,
          capture: profileRegistry.getCapture(profile.name),
        };
      }));
    },
  });

  tools.set("browser_storage_snapshot", {
    name: "browser_storage_snapshot",
    description: "Return localStorage, sessionStorage, document-visible cookies, and CDP cookies for the current profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const maxIndexedDbRecords = typeof params?.maxIndexedDbRecords === "number" ? params.maxIndexedDbRecords : 20;
      const maxCacheEntries = typeof params?.maxCacheEntries === "number" ? params.maxCacheEntries : 50;
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        const page = await client.Runtime.evaluate({
          expression: `(async () => {
            const limits = { maxIndexedDbRecords: ${JSON.stringify(maxIndexedDbRecords)}, maxCacheEntries: ${JSON.stringify(maxCacheEntries)} };
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
          })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        const cookies = await client.Network.getCookies().catch((error) => ({ error: String(error?.message || error) }));
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return { profile: profile.name, tabId: target.id, page: page.result?.value, cookies: cookies.cookies || cookies };
      })); 
    },
  });

  tools.set("browser_storage_origin_summary", {
    name: "browser_storage_origin_summary",
    description: "Return Application-panel origin evidence: frame origins, storage keys, usage/quota, and cookie partition metadata where Chrome exposes it.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        await client.Page.enable().catch(() => {});
        await client.Storage?.enable?.().catch(() => {});
        const page = await client.Runtime.evaluate({
          expression: `({
            url: location.href,
            origin: location.origin,
            protocol: location.protocol,
            host: location.host,
            storageEstimateSupported: Boolean(navigator.storage?.estimate),
            cookieEnabled: navigator.cookieEnabled,
          })`,
          returnByValue: true,
        });
        const frameTree = await client.Page.getFrameTree().catch(() => null);
        const frames = [];
        function walkFrame(node, parentId = null) {
          if (!node?.frame) return;
          frames.push({
            id: node.frame.id,
            parentId,
            url: node.frame.url,
            origin: (() => {
              try { return new URL(node.frame.url).origin; } catch { return ""; }
            })(),
            name: node.frame.name,
            securityOrigin: node.frame.securityOrigin,
            mimeType: node.frame.mimeType,
          });
          for (const child of node.childFrames || []) walkFrame(child, node.frame.id);
        }
        walkFrame(frameTree?.frameTree);
        const framesWithStorage = [];
        for (const frame of frames) {
          let storageKey = null;
          try {
            storageKey = (await client.Storage.getStorageKeyForFrame({ frameId: frame.id })).storageKey;
          } catch {
            storageKey = null;
          }
          let usageAndQuota = null;
          if (frame.origin && frame.origin !== "null") {
            usageAndQuota = await client.Storage.getUsageAndQuota({ origin: frame.origin }).catch((error) => ({ error: String(error?.message || error) }));
          }
          framesWithStorage.push({ ...frame, storageKey, usageAndQuota });
        }
        const cookiesResult = await client.Network.getCookies().catch(() => ({ cookies: [] }));
        const cookies = Array.isArray(cookiesResult.cookies) ? cookiesResult.cookies : [];
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          page: page.result?.value,
          frames: framesWithStorage,
          cookieCount: cookies.length,
          cookiePartitions: cookies.map((cookie) => ({
            name: cookie.name,
            domain: cookie.domain,
            path: cookie.path,
            sameSite: cookie.sameSite,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            partitionKey: cookie.partitionKey,
            partitionKeyOpaque: cookie.partitionKeyOpaque,
            sourceScheme: cookie.sourceScheme,
            sourcePort: cookie.sourcePort,
          })),
        };
      }));
    },
  });

  tools.set("browser_cookie_summary", {
    name: "browser_cookie_summary",
    description: "Summarize browser cookies for the current profile tab, including SameSite, Secure, HttpOnly, expiry, and risk hints.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        const cookies = await client.Network.getCookies().catch((error) => ({ error: String(error?.message || error) }));
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          summary: summarizeCookies(cookies.cookies || []),
          cookies: cookies.cookies || cookies,
        };
      }));
    },
  });

  tools.set("browser_service_worker_summary", {
    name: "browser_service_worker_summary",
    description: "Return Application panel-style Service Worker and CacheStorage summary for the current profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        const pageResult = await client.Runtime.evaluate({
          expression: `(async () => {
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
          })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        const page = pageResult.result?.value || {};
        let cdpTargets = [];
        try {
          const targets = await cdpJson(cdpPort, "/json/list");
          cdpTargets = targets
            .filter((entry) => ["service_worker", "worker", "shared_worker"].includes(entry.type))
            .map((entry) => ({
              id: entry.id,
              type: entry.type,
              title: entry.title,
              url: entry.url,
              attached: Boolean(entry.webSocketDebuggerUrl),
            }));
        } catch (error) {
          cdpTargets = [{ error: String(error?.message || error) }];
        }
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          page,
          registrationCount: page.registrations?.length || 0,
          cacheCount: page.cacheStorage?.names?.length || 0,
          cdpTargets,
          cdpTargetCount: cdpTargets.filter((entry) => !entry.error).length,
        };
      }));
    },
  });

  tools.set("browser_application_export", {
    name: "browser_application_export",
    description: "Export Application panel data for the current profile tab to a JSON file: storage, cookies, IndexedDB, CacheStorage, and Service Worker summary.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        path: { type: "string" },
        maxIndexedDbRecords: { type: "number" },
        maxCacheEntries: { type: "number" },
        includeCacheBodies: { type: "boolean" },
        maxCacheBodyChars: { type: "number" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const maxIndexedDbRecords = typeof params?.maxIndexedDbRecords === "number" ? params.maxIndexedDbRecords : 1000;
      const maxCacheEntries = typeof params?.maxCacheEntries === "number" ? params.maxCacheEntries : 500;
      const includeCacheBodies = params?.includeCacheBodies !== false;
      const maxCacheBodyChars = typeof params?.maxCacheBodyChars === "number" ? params.maxCacheBodyChars : 200000;
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        const pageResult = await client.Runtime.evaluate({
          expression: `(async () => {
            const limits = ${JSON.stringify({ maxIndexedDbRecords, maxCacheEntries, includeCacheBodies, maxCacheBodyChars })};
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
                    const storeResult = { name: storeName, keyPath: null, autoIncrement: null, indexes: [], records: [], truncated: false };
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
                        if (storeResult.records.length >= limits.maxIndexedDbRecords) {
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
                indexedDBExport.databases = await Promise.all(databases.filter((database) => database?.name).map((database) => readIndexedDbDatabase(database)));
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
                  for (const request of requests.slice(0, limits.maxCacheEntries)) {
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
                    if (response && limits.includeCacheBodies) {
                      try {
                        const bodyText = await response.clone().text();
                        entry.bodyText = bodyText.slice(0, limits.maxCacheBodyChars);
                        entry.bodyBytes = bodyText.length;
                        entry.bodyTruncated = bodyText.length > limits.maxCacheBodyChars;
                      } catch (error) {
                        entry.bodyError = String(error?.message || error);
                      }
                    }
                    entries.push(entry);
                  }
                  return { name, entryCount: requests.length, entries, truncated: requests.length > limits.maxCacheEntries };
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
          })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        const cookies = await client.Network.getCookies().catch((error) => ({ error: String(error?.message || error) }));
        const applicationExport = {
          ...(pageResult.result?.value || {}),
          browserCookies: cookies.cookies || cookies,
        };
        const exportText = `${JSON.stringify(applicationExport, null, 2)}\n`;
        const exportPath = params?.path || join(profile.evidenceDir, "application", `${Date.now()}-application-export.json`);
        mkdirSync(dirname(exportPath), { recursive: true });
        writeFileSync(exportPath, exportText, "utf8");
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          exportPath,
          exportBytes: Buffer.byteLength(exportText, "utf8"),
          indexedDbDatabaseCount: applicationExport.indexedDB?.databases?.length || 0,
          cacheCount: applicationExport.cacheStorage?.caches?.length || 0,
          serviceWorkerRegistrationCount: applicationExport.serviceWorker?.registrations?.length || 0,
          cookieCount: Array.isArray(applicationExport.browserCookies) ? applicationExport.browserCookies.length : 0,
        };
      }));
    },
  });

  tools.set("browser_indexeddb_read", {
    name: "browser_indexeddb_read",
    description: "Read records from a specific IndexedDB database and object store in the current profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        database: { type: "string" },
        store: { type: "string" },
        limit: { type: "number" },
        offset: { type: "number" },
      },
      required: ["database", "store"],
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const limit = typeof params?.limit === "number" ? params.limit : 50;
      const offset = typeof params?.offset === "number" ? params.offset : 0;
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        const result = await client.Runtime.evaluate({
          expression: `(async () => {
            const database = ${JSON.stringify(String(params.database))};
            const storeName = ${JSON.stringify(String(params.store))};
            const limit = ${JSON.stringify(limit)};
            const offset = ${JSON.stringify(offset)};
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
          })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return { profile: profile.name, tabId: target.id, page: result.result?.value, exception: result.exceptionDetails };
      }));
    },
  });

  tools.set("browser_cache_entry_get", {
    name: "browser_cache_entry_get",
    description: "Read one CacheStorage response body by cache name and URL in the current profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        cacheName: { type: "string" },
        url: { type: "string" },
      },
      required: ["cacheName", "url"],
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        const result = await client.Runtime.evaluate({
          expression: `(async () => {
            const cacheName = ${JSON.stringify(String(params.cacheName))};
            const url = ${JSON.stringify(String(params.url))};
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
          })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return { profile: profile.name, tabId: target.id, page: result.result?.value, exception: result.exceptionDetails };
      }));
    },
  });

  tools.set("browser_elements_snapshot", {
    name: "browser_elements_snapshot",
    description: "Return DOM tree, layout boxes, and computed style for the current profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        selector: { type: "string" },
        maxNodes: { type: "number" },
        maxDepth: { type: "number" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const maxNodes = typeof params?.maxNodes === "number" ? params.maxNodes : 250;
      const maxDepth = typeof params?.maxDepth === "number" ? params.maxDepth : 6;
      const selector = params?.selector ? String(params.selector) : null;
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        const page = await client.Runtime.evaluate({
          expression: `(() => {
            const maxNodes = ${JSON.stringify(maxNodes)};
            const maxDepth = ${JSON.stringify(maxDepth)};
            const selector = ${JSON.stringify(selector)};
            let seen = 0;
            function nodeLabel(node) {
              if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
              const el = node;
              const id = el.id ? '#' + el.id : '';
              const cls = typeof el.className === 'string' && el.className.trim()
                ? '.' + el.className.trim().split(/\\s+/).slice(0, 4).join('.')
                : '';
              return el.tagName.toLowerCase() + id + cls;
            }
            function cssPath(el) {
              const parts = [];
              let current = el;
              while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
                let part = current.tagName.toLowerCase();
                if (current.id) {
                  part += '#' + CSS.escape(current.id);
                  parts.unshift(part);
                  break;
                }
                const parent = current.parentElement;
                if (parent) {
                  const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
                  if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
                }
                parts.unshift(part);
                current = parent;
              }
              return parts.join(' > ');
            }
            function serialize(el, depth = 0) {
              if (!el || seen >= maxNodes || depth > maxDepth) return null;
              seen += 1;
              const rect = el.getBoundingClientRect();
              const attrs = {};
              for (const attr of Array.from(el.attributes || [])) {
                if (['id', 'class', 'name', 'role', 'aria-label', 'type', 'href', 'src', 'alt', 'title'].includes(attr.name)) attrs[attr.name] = attr.value;
              }
              return {
                label: nodeLabel(el),
                path: cssPath(el),
                text: (el.innerText || el.textContent || '').trim().slice(0, 160),
                attrs,
                rect: {
                  x: Math.round(rect.x),
                  y: Math.round(rect.y),
                  width: Math.round(rect.width),
                  height: Math.round(rect.height),
                  visible: rect.width > 0 && rect.height > 0,
                },
                children: Array.from(el.children || []).map((child) => serialize(child, depth + 1)).filter(Boolean),
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
                text: (el.innerText || el.textContent || '').trim().slice(0, 2000),
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
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
              doctype: document.doctype ? '<!doctype ' + document.doctype.name + '>' : null,
              root: serialize(document.documentElement),
              selected: selector ? inspectElement(selected) : null,
              selectedFound: selector ? Boolean(selected) : undefined,
              nodeCountReturned: seen,
              truncated: seen >= maxNodes,
            };
          })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return { profile: profile.name, tabId: target.id, page: page.result?.value };
      }));
    },
  });

  tools.set("browser_dom_snapshot", {
    name: "browser_dom_snapshot",
    description: "Return Chrome DOMSnapshot.captureSnapshot data for the current profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        computedStyles: { type: "array", items: { type: "string" } },
        includeDOMRects: { type: "boolean" },
        includePaintOrder: { type: "boolean" },
        includeBlendedBackgroundColors: { type: "boolean" },
        includeTextColorOpacities: { type: "boolean" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const computedStyles = Array.isArray(params?.computedStyles) && params.computedStyles.length
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
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        const snapshot = await client.DOMSnapshot.captureSnapshot({
          computedStyles,
          includeDOMRects: params?.includeDOMRects !== false,
          includePaintOrder: params?.includePaintOrder !== false,
          includeBlendedBackgroundColors: Boolean(params?.includeBlendedBackgroundColors),
          includeTextColorOpacities: Boolean(params?.includeTextColorOpacities),
        });
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          computedStyles,
          documentCount: Array.isArray(snapshot.documents) ? snapshot.documents.length : 0,
          stringCount: Array.isArray(snapshot.strings) ? snapshot.strings.length : 0,
          snapshot,
        };
      }));
    },
  });

  tools.set("browser_event_listeners", {
    name: "browser_event_listeners",
    description: "Return DevTools Elements-panel Event Listeners for a selected DOM node.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        selector: { type: "string" },
        depth: { type: "number" },
        pierce: { type: "boolean" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const selector = params?.selector ? String(params.selector) : "document";
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        await client.Runtime.enable();
        await client.DOMDebugger.enable?.().catch(() => {});
        const expression = selector === "document"
          ? "document"
          : `document.querySelector(${JSON.stringify(selector)})`;
        const node = await client.Runtime.evaluate({
          expression,
          objectGroup: "agent-browser-runtime-event-listeners",
          returnByValue: false,
        });
        const objectId = node.result?.objectId;
        if (!objectId) {
          return {
            profile: profile.name,
            tabId: target.id,
            selector,
            found: false,
            listeners: [],
            count: 0,
          };
        }
        const result = await client.DOMDebugger.getEventListeners({
          objectId,
          depth: typeof params?.depth === "number" ? params.depth : -1,
          pierce: params?.pierce !== false,
        });
        await client.Runtime.releaseObjectGroup({ objectGroup: "agent-browser-runtime-event-listeners" }).catch(() => {});
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
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
          profile: profile.name,
          tabId: target.id,
          selector,
          found: true,
          count: listeners.length,
          listeners,
        };
      }));
    },
  });

  tools.set("browser_sources_list", {
    name: "browser_sources_list",
    description: "Return Sources panel-style script metadata for the current profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        urlContains: { type: "string" },
        hasSourceMap: { type: "boolean" },
        isModule: { type: "boolean" },
        limit: { type: "number" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const limit = typeof params?.limit === "number" ? params.limit : 200;
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        const scripts = new Map();
        await client.Debugger.enable();
        client.Debugger.scriptParsed((event) => {
          scripts.set(event.scriptId, {
            timestamp: new Date().toISOString(),
            scriptId: event.scriptId,
            url: event.url,
            startLine: event.startLine,
            startColumn: event.startColumn,
            endLine: event.endLine,
            endColumn: event.endColumn,
            executionContextId: event.executionContextId,
            hash: event.hash,
            executionContextAuxData: event.executionContextAuxData,
            isLiveEdit: event.isLiveEdit,
            sourceMapURL: event.sourceMapURL,
            hasSourceURL: event.hasSourceURL,
            isModule: event.isModule,
            length: event.length,
            stackTrace: event.stackTrace,
          });
        });
        await client.Page.enable();
        await client.Page.reload({ ignoreCache: false });
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 1200);
          client.Page.loadEventFired(() => {
            clearTimeout(timer);
            setTimeout(resolve, 300);
          });
        });
        let rows = [...scripts.values()];
        if (params?.urlContains) {
          const needle = String(params.urlContains).toLowerCase();
          rows = rows.filter((script) => String(script.url || "").toLowerCase().includes(needle));
        }
        if (typeof params?.hasSourceMap === "boolean") {
          rows = rows.filter((script) => Boolean(script.sourceMapURL) === params.hasSourceMap);
        }
        if (typeof params?.isModule === "boolean") {
          rows = rows.filter((script) => Boolean(script.isModule) === params.isModule);
        }
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return { profile: profile.name, tabId: target.id, count: rows.length, scripts: rows.slice(-limit) };
      }));
    },
  });

  tools.set("browser_source_get", {
    name: "browser_source_get",
    description: "Return JavaScript source for a scriptId in the current profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        scriptId: { type: "string" },
      },
      required: ["scriptId"],
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        await client.Debugger.enable();
        const source = await client.Debugger.getScriptSource({ scriptId: String(params.scriptId) });
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          scriptId: String(params.scriptId),
          scriptSource: source.scriptSource,
          bytecode: source.bytecode,
          length: source.scriptSource ? String(source.scriptSource).length : 0,
        };
      }));
    },
  });

  tools.set("browser_source_pretty_print", {
    name: "browser_source_pretty_print",
    description: "Return a DevTools-style heuristic pretty-printed view of a parsed JavaScript source.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        scriptId: { type: "string" },
        query: { type: "string" },
        urlContains: { type: "string" },
        hasSourceMap: { type: "boolean" },
        isModule: { type: "boolean" },
        reload: { type: "boolean" },
        ignoreCache: { type: "boolean" },
        waitMs: { type: "number" },
        maxScripts: { type: "number" },
        maxChars: { type: "number" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const waitMs = typeof params?.waitMs === "number" ? params.waitMs : 1200;
      const maxScripts = typeof params?.maxScripts === "number" ? params.maxScripts : 120;
      const maxChars = typeof params?.maxChars === "number" ? params.maxChars : 120000;
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        const scripts = new Map();
        await client.Debugger.enable();
        client.Debugger.scriptParsed((event) => {
          scripts.set(event.scriptId, {
            timestamp: new Date().toISOString(),
            scriptId: event.scriptId,
            url: event.url,
            startLine: event.startLine,
            startColumn: event.startColumn,
            endLine: event.endLine,
            endColumn: event.endColumn,
            executionContextId: event.executionContextId,
            hash: event.hash,
            executionContextAuxData: event.executionContextAuxData,
            isLiveEdit: event.isLiveEdit,
            sourceMapURL: event.sourceMapURL,
            hasSourceURL: event.hasSourceURL,
            isModule: event.isModule,
            length: event.length,
            stackTrace: event.stackTrace,
          });
        });
        if (params?.reload !== false) {
          await client.Page.enable();
          await client.Page.reload({ ignoreCache: Boolean(params?.ignoreCache) });
          await sleep(waitMs);
        } else {
          await sleep(300);
        }
        const rows = [...scripts.values()]
          .filter((script) => !params?.scriptId || String(script.scriptId) === String(params.scriptId))
          .filter((script) => sourceMatches(script, params))
          .slice(-maxScripts);
        let selected = null;
        let selectedSource = "";
        let selectedError = null;
        for (const script of rows) {
          try {
            const source = await client.Debugger.getScriptSource({ scriptId: script.scriptId });
            const text = String(source?.scriptSource || "");
            if (params?.query && !text.includes(String(params.query))) continue;
            selected = script;
            selectedSource = text;
            break;
          } catch (err) {
            selectedError = String(err?.message || err);
          }
        }
        if (!selected) {
          throw new Error(selectedError || "no matching source found");
        }
        const pretty = prettyPrintJavaScript(selectedSource, params || {});
        const limited = truncateText(pretty.prettyText, maxChars);
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          script: selected,
          mode: pretty.mode,
          originalBytes: pretty.originalBytes,
          prettyBytes: pretty.prettyBytes,
          prettyText: limited.text,
          truncated: limited.truncated,
        };
      }));
    },
  });

  tools.set("browser_source_map_metadata", {
    name: "browser_source_map_metadata",
    description: "Return sourceMappingURL and source map metadata for a parsed JavaScript source.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        scriptId: { type: "string" },
        query: { type: "string" },
        urlContains: { type: "string" },
        hasSourceMap: { type: "boolean" },
        isModule: { type: "boolean" },
        reload: { type: "boolean" },
        ignoreCache: { type: "boolean" },
        waitMs: { type: "number" },
        maxScripts: { type: "number" },
        fetchMap: { type: "boolean" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const waitMs = typeof params?.waitMs === "number" ? params.waitMs : 1200;
      const maxScripts = typeof params?.maxScripts === "number" ? params.maxScripts : 120;
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        const scripts = new Map();
        await client.Debugger.enable();
        client.Debugger.scriptParsed((event) => {
          scripts.set(event.scriptId, {
            timestamp: new Date().toISOString(),
            scriptId: event.scriptId,
            url: event.url,
            startLine: event.startLine,
            startColumn: event.startColumn,
            endLine: event.endLine,
            endColumn: event.endColumn,
            executionContextId: event.executionContextId,
            hash: event.hash,
            executionContextAuxData: event.executionContextAuxData,
            isLiveEdit: event.isLiveEdit,
            sourceMapURL: event.sourceMapURL,
            hasSourceURL: event.hasSourceURL,
            isModule: event.isModule,
            length: event.length,
            stackTrace: event.stackTrace,
          });
        });
        if (params?.reload !== false) {
          await client.Page.enable();
          await client.Page.reload({ ignoreCache: Boolean(params?.ignoreCache) });
          await sleep(waitMs);
        } else {
          await sleep(300);
        }
        const rows = [...scripts.values()]
          .filter((script) => !params?.scriptId || String(script.scriptId) === String(params.scriptId))
          .filter((script) => sourceMatches(script, params))
          .slice(-maxScripts);
        const results = [];
        let lastError = null;
        for (const script of rows) {
          try {
            const source = await client.Debugger.getScriptSource({ scriptId: script.scriptId });
            const text = String(source?.scriptSource || "");
            if (params?.query && !text.includes(String(params.query))) continue;
            const reference = script.sourceMapURL || extractSourceMapReference(text);
            const metadata = await parseSourceMapMetadata(reference, script.url, { fetchMap: Boolean(params?.fetchMap) });
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
        if (!results.length) {
          throw new Error(lastError || "no matching source found");
        }
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          count: results.length,
          results,
        };
      }));
    },
  });

  tools.set("browser_global_search", {
    name: "browser_global_search",
    description: "Search F12 evidence surfaces for a literal query across Network records, parsed Sources, Storage, IndexedDB samples, and Cache metadata.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        query: { type: "string" },
        caseSensitive: { type: "boolean" },
        contextChars: { type: "number" },
        maxMatches: { type: "number" },
        maxScripts: { type: "number" },
        maxNetworkRecords: { type: "number" },
        includeNetwork: { type: "boolean" },
        includeSources: { type: "boolean" },
        includeStorage: { type: "boolean" },
        reloadSources: { type: "boolean" },
        ignoreCache: { type: "boolean" },
        waitMs: { type: "number" },
      },
      required: ["query"],
    },
    async execute(_id, params) {
      if (!params?.query) throw new Error("query is required");
      const profile = await resolveProfile(params?.profile);
      const query = String(params.query);
      const maxMatches = typeof params?.maxMatches === "number" ? params.maxMatches : 80;
      const options = {
        caseSensitive: Boolean(params?.caseSensitive),
        contextChars: typeof params?.contextChars === "number" ? params.contextChars : 120,
        maxMatches,
      };
      const results = [];
      const searched = { networkRecords: 0, scripts: 0, storage: false };

      if (params?.includeNetwork !== false) {
        const records = profileRegistry.queryTraffic(profile.name, { limit: typeof params?.maxNetworkRecords === "number" ? params.maxNetworkRecords : 1000 });
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

      if (params?.includeSources !== false && results.length < maxMatches) {
        await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
          const scripts = new Map();
          await client.Debugger.enable();
          client.Debugger.scriptParsed((event) => {
            scripts.set(event.scriptId, {
              timestamp: new Date().toISOString(),
              scriptId: event.scriptId,
              url: event.url,
              startLine: event.startLine,
              startColumn: event.startColumn,
              endLine: event.endLine,
              endColumn: event.endColumn,
              executionContextId: event.executionContextId,
              hash: event.hash,
              sourceMapURL: event.sourceMapURL,
              hasSourceURL: event.hasSourceURL,
              isModule: event.isModule,
              length: event.length,
            });
          });
          if (params?.reloadSources !== false) {
            await client.Page.enable();
            await client.Page.reload({ ignoreCache: Boolean(params?.ignoreCache) });
            await sleep(typeof params?.waitMs === "number" ? params.waitMs : 1000);
          } else {
            await sleep(300);
          }
          const rows = [...scripts.values()].slice(-(typeof params?.maxScripts === "number" ? params.maxScripts : 150));
          searched.scripts = rows.length;
          for (const script of rows) {
            if (results.length >= maxMatches) break;
            let source = null;
            try {
              source = await client.Debugger.getScriptSource({ scriptId: script.scriptId });
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
          await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        });
      }

      if (params?.includeStorage !== false && results.length < maxMatches) {
        searched.storage = true;
        await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
          const page = await client.Runtime.evaluate({
            expression: `(async () => {
              const out = {
                url: location.href,
                localStorage: Object.fromEntries(Object.entries(localStorage || {})),
                sessionStorage: Object.fromEntries(Object.entries(sessionStorage || {})),
                documentCookie: document.cookie || "",
                indexedDB: { supported: Boolean(indexedDB), databases: [] },
                cacheStorage: { supported: Boolean(caches), caches: [] },
              };
              try {
                if (indexedDB?.databases) {
                  out.indexedDB.databases = await indexedDB.databases();
                }
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
            })()`,
            returnByValue: true,
            awaitPromise: true,
          });
          pushTextSearchMatches(results, {
            category: "application",
            source: "storage",
            locator: { url: page.result?.value?.url, field: "storage-json" },
            text: JSON.stringify(page.result?.value || {}),
            query,
            options,
          });
          await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        });
      }

      return toolResult({
        profile: profile.name,
        query,
        searched,
        matchCount: results.length,
        results,
      });
    },
  });

  tools.set("browser_evidence_bundle", {
    name: "browser_evidence_bundle",
    description: "Export a compact objective F12 evidence bundle for the current profile: diagnostics, Network summary, Issues, Security, Storage summary, and Sources list.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        path: { type: "string" },
        save: { type: "boolean" },
        sourceLimit: { type: "number" },
        networkLimit: { type: "number" },
      },
    },
    async execute(id, params) {
      const profile = await resolveProfile(params?.profile);
      const readPayload = (result) => JSON.parse(result.content?.[0]?.text || "{}");
      const toolParams = { profile: profile.name, tabId: params?.tabId };
      const bundle = {
        generatedAt: new Date().toISOString(),
        profile: profile.name,
        evidenceDir: profile.evidenceDir,
        diagnostics: readPayload(await tools.get("browser_page_diagnostics").execute(id, { ...toolParams, limit: params?.networkLimit || 10 })),
        networkSummary: readPayload(await tools.get("profile_traffic_summary").execute(id, { profile: profile.name, limit: params?.networkLimit || 10 })),
        issues: readPayload(await tools.get("browser_issues_log").execute(id, { ...toolParams, reload: false, waitMs: 100, limit: 50 })),
        security: readPayload(await tools.get("browser_security_summary").execute(id, toolParams)),
        storage: readPayload(await tools.get("browser_storage_snapshot").execute(id, toolParams)),
        sources: readPayload(await tools.get("browser_sources_list").execute(id, { ...toolParams, limit: params?.sourceLimit || 100 })),
      };
      const summary = {
        url: bundle.diagnostics?.page?.url || bundle.security?.page?.url || "",
        requestCount: bundle.networkSummary?.requestCount || 0,
        issueCount: bundle.issues?.issueCount || 0,
        cookieCount: bundle.storage?.cookies?.length || 0,
        sourceCount: bundle.sources?.count || 0,
      };
      let bundlePath = null;
      if (params?.save !== false) {
        bundlePath = params?.path || join(profile.evidenceDir, "bundles", `${Date.now()}-f12-evidence.json`);
        mkdirSync(dirname(bundlePath), { recursive: true });
        writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
      }
      return toolResult({
        profile: profile.name,
        summary,
        bundlePath,
        bundleBytes: bundlePath ? Buffer.byteLength(JSON.stringify(bundle, null, 2), "utf8") : null,
        bundle,
      });
    },
  });

  tools.set("browser_sources_search", {
    name: "browser_sources_search",
    description: "Search parsed script sources for a literal query and return line/column snippets.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        query: { type: "string" },
        urlContains: { type: "string" },
        hasSourceMap: { type: "boolean" },
        isModule: { type: "boolean" },
        caseSensitive: { type: "boolean" },
        reload: { type: "boolean" },
        ignoreCache: { type: "boolean" },
        waitMs: { type: "number" },
        maxScripts: { type: "number" },
        maxMatches: { type: "number" },
        contextChars: { type: "number" },
      },
      required: ["query"],
    },
    async execute(_id, params) {
      if (!params?.query) throw new Error("query is required");
      const profile = await resolveProfile(params?.profile);
      const query = String(params.query);
      const maxScripts = typeof params?.maxScripts === "number" ? params.maxScripts : 120;
      const maxMatches = typeof params?.maxMatches === "number" ? params.maxMatches : 50;
      const waitMs = typeof params?.waitMs === "number" ? params.waitMs : 1200;
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        const scripts = new Map();
        await client.Debugger.enable();
        client.Debugger.scriptParsed((event) => {
          scripts.set(event.scriptId, {
            timestamp: new Date().toISOString(),
            scriptId: event.scriptId,
            url: event.url,
            startLine: event.startLine,
            startColumn: event.startColumn,
            endLine: event.endLine,
            endColumn: event.endColumn,
            executionContextId: event.executionContextId,
            hash: event.hash,
            executionContextAuxData: event.executionContextAuxData,
            isLiveEdit: event.isLiveEdit,
            sourceMapURL: event.sourceMapURL,
            hasSourceURL: event.hasSourceURL,
            isModule: event.isModule,
            length: event.length,
            stackTrace: event.stackTrace,
          });
        });
        if (params?.reload !== false) {
          await client.Page.enable();
          await client.Page.reload({ ignoreCache: Boolean(params?.ignoreCache) });
          await sleep(waitMs);
        } else {
          await sleep(300);
        }
        const rows = [...scripts.values()].filter((script) => sourceMatches(script, params)).slice(-maxScripts);
        const results = [];
        for (const script of rows) {
          if (results.length >= maxMatches) break;
          let source = null;
          let error = null;
          try {
            source = await client.Debugger.getScriptSource({ scriptId: script.scriptId });
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
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          query,
          searchedScripts: rows.length,
          matchCount: results.filter((entry) => !entry.error).length,
          errorCount: results.filter((entry) => entry.error).length,
          results,
        };
      }));
    },
  });

  tools.set("browser_performance_trace", {
    name: "browser_performance_trace",
    description: "Capture a short Performance panel-style snapshot for the current profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        durationMs: { type: "number" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const durationMs = Math.min(typeof params?.durationMs === "number" ? params.durationMs : 3000, 15000);
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        const result = await client.Runtime.evaluate({
          expression: `(async () => {
            const durationMs = ${JSON.stringify(durationMs)};
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
          })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return { profile: profile.name, tabId: target.id, page: result.result?.value, exception: result.exceptionDetails };
      }));
    },
  });

  tools.set("browser_chrome_trace", {
    name: "browser_chrome_trace",
    description: "Capture Chrome Tracing data for the current profile tab and write the full trace to evidence.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        durationMs: { type: "number" },
        categories: { type: "array", items: { type: "string" } },
        maxEvents: { type: "number" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const durationMs = Math.min(Math.max(typeof params?.durationMs === "number" ? params.durationMs : 1500, 250), 10000);
      const categories = Array.isArray(params?.categories) && params.categories.length
        ? params.categories.map(String)
        : [
            "devtools.timeline",
            "blink.user_timing",
            "loading",
            "netlog",
            "disabled-by-default-devtools.screenshot",
          ];
      const maxEvents = typeof params?.maxEvents === "number" ? params.maxEvents : 200;
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        const tracingComplete = new Promise((resolve) => {
          client.Tracing.tracingComplete((event) => resolve(event || {}));
        });
        await client.Tracing.start({
          categories: categories.join(","),
          transferMode: "ReturnAsStream",
        });
        const startedAt = new Date().toISOString();
        await sleep(durationMs);
        await client.Tracing.end();
        const complete = await Promise.race([
          tracingComplete,
          sleep(durationMs + 12000).then(() => {
            throw new Error("Tracing.tracingComplete timed out");
          }),
        ]);
        const chunks = [];
        if (complete.stream) {
          let eof = false;
          while (!eof) {
            const part = await client.IO.read({ handle: complete.stream });
            chunks.push(part.data || "");
            eof = Boolean(part.eof);
          }
          await client.IO.close({ handle: complete.stream }).catch(() => {});
        }
        const traceText = chunks.join("");
        let trace = null;
        let parseError = null;
        try {
          trace = traceText ? JSON.parse(traceText) : null;
        } catch (error) {
          parseError = String(error?.message || error);
        }
        const events = Array.isArray(trace?.traceEvents) ? trace.traceEvents : [];
        const tracePath = join(profile.evidenceDir, "traces", `${Date.now()}-chrome-trace.json`);
        mkdirSync(dirname(tracePath), { recursive: true });
        writeFileSync(tracePath, traceText, "utf8");
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          startedAt,
          finishedAt: new Date().toISOString(),
          durationMs,
          categories,
          tracePath,
          traceTextBytes: traceText.length,
          traceEventCount: events.length,
          traceSummary: summarizeTraceEvents(events, maxEvents),
          traceEvents: events.slice(0, maxEvents),
          truncated: events.length > maxEvents,
          parseError,
        };
      }));
    },
  });

  tools.set("browser_coverage_snapshot", {
    name: "browser_coverage_snapshot",
    description: "Capture short JavaScript precise coverage and CSS rule usage for the current profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        durationMs: { type: "number" },
        maxEntries: { type: "number" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const durationMs = Math.min(Math.max(typeof params?.durationMs === "number" ? params.durationMs : 1000, 250), 10000);
      const maxEntries = typeof params?.maxEntries === "number" ? params.maxEntries : 200;
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        await client.DOM.enable().catch(() => {});
        await client.CSS.enable().catch(() => {});
        await client.Profiler.enable().catch(() => {});
        await client.Profiler.startPreciseCoverage({ callCount: true, detailed: true });
        await client.CSS.startRuleUsageTracking().catch(() => {});
        const startedAt = new Date().toISOString();
        await sleep(durationMs);
        const jsCoverage = await client.Profiler.takePreciseCoverage().catch((error) => ({ error: String(error?.message || error), result: [] }));
        await client.Profiler.stopPreciseCoverage().catch(() => {});
        const cssCoverage = await client.CSS.stopRuleUsageTracking().catch((error) => ({ error: String(error?.message || error), ruleUsage: [] }));
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
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
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
      }));
    },
  });

  tools.set("browser_token_scan", {
    name: "browser_token_scan",
    description: "Scan managed browser Network, storage, and cookies for token-like material. Returns full values in authorized runtime mode.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        limit: { type: "number" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const findings = [];
      const rows = profileRegistry.queryTraffic(profile.name, { limit: typeof params?.limit === "number" ? params.limit : 500 });

      for (const request of rows) {
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

      const storage = await tools.get("browser_storage_snapshot").execute("agent-cdp-server", { profile: profile.name });
      const storagePayload = JSON.parse(storage.content?.[0]?.text || "{}");
      for (const [key, value] of Object.entries(storagePayload.page?.localStorage || {})) {
        const finding = scanRecord("localStorage", key, value);
        if (finding) findings.push(finding);
      }
      for (const [key, value] of Object.entries(storagePayload.page?.sessionStorage || {})) {
        const finding = scanRecord("sessionStorage", key, value);
        if (finding) findings.push(finding);
      }
      if (storagePayload.page?.cookieVisibleToDocument) {
        const finding = scanRecord("document.cookie", "cookie", storagePayload.page.cookieVisibleToDocument);
        if (finding) findings.push(finding);
      }
      if (Array.isArray(storagePayload.cookies)) {
        for (const cookie of storagePayload.cookies) {
          const finding = scanRecord("cdp-cookies", cookie.name, cookie.value, {
            domain: cookie.domain,
            path: cookie.path,
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            sameSite: cookie.sameSite,
          });
          if (finding) findings.push(finding);
        }
      }

      return toolResult({
        backend: "managed-cdp",
        profile: profile.name,
        redacted: false,
        findingCount: findings.length,
        findings,
        note: "Full values are returned by design in authorized runtime mode.",
      });
    },
  });

  tools.set("devtools_status", {
    name: "devtools_status",
    description: "Unified Agent DevTools API: inspect managed browser status.",
    parameters: { type: "object", properties: { profile: { type: "string" } } },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      return toolResult({
        backend: "managed-cdp",
        profile: profile.name,
        tabId: profile.tabId,
        evidenceDir: profile.evidenceDir,
        cdpEndpoint: `http://127.0.0.1:${cdpPort}`,
        capture: profileRegistry.getCapture(profile.name),
      });
    },
  });

  tools.set("devtools_extension_reload", {
    name: "devtools_extension_reload",
    description: "Unified Agent DevTools API: reload the Personal Chrome extension when that backend is active. No-op for managed CDP.",
    parameters: { type: "object", properties: {} },
    async execute() {
      return toolResult({
        ok: true,
        backend: "managed-cdp",
        notApplicable: true,
        reason: "Managed Browser uses direct CDP and has no Chrome extension service worker to reload.",
      });
    },
  });

  function aliasTool(alias, targetName, description, transform = (params) => params) {
    const target = tools.get(targetName);
    if (!target) throw new Error(`cannot alias missing tool: ${targetName}`);
    tools.set(alias, {
      ...target,
      name: alias,
      description,
      async execute(id, params) {
        return await target.execute(id, transform(params || {}));
      },
    });
  }

  aliasTool("devtools_tabs", "browser_tabs", "Unified Agent DevTools API: list browser tabs.");
  aliasTool("devtools_snapshot", "browser_snapshot", "Unified Agent DevTools API: read visible text and controls.");
  aliasTool("devtools_screenshot", "browser_screenshot", "Unified Agent DevTools API: capture a screenshot.");
  aliasTool("devtools_click", "browser_click", "Unified Agent DevTools API: click by selector, text, or coordinates.");
  aliasTool("devtools_type", "browser_type", "Unified Agent DevTools API: type into a field.");
  aliasTool("devtools_scroll", "browser_scroll", "Unified Agent DevTools API: scroll the page.");
  aliasTool("devtools_eval", "browser_eval", "Unified Agent DevTools API: evaluate JavaScript. Local trusted use only.");
  aliasTool("devtools_attach", "devtools_status", "Unified Agent DevTools API: attach/status for managed CDP. Managed browsers are already CDP-attached.");
  aliasTool("devtools_detach", "devtools_status", "Unified Agent DevTools API: detach/status for managed CDP. Managed browsers remain available to the runtime.");
  aliasTool("devtools_network_log", "profile_traffic_query", "Unified Agent DevTools API: read Network panel-style request log.");
  aliasTool("devtools_network_summary", "profile_traffic_summary", "Unified Agent DevTools API: summarize captured Network traffic for dashboards and triage.");
  aliasTool("devtools_network_timeline", "profile_network_timeline", "Unified Agent DevTools API: read Network Timing/Initiator-style rows.");
  aliasTool("devtools_export_har", "profile_export_har", "Unified Agent DevTools API: export captured Network events as HAR.");
  aliasTool("devtools_save_har", "profile_save_har", "Unified Agent DevTools API: save captured Network events as a HAR file.");
  aliasTool("devtools_request_body", "profile_traffic_get", "Unified Agent DevTools API: read captured request/response detail by requestId.");
  aliasTool("devtools_request_detail", "profile_request_detail", "Unified Agent DevTools API: read F12 request-detail evidence by requestId.");
  aliasTool("devtools_request_payload", "profile_request_payload", "Unified Agent DevTools API: read request payload/postData for a requestId.");
  aliasTool("devtools_request_replay", "profile_request_replay", "Unified Agent DevTools API: replay/edit-and-resend a captured request.");
  aliasTool("devtools_console_log", "browser_console_log", "Unified Agent DevTools API: read Console panel events, exceptions, and stack traces.");
  aliasTool("devtools_console_source_context", "browser_console_source_context", "Unified Agent DevTools API: read source context around a console stack frame.");
  aliasTool("devtools_security_summary", "browser_security_summary", "Unified Agent DevTools API: summarize page security context and TLS/certificate details.");
  aliasTool("devtools_page_diagnostics", "browser_page_diagnostics", "Unified Agent DevTools API: summarize page health for agent dashboards.");
  aliasTool("devtools_signal_summary", "browser_risk_summary", "Unified Agent DevTools API: summarize objective cross-panel browser signals and next drill-down tools.");
  aliasTool("devtools_risk_summary", "browser_risk_summary", "Unified Agent DevTools API: summarize cross-panel browser risks and next drill-down tools.");
  aliasTool("devtools_issues_log", "browser_issues_log", "Unified Agent DevTools API: read Chrome DevTools Issues-panel events.");
  aliasTool("devtools_accessibility_snapshot", "browser_accessibility_snapshot", "Unified Agent DevTools API: read Accessibility panel-style AX tree.");
  aliasTool("devtools_frame_tree", "browser_frame_tree", "Unified Agent DevTools API: read frame/iframe tree.");
  aliasTool("devtools_hard_reload", "browser_hard_reload", "Unified Agent DevTools API: disable cache, bypass service worker, and reload.");
  aliasTool("devtools_storage_snapshot", "browser_storage_snapshot", "Unified Agent DevTools API: read storage and cookies.");
  aliasTool("devtools_storage_origin_summary", "browser_storage_origin_summary", "Unified Agent DevTools API: read Application-panel origin, storage key, quota, and cookie partition evidence.");
  aliasTool("devtools_cookie_summary", "browser_cookie_summary", "Unified Agent DevTools API: summarize cookie security attributes and risk hints.");
  aliasTool("devtools_service_worker_summary", "browser_service_worker_summary", "Unified Agent DevTools API: summarize Service Worker registrations and CacheStorage state.");
  aliasTool("devtools_application_export", "browser_application_export", "Unified Agent DevTools API: export Application panel data to a JSON file.");
  aliasTool("devtools_indexeddb_read", "browser_indexeddb_read", "Unified Agent DevTools API: read IndexedDB records by database and object store.");
  aliasTool("devtools_cache_entry_get", "browser_cache_entry_get", "Unified Agent DevTools API: read a CacheStorage response by cache name and URL.");
  aliasTool("devtools_elements_snapshot", "browser_elements_snapshot", "Unified Agent DevTools API: read Elements panel-style DOM tree, layout boxes, and computed style.");
  aliasTool("devtools_dom_snapshot", "browser_dom_snapshot", "Unified Agent DevTools API: read raw Chrome DOMSnapshot data.");
  aliasTool("devtools_event_listeners", "browser_event_listeners", "Unified Agent DevTools API: read Elements panel event listeners for a selected DOM node.");
  aliasTool("devtools_sources_list", "browser_sources_list", "Unified Agent DevTools API: list parsed scripts and source maps.");
  aliasTool("devtools_source_get", "browser_source_get", "Unified Agent DevTools API: read script source by scriptId.");
  aliasTool("devtools_source_pretty_print", "browser_source_pretty_print", "Unified Agent DevTools API: pretty-print parsed JavaScript source.");
  aliasTool("devtools_source_map_metadata", "browser_source_map_metadata", "Unified Agent DevTools API: read source map reference and metadata.");
  aliasTool("devtools_global_search", "browser_global_search", "Unified Agent DevTools API: search F12 evidence surfaces for a literal query.");
  aliasTool("devtools_evidence_bundle", "browser_evidence_bundle", "Unified Agent DevTools API: export a compact objective F12 evidence bundle.");
  aliasTool("devtools_sources_search", "browser_sources_search", "Unified Agent DevTools API: search parsed JavaScript sources by literal query.");
  aliasTool("devtools_performance_trace", "browser_performance_trace", "Unified Agent DevTools API: capture navigation/resource/paint/long-task performance data.");
  aliasTool("devtools_chrome_trace", "browser_chrome_trace", "Unified Agent DevTools API: capture Chrome Tracing data and return a summary plus full trace path.");
  aliasTool("devtools_coverage_snapshot", "browser_coverage_snapshot", "Unified Agent DevTools API: capture short JavaScript and CSS coverage data.");
  aliasTool("devtools_token_scan", "browser_token_scan", "Unified Agent DevTools API: scan headers, payloads, storage, and cookies for token-like material.");
}

function createConfigManager({ defaultProfile, cdpPort, dataDir }) {
  const externallyManaged = Boolean(process.env.OPENCLAW_CONFIG_PATH);
  const configPath =
    process.env.OPENCLAW_CONFIG_PATH || join(dataDir, "standalone-openclaw-compatible.json");

  function readConfig() {
    try {
      return JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      return {};
    }
  }

  function writeConfig(config) {
    if (externallyManaged) return;
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  function ensureProfile(profile) {
    const config = readConfig();
    config.browser = config.browser && typeof config.browser === "object" ? config.browser : {};
    config.browser.profiles =
      config.browser.profiles && typeof config.browser.profiles === "object"
        ? config.browser.profiles
        : {};
    config.browser.profiles[profile] = { cdpPort };
    writeConfig(config);
    process.env.OPENCLAW_CONFIG_PATH = configPath;
  }

  ensureProfile(defaultProfile);
  return { configPath, ensureProfile };
}

function createConfigIfNeeded({ profile, cdpPort }) {
  if (process.env.OPENCLAW_CONFIG_PATH) return process.env.OPENCLAW_CONFIG_PATH;
  const dataDir =
    process.env.CDP_SECURITY_DATA_DIR || join(homedir(), ".agent-browser-runtime");
  mkdirSync(dataDir, { recursive: true });
  const configPath = join(dataDir, "standalone-openclaw-compatible.json");
  writeFileSync(
    configPath,
    JSON.stringify({ browser: { profiles: { [profile]: { cdpPort } } } }, null, 2),
    "utf8",
  );
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  return configPath;
}

function createMockOpenClawApi() {
  const tools = new Map();
  const services = [];
  const logger = {
    debug: (...args) => console.debug(...args),
    info: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
  };
  return {
    tools,
    services,
    api: {
      logger,
      registerTool(factory) {
        const tool = factory({});
        tools.set(tool.name, tool);
      },
      registerService(service) {
        services.push(service);
      },
    },
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "connection": "close",
  });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "connection": "close",
  });
  res.end(html);
}

function panelHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agent DevTools Panel</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f4ef; color: #191816; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; }
    main { display: grid; grid-template-columns: 280px 1fr; min-height: 100vh; }
    aside { border-right: 1px solid #ded8cb; padding: 28px 20px; background: #fbfaf6; }
    h1 { margin: 0 0 8px; font-size: 20px; letter-spacing: 0; }
    .subtle { color: #6c665b; font-size: 13px; line-height: 1.45; }
    .profiles { display: grid; gap: 10px; margin-top: 22px; }
    button.profile { width: 100%; text-align: left; border: 1px solid #ded8cb; background: #fffdf8; color: #191816; border-radius: 8px; padding: 12px; cursor: pointer; }
    button.profile.active { border-color: #2f6b5f; box-shadow: 0 0 0 2px rgba(47,107,95,.16); }
    .name { font-weight: 700; font-size: 15px; }
    .meta { margin-top: 4px; color: #6c665b; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    section { padding: 30px; }
    .topbar { display: flex; justify-content: space-between; align-items: start; gap: 16px; margin-bottom: 20px; }
    .title { font-size: 24px; font-weight: 750; margin: 0; }
    .url { margin-top: 8px; color: #6c665b; font-size: 13px; max-width: 900px; overflow-wrap: anywhere; }
    .actions { display: flex; gap: 8px; }
    .action { border: 1px solid #d4cbbb; background: #fffdf8; border-radius: 8px; padding: 9px 12px; cursor: pointer; }
    .grid { display: grid; grid-template-columns: repeat(5, minmax(130px, 1fr)); gap: 12px; margin-bottom: 18px; }
    .card { border: 1px solid #ded8cb; background: #fffdf8; border-radius: 8px; padding: 14px; min-height: 86px; }
    .label { color: #6c665b; font-size: 12px; margin-bottom: 8px; }
    .value { font-size: 24px; font-weight: 760; }
    .small { color: #6c665b; font-size: 12px; margin-top: 4px; }
    .panel { border: 1px solid #ded8cb; background: #fffdf8; border-radius: 8px; padding: 16px; margin-top: 12px; }
    .panel h2 { font-size: 15px; margin: 0 0 12px; }
    .notice { border: 1px solid #c8dbd5; background: #eef7f3; color: #234d43; border-radius: 8px; padding: 10px 12px; font-size: 13px; margin-bottom: 14px; display: none; overflow-wrap: anywhere; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 9px 6px; border-top: 1px solid #ece7dc; vertical-align: top; }
    th { color: #6c665b; font-weight: 650; }
    .empty { padding: 48px; text-align: center; color: #6c665b; border: 1px dashed #d4cbbb; border-radius: 8px; background: #fffdf8; }
    .pill { display: inline-flex; align-items: center; border-radius: 999px; background: #e9f2ee; color: #235247; padding: 4px 8px; font-size: 12px; }
    @media (max-width: 1060px) { .grid { grid-template-columns: repeat(2, minmax(130px, 1fr)); } }
    @media (max-width: 860px) { main { grid-template-columns: 1fr; } aside { border-right: 0; border-bottom: 1px solid #ded8cb; } }
  </style>
</head>
<body>
  <main>
    <aside>
      <h1>Agent DevTools</h1>
      <div class="subtle">Profiles are agent operating spaces. Pick one to see the current page, Network, Security, Storage, and Accessibility summary.</div>
      <div id="profiles" class="profiles"></div>
    </aside>
    <section>
      <div id="content" class="empty">Loading profiles...</div>
    </section>
  </main>
  <script>
    let state = null;
    let selected = new URLSearchParams(location.search).get("profile") || "";
    async function load() {
      const response = await fetch("/panel-data" + (selected ? "?profile=" + encodeURIComponent(selected) : ""));
      state = await response.json();
      if (!selected && state.defaultProfile) selected = state.defaultProfile;
      render();
    }
    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    }
    function renderProfiles() {
      const box = document.getElementById("profiles");
      box.innerHTML = "";
      for (const profile of state.profiles || []) {
        const button = document.createElement("button");
        button.className = "profile" + (profile.name === selected ? " active" : "");
        button.innerHTML = '<div class="name">' + escapeHtml(profile.name) + '</div><div class="meta">' + escapeHtml(profile.url || "about:blank") + '</div>';
        button.onclick = () => { selected = profile.name; history.replaceState(null, "", "/panel?profile=" + encodeURIComponent(selected)); load(); };
        box.appendChild(button);
      }
    }
    async function runTool(name, body = {}) {
      const notice = document.getElementById("notice");
      notice.style.display = "block";
      notice.textContent = "Running " + name + "...";
      const response = await fetch("/tool/" + encodeURIComponent(name), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile: selected, ...body }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || JSON.stringify(result));
      notice.textContent =
        name === "devtools_save_har" ? "HAR saved: " + result.harPath :
        name === "devtools_application_export" ? "Application export saved: " + result.exportPath :
        name === "devtools_chrome_trace" ? "Trace saved: " + result.tracePath :
        name + " completed.";
      await load();
    }
    function render() {
      renderProfiles();
      const content = document.getElementById("content");
      const current = state.current;
      if (!current || current.error) {
        content.className = "empty";
        content.textContent = current?.error || "No profile selected.";
        return;
      }
      const network = current.network || {};
      const storage = current.storage || {};
      const security = current.security || {};
      const page = current.page || {};
      const capture = current.captureStatus?.capture || current.capture || {};
      const failedRows = (network.failed || []).map(row => '<tr><td>' + escapeHtml(row.status || row.errorText || "failed") + '</td><td>' + escapeHtml(row.method || "") + '</td><td>' + escapeHtml(row.url || "") + '</td></tr>').join("");
      const hostRows = Object.entries(network.byHost || {}).map(([host, count]) => '<tr><td>' + escapeHtml(host) + '</td><td>' + count + '</td></tr>').join("");
      content.className = "";
      content.innerHTML =
        '<div class="topbar"><div><h2 class="title">' + escapeHtml(page.title || selected) + '</h2><div class="url">' + escapeHtml(page.url || "") + '</div></div><div class="actions"><button class="action" onclick="runTool(\\'devtools_capture_start\\', { clear: true, label: \\'panel\\' }).catch(alert)">Start Capture</button><button class="action" onclick="runTool(\\'devtools_hard_reload\\', { waitMs: 800 }).catch(alert)">Hard Reload</button><button class="action" onclick="runTool(\\'devtools_signal_summary\\', {}).catch(alert)">Signals</button><button class="action" onclick="runTool(\\'devtools_save_har\\', { limit: 1000 }).catch(alert)">Save HAR</button><button class="action" onclick="runTool(\\'devtools_application_export\\', { maxIndexedDbRecords: 1000, maxCacheEntries: 500 }).catch(alert)">Export App</button><button class="action" onclick="runTool(\\'devtools_chrome_trace\\', { durationMs: 800, maxEvents: 20 }).catch(alert)">Trace</button><button class="action" onclick="load()">Refresh</button></div></div>' +
        '<div id="notice" class="notice"></div>' +
        '<div class="grid">' +
          '<div class="card"><div class="label">Network</div><div class="value">' + (network.requestCount || 0) + '</div><div class="small">requests, ' + (network.failedCount || 0) + ' failed</div></div>' +
          '<div class="card"><div class="label">Signals</div><div class="value">' + (current.signalSummary?.signalCount || 0) + '</div><div class="small">' + (current.signalSummary?.highCount || 0) + ' high-priority, ' + (current.signalSummary?.mediumCount || 0) + ' medium</div></div>' +
          '<div class="card"><div class="label">Capture</div><div class="value">' + (capture.enabled ? "On" : "Off") + '</div><div class="small">' + escapeHtml(capture.label || "manual switch") + '</div></div>' +
          '<div class="card"><div class="label">Security</div><div class="value">' + (page.isSecureContext ? "OK" : "Check") + '</div><div class="small">' + escapeHtml(page.protocol || "") + '</div></div>' +
          '<div class="card"><div class="label">Cookies</div><div class="value">' + (storage.browserCookieCount || 0) + '</div><div class="small">' + ((storage.cookieSummary?.insecureCount || 0)) + ' insecure, ' + ((storage.cookieSummary?.scriptReadableCount || 0)) + ' script-readable</div></div>' +
          '<div class="card"><div class="label">Accessibility</div><div class="value">' + (current.accessibility?.nodeCount || 0) + '</div><div class="small">AX nodes</div></div>' +
        '</div>' +
        '<div class="panel"><h2>F12 Signals</h2><table><thead><tr><th>Priority</th><th>Panel</th><th>Signal</th><th>Next tools</th></tr></thead><tbody>' + ((current.signalSummary?.signals || current.signalSummary?.findings || []).slice(0, 8).map(row => '<tr><td>' + escapeHtml(row.severity) + '</td><td>' + escapeHtml(row.panel) + '</td><td>' + escapeHtml(row.title) + '<div class="small">' + escapeHtml(row.detail || "") + '</div></td><td>' + escapeHtml((row.nextTools || []).join(", ")) + '</td></tr>').join("") || '<tr><td colspan="4"><span class="pill">No notable F12 signals yet</span></td></tr>') + '</tbody></table></div>' +
        '<div class="panel"><h2>Hosts</h2><table><thead><tr><th>Host</th><th>Requests</th></tr></thead><tbody>' + (hostRows || '<tr><td colspan="2">No captured hosts yet.</td></tr>') + '</tbody></table></div>' +
        '<div class="panel"><h2>Failed Requests</h2><table><thead><tr><th>Status</th><th>Method</th><th>URL</th></tr></thead><tbody>' + (failedRows || '<tr><td colspan="3"><span class="pill">No failed requests in the current capture</span></td></tr>') + '</tbody></table></div>';
    }
    load().catch(error => {
      const content = document.getElementById("content");
      content.className = "empty";
      content.textContent = String(error);
    });
  </script>
</body>
</html>`;
}

async function main() {
  const profile = process.env.CDP_AGENT_PROFILE || "default";
  const cdpPort = Number.parseInt(process.env.CDP_BROWSER_PORT || "9222", 10);
  const serverPort = Number.parseInt(process.env.CDP_AGENT_SERVER_PORT || "17335", 10);
  const dataDir =
    process.env.CDP_SECURITY_DATA_DIR || join(homedir(), ".agent-browser-runtime");
  const launchBrowser = process.env.CDP_LAUNCH_BROWSER === "1";
  const existingBrowser = await cdpEndpointAvailable(cdpPort);
  let browserProcess = null;

  if (launchBrowser && !existingBrowser) {
    const executable = browserExecutable();
    if (!executable) {
      throw new Error("No Edge/Chrome executable found. Set CDP_BROWSER_EXECUTABLE.");
    }
    const userDataDir =
      process.env.CDP_BROWSER_USER_DATA_DIR ||
      join(dataDir, "browser-identities", profile);
    mkdirSync(userDataDir, { recursive: true });
    browserProcess = spawn(
      executable,
      [
        `--remote-debugging-port=${cdpPort}`,
        "--remote-allow-origins=*",
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        ...(process.env.CDP_BROWSER_HEADLESS === "1" ? ["--headless=new"] : []),
        "about:blank",
      ],
      { stdio: "ignore", detached: false },
    );
  }

  await waitForCdp(cdpPort);
  const configManager = createConfigManager({ defaultProfile: profile, cdpPort, dataDir });
  const configPath = configManager.configPath;

  const entry = await import(
    pathToFileURL(join(root, "dist/plugins/cdp-traffic-capture/index.js")).href
  );
  const harness = createMockOpenClawApi();
  entry.default.register(harness.api);
  const profileRegistry = createProfileRegistry({
    cdpPort,
    dataDir,
    onProfileReady: async (record) => {
      configManager.ensureProfile(record.name);
      for (const service of harness.services) await service.start?.();
    },
  });
  await profileRegistry.createProfile(profile);
  registerStandaloneBrowserTools(harness.tools, cdpPort, profileRegistry, profile);
  for (const service of harness.services) await service.start?.();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          defaultProfile: profile,
          cdpPort,
          cdpEndpoint: `http://127.0.0.1:${cdpPort}`,
          browserAttachMode: existingBrowser ? "attached-existing-cdp" : browserProcess ? "launched-managed-browser" : "attached-cdp-after-wait",
          launchedByServer: Boolean(browserProcess),
          browserUserDataDir: process.env.CDP_BROWSER_USER_DATA_DIR || (browserProcess ? join(dataDir, "browser-identities", profile) : undefined),
          configPath,
          profileRegistryFile: profileRegistry.registryFile,
          tools: [...harness.tools.keys()],
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/tools") {
        sendJson(res, 200, {
          tools: [...harness.tools.values()].map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/panel") {
        sendHtml(res, 200, panelHtml());
        return;
      }
      if (req.method === "GET" && url.pathname === "/panel-data") {
        const requestedProfile = url.searchParams.get("profile") || profile;
        const profiles = profileRegistry.listProfiles().map((entry) => ({
          name: entry.name,
          title: entry.title,
          url: entry.url,
          createdAt: entry.createdAt,
          lastUsedAt: entry.lastUsedAt,
        }));
        let current = null;
        try {
          const tool = harness.tools.get("devtools_page_diagnostics");
          const result = await tool.execute("agent-cdp-server", { profile: requestedProfile, limit: 5 });
          current = JSON.parse(result.content?.[0]?.text || "{}");
          const captureResult = await harness.tools.get("devtools_capture_status").execute("agent-cdp-server", { profile: requestedProfile });
          current.captureStatus = JSON.parse(captureResult.content?.[0]?.text || "{}");
          const signalResult = await harness.tools.get("devtools_signal_summary").execute("agent-cdp-server", { profile: requestedProfile, limit: 5 });
          current.signalSummary = JSON.parse(signalResult.content?.[0]?.text || "{}");
          const { tabId: _tabId, evidenceDir: _evidenceDir, ...safeCurrent } = current;
          current = safeCurrent;
        } catch (error) {
          current = { error: String(error?.message || error), profile: requestedProfile };
        }
        sendJson(res, 200, {
          ok: true,
          defaultProfile: profile,
          selectedProfile: requestedProfile,
          profiles,
          current,
        });
        return;
      }
      if (req.method === "POST" && url.pathname.startsWith("/tool/")) {
        const toolName = decodeURIComponent(url.pathname.slice("/tool/".length));
        const tool = harness.tools.get(toolName);
        if (!tool) {
          sendJson(res, 404, { error: "tool_not_found", toolName });
          return;
        }
        const params = await readJson(req);
        const result = await tool.execute("agent-cdp-server", params);
        const text = result.content?.[0]?.text ?? "{}";
        sendJson(res, 200, JSON.parse(text));
        return;
      }
      if (req.method === "POST" && url.pathname === "/shutdown") {
        sendJson(res, 200, { ok: true, shuttingDown: true });
        setTimeout(() => {
          void shutdown().finally(() => process.exit(0));
        }, 50);
        return;
      }
      sendJson(res, 404, { error: "not_found" });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
  });

  async function shutdown() {
    server.close();
    server.closeAllConnections?.();
    for (const service of harness.services.reverse()) await service.stop?.();
    if (browserProcess && !browserProcess.killed) {
      browserProcess.kill();
      await waitForExit(browserProcess);
    }
  }

  process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));

  server.listen(serverPort, "127.0.0.1", () => {
    console.log("Agent CDP server ready:");
    console.log(`- http://127.0.0.1:${serverPort}/health`);
    console.log(`- default profile: ${profile}`);
    console.log(`- profile registry: ${profileRegistry.registryFile}`);
    console.log(`- browser CDP: http://127.0.0.1:${cdpPort}`);
    console.log(`- config: ${configPath}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
