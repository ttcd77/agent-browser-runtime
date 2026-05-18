# Agent 自动开发 Loop

这个文件说明如何让外部 CLI agent 定时“醒来”继续开发。

## 重要边界

当前聊天里的 Codex 不能自己醒来。能做到的是:

1. 本地启动一个 loop runner。
2. loop runner 定时调用 `codex exec` 或 `claude --print`。
3. CLI agent 按固定 prompt 读计划、选下一项、开发、验证、提交。
4. 结果写入 `logs/agent-auto-loop/`。

这不是同一个聊天 session 自己醒来，而是外部进程重新调用一个 agent。

## 安全规则

- 每轮只做一个 bounded task。
- 工作区不干净时，不自动覆盖已有改动。
- 默认每轮必须跑 `npm run check:professional`。
- 如果改动触及 Personal Chrome 或发布前完整回归，再跑 `npm run check:full`。
- 默认要求 agent 提交自己的改动。
- 每轮结束后退出；如果是 loop 模式，则等待下一个 interval。
- 不提交 `runtime/`、真实证据、私人 Chrome 数据。

## 命令

只跑一轮:

```bash
npm run agent:auto-once
```

只测试 loop，不调用 CLI agent:

```bash
npm run agent:auto-dry-run
```

连续跑，默认每 45 分钟一轮，最多 3 轮:

```bash
npm run agent:auto-loop
```

指定任务:

```bash
node scripts/agent-auto-loop.mjs --once --task "Implement Phase 2 HAR/body/timing completeness improvements."
```

## 当前默认任务

如果没有传 `--task`，默认任务是:

> 按 `docs/development-plan.zh.md` 和 `docs/continuous-development.zh.md` 继续下一项开发。当前优先进入 Phase 2: HAR/body/timing 完整度增强。每轮只做一个小能力点，跑验证并提交。

## 什么时候用

适合:

- 你睡觉或离开电脑时，让本地 agent 继续推进小步开发。
- 让另一个 Codex/Claude session 根据同一套计划继续工作。

不适合:

- 没有明确计划时长时间无限开发。
- 私人浏览器里有敏感页面还要跑 Personal Chrome smoke。
- 需要人工产品判断或 UI 审美判断的任务。
