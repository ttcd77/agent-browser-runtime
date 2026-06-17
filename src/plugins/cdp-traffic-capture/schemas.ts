/**
 * CDP Traffic Capture — Schema 单一真相源 + 防静默报错防护
 *
 * 集中：
 *   - zod schema 共用片段（profile / after / before / limit / 各 enum）
 *   - defineCdpTool helper：zod -> JSON Schema + L1 runtime 校验 + L4 错误落盘
 *   - L3 generateDiagnostic：query 返回 0 条时给 LLM hint
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_DATA_DIR = join(homedir(), ".agent-browser-runtime");
const DATA_DIR = process.env.CDP_SECURITY_DATA_DIR || DEFAULT_DATA_DIR;
const ERROR_LOG_DIR =
  process.env.CDP_SECURITY_ERROR_LOG_DIR || join(DATA_DIR, "cdp-traffic", "_errors");

// ────────── DomMutation data model ──────────

export interface DomMutation {
  type: string;
  target: string;
  addedNodes: number;
  removedNodes: number;
  attributeName: string;
  oldValue: string;
  sessionId?: string;
  timestamp: number;
  profile: string;
}

// ────────── WebAuthnEvent data model ──────────

export interface WebAuthnEvent {
  type: string;
  origin?: string;
  rpId?: string;
  credentialId?: string;
  timestamp: number;
  profile: string;
}

// ────────── ScriptParsed data model ──────────

export interface ScriptParsedEntry {
  scriptId: string;
  url: string;
  sourceMapURL?: string;
  hash?: string;
  isModule?: boolean;
  length?: number;
  sessionId?: string;
  timestamp: number;
  profile: string;
}

// ────────── 共享子 schema ──────────

export const ProfileSchema = z
  .string()
  .min(1)
  .describe("Browser profile name (lowercase). Naming convention '<target>-<identity>' or the older '<target>-<slot>' (e.g. 'app-merchant-a' / 'app-payer' / 'app-1'), each with isolated cookies/storage. Configured under browser.profiles in browser-profiles.json. Open a page with that profile using the browser tools first, then query the CDP capture.");

export const AfterSchema = z
  .string()
  .optional()
  .describe("ISO 8601 时间戳增量过滤，**必须带时区**（如 '2026-04-28T10:00:00Z'）。无时区会按本地解析有漂移风险");

export const BeforeSchema = z
  .string()
  .optional()
  .describe("ISO 8601 时间戳上界，配合 after 拿 [after, before] 时间窗口");

export const LimitSchema = z
  .number()
  .int()
  .positive()
  .max(10000)
  .optional()
  .describe("返回**最新** N 条（slice(-limit) 取尾部），默认 50。如需更早数据用 before 时间过滤翻页");

// ────────── CDP enum 真实值（来自协议）──────────

/** Network.ResourceType — 18 个 PascalCase 取值 */
export const ResourceTypeEnum = z
  .enum([
    "Document", "Stylesheet", "Image", "Media", "Font", "Script",
    "TextTrack", "XHR", "Fetch", "Prefetch", "EventSource", "WebSocket",
    "Manifest", "SignedExchange", "Ping", "CSPViolationReport", "Preflight", "Other",
  ])
  .optional()
  .describe("CDP Network.ResourceType（PascalCase 严格匹），如 'Document' / 'Script' / 'XHR' / 'Fetch' / 'WebSocket' / 'CSPViolationReport' / 'Preflight'");

/** Runtime.consoleAPICalled.type — 18 个完整 CDP 取值（不缩写）*/
export const ConsoleLogTypeEnum = z
  .enum([
    "log", "debug", "info", "error", "warning",
    "dir", "dirxml", "table", "trace", "clear",
    "startGroup", "startGroupCollapsed", "endGroup",
    "assert", "profile", "profileEnd", "count", "timeEnd",
  ])
  .optional()
  .describe("CDP console type（**严格匹**），CDP 用完整词如 'warning' 不是 'warn'");

