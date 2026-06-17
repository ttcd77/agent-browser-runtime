// Pure network / HAR / header-evidence view-model builders, extracted from
// agent-cdp-server.mjs (2026-06-06 monolith carve, behavior-preserving). No CDP,
// no filesystem, no module state: each operates over already-captured request /
// HAR / header arrays and returns an objective view-model or diff using only JS
// stdlib. Unit-tested in network-har.test.mjs.

export function requestOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

export function requestPathname(url) {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return String(url || "");
  }
}

export function requestSet(records = []) {
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

export function diffRequestSets(beforeRecords = [], afterRecords = []) {
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

export function extractHarRecords(payload = {}) {
  return payload?.har?.log?.entries?.map((entry) => ({
    method: entry.request?.method,
    url: entry.request?.url,
    status: entry.response?.status,
  })) || [];
}

export function extractBundleNetworkRecords(payload = {}) {
  const records = payload?.bundle?.networkSummary?.requests || payload?.networkSummary?.requests || payload?.requests;
  return Array.isArray(records) ? records : extractHarRecords(payload);
}

export function countBy(rows = [], keyFn = () => "") {
  const counts = {};
  for (const row of rows || []) {
    const key = keyFn(row) || "(none)";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

export function analyzeHarCompleteness(har = {}, options = {}) {
  const entries = Array.isArray(har?.log?.entries) ? har.log.entries : [];
  const phases = ["blocked", "dns", "connect", "ssl", "send", "wait", "receive"];
  const phaseAvailability = {};
  for (const phase of phases) {
    phaseAvailability[phase] = entries.filter((entry) => typeof entry.timings?.[phase] === "number" && entry.timings[phase] >= 0).length;
  }
  const bodyRows = entries.map((entry) => ({
    requestId: entry._requestId || null,
    url: entry.request?.url || "",
    method: entry.request?.method || "",
    status: entry.response?.status ?? null,
    mimeType: entry.response?.content?.mimeType || "",
    contentSize: entry.response?.content?.size ?? -1,
    bodySize: entry.response?.bodySize ?? -1,
    bodyReadable: Boolean(entry._bodyReadable),
    bodyIncluded: entry.response?.content?._bodyIncluded === true,
    bodySource: entry.response?.content?._bodySource || null,
    bodyBytes: entry.response?.content?._bodyBytes ?? null,
    bodyTruncated: entry.response?.content?._bodyTruncated === true,
    bodyUnavailable: entry.response?.content?._bodyUnavailable === true,
    bodyError: entry.response?.content?._bodyError || null,
    bodyPath: entry.response?.content?._bodyPath || null,
  }));
  const timingRows = entries.map((entry) => ({
    requestId: entry._requestId || null,
    url: entry.request?.url || "",
    time: entry.time ?? -1,
    timingSource: entry._timingSource || null,
    missingPhases: phases.filter((phase) => !(typeof entry.timings?.[phase] === "number" && entry.timings[phase] >= 0)),
  }));
  const redirectRows = entries
    .filter((entry) => entry.response?.redirectURL || (entry.response?.status >= 300 && entry.response?.status < 400))
    .map((entry) => ({
      requestId: entry._requestId || null,
      url: entry.request?.url || "",
      status: entry.response?.status ?? null,
      redirectURL: entry.response?.redirectURL || "",
    }));
  const securityRows = entries
    .filter((entry) => entry._securityDetails)
    .map((entry) => ({
      requestId: entry._requestId || null,
      url: entry.request?.url || "",
      protocol: entry._securityDetails?.protocol || null,
      subjectName: entry._securityDetails?.subjectName || null,
      issuer: entry._securityDetails?.issuer || null,
      validFrom: entry._securityDetails?.validFrom || null,
      validTo: entry._securityDetails?.validTo || null,
    }));
  const maxRows = typeof options.maxRows === "number" ? options.maxRows : 50;
  const ratio = (count, total) => total > 0 ? Number((count / total).toFixed(4)) : null;
  const total = entries.length;
  const entriesWithBody = bodyRows.filter((row) => row.bodyIncluded).length;
  const entriesWithReadableBody = bodyRows.filter((row) => row.bodyReadable).length;
  const entriesWithTotalTime = entries.filter((entry) => typeof entry.time === "number" && entry.time >= 0).length;
  const entriesWithAllTimingPhases = timingRows.filter((row) => row.missingPhases.length === 0).length;
  const entriesWithSecurityDetails = securityRows.length;
  const httpsEntries = entries.filter((entry) => {
    try { return new URL(entry.request?.url || "").protocol === "https:"; }
    catch { return false; }
  });
  const httpsEntriesWithSecurityDetails = entries.filter((entry) => {
    try { return new URL(entry.request?.url || "").protocol === "https:" && entry._securityDetails; }
    catch { return false; }
  }).length;
  const sampleEntry = (entry, extra = {}) => ({
    requestId: entry._requestId || null,
    url: entry.request?.url || "",
    method: entry.request?.method || "",
    status: entry.response?.status ?? null,
    ...extra,
  });
  const bodyMissingSamples = entries
    .filter((entry) => entry.response?.content?._bodyIncluded !== true)
    .map((entry) => sampleEntry(entry, {
      bodyReadable: Boolean(entry._bodyReadable),
      bodyUnavailable: Boolean(entry.response?.content?._bodyUnavailable),
      bodyError: entry.response?.content?._bodyError || null,
    }))
    .slice(0, maxRows);
  const timingMissingSamples = timingRows
    .filter((row) => row.missingPhases.length > 0)
    .map((row) => ({
      requestId: row.requestId,
      url: row.url,
      time: row.time,
      timingSource: row.timingSource,
      missingPhases: row.missingPhases,
    }))
    .slice(0, maxRows);
  const securityMissingSamples = entries
    .filter((entry) => {
      try { return new URL(entry.request?.url || "").protocol === "https:" && !entry._securityDetails; }
      catch { return false; }
    })
    .map((entry) => sampleEntry(entry, { evidence: "https-without-security-details" }))
    .slice(0, maxRows);
  const recommendedDrilldowns = [];
  const pushRequestDrilldown = (sample, label, why, extraInput = {}) => {
    if (!sample?.requestId) return;
    recommendedDrilldowns.push({
      label,
      tool: "profile_request_detail",
      input: { requestId: sample.requestId, ...extraInput },
      why,
    });
  };
  pushRequestDrilldown(bodyMissingSamples[0], "Inspect request with missing HAR body", "Open request detail to see body availability, capture timing, mime type, and body retrieval boundary.");
  if (bodyMissingSamples[0]?.requestId) {
    recommendedDrilldowns.push({
      label: "Try response body fetch for missing HAR body",
      tool: "profile_traffic_get",
      input: { requestId: bodyMissingSamples[0].requestId, maxBytes: options.maxBodyBytes || 2000 },
      why: "Ask Chrome for the concrete response body for this observed request; failure is returned as browser evidence.",
    });
  }
  pushRequestDrilldown(timingMissingSamples[0], "Inspect request with incomplete timing phases", "Open request detail to compare raw timing, derived phases, redirect chain, and capture boundary.");
  pushRequestDrilldown(redirectRows[0], "Inspect redirected request chain", "Open request detail for the concrete redirect chain represented in HAR.");
  pushRequestDrilldown(securityMissingSamples[0], "Inspect HTTPS request without HAR security details", "Open request detail and Security panel summary to verify what Chrome exposed for TLS metadata.");
  if (securityMissingSamples[0]) {
    recommendedDrilldowns.push({
      label: "Refresh Security panel evidence",
      tool: "browser_security_summary",
      input: {},
      why: "Collect current Security panel metadata for comparison with HAR securityDetails coverage.",
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    entryCount: total,
    includeBodies: Boolean(options.includeBodies),
    maxBodyBytes: options.maxBodyBytes ?? null,
    coverage: {
      bodiesIncluded: { present: entriesWithBody, total, ratio: ratio(entriesWithBody, total) },
      readableBodies: { present: entriesWithReadableBody, total, ratio: ratio(entriesWithReadableBody, total) },
      totalTiming: { present: entriesWithTotalTime, total, ratio: ratio(entriesWithTotalTime, total) },
      allTimingPhases: { present: entriesWithAllTimingPhases, total, ratio: ratio(entriesWithAllTimingPhases, total) },
      securityDetails: { present: entriesWithSecurityDetails, total, ratio: ratio(entriesWithSecurityDetails, total) },
      httpsSecurityDetails: { present: httpsEntriesWithSecurityDetails, total: httpsEntries.length, ratio: ratio(httpsEntriesWithSecurityDetails, httpsEntries.length) },
      redirects: { present: redirectRows.length, total, ratio: ratio(redirectRows.length, total) },
    },
    drilldownSamples: {
      bodyMissing: bodyMissingSamples,
      timingMissing: timingMissingSamples,
      securityMissing: securityMissingSamples,
      redirects: redirectRows.slice(0, maxRows),
    },
    recommendedDrilldowns,
    body: {
      readableCount: bodyRows.filter((row) => row.bodyReadable).length,
      includedCount: bodyRows.filter((row) => row.bodyIncluded).length,
      truncatedCount: bodyRows.filter((row) => row.bodyTruncated).length,
      unavailableCount: bodyRows.filter((row) => row.bodyUnavailable).length,
      erroredCount: bodyRows.filter((row) => row.bodyError).length,
      byMimeType: countBy(bodyRows, (row) => row.mimeType || "(unknown)"),
      incomplete: bodyRows.filter((row) => !row.bodyIncluded || row.bodyTruncated || row.bodyError).slice(0, maxRows),
    },
    timing: {
      entriesWithTotalTime: entries.filter((entry) => typeof entry.time === "number" && entry.time >= 0).length,
      byTimingSource: countBy(entries, (entry) => entry._timingSource || "(unknown)"),
      phaseAvailability,
      incomplete: timingRows.filter((row) => row.missingPhases.length > 0).slice(0, maxRows),
    },
    redirects: {
      count: redirectRows.length,
      entries: redirectRows.slice(0, maxRows),
    },
    security: {
      securityDetailsCount: securityRows.length,
      entries: securityRows.slice(0, maxRows),
    },
    boundaries: [
      "HAR completeness is evidence coverage metadata, not a vulnerability verdict.",
      "Response bodies require body capture/getResponseBody; absent bodies may reflect Chrome availability or capture timing.",
      "Missing timing phases mean Chrome did not expose those phases for that request, not necessarily a site issue.",
    ],
    nextTools: ["profile_request_detail", "profile_traffic_get", "profile_save_har", "browser_capture_bisect"],
  };
}

export function diffObjectKeys(before = {}, after = {}) {
  const beforeKeys = new Set(Object.keys(before || {}));
  const afterKeys = new Set(Object.keys(after || {}));
  return {
    added: [...afterKeys].filter((key) => !beforeKeys.has(key)).sort(),
    removed: [...beforeKeys].filter((key) => !afterKeys.has(key)).sort(),
    common: [...afterKeys].filter((key) => beforeKeys.has(key)).sort(),
  };
}

export function headerValue(headers = {}, name) {
  const wanted = String(name || "").toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === wanted) return value;
  }
  return undefined;
}

export function authHeaderEvidence(requests = [], limit = 50) {
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
