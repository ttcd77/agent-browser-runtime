import http from "node:http";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { WebSocketServer } from "ws";

const httpPort = Number.parseInt(process.env.PERSONAL_CHROME_HTTP_PORT || "17337", 10);
const wsPort = Number.parseInt(process.env.PERSONAL_CHROME_WS_PORT || "17336", 10);
const commandTimeoutMs = Number.parseInt(process.env.PERSONAL_CHROME_COMMAND_TIMEOUT_MS || "15000", 10);
const screenshotDir = process.env.PERSONAL_CHROME_SCREENSHOT_DIR || join(process.cwd(), "tmp", "personal-chrome-screenshots");
const bodyDir = process.env.PERSONAL_CHROME_BODY_DIR || join(process.cwd(), "tmp", "personal-chrome-bodies");
const traceDir = process.env.PERSONAL_CHROME_TRACE_DIR || join(process.cwd(), "tmp", "personal-chrome-traces");
const harDir = process.env.PERSONAL_CHROME_HAR_DIR || join(process.cwd(), "tmp", "personal-chrome-har");
const applicationExportDir = process.env.PERSONAL_CHROME_APPLICATION_EXPORT_DIR || join(process.cwd(), "tmp", "personal-chrome-application");
const cpuProfileDir = process.env.PERSONAL_CHROME_CPU_PROFILE_DIR || join(process.cwd(), "tmp", "personal-chrome-cpu-profiles");

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
    devtools_capture_start: "chrome_capture_start",
    devtools_capture_stop: "chrome_capture_stop",
    devtools_capture_clear: "chrome_capture_clear",
    devtools_capture_status: "chrome_capture_status",
    devtools_network_log: "chrome_network_log",
    devtools_network_summary: "chrome_network_summary",
    devtools_network_timeline: "chrome_network_timeline",
    devtools_export_har: "chrome_export_har",
    devtools_save_har: "chrome_export_har",
    devtools_request_body: "chrome_request_body",
    devtools_request_detail: "chrome_request_detail",
    devtools_request_payload: "chrome_request_payload",
    devtools_request_replay: "chrome_request_replay",
    devtools_console_log: "chrome_console_log",
    devtools_console_source_context: "chrome_console_source_context",
    devtools_security_summary: "chrome_security_summary",
    devtools_page_diagnostics: "chrome_page_diagnostics",
    devtools_signal_summary: "chrome_signal_summary",
    devtools_risk_summary: "chrome_risk_summary",
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
    devtools_indexeddb_read: "chrome_indexeddb_read",
    devtools_cache_entry_get: "chrome_cache_entry_get",
    devtools_elements_snapshot: "chrome_elements_snapshot",
    devtools_dom_snapshot: "chrome_dom_snapshot",
    devtools_dom_search: "chrome_dom_search",
    devtools_event_listeners: "chrome_event_listeners",
    devtools_css_styles: "chrome_css_styles",
    devtools_dom_mutation_watch: "chrome_dom_mutation_watch",
    devtools_cdp_command: "chrome_cdp_command",
    devtools_debugger_control: "chrome_debugger_control",
    devtools_memory_snapshot: "chrome_memory_snapshot",
    devtools_sources_list: "chrome_sources_list",
    devtools_source_get: "chrome_source_get",
    devtools_source_pretty_print: "chrome_source_pretty_print",
    devtools_source_map_metadata: "chrome_source_map_metadata",
    devtools_global_search: "chrome_global_search",
    devtools_evidence_bundle: "chrome_evidence_bundle",
    devtools_sources_search: "chrome_sources_search",
    devtools_performance_trace: "chrome_performance_trace",
    devtools_chrome_trace: "chrome_chrome_trace",
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
  const { traceText, ...rest } = result;
  return {
    ...rest,
    tracePath: path,
    traceTextBytes: Buffer.byteLength(traceText, "utf8"),
  };
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
  return result;
}