export const DialogTypeEnum = z
  .enum(["alert", "confirm", "prompt", "beforeunload"])
  .optional()
  .describe("CDP javascriptDialog type（严格匹）");

export const SecurityStateEnum = z
  .enum(["unknown", "neutral", "insecure", "secure", "info", "insecure-broken"])
  .optional()
  .describe("CDP Security state（严格匹）。注：'info' 在新 Chrome 已 deprecated，几乎不出现");

export const FrameEventTypeEnum = z
  .enum(["navigated", "attached", "detached", "startedLoading", "stoppedLoading"])
  .optional()
  .describe("Page.frame* event type（严格匹）");

export const HttpMethodEnum = z
  .enum(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "CONNECT", "TRACE"])
  .optional()
  .describe("HTTP 方法（自动 toUpperCase 严格匹）。单值精确匹，如要 OR 多个方法请发多次调用");

/** Audits issue code — 不 strict enum 因为 CDP 经常加新值。Substring 匹 */
export const AuditsIssueCodeSchema = z
  .string()
  .optional()
  .describe(`Substring 匹配 issueCode（case-insensitive，**先 toLowerCase 再 includes**）。
CDP 当前标准值（22 个）：CookieIssue / MixedContentIssue / BlockedByResponseIssue
  / HeavyAdIssue / ContentSecurityPolicyIssue / SharedArrayBufferIssue
  / LowTextContrastIssue / CorsIssue / AttributionReportingIssue
  / QuirksModeIssue / GenericIssue / DeprecationIssue / ClientHintIssue
  / FederatedAuthRequestIssue / BounceTrackingIssue / StylesheetLoadingIssue
  / NavigatorUserAgentIssue / PropertyRuleIssue / SameSiteCookieIssue
  / TrustedWebActivityIssue / WasmCrossOriginModuleSharingIssue
  / FederatedAuthUserInfoRequestIssue。
**'CSP' 不会匹** 'ContentSecurityPolicyIssue'，要写 'ContentSecurityPolicy' 或 'PolicyIssue'`);

/** Storage type — 6 个完整动作粒度 */
export const StorageTypeSchema = z
  .string()
  .optional()
  .describe(`Substring 匹配 type（case-insensitive）。完整 6 个动作粒度：
'indexedDB.contentUpdated' / 'cacheStorage.contentUpdated'
/ 'domStorage.itemAdded' / 'domStorage.itemUpdated'
/ 'domStorage.itemRemoved' / 'domStorage.cleared'。
按大类查用 'indexedDB' / 'cacheStorage' / 'domStorage'`);

export const UrlContainsSchema = z
  .string()
  .optional()
  .describe("Substring 匹 url（case-insensitive）。如要按 hostname 精准匹用 hostname 字段");

export const HostnameSchema = z
  .string()
  .optional()
  .describe("精确按 url 的 hostname 匹（防止 query string 误中），如 'example.com'");

export const StatusSchema = z
  .number()
  .int()
  .optional()
  .describe("HTTP 状态码精确匹单值（如 400 / 401 / 500）。要范围如 4xx 请多次调用或外部过滤");

export const TextContainsSchema = z
  .string()
  .optional()
  .describe("Substring 匹（case-insensitive）。注：对象类参数（如 console.log({token:'abc'})）只能匹到 description='Object'，匹不到对象内部字段");

export const FailedOnlySchema = z
  .boolean()
  .optional()
  .describe("仅返回 failed=true 的请求（包括 blocked / network error / canceled）");

export const FromCacheSchema = z
  .boolean()
  .optional()
  .describe("仅返回 fromCache=true 的请求（cache hit，未真发到服务器）");

export const ScriptIdSchema = z
  .string()
  .min(1)
  .describe("Debugger.scriptParsed 事件带的 scriptId");

export const HasSourceMapSchema = z
  .boolean()
  .optional()
  .describe("仅返回 sourceMapURL 非空的脚本（true）/ 仅返回无 sourcemap 的（false）");

