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

连续开发入口见 `docs/continuous-development.zh.md`。每轮开工前先跑 `npm run dev:loop-check`，收工前优先跑 `npm run check:professional`；触及 Personal Chrome 或发布前再跑 `npm run check:full`。

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

- HAR 导出继续接近 DevTools: 更完整 timing、body handle、redirect/body 证据。第一步先落地 `devtools_har_completeness`，让 Agent 知道当前 HAR 证据完整到什么程度。
- Network: request detail 已补 initiator source context，在 Chrome 暴露脚本 frame 时直接返回发起请求附近源码行；request table / timing table 已补 URL、host、method、status 区间、resource type、redirect、cache、body visibility、header、排序等筛选。
- Sources/Debugger: source map 原始文件导航已补 `devtools_source_map_source_get`；breakpoint probe 已并入 `devtools_debugger_control action=probeBreakpointByUrl`；paused scope 表达式求值已补 `evaluateExpressions`。
- Performance: trace event 已补 `renderingTimeline` 和 `layoutPaintFlameChart`，按 loading/scripting/rendering/painting/screenshot 做时间线分组，并把 layout/paint 事件按同线程嵌套深度整理成 Agent 可读 flame chart 摘要；不做性能风险判断，只做证据整理。
- Application: storage boundary 已补 quota usage breakdown、Storage Buckets support/bucket summary、cookie partition metadata；IndexedDB database/object-store/index/count list、CacheStorage cache/entry metadata list 和具体读取工具已覆盖 Managed/Personal smoke；本地分区 cookie 写入 fixture 已覆盖 Managed/Personal，并记录 document-visible cookie names 与后端 cookie metadata 的可见性差异。
- Elements/Frames: `devtools_frame_tree` 已补 iframe access + open shadow root boundary summary，并在 Managed/Personal smoke 中验证。closed shadow root 和跨源/沙箱 frame 内部不可见时作为浏览器边界返回。
- Network Redirect: redirect chain 已在 Managed/Personal fixture 中真实 302 验证；`devtools_network_summary` 暴露 redirect row，`devtools_request_detail` 暴露链条细节。
- Replay: `devtools_request_replay` / `devtools_request_replay_batch` 已返回 `replayBoundary`，明确 forbidden header、browser fetch replay 与 raw socket-level replay 边界。

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

### 2026-05-18: Tool Catalog Agent Entry Points

已经完成:

- `devtools_tool_catalog` / `personal_chrome_tool_catalog` 新增 `agentEntryPoints`。
- Agent 现在不用先扫描 100 个工具；catalog 会直接给出 facade-first 入口、professional path、drilldown rule 和压缩后的 orient / operate / inspect / package / drilldown / escape-hatch 分组。
- Managed Browser 和 Personal Chrome 返回同一结构；低层 `devtools_*` 仍保留为 drilldown 和 raw CDP escape hatch。
- smoke 已验证 catalog 暴露 `facade-first` 和 `browser_security_pack` 专业路径。
- 这仍然只是工具路由元数据，不判断漏洞或安全影响。

### 2026-05-18: Research Pack Agent Handoff Route

已经完成:

- `devtools_security_research_pack` / `browser_security_pack` 现在把 `agentEntryPoints` 和 `toolCatalogSummary` 写入返回值和 handoff JSON。
- 下一个 Agent 打开 evidence pack 时，不需要重新扫描完整工具列表；可以直接沿用 facade-first、professional path、drilldown rule 和 escape hatch 边界。
- Managed Browser 和 Personal Chrome 都返回同一交接结构。
- smoke 已验证 pack 和 handoff 文件包含 agent entry points。
- 这只是交接路线和工具可用性快照，不判断漏洞或安全影响。

### 2026-05-18: CLI Agent Entry Route

已经完成:

- `npm run research:pack` 的人类/Agent 可读摘要现在会打印 `agent entry mode`、推荐 first call、professional facade path 和 drilldown rule。
- `smoke:cli` 已覆盖这段输出，保证 CLI 不会只生成 JSON 而丢失可执行交接路线。
- README 已同步说明 CLI 会展示 agent entry route。
- 这仍然只是工具路线展示，不解释证据含义。

### 2026-05-18: Research Pack Handoff Inspect

已经完成:

