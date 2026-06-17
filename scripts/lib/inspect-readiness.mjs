// Inspect / professional-readiness builders, extracted from agent-cdp-server.mjs
// (behavior-preserving monolith carve). These turn already-captured request /
// evidence data and already-built workflow/capability/parity/capture inputs into
// objective view-models: a full F12 request detail, an evidence-completeness
// note set, the agent_inspect tool plan, the professional AppSec workflow
// summary, and the large professional-readiness report. No live CDP
// client/session/registry: inputs are plain data/options. buildProfessionalReadiness
// reads the latest research-pack handoff JSON via the already-extracted
// readJsonFile + summarizeResearchPackHandoff helpers. Unit-tested in
// inspect-readiness.test.mjs.

import { readJsonFile, summarizeResearchPackHandoff } from "./evidence-artifacts.mjs";
import { buildInitiatorSummary } from "./initiator-summary.mjs";
import {
  lowerHeaderMap,
  parseCookieHeader,
  buildNetworkTimeline,
  buildRequestF12Sections,
} from "./f12-view.mjs";

export function buildRequestDetail(entry, cookies = []) {
  if (!entry) return null;
  const requestHeadersLower = lowerHeaderMap(entry.requestHeaders || {});
  const responseHeadersLower = lowerHeaderMap(entry.responseHeaders || {});
  const cookieHeader = requestHeadersLower.cookie || "";
  const setCookieHeader = responseHeadersLower["set-cookie"] || "";
  return {
    requestId: entry.requestId,
    url: entry.url,
    method: entry.method,
    status: entry.status,
    statusText: entry.statusText,
    resourceType: entry.resourceType,
    mimeType: entry.mimeType,
    protocol: entry.protocol,
    frameId: entry.frameId,
    loaderId: entry.loaderId,
    documentURL: entry.documentURL,
    failed: Boolean(entry.failed),
    failReason: entry.failReason || entry.errorText || null,
    blockedReason: entry.blockedReason || null,
    fromDiskCache: Boolean(entry.fromDiskCache),
    fromServiceWorker: Boolean(entry.fromServiceWorker),
    remoteIPAddress: entry.remoteIPAddress || null,
    remotePort: entry.remotePort || null,
    requestHeaders: entry.requestHeaders || {},
    requestHeadersText: entry.requestHeadersText || null,
    responseHeaders: entry.responseHeaders || {},
    responseHeadersText: entry.responseHeadersText || null,
    cookieHeader,
    requestCookies: parseCookieHeader(cookieHeader),
    setCookieHeader,
    associatedCookies: entry.associatedCookies || [],
    blockedRequestCookies: entry.blockedRequestCookies || [],
    blockedResponseCookies: entry.blockedResponseCookies || [],
    browserCookiesForUrl: cookies,
    hasPostData: Boolean(entry.hasPostData),
    postDataLength: entry.postDataLength ?? null,
    bodyReadable: Boolean(entry.bodyReadable || entry.bodyText || entry.bodyPath),
    bodyBytes: entry.bodyBytes ?? null,
    bodyPath: entry.bodyPath || null,
    bodyBase64Encoded: Boolean(entry.bodyBase64Encoded),
    initiatorType: entry.initiator?.type || entry.initiatorType || null,
    initiator: entry.initiator || null,
    initiatorSummary: buildInitiatorSummary(entry.initiator || null),
    lifecycleFlags: {
      failed: Boolean(entry.failed),
      blocked: Boolean(entry.blockedReason),
      redirected: Array.isArray(entry.redirectChain) && entry.redirectChain.length > 0,
      fromDiskCache: Boolean(entry.fromDiskCache),
      fromServiceWorker: Boolean(entry.fromServiceWorker),
      hasExtraInfo: Boolean(entry.requestWillBeSentExtraInfoSeen || entry.responseReceivedExtraInfoSeen),
      hasPostData: Boolean(entry.hasPostData),
      bodyReadable: Boolean(entry.bodyReadable || entry.bodyText || entry.bodyPath),
    },
    timing: entry.timing || null,
    timingPhases: entry.timing ? buildNetworkTimeline([entry], 1)[0]?.phases : null,
    securityDetails: entry.securityDetails || null,
    redirectChain: entry.redirectChain || [],
    connectTiming: entry.connectTiming || null,
    extraInfo: {
      requestWillBeSentExtraInfo: Boolean(entry.requestWillBeSentExtraInfoSeen),
      responseReceivedExtraInfo: Boolean(entry.responseReceivedExtraInfoSeen),
      statusCodeFromExtraInfo: entry.extraInfoStatusCode ?? null,
      resourceIPAddressSpace: entry.resourceIPAddressSpace ?? null,
    },
    f12Sections: buildRequestF12Sections(entry, cookies),
  };
}

