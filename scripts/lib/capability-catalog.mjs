// Pure capability-catalog builders, extracted from agent-cdp-server.mjs
// (behavior-preserving monolith carve). These turn the static tool registry
// (plain { name, description, parameters } entries) into navigation metadata:
// per-tool category, agent entry-point routes, capability/usage maps, the
// F12 parity matrix, the workflow guide, and the product capability map. No CDP
// client, no filesystem, no module state beyond the static DEVTOOLS_CAPABILITY_META
// table: every function takes plain data/options and returns data using only JS
// stdlib. Unit-tested in capability-catalog.test.mjs.

export function devtoolsToolCategory(name) {
  if (name === "agent_inspect" || /backend_capabilities|tool_catalog|tool_help|workflow_guide|capability_map|parity_matrix|professional_readiness|protocol_schema/.test(name)) return "orientation";
  if (/tabs|snapshot|screenshot|click|type|scroll|eval|hard_reload/.test(name)) return "page-control";
  if (/network|request|har|capture_|realtime/.test(name)) return "network";
  if (/console|issues|security_summary|signal_summary|page_diagnostics/.test(name)) return "diagnostics";
  if (/storage|cookie|service_worker|application|indexeddb|cache|auth_boundary/.test(name)) return "application";
  if (/frame|accessibility|elements|dom|css|event_listeners|worker_frame/.test(name)) return "dom-frame";
  if (/source|debugger|token_flow|global_search/.test(name)) return "sources-debugger";
  if (/performance|trace|cpu|coverage|memory|heap/.test(name)) return "performance";
  if (/evidence|manifest|artifact|correlation|diff|research_pack/.test(name)) return "evidence-workflow";
  if (/cdp_command|process_cdp|browser_version|browser_targets|process_version|process_targets|system_info/.test(name)) return "raw-cdp";
  return "other";
}

export function buildAgentToolEntryPoints(available) {
  const pick = (names) => names.filter((name) => available.has(name));
  const compressedTools = [
    {
      label: "orient",
      purpose: "Check backend, workflow readiness, and available capability areas before using low-level tools.",
      tools: pick(["browser_professional_readiness", "browser_workflow_guide", "browser_capability_map", "browser_f12_parity_matrix"]),
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
      tools: pick(["browser_security_pack", "browser_security_research_pack"]),
    },
    {
      label: "drilldown",
      purpose: "Use the drilldownPlan, artifact index/search/read, request detail, trace query, and source tools after concrete evidence exists.",
      tools: pick(["browser_artifact_index", "browser_evidence_timeline", "profile_request_detail", "browser_trace_query", "browser_sources_search"]),
    },
    {
      label: "escape-hatch",
      purpose: "Call raw CDP only when the facade and friendly browser_* tools cannot express the exact F12 operation.",
      tools: pick(["browser_raw", "browser_protocol_schema", "browser_cdp_command"]),
    },
  ];
  return {
    defaultMode: "facade-first",
    recommendedFirstCall: available.has("browser_professional_readiness") ? "browser_professional_readiness" : "browser_capability_map",
    facadePath: pick(["browser_open", "browser_capture", "browser_inspect", "browser_security_pack", "browser_raw"]),
    professionalPath: pick(["browser_open", "browser_capture", "browser_inspect", "browser_security_pack"]),
    professionalRouteSummary: {
      firstStep: available.has("browser_professional_readiness")
        ? { tool: "browser_professional_readiness", input: {} }
        : { tool: "browser_capability_map", input: {} },
      standardWorkflow: pick(["browser_open", "browser_capture", "browser_inspect", "browser_security_pack"]),
      evidencePack: available.has("browser_security_pack")
        ? { tool: "browser_security_pack", input: { includeHar: true, includeTrace: true, includeApplicationExport: true } }
        : null,
      handoffInspectTemplate: available.has("browser_artifact_inspect")
        ? { tool: "browser_artifact_inspect", input: { path: "<researchPackPath>" } }
        : null,
      handoffReadTemplate: available.has("browser_artifact_read")
        ? { tool: "browser_artifact_read", input: { path: "<researchPackPath>", mode: "line", startLine: 1, maxLines: 120 } }
        : null,
      firstConcreteDrilldownSources: [
        "browser_professional_readiness.routeSummary.firstConcreteDrilldown",
        "browser_security_research_pack.drilldownPlan.drilldowns",
        "browser_artifact_index.recommendedDrilldowns",
      ],
      objectiveBoundary: "This catalog route is a stateless template; use readiness routeSummary for current evidence and do not treat the route as a vulnerability judgment.",
    },
    drilldownRule: "Use low-level tools only after a facade call returns concrete evidence, an artifact path, requestId, frameId, scriptId, or drilldownPlan entry.",
    compressedTools,
    objectiveBoundary: "This entry plan is routing metadata only; it does not judge vulnerabilities or security impact.",
  };
}