export const IsModuleSchema = z
  .boolean()
  .optional()
  .describe("仅返回 ES module 脚本（true）/ 仅返回普通脚本（false）");

export const BlockedReasonContainsSchema = z
  .string()
  .optional()
  .describe(`Substring 匹 blockedReason（case-insensitive）。CDP 标准值如：
'csp' / 'mixed-content' / 'origin' / 'inspector' / 'subresource-filter'
/ 'content-type' / 'collapsed-by-client' / 'coep-frame-resource-needs-coep-header'
/ 'corp-not-same-origin' / 'corp-not-same-site' / 'corp-not-same-origin-after-defaulted-to-same-origin-by-coep'
/ 'unsupported'`);

// ────────── DOM mutation types ──────────

export const DomMutationTypeEnum = z
  .enum(["childList", "attributes", "characterData"])
  .optional()
  .describe("MutationRecord.type（严格匹）：childList / attributes / characterData");

export const DomMutationTargetContainsSchema = z
  .string()
  .optional()
  .describe("Substring 匹 target 选择器（如 'button' / '#login' / '.modal'）");

// ────────── L3: Diagnostic helpers ──────────

export interface DiagnosticContext {
  /** 该 buffer 当前总条数 */
  bufferSize: number;
  /** filter 后剩余条数（**slice limit 之前**）*/
  filteredCount: number;
  /** filter 输入参数（kv） */
  filters: Record<string, unknown>;
  /** buffer 里 enum-like 字段的 unique 样本（前 5 个）— 帮 LLM 识别拼错 */
  enumSamples?: Record<string, string[]>;
  /** profile 是否 connected */
  profileConnected: boolean;
  /** profile 名字（用于 hint）*/
  profile: string;
}

/** 当 query 返回 0 条时生成 hint。返回 null 表示无诊断需要 */
export function generateDiagnostic(ctx: DiagnosticContext): { hint: string } | null {
  if (!ctx.profileConnected && ctx.bufferSize === 0) {
    return {
      hint: `profile '${ctx.profile}' 当前 disconnected 且 buffer 为空。先用 browser 工具指定 profile='${ctx.profile}' 打开目标页面，再来查`,
    };
  }
  if (ctx.bufferSize === 0) {
    return {
      hint: `该 buffer 当前 0 条事件 captured。可能原因：①profile '${ctx.profile}' 还没 navigate 任何页面 ②plugin attach 晚于浏览器启动（重启 gateway 会重置）③该事件类型需要特定触发（如 IndexedDB 写需访问真用 IDB 的站；Audits issues 需触发 CSP/CORS 拦截）`,
    };
  }
  if (ctx.filteredCount > 0) return null;

  // bufferSize > 0 && filteredCount === 0 — filter 全没匹中，最值得 hint
  const applied = Object.entries(ctx.filters).filter(
    ([_, v]) => v !== undefined && v !== null && v !== "",
  );
  if (applied.length === 0) {
    return {
      hint: `buffer 有 ${ctx.bufferSize} 条但 filter 后 0 条（且无 filter 应用）— 可能是 plugin 内部 bug，请报告`,
    };
  }
  let msg = `buffer 有 ${ctx.bufferSize} 条但 filter 全没匹中。Applied: ${JSON.stringify(Object.fromEntries(applied))}.`;
  if (ctx.enumSamples) {
    const sampleStr = Object.entries(ctx.enumSamples)
      .map(([k, vs]) => `${k}=${JSON.stringify(vs)}`)
      .join("; ");
    msg += ` Buffer 实际取值样本：${sampleStr}。检查 filter 是否拼错（常见：CDP 用 PascalCase / 完整词不是缩写）`;
  }
  return { hint: msg };
}