- `devtools_artifact_inspect` / `personal_chrome_artifact_inspect` 现在识别 `security-research-pack-handoff` JSON。
- 当读取 research pack handoff 时，工具会返回 `researchPackHandoff` 摘要: ready、handoff/artifact coverage 缺失项、agent entry mode、recommended first call、professional path、drilldown rule、首批 drilldown 和 artifact paths。
- Agent 可以用已有 artifact inspect 工具验证交接文件是否可读、是否包含可执行路线，而不需要加载完整 JSON 到上下文。
- Managed Browser 和 Personal Chrome smoke 都已覆盖。
- 这只是 handoff 结构检查和路线提取，不判断漏洞或安全影响。

### 2026-05-18: Professional Readiness Tool

已经完成:

- 新增 `devtools_professional_readiness` / `personal_chrome_professional_readiness`。
- Agent 可以一眼确认专业 F12 工作流、facade 工具、F12 parity matrix、capture status、artifact index、evidence timeline 是否机械可用。
- 返回 `nextActions`，例如先开启 `browser_capture` 或生成 `browser_security_pack`。
- readiness 只报告工作流和证据可用性，不判断漏洞或安全影响。
- Managed Browser 和 Personal Chrome 合同保持一致，当前 `devtools_*` 合同为 100 / 100。
- `npm run research:pack` CLI 已接入 readiness，生成证据包后会额外打印 professional readiness、evidence readiness、missing 和下一步工具。
- `devtools_workflow_guide task=professional-appsec` 和 `browser_inspect` 返回的 `professionalWorkflow` 现在都会显式暴露 `devtools_professional_readiness`，让 Agent 可以在开始和生成证据包后都做机械 readiness 检查。
- `examples/security-research-pack.mjs` 已升级为专业示例，输出前后 readiness、handoff、artifact coverage 和首批 drilldown routes。
- 新增 `npm run smoke:example`，自动启动 Managed Browser 和本地 fixture，真实运行 `examples/security-research-pack.mjs` 并验证 readiness、handoff、artifact coverage 和 drilldown 输出。
- `npm run check:professional` 已纳入 `smoke:example`，专业门禁现在会真实运行公开示例，避免示例和主线能力漂移。

### 2026-05-18: F12 Parity Matrix

已经完成:

- 新增 `devtools_f12_parity_matrix` / `personal_chrome_f12_parity_matrix`。
- 把专业 AppSec 工具的衡量标准落成机器可读矩阵: Network、Elements/Frames、Application、Sources/Debugger、Console/Issues/Security、Performance/Memory、Evidence Workflow、Raw CDP、DevTools UI Extras。
- 每一行返回 Managed / Personal 支持状态、对应工具、浏览器边界和“不判断漏洞”的客观边界。
- Managed Browser 被明确标记为主线后端；Personal Chrome 保持同合同，遇到 chrome.debugger 不支持的能力返回 partial / notApplicable 边界。

### 2026-05-18: Professional AppSec Fixture Smoke

已经完成:

- 新增 `npm run smoke:professional`。
- 这个 smoke 启动本地授权 fixture，覆盖 redirect、cookie/storage、same-origin iframe、open shadow root、service worker/cache、source map、Application export、evidence pack、correlation graph、worker/frame report 和 F12 parity matrix。
- 目标不是判断漏洞，而是证明 Managed Browser 主线可以把一组真实 AppSec 研究常见证据串成完整、可保存、可 drilldown 的工作流。

### 2026-05-18: Security Research Pack Drilldown Index

已经完成:

- `devtools_security_research_pack` / `browser_security_pack` 现在直接返回 artifact index、evidence timeline 和 F12 parity snapshot。
- `summary` 增加 `artifactFileCount`、`evidenceTimelineEventCount`、`f12ParityPanelCount`，方便 Agent 先判断证据包是否完整，再选择下一步 drilldown。
- Managed Browser 和 Personal Chrome 都保持同合同；Personal 不支持的底层能力仍然通过 parity / notApplicable 边界表达。
- 研究包现在还会保存一个 `research-packs/*-security-research-pack.json` handoff 文件，汇总客观摘要、artifact 路径、drilldown plan 和边界说明，方便跨 session 或跨 Agent 交接。

### 2026-05-18: Research Pack Drilldown Plan

已经完成:

