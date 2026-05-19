#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const defaults = {
  managedServer: "http://127.0.0.1:17335",
  personalServer: "http://127.0.0.1:17337",
  profile: "researcher",
};

export function usage() {
  return `Usage:
  node scripts/security-research-pack-cli.mjs --url https://example.com [options]

Options:
  --url <url>                 HTTP/HTTPS URL to inspect.
  --profile <name>            Managed Browser profile name. Default: researcher.
  --server <url>              Tool server base URL.
  --personal                  Use Personal Chrome bridge default server (17337).
  --no-har                    Skip HAR artifact.
  --no-trace                  Skip Chrome trace artifact.
  --no-application-export     Skip Application panel export.
  --token-scan                Include token scan in bundle/auth evidence.
  --limit <n>                 First-pass evidence limit. Default: 20.
  --wait-ms <n>               Navigation/reload wait time. Default: 1000.
  --json                      Print full JSON response.
  --help                      Show this help.
`;
}

export function parseArgs(argv) {
  const args = {
    url: null,
    profile: defaults.profile,
    server: null,
    personal: false,
    includeHar: true,
    includeTrace: true,
    includeApplicationExport: true,
    includeTokenScan: false,
    limit: 20,
    waitMs: 1000,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--url") {
      args.url = argv[++i];
    } else if (arg === "--profile") {
      args.profile = argv[++i];
    } else if (arg === "--server") {
      args.server = argv[++i];
    } else if (arg === "--personal") {
      args.personal = true;
    } else if (arg === "--no-har") {
      args.includeHar = false;
    } else if (arg === "--no-trace") {
      args.includeTrace = false;
    } else if (arg === "--no-application-export") {
      args.includeApplicationExport = false;
    } else if (arg === "--token-scan") {
      args.includeTokenScan = true;
    } else if (arg === "--limit") {
      args.limit = Number(argv[++i]);
    } else if (arg === "--wait-ms") {
      args.waitMs = Number(argv[++i]);
    } else if (arg === "--json") {
      args.json = true;
    } else if (!args.url && /^https?:\/\//i.test(arg)) {
      args.url = arg;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

async function callTool(server, name, input = {}) {
  const response = await fetch(`${server.replace(/\/$/, "")}/tool/${name}`, {
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
    throw new Error(`${name} failed: HTTP ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

export function printSummary(pack, output = console.log) {
  const summary = pack.summary || {};
  const workflow = pack.workflow || {};
  const capture = summary.capture || {};
  const artifactKinds = summary.artifactKinds || pack.artifacts?.artifactIndex?.kinds || {};
  const artifacts = {
    har: summary.harPath,
    application: summary.applicationExportPath,
    trace: summary.tracePath || summary.chromeTracePath,
    bundle: summary.evidenceBundlePath,
    manifest: summary.evidenceManifestPath,
    graph: summary.correlationGraphPath,
    auth: summary.authBoundaryReportPath,
    workerFrame: summary.workerFrameReportPath,
    drilldowns: summary.drilldownPlanPath,
    researchPack: summary.researchPackPath,
  };
  output("Security research pack complete");
  output(`- backend: ${pack.backend || "(unknown)"}`);
  output(`- url: ${summary.url || pack.page?.url || "(unknown)"}`);
  output(`- requests: ${summary.requestCount ?? "(unknown)"}`);
  output(`- failed requests: ${summary.failedRequestCount ?? "(unknown)"}`);
  output(`- console entries: ${summary.consoleEntryCount ?? "(unknown)"}`);
  output(`- artifact files: ${summary.artifactFileCount ?? "(unknown)"}`);
  output(`- evidence timeline events: ${summary.evidenceTimelineEventCount ?? "(unknown)"}`);
  output(`- F12 parity panels: ${summary.f12ParityPanelCount ?? "(unknown)"}`);
  output(`- drilldowns: ${summary.drilldownCount ?? "(unknown)"}`);
  if (summary.f12NavigationRequestCount !== undefined || pack.f12Navigation) {
    const navigation = pack.f12Navigation || {};
    const firstDetail = navigation.requests?.find((row) => row?.detail) || navigation.firstRequest || null;
    output(`- F12 navigation requests: ${summary.f12NavigationRequestCount ?? navigation.requestNodeCount ?? "(unknown)"}`);
    if (firstDetail?.detail?.tool) {
      const requestId = firstDetail.detail.input?.requestId || firstDetail.requestId || "(unknown)";
      const name = firstDetail.f12Columns?.name || firstDetail.label || firstDetail.url || "(unlabelled)";
      output(`  - first request detail: ${name}: ${firstDetail.detail.tool} requestId=${requestId}`);
    }
  }
  if (summary.handoffReady !== undefined || pack.handoffCompleteness) {
    const completeness = pack.handoffCompleteness || {};
    output(`- handoff ready: ${summary.handoffReady ?? completeness.ready ?? "(unknown)"}`);
    output(`  - present: ${summary.handoffPresentCount ?? completeness.presentCount ?? "(unknown)"}`);
    const missing = summary.handoffMissing || completeness.missing || [];
    output(`  - missing: ${Array.isArray(missing) && missing.length ? missing.join(", ") : "(none)"}`);
  }
  if (summary.artifactCoverageReady !== undefined || pack.artifactCoverage) {
    const coverage = pack.artifactCoverage || {};
    const missing = summary.artifactCoverageMissing || coverage.missing || [];
    const skipped = summary.artifactCoverageSkipped || coverage.skipped || [];
    output(`- artifact coverage ready: ${summary.artifactCoverageReady ?? coverage.ready ?? "(unknown)"}`);
    output(`  - missing: ${Array.isArray(missing) && missing.length ? missing.join(", ") : "(none)"}`);
    output(`  - skipped: ${Array.isArray(skipped) && skipped.length ? skipped.join(", ") : "(none)"}`);
  }
  if (pack.professionalReadiness) {
    const readiness = pack.professionalReadiness;
    output(`- professional readiness: ${readiness.ready ?? "(unknown)"}`);
    output(`  - evidence ready: ${readiness.evidenceReady ?? "(unknown)"}`);
    const missing = readiness.missing || [];
    output(`  - missing: ${Array.isArray(missing) && missing.length ? missing.join(", ") : "(none)"}`);
    if (Array.isArray(readiness.nextActions) && readiness.nextActions.length) {
      output(`  - next action: ${readiness.nextActions[0].tool}`);
    }
    const route = readiness.routeSummary || {};
    if (route.firstStep?.tool) output(`  - route first step: ${route.firstStep.tool}`);
    if (route.latestHandoffInspect?.input?.path) {
      output(`  - route handoff inspect: ${route.latestHandoffInspect.tool} path=${route.latestHandoffInspect.input.path}`);
    }
    if (route.latestHandoffRead?.input?.path) {
      output(`  - route handoff read: ${route.latestHandoffRead.tool} path=${route.latestHandoffRead.input.path}`);
    }
    if (route.firstConcreteDrilldown?.tool) {
      output(`  - route first drilldown: ${route.firstConcreteDrilldown.label || "(unlabelled)"}: ${route.firstConcreteDrilldown.tool}`);
    }
    if (route.firstF12RequestDetail?.tool) {
      const requestId = route.firstF12RequestDetail.input?.requestId || "(unknown)";
      const name = route.firstF12RequestDetail.f12Columns?.name || route.firstF12RequestDetail.label || "(unlabelled)";
      output(`  - route first F12 request: ${name}: ${route.firstF12RequestDetail.tool} requestId=${requestId}`);
    }
    if (typeof route.f12NavigationRequestCount === "number") {
      output(`  - route F12 navigation requests: ${route.f12NavigationRequestCount}`);
    }
    if (typeof route.artifactEntrypointCount === "number") {
      output(`  - route evidence entrypoints: ${route.artifactEntrypointCount}`);
    }
    const routeArtifacts = [
      ["F12 navigation", route.f12NavigationArtifact],
      ["first F12 request detail", route.firstF12RequestDetailArtifact],
      ["HAR completeness", route.harCompletenessArtifact],
      ["trace", route.traceArtifact],
      ["Application export", route.applicationExportArtifact],
      ["evidence bundle", route.evidenceBundleArtifact],
      ["drilldown plan", route.drilldownPlanArtifact],
      ["evidence manifest", route.evidenceManifestArtifact],
      ["correlation graph", route.correlationGraphArtifact],
      ["auth boundary", route.authBoundaryArtifact],
      ["worker/frame boundary", route.workerFrameArtifact],
    ].filter(([, artifact]) => artifact?.inspect?.tool || artifact?.read?.tool);
    if (routeArtifacts.length) {
      output("  - route artifacts:");
      for (const [label, artifact] of routeArtifacts) {
        const path = artifact.path || artifact.inspect?.input?.path || artifact.read?.input?.path || "(unknown)";
        output(`    - ${label}: ${path}`);
        if (artifact.inspect?.tool) output(`      inspect: ${artifact.inspect.tool}`);
        if (artifact.read?.tool) output(`      read: ${artifact.read.tool}`);
      }
    }
  }
  if (workflow.task || Array.isArray(workflow.defaultPath)) {
    output(`- workflow: ${workflow.task || "(unknown)"}`);
    if (Array.isArray(workflow.defaultPath)) output(`  - path: ${workflow.defaultPath.join(" -> ")}`);
  }
  if (pack.agentEntryPoints) {
    const entry = pack.agentEntryPoints;
    output(`- agent entry mode: ${entry.defaultMode || "(unknown)"}`);
    if (entry.recommendedFirstCall) output(`  - first call: ${entry.recommendedFirstCall}`);
    if (Array.isArray(entry.professionalPath) && entry.professionalPath.length) {
      output(`  - professional path: ${entry.professionalPath.join(" -> ")}`);
    }
    if (entry.drilldownRule) output(`  - drilldown rule: ${entry.drilldownRule}`);
  }
  if (summary.capture) {
    output("- capture:");
    output(`  - enabled: ${capture.enabled ?? "(unknown)"}`);
    output(`  - label: ${capture.label || "(none)"}`);
    output(`  - startedAt: ${capture.startedAt || "(unknown)"}`);
    output(`  - stoppedAt: ${capture.stoppedAt || "(still active or unknown)"}`);
    output(`  - trafficCount: ${capture.trafficCount ?? "(unknown)"}`);
  }
  if (Object.keys(artifactKinds).length) {
    output(`- artifact kinds: ${Object.entries(artifactKinds).map(([kind, count]) => `${kind}=${count}`).join(", ")}`);
  }
  output("- artifacts:");
  for (const [name, value] of Object.entries(artifacts)) {
    if (value) output(`  - ${name}: ${value}`);
  }
  if (summary.researchPackPath) {
    output("- handoff:");
    output(`  - inspect: devtools_artifact_inspect path=${summary.researchPackPath}`);
    output(`  - read: devtools_artifact_read path=${summary.researchPackPath} mode=line startLine=1 maxLines=120`);
  }
  if (pack.firstF12RequestDetail) {
    const first = pack.firstF12RequestDetail;
    const available = Object.entries(first.sectionAvailability || {})
      .filter(([, present]) => present)
      .map(([name]) => name);
    output("- first F12 request detail:");
    output(`  - requestId: ${first.requestId || "(unknown)"}`);
    output(`  - status: ${first.status ?? "(unknown)"}`);
    output(`  - sections: ${available.length ? available.join(", ") : "(none)"}`);
    if (first.sections?.headers) {
      output(`  - request headers: ${first.sections.headers.requestHeaderCount ?? "(unknown)"}`);
      output(`  - response headers: ${first.sections.headers.responseHeaderCount ?? "(unknown)"}`);
    }
    if (first.sections?.payload) {
      output(`  - body readable: ${first.sections.payload.bodyReadable ?? "(unknown)"}`);
      output(`  - body bytes: ${first.sections.payload.bodyBytes ?? "(unknown)"}`);
    }
  }
  if (Array.isArray(pack.nextTools) && pack.nextTools.length) {
    output(`- next tools: ${pack.nextTools.join(", ")}`);
  }
  if (Array.isArray(pack.drilldownPlan?.drilldowns) && pack.drilldownPlan.drilldowns.length) {
    output("- first drilldowns:");
    for (const step of pack.drilldownPlan.drilldowns.slice(0, 5)) {
      output(`  - ${step.label}: ${step.tool}`);
    }
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.url) {
    console.error(usage());
    throw new Error("--url is required");
  }

  const server = args.server || (args.personal ? defaults.personalServer : defaults.managedServer);
  if (!args.personal) {
    await callTool(server, "profile_create", { profile: args.profile });
  }
  const pack = await callTool(server, "devtools_security_research_pack", {
    profile: args.personal ? undefined : args.profile,
    url: args.url,
    limit: args.limit,
    waitMs: args.waitMs,
    includeHar: args.includeHar,
    includeTrace: args.includeTrace,
    includeApplicationExport: args.includeApplicationExport,
    includeTokenScan: args.includeTokenScan,
  });
  try {
    pack.professionalReadiness = await callTool(server, "devtools_professional_readiness", {
      profile: args.personal ? undefined : args.profile,
    });
  } catch (error) {
    pack.professionalReadiness = {
      unavailable: true,
      error: String(error?.message || error),
      objectiveBoundary: "Readiness check failed separately from the research pack; this does not change the captured evidence.",
    };
  }

  if (args.json) {
    console.log(JSON.stringify(pack, null, 2));
  } else {
    printSummary(pack);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