/** 抽 buffer 里某字段的 unique 取值前 N 个（给 diagnostic 用）*/
export function uniqueFieldValues<T>(
  rows: T[],
  getter: (r: T) => string | undefined,
  max = 5,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const v = getter(r);
    if (typeof v !== "string" || !v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

// ────────── L4: Tool error logging ──────────

let errorLogReady = false;

async function ensureErrorLogReady(): Promise<void> {
  if (errorLogReady) return;
  try {
    await mkdir(ERROR_LOG_DIR, { recursive: true });
    errorLogReady = true;
  } catch {
    // 静默：log dir 创建失败不该挡住 plugin
  }
}

export async function logToolError(
  toolName: string,
  params: unknown,
  err: unknown,
): Promise<void> {
  await ensureErrorLogReady();
  if (!errorLogReady) return;
  const date = new Date().toISOString().slice(0, 10);
  const file = join(ERROR_LOG_DIR, `${date}.jsonl`);
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    tool: toolName,
    params,
    error: String(err),
    stack: (err as Error)?.stack ?? null,
  }) + "\n";
  try {
    await appendFile(file, line, "utf-8");
  } catch {
    // 静默：日志写失败不能挡住主流程
  }
}

/** Listener 内部异常落盘（非 tool 调用异常）*/
export async function logListenerError(
  profile: string,
  domain: string,
  event: string,
  err: unknown,
): Promise<void> {
  await ensureErrorLogReady();
  if (!errorLogReady) return;
  const date = new Date().toISOString().slice(0, 10);
  const file = join(ERROR_LOG_DIR, `listener-${date}.jsonl`);
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    profile,
    domain,
    event,
    error: String(err),
    stack: (err as Error)?.stack ?? null,
  }) + "\n";
  try {
    await appendFile(file, line, "utf-8");
  } catch { /* silent */ }
}

// ────────── Merged tool schemas (21→6 type-based dispatchers) ──────────

// cdp_query: disc union over 12 query types
export const CdpQueryType = z.enum([
  "traffic", "audits", "console", "dialogs", "exceptions",
  "security", "storage", "frames", "scripts", "dom_mutations",
  "webauthn", "fetch",
]);
export type CdpQueryType = z.infer<typeof CdpQueryType>;

export const CdpQuerySchema = z.object({
  profile: ProfileSchema,
  type: CdpQueryType.describe("查询类型：traffic/audits/console/dialogs/exceptions/security/storage/frames/scripts/dom_mutations/webauthn/fetch"),
  // traffic filters
  url_contains: UrlContainsSchema,
  hostname: HostnameSchema,
  method: HttpMethodEnum,
  status: StatusSchema,
  resource_type: ResourceTypeEnum,
  failed_only: FailedOnlySchema,
  from_cache: FromCacheSchema,
  blocked_reason_contains: BlockedReasonContainsSchema,
  // audits
  issue_code: AuditsIssueCodeSchema,
  // console
  log_type: ConsoleLogTypeEnum,
  text_contains: TextContainsSchema,
  // dialogs
  dialog_type: DialogTypeEnum,
  // security
  state: SecurityStateEnum,
  // storage
  storage_type: StorageTypeSchema,
  origin: z.string().optional().describe("storage origin 过滤"),
  key_contains: z.string().optional().describe("storage key substring"),
  // frames
  frame_type: FrameEventTypeEnum,
  frame_url_contains: UrlContainsSchema,
  // scripts
  script_url_contains: z.string().optional(),
  has_source_map: HasSourceMapSchema,
  is_module: IsModuleSchema,
  // webauthn
  webauthn_type: z.string().optional(),
  // dom_mutations
  mutation_type: DomMutationTypeEnum,
  mutation_target_contains: DomMutationTargetContainsSchema,
  // common
  after: AfterSchema,
  before: BeforeSchema,
  limit: LimitSchema,
});

// Retired 2026-06-13 alongside the tools that used them: CdpGetSchema,
// CdpCookiesSchema, CdpStatsSchema, CdpSelfTestSchema. See index.ts header
// for rationale (0 callers in server / CLI / smoke / skills).

