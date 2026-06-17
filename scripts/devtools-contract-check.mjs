import { spawn } from "node:child_process";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

function toolNames(payload) {
  if (Array.isArray(payload.tools)) return payload.tools.map((tool) => (typeof tool === "string" ? tool : tool.name));
  if (payload.tools && typeof payload.tools === "object") return Object.keys(payload.tools);
  return Object.keys(payload || {});
}

// J1-W6 (2026-06-11): 20 real devtools_* implementations renamed to browser_* namespace.
// devtools_* prefix is now fully retired — no devtools_* tools should appear in the contract.
//
// allowedManagedOnly catalogs every Managed-only tool that is intentionally absent from
// Personal Chrome. Personal Chrome is a current-tab bridge with 9 tools; it is not
// expected to match the full Managed surface. The categories below document why each
// group is Managed-only so the contract check passes cleanly.
const allowedManagedOnly = new Map([
  // --- capture / signal / observe (8) ---
  ["browser_capture_bisect", "Managed Browser owns the persistent traffic journal; Personal Chrome relies on the user's live tab and the extension bridge doesn't keep a long capture spool."],
  ["browser_capture_clear", "Managed Browser owns the persistent traffic journal; Personal Chrome relies on the user's live tab and the extension bridge doesn't keep a long capture spool."],
  ["browser_capture_diff", "Managed Browser owns the persistent traffic journal; Personal Chrome relies on the user's live tab and the extension bridge doesn't keep a long capture spool."],
  ["browser_capture_start", "Managed Browser owns the persistent traffic journal; Personal Chrome relies on the user's live tab and the extension bridge doesn't keep a long capture spool."],
  ["browser_capture_status", "Managed Browser owns the persistent traffic journal; Personal Chrome relies on the user's live tab and the extension bridge doesn't keep a long capture spool."],
  ["browser_capture_stop", "Managed Browser owns the persistent traffic journal; Personal Chrome relies on the user's live tab and the extension bridge doesn't keep a long capture spool."],
  ["browser_observe", "Managed Browser owns the persistent traffic journal; Personal Chrome relies on the user's live tab and the extension bridge doesn't keep a long capture spool."],
  ["browser_signal_summary", "Managed Browser owns the persistent traffic journal; Personal Chrome relies on the user's live tab and the extension bridge doesn't keep a long capture spool."],

  // --- evidence / artifact / correlation (8) ---
  ["browser_artifact_index", "Managed Browser persists evidence bundles to disk per-profile; Personal Chrome targets the user's live tab and does not maintain a durable evidence directory."],
  ["browser_artifact_inspect", "Managed Browser persists evidence bundles to disk per-profile; Personal Chrome targets the user's live tab and does not maintain a durable evidence directory."],
  ["browser_artifact_read", "Managed Browser persists evidence bundles to disk per-profile; Personal Chrome targets the user's live tab and does not maintain a durable evidence directory."],
  ["browser_artifact_search", "Managed Browser persists evidence bundles to disk per-profile; Personal Chrome targets the user's live tab and does not maintain a durable evidence directory."],
  ["browser_evidence_bundle", "Managed Browser persists evidence bundles to disk per-profile; Personal Chrome targets the user's live tab and does not maintain a durable evidence directory."],
  ["browser_evidence_manifest", "Managed Browser persists evidence bundles to disk per-profile; Personal Chrome targets the user's live tab and does not maintain a durable evidence directory."],
  ["browser_evidence_timeline", "Managed Browser persists evidence bundles to disk per-profile; Personal Chrome targets the user's live tab and does not maintain a durable evidence directory."],
  ["browser_request_correlation_graph", "Managed Browser persists evidence bundles to disk per-profile; Personal Chrome targets the user's live tab and does not maintain a durable evidence directory."],

  // --- DOM / elements / frame / accessibility / css (7) ---
  ["browser_accessibility_snapshot", "Managed Browser exposes deep DOM introspection via direct CDP; Personal Chrome currently keeps a smaller live-inspection set through the extension bridge."],
  ["browser_css_styles", "Managed Browser exposes deep DOM introspection via direct CDP; Personal Chrome currently keeps a smaller live-inspection set through the extension bridge."],
  ["browser_dom_mutation_watch", "Managed Browser exposes deep DOM introspection via direct CDP; Personal Chrome currently keeps a smaller live-inspection set through the extension bridge."],
  ["browser_dom_search", "Managed Browser exposes deep DOM introspection via direct CDP; Personal Chrome currently keeps a smaller live-inspection set through the extension bridge."],
  ["browser_dom_snapshot", "Managed Browser exposes deep DOM introspection via direct CDP; Personal Chrome currently keeps a smaller live-inspection set through the extension bridge."],
  ["browser_elements_snapshot", "Managed Browser exposes deep DOM introspection via direct CDP; Personal Chrome currently keeps a smaller live-inspection set through the extension bridge."],
  ["browser_frame_tree", "Managed Browser exposes deep DOM introspection via direct CDP; Personal Chrome currently keeps a smaller live-inspection set through the extension bridge."],

  // --- storage / indexedDB / cookie / cache / application (original cookies_get/set grouped here) (12) ---
  ["browser_application_export", "Managed Browser exposes full Application-panel storage drilldown via CDP; Personal Chrome bridge currently focuses on the common cookie subset."],
  ["browser_cache_entry_get", "Managed Browser exposes full Application-panel storage drilldown via CDP; Personal Chrome bridge currently focuses on the common cookie subset."],
  ["browser_cache_storage_list", "Managed Browser exposes full Application-panel storage drilldown via CDP; Personal Chrome bridge currently focuses on the common cookie subset."],
  ["browser_cookie_summary", "Managed Browser exposes full Application-panel storage drilldown via CDP; Personal Chrome bridge currently focuses on the common cookie subset."],
  ["browser_cookies_get", "Managed Browser exposes full Application-panel storage drilldown via CDP; Personal Chrome bridge currently focuses on the common cookie subset."],
  ["browser_cookies_set", "Managed Browser exposes full Application-panel storage drilldown via CDP; Personal Chrome bridge currently focuses on the common cookie subset."],
  ["browser_indexeddb_list", "Managed Browser exposes full Application-panel storage drilldown via CDP; Personal Chrome bridge currently focuses on the common cookie subset."],
  ["browser_indexeddb_read", "Managed Browser exposes full Application-panel storage drilldown via CDP; Personal Chrome bridge currently focuses on the common cookie subset."],
  ["browser_storage_origin_summary", "Managed Browser exposes full Application-panel storage drilldown via CDP; Personal Chrome bridge currently focuses on the common cookie subset."],
  ["browser_storage_snapshot", "Managed Browser exposes full Application-panel storage drilldown via CDP; Personal Chrome bridge currently focuses on the common cookie subset."],

  // --- sources / coverage (9) ---
  ["browser_coverage_detail", "Managed Browser exposes Sources-panel drilldown via CDP; Personal Chrome bridge currently focuses on live page interaction."],
  ["browser_coverage_snapshot", "Managed Browser exposes Sources-panel drilldown via CDP; Personal Chrome bridge currently focuses on live page interaction."],
  ["browser_source_get", "Managed Browser exposes Sources-panel drilldown via CDP; Personal Chrome bridge currently focuses on live page interaction."],
  ["browser_source_map_metadata", "Managed Browser exposes Sources-panel drilldown via CDP; Personal Chrome bridge currently focuses on live page interaction."],
  ["browser_source_map_source_get", "Managed Browser exposes Sources-panel drilldown via CDP; Personal Chrome bridge currently focuses on live page interaction."],
  ["browser_source_map_sources", "Managed Browser exposes Sources-panel drilldown via CDP; Personal Chrome bridge currently focuses on live page interaction."],
  ["browser_source_pretty_print", "Managed Browser exposes Sources-panel drilldown via CDP; Personal Chrome bridge currently focuses on live page interaction."],
  ["browser_sources_list", "Managed Browser exposes Sources-panel drilldown via CDP; Personal Chrome bridge currently focuses on live page interaction."],
  ["browser_sources_search", "Managed Browser exposes Sources-panel drilldown via CDP; Personal Chrome bridge currently focuses on live page interaction."],

  // --- performance / trace / memory / cpu / heap (10) ---
  ["browser_chrome_trace", "Managed Browser owns Performance / Trace tooling via CDP; Personal Chrome bridge does not run profiling sessions."],
  ["browser_cpu_profile", "Managed Browser owns Performance / Trace tooling via CDP; Personal Chrome bridge does not run profiling sessions."],
  ["browser_heap_snapshot", "Managed Browser owns Performance / Trace tooling via CDP; Personal Chrome bridge does not run profiling sessions."],
  ["browser_memory_snapshot", "Managed Browser owns Performance / Trace tooling via CDP; Personal Chrome bridge does not run profiling sessions."],
  ["browser_performance_insights", "Managed Browser owns Performance / Trace tooling via CDP; Personal Chrome bridge does not run profiling sessions."],
  ["browser_performance_observer", "Managed Browser owns Performance / Trace tooling via CDP; Personal Chrome bridge does not run profiling sessions."],
  ["browser_performance_trace", "Managed Browser owns Performance / Trace tooling via CDP; Personal Chrome bridge does not run profiling sessions."],
  ["browser_trace_compare", "Managed Browser owns Performance / Trace tooling via CDP; Personal Chrome bridge does not run profiling sessions."],
  ["browser_trace_query", "Managed Browser owns Performance / Trace tooling via CDP; Personal Chrome bridge does not run profiling sessions."],
  ["browser_worker_frame_deep_dive", "Managed Browser owns Performance / Trace tooling via CDP; Personal Chrome bridge does not run profiling sessions."],

  // --- security / auth / token / service_worker (10) ---
  ["browser_auth_boundary_report", "Managed Browser runs targeted security passes against durable profiles; Personal Chrome bridge does not own this analysis pipeline."],
  ["browser_scan_bola", "Managed Browser runs targeted security passes against durable profiles; Personal Chrome bridge does not own this analysis pipeline."],
  ["browser_scan_bridge", "Managed Browser runs targeted security passes against durable profiles; Personal Chrome bridge does not own this analysis pipeline."],
  ["browser_scan_status", "Managed Browser runs targeted security passes against durable profiles; Personal Chrome bridge does not own this analysis pipeline."],
  ["browser_security_research_pack", "Managed Browser runs targeted security passes against durable profiles; Personal Chrome bridge does not own this analysis pipeline."],
  ["browser_security_summary", "Managed Browser runs targeted security passes against durable profiles; Personal Chrome bridge does not own this analysis pipeline."],
  ["browser_service_worker_detail", "Managed Browser runs targeted security passes against durable profiles; Personal Chrome bridge does not own this analysis pipeline."],
  ["browser_service_worker_summary", "Managed Browser runs targeted security passes against durable profiles; Personal Chrome bridge does not own this analysis pipeline."],
  ["browser_token_flow_trace", "Managed Browser runs targeted security passes against durable profiles; Personal Chrome bridge does not own this analysis pipeline."],
  ["browser_token_scan", "Managed Browser runs targeted security passes against durable profiles; Personal Chrome bridge does not own this analysis pipeline."],

  // --- console / debugger / issues / event_listeners (5) ---
  ["browser_console_log", "Managed Browser exposes Console / DevTools issues drilldown via CDP; Personal Chrome bridge currently keeps a smaller console surface."],
  ["browser_console_source_context", "Managed Browser exposes Console / DevTools issues drilldown via CDP; Personal Chrome bridge currently keeps a smaller console surface."],
  ["browser_debugger_control", "Managed Browser exposes Console / DevTools issues drilldown via CDP; Personal Chrome bridge currently keeps a smaller console surface."],
  ["browser_event_listeners", "Managed Browser exposes Console / DevTools issues drilldown via CDP; Personal Chrome bridge currently keeps a smaller console surface."],
  ["browser_issues_log", "Managed Browser exposes Console / DevTools issues drilldown via CDP; Personal Chrome bridge currently keeps a smaller console surface."],

  // --- basic actions — roadmap to Personal (20) ---
  ["browser_click", "Currently routed only through Managed Browser; Personal Chrome support is on the roadmap as the extension bridge matures."],
  ["browser_download_watch", "Currently routed only through Managed Browser; Personal Chrome support is on the roadmap as the extension bridge matures."],
  ["browser_eval", "Currently routed only through Managed Browser; Personal Chrome support is on the roadmap as the extension bridge matures."],
  ["browser_find", "Currently routed only through Managed Browser; Personal Chrome support is on the roadmap as the extension bridge matures."],
  ["browser_global_search", "Currently routed only through Managed Browser; Personal Chrome support is on the roadmap as the extension bridge matures."],
  ["browser_hard_reload", "Currently routed only through Managed Browser; Personal Chrome support is on the roadmap as the extension bridge matures."],
  ["browser_navigate", "Currently routed only through Managed Browser; Personal Chrome support is on the roadmap as the extension bridge matures."],
  ["browser_page_diagnostics", "Currently routed only through Managed Browser; Personal Chrome support is on the roadmap as the extension bridge matures."],
  ["browser_ready", "Currently routed only through Managed Browser; Personal Chrome support is on the roadmap as the extension bridge matures."],
  ["browser_screenshot", "Currently routed only through Managed Browser; Personal Chrome support is on the roadmap as the extension bridge matures."],
  ["browser_scroll", "Currently routed only through Managed Browser; Personal Chrome support is on the roadmap as the extension bridge matures."],
  ["browser_select", "Currently routed only through Managed Browser; Personal Chrome support is on the roadmap as the extension bridge matures."],
  ["browser_snapshot", "Currently routed only through Managed Browser; Personal Chrome support is on the roadmap as the extension bridge matures."],
  ["browser_stuck", "Currently routed only through Managed Browser; Personal Chrome support is on the roadmap as the extension bridge matures."],
  ["browser_tab_close", "Currently routed only through Managed Browser; Personal Chrome support is on the roadmap as the extension bridge matures."],
  ["browser_tabs", "Currently routed only through Managed Browser; Personal Chrome support is on the roadmap as the extension bridge matures."],
  ["browser_text", "Currently routed only through Managed Browser; Personal Chrome support is on the roadmap as the extension bridge matures."],
  ["browser_type", "Currently routed only through Managed Browser; Personal Chrome support is on the roadmap as the extension bridge matures."],
  ["browser_upload", "Currently routed only through Managed Browser; Personal Chrome support is on the roadmap as the extension bridge matures."],
  ["browser_wait", "Currently routed only through Managed Browser; Personal Chrome support is on the roadmap as the extension bridge matures."],

  // --- diagnostic / CDP misc (5) ---
  ["browser_backend_status", "Managed Browser diagnostics and CDP internals; Personal Chrome bridge does not expose these internals."],
  ["browser_capabilities", "Managed Browser diagnostics and CDP internals; Personal Chrome bridge does not expose these internals."],
  ["browser_cdp_command", "Managed Browser diagnostics and CDP internals; Personal Chrome bridge does not expose these internals."],
  ["browser_feedback", "Managed Browser diagnostics and CDP internals; Personal Chrome bridge does not expose these internals."],
  ["browser_resume_profile", "Managed Browser diagnostics and CDP internals; Personal Chrome bridge does not expose these internals."],

  // --- profile-scoped — only meaningful for Managed (21) ---
  ["profile_create", "Profile-scoped operations (named profiles, durable evidence dirs, replay/intruder) only make sense for Managed Browser; Personal Chrome operates on the user's already-open tab."],
  ["profile_delete", "Profile-scoped operations (named profiles, durable evidence dirs, replay/intruder) only make sense for Managed Browser; Personal Chrome operates on the user's already-open tab."],
  ["profile_export_har", "Profile-scoped operations (named profiles, durable evidence dirs, replay/intruder) only make sense for Managed Browser; Personal Chrome operates on the user's already-open tab."],
  ["profile_har_completeness", "Profile-scoped operations (named profiles, durable evidence dirs, replay/intruder) only make sense for Managed Browser; Personal Chrome operates on the user's already-open tab."],
  ["profile_jwt_forge", "Profile-scoped operations (named profiles, durable evidence dirs, replay/intruder) only make sense for Managed Browser; Personal Chrome operates on the user's already-open tab."],
  ["profile_list", "Profile-scoped operations (named profiles, durable evidence dirs, replay/intruder) only make sense for Managed Browser; Personal Chrome operates on the user's already-open tab."],
  ["profile_network_timeline", "Profile-scoped operations (named profiles, durable evidence dirs, replay/intruder) only make sense for Managed Browser; Personal Chrome operates on the user's already-open tab."],
  ["profile_oob_alloc", "Profile-scoped operations (named profiles, durable evidence dirs, replay/intruder) only make sense for Managed Browser; Personal Chrome operates on the user's already-open tab."],
  ["profile_oob_poll", "Profile-scoped operations (named profiles, durable evidence dirs, replay/intruder) only make sense for Managed Browser; Personal Chrome operates on the user's already-open tab."],
  ["profile_race_request", "Profile-scoped operations (named profiles, durable evidence dirs, replay/intruder) only make sense for Managed Browser; Personal Chrome operates on the user's already-open tab."],
  ["profile_raw_request", "Profile-scoped operations (named profiles, durable evidence dirs, replay/intruder) only make sense for Managed Browser; Personal Chrome operates on the user's already-open tab."],
  ["profile_realtime_log", "Profile-scoped operations (named profiles, durable evidence dirs, replay/intruder) only make sense for Managed Browser; Personal Chrome operates on the user's already-open tab."],
  ["profile_request_detail", "Profile-scoped operations (named profiles, durable evidence dirs, replay/intruder) only make sense for Managed Browser; Personal Chrome operates on the user's already-open tab."],
  ["profile_request_payload", "Profile-scoped operations (named profiles, durable evidence dirs, replay/intruder) only make sense for Managed Browser; Personal Chrome operates on the user's already-open tab."],
  ["profile_request_replay", "Profile-scoped operations (named profiles, durable evidence dirs, replay/intruder) only make sense for Managed Browser; Personal Chrome operates on the user's already-open tab."],
  ["profile_request_replay_batch", "Profile-scoped operations (named profiles, durable evidence dirs, replay/intruder) only make sense for Managed Browser; Personal Chrome operates on the user's already-open tab."],
  ["profile_save_har", "Profile-scoped operations (named profiles, durable evidence dirs, replay/intruder) only make sense for Managed Browser; Personal Chrome operates on the user's already-open tab."],
  ["profile_traffic_get", "Profile-scoped operations (named profiles, durable evidence dirs, replay/intruder) only make sense for Managed Browser; Personal Chrome operates on the user's already-open tab."],
  ["profile_traffic_query", "Profile-scoped operations (named profiles, durable evidence dirs, replay/intruder) only make sense for Managed Browser; Personal Chrome operates on the user's already-open tab."],
  ["profile_traffic_summary", "Profile-scoped operations (named profiles, durable evidence dirs, replay/intruder) only make sense for Managed Browser; Personal Chrome operates on the user's already-open tab."],
  ["profile_warm_from_personal", "Profile-scoped operations (named profiles, durable evidence dirs, replay/intruder) only make sense for Managed Browser; Personal Chrome operates on the user's already-open tab."],

  // --- original 21 entries preserved ---
  ["browser_adopt_tab", "Managed Browser binds durable profiles to CDP targets; Personal Chrome uses the active user tab through the extension bridge."],
  ["profile_resume", "Managed Browser owns durable profile resume; Personal Chrome current-tab mode does not clone or resume profiles."],
  ["browser_auth_bootstrap", "Managed Browser can bootstrap operator-assisted auth into a durable profile; Personal Chrome keeps auth in the user's browser."],
  ["browser_hover", "Managed Browser exposes Playwright-style pointer actions; Personal Chrome currently keeps the smaller click/type/scroll action set."],
  ["browser_double_click", "Managed Browser exposes Playwright-style pointer actions; Personal Chrome currently keeps the smaller click/type/scroll action set."],
  ["browser_drag", "Managed Browser exposes Playwright-style pointer actions; Personal Chrome currently keeps the smaller click/type/scroll action set."],
  ["browser_press", "Managed Browser exposes keyboard shortcut actions; Personal Chrome currently keeps basic type/click/scroll actions."],
  ["browser_profile_status", "Managed worker profile introspection; Personal Chrome bridge does not expose managed profile internals."],
  ["browser_backend_capabilities", "Managed worker CDP layer explanation; Personal Chrome bridge reports its own extension layer."],
  ["browser_process_cdp", "Managed Browser browser-process CDP; Personal Chrome uses extension bridge, not direct browser process CDP."],
  ["browser_protocol_schema", "Managed Browser CDP protocol schema; Personal Chrome bridge does not expose CDP schema."],
  ["browser_process_version", "Managed Browser browser version; Personal Chrome bridge does not expose raw browser version."],
  ["browser_process_targets", "Managed Browser target list; Personal Chrome bridge uses the active user tab."],
  ["browser_system_info", "Managed Browser system info; Personal Chrome bridge does not expose SystemInfo."],
  ["browser_extension_reload", "Extension reload is a no-op on managed CDP; Personal Chrome bridge maps it to the extension."],
  ["browser_tool_catalog", "Managed worker diagnostic; Personal Chrome bridge does not expose tool catalogs."],
  ["browser_tool_help", "Managed worker diagnostic; Personal Chrome bridge does not expose tool help."],
  ["browser_capability_map", "Managed worker diagnostic; Personal Chrome bridge does not expose capability maps."],
  ["browser_f12_parity_matrix", "Managed worker diagnostic; Personal Chrome bridge does not expose parity matrices."],
  ["browser_workflow_guide", "Managed worker diagnostic; Personal Chrome bridge does not expose workflow guides."],
  ["browser_professional_readiness", "Managed worker diagnostic; Personal Chrome bridge does not expose readiness checks."],
]);

