import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Completeness guard — two directions:
//
// FORWARD: every key listed in PERSONAL_FACADE_ROUTES must have a matching
//   `maybeRoutePersonal("<toolName>"` call somewhere in its execute(). If a
//   new key is added to the routes map but the execute() is forgotten, this
//   test turns red immediately and names the missing tools.
//
// REVERSE: every browser_*/devtools_*/profile_* tool registered via
//   `tools.set("<name>", ...)` across all register-*.mjs files and
//   agent-cdp-server.mjs must either:
//     (a) appear in PERSONAL_FACADE_ROUTES, OR
//     (b) be in the MANAGED_ONLY_TOOLS exempt list (tools that intentionally
//         have no personal-backend implementation).
//   This prevents the "60+ routing island" failure mode where a new managed
//   tool silently never reaches the personal backend.
//
// Strategy:
//   1. Parse PERSONAL_FACADE_ROUTES keys (Fix 1: regex now matches any key
//      prefix, not just browser_*).
//   2. Scan all register-*.mjs + agent-cdp-server.mjs for maybeRoutePersonal
//      calls; collect the covered set.
//   3. Forward assertion: every route key is in covered set.
//   4. Reverse assertion: every dual-backend-capable registered tool is either
//      in routes or in the exempt list.

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(__dirname, "..");
const libDir = __dirname;

// ── Exempt list: tools that are intentionally managed-only ───────────────────
// Add a tool here when it has a tools.set() call AND should never route to
// personal backend. Omitting a tool from both this list and PERSONAL_FACADE_ROUTES
// is a test failure.
//
// Categories:
//   - Profile lifecycle (create/delete/adopt/resume): managed infra ops
//   - Capability/status queries: introspect managed worker state
//   - Profiling/tracing/coverage: Playwright-specific, no Chrome extension equiv
//   - Managed-only interaction utilities: observe/stuck/find (no personal impl)
//   - Feedback/download: managed-side only
//   - Attack tools (attack_intruder_*): always run on managed Playwright
//   - devtools_* diagnostic tools: managed worker diagnostics
//   - agent_inspect: managed composite tool

const MANAGED_ONLY_TOOLS = new Set([
  // Profile lifecycle
  "profile_create",
  "profile_list",
  "profile_resume",
  "profile_delete",
  "profile_warm_from_personal",
  "browser_adopt_tab",
  "browser_resume_profile",
  "browser_auth_bootstrap",
  // Capability / status introspection
  "browser_capabilities",
  "browser_ready",
  "browser_backend_status",
  // Managed-only interaction utilities
  "browser_observe",
  "browser_stuck",
  "browser_find",
  // DOM detail (no personal CDP equivalent)
  "browser_dom_snapshot",
  "browser_css_styles",
  // Profiling / tracing / coverage (Playwright-only)
  "browser_memory_snapshot",
  "browser_heap_snapshot",
  "browser_performance_trace",
  "browser_chrome_trace",
  "browser_trace_query",
  "browser_trace_compare",
  "browser_performance_insights",
  "browser_performance_observer",
  "browser_cpu_profile",
  "browser_coverage_snapshot",
  "browser_coverage_detail",
  // Download watcher
  "browser_download_watch",
  // Feedback
  "browser_feedback",
  // Attack / replay tools (always managed)
  "profile_raw_request",
  "profile_race_request",
  "profile_jwt_forge",
  "profile_oob_alloc",
  "profile_oob_poll",
  "attack_intruder_create",
  "attack_intruder_run",
  "attack_intruder_pause",
  "attack_intruder_resume",
  "attack_intruder_status",
  "attack_intruder_results",
  "attack_intruder_evidence",
  // browser_* diagnostic / utility tools (managed worker diagnostics, no personal-backend equivalent)
  "browser_profile_status",
  "browser_backend_capabilities",
  "browser_process_cdp",
  "browser_protocol_schema",
  "browser_process_version",
  "browser_process_targets",
  "browser_system_info",
  "browser_extension_reload",
  "browser_tool_catalog",
  "browser_tool_help",
  "browser_capability_map",
  "browser_f12_parity_matrix",
  "browser_workflow_guide",
  "browser_professional_readiness",
  // Capture sub-tools routed to personal backend via PERSONAL_FACADE_ROUTES
  // (browser_capture_start/stop/clear/status are in the routes map, not here)
  // Scan / analysis tools (read captured traffic, no browser interaction)
  "browser_scan_bridge",
  "browser_scan_bola",
  "browser_scan_status",
  // Python subprocess proxies via attack-harness (DS-A 2026-06-21 port —
  // no Chrome backend, neither personal nor managed; run as pure Python).
  "browser_security_pack",
  "browser_security_research_pack",
  "browser_replay",
  "browser_token_flow_trace",
  "browser_token_scan",
  "browser_sources_search",
  // Composite / meta tool
  "agent_inspect",
  // Agent Workspace tools (managed-only: file I/O, tool usage stats, coordinate-click, framework fill)
  "browser_workspace_status",
  "browser_agent_helpers_read",
  "browser_agent_helpers_write",
  "browser_domain_skills_list",
  "browser_domain_skills_read",
  "browser_domain_skills_write",
  "browser_tool_usage",
  "browser_click_xy",
  "browser_fill_framework",
  "browser_screenshot_drive",
]);

// Prefixes that identify dual-backend-capable tool families.
// Tools with these prefixes registered via tools.set() must be either in
// PERSONAL_FACADE_ROUTES or in MANAGED_ONLY_TOOLS.
const DUAL_BACKEND_PREFIXES = ["browser_", "devtools_", "profile_"];

