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

const beforeReadiness = await callTool("devtools_professional_readiness", {
  profile,
});

const pack = await callTool("devtools_security_research_pack", {
  profile,
  url,
  limit: 20,
  waitMs: 1000,
  includeHar: true,
  includeTrace: true,
  includeApplicationExport: true,
});

const afterReadiness = await callTool("devtools_professional_readiness", {
  profile,
});

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
    objectiveBoundary: afterReadiness.objectiveBoundary,
  },
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
    applicationExportPath: pack.summary?.applicationExportPath,
    tracePath: pack.summary?.tracePath,
    evidenceBundlePath: pack.summary?.evidenceBundlePath,
    evidenceManifestPath: pack.summary?.evidenceManifestPath,
    correlationGraphPath: pack.summary?.correlationGraphPath,
    authBoundaryReportPath: pack.summary?.authBoundaryReportPath,
    workerFrameReportPath: pack.summary?.workerFrameReportPath,
    researchPackPath: pack.summary?.researchPackPath,
    drilldownPlanPath: pack.summary?.drilldownPlanPath,
  },
  firstDrilldowns: pack.drilldownPlan?.drilldowns?.slice(0, 5),
  objectiveBoundary: "This example prints evidence workflow readiness and artifact paths only; it does not judge vulnerabilities.",
}, null, 2));
