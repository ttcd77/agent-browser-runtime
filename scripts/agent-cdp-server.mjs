import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import CDP from "chrome-remote-interface";

const root = process.cwd();
const DIRECT_CDP_CORE_DOMAINS = [
  "Accessibility",
  "Audits",
  "Browser",
  "CacheStorage",
  "Console",
  "CSS",
  "Database",
  "Debugger",
  "DOM",
  "DOMDebugger",
  "DOMSnapshot",
  "Emulation",
  "Fetch",
  "HeapProfiler",
  "IO",
  "Input",
  "Inspector",
  "Log",
  "Memory",
  "Network",
  "Overlay",
  "Page",
  "Performance",
  "Profiler",
  "Runtime",
  "Security",
  "ServiceWorker",
  "Storage",
  "SystemInfo",
  "Target",
  "Tracing",
];

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
    const attributeSignals = [];
    if (!cookie.secure) attributeSignals.push("missing-secure");
    if (likelySensitive && !cookie.httpOnly) attributeSignals.push("sensitive-not-httponly");
    if (!cookie.sameSite || /no_restriction|none/i.test(String(cookie.sameSite))) attributeSignals.push("samesite-none-or-unspecified");
    if (attributeSignals.length) {
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
        attributeSignals,
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

function cookiePartitionKeyLabel(cookie) {
  const key = cookie?.partitionKey;
  if (key === undefined || key === null || key === "") return "(unpartitioned)";
  if (typeof key === "string") return key;
  try {
    return JSON.stringify(key);
  } catch {
    return String(key);
  }
}

function summarizeCookiePartitions(cookies = []) {
  const list = Array.isArray(cookies) ? cookies : [];
  const byPartitionKey = {};
  const byStoreId = {};
  const partitionedCookies = [];
  let partitionedCount = 0;
  let opaquePartitionCount = 0;
  let partitionMetadataCount = 0;
  for (const cookie of list) {
    const partitionKey = cookiePartitionKeyLabel(cookie);
    byPartitionKey[partitionKey] = (byPartitionKey[partitionKey] || 0) + 1;
    if (cookie.storeId) byStoreId[cookie.storeId] = (byStoreId[cookie.storeId] || 0) + 1;
    if (cookie.partitionKey !== undefined || cookie.partitionKeyOpaque !== undefined) partitionMetadataCount += 1;
    if (cookie.partitionKey !== undefined && cookie.partitionKey !== null && cookie.partitionKey !== "") partitionedCount += 1;
    if (cookie.partitionKeyOpaque) opaquePartitionCount += 1;
    if (cookie.partitionKey !== undefined || cookie.partitionKeyOpaque !== undefined) {
      partitionedCookies.push({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
        partitionKey: cookie.partitionKey,
        partitionKeyOpaque: cookie.partitionKeyOpaque,
        sourceScheme: cookie.sourceScheme,
        sourcePort: cookie.sourcePort,
        storeId: cookie.storeId,
      });
    }
  }
  return {
    cookieCount: list.length,
    partitionedCount,
    unpartitionedCount: list.length - partitionedCount,
    opaquePartitionCount,
    partitionMetadataCount,
    partitionMetadataExposed: partitionMetadataCount > 0,
    byPartitionKey,
    byStoreId,
    partitionedCookies,
  };
}

function summarizeStorageBoundaries(frames = []) {
  const list = Array.isArray(frames) ? frames : [];
  const byOrigin = {};
  const byStorageKey = {};
  const storageKeyErrors = [];
  const quotaErrors = [];
  let framesWithStorageKey = 0;
  let framesWithQuota = 0;
  for (const frame of list) {
    const origin = frame.origin || frame.securityOrigin || "(unknown)";
    byOrigin[origin] = (byOrigin[origin] || 0) + 1;
    if (frame.storageKey) {
      framesWithStorageKey += 1;
      byStorageKey[frame.storageKey] = (byStorageKey[frame.storageKey] || 0) + 1;
    }
    if (frame.storageKeyError) {
      storageKeyErrors.push({ frameId: frame.id, url: frame.url, error: frame.storageKeyError });
    }
    if (frame.usageAndQuota?.error) {
      quotaErrors.push({ frameId: frame.id, origin: frame.origin, error: frame.usageAndQuota.error });
    } else if (frame.usageAndQuota) {
      framesWithQuota += 1;
    }
  }
  return {
    frameCount: list.length,
    originCount: Object.keys(byOrigin).length,
    storageKeyCount: Object.keys(byStorageKey).length,
    framesWithStorageKey,
    framesWithoutStorageKey: list.length - framesWithStorageKey,
    framesWithQuota,
    framesWithoutQuota: list.length - framesWithQuota,
    byOrigin,
    byStorageKey,
    storageKeyErrors,
    quotaErrors,
    incomplete: storageKeyErrors.length > 0 || quotaErrors.length > 0,
  };
}

function severityRank(severity) {
  return { high: 3, medium: 2, low: 1, info: 0 }[severity] ?? 0;
}

function buildSignalSummary({ diagnostics = {}, cookieSummary = {}, serviceWorkerSummary = {}, tokenScan = null } = {}) {
  const signals = [];
  const network = diagnostics.network || {};
  const storage = diagnostics.storage || {};
  const page = diagnostics.page || {};
  const security = diagnostics.security || {};
  if (network.failedCount > 0) {
    signals.push({
      id: "network.failed-requests",
      severity: "medium",
      panel: "Network",
      title: "Failed Network requests observed",
      detail: `${network.failedCount} failed request(s) observed in the current capture.`,
      evidence: network.failed || [],
      nextTools: ["devtools_network_summary", "devtools_network_log", "devtools_request_body"],
    });
  }
  if (network.serviceWorkerCount > 0) {
    signals.push({
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
    const attributeSignals = finding.attributeSignals || [];
    const hasSensitiveSignal = attributeSignals.includes("sensitive-not-httponly");
    signals.push({
      id: `cookie.${finding.domain || "domain"}.${finding.name || "cookie"}`,
      severity: hasSensitiveSignal ? "high" : "medium",
      panel: "Application",
      title: `Cookie attribute signal: ${finding.name}`,
      detail: attributeSignals.join(", "),
      evidence: finding,
      nextTools: ["devtools_cookie_summary", "devtools_storage_snapshot", "devtools_application_export"],
    });
  }
  if (cookieSummary.insecureCount > 0 || storage.cookieSummary?.insecureCount > 0) {
    signals.push({
      id: "cookies.insecure-count",
      severity: "medium",
      panel: "Application",
      title: "Cookies without Secure flag",
      detail: `${cookieSummary.insecureCount ?? storage.cookieSummary?.insecureCount ?? 0} cookie(s) are not marked Secure.`,
      nextTools: ["devtools_cookie_summary"],
    });
  }
  if (page?.isSecureContext === false) {
    signals.push({
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
    signals.push({
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
    signals.push({
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
    signals.push({
      id: "security.no-tls-metadata",
      severity: "low",
      panel: "Security",
      title: "No TLS metadata captured yet",
      detail: "The page is HTTPS, but the current capture does not include TLS securityDetails. Start capture and hard reload for complete evidence.",
      nextTools: ["devtools_capture_start", "devtools_hard_reload", "devtools_security_summary"],
    });
  }
  signals.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  return {
    summaryKind: "signals",
    signalCount: signals.length,
    signals,
    highCount: signals.filter((finding) => finding.severity === "high").length,
    mediumCount: signals.filter((finding) => finding.severity === "medium").length,
    lowCount: signals.filter((finding) => finding.severity === "low").length,
    infoCount: signals.filter((finding) => finding.severity === "info").length,
  };
}

function fileSha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function listEvidenceFiles(rootDir, options = {}) {
  const maxFiles = typeof options.maxFiles === "number" ? options.maxFiles : 200;
  const maxBytesForHash = typeof options.maxBytesForHash === "number" ? options.maxBytesForHash : 25_000_000;
  const out = [];
  const walk = (dir) => {
    if (out.length >= maxFiles || !existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (out.length >= maxFiles) break;
      const file = join(dir, name);
      let stat;
      try {
        stat = statSync(file);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(file);
        continue;
      }
      const relativePath = file.slice(rootDir.length).replace(/^[/\\]/, "");
      out.push({
        path: file,
        relativePath,
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        sha256: stat.size <= maxBytesForHash ? fileSha256(file) : null,
        hashSkipped: stat.size > maxBytesForHash,
      });
    }
  };
  walk(rootDir);
  return out;
}

function readJsonFile(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function requestOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function requestPathname(url) {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return String(url || "");
  }
}

function requestSet(records = []) {
  const set = new Map();
  for (const record of records || []) {
    const key = `${record.method || "GET"} ${requestOrigin(record.url)}${requestPathname(record.url)}`;
    const item = set.get(key) || { key, count: 0, statuses: {}, methods: {}, origins: {}, sampleUrls: [] };
    item.count += 1;
    item.statuses[String(record.status || record.statusCode || "pending")] = (item.statuses[String(record.status || record.statusCode || "pending")] || 0) + 1;
    item.methods[String(record.method || "GET")] = (item.methods[String(record.method || "GET")] || 0) + 1;
    const origin = requestOrigin(record.url) || "(unknown)";
    item.origins[origin] = (item.origins[origin] || 0) + 1;
    if (item.sampleUrls.length < 3 && record.url) item.sampleUrls.push(record.url);
    set.set(key, item);
  }
  return set;
}

function diffRequestSets(beforeRecords = [], afterRecords = []) {
  const before = requestSet(beforeRecords);
  const after = requestSet(afterRecords);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [key, value] of after) {
    if (!before.has(key)) added.push(value);
    else {
      const prior = before.get(key);
      if (JSON.stringify(prior.statuses) !== JSON.stringify(value.statuses) || prior.count !== value.count) {
        changed.push({ key, before: prior, after: value });
      }
    }
  }
  for (const [key, value] of before) {
    if (!after.has(key)) removed.push(value);
  }
  return { added, removed, changed };
}

function extractHarRecords(payload = {}) {
  return payload?.har?.log?.entries?.map((entry) => ({
    method: entry.request?.method,
    url: entry.request?.url,
    status: entry.response?.status,
  })) || [];
}

function extractBundleNetworkRecords(payload = {}) {
  const records = payload?.bundle?.networkSummary?.requests || payload?.networkSummary?.requests || payload?.requests;
  return Array.isArray(records) ? records : extractHarRecords(payload);
}

function diffObjectKeys(before = {}, after = {}) {
  const beforeKeys = new Set(Object.keys(before || {}));
  const afterKeys = new Set(Object.keys(after || {}));
  return {
    added: [...afterKeys].filter((key) => !beforeKeys.has(key)).sort(),
    removed: [...beforeKeys].filter((key) => !afterKeys.has(key)).sort(),
    common: [...afterKeys].filter((key) => beforeKeys.has(key)).sort(),
  };
}

function headerValue(headers = {}, name) {
  const wanted = String(name || "").toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === wanted) return value;
  }
  return undefined;
}

function authHeaderEvidence(requests = [], limit = 50) {
  const evidence = [];
  for (const request of requests || []) {
    const headers = request.requestHeaders || request.headers || {};
    const authorization = headerValue(headers, "authorization");
    const cookie = headerValue(headers, "cookie");
    const csrf = Object.entries(headers).find(([key]) => /csrf|xsrf/i.test(key));
    if (authorization || cookie || csrf) {
      evidence.push({
        requestId: request.requestId,
        method: request.method,
        url: request.url,
        status: request.status,
        hasAuthorizationHeader: authorization !== undefined,
        authorizationScheme: authorization ? String(authorization).split(/\s+/)[0] : null,
        hasCookieHeader: cookie !== undefined,
        cookieHeaderBytes: cookie ? String(cookie).length : 0,
        csrfHeader: csrf ? csrf[0] : null,
      });
    }
    if (evidence.length >= limit) break;
  }
  return evidence;
}

function buildRequestCorrelationGraph({ requests = [], consoleEntries = [], scripts = [], frames = [], limit = 200 } = {}) {
  const nodes = [];
  const edges = [];
  const seen = new Set();
  const addNode = (node) => {
    if (!node?.id || seen.has(node.id) || nodes.length >= limit) return;
    seen.add(node.id);
    nodes.push(node);
  };
  const addEdge = (edge) => {
    if (!edge?.from || !edge?.to || edges.length >= limit * 2) return;
    edges.push(edge);
  };
  for (const frame of frames || []) {
    const id = `frame:${frame.id || frame.frameId || frame.url}`;
    addNode({ id, type: "frame", label: frame.url || frame.name || id, url: frame.url, origin: frame.origin || frame.securityOrigin });
  }
  for (const script of scripts || []) {
    const id = `script:${script.scriptId || script.url || nodes.length}`;
    addNode({ id, type: "script", label: script.url || script.scriptId, url: script.url, sourceMapURL: script.sourceMapURL || "" });
  }
  for (const request of (requests || []).slice(-limit)) {
    const id = `request:${request.requestId || request.url}`;
    addNode({
      id,
      type: "request",
      label: `${request.method || "GET"} ${requestPathname(request.url)}`,
      requestId: request.requestId,
      method: request.method,
      url: request.url,
      status: request.status,
      resourceType: request.resourceType,
    });
    if (request.frameId) addEdge({ from: `frame:${request.frameId}`, to: id, type: "frame-request" });
    const initiatorUrl = request.initiator?.url || request.initiator?.stack?.callFrames?.[0]?.url || "";
    if (initiatorUrl) {
      const script = (scripts || []).find((candidate) => candidate.url && initiatorUrl.includes(candidate.url));
      const scriptId = script ? `script:${script.scriptId || script.url}` : `initiator:${initiatorUrl}`;
      addNode({ id: scriptId, type: script ? "script" : "initiator", label: initiatorUrl, url: initiatorUrl });
      addEdge({ from: scriptId, to: id, type: "initiates" });
    }
  }
  for (const entry of (consoleEntries || []).slice(-limit)) {
    const id = `console:${entry.timestamp || entry.text || nodes.length}`;
    addNode({ id, type: "console", label: entry.text || entry.message || entry.level, level: entry.level, url: entry.url });
    if (entry.url) {
      const script = (scripts || []).find((candidate) => candidate.url && entry.url.includes(candidate.url));
      if (script) addEdge({ from: `script:${script.scriptId || script.url}`, to: id, type: "emits-console" });
    }
  }
  return { nodeCount: nodes.length, edgeCount: edges.length, nodes, edges };
}

function flattenFrameTree(frameTree, out = []) {
  if (!frameTree) return out;
  const frame = frameTree.frame || frameTree;
  if (frame) out.push(frame);
  for (const child of frameTree.childFrames || []) flattenFrameTree(child, out);
  return out;
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

function buildInitiatorSummary(initiator = null) {
  if (!initiator) return null;
  const stack = initiator.stack || initiator.asyncStackTrace || null;
  const callFrames = [];
  const collectFrames = (trace, relation = "sync") => {
    if (!trace) return;
    for (const frame of trace.callFrames || []) {
      callFrames.push({
        relation,
        functionName: frame.functionName || "",
        url: frame.url || "",
        lineNumber: frame.lineNumber,
        columnNumber: frame.columnNumber,
        scriptId: frame.scriptId || null,
      });
    }
    if (trace.parent) collectFrames(trace.parent, "parent");
    if (trace.parentId) callFrames.push({ relation: "parentId", id: trace.parentId });
  };
  collectFrames(stack);
  if (initiator.url && !callFrames.some((frame) => frame.url === initiator.url)) {
    callFrames.push({
      relation: "initiator-url",
      functionName: "",
      url: initiator.url,
      lineNumber: initiator.lineNumber,
      columnNumber: initiator.columnNumber,
      scriptId: null,
    });
  }
  return {
    type: initiator.type || null,
    url: initiator.url || callFrames.find((frame) => frame.url)?.url || null,
    lineNumber: initiator.lineNumber ?? callFrames.find((frame) => Number.isFinite(frame.lineNumber))?.lineNumber ?? null,
    columnNumber: initiator.columnNumber ?? callFrames.find((frame) => Number.isFinite(frame.columnNumber))?.columnNumber ?? null,
    stackDescription: stack?.description || null,
    stackDepth: callFrames.length,
    callFrames,
  };
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
    initiatorSummary: buildInitiatorSummary(entry.initiator || null),
    lifecycleFlags: {
      failed: Boolean(entry.failed),
      blocked: Boolean(entry.blockedReason),
      redirected: Array.isArray(entry.redirectChain) && entry.redirectChain.length > 0,
      fromDiskCache: Boolean(entry.fromDiskCache),
      fromServiceWorker: Boolean(entry.fromServiceWorker),
      hasExtraInfo: Boolean(entry.requestWillBeSentExtraInfoSeen || entry.responseReceivedExtraInfoSeen),
      hasPostData: Boolean(entry.hasPostData),
      bodyReadable: Boolean(entry.bodyReadable || entry.bodyText || entry.bodyPath),
    },
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

function classifyTraceEvent(name, category) {
  const text = `${name} ${category}`.toLowerCase();
  if (/urlrequest|resource|network|netlog|sendrequest|receiveresponse|loading/.test(text)) return "network";
  if (/parsehtml|commitload|navigation|markload|markDOMContent|firstcontentfulpaint/i.test(name)) return "loading";
  if (/functioncall|evaluatescript|v8|timerfire|eventdispatch|runtask|compile|parse script|javascript/i.test(name)) return "scripting";
  if (/layout|style|recalculatestyle|updatelayouttree|invalidate/i.test(name)) return "rendering";
  if (/paint|raster|composite|draw|gpu/i.test(name)) return "painting";
  return "other";
}

function addTraceBucket(map, key, durationMs, count = 1) {
  const bucket = map[key] || { count: 0, durationMs: 0 };
  bucket.count += count;
  bucket.durationMs += durationMs;
  map[key] = bucket;
}

function summarizeTraceEvents(events = [], limit = 10) {
  const byCategory = {};
  const byName = {};
  const byPhase = {};
  const byThread = {};
  const byProcess = {};
  const longEvents = [];
  const screenshots = [];
  const networkLike = [];
  const topDurations = [];
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const event of events) {
    const categories = String(event.cat || "").split(",").filter(Boolean);
    for (const category of categories) byCategory[category] = (byCategory[category] || 0) + 1;
    const name = String(event.name || "(unknown)");
    byName[name] = (byName[name] || 0) + 1;
    if (typeof event.ts === "number") {
      minTs = Math.min(minTs, event.ts);
      maxTs = Math.max(maxTs, event.ts + (typeof event.dur === "number" ? event.dur : 0));
    }
    const durationMs = typeof event.dur === "number" ? event.dur / 1000 : 0;
    if (durationMs > 0) {
      const phase = classifyTraceEvent(name, event.cat);
      addTraceBucket(byPhase, phase, durationMs);
      addTraceBucket(byThread, `${event.pid || "?"}:${event.tid || "?"}`, durationMs);
      addTraceBucket(byProcess, String(event.pid || "?"), durationMs);
      topDurations.push({
        name,
        category: event.cat,
        phase,
        ts: event.ts,
        durationMs: Math.round(durationMs * 100) / 100,
        thread: event.tid,
        process: event.pid,
      });
    }
    if (typeof event.dur === "number" && event.dur >= 50_000) {
      longEvents.push({
        name,
        category: event.cat,
        phase: classifyTraceEvent(name, event.cat),
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
  topDurations.sort((a, b) => b.durationMs - a.durationMs);
  const topEntries = (object) => Object.entries(object)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
  const topDurationBuckets = (object) => Object.entries(object)
    .sort((a, b) => b[1].durationMs - a[1].durationMs)
    .slice(0, limit)
    .map(([name, value]) => ({
      name,
      count: value.count,
      durationMs: Math.round(value.durationMs * 100) / 100,
    }));
  return {
    eventCount: events.length,
    timeRangeMs: Number.isFinite(minTs) && Number.isFinite(maxTs) ? Math.round((maxTs - minTs) / 1000) : 0,
    topCategories: topEntries(byCategory),
    topNames: topEntries(byName),
    durationByPhase: topDurationBuckets(byPhase),
    busiestThreads: topDurationBuckets(byThread),
    busiestProcesses: topDurationBuckets(byProcess),
    topDurations: topDurations.slice(0, limit),
    longEventCount: longEvents.length,
    longEvents: longEvents.slice(0, limit),
    screenshotEventCount: screenshots.length,
    screenshots: screenshots.slice(0, limit),
    networkEventCount: networkLike.length,
    networkEvents: networkLike.slice(0, limit),
  };
}

function summarizePerformanceInsights(page = {}, chromeTrace = null, limit = 10) {
  const performancePage = page?.page || page || {};
  const resources = Array.isArray(performancePage.resources) ? performancePage.resources : [];
  const longTasks = Array.isArray(performancePage.longTasks) ? performancePage.longTasks : [];
  const paints = Array.isArray(performancePage.paints) ? performancePage.paints : [];
  const navigation = Array.isArray(performancePage.navigation) ? performancePage.navigation[0] : null;
  const slowResources = resources
    .map((entry) => ({
      name: entry.name,
      initiatorType: entry.initiatorType,
      duration: Math.round(Number(entry.duration || 0) * 100) / 100,
      transferSize: entry.transferSize,
      encodedBodySize: entry.encodedBodySize,
      decodedBodySize: entry.decodedBodySize,
      renderBlockingStatus: entry.renderBlockingStatus,
    }))
    .filter((entry) => entry.duration > 0)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, limit);
  const longestLongTasks = longTasks
    .map((entry) => ({
      name: entry.name,
      startTime: Math.round(Number(entry.startTime || 0) * 100) / 100,
      duration: Math.round(Number(entry.duration || 0) * 100) / 100,
      attribution: entry.attribution,
    }))
    .sort((a, b) => b.duration - a.duration)
    .slice(0, limit);
  const traceSummary = chromeTrace?.traceSummary || chromeTrace?.summary || null;
  const traceLongEvents = Array.isArray(traceSummary?.longEvents) ? traceSummary.longEvents.slice(0, limit) : [];
  return {
    generatedAt: new Date().toISOString(),
    source: {
      performanceEntries: true,
      chromeTrace: Boolean(traceSummary),
      tracePath: chromeTrace?.tracePath || null,
    },
    page: {
      url: performancePage.url || null,
      durationMs: performancePage.durationMs || null,
      timeOrigin: performancePage.timeOrigin || null,
    },
    navigation: navigation ? {
      type: navigation.type,
      duration: Math.round(Number(navigation.duration || 0) * 100) / 100,
      domContentLoadedEventEnd: navigation.domContentLoadedEventEnd,
      loadEventEnd: navigation.loadEventEnd,
      transferSize: navigation.transferSize,
      encodedBodySize: navigation.encodedBodySize,
      decodedBodySize: navigation.decodedBodySize,
    } : null,
    paints,
    resourceCount: resources.length,
    slowResources,
    longTaskCount: longTasks.length,
    longestLongTasks,
    trace: traceSummary ? {
      eventCount: traceSummary.eventCount,
      timeRangeMs: traceSummary.timeRangeMs,
      durationByPhase: traceSummary.durationByPhase || [],
      busiestThreads: traceSummary.busiestThreads || [],
      topDurations: traceSummary.topDurations || [],
      longEventCount: traceSummary.longEventCount || 0,
      longEvents: traceLongEvents,
      screenshotEventCount: traceSummary.screenshotEventCount || 0,
    } : null,
    captureBoundaries: [
      "Performance entries describe the current page's browser-exposed timing state.",
      "Long task attribution is browser-provided and may be sparse.",
      "Chrome trace evidence is complete only for the explicit trace window.",
      "This is objective performance evidence, not a root-cause verdict.",
    ],
    nextTools: ["devtools_chrome_trace", "devtools_cpu_profile", "devtools_coverage_detail", "devtools_source_get"],
  };
}

function summarizePerformanceObserverSnapshot(snapshot = {}, limit = 10) {
  const entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
  const byTypeCount = {};
  for (const entry of entries) {
    const type = entry.entryType || "unknown";
    byTypeCount[type] = (byTypeCount[type] || 0) + 1;
  }
  const byType = (type) => entries.filter((entry) => entry.entryType === type);
  const round = (value) => Math.round(Number(value || 0) * 100) / 100;
  const topByDuration = (type) => byType(type)
    .map((entry) => ({
      name: entry.name || null,
      startTime: round(entry.startTime),
      duration: round(entry.duration),
      url: entry.url || entry.renderURL || null,
      detail: entry.detail || null,
      value: entry.value,
      hadRecentInput: entry.hadRecentInput,
    }))
    .sort((a, b) => b.duration - a.duration)
    .slice(0, limit);
  const layoutShifts = byType("layout-shift");
  const unexpectedLayoutShifts = layoutShifts.filter((entry) => !entry.hadRecentInput);
  const lcpCandidates = byType("largest-contentful-paint").sort((a, b) => Number(a.startTime || 0) - Number(b.startTime || 0));
  const lcp = lcpCandidates.at(-1) || null;
  const resources = byType("resource")
    .map((entry) => ({
      name: entry.name,
      initiatorType: entry.initiatorType,
      startTime: round(entry.startTime),
      duration: round(entry.duration),
      transferSize: entry.transferSize,
      encodedBodySize: entry.encodedBodySize,
      decodedBodySize: entry.decodedBodySize,
    }))
    .sort((a, b) => b.duration - a.duration)
    .slice(0, limit);
  return {
    generatedAt: new Date().toISOString(),
    source: "PerformanceObserver",
    supportedEntryTypes: snapshot.supportedEntryTypes || [],
    requestedEntryTypes: snapshot.requestedEntryTypes || [],
    observedEntryTypes: Object.keys(byTypeCount).sort(),
    unsupportedEntryTypes: snapshot.unsupportedEntryTypes || [],
    observeErrors: snapshot.observeErrors || [],
    entryCount: entries.length,
    byTypeCount,
    largestContentfulPaint: lcp ? {
      name: lcp.name || null,
      startTime: round(lcp.startTime),
      renderTime: round(lcp.renderTime),
      loadTime: round(lcp.loadTime),
      size: lcp.size,
      url: lcp.url || null,
      id: lcp.id || null,
    } : null,
    layoutShift: {
      count: layoutShifts.length,
      totalScore: Math.round(layoutShifts.reduce((sum, entry) => sum + Number(entry.value || 0), 0) * 10000) / 10000,
      unexpectedScore: Math.round(unexpectedLayoutShifts.reduce((sum, entry) => sum + Number(entry.value || 0), 0) * 10000) / 10000,
      top: layoutShifts
        .map((entry) => ({
          startTime: round(entry.startTime),
          value: entry.value,
          hadRecentInput: Boolean(entry.hadRecentInput),
          sourceCount: Array.isArray(entry.sources) ? entry.sources.length : 0,
          sources: Array.isArray(entry.sources) ? entry.sources.slice(0, 5) : [],
        }))
        .sort((a, b) => Number(b.value || 0) - Number(a.value || 0))
        .slice(0, limit),
    },
    longTasks: {
      count: byType("longtask").length,
      top: topByDuration("longtask"),
    },
    longAnimationFrames: {
      count: byType("long-animation-frame").length,
      top: topByDuration("long-animation-frame"),
    },
    eventTiming: {
      count: byType("event").length,
      top: topByDuration("event"),
    },
    paints: byType("paint").map((entry) => ({ name: entry.name, startTime: round(entry.startTime), duration: round(entry.duration) })),
    navigation: byType("navigation").slice(0, 1),
    slowResources: resources,
    captureBoundaries: [
      "PerformanceObserver reports entries Chrome exposes to the current page context.",
      "Some entry types are browser-version dependent and appear in unsupportedEntryTypes when unavailable.",
      "Entries are complete only for buffered entries plus the explicit observation window.",
      "This is objective timing evidence, not a root-cause verdict.",
    ],
    nextTools: ["devtools_performance_insights", "devtools_chrome_trace", "devtools_cpu_profile", "devtools_cdp_command"],
  };
}

function extractTraceScreenshots(events = [], directory, options = {}) {
  const maxScreenshots = Math.max(0, Number(options.maxScreenshots || 5));
  if (!maxScreenshots || !directory) return [];
  mkdirSync(directory, { recursive: true });
  const frames = [];
  for (const event of events) {
    if (frames.length >= maxScreenshots) break;
    const name = String(event?.name || "");
    const snapshot = event?.args?.snapshot;
    if (!name.toLowerCase().includes("screenshot") || typeof snapshot !== "string" || !snapshot) continue;
    const safeTs = String(event.ts || Date.now()).replace(/[^a-zA-Z0-9_.-]/g, "_");
    const path = join(directory, `${safeTs}-trace-screenshot.jpg`);
    const bytes = Buffer.from(snapshot, "base64");
    writeFileSync(path, bytes);
    frames.push({
      path,
      bytes: bytes.length,
      mimeType: "image/jpeg",
      ts: event.ts,
      name,
    });
  }
  return frames;
}

function findLatestTracePath(directory) {
  if (!directory || !existsSync(directory)) return null;
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const path = join(directory, name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        // Ignore files that disappear between readdir and stat.
      }
      return { path, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0]?.path || null;
}

function findRecentTracePaths(directory, count = 2) {
  if (!directory || !existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const path = join(directory, name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        // Ignore files that disappear between readdir and stat.
      }
      return { path, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, count)
    .map((entry) => entry.path);
}

function traceProfile(events = []) {
  const countMap = (getKey, getValue = () => 1) => {
    const map = new Map();
    for (const event of events) {
      const key = getKey(event) || "(none)";
      map.set(key, (map.get(key) || 0) + getValue(event));
    }
    return map;
  };
  const names = countMap((event) => event.name);
  const categories = countMap((event) => String(event.cat || "").split(",")[0]);
  const phases = countMap((event) => event.ph);
  const threads = countMap((event) => `${event.pid}:${event.tid}`);
  const durationsByName = countMap((event) => event.name, (event) => Number(event.dur || 0) / 1000);
  return { names, categories, phases, threads, durationsByName };
}

function diffMap(before = new Map(), after = new Map(), limit = 25) {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].map((key) => ({
    key,
    before: Math.round(Number(before.get(key) || 0) * 100) / 100,
    after: Math.round(Number(after.get(key) || 0) * 100) / 100,
    delta: Math.round((Number(after.get(key) || 0) - Number(before.get(key) || 0)) * 100) / 100,
  }))
    .filter((row) => row.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, limit);
}

function compareTraceEvents(beforeEvents = [], afterEvents = [], params = {}) {
  const limit = Math.max(1, Math.min(typeof params.limit === "number" ? params.limit : 25, 500));
  const before = traceProfile(beforeEvents);
  const after = traceProfile(afterEvents);
  const beforeSummary = summarizeTraceEvents(beforeEvents, limit);
  const afterSummary = summarizeTraceEvents(afterEvents, limit);
  return {
    before: {
      eventCount: beforeEvents.length,
      timeRangeMs: beforeSummary.timeRangeMs,
    },
    after: {
      eventCount: afterEvents.length,
      timeRangeMs: afterSummary.timeRangeMs,
    },
    deltas: {
      eventCount: afterEvents.length - beforeEvents.length,
      timeRangeMs: afterSummary.timeRangeMs != null && beforeSummary.timeRangeMs != null
        ? Math.round((afterSummary.timeRangeMs - beforeSummary.timeRangeMs) * 100) / 100
        : null,
      names: diffMap(before.names, after.names, limit),
      categories: diffMap(before.categories, after.categories, limit),
      phases: diffMap(before.phases, after.phases, limit),
      threads: diffMap(before.threads, after.threads, limit),
      durationByNameMs: diffMap(before.durationsByName, after.durationsByName, limit),
    },
    captureBoundaries: [
      "Trace comparison is only meaningful when both traces captured comparable actions and durations.",
      "This compares observed trace event counts and durations; it does not decide root cause.",
      "Use devtools_trace_query on specific changed event names for drill-down.",
    ],
    nextTools: ["devtools_trace_query", "devtools_chrome_trace", "devtools_cpu_profile"],
  };
}

function summarizeTraceQuery(events = [], params = {}) {
  const query = String(params.query || "").trim().toLowerCase();
  const nameFilter = String(params.name || "").trim().toLowerCase();
  const categoryFilter = String(params.category || "").trim().toLowerCase();
  const phaseFilter = String(params.phase || "").trim();
  const minDurationUs = typeof params.minDurationMs === "number" ? params.minDurationMs * 1000 : null;
  const maxDurationUs = typeof params.maxDurationMs === "number" ? params.maxDurationMs * 1000 : null;
  const limit = Math.max(1, Math.min(typeof params.limit === "number" ? params.limit : 50, 1000));
  const sortBy = String(params.sortBy || "duration");
  const minTs = Math.min(...events.map((event) => Number(event.ts)).filter(Number.isFinite));
  const startUs = typeof params.startTimeMs === "number" && Number.isFinite(minTs) ? minTs + params.startTimeMs * 1000 : null;
  const endUs = typeof params.endTimeMs === "number" && Number.isFinite(minTs) ? minTs + params.endTimeMs * 1000 : null;
  const matches = events.filter((event) => {
    const duration = Number(event.dur || 0);
    const ts = Number(event.ts);
    if (nameFilter && !String(event.name || "").toLowerCase().includes(nameFilter)) return false;
    if (categoryFilter && !String(event.cat || "").toLowerCase().includes(categoryFilter)) return false;
    if (phaseFilter && String(event.ph || "") !== phaseFilter) return false;
    if (typeof params.processId === "number" && Number(event.pid) !== Number(params.processId)) return false;
    if (typeof params.threadId === "number" && Number(event.tid) !== Number(params.threadId)) return false;
    if (minDurationUs !== null && duration < minDurationUs) return false;
    if (maxDurationUs !== null && duration > maxDurationUs) return false;
    if (startUs !== null && ts < startUs) return false;
    if (endUs !== null && ts > endUs) return false;
    if (query && !JSON.stringify(event).toLowerCase().includes(query)) return false;
    return true;
  });
  const sorted = [...matches].sort((a, b) => {
    if (sortBy === "timestamp") return Number(a.ts || 0) - Number(b.ts || 0);
    if (sortBy === "name") return String(a.name || "").localeCompare(String(b.name || ""));
    return Number(b.dur || 0) - Number(a.dur || 0);
  });
  const countMap = (items, getKey) => {
    const map = new Map();
    for (const item of items) {
      const key = getKey(item) || "(none)";
      map.set(key, (map.get(key) || 0) + 1);
    }
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([key, count]) => ({ key, count }));
  };
  const returnedEvents = sorted.slice(0, limit).map((event) => ({
    name: event.name || "",
    category: event.cat || "",
    phase: event.ph || "",
    processId: event.pid,
    threadId: event.tid,
    timestampUs: event.ts,
    relativeStartMs: Number.isFinite(minTs) && Number.isFinite(Number(event.ts)) ? Math.round(((Number(event.ts) - minTs) / 1000) * 100) / 100 : null,
    durationMs: Math.round((Number(event.dur || 0) / 1000) * 100) / 100,
    args: event.args || {},
  }));
  const timestamps = events.map((event) => Number(event.ts)).filter(Number.isFinite);
  const maxTs = Math.max(...timestamps);
  return {
    totalEvents: events.length,
    matchedCount: matches.length,
    returnedCount: returnedEvents.length,
    truncated: matches.length > returnedEvents.length,
    timeRangeMs: Number.isFinite(minTs) && Number.isFinite(maxTs) ? Math.round(((maxTs - minTs) / 1000) * 100) / 100 : null,
    filters: {
      query: query || null,
      name: nameFilter || null,
      category: categoryFilter || null,
      phase: phaseFilter || null,
      processId: params.processId ?? null,
      threadId: params.threadId ?? null,
      minDurationMs: params.minDurationMs ?? null,
      maxDurationMs: params.maxDurationMs ?? null,
      startTimeMs: params.startTimeMs ?? null,
      endTimeMs: params.endTimeMs ?? null,
      sortBy,
    },
    categoryCounts: countMap(matches, (event) => String(event.cat || "").split(",")[0]),
    phaseCounts: countMap(matches, (event) => event.ph),
    topNames: countMap(matches, (event) => event.name),
    threads: countMap(matches, (event) => `${event.pid}:${event.tid}`),
    events: returnedEvents,
    captureBoundaries: [
      "This reads a saved Chrome trace JSON file; it cannot recover trace events that were not captured.",
      "Durations are reported from Chrome trace event dur fields when present.",
      "Use devtools_chrome_trace around the smallest reproducible action before querying.",
    ],
  };
}

function summarizeEvidenceCompleteness(evidence = {}) {
  const notes = [];
  const walk = (value, path = "evidence") => {
    if (!value || typeof value !== "object") return;
    if (value.unavailable) notes.push({ path, status: "unavailable", detail: value.error || value.tool || "tool unavailable" });
    else if (value.error) notes.push({ path, status: "error", detail: String(value.error) });
    if (value.truncated === true) notes.push({ path, status: "truncated", detail: "result limited by max count or max bytes" });
    if (value.parseError) notes.push({ path, status: "parse_error", detail: String(value.parseError) });
    if (Array.isArray(value.frameErrors) && value.frameErrors.length) {
      notes.push({ path, status: "partial_frames", detail: `${value.frameErrors.length} frame(s) could not be inspected` });
    }
    for (const [key, child] of Object.entries(value)) {
      if (!child || typeof child !== "object") continue;
      if (key === "requestHeaders" || key === "responseHeaders" || key === "browserCookiesForUrl") continue;
      walk(child, `${path}.${key}`);
    }
  };
  walk(evidence);
  return {
    status: notes.length ? "partial" : "complete_for_current_capture",
    noteCount: notes.length,
    notes: notes.slice(0, 20),
  };
}

function buildAgentInspectToolPlan(focus, options = {}) {
  const base = {
    intent: "Use agent_inspect as the first-screen router; call low-level devtools_* tools only for drill-down.",
    escapeHatch: "devtools_cdp_command",
    schemaTool: "devtools_protocol_schema",
  };
  if (focus === "network") {
    return {
      ...base,
      firstPass: ["devtools_network_summary", "devtools_network_timeline", "devtools_network_log", "devtools_realtime_log"],
      drillDown: options.requestId
        ? ["devtools_request_detail", "devtools_request_body", "devtools_request_payload", "devtools_request_replay", "devtools_request_replay_batch"]
        : ["pick a requestId, then rerun agent_inspect focus=network requestId=<id>"],
      captureHint: "If request rows are missing, run devtools_capture_start and devtools_hard_reload before repeating the user action.",
      objectiveBoundary: "Replay diffs compare observed browser fetch results; they do not prove exploitability by themselves.",
    };
  }
  if (focus === "storage") {
    return {
      ...base,
      firstPass: ["devtools_storage_origin_summary", "devtools_cookie_summary", "devtools_service_worker_summary"],
      drillDown: ["devtools_application_export", "devtools_indexeddb_read", "devtools_cache_entry_get"],
      captureHint: "Storage is current-state evidence. Use Application export for handoff and repeatability.",
      objectiveBoundary: "Partition metadata is reported only when Chrome exposes it for the current page.",
    };
  }
  if (focus === "dom") {
    return {
      ...base,
      firstPass: ["devtools_elements_snapshot", options.query ? "devtools_dom_search" : "pass query for DOM search"],
      drillDown: options.selector ? ["devtools_css_styles", "devtools_event_listeners", "devtools_dom_mutation_watch"] : ["pass selector for selected-node evidence"],
      captureHint: "Use framePath or frameIndexes when evidence is inside a same-origin iframe.",
      objectiveBoundary: "Cross-origin frame internals remain inaccessible unless the browser grants that access.",
    };
  }
  if (focus === "sources" || focus === "debug") {
    return {
      ...base,
      firstPass: ["devtools_sources_list", options.query ? "devtools_sources_search" : "pass query for source search"],
      drillDown: ["devtools_source_get", "devtools_source_pretty_print", "devtools_source_map_metadata", "devtools_debugger_control"],
      captureHint: "Use debugger controls for live runtime state; source text alone is not runtime proof.",
      objectiveBoundary: "Heap/closure-only values are visible only when the debugger pauses in the right execution context.",
    };
  }
  if (focus === "performance") {
    return {
      ...base,
      firstPass: ["devtools_memory_snapshot", "devtools_performance_observer", "devtools_performance_insights", "devtools_performance_trace"],
      drillDown: ["devtools_chrome_trace", "devtools_trace_query", "devtools_trace_compare", "devtools_cpu_profile", "devtools_coverage_detail"],
      captureHint: "Use heavier traces only around the smallest reproducible action.",
      objectiveBoundary: "Trace summaries expose timing evidence, not root-cause conclusions.",
    };
  }
  if (focus === "search") {
    return {
      ...base,
      firstPass: options.query ? ["devtools_global_search"] : ["provide query"],
      drillDown: ["agent_inspect focus=network", "agent_inspect focus=storage", "agent_inspect focus=sources"],
      captureHint: "Search only covers evidence currently captured or readable from the page.",
      objectiveBoundary: "No match means no match in current evidence, not proof that the value never existed.",
    };
  }
  if (focus === "evidence") {
    return {
      ...base,
      firstPass: ["devtools_evidence_bundle"],
      drillDown: ["devtools_save_har", "devtools_application_export", "agent_inspect focus=search query=<hypothesis>"],
      captureHint: "Save bundles after the relevant action has been reproduced with capture enabled.",
      objectiveBoundary: "Bundles preserve evidence for review; interpretation remains the Agent or human's job.",
    };
  }
  return {
    ...base,
    firstPass: ["devtools_backend_capabilities", "agent_inspect focus=overview"],
    drillDown: ["agent_inspect focus=network", "agent_inspect focus=storage", "agent_inspect focus=console", "agent_inspect focus=dom", "agent_inspect focus=evidence", "devtools_browser_version", "devtools_browser_targets"],
    captureHint: "Start capture before reproducing behavior you want Network/Console evidence for.",
    objectiveBoundary: "Overview organizes signals; it does not decide whether a finding is a vulnerability.",
  };
}

function devtoolsToolCategory(name) {
  if (name === "agent_inspect" || /backend_capabilities|tool_catalog|tool_help|workflow_guide|protocol_schema/.test(name)) return "orientation";
  if (/tabs|snapshot|screenshot|click|type|scroll|eval|hard_reload/.test(name)) return "page-control";
  if (/network|request|har|capture_|realtime/.test(name)) return "network";
  if (/console|issues|security_summary|signal_summary|page_diagnostics/.test(name)) return "diagnostics";
  if (/storage|cookie|service_worker|application|indexeddb|cache|auth_boundary/.test(name)) return "application";
  if (/frame|accessibility|elements|dom|css|event_listeners|worker_frame/.test(name)) return "dom-frame";
  if (/source|debugger|token_flow|global_search/.test(name)) return "sources-debugger";
  if (/performance|trace|cpu|coverage|memory/.test(name)) return "performance";
  if (/evidence|manifest|correlation|diff|research_pack/.test(name)) return "evidence-workflow";
  if (/cdp_command|browser_version|browser_targets|system_info/.test(name)) return "raw-cdp";
  return "other";
}

function devtoolsToolCatalogFromEntries(entries, options = {}) {
  const query = String(options.query || "").trim().toLowerCase();
  const categoryFilter = String(options.category || "").trim().toLowerCase();
  const includeBackendSpecific = Boolean(options.includeBackendSpecific);
  const rows = entries
    .filter((tool) => includeBackendSpecific || tool.name === "agent_inspect" || tool.name.startsWith("devtools_"))
    .map((tool) => ({
      name: tool.name,
      category: devtoolsToolCategory(tool.name),
      description: tool.description || "",
      required: tool.parameters?.required || [],
      parameterNames: Object.keys(tool.parameters?.properties || {}),
    }))
    .filter((tool) => !categoryFilter || tool.category === categoryFilter)
    .filter((tool) => !query || `${tool.name} ${tool.category} ${tool.description} ${tool.parameterNames.join(" ")}`.toLowerCase().includes(query))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  const categories = {};
  for (const tool of rows) {
    categories[tool.category] = (categories[tool.category] || 0) + 1;
  }
  return {
    generatedAt: new Date().toISOString(),
    toolCount: rows.length,
    categories,
    tools: rows,
    boundaries: [
      "Tool catalog is a navigation aid; it does not choose or execute tools automatically.",
      "Prefer agent_inspect or devtools_security_research_pack for first-pass work, then drill down.",
    ],
  };
}

function devtoolsWorkflowGuide(task = "first-pass") {
  const key = String(task || "first-pass").trim().toLowerCase().replace(/[\s_]+/g, "-");
  const recipes = {
    "first-pass": {
      title: "First page inspection",
      goal: "Understand current page, backend layer, capture state, and first objective signals.",
      steps: [
        { tool: "devtools_backend_capabilities", why: "Know whether this is Managed CDP or Personal Chrome and what boundaries apply." },
        { tool: "agent_inspect", input: { focus: "overview", limit: 10 }, why: "Get dashboard evidence and next drill-down tools." },
        { tool: "devtools_signal_summary", why: "List objective cross-panel signals without deciding vulnerability impact." },
      ],
    },
    "security-research-pack": {
      title: "One-call security research evidence pack",
      goal: "Create portable first-pass evidence for an authorized target.",
      steps: [
        { tool: "devtools_security_research_pack", input: { url: "https://example.com", profile: "researcher" }, why: "Capture, reload, collect F12 evidence, and save artifact paths." },
        { tool: "devtools_evidence_manifest", why: "Verify artifact hashes and provenance when needed." },
        { tool: "devtools_request_correlation_graph", why: "Choose which request/script/frame chain to drill into." },
      ],
    },
    "network-capture": {
      title: "Network capture and request drill-down",
      goal: "Record a reproducible action and inspect request details.",
      steps: [
        { tool: "devtools_capture_start", input: { clear: true, label: "reproduce" }, why: "Start an explicit F12 recording window." },
        { tool: "devtools_hard_reload", input: { waitMs: 1000 }, why: "Reload with cache disabled and Service Worker bypass where supported." },
        { tool: "agent_inspect", input: { focus: "network", limit: 20 }, why: "Find request ids and request shapes." },
        { tool: "devtools_request_detail", input: { requestId: "<request-id>" }, why: "Inspect headers, cookies, timing, initiator, and body availability." },
      ],
    },
    "request-replay": {
      title: "Request replay variants",
      goal: "Replay an observed browser request with bounded variants and compare responses.",
      steps: [
        { tool: "agent_inspect", input: { focus: "network", limit: 20 }, why: "Pick a requestId from captured traffic." },
        { tool: "devtools_request_replay_batch", input: { requestId: "<request-id>", variants: [{ label: "baseline" }] }, why: "Run variants and compare status, headers, and body previews." },
      ],
      boundary: "Replay evidence is not a vulnerability verdict; the agent or human must judge authorization and impact.",
    },
    "auth-boundary": {
      title: "Authentication boundary evidence",
      goal: "Collect cookies, auth headers, storage tokens, credentialed requests, and page security context.",
      steps: [
        { tool: "devtools_auth_boundary_report", input: { includeTokenScan: true, save: true }, why: "Collect objective auth-related evidence." },
        { tool: "devtools_cookie_summary", why: "Inspect cookie attributes and objective attribute signals." },
        { tool: "devtools_token_scan", why: "Search authorized browser evidence for token-like material." },
      ],
    },
    "before-after-diff": {
      title: "Before/after evidence diff",
      goal: "Compare evidence before and after login, role switch, account switch, or permission change.",
      steps: [
        { tool: "devtools_evidence_bundle", input: { save: true }, why: "Save the before snapshot." },
        { tool: "devtools_capture_start", input: { clear: true, label: "after-action" }, why: "Record the action window." },
        { tool: "devtools_capture_diff", input: { beforePath: "<before-bundle-path>", save: true }, why: "Compare before snapshot to current captured traffic." },
      ],
    },
    "source-debug": {
      title: "Sources and debugger drill-down",
      goal: "Find relevant scripts, read source, and pause around runtime behavior.",
      steps: [
        { tool: "agent_inspect", input: { focus: "sources", query: "<marker>" }, why: "List and search parsed scripts." },
        { tool: "devtools_source_get", input: { scriptId: "<script-id>" }, why: "Read exact script source." },
        { tool: "devtools_debugger_control", input: { action: "setBreakpointByUrl" }, why: "Use live runtime state when source text is insufficient." },
      ],
    },
    performance: {
      title: "Performance and trace drill-down",
      goal: "Capture objective timing, observer, CPU, coverage, and trace evidence.",
      steps: [
        { tool: "agent_inspect", input: { focus: "performance" }, why: "Start with lightweight performance evidence." },
        { tool: "devtools_chrome_trace", input: { durationMs: 1000 }, why: "Capture a bounded trace around the smallest reproducible action." },
        { tool: "devtools_trace_query", input: { tracePath: "<trace-path>", minDurationMs: 5 }, why: "Search saved trace events." },
      ],
    },
  };
  const recipe = recipes[key] || recipes["first-pass"];
  return {
    task: key,
    ...recipe,
    availableTasks: Object.keys(recipes),
    boundaries: [
      "Workflow guide is a deterministic recipe, not model reasoning.",
      "Tools return evidence; the agent or human decides interpretation.",
    ],
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
  const includeFrames = options.includeFrames !== false;
  const seen = new Set();
  const results = [];
  const frameErrors = [];
  function push(element, source, frame = null) {
    if (!element || element.nodeType !== 1 || seen.has(element) || results.length >= maxResults) return;
    seen.add(element);
    const outerHTML = String(element.outerHTML || "");
    results.push({
      source,
      frame,
      nodeType: element.nodeType,
      nodeName: element.nodeName,
      localName: element.localName,
      attributes: Object.fromEntries([...element.attributes].map((attr) => [attr.name, attr.value])),
      text: String(element.textContent || "").trim().slice(0, 300),
      outerHTML: outerHTML.slice(0, maxOuterHTMLChars),
      outerHTMLTruncated: outerHTML.length > maxOuterHTMLChars,
    });
  }
  function frameInfo(win, path) {
    try {
      return {
        path,
        url: win.location.href,
        origin: win.location.origin,
        title: win.document?.title || "",
      };
    } catch (error) {
      return { path, inaccessible: true, error: String(error?.message || error) };
    }
  }
  function searchDocument(doc, frame) {
    if (!doc?.documentElement || results.length >= maxResults) return;
    try {
      doc.querySelectorAll(query).forEach((element) => push(element, "querySelectorAll", frame));
    } catch {
      // Not a CSS selector; text and XPath passes below can still match.
    }
    try {
      const xpath = doc.evaluate(query, doc, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
      let node = xpath.iterateNext();
      while (node && results.length < maxResults) {
        push(node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement, "xpath", frame);
        node = xpath.iterateNext();
      }
    } catch {
      // Not an XPath expression.
    }
    const needle = query.toLowerCase();
    if (needle) {
      const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_ELEMENT);
      let node = walker.currentNode;
      while (node && results.length < maxResults) {
        const haystack = `${node.id || ""} ${node.className || ""} ${node.getAttribute?.("name") || ""} ${node.getAttribute?.("aria-label") || ""} ${node.textContent || ""} ${node.outerHTML || ""}`.toLowerCase();
        if (haystack.includes(needle)) push(node, "text", frame);
        node = walker.nextNode();
      }
    }
    if (includeFrames) {
      const frames = Array.from(doc.querySelectorAll("iframe,frame"));
      frames.forEach((frameElement, index) => {
        if (results.length >= maxResults) return;
        try {
          const childWindow = frameElement.contentWindow;
          const childDocument = frameElement.contentDocument || childWindow?.document;
          if (!childDocument) return;
          searchDocument(childDocument, frameInfo(childWindow, `${frame?.path || "top"} > frame[${index}]`));
        } catch (error) {
          frameErrors.push({
            path: `${frame?.path || "top"} > frame[${index}]`,
            src: frameElement.getAttribute("src") || frameElement.getAttribute("srcdoc") || "",
            error: String(error?.message || error),
          });
        }
      });
    }
  }
  searchDocument(document, frameInfo(window, "top"));
  return {
    query,
    returnedCount: results.length,
    includeFrames,
    frameErrors,
    results,
  };
}

function normalizeForcedPseudoClasses(value) {
  const allowed = new Set(["active", "focus", "focus-within", "focus-visible", "hover", "target", "visited"]);
  const raw = Array.isArray(value) ? value : (value ? [value] : []);
  const requested = raw.map((entry) => String(entry || "").replace(/^:/, "").trim()).filter(Boolean);
  const forced = [...new Set(requested.filter((entry) => allowed.has(entry)))];
  const skipped = requested.filter((entry) => !allowed.has(entry));
  return { forced, skipped };
}

function frameIndexesFromOptions(options = {}) {
  if (Array.isArray(options.frameIndexes)) return options.frameIndexes.map((entry) => Number(entry)).filter(Number.isInteger);
  const path = String(options.framePath || "");
  return [...path.matchAll(/frame\[(\d+)\]/g)].map((match) => Number(match[1])).filter(Number.isInteger);
}

function selectInFramePageFunction(options) {
  const selector = String(options.selector || "document");
  const text = String(options.text || "");
  const frameIndexes = Array.isArray(options.frameIndexes) ? options.frameIndexes : [];
  let doc = document;
  for (const index of frameIndexes) {
    const frames = Array.from(doc.querySelectorAll("iframe,frame"));
    const frame = frames[index];
    if (!frame) return null;
    doc = frame.contentDocument || frame.contentWindow?.document;
    if (!doc) return null;
  }
  if (selector === "document") return doc;
  if (selector) return doc.querySelector(selector);
  const wanted = text.toLowerCase();
  return Array.from(doc.querySelectorAll("button,a,input,textarea,[role=button],label,summary"))
    .find((node) => (node.innerText || node.value || node.getAttribute("aria-label") || "").toLowerCase().includes(wanted)) || null;
}

function clickInFramePageFunction(options) {
  const el = selectInFramePageFunction(options);
  if (!el) return { ok: false, error: options.selector ? "selector_not_found" : "text_not_found", framePath: options.framePath || null };
  el.scrollIntoView({ block: "center", inline: "center" });
  el.click();
  return { ok: true, mode: options.selector ? "selector" : "text", framePath: options.framePath || null };
}

function typeInFramePageFunction(options) {
  const el = selectInFramePageFunction(options);
  if (!el) return { ok: false, error: "selector_not_found", framePath: options.framePath || null };
  el.scrollIntoView({ block: "center", inline: "center" });
  el.focus();
  if (options.clear !== false) el.value = "";
  el.value = (el.value || "") + String(options.text || "");
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, framePath: options.framePath || null };
}

function styleInFramePageFunction(options) {
  const el = selectInFramePageFunction(options);
  if (!el || el.nodeType !== 1) return { found: false, error: "selector_not_found", framePath: options.framePath || null };
  const computed = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const computedStyle = Array.from(computed).map((name) => ({ name, value: computed.getPropertyValue(name) }));
  return {
    found: true,
    source: "runtime-frame-fallback",
    framePath: options.framePath || null,
    selector: options.selector,
    nodeName: el.nodeName,
    localName: el.localName,
    text: String(el.textContent || "").trim().slice(0, 500),
    outerHTML: String(el.outerHTML || "").slice(0, options.maxOuterHTMLChars || 4000),
    computedStyle: { computedStyle },
    boxModel: {
      model: {
        content: [rect.left, rect.top, rect.right, rect.top, rect.right, rect.bottom, rect.left, rect.bottom],
        border: [rect.left, rect.top, rect.right, rect.top, rect.right, rect.bottom, rect.left, rect.bottom],
        padding: [rect.left, rect.top, rect.right, rect.top, rect.right, rect.bottom, rect.left, rect.bottom],
        margin: [rect.left, rect.top, rect.right, rect.top, rect.right, rect.bottom, rect.left, rect.bottom],
        width: rect.width,
        height: rect.height,
      },
    },
  };
}

function frameAccessPageFunction() {
  const rows = [];
  function visit(doc, path) {
    const frames = Array.from(doc.querySelectorAll("iframe,frame"));
    frames.forEach((frame, index) => {
      const childPath = `${path} > frame[${index}]`;
      const row = {
        path: childPath,
        tagName: frame.tagName,
        id: frame.id || null,
        name: frame.getAttribute("name") || null,
        src: frame.getAttribute("src") || frame.getAttribute("srcdoc") || "",
        sandbox: frame.getAttribute("sandbox") || null,
        accessible: false,
      };
      try {
        const childWindow = frame.contentWindow;
        const childDocument = frame.contentDocument || childWindow?.document;
        row.url = childWindow?.location?.href || "";
        row.origin = childWindow?.location?.origin || "";
        row.title = childDocument?.title || "";
        row.accessible = Boolean(childDocument?.documentElement);
        if (row.accessible) visit(childDocument, childPath);
      } catch (error) {
        row.error = String(error?.message || error);
      }
      rows.push(row);
    });
  }
  visit(document, "top");
  return rows;
}

function tokenFlowTracePageFunction(options) {
  const durationMs = Math.max(50, Number(options.durationMs || 1000));
  const maxEvents = Math.max(1, Number(options.maxEvents || 100));
  const includeValues = options.includeValues !== false;
  const triggerExpression = String(options.triggerExpression || "");
  const tokenPatterns = [
    /bearer\s+[a-z0-9._~+/=-]{8,}/i,
    /(?:token|secret|session|jwt|auth|api[_-]?key)[a-z0-9_.:/?&=%+\-\s]{0,40}[=:]\s*[a-z0-9._~+/=-]{8,}/i,
    /eyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}/,
    /sk-[a-zA-Z0-9_-]{16,}/,
  ];
  const events = [];
  const originals = {
    fetch: window.fetch,
    xhrOpen: XMLHttpRequest.prototype.open,
    xhrSetRequestHeader: XMLHttpRequest.prototype.setRequestHeader,
    xhrSend: XMLHttpRequest.prototype.send,
    localSet: Storage.prototype.setItem,
    localGet: Storage.prototype.getItem,
    cookie: Object.getOwnPropertyDescriptor(Document.prototype, "cookie") || Object.getOwnPropertyDescriptor(HTMLDocument.prototype, "cookie"),
  };
  const now = () => new Date().toISOString();
  const safeString = (value) => {
    try {
      if (typeof value === "string") return value;
      if (value instanceof Headers) return JSON.stringify(Object.fromEntries(value.entries()));
      if (value && typeof value === "object") return JSON.stringify(value);
      return String(value ?? "");
    } catch {
      return String(value ?? "");
    }
  };
  const tokenHits = (parts) => {
    const text = parts.map(safeString).join(" ");
    return tokenPatterns
      .map((pattern) => text.match(pattern)?.[0])
      .filter(Boolean);
  };
  const push = (event) => {
    if (events.length >= maxEvents) return;
    const hits = tokenHits([event.value, event.key, event.url, event.headers, event.body]);
    events.push({
      at: now(),
      tokenLike: hits.length > 0,
      tokenHits: includeValues ? hits : hits.map((hit) => ({ length: hit.length })),
      ...event,
      ...(includeValues ? {} : {
        value: event.value ? { length: safeString(event.value).length } : undefined,
        body: event.body ? { length: safeString(event.body).length } : undefined,
        headers: event.headers ? { length: safeString(event.headers).length } : undefined,
      }),
    });
  };
  const readHeaders = (headers) => {
    try {
      if (!headers) return {};
      if (headers instanceof Headers) return Object.fromEntries(headers.entries());
      if (Array.isArray(headers)) return Object.fromEntries(headers);
      if (typeof headers === "object") return { ...headers };
      return headers;
    } catch {
      return {};
    }
  };
  window.fetch = async function agentTokenFlowFetch(input, init = {}) {
    const url = typeof input === "string" ? input : input?.url;
    const headers = readHeaders(init?.headers || input?.headers);
    push({ api: "fetch", phase: "request", url, method: init?.method || input?.method || "GET", headers, body: init?.body || null });
    const response = await originals.fetch.apply(this, arguments);
    try {
      const clone = response.clone();
      const text = await clone.text();
      push({ api: "fetch", phase: "response", url: response.url || url, status: response.status, value: text.slice(0, options.maxValueChars || 4000) });
    } catch (error) {
      push({ api: "fetch", phase: "response-body-error", url: response.url || url, status: response.status, error: String(error?.message || error) });
    }
    return response;
  };
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__agentTokenFlow = { method, url, headers: {} };
    return originals.xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    this.__agentTokenFlow = this.__agentTokenFlow || { headers: {} };
    this.__agentTokenFlow.headers[name] = value;
    return originals.xhrSetRequestHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    const meta = this.__agentTokenFlow || {};
    push({ api: "XMLHttpRequest", phase: "request", url: meta.url, method: meta.method, headers: meta.headers, body });
    this.addEventListener("loadend", () => {
      push({ api: "XMLHttpRequest", phase: "response", url: meta.url, status: this.status, value: String(this.responseText || "").slice(0, options.maxValueChars || 4000) });
    });
    return originals.xhrSend.apply(this, arguments);
  };
  Storage.prototype.setItem = function(key, value) {
    const area = this === localStorage ? "localStorage" : this === sessionStorage ? "sessionStorage" : "Storage";
    push({ api: area, phase: "setItem", key, value });
    return originals.localSet.apply(this, arguments);
  };
  Storage.prototype.getItem = function(key) {
    const value = originals.localGet.apply(this, arguments);
    const area = this === localStorage ? "localStorage" : this === sessionStorage ? "sessionStorage" : "Storage";
    push({ api: area, phase: "getItem", key, value });
    return value;
  };
  if (originals.cookie?.get && originals.cookie?.set) {
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get() {
        const value = originals.cookie.get.call(document);
        push({ api: "document.cookie", phase: "get", value });
        return value;
      },
      set(value) {
        push({ api: "document.cookie", phase: "set", value });
        return originals.cookie.set.call(document, value);
      },
    });
  }
  const restore = () => {
    window.fetch = originals.fetch;
    XMLHttpRequest.prototype.open = originals.xhrOpen;
    XMLHttpRequest.prototype.setRequestHeader = originals.xhrSetRequestHeader;
    XMLHttpRequest.prototype.send = originals.xhrSend;
    Storage.prototype.setItem = originals.localSet;
    Storage.prototype.getItem = originals.localGet;
    if (originals.cookie) {
      Object.defineProperty(document, "cookie", originals.cookie);
    }
  };
  return new Promise((resolve) => {
    let triggerResult = null;
    let triggerError = null;
    Promise.resolve()
      .then(() => triggerExpression ? Function(triggerExpression)() : null)
      .then((value) => { triggerResult = value; })
      .catch((error) => { triggerError = String(error?.message || error); });
    setTimeout(() => {
      restore();
      resolve({
        url: location.href,
        durationMs,
        eventCount: events.length,
        tokenLikeEventCount: events.filter((event) => event.tokenLike).length,
        events,
        triggerResult,
        triggerError,
      });
    }, durationMs);
  });
}

async function resolveNodeIdForSelector(client, selector, options = {}) {
  const frameIndexes = frameIndexesFromOptions(options);
  const searchNode = async () => {
    const search = await client.DOM.performSearch({ query: selector, includeUserAgentShadowDOM: true }).catch(() => null);
    const count = Number(search?.resultCount || 0);
    if (!search?.searchId || count <= 0) return null;
    const ids = await client.DOM.getSearchResults({ searchId: search.searchId, fromIndex: 0, toIndex: Math.min(count, 5) }).catch(() => ({ nodeIds: [] }));
    await client.DOM.discardSearchResults({ searchId: search.searchId }).catch(() => {});
    return (ids.nodeIds || []).find((nodeId) => nodeId) || null;
  };
  if (!frameIndexes.length) {
    const documentNode = await client.DOM.getDocument({ depth: -1, pierce: true });
    const query = await client.DOM.querySelector({ nodeId: documentNode.root.nodeId, selector });
    return { nodeId: query.nodeId || null, frameIndexes, via: "dom-query-selector" };
  }
  const objectGroup = "agent-browser-runtime-frame-selector";
  const evaluated = await client.Runtime.evaluate({
    expression: `(${selectInFramePageFunction.toString()})(${JSON.stringify({ selector, frameIndexes })})`,
    objectGroup,
    returnByValue: false,
    awaitPromise: true,
  });
  const objectId = evaluated.result?.objectId;
  if (!objectId || evaluated.result?.subtype === "null") {
    await client.Runtime.releaseObjectGroup({ objectGroup }).catch(() => {});
    return { nodeId: null, frameIndexes, via: "runtime-frame-selector", exception: evaluated.exceptionDetails || null };
  }
  const node = await client.DOM.requestNode({ objectId }).catch((error) => ({ error: String(error?.message || error), nodeId: null }));
  await client.Runtime.releaseObjectGroup({ objectGroup }).catch(() => {});
  const fallbackNodeId = node.nodeId ? null : await searchNode();
  return { nodeId: node.nodeId || fallbackNodeId || null, frameIndexes, via: node.nodeId ? "runtime-frame-selector" : "dom-search-fallback", error: node.error || null };
}

async function debuggerScopePreview(client, scopeChain = [], maxScopes = 5, maxProperties = 20) {
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
        const properties = await client.Runtime.getProperties({
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

async function debuggerPausedSummary(client, event, options = {}) {
  if (!event) return null;
  const maxFrames = typeof options.maxFrames === "number" ? options.maxFrames : 10;
  const maxScopes = typeof options.maxScopes === "number" ? options.maxScopes : 5;
  const maxProperties = typeof options.maxProperties === "number" ? options.maxProperties : 20;
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
      scopeChain: await debuggerScopePreview(client, frame.scopeChain || [], maxScopes, maxProperties),
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
  const removed = [];
  const skipped = [];
  for (const [key, value] of Object.entries({ ...rawHeaders, ...overrides })) {
    const lower = String(key).toLowerCase();
    if (value === null || value === undefined || value === false) {
      removed.push(key);
      continue;
    }
    if (forbidden.has(lower) || lower.startsWith("sec-ch-")) {
      skipped.push({
        name: key,
        reason: lower.startsWith("sec-ch-") ? "client-hint-forbidden-in-fetch" : "forbidden-fetch-header",
      });
      continue;
    }
    headers[key] = String(value);
  }
  return { headers, skipped, removed };
}

function headerHas(headers, name) {
  const lower = String(name).toLowerCase();
  return Object.keys(headers || {}).some((key) => String(key).toLowerCase() === lower);
}

function setHeaderIfMissing(headers, name, value) {
  if (!headerHas(headers, name)) headers[name] = value;
}

function buildReplayBody(params = {}, request = {}, headers = {}) {
  if (params.multipart && typeof params.multipart === "object") {
    for (const key of Object.keys(headers)) {
      if (String(key).toLowerCase() === "content-type") delete headers[key];
    }
    return {
      bodyKind: "multipart",
      body: {
        fields: params.multipart.fields || params.multipart,
        files: Array.isArray(params.multipart.files) ? params.multipart.files : [],
      },
      bodyLength: JSON.stringify(params.multipart).length,
      contentTypeNote: "Content-Type removed so the browser can generate the multipart boundary.",
    };
  }
  if (params.form && typeof params.form === "object") {
    setHeaderIfMissing(headers, "Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
    const body = new URLSearchParams(Object.entries(params.form).map(([key, value]) => [key, String(value)])).toString();
    return { bodyKind: "form", body, bodyLength: body.length };
  }
  if (params.json !== undefined) {
    setHeaderIfMissing(headers, "Content-Type", "application/json");
    const body = JSON.stringify(params.json);
    return { bodyKind: "json", body, bodyLength: body.length };
  }
  const body = params.body !== undefined ? String(params.body) : request.postData;
  return {
    bodyKind: body === undefined ? "none" : "raw",
    body,
    bodyLength: body === undefined ? 0 : String(body).length,
  };
}

function headerMapLower(headers = {}) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    out[String(name).toLowerCase()] = String(value);
  }
  return out;
}

function diffReplayResponse(originalRequest = {}, response = {}, maxBodyPreview = 500) {
  const originalHeaders = headerMapLower(originalRequest.responseHeaders || {});
  const replayHeaders = headerMapLower(response.headers || {});
  const headerNames = new Set([...Object.keys(originalHeaders), ...Object.keys(replayHeaders)]);
  const headerDiff = [];
  for (const name of [...headerNames].sort()) {
    if (originalHeaders[name] !== replayHeaders[name]) {
      headerDiff.push({ name, original: originalHeaders[name], replay: replayHeaders[name] });
    }
  }
  const originalBody = typeof originalRequest.bodyText === "string" ? originalRequest.bodyText : null;
  const replayBody = typeof response.bodyText === "string" ? response.bodyText : null;
  const bodyComparable = originalBody !== null && replayBody !== null;
  const originalLength = originalBody === null ? (originalRequest.bodyBytes ?? originalRequest.encodedDataLength ?? null) : originalBody.length;
  const replayLength = replayBody === null ? (response.bodyBytes ?? null) : replayBody.length;
  return {
    originalStatus: originalRequest.status ?? null,
    replayStatus: response.status ?? null,
    statusChanged: (originalRequest.status ?? null) !== (response.status ?? null),
    originalUrl: originalRequest.url || null,
    replayUrl: response.url || null,
    urlChanged: Boolean(originalRequest.url && response.url && originalRequest.url !== response.url),
    redirectedChanged: Boolean(response.redirected) !== Boolean(originalRequest.redirected),
    headerChangedCount: headerDiff.length,
    headerDiff: headerDiff.slice(0, 50),
    bodyComparable,
    bodyChanged: bodyComparable ? originalBody !== replayBody : null,
    originalBodyLength: originalLength,
    replayBodyLength: replayLength,
    bodyLengthDelta: typeof originalLength === "number" && typeof replayLength === "number" ? replayLength - originalLength : null,
    originalBodyPreview: originalBody === null ? null : originalBody.slice(0, maxBodyPreview),
    replayBodyPreview: replayBody === null ? null : replayBody.slice(0, maxBodyPreview),
  };
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

  function eventSourceFile(name) {
    return join(profileDir(name), "traffic", "eventsource.jsonl");
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

  function appendEventSources(raw, entries) {
    const name = normalizeProfileName(raw);
    const file = eventSourceFile(name);
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

  function readEventSources(raw) {
    const name = normalizeProfileName(raw);
    const file = eventSourceFile(name);
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
    appendEventSources,
    appendEvent,
    writeBody,
    queryTraffic,
    getTraffic,
    readWebSockets,
    readEventSources,
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
    const eventSources = [];
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
    client.Network.eventSourceMessageReceived((event) => {
      eventSources.push({
        timestamp: new Date().toISOString(),
        requestId: event.requestId,
        eventName: event.eventName,
        eventId: event.eventId,
        data: event.data,
        dataLength: event.data ? String(event.data).length : 0,
      });
    });
    const result = await action();
    await sleep(waitMs);
    const rows = [...entries.values()].filter((entry) => entry.url);
    const websocketRows = [...websockets.values()];
    const eventSourceRows = [...eventSources];
    const capture = profileRegistry.getCapture(profileName);
    const trafficFile = capture.enabled ? profileRegistry.appendTraffic(profileName, rows) : null;
    const websocketFile = capture.enabled && websocketRows.length ? profileRegistry.appendWebSockets(profileName, websocketRows) : null;
    const eventSourceFile = capture.enabled && eventSourceRows.length ? profileRegistry.appendEventSources(profileName, eventSourceRows) : null;
    return {
      result,
      observedTraffic: rows.length,
      observedWebSockets: websocketRows.length,
      observedEventSourceMessages: eventSourceRows.length,
      recordedTraffic: capture.enabled ? rows.length : 0,
      capturedTraffic: capture.enabled ? rows.length : 0,
      captureEnabled: capture.enabled,
      trafficFile,
      websocketFile,
      eventSourceFile,
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
        removeHeaders: { type: "array", items: { type: "string" } },
        body: { type: "string" },
        json: {},
        form: { type: "object" },
        multipart: { type: "object" },
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
      const removeHeaders = Array.isArray(params?.removeHeaders) ? Object.fromEntries(params.removeHeaders.map((name) => [name, null])) : {};
      const headerPrep = prepareReplayHeaders(request.requestHeaders || {}, { ...removeHeaders, ...(params?.headers || {}) });
      const bodyPrep = buildReplayBody(params || {}, request, headerPrep.headers);
      const includeBody = !["GET", "HEAD"].includes(method) && bodyPrep.bodyKind !== "none";
      return toolResult(await withPageClient(cdpPort, profile.tabId, async (client, target) => {
        const result = await client.Runtime.evaluate({
          expression: `(async () => {
            const replay = ${JSON.stringify({
              url,
              method,
              headers: headerPrep.headers,
              body: bodyPrep.body,
              bodyKind: bodyPrep.bodyKind,
              includeBody,
              credentials: params?.credentials || "include",
            })};
            function buildBody(replay) {
              if (!replay.includeBody) return undefined;
              if (replay.bodyKind === "multipart") {
                const form = new FormData();
                for (const [key, value] of Object.entries(replay.body.fields || {})) {
                  if (Array.isArray(value)) {
                    for (const item of value) form.append(key, String(item));
                  } else {
                    form.append(key, String(value));
                  }
                }
                for (const file of replay.body.files || []) {
                  const blob = new Blob([file.content || ""], { type: file.type || "application/octet-stream" });
                  form.append(file.field || "file", blob, file.filename || "upload.bin");
                }
                return form;
              }
              return replay.body;
            }
            const startedAt = new Date().toISOString();
            const response = await fetch(replay.url, {
              method: replay.method,
              headers: replay.headers,
              credentials: replay.credentials,
              cache: "no-store",
              redirect: "follow",
              ...(replay.includeBody ? { body: buildBody(replay) } : {}),
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
            bodyKind: bodyPrep.bodyKind,
            skippedHeaders: headerPrep.skipped,
            removedHeaders: headerPrep.removed,
            skippedHeaderNames: headerPrep.skipped.map((entry) => entry.name),
            bodyLength: includeBody ? bodyPrep.bodyLength : 0,
            contentTypeNote: bodyPrep.contentTypeNote || null,
            credentials: params?.credentials || "include",
          },
          response: result.result?.value,
          responseDiff: result.result?.value ? diffReplayResponse(request, result.result.value, params?.maxBodyPreview) : null,
          exception: result.exceptionDetails,
        };
      }));
    },
  });

  tools.set("profile_request_replay_batch", {
    name: "profile_request_replay_batch",
    description: "Replay one captured managed browser request through multiple variants and return response diffs for edit-and-resend security testing.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        requestId: { type: "string" },
        variants: { type: "array", items: { type: "object" } },
        maxVariants: { type: "number" },
        maxBodyPreview: { type: "number" },
      },
      required: ["requestId", "variants"],
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const request = profileRegistry.getTraffic(profile.name, params?.requestId);
      if (!request) throw new Error(`request not found: ${params?.requestId}`);
      const variants = Array.isArray(params?.variants) ? params.variants.slice(0, Math.max(1, Math.min(50, Number(params?.maxVariants || params.variants.length)))) : [];
      if (!variants.length) throw new Error("variants must contain at least one replay variant");
      return toolResult(await withPageClient(cdpPort, profile.tabId, async (client, target) => {
        const results = [];
        for (let index = 0; index < variants.length; index += 1) {
          const variant = variants[index] || {};
          const url = variant.url || request.url;
          const method = String(variant.method || request.method || "GET").toUpperCase();
          const removeHeaders = Array.isArray(variant.removeHeaders) ? Object.fromEntries(variant.removeHeaders.map((name) => [name, null])) : {};
          const headerPrep = prepareReplayHeaders(request.requestHeaders || {}, { ...removeHeaders, ...(variant.headers || {}) });
          const bodyPrep = buildReplayBody(variant, request, headerPrep.headers);
          const includeBody = !["GET", "HEAD"].includes(method) && bodyPrep.bodyKind !== "none";
          const result = await client.Runtime.evaluate({
            expression: `(async () => {
              const replay = ${JSON.stringify({
                url,
                method,
                headers: headerPrep.headers,
                body: bodyPrep.body,
                bodyKind: bodyPrep.bodyKind,
                includeBody,
                credentials: variant.credentials || params?.credentials || "include",
              })};
              function buildBody(replay) {
                if (!replay.includeBody) return undefined;
                if (replay.bodyKind === "multipart") {
                  const form = new FormData();
                  for (const [key, value] of Object.entries(replay.body.fields || {})) {
                    if (Array.isArray(value)) {
                      for (const item of value) form.append(key, String(item));
                    } else {
                      form.append(key, String(value));
                    }
                  }
                  for (const file of replay.body.files || []) {
                    const blob = new Blob([file.content || ""], { type: file.type || "application/octet-stream" });
                    form.append(file.field || "file", blob, file.filename || "upload.bin");
                  }
                  return form;
                }
                return replay.body;
              }
              const startedAt = new Date().toISOString();
              const response = await fetch(replay.url, {
                method: replay.method,
                headers: replay.headers,
                credentials: replay.credentials,
                cache: "no-store",
                redirect: "follow",
                ...(replay.includeBody ? { body: buildBody(replay) } : {}),
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
          const response = result.result?.value || null;
          results.push({
            index,
            label: variant.label || `variant-${index + 1}`,
            replayRequest: {
              url,
              method,
              headers: headerPrep.headers,
              bodyKind: bodyPrep.bodyKind,
              skippedHeaders: headerPrep.skipped,
              removedHeaders: headerPrep.removed,
              skippedHeaderNames: headerPrep.skipped.map((entry) => entry.name),
              bodyLength: includeBody ? bodyPrep.bodyLength : 0,
              contentTypeNote: bodyPrep.contentTypeNote || null,
              credentials: variant.credentials || params?.credentials || "include",
            },
            response,
            responseDiff: response ? diffReplayResponse(request, response, params?.maxBodyPreview) : null,
            exception: result.exceptionDetails,
          });
        }
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          originalRequest: request,
          variantCount: results.length,
          results,
        };
      }));
    },
  });

  tools.set("profile_realtime_log", {
    name: "profile_realtime_log",
    description: "Return F12 Network real-time channel evidence: WebSocket lifecycle/frames and EventSource/SSE messages.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        requestId: { type: "string" },
        url_contains: { type: "string" },
        direction: { type: "string" },
        limit: { type: "number" },
        maxPayloadChars: { type: "number" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const limit = typeof params?.limit === "number" ? params.limit : 100;
      const maxPayloadChars = typeof params?.maxPayloadChars === "number" ? params.maxPayloadChars : 2000;
      const needle = params?.url_contains ? String(params.url_contains).toLowerCase() : null;
      const requestedId = params?.requestId ? String(params.requestId) : null;
      const direction = params?.direction ? String(params.direction).toLowerCase() : null;
      const truncatePayload = (value) => {
        if (typeof value !== "string") return value ?? null;
        return value.length > maxPayloadChars ? `${value.slice(0, maxPayloadChars)}...[truncated ${value.length - maxPayloadChars} chars]` : value;
      };
      let websockets = profileRegistry.readWebSockets(profile.name);
      if (requestedId) websockets = websockets.filter((socket) => String(socket.requestId) === requestedId);
      if (needle) websockets = websockets.filter((socket) => String(socket.url || "").toLowerCase().includes(needle));
      websockets = websockets.slice(-limit).map((socket) => {
        const frames = (socket.frames || [])
          .filter((frame) => !direction || String(frame.direction || "").toLowerCase() === direction)
          .slice(-limit)
          .map((frame) => ({
            ...frame,
            payloadData: truncatePayload(frame.payloadData),
            truncated: typeof frame.payloadData === "string" && frame.payloadData.length > maxPayloadChars,
          }));
        return {
          requestId: socket.requestId,
          url: socket.url,
          status: socket.status,
          statusText: socket.statusText,
          requestHeaders: socket.requestHeaders,
          responseHeaders: socket.responseHeaders,
          createdAt: socket.createdAt,
          updatedAt: socket.updatedAt,
          closedAt: socket.closedAt,
          errorMessage: socket.errorMessage,
          frameCount: socket.frames?.length || 0,
          returnedFrameCount: frames.length,
          frames,
        };
      });
      let eventSources = profileRegistry.readEventSources(profile.name);
      if (requestedId) eventSources = eventSources.filter((entry) => String(entry.requestId) === requestedId);
      eventSources = eventSources.slice(-limit).map((entry) => ({
        ...entry,
        data: truncatePayload(entry.data),
        truncated: typeof entry.data === "string" && entry.data.length > maxPayloadChars,
      }));
      return toolResult({
        backend: "managed-cdp",
        profile: profile.name,
        evidenceDir: profile.evidenceDir,
        capture: profileRegistry.getCapture(profile.name),
        websocketCount: websockets.length,
        eventSourceMessageCount: eventSources.length,
        websockets,
        eventSources,
      });
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
        includeBodies: { type: "boolean" },
        maxBodyBytes: { type: "number" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const rows = profileRegistry.queryTraffic(profile.name, { limit: typeof params?.limit === "number" ? params.limit : 1000 });
      const includeBodies = params?.includeBodies === true;
      const maxBodyBytes = typeof params?.maxBodyBytes === "number" ? params.maxBodyBytes : 200000;
      const responseContent = (request) => {
        const content = {
          size: request.encodedDataLength ?? request.bodyBytes ?? -1,
          mimeType: request.mimeType || "",
        };
        if (!includeBodies) return content;
        if (typeof request.bodyText === "string") {
          const text = request.bodyText.slice(0, maxBodyBytes);
          return {
            ...content,
            text,
            _bodyIncluded: true,
            _bodyTruncated: Buffer.byteLength(request.bodyText, "utf8") > maxBodyBytes,
          };
        }
        if (request.bodyPath) {
          try {
            const body = readFileSync(request.bodyPath);
            const limited = body.subarray(0, maxBodyBytes);
            return {
              ...content,
              text: limited.toString("base64"),
              encoding: "base64",
              _bodyIncluded: true,
              _bodyPath: request.bodyPath,
              _bodyTruncated: body.length > maxBodyBytes,
            };
          } catch (error) {
            return {
              ...content,
              _bodyIncluded: false,
              _bodyError: String(error?.message || error),
            };
          }
        }
        return {
          ...content,
          _bodyIncluded: false,
          _bodyUnavailable: true,
        };
      };
      const entries = rows.map((request) => {
        const timelineRow = buildNetworkTimeline([request], 1)[0] || {};
        return {
        startedDateTime: request.timestamp,
        time: timelineRow.durationMs ?? -1,
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
          content: responseContent(request),
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
        _initiatorSummary: buildInitiatorSummary(request.initiator || null),
        _timingPhases: timelineRow.phases || null,
        _durationMs: timelineRow.durationMs ?? null,
        _timingSource: request.timing ? "cdp-network-timing" : "wall-clock-capture",
        _securityDetails: request.securityDetails,
        _bodyReadable: Boolean(request.bodyReadable || request.bodyText || request.bodyPath),
      };
      });
      return toolResult({
        profile: profile.name,
        includeBodies,
        maxBodyBytes,
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
        includeBodies: { type: "boolean" },
        maxBodyBytes: { type: "number" },
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
        framePath: { type: "string" },
        frameIndexes: { type: "array", items: { type: "number" } },
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
        const frameIndexes = frameIndexesFromOptions(params);
        const actionOptions = {
          selector: params?.selector ? String(params.selector) : "",
          text: String(params?.text || ""),
          framePath: params?.framePath || null,
          frameIndexes,
        };
        const expression = `(() => { const selectInFramePageFunction = ${selectInFramePageFunction.toString()}; const clickInFramePageFunction = ${clickInFramePageFunction.toString()}; return clickInFramePageFunction(${JSON.stringify(actionOptions)}); })()`;
        const capture = await runProfileAction({
          client,
          profile,
          eventType: "browser_click",
          waitMs: typeof params?.waitMs === "number" ? params.waitMs : 700,
          event: { tabId: target.id, mode: params?.selector ? "selector" : "text", selector: params?.selector, text: params?.text, framePath: params?.framePath, frameIndexes },
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
        framePath: { type: "string" },
        frameIndexes: { type: "array", items: { type: "number" } },
        tabId: { type: "string" },
      },
      required: ["selector", "text"],
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        const frameIndexes = frameIndexesFromOptions(params);
        const typeOptions = {
          selector: String(params.selector || ""),
          text: String(params.text || ""),
          clear: params.clear !== false,
          framePath: params?.framePath || null,
          frameIndexes,
        };
        const expression = `(() => { const selectInFramePageFunction = ${selectInFramePageFunction.toString()}; const typeInFramePageFunction = ${typeInFramePageFunction.toString()}; return typeInFramePageFunction(${JSON.stringify(typeOptions)}); })()`;
        const capture = await runProfileAction({
          client,
          profile,
          eventType: "browser_type",
          waitMs: typeof params?.waitMs === "number" ? params.waitMs : 700,
          event: { tabId: target.id, selector: params.selector, textLength: String(params.text || "").length, pressEnter: Boolean(params.pressEnter), framePath: params?.framePath, frameIndexes },
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
        const access = await client.Runtime.evaluate({
          expression: `(${frameAccessPageFunction.toString()})()`,
          returnByValue: true,
          awaitPromise: true,
        }).catch((error) => ({ error: String(error?.message || error) }));
        const frameAccess = access.error ? [] : access.result?.value || [];
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          frameTree: tree.frameTree,
          frameAccess,
          inaccessibleFrameCount: frameAccess.filter((frame) => frame.accessible === false).length,
          frameAccessError: access.error || null,
        };
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

  tools.set("browser_signal_summary", {
    name: "browser_signal_summary",
    description: "Return objective cross-panel browser signals across Network, Cookies, Storage, Service Workers, Security, and optional token scan. This does not decide vulnerability impact.",
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
      const summary = buildSignalSummary({
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
          let storageKeyError = null;
          try {
            storageKey = (await client.Storage.getStorageKeyForFrame({ frameId: frame.id })).storageKey;
          } catch (error) {
            storageKey = null;
            storageKeyError = String(error?.message || error);
          }
          let usageAndQuota = null;
          if (frame.origin && frame.origin !== "null") {
            usageAndQuota = await client.Storage.getUsageAndQuota({ origin: frame.origin }).catch((error) => ({ error: String(error?.message || error) }));
          }
          framesWithStorage.push({ ...frame, storageKey, storageKeyError, usageAndQuota });
        }
        const cookiesResult = await client.Network.getCookies().catch(() => ({ cookies: [] }));
        const cookies = Array.isArray(cookiesResult.cookies) ? cookiesResult.cookies : [];
        const storageBoundarySummary = summarizeStorageBoundaries(framesWithStorage);
        const cookiePartitionSummary = summarizeCookiePartitions(cookies);
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          page: page.result?.value,
          frames: framesWithStorage,
          storageBoundarySummary,
          cookieCount: cookies.length,
          cookiePartitionSummary,
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
    description: "Summarize browser cookies for the current profile tab, including SameSite, Secure, HttpOnly, expiry, and objective attribute signals.",
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
          partitionSummary: summarizeCookiePartitions(cookies.cookies || []),
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

  tools.set("browser_service_worker_detail", {
    name: "browser_service_worker_detail",
    description: "Return deeper Application panel Service Worker evidence: registrations, worker scripts, CacheStorage entries, and worker debugger targets.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        includeScripts: { type: "boolean" },
        includeCacheEntries: { type: "boolean" },
        maxScriptChars: { type: "number" },
        maxCacheEntries: { type: "number" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const includeScripts = params?.includeScripts !== false;
      const includeCacheEntries = params?.includeCacheEntries !== false;
      const maxScriptChars = typeof params?.maxScriptChars === "number" ? params.maxScriptChars : 120000;
      const maxCacheEntries = typeof params?.maxCacheEntries === "number" ? params.maxCacheEntries : 50;
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        const pageResult = await client.Runtime.evaluate({
          expression: `(async () => {
            const limits = ${JSON.stringify({ includeScripts, includeCacheEntries, maxScriptChars, maxCacheEntries })};
            const textPreview = (text) => ({
              text: String(text || "").slice(0, limits.maxScriptChars),
              bytes: new TextEncoder().encode(String(text || "")).length,
              truncated: String(text || "").length > limits.maxScriptChars,
            });
            async function fetchText(url) {
              if (!limits.includeScripts || !url) return null;
              try {
                const response = await fetch(url, { cache: "no-store", credentials: "include" });
                const text = await response.text();
                return {
                  url,
                  ok: response.ok,
                  status: response.status,
                  statusText: response.statusText,
                  headers: Array.from(response.headers.entries()).map(([name, value]) => ({ name, value })),
                  ...textPreview(text),
                };
              } catch (error) {
                return { url, error: String(error?.message || error) };
              }
            }
            const result = {
              url: location.href,
              origin: location.origin,
              secureContext: isSecureContext,
              controller: navigator.serviceWorker?.controller
                ? { scriptURL: navigator.serviceWorker.controller.scriptURL, state: navigator.serviceWorker.controller.state }
                : null,
              registrations: [],
              scripts: [],
              cacheStorage: { supported: Boolean(caches), names: [], caches: [] },
            };
            try {
              const registrations = navigator.serviceWorker?.getRegistrations ? await navigator.serviceWorker.getRegistrations() : [];
              const scriptUrls = new Set();
              result.registrations = registrations.map((registration) => {
                const states = {};
                for (const key of ["active", "waiting", "installing"]) {
                  const worker = registration[key];
                  states[key] = worker ? { scriptURL: worker.scriptURL, state: worker.state } : null;
                  if (worker?.scriptURL) scriptUrls.add(worker.scriptURL);
                }
                return {
                  scope: registration.scope,
                  updateViaCache: registration.updateViaCache,
                  ...states,
                };
              });
              result.scripts = await Promise.all(Array.from(scriptUrls).map(fetchText));
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
                  const entries = [];
                  if (limits.includeCacheEntries) {
                    for (const request of requests.slice(0, limits.maxCacheEntries)) {
                      const response = await cache.match(request).catch(() => null);
                      entries.push({
                        url: request.url,
                        method: request.method,
                        mode: request.mode,
                        credentials: request.credentials,
                        status: response?.status ?? null,
                        statusText: response?.statusText ?? null,
                        type: response?.type ?? null,
                        headers: response ? Array.from(response.headers.entries()).map(([header, value]) => ({ name: header, value })) : [],
                        bodyUsed: response?.bodyUsed ?? null,
                      });
                    }
                  }
                  return {
                    name,
                    entryCount: requests.length,
                    entries,
                    truncated: requests.length > limits.maxCacheEntries,
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
              devtoolsFrontendUrl: entry.devtoolsFrontendUrl,
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
          scriptCount: page.scripts?.filter(Boolean).length || 0,
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

  tools.set("browser_dom_search", {
    name: "browser_dom_search",
    description: "Search the live DOM using Chrome DevTools DOM.performSearch, like Elements panel search.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        query: { type: "string" },
        includeUserAgentShadowDOM: { type: "boolean" },
        includeFrames: { type: "boolean" },
        maxResults: { type: "number" },
        maxOuterHTMLChars: { type: "number" },
      },
      required: ["query"],
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const query = String(params?.query || "");
      const maxResults = typeof params?.maxResults === "number" ? params.maxResults : 20;
      const maxOuterHTMLChars = typeof params?.maxOuterHTMLChars === "number" ? params.maxOuterHTMLChars : 1200;
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        await client.DOM.enable().catch(() => {});
        const search = await client.DOM.performSearch({
          query,
          includeUserAgentShadowDOM: Boolean(params?.includeUserAgentShadowDOM),
        });
        const count = Number(search.resultCount || 0);
        const endIndex = Math.min(count, Math.max(0, maxResults));
        const ids = endIndex > 0
          ? await client.DOM.getSearchResults({ searchId: search.searchId, fromIndex: 0, toIndex: endIndex })
          : { nodeIds: [] };
        const results = [];
        for (const nodeId of ids.nodeIds || []) {
          const described = await client.DOM.describeNode({ nodeId, depth: 1, pierce: true }).catch((error) => ({ error: String(error?.message || error), node: { nodeId } }));
          const outer = await client.DOM.getOuterHTML({ nodeId }).catch((error) => ({ error: String(error?.message || error), outerHTML: "" }));
          results.push({
            source: "cdp",
            ...domSearchNodeSummary(described.node || { nodeId }, outer, maxOuterHTMLChars),
            describeError: described.error,
            outerHTMLError: outer.error,
          });
        }
        await client.DOM.discardSearchResults({ searchId: search.searchId }).catch(() => {});
        const validResultCount = results.filter((entry) => entry.outerHTML || entry.nodeName || entry.localName).length;
        let fallback = null;
        if (params?.includeFrames !== false || validResultCount < Math.min(count, maxResults)) {
          const fallbackResult = await client.Runtime.evaluate({
            expression: `(${domSearchFallbackPageFunction.toString()})(${JSON.stringify({ query, maxResults, maxOuterHTMLChars, includeFrames: params?.includeFrames !== false })})`,
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
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          query,
          includeUserAgentShadowDOM: Boolean(params?.includeUserAgentShadowDOM),
          includeFrames: params?.includeFrames !== false,
          resultCount: count,
          returnedCount: merged.length,
          truncated: count > merged.length,
          fallbackUsed: Boolean(fallbackResults.length || fallback?.error),
          fallbackError: fallback?.error,
          results: merged,
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
        framePath: { type: "string" },
        frameIndexes: { type: "array", items: { type: "number" } },
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
        const frameIndexes = frameIndexesFromOptions(params);
        const expression = frameIndexes.length
          ? `(${selectInFramePageFunction.toString()})(${JSON.stringify({ selector, framePath: params?.framePath || null, frameIndexes })})`
          : selector === "document"
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
            framePath: params?.framePath || null,
            frameIndexes,
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
          framePath: params?.framePath || null,
          frameIndexes,
          found: true,
          count: listeners.length,
          listeners,
        };
      }));
    },
  });

  tools.set("browser_css_styles", {
    name: "browser_css_styles",
    description: "Return DevTools Elements-panel Styles/Computed/Box Model evidence for a selected DOM node.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        selector: { type: "string" },
        framePath: { type: "string" },
        frameIndexes: { type: "array", items: { type: "number" } },
        includeComputed: { type: "boolean" },
        includeMatchedRules: { type: "boolean" },
        includeBoxModel: { type: "boolean" },
        forcePseudoClasses: { type: "array", items: { type: "string" } },
        persistPseudoState: { type: "boolean" },
        maxRules: { type: "number" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const selector = params?.selector ? String(params.selector) : "body";
      const maxRules = typeof params?.maxRules === "number" ? params.maxRules : 80;
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        await client.DOM.enable();
        await client.CSS.enable();
        const resolved = await resolveNodeIdForSelector(client, selector, params);
        if (!resolved.nodeId) {
          const fallbackStyle = await client.Runtime.evaluate({
            expression: `(() => { const selectInFramePageFunction = ${selectInFramePageFunction.toString()}; const styleInFramePageFunction = ${styleInFramePageFunction.toString()}; return styleInFramePageFunction(${JSON.stringify({
              selector,
              framePath: params?.framePath || null,
              frameIndexes: resolved.frameIndexes,
              maxOuterHTMLChars: 4000,
            })}); })()`,
            returnByValue: true,
            awaitPromise: true,
          }).catch((error) => ({ error: String(error?.message || error) }));
          const fallbackValue = fallbackStyle.error ? { found: false, error: fallbackStyle.error } : fallbackStyle.result?.value;
          return {
            profile: profile.name,
            tabId: target.id,
            selector,
            framePath: params?.framePath || null,
            frameIndexes: resolved.frameIndexes,
            ...(fallbackValue || { found: false }),
            selectorResolution: resolved,
            matchedStyles: null,
            fallbackUsed: true,
          };
        }
        const pseudo = normalizeForcedPseudoClasses(params?.forcePseudoClasses);
        let forcePseudoState = null;
        if (pseudo.forced.length) {
          forcePseudoState = await client.CSS.forcePseudoState({
            nodeId: resolved.nodeId,
            forcedPseudoClasses: pseudo.forced,
          }).then(() => ({ applied: true })).catch((error) => ({ applied: false, error: String(error?.message || error) }));
        }
        const [matchedStyles, computedStyle, boxModel] = await Promise.all([
          params?.includeMatchedRules === false
            ? Promise.resolve(null)
            : client.CSS.getMatchedStylesForNode({ nodeId: resolved.nodeId }).catch((error) => ({ error: String(error?.message || error) })),
          params?.includeComputed === false
            ? Promise.resolve(null)
            : client.CSS.getComputedStyleForNode({ nodeId: resolved.nodeId }).catch((error) => ({ error: String(error?.message || error) })),
          params?.includeBoxModel === false
            ? Promise.resolve(null)
            : client.DOM.getBoxModel({ nodeId: resolved.nodeId }).catch((error) => ({ error: String(error?.message || error) })),
        ]);
        if (pseudo.forced.length && params?.persistPseudoState !== true) {
          await client.CSS.forcePseudoState({ nodeId: resolved.nodeId, forcedPseudoClasses: [] }).catch(() => {});
        }
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          selector,
          framePath: params?.framePath || null,
          frameIndexes: resolved.frameIndexes,
          found: true,
          nodeId: resolved.nodeId,
          selectorResolution: resolved,
          forcedPseudoClasses: pseudo.forced,
          skippedPseudoClasses: pseudo.skipped,
          pseudoStatePersisted: Boolean(params?.persistPseudoState && pseudo.forced.length),
          forcePseudoState,
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
      }));
    },
  });

  tools.set("browser_dom_mutation_watch", {
    name: "browser_dom_mutation_watch",
    description: "Watch DOM mutations for a selector, similar to DevTools Elements DOM-breakpoint evidence without pausing JavaScript.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        selector: { type: "string" },
        durationMs: { type: "number" },
        maxEvents: { type: "number" },
        subtree: { type: "boolean" },
        childList: { type: "boolean" },
        attributes: { type: "boolean" },
        characterData: { type: "boolean" },
        attributeOldValue: { type: "boolean" },
        characterDataOldValue: { type: "boolean" },
        triggerExpression: { type: "string" },
      },
      required: ["selector"],
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const selector = String(params?.selector || "");
      const durationMs = Math.min(Math.max(typeof params?.durationMs === "number" ? params.durationMs : 1000, 100), 10000);
      const maxEvents = typeof params?.maxEvents === "number" ? params.maxEvents : 100;
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        await client.Runtime.enable().catch(() => {});
        const expression = `(${domMutationWatchPageFunction.toString()})(${JSON.stringify({
          selector,
          durationMs,
          maxEvents,
          subtree: params?.subtree !== false,
          childList: params?.childList !== false,
          attributes: params?.attributes !== false,
          characterData: Boolean(params?.characterData),
          attributeOldValue: params?.attributeOldValue !== false,
          characterDataOldValue: Boolean(params?.characterDataOldValue),
          triggerExpression: params?.triggerExpression ? String(params.triggerExpression) : "",
        })})`;
        const result = await client.Runtime.evaluate({
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        if (result.exceptionDetails) {
          throw new Error(result.exceptionDetails.text || "DOM mutation watch failed");
        }
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          ...(result.result?.value || {}),
        };
      }));
    },
  });

  tools.set("browser_cdp_command", {
    name: "browser_cdp_command",
    description: "Run a raw Chrome DevTools Protocol command against the profile tab for F12 features not yet wrapped as first-class tools.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        method: { type: "string" },
        params: { type: "object" },
      },
      required: ["method"],
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const method = String(params?.method || "").trim();
      if (!/^[A-Za-z0-9_.]+$/.test(method) || !method.includes(".")) {
        throw new Error("method must be a Chrome DevTools Protocol method like Runtime.evaluate");
      }
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        const result = await client.send(method, params?.params && typeof params.params === "object" ? params.params : {});
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          method,
          result,
        };
      }));
    },
  });

  tools.set("browser_debugger_control", {
    name: "browser_debugger_control",
    description: "Use core DevTools Debugger controls: pause/resume/step, breakpoint setup, XHR breakpoints, and paused call-frame/scope inspection.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        action: { type: "string" },
        url: { type: "string" },
        urlRegex: { type: "string" },
        lineNumber: { type: "number" },
        columnNumber: { type: "number" },
        condition: { type: "string" },
        breakpointId: { type: "string" },
        xhrUrlContains: { type: "string" },
        expression: { type: "string" },
        waitMs: { type: "number" },
        autoResume: { type: "boolean" },
        maxFrames: { type: "number" },
        maxScopes: { type: "number" },
        maxProperties: { type: "number" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const action = String(params?.action || "snapshot");
      const waitMs = Math.min(Math.max(typeof params?.waitMs === "number" ? params.waitMs : 1000, 50), 10000);
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        await client.Runtime.enable().catch(() => {});
        await client.Debugger.enable().catch(() => {});
        let pausedEvent = null;
        client.Debugger.paused((event) => {
          pausedEvent = event;
        });
        client.Debugger.resumed(() => {
          if (action !== "snapshot") pausedEvent = null;
        });

        let commandResult = null;
        let pendingCommand = null;
        if (action === "setBreakpointByUrl") {
          commandResult = await client.Debugger.setBreakpointByUrl({
            lineNumber: Number(params?.lineNumber || 0),
            url: params?.url ? String(params.url) : undefined,
            urlRegex: params?.urlRegex ? String(params.urlRegex) : undefined,
            columnNumber: typeof params?.columnNumber === "number" ? params.columnNumber : 0,
            condition: params?.condition ? String(params.condition) : undefined,
          });
        } else if (action === "removeBreakpoint") {
          commandResult = await client.Debugger.removeBreakpoint({ breakpointId: String(params?.breakpointId || "") });
        } else if (action === "setXHRBreakpoint") {
          commandResult = await client.DOMDebugger.setXHRBreakpoint({ url: String(params?.xhrUrlContains || "") });
        } else if (action === "removeXHRBreakpoint") {
          commandResult = await client.DOMDebugger.removeXHRBreakpoint({ url: String(params?.xhrUrlContains || "") });
        } else if (action === "pause") {
          commandResult = await client.Debugger.pause();
          await sleep(waitMs);
        } else if (action === "resume") {
          commandResult = await client.Debugger.resume().catch((error) => ({ error: String(error?.message || error) }));
        } else if (action === "stepOver") {
          commandResult = await client.Debugger.stepOver().catch((error) => ({ error: String(error?.message || error) }));
          await sleep(waitMs);
        } else if (action === "stepInto") {
          commandResult = await client.Debugger.stepInto().catch((error) => ({ error: String(error?.message || error) }));
          await sleep(waitMs);
        } else if (action === "stepOut") {
          commandResult = await client.Debugger.stepOut().catch((error) => ({ error: String(error?.message || error) }));
          await sleep(waitMs);
        } else if (action === "pauseOnExpression") {
          const expression = params?.expression ? String(params.expression) : "debugger;";
          pendingCommand = client.Runtime.evaluate({
            expression,
            awaitPromise: false,
            returnByValue: false,
          }).catch((error) => ({ error: String(error?.message || error) }));
          commandResult = { pending: true, reason: "Runtime.evaluate may remain pending while JavaScript is paused." };
          await sleep(waitMs);
        } else if (action !== "snapshot") {
          throw new Error(`unsupported debugger action: ${action}`);
        }

        const paused = await debuggerPausedSummary(client, pausedEvent, params || {});
        const shouldResume = params?.autoResume !== false && ["pause", "pauseOnExpression", "stepOver", "stepInto", "stepOut"].includes(action);
        let resumeResult = null;
        if (paused && shouldResume) {
          resumeResult = await client.Debugger.resume().catch((error) => ({ error: String(error?.message || error) }));
        }
        if (pendingCommand) {
          commandResult = await Promise.race([
            pendingCommand,
            sleep(1000).then(() => ({ pending: true, reason: "Runtime.evaluate did not settle after resume timeout." })),
          ]);
        }
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          action,
          commandResult,
          paused,
          autoResumed: Boolean(paused && shouldResume),
          resumeResult,
          note: "Managed Browser uses a short-lived CDP session; use pauseOnExpression for capture-and-resume inspection, or raw CDP for specialized flows.",
        };
      }));
    },
  });

  tools.set("browser_token_flow_trace", {
    name: "browser_token_flow_trace",
    description: "Temporarily instrument fetch, XHR, local/session storage, and document.cookie to capture objective token-like data flow evidence during a trigger.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        durationMs: { type: "number" },
        maxEvents: { type: "number" },
        maxValueChars: { type: "number" },
        includeValues: { type: "boolean" },
        triggerExpression: { type: "string" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const durationMs = Math.min(Math.max(typeof params?.durationMs === "number" ? params.durationMs : 1000, 50), 10000);
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        await client.Runtime.enable().catch(() => {});
        const result = await client.Runtime.evaluate({
          expression: `(${tokenFlowTracePageFunction.toString()})(${JSON.stringify({
            durationMs,
            maxEvents: typeof params?.maxEvents === "number" ? params.maxEvents : 100,
            maxValueChars: typeof params?.maxValueChars === "number" ? params.maxValueChars : 4000,
            includeValues: params?.includeValues !== false,
            triggerExpression: params?.triggerExpression || "",
          })})`,
          awaitPromise: true,
          returnByValue: true,
        });
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          trace: result.result?.value || null,
          exception: result.exceptionDetails || null,
        };
      }));
    },
  });

  tools.set("browser_memory_snapshot", {
    name: "browser_memory_snapshot",
    description: "Return DevTools Memory/Performance Monitor-style counters: JS heap usage, DOM counters, and performance metrics.",
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
        await client.Runtime.enable().catch(() => {});
        await client.Performance.enable().catch(() => {});
        const heap = await client.Runtime.getHeapUsage().catch((error) => ({ error: String(error?.message || error) }));
        const domCounters = await client.Memory.getDOMCounters().catch((error) => ({ error: String(error?.message || error) }));
        const metrics = await client.Performance.getMetrics().catch((error) => ({ error: String(error?.message || error), metrics: [] }));
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          timestamp: new Date().toISOString(),
          heap,
          domCounters,
          performanceMetrics: Array.isArray(metrics.metrics) ? metrics.metrics : [],
          performanceError: metrics.error,
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

  tools.set("agent_inspect", {
    name: "agent_inspect",
    description: "Agent-facing F12 router. Pick a focus and get the right DevTools evidence without choosing from dozens of low-level tools.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        focus: {
          type: "string",
          enum: ["overview", "network", "storage", "console", "dom", "sources", "performance", "search", "evidence", "debug"],
        },
        query: { type: "string" },
        selector: { type: "string" },
        requestId: { type: "string" },
        includeHeavy: { type: "boolean" },
        save: { type: "boolean" },
        limit: { type: "number" },
      },
    },
    async execute(id, params) {
      const profile = await resolveProfile(params?.profile);
      const focus = String(params?.focus || "overview");
      const limit = typeof params?.limit === "number" ? params.limit : 20;
      const base = { profile: profile.name, tabId: params?.tabId };
      const readPayload = (result) => JSON.parse(result.content?.[0]?.text || "{}");
      const call = async (name, extra = {}) => readPayload(await tools.get(name).execute(id, { ...base, ...extra }));
      const safeCall = async (name, extra = {}) => {
        try {
          return await call(name, extra);
        } catch (error) {
          return { unavailable: true, tool: name, error: String(error?.message || error) };
        }
      };
      const safeProfileCall = async (name, extra = {}) => {
        try {
          return readPayload(await tools.get(name).execute(id, { profile: profile.name, ...extra }));
        } catch (error) {
          return { unavailable: true, tool: name, error: String(error?.message || error) };
        }
      };
      const objectiveSignals = (payload) => {
        if (!payload || typeof payload !== "object") return payload;
        return payload;
      };
      const out = {
        backend: "managed-cdp",
        profile: profile.name,
        focus,
        generatedAt: new Date().toISOString(),
        summary: "",
        evidence: {},
        nextTools: [],
        toolPlan: buildAgentInspectToolPlan(focus, {
          requestId: Boolean(params?.requestId),
          query: Boolean(params?.query),
          selector: Boolean(params?.selector),
          includeHeavy: Boolean(params?.includeHeavy),
        }),
      };

      if (focus === "overview") {
        out.evidence.backendCapabilities = await safeCall("devtools_backend_capabilities");
        out.evidence.diagnostics = await safeCall("browser_page_diagnostics", { limit });
        out.evidence.signals = objectiveSignals(await safeCall("browser_signal_summary", { limit, includeTokenScan: false }));
        out.evidence.network = await safeProfileCall("profile_traffic_summary", { limit });
        out.evidence.console = await safeCall("browser_console_log", { reload: false, waitMs: 100, limit });
        out.summary = "Objective first pass across page, network, console, storage, and browser signals. This does not decide vulnerability impact.";
        out.nextTools = ["agent_inspect focus=network", "agent_inspect focus=storage", "agent_inspect focus=console", "agent_inspect focus=dom", "agent_inspect focus=evidence"];
      } else if (focus === "network") {
        out.evidence.summary = await safeProfileCall("profile_traffic_summary", { limit: 1000000 });
        out.evidence.timeline = await safeProfileCall("profile_network_timeline", { limit });
        out.evidence.requests = await safeProfileCall("profile_traffic_query", { limit });
        out.evidence.realtime = await safeProfileCall("profile_realtime_log", { limit });
        if (params?.requestId) {
          out.evidence.requestDetail = await safeProfileCall("profile_request_detail", { requestId: params.requestId });
          out.evidence.requestBody = await safeProfileCall("profile_traffic_get", { requestId: params.requestId });
        }
        out.summary = "Network panel route: summary, timing/initiator rows, captured requests, real-time channels, and optional request drill-down.";
        out.nextTools = ["Use requestId with focus=network", "devtools_realtime_log", "devtools_request_replay", "devtools_request_replay_batch", "devtools_save_har", "agent_inspect focus=search query=<token/url/header>"];
      } else if (focus === "storage") {
        out.evidence.origin = await safeCall("browser_storage_origin_summary");
        out.evidence.cookies = await safeCall("browser_cookie_summary");
        out.evidence.serviceWorkers = await safeCall("browser_service_worker_summary");
        if (params?.includeHeavy) out.evidence.storage = await safeCall("browser_storage_snapshot");
        out.summary = "Application panel route: origin/quota, cookies, service workers, and optional full storage snapshot.";
        out.nextTools = ["devtools_application_export", "devtools_indexeddb_read", "devtools_cache_entry_get", "agent_inspect focus=search query=<key/value>"];
      } else if (focus === "console") {
        out.evidence.console = await safeCall("browser_console_log", { reload: false, waitMs: 300, limit });
        out.evidence.issues = await safeCall("browser_issues_log", { reload: false, waitMs: 100, limit });
        out.summary = "Console and Issues route: runtime logs, exceptions, security messages, and DevTools issue events.";
        out.nextTools = ["devtools_console_source_context", "agent_inspect focus=sources query=<stack marker>", "agent_inspect focus=debug"];
      } else if (focus === "dom") {
        out.evidence.elements = await safeCall("browser_elements_snapshot", { selector: params?.selector, maxNodes: limit * 10 });
        if (params?.query) out.evidence.search = await safeCall("browser_dom_search", { query: params.query, maxResults: limit });
        if (params?.selector) {
          out.evidence.styles = await safeCall("browser_css_styles", { selector: params.selector, maxRules: limit });
          out.evidence.listeners = await safeCall("browser_event_listeners", { selector: params.selector });
        }
        out.summary = "Elements panel route: DOM tree, optional live DOM search, selected-node styles, box model, and event listeners.";
        out.nextTools = ["Pass selector for styles/listeners", "Pass query for DOM search", "devtools_dom_mutation_watch"];
      } else if (focus === "sources") {
        out.evidence.sources = await safeCall("browser_sources_list", { limit: limit * 5 });
        if (params?.query) out.evidence.search = await safeCall("browser_sources_search", { query: params.query, maxMatches: limit });
        out.summary = "Sources panel route: parsed scripts, source maps, literal source search, and debugger drill-down.";
        out.nextTools = ["devtools_source_get", "devtools_source_pretty_print", "devtools_source_map_metadata", "agent_inspect focus=debug"];
      } else if (focus === "performance") {
        out.evidence.memory = await safeCall("browser_memory_snapshot");
        out.evidence.observer = await safeCall("browser_performance_observer", { durationMs: 500, maxItems: limit });
        out.evidence.insights = await safeCall("browser_performance_insights", { durationMs: 500, maxItems: limit, includeChromeTrace: Boolean(params?.includeHeavy) });
        out.evidence.performance = await safeCall("browser_performance_trace", { durationMs: 500 });
        if (params?.includeHeavy) out.evidence.cpuProfile = await safeCall("browser_cpu_profile", { durationMs: 500, maxNodes: limit });
        out.summary = "Performance route: memory counters plus objective timing, resource, long-task, and optional trace evidence.";
        out.nextTools = ["devtools_performance_observer", "devtools_performance_insights", "devtools_chrome_trace", "devtools_cpu_profile", "devtools_coverage_detail"];
      } else if (focus === "search") {
        if (!params?.query) throw new Error("query is required for focus=search");
        out.evidence.search = await safeCall("browser_global_search", { query: params.query, maxMatches: limit });
        out.summary = "Global search route: literal search across currently available F12 evidence surfaces.";
        out.nextTools = ["agent_inspect focus=network query=<...>", "agent_inspect focus=storage query=<...>", "agent_inspect focus=sources query=<...>"];
      } else if (focus === "evidence") {
        out.evidence.bundle = await safeCall("browser_evidence_bundle", { save: params?.save !== false, networkLimit: limit, sourceLimit: limit * 5 });
        out.summary = "Evidence route: compact export bundle for handoff, report writing, or later Agent review.";
        out.nextTools = ["Open bundlePath", "agent_inspect focus=overview", "agent_inspect focus=search query=<hypothesis>"];
      } else if (focus === "debug") {
        out.evidence.debugger = await safeCall("browser_debugger_control", {
          action: params?.query ? "pauseOnExpression" : "snapshot",
          expression: params?.query || undefined,
          waitMs: 500,
          autoResume: true,
          maxFrames: limit,
        });
        out.summary = "Debugger route: paused-frame/scope snapshot or expression-triggered pause. Use low-level debugger tool for precise breakpoints.";
        out.nextTools = ["Use query as pauseOnExpression", "devtools_debugger_control action=setBreakpointByUrl", "devtools_source_get"];
      } else {
        throw new Error(`unsupported agent_inspect focus: ${focus}`);
      }
      out.completeness = summarizeEvidenceCompleteness(out.evidence);
      return toolResult(out);
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
        includeHar: { type: "boolean" },
        includeTokenScan: { type: "boolean" },
        includeTokenFlow: { type: "boolean" },
        tokenFlowTriggerExpression: { type: "string" },
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
      if (params?.includeHar) {
        bundle.har = readPayload(await tools.get("profile_export_har").execute(id, {
          profile: profile.name,
          limit: params?.networkLimit || 100,
          includeBodies: false,
        }));
      }
      if (params?.includeTokenScan) {
        bundle.tokenScan = readPayload(await tools.get("browser_token_scan").execute(id, toolParams));
      }
      if (params?.includeTokenFlow) {
        bundle.tokenFlow = readPayload(await tools.get("browser_token_flow_trace").execute(id, {
          ...toolParams,
          durationMs: 800,
          maxEvents: 50,
          triggerExpression: params?.tokenFlowTriggerExpression || "",
        }));
      }
      const summary = {
        url: bundle.diagnostics?.page?.url || bundle.security?.page?.url || "",
        requestCount: bundle.networkSummary?.requestCount || 0,
        issueCount: bundle.issues?.issueCount || 0,
        cookieCount: bundle.storage?.cookies?.length || 0,
        sourceCount: bundle.sources?.count || 0,
        harEntryCount: bundle.har?.har?.log?.entries?.length || 0,
        tokenFindingCount: bundle.tokenScan?.findingCount || bundle.tokenScan?.findings?.length || 0,
        tokenFlowEventCount: bundle.tokenFlow?.trace?.eventCount || 0,
        tokenFlowTokenLikeEventCount: bundle.tokenFlow?.trace?.tokenLikeEventCount || 0,
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

  tools.set("browser_evidence_manifest", {
    name: "browser_evidence_manifest",
    description: "Create a manifest for profile evidence files: capture window, artifact paths, sizes, hashes, and local provenance. This is objective evidence bookkeeping, not vulnerability analysis.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        artifactPaths: { type: "array", items: { type: "string" } },
        maxFiles: { type: "number" },
        save: { type: "boolean" },
        path: { type: "string" },
      },
    },
    async execute(id, params) {
      const profile = await resolveProfile(params?.profile);
      const readPayload = (result) => JSON.parse(result.content?.[0]?.text || "{}");
      const diagnostics = readPayload(await tools.get("browser_page_diagnostics").execute(id, { profile: profile.name, tabId: params?.tabId, limit: 5 }));
      const files = listEvidenceFiles(profile.evidenceDir, { maxFiles: params?.maxFiles || 200 });
      const explicitArtifacts = [];
      for (const file of params?.artifactPaths || []) {
        if (!file || !existsSync(file)) {
          explicitArtifacts.push({ path: file, exists: false });
          continue;
        }
        const stat = statSync(file);
        explicitArtifacts.push({
          path: file,
          exists: true,
          bytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          sha256: stat.size <= 25_000_000 ? fileSha256(file) : null,
          hashSkipped: stat.size > 25_000_000,
        });
      }
      const manifest = {
        schema: "agent-browser-runtime.evidence-manifest.v1",
        backend: "managed-cdp",
        generatedAt: new Date().toISOString(),
        profile: profile.name,
        tabId: diagnostics.tabId || profile.tabId,
        page: diagnostics.page || {},
        capture: profileRegistry.getCapture(profile.name),
        evidenceDir: profile.evidenceDir,
        fileCount: files.length,
        files,
        explicitArtifacts,
        boundaries: [
          "Manifest records local evidence files and hashes only.",
          "It does not classify findings or decide vulnerability impact.",
        ],
      };
      let manifestPath = null;
      if (params?.save !== false) {
        manifestPath = params?.path || join(profile.evidenceDir, "manifests", `${Date.now()}-evidence-manifest.json`);
        mkdirSync(dirname(manifestPath), { recursive: true });
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      }
      return toolResult({ ...manifest, manifestPath });
    },
  });

  tools.set("browser_request_correlation_graph", {
    name: "browser_request_correlation_graph",
    description: "Build an objective graph connecting frames, scripts, Network requests, and Console entries observed in current F12 evidence.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        limit: { type: "number" },
        save: { type: "boolean" },
        path: { type: "string" },
      },
    },
    async execute(id, params) {
      const profile = await resolveProfile(params?.profile);
      const limit = typeof params?.limit === "number" ? params.limit : 200;
      const readPayload = (result) => JSON.parse(result.content?.[0]?.text || "{}");
      const framePayload = readPayload(await tools.get("browser_frame_tree").execute(id, { profile: profile.name, tabId: params?.tabId }));
      const frames = framePayload.frames || flattenFrameTree(framePayload.frameTree);
      const consoleLog = readPayload(await tools.get("browser_console_log").execute(id, { profile: profile.name, tabId: params?.tabId, limit: 100, reload: false, waitMs: 50 }));
      const sources = readPayload(await tools.get("browser_sources_list").execute(id, { profile: profile.name, tabId: params?.tabId, limit }))?.scripts || [];
      const requests = profileRegistry.queryTraffic(profile.name, { limit });
      const graph = buildRequestCorrelationGraph({
        requests,
        consoleEntries: consoleLog.entries || [],
        scripts: sources,
        frames,
        limit,
      });
      let graphPath = null;
      if (params?.save) {
        graphPath = params?.path || join(profile.evidenceDir, "graphs", `${Date.now()}-request-correlation-graph.json`);
        mkdirSync(dirname(graphPath), { recursive: true });
        writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
      }
      return toolResult({
        backend: "managed-cdp",
        profile: profile.name,
        generatedAt: new Date().toISOString(),
        graphPath,
        ...graph,
        boundaries: [
          "Edges are evidence correlations from F12 metadata, not proof of causality.",
          "Use request detail, source context, and debugger tools for drill-down.",
        ],
        nextTools: ["devtools_request_detail", "devtools_source_get", "devtools_console_source_context", "devtools_debugger_control"],
      });
    },
  });

  tools.set("browser_capture_diff", {
    name: "browser_capture_diff",
    description: "Compare two saved evidence artifacts or current captured traffic against a saved artifact. Useful for login/logout, role, account, and permission-boundary before/after research.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        beforePath: { type: "string" },
        afterPath: { type: "string" },
        includeCurrentAsAfter: { type: "boolean" },
        save: { type: "boolean" },
        path: { type: "string" },
      },
      required: ["beforePath"],
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const before = readJsonFile(params.beforePath);
      const after = params?.afterPath ? readJsonFile(params.afterPath) : { requests: profileRegistry.queryTraffic(profile.name, { limit: 1000000 }) };
      const beforeRequests = extractBundleNetworkRecords(before);
      const afterRequests = extractBundleNetworkRecords(after);
      const network = diffRequestSets(beforeRequests, afterRequests);
      const beforeStorage = before?.bundle?.storage || before?.storage || {};
      const afterStorage = after?.bundle?.storage || after?.storage || {};
      const storage = {
        topLevelKeys: diffObjectKeys(beforeStorage, afterStorage),
        cookieNames: diffObjectKeys(
          Object.fromEntries((beforeStorage.cookies || []).map((cookie) => [cookie.name, true])),
          Object.fromEntries((afterStorage.cookies || []).map((cookie) => [cookie.name, true])),
        ),
      };
      const diff = {
        schema: "agent-browser-runtime.capture-diff.v1",
        backend: "managed-cdp",
        generatedAt: new Date().toISOString(),
        profile: profile.name,
        beforePath: params.beforePath,
        afterPath: params?.afterPath || null,
        afterSource: params?.afterPath ? "file" : "current-profile-traffic",
        network,
        storage,
        summary: {
          addedRequestShapes: network.added.length,
          removedRequestShapes: network.removed.length,
          changedRequestShapes: network.changed.length,
          addedStorageKeys: storage.topLevelKeys.added.length,
          removedStorageKeys: storage.topLevelKeys.removed.length,
        },
        boundaries: [
          "Diff reports observable changes between two evidence snapshots.",
          "It does not decide whether a change is authorized, expected, or vulnerable.",
        ],
      };
      let diffPath = null;
      if (params?.save) {
        diffPath = params?.path || join(profile.evidenceDir, "diffs", `${Date.now()}-capture-diff.json`);
        mkdirSync(dirname(diffPath), { recursive: true });
        writeFileSync(diffPath, `${JSON.stringify(diff, null, 2)}\n`, "utf8");
      }
      return toolResult({ ...diff, diffPath, nextTools: ["devtools_request_detail", "devtools_auth_boundary_report", "devtools_global_search"] });
    },
  });

  tools.set("browser_auth_boundary_report", {
    name: "browser_auth_boundary_report",
    description: "Collect objective authentication and authorization boundary evidence: cookies, auth headers, token-like values, credentialed requests, storage tokens, and security context.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        limit: { type: "number" },
        includeTokenScan: { type: "boolean" },
        save: { type: "boolean" },
        path: { type: "string" },
      },
    },
    async execute(id, params) {
      const profile = await resolveProfile(params?.profile);
      const limit = typeof params?.limit === "number" ? params.limit : 50;
      const readPayload = (result) => JSON.parse(result.content?.[0]?.text || "{}");
      const requests = profileRegistry.queryTraffic(profile.name, { limit: 1000000 });
      const cookies = readPayload(await tools.get("browser_cookie_summary").execute(id, { profile: profile.name, tabId: params?.tabId }));
      const storage = readPayload(await tools.get("browser_storage_snapshot").execute(id, { profile: profile.name, tabId: params?.tabId }));
      const security = readPayload(await tools.get("browser_security_summary").execute(id, { profile: profile.name, tabId: params?.tabId }));
      const tokenScan = params?.includeTokenScan === false ? null : readPayload(await tools.get("browser_token_scan").execute(id, { profile: profile.name, tabId: params?.tabId }));
      const authRequests = authHeaderEvidence(requests, limit);
      const credentialedRequests = requests
        .filter((request) => headerValue(request.requestHeaders || request.headers || {}, "cookie") || headerValue(request.requestHeaders || request.headers || {}, "authorization"))
        .slice(-limit)
        .map((request) => ({
          requestId: request.requestId,
          method: request.method,
          url: request.url,
          status: request.status,
          resourceType: request.resourceType,
          hasCookies: Boolean(headerValue(request.requestHeaders || request.headers || {}, "cookie")),
          hasAuthorization: Boolean(headerValue(request.requestHeaders || request.headers || {}, "authorization")),
        }));
      const report = {
        schema: "agent-browser-runtime.auth-boundary-report.v1",
        backend: "managed-cdp",
        generatedAt: new Date().toISOString(),
        profile: profile.name,
        page: security.page || {},
        capture: profileRegistry.getCapture(profile.name),
        cookieSummary: cookies.summary || cookies,
        storageSummary: {
          localStorageKeys: Object.keys(storage.localStorage || {}),
          sessionStorageKeys: Object.keys(storage.sessionStorage || {}),
          cookieCount: Array.isArray(storage.cookies) ? storage.cookies.length : 0,
        },
        authRequests,
        credentialedRequests,
        tokenScanSummary: tokenScan ? {
          findingCount: tokenScan.findingCount || tokenScan.findings?.length || 0,
          bySource: tokenScan.bySource || {},
          findings: (tokenScan.findings || []).slice(0, limit),
        } : null,
        security: security.security || security,
        boundaries: [
          "This report lists authentication-related evidence only.",
          "It does not decide whether access control is correct.",
        ],
      };
      let reportPath = null;
      if (params?.save) {
        reportPath = params?.path || join(profile.evidenceDir, "auth", `${Date.now()}-auth-boundary-report.json`);
        mkdirSync(dirname(reportPath), { recursive: true });
        writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      }
      return toolResult({ ...report, reportPath, nextTools: ["devtools_request_replay_batch", "devtools_capture_diff", "devtools_token_scan", "devtools_cookie_summary"] });
    },
  });

  tools.set("browser_worker_frame_deep_dive", {
    name: "browser_worker_frame_deep_dive",
    description: "Deep-dive frame, iframe, worker, Service Worker, CacheStorage, and target evidence so agents can inspect execution boundaries.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        includeServiceWorkerDetail: { type: "boolean" },
        save: { type: "boolean" },
        path: { type: "string" },
      },
    },
    async execute(id, params) {
      const profile = await resolveProfile(params?.profile);
      const readPayload = (result) => JSON.parse(result.content?.[0]?.text || "{}");
      const frames = readPayload(await tools.get("browser_frame_tree").execute(id, { profile: profile.name, tabId: params?.tabId }));
      const swSummary = readPayload(await tools.get("browser_service_worker_summary").execute(id, { profile: profile.name, tabId: params?.tabId }));
      const swDetail = params?.includeServiceWorkerDetail === false
        ? null
        : readPayload(await tools.get("browser_service_worker_detail").execute(id, { profile: profile.name, tabId: params?.tabId }));
      const targets = await cdpJson(cdpPort, "/json/list").catch(() => []);
      const workerTargets = (targets || []).filter((target) => ["worker", "shared_worker", "service_worker"].includes(target.type));
      const report = {
        schema: "agent-browser-runtime.worker-frame-deep-dive.v1",
        backend: "managed-cdp",
        generatedAt: new Date().toISOString(),
        profile: profile.name,
        frameTree: frames,
        serviceWorkers: {
          summary: swSummary,
          detail: swDetail,
        },
        workerTargets: workerTargets.map((target) => ({
          id: target.id,
          type: target.type,
          title: target.title,
          url: target.url,
          attached: target.attached,
        })),
        summary: {
          frameCount: frames.frameCount || frames.frames?.length || flattenFrameTree(frames.frameTree).length || 0,
          inaccessibleFrameCount: frames.inaccessibleFrameCount || 0,
          serviceWorkerRegistrationCount: swSummary.registrationCount || 0,
          cacheCount: swSummary.cacheCount || 0,
          workerTargetCount: workerTargets.length,
        },
        boundaries: [
          "Cross-origin frame internals may be intentionally unavailable to page-context tools.",
          "Direct CDP target metadata is included when Chrome exposes it.",
        ],
      };
      let reportPath = null;
      if (params?.save) {
        reportPath = params?.path || join(profile.evidenceDir, "boundaries", `${Date.now()}-worker-frame-deep-dive.json`);
        mkdirSync(dirname(reportPath), { recursive: true });
        writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      }
      return toolResult({ ...report, reportPath, nextTools: ["devtools_frame_tree", "devtools_service_worker_detail", "devtools_cache_entry_get", "devtools_cdp_command"] });
    },
  });

  tools.set("browser_security_research_pack", {
    name: "browser_security_research_pack",
    description: "One-call security research evidence workflow: optionally navigate, start capture, reload, collect agent_inspect routes, save HAR/Application/trace evidence, and return artifact paths.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        url: { type: "string" },
        waitMs: { type: "number" },
        limit: { type: "number" },
        includeTrace: { type: "boolean" },
        includeHar: { type: "boolean" },
        includeApplicationExport: { type: "boolean" },
        includeTokenScan: { type: "boolean" },
        includePerformanceHeavy: { type: "boolean" },
      },
    },
    async execute(id, params) {
      const profile = await resolveProfile(params?.profile);
      const readPayload = (result) => JSON.parse(result.content?.[0]?.text || "{}");
      const call = async (name, extra = {}) => readPayload(await tools.get(name).execute(id, { profile: profile.name, ...extra }));
      const safeCall = async (name, extra = {}) => {
        try {
          return await call(name, extra);
        } catch (error) {
          return { unavailable: true, tool: name, error: String(error?.message || error) };
        }
      };
      const waitMs = typeof params?.waitMs === "number" ? params.waitMs : 1200;
      const limit = typeof params?.limit === "number" ? params.limit : 25;
      const steps = [];
      if (params?.url) {
        const url = new URL(String(params.url));
        if (!/^https?:$/.test(url.protocol)) throw new Error("url must use http or https");
        steps.push({ step: "navigate", result: await safeCall("browser_navigate", { url: url.toString(), waitMs }) });
      }
      steps.push({ step: "capture_start", result: await safeCall("devtools_capture_start", { clear: true, label: "security-research-pack" }) });
      steps.push({ step: "hard_reload", result: await safeCall("browser_hard_reload", { waitMs }) });
      const overview = await safeCall("agent_inspect", { focus: "overview", limit });
      const network = await safeCall("agent_inspect", { focus: "network", limit });
      const storage = await safeCall("agent_inspect", { focus: "storage", limit, includeHeavy: true });
      const consoleEvidence = await safeCall("agent_inspect", { focus: "console", limit });
      const sources = await safeCall("agent_inspect", { focus: "sources", limit });
      const performance = await safeCall("agent_inspect", { focus: "performance", limit, includeHeavy: Boolean(params?.includePerformanceHeavy) });
      const artifacts = {};
      if (params?.includeHar !== false) {
        artifacts.har = await safeCall("devtools_save_har", { limit: 500, includeBodies: false });
      }
      if (params?.includeApplicationExport !== false) {
        artifacts.application = await safeCall("devtools_application_export", {
          maxIndexedDbRecords: 100,
          maxCacheEntries: 100,
        });
      }
      if (params?.includeTrace !== false) {
        artifacts.trace = await safeCall("devtools_chrome_trace", { durationMs: 800, maxEvents: 20, maxScreenshots: 2 });
        if (artifacts.trace?.tracePath) {
          artifacts.traceQuery = await safeCall("devtools_trace_query", { tracePath: artifacts.trace.tracePath, limit: 10 });
        }
      }
      artifacts.correlationGraph = await safeCall("devtools_request_correlation_graph", { limit: 100, save: true });
      artifacts.authBoundary = await safeCall("devtools_auth_boundary_report", { limit: 50, includeTokenScan: Boolean(params?.includeTokenScan), save: true });
      artifacts.workerFrame = await safeCall("devtools_worker_frame_deep_dive", { includeServiceWorkerDetail: true, save: true });
      artifacts.bundle = await safeCall("devtools_evidence_bundle", {
        save: true,
        networkLimit: 100,
        sourceLimit: 100,
        includeHar: false,
        includeTokenScan: Boolean(params?.includeTokenScan),
      });
      artifacts.manifest = await safeCall("devtools_evidence_manifest", {
        save: true,
        artifactPaths: [
          artifacts.har?.harPath,
          artifacts.application?.exportPath,
          artifacts.trace?.tracePath,
          artifacts.bundle?.bundlePath,
          artifacts.correlationGraph?.graphPath,
          artifacts.authBoundary?.reportPath,
          artifacts.workerFrame?.reportPath,
        ].filter(Boolean),
      });
      const networkSummary = network?.evidence?.summary || {};
      const page = overview?.evidence?.diagnostics?.page || {};
      return toolResult({
        backend: "managed-cdp",
        profile: profile.name,
        generatedAt: new Date().toISOString(),
        page,
        summary: {
          url: page.url || params?.url || null,
          requestCount: networkSummary.requestCount || 0,
          failedRequestCount: networkSummary.failedRequestCount || networkSummary.errorCount || 0,
          consoleEntryCount: overview?.evidence?.console?.entryCount || overview?.evidence?.console?.entries?.length || 0,
          cookieCount: storage?.evidence?.cookies?.cookieCount ?? null,
          sourceCount: sources?.evidence?.sources?.count ?? null,
          performanceObserverEntryCount: performance?.evidence?.observer?.summary?.entryCount ?? null,
          tracePath: artifacts.trace?.tracePath || null,
          harPath: artifacts.har?.harPath || null,
          applicationExportPath: artifacts.application?.exportPath || null,
          evidenceBundlePath: artifacts.bundle?.bundlePath || null,
          evidenceManifestPath: artifacts.manifest?.manifestPath || null,
          correlationGraphPath: artifacts.correlationGraph?.graphPath || null,
          authBoundaryReportPath: artifacts.authBoundary?.reportPath || null,
          workerFrameReportPath: artifacts.workerFrame?.reportPath || null,
        },
        steps,
        evidence: {
          overview,
          network,
          storage,
          console: consoleEvidence,
          sources,
          performance,
        },
        artifacts,
        captureBoundaries: [
          "This workflow records only evidence observable after capture starts and during the reload/reproduction window.",
          "It organizes F12 evidence for security research but does not decide exploitability.",
          "Use returned requestId/scriptId/tracePath values for low-level drill-down tools.",
        ],
        nextTools: ["agent_inspect", "devtools_request_detail", "devtools_request_replay_batch", "devtools_capture_diff", "devtools_auth_boundary_report", "devtools_trace_query"],
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
        maxScreenshots: { type: "number" },
        saveScreenshots: { type: "boolean" },
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
        const traceScreenshots = params?.saveScreenshots === false
          ? []
          : extractTraceScreenshots(events, join(profile.evidenceDir, "traces", "screenshots"), { maxScreenshots: params?.maxScreenshots });
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
          traceScreenshotCount: traceScreenshots.length,
          traceScreenshots,
          traceEvents: events.slice(0, maxEvents),
          truncated: events.length > maxEvents,
          parseError,
        };
      }));
    },
  });

  tools.set("browser_trace_query", {
    name: "browser_trace_query",
    description: "Query a saved Chrome trace JSON file by event name, category, phase, duration, thread, or time range without loading the full trace into the agent context.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tracePath: { type: "string" },
        query: { type: "string" },
        name: { type: "string" },
        category: { type: "string" },
        phase: { type: "string" },
        processId: { type: "number" },
        threadId: { type: "number" },
        minDurationMs: { type: "number" },
        maxDurationMs: { type: "number" },
        startTimeMs: { type: "number" },
        endTimeMs: { type: "number" },
        sortBy: { type: "string", enum: ["duration", "timestamp", "name"] },
        limit: { type: "number" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const tracePath = params?.tracePath || findLatestTracePath(join(profile.evidenceDir, "traces"));
      if (!tracePath) throw new Error("tracePath is required and no saved trace was found for this profile");
      const traceText = readFileSync(tracePath, "utf8");
      const trace = JSON.parse(traceText);
      const events = Array.isArray(trace?.traceEvents) ? trace.traceEvents : [];
      return toolResult({
        backend: "managed-cdp",
        profile: profile.name,
        tracePath,
        traceBytes: Buffer.byteLength(traceText, "utf8"),
        ...summarizeTraceQuery(events, params || {}),
      });
    },
  });

  tools.set("browser_trace_compare", {
    name: "browser_trace_compare",
    description: "Compare two saved Chrome trace JSON files and report objective differences in event names, categories, phases, threads, and duration buckets.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        beforeTracePath: { type: "string" },
        afterTracePath: { type: "string" },
        limit: { type: "number" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      let beforeTracePath = params?.beforeTracePath;
      let afterTracePath = params?.afterTracePath;
      if (!beforeTracePath || !afterTracePath) {
        const recent = findRecentTracePaths(join(profile.evidenceDir, "traces"), 2);
        afterTracePath = afterTracePath || recent[0];
        beforeTracePath = beforeTracePath || recent[1];
      }
      if (!beforeTracePath || !afterTracePath) {
        throw new Error("beforeTracePath and afterTracePath are required, or at least two saved traces must exist for this profile");
      }
      const beforeText = readFileSync(beforeTracePath, "utf8");
      const afterText = readFileSync(afterTracePath, "utf8");
      const beforeTrace = JSON.parse(beforeText);
      const afterTrace = JSON.parse(afterText);
      const beforeEvents = Array.isArray(beforeTrace?.traceEvents) ? beforeTrace.traceEvents : [];
      const afterEvents = Array.isArray(afterTrace?.traceEvents) ? afterTrace.traceEvents : [];
      return toolResult({
        backend: "managed-cdp",
        profile: profile.name,
        beforeTracePath,
        afterTracePath,
        beforeTraceBytes: Buffer.byteLength(beforeText, "utf8"),
        afterTraceBytes: Buffer.byteLength(afterText, "utf8"),
        ...compareTraceEvents(beforeEvents, afterEvents, params || {}),
      });
    },
  });

  tools.set("browser_performance_insights", {
    name: "browser_performance_insights",
    description: "Summarize Performance panel timing, slow resources, long tasks, and optional Chrome trace evidence for agents.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        durationMs: { type: "number" },
        includeChromeTrace: { type: "boolean" },
        maxItems: { type: "number" },
        maxEvents: { type: "number" },
        maxScreenshots: { type: "number" },
        saveScreenshots: { type: "boolean" },
      },
    },
    async execute(id, params) {
      const profile = await resolveProfile(params?.profile);
      const readPayload = (result) => JSON.parse(result.content?.[0]?.text || "{}");
      const base = {
        profile: profile.name,
        tabId: params?.tabId,
        durationMs: typeof params?.durationMs === "number" ? params.durationMs : 500,
      };
      const page = readPayload(await tools.get("browser_performance_trace").execute(id, base));
      let chromeTrace = null;
      if (params?.includeChromeTrace) {
        chromeTrace = readPayload(await tools.get("browser_chrome_trace").execute(id, {
          ...base,
          maxEvents: typeof params?.maxEvents === "number" ? params.maxEvents : typeof params?.maxItems === "number" ? params.maxItems : 20,
          maxScreenshots: params?.maxScreenshots,
          saveScreenshots: params?.saveScreenshots,
        }));
      }
      return toolResult({
        backend: "managed-cdp",
        profile: profile.name,
        tabId: page.tabId || params?.tabId || profile.tabId,
        insights: summarizePerformanceInsights(page, chromeTrace, params?.maxItems || 10),
      });
    },
  });

  tools.set("browser_performance_observer", {
    name: "browser_performance_observer",
    description: "Capture browser PerformanceObserver entries such as LCP, layout shift, long tasks, event timing, and long animation frames.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        durationMs: { type: "number" },
        entryTypes: { type: "array", items: { type: "string" } },
        triggerExpression: { type: "string" },
        maxEntries: { type: "number" },
        maxItems: { type: "number" },
        durationThreshold: { type: "number" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const options = {
        durationMs: Math.min(Math.max(typeof params?.durationMs === "number" ? params.durationMs : 1000, 100), 15000),
        entryTypes: Array.isArray(params?.entryTypes) && params.entryTypes.length
          ? params.entryTypes.map(String)
          : ["navigation", "resource", "paint", "largest-contentful-paint", "layout-shift", "longtask", "event", "long-animation-frame"],
        triggerExpression: params?.triggerExpression ? String(params.triggerExpression) : "",
        maxEntries: typeof params?.maxEntries === "number" ? params.maxEntries : 500,
        durationThreshold: typeof params?.durationThreshold === "number" ? params.durationThreshold : 16,
      };
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        const result = await client.Runtime.evaluate({
          expression: `(${async (options) => {
            const startedAt = new Date().toISOString();
            const supportedEntryTypes = typeof PerformanceObserver !== "undefined" && Array.isArray(PerformanceObserver.supportedEntryTypes)
              ? PerformanceObserver.supportedEntryTypes
              : [];
            const requestedEntryTypes = Array.isArray(options.entryTypes) ? options.entryTypes : [];
            const unsupportedEntryTypes = requestedEntryTypes.filter((type) => !supportedEntryTypes.includes(type));
            const observeErrors = [];
            const entries = [];
            const observers = [];
            const nodeLabel = (node) => node ? ({
              nodeName: node.nodeName,
              id: node.id || "",
              className: typeof node.className === "string" ? node.className : "",
            }) : null;
            const rectLabel = (rect) => rect ? {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              left: rect.left,
            } : null;
            const cleanEntry = (entry) => {
              const base = entry.toJSON?.() || {};
              const out = {
                ...base,
                name: entry.name,
                entryType: entry.entryType,
                startTime: entry.startTime,
                duration: entry.duration,
              };
              if (entry.entryType === "layout-shift") {
                out.value = entry.value;
                out.hadRecentInput = entry.hadRecentInput;
                out.lastInputTime = entry.lastInputTime;
                out.sources = Array.from(entry.sources || []).map((source) => ({
                  node: nodeLabel(source.node),
                  previousRect: rectLabel(source.previousRect),
                  currentRect: rectLabel(source.currentRect),
                }));
              }
              if (entry.entryType === "largest-contentful-paint") {
                out.renderTime = entry.renderTime;
                out.loadTime = entry.loadTime;
                out.size = entry.size;
                out.id = entry.id || "";
                out.url = entry.url || "";
                out.element = nodeLabel(entry.element);
              }
              if (entry.entryType === "long-animation-frame") {
                out.blockingDuration = entry.blockingDuration;
                out.renderStart = entry.renderStart;
                out.styleAndLayoutStart = entry.styleAndLayoutStart;
                out.scripts = Array.from(entry.scripts || []).slice(0, 20).map((script) => ({
                  name: script.name,
                  duration: script.duration,
                  invoker: script.invoker,
                  invokerType: script.invokerType,
                  sourceURL: script.sourceURL,
                  sourceFunctionName: script.sourceFunctionName,
                  sourceCharPosition: script.sourceCharPosition,
                  windowAttribution: script.windowAttribution,
                }));
              }
              return JSON.parse(JSON.stringify(out));
            };
            for (const type of requestedEntryTypes) {
              if (!supportedEntryTypes.includes(type)) continue;
              try {
                const observer = new PerformanceObserver((list) => {
                  for (const entry of list.getEntries()) {
                    if (entries.length < options.maxEntries) entries.push(cleanEntry(entry));
                  }
                });
                const init = { type, buffered: true };
                if (type === "event") init.durationThreshold = options.durationThreshold;
                observer.observe(init);
                observers.push(observer);
              } catch (error) {
                observeErrors.push({ type, error: String(error?.message || error) });
              }
            }
            let triggerResult = null;
            if (options.triggerExpression) {
              try {
                triggerResult = await eval(options.triggerExpression);
              } catch (error) {
                triggerResult = { error: String(error?.message || error) };
              }
            }
            await new Promise((resolve) => setTimeout(resolve, options.durationMs));
            for (const observer of observers) observer.disconnect();
            return {
              startedAt,
              finishedAt: new Date().toISOString(),
              durationMs: options.durationMs,
              requestedEntryTypes,
              supportedEntryTypes,
              unsupportedEntryTypes,
              observeErrors,
              triggerResult,
              entries,
            };
          }})(${JSON.stringify(options)})`,
          returnByValue: true,
          awaitPromise: true,
        });
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        const snapshot = result.result?.value || {};
        return {
          backend: "managed-cdp",
          profile: profile.name,
          tabId: target.id,
          snapshot,
          summary: summarizePerformanceObserverSnapshot(snapshot, params?.maxItems || 10),
          exception: result.exceptionDetails,
        };
      }));
    },
  });

  tools.set("browser_cpu_profile", {
    name: "browser_cpu_profile",
    description: "Capture a JavaScript CPU profile from the current profile tab and save the full DevTools profile to evidence.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        durationMs: { type: "number" },
        maxNodes: { type: "number" },
        triggerExpression: { type: "string" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const durationMs = Math.min(Math.max(typeof params?.durationMs === "number" ? params.durationMs : 1000, 100), 30000);
      const maxNodes = typeof params?.maxNodes === "number" ? params.maxNodes : 20;
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        await client.Runtime.enable().catch(() => {});
        await client.Profiler.enable().catch(() => {});
        await client.Profiler.start();
        const startedAt = new Date().toISOString();
        let triggerResult = null;
        if (params?.triggerExpression) {
          triggerResult = await client.Runtime.evaluate({
            expression: String(params.triggerExpression),
            awaitPromise: true,
            returnByValue: true,
          }).catch((error) => ({ error: String(error?.message || error) }));
        }
        await sleep(durationMs);
        const stopped = await client.Profiler.stop();
        const cpuProfile = stopped.profile || {};
        const profilePath = join(profile.evidenceDir, "profiles", `${Date.now()}-cpu-profile.json`);
        mkdirSync(dirname(profilePath), { recursive: true });
        writeFileSync(profilePath, JSON.stringify(cpuProfile, null, 2), "utf8");
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          startedAt,
          finishedAt: new Date().toISOString(),
          durationMs,
          triggerResult,
          cpuProfilePath: profilePath,
          summary: summarizeCpuProfile(cpuProfile, maxNodes),
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

  tools.set("browser_coverage_detail", {
    name: "browser_coverage_detail",
    description: "Capture DevTools Coverage-panel drilldown data with raw JavaScript ranges, CSS rule usage, and bounded source snippets.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        tabId: { type: "string" },
        durationMs: { type: "number" },
        maxEntries: { type: "number" },
        maxRangesPerEntry: { type: "number" },
        maxSnippetChars: { type: "number" },
        includeSource: { type: "boolean" },
        includeUnused: { type: "boolean" },
        includeUsed: { type: "boolean" },
        urlContains: { type: "string" },
        scriptId: { type: "string" },
        styleSheetId: { type: "string" },
        reload: { type: "boolean" },
        ignoreCache: { type: "boolean" },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const durationMs = Math.min(Math.max(typeof params?.durationMs === "number" ? params.durationMs : 1000, 250), 10000);
      const maxEntries = typeof params?.maxEntries === "number" ? params.maxEntries : 50;
      const maxRangesPerEntry = typeof params?.maxRangesPerEntry === "number" ? params.maxRangesPerEntry : 20;
      const maxSnippetChars = typeof params?.maxSnippetChars === "number" ? params.maxSnippetChars : 300;
      const includeSource = params?.includeSource !== false;
      const includeUsed = params?.includeUsed !== false;
      const includeUnused = params?.includeUnused !== false;
      return toolResult(await withPageClient(cdpPort, params?.tabId || profile.tabId, async (client, target) => {
        await client.Page.enable().catch(() => {});
        await client.Debugger.enable().catch(() => {});
        await client.DOM.enable().catch(() => {});
        await client.CSS.enable().catch(() => {});
        await client.Profiler.enable().catch(() => {});
        await client.Profiler.startPreciseCoverage({ callCount: true, detailed: true });
        await client.CSS.startRuleUsageTracking().catch(() => {});
        const startedAt = new Date().toISOString();
        if (params?.reload) {
          await client.Page.reload({ ignoreCache: Boolean(params?.ignoreCache) }).catch(() => {});
        }
        await sleep(durationMs);
        const jsCoverage = await client.Profiler.takePreciseCoverage().catch((error) => ({ error: String(error?.message || error), result: [] }));
        await client.Profiler.stopPreciseCoverage().catch(() => {});
        const cssCoverage = await client.CSS.stopRuleUsageTracking().catch((error) => ({ error: String(error?.message || error), ruleUsage: [] }));
        const scriptEntries = [];
        const scripts = Array.isArray(jsCoverage.result) ? jsCoverage.result : [];
        for (const script of scripts) {
          if (params?.scriptId && String(script.scriptId) !== String(params.scriptId)) continue;
          if (params?.urlContains && !String(script.url || "").toLowerCase().includes(String(params.urlContains).toLowerCase())) continue;
          const allRanges = summarizeCoverageRanges(script.functions || [])
            .filter((range) => (range.used ? includeUsed : includeUnused));
          let sourceText = "";
          let sourceError = null;
          if (includeSource) {
            try {
              const source = await client.Debugger.getScriptSource({ scriptId: script.scriptId });
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
          if (params?.styleSheetId && String(rule.styleSheetId) !== String(params.styleSheetId)) continue;
          const used = Boolean(rule.used);
          if (used && !includeUsed) continue;
          if (!used && !includeUnused) continue;
          let snippet = null;
          let sourceError = null;
          if (includeSource) {
            try {
              let text = cssTextCache.get(rule.styleSheetId);
              if (text === undefined) {
                const sheet = await client.CSS.getStyleSheetText({ styleSheetId: rule.styleSheetId });
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
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          startedAt,
          finishedAt: new Date().toISOString(),
          durationMs,
          filters: {
            urlContains: params?.urlContains || null,
            scriptId: params?.scriptId || null,
            styleSheetId: params?.styleSheetId || null,
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

  tools.set("devtools_backend_capabilities", {
    name: "devtools_backend_capabilities",
    description: "Unified Agent DevTools API: explain current backend layer, CDP transport, supported domains, and evidence boundaries.",
    parameters: { type: "object", properties: { profile: { type: "string" } } },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      return toolResult({
        backend: "managed-cdp",
        layer: "direct-cdp",
        transport: "Chrome DevTools Protocol over remote debugging endpoint",
        cdpEndpoint: `http://127.0.0.1:${cdpPort}`,
        profile: profile.name,
        tabId: profile.tabId,
        evidenceDir: profile.evidenceDir,
        capture: profileRegistry.getCapture(profile.name),
        rawCommandTool: "devtools_cdp_command",
        rawCommandTransport: "chrome-remote-interface client.send against the selected page target",
        protocolSchemaTool: "devtools_protocol_schema",
        domainAccess: {
          mode: "direct-remote-debugging-cdp",
          expectedBroaderThanChromeDebugger: true,
          coreDomains: DIRECT_CDP_CORE_DOMAINS,
          note: "Direct CDP generally exposes the most complete browser automation/debugging surface available to this runtime. The friendly devtools_* wrappers target ordinary web-page F12 workflows; devtools_cdp_command is the escape hatch for unwrapped page-target methods.",
        },
        bestUseCases: [
          "Agent-owned browser profiles for repeatable target testing.",
          "Fuller CDP coverage than the Personal Chrome extension layer.",
          "Clean evidence capture with explicit profile-scoped traffic and artifact directories.",
        ],
        recordingSemantics: [
          "Network/Console/Security events are complete only for activity after capture starts.",
          "For repeatable evidence, run devtools_capture_start, then devtools_hard_reload or reproduce the action.",
          "If Chrome did not retain a response body or a value only lived briefly in JavaScript memory, the tool reports missing evidence instead of inventing it.",
        ],
        knownBoundaries: [
          "Chrome internal pages, browser UI, and system dialogs are outside the ordinary-web-page F12 target.",
          "Cross-origin iframe internals follow the browser security model.",
          "Some browser-process domains may need future browser-level session wrappers instead of the current page-target devtools_cdp_command.",
        ],
        companionLayer: "personal-chrome chrome.debugger",
      });
    },
  });

  async function runBrowserCdpCommand(method, commandParams = {}) {
    const versionResponse = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
    if (!versionResponse.ok) {
      throw new Error(`CDP version endpoint failed: ${versionResponse.status} ${await versionResponse.text()}`);
    }
    const version = await versionResponse.json();
    if (!version.webSocketDebuggerUrl) {
      throw new Error("CDP version endpoint did not expose webSocketDebuggerUrl");
    }
    const browserClient = await CDP({ target: version.webSocketDebuggerUrl });
    try {
      return await browserClient.send(method, commandParams && typeof commandParams === "object" ? commandParams : {});
    } finally {
      await browserClient.close().catch(() => {});
    }
  }

  tools.set("devtools_browser_cdp_command", {
    name: "devtools_browser_cdp_command",
    description: "Managed CDP only: run a raw Chrome DevTools Protocol command against the browser-process endpoint for Browser/SystemInfo/Target-level features.",
    parameters: {
      type: "object",
      properties: {
        method: { type: "string" },
        params: { type: "object" },
      },
      required: ["method"],
    },
    async execute(_id, params) {
      const method = String(params?.method || "").trim();
      if (!/^[A-Za-z0-9_.]+$/.test(method) || !method.includes(".")) {
        throw new Error("method must be a Chrome DevTools Protocol method like Browser.getVersion");
      }
      const result = await runBrowserCdpCommand(method, params?.params);
      return toolResult({
        backend: "managed-cdp",
        layer: "direct-cdp-browser-process",
        cdpEndpoint: `http://127.0.0.1:${cdpPort}`,
        method,
        result,
      });
    },
  });

  tools.set("devtools_protocol_schema", {
    name: "devtools_protocol_schema",
    description: "Managed CDP: discover Chrome DevTools Protocol domains, commands, events, and parameters exposed by the current browser.",
    parameters: {
      type: "object",
      properties: {
        domain: { type: "string" },
        query: { type: "string" },
        includeExperimental: { type: "boolean" },
        includeDeprecated: { type: "boolean" },
        limit: { type: "number" },
      },
    },
    async execute(_id, params) {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/protocol`);
      if (!response.ok) {
        throw new Error(`CDP protocol endpoint failed: ${response.status} ${await response.text()}`);
      }
      const protocol = await response.json();
      const query = String(params?.query || "").trim().toLowerCase();
      const domainFilter = String(params?.domain || "").trim().toLowerCase();
      const limit = Math.max(1, typeof params?.limit === "number" ? params.limit : 50);
      const includeExperimental = params?.includeExperimental !== false;
      const includeDeprecated = params?.includeDeprecated !== false;
      const domains = Array.isArray(protocol.domains) ? protocol.domains : [];
      const rows = [];
      for (const domain of domains) {
        if (domainFilter && String(domain.domain || "").toLowerCase() !== domainFilter) continue;
        if (!includeExperimental && domain.experimental) continue;
        if (!includeDeprecated && domain.deprecated) continue;
        const commands = Array.isArray(domain.commands) ? domain.commands : [];
        const events = Array.isArray(domain.events) ? domain.events : [];
        const types = Array.isArray(domain.types) ? domain.types : [];
        const methods = commands
          .filter((command) => includeExperimental || !command.experimental)
          .filter((command) => includeDeprecated || !command.deprecated)
          .map((command) => ({
            method: `${domain.domain}.${command.name}`,
            name: command.name,
            description: command.description || "",
            experimental: Boolean(command.experimental),
            deprecated: Boolean(command.deprecated),
            parameters: Array.isArray(command.parameters) ? command.parameters.map((param) => ({
              name: param.name,
              type: param.type || param.$ref || "object",
              optional: Boolean(param.optional),
              description: param.description || "",
            })) : [],
            returns: Array.isArray(command.returns) ? command.returns.map((param) => ({
              name: param.name,
              type: param.type || param.$ref || "object",
              optional: Boolean(param.optional),
              description: param.description || "",
            })) : [],
          }));
        const eventRows = events
          .filter((event) => includeExperimental || !event.experimental)
          .filter((event) => includeDeprecated || !event.deprecated)
          .map((event) => ({
            event: `${domain.domain}.${event.name}`,
            name: event.name,
            description: event.description || "",
            experimental: Boolean(event.experimental),
            deprecated: Boolean(event.deprecated),
            parameters: Array.isArray(event.parameters) ? event.parameters.map((param) => ({
              name: param.name,
              type: param.type || param.$ref || "object",
              optional: Boolean(param.optional),
              description: param.description || "",
            })) : [],
          }));
        const typeRows = types.map((type) => ({
          id: type.id,
          type: type.type,
          description: type.description || "",
          experimental: Boolean(type.experimental),
          deprecated: Boolean(type.deprecated),
        }));
        const haystack = JSON.stringify({ domain: domain.domain, methods, events: eventRows, types: typeRows }).toLowerCase();
        if (query && !haystack.includes(query)) continue;
        const queryMatches = (value) => !query || JSON.stringify(value).toLowerCase().includes(query);
        const outputCommands = query ? methods.filter(queryMatches) : methods;
        const outputEvents = query ? eventRows.filter(queryMatches) : eventRows;
        const outputTypes = query ? typeRows.filter(queryMatches) : typeRows;
        rows.push({
          domain: domain.domain,
          description: domain.description || "",
          experimental: Boolean(domain.experimental),
          deprecated: Boolean(domain.deprecated),
          commandCount: methods.length,
          eventCount: eventRows.length,
          typeCount: types.length,
          commands: outputCommands.slice(0, limit),
          events: outputEvents.slice(0, limit),
          types: outputTypes.slice(0, limit),
          filtered: Boolean(query),
          truncated: outputCommands.length > limit || outputEvents.length > limit || outputTypes.length > limit,
        });
      }
      return toolResult({
        backend: "managed-cdp",
        layer: "direct-cdp-protocol",
        version: protocol.version || null,
        domainCount: domains.length,
        matchedDomainCount: rows.length,
        query: query || null,
        domain: domainFilter || null,
        domains: rows,
        captureBoundaries: [
          "This reports Chrome's protocol schema, not live page evidence.",
          "Use devtools_cdp_command for page-target methods and devtools_browser_cdp_command for browser-process methods.",
          "Method availability can still depend on the selected target type and enabled domains.",
        ],
      });
    },
  });

  tools.set("devtools_browser_version", {
    name: "devtools_browser_version",
    description: "Managed CDP: return browser-process version metadata from Browser.getVersion.",
    parameters: { type: "object", properties: {} },
    async execute() {
      return toolResult({
        backend: "managed-cdp",
        layer: "direct-cdp-browser-process",
        result: await runBrowserCdpCommand("Browser.getVersion"),
      });
    },
  });

  tools.set("devtools_browser_targets", {
    name: "devtools_browser_targets",
    description: "Managed CDP: list browser targets from Target.getTargets for agent target/session discovery.",
    parameters: { type: "object", properties: {} },
    async execute() {
      const result = await runBrowserCdpCommand("Target.getTargets");
      const targets = Array.isArray(result.targetInfos) ? result.targetInfos : [];
      return toolResult({
        backend: "managed-cdp",
        layer: "direct-cdp-browser-process",
        targetCount: targets.length,
        targets,
      });
    },
  });

  tools.set("devtools_system_info", {
    name: "devtools_system_info",
    description: "Managed CDP: return browser/system information from SystemInfo.getInfo where Chrome exposes it.",
    parameters: { type: "object", properties: {} },
    async execute() {
      return toolResult({
        backend: "managed-cdp",
        layer: "direct-cdp-browser-process",
        result: await runBrowserCdpCommand("SystemInfo.getInfo"),
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
  aliasTool("devtools_realtime_log", "profile_realtime_log", "Unified Agent DevTools API: read WebSocket frames and EventSource/SSE messages.");
  aliasTool("devtools_export_har", "profile_export_har", "Unified Agent DevTools API: export captured Network events as HAR.");
  aliasTool("devtools_save_har", "profile_save_har", "Unified Agent DevTools API: save captured Network events as a HAR file.");
  aliasTool("devtools_request_body", "profile_traffic_get", "Unified Agent DevTools API: read captured request/response detail by requestId.");
  aliasTool("devtools_request_detail", "profile_request_detail", "Unified Agent DevTools API: read F12 request-detail evidence by requestId.");
  aliasTool("devtools_request_payload", "profile_request_payload", "Unified Agent DevTools API: read request payload/postData for a requestId.");
  aliasTool("devtools_request_replay", "profile_request_replay", "Unified Agent DevTools API: replay/edit-and-resend a captured request.");
  aliasTool("devtools_request_replay_batch", "profile_request_replay_batch", "Unified Agent DevTools API: replay a captured request through multiple variants and compare responses.");
  aliasTool("devtools_console_log", "browser_console_log", "Unified Agent DevTools API: read Console panel events, exceptions, and stack traces.");
  aliasTool("devtools_console_source_context", "browser_console_source_context", "Unified Agent DevTools API: read source context around a console stack frame.");
  aliasTool("devtools_security_summary", "browser_security_summary", "Unified Agent DevTools API: summarize page security context and TLS/certificate details.");
  aliasTool("devtools_page_diagnostics", "browser_page_diagnostics", "Unified Agent DevTools API: summarize page health for agent dashboards.");
  aliasTool("devtools_signal_summary", "browser_signal_summary", "Unified Agent DevTools API: summarize objective cross-panel browser signals and next drill-down tools.");
  aliasTool("devtools_issues_log", "browser_issues_log", "Unified Agent DevTools API: read Chrome DevTools Issues-panel events.");
  aliasTool("devtools_accessibility_snapshot", "browser_accessibility_snapshot", "Unified Agent DevTools API: read Accessibility panel-style AX tree.");
  aliasTool("devtools_frame_tree", "browser_frame_tree", "Unified Agent DevTools API: read frame/iframe tree.");
  aliasTool("devtools_hard_reload", "browser_hard_reload", "Unified Agent DevTools API: disable cache, bypass service worker, and reload.");
  aliasTool("devtools_storage_snapshot", "browser_storage_snapshot", "Unified Agent DevTools API: read storage and cookies.");
  aliasTool("devtools_storage_origin_summary", "browser_storage_origin_summary", "Unified Agent DevTools API: read Application-panel origin, storage key, quota, and cookie partition evidence.");
  aliasTool("devtools_cookie_summary", "browser_cookie_summary", "Unified Agent DevTools API: summarize cookie security attributes and objective attribute signals.");
  aliasTool("devtools_service_worker_summary", "browser_service_worker_summary", "Unified Agent DevTools API: summarize Service Worker registrations and CacheStorage state.");
  aliasTool("devtools_service_worker_detail", "browser_service_worker_detail", "Unified Agent DevTools API: inspect Service Worker registrations, scripts, CacheStorage entries, and worker targets.");
  aliasTool("devtools_application_export", "browser_application_export", "Unified Agent DevTools API: export Application panel data to a JSON file.");
  aliasTool("devtools_indexeddb_read", "browser_indexeddb_read", "Unified Agent DevTools API: read IndexedDB records by database and object store.");
  aliasTool("devtools_cache_entry_get", "browser_cache_entry_get", "Unified Agent DevTools API: read a CacheStorage response by cache name and URL.");
  aliasTool("devtools_elements_snapshot", "browser_elements_snapshot", "Unified Agent DevTools API: read Elements panel-style DOM tree, layout boxes, and computed style.");
  aliasTool("devtools_dom_snapshot", "browser_dom_snapshot", "Unified Agent DevTools API: read raw Chrome DOMSnapshot data.");
  aliasTool("devtools_dom_search", "browser_dom_search", "Unified Agent DevTools API: search the live DOM like Elements panel search.");
  aliasTool("devtools_event_listeners", "browser_event_listeners", "Unified Agent DevTools API: read Elements panel event listeners for a selected DOM node.");
  aliasTool("devtools_css_styles", "browser_css_styles", "Unified Agent DevTools API: read Elements panel Styles/Computed/Box Model evidence for a selected DOM node.");
  aliasTool("devtools_dom_mutation_watch", "browser_dom_mutation_watch", "Unified Agent DevTools API: watch selected-node DOM mutations as Elements-panel breakpoint evidence.");
  aliasTool("devtools_cdp_command", "browser_cdp_command", "Unified Agent DevTools API: run a raw Chrome DevTools Protocol command for unwrapped F12 features.");
  aliasTool("devtools_debugger_control", "browser_debugger_control", "Unified Agent DevTools API: use Debugger pause/resume/step/breakpoint controls and inspect paused frames/scopes.");
  aliasTool("devtools_token_flow_trace", "browser_token_flow_trace", "Unified Agent DevTools API: instrument fetch, XHR, storage, and cookies to capture token-like data flow evidence.");
  aliasTool("devtools_memory_snapshot", "browser_memory_snapshot", "Unified Agent DevTools API: read Memory/Performance Monitor counters.");
  aliasTool("devtools_sources_list", "browser_sources_list", "Unified Agent DevTools API: list parsed scripts and source maps.");
  aliasTool("devtools_source_get", "browser_source_get", "Unified Agent DevTools API: read script source by scriptId.");
  aliasTool("devtools_source_pretty_print", "browser_source_pretty_print", "Unified Agent DevTools API: pretty-print parsed JavaScript source.");
  aliasTool("devtools_source_map_metadata", "browser_source_map_metadata", "Unified Agent DevTools API: read source map reference and metadata.");
  aliasTool("devtools_global_search", "browser_global_search", "Unified Agent DevTools API: search F12 evidence surfaces for a literal query.");
  aliasTool("devtools_evidence_bundle", "browser_evidence_bundle", "Unified Agent DevTools API: export a compact objective F12 evidence bundle.");
  aliasTool("devtools_evidence_manifest", "browser_evidence_manifest", "Unified Agent DevTools API: write a manifest with evidence paths, hashes, capture metadata, and provenance.");
  aliasTool("devtools_request_correlation_graph", "browser_request_correlation_graph", "Unified Agent DevTools API: build a frame/script/request/console correlation graph from F12 evidence.");
  aliasTool("devtools_capture_diff", "browser_capture_diff", "Unified Agent DevTools API: compare before/after evidence artifacts or current captured traffic.");
  aliasTool("devtools_auth_boundary_report", "browser_auth_boundary_report", "Unified Agent DevTools API: collect objective auth boundary evidence without deciding vulnerability impact.");
  aliasTool("devtools_worker_frame_deep_dive", "browser_worker_frame_deep_dive", "Unified Agent DevTools API: inspect frame, iframe, worker, Service Worker, CacheStorage, and target boundaries.");
  aliasTool("devtools_security_research_pack", "browser_security_research_pack", "Unified Agent DevTools API: run a one-call security research evidence workflow and return artifact paths.");
  aliasTool("devtools_sources_search", "browser_sources_search", "Unified Agent DevTools API: search parsed JavaScript sources by literal query.");
  aliasTool("devtools_performance_trace", "browser_performance_trace", "Unified Agent DevTools API: capture navigation/resource/paint/long-task performance data.");
  aliasTool("devtools_chrome_trace", "browser_chrome_trace", "Unified Agent DevTools API: capture Chrome Tracing data and return a summary plus full trace path.");
  aliasTool("devtools_trace_query", "browser_trace_query", "Unified Agent DevTools API: query saved Chrome trace events by name, category, duration, thread, or time range.");
  aliasTool("devtools_trace_compare", "browser_trace_compare", "Unified Agent DevTools API: compare two saved Chrome traces by event names, categories, phases, threads, and duration buckets.");
  aliasTool("devtools_performance_insights", "browser_performance_insights", "Unified Agent DevTools API: summarize Performance panel timing, resources, long tasks, and optional trace evidence.");
  aliasTool("devtools_performance_observer", "browser_performance_observer", "Unified Agent DevTools API: capture PerformanceObserver entries such as LCP, layout shifts, long tasks, event timing, and long animation frames.");
  aliasTool("devtools_cpu_profile", "browser_cpu_profile", "Unified Agent DevTools API: capture a JavaScript CPU profile and hotspot summary.");
  aliasTool("devtools_coverage_snapshot", "browser_coverage_snapshot", "Unified Agent DevTools API: capture short JavaScript and CSS coverage data.");
  aliasTool("devtools_coverage_detail", "browser_coverage_detail", "Unified Agent DevTools API: capture Coverage-panel JavaScript/CSS range drilldown data.");
  aliasTool("devtools_token_scan", "browser_token_scan", "Unified Agent DevTools API: scan headers, payloads, storage, and cookies for token-like material.");

  tools.set("devtools_tool_catalog", {
    name: "devtools_tool_catalog",
    description: "Agent usability: list available tools by category, description, required fields, and parameter names so agents do not choose blindly.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        category: { type: "string" },
        includeBackendSpecific: { type: "boolean" },
      },
    },
    async execute(_id, params) {
      return toolResult({
        backend: "managed-cdp",
        ...devtoolsToolCatalogFromEntries([...tools.values()], params || {}),
      });
    },
  });

  tools.set("devtools_tool_help", {
    name: "devtools_tool_help",
    description: "Agent usability: return description, parameters, category, and small usage hints for one tool.",
    parameters: {
      type: "object",
      properties: {
        tool: { type: "string" },
      },
      required: ["tool"],
    },
    async execute(_id, params) {
      const name = String(params?.tool || "").trim();
      const tool = tools.get(name);
      if (!tool) throw new Error(`unknown tool: ${name}`);
      return toolResult({
        backend: "managed-cdp",
        name: tool.name,
        category: devtoolsToolCategory(tool.name),
        description: tool.description || "",
        parameters: tool.parameters || { type: "object", properties: {} },
        hints: {
          firstPass: tool.name === "agent_inspect" || tool.name === "devtools_security_research_pack",
          objectiveBoundary: "This help describes tool usage only; it does not interpret evidence.",
        },
      });
    },
  });

  tools.set("devtools_workflow_guide", {
    name: "devtools_workflow_guide",
    description: "Agent usability: return deterministic tool recipes for common browser-security research tasks.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string" },
      },
    },
    async execute(_id, params) {
      return toolResult({
        backend: "managed-cdp",
        ...devtoolsWorkflowGuide(params?.task),
      });
    },
  });

  tools.set("browser_open", {
    name: "browser_open",
    description: "Facade: open or switch a profile to a URL, then return page diagnostics. Use this instead of low-level navigation for ordinary agent work.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        url: { type: "string" },
        waitMs: { type: "number" },
      },
    },
    async execute(id, params) {
      const profileName = params?.profile || defaultProfileName;
      if (params?.url) {
        await tools.get("browser_navigate").execute(id, { profile: profileName, url: params.url, waitMs: params?.waitMs });
      } else {
        await profileRegistry.getProfile(profileName);
      }
      const diagnostics = JSON.parse((await tools.get("devtools_page_diagnostics").execute(id, { profile: profileName })).content?.[0]?.text || "{}");
      return toolResult({
        backend: "managed-cdp",
        facade: "browser_open",
        profile: profileName,
        diagnostics,
        next: ["browser_inspect", "browser_capture", "browser_security_pack"],
      });
    },
  });

  tools.set("browser_act", {
    name: "browser_act",
    description: "Facade: perform a common browser action: click, type, scroll, eval, screenshot, or snapshot.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        action: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        expression: { type: "string" },
        waitMs: { type: "number" },
      },
      required: ["action"],
    },
    async execute(id, params) {
      const action = String(params?.action || "").toLowerCase();
      const profileName = params?.profile || defaultProfileName;
      const actionTools = {
        click: "devtools_click",
        type: "devtools_type",
        scroll: "devtools_scroll",
        eval: "devtools_eval",
        screenshot: "devtools_screenshot",
        snapshot: "devtools_snapshot",
      };
      const toolName = actionTools[action];
      if (!toolName) throw new Error(`unsupported browser_act action: ${action}`);
      const result = JSON.parse((await tools.get(toolName).execute(id, { ...params, profile: profileName })).content?.[0]?.text || "{}");
      return toolResult({
        backend: "managed-cdp",
        facade: "browser_act",
        action,
        tool: toolName,
        profile: profileName,
        result,
        next: ["browser_inspect", "browser_capture"],
      });
    },
  });

  tools.set("browser_inspect", {
    name: "browser_inspect",
    description: "Facade: inspect the current page through agent_inspect. Modes: overview, network, storage, console, dom, sources, performance, search, evidence, debug.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        mode: { type: "string" },
        query: { type: "string" },
        selector: { type: "string" },
        requestId: { type: "string" },
        limit: { type: "number" },
        includeHeavy: { type: "boolean" },
      },
    },
    async execute(id, params) {
      const profileName = params?.profile || defaultProfileName;
      const focus = params?.mode || params?.focus || "overview";
      const result = JSON.parse((await tools.get("agent_inspect").execute(id, { ...params, profile: profileName, focus })).content?.[0]?.text || "{}");
      return toolResult({
        backend: "managed-cdp",
        facade: "browser_inspect",
        profile: profileName,
        mode: focus,
        result,
        next: result.nextTools || ["browser_capture", "browser_security_pack"],
      });
    },
  });

  tools.set("browser_capture", {
    name: "browser_capture",
    description: "Facade: manage F12 recording with start, stop, clear, status, or reload.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        action: { type: "string" },
        label: { type: "string" },
        clear: { type: "boolean" },
        waitMs: { type: "number" },
      },
    },
    async execute(id, params) {
      const action = String(params?.action || "status").toLowerCase();
      const profileName = params?.profile || defaultProfileName;
      const actionTools = {
        start: "devtools_capture_start",
        stop: "devtools_capture_stop",
        clear: "devtools_capture_clear",
        status: "devtools_capture_status",
        reload: "devtools_hard_reload",
        hard_reload: "devtools_hard_reload",
      };
      const toolName = actionTools[action];
      if (!toolName) throw new Error(`unsupported browser_capture action: ${action}`);
      const result = JSON.parse((await tools.get(toolName).execute(id, { ...params, profile: profileName })).content?.[0]?.text || "{}");
      return toolResult({
        backend: "managed-cdp",
        facade: "browser_capture",
        action,
        tool: toolName,
        profile: profileName,
        result,
        next: ["browser_inspect", "browser_security_pack"],
      });
    },
  });

  tools.set("browser_security_pack", {
    name: "browser_security_pack",
    description: "Facade: run the one-call objective security research evidence workflow and return saved artifact paths.",
    parameters: tools.get("devtools_security_research_pack").parameters,
    async execute(id, params) {
      const result = JSON.parse((await tools.get("devtools_security_research_pack").execute(id, { ...params, profile: params?.profile || defaultProfileName })).content?.[0]?.text || "{}");
      return toolResult({ facade: "browser_security_pack", ...result });
    },
  });

  tools.set("browser_auth_boundary", {
    name: "browser_auth_boundary",
    description: "Facade: collect objective authentication-boundary evidence: cookies, auth headers, tokens, storage, and credentialed requests.",
    parameters: tools.get("devtools_auth_boundary_report").parameters,
    async execute(id, params) {
      const result = JSON.parse((await tools.get("devtools_auth_boundary_report").execute(id, { ...params, profile: params?.profile || defaultProfileName })).content?.[0]?.text || "{}");
      return toolResult({ facade: "browser_auth_boundary", ...result });
    },
  });

  tools.set("browser_diff", {
    name: "browser_diff",
    description: "Facade: compare before/after evidence artifacts or current captured traffic.",
    parameters: tools.get("devtools_capture_diff").parameters,
    async execute(id, params) {
      const result = JSON.parse((await tools.get("devtools_capture_diff").execute(id, { ...params, profile: params?.profile || defaultProfileName })).content?.[0]?.text || "{}");
      return toolResult({ facade: "browser_diff", ...result });
    },
  });

  tools.set("browser_replay", {
    name: "browser_replay",
    description: "Facade: replay one captured request or run batch variants and compare responses.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string" },
        requestId: { type: "string" },
        variants: { type: "array", items: { type: "object" } },
      },
      required: ["requestId"],
    },
    async execute(id, params) {
      const profileName = params?.profile || defaultProfileName;
      const toolName = Array.isArray(params?.variants) && params.variants.length ? "devtools_request_replay_batch" : "devtools_request_replay";
      const result = JSON.parse((await tools.get(toolName).execute(id, { ...params, profile: profileName })).content?.[0]?.text || "{}");
      return toolResult({ backend: "managed-cdp", facade: "browser_replay", tool: toolName, profile: profileName, result });
    },
  });

  tools.set("browser_raw", {
    name: "browser_raw",
    description: "Facade: advanced escape hatch. Call one exact devtools_* tool when the big tools are not enough.",
    parameters: {
      type: "object",
      properties: {
        tool: { type: "string" },
        input: { type: "object" },
      },
      required: ["tool"],
    },
    async execute(id, params) {
      const toolName = String(params?.tool || "").trim();
      if (!toolName.startsWith("devtools_")) throw new Error("browser_raw only allows devtools_* tools");
      if (["devtools_tool_catalog", "devtools_tool_help", "devtools_workflow_guide"].includes(toolName)) throw new Error("use tool usability helpers directly");
      const target = tools.get(toolName);
      if (!target) throw new Error(`unknown devtools tool: ${toolName}`);
      const result = JSON.parse((await target.execute(id, params?.input || {})).content?.[0]?.text || "{}");
      return toolResult({ backend: "managed-cdp", facade: "browser_raw", tool: toolName, result });
    },
  });
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
