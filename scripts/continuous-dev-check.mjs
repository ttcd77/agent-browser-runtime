import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function run(command, args = []) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    return String(error?.stdout || error?.stderr || error?.message || error).trim();
  }
}

function read(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function section(text, title) {
  const pattern = new RegExp(`^## ${title}\\s*$([\\s\\S]*?)(?=^## |\\z)`, "m");
  return text.match(pattern)?.[1]?.trim() || "";
}

const root = process.cwd();
const status = run("git", ["status", "--short"]);
const log = run("git", ["log", "--oneline", "-5"]);
const planPath = join(root, "docs", "development-plan.zh.md");
const roadmapPath = join(root, "docs", "roadmap.md");
const releasePath = join(root, "docs", "open-source-release-checklist.md");
const packagePath = join(root, "package.json");

const plan = read(planPath);
const roadmap = read(roadmapPath);
const releaseChecklist = read(releasePath);
const pkg = JSON.parse(read(packagePath) || "{}");

const scripts = pkg.scripts || {};
const requiredScripts = ["check", "contract:devtools", "smoke:f12", "smoke:professional", "check:professional", "check:full"];
const missingScripts = requiredScripts.filter((name) => !scripts[name]);
const currentPlan = section(plan, "分阶段计划");
const executionRecord = section(plan, "执行记录");

const nextSuggestions = [
  "如果工作区不干净，先判断是否都是本轮改动；不要覆盖用户改动。",
  "如果 contract:devtools 不一致，先恢复 Personal / Managed 工具合同一致。",
  "如果 smoke 失败，先修复失败的真实浏览器行为。",
  "如果验证全绿，按 docs/development-plan.zh.md 进入 Phase 2 的 HAR/body/timing 完整度增强。",
];

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  repo: root,
  git: {
    clean: status.length === 0,
    status: status || "(clean)",
    recentCommits: log.split(/\r?\n/).filter(Boolean),
  },
  scripts: {
    missing: missingScripts,
    recommendedQuick: ["npm run check", "npm run contract:devtools"],
    recommendedFull: ["npm run check:professional"],
  },
  docs: {
    hasPlan: Boolean(plan),
    hasRoadmap: Boolean(roadmap),
    hasReleaseChecklist: Boolean(releaseChecklist),
    currentPlanPreview: currentPlan.split(/\r?\n/).slice(0, 18),
    latestExecutionPreview: executionRecord.split(/\r?\n/).slice(-18),
  },
  nextSuggestions,
}, null, 2));