export function summarizeEvidenceCompleteness(evidence = {}) {
  const notes = [];
  const walk = (value, path = "evidence") => {
    if (!value || typeof value !== "object") return;
    if (value.unavailable) notes.push({ path, status: "unavailable", detail: value.error || value.tool || "tool unavailable" });
    else if (value.error) notes.push({ path, status: "error", detail: String(value.error) });
    if (value.truncated === true) notes.push({ path, status: "truncated", detail: "result limited by max count or max bytes" });
    if (value.parseError) notes.push({ path, status: "parse_error", detail: String(value.parseError) });
    if (Array.isArray(value.frameErrors) && value.frameErrors.length) {
      notes.push({ path, status: "partial_frames", detail: `${value.frameErrors.length} frame(s) could not be inspected` });
    }
    for (const [key, child] of Object.entries(value)) {
      if (!child || typeof child !== "object") continue;
      if (key === "requestHeaders" || key === "responseHeaders" || key === "browserCookiesForUrl") continue;
      walk(child, `${path}.${key}`);
    }
  };
  walk(evidence);
  return {
    status: notes.length ? "partial" : "complete_for_current_capture",
    noteCount: notes.length,
    notes: notes.slice(0, 20),
  };
}

export function buildAgentInspectToolPlan(focus, options = {}) {
  const base = {
    intent: "Use agent_inspect as the first-screen router; call low-level tools only for drill-down.",
    escapeHatch: "browser_cdp_command",
    schemaTool: "browser_protocol_schema",
  };
  if (focus === "network") {
    return {
      ...base,
      firstPass: ["profile_traffic_summary", "profile_network_timeline", "profile_traffic_query", "profile_realtime_log"],
      drillDown: options.requestId
        ? ["profile_request_detail", "profile_traffic_get", "profile_request_payload", "profile_request_replay", "profile_request_replay_batch"]
        : ["pick a requestId, then rerun agent_inspect focus=network requestId=<id>"],
      captureHint: "If request rows are missing, run browser_capture_start and browser_hard_reload before repeating the user action.",
      objectiveBoundary: "Replay diffs compare observed browser fetch results; they do not prove exploitability by themselves.",
    };
  }
  if (focus === "storage") {
    return {
      ...base,
      firstPass: ["browser_storage_origin_summary", "browser_cookie_summary", "browser_service_worker_summary"],
      drillDown: ["browser_application_export", "browser_indexeddb_list", "browser_indexeddb_read", "browser_cache_storage_list", "browser_cache_entry_get"],
      captureHint: "Storage is current-state evidence. Use Application export for handoff and repeatability.",
      objectiveBoundary: "Partition metadata is reported only when Chrome exposes it for the current page.",
    };
  }
  if (focus === "dom") {
    return {
      ...base,
      firstPass: ["browser_elements_snapshot", options.query ? "browser_dom_search" : "pass query for DOM search"],
      drillDown: options.selector ? ["browser_css_styles", "browser_event_listeners", "browser_dom_mutation_watch"] : ["pass selector for selected-node evidence"],
      captureHint: "Use framePath or frameIndexes when evidence is inside a same-origin iframe.",
      objectiveBoundary: "Cross-origin frame internals remain inaccessible unless the browser grants that access.",
    };
  }
  if (focus === "sources" || focus === "debug") {
    return {
      ...base,
      firstPass: ["browser_sources_list", options.query ? "browser_sources_search" : "pass query for source search"],
      drillDown: ["browser_source_get", "browser_source_pretty_print", "browser_source_map_metadata", "browser_debugger_control"],
      captureHint: "Use debugger controls for live runtime state; source text alone is not runtime proof.",
      objectiveBoundary: "Heap/closure-only values are visible only when the debugger pauses in the right execution context.",
    };
  }
  if (focus === "performance") {
    return {
      ...base,
      firstPass: ["browser_memory_snapshot", "browser_performance_observer", "browser_performance_insights", "browser_performance_trace"],
      drillDown: ["browser_heap_snapshot", "browser_chrome_trace", "browser_trace_query", "browser_trace_compare", "browser_cpu_profile", "browser_coverage_detail"],
      captureHint: "Use heavier traces only around the smallest reproducible action.",
      objectiveBoundary: "Trace summaries expose timing evidence, not root-cause conclusions.",
    };
  }
  if (focus === "search") {
    return {
      ...base,
      firstPass: options.query ? ["browser_global_search"] : ["provide query"],
      drillDown: ["agent_inspect focus=network", "agent_inspect focus=storage", "agent_inspect focus=sources"],
      captureHint: "Search only covers evidence currently captured or readable from the page.",
      objectiveBoundary: "No match means no match in current evidence, not proof that the value never existed.",
    };
  }
  if (focus === "evidence") {
    return {
      ...base,
      firstPass: ["browser_evidence_bundle"],
      drillDown: ["profile_save_har", "browser_application_export", "agent_inspect focus=search query=<hypothesis>"],
      captureHint: "Save bundles after the relevant action has been reproduced with capture enabled.",
      objectiveBoundary: "Bundles preserve evidence for review; interpretation remains the Agent or human's job.",
    };
  }
  return {
    ...base,
    firstPass: ["browser_backend_capabilities", "agent_inspect focus=overview"],
    drillDown: ["agent_inspect focus=network", "agent_inspect focus=storage", "agent_inspect focus=console", "agent_inspect focus=dom", "agent_inspect focus=evidence", "browser_process_version", "browser_process_targets"],
    captureHint: "Start capture before reproducing behavior you want Network/Console evidence for.",
    objectiveBoundary: "Overview organizes signals; it does not decide whether a finding is a vulnerability.",
  };
}