export function buildCapabilityAgentUsage(available, backend = "unknown") {
  const includeProfile = backend === "managed-cdp";
  const input = (value = {}) => includeProfile ? { profile: "researcher", ...value } : value;
  const route = (steps) => steps.filter((step) => available.has(step.tool));
  return {
    defaultRoute: route([
      { tool: "browser_professional_readiness", input: input({}), why: "Check mechanical readiness, current capture status, and latest saved evidence." },
      { tool: "browser_open", input: input({ url: "https://example.com", waitMs: 1000 }), why: "Bind a profile/tab to the target page." },
      { tool: "browser_capture", input: input({ action: "start", label: "research-window" }), why: "Start the explicit F12 recording window before reproducing behaviour." },
      { tool: "browser_inspect", input: input({ mode: "overview", limit: 10 }), why: "Read first-pass objective evidence before choosing a low-level panel." },
      { tool: "browser_security_pack", input: input({ includeHar: true, includeTrace: true, includeApplicationExport: true }), why: "Save portable evidence artifacts and drilldown routes." },
      { tool: "browser_artifact_index", input: input({ maxFiles: 200 }), why: "Navigate saved artifacts through latestByKind and recommendedDrilldowns." },
    ]),
    panelRoutes: {
      network: route([
        { tool: "profile_traffic_summary", input: input({}), needs: "Recorded requests exist." },
        { tool: "profile_request_detail", input: input({ requestId: "<requestId>" }), needs: "A concrete requestId from summary, timeline, HAR, or drilldownPlan." },
        { tool: "profile_har_completeness", input: input({}), needs: "HAR/body/timing completeness check." },
      ]),
      application: route([
        { tool: "browser_storage_origin_summary", input: input({}), needs: "Current page origin is loaded." },
        { tool: "browser_cookie_summary", input: input({}), needs: "Cookie metadata and visibility evidence." },
        { tool: "browser_application_export", input: input({ save: true }), needs: "Portable Application panel artifact." },
      ]),
      sources: route([
        { tool: "browser_sources_search", input: input({ query: "<literal>" }), needs: "A literal string, URL fragment, token name, or function name." },
        { tool: "browser_source_pretty_print", input: input({ scriptId: "<scriptId>" }), needs: "A concrete scriptId from sources list/search." },
        { tool: "browser_debugger_control", input: input({ action: "getPausedState" }), needs: "Debugger state inspection." },
      ]),
      performance: route([
        { tool: "browser_chrome_trace", input: input({ save: true }), needs: "Trace capture for Performance-like evidence." },
        { tool: "browser_trace_query", input: input({ category: "rendering", limit: 20 }), needs: "Saved or active trace events." },
      ]),
      evidence: route([
        { tool: "browser_evidence_timeline", input: input({ maxEvents: 80, maxArtifacts: 120 }), needs: "Existing captured events or saved artifacts." },
        { tool: "browser_artifact_index", input: input({ maxFiles: 200 }), needs: "Existing artifact directory." },
        { tool: "browser_artifact_inspect", input: { path: "<artifactPath>" }, needs: "A concrete path from latestByKind, recommendedDrilldowns, or research pack." },
      ]),
    },
    drilldownRule: "Only use panel drilldowns after a first-pass route returns a concrete requestId, frameId, scriptId, trace path, artifact path, or recommendedDrilldowns entry.",
    objectiveBoundary: "These are deterministic routing hints for agents; they do not read hidden data and do not judge vulnerabilities.",
  };
}

