# ABR 反馈 / 已知缺陷(给修 ABR 的人)

> 外场用 ABR 打 target 时遇到的 **ABR 本身**缺陷/改进项写这里(append-only)。
> 落点判据:**任何场景都会撞的 ABR 缺陷** → 写这里;**某 target 特有的运行问题** → 写 helloworld 的 campaign ledger(`studio/state/<target>.campaign.json`),不写这。
> 每条格式:现象 + 复现/触发条件 + 影响 + 修复方向 + 来源。

## 待修

### input blocker — React 受控 input 写不进值
- **现象**:对 React 受控 input,所有输入路径返回 `ok:true` 但 `input.value` 仍空、submit 仍 disabled。
- **复现**:Bullish `simnext.bullish-test.com` 订单表单 `PlaceOrderForm-PriceInput` / `PlaceOrderForm-QuantityInput`。
- **试过全失败**:`personal_chrome_type` / `browser_act type` / CDP `Input.insertText` / `dispatchKeyEvent char` / `HTMLInputElement.prototype.value` setter+event / `execCommand insertText`。
- **影响**:任何 React 受控表单都可能写不进,agent 易误判成"target 拒绝"。
- **修复方向**:CDP `rawKeyDown/char/keyUp` 每字符输入在 simnext 订单表单已证明有效(见 TI-BULL-001),但 ABR 仍应提供可复用的 React-aware 输入原语,避免每个 target 临场拼 CDP 序列。
- **来源**:2026-06-27 Bullish;campaign `bullish-exchange` TI-BULL-001。

### activeBrowser 漂到用户日常 Chrome / 无关 tab
- **现象**:activeBrowser 绑定漂移到用户日常 Chrome(B 站 tab 等无关页面)。
- **影响**:① 操作打到错误浏览器;② password/snapshot 取证时把用户日常页面的输入值带出 → **泄露风险**。
- **修复方向**:稳定 activeBrowser 绑定(显式锁定,不隐式漂移)+ snapshot 对 password 字段 redaction。
- **来源**:2026-06-28 Codex(Luno campaign)。

### secret-like 页面缺 redaction
- **现象**:`read_page` / `active_tab_snapshot` / `eval(innerText)` 会把 API Keys / Secret 页的 key material 带进工具输出。
- **影响**:密钥泄露进 chat/log。
- **agent 侧 workaround**:secret 页只 shape-only eval(记 prefix/length,不取值)。
- **修复方向**:ABR 在 secret-like 页给 `read_page`/`snapshot` 加 secret redaction。
- **来源**:2026-06-28 Magic `dashboard.magic.link`。

### profile/tab 绑定不稳
- **现象**:profile/tab 状态乱漂,出现旧 tab(Stripe)、inactive tab。
- **影响**:操作不确定打到哪个 tab。
- **修复方向**:稳定 profile/tab 绑定 wrapper。
- **来源**:campaign `luno-og` TI-LUNO-001。

### 全局 header 注入污染第三方请求
- **现象**:全局注入自定义 header(如 `x-luno-bugcrowd-id`)会加到所有请求含第三方,触发 CORS/preflight 失败。
- **修复方向**:selective header(按 origin 注入)或 browser + raw HTTP hybrid。
- **来源**:campaign `luno-og` TI-LUNO-002。

### Personal Chrome 单 cookie store 不能切账号
- **现象**:Personal Chrome 单 cookie store,旧 session 的 server-side cookie(`.ASPXAUTH`)还活时,新账号 login 不真换 token;`click logout` 在长会话站(ASP.NET/Knockout)实测无效。
- **影响**:同一 Personal Chrome 串两个账号会拿到同一 session(两份 auth artifact 实际同一身份)。
- **agent 侧 workaround**:attacker/victim 用独立 Agent Browser(`profile_create`),不在 Personal Chrome 混。
- **修复方向**:ABR 提供 Personal Chrome cookie 清理 / 强制切账号能力。
- **来源**:2026-06-24 flow 16/17。
