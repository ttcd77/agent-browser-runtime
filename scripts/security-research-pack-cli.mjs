#!/usr/bin/env node

const defaults = {
  managedServer: "http://127.0.0.1:17335",
  personalServer: "http://127.0.0.1:17337",
  profile: "researcher",
};

function usage() {
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

function parseArgs(argv) {
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

function printSummary(pack) {
  const summary = pack.summary || {};
  const artifacts = {
    har: summary.harPath,
    application: summary.applicationExportPath,
    trace: summary.tracePath || summary.chromeTracePath,
    bundle: summary.evidenceBundlePath,
    manifest: summary.evidenceManifestPath,
    graph: summary.correlationGraphPath,
    auth: summary.authBoundaryReportPath,
    workerFrame: summary.workerFrameReportPath,
  };
  console.log("Security research pack complete");
  console.log(`- backend: ${pack.backend || "(unknown)"}`);
  console.log(`- url: ${summary.url || pack.page?.url || "(unknown)"}`);
  console.log(`- requests: ${summary.requestCount ?? "(unknown)"}`);
  console.log(`- failed requests: ${summary.failedRequestCount ?? "(unknown)"}`);
  console.log(`- console entries: ${summary.consoleEntryCount ?? "(unknown)"}`);
  console.log(`- artifact files: ${summary.artifactFileCount ?? "(unknown)"}`);
  console.log(`- evidence timeline events: ${summary.evidenceTimelineEventCount ?? "(unknown)"}`);
  console.log(`- F12 parity panels: ${summary.f12ParityPanelCount ?? "(unknown)"}`);
  console.log(`- drilldowns: ${summary.drilldownCount ?? "(unknown)"}`);
  console.log("- artifacts:");
  for (const [name, value] of Object.entries(artifacts)) {
    if (value) console.log(`  - ${name}: ${value}`);
  }
  if (Array.isArray(pack.nextTools) && pack.nextTools.length) {
    console.log(`- next tools: ${pack.nextTools.join(", ")}`);
  }
  if (Array.isArray(pack.drilldownPlan?.drilldowns) && pack.drilldownPlan.drilldowns.length) {
    console.log("- first drilldowns:");
    for (const step of pack.drilldownPlan.drilldowns.slice(0, 5)) {
      console.log(`  - ${step.label}: ${step.tool}`);
    }
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
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
