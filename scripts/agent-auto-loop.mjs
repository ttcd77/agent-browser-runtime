import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);

function argValue(name, fallback = null) {
  const index = args.indexOf(name);
  if (index >= 0 && index + 1 < args.length) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  return fallback;
}

function hasFlag(name) {
  return args.includes(name);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: process.platform === "win32",
    ...options,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function readOptional(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

const once = hasFlag("--once");
const dryRun = hasFlag("--dry-run");
const agent = argValue("--agent", "codex");
const intervalMinutes = Number(argValue("--interval-minutes", "45"));
const maxIterations = Number(argValue("--max-iterations", once ? "1" : "3"));
const task = argValue("--task", "按 docs/development-plan.zh.md 和 docs/continuous-development.zh.md 继续下一项开发。当前优先进入 Phase 2: HAR/body/timing 完整度增强。每轮只做一个小能力点，跑验证并提交。");
const logDir = join(process.cwd(), "logs", "agent-auto-loop");
mkdirSync(logDir, { recursive: true });

const basePrompt = `
你是 Agent Browser Runtime 的连续开发 agent。

工作目录: ${process.cwd()}

任务:
${task}

必须遵守:
1. 先运行 npm run dev:loop-check。
2. 读取 docs/development-plan.zh.md、docs/continuous-development.zh.md、docs/roadmap.md。
3. 每轮只做一个 bounded engineering task。
4. 工具层只返回客观证据，不做漏洞判断，不恢复 risk summary。
5. Personal Chrome 和 Managed Browser 的 devtools_* 合同必须保持一致；如果一个后端不支持，返回结构化 notApplicable。
6. 修改后运行 npm run check:professional；如果改动触及 Personal Chrome，再额外运行 npm run smoke:personal 或 npm run check:full。
7. 如果验证通过，更新相关 docs 并 git commit。
8. 如果验证失败，修复；如果无法修复，写清楚失败原因，不要强行提交。
9. 不提交 runtime、logs、私人浏览器数据、真实目标证据。

当前计划书:
${readOptional(join(process.cwd(), "docs", "development-plan.zh.md")).slice(0, 12000)}
`;

function runAgentOnce(iteration) {
  const startedAt = new Date().toISOString();
  const name = `${timestamp()}-iteration-${iteration}`;
  const logPath = join(logDir, `${name}.log`);
  const promptPath = join(logDir, `${name}.prompt.md`);
  writeFileSync(promptPath, basePrompt, "utf8");

  if (dryRun) {
    const message = [
      `startedAt=${startedAt}`,
      `agent=${agent}`,
      "Dry run only. No CLI agent was invoked.",
      `promptPath=${promptPath}`,
    ].join("\n");
    writeFileSync(logPath, message, "utf8");
    return { ok: true, dryRun: true, skipped: false, logPath, promptPath };
  }

  const cleanCheck = run("git", ["status", "--short"]);
  if (cleanCheck.stdout.trim()) {
    const message = [
      `startedAt=${startedAt}`,
      "Skipped because git worktree is not clean.",
      cleanCheck.stdout,
    ].join("\n");
    writeFileSync(logPath, message, "utf8");
    return { ok: false, skipped: true, logPath, promptPath };
  }

  const commandArgs = agent === "claude"
    ? ["--print", "--permission-mode", "auto", basePrompt]
    : ["exec", "--cd", process.cwd(), "--sandbox", "danger-full-access", "--ask-for-approval", "never", basePrompt];

  const result = run(agent, commandArgs, { timeout: 1000 * 60 * 60 * 2 });
  const endedAt = new Date().toISOString();
  const log = [
    `startedAt=${startedAt}`,
    `endedAt=${endedAt}`,
    `agent=${agent}`,
    `status=${result.status}`,
    "",
    "STDOUT:",
    result.stdout,
    "",
    "STDERR:",
    result.stderr,
  ].join("\n");
  writeFileSync(logPath, log, "utf8");
  return { ok: result.status === 0, skipped: false, logPath, promptPath };
}

const summary = [];
for (let i = 1; i <= maxIterations; i += 1) {
  const result = runAgentOnce(i);
  summary.push(result);
  console.log(JSON.stringify({ iteration: i, ...result }, null, 2));
  if (once || i === maxIterations) break;
  await sleep(Math.max(1, intervalMinutes) * 60 * 1000);
}

const summaryPath = join(logDir, `${timestamp()}-summary.json`);
writeFileSync(summaryPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), agent, dryRun, task, summary }, null, 2)}\n`, "utf8");
console.log(`summary=${summaryPath}`);