// cdp_fetch_intercept: disc union over 4 actions
export const CdpFetchAction = z.enum(["start", "list", "continue", "fail"]);
export const CdpFetchInterceptSchema = z.object({
  profile: ProfileSchema,
  action: CdpFetchAction.describe("动作：start（开始拦截）/ list（列暂停）/ continue（放行，可改 header/body/url/method）/ fail（模拟失败）"),
  url_pattern: z.string().optional().describe("URL substring 匹配（action=start 时用，空串=所有）"),
  captured_request_id: z.string().optional().describe("capturedRequestId（action=continue/fail 时用，来自 list 返回）"),
  header_overrides: z.record(z.string(), z.string()).optional().describe("header 修改 {name:value}（action=continue 时用）"),
  remove_headers: z.array(z.string()).optional().describe("要删除的 header 名称（action=continue 时用）"),
  url: z.string().optional().describe("改写请求 URL（action=continue 时用）"),
  method: z.string().optional().describe("改写请求 method（action=continue 时用）"),
  body: z.string().optional().describe("改写请求 body，工具会按 CDP 要求转 base64（action=continue 时用）"),
  body_base64: z.string().optional().describe("已 base64 编码的请求 body（action=continue 时用）"),
  json: z.unknown().optional().describe("把对象序列化成 JSON 请求 body（action=continue 时用）"),
  error_reason: z.string().optional().default("BlockedByClient").describe("CDP errorReason（action=fail 时用）"),
});

// ────────── 核心：defineCdpTool helper ──────────

// Loose tool shape — the runtime accepts a raw object; no typebox cast required.
type AnyAgentTool = {
  name: string;
  label?: string;
  description: string;
  details?: string;
  parameters: unknown;
  execute: (toolCallId: unknown, params: unknown) => Promise<{
    content: Array<{ type: "text"; text: string }>;
  }>;
};

export interface CdpToolDef<T extends z.ZodTypeAny> {
  name: string;
  label?: string;
  description: string;
  details?: string;
  deferred?: boolean;
  schema: T;
  execute: (params: z.infer<T>) => Promise<unknown>;
}

/**
 * 定义一个 CDP 工具：
 *   - zod schema → JSON Schema（自动给 LLM 看）
 *   - L1 runtime 校验（schema 不匹 reject + 清晰错误）
 *   - L4 try-catch + 错误落盘
 *
 * 不在这层加 L3 diagnostic — diagnostic 在 execute 内部生成更精确（需要访问 buffer）
 */
export function defineCdpTool<T extends z.ZodTypeAny>(def: CdpToolDef<T>): AnyAgentTool {
  const jsonSchema = zodToJsonSchema(def.schema, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;

  // 移除 $schema 字段（OpenAI tool schema 不期望）
  delete jsonSchema.$schema;

  return {
    name: def.name,
    label: def.label,
    description: def.description,
    details: def.details,
    ...(def.deferred ? { deferred: true } : {}),
    parameters: jsonSchema,
    async execute(_id: unknown, rawParams: unknown) {
      // L1: zod runtime 校验
      const parsed = def.schema.safeParse(rawParams);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => {
          const base: Record<string, unknown> = {
            path: i.path.join(".") || "(root)",
            code: i.code,
            message: i.message,
          };
          // zod enum 错时把合法选项列出来给 LLM
          if (i.code === "invalid_enum_value") {
            const anyI = i as unknown as { options?: unknown[]; received?: unknown };
            if (anyI.options) base.legalValues = anyI.options;
            if (anyI.received !== undefined) base.received = anyI.received;
          }
          return base;
        });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "schema validation failed",
              tool: def.name,
              issues,
              hint: "传值不符合 schema — 通常是 enum 拼错。检查 issues[].legalValues 给的合法值列表",
            }),
          }],
        };
      }

      // L4: 包住业务执行
      try {
        const result = await def.execute(parsed.data);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(result),
          }],
        };
      } catch (err) {
        await logToolError(def.name, rawParams, err);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: String(err),
              tool: def.name,
              hint: `工具内部异常，已落盘到 data/cdp-traffic/_errors/<date>.jsonl`,
            }),
          }],
        };
      }
    },
  };
}