export function devtoolsToolCatalogFromEntries(entries, options = {}) {
  const query = String(options.query || "").trim().toLowerCase();
  const categoryFilter = String(options.category || "").trim().toLowerCase();
  const includeBackendSpecific = Boolean(options.includeBackendSpecific);
  const available = new Set(entries.map((tool) => tool.name));
  const rows = entries
    .filter((tool) => includeBackendSpecific || tool.name === "agent_inspect" || tool.name.startsWith("browser_") || tool.name.startsWith("profile_"))
    .map((tool) => ({
      name: tool.name,
      category: devtoolsToolCategory(tool.name),
      description: tool.description || "",
      required: tool.parameters?.required || [],
      parameterNames: Object.keys(tool.parameters?.properties || {}),
    }))
    .filter((tool) => !categoryFilter || tool.category === categoryFilter)
    .filter((tool) => !query || `${tool.name} ${tool.category} ${tool.description} ${tool.parameterNames.join(" ")}`.toLowerCase().includes(query))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  const categories = {};
  for (const tool of rows) {
    categories[tool.category] = (categories[tool.category] || 0) + 1;
  }
  return {
    generatedAt: new Date().toISOString(),
    toolCount: rows.length,
    categories,
    agentEntryPoints: buildAgentToolEntryPoints(available),
    tools: rows,
    boundaries: [
      "Tool catalog is a navigation aid; it does not choose or execute tools automatically.",
      "Prefer agent_inspect or browser_security_research_pack for first-pass work, then drill down.",
    ],
  };
}

const DEVTOOLS_CAPABILITY_META = {
  orientation: {
    panel: "Orientation",
    purpose: "Understand backend, available tools, workflows, and capture boundaries before drilling down.",
    firstPass: ["browser_backend_capabilities", "browser_professional_readiness", "browser_tool_catalog", "browser_workflow_guide", "agent_inspect"],
  },
  "page-control": {
    panel: "Page",
    purpose: "Open, inspect, screenshot, and interact with the page like a user.",
    firstPass: ["browser_open", "browser_act", "browser_snapshot", "browser_screenshot"],
  },
  network: {
    panel: "Network",
    purpose: "Record request traffic, inspect timing/initiators/bodies, replay captured requests, and export HAR evidence.",
    firstPass: ["browser_capture_start", "browser_hard_reload", "agent_inspect", "profile_traffic_summary", "browser_capture_bisect", "profile_har_completeness"],
  },
  diagnostics: {
    panel: "Console / Issues / Security",
    purpose: "Read console messages, exceptions, DevTools Issues, page diagnostics, and security context.",
    firstPass: ["agent_inspect", "browser_page_diagnostics", "browser_signal_summary", "browser_console_log"],
  },
  application: {
    panel: "Application",
    purpose: "Inspect storage, cookies, service workers, CacheStorage, IndexedDB, and auth-boundary evidence.",
    firstPass: ["agent_inspect", "browser_storage_origin_summary", "browser_cookie_summary", "browser_service_worker_summary"],
  },
  "dom-frame": {
    panel: "Elements / Frames / Accessibility",
    purpose: "Inspect DOM, styles, event listeners, accessibility tree, frame tree, and worker/frame boundaries.",
    firstPass: ["agent_inspect", "browser_elements_snapshot", "browser_dom_search", "browser_frame_tree"],
  },
  "sources-debugger": {
    panel: "Sources / Debugger",
    purpose: "Inspect parsed scripts, source maps, source text, breakpoints, paused frames, and literal searches.",
    firstPass: ["agent_inspect", "browser_sources_list", "browser_sources_search", "browser_source_map_metadata"],
  },
  performance: {
    panel: "Performance / Memory",
    purpose: "Capture performance evidence, traces, CPU profiles, coverage, heap/memory counters, and trace queries.",
    firstPass: ["agent_inspect", "browser_performance_insights", "browser_performance_observer", "browser_chrome_trace"],
  },
  "evidence-workflow": {
    panel: "Recorder / Evidence",
    purpose: "Create reusable evidence packs, manifests, diffs, correlation graphs, and research workflows.",
    firstPass: ["browser_security_pack", "browser_security_research_pack", "browser_artifact_index", "browser_evidence_bundle", "browser_evidence_manifest"],
  },
  "raw-cdp": {
    panel: "Raw CDP",
    purpose: "Reach DevTools Protocol commands that do not yet have a friendly wrapper.",
    firstPass: ["browser_protocol_schema", "browser_cdp_command"],
  },
};

