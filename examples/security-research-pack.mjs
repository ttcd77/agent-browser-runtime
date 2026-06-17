#!/usr/bin/env node

const server = process.env.AGENT_BROWSER_SERVER || "http://127.0.0.1:17335";
const profile = process.env.AGENT_BROWSER_PROFILE || "researcher";
const url = process.argv[2] || "https://example.com";

async function callTool(name, input = {}) {
  const response = await fetch(`${server}/tool/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${name} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

await callTool("profile_create", { profile });

const beforeReadiness = await callTool("browser_professional_readiness", {
  profile,
});

const pack = await callTool("browser_security_pack", {
  profile,
  url,
  limit: 20,
  waitMs: 1000,
  includeHar: true,
  includeTrace: true,
  includeApplicationExport: true,
});

const afterReadiness = await callTool("browser_professional_readiness", {
  profile,
});

function compactRouteArtifacts(routeSummary = {}) {
  const entries = [
    ["f12Navigation", routeSummary.f12NavigationArtifact],
    ["firstF12RequestDetail", routeSummary.firstF12RequestDetailArtifact],
    ["harCompleteness", routeSummary.harCompletenessArtifact],
    ["trace", routeSummary.traceArtifact],
    ["applicationExport", routeSummary.applicationExportArtifact],
    ["evidenceBundle", routeSummary.evidenceBundleArtifact],
    ["drilldownPlan", routeSummary.drilldownPlanArtifact],
    ["evidenceManifest", routeSummary.evidenceManifestArtifact],
    ["correlationGraph", routeSummary.correlationGraphArtifact],
    ["authBoundary", routeSummary.authBoundaryArtifact],
    ["workerFrameBoundary", routeSummary.workerFrameArtifact],
  ].filter(([, artifact]) => artifact?.path || artifact?.inspect || artifact?.read);
  return Object.fromEntries(entries.map(([name, artifact]) => [name, {
    path: artifact.path || artifact.inspect?.input?.path || artifact.read?.input?.path || null,
    inspect: artifact.inspect || null,
    read: artifact.read || null,
  }]));
}

const _routeArtifactsMap =
  afterReadiness.routeArtifacts || compactRouteArtifacts(afterReadiness.routeSummary);

const _firstRequestRoute =
  pack.f12Navigation?.requests?.find((r) => r?.detail)?.detail ||
  afterReadiness.routeSummary?.firstF12RequestDetail ||
  null;

const _drilldownItems = (pack.drilldownPlan?.drilldowns || [])
  .slice(0, 3)
  .map((d) => ({
    label: d.label || d.tool || "drilldown",
    tool: d.tool,
    input: d.input || {},
  }));

const operatorHandoff = {
  firstRead: {
    tool: afterReadiness.routeSummary?.latestHandoffRead?.tool || "browser_artifact_read",
    route:
      afterReadiness.routeSummary?.latestHandoffRead ||
      (pack.summary?.researchPackPath
        ? {
            tool: "browser_artifact_read",
            input: {
              profile,
              path: pack.summary.researchPackPath,
              mode: "line",
              startLine: 1,
              maxLines: 120,
            },
          }
        : null),
    purpose:
      "Bounded read of the research pack summary; start here before loading other artifacts",
  },
  routeArtifacts: Object.entries(_routeArtifactsMap)
    .filter(([, art]) => art?.inspect || art?.read)
    .map(([name, art]) => ({
      name,
      inspectRoute: art.inspect || null,
      readRoute: art.read || null,
    })),
  firstRequest: _firstRequestRoute,
  drilldowns: _drilldownItems,
  objectiveBoundary:
    "Collect browser evidence only; do not classify findings as vulnerabilities.",
};

console.log(JSON.stringify({
  backend: pack.backend,
  profile: pack.profile,
  url: pack.url,
  summary: pack.summary,
  beforeReadiness: {
    ready: beforeReadiness.ready,
    evidenceReady: beforeReadiness.evidenceReady,
    missing: beforeReadiness.missing,
    nextActions: beforeReadiness.nextActions,
    objectiveBoundary: beforeReadiness.objectiveBoundary,
  },
  afterReadiness: {
    ready: afterReadiness.ready,
    evidenceReady: afterReadiness.evidenceReady,
    missing: afterReadiness.missing,
    artifactCount: afterReadiness.artifactCount,
    timelineEventCount: afterReadiness.timelineEventCount,
    routeSummary: afterReadiness.routeSummary,
    f12NavigationRequestCount: afterReadiness.summary?.f12NavigationRequestCount ?? afterReadiness.f12Navigation?.requestNodeCount ?? null,
    firstF12RequestDetail: afterReadiness.routeSummary?.firstF12RequestDetail || null,
    routeArtifacts: afterReadiness.routeArtifacts || compactRouteArtifacts(afterReadiness.routeSummary),
    objectiveBoundary: afterReadiness.objectiveBoundary,
  },
  f12Navigation: {
    requestNodeCount: pack.f12Navigation?.requestNodeCount ?? null,
    firstRequest: pack.f12Navigation?.firstRequest || null,
    firstDetailRoute: pack.f12Navigation?.requests?.find((row) => row?.detail)?.detail || null,
    sectionRoutes: pack.f12Navigation?.sectionRoutes || null,
  },
  firstF12RequestDetail: pack.firstF12RequestDetail ? {
    requestId: pack.firstF12RequestDetail.requestId,
    url: pack.firstF12RequestDetail.url,
    status: pack.firstF12RequestDetail.status,
    sectionAvailability: pack.firstF12RequestDetail.sectionAvailability,
    headerSummary: pack.firstF12RequestDetail.sections?.headers || null,
    objectiveBoundary: pack.firstF12RequestDetail.boundaries?.at(-1) || null,
  } : null,
  handoff: {
    ready: pack.handoffCompleteness?.ready,
    missing: pack.handoffCompleteness?.missing,
    researchPackPath: pack.summary?.researchPackPath,
    drilldownPlanPath: pack.summary?.drilldownPlanPath,
  },
  artifactCoverage: {
    ready: pack.artifactCoverage?.ready,
    missing: pack.artifactCoverage?.missing,
    skipped: pack.artifactCoverage?.skipped,
  },
  captureBoundaries: pack.captureBoundaries,
  artifactPaths: {
    harPath: pack.summary?.harPath,
    harCompletenessPath: pack.summary?.harCompletenessPath,
    applicationExportPath: pack.summary?.applicationExportPath,
    tracePath: pack.summary?.tracePath,
    evidenceBundlePath: pack.summary?.evidenceBundlePath,
    evidenceManifestPath: pack.summary?.evidenceManifestPath,
    correlationGraphPath: pack.summary?.correlationGraphPath,
    authBoundaryReportPath: pack.summary?.authBoundaryReportPath,
    workerFrameReportPath: pack.summary?.workerFrameReportPath,
    f12NavigationPath: pack.summary?.f12NavigationPath,
    firstF12RequestDetailPath: pack.summary?.firstF12RequestDetailPath,
    researchPackPath: pack.summary?.researchPackPath,
    drilldownPlanPath: pack.summary?.drilldownPlanPath,
  },
  firstDrilldowns: pack.drilldownPlan?.drilldowns?.slice(0, 5),
  operatorHandoff,
  objectiveBoundary: "This example prints evidence workflow readiness and artifact paths only; it does not judge vulnerabilities.",
}, null, 2));
