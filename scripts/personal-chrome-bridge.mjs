import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";

const httpPort = Number.parseInt(process.env.PERSONAL_CHROME_HTTP_PORT || "17337", 10);
const wsPort = Number.parseInt(process.env.PERSONAL_CHROME_WS_PORT || "17336", 10);
const commandTimeoutMs = Number.parseInt(process.env.PERSONAL_CHROME_COMMAND_TIMEOUT_MS || "15000", 10);
const screenshotDir = process.env.PERSONAL_CHROME_SCREENSHOT_DIR || join(process.cwd(), "tmp", "personal-chrome-screenshots");
const bodyDir = process.env.PERSONAL_CHROME_BODY_DIR || join(process.cwd(), "tmp", "personal-chrome-bodies");
const traceDir = process.env.PERSONAL_CHROME_TRACE_DIR || join(process.cwd(), "tmp", "personal-chrome-traces");
const harDir = process.env.PERSONAL_CHROME_HAR_DIR || join(process.cwd(), "tmp", "personal-chrome-har");
const captureDir = process.env.PERSONAL_CHROME_CAPTURE_DIR || join(process.cwd(), "tmp", "personal-chrome-captures");
const applicationExportDir = process.env.PERSONAL_CHROME_APPLICATION_EXPORT_DIR || join(process.cwd(), "tmp", "personal-chrome-application");
const cpuProfileDir = process.env.PERSONAL_CHROME_CPU_PROFILE_DIR || join(process.cwd(), "tmp", "personal-chrome-cpu-profiles");
const sourceMapDir = process.env.PERSONAL_CHROME_SOURCE_MAP_DIR || join(process.cwd(), "tmp", "personal-chrome-sources");
const manifestDir = process.env.PERSONAL_CHROME_MANIFEST_DIR || join(process.cwd(), "tmp", "personal-chrome-manifests");
const graphDir = process.env.PERSONAL_CHROME_GRAPH_DIR || join(process.cwd(), "tmp", "personal-chrome-graphs");
const diffDir = process.env.PERSONAL_CHROME_DIFF_DIR || join(process.cwd(), "tmp", "personal-chrome-diffs");
const authReportDir = process.env.PERSONAL_CHROME_AUTH_REPORT_DIR || join(process.cwd(), "tmp", "personal-chrome-auth");
const boundaryReportDir = process.env.PERSONAL_CHROME_BOUNDARY_REPORT_DIR || join(process.cwd(), "tmp", "personal-chrome-boundaries");
const drilldownPlanDir = process.env.PERSONAL_CHROME_DRILLDOWN_PLAN_DIR || join(process.cwd(), "tmp", "personal-chrome-drilldowns");
const researchPackDir = process.env.PERSONAL_CHROME_RESEARCH_PACK_DIR || join(process.cwd(), "tmp", "personal-chrome-research-packs");
const requestDetailDir = process.env.PERSONAL_CHROME_REQUEST_DETAIL_DIR || join(process.cwd(), "tmp", "personal-chrome-request-details");

const clients = new Map();
const pending = new Map();

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "connection": "close",
  });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function pickClient() {
  const live = [...clients.values()].filter((client) => client.ws.readyState === client.ws.OPEN);
  live.sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
  return live[0] || null;
}

function listClients() {
  return [...clients.values()].map((client) => ({
    id: client.id,
    name: client.name,
    connectedAt: client.connectedAt,
    lastSeenAt: client.lastSeenAt,
    userAgent: client.userAgent,
    extensionVersion: client.extensionVersion,
  }));
}

function normalizeCommand(toolName) {
  const aliases = {
    devtools_tabs: "chrome_tabs",
    personal_chrome_save_har: "chrome_export_har",
    devtools_extension_reload: "chrome_extension_reload",
    devtools_snapshot: "chrome_active_tab_snapshot",
    devtools_screenshot: "chrome_screenshot",
    devtools_click: "chrome_click",
    devtools_type: "chrome_type",
    devtools_scroll: "chrome_scroll",
    devtools_eval: "chrome_eval",
    devtools_attach: "chrome_devtools_attach",
    devtools_detach: "chrome_devtools_detach",
    devtools_status: "chrome_devtools_status",
    devtools_backend_capabilities: "chrome_backend_capabilities",
    devtools_protocol_schema: "chrome_protocol_schema",
    devtools_browser_cdp_command: "chrome_browser_cdp_command",
    devtools_browser_version: "chrome_browser_version",
    devtools_browser_targets: "chrome_browser_targets",
    devtools_system_info: "chrome_system_info",
    devtools_capture_start: "chrome_capture_start",
    devtools_capture_stop: "chrome_capture_stop",
    devtools_capture_clear: "chrome_capture_clear",
    devtools_capture_status: "chrome_capture_status",
    devtools_network_log: "chrome_network_log",
    devtools_network_summary: "chrome_network_summary",
    devtools_network_timeline: "chrome_network_timeline",
    devtools_realtime_log: "chrome_realtime_log",
    devtools_capture_bisect: "chrome_capture_bisect",
    devtools_export_har: "chrome_export_har",
    devtools_save_har: "chrome_export_har",
    devtools_har_completeness: "chrome_har_completeness",
    devtools_request_body: "chrome_request_body",
    devtools_request_detail: "chrome_request_detail",
    devtools_request_payload: "chrome_request_payload",
    devtools_request_replay: "chrome_request_replay",
    devtools_request_replay_batch: "chrome_request_replay_batch",
    devtools_console_log: "chrome_console_log",
    devtools_console_source_context: "chrome_console_source_context",
    devtools_security_summary: "chrome_security_summary",
    devtools_page_diagnostics: "chrome_page_diagnostics",
    devtools_signal_summary: "chrome_signal_summary",
    devtools_issues_log: "chrome_issues_log",
    devtools_accessibility_snapshot: "chrome_accessibility_snapshot",
    devtools_frame_tree: "chrome_frame_tree",
    devtools_hard_reload: "chrome_hard_reload",
    devtools_storage_snapshot: "chrome_storage_snapshot",
    devtools_storage_origin_summary: "chrome_storage_origin_summary",
    devtools_cookie_summary: "chrome_cookie_summary",
    devtools_service_worker_summary: "chrome_service_worker_summary",
    devtools_service_worker_detail: "chrome_service_worker_detail",
    devtools_application_export: "chrome_application_export",
    devtools_indexeddb_list: "chrome_indexeddb_list",
    devtools_indexeddb_read: "chrome_indexeddb_read",
    devtools_cache_storage_list: "chrome_cache_storage_list",
    devtools_cache_entry_get: "chrome_cache_entry_get",
    devtools_elements_snapshot: "chrome_elements_snapshot",
    devtools_dom_snapshot: "chrome_dom_snapshot",
    devtools_dom_search: "chrome_dom_search",
    devtools_event_listeners: "chrome_event_listeners",
    devtools_css_styles: "chrome_css_styles",
    devtools_dom_mutation_watch: "chrome_dom_mutation_watch",
    devtools_cdp_command: "chrome_cdp_command",
    devtools_debugger_control: "chrome_debugger_control",
    devtools_token_flow_trace: "chrome_token_flow_trace",
    devtools_memory_snapshot: "chrome_memory_snapshot",
    devtools_sources_list: "chrome_sources_list",
    devtools_source_get: "chrome_source_get",
    devtools_source_pretty_print: "chrome_source_pretty_print",
    devtools_source_map_metadata: "chrome_source_map_metadata",
    devtools_source_map_sources: "chrome_source_map_sources",
    devtools_source_map_source_get: "chrome_source_map_source_get",
    devtools_global_search: "chrome_global_search",
    devtools_evidence_bundle: "chrome_evidence_bundle",
    devtools_evidence_manifest: "chrome_evidence_manifest",
    devtools_request_correlation_graph: "chrome_request_correlation_graph",
    devtools_capture_diff: "chrome_capture_diff",
    devtools_auth_boundary_report: "chrome_auth_boundary_report",
    devtools_worker_frame_deep_dive: "chrome_worker_frame_deep_dive",
    devtools_sources_search: "chrome_sources_search",
    devtools_performance_trace: "chrome_performance_trace",
    devtools_performance_insights: "chrome_performance_insights",
    devtools_performance_observer: "chrome_performance_observer",
    devtools_chrome_trace: "chrome_chrome_trace",
    devtools_trace_query: "chrome_trace_query",
    devtools_trace_compare: "chrome_trace_compare",
    devtools_cpu_profile: "chrome_cpu_profile",
    devtools_coverage_snapshot: "chrome_coverage_snapshot",
    devtools_coverage_detail: "chrome_coverage_detail",
    devtools_token_scan: "chrome_token_scan",
  };
  if (aliases[toolName]) return aliases[toolName];
  return toolName.replace(/^personal_/, "");
}

function callExtension(command, params = {}) {
  const client = pickClient();
  if (!client) {
    throw new Error("no personal Chrome extension is connected");
  }

  const id = randomUUID();
  const payload = { type: "command", id, command, params };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`personal Chrome command timed out: ${command}`));
    }, commandTimeoutMs);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    client.ws.send(JSON.stringify(payload));
  });
}

function persistScreenshot(result, params = {}) {
  if (!result?.dataUrl?.startsWith("data:image/png;base64,")) return result;
  const path = params.path || join(screenshotDir, `${Date.now()}.png`);
  mkdirSync(dirname(path), { recursive: true });
  const base64 = result.dataUrl.slice("data:image/png;base64,".length);
  writeFileSync(path, Buffer.from(base64, "base64"));
  const { dataUrl, ...rest } = result;
  return {
    ...rest,
    path,
    dataUrlBytes: Buffer.byteLength(dataUrl, "utf8"),
  };
}

function persistResponseBody(result, params = {}) {
  if (!result || typeof result.body !== "string" || !result.request?.requestId) return result;
  const extension = result.base64Encoded ? "bin" : "txt";
  const safeRequestId = String(result.request.requestId).replace(/[^a-zA-Z0-9_.-]/g, "_");
  const path = params.path || join(bodyDir, `${safeRequestId}.${extension}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, result.base64Encoded ? Buffer.from(result.body, "base64") : result.body, result.base64Encoded ? undefined : "utf8");
  return {
    ...result,
    bodyPath: path,
    bodyBytes: result.base64Encoded ? Buffer.from(result.body, "base64").length : Buffer.byteLength(result.body || "", "utf8"),
  };
}

function persistChromeTrace(result, params = {}) {
  if (!result || typeof result.traceText !== "string") return result;
  const path = params.path || join(traceDir, `${Date.now()}-chrome-trace.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, result.traceText, "utf8");
  const traceScreenshots = params.saveScreenshots === false
    ? []
    : persistTraceScreenshots(result.traceText, params);
  const { traceText, ...rest } = result;
  return {
    ...rest,
    tracePath: path,
    traceTextBytes: Buffer.byteLength(traceText, "utf8"),
    traceScreenshotCount: traceScreenshots.length,
    traceScreenshots,
  };
}