export function devtoolsCapabilityMapFromEntries(entries, options = {}) {
  const backend = options.backend || "unknown";
  const normalized = entries.map((tool) => ({
    name: tool.name,
    category: devtoolsToolCategory(tool.name),
    description: tool.description || "",
    required: tool.parameters?.required || [],
    parameterNames: Object.keys(tool.parameters?.properties || {}),
  }));
  const available = new Set(normalized.map((tool) => tool.name));
  const FACADE_ENTRY_NAMES = new Set(["browser_open", "browser_capture", "browser_inspect", "browser_security_pack", "browser_raw"]);
  const facadeTools = normalized
    .filter((tool) => FACADE_ENTRY_NAMES.has(tool.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const productTools = normalized
    .filter((tool) => tool.name === "agent_inspect" || tool.name.startsWith("browser_"));
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
      rawEscapeHatch: category === "raw-cdp" ? "browser_cdp_command" : null,
    };
  });
  return {
    backend,
    generatedAt: new Date().toISOString(),
    contract: "Agent DevTools capability map",
    facadeTools: facadeTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
    agentUsage: buildCapabilityAgentUsage(available, backend),
    panelCount: panels.length,
    panels,
    recommendedStart: ["browser_open", "browser_capture", "browser_inspect", "browser_security_pack", "browser_raw"].filter((name) => available.has(name)),
    boundaries: [
      "Capability map is navigation metadata; it does not execute tools or decide impact.",
      "Use browser_* facade tools first, then drill into lower-level tools for exact F12 evidence.",
      "Use browser_cdp_command only when the friendly wrapper does not expose the needed DevTools Protocol method.",
    ],
  };
}