export function professionalAppsecWorkflowSummary() {
  return {
    task: "professional-appsec",
    defaultPath: ["browser_open", "browser_capture", "browser_inspect", "browser_security_pack", "drilldownPlan"],
    guideTool: "browser_workflow_guide",
    guideInput: { task: "professional-appsec" },
    readinessTool: "browser_professional_readiness",
    readinessInput: {},
    routeSummaryTemplate: {
      firstStep: { tool: "browser_professional_readiness", input: {} },
      evidencePack: { tool: "browser_security_pack", input: { includeHar: true, includeTrace: true, includeApplicationExport: true } },
      latestHandoffInspect: { tool: "browser_artifact_inspect", input: { path: "<researchPackPath>" } },
      latestHandoffRead: { tool: "browser_artifact_read", input: { path: "<researchPackPath>", mode: "line", startLine: 1, maxLines: 120 } },
      firstConcreteDrilldown: "Use browser_professional_readiness.routeSummary.firstConcreteDrilldown after evidence exists.",
    },
    firstInterface: "browser_* facade tools",
    drilldownBoundary: "Use browser_raw only after the facade returns concrete evidence or a drilldown route.",
    objectiveBoundary: "The workflow collects and routes F12 evidence; it does not classify vulnerabilities.",
  };
}