function persistTraceScreenshots(traceText, params = {}) {
  const maxScreenshots = Math.max(0, Number(params.maxScreenshots || 5));
  if (!maxScreenshots || !traceText) return [];
  let trace = null;
  try {
    trace = JSON.parse(traceText);
  } catch {
    return [];
  }
  const events = Array.isArray(trace?.traceEvents) ? trace.traceEvents : [];
  const directory = params.screenshotDir || join(traceDir, "screenshots");
  mkdirSync(directory, { recursive: true });
  const frames = [];
  for (const event of events) {
    if (frames.length >= maxScreenshots) break;
    const name = String(event?.name || "");
    const snapshot = event?.args?.snapshot;
    if (!name.toLowerCase().includes("screenshot") || typeof snapshot !== "string" || !snapshot) continue;
    const safeTs = String(event.ts || Date.now()).replace(/[^a-zA-Z0-9_.-]/g, "_");
    const screenshotPath = join(directory, `${safeTs}-trace-screenshot.jpg`);
    const bytes = Buffer.from(snapshot, "base64");
    writeFileSync(screenshotPath, bytes);
    frames.push({
      path: screenshotPath,
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
  return {
    names: countMap((event) => event.name),
    categories: countMap((event) => String(event.cat || "").split(",")[0]),
    phases: countMap((event) => event.ph),
    threads: countMap((event) => `${event.pid}:${event.tid}`),
    durationsByName: countMap((event) => event.name, (event) => Number(event.dur || 0) / 1000),
  };
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

function traceTimeRangeMs(events = []) {
  const timestamps = events.map((event) => Number(event.ts)).filter(Number.isFinite);
  if (!timestamps.length) return null;
  return Math.round(((Math.max(...timestamps) - Math.min(...timestamps)) / 1000) * 100) / 100;
}

function compareTraceEvents(beforeEvents = [], afterEvents = [], params = {}) {
  const limit = Math.max(1, Math.min(typeof params.limit === "number" ? params.limit : 25, 500));
  const before = traceProfile(beforeEvents);
  const after = traceProfile(afterEvents);
  const beforeRange = traceTimeRangeMs(beforeEvents);
  const afterRange = traceTimeRangeMs(afterEvents);
  return {
    before: {
      eventCount: beforeEvents.length,
      timeRangeMs: beforeRange,
    },
    after: {
      eventCount: afterEvents.length,
      timeRangeMs: afterRange,
    },
    deltas: {
      eventCount: afterEvents.length - beforeEvents.length,
      timeRangeMs: afterRange != null && beforeRange != null ? Math.round((afterRange - beforeRange) * 100) / 100 : null,
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
  const timestamps = events.map((event) => Number(event.ts)).filter(Number.isFinite);
  const minTs = Math.min(...timestamps);
  const maxTs = Math.max(...timestamps);
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
  const traceRow = (event) => ({
    name: event.name || "",
    category: event.cat || "",
    phase: event.ph || "",
    processId: event.pid,
    threadId: event.tid,
    timestampUs: event.ts,
    relativeStartMs: Number.isFinite(minTs) && Number.isFinite(Number(event.ts)) ? Math.round(((Number(event.ts) - minTs) / 1000) * 100) / 100 : null,
    durationMs: Math.round((Number(event.dur || 0) / 1000) * 100) / 100,
    args: event.args || {},
  });
  const returnedEvents = sorted.slice(0, limit).map(traceRow);
  const contextEventCount = Math.max(0, Math.min(typeof params.contextEvents === "number" ? params.contextEvents : 2, 10));
  const contextWindowCount = Math.max(0, Math.min(typeof params.contextWindows === "number" ? params.contextWindows : 3, 10));
  const chronological = [...events].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
  const threadKey = (event) => `${event.pid ?? "?"}:${event.tid ?? "?"}`;
  const sameThreadWindow = (target) => {
    const targetTs = Number(target.ts);
    const threadEvents = chronological.filter((event) => threadKey(event) === threadKey(target));
    const index = threadEvents.findIndex((event) => event === target || (event.ts === target.ts && event.name === target.name && event.dur === target.dur));
    const safeIndex = index < 0 ? 0 : index;
    const start = Math.max(0, safeIndex - contextEventCount);
    const end = Math.min(threadEvents.length, safeIndex + contextEventCount + 1);
    return {
      target: traceRow(target),
      thread: threadKey(target),
      sameThreadEventCount: threadEvents.length,
      before: threadEvents.slice(start, safeIndex).map(traceRow),
      after: threadEvents.slice(safeIndex + 1, end).map(traceRow),
      windowStartRelativeMs: Number.isFinite(minTs) && Number.isFinite(targetTs) ? Math.round(((threadEvents[start]?.ts - minTs) / 1000) * 100) / 100 : null,
      windowEndRelativeMs: Number.isFinite(minTs) && Number.isFinite(targetTs) ? Math.round(((threadEvents[end - 1]?.ts - minTs) / 1000) * 100) / 100 : null,
    };
  };
  const contextWindows = contextEventCount > 0
    ? sorted.slice(0, contextWindowCount).map(sameThreadWindow)
    : [];
  const tracePath = params.tracePath || "<trace-path>";
  const firstReturned = returnedEvents[0] || null;
  const recommendedDrilldowns = [];
  if (firstReturned) {
    recommendedDrilldowns.push({
      label: "Query same trace thread",
      tool: "devtools_trace_query",
      input: {
        tracePath,
        processId: firstReturned.processId,
        threadId: firstReturned.threadId,
        sortBy: "timestamp",
        limit,
        contextEvents: contextEventCount,
      },
      why: "Stay on the same process/thread as the selected event and inspect neighboring trace events chronologically.",
    });
    recommendedDrilldowns.push({
      label: "Query same trace event name",
      tool: "devtools_trace_query",
      input: { tracePath, name: firstReturned.name, limit },
      why: "Find other occurrences of the same Chrome trace event name in this capture.",
    });
    if (typeof firstReturned.relativeStartMs === "number") {
      recommendedDrilldowns.push({
        label: "Query narrow time window around event",
        tool: "devtools_trace_query",
        input: {
          tracePath,
          startTimeMs: Math.max(0, firstReturned.relativeStartMs - 25),
          endTimeMs: firstReturned.relativeStartMs + Math.max(25, firstReturned.durationMs || 0) + 25,
          sortBy: "timestamp",
          limit,
        },
        why: "Inspect all trace events near the selected event's timestamp without implying causality.",
      });
    }
  }
  recommendedDrilldowns.push({
    label: "Capture fresh trace around smallest reproduction",
    tool: "devtools_chrome_trace",
    input: { durationMs: 1000, maxEvents: limit },
    why: "If the saved trace window is incomplete, capture a new bounded trace around a smaller browser action.",
  });
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
    contextWindows,
    recommendedDrilldowns,
    drilldown: {
      contextEventsPerSide: contextEventCount,
      contextWindowCount: contextWindows.length,
      contextWindowBasis: "same-thread chronological trace events around the first returned matches",
      nextQueries: [
        "Narrow by threadId/processId from a context window.",
        "Use minDurationMs to focus on long events.",
        "Use name/category filters from topNames/categoryCounts for a smaller window.",
      ],
    },
    captureBoundaries: [
      "This reads a saved Chrome trace JSON file; it cannot recover trace events that were not captured.",
      "Durations are reported from Chrome trace event dur fields when present.",
      "Context windows are same-thread neighboring events, not causal proof.",
      "Use devtools_chrome_trace around the smallest reproducible action before querying.",
    ],
  };
}

function traceQuery(params = {}) {
  const tracePath = params.tracePath || findLatestTracePath(traceDir);
  if (!tracePath) throw new Error("tracePath is required and no saved personal Chrome trace was found");
  const traceText = readFileSync(tracePath, "utf8");
  const trace = JSON.parse(traceText);
  const events = Array.isArray(trace?.traceEvents) ? trace.traceEvents : [];
  return {
    backend: "personal-chrome",
    tracePath,
    traceBytes: Buffer.byteLength(traceText, "utf8"),
    ...summarizeTraceQuery(events, params),
  };
}

function traceCompare(params = {}) {
  let beforeTracePath = params.beforeTracePath;
  let afterTracePath = params.afterTracePath;
  if (!beforeTracePath || !afterTracePath) {
    const recent = findRecentTracePaths(traceDir, 2);
    afterTracePath = afterTracePath || recent[0];
    beforeTracePath = beforeTracePath || recent[1];
  }
  if (!beforeTracePath || !afterTracePath) {
    throw new Error("beforeTracePath and afterTracePath are required, or at least two saved personal Chrome traces must exist");
  }
  const beforeText = readFileSync(beforeTracePath, "utf8");
  const afterText = readFileSync(afterTracePath, "utf8");
  const beforeTrace = JSON.parse(beforeText);
  const afterTrace = JSON.parse(afterText);
  const beforeEvents = Array.isArray(beforeTrace?.traceEvents) ? beforeTrace.traceEvents : [];
  const afterEvents = Array.isArray(afterTrace?.traceEvents) ? afterTrace.traceEvents : [];
  return {
    backend: "personal-chrome",
    beforeTracePath,
    afterTracePath,
    beforeTraceBytes: Buffer.byteLength(beforeText, "utf8"),
    afterTraceBytes: Buffer.byteLength(afterText, "utf8"),
    ...compareTraceEvents(beforeEvents, afterEvents, params),
  };
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function truncateText(text, maxChars = 120000) {
  const value = String(text || "");
  const limit = Math.max(0, Number(maxChars) || 0);
  if (!limit || value.length <= limit) return { text: value, truncated: false };
  return { text: value.slice(0, limit), truncated: true };
}

function pathInsideRoot(file, rootDir) {
  const target = resolve(file);
  const rootPath = resolve(rootDir);
  const normalizedTarget = process.platform === "win32" ? target.toLowerCase() : target;
  const normalizedRoot = process.platform === "win32" ? rootPath.toLowerCase() : rootPath;
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${sep}`);
}

function readSourceMapArtifact(file, maxChars = 120000) {
  if (!file) throw new Error("path is required");
  if (!pathInsideRoot(file, sourceMapDir)) {
    throw new Error(`source artifact path is outside the Personal Chrome source-map evidence directory: ${file}`);
  }
  if (!existsSync(file)) throw new Error(`source artifact path does not exist: ${file}`);
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error(`source artifact path is not a file: ${file}`);
  const text = readFileSync(file, "utf8");
  const limited = truncateText(text, maxChars);
  return {
    path: file,
    bytes: stat.size,
    sha256: sha256File(file),
    contentText: limited.text,
    truncated: limited.truncated,
    contentBytes: Buffer.byteLength(text, "utf8"),
  };
}

function listFiles(rootDir, maxFiles = 200) {
  const out = [];
  const walk = (dir) => {
    if (out.length >= maxFiles || !existsSync(dir)) return;
    for (const name of readdirSync(dir).sort().reverse()) {
      if (out.length >= maxFiles) break;
      const file = join(dir, name);
      let stat;
      try { stat = statSync(file); }
      catch { continue; }
      if (stat.isDirectory()) {
        walk(file);
        continue;
      }
      out.push({
        path: file,
        relativePath: file.slice(rootDir.length).replace(/^[/\\]/, ""),
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        sha256: stat.size <= 25_000_000 ? sha256File(file) : null,
        hashSkipped: stat.size > 25_000_000,
      });
    }
  };
  walk(rootDir);
  return out;
}

function personalArtifactRoots() {
  return [
    screenshotDir,
    bodyDir,
    traceDir,
    harDir,
    captureDir,
    applicationExportDir,
    cpuProfileDir,
    sourceMapDir,
    manifestDir,
    graphDir,
    diffDir,
    authReportDir,
    boundaryReportDir,
    drilldownPlanDir,
    researchPackDir,
    requestDetailDir,
  ].filter(existsSync);
}

function readJsonFile(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function findTextMatches(text, query, options = {}) {
  const haystack = String(text || "");
  const needle = String(query || "");
  if (!needle) return [];
  const caseSensitive = Boolean(options.caseSensitive);
  const source = caseSensitive ? haystack : haystack.toLowerCase();
  const target = caseSensitive ? needle : needle.toLowerCase();
  const maxMatches = Math.max(0, Number(options.maxMatches) || 20);
  const contextChars = Math.max(0, Number(options.contextChars) || 160);
  const out = [];
  let offset = 0;
  while (out.length < maxMatches) {
    const index = source.indexOf(target, offset);
    if (index < 0) break;
    const start = Math.max(0, index - contextChars);
    const end = Math.min(haystack.length, index + needle.length + contextChars);
    out.push({
      index,
      match: haystack.slice(index, index + needle.length),
      before: haystack.slice(start, index),
      after: haystack.slice(index + needle.length, end),
      context: haystack.slice(start, end),
    });
    offset = index + Math.max(1, target.length);
  }
  return out;
}

function summarizeResearchPackHandoff(parsed) {
  if (!parsed || typeof parsed !== "object" || parsed.schema !== "agent-browser-runtime.security-research-pack-handoff.v1") return null;
  const summary = parsed.summary || {};
  const agentEntryPoints = parsed.agentEntryPoints || {};
  const agentUsage = parsed.agentUsage || {};
  const artifactPaths = parsed.artifactPaths || {};
  const handoffCompleteness = parsed.handoffCompleteness || {};
  const artifactCoverage = parsed.artifactCoverage || {};
  const f12Navigation = parsed.f12Navigation || {};
  const firstF12RequestDetail = parsed.firstF12RequestDetail || null;
  return {
    schema: parsed.schema,
    backend: parsed.backend || null,
    generatedAt: parsed.generatedAt || null,
    profile: parsed.profile || null,
    url: summary.url || parsed.page?.url || null,
    ready: Boolean(handoffCompleteness.ready && artifactCoverage.ready !== false),
    handoffReady: handoffCompleteness.ready ?? null,
    artifactCoverageReady: artifactCoverage.ready ?? null,
    handoffMissing: handoffCompleteness.missing || summary.handoffMissing || [],
    handoffChecks: Array.isArray(handoffCompleteness.checks) ? handoffCompleteness.checks.map((check) => ({
      name: check.name,
      present: Boolean(check.present),
      evidence: check.evidence ?? null,
    })) : [],
    artifactCoverageMissing: artifactCoverage.missing || summary.artifactCoverageMissing || [],
    artifactCoverageSkipped: artifactCoverage.skipped || summary.artifactCoverageSkipped || [],
    artifactCoverageRows: Array.isArray(artifactCoverage.rows) ? artifactCoverage.rows.map((row) => ({
      name: row.name,
      status: row.status,
      requested: Boolean(row.requested),
      path: row.path || null,
    })) : [],
    agentEntryMode: agentEntryPoints.defaultMode || null,
    recommendedFirstCall: agentEntryPoints.recommendedFirstCall || null,
    professionalPath: agentEntryPoints.professionalPath || [],
    drilldownRule: agentEntryPoints.drilldownRule || null,
    recommendedRoute: Array.isArray(agentUsage.recommendedRoute) ? agentUsage.recommendedRoute : (Array.isArray(agentUsage.defaultRoute) ? agentUsage.defaultRoute : []),
    panelRoutes: agentUsage.panelRoutes || null,
    f12Navigation: f12Navigation && typeof f12Navigation === "object" ? {
      schema: f12Navigation.schema || null,
      requestNodeCount: f12Navigation.requestNodeCount ?? null,
      firstRequest: f12Navigation.firstRequest || null,
      firstDetailRoute: Array.isArray(f12Navigation.requests) ? f12Navigation.requests.find((row) => row?.detail)?.detail || null : null,
      requestDrilldowns: Array.isArray(f12Navigation.requests) ? f12Navigation.requests.filter((row) => row?.detail).slice(0, 5).map((row) => ({
        label: row.label || row.f12Columns?.name || row.url || row.requestId || "request detail",
        tool: row.detail.tool,
        input: row.detail.input || {},
        requestId: row.requestId || null,
        f12Columns: row.f12Columns || null,
      })) : [],
      artifacts: f12Navigation.artifacts || null,
      sectionRoutes: f12Navigation.sectionRoutes || null,
      boundaries: f12Navigation.boundaries || [],
    } : null,
    firstF12RequestDetail,
    drilldownCount: parsed.drilldownPlan?.count ?? summary.drilldownCount ?? null,
    firstDrilldowns: (parsed.drilldownPlan?.drilldowns || []).slice(0, 5).map((entry) => ({
      label: entry.label,
      tool: entry.tool,
      input: entry.input,
    })),
    artifactPaths,
    nextTools: parsed.nextTools || [],
    nextRead: summary.researchPackPath ? {
      tool: "devtools_artifact_read",
      input: { path: summary.researchPackPath, mode: "line", startLine: 1, lineCount: 160 },
    } : null,
    objectiveBoundary: "This handoff summary checks saved evidence-pack structure and routes only; it does not judge vulnerabilities or security impact.",
  };
}

function inspectArtifactFile(params = {}) {
  const artifactPath = params.path || params.artifactPath;
  if (!artifactPath) throw new Error("path is required");
  const file = resolve(String(artifactPath));
  const maxBytes = Math.max(1, Math.min(Number(params.maxBytes) || 120000, 2_000_000));
  const maxMatches = Math.max(0, Math.min(Number(params.maxMatches) || 20, 200));
  const contextChars = Math.max(0, Math.min(Number(params.contextChars) || 160, 2000));
  const query = params.query == null ? "" : String(params.query);
  if (!existsSync(file)) {
    return {
      schema: "agent-browser-runtime.artifact-inspect.v1",
      backend: "personal-chrome",
      path: String(artifactPath),
      resolvedPath: file,
      exists: false,
      boundaries: ["This tool reads local evidence artifacts only; it does not interpret findings."],
    };
  }
  const stat = statSync(file);
  const out = {
    schema: "agent-browser-runtime.artifact-inspect.v1",
    backend: "personal-chrome",
    path: String(artifactPath),
    resolvedPath: file,
    exists: true,
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    sha256: stat.isFile() && stat.size <= 25_000_000 ? sha256File(file) : null,
    hashSkipped: stat.isFile() && stat.size > 25_000_000,
    readLimitBytes: maxBytes,
    boundaries: [
      "This is bounded local artifact inspection for agent drill-down.",
      "It returns structure, previews, and literal matches; it does not decide vulnerability impact.",
      "If an artifact was not captured earlier, this tool cannot reconstruct missing browser events.",
    ],
    nextTools: ["devtools_artifact_inspect path=<artifact> query=<literal>", "devtools_evidence_manifest", "devtools_global_search"],
  };
  if (!stat.isFile()) return out;

  const ext = file.toLowerCase().split(".").pop() || "";
  const textLike = new Set(["json", "har", "txt", "log", "md", "html", "htm", "js", "mjs", "ts", "css", "csv", "xml", "yml", "yaml", "map", "svg"]);
  const buffer = readFileSync(file);
  const previewBuffer = buffer.subarray(0, Math.min(buffer.length, maxBytes));
  const text = previewBuffer.toString("utf8");
  out.previewBytes = previewBuffer.length;
  out.previewTruncated = buffer.length > previewBuffer.length;
  out.kind = textLike.has(ext) || !text.includes("\u0000") ? "text" : "binary";
  if (out.kind !== "text") return out;

  const lines = text.split(/\r?\n/);
  out.previewText = text;
  out.previewLineCount = lines.length;
  out.firstLines = lines.slice(0, Math.min(20, lines.length));
  out.lastLines = lines.slice(Math.max(0, lines.length - 20));

  if (["json", "har", "map"].includes(ext) && buffer.length <= Math.max(maxBytes, 2_000_000)) {
    try {
      const parsed = JSON.parse(buffer.toString("utf8"));
      out.json = {
        ok: true,
        topLevelType: Array.isArray(parsed) ? "array" : typeof parsed,
        keys: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed).slice(0, 80) : [],
        arrayLength: Array.isArray(parsed) ? parsed.length : null,
        harEntryCount: Array.isArray(parsed?.log?.entries) ? parsed.log.entries.length : null,
        traceEventCount: Array.isArray(parsed?.traceEvents) ? parsed.traceEvents.length : null,
      };
      const handoff = summarizeResearchPackHandoff(parsed);
      if (handoff) {
        out.researchPackHandoff = handoff;
        out.nextTools = [
          "devtools_artifact_read path=<researchPackPath> mode=line",
          "devtools_artifact_inspect path=<drilldownPlanPath>",
          "devtools_artifact_index kind=<artifact-kind>",
          ...handoff.nextTools,
        ];
      }
    } catch (error) {
      out.json = { ok: false, error: String(error?.message || error) };
    }
  } else if (["json", "har", "map"].includes(ext)) {
    out.json = { ok: false, skipped: true, reason: "artifact exceeds bounded JSON parse limit" };
  }

  if (query) {
    const searchText = buffer.length <= 5_000_000 ? buffer.toString("utf8") : text;
    out.matches = findTextMatches(searchText, query, {
      caseSensitive: Boolean(params.caseSensitive),
      maxMatches,
      contextChars,
    });
    out.matchCount = out.matches.length;
    out.searchTruncated = buffer.length > 5_000_000;
  }
  return out;
}

function inferArtifactKind(file) {
  const value = String(file || "").replace(/\\/g, "/").toLowerCase();
  const ext = value.split(".").pop() || "";
  if (ext === "har" || value.includes("har")) return "har";
  if (value.includes("trace")) return "trace";
  if (value.includes("screenshots") || ["png", "jpg", "jpeg", "webp"].includes(ext)) return "screenshot";
  if (value.includes("application")) return "application";
  if (value.includes("drilldown")) return "drilldown-plan";
  if (value.includes("research-pack")) return "research-pack";
  if (value.includes("capture") || value.includes("f12-evidence") || value.includes("bundle")) return "bundle";
  if (value.includes("manifest")) return "manifest";
  if (value.includes("graph")) return "graph";
  if (value.includes("diff")) return "diff";
  if (value.includes("auth-boundary") || value.includes("auth")) return "auth-boundary";
  if (value.includes("boundary") || value.includes("worker-frame")) return "boundary";
  if (value.includes("request-detail")) return "request-detail";
  if (value.includes("cpu-profile")) return "cpu-profile";
  if (value.includes("source-map") || value.includes("sources")) return "source-map";
  if (value.includes("body")) return "body";
  if (ext === "json") return "json";
  if (["txt", "log", "md", "html", "js", "mjs", "ts", "css", "csv", "xml", "yml", "yaml", "map"].includes(ext)) return "text";
  return "other";
}

function buildArtifactIndex(files = [], params = {}) {
  const query = String(params.query || "").trim().toLowerCase();
  const kindFilter = String(params.kind || "").trim().toLowerCase();
  const maxFiles = Math.max(1, Math.min(Number(params.maxFiles) || 200, 2000));
  const minBytes = Number.isFinite(Number(params.minBytes)) ? Number(params.minBytes) : null;
  const maxBytes = Number.isFinite(Number(params.maxBytes)) ? Number(params.maxBytes) : null;
  const rows = files.map((file) => ({
    ...file,
    kind: inferArtifactKind(file.path || file.relativePath || ""),
  }));
  const filtered = rows
    .filter((file) => !kindFilter || file.kind === kindFilter)
    .filter((file) => !query || `${file.path || ""} ${file.relativePath || ""} ${file.kind}`.toLowerCase().includes(query))
    .filter((file) => minBytes == null || Number(file.bytes || 0) >= minBytes)
    .filter((file) => maxBytes == null || Number(file.bytes || 0) <= maxBytes)
    .sort((a, b) => String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || "")));
  const kinds = {};
  const latestByKind = {};
  let totalBytes = 0;
  for (const file of rows) {
    kinds[file.kind] = (kinds[file.kind] || 0) + 1;
    totalBytes += Number(file.bytes || 0);
    const current = latestByKind[file.kind];
    if (!current || String(file.modifiedAt || "").localeCompare(String(current.modifiedAt || "")) > 0) {
      latestByKind[file.kind] = {
        path: file.path,
        relativePath: file.relativePath,
        kind: file.kind,
        bytes: file.bytes,
        modifiedAt: file.modifiedAt,
        sha256: file.sha256 || null,
        inspectInput: { path: file.path },
        readInput: { path: file.path, mode: "line", startLine: 1, lineCount: 120 },
      };
    }
  }
  const recommendedKindOrder = ["research-pack", "drilldown-plan", "har", "application", "bundle", "manifest", "graph", "auth-boundary", "boundary", "trace"];
  const recommendedDrilldowns = recommendedKindOrder
    .filter((kind) => latestByKind[kind])
    .flatMap((kind) => {
      const artifact = latestByKind[kind];
      const drilldowns = [{
        label: `Latest ${kind} artifact`,
        tool: "devtools_artifact_inspect",
        input: artifact.inspectInput,
        path: artifact.path,
      }];
      if (["research-pack", "drilldown-plan", "har", "application", "bundle", "manifest", "graph", "auth-boundary", "boundary"].includes(kind)) {
        drilldowns.push({
          label: `Read latest ${kind} artifact`,
          tool: "devtools_artifact_read",
          input: artifact.readInput,
          path: artifact.path,
        });
      }
      return drilldowns;
    })
    .slice(0, 12);
  return {
    schema: "agent-browser-runtime.artifact-index.v1",
    generatedAt: new Date().toISOString(),
    totalFileCount: rows.length,
    returnedFileCount: Math.min(filtered.length, maxFiles),
    totalBytes,
    kinds,
    latestByKind,
    recommendedDrilldowns,
    filters: {
      query: query || null,
      kind: kindFilter || null,
      minBytes,
      maxBytes,
      maxFiles,
    },
    artifacts: filtered.slice(0, maxFiles).map((file) => ({
      path: file.path,
      relativePath: file.relativePath,
      kind: file.kind,
      bytes: file.bytes,
      modifiedAt: file.modifiedAt,
      sha256: file.sha256 || null,
      hashSkipped: Boolean(file.hashSkipped),
      nextTool: "devtools_artifact_inspect",
      inspectInput: { path: file.path },
    })),
    boundaries: [
      "This index lists local evidence artifacts that already exist on disk.",
      "It does not read every artifact body and does not decide vulnerability impact.",
      "latestByKind is a convenience pointer for navigation only; use inspect/read tools for bounded content access.",
      "recommendedDrilldowns are deterministic navigation shortcuts, not findings.",
      "Use devtools_artifact_inspect for bounded structure, preview, and literal match drill-down.",
    ],
  };
}

function buildArtifactSearch(files = [], params = {}) {
  const query = String(params.query || "").trim();
  if (!query) throw new Error("query is required");
  const kindFilter = String(params.kind || "").trim().toLowerCase();
  const maxFiles = Math.max(1, Math.min(Number(params.maxFiles) || 100, 1000));
  const maxMatches = Math.max(1, Math.min(Number(params.maxMatches) || 50, 500));
  const maxMatchesPerFile = Math.max(1, Math.min(Number(params.maxMatchesPerFile) || 10, 100));
  const maxBytesPerFile = Math.max(1024, Math.min(Number(params.maxBytesPerFile) || 500000, 5_000_000));
  const contextChars = Math.max(0, Math.min(Number(params.contextChars) || 160, 2000));
  const rows = files
    .map((file) => ({ ...file, kind: inferArtifactKind(file.path || file.relativePath || "") }))
    .filter((file) => !kindFilter || file.kind === kindFilter)
    .sort((a, b) => String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || "")))
    .slice(0, maxFiles);
  const fileMatches = [];
  let scannedFileCount = 0;
  let skippedFileCount = 0;
  let totalMatches = 0;
  for (const file of rows) {
    if (totalMatches >= maxMatches) break;
    if (!file.path || !existsSync(file.path) || Number(file.bytes || 0) > maxBytesPerFile) {
      skippedFileCount += 1;
      continue;
    }
    const ext = String(file.path).toLowerCase().split(".").pop() || "";
    const searchable = ["har", "json", "txt", "log", "md", "html", "htm", "js", "mjs", "ts", "css", "csv", "xml", "yml", "yaml", "map", "svg"].includes(ext);
    if (!searchable) {
      skippedFileCount += 1;
      continue;
    }
    let text = "";
    try {
      text = readFileSync(file.path, "utf8");
    } catch {
      skippedFileCount += 1;
      continue;
    }
    scannedFileCount += 1;
    const matches = findTextMatches(text, query, {
      caseSensitive: Boolean(params.caseSensitive),
      maxMatches: Math.min(maxMatchesPerFile, maxMatches - totalMatches),
      contextChars,
    });
    if (!matches.length) continue;
    totalMatches += matches.length;
    fileMatches.push({
      path: file.path,
      relativePath: file.relativePath,
      kind: file.kind,
      bytes: file.bytes,
      modifiedAt: file.modifiedAt,
      matchCount: matches.length,
      matches,
      nextTool: "devtools_artifact_inspect",
      inspectInput: { path: file.path, query },
    });
  }
  return {
    schema: "agent-browser-runtime.artifact-search.v1",
    generatedAt: new Date().toISOString(),
    query,
    filters: {
      kind: kindFilter || null,
      maxFiles,
      maxMatches,
      maxMatchesPerFile,
      maxBytesPerFile,
      contextChars,
      caseSensitive: Boolean(params.caseSensitive),
    },
    candidateFileCount: rows.length,
    scannedFileCount,
    skippedFileCount,
    matchedFileCount: fileMatches.length,
    totalMatches,
    fileMatches,
    boundaries: [
      "This is literal search across saved local evidence artifacts.",
      "It skips oversized or non-text artifacts and does not interpret match meaning.",
      "Use devtools_artifact_inspect on a returned path for bounded file-level drill-down.",
    ],
  };
}

function readArtifactSlice(params = {}) {
  const artifactPath = params.path || params.artifactPath;
  if (!artifactPath) throw new Error("path is required");
  const file = resolve(String(artifactPath));
  const maxBytes = Math.max(1, Math.min(Number(params.maxBytes) || 120000, 2_000_000));
  const startByte = Math.max(0, Number(params.startByte) || 0);
  const startLine = params.startLine == null ? null : Math.max(1, Number(params.startLine) || 1);
  const lineCount = Math.max(1, Math.min(Number(params.lineCount) || 80, 5000));
  if (!existsSync(file)) {
    return {
      schema: "agent-browser-runtime.artifact-read.v1",
      backend: "personal-chrome",
      path: String(artifactPath),
      resolvedPath: file,
      exists: false,
      boundaries: ["This tool reads local evidence artifact slices only; it does not interpret findings."],
    };
  }
  const stat = statSync(file);
  if (!stat.isFile()) {
    return {
      schema: "agent-browser-runtime.artifact-read.v1",
      backend: "personal-chrome",
      path: String(artifactPath),
      resolvedPath: file,
      exists: true,
      isFile: false,
      bytes: stat.size,
      boundaries: ["The requested artifact path is not a regular file."],
    };
  }

  const buffer = readFileSync(file);
  const base = {
    schema: "agent-browser-runtime.artifact-read.v1",
    backend: "personal-chrome",
    path: String(artifactPath),
    resolvedPath: file,
    exists: true,
    isFile: true,
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    sha256: stat.size <= 25_000_000 ? sha256File(file) : null,
    hashSkipped: stat.size > 25_000_000,
    kind: inferArtifactKind(file),
    boundaries: [
      "This is bounded local artifact reading for agent drill-down.",
      "It returns exact file slices and does not decide vulnerability impact.",
    ],
    nextTools: ["devtools_artifact_search", "devtools_artifact_inspect"],
  };

  if (startLine != null) {
    const textLimit = Math.min(buffer.length, Math.max(maxBytes, 5_000_000));
    const text = buffer.subarray(0, textLimit).toString("utf8");
    const lines = text.split(/\r?\n/);
    const zero = startLine - 1;
    const selected = lines.slice(zero, zero + lineCount);
    return {
      ...base,
      mode: "line",
      startLine,
      lineCount,
      returnedLineCount: selected.length,
      lineSearchTruncated: textLimit < buffer.length,
      contentText: selected.join("\n"),
      lines: selected.map((line, index) => ({ lineNumber: startLine + index, text: line })),
    };
  }

  const endByte = Math.min(buffer.length, startByte + maxBytes);
  const slice = buffer.subarray(startByte, endByte);
  const text = slice.toString("utf8");
  return {
    ...base,
    mode: "byte",
    startByte,
    endByte,
    returnedBytes: slice.length,
    truncatedBefore: startByte > 0,
    truncatedAfter: endByte < buffer.length,
    contentText: text,
    contentBase64: params.includeBase64 ? slice.toString("base64") : undefined,
  };
}

function evidenceTimestamp(value) {
  if (!value) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function buildEvidenceTimeline({ requests = [], consoleLog = {}, issues = {}, realtime = {}, artifacts = [] }, params = {}) {
  const maxEvents = Math.max(1, Math.min(Number(params.maxEvents) || 200, 2000));
  const eventType = String(params.eventType || "").trim().toLowerCase();
  const sourceFilter = String(params.source || "").trim().toLowerCase();
  const query = String(params.query || "").trim().toLowerCase();
  const since = evidenceTimestamp(params.since);
  const until = evidenceTimestamp(params.until);
  const events = [];
  for (const request of requests || []) {
    events.push({
      timestamp: evidenceTimestamp(request.timestamp || request.startedAt || request.requestTime || request.wallTime || request.responseTimestamp || request.finishedAt),
      type: "network-request",
      source: "Network",
      label: `${request.method || "GET"} ${request.status || "pending"} ${request.url || ""}`.trim(),
      requestId: request.requestId || null,
      url: request.url || "",
      method: request.method || "",
      status: request.status ?? null,
      resourceType: request.resourceType || request.type || null,
      nextTool: "devtools_request_detail",
      drilldownInput: request.requestId ? { requestId: request.requestId } : null,
    });
  }
  for (const entry of consoleLog.console || consoleLog.entries || []) {
    events.push({
      timestamp: evidenceTimestamp(entry.timestamp),
      type: "console",
      source: "Console",
      label: `${entry.type || "console"} ${(entry.args || entry.text || []).toString().slice(0, 160)}`.trim(),
      level: entry.type || entry.level || null,
      nextTool: "devtools_console_log",
      drilldownInput: { reload: false },
    });
  }
  for (const entry of consoleLog.exceptions || []) {
    events.push({
      timestamp: evidenceTimestamp(entry.timestamp || entry.timestampRaw),
      type: "exception",
      source: "Console",
      label: entry.details?.text || entry.details?.exception?.description || "Runtime exception",
      exceptionId: entry.exceptionId || null,
      nextTool: "devtools_console_source_context",
      drilldownInput: { reload: false },
    });
  }
  for (const entry of consoleLog.logs || []) {
    events.push({
      timestamp: evidenceTimestamp(entry.timestamp || entry.entry?.timestamp),
      type: "log-entry",
      source: "Log",
      label: entry.entry?.text || entry.entry?.url || "Log entry",
      level: entry.entry?.level || null,
      nextTool: "devtools_console_log",
      drilldownInput: { reload: false },
    });
  }
  for (const issue of issues.issues || []) {
    events.push({
      timestamp: evidenceTimestamp(issue.timestamp),
      type: "devtools-issue",
      source: "Issues",
      label: issue.issue?.code || issue.code || issue.error || "DevTools issue",
      nextTool: "devtools_issues_log",
      drilldownInput: { reload: false },
    });
  }
  for (const socket of realtime.websockets || []) {
    events.push({
      timestamp: evidenceTimestamp(socket.createdAt || socket.updatedAt),
      type: "websocket",
      source: "Network",
      label: `WebSocket ${socket.status || ""} ${socket.url || ""}`.trim(),
      requestId: socket.requestId || null,
      url: socket.url || "",
      nextTool: "devtools_realtime_log",
      drilldownInput: socket.requestId ? { requestId: socket.requestId } : {},
    });
    for (const frame of socket.frames || []) {
      events.push({
        timestamp: evidenceTimestamp(frame.timestamp || socket.updatedAt || socket.createdAt),
        type: "websocket-frame",
        source: "Network",
        label: `WebSocket ${frame.direction || "frame"} ${String(frame.payloadData || "").slice(0, 120)}`.trim(),
        requestId: socket.requestId || null,
        nextTool: "devtools_realtime_log",
        drilldownInput: socket.requestId ? { requestId: socket.requestId } : {},
      });
    }
  }
  for (const event of realtime.eventSources || []) {
    events.push({
      timestamp: evidenceTimestamp(event.timestamp || event.receivedAt),
      type: "eventsource-message",
      source: "Network",
      label: `EventSource ${String(event.eventName || event.data || "").slice(0, 140)}`.trim(),
      requestId: event.requestId || null,
      nextTool: "devtools_realtime_log",
      drilldownInput: event.requestId ? { requestId: event.requestId } : {},
    });
  }
  for (const artifact of artifacts || []) {
    events.push({
      timestamp: evidenceTimestamp(artifact.modifiedAt),
      type: "artifact",
      source: "Evidence",
      label: `${artifact.kind || inferArtifactKind(artifact.path)} ${artifact.relativePath || artifact.path || ""}`.trim(),
      path: artifact.path,
      kind: artifact.kind || inferArtifactKind(artifact.path),
      bytes: artifact.bytes,
      nextTool: "devtools_artifact_read",
      drilldownInput: { path: artifact.path },
    });
  }
  const filtered = events
    .filter((event) => event.timestamp || params.includeUndated)
    .filter((event) => !eventType || String(event.type || "").toLowerCase() === eventType)
    .filter((event) => !sourceFilter || String(event.source || "").toLowerCase() === sourceFilter)
    .filter((event) => !query || `${event.type || ""} ${event.source || ""} ${event.label || ""} ${event.url || ""} ${event.path || ""}`.toLowerCase().includes(query))
    .filter((event) => !since || !event.timestamp || String(event.timestamp) >= since)
    .filter((event) => !until || !event.timestamp || String(event.timestamp) <= until);
  const sorted = filtered
    .sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")))
    .slice(-maxEvents);
  const byType = {};
  for (const event of sorted) byType[event.type] = (byType[event.type] || 0) + 1;
  return {
    schema: "agent-browser-runtime.evidence-timeline.v1",
    generatedAt: new Date().toISOString(),
    totalEventCount: events.length,
    filteredEventCount: filtered.length,
    eventCount: sorted.length,
    filters: {
      eventType: eventType || null,
      source: sourceFilter || null,
      query: query || null,
      since,
      until,
      maxEvents,
    },
    byType,
    events: sorted,
    boundaries: [
      "Timeline order is built from timestamps exposed by captured F12 evidence and local artifact mtimes.",
      "It is an objective navigation aid, not a vulnerability or causality judgement.",
      "Missing events mean they were not captured or not timestamped in the current evidence set.",
    ],
  };
}

function urlOrigin(url) {
  try { return new URL(url).origin; }
  catch { return ""; }
}

function urlPath(url) {
  try { return new URL(url).pathname || "/"; }
  catch { return String(url || ""); }
}

function captureHostname(url) {
  try { return new URL(url).hostname; }
  catch { return ""; }
}

function captureGroupCount(rows = [], keyFn = () => "") {
  const counts = new Map();
  for (const row of rows || []) {
    const key = keyFn(row) || "(none)";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, count }));
}

function capturePageKey(entry = {}) {
  return entry.frameId || entry.loaderId || entry.documentURL || entry.url || "(unknown-page)";
}

function buildPersonalCaptureBisect({ requests = [], realtime = {}, status = {}, limit = 200, save = true, path = null }) {
  const requestRows = Array.isArray(requests) ? requests : [];
  const websockets = Array.isArray(realtime.websockets) ? realtime.websockets : [];
  const eventSources = Array.isArray(realtime.eventSources) ? realtime.eventSources : [];
  const pages = new Map();
  for (const request of requestRows) {
    const key = capturePageKey(request);
    const page = pages.get(key) || {
      pageKey: key,
      frameId: request.frameId || null,
      loaderId: request.loaderId || null,
      documentURL: request.documentURL || null,
      firstUrl: request.url || null,
      requestCount: 0,
      failedCount: 0,
      statusCounts: {},
      resourceTypeCounts: {},
      hostCounts: {},
      requests: [],
    };
    page.requestCount += 1;
    if (request.failed) page.failedCount += 1;
    const statusKey = request.status == null ? "(pending)" : String(request.status);
    page.statusCounts[statusKey] = (page.statusCounts[statusKey] || 0) + 1;
    const typeKey = request.resourceType || "(unknown)";
    page.resourceTypeCounts[typeKey] = (page.resourceTypeCounts[typeKey] || 0) + 1;
    const host = captureHostname(request.url) || "(unknown)";
    page.hostCounts[host] = (page.hostCounts[host] || 0) + 1;
    page.requests.push({
      requestId: request.requestId,
      url: request.url,
      method: request.method,
      status: request.status,
      failed: Boolean(request.failed),
      resourceType: request.resourceType,
      mimeType: request.mimeType,
      initiatorType: request.initiator?.type || request.initiatorType || null,
      bodyReadable: Boolean(request.bodyReadable),
      bodyBytes: request.bodyBytes ?? null,
    });
    pages.set(key, page);
  }
  const failed = requestRows.filter((entry) => entry.failed || (typeof entry.status === "number" && entry.status >= 400));
  const result = {
    backend: "personal-chrome",
    generatedAt: new Date().toISOString(),
    captureStatus: status,
    totalEvents: requestRows.length + websockets.length + eventSources.length,
    bucketCount: 3,
    buckets: {
      network: {
        requestCount: requestRows.length,
        failedCount: failed.length,
        byHost: captureGroupCount(requestRows, (entry) => captureHostname(entry.url)),
        byStatus: captureGroupCount(requestRows, (entry) => entry.status == null ? "(pending)" : String(entry.status)),
        byResourceType: captureGroupCount(requestRows, (entry) => entry.resourceType || "(unknown)"),
        byMethod: captureGroupCount(requestRows, (entry) => entry.method || "(unknown)"),
        failed: failed.slice(-limit).map((entry) => ({
          requestId: entry.requestId,
          url: entry.url,
          method: entry.method,
          status: entry.status,
          errorText: entry.errorText || entry.failReason || null,
          blockedReason: entry.blockedReason || null,
        })),
      },
      realtime: {
        websocketCount: websockets.length,
        websocketFrameCount: websockets.reduce((sum, socket) => sum + Number(socket.frameCount || (Array.isArray(socket.frames) ? socket.frames.length : 0)), 0),
        eventSourceMessageCount: eventSources.length,
        websockets: websockets.slice(-limit),
        eventSources: eventSources.slice(-limit),
      },
      pages: {
        pageCount: pages.size,
        items: [...pages.values()].map((page) => ({
          ...page,
          requests: page.requests.slice(-limit),
        })),
      },
    },
    captureBoundaries: [
      "This bisects evidence currently available through the Personal Chrome bridge.",
      "Network response bodies are referenced by request tools/body paths; they are not embedded in this summary.",
      "If rows are missing, start capture before reproducing the browser action.",
    ],
    nextTools: ["devtools_request_detail", "devtools_request_body", "devtools_realtime_log", "devtools_save_har"],
  };
  if (save) {
    const outPath = path || join(captureDir, `${Date.now()}-capture-bisect.json`);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    result.bisectPath = outPath;
    result.bisectBytes = statSync(outPath).size;
  }
  return result;
}

function headerValue(headers = {}, name) {
  const wanted = String(name || "").toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === wanted) return value;
  }
  return undefined;
}

function extractRecords(payload = {}) {
  if (Array.isArray(payload.requests)) return payload.requests;
  if (Array.isArray(payload?.bundle?.networkSummary?.requests)) return payload.bundle.networkSummary.requests;
  if (Array.isArray(payload?.networkSummary?.requests)) return payload.networkSummary.requests;
  return payload?.har?.log?.entries?.map((entry) => ({
    method: entry.request?.method,
    url: entry.request?.url,
    status: entry.response?.status,
  })) || [];
}

function countBy(rows = [], keyFn = () => "") {
  const counts = {};
  for (const row of rows || []) {
    const key = keyFn(row) || "(none)";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function analyzeHarCompleteness(har = {}, options = {}) {
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
      tool: "devtools_request_detail",
      input: { requestId: sample.requestId, ...extraInput },
      why,
    });
  };
  pushRequestDrilldown(bodyMissingSamples[0], "Inspect request with missing HAR body", "Open request detail to see body availability, capture timing, mime type, and body retrieval boundary.");
  if (bodyMissingSamples[0]?.requestId) {
    recommendedDrilldowns.push({
      label: "Try response body fetch for missing HAR body",
      tool: "devtools_request_body",
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
      tool: "devtools_security_summary",
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
    nextTools: ["devtools_request_detail", "devtools_request_body", "devtools_save_har", "devtools_capture_bisect"],
  };
}

function diffRequestSets(beforeRecords = [], afterRecords = []) {
  const shape = (record) => `${record.method || "GET"} ${urlOrigin(record.url)}${urlPath(record.url)}`;
  const makeMap = (records) => {
    const map = new Map();
    for (const record of records || []) {
      const key = shape(record);
      const item = map.get(key) || { key, count: 0, statuses: {}, sampleUrls: [] };
      item.count += 1;
      item.statuses[String(record.status || "pending")] = (item.statuses[String(record.status || "pending")] || 0) + 1;
      if (item.sampleUrls.length < 3 && record.url) item.sampleUrls.push(record.url);
      map.set(key, item);
    }
    return map;
  };
  const before = makeMap(beforeRecords);
  const after = makeMap(afterRecords);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [key, item] of after) {
    if (!before.has(key)) added.push(item);
    else if (before.get(key).count !== item.count || JSON.stringify(before.get(key).statuses) !== JSON.stringify(item.statuses)) {
      changed.push({ key, before: before.get(key), after: item });
    }
  }
  for (const [key, item] of before) {
    if (!after.has(key)) removed.push(item);
  }
  return { added, removed, changed };
}

async function evidenceManifest(params = {}) {
  const active = await safeBridgeTool("devtools_tabs", {});
  const roots = personalArtifactRoots();
  const files = roots.flatMap((dir) => listFiles(dir, Math.ceil((params.maxFiles || 200) / Math.max(1, roots.length))));
  const explicitArtifacts = [];
  for (const file of params.artifactPaths || []) {
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
      sha256: stat.size <= 25_000_000 ? sha256File(file) : null,
      hashSkipped: stat.size > 25_000_000,
    });
  }
  const manifest = {
    schema: "agent-browser-runtime.evidence-manifest.v1",
    backend: "personal-chrome",
    generatedAt: new Date().toISOString(),
    activeTab: active.activeTab || active.tabs?.[0] || null,
    fileCount: files.length,
    files,
    explicitArtifacts,
    boundaries: ["Manifest records local bridge artifacts and hashes only.", "It does not classify vulnerability impact."],
  };
  let manifestPath = null;
  if (params.save !== false) {
    manifestPath = params.path || join(manifestDir, `${Date.now()}-evidence-manifest.json`);
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  return { ...manifest, manifestPath };
}

function artifactIndex(params = {}) {
  const roots = personalArtifactRoots();
  const files = roots.flatMap((dir) => listFiles(dir, Math.ceil(Math.max(Number(params.maxFiles) || 500, 500) / Math.max(1, roots.length))));
  return {
    backend: "personal-chrome",
    artifactRoots: roots,
    ...buildArtifactIndex(files, params),
  };
}

function artifactSearch(params = {}) {
  const roots = personalArtifactRoots();
  const files = roots.flatMap((dir) => listFiles(dir, Math.ceil(Math.max(Number(params.maxFiles) || 500, 500) / Math.max(1, roots.length))));
  return {
    backend: "personal-chrome",
    artifactRoots: roots,
    ...buildArtifactSearch(files, params),
  };
}

async function evidenceTimeline(params = {}) {
  const roots = personalArtifactRoots();
  const files = params.includeArtifacts === false ? [] : roots.flatMap((dir) => listFiles(dir, Math.ceil(Math.max(Number(params.maxArtifacts) || 200, 200) / Math.max(1, roots.length))));
  const artifactRows = params.includeArtifacts === false ? [] : buildArtifactIndex(files, {
    maxFiles: typeof params.maxArtifacts === "number" ? params.maxArtifacts : 200,
  }).artifacts;
  const network = await safeBridgeTool("devtools_network_log", { limit: typeof params.maxNetworkRecords === "number" ? params.maxNetworkRecords : 500 });
  const consoleLog = params.includeConsole === false ? {} : await safeBridgeTool("devtools_console_log", { reload: false, waitMs: 50, limit: 200 });
  const issues = params.includeIssues === false ? {} : await safeBridgeTool("devtools_issues_log", { reload: false, waitMs: 50, limit: 100 });
  const realtime = params.includeRealtime === false ? {} : await safeBridgeTool("devtools_realtime_log", { limit: 200 });
  return {
    backend: "personal-chrome",
    artifactRoots: roots,
    ...buildEvidenceTimeline({
      requests: Array.isArray(network.requests) ? network.requests : [],
      consoleLog,
      issues,
      realtime,
      artifacts: artifactRows,
    }, params),
  };
}

async function requestCorrelationGraph(params = {}) {
  const limit = typeof params.limit === "number" ? params.limit : 200;
  const maxDetailRequests = typeof params.maxDetailRequests === "number" ? params.maxDetailRequests : 50;
  const [network, frames, consoleLog, sources] = await Promise.all([
    safeBridgeTool("devtools_network_log", { limit }),
    safeBridgeTool("devtools_frame_tree", {}),
    safeBridgeTool("devtools_console_log", { limit: 100, reload: false, waitMs: 50 }),
    safeBridgeTool("devtools_sources_list", { limit }),
  ]);
  const detailRows = await Promise.all((network.requests || [])
    .filter((request) => request.requestId)
    .slice(-maxDetailRequests)
    .map(async (request) => {
      const detail = await safeBridgeTool("devtools_request_detail", { requestId: request.requestId });
      return [request.requestId, detail.detail || null];
    }));
  const detailByRequestId = new Map(detailRows.filter(([, detail]) => detail));
  const requestRows = (network.requests || []).map((request) => {
    const detail = detailByRequestId.get(request.requestId);
    if (!detail) return request;
    return {
      ...request,
      initiator: detail.initiator || request.initiator || null,
      initiatorType: detail.initiatorType || request.initiatorType || null,
      redirectChain: detail.redirectChain || request.redirectChain || [],
      frameId: detail.frameId || request.frameId || null,
      resourceType: detail.resourceType || request.resourceType || null,
    };
  });
  const nodes = [];
  const edges = [];
  const seen = new Set();
  const seenEdges = new Set();
  const addNode = (node) => {
    if (!node?.id || seen.has(node.id)) return;
    seen.add(node.id);
    nodes.push(node);
  };
  const addEdge = (edge) => {
    const key = `${edge?.from || ""}\u0000${edge?.to || ""}\u0000${edge?.type || ""}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    if (edge?.from && edge?.to) edges.push(edge);
  };
  const scriptIdForUrl = (scriptUrl = "") => {
    if (!scriptUrl) return null;
    const script = (sources.scripts || []).find((candidate) => candidate.url && scriptUrl.includes(candidate.url));
    return script ? `script:${script.scriptId || script.url}` : `initiator:${scriptUrl}`;
  };
  const addInitiatorStack = (request, requestNodeId) => {
    const initiator = request.initiator || null;
    const stack = initiator?.stack || initiator?.asyncStackTrace || null;
    const callFrames = [];
    const collect = (trace, relation = "sync") => {
      if (!trace) return;
      for (const frame of trace.callFrames || []) callFrames.push({ ...frame, relation });
      if (trace.parent) collect(trace.parent, "parent");
      if (trace.parentId) callFrames.push({ relation: "parentId", id: trace.parentId });
    };
    collect(stack);
    if (initiator?.url && !callFrames.some((frame) => frame.url === initiator.url)) {
      callFrames.push({
        relation: "initiator-url",
        functionName: "",
        url: initiator.url,
        lineNumber: initiator.lineNumber,
        columnNumber: initiator.columnNumber,
        scriptId: null,
      });
    }
    let previousFrameId = null;
    for (const frame of callFrames.slice(0, 20)) {
      const frameUrl = frame.url || "";
      if (!frameUrl && !frame.scriptId) continue;
      const frameId = `initiator-frame:${frame.scriptId || frameUrl}:${frame.lineNumber ?? "?"}:${frame.columnNumber ?? "?"}:${frame.relation || "sync"}`;
      addNode({
        id: frameId,
        type: "initiator-frame",
        label: `${frame.functionName || "(anonymous)"} ${urlPath(frameUrl)}`,
        url: frameUrl,
        functionName: frame.functionName || "",
        lineNumber: frame.lineNumber,
        columnNumber: frame.columnNumber,
        scriptId: frame.scriptId || null,
        relation: frame.relation || "sync",
      });
      if (frameUrl) {
        const scriptId = scriptIdForUrl(frameUrl);
        addNode({ id: scriptId, type: scriptId.startsWith("script:") ? "script" : "initiator", label: frameUrl, url: frameUrl });
        addEdge({ from: scriptId, to: frameId, type: "has-call-frame" });
      }
      if (previousFrameId) addEdge({ from: previousFrameId, to: frameId, type: "async-parent" });
      previousFrameId = frameId;
    }
    if (previousFrameId) addEdge({ from: previousFrameId, to: requestNodeId, type: "initiates" });
  };
  for (const frame of frames.frames || []) addNode({ id: `frame:${frame.id || frame.url}`, type: "frame", label: frame.url, url: frame.url });
  for (const script of sources.scripts || []) addNode({ id: `script:${script.scriptId || script.url}`, type: "script", label: script.url || script.scriptId, url: script.url });
  for (const request of requestRows) {
    const id = `request:${request.requestId || request.url}`;
    addNode({
      id,
      type: "request",
      label: `${request.method || "GET"} ${urlPath(request.url)}`,
      requestId: request.requestId,
      method: request.method,
      url: request.url,
      status: request.status,
      resourceType: request.resourceType,
      f12Columns: request.f12Columns || null,
    });
    if (request.frameId) addEdge({ from: `frame:${request.frameId}`, to: id, type: "frame-request" });
    for (const [index, redirect] of (request.redirectChain || []).entries()) {
      const redirectId = `redirect:${request.requestId || request.url}:${index}`;
      addNode({ id: redirectId, type: "redirect", label: `${redirect.status || ""} ${urlPath(redirect.url)}`.trim(), requestId: request.requestId, url: redirect.url, status: redirect.status, location: redirect.location || null });
      addEdge({ from: redirectId, to: id, type: "redirects-to" });
      if (index > 0) addEdge({ from: `redirect:${request.requestId || request.url}:${index - 1}`, to: redirectId, type: "redirect-next" });
    }
    const initiatorUrl = request.initiator?.url || request.initiator?.stack?.callFrames?.[0]?.url || "";
    if (initiatorUrl) {
      const scriptId = scriptIdForUrl(initiatorUrl);
      addNode({ id: scriptId, type: scriptId.startsWith("script:") ? "script" : "initiator", label: initiatorUrl, url: initiatorUrl });
      addEdge({ from: scriptId, to: id, type: "initiates" });
    }
    addInitiatorStack(request, id);
  }
  for (const entry of consoleLog.entries || []) addNode({ id: `console:${entry.timestamp || entry.text || nodes.length}`, type: "console", label: entry.text || entry.message || entry.level, level: entry.level, url: entry.url });
  const graph = { backend: "personal-chrome", generatedAt: new Date().toISOString(), detailRequestsInspected: detailByRequestId.size, nodeCount: nodes.length, edgeCount: edges.length, nodes, edges };
  let graphPath = null;
  if (params.save) {
    graphPath = params.path || join(graphDir, `${Date.now()}-request-correlation-graph.json`);
    mkdirSync(dirname(graphPath), { recursive: true });
    writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
  }
  return {
    ...graph,
    graphPath,
    boundaries: [
      "Edges are metadata correlations, not proof of causality.",
      "Redirect edges are reconstructed from request detail when Chrome exposes redirectChain.",
      "Initiator stack frames are included only when chrome.debugger exposes initiator stack metadata for the request.",
    ],
  };
}

async function captureDiff(params = {}) {
  if (!params.beforePath) throw new Error("beforePath is required");
  const before = readJsonFile(params.beforePath);
  const after = params.afterPath ? readJsonFile(params.afterPath) : await safeBridgeTool("devtools_network_log", { limit: 1000000 });
  const network = diffRequestSets(extractRecords(before), extractRecords(after));
  const diff = {
    schema: "agent-browser-runtime.capture-diff.v1",
    backend: "personal-chrome",
    generatedAt: new Date().toISOString(),
    beforePath: params.beforePath,
    afterPath: params.afterPath || null,
    afterSource: params.afterPath ? "file" : "current-network-log",
    network,
    summary: {
      addedRequestShapes: network.added.length,
      removedRequestShapes: network.removed.length,
      changedRequestShapes: network.changed.length,
    },
    boundaries: ["Diff reports observable changes; it does not decide authorization or vulnerability impact."],
  };
  let diffPath = null;
  if (params.save) {
    diffPath = params.path || join(diffDir, `${Date.now()}-capture-diff.json`);
    mkdirSync(dirname(diffPath), { recursive: true });
    writeFileSync(diffPath, `${JSON.stringify(diff, null, 2)}\n`, "utf8");
  }
  return { ...diff, diffPath };
}

async function authBoundaryReport(params = {}) {
  const limit = typeof params.limit === "number" ? params.limit : 50;
  const [network, cookies, storage, security, tokenScan] = await Promise.all([
    safeBridgeTool("devtools_network_log", { limit: 1000000 }),
    safeBridgeTool("devtools_cookie_summary", {}),
    safeBridgeTool("devtools_storage_snapshot", {}),
    safeBridgeTool("devtools_security_summary", {}),
    params.includeTokenScan === false ? null : safeBridgeTool("devtools_token_scan", {}),
  ]);
  const authRequests = (network.requests || []).filter((request) => {
    const headers = request.requestHeaders || request.headers || {};
    return headerValue(headers, "authorization") || headerValue(headers, "cookie") || Object.keys(headers).some((key) => /csrf|xsrf/i.test(key));
  }).slice(-limit).map((request) => ({
    requestId: request.requestId,
    method: request.method,
    url: request.url,
    status: request.status,
    hasAuthorizationHeader: Boolean(headerValue(request.requestHeaders || request.headers || {}, "authorization")),
    hasCookieHeader: Boolean(headerValue(request.requestHeaders || request.headers || {}, "cookie")),
  }));
  const report = {
    schema: "agent-browser-runtime.auth-boundary-report.v1",
    backend: "personal-chrome",
    generatedAt: new Date().toISOString(),
    page: security.page || {},
    cookieSummary: cookies.summary || cookies,
    storageSummary: {
      localStorageKeys: Object.keys(storage.localStorage || {}),
      sessionStorageKeys: Object.keys(storage.sessionStorage || {}),
      cookieCount: Array.isArray(storage.cookies) ? storage.cookies.length : 0,
    },
    authRequests,
    tokenScanSummary: tokenScan ? { findingCount: tokenScan.findingCount || tokenScan.findings?.length || 0, findings: (tokenScan.findings || []).slice(0, limit) } : null,
    boundaries: ["This report lists authentication-related evidence only.", "It does not decide access-control correctness."],
  };
  let reportPath = null;
  if (params.save) {
    reportPath = params.path || join(authReportDir, `${Date.now()}-auth-boundary-report.json`);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return { ...report, reportPath };
}

async function workerFrameDeepDive(params = {}) {
  const [frames, swSummary, swDetail, targets] = await Promise.all([
    safeBridgeTool("devtools_frame_tree", {}),
    safeBridgeTool("devtools_service_worker_summary", {}),
    params.includeServiceWorkerDetail === false ? null : safeBridgeTool("devtools_service_worker_detail", {}),
    safeBridgeTool("devtools_browser_targets", {}),
  ]);
  const targetList = Array.isArray(targets?.targets) ? targets.targets : (Array.isArray(targets) ? targets : []);
  const workerTargets = targetList.filter((target) => ["worker", "shared_worker", "service_worker"].includes(target.type));
  const report = {
    schema: "agent-browser-runtime.worker-frame-deep-dive.v1",
    backend: "personal-chrome",
    generatedAt: new Date().toISOString(),
    frameTree: frames,
    serviceWorkers: { summary: swSummary, detail: swDetail },
    workerTargets,
    summary: {
      frameCount: frames.frameCount || frames.frames?.length || 0,
      inaccessibleFrameCount: frames.inaccessibleFrameCount || 0,
      serviceWorkerRegistrationCount: swSummary.registrationCount || 0,
      cacheCount: swSummary.cacheCount || 0,
      workerTargetCount: workerTargets.length,
    },
    boundaries: ["Cross-origin frame internals may be unavailable to page-context tools."],
  };
  let reportPath = null;
  if (params.save) {
    reportPath = params.path || join(boundaryReportDir, `${Date.now()}-worker-frame-deep-dive.json`);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return { ...report, reportPath };
}

function devtoolsToolCategory(name) {
  if (name === "agent_inspect" || /backend_capabilities|tool_catalog|tool_help|workflow_guide|capability_map|parity_matrix|professional_readiness|protocol_schema/.test(name)) return "orientation";
  if (/tabs|snapshot|screenshot|click|type|scroll|eval|hard_reload/.test(name)) return "page-control";
  if (/network|request|har|capture_|realtime/.test(name)) return "network";
  if (/console|issues|security_summary|signal_summary|page_diagnostics/.test(name)) return "diagnostics";
  if (/storage|cookie|service_worker|application|indexeddb|cache|auth_boundary/.test(name)) return "application";
  if (/frame|accessibility|elements|dom|css|event_listeners|worker_frame/.test(name)) return "dom-frame";
  if (/source|debugger|token_flow|global_search/.test(name)) return "sources-debugger";
  if (/performance|trace|cpu|coverage|memory|heap/.test(name)) return "performance";
  if (/evidence|manifest|artifact|correlation|diff|research_pack/.test(name)) return "evidence-workflow";
  if (/cdp_command|browser_version|browser_targets|system_info/.test(name)) return "raw-cdp";
  return "other";
}

function buildAgentToolEntryPoints(available) {
  const pick = (names) => names.filter((name) => available.has(name));
  const compressedTools = [
    {
      label: "orient",
      purpose: "Check backend, workflow readiness, and available capability areas before using low-level tools.",
      tools: pick(["devtools_professional_readiness", "devtools_workflow_guide", "devtools_capability_map", "devtools_f12_parity_matrix"]),
    },
    {
      label: "operate",
      purpose: "Open pages and interact with the browser through the facade layer.",
      tools: pick(["browser_open", "browser_act", "browser_capture"]),
    },
    {
      label: "inspect",
      purpose: "Get first-pass F12 evidence without choosing a specific low-level panel tool.",
      tools: pick(["browser_inspect", "agent_inspect"]),
    },
    {
      label: "package",
      purpose: "Save a portable objective evidence pack with artifact paths and drilldown routes.",
      tools: pick(["browser_security_pack", "devtools_security_research_pack"]),
    },
    {
      label: "drilldown",
      purpose: "Use the drilldownPlan, artifact index/search/read, request detail, trace query, and source tools after concrete evidence exists.",
      tools: pick(["devtools_artifact_index", "devtools_evidence_timeline", "devtools_request_detail", "devtools_trace_query", "devtools_sources_search"]),
    },
    {
      label: "escape-hatch",
      purpose: "Call raw CDP only when the facade and friendly devtools_* tools cannot express the exact F12 operation.",
      tools: pick(["browser_raw", "devtools_protocol_schema", "devtools_cdp_command"]),
    },
  ];
  return {
    defaultMode: "facade-first",
    recommendedFirstCall: available.has("devtools_professional_readiness") ? "devtools_professional_readiness" : "devtools_capability_map",
    facadePath: pick(["browser_open", "browser_capture", "browser_inspect", "browser_security_pack", "browser_raw"]),
    professionalPath: pick(["browser_open", "browser_capture", "browser_inspect", "browser_security_pack"]),
    professionalRouteSummary: {
      firstStep: available.has("devtools_professional_readiness")
        ? { tool: "devtools_professional_readiness", input: {} }
        : { tool: "devtools_capability_map", input: {} },
      standardWorkflow: pick(["browser_open", "browser_capture", "browser_inspect", "browser_security_pack"]),
      evidencePack: available.has("browser_security_pack")
        ? { tool: "browser_security_pack", input: { includeHar: true, includeTrace: true, includeApplicationExport: true } }
        : null,
      handoffInspectTemplate: available.has("devtools_artifact_inspect")
        ? { tool: "devtools_artifact_inspect", input: { path: "<researchPackPath>" } }
        : null,
      handoffReadTemplate: available.has("devtools_artifact_read")
        ? { tool: "devtools_artifact_read", input: { path: "<researchPackPath>", mode: "line", startLine: 1, maxLines: 120 } }
        : null,
      firstConcreteDrilldownSources: [
        "devtools_professional_readiness.routeSummary.firstConcreteDrilldown",
        "devtools_security_research_pack.drilldownPlan.drilldowns",
        "devtools_artifact_index.recommendedDrilldowns",
      ],
      objectiveBoundary: "This catalog route is a stateless template; use readiness routeSummary for current evidence and do not treat the route as a vulnerability judgment.",
    },
    drilldownRule: "Use low-level devtools_* tools only after a facade call returns concrete evidence, an artifact path, requestId, frameId, scriptId, or drilldownPlan entry.",
    compressedTools,
    objectiveBoundary: "This entry plan is routing metadata only; it does not judge vulnerabilities or security impact.",
  };
}

function buildCapabilityAgentUsage(available, backend = "personal-chrome") {
  const route = (steps) => steps.filter((step) => available.has(step.tool));
  return {
    defaultRoute: route([
      { tool: "devtools_professional_readiness", input: {}, why: "Check mechanical readiness, current capture status, and latest saved evidence." },
      { tool: "browser_open", input: { url: "https://example.com", waitMs: 1000 }, why: "Bind the authorized Chrome tab to the target page." },
      { tool: "browser_capture", input: { action: "start", label: "research-window" }, why: "Start the explicit F12 recording window before reproducing behaviour." },
      { tool: "browser_inspect", input: { mode: "overview", limit: 10 }, why: "Read first-pass objective evidence before choosing a low-level panel." },
      { tool: "browser_security_pack", input: { includeHar: true, includeTrace: true, includeApplicationExport: true }, why: "Save portable evidence artifacts and drilldown routes." },
      { tool: "devtools_artifact_index", input: { maxFiles: 200 }, why: "Navigate saved artifacts through latestByKind and recommendedDrilldowns." },
    ]),
    panelRoutes: {
      network: route([
        { tool: "devtools_network_summary", input: {}, needs: "Recorded requests exist." },
        { tool: "devtools_request_detail", input: { requestId: "<requestId>" }, needs: "A concrete requestId from summary, timeline, HAR, or drilldownPlan." },
        { tool: "devtools_har_completeness", input: {}, needs: "HAR/body/timing completeness check." },
      ]),
      application: route([
        { tool: "devtools_storage_origin_summary", input: {}, needs: "Current page origin is loaded." },
        { tool: "devtools_cookie_summary", input: {}, needs: "Cookie metadata and visibility evidence." },
        { tool: "devtools_application_export", input: { save: true }, needs: "Portable Application panel artifact." },
      ]),
      sources: route([
        { tool: "devtools_sources_search", input: { query: "<literal>" }, needs: "A literal string, URL fragment, token name, or function name." },
        { tool: "devtools_source_pretty_print", input: { scriptId: "<scriptId>" }, needs: "A concrete scriptId from sources list/search." },
        { tool: "devtools_debugger_control", input: { action: "getPausedState" }, needs: "Debugger state inspection." },
      ]),
      performance: route([
        { tool: "devtools_chrome_trace", input: { save: true }, needs: "Trace capture for Performance-like evidence." },
        { tool: "devtools_trace_query", input: { category: "rendering", limit: 20 }, needs: "Saved or active trace events." },
      ]),
      evidence: route([
        { tool: "devtools_evidence_timeline", input: { maxEvents: 80, maxArtifacts: 120 }, needs: "Existing captured events or saved artifacts." },
        { tool: "devtools_artifact_index", input: { maxFiles: 200 }, needs: "Existing artifact directory." },
        { tool: "devtools_artifact_inspect", input: { path: "<artifactPath>" }, needs: "A concrete path from latestByKind, recommendedDrilldowns, or research pack." },
      ]),
    },
    drilldownRule: "Only use panel drilldowns after a first-pass route returns a concrete requestId, frameId, scriptId, trace path, artifact path, or recommendedDrilldowns entry.",
    objectiveBoundary: "These are deterministic routing hints for agents; they do not read hidden data and do not judge vulnerabilities.",
  };
}

const DEVTOOLS_CAPABILITY_META = {
  orientation: {
    panel: "Orientation",
    purpose: "Understand backend, available tools, workflows, and capture boundaries before drilling down.",
    firstPass: ["devtools_backend_capabilities", "devtools_professional_readiness", "devtools_tool_catalog", "devtools_workflow_guide", "agent_inspect"],
  },
  "page-control": {
    panel: "Page",
    purpose: "Open, inspect, screenshot, and interact with the page like a user.",
    firstPass: ["browser_open", "browser_act", "devtools_snapshot", "devtools_screenshot"],
  },
  network: {
    panel: "Network",
    purpose: "Record request traffic, inspect timing/initiators/bodies, replay captured requests, and export HAR evidence.",
    firstPass: ["devtools_capture_start", "devtools_hard_reload", "agent_inspect", "devtools_network_summary", "devtools_capture_bisect", "devtools_har_completeness"],
  },
  diagnostics: {
    panel: "Console / Issues / Security",
    purpose: "Read console messages, exceptions, DevTools Issues, page diagnostics, and security context.",
    firstPass: ["agent_inspect", "devtools_page_diagnostics", "devtools_signal_summary", "devtools_console_log"],
  },
  application: {
    panel: "Application",
    purpose: "Inspect storage, cookies, service workers, CacheStorage, IndexedDB, and auth-boundary evidence.",
    firstPass: ["agent_inspect", "devtools_storage_origin_summary", "devtools_cookie_summary", "devtools_service_worker_summary"],
  },
  "dom-frame": {
    panel: "Elements / Frames / Accessibility",
    purpose: "Inspect DOM, styles, event listeners, accessibility tree, frame tree, and worker/frame boundaries.",
    firstPass: ["agent_inspect", "devtools_elements_snapshot", "devtools_dom_search", "devtools_frame_tree"],
  },
  "sources-debugger": {
    panel: "Sources / Debugger",
    purpose: "Inspect parsed scripts, source maps, source text, breakpoints, paused frames, and literal searches.",
    firstPass: ["agent_inspect", "devtools_sources_list", "devtools_sources_search", "devtools_source_map_metadata"],
  },
  performance: {
    panel: "Performance / Memory",
    purpose: "Capture performance evidence, traces, CPU profiles, coverage, heap/memory counters, and trace queries.",
    firstPass: ["agent_inspect", "devtools_performance_insights", "devtools_performance_observer", "devtools_chrome_trace"],
  },
  "evidence-workflow": {
    panel: "Recorder / Evidence",
    purpose: "Create reusable evidence packs, manifests, diffs, correlation graphs, and research workflows.",
    firstPass: ["browser_security_pack", "devtools_security_research_pack", "devtools_artifact_index", "devtools_evidence_bundle", "devtools_evidence_manifest"],
  },
  "raw-cdp": {
    panel: "Raw CDP",
    purpose: "Reach DevTools Protocol commands that do not yet have a friendly wrapper.",
    firstPass: ["devtools_protocol_schema", "devtools_cdp_command"],
  },
};

function toolCatalog(params = {}) {
  const query = String(params.query || "").trim().toLowerCase();
  const categoryFilter = String(params.category || "").trim().toLowerCase();
  const includeBackendSpecific = Boolean(params.includeBackendSpecific);
  const available = new Set(Object.keys(tools));
  const rows = Object.entries(tools)
    .filter(([name]) => includeBackendSpecific || name === "agent_inspect" || name.startsWith("devtools_"))
    .map(([name, description]) => ({
      name,
      category: devtoolsToolCategory(name),
      description,
      required: [],
      parameterNames: [],
    }))
    .filter((tool) => !categoryFilter || tool.category === categoryFilter)
    .filter((tool) => !query || `${tool.name} ${tool.category} ${tool.description}`.toLowerCase().includes(query))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  const categories = {};
  for (const tool of rows) categories[tool.category] = (categories[tool.category] || 0) + 1;
  return {
    backend: "personal-chrome",
    generatedAt: new Date().toISOString(),
    toolCount: rows.length,
    categories,
    agentEntryPoints: buildAgentToolEntryPoints(available),
    tools: rows,
    boundaries: [
      "Tool catalog is a navigation aid; it does not choose or execute tools automatically.",
      "Personal Chrome parameter schemas are summarized in docs; use workflow guide and examples for detailed inputs.",
    ],
  };
}

function capabilityMap() {
  const normalized = Object.entries(tools).map(([name, description]) => ({
    name,
    category: devtoolsToolCategory(name),
    description,
  }));
  const available = new Set(normalized.map((tool) => tool.name));
  const facadeTools = normalized
    .filter((tool) => tool.name.startsWith("browser_"))
    .sort((a, b) => a.name.localeCompare(b.name));
  const productTools = normalized
    .filter((tool) => tool.name === "agent_inspect" || tool.name.startsWith("devtools_"));
  const panels = Object.entries(DEVTOOLS_CAPABILITY_META).map(([category, meta]) => {
    const toolsInCategory = productTools
      .filter((tool) => tool.category === category)
      .sort((a, b) => a.name.localeCompare(b.name));
    const preferred = meta.firstPass.filter((name) => available.has(name));
    const artifactTools = toolsInCategory
      .filter((tool) => /export|save|bundle|manifest|pack|trace|snapshot|profile|har|report|map_sources/.test(tool.name))
      .map((tool) => tool.name);
    return {
      category,
      panel: meta.panel,
      purpose: meta.purpose,
      toolCount: toolsInCategory.length,
      firstPass: preferred,
      drillDown: toolsInCategory.map((tool) => tool.name).filter((name) => !preferred.includes(name)),
      artifactTools,
      rawEscapeHatch: category === "raw-cdp" ? "devtools_cdp_command" : null,
    };
  });
  return {
    backend: "personal-chrome",
    generatedAt: new Date().toISOString(),
    contract: "Agent DevTools capability map",
    facadeTools: facadeTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
    agentUsage: buildCapabilityAgentUsage(available, "personal-chrome"),
    panelCount: panels.length,
    panels,
    recommendedStart: ["browser_open", "browser_capture", "browser_inspect", "browser_security_pack", "browser_raw"].filter((name) => available.has(name)),
    boundaries: [
      "Capability map is navigation metadata; it does not execute tools or decide impact.",
      "Use browser_* facade tools first, then drill into devtools_* tools for exact F12 evidence.",
      "Use devtools_cdp_command only when the friendly wrapper does not expose the needed DevTools Protocol method.",
    ],
  };
}

function f12ParityMatrix() {
  const rows = [
    {
      panel: "Network",
      coverage: "strong",
      managed: "supported",
      personal: "supported",
      tools: ["devtools_capture_start", "devtools_network_log", "devtools_network_summary", "devtools_network_timeline", "devtools_request_detail", "devtools_request_body", "devtools_request_payload", "devtools_realtime_log", "devtools_save_har", "devtools_har_completeness", "devtools_request_replay", "devtools_request_replay_batch"],
      boundaries: ["Only activity observed after capture starts is complete.", "Replay uses browser fetch semantics, not raw socket/TLS/HTTP2 framing."],
    },
    {
      panel: "Elements / Frames / Accessibility",
      coverage: "strong-with-browser-boundaries",
      managed: "supported",
      personal: "supported",
      tools: ["devtools_elements_snapshot", "devtools_dom_snapshot", "devtools_dom_search", "devtools_frame_tree", "devtools_accessibility_snapshot", "devtools_event_listeners", "devtools_css_styles", "devtools_dom_mutation_watch"],
      boundaries: ["Closed shadow roots and cross-origin or sandboxed frame internals follow Chrome visibility boundaries."],
    },
    {
      panel: "Application",
      coverage: "strong",
      managed: "supported",
      personal: "supported",
      tools: ["devtools_storage_snapshot", "devtools_storage_origin_summary", "devtools_cookie_summary", "devtools_service_worker_summary", "devtools_service_worker_detail", "devtools_application_export", "devtools_indexeddb_list", "devtools_indexeddb_read", "devtools_cache_storage_list", "devtools_cache_entry_get", "devtools_token_scan"],
      boundaries: ["Storage and cache reads are scoped to the selected page/origin and browser permission model."],
    },
    {
      panel: "Sources / Debugger",
      coverage: "strong-with-tooling-boundaries",
      managed: "supported",
      personal: "supported",
      tools: ["devtools_sources_list", "devtools_source_get", "devtools_source_pretty_print", "devtools_source_map_metadata", "devtools_source_map_sources", "devtools_source_map_source_get", "devtools_sources_search", "devtools_debugger_control", "devtools_console_source_context"],
      boundaries: ["Pretty printing is heuristic.", "Source maps expose metadata and extractable sources rather than a full DevTools editor UI."],
    },
    {
      panel: "Console / Issues / Security",
      coverage: "strong",
      managed: "supported",
      personal: "supported",
      tools: ["devtools_console_log", "devtools_issues_log", "devtools_security_summary", "devtools_page_diagnostics", "devtools_signal_summary"],
      boundaries: ["Browser Issues and Security events are Chrome-reported evidence, not vulnerability classification."],
    },
    {
      panel: "Performance / Memory",
      coverage: "partial-in-personal",
      managed: "supported",
      personal: "partial",
      tools: ["devtools_performance_trace", "devtools_performance_insights", "devtools_performance_observer", "devtools_chrome_trace", "devtools_trace_query", "devtools_trace_compare", "devtools_cpu_profile", "devtools_coverage_snapshot", "devtools_coverage_detail", "devtools_memory_snapshot", "devtools_heap_snapshot"],
      boundaries: ["Managed CDP can capture heap snapshot artifacts.", "Personal Chrome chrome.debugger does not expose HeapProfiler heap snapshots and returns a structured notApplicable response."],
    },
    {
      panel: "Recorder / Evidence Workflow",
      coverage: "strong",
      managed: "supported",
      personal: "supported",
      tools: ["devtools_security_research_pack", "devtools_evidence_bundle", "devtools_evidence_manifest", "devtools_artifact_index", "devtools_artifact_inspect", "devtools_artifact_search", "devtools_artifact_read", "devtools_evidence_timeline", "devtools_capture_diff", "devtools_request_correlation_graph", "devtools_auth_boundary_report", "devtools_worker_frame_deep_dive"],
      boundaries: ["Evidence workflow tools organize and preserve evidence; they do not decide impact."],
    },
    {
      panel: "Raw CDP / Escape Hatch",
      coverage: "partial-in-personal",
      managed: "supported",
      personal: "partial",
      tools: ["devtools_protocol_schema", "devtools_cdp_command", "devtools_browser_cdp_command", "devtools_browser_version", "devtools_browser_targets", "devtools_system_info"],
      boundaries: ["Managed Browser exposes page-target and browser-process CDP routes.", "Personal Chrome is limited to chrome.debugger page-target domains and structured no-op responses for browser-process/schema calls."],
    },
    {
      panel: "DevTools UI Extras",
      coverage: "intentional-gap",
      managed: "not-first-class",
      personal: "not-first-class",
      tools: [],
      boundaries: ["Lighthouse UI, Recorder UI, Sensors, Overrides, Animations, Rendering overlays, and visual editor affordances are not first-class wrappers yet.", "Use raw CDP where Chrome exposes the needed data, or add a focused wrapper when it becomes part of the agent security workflow."],
    },
  ];
  const counts = rows.reduce((acc, row) => {
    acc[row.personal] = (acc[row.personal] || 0) + 1;
    return acc;
  }, {});
  return {
    backend: "personal-chrome",
    generatedAt: new Date().toISOString(),
    contract: "Agent F12 parity matrix",
    targetStandard: "ordinary web-page DevTools evidence for agentic AppSec research",
    professionalToolPositioning: "objective F12 evidence runtime, not a vulnerability scanner and not a pixel clone of Chrome DevTools UI",
    summary: {
      panelCount: rows.length,
      counts,
      strongestBackend: "managed-cdp",
      managedReadiness: "core F12 security-research evidence workflow is strong; remaining gaps are mostly UI extras and deeper wrappers.",
      personalReadiness: "core workflow is usable; chrome.debugger transport has explicit boundary rows where Chrome does not expose full CDP.",
    },
    rows,
    recommendedUse: [
      "Use Managed Browser as the main professional AppSec backend.",
      "Use Personal Chrome for user-authorized real-browser inspection when the chrome.debugger boundary is acceptable.",
      "Start with devtools_capability_map or browser_inspect, then use this parity matrix when deciding whether a missing signal is a tool gap or a browser boundary.",
    ],
    objectiveBoundaries: [
      "This matrix is capability evidence only; it does not classify vulnerabilities.",
      "If a row says partial or intentional-gap, the tool should expose that boundary instead of pretending the data exists.",
      "No capture means no complete historical network evidence, matching human F12 recording semantics.",
    ],
  };
}

function buildProfessionalReadiness({
  backend = "unknown",
  workflow = {},
  capabilityMap = {},
  parityMatrix = {},
  captureStatus = {},
  captureBisect = null,
  harCompleteness = null,
  artifactIndex = null,
  evidenceTimeline = null,
} = {}) {
  const capture = captureStatus?.capture || captureStatus;
  const artifactCount = artifactIndex?.totalFileCount ?? artifactIndex?.summary?.totalFileCount ?? null;
  const artifactKinds = artifactIndex?.kinds || artifactIndex?.summary?.kinds || null;
  const latestArtifacts = artifactIndex?.latestByKind ? Object.fromEntries(Object.entries(artifactIndex.latestByKind).map(([kind, artifact]) => [kind, {
    path: artifact.path || null,
    relativePath: artifact.relativePath || null,
    kind: artifact.kind || kind,
    bytes: artifact.bytes ?? null,
    modifiedAt: artifact.modifiedAt || null,
    sha256: artifact.sha256 || null,
    inspect: artifact.inspectInput ? { tool: "devtools_artifact_inspect", input: artifact.inspectInput } : null,
    read: artifact.readInput ? { tool: "devtools_artifact_read", input: artifact.readInput } : null,
  }])) : null;
  const evidenceEntrypoints = latestArtifacts ? {
    correlationGraph: latestArtifacts.graph || null,
    authBoundary: latestArtifacts["auth-boundary"] || null,
    workerFrameBoundary: latestArtifacts.boundary || null,
  } : null;
  const timelineCount = evidenceTimeline?.eventCount ?? evidenceTimeline?.summary?.eventCount ?? null;
  const timelineTypes = evidenceTimeline?.byType || evidenceTimeline?.summary?.byType || null;
  const parityRows = Array.isArray(parityMatrix?.rows) ? parityMatrix.rows : [];
  const f12Coverage = {
    panelCount: parityMatrix?.summary?.panelCount ?? parityMatrix?.panelCount ?? parityRows.length,
    counts: parityMatrix?.summary?.counts || null,
    strongPanels: parityRows.filter((row) => String(row.coverage || "").startsWith("strong")).map((row) => row.panel),
    partialPanels: parityRows.filter((row) => String(row.coverage || "").includes("partial") || row.managed === "partial" || row.personal === "partial").map((row) => row.panel),
    intentionalGapPanels: parityRows.filter((row) => row.coverage === "intentional-gap" || row.managed === "not-first-class" || row.personal === "not-first-class").map((row) => row.panel),
  };
  const captureBuckets = captureBisect?.buckets ? {
    bucketCount: captureBisect.bucketCount ?? Object.keys(captureBisect.buckets).length,
    totalEvents: captureBisect.totalEvents ?? null,
    networkRequestCount: captureBisect.buckets.network?.requestCount ?? 0,
    networkFailedCount: captureBisect.buckets.network?.failedCount ?? 0,
    pageCount: captureBisect.buckets.pages?.pageCount ?? 0,
    websocketCount: captureBisect.buckets.realtime?.websocketCount ?? 0,
    websocketFrameCount: captureBisect.buckets.realtime?.websocketFrameCount ?? 0,
    eventSourceMessageCount: captureBisect.buckets.realtime?.eventSourceMessageCount ?? 0,
  } : null;
  const harCoverage = harCompleteness && !harCompleteness.unavailable && !harCompleteness.error ? {
    entryCount: harCompleteness.entryCount ?? 0,
    bodiesIncluded: harCompleteness.coverage?.bodiesIncluded || null,
    readableBodies: harCompleteness.coverage?.readableBodies || null,
    totalTiming: harCompleteness.coverage?.totalTiming || null,
    allTimingPhases: harCompleteness.coverage?.allTimingPhases || null,
    securityDetails: harCompleteness.coverage?.securityDetails || null,
    httpsSecurityDetails: harCompleteness.coverage?.httpsSecurityDetails || null,
    redirects: harCompleteness.coverage?.redirects || null,
    recommendedDrilldownCount: Array.isArray(harCompleteness.recommendedDrilldowns) ? harCompleteness.recommendedDrilldowns.length : 0,
  } : null;
  const agentUsage = capabilityMap?.agentUsage || null;
  const recommendedRoute = Array.isArray(agentUsage?.defaultRoute) ? agentUsage.defaultRoute : [];
  const artifactDrilldowns = Array.isArray(artifactIndex?.recommendedDrilldowns) ? artifactIndex.recommendedDrilldowns.slice(0, 8) : [];
  const latestResearchPack = (artifactIndex?.artifacts || [])
    .filter((artifact) => artifact.kind === "research-pack" && artifact.path)
    .sort((a, b) => String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || "")))[0] || null;
  let latestResearchPackSummary = null;
  if (latestResearchPack?.path) {
    try {
      latestResearchPackSummary = summarizeResearchPackHandoff(readJsonFile(latestResearchPack.path));
    } catch (error) {
      latestResearchPackSummary = {
        path: latestResearchPack.path,
        error: String(error?.message || error),
      };
    }
  }
  const researchPackDrilldowns = Array.isArray(latestResearchPackSummary?.firstDrilldowns) ? latestResearchPackSummary.firstDrilldowns.slice(0, 6) : [];
  const f12Navigation = latestResearchPackSummary?.f12Navigation || null;
  const f12NavigationDrilldowns = Array.isArray(f12Navigation?.requestDrilldowns) ? f12Navigation.requestDrilldowns.slice(0, 5) : [];
  const latestResearchPackHandoff = latestResearchPack ? {
    path: latestResearchPack.path,
    bytes: latestResearchPack.bytes ?? null,
    modifiedAt: latestResearchPack.modifiedAt || null,
    inspect: { tool: "devtools_artifact_inspect", input: { path: latestResearchPack.path, maxBytes: 300000 } },
    read: { tool: "devtools_artifact_read", input: { path: latestResearchPack.path, mode: "line", startLine: 1, lineCount: 160 } },
  } : null;
  const firstF12RequestDetailPath = latestResearchPackSummary?.artifactPaths?.firstF12RequestDetailPath || null;
  const firstF12RequestDetailArtifact = firstF12RequestDetailPath ? {
    path: firstF12RequestDetailPath,
    inspect: { tool: "devtools_artifact_inspect", input: { path: firstF12RequestDetailPath, maxBytes: 120000 } },
    read: { tool: "devtools_artifact_read", input: { path: firstF12RequestDetailPath, mode: "line", startLine: 1, lineCount: 120 } },
  } : null;
  const checks = [
    {
      name: "professionalWorkflow",
      present: workflow?.task === "professional-appsec" && Array.isArray(workflow.defaultPath) && workflow.defaultPath.includes("browser_security_pack"),
      evidence: workflow?.defaultPath || null,
    },
    {
      name: "facadeTools",
      present: Array.isArray(capabilityMap?.recommendedStart) && capabilityMap.recommendedStart.includes("browser_security_pack"),
      evidence: capabilityMap?.recommendedStart || null,
    },
    {
      name: "agentUsageRoute",
      present: recommendedRoute.some((step) => step.tool === "browser_security_pack"),
      evidence: recommendedRoute.map((step) => step.tool),
    },
    {
      name: "f12ParityMatrix",
      present: Boolean(parityMatrix?.summary?.panelCount >= 8 || parityMatrix?.panelCount >= 8),
      evidence: parityMatrix?.summary?.panelCount ?? parityMatrix?.panelCount ?? null,
    },
    {
      name: "captureStatusReachable",
      present: Boolean(captureStatus && !captureStatus.unavailable && !captureStatus.error),
      evidence: captureStatus?.unavailable ? captureStatus.error || "unavailable" : capture || null,
    },
    {
      name: "captureBisectReachable",
      present: captureBisect === null || Boolean(!captureBisect.unavailable && !captureBisect.error && captureBuckets),
      evidence: captureBuckets,
    },
    {
      name: "harCompletenessReachable",
      present: harCompleteness === null || Boolean(!harCompleteness.unavailable && !harCompleteness.error && harCoverage),
      evidence: harCoverage,
    },
    {
      name: "latestResearchPackSummaryReachable",
      present: !latestResearchPack || Boolean(latestResearchPackSummary && !latestResearchPackSummary.error),
      evidence: latestResearchPackSummary?.ready ?? latestResearchPackSummary?.error ?? null,
    },
    {
      name: "researchPackDrilldownsReachable",
      present: !latestResearchPackSummary || Boolean(researchPackDrilldowns.length > 0),
      evidence: researchPackDrilldowns.map((entry) => entry.tool),
    },
    {
      name: "f12NavigationReachable",
      present: !latestResearchPackSummary || !f12Navigation || Boolean(f12Navigation.requestNodeCount >= 0),
      evidence: f12Navigation ? { requestNodeCount: f12Navigation.requestNodeCount, firstTool: f12Navigation.firstDetailRoute?.tool || null } : null,
    },
    {
      name: "artifactInventoryReachable",
      present: artifactIndex === null || Boolean(!artifactIndex.unavailable && !artifactIndex.error && artifactCount !== null),
      evidence: artifactCount,
    },
    {
      name: "latestArtifactsReachable",
      present: artifactIndex === null || Boolean(!artifactIndex.unavailable && !artifactIndex.error && latestArtifacts),
      evidence: latestArtifacts ? Object.keys(latestArtifacts) : null,
    },
    {
      name: "evidenceEntrypointsReachable",
      present: artifactIndex === null || Boolean(!artifactIndex.unavailable && !artifactIndex.error && evidenceEntrypoints && (evidenceEntrypoints.correlationGraph || evidenceEntrypoints.authBoundary || evidenceEntrypoints.workerFrameBoundary)),
      evidence: evidenceEntrypoints ? Object.keys(evidenceEntrypoints).filter((key) => evidenceEntrypoints[key]) : null,
    },
    {
      name: "artifactDrilldownsReachable",
      present: artifactIndex === null || artifactDrilldowns.length > 0,
      evidence: artifactDrilldowns.map((entry) => entry.tool),
    },
    {
      name: "evidenceTimelineReachable",
      present: evidenceTimeline === null || Boolean(!evidenceTimeline.unavailable && !evidenceTimeline.error && timelineCount !== null),
      evidence: timelineCount,
    },
  ];
  const missing = checks.filter((check) => !check.present).map((check) => check.name);
  const captureEnabled = Boolean(capture?.enabled || capture?.recording || capture?.active);
  const nextActions = [];
  if (!captureEnabled) {
    nextActions.push({
      tool: "browser_capture",
      input: { action: "start", clear: true, label: "professional-readiness" },
      why: "Start the explicit F12 recording window before reproducing behavior.",
    });
  }
  if (!artifactCount) {
    nextActions.push({
      tool: "browser_security_pack",
      input: { includeHar: true, includeTrace: true, includeApplicationExport: true },
      why: "Create the portable evidence pack, artifact index, timeline, and drilldown plan.",
    });
  } else if (latestResearchPackHandoff) {
    nextActions.push({
      tool: "devtools_artifact_inspect",
      input: latestResearchPackHandoff.inspect.input,
      why: "Inspect the latest saved research-pack handoff and continue from its objective agent route.",
    });
  }
  const actionKey = (entry) => `${entry.tool}:${entry.input?.path || ""}:${entry.input?.requestId || ""}:${entry.input?.tracePath || ""}:${entry.input?.query || ""}`;
  const seenNextActions = new Set(nextActions.map(actionKey));
  if (firstF12RequestDetailArtifact) {
    const entry = {
      tool: firstF12RequestDetailArtifact.inspect.tool,
      input: firstF12RequestDetailArtifact.inspect.input,
      why: "Inspect the standalone first F12 request-detail summary saved by the latest research pack.",
    };
    const key = actionKey(entry);
    if (!seenNextActions.has(key)) {
      nextActions.push(entry);
      seenNextActions.add(key);
    }
  }
  for (const entry of f12NavigationDrilldowns) {
    const key = actionKey(entry);
    if (seenNextActions.has(key)) continue;
    nextActions.push({
      tool: entry.tool,
      input: entry.input || {},
      why: entry.label ? `Continue from F12 navigation request: ${entry.label}.` : "Continue with a deterministic F12 request-detail route from the latest research pack.",
    });
    seenNextActions.add(key);
    if (nextActions.length >= 8) break;
  }
  for (const entry of researchPackDrilldowns) {
    const key = actionKey(entry);
    if (seenNextActions.has(key)) continue;
    nextActions.push({
      tool: entry.tool,
      input: entry.input || {},
      why: entry.label ? `Continue with research-pack drilldown: ${entry.label}.` : "Continue with a deterministic drilldown from the latest research pack.",
    });
    seenNextActions.add(key);
    if (nextActions.length >= 10) break;
  }
  for (const entry of artifactDrilldowns) {
    const key = actionKey(entry);
    if (seenNextActions.has(key)) continue;
    nextActions.push({
      tool: entry.tool,
      input: entry.input || {},
      why: entry.label ? `Continue with artifact drilldown: ${entry.label}.` : "Continue with a deterministic artifact drilldown from the latest artifact index.",
    });
    seenNextActions.add(key);
    if (nextActions.length >= 12) break;
  }
  nextActions.push({
    tool: "devtools_workflow_guide",
    input: { task: "professional-appsec" },
    why: "Re-read the deterministic workflow if the agent needs the full route.",
  });
  const isConcreteDrilldown = (entry) => {
    const input = entry?.input || {};
    return Boolean(input.requestId || input.path || input.tracePath || input.query);
  };
  const firstConcreteDrilldown = researchPackDrilldowns.find((entry) => entry?.tool && isConcreteDrilldown(entry)) || null;
  const routeSummary = {
    firstStep: nextActions[0] ? { tool: nextActions[0].tool, input: nextActions[0].input || {} } : null,
    latestHandoffInspect: latestResearchPackHandoff?.inspect || null,
    latestHandoffRead: latestResearchPackHandoff?.read || null,
    firstF12RequestDetailArtifact,
    firstF12RequestDetail: f12NavigationDrilldowns[0] ? {
      label: f12NavigationDrilldowns[0].label || null,
      tool: f12NavigationDrilldowns[0].tool,
      input: f12NavigationDrilldowns[0].input || {},
      f12Columns: f12NavigationDrilldowns[0].f12Columns || null,
    } : null,
    firstConcreteDrilldown: firstConcreteDrilldown ? {
      label: firstConcreteDrilldown.label || null,
      tool: firstConcreteDrilldown.tool,
      input: firstConcreteDrilldown.input || {},
    } : null,
    nextActionTools: nextActions.map((entry) => entry.tool),
    artifactEntrypointCount: evidenceEntrypoints ? Object.values(evidenceEntrypoints).filter(Boolean).length : 0,
    f12NavigationRequestCount: f12Navigation?.requestNodeCount ?? null,
    researchPackDrilldownCount: researchPackDrilldowns.length,
    artifactDrilldownCount: artifactDrilldowns.length,
  };
  const readinessSummary = {
    ready: missing.length === 0,
    evidenceReady: Boolean(artifactCount && timelineCount),
    missingCount: missing.length,
    captureEnabled,
    artifactCount,
    timelineEventCount: timelineCount,
    latestResearchPackReady: latestResearchPackSummary?.ready ?? null,
    f12NavigationRequestCount: f12Navigation?.requestNodeCount ?? null,
    latestArtifactKinds: latestArtifacts ? Object.keys(latestArtifacts) : [],
    nextTool: nextActions[0]?.tool || null,
    nextActionCount: nextActions.length,
  };
  return {
    schema: "agent-browser-runtime.professional-readiness.v1",
    backend,
    generatedAt: new Date().toISOString(),
    summary: readinessSummary,
    routeSummary,
    ready: missing.length === 0,
    evidenceReady: Boolean(artifactCount && timelineCount),
    checks,
    missing,
    capture: capture || null,
    captureBuckets,
    harCoverage,
    artifactCount,
    artifactKinds,
    latestArtifacts,
    evidenceEntrypoints,
    timelineEventCount: timelineCount,
    timelineTypes,
    f12Coverage,
    latestResearchPackHandoff,
    latestResearchPackSummary,
    f12Navigation,
    f12NavigationDrilldowns,
    researchPackDrilldowns,
    recommendedRoute,
    panelRoutes: agentUsage?.panelRoutes || null,
    artifactDrilldowns,
    workflowPath: workflow?.defaultPath || null,
    nextActions,
    objectiveBoundary: "This readiness report checks tool workflow and evidence availability only; it does not judge vulnerabilities or security impact.",
  };
}

function buildResearchPackDrilldowns(artifacts = {}, options = {}) {
  const artifactRows = Array.isArray(artifacts.artifactIndex?.artifacts) ? artifacts.artifactIndex.artifacts : [];
  const timelineEvents = Array.isArray(artifacts.evidenceTimeline?.events) ? artifacts.evidenceTimeline.events : [];
  const firstRequest = timelineEvents.find((event) => event.type === "network-request" && event.requestId);
  const harArtifact = artifactRows.find((artifact) => artifact.kind === "har" || String(artifact.path || "").toLowerCase().endsWith(".har"));
  const traceArtifact = artifactRows.find((artifact) => artifact.kind === "trace" || String(artifact.path || "").toLowerCase().includes("\\traces\\") || String(artifact.path || "").toLowerCase().includes("/traces/"));
  const tracePath = artifacts.trace?.tracePath || traceArtifact?.path || null;
  const bundleArtifact = artifactRows.find((artifact) => artifact.kind === "bundle" || String(artifact.path || "").toLowerCase().includes("\\bundles\\") || String(artifact.path || "").toLowerCase().includes("/bundles/"));
  const rows = [
    {
      label: "Chronological evidence orientation",
      tool: "devtools_evidence_timeline",
      input: { maxEvents: 80, maxArtifacts: 120 },
      why: "Start from objective event order before selecting request, console, realtime, or artifact drilldowns.",
    },
    {
      label: "Artifact inventory",
      tool: "devtools_artifact_index",
      input: { maxFiles: 200 },
      why: "List saved HAR, trace, bundle, manifest, graph, and report files without loading large artifacts into context.",
    },
    {
      label: "F12 backend boundary check",
      tool: "devtools_f12_parity_matrix",
      input: {},
      why: "Decide whether a missing signal is a browser/backend boundary or a wrapper gap.",
    },
  ];
  if (firstRequest) {
    rows.push({
      label: "First captured request detail",
      tool: "devtools_request_detail",
      input: { requestId: firstRequest.requestId },
      why: "Inspect headers, cookies, timing, redirect chain, initiator, and body availability for a concrete observed request.",
    });
    rows.push({
      label: "Browser-level replay boundary check",
      tool: "devtools_request_replay_batch",
      input: { requestId: firstRequest.requestId, variants: [{ label: "baseline" }] },
      why: "Compare observed browser-fetch replay behavior while preserving replayBoundary limitations.",
    });
  }
  if (harArtifact?.path) {
    rows.push({
      label: "HAR artifact shape",
      tool: "devtools_artifact_inspect",
      input: { path: harArtifact.path, maxBytes: 8000 },
      why: "Inspect HAR entry/body/timing structure without reading the full file into context.",
    });
  }
  if (tracePath) {
    rows.push({
      label: "Trace event drilldown",
      tool: "devtools_trace_query",
      input: { tracePath, minDurationMs: 5, limit: 20 },
      why: "Query saved Chrome trace events by duration/name/category for performance or execution timing evidence.",
    });
  }
  if (bundleArtifact?.path) {
    rows.push({
      label: "Evidence bundle preview",
      tool: "devtools_artifact_read",
      input: { path: bundleArtifact.path, mode: "line", startLine: 1, maxLines: 80 },
      why: "Read a bounded slice of the compact evidence bundle for handoff context.",
    });
  }
  rows.push({
    label: "Literal evidence search",
    tool: "devtools_artifact_search",
    input: { query: "<literal-url-token-header-or-marker>", maxFiles: 200, maxMatches: 20 },
    why: "Search saved evidence files for a concrete string chosen by the agent or human.",
  });
  const plan = {
    generatedAt: new Date().toISOString(),
    count: rows.length,
    drilldowns: rows,
    boundaries: [
      "Drilldowns are deterministic navigation hints, not vulnerability judgments.",
      "Inputs with placeholder values must be filled by the agent or human from observed evidence.",
    ],
  };
  const planPath = options.path || join(drilldownPlanDir, `${Date.now()}-research-pack-drilldowns.json`);
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return { ...plan, planPath };
}

function buildResearchPackF12Navigation(artifacts = {}, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit) || 10, 50));
  const nodes = Array.isArray(artifacts.correlationGraph?.nodes) ? artifacts.correlationGraph.nodes : [];
  const requestNodes = nodes.filter((node) => node?.type === "request").slice(0, limit);
  const requests = requestNodes.map((node) => {
    const f12Columns = node.f12Columns && typeof node.f12Columns === "object" ? node.f12Columns : {
      name: urlPath(node.url || "") || node.url || null,
      url: node.url || null,
      method: node.method || null,
      status: node.status ?? null,
      type: node.resourceType || null,
      flags: {},
    };
    return {
      requestId: node.requestId || null,
      label: node.label || null,
      url: node.url || f12Columns.url || null,
      status: node.status ?? f12Columns.status ?? null,
      resourceType: node.resourceType || f12Columns.type || null,
      f12Columns,
      detail: node.requestId ? {
        tool: "devtools_request_detail",
        input: { requestId: node.requestId },
        expectedSections: ["overview", "headers", "payload", "cookies", "timing", "initiator", "redirects", "security"],
      } : null,
    };
  });
  return {
    schema: "agent-browser-runtime.f12-navigation.v1",
    generatedAt: new Date().toISOString(),
    requestNodeCount: requests.length,
    firstRequest: requests[0] || null,
    requests,
    artifacts: {
      correlationGraphPath: artifacts.correlationGraph?.graphPath || null,
      harPath: artifacts.har?.harPath || null,
      evidenceBundlePath: artifacts.bundle?.bundlePath || null,
      drilldownPlanPath: artifacts.drilldownPlan?.planPath || null,
    },
    sectionRoutes: {
      networkTable: "devtools_network_log.requests[].f12Columns",
      requestDetail: "devtools_request_detail.detail.f12Sections",
      correlationGraph: "devtools_request_correlation_graph.nodes[type=request].f12Columns",
    },
    boundaries: [
      "f12Navigation is a deterministic route index over captured F12 evidence.",
      "It does not inspect artifact bodies beyond already returned summaries.",
      "It does not decide whether a request is vulnerable or important.",
    ],
  };
}

function summarizeF12RequestDetail(result = {}, route = null) {
  const detail = result?.detail || result?.evidence?.requestDetail?.detail || result?.requestDetail?.detail || null;
  if (!detail) return null;
  const sections = detail.f12Sections || {};
  const requestHeaders = sections.headers?.request || detail.requestHeaders || {};
  const responseHeaders = sections.headers?.response || detail.responseHeaders || {};
  const sectionAvailability = {
    overview: Boolean(sections.overview),
    headers: Boolean(sections.headers),
    payload: Boolean(sections.payload),
    cookies: Boolean(sections.cookies),
    timing: Boolean(sections.timing),
    initiator: Boolean(sections.initiator),
    redirects: Boolean(sections.redirects),
    security: Boolean(sections.security),
  };
  return {
    schema: "agent-browser-runtime.f12-request-detail-summary.v1",
    requestId: detail.requestId || route?.input?.requestId || null,
    url: detail.url || sections.headers?.general?.requestUrl || null,
    method: detail.method || sections.headers?.general?.requestMethod || null,
    status: detail.status ?? sections.headers?.general?.statusCode ?? null,
    resourceType: detail.resourceType || sections.overview?.type || null,
    route,
    sectionAvailability,
    sections: {
      overview: sections.overview || null,
      headers: {
        general: sections.headers?.general || null,
        requestHeaderCount: Object.keys(requestHeaders || {}).length,
        responseHeaderCount: Object.keys(responseHeaders || {}).length,
        requestHeaderNames: Object.keys(requestHeaders || {}).slice(0, 40),
        responseHeaderNames: Object.keys(responseHeaders || {}).slice(0, 40),
        hasRawRequestHeadersText: Boolean(sections.headers?.rawRequestHeadersText || detail.requestHeadersText),
        hasRawResponseHeadersText: Boolean(sections.headers?.rawResponseHeadersText || detail.responseHeadersText),
      },
      payload: sections.payload || {
        hasPostData: Boolean(detail.hasPostData),
        postDataLength: detail.postDataLength ?? null,
        bodyReadable: Boolean(detail.bodyReadable),
        bodyBytes: detail.bodyBytes ?? null,
        bodyPath: detail.bodyPath || null,
      },
      cookies: {
        requestCookieHeaderPresent: Boolean(sections.cookies?.requestCookieHeaderPresent || detail.cookieHeader),
        responseSetCookieHeaderPresent: Boolean(sections.cookies?.responseSetCookieHeaderPresent || detail.setCookieHeader),
        requestCookieCount: Array.isArray(sections.cookies?.requestCookies || detail.requestCookies) ? (sections.cookies?.requestCookies || detail.requestCookies).length : 0,
        associatedCookieCount: Array.isArray(sections.cookies?.associatedCookies || detail.associatedCookies) ? (sections.cookies?.associatedCookies || detail.associatedCookies).length : 0,
        blockedRequestCookieCount: Array.isArray(sections.cookies?.blockedRequestCookies || detail.blockedRequestCookies) ? (sections.cookies?.blockedRequestCookies || detail.blockedRequestCookies).length : 0,
        blockedResponseCookieCount: Array.isArray(sections.cookies?.blockedResponseCookies || detail.blockedResponseCookies) ? (sections.cookies?.blockedResponseCookies || detail.blockedResponseCookies).length : 0,
        browserCookiesForUrlCount: sections.cookies?.browserCookiesForUrlCount ?? (Array.isArray(detail.browserCookiesForUrl) ? detail.browserCookiesForUrl.length : null),
      },
      timing: sections.timing || {
        rawTimingPresent: Boolean(detail.timing),
        phases: detail.timingPhases || null,
      },
      initiator: sections.initiator || {
        type: detail.initiatorType || null,
        summary: detail.initiatorSummary || null,
      },
      redirects: {
        count: sections.redirects?.count ?? (Array.isArray(detail.redirectChain) ? detail.redirectChain.length : 0),
        chain: sections.redirects?.chain || detail.redirectChain || [],
      },
      security: sections.security || {
        protocol: detail.protocol || null,
        securityDetails: detail.securityDetails || null,
      },
    },
    boundaries: [
      "This is a compact objective summary of one captured F12 request detail.",
      "Header values are not duplicated here; call devtools_request_detail with requestId for exact values.",
      "This summary does not classify request importance, exploitability, or vulnerability.",
    ],
  };
}

function workflowGuide(task = "first-pass") {
  const key = String(task || "first-pass").trim().toLowerCase().replace(/[\s_]+/g, "-");
  const recipes = {
    "professional-appsec": {
      title: "Professional AppSec F12 workflow",
      goal: "Use the small facade first, then drill into exact DevTools evidence only when needed.",
      defaultPath: ["browser_open", "browser_capture", "browser_inspect", "browser_security_pack", "drilldownPlan"],
      defaultTools: ["browser_open", "browser_capture", "browser_inspect", "browser_security_pack", "browser_raw"],
      routeSummaryTemplate: {
        firstStep: { tool: "devtools_professional_readiness", input: {} },
        evidencePack: { tool: "browser_security_pack", input: { url: "https://example.com", includeHar: true, includeTrace: true, includeApplicationExport: true } },
        latestHandoffInspect: { tool: "devtools_artifact_inspect", input: { path: "<researchPackPath>" } },
        latestHandoffRead: { tool: "devtools_artifact_read", input: { path: "<researchPackPath>", mode: "line", startLine: 1, maxLines: 120 } },
        firstConcreteDrilldown: "Use devtools_professional_readiness.routeSummary.firstConcreteDrilldown after evidence exists.",
        objectiveBoundary: "This template is routing metadata for the professional workflow; it does not read evidence content or judge vulnerabilities.",
      },
      steps: [
        { tool: "devtools_professional_readiness", input: {}, why: "Check whether workflow, capture status, artifact inventory, and evidence timeline are already mechanically ready." },
        { tool: "browser_open", input: { url: "https://example.com", waitMs: 1000 }, why: "Bind the authorized real Chrome tab to a page and collect page diagnostics." },
        { tool: "browser_capture", input: { action: "start", label: "reproduce" }, why: "Start an explicit F12 recording window before the action." },
        { tool: "browser_act", input: { action: "snapshot" }, why: "Interact or snapshot through the facade so the agent does not choose low-level UI tools first." },
        { tool: "browser_inspect", input: { mode: "overview", limit: 10 }, why: "Read the first objective evidence set and next tool plan." },
        { tool: "browser_security_pack", input: { url: "https://example.com", includeHar: true, includeTrace: true, includeApplicationExport: true }, why: "Save a portable evidence pack, manifest, timeline, and drilldown plan." },
        { tool: "devtools_professional_readiness", input: {}, why: "Confirm the evidence package created the expected handoff, artifact, timeline, and parity readiness signals." },
        { tool: "devtools_artifact_read", input: { path: "<researchPackPath>", mode: "line", startLine: 1, maxLines: 80 }, why: "Preview the handoff artifact without loading every saved file." },
        { tool: "<drilldownPlan.tool>", input: "<drilldownPlan.input>", why: "Continue with concrete request, replay, trace, source, or artifact drilldowns returned by the evidence pack." },
      ],
      exitCriteria: [
        "A research pack handoff file exists.",
        "A drilldown plan exists and contains concrete request/trace/artifact routes.",
        "HAR/Application/trace artifacts are saved when the backend exposes them.",
        "All returned boundaries remain objective and do not classify vulnerabilities.",
      ],
      boundary: "This is the default professional path for agents. Low-level devtools_* calls are drilldowns, not the first interface.",
    },
    "first-pass": {
      title: "First page inspection",
      goal: "Understand current page, backend layer, capture state, and first objective signals.",
      steps: [
        { tool: "devtools_backend_capabilities", why: "Know this is Personal Chrome and what chrome.debugger boundaries apply." },
        { tool: "agent_inspect", input: { focus: "overview", limit: 10 }, why: "Get dashboard evidence and next drill-down tools." },
        { tool: "devtools_signal_summary", why: "List objective cross-panel signals without deciding vulnerability impact." },
      ],
    },
    "security-research-pack": {
      title: "One-call security research evidence pack",
      goal: "Create portable first-pass evidence from the user's active Chrome tab.",
      steps: [
        { tool: "devtools_security_research_pack", input: { url: "https://example.com" }, why: "Capture, reload, collect F12 evidence, and save artifact paths." },
        { tool: "devtools_evidence_manifest", why: "Verify artifact hashes and provenance when needed." },
        { tool: "devtools_request_correlation_graph", why: "Choose which request/script/frame chain to drill into." },
      ],
    },
    "network-capture": {
      title: "Network capture and request drill-down",
      goal: "Record a reproducible action and inspect request details.",
      steps: [
        { tool: "devtools_capture_start", input: { clear: true, label: "reproduce" }, why: "Start an explicit F12 recording window." },
        { tool: "devtools_hard_reload", input: { waitMs: 1000 }, why: "Reload with cache disabled where supported." },
        { tool: "agent_inspect", input: { focus: "network", limit: 20 }, why: "Find request ids and request shapes." },
        { tool: "devtools_har_completeness", input: { includeBodies: true, maxBodyBytes: 2000 }, why: "Check objective HAR body/timing/redirect/security evidence completeness before drilling down." },
        { tool: "devtools_request_detail", input: { requestId: "<request-id>" }, why: "Inspect headers, cookies, timing, initiator, and body availability." },
      ],
    },
    "request-replay": {
      title: "Request replay variants",
      goal: "Replay an observed browser request with bounded variants and compare responses.",
      steps: [
        { tool: "agent_inspect", input: { focus: "network", limit: 20 }, why: "Pick a requestId from captured traffic." },
        { tool: "devtools_request_replay_batch", input: { requestId: "<request-id>", variants: [{ label: "baseline" }] }, why: "Run variants and compare observed browser fetch results." },
      ],
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
        { tool: "devtools_har_completeness", input: { includeBodies: true, maxBodyBytes: 2000 }, why: "Check whether the HAR evidence is complete enough for the claim." },
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
  return {
    backend: "personal-chrome",
    task: key,
    ...(recipes[key] || recipes["first-pass"]),
    availableTasks: Object.keys(recipes),
    boundaries: [
      "Workflow guide is a deterministic recipe, not model reasoning.",
      "Tools return evidence; the agent or human decides interpretation.",
    ],
  };
}

async function browserOpenFacade(params = {}) {
  let opened = null;
  if (params.url) {
    const url = new URL(String(params.url));
    if (!/^https?:$/.test(url.protocol)) throw new Error("url must use http or https");
    opened = await safeBridgeTool("personal_chrome_open", {
      ...params,
      url: url.toString(),
    });
  }
  let diagnostics = await safeBridgeTool("devtools_page_diagnostics", {
    tabId: opened?.tab?.id ?? params.tabId,
  });
  if (diagnostics?.unavailable && opened?.tab?.id) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    diagnostics = await safeBridgeTool("devtools_page_diagnostics", {
      tabId: opened.tab.id,
    });
  }
  return {
    backend: "personal-chrome",
    facade: "browser_open",
    opened,
    diagnostics,
    next: ["browser_inspect", "browser_capture", "browser_security_pack"],
  };
}

async function browserActFacade(params = {}) {
  const action = String(params.action || "").toLowerCase();
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
  const result = await safeBridgeTool(toolName, params);
  return {
    backend: "personal-chrome",
    facade: "browser_act",
    action,
    tool: toolName,
    result,
    next: ["browser_inspect", "browser_capture"],
  };
}

async function browserInspectFacade(params = {}) {
  const mode = params.mode || params.focus || "overview";
  const result = await runAgentInspect({ ...params, focus: mode });
  return {
    backend: "personal-chrome",
    facade: "browser_inspect",
    mode,
    result,
    next: result.nextTools || ["browser_capture", "browser_security_pack"],
  };
}

async function browserCaptureFacade(params = {}) {
  const action = String(params.action || "status").toLowerCase();
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
  const result = await safeBridgeTool(toolName, params);
  return {
    backend: "personal-chrome",
    facade: "browser_capture",
    action,
    tool: toolName,
    result,
    next: ["browser_inspect", "browser_security_pack"],
  };
}

async function browserReplayFacade(params = {}) {
  const toolName = Array.isArray(params.variants) && params.variants.length ? "devtools_request_replay_batch" : "devtools_request_replay";
  const result = await safeBridgeTool(toolName, params);
  return { backend: "personal-chrome", facade: "browser_replay", tool: toolName, result };
}

async function browserRawFacade(params = {}) {
  const toolName = String(params.tool || "").trim();
  if (!toolName.startsWith("devtools_")) throw new Error("browser_raw only allows devtools_* tools");
  if (["devtools_tool_catalog", "devtools_tool_help", "devtools_capability_map", "devtools_f12_parity_matrix", "devtools_workflow_guide", "devtools_professional_readiness"].includes(toolName)) throw new Error("use tool usability helpers directly");
  const result = await callBridgeTool(toolName, params.input || {});
  return { backend: "personal-chrome", facade: "browser_raw", tool: toolName, result };
}

function persistCpuProfile(result, params = {}) {
  if (!result?.profile) return result;
  const path = params.path || join(cpuProfileDir, `${Date.now()}-cpu-profile.json`);
  mkdirSync(dirname(path), { recursive: true });
  const profileText = `${JSON.stringify(result.profile, null, 2)}\n`;
  writeFileSync(path, profileText, "utf8");
  const { profile, ...rest } = result;
  return {
    ...rest,
    cpuProfilePath: path,
    cpuProfileBytes: Buffer.byteLength(profileText, "utf8"),
  };
}

function persistHar(result, params = {}) {
  if (!result?.har) return result;
  const path = params.path || join(harDir, `${Date.now()}-network.har`);
  mkdirSync(dirname(path), { recursive: true });
  const harText = `${JSON.stringify(result.har, null, 2)}\n`;
  writeFileSync(path, harText, "utf8");
  return {
    ok: true,
    profile: result.profile,
    harPath: path,
    harBytes: Buffer.byteLength(harText, "utf8"),
    entryCount: result.har?.log?.entries?.length || 0,
    bodyIndex: result.bodyIndex || [],
    bodyIndexSummary: result.bodyIndexSummary || null,
  };
}

function persistApplicationExport(result, params = {}) {
  if (!result?.export) return result;
  const path = params.path || join(applicationExportDir, `${Date.now()}-application-export.json`);
  mkdirSync(dirname(path), { recursive: true });
  const exportText = `${JSON.stringify(result.export, null, 2)}\n`;
  writeFileSync(path, exportText, "utf8");
  return {
    ok: true,
    tab: result.tab,
    exportPath: path,
    exportBytes: Buffer.byteLength(exportText, "utf8"),
    indexedDbDatabaseCount: result.export.indexedDB?.databases?.length || 0,
    cacheCount: result.export.cacheStorage?.caches?.length || 0,
    serviceWorkerRegistrationCount: result.export.serviceWorker?.registrations?.length || 0,
    cookieCount: Array.isArray(result.export.browserCookies) ? result.export.browserCookies.length : 0,
  };
}

function persistEvidenceBundle(result, params = {}) {
  if (!result?.bundle || params.save === false) return result;
  const path = params.path || join(applicationExportDir, `${Date.now()}-f12-evidence.json`);
  mkdirSync(dirname(path), { recursive: true });
  const bundleText = `${JSON.stringify(result.bundle, null, 2)}\n`;
  writeFileSync(path, bundleText, "utf8");
  return {
    ...result,
    bundlePath: path,
    bundleBytes: Buffer.byteLength(bundleText, "utf8"),
  };
}

function safeArtifactName(raw, fallback = "source") {
  const name = String(raw || fallback)
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .pop() || fallback;
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120) || fallback;
}

function persistSourceMapSources(result, params = {}) {
  if (!Array.isArray(result?.results) || params.save === false) return result;
  const root = params.path || join(sourceMapDir, `${Date.now()}-source-map-sources`);
  mkdirSync(root, { recursive: true });
  const persistedResults = [];
  for (const item of result.results) {
    if (!Array.isArray(item.sources)) {
      persistedResults.push(item);
      continue;
    }
    const scriptName = safeArtifactName(item.script?.url || item.script?.scriptId || "script", "script");
    const scriptDir = join(root, scriptName);
    mkdirSync(scriptDir, { recursive: true });
    const sources = [];
    for (const source of item.sources) {
      if (!source.hasContent) {
        sources.push({ ...source, contentText: undefined, path: null, saved: false, reason: "source map entry has no sourcesContent" });
        continue;
      }
      const file = join(scriptDir, `${String(source.index).padStart(3, "0")}-${safeArtifactName(source.source, "source")}`);
      writeFileSync(file, source.contentText || "", "utf8");
      sources.push({
        ...source,
        contentText: undefined,
        path: file,
        saved: true,
        sha256: sha256File(file),
      });
    }
    persistedResults.push({ ...item, sources, sourceRoot: scriptDir });
  }
  const manifestPath = join(root, "manifest.json");
  const manifest = {
    generatedAt: new Date().toISOString(),
    backend: "personal-chrome",
    count: persistedResults.length,
    results: persistedResults,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return {
    ...result,
    sourceRoot: root,
    manifestPath,
    results: persistedResults,
  };
}

function selectSourceMapOriginalSource(results = [], params = {}) {
  const entries = [];
  for (const [resultIndex, result] of results.entries()) {
    for (const source of result.sources || []) {
      entries.push({
        resultIndex,
        script: result.script || null,
        sourceRoot: result.sourceRoot || null,
        manifestPath: result.manifestPath || null,
        source,
      });
    }
  }
  const savedEntries = entries.filter((entry) => entry.source?.saved && entry.source?.path);
  if (!savedEntries.length) {
    throw new Error("no saved source-map original source is available; the map may not include sourcesContent");
  }
  if (typeof params.index === "number") {
    const byIndex = savedEntries.find((entry) => Number(entry.source?.index) === Number(params.index));
    if (byIndex) return byIndex;
  }
  if (params.source) {
    const needle = String(params.source);
    const exact = savedEntries.find((entry) => String(entry.source?.source || "") === needle);
    if (exact) return exact;
    const partial = savedEntries.find((entry) => String(entry.source?.source || "").includes(needle) || String(entry.source?.resolvedURL || "").includes(needle));
    if (partial) return partial;
  }
  return savedEntries[0];
}

function postProcessToolResult(toolName, result, params = {}) {
  if (toolName === "personal_chrome_screenshot" || toolName === "devtools_screenshot") {
    return persistScreenshot(result, params);
  }
  if (toolName === "personal_chrome_request_body" || toolName === "devtools_request_body") {
    return persistResponseBody(result, params);
  }
  if (toolName === "personal_chrome_chrome_trace" || toolName === "devtools_chrome_trace") {
    return persistChromeTrace(result, params);
  }
  if (toolName === "personal_chrome_cpu_profile" || toolName === "devtools_cpu_profile") {
    return persistCpuProfile(result, params);
  }
  if (toolName === "personal_chrome_save_har" || toolName === "devtools_save_har") {
    return persistHar(result, params);
  }
  if (toolName === "personal_chrome_application_export" || toolName === "devtools_application_export") {
    return persistApplicationExport(result, params);
  }
  if (toolName === "personal_chrome_evidence_bundle" || toolName === "devtools_evidence_bundle") {
    return persistEvidenceBundle(result, params);
  }
  if (toolName === "personal_chrome_source_map_sources" || toolName === "devtools_source_map_sources") {
    return persistSourceMapSources(result, params);
  }
  return result;
}

async function callBridgeTool(toolName, params = {}) {
  if (toolName === "browser_open") {
    return await browserOpenFacade(params);
  }
  if (toolName === "browser_act") {
    return await browserActFacade(params);
  }
  if (toolName === "browser_inspect") {
    return await browserInspectFacade(params);
  }
  if (toolName === "browser_capture") {
    return await browserCaptureFacade(params);
  }
  if (toolName === "browser_security_pack") {
    return { facade: "browser_security_pack", ...(await securityResearchPack(params)) };
  }
  if (toolName === "browser_auth_boundary") {
    return { facade: "browser_auth_boundary", ...(await authBoundaryReport(params)) };
  }
  if (toolName === "browser_diff") {
    return { facade: "browser_diff", ...(await captureDiff(params)) };
  }
  if (toolName === "browser_replay") {
    return await browserReplayFacade(params);
  }
  if (toolName === "browser_raw") {
    return await browserRawFacade(params);
  }
  if (toolName === "personal_chrome_trace_query" || toolName === "devtools_trace_query") {
    return traceQuery(params);
  }
  if (toolName === "personal_chrome_trace_compare" || toolName === "devtools_trace_compare") {
    return traceCompare(params);
  }
  if (toolName === "personal_chrome_artifact_inspect" || toolName === "devtools_artifact_inspect") {
    return inspectArtifactFile(params);
  }
  if (toolName === "personal_chrome_artifact_index" || toolName === "devtools_artifact_index") {
    return artifactIndex(params);
  }
  if (toolName === "personal_chrome_artifact_search" || toolName === "devtools_artifact_search") {
    return artifactSearch(params);
  }
  if (toolName === "personal_chrome_artifact_read" || toolName === "devtools_artifact_read") {
    return readArtifactSlice(params);
  }
  if (toolName === "personal_chrome_source_map_source_get" || toolName === "devtools_source_map_source_get") {
    const maxChars = typeof params.maxChars === "number" ? params.maxChars : 120000;
    if (params.path) {
      const artifact = readSourceMapArtifact(params.path, maxChars);
      return {
        backend: "personal-chrome",
        selectedBy: "path",
        source: {
          path: artifact.path,
          saved: true,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
        },
        contentText: artifact.contentText,
        contentBytes: artifact.contentBytes,
        truncated: artifact.truncated,
        captureBoundaries: [
          "Reads only previously saved source-map evidence under the Personal Chrome source-map evidence directory.",
          "This tool returns source text and artifact provenance; it does not decide whether the source contains a vulnerability.",
        ],
      };
    }
    const extracted = await safeBridgeTool("devtools_source_map_sources", {
      ...params,
      save: true,
      maxContentChars: 0,
    });
    const selected = selectSourceMapOriginalSource(extracted.results || [], params);
    const artifact = readSourceMapArtifact(selected.source.path, maxChars);
    return {
      backend: "personal-chrome",
      tab: extracted.tab || null,
      selectedBy: params.source ? "source" : typeof params.index === "number" ? "index" : "first-saved-source",
      resultIndex: selected.resultIndex,
      script: selected.script,
      sourceRoot: selected.sourceRoot,
      manifestPath: extracted.manifestPath || selected.manifestPath || null,
      source: {
        ...selected.source,
        contentText: undefined,
        content: undefined,
        path: artifact.path,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
      },
      contentText: artifact.contentText,
      contentBytes: artifact.contentBytes,
      truncated: artifact.truncated,
      captureBoundaries: [
        "Only source maps referenced by parsed scripts can be extracted.",
        "sourcesContent is saved when present. External original sources are not fetched unless they are embedded in the source map.",
        "This tool returns source text and artifact provenance; it does not decide whether the source contains a vulnerability.",
      ],
    };
  }
  if (toolName === "personal_chrome_capture_bisect" || toolName === "devtools_capture_bisect") {
    const limit = typeof params.limit === "number" ? params.limit : 200;
    const status = await safeBridgeTool("devtools_capture_status", params);
    const network = await safeBridgeTool("devtools_network_log", { ...params, limit: 1000000 });
    const realtime = await safeBridgeTool("devtools_realtime_log", { ...params, limit });
    return buildPersonalCaptureBisect({
      requests: Array.isArray(network.requests) ? network.requests : [],
      realtime: realtime || {},
      status,
      limit,
      save: params.save !== false,
      path: params.path || null,
    });
  }
  if (toolName === "personal_chrome_har_completeness" || toolName === "devtools_har_completeness") {
    const harResult = await safeBridgeTool("devtools_export_har", {
      ...params,
      includeBodies: params.includeBodies === true,
    });
    const report = {
      backend: "personal-chrome",
      tab: harResult.tab || null,
      ...analyzeHarCompleteness(harResult.har, {
        includeBodies: params.includeBodies === true,
        maxBodyBytes: typeof params.maxBodyBytes === "number" ? params.maxBodyBytes : 200000,
        maxRows: typeof params.maxRows === "number" ? params.maxRows : 50,
      }),
    };
    if (params.save !== false) {
      const outPath = params.path || join(harDir, `${Date.now()}-har-completeness.json`);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      report.reportPath = outPath;
      report.reportBytes = statSync(outPath).size;
    }
    return report;
  }
  if (toolName === "personal_chrome_security_research_pack" || toolName === "devtools_security_research_pack") {
    return await securityResearchPack(params);
  }
  if (toolName === "personal_chrome_evidence_manifest" || toolName === "devtools_evidence_manifest") {
    return await evidenceManifest(params);
  }
  if (toolName === "personal_chrome_evidence_timeline" || toolName === "devtools_evidence_timeline") {
    return await evidenceTimeline(params);
  }
  if (toolName === "personal_chrome_request_correlation_graph" || toolName === "devtools_request_correlation_graph") {
    return await requestCorrelationGraph(params);
  }
  if (toolName === "personal_chrome_capture_diff" || toolName === "devtools_capture_diff") {
    return await captureDiff(params);
  }
  if (toolName === "personal_chrome_auth_boundary_report" || toolName === "devtools_auth_boundary_report") {
    return await authBoundaryReport(params);
  }
  if (toolName === "personal_chrome_worker_frame_deep_dive" || toolName === "devtools_worker_frame_deep_dive") {
    return await workerFrameDeepDive(params);
  }
  if (toolName === "devtools_tool_catalog" || toolName === "personal_chrome_tool_catalog") {
    return toolCatalog(params);
  }
  if (toolName === "devtools_tool_help" || toolName === "personal_chrome_tool_help") {
    const name = String(params?.tool || "").trim();
    if (!tools[name]) throw new Error(`unknown tool: ${name}`);
    return {
      backend: "personal-chrome",
      name,
      category: devtoolsToolCategory(name),
      description: tools[name],
      parameters: { type: "object", properties: {}, note: "Personal Chrome bridge exposes detailed examples through devtools_workflow_guide and docs/personal-chrome-extension.md." },
      hints: {
        firstPass: name === "agent_inspect" || name === "devtools_security_research_pack",
        objectiveBoundary: "This help describes tool usage only; it does not interpret evidence.",
      },
    };
  }
  if (toolName === "devtools_workflow_guide" || toolName === "personal_chrome_workflow_guide") {
    return workflowGuide(params?.task);
  }
  if (toolName === "devtools_capability_map" || toolName === "personal_chrome_capability_map") {
    return capabilityMap();
  }
  if (toolName === "devtools_f12_parity_matrix" || toolName === "personal_chrome_f12_parity_matrix") {
    return f12ParityMatrix();
  }
  if (toolName === "devtools_professional_readiness" || toolName === "personal_chrome_professional_readiness") {
    const workflow = workflowGuide("professional-appsec");
    const capabilityMapResult = capabilityMap();
    const parityMatrix = f12ParityMatrix();
    const captureStatus = await safeBridgeTool("devtools_capture_status", params || {});
    const captureBisect = params?.includeCaptureBisect === false ? null : await safeBridgeTool("devtools_capture_bisect", { ...(params || {}), save: false, limit: 80 });
    const harCompleteness = params?.includeHarCompleteness === false ? null : await safeBridgeTool("devtools_har_completeness", { ...(params || {}), save: false, includeBodies: false, maxRows: 20 });
    const artifactIndex = params?.includeArtifacts === false ? null : await safeBridgeTool("devtools_artifact_index", { maxFiles: 200 });
    const evidenceTimeline = params?.includeTimeline === false ? null : await safeBridgeTool("devtools_evidence_timeline", { maxEvents: 80, maxArtifacts: 120 });
    return buildProfessionalReadiness({
      backend: "personal-chrome",
      workflow,
      capabilityMap: capabilityMapResult,
      parityMatrix,
      captureStatus,
      captureBisect,
      harCompleteness,
      artifactIndex,
      evidenceTimeline,
    });
  }
  if (toolName === "devtools_heap_snapshot" || toolName === "personal_chrome_heap_snapshot") {
    return {
      backend: "personal-chrome",
      notApplicable: true,
      layer: "chrome.debugger",
      tool: toolName,
      reason: "Personal Chrome uses the extension chrome.debugger transport, which does not expose HeapProfiler heap snapshot capture. Use Managed Browser devtools_heap_snapshot for this F12 Memory panel artifact.",
      fallbackTool: "devtools_memory_snapshot",
      managedFallbackTool: "devtools_heap_snapshot",
    };
  }
  const command = normalizeCommand(toolName);
  const result = await callExtension(command, params);
  return postProcessToolResult(toolName, result, params);
}

async function safeBridgeTool(toolName, params = {}) {
  try {
    return await callBridgeTool(toolName, params);
  } catch (error) {
    return { unavailable: true, tool: toolName, error: String(error?.message || error) };
  }
}

async function securityResearchPack(params = {}) {
  const waitMs = typeof params.waitMs === "number" ? params.waitMs : 1200;
  const limit = typeof params.limit === "number" ? params.limit : 25;
  const steps = [];
  if (params.url) {
    const url = new URL(String(params.url));
    if (!/^https?:$/.test(url.protocol)) throw new Error("url must use http or https");
    steps.push({
      step: "navigate",
      result: await safeBridgeTool("devtools_eval", {
        expression: `(() => { location.assign(${JSON.stringify(url.toString())}); return true; })()`,
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  steps.push({ step: "attach", result: await safeBridgeTool("devtools_attach") });
  steps.push({ step: "capture_start", result: await safeBridgeTool("devtools_capture_start", { clear: true, label: "security-research-pack" }) });
  steps.push({ step: "hard_reload", result: await safeBridgeTool("devtools_hard_reload", { waitMs }) });
  const overview = await runAgentInspect({ focus: "overview", limit });
  const network = await runAgentInspect({ focus: "network", limit });
  const storage = await runAgentInspect({ focus: "storage", limit, includeHeavy: true });
  const consoleEvidence = await runAgentInspect({ focus: "console", limit });
  const sources = await runAgentInspect({ focus: "sources", limit });
  const performance = await runAgentInspect({ focus: "performance", limit, includeHeavy: Boolean(params.includePerformanceHeavy) });
  const artifacts = {};
  if (params.includeHar !== false) {
    artifacts.har = await safeBridgeTool("devtools_save_har", { limit: 500, includeBodies: false });
  }
  if (params.includeApplicationExport !== false) {
    artifacts.application = await safeBridgeTool("devtools_application_export", {
      maxIndexedDbRecords: 100,
      maxCacheEntries: 100,
    });
  }
  if (params.includeTrace !== false) {
    artifacts.trace = await safeBridgeTool("devtools_chrome_trace", { durationMs: 800, maxEvents: 20, maxScreenshots: 2 });
    if (artifacts.trace?.tracePath) {
      artifacts.traceQuery = await safeBridgeTool("devtools_trace_query", { tracePath: artifacts.trace.tracePath, limit: 10 });
    }
  }
  artifacts.correlationGraph = await safeBridgeTool("devtools_request_correlation_graph", { limit: 100, save: true });
  artifacts.authBoundary = await safeBridgeTool("devtools_auth_boundary_report", { limit: 50, includeTokenScan: Boolean(params.includeTokenScan), save: true });
  artifacts.workerFrame = await safeBridgeTool("devtools_worker_frame_deep_dive", { includeServiceWorkerDetail: true, save: true });
  artifacts.bundle = await safeBridgeTool("devtools_evidence_bundle", {
    save: true,
    networkLimit: 100,
    sourceLimit: 100,
    includeHar: false,
    includeTokenScan: Boolean(params.includeTokenScan),
  });
  artifacts.artifactIndex = await safeBridgeTool("devtools_artifact_index", { maxFiles: 200 });
  artifacts.evidenceTimeline = await safeBridgeTool("devtools_evidence_timeline", { maxEvents: 80, maxArtifacts: 120 });
  const parityMatrix = await safeBridgeTool("devtools_f12_parity_matrix");
  const workflow = workflowGuide("professional-appsec");
  const toolCatalogSnapshot = toolCatalog({});
  const agentEntryPoints = toolCatalogSnapshot.agentEntryPoints || null;
  const capabilityMapSnapshot = capabilityMap();
  const agentUsage = capabilityMapSnapshot.agentUsage || null;
  const drilldownPlan = buildResearchPackDrilldowns(artifacts);
  artifacts.drilldownPlan = drilldownPlan;
  const f12Navigation = buildResearchPackF12Navigation(artifacts, { limit });
  const firstF12DetailRoute = f12Navigation.requests.find((row) => row?.detail)?.detail || null;
  const firstF12RequestDetail = firstF12DetailRoute
    ? summarizeF12RequestDetail(await safeBridgeTool(firstF12DetailRoute.tool, firstF12DetailRoute.input), firstF12DetailRoute)
    : null;
  let firstF12RequestDetailArtifact = null;
  if (firstF12RequestDetail) {
    const detailPath = join(requestDetailDir, `${Date.now()}-first-f12-request-detail.json`);
    mkdirSync(dirname(detailPath), { recursive: true });
    writeFileSync(detailPath, `${JSON.stringify(firstF12RequestDetail, null, 2)}\n`, "utf8");
    firstF12RequestDetailArtifact = {
      path: detailPath,
      bytes: statSync(detailPath).size,
      sha256: sha256File(detailPath),
    };
    artifacts.firstF12RequestDetail = firstF12RequestDetailArtifact;
  }
  artifacts.manifest = await safeBridgeTool("devtools_evidence_manifest", {
    save: true,
    artifactPaths: [
      artifacts.har?.harPath,
      artifacts.application?.exportPath,
      artifacts.trace?.tracePath,
      artifacts.bundle?.bundlePath,
      artifacts.correlationGraph?.graphPath,
      artifacts.authBoundary?.reportPath,
      artifacts.workerFrame?.reportPath,
      artifacts.drilldownPlan?.planPath,
      firstF12RequestDetailArtifact?.path,
    ].filter(Boolean),
  });
  const networkSummary = network?.evidence?.summary || {};
  const page = overview?.evidence?.diagnostics?.page || overview?.evidence?.backendCapabilities?.activeTab || {};
  const generatedAt = new Date().toISOString();
  const summary = {
    url: page.url || params.url || null,
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
    drilldownPlanPath: drilldownPlan.planPath || null,
    firstF12RequestDetailPath: firstF12RequestDetailArtifact?.path || null,
    artifactFileCount: artifacts.artifactIndex?.totalFileCount ?? null,
    evidenceTimelineEventCount: artifacts.evidenceTimeline?.eventCount ?? null,
    f12ParityPanelCount: parityMatrix?.summary?.panelCount ?? null,
    drilldownCount: drilldownPlan.count,
    f12NavigationRequestCount: f12Navigation.requestNodeCount,
    firstF12RequestDetailSections: firstF12RequestDetail ? Object.entries(firstF12RequestDetail.sectionAvailability).filter(([, present]) => present).map(([name]) => name) : [],
    workflowTask: workflow.task || "professional-appsec",
  };
  const captureBoundaries = [
    "Personal Chrome mode runs against the user's active browser profile after local extension authorization.",
    "This workflow records only evidence observable after capture starts and during the reload/reproduction window.",
    "It organizes F12 evidence for security research but does not decide exploitability.",
  ];
  const nextTools = drilldownPlan.drilldowns.map((entry) => entry.tool);
  const researchPackPath = join(researchPackDir, `${Date.now()}-security-research-pack.json`);
  const handoffDrilldowns = [
    {
      label: "Research pack handoff shape",
      tool: "devtools_artifact_inspect",
      input: { path: researchPackPath, maxBytes: 12000 },
      why: "Inspect the saved handoff JSON structure without loading every underlying artifact.",
    },
    {
      label: "Research pack handoff preview",
      tool: "devtools_artifact_read",
      input: { path: researchPackPath, mode: "line", startLine: 1, maxLines: 120 },
      why: "Read a bounded handoff slice for cross-session or cross-agent context transfer.",
    },
  ];
  const researchPackHandoff = {
    schema: "agent-browser-runtime.security-research-pack-handoff.v1",
    backend: "personal-chrome",
    generatedAt,
    page,
    summary: { ...summary, researchPackPath },
    artifactPaths: {
      harPath: summary.harPath,
      applicationExportPath: summary.applicationExportPath,
      evidenceBundlePath: summary.evidenceBundlePath,
      evidenceManifestPath: summary.evidenceManifestPath,
      correlationGraphPath: summary.correlationGraphPath,
      authBoundaryReportPath: summary.authBoundaryReportPath,
      workerFrameReportPath: summary.workerFrameReportPath,
      drilldownPlanPath: summary.drilldownPlanPath,
      firstF12RequestDetailPath: summary.firstF12RequestDetailPath,
    },
    agentEntryPoints,
    agentUsage,
    toolCatalogSummary: {
      toolCount: toolCatalogSnapshot.toolCount,
      categories: toolCatalogSnapshot.categories,
    },
    workflow,
    drilldownPlan: {
      planPath: drilldownPlan.planPath || null,
      count: drilldownPlan.count,
      drilldowns: drilldownPlan.drilldowns,
      boundaries: drilldownPlan.boundaries,
    },
    paritySummary: parityMatrix?.summary || null,
    f12Navigation,
    firstF12RequestDetail,
    firstF12RequestDetailArtifact,
    captureBoundaries,
    nextTools,
    handoffDrilldowns,
  };
  mkdirSync(dirname(researchPackPath), { recursive: true });
  writeFileSync(researchPackPath, `${JSON.stringify(researchPackHandoff, null, 2)}\n`, "utf8");
  summary.researchPackPath = researchPackPath;
  artifacts.researchPack = {
    path: researchPackPath,
    bytes: statSync(researchPackPath).size,
    sha256: sha256File(researchPackPath),
  };
  artifacts.artifactIndex = await safeBridgeTool("devtools_artifact_index", { maxFiles: 200 });
  summary.artifactFileCount = artifacts.artifactIndex?.totalFileCount ?? summary.artifactFileCount;
  summary.artifactKinds = artifacts.artifactIndex?.kinds || null;
  artifacts.captureStatus = await safeBridgeTool("devtools_capture_status");
  summary.capture = {
    enabled: artifacts.captureStatus?.capture?.enabled ?? null,
    startedAt: artifacts.captureStatus?.capture?.startedAt || null,
    stoppedAt: artifacts.captureStatus?.capture?.stoppedAt || null,
    label: artifacts.captureStatus?.capture?.label || null,
    trafficCount: artifacts.captureStatus?.trackedRequests ?? artifacts.captureStatus?.networkEvents ?? null,
  };
  const handoffCompleteness = buildResearchPackHandoffCompleteness(summary, artifacts, workflow, drilldownPlan, parityMatrix, agentUsage);
  summary.handoffReady = handoffCompleteness.ready;
  summary.handoffPresentCount = handoffCompleteness.presentCount;
  summary.handoffMissing = handoffCompleteness.missing;
  researchPackHandoff.summary = { ...summary, researchPackPath };
  researchPackHandoff.artifactIndexSummary = {
    totalFileCount: artifacts.artifactIndex?.totalFileCount ?? null,
    kinds: artifacts.artifactIndex?.kinds || null,
  };
  researchPackHandoff.captureStatus = artifacts.captureStatus;
  researchPackHandoff.handoffCompleteness = handoffCompleteness;
  writeFileSync(researchPackPath, `${JSON.stringify(researchPackHandoff, null, 2)}\n`, "utf8");
  artifacts.researchPack = {
    path: researchPackPath,
    bytes: statSync(researchPackPath).size,
    sha256: sha256File(researchPackPath),
  };
  const artifactCoverage = buildResearchPackArtifactCoverage(summary, params || {});
  summary.artifactCoverageReady = artifactCoverage.ready;
  summary.artifactCoverageMissing = artifactCoverage.missing;
  summary.artifactCoverageSkipped = artifactCoverage.skipped;
  researchPackHandoff.summary = { ...summary, researchPackPath };
  researchPackHandoff.artifactCoverage = artifactCoverage;
  writeFileSync(researchPackPath, `${JSON.stringify(researchPackHandoff, null, 2)}\n`, "utf8");
  artifacts.researchPack = {
    path: researchPackPath,
    bytes: statSync(researchPackPath).size,
    sha256: sha256File(researchPackPath),
  };
  return {
    backend: "personal-chrome",
    generatedAt,
    page,
    summary,
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
    artifactCoverage,
    handoffCompleteness,
    workflow,
    agentEntryPoints,
    agentUsage,
    toolCatalogSummary: {
      toolCount: toolCatalogSnapshot.toolCount,
      categories: toolCatalogSnapshot.categories,
    },
    parityMatrix,
    f12Navigation,
    firstF12RequestDetail,
    drilldownPlan,
    handoffDrilldowns,
    captureBoundaries,
    nextTools,
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
      drillDown: ["devtools_application_export", "devtools_indexeddb_list", "devtools_indexeddb_read", "devtools_cache_storage_list", "devtools_cache_entry_get"],
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

function professionalAppsecWorkflowSummary() {
  return {
    task: "professional-appsec",
    defaultPath: ["browser_open", "browser_capture", "browser_inspect", "browser_security_pack", "drilldownPlan"],
    guideTool: "devtools_workflow_guide",
    guideInput: { task: "professional-appsec" },
    readinessTool: "devtools_professional_readiness",
    readinessInput: {},
    routeSummaryTemplate: {
      firstStep: { tool: "devtools_professional_readiness", input: {} },
      evidencePack: { tool: "browser_security_pack", input: { includeHar: true, includeTrace: true, includeApplicationExport: true } },
      latestHandoffInspect: { tool: "devtools_artifact_inspect", input: { path: "<researchPackPath>" } },
      latestHandoffRead: { tool: "devtools_artifact_read", input: { path: "<researchPackPath>", mode: "line", startLine: 1, maxLines: 120 } },
      firstConcreteDrilldown: "Use devtools_professional_readiness.routeSummary.firstConcreteDrilldown after evidence exists.",
    },
    firstInterface: "browser_* facade tools",
    drilldownBoundary: "Use devtools_* or browser_raw only after the facade returns concrete evidence or a drilldown route.",
    objectiveBoundary: "The workflow collects and routes F12 evidence; it does not classify vulnerabilities.",
  };
}

function buildResearchPackHandoffCompleteness(summary = {}, artifacts = {}, workflow = {}, drilldownPlan = {}, parityMatrix = {}, agentUsage = {}) {
  const defaultRoute = Array.isArray(agentUsage?.defaultRoute) ? agentUsage.defaultRoute : [];
  const panelRoutes = agentUsage?.panelRoutes || {};
  const checks = [
    { name: "workflow", present: Boolean(workflow?.task && workflow?.defaultPath?.length), evidence: workflow?.task || null },
    { name: "agentUsageRoute", present: Boolean(defaultRoute.some((step) => step.tool === "browser_security_pack") && panelRoutes.network?.some((step) => step.tool === "devtools_request_detail")), evidence: defaultRoute.map((step) => step.tool) },
    { name: "researchPack", present: Boolean(summary.researchPackPath && artifacts.researchPack?.sha256), evidence: summary.researchPackPath || null },
    { name: "drilldownPlan", present: Boolean(summary.drilldownPlanPath && drilldownPlan?.count >= 1), evidence: summary.drilldownPlanPath || null },
    { name: "artifactIndex", present: Boolean(artifacts.artifactIndex?.totalFileCount >= 1), evidence: artifacts.artifactIndex?.totalFileCount ?? null },
    { name: "evidenceTimeline", present: Boolean(artifacts.evidenceTimeline?.eventCount >= 1), evidence: artifacts.evidenceTimeline?.eventCount ?? null },
    { name: "captureStatus", present: Boolean(artifacts.captureStatus?.capture), evidence: summary.capture || null },
    { name: "parityMatrix", present: Boolean(parityMatrix?.summary?.panelCount || parityMatrix?.panelCount), evidence: parityMatrix?.summary?.panelCount ?? parityMatrix?.panelCount ?? null },
  ];
  return {
    schema: "agent-browser-runtime.research-pack-handoff-completeness.v1",
    ready: checks.every((check) => check.present),
    presentCount: checks.filter((check) => check.present).length,
    missing: checks.filter((check) => !check.present).map((check) => check.name),
    checks,
    objectiveBoundary: "This is a mechanical handoff-artifact checklist; it does not decide security impact.",
  };
}

function buildResearchPackArtifactCoverage(summary = {}, options = {}) {
  const requested = {
    har: options.includeHar !== false,
    application: options.includeApplicationExport !== false,
    trace: options.includeTrace !== false,
    bundle: true,
    manifest: true,
    correlationGraph: true,
    authBoundary: true,
    workerFrame: true,
    drilldownPlan: true,
    researchPack: true,
  };
  const paths = {
    har: summary.harPath,
    application: summary.applicationExportPath,
    trace: summary.tracePath,
    bundle: summary.evidenceBundlePath,
    manifest: summary.evidenceManifestPath,
    correlationGraph: summary.correlationGraphPath,
    authBoundary: summary.authBoundaryReportPath,
    workerFrame: summary.workerFrameReportPath,
    drilldownPlan: summary.drilldownPlanPath,
    researchPack: summary.researchPackPath,
  };
  const rows = Object.keys(requested).map((name) => ({
    name,
    requested: requested[name],
    status: requested[name] ? (paths[name] ? "present" : "missing") : "skipped",
    path: paths[name] || null,
  }));
  return {
    schema: "agent-browser-runtime.research-pack-artifact-coverage.v1",
    ready: rows.every((row) => row.status !== "missing"),
    present: rows.filter((row) => row.status === "present").map((row) => row.name),
    missing: rows.filter((row) => row.status === "missing").map((row) => row.name),
    skipped: rows.filter((row) => row.status === "skipped").map((row) => row.name),
    rows,
    objectiveBoundary: "This reports artifact file presence for the requested workflow; it does not judge security impact.",
  };
}

async function runAgentInspect(params = {}) {
  const focus = String(params.focus || "overview");
  const limit = typeof params.limit === "number" ? params.limit : 20;
  const base = { tabId: params.tabId };
  const withBase = (extra = {}) => ({ ...base, ...extra });
  const objectiveSignals = (payload) => {
    if (!payload || typeof payload !== "object") return payload;
    return payload;
  };
  const out = {
    backend: "personal-chrome",
    focus,
    generatedAt: new Date().toISOString(),
    summary: "",
    evidence: {},
    nextTools: [],
    professionalWorkflow: professionalAppsecWorkflowSummary(),
    toolPlan: buildAgentInspectToolPlan(focus, {
      requestId: Boolean(params.requestId),
      query: Boolean(params.query),
      selector: Boolean(params.selector),
      includeHeavy: Boolean(params.includeHeavy),
    }),
  };

  if (focus === "overview") {
    out.evidence.backendCapabilities = await safeBridgeTool("devtools_backend_capabilities", base);
    out.evidence.diagnostics = await safeBridgeTool("devtools_page_diagnostics", withBase({ limit }));
    out.evidence.signals = objectiveSignals(await safeBridgeTool("devtools_signal_summary", withBase({ limit, includeTokenScan: false })));
    out.evidence.network = await safeBridgeTool("devtools_network_summary", withBase({ limit }));
    out.evidence.console = await safeBridgeTool("devtools_console_log", withBase({ reload: false, waitMs: 100, limit }));
    out.summary = "Objective first pass across page, network, console, storage, and browser signals. This does not decide vulnerability impact.";
    out.nextTools = ["agent_inspect focus=network", "agent_inspect focus=storage", "agent_inspect focus=console", "agent_inspect focus=dom", "agent_inspect focus=evidence"];
  } else if (focus === "network") {
    out.evidence.summary = await safeBridgeTool("devtools_network_summary", withBase({ limit: 1000000 }));
    out.evidence.timeline = await safeBridgeTool("devtools_network_timeline", withBase({ limit }));
    out.evidence.requests = await safeBridgeTool("devtools_network_log", withBase({ limit }));
    out.evidence.realtime = await safeBridgeTool("devtools_realtime_log", withBase({ limit }));
    if (params.requestId) {
      out.evidence.requestDetail = await safeBridgeTool("devtools_request_detail", withBase({ requestId: params.requestId }));
      out.evidence.requestBody = await safeBridgeTool("devtools_request_body", withBase({ requestId: params.requestId }));
    }
    out.summary = "Network panel route: summary, timing/initiator rows, captured requests, real-time channels, and optional request drill-down.";
    out.nextTools = ["Use requestId with focus=network", "devtools_realtime_log", "devtools_request_replay", "devtools_request_replay_batch", "devtools_save_har", "agent_inspect focus=search query=<token/url/header>"];
  } else if (focus === "storage") {
    out.evidence.origin = await safeBridgeTool("devtools_storage_origin_summary", base);
    out.evidence.cookies = await safeBridgeTool("devtools_cookie_summary", base);
    out.evidence.serviceWorkers = await safeBridgeTool("devtools_service_worker_summary", base);
    if (params.includeHeavy) out.evidence.storage = await safeBridgeTool("devtools_storage_snapshot", base);
    out.summary = "Application panel route: origin/quota, cookies, service workers, and optional full storage snapshot.";
    out.nextTools = ["devtools_application_export", "devtools_indexeddb_list", "devtools_indexeddb_read", "devtools_cache_storage_list", "devtools_cache_entry_get", "agent_inspect focus=search query=<key/value>"];
  } else if (focus === "console") {
    out.evidence.console = await safeBridgeTool("devtools_console_log", withBase({ reload: false, waitMs: 300, limit }));
    out.evidence.issues = await safeBridgeTool("devtools_issues_log", withBase({ reload: false, waitMs: 100, limit }));
    out.summary = "Console and Issues route: runtime logs, exceptions, security messages, and DevTools issue events.";
    out.nextTools = ["devtools_console_source_context", "agent_inspect focus=sources query=<stack marker>", "agent_inspect focus=debug"];
  } else if (focus === "dom") {
    out.evidence.elements = await safeBridgeTool("devtools_elements_snapshot", withBase({ selector: params.selector, maxNodes: limit * 10 }));
    if (params.query) out.evidence.search = await safeBridgeTool("devtools_dom_search", withBase({ query: params.query, maxResults: limit }));
    if (params.selector) {
      out.evidence.styles = await safeBridgeTool("devtools_css_styles", withBase({ selector: params.selector, maxRules: limit }));
      out.evidence.listeners = await safeBridgeTool("devtools_event_listeners", withBase({ selector: params.selector }));
    }
    out.summary = "Elements panel route: DOM tree, optional live DOM search, selected-node styles, box model, and event listeners.";
    out.nextTools = ["Pass selector for styles/listeners", "Pass query for DOM search", "devtools_dom_mutation_watch"];
  } else if (focus === "sources") {
    out.evidence.sources = await safeBridgeTool("devtools_sources_list", withBase({ limit: limit * 5 }));
    if (params.query) out.evidence.search = await safeBridgeTool("devtools_sources_search", withBase({ query: params.query, maxMatches: limit }));
    out.summary = "Sources panel route: parsed scripts, source maps, literal source search, and debugger drill-down.";
    out.nextTools = ["devtools_source_get", "devtools_source_pretty_print", "devtools_source_map_metadata", "devtools_source_map_source_get", "agent_inspect focus=debug"];
  } else if (focus === "performance") {
    out.evidence.memory = await safeBridgeTool("devtools_memory_snapshot", base);
    out.evidence.observer = await safeBridgeTool("devtools_performance_observer", withBase({ durationMs: 500, maxItems: limit }));
    out.evidence.insights = await safeBridgeTool("devtools_performance_insights", withBase({ durationMs: 500, maxItems: limit, includeChromeTrace: Boolean(params.includeHeavy) }));
    out.evidence.performance = await safeBridgeTool("devtools_performance_trace", withBase({ durationMs: 500 }));
    if (params.includeHeavy) out.evidence.cpuProfile = await safeBridgeTool("devtools_cpu_profile", withBase({ durationMs: 500, maxNodes: limit }));
    out.summary = "Performance route: memory counters plus objective timing, resource, long-task, and optional trace evidence.";
    out.nextTools = ["devtools_performance_observer", "devtools_performance_insights", "devtools_chrome_trace", "devtools_cpu_profile", "devtools_coverage_detail"];
  } else if (focus === "search") {
    if (!params.query) throw new Error("query is required for focus=search");
    out.evidence.search = await safeBridgeTool("devtools_global_search", withBase({ query: params.query, maxMatches: limit }));
    out.summary = "Global search route: literal search across currently available F12 evidence surfaces.";
    out.nextTools = ["agent_inspect focus=network query=<...>", "agent_inspect focus=storage query=<...>", "agent_inspect focus=sources query=<...>"];
  } else if (focus === "evidence") {
    out.evidence.bundle = await safeBridgeTool("devtools_evidence_bundle", withBase({ save: params.save !== false, networkLimit: limit, sourceLimit: limit * 5 }));
    out.summary = "Evidence route: compact export bundle for handoff, report writing, or later Agent review.";
    out.nextTools = ["Open bundlePath", "agent_inspect focus=overview", "agent_inspect focus=search query=<hypothesis>"];
  } else if (focus === "debug") {
    out.evidence.debugger = await safeBridgeTool("devtools_debugger_control", withBase({
      action: params.query ? "pauseOnExpression" : "snapshot",
      expression: params.query || undefined,
      waitMs: 500,
      autoResume: true,
      maxFrames: limit,
    }));
    out.summary = "Debugger route: paused-frame/scope snapshot or expression-triggered pause. Use low-level debugger tool for precise breakpoints.";
    out.nextTools = ["Use query as pauseOnExpression", "devtools_debugger_control action=setBreakpointByUrl", "devtools_source_get"];
  } else {
    throw new Error(`unsupported agent_inspect focus: ${focus}`);
  }

  return out;
}

const wss = new WebSocketServer({ port: wsPort, host: "127.0.0.1", path: "/extension" });
wss.on("connection", (ws) => {
  const id = randomUUID();
  const record = {
    id,
    name: "personal-chrome",
    connectedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    ws,
  };
  clients.set(id, record);

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }
    record.lastSeenAt = new Date().toISOString();
    if (message.type === "hello") {
      record.name = message.name || record.name;
      record.userAgent = message.userAgent;
      record.extensionVersion = message.extensionVersion;
      return;
    }
    if (message.type === "heartbeat") return;
    if (message.type === "result") {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.ok) waiter.resolve(message.result);
      else waiter.reject(new Error(message.error || "extension command failed"));
    }
  });

  ws.on("close", () => {
    clients.delete(id);
  });
});

const tools = {
  browser_open: "Facade: open or switch a page, then return page diagnostics. Use this first for ordinary agent browser work.",
  browser_act: "Facade: perform a common browser action: click, type, scroll, eval, screenshot, or snapshot.",
  browser_inspect: "Facade: inspect the page through agent_inspect modes instead of choosing from dozens of low-level tools.",
  browser_capture: "Facade: manage F12 recording with start, stop, clear, status, or reload.",
  browser_security_pack: "Facade: run the one-call objective security research evidence workflow.",
  browser_auth_boundary: "Facade: collect objective authentication-boundary evidence.",
  browser_diff: "Facade: compare before/after evidence artifacts or current captured traffic.",
  browser_replay: "Facade: replay one captured request or batch variants.",
  browser_raw: "Facade: advanced escape hatch for one exact devtools_* tool.",
  agent_inspect: "Agent-facing F12 router. Pick a focus and get the right DevTools evidence without choosing from dozens of low-level tools.",
  personal_chrome_status: "Check whether the real Chrome extension is connected.",
  personal_chrome_open: "Open a URL in the user's real Chrome through chrome.tabs.update/create, then return tab metadata.",
  personal_chrome_extension_reload: "Reload the unpacked extension service worker after local development changes.",
  personal_chrome_tabs: "List tabs from the user's real Chrome.",
  personal_chrome_active_tab_snapshot: "Read title, URL, visible text, selected text, and controls from the active tab.",
  personal_chrome_screenshot: "Capture the active tab as a PNG and save it locally.",
  personal_chrome_click: "Click in the user's real Chrome by selector, visible text, or x/y coordinate.",
  personal_chrome_type: "Type into the user's real Chrome by CSS selector.",
  personal_chrome_scroll: "Scroll the user's real Chrome tab.",
  personal_chrome_eval: "Evaluate JavaScript in the user's real Chrome tab. Local trusted use only.",
  personal_chrome_devtools_attach: "Attach Chrome debugger to a real Chrome tab and enable Network/Page/Runtime events.",
  personal_chrome_devtools_detach: "Detach Chrome debugger from a real Chrome tab.",
  personal_chrome_devtools_status: "Show debugger attachment and captured event counts for a real Chrome tab.",
  personal_chrome_backend_capabilities: "Explain the Personal Chrome chrome.debugger layer, allowed CDP domains, recording semantics, and boundaries.",
  personal_chrome_protocol_schema: "Return a structured not-applicable response for full CDP protocol schema discovery in Personal Chrome mode.",
  personal_chrome_browser_cdp_command: "Return a structured not-applicable response for browser-process CDP commands in Personal Chrome mode.",
  personal_chrome_browser_version: "Return Personal Chrome browser/user-agent metadata and explain exact Browser.getVersion fallback.",
  personal_chrome_browser_targets: "List Personal Chrome tabs as target-like evidence for agent discovery.",
  personal_chrome_system_info: "Return a structured not-applicable response for SystemInfo.getInfo in Personal Chrome mode.",
  personal_chrome_capture_start: "Start explicit F12 capture for a real Chrome tab. Clears previous capture by default.",
  personal_chrome_capture_stop: "Stop explicit F12 capture for a real Chrome tab.",
  personal_chrome_capture_clear: "Clear captured F12 events for a real Chrome tab.",
  personal_chrome_capture_status: "Show explicit F12 capture status for a real Chrome tab.",
  personal_chrome_capture_bisect: "Bisect captured F12 evidence into Network, page/frame, realtime, and summary buckets.",
  personal_chrome_network_log: "Return structured Network events captured through chrome.debugger.",
  personal_chrome_network_summary: "Summarize captured Network events for agent dashboards and triage.",
  personal_chrome_network_timeline: "Return F12 Network Timing/Initiator-style rows from the user's real Chrome tab.",
  personal_chrome_realtime_log: "Return F12 Network real-time channel evidence: WebSocket lifecycle/frames and EventSource/SSE messages.",
  personal_chrome_export_har: "Export captured Network events as a HAR-like object.",
  personal_chrome_save_har: "Export captured Network events as a HAR-like file and return the saved path.",
  personal_chrome_har_completeness: "Report objective HAR evidence completeness for captured traffic: bodies, truncation, timing phases, redirects, and security details.",
  personal_chrome_request_body: "Return a response body for a captured Network requestId.",
  personal_chrome_request_detail: "Return F12 request-detail evidence for one captured request: headers, cookies, timing, initiator, redirects, and body availability.",
  personal_chrome_request_payload: "Return request payload/postData for a captured Network requestId.",
  personal_chrome_request_replay: "Replay a captured request with optional URL, method, headers, and body overrides.",
  personal_chrome_request_replay_batch: "Replay one captured request through multiple variants and compare response diffs.",
  personal_chrome_console_log: "Return Runtime console and Security events captured through chrome.debugger.",
  personal_chrome_console_source_context: "Return source lines around a Console/exception stack frame script location.",
  personal_chrome_security_summary: "Return current page security context and TLS/certificate summary.",
  personal_chrome_page_diagnostics: "Return a dashboard-friendly page health summary across Network, Security, Storage, Console, and Accessibility.",
  personal_chrome_signal_summary: "Return objective cross-panel browser signals and next drill-down tools.",
  personal_chrome_issues_log: "Return Chrome DevTools Issues-panel events from the user's real Chrome tab.",
  personal_chrome_accessibility_snapshot: "Return Accessibility panel-style AX tree from the user's real Chrome tab.",
  personal_chrome_frame_tree: "Return the Page frame tree and recent frame events.",
  personal_chrome_hard_reload: "Disable cache, optionally bypass service worker, clear logs, and reload the tab.",
  personal_chrome_storage_snapshot: "Read local/session storage, document-visible cookies, and extension cookie API results.",
  personal_chrome_storage_origin_summary: "Return Application-panel origin, storage key, quota, and cookie partition evidence from the user's real Chrome tab.",
  personal_chrome_cookie_summary: "Summarize cookie security attributes and objective attribute signals from the user's real Chrome tab.",
  personal_chrome_service_worker_summary: "Return Application panel-style Service Worker and CacheStorage summary from the user's real Chrome tab.",
  personal_chrome_service_worker_detail: "Return deeper Application panel Service Worker evidence: registrations, scripts, CacheStorage entries, and worker debugger targets.",
  personal_chrome_application_export: "Export Application panel data from the user's real Chrome tab to a JSON file.",
  personal_chrome_indexeddb_list: "List IndexedDB databases, object stores, indexes, and record counts from the user's real Chrome tab.",
  personal_chrome_indexeddb_read: "Read records from a specific IndexedDB database and object store.",
  personal_chrome_cache_storage_list: "List CacheStorage caches and request/response metadata from the user's real Chrome tab.",
  personal_chrome_cache_entry_get: "Read one CacheStorage response body by cache name and URL.",
  personal_chrome_elements_snapshot: "Return DOM tree, layout boxes, and computed style for the user's real Chrome tab.",
  personal_chrome_dom_snapshot: "Return Chrome DOMSnapshot.captureSnapshot data from the user's real Chrome tab.",
  personal_chrome_dom_search: "Search the live DOM in the user's real Chrome tab like Elements panel search.",
  personal_chrome_event_listeners: "Return DevTools Elements-panel Event Listeners for a selected DOM node in the user's real Chrome tab.",
  personal_chrome_css_styles: "Return DevTools Elements-panel Styles/Computed/Box Model evidence for a selected DOM node in the user's real Chrome tab.",
  personal_chrome_dom_mutation_watch: "Watch selected-node DOM mutations in the user's real Chrome tab as Elements-panel breakpoint evidence.",
  personal_chrome_cdp_command: "Run a raw Chrome DevTools Protocol command against the user's real Chrome tab.",
  personal_chrome_debugger_control: "Use Debugger pause/resume/step/breakpoint controls and inspect paused frames/scopes in the user's real Chrome tab.",
  personal_chrome_token_flow_trace: "Instrument fetch, XHR, storage, and cookies in the user's real Chrome tab to capture token-like data flow evidence.",
  personal_chrome_memory_snapshot: "Return Memory/Performance Monitor counters from the user's real Chrome tab.",
  personal_chrome_heap_snapshot: "Structured not-applicable response for HeapProfiler heap snapshots in Personal Chrome mode.",
  personal_chrome_sources_list: "Return Sources panel-style script metadata captured through chrome.debugger.",
  personal_chrome_source_get: "Return JavaScript source for a scriptId captured through chrome.debugger.",
  personal_chrome_source_pretty_print: "Return a DevTools-style heuristic pretty-printed JavaScript source from the user's real Chrome tab.",
  personal_chrome_source_map_metadata: "Return sourceMappingURL and source map metadata from the user's real Chrome tab.",
  personal_chrome_source_map_sources: "Extract original source files from source maps in the user's real Chrome tab.",
  personal_chrome_source_map_source_get: "Read one saved original source file extracted from a source map in the user's real Chrome tab.",
  personal_chrome_global_search: "Search F12 evidence surfaces in the user's real Chrome tab for a literal query.",
  personal_chrome_evidence_bundle: "Export a compact objective F12 evidence bundle from the user's real Chrome tab.",
  personal_chrome_evidence_manifest: "Write a manifest with Personal Chrome evidence paths, hashes, capture metadata, and provenance.",
  personal_chrome_artifact_inspect: "Inspect a saved local Personal Chrome evidence artifact with bounded preview, JSON/HAR shape, and literal matches.",
  personal_chrome_artifact_index: "List saved local Personal Chrome evidence artifacts by type, size, mtime, and path.",
  personal_chrome_artifact_search: "Search saved local Personal Chrome evidence artifacts for a literal query.",
  personal_chrome_artifact_read: "Read a bounded byte or line slice from a saved local Personal Chrome evidence artifact.",
  personal_chrome_evidence_timeline: "Build a chronological timeline across Personal Chrome Network, Console, Issues, realtime, and saved evidence artifacts.",
  personal_chrome_request_correlation_graph: "Build a frame/script/request/console correlation graph from Personal Chrome F12 evidence.",
  personal_chrome_capture_diff: "Compare before/after Personal Chrome evidence artifacts or current captured traffic.",
  personal_chrome_auth_boundary_report: "Collect objective Personal Chrome auth boundary evidence without deciding vulnerability impact.",
  personal_chrome_worker_frame_deep_dive: "Inspect frame, iframe, worker, Service Worker, CacheStorage, and target boundaries in Personal Chrome.",
  personal_chrome_security_research_pack: "Run a one-call security research evidence workflow against the user's real Chrome tab and return artifact paths.",
  personal_chrome_tool_catalog: "Agent usability: list available tools by category, description, required fields, and parameter names.",
  personal_chrome_tool_help: "Agent usability: return description, category, and usage hints for one tool.",
  personal_chrome_capability_map: "Agent usability: return the DevTools capability map grouped by F12 panel, first-pass tools, drill-down tools, artifacts, and raw CDP escape hatches.",
  personal_chrome_f12_parity_matrix: "Agent usability: return an objective F12 parity matrix for professional AppSec work, including supported panels, partial coverage, tool routes, and browser boundaries.",
  personal_chrome_workflow_guide: "Agent usability: return deterministic tool recipes for common browser-security research tasks.",
  personal_chrome_professional_readiness: "Agent usability: report whether the professional F12 evidence workflow is mechanically ready and which objective tool to call next.",
  personal_chrome_sources_search: "Search parsed JavaScript sources captured through chrome.debugger.",
  personal_chrome_performance_trace: "Capture a short Performance panel-style snapshot from the user's real Chrome tab.",
  personal_chrome_performance_insights: "Summarize Performance panel timing, slow resources, long tasks, and optional Chrome trace evidence from the user's real Chrome tab.",
  personal_chrome_performance_observer: "Capture PerformanceObserver entries such as LCP, layout shifts, long tasks, event timing, and long animation frames from the user's real Chrome tab.",
  personal_chrome_chrome_trace: "Capture Chrome Tracing data from the user's real Chrome tab and write the full trace locally.",
  personal_chrome_trace_query: "Query a saved Personal Chrome trace JSON file by event name, category, phase, duration, thread, or time range.",
  personal_chrome_trace_compare: "Compare two saved Personal Chrome trace JSON files by event names, categories, phases, threads, and duration buckets.",
  personal_chrome_cpu_profile: "Capture a JavaScript CPU profile from the user's real Chrome tab and write the full profile locally.",
  personal_chrome_coverage_snapshot: "Capture short JavaScript precise coverage and CSS rule usage from the user's real Chrome tab.",
  personal_chrome_coverage_detail: "Capture Coverage-panel JavaScript/CSS range drilldown data from the user's real Chrome tab.",
  personal_chrome_token_scan: "Scan Network, storage, and cookies for token-like material. Returns full values after the operator authorizes this local browser backend.",
  devtools_tabs: "Unified Agent DevTools API: list browser tabs.",
  devtools_extension_reload: "Unified Agent DevTools API: reload the unpacked extension service worker after local development changes.",
  devtools_snapshot: "Unified Agent DevTools API: read visible text and controls from a tab.",
  devtools_screenshot: "Unified Agent DevTools API: capture a screenshot.",
  devtools_click: "Unified Agent DevTools API: click by selector, text, or coordinates.",
  devtools_type: "Unified Agent DevTools API: type into a field.",
  devtools_scroll: "Unified Agent DevTools API: scroll the page.",
  devtools_eval: "Unified Agent DevTools API: evaluate JavaScript. Local trusted use only.",
  devtools_attach: "Unified Agent DevTools API: attach to DevTools/F12 data layer.",
  devtools_detach: "Unified Agent DevTools API: detach from DevTools/F12 data layer.",
  devtools_status: "Unified Agent DevTools API: inspect attachment and capture status.",
  devtools_backend_capabilities: "Unified Agent DevTools API: explain current backend layer, CDP transport, supported domains, and evidence boundaries.",
  devtools_protocol_schema: "Unified Agent DevTools API: discover CDP domains, commands, events, and parameters where the backend exposes the protocol schema.",
  devtools_browser_cdp_command: "Unified Agent DevTools API: run browser-process CDP commands in Managed Browser mode; structured no-op in Personal Chrome.",
  devtools_browser_version: "Unified Agent DevTools API: return browser version metadata.",
  devtools_browser_targets: "Unified Agent DevTools API: list browser targets or tab-equivalent target evidence.",
  devtools_system_info: "Unified Agent DevTools API: return browser/system information where the backend exposes it.",
  devtools_capture_start: "Unified Agent DevTools API: start explicit F12 capture.",
  devtools_capture_stop: "Unified Agent DevTools API: stop explicit F12 capture.",
  devtools_capture_clear: "Unified Agent DevTools API: clear captured F12 events.",
  devtools_capture_status: "Unified Agent DevTools API: inspect explicit F12 capture status.",
  devtools_capture_bisect: "Unified Agent DevTools API: bisect captured F12 evidence into page/network/realtime buckets.",
  devtools_network_log: "Unified Agent DevTools API: read Network panel-style request log.",
  devtools_network_summary: "Unified Agent DevTools API: summarize captured Network traffic for dashboards and triage.",
  devtools_network_timeline: "Unified Agent DevTools API: read Network Timing/Initiator-style rows.",
  devtools_realtime_log: "Unified Agent DevTools API: read WebSocket frames and EventSource/SSE messages.",
  devtools_export_har: "Unified Agent DevTools API: export captured Network events as HAR.",
  devtools_save_har: "Unified Agent DevTools API: save captured Network events as a HAR file.",
  devtools_har_completeness: "Unified Agent DevTools API: report objective HAR body/timing/redirect/security evidence completeness.",
  devtools_request_body: "Unified Agent DevTools API: read response body for a requestId.",
  devtools_request_detail: "Unified Agent DevTools API: read F12 request-detail evidence by requestId.",
  devtools_request_payload: "Unified Agent DevTools API: read request payload/postData for a requestId.",
  devtools_request_replay: "Unified Agent DevTools API: replay/edit-and-resend a captured request.",
  devtools_request_replay_batch: "Unified Agent DevTools API: replay one captured request through multiple variants and compare response diffs.",
  devtools_console_log: "Unified Agent DevTools API: read Console/Security events.",
  devtools_console_source_context: "Unified Agent DevTools API: read source context around a console stack frame.",
  devtools_security_summary: "Unified Agent DevTools API: summarize page security context and TLS/certificate details.",
  devtools_page_diagnostics: "Unified Agent DevTools API: summarize page health for agent dashboards.",
  devtools_signal_summary: "Unified Agent DevTools API: summarize objective cross-panel browser signals and next drill-down tools.",
  devtools_issues_log: "Unified Agent DevTools API: read Chrome DevTools Issues-panel events.",
  devtools_accessibility_snapshot: "Unified Agent DevTools API: read Accessibility panel-style AX tree.",
  devtools_frame_tree: "Unified Agent DevTools API: read frame/iframe tree.",
  devtools_hard_reload: "Unified Agent DevTools API: disable cache, bypass service worker, and reload.",
  devtools_storage_snapshot: "Unified Agent DevTools API: read storage and cookies.",
  devtools_storage_origin_summary: "Unified Agent DevTools API: read Application-panel origin, storage key, quota, and cookie partition evidence.",
  devtools_cookie_summary: "Unified Agent DevTools API: summarize cookie security attributes and objective attribute signals.",
  devtools_service_worker_summary: "Unified Agent DevTools API: summarize Service Worker registrations and CacheStorage state.",
  devtools_service_worker_detail: "Unified Agent DevTools API: inspect Service Worker registrations, scripts, CacheStorage entries, and worker targets.",
  devtools_application_export: "Unified Agent DevTools API: export Application panel data to a JSON file.",
  devtools_indexeddb_list: "Unified Agent DevTools API: list IndexedDB databases, object stores, indexes, and record counts.",
  devtools_indexeddb_read: "Unified Agent DevTools API: read IndexedDB records by database and object store.",
  devtools_cache_storage_list: "Unified Agent DevTools API: list CacheStorage caches and request/response metadata.",
  devtools_cache_entry_get: "Unified Agent DevTools API: read a CacheStorage response by cache name and URL.",
  devtools_elements_snapshot: "Unified Agent DevTools API: read Elements panel-style DOM tree, layout boxes, and computed style.",
  devtools_dom_snapshot: "Unified Agent DevTools API: read raw Chrome DOMSnapshot data.",
  devtools_dom_search: "Unified Agent DevTools API: search the live DOM like Elements panel search.",
  devtools_event_listeners: "Unified Agent DevTools API: read Elements panel event listeners for a selected DOM node.",
  devtools_css_styles: "Unified Agent DevTools API: read Elements panel Styles/Computed/Box Model evidence for a selected DOM node.",
  devtools_dom_mutation_watch: "Unified Agent DevTools API: watch selected-node DOM mutations as Elements-panel breakpoint evidence.",
  devtools_cdp_command: "Unified Agent DevTools API: run a raw Chrome DevTools Protocol command for unwrapped F12 features.",
  devtools_debugger_control: "Unified Agent DevTools API: use Debugger pause/resume/step/breakpoint controls and inspect paused frames/scopes.",
  devtools_token_flow_trace: "Unified Agent DevTools API: instrument fetch, XHR, storage, and cookies to capture token-like data flow evidence.",
  devtools_memory_snapshot: "Unified Agent DevTools API: read Memory/Performance Monitor counters.",
  devtools_heap_snapshot: "Unified Agent DevTools API: capture a JavaScript heap snapshot where the backend exposes HeapProfiler; structured no-op in Personal Chrome.",
  devtools_sources_list: "Unified Agent DevTools API: list parsed scripts and source maps.",
  devtools_source_get: "Unified Agent DevTools API: read script source by scriptId.",
  devtools_source_pretty_print: "Unified Agent DevTools API: pretty-print parsed JavaScript source.",
  devtools_source_map_metadata: "Unified Agent DevTools API: read source map reference and metadata.",
  devtools_source_map_sources: "Unified Agent DevTools API: extract original source files from source maps.",
  devtools_source_map_source_get: "Unified Agent DevTools API: read one original source file extracted from a source map.",
  devtools_global_search: "Unified Agent DevTools API: search F12 evidence surfaces for a literal query.",
  devtools_evidence_bundle: "Unified Agent DevTools API: export a compact objective F12 evidence bundle.",
  devtools_evidence_manifest: "Unified Agent DevTools API: write a manifest with evidence paths, hashes, capture metadata, and provenance.",
  devtools_artifact_inspect: "Unified Agent DevTools API: inspect a saved evidence artifact with bounded preview, structure, and literal matches.",
  devtools_artifact_index: "Unified Agent DevTools API: list saved evidence artifacts by type, size, mtime, and path.",
  devtools_artifact_search: "Unified Agent DevTools API: literal search across saved evidence artifacts.",
  devtools_artifact_read: "Unified Agent DevTools API: read a bounded byte or line slice from a saved evidence artifact.",
  devtools_evidence_timeline: "Unified Agent DevTools API: build a chronological timeline across captured F12 evidence and saved artifacts.",
  devtools_request_correlation_graph: "Unified Agent DevTools API: build a frame/script/request/console correlation graph from F12 evidence.",
  devtools_capture_diff: "Unified Agent DevTools API: compare before/after evidence artifacts or current captured traffic.",
  devtools_auth_boundary_report: "Unified Agent DevTools API: collect objective auth boundary evidence without deciding vulnerability impact.",
  devtools_worker_frame_deep_dive: "Unified Agent DevTools API: inspect frame, iframe, worker, Service Worker, CacheStorage, and target boundaries.",
  devtools_security_research_pack: "Unified Agent DevTools API: run a one-call security research evidence workflow and return artifact paths.",
  devtools_tool_catalog: "Agent usability: list available tools by category, description, required fields, and parameter names.",
  devtools_tool_help: "Agent usability: return description, category, and usage hints for one tool.",
  devtools_capability_map: "Agent usability: return the DevTools capability map grouped by F12 panel, first-pass tools, drill-down tools, artifacts, and raw CDP escape hatches.",
  devtools_f12_parity_matrix: "Agent usability: return an objective F12 parity matrix for professional AppSec work, including supported panels, partial coverage, tool routes, and browser boundaries.",
  devtools_workflow_guide: "Agent usability: return deterministic tool recipes for common browser-security research tasks.",
  devtools_professional_readiness: "Agent usability: report whether the professional F12 evidence workflow is mechanically ready and which objective tool to call next.",
  devtools_sources_search: "Unified Agent DevTools API: search parsed JavaScript sources by literal query.",
  devtools_performance_trace: "Unified Agent DevTools API: capture navigation/resource/paint/long-task performance data.",
  devtools_performance_insights: "Unified Agent DevTools API: summarize Performance panel timing, resources, long tasks, and optional trace evidence.",
  devtools_performance_observer: "Unified Agent DevTools API: capture PerformanceObserver entries such as LCP, layout shifts, long tasks, event timing, and long animation frames.",
  devtools_chrome_trace: "Unified Agent DevTools API: capture Chrome Tracing data and return a summary plus full trace path.",
  devtools_trace_query: "Unified Agent DevTools API: query saved Chrome trace events by name, category, duration, thread, or time range.",
  devtools_trace_compare: "Unified Agent DevTools API: compare two saved Chrome traces by event names, categories, phases, threads, and duration buckets.",
  devtools_cpu_profile: "Unified Agent DevTools API: capture a JavaScript CPU profile and hotspot summary.",
  devtools_coverage_snapshot: "Unified Agent DevTools API: capture short JavaScript and CSS coverage data.",
  devtools_coverage_detail: "Unified Agent DevTools API: capture Coverage-panel JavaScript/CSS range drilldown data.",
  devtools_token_scan: "Unified Agent DevTools API: scan headers, payloads, storage, and cookies for token-like material.",
};

const httpServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        wsUrl: `ws://127.0.0.1:${wsPort}/extension`,
        connected: clients.size,
        clients: listClients(),
        tools: Object.keys(tools),
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/tools") {
      sendJson(res, 200, { tools });
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/tool/")) {
      const toolName = decodeURIComponent(url.pathname.slice("/tool/".length));
      if (!tools[toolName]) {
        sendJson(res, 404, { error: "tool_not_found", toolName });
        return;
      }
      const params = await readJson(req);
      const result = toolName === "agent_inspect"
        ? await runAgentInspect(params)
        : await callBridgeTool(toolName, params);
      sendJson(res, 200, result);
      return;
    }
    if (req.method === "POST" && url.pathname === "/shutdown") {
      sendJson(res, 200, { ok: true, shuttingDown: true });
      setTimeout(() => {
        httpServer.close();
        wss.close();
        process.exit(0);
      }, 50);
      return;
    }
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: String(error?.message || error) });
  }
});

httpServer.listen(httpPort, "127.0.0.1", () => {
  console.log("Personal Chrome bridge ready:");
  console.log(`- HTTP tools: http://127.0.0.1:${httpPort}/health`);
  console.log(`- Extension WebSocket: ws://127.0.0.1:${wsPort}/extension`);
  console.log(`- Load unpacked extension from: ${join(process.cwd(), "extension")}`);
});
