# 轻量审查报告：agent-browser-runtime

**审查日期**：2026-05-19  
**审查范围**：README.md、package.json、docs/roadmap.md、docs/project-overview.md  
**目标**：评估项目成熟度，提出下一步任务和优先级，不涉及源码级分析。

---

## 1. 项目定位

Agent Browser Runtime 是一个**面向 AI Agent 的本地 DevTools 证据运行时**。它给 AI agent 提供一套浏览器操作工具，核心特点：

- **facade-first 架构**：agent 用 `browser_open` / `browser_act` / `browser_inspect` / `browser_security_pack`，不需要关心 CDP target id、tab id、端口。
- **双层工具面**：上层 `browser_*` facade 对 agent 友好，下层 `devtools_*` 对应精确的 F12 面板钻取。
- **证据驱动**：核心目标是收集客观浏览器证据，**不判断漏洞**（不是扫描器）。
- **双后端**：Managed Browser（主推，Professional AppSec 工作流）和 Personal Chrome（Beta，通过 Extension Bridge）。
- **多 profile 隔离**：每个 profile 拥有独立标签页、证据目录、流量日志、截图。

---

## 2. 成熟度评估

### 代码与构建

| 维度 | 状态 |
|---|---|
| 版本号 | `0.1.0` (early stage, 合理) |
| 构建系统 | TypeScript + tsc + vitest，基本配置完整 |
| 依赖 | 轻量：`chrome-remote-interface`、`ws`、`zod`、vitest — 无臃肿 |
| 脚本体系 | 健全：build、test、多种 smoke、contract check、scorecard |
| Node 要求 | `>=20` |

### 文档

| 维度 | 状态 |
|---|---|
| README | 详细、结构清晰、工具表和 env 变量齐全。但篇幅偏长，新用户可能迷失 |
| Roadmap | 版本 0.1–0.6 路线清晰，阶段性目标明确 |
| Project Overview | 定位精准，问题-方案-当前成熟度都有覆盖 |
| 缺失 | 无 CONTRIBUTING.md、无 CHANGELOG.md、快速入门缺少简短版 |

### 测试与质量保障

| 维度 | 状态 |
|---|---|
| 单元测试 | 有（schema + lease-store）— 但覆盖范围明显不足（仅 2 个测试文件） |
| Smoke 测试 | 丰富：product、browser、server、F12、professional、CLI、example |
| Contract 检查 | 有 `contract:devtools` |
| Professional 门禁 | 有 `check:professional` + `professional:scorecard`，体系完整 |
| 开源就绪门禁 | 有 `release:readiness` |

### 架构层面

| 维度 | 状态 |
|---|---|
| 分层设计 | 优秀：facade → unified API → backend-specific — 是产品级抽象 |
| 安全边界 | 明确：不提漏洞严重性、无自动扫描逻辑 |
| 扩展性 | 通过 profile 抽象支持多身份、多目标场景 |

---

## 3. 发现的问题 / 风险

1. **单元测试覆盖率过低** — 只测了 2 个测试文件（schemas、lease-store），大量核心逻辑（agent server, devtools 工具实现, CDP 通信, 证据打包）无单元测试覆盖。
2. **README 篇幅过长** — 技术细节（完整工具列表、env 表、curl 示例）可以拆入独立文档，README 应保留为快速入口。
3. **CI/CD 已补齐** — Hermes 审查时看到的是旧状态；Codex 已在同日补上 GitHub Actions，并修复 Linux runner 上 Rolldown native binding 的 CI 失败。
4. **Personal Chrome 模式标记为 beta** — 但 roadmap 未明确 0.2 之前的迭代计划。目前双后端共存可能增加维护成本。
5. **roadmap 0.2 (F12 Parity) 目标巨大** — Network / Application / Elements / Sources / Security / Performance 全覆盖，但团队和版本号 (0.2) 的体量可能不匹配。需考虑拆分。

---

## 4. 三个下一步任务

### 任务 A：补单元测试（高优先级）

**目标**：将核心模块（agent-server、devtools 工具函数、capture 引擎、profile 管理）的单元测试覆盖提升到合理水平。

**理由**：当前仅 2 个 test file，smoke 测试虽多但无法精确定位回归。SMOKE 通过、单元测试失败的情况时有发生。

**验收命令**：

```bash
npm run test            # 现有单元测试
npm run test:coverage   # 或 vitest --coverage
```

### 任务 B：建立 CI 自动门禁（已完成）

**目标**：配置 GitHub Actions（或目标 CI），每次 push/PR 自动运行基础检查。

**状态**：已完成基础 CI。当前 public repo 每次 push/PR 会运行 release readiness、build、unit tests 和 CLI smoke。`check:professional` 仍保留为本地专业门禁，因为它会启动真实浏览器 smoke，更适合作为本机 release gate。

**验收命令**：

```bash
# 在 CI workflow 中
npm run release:readiness
npm run check
# 期望：exit code 0
```

### 任务 C：重构 README + 补充贡献文档（中优先级）

**目标**：
- 将 README 的完整工具列表移入 `docs/devtools-api.md` 或 `docs/agent-tools.md`。
- 在 README 顶部保留 30 秒快速入门。
- 补充 `CONTRIBUTING.md`（开发环境、PR 流程、代码规范）。

**理由**：开源前需要降低贡献门槛。

---

## 5. 推荐优先级

```
Priority  High:  Task A (单元测试)
Done      Task B (CI 门禁)
Priority  Med:   Task C (文档重构)
```

**说明**：

1. 先补单元测试和 CI：这是开源项目**最基本信用凭证**。没有 CI + 不足的单元测试会让外部贡献者不敢动手。
2. 再改文档：降低贡献门槛，让更多人能参与。
3. 其他（Personal Chrome 稳定性、roadmap F12 Parity 推进）应在上述基础打牢后再跟进。

---

## 6. 快速验收全家桶

```bash
# 完整构建
npm run build

# 单元测试 + 覆盖率
npm run test

# 开源就绪检查
npm run release:readiness

# 专业门禁（包含 build + test + smoke 全链路）
npm run check:professional

# 分数卡（打印 DevTools 成熟度分数）
npm run professional:scorecard
```

---

*本报告由 Hermes Agent 于 2026-05-19 自动生成，基于 README.md / package.json / docs/roadmap.md / docs/project-overview.md 的轻量审查。不涉及源码分析。*
