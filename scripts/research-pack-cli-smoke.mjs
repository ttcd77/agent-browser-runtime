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
    handoffReady: true,
    handoffPresentCount: 7,
    handoffMissing: [],
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
  nextTools: ["devtools_request_detail"],
  handoffCompleteness: {
    ready: true,
    presentCount: 7,
    missing: [],
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
assert(output.includes("browser_open -> browser_capture -> browser_inspect -> browser_security_pack -> drilldownPlan"), "summary missing workflow path");
assert(output.includes("- capture:"), "summary missing capture section");
assert(output.includes("trafficCount: 2"), "summary missing capture traffic count");
assert(output.includes("research-pack=1"), "summary missing artifact kind counts");
assert(output.includes("devtools_artifact_inspect path=tmp/security-research-pack.json"), "summary missing handoff inspect command");
assert(output.includes("devtools_artifact_read path=tmp/security-research-pack.json"), "summary missing handoff read command");
assert(output.includes("Request detail: devtools_request_detail"), "summary missing first drilldown");

console.log("Research pack CLI smoke passed");