export function devtoolsF12ParityMatrix(backend = "managed-cdp") {
  const personal = backend === "personal-chrome";
  const rows = [
    {
      panel: "Network",
      coverage: "strong",
      managed: "supported",
      personal: "supported",
      tools: ["browser_capture_start", "profile_traffic_query", "profile_traffic_summary", "profile_network_timeline", "profile_request_detail", "profile_traffic_get", "profile_request_payload", "profile_realtime_log", "profile_save_har", "profile_har_completeness", "profile_request_replay", "profile_request_replay_batch"],
      boundaries: ["Only activity observed after capture starts is complete.", "Replay uses browser fetch semantics, not raw socket/TLS/HTTP2 framing."],
    },
    {
      panel: "Elements / Frames / Accessibility",
      coverage: "strong-with-browser-boundaries",
      managed: "supported",
      personal: "supported",
      tools: ["browser_elements_snapshot", "browser_dom_snapshot", "browser_dom_search", "browser_frame_tree", "browser_accessibility_snapshot", "browser_event_listeners", "browser_css_styles", "browser_dom_mutation_watch"],
      boundaries: ["Closed shadow roots and cross-origin or sandboxed frame internals follow Chrome visibility boundaries."],
    },
    {
      panel: "Application",
      coverage: "strong",
      managed: "supported",
      personal: "supported",
      tools: ["browser_storage_snapshot", "browser_storage_origin_summary", "browser_cookie_summary", "browser_service_worker_summary", "browser_service_worker_detail", "browser_application_export", "browser_indexeddb_list", "browser_indexeddb_read", "browser_cache_storage_list", "browser_cache_entry_get", "browser_token_scan"],
      boundaries: ["Storage and cache reads are scoped to the selected page/origin and browser permission model."],
    },
    {
      panel: "Sources / Debugger",
      coverage: "strong-with-tooling-boundaries",
      managed: "supported",
      personal: "supported",
      tools: ["browser_sources_list", "browser_source_get", "browser_source_pretty_print", "browser_source_map_metadata", "browser_source_map_sources", "browser_source_map_source_get", "browser_sources_search", "browser_debugger_control", "browser_console_source_context"],
      boundaries: ["Pretty printing is heuristic.", "Source maps expose metadata and extractable sources rather than a full DevTools editor UI."],
    },
    {
      panel: "Console / Issues / Security",
      coverage: "strong",
      managed: "supported",
      personal: "supported",
      tools: ["browser_console_log", "browser_issues_log", "browser_security_summary", "browser_page_diagnostics", "browser_signal_summary"],
      boundaries: ["Browser Issues and Security events are Chrome-reported evidence, not vulnerability classification."],
    },
    {
      panel: "Performance / Memory",
      coverage: personal ? "partial-in-personal" : "strong-with-boundaries",
      managed: "supported",
      personal: "partial",
      tools: ["browser_performance_trace", "browser_performance_insights", "browser_performance_observer", "browser_chrome_trace", "browser_trace_query", "browser_trace_compare", "browser_cpu_profile", "browser_coverage_snapshot", "browser_coverage_detail", "browser_memory_snapshot", "browser_heap_snapshot"],
      boundaries: ["Managed CDP can capture heap snapshot artifacts.", "Personal Chrome chrome.debugger does not expose HeapProfiler heap snapshots and returns a structured notApplicable response."],
    },
    {
      panel: "Recorder / Evidence Workflow",
      coverage: "strong",
      managed: "supported",
      personal: "supported",
      tools: ["browser_security_research_pack", "browser_evidence_bundle", "browser_evidence_manifest", "browser_artifact_index", "browser_artifact_inspect", "browser_artifact_search", "browser_artifact_read", "browser_evidence_timeline", "browser_capture_diff", "browser_request_correlation_graph", "browser_auth_boundary_report", "browser_worker_frame_deep_dive"],
      boundaries: ["Evidence workflow tools organize and preserve evidence; they do not decide impact."],
    },
    {
      panel: "Raw CDP / Escape Hatch",
      coverage: personal ? "partial-in-personal" : "strong",
      managed: "supported",
      personal: "partial",
      tools: ["browser_protocol_schema", "browser_cdp_command", "browser_process_cdp", "browser_process_version", "browser_process_targets", "browser_system_info"],
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
    const status = personal ? row.personal : row.managed;
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  return {
    backend,
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
      "Start with browser_capability_map or browser_inspect, then use this parity matrix when deciding whether a missing signal is a tool gap or a browser boundary.",
    ],
    objectiveBoundaries: [
      "This matrix is capability evidence only; it does not classify vulnerabilities.",
      "If a row says partial or intentional-gap, the tool should expose that boundary instead of pretending the data exists.",
      "No capture means no complete historical network evidence, matching human F12 recording semantics.",
    ],
  };
}

export function devtoolsWorkflowGuide(task = "first-pass") {
  const key = String(task || "first-pass").trim().toLowerCase().replace(/[\s_]+/g, "-");
  const recipes = {
    "professional-appsec": {
      title: "Professional AppSec F12 workflow",
      goal: "Use the small facade first, then drill into exact DevTools evidence only when needed.",
      defaultPath: ["browser_open", "browser_capture", "browser_inspect", "browser_security_pack", "drilldownPlan"],
      defaultTools: ["browser_open", "browser_capture", "browser_inspect", "browser_security_pack", "browser_raw"],
      routeSummaryTemplate: {
        firstStep: { tool: "browser_professional_readiness", input: { profile: "researcher" } },
        evidencePack: { tool: "browser_security_pack", input: { profile: "researcher", url: "https://example.com", includeHar: true, includeTrace: true, includeApplicationExport: true } },
        latestHandoffInspect: { tool: "browser_artifact_inspect", input: { profile: "researcher", path: "<researchPackPath>" } },
        latestHandoffRead: { tool: "browser_artifact_read", input: { path: "<researchPackPath>", mode: "line", startLine: 1, maxLines: 120 } },
        firstConcreteDrilldown: "Use browser_professional_readiness.routeSummary.firstConcreteDrilldown after evidence exists.",
        objectiveBoundary: "This template is routing metadata for the professional workflow; it does not read evidence content or judge vulnerabilities.",
      },
      steps: [
        { tool: "browser_professional_readiness", input: { profile: "researcher" }, why: "Check whether workflow, capture status, artifact inventory, and evidence timeline are already mechanically ready." },
        { tool: "browser_open", input: { profile: "researcher", url: "https://example.com", waitMs: 1000 }, why: "Bind the profile to a page and collect page diagnostics." },
        { tool: "browser_capture", input: { profile: "researcher", action: "start", label: "reproduce" }, why: "Start an explicit F12 recording window before the action." },
        { tool: "browser_act", input: { profile: "researcher", action: "snapshot" }, why: "Interact or snapshot through the facade so the agent does not choose low-level UI tools first." },
        { tool: "browser_inspect", input: { profile: "researcher", mode: "overview", limit: 10 }, why: "Read the first objective evidence set and next tool plan." },
        { tool: "browser_security_pack", input: { profile: "researcher", url: "https://example.com", includeHar: true, includeTrace: true, includeApplicationExport: true }, why: "Save a portable evidence pack, manifest, timeline, and drilldown plan." },
        { tool: "browser_professional_readiness", input: { profile: "researcher" }, why: "Confirm the evidence package created the expected handoff, artifact, timeline, and parity readiness signals." },
        { tool: "browser_artifact_read", input: { path: "<researchPackPath>", mode: "line", startLine: 1, maxLines: 80 }, why: "Preview the handoff artifact without loading every saved file." },
        { tool: "<drilldownPlan.tool>", input: "<drilldownPlan.input>", why: "Continue with concrete request, replay, trace, source, or artifact drilldowns returned by the evidence pack." },
      ],
      exitCriteria: [
        "A research pack handoff file exists.",
        "A drilldown plan exists and contains concrete request/trace/artifact routes.",
        "HAR/Application/trace artifacts are saved when the backend exposes them.",
        "All returned boundaries remain objective and do not classify vulnerabilities.",
      ],
      boundary: "This is the default professional path for agents. Low-level CDP calls are drilldowns, not the first interface.",
    },
    "first-pass": {
      title: "First page inspection",
      goal: "Understand current page, backend layer, capture state, and first objective signals.",
      steps: [
        { tool: "browser_backend_capabilities", why: "Know whether this is Managed CDP or Personal Chrome and what boundaries apply." },
        { tool: "agent_inspect", input: { focus: "overview", limit: 10 }, why: "Get dashboard evidence and next drill-down tools." },
        { tool: "browser_signal_summary", why: "List objective cross-panel signals without deciding vulnerability impact." },
      ],
    },
    "security-research-pack": {
      title: "One-call security research evidence pack",
      goal: "Create portable first-pass evidence for an authorized target.",
      steps: [
        { tool: "browser_security_research_pack", input: { url: "https://example.com", profile: "researcher" }, why: "Capture, reload, collect F12 evidence, and save artifact paths." },
        { tool: "browser_evidence_manifest", why: "Verify artifact hashes and provenance when needed." },
        { tool: "browser_request_correlation_graph", why: "Choose which request/script/frame chain to drill into." },
      ],
    },
    "network-capture": {
      title: "Network capture and request drill-down",
      goal: "Record a reproducible action and inspect request details.",
      steps: [
        { tool: "browser_capture_start", input: { clear: true, label: "reproduce" }, why: "Start an explicit F12 recording window." },
        { tool: "browser_hard_reload", input: { waitMs: 1000 }, why: "Reload with cache disabled and Service Worker bypass where supported." },
        { tool: "agent_inspect", input: { focus: "network", limit: 20 }, why: "Find request ids and request shapes." },
        { tool: "profile_har_completeness", input: { includeBodies: true, maxBodyBytes: 2000 }, why: "Check objective HAR body/timing/redirect/security evidence completeness before drilling down." },
        { tool: "profile_request_detail", input: { requestId: "<request-id>" }, why: "Inspect headers, cookies, timing, initiator, and body availability." },
      ],
    },
    "request-replay": {
      title: "Request replay variants",
      goal: "Replay an observed browser request with bounded variants and compare responses.",
      steps: [
        { tool: "agent_inspect", input: { focus: "network", limit: 20 }, why: "Pick a requestId from captured traffic." },
        { tool: "profile_request_replay_batch", input: { requestId: "<request-id>", variants: [{ label: "baseline" }] }, why: "Run variants and compare status, headers, and body previews." },
      ],
      boundary: "Replay evidence is not a vulnerability verdict; the agent or human must judge authorization and impact.",
    },
    "auth-boundary": {
      title: "Authentication boundary evidence",
      goal: "Collect cookies, auth headers, storage tokens, credentialed requests, and page security context.",
      steps: [
        { tool: "browser_auth_boundary_report", input: { includeTokenScan: true, save: true }, why: "Collect objective auth-related evidence." },
        { tool: "browser_cookie_summary", why: "Inspect cookie attributes and objective attribute signals." },
        { tool: "browser_token_scan", why: "Search authorized browser evidence for token-like material." },
      ],
    },
    "before-after-diff": {
      title: "Before/after evidence diff",
      goal: "Compare evidence before and after login, role switch, account switch, or permission change.",
      steps: [
        { tool: "browser_evidence_bundle", input: { save: true }, why: "Save the before snapshot." },
        { tool: "browser_capture_start", input: { clear: true, label: "after-action" }, why: "Record the action window." },
        { tool: "browser_capture_diff", input: { beforePath: "<before-bundle-path>", save: true }, why: "Compare before snapshot to current captured traffic." },
        { tool: "profile_har_completeness", input: { includeBodies: true, maxBodyBytes: 2000 }, why: "Check whether the HAR evidence is complete enough for the claim." },
      ],
    },
    "source-debug": {
      title: "Sources and debugger drill-down",
      goal: "Find relevant scripts, read source, and pause around runtime behavior.",
      steps: [
        { tool: "agent_inspect", input: { focus: "sources", query: "<marker>" }, why: "List and search parsed scripts." },
        { tool: "browser_source_get", input: { scriptId: "<script-id>" }, why: "Read exact script source." },
        { tool: "browser_debugger_control", input: { action: "setBreakpointByUrl" }, why: "Use live runtime state when source text is insufficient." },
      ],
    },
    performance: {
      title: "Performance and trace drill-down",
      goal: "Capture objective timing, observer, CPU, coverage, and trace evidence.",
      steps: [
        { tool: "agent_inspect", input: { focus: "performance" }, why: "Start with lightweight performance evidence." },
        { tool: "browser_chrome_trace", input: { durationMs: 1000 }, why: "Capture a bounded trace around the smallest reproducible action." },
        { tool: "browser_trace_query", input: { tracePath: "<trace-path>", minDurationMs: 5 }, why: "Search saved trace events." },
      ],
    },
  };
  const recipe = recipes[key] || recipes["first-pass"];
  return {
    task: key,
    ...recipe,
    availableTasks: Object.keys(recipes),
    boundaries: [
      "Workflow guide is a deterministic recipe, not model reasoning.",
      "Tools return evidence; the agent or human decides interpretation.",
    ],
  };
}

export function browserProductCapabilities() {
  return {
    schema: "agent-browser.capabilities.v1",
    ok: true,
    productModel: {
      primaryBackend: "managed",
      secondaryBackend: "personal",
      cliRole: "primary product interface for agents and shell workers",
      objectiveBoundary: "Collect browser/F12 evidence and expose boundaries. Do not judge vulnerabilities.",
    },
    browserBackends: {
      managed: {
        role: "primary",
        meaning: "Managed Browser is an agent-owned browser/profile controlled by Agent Browser Runtime.",
        transport: "Direct Chrome DevTools Protocol over the managed browser remote-debugging endpoint.",
        useWhen: [
          "clean profile or target-scoped identity is needed",
          "two-account attacker/victim isolation is needed",
          "repeatable F12 evidence, HAR, trace, replay, or artifact export is needed",
        ],
      },
      personal: {
        role: "secondary",
        meaning: "Personal Browser is operator-authorized access to the user's already-open Chrome tab.",
        transport: "Chrome extension bridge using chrome.debugger; DevTools commands are routed through extension permission and current-tab scope.",
        useWhen: [
          "the operator explicitly asks to use their current Chrome tab",
          "the real logged-in tab must be inspected without restarting Chrome",
          "the task is personal/ad hoc and does not need clean profile isolation",
        ],
      },
    },
    scenarios: [
      {
        scenario: "basic",
        maturity: "usable-mainline",
        defaultBackend: "managed",
        useFor: ["form fill", "posting workflows", "downloads", "uploads", "logged-in web apps", "Money Project browser work"],
        cliFirstCommands: [
          "agent-browser ready basic --profile <profile>",
          "agent-browser open <url> --profile <profile>",
          "agent-browser fill \"<value>\" --label \"<field label>\" --profile <profile>",
          "agent-browser workflow diagnose --file <workflow.json>",
        ],
      },
      {
        scenario: "pentest",
        maturity: "professional-mainline",
        defaultBackend: "managed",
        useFor: ["F12 evidence", "network capture", "request body reading", "GraphQL payloads", "replay", "repeater", "two-account isolation", "evidence export"],
        cliFirstCommands: [
          "agent-browser ready pentest --profile <profile>",
          "agent-browser capture start --profile <profile> --label <reason>",
          "agent-browser requests --profile <profile> --method POST --has-request-body true",
          "agent-browser graphql intercept-plan <requestId> --profile <profile> --variables-json '{...}'",
          "agent-browser requests diagnose --profile <profile>",
          "agent-browser repeater diagnose <sessionId> --profile <profile>",
          "agent-browser intercept diagnose --profile <profile>",
          "agent-browser profile registry diagnose --target <target> --require-roles attacker,victim",
          "agent-browser evidence bundle --profile <profile> --include-har",
        ],
      },
      {
        scenario: "personal",
        maturity: "secondary-current-tab",
        defaultBackend: "personal",
        useFor: ["operator-authorized current tab", "real logged-in page inspection", "personal/ad hoc browser help"],
        cliFirstCommands: ["npm run personal:chrome", "agent-browser ready personal", "agent-browser see snapshot --backend personal --current-tab true"],
      },
    ],
    recommendedStart: {
      cli: ["agent-browser doctor", "agent-browser capabilities", "agent-browser ready basic|pentest|personal"],
    },
    agentUse: {
      interaction: {
        preferCli: [
          "agent-browser fill --label/--field for Playwright-style replacement input without hand-copying selectors",
          "agent-browser type --press-enter for React forms that only submit from keyboard Enter",
          "agent-browser wait before reading SPA/no-navigation results",
        ],
        tools: ["browser_type", "browser_press", "browser_select", "browser_wait", "browser_upload"],
      },
      diagnostics: {
        basic: ["agent-browser download diagnose", "agent-browser auth diagnose", "agent-browser workflow diagnose"],
        pentest: ["agent-browser requests diagnose", "agent-browser repeater diagnose", "agent-browser intercept diagnose", "agent-browser profile registry diagnose"],
        rule: "When a command fails or returns partial coverage, run the matching diagnose command before guessing.",
      },
      appsecReplay: {
        fetchLayer: "agent-browser graphql replay <requestId> --profile <profile> --variables-json '{...}'",
        inFlightBrowserRequest: "agent-browser graphql intercept-plan <requestId> --profile <profile> --variables-json '{...}'",
        rule: "Use intercept-plan when WAF/browser signals, service workers, or page runtime context may make fetch-layer replay misleading.",
      },
      evidence: {
        command: "agent-browser evidence bundle --profile <profile> --include-har",
        tools: ["browser_evidence_bundle", "browser_evidence_manifest", "browser_evidence_timeline"],
        contains: ["page snapshot", "screenshot path", "network summary", "issues", "security", "storage", "sources"],
        rule: "Use evidence bundle for handoff/report context after capture and before claiming a workflow is reproducible.",
      },
      profileIsolation: {
        rule: "Use separate profiles for attacker/victim or account A/B tests. Do not share cookies across identities.",
        commands: [
          "agent-browser ready pentest --target <target> --require-roles attacker,victim",
          "agent-browser profile registry diagnose --target <target> --require-roles attacker,victim",
          "agent-browser profile isolation check --profiles attacker,victim --url <same-origin-url>",
        ],
      },
    },
    boundaries: [
      "Use Managed Browser for clean target identities, two-account isolation, capture/replay, and repeatable evidence.",
      "Use Personal Browser only when the operator asks for their current Chrome tab or real logged-in browser state.",
      "Use browser_raw for explicit low-level tool drilldown.",
      "Capability map is product routing information, not a live readiness result.",
    ],
  };
}