- `devtools_security_research_pack` / `browser_security_pack` 新增 `drilldownPlan`。
- `drilldownPlan` 会从研究包里的 timeline、artifact index、requestId、HAR、trace、bundle 等客观证据生成下一步工具调用建议。
- `nextTools` 现在来自 drilldown plan，而不是固定字符串列表；这让 Agent 能从一次研究包直接进入 request detail、replay boundary、artifact inspect、trace query、artifact search 等后续动作。
- drilldown plan 现在会保存为独立 artifact，并写入 manifest；`summary.drilldownPlanPath` 可用于跨 session 交接。
- 这个 plan 只是确定性导航提示，不判断漏洞、不替代模型推理。

### 2026-05-18: Evidence Timeline Filters

已经完成:

- `devtools_evidence_timeline` / `personal_chrome_evidence_timeline` 增加 `eventType`、`source`、`query`、`since`、`until` 过滤。
- Agent 可以直接取“只看 artifact”“只看 Network”“只看包含某个 URL/path 的事件”等 bounded timeline。
- 过滤仍然只是事件导航和证据定位，不判断因果或漏洞。

### 2026-05-18: Evidence Timeline

已经完成:

- 新增 `devtools_evidence_timeline` / `personal_chrome_evidence_timeline`。
- Agent 可以把 Network request、Console/exception/log、Issues、WebSocket/SSE、以及本地 artifact mtime 统一排序成客观时间线。
- 每条 timeline item 附带下一步 drilldown 工具和输入，例如 `devtools_request_detail`、`devtools_realtime_log`、`devtools_artifact_read`。
- 这只是时间顺序导航，不判断因果、不判断漏洞。

### 2026-05-18: Artifact Read

已经完成:

- 新增 `devtools_artifact_read` / `personal_chrome_artifact_read`。
- Agent 可以按 byte range 或 line range 读取 HAR、trace、bundle、manifest 等本地证据文件的 bounded 片段。
- 这让证据 drilldown 形成 `index -> search -> read/inspect` 的闭环，仍然只返回客观文件片段，不判断安全含义。

### 2026-05-17: Artifact Search

已经完成:

- 新增 `devtools_artifact_search` / `personal_chrome_artifact_search`。
- Agent 可以在本地证据池中按 kind 和 literal query 搜索 HAR、JSON、trace、bundle 等文本型 artifact，返回 bounded match window 和后续 `devtools_artifact_inspect` 输入。
- 仍然只做客观字符串定位: 跳过超大或非文本文件，不判断匹配是否代表安全问题。

### 2026-05-17: Artifact Index

已经完成:

- 新增 `devtools_artifact_index` / `personal_chrome_artifact_index`。
- Agent 可以先列出当前证据池里的 HAR、trace、screenshot、Application export、bundle、manifest、graph 等 artifact，再选择具体文件调用 `devtools_artifact_inspect`。
- 这一步继续保持客观工具边界: 只暴露文件类型、大小、路径、mtime、hash 和 drilldown 输入，不判断安全含义。

### 2026-05-17: Artifact Drilldown

已经完成:

- 新增 `devtools_artifact_inspect` / `personal_chrome_artifact_inspect`。
- Agent 可以对 HAR、manifest、trace、bundle 等本地证据文件做 bounded 检查: 文件大小、哈希、文本预览、JSON/HAR 顶层结构、字面量匹配上下文。
- 这个工具只负责读证据和定位片段，不判断漏洞、不输出 risk 结论。

### 2026-05-17: HAR response body index

已经完成:

- `devtools_export_har` / `devtools_save_har` 返回 `bodyIndex` 和 `bodyIndexSummary`。
- 每条 body index 记录 requestId、URL、status、mime、bodyIncluded、bodySource、bodyBytes、bodyPath/truncation/unavailable/error 等客观字段。
- Managed Browser 记录 inline-captured/file-backed body 来源；Personal Chrome 记录 `chrome-debugger-getResponseBody` 来源。
- 这让 Agent 不必把大 body 全塞进上下文，也能知道哪些 body 有证据、证据来自哪里、是否截断。

### 2026-05-17: Global Search 深搜 Application 证据

已经完成:

- `devtools_global_search` 的 Application 搜索从轻量 storage metadata 扩展到 bounded Application export。
- Agent 现在可以直接搜索 IndexedDB record value 和 CacheStorage response body 中的文本，不需要先知道 database/store/cache URL。
- 搜索会返回 `application-export` 证据来源和本地 export path，仍然只是文本匹配，不判断安全含义。

### 2026-05-17: 请求关联图增强

已经完成:

