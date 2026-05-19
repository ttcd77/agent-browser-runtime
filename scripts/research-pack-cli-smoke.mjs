#!/usr/bin/env node

import { parseArgs, printSummary, usage } from "./security-research-pack-cli.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const parsed = parseArgs([
  "--url",
  "https://example.com",
  "--profile",
  "researcher",
  "--no-trace",
  "--limit",
  "7",
]);
assert(parsed.url === "https://example.com", "CLI parser lost url");
assert(parsed.profile === "researcher", "CLI parser lost profile");
assert(parsed.includeTrace === false, "CLI parser did not parse --no-trace");
assert(parsed.limit === 7, "CLI parser did not parse numeric limit");
assert(usage().includes("--json"), "CLI usage missing --json");

const lines = [];
printSummary({
  backend: "managed-cdp",
  page: { url: "https://example.com" },
  workflow: {
    task: "professional-appsec",
    defaultPath: ["browser_open", "browser_capture", "browser_inspect", "browser_security_pack", "drilldownPlan"],
  },
  agentEntryPoints: {
    defaultMode: "facade-first",
    recommendedFirstCall: "devtools_professional_readiness",
    professionalPath: ["browser_open", "browser_capture", "browser_inspect", "browser_security_pack"],
    drilldownRule: "Use low-level devtools_* tools only after concrete evidence exists.",
  },
  summary: {
    url: "https://example.com",
    requestCount: 2,
    failedRequestCount: 0,
    consoleEntryCount: 1,
    artifactFileCount: 8,
    artifactKinds: { har: 1, "research-pack": 1, "drilldown-plan": 1 },
    evidenceTimelineEventCount: 5,
    f12ParityPanelCount: 9,
    drilldownCount: 3,
    f12NavigationRequestCount: 2,
    handoffReady: true,
    handoffPresentCount: 7,
    handoffMissing: [],
    artifactCoverageReady: true,
    artifactCoverageMissing: [],
    artifactCoverageSkipped: ["trace"],
    harPath: "tmp/example.har",
    researchPackPath: "tmp/security-research-pack.json",
    capture: {
      enabled: true,
      label: "hard-reload",
      startedAt: "2026-05-18T00:00:00.000Z",
      stoppedAt: null,
      trafficCount: 2,
    },
  },
  f12Navigation: {
    requestNodeCount: 2,
    requests: [{
      label: "GET /api/data",
      requestId: "request-1",
      f12Columns: { name: "data", status: 200, type: "fetch" },
      detail: { tool: "devtools_request_detail", input: { requestId: "request-1" } },
    }],
  },
  firstF12RequestDetail: {
    requestId: "request-1",
    status: 200,
    sectionAvailability: {
      overview: true,
      headers: true,
      payload: true,
      cookies: true,
      timing: true,
      initiator: true,
      redirects: true,
      security: true,
    },
    sections: {
      headers: {
        requestHeaderCount: 6,
        responseHeaderCount: 4,
      },
      payload: {
        bodyReadable: true,
        bodyBytes: 42,
      },
    },
  },
  nextTools: ["devtools_request_detail"],
  handoffCompleteness: {
    ready: true,
    presentCount: 7,
    missing: [],
  },
  artifactCoverage: {
    ready: true,
    missing: [],
    skipped: ["trace"],
  },
  professionalReadiness: {
    ready: true,
    evidenceReady: true,
    missing: [],
    nextActions: [{ tool: "devtools_workflow_guide" }],
    routeArtifacts: {
      f12Navigation: {
        path: "tmp/f12-navigation-compact.json",
        inspect: { tool: "devtools_artifact_inspect", input: { path: "tmp/f12-navigation-compact.json" } },
        read: { tool: "devtools_artifact_read", input: { path: "tmp/f12-navigation-compact.json" } },
      },
      harCompleteness: {
        path: "tmp/har-completeness.json",
        inspect: { tool: "devtools_artifact_inspect", input: { path: "tmp/har-completeness.json" } },
        read: { tool: "devtools_artifact_read", input: { path: "tmp/har-completeness.json" } },
      },
    },
    routeSummary: {
      firstStep: { tool: "devtools_artifact_inspect", input: { path: "tmp/security-research-pack.json" } },
      latestHandoffInspect: { tool: "devtools_artifact_inspect", input: { path: "tmp/security-research-pack.json" } },
      latestHandoffRead: { tool: "devtools_artifact_read", input: { path: "tmp/security-research-pack.json", mode: "line", startLine: 1, maxLines: 120 } },
      firstF12RequestDetail: { label: "GET /api/data", tool: "devtools_request_detail", input: { requestId: "request-1" }, f12Columns: { name: "data" } },
      firstConcreteDrilldown: { label: "Request detail", tool: "devtools_request_detail", input: { requestId: "request-1" } },
      f12NavigationRequestCount: 2,
      artifactEntrypointCount: 3,
      f12NavigationArtifact: {
        path: "tmp/f12-navigation.json",
        inspect: { tool: "devtools_artifact_inspect", input: { path: "tmp/f12-navigation.json" } },
        read: { tool: "devtools_artifact_read", input: { path: "tmp/f12-navigation.json" } },
      },
      correlationGraphArtifact: {
        path: "tmp/correlation-graph.json",
        inspect: { tool: "devtools_artifact_inspect", input: { path: "tmp/correlation-graph.json" } },
        read: { tool: "devtools_artifact_read", input: { path: "tmp/correlation-graph.json" } },
      },
      authBoundaryArtifact: {
        path: "tmp/auth-boundary.json",
        inspect: { tool: "devtools_artifact_inspect", input: { path: "tmp/auth-boundary.json" } },
        read: { tool: "devtools_artifact_read", input: { path: "tmp/auth-boundary.json" } },
      },
      workerFrameArtifact: {
        path: "tmp/worker-frame.json",
        inspect: { tool: "devtools_artifact_inspect", input: { path: "tmp/worker-frame.json" } },
        read: { tool: "devtools_artifact_read", input: { path: "tmp/worker-frame.json" } },
      },
    },
  },
  drilldownPlan: {
    drilldowns: [{ label: "Request detail", tool: "devtools_request_detail" }],
  },
}, (line) => lines.push(line));

