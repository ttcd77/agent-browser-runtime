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
  if (workflow.task || Array.isArray(workflow.defaultPath)) {
    output(`- workflow: ${workflow.task || "(unknown)"}`);
    if (Array.isArray(workflow.defaultPath)) output(`  - path: ${workflow.defaultPath.join(" -> ")}`);
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

  if (args.json) {
    console.log(JSON.stringify(pack, null, 2));
  } else {
    printSummary(pack);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