- `devtools_request_correlation_graph` 增加 redirect chain 边和 initiator stack frame 节点。
- Managed Browser 与 Personal Chrome 都返回同一类客观图边: `redirects-to`、`redirect-next`、`initiates`、`has-call-frame`、`async-parent`。
- smoke 覆盖 redirect edge 和 initiator evidence，帮助 Agent 复刻 F12 Network Initiator/Redirect Chain 的分析入口。
- 这些边是 F12 metadata correlation，不是因果或漏洞判断。

### 2026-05-17: Application 存储列表工具

已经完成:

- 新增统一工具 `devtools_indexeddb_list` 和 `devtools_cache_storage_list`，Managed Browser 与 Personal Chrome 共用同一语义。
- IndexedDB list 返回 database、version、object store、keyPath、autoIncrement、index metadata 和可选 record count。
- CacheStorage list 返回 cache name、entry count、request URL/method/mode/credentials/destination/referrer、response status/type/header metadata；response body 仍由 `devtools_cache_entry_get` 按需读取。
- 这层只给 Agent 提供 F12 Application 面板证据，不判断安全风险。

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

### 2026-05-17: 连续开发机制建立

已经完成:

- 新增 `docs/continuous-development.zh.md`，固定每轮开发循环。
- 新增 `npm run dev:loop-check`，输出 repo 状态、计划状态、验证脚本状态和下一步建议。
- 新增 `npm run check:devtools` 和 `npm run check:full`，把完整验收命令固定下来。
- 后续新增 `npm run check:professional`，把 Managed/CDP 专业主线、F12 smoke、professional smoke 和 CLI handoff smoke 收束成默认专业门禁。

### 2026-05-17: 外部自动开发 Loop 建立

已经完成:

- 新增 `docs/agent-auto-loop.zh.md`，解释当前聊天不能自己醒来，以及如何用外部 CLI agent 定时继续开发。
- 新增 `scripts/agent-auto-loop.mjs`。
- 新增 `npm run agent:auto-once` 和 `npm run agent:auto-loop`。
- `logs/` 已加入 `.gitignore`，避免自动开发日志进入公开仓库。

### 2026-05-17: Phase 2 第一段完成

已经完成:

- 新增 `devtools_har_completeness`。
- Managed Browser 新增 `profile_har_completeness` 并通过统一 `devtools_*` 暴露。
- Personal Chrome 新增 `devtools_har_completeness` 和 `personal_chrome_har_completeness`。
- 报告 HAR 的客观完整度:
  - body readable / included / truncated / unavailable / errored
  - timing total time 和各 phase availability
  - redirect evidence
  - securityDetails evidence
- 工具只报告证据覆盖，不判断漏洞。

验证结果:

- `npm run build`: 通过。
- `npm run contract:devtools`: Managed 90 / Personal 90。
- `npm run smoke:f12`: 通过。
- `npm run smoke:personal`: 通过。
- `npm run check`: 通过。

### 2026-05-17: Phase 2 Sources/Debugger 断点探针完成

已经完成:

- `devtools_debugger_control` 新增 `action=probeBreakpointByUrl`。
- Managed Browser 和 Personal Chrome 都支持同一动作:
  - 设置临时 URL / URL regex 断点。
  - 可选择 `triggerExpression` 或 reload 触发。
  - 命中后返回 paused call frames、scope previews、hitBreakpoints。
  - 默认自动 resume，并在 `keepBreakpoint=true` 以外自动清理断点。
- 返回 `captureBoundaries`，只报告客观 debugger 状态，不判断漏洞。

验证结果:

- `npm run smoke:f12`: 通过，fixture 命中了 `agent-breakpoint-smoke.js` 的临时断点并采集 local scope marker。
- `npm run contract:devtools`: 通过，Managed / Personal 仍为 91 / 91。
- `npm run check`: 通过。
- Personal Chrome 断点探针用当前真实 Chrome 非破坏性单独调用验证通过。
- `npm run smoke:personal`: 当前失败在 `security_research_pack` 对真实 Gmail 页生成 bundle path，属于环境/页面依赖问题，不是本次断点探针失败；后续应把 Personal smoke 改成独立测试页以减少对用户当前标签页的依赖。

### 2026-05-17: Personal Chrome smoke 独立测试页完成

已经完成:

- `scripts/personal-chrome-smoke.mjs` 启动本地 HTTP fixture 页面。
- smoke 运行时通过 `browser_open` 打开新 tab，不再依赖用户当前真实网页。
- fixture 包含 script、cookie、localStorage、sessionStorage、fetch、same-origin iframe，覆盖 Personal Chrome 的主要 F12 证据面。
- Personal Chrome `browser_open` 改为使用扩展侧 `chrome.tabs.update/create`，不再依赖页面内 `location.assign`。

