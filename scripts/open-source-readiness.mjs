#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const requiredFiles = [
  "README.md",
  "LICENSE",
  "docs/safety-boundaries.md",
  "docs/agent-devtools-api.md",
  "docs/browser-worker-integration.md",
  "docs/devtools-panel-map.md",
  "docs/competitor-research.md",
  "docs/open-source-release-checklist.md",
  "docs/project-overview.md",
  "docs/public-release-notes.md",
  "examples/agent-devtools-workflows.md",
  "examples/mcp-adapter-sketch.mjs",
  "examples/sdk-browser-worker-requests.json",
  "examples/security-research-pack.mjs",
  "extension/manifest.json",
];

const requiredPackageScripts = [
  "build",
  "test",
  "check",
  "contract:devtools",
  "smoke:worker",
  "smoke:f12",
  "smoke:personal",
  "smoke:cli",
  "smoke:example",
  "check:devtools",
  "check:professional",
  "check:full",
  "professional:scorecard",
  "worker:doctor",
  "research:pack",
  "release:readiness",
];

const requiredReadmePhrases = [
  "Personal Profile",
  "Agent Browser",
  "Agent-Facing Tools",
  "What This Is Not",
  "Safety Boundaries",
  "devtools_security_research_pack",
  "devtools_professional_readiness",
  "routeSummary",
  "route artifacts",
  "routeArtifactCount",
  "routeArtifactNames",
  "browser_inspect",
];

const forbiddenTrackedPrefixes = [
  "tmp/",
  "logs/",
  "data/",
  "research/competitors/",
  "runtime/",
];

const failures = [];
const warnings = [];

function readText(path) {
  return readFileSync(path, "utf8");
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

for (const file of requiredFiles) {
  if (!existsSync(file)) failures.push(`missing required file: ${file}`);
}

const pkg = JSON.parse(readText("package.json"));
if (pkg.private !== false) failures.push("package.json must set private=false for an open-source package");
if (!pkg.license) failures.push("package.json is missing license");
if (!pkg.description || !/DevTools|browser|agent/i.test(pkg.description)) {
  failures.push("package.json description should explain the agent/browser runtime clearly");
}
if (!pkg.bin?.["agent-browser-research-pack"]) {
  failures.push("package.json missing bin: agent-browser-research-pack");
}
for (const script of requiredPackageScripts) {
  if (!pkg.scripts?.[script]) failures.push(`package.json missing script: ${script}`);
}

if (existsSync("README.md")) {
  const readme = readText("README.md");
  for (const phrase of requiredReadmePhrases) {
    if (!readme.includes(phrase)) failures.push(`README.md missing phrase/section: ${phrase}`);
  }
}

if (existsSync("docs/safety-boundaries.md")) {
  const safety = readText("docs/safety-boundaries.md");
  if (!/authorized/i.test(safety)) failures.push("safety boundaries must mention authorized use");
  if (!/sensitive/i.test(safety)) failures.push("safety boundaries must mention sensitive browser evidence");
}

if (existsSync("docs/agent-devtools-api.md")) {
  const api = readText("docs/agent-devtools-api.md");
  if (!api.includes("browser_*") || !api.includes("devtools_*")) {
    failures.push("agent-devtools-api.md must explain facade and low-level tool layers");
  }
  if (!api.includes("devtools_professional_readiness")) {
    failures.push("agent-devtools-api.md must document devtools_professional_readiness");
  }
  if (!api.includes("routeSummary")) {
    failures.push("agent-devtools-api.md must document readiness routeSummary");
  }
  if (!api.includes("routeArtifacts") || !api.includes("routeArtifactCount") || !api.includes("routeArtifactNames")) {
    failures.push("agent-devtools-api.md must document compact readiness route artifacts");
  }
  if (/decide whether.*vulnerab/i.test(api) === false) {
    failures.push("agent-devtools-api.md must preserve the objective-tool boundary");
  }
}

if (existsSync("docs/agent-operator-runbook.md")) {
  const runbook = readText("docs/agent-operator-runbook.md");
  for (const phrase of ["professional-appsec", "devtools_professional_readiness", "routeSummary", "route artifacts", "routeArtifactCount", "routeArtifactNames", "handoffReady", "devtools_artifact_read"]) {
    if (!runbook.includes(phrase)) failures.push(`agent-operator-runbook.md missing operator phrase: ${phrase}`);
  }
}

if (existsSync("docs/devtools-panel-map.md")) {
  const panelMap = readText("docs/devtools-panel-map.md");
  if (!panelMap.includes("devtools_professional_readiness")) {
    failures.push("devtools-panel-map.md must include devtools_professional_readiness in the first-screen/orientation map");
  }
}

if (existsSync("examples/security-research-pack.mjs")) {
  const example = readText("examples/security-research-pack.mjs");
  for (const phrase of ["devtools_professional_readiness", "handoff", "artifactCoverage", "objectiveBoundary"]) {
    if (!example.includes(phrase)) failures.push(`security-research-pack example missing professional field: ${phrase}`);
  }
}

let tracked = [];
try {
  tracked = git(["ls-files"]).split(/\r?\n/).filter(Boolean).map((path) => path.replace(/\\/g, "/"));
} catch (error) {
  warnings.push(`could not inspect git tracked files: ${error.message}`);
}

for (const path of tracked) {
  for (const prefix of forbiddenTrackedPrefixes) {
    if (path.startsWith(prefix)) failures.push(`forbidden private/generated path is tracked: ${path}`);
  }
  if (/\.(har|tgz|zip)$/i.test(path)) warnings.push(`archive/evidence-like file is tracked, verify it is intentional: ${path}`);
}

const internalWording = tracked.filter((path) => /\.(md|json|mjs|ts)$/i.test(path)).flatMap((path) => {
  if (!existsSync(path)) return [];
  const text = readText(path);
  if (!/OpenClaw/i.test(text)) return [];
  if (/compat|adapter|shim|openclaw\.plugin|without OpenClaw|OpenClaw-compatible|OpenClaw config|createMockOpenClawApi|plugin SDK|OPENCLAW_CONFIG_PATH|OPENCLAW_GATEWAY_TOKEN/i.test(text)) return [];
  if (path.startsWith("src/openclaw-shim/") || path.includes("/openclaw.plugin.json")) return [];
  return [path];
});
if (internalWording.length) {
  warnings.push(`OpenClaw wording outside clear compatibility context: ${internalWording.join(", ")}`);
}

if (failures.length) {
  console.error("Open-source readiness failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  if (warnings.length) {
    console.error("Warnings:");
    for (const warning of warnings) console.error(`- ${warning}`);
  }
  process.exit(1);
}

console.log("Open-source readiness passed");
console.log(`- required files: ${requiredFiles.length}`);
console.log(`- required scripts: ${requiredPackageScripts.length}`);
console.log(`- tracked files checked: ${tracked.length}`);
if (warnings.length) {
  console.log("Warnings:");
  for (const warning of warnings) console.log(`- ${warning}`);
}
