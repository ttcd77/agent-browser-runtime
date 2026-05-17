# 连续开发工作流

这个文件定义 Agent Browser Runtime 的连续开发办法。目标是让每一轮开发都能从同一个入口继续，而不是依赖某个 session 的记忆。

## 核心循环

每一轮都按下面顺序执行:

1. 读状态
   - `git status --short`
   - `git log --oneline -5`
   - `docs/development-plan.zh.md`
   - `docs/roadmap.md`
   - `docs/open-source-release-checklist.md`

2. 选下一项
   - 优先执行 `docs/development-plan.zh.md` 里当前 Phase 的下一项。
   - 如果当前 Phase 已完成，进入下一 Phase。
   - 如果发现测试失败，先修测试或实现问题，不继续加功能。

3. 小步开发
   - 每轮只解决一个清晰能力点。
   - 新增工具必须同时补 Managed Browser 和 Personal Chrome，或者明确返回 `notApplicable`。
   - 工具返回客观证据，不做漏洞判断。

4. 验证
   - 快速验证: `npm run check`
   - 合同验证: `npm run contract:devtools`
   - F12 验证: `npm run smoke:f12`
   - Personal Chrome 验证: `npm run smoke:personal`
   - 完整验证: `npm run check:full`

5. 写记录
   - 修改对应 docs。
   - 如果完成了计划项，更新 `docs/development-plan.zh.md` 的执行记录。
   - 提交 commit，保持每个 commit 主题单一。

## 连续开发命令

开工前:

```bash
npm run dev:loop-check
```

快速本地检查:

```bash
npm run check
npm run contract:devtools
```

完整验收:

```bash
npm run check:full
```

## 选择下一项的规则

优先级:

1. 修复失败测试或合同不一致。
2. 补当前 Phase 的验收缺口。
3. 补 F12 证据完整性缺口。
4. 优化开源发布体验。
5. 做 UI/产品壳。

当前下一层建议:

1. HAR/body/timing 完整度增强。
2. Source map 原始文件导航和 debugger scope 深挖。
3. Performance trace 的 layout/paint/frame 分组。
4. Application panel 的 CHIPS / partitioned cookie / storage bucket fixture。
5. MCP adapter 完整化。

## 不做什么

- 不把 `risk summary` 放回核心工具层。
- 不让工具替 Agent 或人判断漏洞。
- 不把 80+ 个底层工具作为默认入口。
- 不把私人 Chrome 证据、真实目标数据、账号截图提交到仓库。

