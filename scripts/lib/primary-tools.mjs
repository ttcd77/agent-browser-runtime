// Task G: Structural hide of ~140 wrapper tools from default discovery surface.
// Agent sees only PRIMARY_TOOLS (~17) when querying /health — wrappers hidden
// behind ?legacy=1. Wrapper execution is NOT blocked (backward compat); only
// the discovery surface is filtered.

export const PRIMARY_TOOLS = new Set([
  // ── Lifecycle (irreplaceable browser control) ──
  "browser_open",
  "browser_tab_close",
  "browser_tabs",

  // ── Evidence / traffic capture (core collection) ──
  "browser_capture_start",
  "browser_capture_stop",
  "browser_capture_status",
  "profile_traffic_query",
  "profile_traffic_summary",

  // ── Observation / diagnostics (reading page state) ──
  "browser_page_diagnostics",
  "browser_signal_summary",
  "browser_screenshot",
  "browser_snapshot",
  "browser_console_log",
  "browser_security_summary",

  // ── Raw primitives (CDP / HTTP direct) ──
  "browser_cdp_command",
  "profile_raw_request",
  "browser_eval",
]);

export function filterPrimaryToolNames(allToolNames) {
  return allToolNames.filter(name => PRIMARY_TOOLS.has(name));
}
