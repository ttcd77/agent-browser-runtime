# Agent Browser Runtime 开发计划书

更新日期: 2026-05-17

## 目标

这个项目的目标不是做一个普通浏览器自动化工具，而是做一个面向 Agent 的 F12 / DevTools 证据运行时:

- Agent 能像安全研究员一样查看网页、Network、Console、Storage、Sources、Performance、Memory 等证据。
- Personal Chrome 和 Managed Browser 使用同一套 `browser_*` / `devtools_*` 合同。
- 工具只提供客观证据，不内置漏洞判断，不替 Agent 或人类下结论。
- 证据要能保存、复现、比较、钻取，适合作为开源作品集和安全岗位申请材料。

## 已经学到的东西

1. 市场上已经有很多浏览器 Agent 和 DevTools MCP 项目。
   Chrome DevTools MCP、OpenChrome、Browserbase Stagehand、Browserbase Skills、YetiBrowser、Nanobrowser 等都证明这个方向真实存在。

2. 差异化不能靠“工具更多”。
   88 个工具如果直接暴露给 Agent，会增加选择成本。正确结构应该是:
   `browser_*` 作为小入口，`devtools_*` 作为 F12 细节层，`devtools_cdp_command` 作为逃生口。

3. F12 对齐的合理标准是“人类打开 F12 能看到和操作的普通网页证据，Agent 也应该能通过工具拿到”。
   不是要求拿到 Chrome 内部页面或没有提前录制的历史请求。没有 capture 的东西，人类也看不到，工具不应该承诺不可能的能力。

4. Personal Chrome 和 Managed Browser 是两种后端，不是两套产品。
   用户心智应该是:
   - Personal Profile: 接管用户真实 Chrome。
   - Agent Browser: 给 Agent 启动独立浏览器/profile。
   但 Agent 调用的工具合同应该尽量一致。

5. 风险判断必须从工具层移出去。
   工具可以说“这个请求失败了”“这个 cookie 没有 HttpOnly”“这个 frame 访问不到”，但不能说“这是漏洞”。漏洞判断留给 Agent 或人。

6. 竞品里最值得吸收的不是 UI，而是工程纪律:
   - capability map / tool catalog / doctor 检查。
   - trace/capture 后的证据分桶。
   - 大文件返回路径和 manifest，而不是塞进上下文。
   - 可重复 smoke test 和 contract test。

## 当前状态

已经完成:

- Managed Browser CDP 后端。
- Personal Chrome extension + bridge 后端。
- 统一 `devtools_*` 合同，当前两边工具数量对齐。
- Network、Console、Storage、Sources、Performance、Memory、Security、DOM、Accessibility、Frame、Service Worker 等主要 F12 证据面。
- HAR、request replay、batch replay、WebSocket/SSE、source map、heap snapshot、trace、coverage、evidence bundle、auth boundary、correlation graph。
- `devtools_capture_bisect`: 把已录制证据拆成 Network、Page/Frame、Realtime bucket。
- `npm run contract:devtools`、`npm run smoke:f12`、`npm run smoke:personal`、`npm run check` 均已通过。

## 开发原则

1. 先客观证据，后高级分析。
2. 先能力地图，后继续加低层工具。
3. 先保证 Personal / Managed 合同一致，再考虑单后端增强。
4. 所有新增能力必须有 smoke 或 contract 验证。
5. 文档必须能解释“Agent 应该怎么用”，而不是只列 API 名。

## 分阶段计划

### Phase 1: 工具可用性和能力地图

目标: 让 Agent 不需要面对 88 个平铺工具。

开发项:

- 新增 `devtools_capability_map`。
- 按 DevTools 面板和任务场景分组工具: orientation、page-control、network、application、dom-frame、sources-debugger、performance、evidence-workflow、raw-cdp。
- 标记每组 first-pass 工具、drill-down 工具、artifact 工具、raw escape hatch。
- Managed / Personal 都返回同样结构。
- contract / smoke 验证 capability map 存在并能解释主要面板。

验收:

- `devtools_capability_map` 在 Managed / Personal 都可调用。
- `npm run contract:devtools` 工具数量继续对齐。
- smoke 检查 Network、Sources、Performance、Evidence 至少四组存在。

### Phase 2: F12 证据完整性缺口

目标: 补齐还不够成熟的 F12 能力。

开发项:

- HAR 导出继续接近 DevTools: 更完整 timing、body handle、redirect/body 证据。
- Sources/Debugger: breakpoint 管理、paused scope 深挖、source map 原始文件导航。
- Performance: trace event 到 frame/layout/paint 的更好分组，不做性能风险判断，只做证据整理。
- Application: CHIPS / partitioned cookie、quota/storage bucket、Cache/IndexedDB drill-down。
- Replay: 更明确 forbidden header、browser fetch replay 与 raw socket-level replay 边界。

验收:

- 每个缺口都有单独 smoke 或 fixture。
- 所有返回值带 `boundaries` 或 `completeness`。

### Phase 3: 证据包和开源展示

目标: 让项目成为可公开展示的安全工程作品。

开发项:

- 一键 demo: example.com / 本地 fixture 生成证据包。
- Release checklist 自动检查。
- README 的 quickstart 降低门槛。
- MCP adapter 完整化。
- 清理 OpenClaw 相关措辞，只保留 compatibility 说明。

验收:

- 新用户按 README 能跑 Managed demo。
- 不需要私人 Chrome 数据即可展示核心能力。
- `docs/open-source-release-checklist.md` 所有 must-have 通过。

### Phase 4: 产品化外壳

目标: 让非底层用户能理解 Personal Profile / Agent Browser / Profile / Capture。

开发项:

- 本地 UI 只做人类可理解的 profile、capture、artifact、tool map。
- 隐藏 UUID、target id、tab id 等底层细节。
- 支持 profile 命名、证据目录查看、capture 状态查看。

验收:

- UI 不替代 Agent API，只作为可视化控制台。
- 人类能看懂当前谁在控制哪个浏览器、正在录什么、证据存在哪里。

## 现在开始执行

已开始执行 Phase 1: `devtools_capability_map`。

原因:

- 当前底层工具已经很多，再继续加工具会降低 Agent 可用性。
- capability map 能吸收竞品的优点，又保持我们“小 facade + 深 F12 层”的产品结构。
- 它是后续开源展示和 Agent 自动选择工具的基础。

## 执行记录

### 2026-05-17: Phase 1 第一段完成

已经完成:

- Managed Browser 新增 `devtools_capability_map`。
- Personal Chrome 新增 `devtools_capability_map` 和 `personal_chrome_capability_map`。
- capability map 按 F12 面板/任务组返回:
  - facade tools
  - panel category
  - first-pass tools
  - drill-down tools
  - artifact tools
  - raw CDP escape hatch
- smoke 验证 Network、Sources、Performance 等核心 panel 存在。
- contract 验证 Personal / Managed 工具数继续对齐。

验证结果:

- `npm run build`: 通过。
- `npm run contract:devtools`: Managed 89 / Personal 89。
- `npm run smoke:f12`: 通过。
- `npm run smoke:personal`: 通过。
- `npm run check`: 通过。