验证结果:

- `npm run smoke:personal`: 通过。

### 2026-05-17: Phase 2 paused scope 深挖完成

已经完成:

- `devtools_debugger_control` 新增 `evaluateExpressions` 参数。
- 暂停时可在 call frame 上执行表达式，并返回每个表达式的值、异常或错误。
- Managed Browser 使用 CDP `Debugger.evaluateOnCallFrame`。
- Personal Chrome 使用 `chrome.debugger` 调用同一 CDP 方法。
- 默认只在第一个 call frame 求值，可通过 `maxEvaluateFrames` / `maxEvaluateExpressions` 控制范围。
- 返回的是暂停作用域里的客观求值结果，不判断漏洞。

验证结果:

- `npm run smoke:f12`: 通过，fixture 暂停时读取 `agentDebuggerSmoke=42` 和表达式 `agentDebuggerSmoke + 1=43`。
- Personal Chrome 直接调用验证通过，真实 Chrome 暂停时读取 `agentPersonalDebuggerSmoke=77` 和表达式 `agentPersonalDebuggerSmoke + 1=78`。

### 2026-05-17: Phase 2 Performance trace 时间线分组完成

已经完成:

- `devtools_chrome_trace` 的 `traceSummary` 新增 `renderingTimeline`。
- 时间线按 Chrome trace 事件客观分组:
  - loading
  - scripting
  - rendering
  - painting
  - screenshot
- 每行返回事件名、phase、category、相对开始时间、持续时间、process/thread、frame/data 摘要。
- Managed Browser 和 Personal Chrome 共用同一 summary 形状。
- 该功能只整理 trace 证据，不判断性能根因或漏洞。

验证结果:

- `npm run smoke:f12`: 通过，确认 `renderingTimeline.rows` 和 `captureBoundaries` 存在。

### 2026-05-17: Phase 2 trace drilldown 上下文窗口完成

已经完成:

- `devtools_trace_query` / `personal_chrome_trace_query` 新增 `contextWindows`。
- 查询 trace event 时可返回同 thread 的前后邻近事件，帮助 Agent 像 F12 Performance 面板一样看局部上下文。
- 返回 `drilldown.contextWindowBasis` 和 `nextQueries`，说明上下文窗口是邻近事件证据，不是因果证明。

验证结果:

- `npm run smoke:f12`: 通过。
- `npm run smoke:personal`: 通过。
- `npm run check:release`: 通过。

### 2026-05-17: Phase 2 Network table 筛选完成

已经完成:

- `devtools_network_log` 和 `devtools_network_timeline` 在 Managed Browser / Personal Chrome 两边支持同一套客观筛选:
  - `url_contains`、`hostname`、`method`、`status`、`status_min`、`status_max`
  - `resource_type`、`mime_contains`
  - `failed`、`redirected`、`from_cache`、`from_service_worker`
  - `has_request_body`、`has_response_body`
  - `request_header`、`response_header`
  - `sort_by`、`sort_dir`
- 返回 `filtersApplied`，让证据记录保留“当时怎么缩小表格”的上下文。
- Managed / Personal smoke 都用真实 302 redirect fixture 验证筛选结果。
- 该能力只做 F12 Network 表格筛选，不判断请求是否有漏洞。

验证结果:

- `npm run check`: 通过。
- `npm run contract:devtools`: Managed 91 / Personal 91。
- `npm run smoke:f12`: 通过。
- `npm run smoke:personal`: 通过。

### 2026-05-17: Phase 2 layout/paint flame chart 摘要完成

已经完成:

- `devtools_chrome_trace` 的 `traceSummary` 新增 `layoutPaintFlameChart`。
- Managed Browser 和 Personal Chrome 共用同一返回形状:
  - layout/paint 事件列表
  - same-thread nesting depth
  - byPhase / byThread duration buckets
  - frame / nodeId / layerId / clip 等 Chrome trace 暴露的定位信息
- 返回 `captureBoundaries`，说明 depth 是同线程嵌套近似，不是因果判断。
- 该能力只把 Performance 面板里的 layout/paint 证据结构化，不判断性能根因或漏洞。

验证目标:

- `npm run smoke:f12`
- `npm run smoke:personal`
- `npm run check:release`
