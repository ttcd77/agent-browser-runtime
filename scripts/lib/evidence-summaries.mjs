// Pure objective-evidence summarizers, extracted from agent-cdp-server.mjs
// (2026-06-06 monolith carve, behavior-preserving). No CDP, no filesystem, no
// module state: each takes already-parsed browser data and returns an objective
// view-model. Unit-tested in evidence-summaries.test.mjs.

export function looksSensitiveKey(key) {
  return /(token|secret|session|jwt|bearer|authorization|auth|cookie|csrf|xsrf|api[-_]?key|credential|password|passcode)/i.test(String(key || ""));
}

export function looksSensitiveValue(value) {
  const text = String(value || "");
  return (
    /bearer\s+[a-z0-9._~+/=-]{16,}/i.test(text) ||
    /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/.test(text) ||
    /[a-zA-Z0-9_-]{24,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}/.test(text) ||
    /(?:sk|pk|rk|sess|csrf|xsrf|token|secret|key)[-_]?[a-zA-Z0-9]{12,}/i.test(text)
  );
}

export function scanRecord(source, key, value, extra = {}) {
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

export function cookieExpiry(cookie) {
  const raw = cookie?.expires ?? cookie?.expirationDate;
  if (raw === undefined || raw === null || raw === -1) return null;
  const milliseconds = Number(raw) > 10_000_000_000 ? Number(raw) : Number(raw) * 1000;
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString();
}

export function summarizeCookies(cookies = []) {
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

export function cookiePartitionKeyLabel(cookie) {
  const key = cookie?.partitionKey;
  if (key === undefined || key === null || key === "") return "(unpartitioned)";
  if (typeof key === "string") return key;
  try {
    return JSON.stringify(key);
  } catch {
    return String(key);
  }
}

export function summarizeCookiePartitions(cookies = []) {
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

export function summarizeStorageBoundaries(frames = []) {
  const list = Array.isArray(frames) ? frames : [];
  const byOrigin = {};
  const byStorageKey = {};
  const quotaByOrigin = {};
  const usageBreakdownByType = {};
  const storageKeyErrors = [];
  const quotaErrors = [];
  let framesWithStorageKey = 0;
  let framesWithQuota = 0;
  let quotaUsageBytes = 0;
  let quotaBytes = 0;
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
      const usage = Number(frame.usageAndQuota.usage || 0);
      const quota = Number(frame.usageAndQuota.quota || 0);
      quotaUsageBytes += usage;
      quotaBytes += quota;
      quotaByOrigin[origin] = {
        usage,
        quota,
        overrideActive: frame.usageAndQuota.overrideActive ?? null,
        usageBreakdown: Array.isArray(frame.usageAndQuota.usageBreakdown) ? frame.usageAndQuota.usageBreakdown : [],
      };
      for (const item of quotaByOrigin[origin].usageBreakdown) {
        const type = item.storageType || item.type || "(unknown)";
        usageBreakdownByType[type] = (usageBreakdownByType[type] || 0) + Number(item.usage || 0);
      }
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
    quotaUsageBytes,
    quotaBytes,
    quotaByOrigin,
    usageBreakdownByType,
    storageKeyErrors,
    quotaErrors,
    incomplete: storageKeyErrors.length > 0 || quotaErrors.length > 0,
  };
}

export function summarizeStorageBuckets(storageBuckets = {}) {
  const buckets = Array.isArray(storageBuckets?.buckets) ? storageBuckets.buckets : [];
  const errors = buckets.filter((bucket) => bucket?.error).map((bucket) => ({
    name: bucket.name,
    error: bucket.error,
  }));
  let estimatedUsageBytes = 0;
  let estimatedQuotaBytes = 0;
  for (const bucket of buckets) {
    estimatedUsageBytes += Number(bucket?.estimate?.usage || 0);
    estimatedQuotaBytes += Number(bucket?.estimate?.quota || 0);
  }
  return {
    supported: Boolean(storageBuckets?.supported),
    bucketCount: buckets.length,
    names: Array.isArray(storageBuckets?.names) ? storageBuckets.names : buckets.map((bucket) => bucket.name).filter(Boolean),
    estimatedUsageBytes,
    estimatedQuotaBytes,
    errors,
    incomplete: Boolean(storageBuckets?.error) || errors.length > 0,
  };
}

export function severityRank(severity) {
  return { high: 3, medium: 2, low: 1, info: 0 }[severity] ?? 0;
}

export function buildSignalSummary({ diagnostics = {}, cookieSummary = {}, serviceWorkerSummary = {}, tokenScan = null } = {}) {
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
      nextTools: ["profile_traffic_summary", "profile_traffic_query", "profile_traffic_get"],
    });
  }
  if (network.serviceWorkerCount > 0) {
    signals.push({
      id: "network.service-worker-responses",
      severity: "info",
      panel: "Network",
      title: "Responses served by Service Worker",
      detail: `${network.serviceWorkerCount} request(s) involved Service Worker handling.`,
      nextTools: ["profile_traffic_query", "browser_service_worker_summary"],
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
      nextTools: ["browser_cookie_summary", "browser_storage_snapshot", "browser_application_export"],
    });
  }
  if (cookieSummary.insecureCount > 0 || storage.cookieSummary?.insecureCount > 0) {
    signals.push({
      id: "cookies.insecure-count",
      severity: "medium",
      panel: "Application",
      title: "Cookies without Secure flag",
      detail: `${cookieSummary.insecureCount ?? storage.cookieSummary?.insecureCount ?? 0} cookie(s) are not marked Secure.`,
      nextTools: ["browser_cookie_summary"],
    });
  }
  if (page?.isSecureContext === false) {
    signals.push({
      id: "security.insecure-context",
      severity: "high",
      panel: "Security",
      title: "Page is not a secure context",
      detail: `Current protocol is ${page.protocol || "unknown"}.`,
      nextTools: ["browser_security_summary"],
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
      nextTools: ["browser_service_worker_summary", "browser_application_export", "browser_cache_entry_get"],
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
      nextTools: ["browser_token_scan", "profile_traffic_query", "browser_storage_snapshot"],
    });
  }
  if (security?.tlsHosts && Object.keys(security.tlsHosts).length === 0 && page?.protocol === "https:") {
    signals.push({
      id: "security.no-tls-metadata",
      severity: "low",
      panel: "Security",
      title: "No TLS metadata captured yet",
      detail: "The page is HTTPS, but the current capture does not include TLS securityDetails. Start capture and hard reload for complete evidence.",
      nextTools: ["browser_capture_start", "browser_hard_reload", "browser_security_summary"],
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
