// Pure HTTP-replay helpers, extracted from agent-cdp-server.mjs (behavior-
// preserving monolith carve). These prepare the headers/body for a browser
// `fetch`-based request replay, describe the replay-vs-original boundary as
// objective evidence, and diff the replayed response against the captured
// original. No CDP client, no filesystem, no module state: every function takes
// plain request/response/option data and returns data, using only JS stdlib.
// Unit-tested in replay-http.test.mjs.

export function prepareReplayHeaders(rawHeaders = {}, overrides = {}) {
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
    if (lower.startsWith(":")) {
      skipped.push({ name: key, reason: "http2-pseudo-header" });
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

export function headerHas(headers, name) {
  const lower = String(name).toLowerCase();
  return Object.keys(headers || {}).some((key) => String(key).toLowerCase() === lower);
}

export function setHeaderIfMissing(headers, name, value) {
  if (!headerHas(headers, name)) headers[name] = value;
}

export function buildReplayBody(params = {}, request = {}, headers = {}) {
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

export function buildReplayBoundaryEvidence({ originalRequest = {}, replayRequest = {}, headerPrep = {}, bodyPrep = {}, includeBody = false } = {}) {
  const skippedHeaders = Array.isArray(headerPrep.skipped) ? headerPrep.skipped : [];
  const removedHeaders = Array.isArray(headerPrep.removed) ? headerPrep.removed : [];
  return {
    replayLayer: "browser-fetch",
    originalTransport: {
      url: originalRequest.url || null,
      method: originalRequest.method || null,
      protocol: originalRequest.protocol || null,
      fromDiskCache: Boolean(originalRequest.fromDiskCache),
      fromServiceWorker: Boolean(originalRequest.fromServiceWorker),
      redirected: Array.isArray(originalRequest.redirectChain) && originalRequest.redirectChain.length > 0,
    },
    replayTransport: {
      url: replayRequest.url || null,
      method: replayRequest.method || null,
      credentials: replayRequest.credentials || "include",
      redirect: "follow",
      cache: "no-store",
      includeBody: Boolean(includeBody),
      bodyKind: bodyPrep.bodyKind || "none",
    },
    headerHandling: {
      sentHeaderNames: Object.keys(replayRequest.headers || {}),
      skippedHeaders,
      skippedHeaderNames: skippedHeaders.map((entry) => entry.name),
      removedHeaders,
      forbiddenHeaderCount: skippedHeaders.length,
    },
    bodyHandling: {
      originalHasPostData: Boolean(originalRequest.hasPostData || originalRequest.postData || originalRequest.postDataLength),
      replayIncludesBody: Boolean(includeBody),
      replayBodyKind: bodyPrep.bodyKind || "none",
      replayBodyLength: includeBody ? bodyPrep.bodyLength : 0,
      contentTypeNote: bodyPrep.contentTypeNote || null,
    },
    captureBoundaries: [
      "Replay is executed with fetch inside the current browser page context, so browser-managed cookies, credentials, CORS, CSP, redirects, and forbidden-header rules still apply.",
      "This is not raw socket-level replay: TLS handshake, HTTP/2 framing, connection coalescing, proxy behavior, and browser-forbidden headers are not manually reproduced.",
      "Skipped headers are browser/API boundaries, not tool failures. Use responseDiff and captured request detail as evidence, then let the agent or human interpret impact.",
    ],
  };
}

export function headerMapLower(headers = {}) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    out[String(name).toLowerCase()] = String(value);
  }
  return out;
}

export function diffReplayResponse(originalRequest = {}, response = {}, maxBodyPreview = 500) {
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