// ── Step 1: extract PERSONAL_FACADE_ROUTES keys ──────────────────────────────

function extractPersonalFacadeRoutes(source) {
  // Find the block between `const PERSONAL_FACADE_ROUTES = {` and the matching `};`
  const blockStart = source.indexOf("const PERSONAL_FACADE_ROUTES = {");
  if (blockStart === -1) {
    throw new Error("PERSONAL_FACADE_ROUTES not found in agent-cdp-server.mjs");
  }
  // Walk forward to find the closing `};`
  let depth = 0;
  let i = source.indexOf("{", blockStart);
  const blockStartBrace = i;
  while (i < source.length) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
    i++;
  }
  const block = source.slice(blockStartBrace, i + 1);

  // Fix 1: Match any key name (was: browser_\w+ only, missed devtools_* and profile_*).
  // New pattern matches bare-word keys: `  someKey:` or `  "someKey":` inside the block.
  const keys = new Set();
  const keyPattern = /^\s+([a-z_][a-z0-9_]*)\s*:/gm;
  let m;
  while ((m = keyPattern.exec(block)) !== null) {
    keys.add(m[1]);
  }
  return keys;
}

// ── Step 2: collect all maybeRoutePersonal("xxx") call sites ─────────────────

function collectCoveredTools(sources) {
  const covered = new Set();
  const callPattern = /maybeRoutePersonal\(\s*["'](\w+)["']/g;
  for (const src of sources) {
    let m;
    while ((m = callPattern.exec(src)) !== null) {
      covered.add(m[1]);
    }
  }
  return covered;
}

// ── Step 3: extract all tools registered via tools.set("<name>", ...) ────────

function extractRegisteredToolNames(sources) {
  const names = new Set();
  // Match tools.set("toolName", or tools.set('toolName',
  const setPattern = /tools\.set\s*\(\s*["']([a-z_][a-z0-9_]*)["']/g;
  for (const src of sources) {
    let m;
    while ((m = setPattern.exec(src)) !== null) {
      names.add(m[1]);
    }
  }
  return names;
}

// ── Load source files ─────────────────────────────────────────────────────────

function loadSources() {
  const sources = [];

  // agent-cdp-server.mjs (routes map lives here; some calls may too)
  const serverSrc = readFileSync(join(scriptsDir, "agent-cdp-server.mjs"), "utf8");
  sources.push(serverSrc);

  // All register-*.mjs in scripts/lib/
  const libFiles = readdirSync(libDir).filter(
    (f) => f.startsWith("register-") && f.endsWith(".mjs") && !f.endsWith(".test.mjs"),
  );
  for (const f of libFiles) {
    sources.push(readFileSync(join(libDir, f), "utf8"));
  }

  return { serverSrc, sources };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("dual-backend completeness: PERSONAL_FACADE_ROUTES ↔ maybeRoutePersonal calls", () => {
  const { serverSrc, sources } = loadSources();
  const routeKeys = extractPersonalFacadeRoutes(serverSrc);
  const coveredTools = collectCoveredTools(sources);
  const registeredTools = extractRegisteredToolNames(sources);

  it("PERSONAL_FACADE_ROUTES is non-empty (sanity: parser found the block)", () => {
    expect(routeKeys.size).toBeGreaterThan(0);
  });

  it("maybeRoutePersonal call set is non-empty (sanity: scanner found calls)", () => {
    expect(coveredTools.size).toBeGreaterThan(0);
  });

  // ── FORWARD check ──────────────────────────────────────────────────────────
  it("every PERSONAL_FACADE_ROUTES key has a matching maybeRoutePersonal() call in execute()", () => {
    const missing = [...routeKeys].filter((k) => !coveredTools.has(k));
    expect(missing, `Missing maybeRoutePersonal() calls for: ${missing.join(", ")}`).toHaveLength(0);
  });

  it("reports how many tools are covered (informational)", () => {
    // This test always passes; it exists to surface the count in the vitest output.
    const covered = [...routeKeys].filter((k) => coveredTools.has(k));
    expect(covered.length).toBe(routeKeys.size);
  });

  // ── REVERSE check (Fix 2) ──────────────────────────────────────────────────
  // Every dual-backend-capable tool registered via tools.set() must either be
  // in PERSONAL_FACADE_ROUTES or explicitly declared in MANAGED_ONLY_TOOLS.
  // A tool that appears in neither is a routing island — it can never reach the
  // personal backend and the omission is unreviewed.
  it("every registered dual-backend-capable tool is either in PERSONAL_FACADE_ROUTES or MANAGED_ONLY_TOOLS", () => {
    const dualBackendTools = [...registeredTools].filter((name) =>
      DUAL_BACKEND_PREFIXES.some((prefix) => name.startsWith(prefix)),
    );

    const islands = dualBackendTools.filter(
      (name) => !routeKeys.has(name) && !MANAGED_ONLY_TOOLS.has(name),
    );

    expect(
      islands,
      `Routing islands found — these tools are registered but missing from both ` +
        `PERSONAL_FACADE_ROUTES and MANAGED_ONLY_TOOLS:\n  ${islands.join("\n  ")}\n` +
        `Either add them to PERSONAL_FACADE_ROUTES (if they need personal-backend support) ` +
        `or to MANAGED_ONLY_TOOLS in this test file (if they are intentionally managed-only).`,
    ).toHaveLength(0);
  });
});