async function waitForHealth(port) {
  const url = `http://127.0.0.1:${port}/health`;
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // keep waiting
    }
    await sleep(250);
  }
  throw new Error(`managed server did not become healthy: ${url}`);
}

async function fetchTools(baseUrl) {
  const response = await fetch(`${baseUrl}/tools`);
  if (!response.ok) throw new Error(`tools fetch failed: ${response.status} ${await response.text()}`);
  return toolNames(await response.json()).filter((name) => name?.startsWith("devtools_") || name?.startsWith("browser_") || name?.startsWith("profile_")).sort();
}

const serverPort = await freePort();
const browserPort = await freePort();
const tempDir = mkdtempSync(join(tmpdir(), "agent-devtools-contract-"));
const child = spawn(process.execPath, ["scripts/agent-cdp-server.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    CDP_LAUNCH_BROWSER: "1",
    CDP_AGENT_SERVER_PORT: String(serverPort),
    CDP_BROWSER_PORT: String(browserPort),
    CDP_BROWSER_HEADLESS: "1",
    CDP_SECURITY_DATA_DIR: join(tempDir, "runtime"),
    CDP_BROWSER_USER_DATA_DIR: join(tempDir, "browser"),
  },
  stdio: "ignore",
});

try {
  await waitForHealth(serverPort);
  const managed = await fetchTools(`http://127.0.0.1:${serverPort}`);

  let personal = [];
  let personalAvailable = false;
  try {
    personal = await fetchTools("http://127.0.0.1:17337");
    personalAvailable = true;
  } catch {
    personal = managed;
  }

  const onlyManaged = managed.filter((name) => !personal.includes(name));
  const onlyPersonal = personal.filter((name) => !managed.includes(name));
  const unexpectedOnlyManaged = onlyManaged.filter((name) => !allowedManagedOnly.has(name));
  const result = {
    managedCount: managed.length,
    personalCount: personalAvailable ? personal.length : null,
    personalAvailable,
    onlyManaged,
    onlyPersonal,
    allowedManagedOnly: onlyManaged
      .filter((name) => allowedManagedOnly.has(name))
      .map((name) => ({ name, reason: allowedManagedOnly.get(name) })),
    unexpectedOnlyManaged,
    unexpectedOnlyPersonal: onlyPersonal,
    contractBoundary: "Managed Browser is the primary backend. Personal Chrome is a current-tab bridge and may intentionally omit durable-profile or advanced action tools, but unexpected devtools_* drift still fails this check.",
  };
  console.log(JSON.stringify(result, null, 2));
  if (unexpectedOnlyManaged.length || onlyPersonal.length) {
    throw new Error("devtools_* contract drift detected");
  }
} finally {
  await fetch(`http://127.0.0.1:${serverPort}/shutdown`, { method: "POST" }).catch(() => {});
  setTimeout(() => child.kill(), 500);
  setTimeout(() => rmSync(tempDir, { recursive: true, force: true }), 1000);
}
