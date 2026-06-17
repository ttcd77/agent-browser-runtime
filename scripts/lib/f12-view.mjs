// Pure F12 / DevTools view-model builders, extracted from agent-cdp-server.mjs
// (2026-06-06 monolith carve, behavior-preserving). No CDP, no filesystem, no
// module state: each operates over already-captured request / header / cookie
// data and returns an objective F12-shaped view-model using only JS stdlib plus
// already-extracted lib helpers (network-filters, initiator-summary). The one
// async builder, buildInitiatorSourceContext, takes a getScriptSource CALLBACK
// so it stays pure with respect to whoever resolves script source.
// Unit-tested in f12-view.test.mjs.

import { requestDurationMs, hostnameForUrl, networkDisplayName } from "./network-filters.mjs";
import { buildInitiatorSummary } from "./initiator-summary.mjs";

export function buildNetworkF12Columns(request = {}) {
  const url = request.url || "";
  let parsed = null;
  try { parsed = new URL(url); } catch {}
  const initiatorSummary = buildInitiatorSummary(request.initiator || null);
  const durationMs = requestDurationMs(request);
  return {
    name: networkDisplayName(url),
    url,
    method: request.method || null,
    status: request.status ?? null,
    statusText: request.statusText || null,
    type: request.resourceType || null,
    mimeType: request.mimeType || null,
    domain: parsed?.hostname || "",
    scheme: parsed?.protocol ? parsed.protocol.replace(/:$/, "") : "",
    protocol: request.protocol || null,
    initiatorType: request.initiator?.type || request.initiatorType || null,
    initiatorUrl: initiatorSummary?.url || null,
    initiatorStackDepth: initiatorSummary?.stackDepth ?? 0,
    sizeBytes: request.encodedDataLength ?? request.bodyBytes ?? null,
    transferredBytes: request.encodedDataLength ?? null,
    resourceSizeBytes: request.bodyBytes ?? null,
    timeMs: durationMs,
    startedAt: request.timestamp || null,
    responseAt: request.responseTimestamp || null,
    finishedAt: request.finishedAt || null,
    remoteAddress: request.remoteIPAddress ? `${request.remoteIPAddress}:${request.remotePort || ""}` : null,
    flags: {
      failed: Boolean(request.failed),
      redirected: Boolean(Array.isArray(request.redirectChain) && request.redirectChain.length),
      fromDiskCache: Boolean(request.fromDiskCache),
      fromServiceWorker: Boolean(request.fromServiceWorker),
      hasRequestBody: Boolean(request.hasPostData || request.postData || request.postDataLength),
      hasResponseBody: Boolean(request.bodyReadable || request.bodyText || request.bodyPath || request.bodyBytes),
    },
  };
}

export function timingPhase(timing, startKey, endKey) {
  if (!timing || typeof timing[startKey] !== "number" || typeof timing[endKey] !== "number") return null;
  if (timing[startKey] < 0 || timing[endKey] < 0) return null;
  return Math.max(0, timing[endKey] - timing[startKey]);
}

export function buildNetworkTimeline(requests, limit = 100) {
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
      f12Columns: buildNetworkF12Columns(request),
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

export function parseCookieHeader(headerValue = "") {
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

export function lowerHeaderMap(headers = {}) {
  return Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [String(key).toLowerCase(), value]));
}

export async function buildInitiatorSourceContext(getScriptSource, initiatorSummary = null, contextLines = 5) {
  const frame = (initiatorSummary?.callFrames || []).find((entry) => entry?.scriptId && Number.isFinite(entry.lineNumber));
  if (!frame) {
    return {
      available: false,
      reason: "no-script-frame",
      summary: initiatorSummary || null,
    };
  }
  try {
    const source = await getScriptSource(String(frame.scriptId));
    return {
      available: true,
      frame,
      contextLines,
      lines: sourceContextLines(source?.scriptSource || "", frame.lineNumber, contextLines),
    };
  } catch (error) {
    return {
      available: false,
      reason: "script-source-unavailable",
      frame,
      error: String(error?.message || error),
    };
  }
}

export function buildRequestF12Sections(entry = {}, cookies = []) {
  const requestHeaders = entry.requestHeaders || {};
  const responseHeaders = entry.responseHeaders || {};
  const requestHeadersLower = lowerHeaderMap(requestHeaders);
  const responseHeadersLower = lowerHeaderMap(responseHeaders);
  const timingRow = buildNetworkTimeline([entry], 1)[0] || {};
  return {
    overview: buildNetworkF12Columns(entry),
    headers: {
      general: {
        requestUrl: entry.url || "",
        requestMethod: entry.method || null,
        statusCode: entry.status ?? null,
        statusText: entry.statusText || null,
        remoteAddress: entry.remoteIPAddress ? `${entry.remoteIPAddress}:${entry.remotePort || ""}` : null,
        referrerPolicy: requestHeadersLower.referer || requestHeadersLower.referrer || null,
      },
      request: requestHeaders,
      response: responseHeaders,
      rawRequestHeadersText: entry.requestHeadersText || null,
      rawResponseHeadersText: entry.responseHeadersText || null,
    },
    payload: {
      hasPostData: Boolean(entry.hasPostData),
      postDataLength: entry.postDataLength ?? null,
      requestContentType: requestHeadersLower["content-type"] || null,
      bodyReadable: Boolean(entry.bodyReadable || entry.bodyText || entry.bodyPath),
      bodyBytes: entry.bodyBytes ?? null,
      bodyPath: entry.bodyPath || null,
      bodyBase64Encoded: Boolean(entry.bodyBase64Encoded),
    },
    cookies: {
      requestCookieHeaderPresent: Boolean(requestHeadersLower.cookie),
      responseSetCookieHeaderPresent: Boolean(responseHeadersLower["set-cookie"]),
      requestCookies: parseCookieHeader(requestHeadersLower.cookie || ""),
      setCookieHeader: responseHeadersLower["set-cookie"] || "",
      associatedCookies: entry.associatedCookies || [],
      blockedRequestCookies: entry.blockedRequestCookies || [],
      blockedResponseCookies: entry.blockedResponseCookies || [],
      browserCookiesForUrlCount: Array.isArray(cookies) ? cookies.length : 0,
    },
    timing: {
      rawTiming: entry.timing || null,
      phases: timingRow.phases || null,
      durationMs: timingRow.durationMs ?? null,
      timingSource: entry.timing ? "cdp-network-timing" : "wall-clock-capture",
    },
    initiator: {
      type: entry.initiator?.type || entry.initiatorType || null,
      summary: buildInitiatorSummary(entry.initiator || null),
    },
    redirects: {
      count: Array.isArray(entry.redirectChain) ? entry.redirectChain.length : 0,
      chain: entry.redirectChain || [],
    },
    security: {
      protocol: entry.protocol || null,
      securityDetails: entry.securityDetails || null,
      resourceIPAddressSpace: entry.resourceIPAddressSpace ?? null,
    },
    boundaries: [
      "Request detail sections mirror F12 detail tabs as objective evidence groups.",
      "Missing body, timing, cookie, or security fields mean Chrome did not expose them in the current capture.",
      "These sections do not classify the request as safe, unsafe, exploitable, or vulnerable.",
    ],
  };
}

export function sourceContextLines(sourceText, lineNumber = 0, contextLines = 5) {
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
