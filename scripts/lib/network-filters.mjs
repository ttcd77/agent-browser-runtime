// Pure network request-shape + filter/sort helpers, extracted from
// agent-cdp-server.mjs (2026-06-06 monolith carve, behavior-preserving). No CDP,
// no filesystem, no module state: each derives a value from a request object /
// URL or filters/sorts/limits already-captured request arrays, using only JS
// stdlib. Unit-tested in network-filters.test.mjs.

export function requestDurationMs(request) {
  if (!request?.timestamp || !request?.finishedAt) return null;
  const duration = new Date(request.finishedAt).getTime() - new Date(request.timestamp).getTime();
  return Number.isFinite(duration) ? Math.max(0, duration) : null;
}

export function hostnameForUrl(url) {
  try {
    return new URL(url).hostname || "";
  } catch {
    return "";
  }
}

export function networkDisplayName(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return `${parts.at(-1) || parsed.hostname}${parsed.search || ""}`;
  } catch {
    return String(url || "");
  }
}

export function pickFilterValue(filters = {}, ...names) {
  for (const name of names) {
    if (filters[name] !== undefined && filters[name] !== null && filters[name] !== "") return filters[name];
  }
  return undefined;
}

export function booleanFilterValue(filters = {}, ...names) {
  const value = pickFilterValue(filters, ...names);
  if (value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const lowered = String(value).toLowerCase();
  if (["true", "1", "yes"].includes(lowered)) return true;
  if (["false", "0", "no"].includes(lowered)) return false;
  return null;
}

export function headerMatches(headers = {}, filter = {}) {
  if (!filter || typeof filter !== "object") return true;
  const requestedName = String(filter.name || "").toLowerCase();
  const valueContains = filter.valueContains ?? filter.value_contains ?? filter.contains;
  for (const [name, value] of Object.entries(headers || {})) {
    if (requestedName && String(name).toLowerCase() !== requestedName) continue;
    if (valueContains !== undefined && !String(value || "").toLowerCase().includes(String(valueContains).toLowerCase())) continue;
    return true;
  }
  return false;
}

export function networkRequestMatchesFilters(entry = {}, filters = {}) {
  const urlContains = pickFilterValue(filters, "url_contains", "urlContains");
  if (urlContains && !String(entry.url || "").toLowerCase().includes(String(urlContains).toLowerCase())) return false;

  const host = pickFilterValue(filters, "hostname", "host");
  if (host && hostnameForUrl(entry.url).toLowerCase() !== String(host).toLowerCase()) return false;

  const method = pickFilterValue(filters, "method");
  if (method && String(entry.method || "").toUpperCase() !== String(method).toUpperCase()) return false;

  const status = pickFilterValue(filters, "status");
  if (typeof status === "number" && entry.status !== status) return false;

  const statusMin = pickFilterValue(filters, "status_min", "statusMin");
  if (typeof statusMin === "number" && !(Number(entry.status) >= statusMin)) return false;

  const statusMax = pickFilterValue(filters, "status_max", "statusMax");
  if (typeof statusMax === "number" && !(Number(entry.status) <= statusMax)) return false;

  const resourceType = pickFilterValue(filters, "resource_type", "resourceType", "type");
  if (resourceType && String(entry.resourceType || "").toLowerCase() !== String(resourceType).toLowerCase()) return false;

  const mimeContains = pickFilterValue(filters, "mime_contains", "mimeContains");
  if (mimeContains && !String(entry.mimeType || "").toLowerCase().includes(String(mimeContains).toLowerCase())) return false;

  const failed = booleanFilterValue(filters, "failed");
  if (failed !== null && Boolean(entry.failed || Number(entry.status) >= 400) !== failed) return false;

  const redirected = booleanFilterValue(filters, "redirected", "has_redirect", "hasRedirect");
  if (redirected !== null && Boolean(Array.isArray(entry.redirectChain) && entry.redirectChain.length) !== redirected) return false;

  const fromCache = booleanFilterValue(filters, "from_cache", "fromCache");
  if (fromCache !== null && Boolean(entry.fromDiskCache) !== fromCache) return false;

  const fromServiceWorker = booleanFilterValue(filters, "from_service_worker", "fromServiceWorker");
  if (fromServiceWorker !== null && Boolean(entry.fromServiceWorker) !== fromServiceWorker) return false;

  const hasRequestBody = booleanFilterValue(filters, "has_request_body", "hasRequestBody");
  if (hasRequestBody !== null && Boolean(entry.hasPostData || entry.postData || entry.postDataLength) !== hasRequestBody) return false;

  const hasResponseBody = booleanFilterValue(filters, "has_response_body", "hasResponseBody");
  if (hasResponseBody !== null && Boolean(entry.bodyReadable || entry.bodyText || entry.bodyPath || entry.bodyBytes) !== hasResponseBody) return false;

  const requestHeader = pickFilterValue(filters, "request_header", "requestHeader");
  if (requestHeader && !headerMatches(entry.requestHeaders, requestHeader)) return false;

  const responseHeader = pickFilterValue(filters, "response_header", "responseHeader");
  if (responseHeader && !headerMatches(entry.responseHeaders, responseHeader)) return false;

  return true;
}

export function sortNetworkRequests(rows = [], filters = {}) {
  const sortBy = pickFilterValue(filters, "sort_by", "sortBy");
  if (!sortBy) return rows;
  const direction = String(pickFilterValue(filters, "sort_dir", "sortDir") || "desc").toLowerCase() === "asc" ? 1 : -1;
  const valueFor = (entry) => {
    if (sortBy === "status") return Number(entry.status ?? -1);
    if (sortBy === "duration") return requestDurationMs(entry) ?? -1;
    if (sortBy === "size") return Number(entry.encodedDataLength ?? entry.bodyBytes ?? -1);
    if (sortBy === "start" || sortBy === "time") return Date.parse(entry.timestamp || "") || 0;
    if (sortBy === "url") return String(entry.url || "");
    if (sortBy === "method") return String(entry.method || "");
    return Date.parse(entry.timestamp || "") || 0;
  };
  return [...rows].sort((a, b) => {
    const av = valueFor(a);
    const bv = valueFor(b);
    if (typeof av === "string" || typeof bv === "string") return String(av).localeCompare(String(bv)) * direction;
    return (av - bv) * direction;
  });
}

export function filterNetworkRequests(rows = [], filters = {}) {
  return sortNetworkRequests(rows.filter((entry) => networkRequestMatchesFilters(entry, filters)), filters);
}

export function limitNetworkRequests(rows = [], filters = {}, limit = 50) {
  if (pickFilterValue(filters, "sort_by", "sortBy")) return rows.slice(0, limit);
  return rows.slice(-limit);
}
