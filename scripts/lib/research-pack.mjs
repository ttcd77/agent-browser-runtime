// Security research-pack builders, extracted from agent-cdp-server.mjs
// (behavior-preserving monolith carve). These assess research-pack handoff
// completeness and artifact coverage, build the deterministic drilldown plan and
// F12 navigation index over already-captured artifacts, and summarize one F12
// request detail. No live CDP client/session/registry: inputs are plain
// summary/artifacts/options/result data. buildResearchPackDrilldowns optionally
// writes its plan JSON to a plain evidence directory, like evidence-artifacts.mjs.
// Reuses the already-extracted networkDisplayName helper. Unit-tested in
// research-pack.test.mjs.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { networkDisplayName } from "./network-filters.mjs";

export function buildResearchPackHandoffCompleteness(summary = {}, artifacts = {}, workflow = {}, drilldownPlan = {}, parityMatrix = {}, agentUsage = {}) {
  const defaultRoute = Array.isArray(agentUsage?.defaultRoute) ? agentUsage.defaultRoute : [];
  const panelRoutes = agentUsage?.panelRoutes || {};
  const checks = [
    { name: "workflow", present: Boolean(workflow?.task && workflow?.defaultPath?.length), evidence: workflow?.task || null },
    { name: "agentUsageRoute", present: Boolean(defaultRoute.some((step) => step.tool === "browser_security_pack") && panelRoutes.network?.some((step) => step.tool === "profile_request_detail")), evidence: defaultRoute.map((step) => step.tool) },
    { name: "researchPack", present: Boolean(summary.researchPackPath && artifacts.researchPack?.sha256), evidence: summary.researchPackPath || null },
    { name: "drilldownPlan", present: Boolean(summary.drilldownPlanPath && drilldownPlan?.count >= 1), evidence: summary.drilldownPlanPath || null },
    { name: "realtimeLog", present: Boolean(summary.realtimeLogPath && artifacts.realtime?.reportSha256), evidence: summary.realtimeLogPath || null },
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

export function buildResearchPackArtifactCoverage(summary = {}, options = {}) {
  const requested = {
    har: options.includeHar !== false,
    harCompleteness: options.includeHar !== false,
    realtime: true,
    application: options.includeApplicationExport !== false,
    trace: options.includeTrace !== false,
    bundle: true,
    manifest: true,
    correlationGraph: true,
    authBoundary: true,
    workerFrame: true,
    drilldownPlan: true,
    f12Navigation: true,
    firstF12RequestDetail: true,
    researchPack: true,
  };
  const paths = {
    har: summary.harPath,
    harCompleteness: summary.harCompletenessPath,
    realtime: summary.realtimeLogPath,
    application: summary.applicationExportPath,
    trace: summary.tracePath,
    bundle: summary.evidenceBundlePath,
    manifest: summary.evidenceManifestPath,
    correlationGraph: summary.correlationGraphPath,
    authBoundary: summary.authBoundaryReportPath,
    workerFrame: summary.workerFrameReportPath,
    drilldownPlan: summary.drilldownPlanPath,
    f12Navigation: summary.f12NavigationPath,
    firstF12RequestDetail: summary.firstF12RequestDetailPath,
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

export function buildResearchPackDrilldowns(artifacts = {}, options = {}) {
  const profileInput = options.profile ? { profile: options.profile } : {};
  const artifactRows = Array.isArray(artifacts.artifactIndex?.artifacts) ? artifacts.artifactIndex.artifacts : [];
  const timelineEvents = Array.isArray(artifacts.evidenceTimeline?.events) ? artifacts.evidenceTimeline.events : [];
  const firstRequest = timelineEvents.find((event) => event.type === "network-request" && event.requestId);
  const harArtifact = artifactRows.find((artifact) => artifact.kind === "har" || String(artifact.path || "").toLowerCase().endsWith(".har"));
  const realtimeArtifact = artifacts.realtime?.reportPath ? { path: artifacts.realtime.reportPath } : artifactRows.find((artifact) => artifact.kind === "realtime" || String(artifact.path || "").toLowerCase().includes("\\realtime\\") || String(artifact.path || "").toLowerCase().includes("/realtime/"));
  const traceArtifact = artifactRows.find((artifact) => artifact.kind === "trace" || String(artifact.path || "").toLowerCase().includes("\\traces\\") || String(artifact.path || "").toLowerCase().includes("/traces/"));
  const tracePath = artifacts.trace?.tracePath || traceArtifact?.path || null;
  const bundleArtifact = artifactRows.find((artifact) => artifact.kind === "bundle" || String(artifact.path || "").toLowerCase().includes("\\bundles\\") || String(artifact.path || "").toLowerCase().includes("/bundles/"));
  const rows = [
    {
      label: "Chronological evidence orientation",
      tool: "browser_evidence_timeline",
      input: { ...profileInput, maxEvents: 80, maxArtifacts: 120 },
      why: "Start from objective event order before selecting request, console, realtime, or artifact drilldowns.",
    },
    {
      label: "Artifact inventory",
      tool: "browser_artifact_index",
      input: { ...profileInput, maxFiles: 200 },
      why: "List saved HAR, trace, bundle, manifest, graph, and report files without loading large artifacts into context.",
    },
    {
      label: "F12 backend boundary check",
      tool: "browser_f12_parity_matrix",
      input: {},
      why: "Decide whether a missing signal is a browser/backend boundary or a wrapper gap.",
    },
  ];
  if (firstRequest) {
    rows.push({
      label: "First captured request detail",
      tool: "profile_request_detail",
      input: { ...profileInput, requestId: firstRequest.requestId },
      why: "Inspect headers, cookies, timing, redirect chain, initiator, and body availability for a concrete observed request.",
    });
    rows.push({
      label: "Browser-level replay boundary check",
      tool: "profile_request_replay_batch",
      input: { ...profileInput, requestId: firstRequest.requestId, variants: [{ label: "baseline" }] },
      why: "Compare observed browser-fetch replay behavior while preserving replayBoundary limitations.",
    });
  }
  if (harArtifact?.path) {
    rows.push({
      label: "HAR artifact shape",
      tool: "browser_artifact_inspect",
      input: { path: harArtifact.path, maxBytes: 8000 },
      why: "Inspect HAR entry/body/timing structure without reading the full file into context.",
    });
  }
  if (realtimeArtifact?.path) {
    rows.push({
      label: "Realtime WebSocket/SSE evidence",
      tool: "browser_artifact_read",
      input: { path: realtimeArtifact.path, mode: "line", startLine: 1, maxLines: 120 },
      why: "Read saved WebSocket/SSE evidence without loading the full realtime stream into context.",
    });
    rows.push({
      label: "Realtime payload drilldown",
      tool: "profile_realtime_log",
      input: { ...profileInput, payload_contains: "<literal-protocol-marker>", limit: 50 },
      why: "Filter WebSocket/SSE payloads by a concrete marker such as an XMPP error, room name, or protocol token.",
    });
  }
  if (tracePath) {
    rows.push({
      label: "Trace event drilldown",
      tool: "browser_trace_query",
      input: { tracePath, minDurationMs: 5, limit: 20 },
      why: "Query saved Chrome trace events by duration/name/category for performance or execution timing evidence.",
    });
  }
  if (bundleArtifact?.path) {
    rows.push({
      label: "Evidence bundle preview",
      tool: "browser_artifact_read",
      input: { path: bundleArtifact.path, mode: "line", startLine: 1, maxLines: 80 },
      why: "Read a bounded slice of the compact evidence bundle for handoff context.",
    });
  }
  rows.push({
    label: "Literal evidence search",
    tool: "browser_artifact_search",
    input: { ...profileInput, query: "<literal-url-token-header-or-marker>", maxFiles: 200, maxMatches: 20 },
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
  if (options.evidenceDir) {
    const planPath = options.path || join(options.evidenceDir, "drilldowns", `${Date.now()}-research-pack-drilldowns.json`);
    mkdirSync(dirname(planPath), { recursive: true });
    writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    return { ...plan, planPath };
  }
  return plan;
}

export function buildResearchPackF12Navigation(artifacts = {}, options = {}) {
  const profileInput = options.profile ? { profile: options.profile } : {};
  const limit = Math.max(1, Math.min(Number(options.limit) || 10, 50));
  const nodes = Array.isArray(artifacts.correlationGraph?.nodes) ? artifacts.correlationGraph.nodes : [];
  const requestNodes = nodes.filter((node) => node?.type === "request").slice(0, limit);
  const requests = requestNodes.map((node) => {
    const f12Columns = node.f12Columns && typeof node.f12Columns === "object" ? node.f12Columns : {
      name: networkDisplayName(node.url || ""),
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
        tool: "profile_request_detail",
        input: { ...profileInput, requestId: node.requestId },
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
      networkTable: "profile_traffic_query.requests[].f12Columns",
      requestDetail: "profile_request_detail.detail.f12Sections",
      correlationGraph: "browser_request_correlation_graph.nodes[type=request].f12Columns",
    },
    boundaries: [
      "f12Navigation is a deterministic route index over captured F12 evidence.",
      "It does not inspect artifact bodies beyond already returned summaries.",
      "It does not decide whether a request is vulnerable or important.",
    ],
  };
}

export function summarizeF12RequestDetail(result = {}, route = null) {
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
      "Header values are not duplicated here; call profile_request_detail with requestId for exact values.",
      "This summary does not classify request importance, exploitability, or vulnerability.",
    ],
  };
}
