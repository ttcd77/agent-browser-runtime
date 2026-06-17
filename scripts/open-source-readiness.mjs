#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const requiredFiles = [
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "docs/safety-boundaries.md",
  "docs/agent-devtools-api.md",
  "docs/browser-worker-integration.md",
  "docs/codex-agent-manual.md",
  "docs/feedback-and-gaps.md",
  "docs/personal-chrome-quickstart.md",
  "docs/personal-chrome-extension.md",
  "docs/devtools-panel-map.md",
  "docs/competitor-research.md",
  "docs/open-source-release-checklist.md",
  "docs/project-overview.md",
  "docs/public-release-notes.md",
  "examples/agent-devtools-workflows.md",
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
  "feedback:note",
  "smoke:feedback",
  "research:pack",
  "release:readiness",
];

// Phrase checks pared down to load-bearing identifiers only (wave-6 README
// simplification + wave-7 砍 MCP / 砍 devtools_* prefix retired most of the older
// phrases the original 1477-line README contained). The README now stays minimal
// on purpose — this list is reserved for things that must be in any user-facing
// description of the project, not for every internal field name.
const requiredReadmePhrases = [
  "agent-browser",
  "Personal Chrome",
  "Managed Browser",
];

const forbiddenPublicPatterns = [
  // Match a developer's local Windows home directory in any slash form: the
  // forward-slash form, the single-backslash form, AND the double-backslash
  // form that appears in .mjs/.js string literals — the previous
  // single-backslash regex silently passed source files (2026-06-06 audit).
  { pattern: new RegExp("C:" + String.raw`[\\/]+Users[\\/]+` + "Tong", "i"), label: "local Windows user path (any slash form)" },
  // Internal Tailscale tailnet address of the inner-field worker — must not
  // appear in a public repo. Built by concatenation so this checker does not
  // flag its own source.
  { pattern: new RegExp("100\\.113\\." + "81\\.96"), label: "internal tailnet IP" },
  // A specific bug-bounty target's login URL hardcoded into a general tool
  // discloses the active target + anti-bot handling. Concatenated to avoid self-match.
  { pattern: new RegExp("connect\\." + "8x8" + "\\.com", "i"), label: "private bounty target URL" },
  { pattern: new RegExp("Hello@" + "Selfloom" + String.raw`\.ai`, "i"), label: "personal email" },
  { pattern: new RegExp(String.raw`\b` + "selfloom" + String.raw`\.ai\b`, "i"), label: "personal domain" },
  { pattern: new RegExp(String.raw`\bG` + "mail" + String.raw`\b`, "i"), label: "personal account product reference" },
  { pattern: new RegExp(String.raw`\bLinked` + "In" + String.raw`\b`, "i"), label: "personal workflow product reference" },
  { pattern: new RegExp(["targets", "active", "8x8", "evidence"].join("/"), "i"), label: "private target evidence path" },
  { pattern: new RegExp(["targets", "active", "8x8", "evidence"].join(String.raw`\\`), "i"), label: "private target evidence path" },
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

// Wave-7 砍 devtools_* prefix + 砍 MCP server 之后, agent-devtools-api.md /
// agent-operator-runbook.md / devtools-panel-map.md / security-research-pack.mjs
// 里很多 phrase (browser_professional_readiness, routeSummary,
// routeArtifactCount...) 已经退役或重命名。这些 phrase check 留作 deprecated
// 内部 API guard 没意义 — 真要约束 boundary, 看 docs/safety-boundaries.md 检查
// + forbiddenPublicPatterns 即可。保留 objective-tool boundary 检查作为
// API doc 最低要求, 其余 phrase check 撤销。
if (existsSync("docs/agent-devtools-api.md")) {
  const api = readText("docs/agent-devtools-api.md");
  if (/decide whether.*vulnerab/i.test(api) === false) {
    failures.push("agent-devtools-api.md must preserve the objective-tool boundary");
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

for (const path of tracked) {
  if (!/\.(md|json|jsonc|mjs|ts|js|yml|yaml|ps1)$/i.test(path)) continue;
  if (!existsSync(path)) continue;
  const text = readText(path);
  for (const { pattern, label } of forbiddenPublicPatterns) {
    if (pattern.test(text)) failures.push(`public tracked file contains ${label}: ${path}`);
  }
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