const output = lines.join("\n");
assert(output.includes("- workflow: professional-appsec"), "summary missing workflow");
assert(output.includes("- handoff ready: true"), "summary missing handoff readiness");
assert(output.includes("present: 7"), "summary missing handoff present count");
assert(output.includes("missing: (none)"), "summary missing handoff missing list");
assert(output.includes("- artifact coverage ready: true"), "summary missing artifact coverage readiness");
assert(output.includes("skipped: trace"), "summary missing artifact coverage skipped list");
assert(output.includes("- professional readiness: true"), "summary missing professional readiness");
assert(output.includes("evidence ready: true"), "summary missing professional evidence readiness");
assert(output.includes("next action: devtools_workflow_guide"), "summary missing readiness next action");
assert(output.includes("route first step: devtools_artifact_inspect"), "summary missing readiness route first step");
assert(output.includes("route handoff inspect: devtools_artifact_inspect path=tmp/security-research-pack.json"), "summary missing route handoff inspect");
assert(output.includes("route handoff read: devtools_artifact_read path=tmp/security-research-pack.json"), "summary missing route handoff read");
assert(output.includes("route first drilldown: Request detail: devtools_request_detail"), "summary missing route first drilldown");
assert(output.includes("route first F12 request: data: devtools_request_detail requestId=request-1"), "summary missing route first F12 request");
assert(output.includes("route F12 navigation requests: 2"), "summary missing route F12 navigation count");
assert(output.includes("route evidence entrypoints: 3"), "summary missing route evidence entrypoint count");
assert(output.includes("- route artifacts:"), "summary missing route artifact section");
assert(output.includes("F12 navigation: tmp/f12-navigation-compact.json"), "summary missing compact F12 navigation artifact route");
assert(output.includes("HAR completeness: tmp/har-completeness.json"), "summary missing compact HAR completeness artifact route");
assert(output.includes("correlation graph: tmp/correlation-graph.json"), "summary missing correlation graph artifact route");
assert(output.includes("auth boundary: tmp/auth-boundary.json"), "summary missing auth boundary artifact route");
assert(output.includes("worker/frame boundary: tmp/worker-frame.json"), "summary missing worker/frame artifact route");
assert(output.includes("inspect: devtools_artifact_inspect"), "summary missing route artifact inspect command");
assert(output.includes("read: devtools_artifact_read"), "summary missing route artifact read command");
assert(output.includes("- F12 navigation requests: 2"), "summary missing F12 navigation request count");
assert(output.includes("first request detail: data: devtools_request_detail requestId=request-1"), "summary missing F12 navigation request detail");
assert(output.includes("browser_open -> browser_capture -> browser_inspect -> browser_security_pack -> drilldownPlan"), "summary missing workflow path");
assert(output.includes("- agent entry mode: facade-first"), "summary missing agent entry mode");
assert(output.includes("first call: devtools_professional_readiness"), "summary missing recommended first call");
assert(output.includes("professional path: browser_open -> browser_capture -> browser_inspect -> browser_security_pack"), "summary missing agent professional path");
assert(output.includes("- capture:"), "summary missing capture section");
assert(output.includes("trafficCount: 2"), "summary missing capture traffic count");
assert(output.includes("research-pack=1"), "summary missing artifact kind counts");
assert(output.includes("devtools_artifact_inspect path=tmp/security-research-pack.json"), "summary missing handoff inspect command");
assert(output.includes("devtools_artifact_read path=tmp/security-research-pack.json"), "summary missing handoff read command");
assert(output.includes("- first F12 request detail:"), "summary missing first F12 request detail section");
assert(output.includes("requestId: request-1"), "summary missing first F12 request id");
assert(output.includes("sections: overview, headers, payload, cookies, timing, initiator, redirects, security"), "summary missing first F12 request sections");
assert(output.includes("request headers: 6"), "summary missing first F12 request header count");
assert(output.includes("body readable: true"), "summary missing first F12 request body readability");
assert(output.includes("Request detail: devtools_request_detail"), "summary missing first drilldown");

console.log("Research pack CLI smoke passed");