export function buildProfessionalReadiness({
  backend = "unknown",
  profile = null,
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
    inspect: artifact.inspectInput ? { tool: "browser_artifact_inspect", input: artifact.inspectInput } : null,
    read: artifact.readInput ? { tool: "browser_artifact_read", input: artifact.readInput } : null,
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
    inspect: { tool: "browser_artifact_inspect", input: { path: latestResearchPack.path, maxBytes: 300000 } },
    read: { tool: "browser_artifact_read", input: { path: latestResearchPack.path, mode: "line", startLine: 1, lineCount: 160 } },
  } : null;
  const firstF12RequestDetailPath = latestResearchPackSummary?.artifactPaths?.firstF12RequestDetailPath || null;
  const f12NavigationPath = latestResearchPackSummary?.artifactPaths?.f12NavigationPath || null;
  const harCompletenessPath = latestResearchPackSummary?.artifactPaths?.harCompletenessPath || null;
  const realtimeLogPath = latestResearchPackSummary?.artifactPaths?.realtimeLogPath || null;
  const tracePath = latestResearchPackSummary?.artifactPaths?.tracePath || null;
  const applicationExportPath = latestResearchPackSummary?.artifactPaths?.applicationExportPath || null;
  const evidenceBundlePath = latestResearchPackSummary?.artifactPaths?.evidenceBundlePath || null;
  const drilldownPlanPath = latestResearchPackSummary?.artifactPaths?.drilldownPlanPath || null;
  const evidenceManifestPath = latestResearchPackSummary?.artifactPaths?.evidenceManifestPath || null;
  const correlationGraphPath = latestResearchPackSummary?.artifactPaths?.correlationGraphPath || null;
  const authBoundaryReportPath = latestResearchPackSummary?.artifactPaths?.authBoundaryReportPath || null;
  const workerFrameReportPath = latestResearchPackSummary?.artifactPaths?.workerFrameReportPath || null;
  const firstF12RequestDetailArtifact = firstF12RequestDetailPath ? {
    path: firstF12RequestDetailPath,
    inspect: { tool: "browser_artifact_inspect", input: { path: firstF12RequestDetailPath, maxBytes: 120000 } },
    read: { tool: "browser_artifact_read", input: { path: firstF12RequestDetailPath, mode: "line", startLine: 1, lineCount: 120 } },
  } : null;
  const f12NavigationArtifact = f12NavigationPath ? {
    path: f12NavigationPath,
    inspect: { tool: "browser_artifact_inspect", input: { path: f12NavigationPath, maxBytes: 160000 } },
    read: { tool: "browser_artifact_read", input: { path: f12NavigationPath, mode: "line", startLine: 1, lineCount: 160 } },
  } : null;
  const harCompletenessArtifact = harCompletenessPath ? {
    path: harCompletenessPath,
    inspect: { tool: "browser_artifact_inspect", input: { path: harCompletenessPath, maxBytes: 160000 } },
    read: { tool: "browser_artifact_read", input: { path: harCompletenessPath, mode: "line", startLine: 1, lineCount: 160 } },
  } : null;
  const realtimeLogArtifact = realtimeLogPath ? {
    path: realtimeLogPath,
    inspect: { tool: "browser_artifact_inspect", input: { path: realtimeLogPath, maxBytes: 160000 } },
    read: { tool: "browser_artifact_read", input: { path: realtimeLogPath, mode: "line", startLine: 1, lineCount: 160 } },
  } : null;
  const traceArtifact = tracePath ? {
    path: tracePath,
    inspect: { tool: "browser_artifact_inspect", input: { path: tracePath, maxBytes: 160000 } },
    query: { tool: "browser_trace_query", input: { tracePath, minDurationMs: 5, limit: 20 } },
  } : null;
  const applicationExportArtifact = applicationExportPath ? {
    path: applicationExportPath,
    inspect: { tool: "browser_artifact_inspect", input: { path: applicationExportPath, maxBytes: 200000 } },
    read: { tool: "browser_artifact_read", input: { path: applicationExportPath, mode: "line", startLine: 1, lineCount: 180 } },
  } : null;
  const evidenceBundleArtifact = evidenceBundlePath ? {
    path: evidenceBundlePath,
    inspect: { tool: "browser_artifact_inspect", input: { path: evidenceBundlePath, maxBytes: 220000 } },
    read: { tool: "browser_artifact_read", input: { path: evidenceBundlePath, mode: "line", startLine: 1, lineCount: 180 } },
  } : null;
  const drilldownPlanArtifact = drilldownPlanPath ? {
    path: drilldownPlanPath,
    inspect: { tool: "browser_artifact_inspect", input: { path: drilldownPlanPath, maxBytes: 160000 } },
    read: { tool: "browser_artifact_read", input: { path: drilldownPlanPath, mode: "line", startLine: 1, lineCount: 180 } },
  } : null;
  const evidenceManifestArtifact = evidenceManifestPath ? {
    path: evidenceManifestPath,
    inspect: { tool: "browser_artifact_inspect", input: { path: evidenceManifestPath, maxBytes: 160000 } },
    read: { tool: "browser_artifact_read", input: { path: evidenceManifestPath, mode: "line", startLine: 1, lineCount: 180 } },
  } : null;
  const correlationGraphArtifact = correlationGraphPath ? {
    path: correlationGraphPath,
    inspect: { tool: "browser_artifact_inspect", input: { path: correlationGraphPath, maxBytes: 180000 } },
    read: { tool: "browser_artifact_read", input: { path: correlationGraphPath, mode: "line", startLine: 1, lineCount: 180 } },
  } : null;
  const authBoundaryArtifact = authBoundaryReportPath ? {
    path: authBoundaryReportPath,
    inspect: { tool: "browser_artifact_inspect", input: { path: authBoundaryReportPath, maxBytes: 180000 } },
    read: { tool: "browser_artifact_read", input: { path: authBoundaryReportPath, mode: "line", startLine: 1, lineCount: 180 } },
  } : null;
  const workerFrameArtifact = workerFrameReportPath ? {
    path: workerFrameReportPath,
    inspect: { tool: "browser_artifact_inspect", input: { path: workerFrameReportPath, maxBytes: 180000 } },
    read: { tool: "browser_artifact_read", input: { path: workerFrameReportPath, mode: "line", startLine: 1, lineCount: 180 } },
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
      input: profile ? { profile, action: "start", clear: true, label: "professional-readiness" } : { action: "start", clear: true, label: "professional-readiness" },
      why: "Start the explicit F12 recording window before reproducing behavior.",
    });
  }
  if (!artifactCount) {
    nextActions.push({
      tool: "browser_security_pack",
      input: profile ? { profile, includeHar: true, includeTrace: true, includeApplicationExport: true } : { includeHar: true, includeTrace: true, includeApplicationExport: true },
      why: "Create the portable evidence pack, artifact index, timeline, and drilldown plan.",
    });
  } else if (latestResearchPackHandoff) {
    nextActions.push({
      tool: "browser_artifact_inspect",
      input: latestResearchPackHandoff.inspect.input,
      why: "Inspect the latest saved research-pack handoff and continue from its objective agent route.",
    });
  }
  const actionKey = (entry) => `${entry.tool}:${entry.input?.path || ""}:${entry.input?.requestId || ""}:${entry.input?.tracePath || ""}:${entry.input?.query || ""}`;
  const seenNextActions = new Set(nextActions.map(actionKey));
  if (harCompletenessArtifact) {
    const entry = {
      tool: harCompletenessArtifact.inspect.tool,
      input: harCompletenessArtifact.inspect.input,
      why: "Inspect the standalone HAR completeness report saved by the latest research pack.",
    };
    const key = actionKey(entry);
    if (!seenNextActions.has(key)) {
      nextActions.push(entry);
      seenNextActions.add(key);
    }
  }
  if (traceArtifact) {
    const entry = {
      tool: traceArtifact.query.tool,
      input: traceArtifact.query.input,
      why: "Query the saved Chrome trace artifact for long events and timeline evidence.",
    };
    const key = actionKey(entry);
    if (!seenNextActions.has(key)) {
      nextActions.push(entry);
      seenNextActions.add(key);
    }
  }
  if (applicationExportArtifact) {
    const entry = {
      tool: applicationExportArtifact.inspect.tool,
      input: applicationExportArtifact.inspect.input,
      why: "Inspect the saved Application/Storage export from the latest research pack.",
    };
    const key = actionKey(entry);
    if (!seenNextActions.has(key)) {
      nextActions.push(entry);
      seenNextActions.add(key);
    }
  }
  if (evidenceBundleArtifact) {
    const entry = {
      tool: evidenceBundleArtifact.inspect.tool,
      input: evidenceBundleArtifact.inspect.input,
      why: "Inspect the saved F12 evidence bundle from the latest research pack.",
    };
    const key = actionKey(entry);
    if (!seenNextActions.has(key)) {
      nextActions.push(entry);
      seenNextActions.add(key);
    }
  }
  if (drilldownPlanArtifact) {
    const entry = {
      tool: drilldownPlanArtifact.inspect.tool,
      input: drilldownPlanArtifact.inspect.input,
      why: "Inspect the saved drilldown plan artifact from the latest research pack.",
    };
    const key = actionKey(entry);
    if (!seenNextActions.has(key)) {
      nextActions.push(entry);
      seenNextActions.add(key);
    }
  }
  if (evidenceManifestArtifact) {
    const entry = {
      tool: evidenceManifestArtifact.inspect.tool,
      input: evidenceManifestArtifact.inspect.input,
      why: "Inspect the saved evidence manifest for artifact paths and hashes.",
    };
    const key = actionKey(entry);
    if (!seenNextActions.has(key)) {
      nextActions.push(entry);
      seenNextActions.add(key);
    }
  }
  for (const [artifact, why] of [
    [correlationGraphArtifact, "Inspect the saved request correlation graph from the latest research pack."],
    [authBoundaryArtifact, "Inspect the saved auth boundary report from the latest research pack."],
    [workerFrameArtifact, "Inspect the saved worker/frame boundary report from the latest research pack."],
  ]) {
    if (!artifact) continue;
    const entry = {
      tool: artifact.inspect.tool,
      input: artifact.inspect.input,
      why,
    };
    const key = actionKey(entry);
    if (!seenNextActions.has(key)) {
      nextActions.push(entry);
      seenNextActions.add(key);
    }
  }
  if (f12NavigationArtifact) {
    const entry = {
      tool: f12NavigationArtifact.inspect.tool,
      input: f12NavigationArtifact.inspect.input,
      why: "Inspect the standalone F12 navigation index saved by the latest research pack.",
    };
    const key = actionKey(entry);
    if (!seenNextActions.has(key)) {
      nextActions.push(entry);
      seenNextActions.add(key);
    }
  }
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
    tool: "browser_workflow_guide",
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
    harCompletenessArtifact,
    traceArtifact,
    traceQuery: traceArtifact?.query || null,
    applicationExportArtifact,
    evidenceBundleArtifact,
    drilldownPlanArtifact,
    evidenceManifestArtifact,
    correlationGraphArtifact,
    authBoundaryArtifact,
    workerFrameArtifact,
    f12NavigationArtifact,
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
  const routeArtifacts = Object.fromEntries([
    ["f12Navigation", f12NavigationArtifact],
    ["firstF12RequestDetail", firstF12RequestDetailArtifact],
    ["harCompleteness", harCompletenessArtifact],
    ["realtimeLog", realtimeLogArtifact],
    ["trace", traceArtifact],
    ["applicationExport", applicationExportArtifact],
    ["evidenceBundle", evidenceBundleArtifact],
    ["drilldownPlan", drilldownPlanArtifact],
    ["evidenceManifest", evidenceManifestArtifact],
    ["correlationGraph", correlationGraphArtifact],
    ["authBoundary", authBoundaryArtifact],
    ["workerFrameBoundary", workerFrameArtifact],
  ].filter(([, artifact]) => artifact?.path || artifact?.inspect || artifact?.read));
  const routeArtifactNames = Object.keys(routeArtifacts);
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
    routeArtifactCount: routeArtifactNames.length,
    routeArtifactNames,
    nextTool: nextActions[0]?.tool || null,
    nextActionCount: nextActions.length,
  };
  return {
    schema: "agent-browser-runtime.professional-readiness.v1",
    backend,
    profile,
    generatedAt: new Date().toISOString(),
    summary: readinessSummary,
    routeSummary,
    routeArtifacts,
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