async function callBridgeTool(toolName, params = {}) {
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

async function runAgentInspect(params = {}) {
  const focus = String(params.focus || "overview");
  const limit = typeof params.limit === "number" ? params.limit : 20;
  const base = { tabId: params.tabId };
  const withBase = (extra = {}) => ({ ...base, ...extra });
  const objectiveSignals = (payload) => {
    if (!payload || typeof payload !== "object") return payload;
    const { riskCount, findings, ...rest } = payload;
    return rest;
  };
  const out = {
    backend: "personal-chrome",
    focus,
    generatedAt: new Date().toISOString(),
    summary: "",
    evidence: {},
    nextTools: [],
  };

  if (focus === "overview") {
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
    if (params.requestId) {
      out.evidence.requestDetail = await safeBridgeTool("devtools_request_detail", withBase({ requestId: params.requestId }));
      out.evidence.requestBody = await safeBridgeTool("devtools_request_body", withBase({ requestId: params.requestId }));
    }
    out.summary = "Network panel route: summary, timing/initiator rows, captured requests, and optional request drill-down.";
    out.nextTools = ["Use requestId with focus=network", "devtools_request_replay", "devtools_save_har", "agent_inspect focus=search query=<token/url/header>"];
  } else if (focus === "storage") {
    out.evidence.origin = await safeBridgeTool("devtools_storage_origin_summary", base);
    out.evidence.cookies = await safeBridgeTool("devtools_cookie_summary", base);
    out.evidence.serviceWorkers = await safeBridgeTool("devtools_service_worker_summary", base);
    if (params.includeHeavy) out.evidence.storage = await safeBridgeTool("devtools_storage_snapshot", base);
    out.summary = "Application panel route: origin/quota, cookies, service workers, and optional full storage snapshot.";
    out.nextTools = ["devtools_application_export", "devtools_indexeddb_read", "devtools_cache_entry_get", "agent_inspect focus=search query=<key/value>"];
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
    out.nextTools = ["devtools_source_get", "devtools_source_pretty_print", "devtools_source_map_metadata", "agent_inspect focus=debug"];
  } else if (focus === "performance") {
    out.evidence.memory = await safeBridgeTool("devtools_memory_snapshot", base);
    out.evidence.performance = await safeBridgeTool("devtools_performance_trace", base);
    if (params.includeHeavy) out.evidence.cpuProfile = await safeBridgeTool("devtools_cpu_profile", withBase({ durationMs: 500, maxNodes: limit }));
    out.summary = "Performance route: memory/performance monitor snapshot, with optional heavier CPU profiling.";
    out.nextTools = ["devtools_chrome_trace", "devtools_cpu_profile", "devtools_coverage_detail"];
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
  agent_inspect: "Agent-facing F12 router. Pick a focus and get the right DevTools evidence without choosing from dozens of low-level tools.",
  personal_chrome_status: "Check whether the real Chrome extension is connected.",
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
  personal_chrome_capture_start: "Start explicit F12 capture for a real Chrome tab. Clears previous capture by default.",
  personal_chrome_capture_stop: "Stop explicit F12 capture for a real Chrome tab.",
  personal_chrome_capture_clear: "Clear captured F12 events for a real Chrome tab.",
  personal_chrome_capture_status: "Show explicit F12 capture status for a real Chrome tab.",
  personal_chrome_network_log: "Return structured Network events captured through chrome.debugger.",
  personal_chrome_network_summary: "Summarize captured Network events for agent dashboards and triage.",
  personal_chrome_network_timeline: "Return F12 Network Timing/Initiator-style rows from the user's real Chrome tab.",
  personal_chrome_export_har: "Export captured Network events as a HAR-like object.",
  personal_chrome_save_har: "Export captured Network events as a HAR-like file and return the saved path.",
  personal_chrome_request_body: "Return a response body for a captured Network requestId.",
  personal_chrome_request_detail: "Return F12 request-detail evidence for one captured request: headers, cookies, timing, initiator, redirects, and body availability.",
  personal_chrome_request_payload: "Return request payload/postData for a captured Network requestId.",
  personal_chrome_request_replay: "Replay a captured request with optional URL, method, headers, and body overrides.",
  personal_chrome_console_log: "Return Runtime console and Security events captured through chrome.debugger.",
  personal_chrome_console_source_context: "Return source lines around a Console/exception stack frame script location.",
  personal_chrome_security_summary: "Return current page security context and TLS/certificate summary.",
  personal_chrome_page_diagnostics: "Return a dashboard-friendly page health summary across Network, Security, Storage, Console, and Accessibility.",
  personal_chrome_signal_summary: "Return objective cross-panel browser signals and next drill-down tools.",
  personal_chrome_risk_summary: "Return a first-screen risk summary across Network, Cookies, Storage, Service Workers, Security, and optional token scan.",
  personal_chrome_issues_log: "Return Chrome DevTools Issues-panel events from the user's real Chrome tab.",
  personal_chrome_accessibility_snapshot: "Return Accessibility panel-style AX tree from the user's real Chrome tab.",
  personal_chrome_frame_tree: "Return the Page frame tree and recent frame events.",
  personal_chrome_hard_reload: "Disable cache, optionally bypass service worker, clear logs, and reload the tab.",
  personal_chrome_storage_snapshot: "Read local/session storage, document-visible cookies, and extension cookie API results.",
  personal_chrome_storage_origin_summary: "Return Application-panel origin, storage key, quota, and cookie partition evidence from the user's real Chrome tab.",
  personal_chrome_cookie_summary: "Summarize cookie security attributes and risk hints from the user's real Chrome tab.",
  personal_chrome_service_worker_summary: "Return Application panel-style Service Worker and CacheStorage summary from the user's real Chrome tab.",
  personal_chrome_service_worker_detail: "Return deeper Application panel Service Worker evidence: registrations, scripts, CacheStorage entries, and worker debugger targets.",
  personal_chrome_application_export: "Export Application panel data from the user's real Chrome tab to a JSON file.",
  personal_chrome_indexeddb_read: "Read records from a specific IndexedDB database and object store.",
  personal_chrome_cache_entry_get: "Read one CacheStorage response body by cache name and URL.",
  personal_chrome_elements_snapshot: "Return DOM tree, layout boxes, and computed style for the user's real Chrome tab.",
  personal_chrome_dom_snapshot: "Return Chrome DOMSnapshot.captureSnapshot data from the user's real Chrome tab.",
  personal_chrome_dom_search: "Search the live DOM in the user's real Chrome tab like Elements panel search.",
  personal_chrome_event_listeners: "Return DevTools Elements-panel Event Listeners for a selected DOM node in the user's real Chrome tab.",
  personal_chrome_css_styles: "Return DevTools Elements-panel Styles/Computed/Box Model evidence for a selected DOM node in the user's real Chrome tab.",
  personal_chrome_dom_mutation_watch: "Watch selected-node DOM mutations in the user's real Chrome tab as Elements-panel breakpoint evidence.",
  personal_chrome_cdp_command: "Run a raw Chrome DevTools Protocol command against the user's real Chrome tab.",
  personal_chrome_debugger_control: "Use Debugger pause/resume/step/breakpoint controls and inspect paused frames/scopes in the user's real Chrome tab.",
  personal_chrome_memory_snapshot: "Return Memory/Performance Monitor counters from the user's real Chrome tab.",
  personal_chrome_sources_list: "Return Sources panel-style script metadata captured through chrome.debugger.",
  personal_chrome_source_get: "Return JavaScript source for a scriptId captured through chrome.debugger.",
  personal_chrome_source_pretty_print: "Return a DevTools-style heuristic pretty-printed JavaScript source from the user's real Chrome tab.",
  personal_chrome_source_map_metadata: "Return sourceMappingURL and source map metadata from the user's real Chrome tab.",
  personal_chrome_global_search: "Search F12 evidence surfaces in the user's real Chrome tab for a literal query.",
  personal_chrome_evidence_bundle: "Export a compact objective F12 evidence bundle from the user's real Chrome tab.",
  personal_chrome_sources_search: "Search parsed JavaScript sources captured through chrome.debugger.",
  personal_chrome_performance_trace: "Capture a short Performance panel-style snapshot from the user's real Chrome tab.",
  personal_chrome_chrome_trace: "Capture Chrome Tracing data from the user's real Chrome tab and write the full trace locally.",
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
  devtools_capture_start: "Unified Agent DevTools API: start explicit F12 capture.",
  devtools_capture_stop: "Unified Agent DevTools API: stop explicit F12 capture.",
  devtools_capture_clear: "Unified Agent DevTools API: clear captured F12 events.",
  devtools_capture_status: "Unified Agent DevTools API: inspect explicit F12 capture status.",
  devtools_network_log: "Unified Agent DevTools API: read Network panel-style request log.",
  devtools_network_summary: "Unified Agent DevTools API: summarize captured Network traffic for dashboards and triage.",
  devtools_network_timeline: "Unified Agent DevTools API: read Network Timing/Initiator-style rows.",
  devtools_export_har: "Unified Agent DevTools API: export captured Network events as HAR.",
  devtools_save_har: "Unified Agent DevTools API: save captured Network events as a HAR file.",
  devtools_request_body: "Unified Agent DevTools API: read response body for a requestId.",
  devtools_request_detail: "Unified Agent DevTools API: read F12 request-detail evidence by requestId.",
  devtools_request_payload: "Unified Agent DevTools API: read request payload/postData for a requestId.",
  devtools_request_replay: "Unified Agent DevTools API: replay/edit-and-resend a captured request.",
  devtools_console_log: "Unified Agent DevTools API: read Console/Security events.",
  devtools_console_source_context: "Unified Agent DevTools API: read source context around a console stack frame.",
  devtools_security_summary: "Unified Agent DevTools API: summarize page security context and TLS/certificate details.",
  devtools_page_diagnostics: "Unified Agent DevTools API: summarize page health for agent dashboards.",
  devtools_signal_summary: "Unified Agent DevTools API: summarize objective cross-panel browser signals and next drill-down tools.",
  devtools_risk_summary: "Unified Agent DevTools API: summarize cross-panel browser risks and next drill-down tools.",
  devtools_issues_log: "Unified Agent DevTools API: read Chrome DevTools Issues-panel events.",
  devtools_accessibility_snapshot: "Unified Agent DevTools API: read Accessibility panel-style AX tree.",
  devtools_frame_tree: "Unified Agent DevTools API: read frame/iframe tree.",
  devtools_hard_reload: "Unified Agent DevTools API: disable cache, bypass service worker, and reload.",
  devtools_storage_snapshot: "Unified Agent DevTools API: read storage and cookies.",
  devtools_storage_origin_summary: "Unified Agent DevTools API: read Application-panel origin, storage key, quota, and cookie partition evidence.",
  devtools_cookie_summary: "Unified Agent DevTools API: summarize cookie security attributes and risk hints.",
  devtools_service_worker_summary: "Unified Agent DevTools API: summarize Service Worker registrations and CacheStorage state.",
  devtools_service_worker_detail: "Unified Agent DevTools API: inspect Service Worker registrations, scripts, CacheStorage entries, and worker targets.",
  devtools_application_export: "Unified Agent DevTools API: export Application panel data to a JSON file.",
  devtools_indexeddb_read: "Unified Agent DevTools API: read IndexedDB records by database and object store.",
  devtools_cache_entry_get: "Unified Agent DevTools API: read a CacheStorage response by cache name and URL.",
  devtools_elements_snapshot: "Unified Agent DevTools API: read Elements panel-style DOM tree, layout boxes, and computed style.",
  devtools_dom_snapshot: "Unified Agent DevTools API: read raw Chrome DOMSnapshot data.",
  devtools_dom_search: "Unified Agent DevTools API: search the live DOM like Elements panel search.",
  devtools_event_listeners: "Unified Agent DevTools API: read Elements panel event listeners for a selected DOM node.",
  devtools_css_styles: "Unified Agent DevTools API: read Elements panel Styles/Computed/Box Model evidence for a selected DOM node.",
  devtools_dom_mutation_watch: "Unified Agent DevTools API: watch selected-node DOM mutations as Elements-panel breakpoint evidence.",
  devtools_cdp_command: "Unified Agent DevTools API: run a raw Chrome DevTools Protocol command for unwrapped F12 features.",
  devtools_debugger_control: "Unified Agent DevTools API: use Debugger pause/resume/step/breakpoint controls and inspect paused frames/scopes.",
  devtools_memory_snapshot: "Unified Agent DevTools API: read Memory/Performance Monitor counters.",
  devtools_sources_list: "Unified Agent DevTools API: list parsed scripts and source maps.",
  devtools_source_get: "Unified Agent DevTools API: read script source by scriptId.",
  devtools_source_pretty_print: "Unified Agent DevTools API: pretty-print parsed JavaScript source.",
  devtools_source_map_metadata: "Unified Agent DevTools API: read source map reference and metadata.",
  devtools_global_search: "Unified Agent DevTools API: search F12 evidence surfaces for a literal query.",
  devtools_evidence_bundle: "Unified Agent DevTools API: export a compact objective F12 evidence bundle.",
  devtools_sources_search: "Unified Agent DevTools API: search parsed JavaScript sources by literal query.",
  devtools_performance_trace: "Unified Agent DevTools API: capture navigation/resource/paint/long-task performance data.",
  devtools_chrome_trace: "Unified Agent DevTools API: capture Chrome Tracing data and return a summary plus full trace path.",
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
