/**
 * CDP Traffic Capture plugin
 *
 * Directly attaches to each configured browser profile's Chrome DevTools
 * Protocol endpoint and captures FULL request/response data — including
 * request headers, POST data, response headers, response body, and WebSocket
 * frames. This is far richer than a typical bridge /requests view that only
 * exposes URL/method/status/resourceType.
 *
 * Stores per-profile ring buffer (default 2000 entries). Exposes:
 *   cdp_traffic_query(profile, filters)   — search captured requests
 *   cdp_traffic_detail(profile, requestId) — get full body/headers
 *   cdp_traffic_stats()                    — show capture health per profile
 *
 * Lifecycle:
 *  - On startup: load profiles into memory but attach NOTHING (lazy). The
 *    reconnect loop only iterates profiles that have been activated.
 *  - On first tool use of a profile: activate() it — kick an immediate attach
 *    and add it to the reconnect set so the loop keeps it attached.
 *  - When a CDP endpoint is up: attach to page target, enable Network domain
 *  - On browser exit: mark disconnected; loop keeps trying (activated profiles)
 */

import {
  definePluginEntry,
  type AnyAgentTool,
  type PluginApi,
  type PluginService,
  type PluginLogger,
} from "../../plugin-sdk/plugin-entry.js";
// @ts-expect-error - chrome-remote-interface has no TS types
import CDP from "chrome-remote-interface";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  defineCdpTool,
  generateDiagnostic,
  uniqueFieldValues,
  logListenerError,
  ProfileSchema,
  AfterSchema,
  BeforeSchema,
  LimitSchema,
  ResourceTypeEnum,
  ConsoleLogTypeEnum,
  DialogTypeEnum,
  SecurityStateEnum,
  FrameEventTypeEnum,
  HttpMethodEnum,
  AuditsIssueCodeSchema,
  StorageTypeSchema,
  UrlContainsSchema,
  HostnameSchema,
  StatusSchema,
  TextContainsSchema,
  FailedOnlySchema,
  FromCacheSchema,
  BlockedReasonContainsSchema,
  ScriptIdSchema,
  HasSourceMapSchema,
  IsModuleSchema,
  DomMutationTypeEnum,
  DomMutationTargetContainsSchema,
  CdpQueryType,
  CdpQuerySchema,
  CdpFetchAction,
  CdpFetchInterceptSchema,
  type ScriptParsedEntry,
  type DomMutation,
  type WebAuthnEvent,
} from "./schemas.js";

const DEFAULT_DATA_DIR = join(homedir(), ".agent-browser-runtime");
const DATA_DIR = process.env.CDP_SECURITY_DATA_DIR || DEFAULT_DATA_DIR;
const BODY_STORE_DIR = process.env.CDP_SECURITY_BODY_STORE_DIR || join(DATA_DIR, "cdp-traffic");
const SPOOL_DIR = process.env.CDP_SECURITY_SPOOL_DIR || join(DATA_DIR, "cdp-spool");
// Profile-port config the worker maintains (browser.profiles -> cdpPort). The
// worker resolves the canonical path at startup and exports it via this env
// var; we fall back to the dataDir default if loaded standalone.
const PROFILE_CONFIG_PATH =
  process.env.CDP_BROWSER_PROFILE_CONFIG ||
  join(DATA_DIR, "browser-profiles.json");

interface CDPInitiator {
  /** "parser"=HTML/CSS 解析触发；"script"=JS 触发；"preload"/"preflight"/"SignedExchange"/"other" */
  type: string;
  /** parser 类型：HTML/CSS 的 URL；script 类型有时也带 */
  url?: string;
  /** parser 类型：HTML/CSS 第几行触发的 */
  lineNumber?: number;
  columnNumber?: number;
  /** 父请求 requestId — 重定向链 / fetch chain / preflight 用 */
  requestId?: string;
  /** JS 调用栈，第 0 帧是最深处（实际发请求的函数）。混淆代码里 lineNumber 都是 1 */
  stack?: {
    callFrames: Array<{
      url: string;
      lineNumber: number;
      columnNumber: number;
      functionName?: string;
    }>;
  };
}

interface CDPSecurityDetails {
  protocol?: string;
  keyExchange?: string;
  cipher?: string;
  certificateId?: number;
  subjectName?: string;
  issuer?: string;
  validFrom?: number;
  validTo?: number;
  sanList?: string[];
}

interface CDPTiming {
  requestTime?: number;
  proxyStart?: number;
  proxyEnd?: number;
  dnsStart?: number;
  dnsEnd?: number;
  connectStart?: number;
  connectEnd?: number;
  sslStart?: number;
  sslEnd?: number;
  sendStart?: number;
  sendEnd?: number;
  receiveHeadersEnd?: number;
}

interface RedirectHop {
  url: string;
  method: string;
  status: number;
  headers: Record<string, string>;
}

interface CapturedRequest {
  requestId: string;
  profile: string;
  timestamp: number;
  request?: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
  };
  response?: {
    status: number;
    statusText?: string;
    headers: Record<string, string>;
    mimeType?: string;
    /** TLS / cert 信息 — TLS 协议研究 / 证书钉扎 / mixed content */
    securityDetails?: CDPSecurityDetails;
    /** DNS / connect / TLS / send / receive 时间戳 — 时序攻击 / 盲注研究 */
    timing?: CDPTiming;
    /** 网络层实际传输字节数（含 headers + body）— cache poisoning / DoS 研究 */
    transferSize?: number;
    encodedDataLength?: number;
    fromDiskCache?: boolean;
    fromServiceWorker?: boolean;
    fromPrefetchCache?: boolean;
  };
  resourceType?: string;
  /** "谁拉来的这个请求" — CDP Network.requestWillBeSent 自带，等价于 DevTools Network 的"启动器"列 + "启动器链" + "调用堆栈" */
  initiator?: CDPInitiator;
  /** 浏览器拦的原因 — CSP/CORS/MixedContent/CoepFrameResourceNeedsCoepHeader 等。漏洞研究关键信号 */
  blockedReason?: string;
  /** 触发请求的 frame ID — iframe 攻击 / cross-frame 研究 */
  frameId?: string;
  /** 仅 frame navigation 请求带（页面主请求 / iframe 主请求）*/
  documentURL?: string;
  /** Network.requestServedFromCache 信号 — cache poisoning 研究 */
  fromCache?: boolean;
  /** redirect 链每跳保留 — OAuth/SAML/SSRF 必看 */
  redirectChain?: RedirectHop[];
  /** body path on disk: `data/cdp-traffic/{profile}/{requestId}.{ext}`. Full body, no truncation. */
  bodyPath?: string;
  base64Encoded?: boolean;
  bodyBytes?: number;
  failed?: boolean;
  failReason?: string;
  ws?: Array<{ direction: "tx" | "rx"; payload: string; ts: number; opcode?: number }>;
  /** WebSocket 完整生命周期 — handshake auth bypass 研究 */
  wsLifecycle?: {
    created?: { url: string; ts: number };
    handshakeRequest?: { headers: Record<string, string>; ts: number };
    handshakeResponse?: { status: number; statusText?: string; headers: Record<string, string>; ts: number };
    closed?: { ts: number; reason?: string };
  };
  /** Server-Sent Events 推送消息 */
  sse?: Array<{ data: string; eventName?: string; eventId?: string; ts: number }>;
}

interface AuditIssue {
  profile: string;
  timestamp: number;
  /** CDP issueCode — CookieIssue / MixedContentIssue / BlockedByResponseIssue / ContentSecurityPolicyIssue / CorsIssue / etc. */
  issueCode: string;
  /** 完整 details — CDP issue raw payload，结构因 issueCode 而异 */
  details: unknown;
}

interface ConsoleLog {
  profile: string;
  timestamp: number;
  /** log / warn / error / info / debug / trace / dir / etc. */
  type: string;
  /** 实参列表 */
  args: Array<{ type: string; subtype?: string; value?: unknown; description?: string; className?: string }>;
  /** 调用栈（混淆代码 leak 路径用）*/
  stackTrace?: { callFrames: Array<{ url: string; lineNumber: number; columnNumber: number; functionName: string }> };
  /** 触发的脚本 URL */
  url?: string;
  /** executionContextId — 区分主页 vs iframe vs Worker */
  executionContextId?: number;
}

interface RuntimeException {
  profile: string;
  timestamp: number;
  /** 异常文本 */
  text: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  stackTrace?: { callFrames: Array<{ url: string; lineNumber: number; columnNumber: number; functionName: string }> };
  /** 异常对象本身（type / className / description / value）— stack trace + obj 一起 leak 内部状态 */
  exception?: { type: string; subtype?: string; className?: string; description?: string; value?: unknown };
}

interface PageDialog {
  profile: string;
  timestamp: number;
  url: string;
  message: string;
  /** alert / confirm / prompt / beforeunload */
  dialogType: string;
  defaultPrompt?: string;
  /** XSS 验证：弹了什么 = 你的 payload 触发了哪个 sink */
  hasBrowserHandler?: boolean;
}

interface SecurityStateEvent {
  profile: string;
  timestamp: number;
  /** unknown / neutral / insecure / secure / info / insecure-broken */
  state: string;
  explanations?: Array<{
    securityState: string;
    title?: string;
    summary: string;
    description: string;
    mixedContentType?: string;
    certificate?: string[];
    recommendations?: string[];
  }>;
}

interface StorageWriteEvent {
  profile: string;
  timestamp: number;
  /** indexedDB.contentUpdated / cacheStorage.contentUpdated / domStorage.itemAdded / domStorage.itemUpdated / domStorage.itemRemoved / domStorage.cleared */
  type: string;
  origin?: string;
  databaseName?: string;
  objectStoreName?: string;
  cacheName?: string;
  /** localStorage / sessionStorage 区分 */
  isLocalStorage?: boolean;
  storageKey?: string;
  itemKey?: string;
  itemValue?: string;
  itemOldValue?: string;
}

interface FrameLifecycleEvent {
  profile: string;
  timestamp: number;
  /** navigated / attached / detached / startedLoading / stoppedLoading */
  type: string;
  frameId: string;
  parentFrameId?: string;
  url?: string;
  name?: string;
  /** loaderId / mimeType — frame navigation 详情 */
  loaderId?: string;
  mimeType?: string;
}

const MAX_WS_FRAMES_PER_ENTRY = 5000;
const MAX_REQUEST_PER_PROFILE = 2000;
const MAX_AUDIT_ISSUES_PER_PROFILE = 1000;
const MAX_CONSOLE_PER_PROFILE = 5000;
const MAX_EXCEPTIONS_PER_PROFILE = 1000;
const MAX_DIALOGS_PER_PROFILE = 200;
const MAX_SECURITY_PER_PROFILE = 500;
const MAX_STORAGE_PER_PROFILE = 2000;
const MAX_FRAMES_PER_PROFILE = 1000;
const MAX_SCRIPTS_PER_PROFILE = 5000;
const MAX_DOM_MUTATIONS_PER_PROFILE = 5000;
const MAX_WEBAUTHN_EVENTS_PER_PROFILE = 1000;
const RECONNECT_MS = 5_000;

/** IIFE 注入生成 unique 全局名，避免跟 page JS 冲突 */
function _domMutationVar(): string {
  return `__hubDomMutations_${Math.random().toString(36).slice(2, 8)}`;
}

function pickExt(mimeType?: string): string {
  if (!mimeType) return "bin";
  const m = mimeType.split(";")[0].trim().toLowerCase();
  if (m.includes("json")) return "json";
  if (m.includes("html")) return "html";
  if (m.includes("xml")) return "xml";
  if (m.includes("javascript")) return "js";
  if (m.includes("css")) return "css";
  if (m.includes("text/plain")) return "txt";
  if (m.includes("image/")) return m.split("/")[1] ?? "bin";
  if (m.includes("font/") || m.includes("woff") || m.includes("ttf")) return "font";
  return "bin";
}

function normalizeCdpUrl(cdpUrl: string): string {
  return cdpUrl.replace(/\/+$/, "");
}

function cdpEndpointLabel(endpoint: CdpEndpoint): string {
  return endpoint.kind === "port" ? String(endpoint.cdpPort) : endpoint.cdpUrl;
}

function readEndpointJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? https : http;
    const req = mod.get(parsed, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            return;
          }
          resolve(JSON.parse(data) as T);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(8_000, () => {
      req.destroy(new Error(`timeout reading ${url}`));
    });
  });
}

interface FetchInterceptState {
  /** URL patterns marked for intercept (substring match against full URL) */
  patterns: Set<string>;
  /** Paused requests awaiting user action — 30s auto-continue timeout */
  paused: Map<string, { requestId: string; captured: CapturedRequest; timer: ReturnType<typeof setTimeout> }>;
}

interface FetchContinueOptions {
  headerOverrides?: Record<string, string>;
  removeHeaders?: string[];
  url?: string;
  method?: string;
  body?: string;
  bodyBase64?: string;
  json?: unknown;
}

type CdpEndpoint =
  | { kind: "port"; cdpPort: number; label: string; browserContextId?: string; tabId?: string }
  | { kind: "url"; cdpUrl: string; label: string; browserContextId?: string; tabId?: string };

interface CdpTarget {
  id: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
  browserContextId?: string;
}

interface ProfileState {
  endpoint: CdpEndpoint;
  /** HTTP/WS request store (Network domain capture) */
  store: CapturedRequest[];
  /** Audits.issueAdded — CSP/CORS/Cookie/MixedContent issues */
  issues: AuditIssue[];
  /** Runtime.consoleAPICalled — console.log/warn/error/etc. */
  consoleLogs: ConsoleLog[];
  /** Runtime.exceptionThrown — uncaught JS exceptions */
  exceptions: RuntimeException[];
  /** Page.javascriptDialogOpening — alert/confirm/prompt */
  dialogs: PageDialog[];
  /** Security.securityStateChanged — TLS / mixed content state transitions */
  securityStates: SecurityStateEvent[];
  /** Storage + DOMStorage write events */
  storageEvents: StorageWriteEvent[];
  /** Page.frameNavigated/Attached/Detached */
  frameEvents: FrameLifecycleEvent[];
  /** Fetch.requestPaused captured requests (capture-only mode, auto-continued) */
  fetchPaused: CapturedRequest[];
  /** Debugger.scriptParsed — 浏览器已解析的 JS 脚本元数据 */
  scripts: ScriptParsedEntry[];
  /** Runtime.evaluate inject MutationObserver 抓到的 DOM mutation */
  domMutations: DomMutation[];
  /** WebAuthn domain 事件 */
  webauthnEvents: WebAuthnEvent[];
  /** Fetch domain intercept state — patterns + paused requests for P2.I 4 control tools */
  fetchInterceptState: FetchInterceptState;
  /** 已经调过 Storage.trackIndexedDBForOrigin / trackCacheStorageForOrigin 的 origin。
   *  CDP 要求 per-origin opt-in tracking，否则 Storage.indexedDBContentUpdated /
   *  cacheStorageContentUpdated 永不 emit。Page.frameNavigated 时 lazy track。 */
  trackedOrigins: Set<string>;
  clients: Set<unknown>;
  /** Target IDs we already have an active CDP connection to — used by
   *  attachProfile() to skip already-connected targets so we only connect to
   *  newly-created tabs (e.g. ensureProfileTab in the bridge creates a new page
   *  target AFTER the initial attach, and without this tracking the reconnect
   *  loop's old clients.size>0 guard would never discover it). */
  connectedTargetIds: Set<string>;
  attaching: boolean;
}

// Fallback logger used before register() injects the real PluginLogger. Shouldn't
// fire in practice (register is called once at plugin load), but keeps class
// methods callable in tests / standalone smoke without a runtime crash.
const NOOP_LOGGER: PluginLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

class TrafficCapture {
  private profiles: Map<string, ProfileState> = new Map();
  /**
   * Profiles the reconnect loop is allowed to attach to. A profile is loaded
   * into `profiles` (cheap, in-memory) by loadProfiles(), but stays DORMANT —
   * no CDP connection — until a tool actually references it via activate().
   *
   * Root cause this fixes: loadProfiles() reads ~119 historical profiles from
   * browser-profiles.json. The old loop attached ALL of them on
   * startup (Target.setAutoAttach + Network capture per profile), which dragged
   * worker boot past 60s and stalled /health. With lazy activation the loop is
   * empty at boot → worker starts in seconds → each profile attaches on first
   * use and is then kept attached / re-attached as before.
   */
  private activated: Set<string> = new Set();
  private logger: PluginLogger = NOOP_LOGGER;
  private reconnectTimer: NodeJS.Timeout | null = null;

  setLogger(logger: PluginLogger): void {
    this.logger = logger;
  }

  private static makeProfileState(endpoint: CdpEndpoint): ProfileState {
    return {
      endpoint,
      store: [],
      issues: [],
      consoleLogs: [],
      exceptions: [],
      dialogs: [],
      securityStates: [],
      storageEvents: [],
      frameEvents: [],
      fetchPaused: [],
      scripts: [],
      domMutations: [],
      webauthnEvents: [],
      fetchInterceptState: { patterns: new Set(), paused: new Map() },
      trackedOrigins: new Set<string>(),
      clients: new Set(),
      connectedTargetIds: new Set(),
      attaching: false,
    };
  }

  async loadProfiles(): Promise<void> {
    try {
      const cfgRaw = (await readFile(PROFILE_CONFIG_PATH, "utf-8")).replace(/^\uFEFF/, "");
      const cfg = JSON.parse(cfgRaw) as { browser?: { profiles?: Record<string, { cdpPort?: number; cdpUrl?: string; browserContextId?: string; tabId?: string }> } };
      const profiles = cfg.browser?.profiles ?? {};
      for (const [name, p] of Object.entries(profiles)) {
        let endpoint: CdpEndpoint | null = null;
        const scoped = {
          ...(typeof p.browserContextId === "string" && p.browserContextId ? { browserContextId: p.browserContextId } : {}),
          ...(typeof p.tabId === "string" && p.tabId ? { tabId: p.tabId } : {}),
        };
        if (typeof p.cdpUrl === "string" && p.cdpUrl.trim()) {
          const cdpUrl = normalizeCdpUrl(p.cdpUrl.trim());
          endpoint = { kind: "url", cdpUrl, label: cdpUrl, ...scoped };
        } else if (typeof p.cdpPort === "number") {
          endpoint = { kind: "port", cdpPort: p.cdpPort, label: String(p.cdpPort), ...scoped };
        }
        if (!endpoint) continue;
        const existing = this.profiles.get(name);
        if (existing) {
          existing.endpoint = endpoint;
        } else {
          this.profiles.set(name, TrafficCapture.makeProfileState(endpoint));
        }
      }
      this.logger.info(`[cdp-traffic] loaded ${this.profiles.size} profiles`);
    } catch (err) {
      this.logger.warn(`[cdp-traffic] loadProfiles failed: ${err}`);
    }
  }

  // Throttle state shared across all plugin instances via process-global
  // Symbol. A host that re-registers the plugin per subagent would otherwise
  // give each instance its own Map, and many concurrent instances on a 5s
  // reconnect tick produced ~70 log lines/min despite the 60s throttle.
  private get _disconnectLogged(): Map<string, number> {
    const SYM = Symbol.for("hub.cdpTraffic.disconnectLogged");
    const g = globalThis as unknown as Record<symbol, Map<string, number>>;
    if (!g[SYM]) g[SYM] = new Map();
    return g[SYM];
  }

  startReconnectLoop(): void {
    // Singleton guard: plugin re-registers per subagent (observed 6× in a few
    // minutes during Hunt). Without this, each instance starts its own
    // setInterval — 6 concurrent loops × 10 profiles × tick every 5s produced
    // ~216 log lines/min despite the shared Symbol throttle Map (because each
    // instance's this.profiles state is independent, they race each other to
    // win the throttle window). Only the first instance runs the loop.
    //
    // After registerService refactor (2026-04-28), service.stop also clears
    // the Symbol so a subsequent service.start re-creates the loop cleanly.
    const SYM_STARTED = Symbol.for("hub.cdpTraffic.reconnectLoopStarted");
    const g = globalThis as unknown as Record<symbol, boolean>;
    if (g[SYM_STARTED]) return;
    g[SYM_STARTED] = true;

    this.reconnectTimer = setInterval(async () => {
      // Slim Step 4h+: re-read profiles config each tick so newly profile_create'd
      // entries (added by bridge into browser-profiles.json) become visible.
      // Auto-activate any profile tagged backend:"personal-spawn" so its
      // traffic gets captured under cdp-traffic/<name>/ for after-the-fact
      // analysis — agent doesn't need a separate "start capture" call.
      await this.loadProfiles();
      try {
        const cfgRaw = (await readFile(PROFILE_CONFIG_PATH, "utf-8")).replace(/^﻿/, "");
        const cfg = JSON.parse(cfgRaw) as { browser?: { profiles?: Record<string, { backend?: string }> } };
        const entries = Object.entries(cfg.browser?.profiles ?? {});
        for (const [name, meta] of entries) {
          if (meta?.backend === "personal-spawn"
              && !this.activated.has(name)
              && this.profiles.has(name)) {
            this.activate(name);
          }
        }
      } catch {
        // Config file may be transiently unreadable; next tick will retry.
      }

      // Only iterate ACTIVATED profiles. Dormant profiles (loaded but never
      // touched by a tool) are skipped entirely so a fresh worker with 119
      // historical profiles does zero attach work until something uses them.
      for (const name of this.activated) {
        const p = this.profiles.get(name);
        if (!p) continue;
        if (p.attaching) {
          continue;
        }
        if (p.clients.size > 0) {
          this._disconnectLogged.delete(name);
        }
        // Log once per real attach failure. A cdpUrl profile with zero open
        // pages is normal: capture is passive and must not create about:blank
        // tabs merely to become "connected".
        const lastLogged = this._disconnectLogged.get(name) ?? 0;
        const now = Date.now();
        const withinThrottle = now - lastLogged <= 60_000;
        void this.attachProfile(name).catch((e) => {
          if (!withinThrottle) {
            this.logger.warn(`[cdp-traffic] attach ${name}:${cdpEndpointLabel(p.endpoint)} skipped — CDP endpoint unavailable: ${e?.message ?? e}`);
            this._disconnectLogged.set(name, now);
          }
        });
      }
    }, RECONNECT_MS);
    // 让 CLI 短命场景能自然退（同 sessions feedback watcher 思路）。长服务场景
    // 由 HTTP server / pool 撑事件循环，reconnect loop 跟着 ref 链活。
    this.reconnectTimer.unref();
  }

  /**
   * Wake a profile's capture on first use. Called from every CDP tool's execute
   * path with the profile it operates on. Idempotent.
   *
   *  - Adds the profile to the reconnect set so the loop keeps it attached (and
   *    re-attaches after browser restart / new tab), exactly as the old
   *    attach-everything loop did — but only for profiles actually in use.
   *  - Kicks an immediate attach so the caller doesn't wait up to one 5s tick
   *    for capture to come online.
   *
   * No-op for unknown profiles (the tool itself reports "profile not found").
   */
  activate(profile: string | undefined): void {
    if (!profile) return;
    if (!this.profiles.has(profile)) return;
    if (this.activated.has(profile)) return;
    this.activated.add(profile);
    this.logger.info(`[cdp-traffic] ${profile}: activated (lazy attach on first use)`);
    void this.attachProfile(profile).catch(() => {
      // CDP endpoint may not be up yet (browser not launched for this profile).
      // The reconnect loop will retry on its next tick; first-failure logging is
      // handled there via the throttle map.
    });
  }

  /**
   * Service.stop entry point.
   *  - Clears the reconnect interval so no further attach attempts fire.
   *  - Closes every CDP client across all profiles (per-client close() is the
   *    chrome-remote-interface API; the "disconnect" handler from attachTarget
   *    will then drain p.clients).
   *  - Resets the singleton-guard Symbol so a subsequent service.start can
   *    re-create the loop without leaking an old timer.
   *
   * Best-effort: any close() failure is logged but doesn't block shutdown of
   * the remaining clients (we're tearing down).
   */
  async stop(): Promise<void> {
    this.logger.info("[cdp-traffic-capture] service.stop invoked");
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const SYM_STARTED = Symbol.for("hub.cdpTraffic.reconnectLoopStarted");
    const g = globalThis as unknown as Record<symbol, boolean>;
    g[SYM_STARTED] = false;

    let closed = 0;
    for (const [name, p] of this.profiles) {
      for (const client of [...p.clients]) {
        try {
          await (client as { close: () => Promise<void> }).close();
          closed++;
        } catch (err) {
          this.logger.warn(`[cdp-traffic] ${name} client close failed: ${err}`);
        }
      }
      p.clients.clear();
      p.connectedTargetIds.clear();
    }
    this.logger.info(`[cdp-traffic-capture] stop complete (closed ${closed} CDP client(s))`);
  }

  private async attachProfile(name: string): Promise<void> {
    const p = this.profiles.get(name);
    if (!p) return;
    p.attaching = true;
    try {
      const targets = await this.listTargets(p.endpoint);
      const pages = targets.filter((t: { type?: string }) => t.type === "page");
      let newTargets = 0;
      for (const target of pages) {
        if (p.connectedTargetIds.has(target.id)) continue;
        await this.attachTarget(name, p.endpoint, target);
        newTargets++;
      }
      if (newTargets > 0) {
        this.logger.info(`[cdp-traffic] ${name}:${cdpEndpointLabel(p.endpoint)} attached to ${newTargets} new page(s) (${pages.length} total)`);
      }
    } finally {
      p.attaching = false;
    }
  }

  private async listTargets(endpoint: CdpEndpoint): Promise<CdpTarget[]> {
    if (endpoint.kind === "port" && (endpoint.browserContextId || endpoint.tabId)) {
      const version = await readEndpointJson<{ webSocketDebuggerUrl?: string }>(`http://127.0.0.1:${endpoint.cdpPort}/json/version`);
      if (!version.webSocketDebuggerUrl) return [];
      const client = await CDP({ target: version.webSocketDebuggerUrl });
      try {
        const result = await (client as { send: (method: string, params?: Record<string, unknown>) => Promise<{ targetInfos?: Array<{ targetId: string; type?: string; url?: string; browserContextId?: string }> }> })
          .send("Target.getTargets");
        return (result.targetInfos ?? [])
          .filter((target) => !endpoint.browserContextId || target.browserContextId === endpoint.browserContextId)
          .filter((target) => !endpoint.tabId || target.targetId === endpoint.tabId)
          .map((target) => ({
            id: target.targetId,
            type: target.type,
            url: target.url,
            browserContextId: target.browserContextId,
          }));
      } finally {
        await (client as { close: () => Promise<void> }).close().catch(() => {});
      }
    }
    if (endpoint.kind === "port") {
      return await CDP.List({ port: endpoint.cdpPort }) as CdpTarget[];
    }
    return await readEndpointJson<CdpTarget[]>(`${endpoint.cdpUrl}/json/list`);
  }

  private async attachTarget(name: string, endpoint: CdpEndpoint, target: CdpTarget): Promise<void> {
    const p = this.profiles.get(name);
    if (!p) return;
    let client: unknown;
    try {
      client = endpoint.kind === "port"
        ? await CDP({ port: endpoint.cdpPort, target: target.id })
        : await CDP({ target: target.webSocketDebuggerUrl || target.id });
    } catch (err) {
      return; // Browser may have exited
    }
    p.clients.add(client);
    p.connectedTargetIds.add(target.id);
    type DomainAPI = Record<string, (...args: unknown[]) => unknown>;
    const c = client as {
      Network: DomainAPI;
      Audits: DomainAPI;
      Security: DomainAPI;
      Runtime: DomainAPI;
      Page: DomainAPI;
      Storage: DomainAPI;
      DOMStorage: DomainAPI;
      Fetch: DomainAPI;
      Log: DomainAPI;
      Target: DomainAPI;
      Debugger: DomainAPI;
      WebAuthn: DomainAPI;
      close: () => Promise<void>;
      on: (event: string, cb: () => void) => void;
    };

    const pushCapped = <T>(arr: T[], item: T, max: number, kind?: string): void => {
      arr.push(item);
      while (arr.length > max) {
        const evicted = arr.shift();
        if (kind && evicted !== undefined) {
          void this._spoolWrite(name, kind, evicted);
        }
      }
    };

    const record = (requestId: string, patch: Partial<CapturedRequest>): void => {
      let entry = p.store.find((e) => e.requestId === requestId);
      if (!entry) {
        entry = { requestId, profile: name, timestamp: Date.now() };
        pushCapped(p.store, entry, MAX_REQUEST_PER_PROFILE, "requests");
      }
      Object.assign(entry, patch);
    };

    // ────────── Network domain ──────────

    (c.Network["requestWillBeSent"] as (cb: (e: {
      requestId: string;
      request: { url: string; method: string; headers: Record<string, string>; postData?: string };
      type?: string;
      initiator?: CDPInitiator;
      redirectResponse?: { url?: string; status: number; statusText?: string; headers: Record<string, string> };
      frameId?: string;
      documentURL?: string;
      timestamp: number;
    }) => void) => void)(({ requestId, request, type, initiator, redirectResponse, frameId, documentURL }) => {
      // 重定向：CDP 同 requestId 重 emit。把前一跳压进 redirectChain 后再覆盖
      if (redirectResponse) {
        const prev = p.store.find((x) => x.requestId === requestId);
        if (prev) {
          prev.redirectChain ??= [];
          prev.redirectChain.push({
            url: prev.request?.url ?? redirectResponse.url ?? "",
            method: prev.request?.method ?? "",
            status: redirectResponse.status,
            headers: redirectResponse.headers ?? {},
          });
        }
      }
      record(requestId, {
        request: {
          url: request.url,
          method: request.method,
          headers: request.headers ?? {},
          ...(request.postData ? { postData: request.postData } : {}),
        },
        resourceType: type,
        ...(initiator ? { initiator } : {}),
        ...(frameId ? { frameId } : {}),
        ...(documentURL ? { documentURL } : {}),
      });
    });

    (c.Network["requestWillBeSentExtraInfo"] as (cb: (e: {
      requestId: string;
      headers?: Record<string, string>;
      associatedCookies?: Array<{ cookie: { name: string; value: string; domain?: string; path?: string; httpOnly?: boolean; secure?: boolean } }>;
    }) => void) => void)(({ requestId, headers, associatedCookies }) => {
      const entry = p.store.find((e) => e.requestId === requestId);
      if (!entry?.request) {
        record(requestId, { request: { url: "", method: "", headers: headers ?? {} } });
      } else {
        entry.request.headers = { ...(entry.request.headers ?? {}), ...(headers ?? {}) };
      }
      if (associatedCookies?.length) {
        const e2 = p.store.find((x) => x.requestId === requestId);
        if (e2 && e2.request) {
          (e2.request as unknown as { associatedCookies?: unknown[] }).associatedCookies =
            associatedCookies.map((ac) => ac.cookie);
        }
      }
    });

    (c.Network["responseReceived"] as (cb: (e: {
      requestId: string;
      response: {
        status: number;
        statusText?: string;
        headers: Record<string, string>;
        mimeType?: string;
        timing?: CDPTiming;
        securityDetails?: CDPSecurityDetails;
        encodedDataLength?: number;
        fromDiskCache?: boolean;
        fromServiceWorker?: boolean;
        fromPrefetchCache?: boolean;
      };
      type?: string;
      frameId?: string;
    }) => void) => void)(({ requestId, response, type, frameId }) => {
      record(requestId, {
        response: {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers ?? {},
          mimeType: response.mimeType,
          ...(response.timing ? { timing: response.timing } : {}),
          ...(response.securityDetails ? { securityDetails: response.securityDetails } : {}),
          ...(typeof response.encodedDataLength === "number" ? { encodedDataLength: response.encodedDataLength } : {}),
          ...(response.fromDiskCache !== undefined ? { fromDiskCache: response.fromDiskCache } : {}),
          ...(response.fromServiceWorker !== undefined ? { fromServiceWorker: response.fromServiceWorker } : {}),
          ...(response.fromPrefetchCache !== undefined ? { fromPrefetchCache: response.fromPrefetchCache } : {}),
        },
        resourceType: type,
        ...(frameId ? { frameId } : {}),
      });
    });

    (c.Network["responseReceivedExtraInfo"] as (cb: (e: {
      requestId: string;
      headers?: Record<string, string>;
      blockedCookies?: unknown[];
    }) => void) => void)(({ requestId, headers }) => {
      const entry = p.store.find((e) => e.requestId === requestId);
      if (!entry?.response) {
        record(requestId, { response: { status: 0, headers: headers ?? {} } });
      } else {
        entry.response.headers = { ...(entry.response.headers ?? {}), ...(headers ?? {}) };
      }
    });

    // requestServedFromCache — 信号"这次没真发出去"
    (c.Network["requestServedFromCache"] as (cb: (e: { requestId: string }) => void) => void)(({ requestId }) => {
      record(requestId, { fromCache: true });
    });

    // dataReceived — 累计 transferSize（含 headers + body 的网络字节）
    (c.Network["dataReceived"] as (cb: (e: { requestId: string; dataLength?: number; encodedDataLength?: number }) => void) => void)(({ requestId, encodedDataLength }) => {
      const entry = p.store.find((e) => e.requestId === requestId);
      if (entry?.response && typeof encodedDataLength === "number") {
        entry.response.transferSize = (entry.response.transferSize ?? 0) + encodedDataLength;
      }
    });

    // signedExchangeReceived — SXG（attack surface for Signed Exchanges）
    (c.Network["signedExchangeReceived"] as (cb: (e: { requestId: string; info: unknown }) => void) => void)(({ requestId, info }) => {
      const entry = p.store.find((e) => e.requestId === requestId);
      if (entry) (entry as unknown as { signedExchange?: unknown }).signedExchange = info;
    });

    (c.Network["loadingFinished"] as (cb: (e: { requestId: string }) => void) => void)(async ({ requestId }) => {
      try {
        const result = (await (c.Network["getResponseBody"] as (p: unknown) => Promise<{ body: string; base64Encoded: boolean }>)({ requestId })) as { body: string; base64Encoded: boolean };
        const body = result.body ?? "";
        const bodyBytes = body.length;
        const entry = p.store.find((e) => e.requestId === requestId);
        const mimeType = entry?.response?.mimeType;
        const ext = pickExt(mimeType);
        const dir = join(BODY_STORE_DIR, name);
        const fname = `${requestId.replace(/[^a-zA-Z0-9_.-]/g, "_")}.${ext}`;
        const fullPath = join(dir, fname);
        try {
          await mkdir(dir, { recursive: true });
          const buf = result.base64Encoded ? Buffer.from(body, "base64") : Buffer.from(body, "utf-8");
          await writeFile(fullPath, buf);
          record(requestId, {
            bodyPath: fullPath,
            base64Encoded: result.base64Encoded,
            bodyBytes: result.base64Encoded ? buf.length : bodyBytes,
          });
        } catch (err) {
          this.logger.warn(`[cdp-traffic] write body failed ${fullPath}: ${err}`);
        }
      } catch (err) {
        this.logger.debug(`[cdp-traffic] getResponseBody skipped ${requestId}: ${(err as Error)?.message}`);
      }
    });

    (c.Network["loadingFailed"] as (cb: (e: { requestId: string; errorText?: string; blockedReason?: string }) => void) => void)(({ requestId, errorText, blockedReason }) => {
      record(requestId, {
        failed: true,
        failReason: errorText,
        ...(blockedReason ? { blockedReason } : {}),
      });
    });

    // WebSocket frames (现有)
    (c.Network["webSocketFrameSent"] as (cb: (e: { requestId: string; response: { payloadData: string; opcode?: number } }) => void) => void)(({ requestId, response }) => {
      const entry = p.store.find((e) => e.requestId === requestId);
      if (!entry) return;
      entry.ws ??= [];
      if (entry.ws.length < MAX_WS_FRAMES_PER_ENTRY)
        entry.ws.push({ direction: "tx", payload: response.payloadData, ts: Date.now(), opcode: response.opcode });
    });

    (c.Network["webSocketFrameReceived"] as (cb: (e: { requestId: string; response: { payloadData: string; opcode?: number } }) => void) => void)(({ requestId, response }) => {
      const entry = p.store.find((e) => e.requestId === requestId);
      if (!entry) return;
      entry.ws ??= [];
      if (entry.ws.length < MAX_WS_FRAMES_PER_ENTRY)
        entry.ws.push({ direction: "rx", payload: response.payloadData, ts: Date.now(), opcode: response.opcode });
    });

    // WebSocket lifecycle (新)
    (c.Network["webSocketCreated"] as (cb: (e: { requestId: string; url: string }) => void) => void)(({ requestId, url }) => {
      record(requestId, {
        request: { url, method: "GET", headers: {} },
        resourceType: "WebSocket",
        wsLifecycle: { created: { url, ts: Date.now() } },
      });
    });

    (c.Network["webSocketWillSendHandshakeRequest"] as (cb: (e: { requestId: string; request: { headers: Record<string, string> } }) => void) => void)(({ requestId, request }) => {
      const entry = p.store.find((e) => e.requestId === requestId);
      if (entry) {
        entry.wsLifecycle ??= {};
        entry.wsLifecycle.handshakeRequest = { headers: request.headers ?? {}, ts: Date.now() };
      }
    });

    (c.Network["webSocketHandshakeResponseReceived"] as (cb: (e: { requestId: string; response: { status: number; statusText?: string; headers: Record<string, string> } }) => void) => void)(({ requestId, response }) => {
      const entry = p.store.find((e) => e.requestId === requestId);
      if (entry) {
        entry.wsLifecycle ??= {};
        entry.wsLifecycle.handshakeResponse = {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers ?? {},
          ts: Date.now(),
        };
      }
    });

    (c.Network["webSocketClosed"] as (cb: (e: { requestId: string }) => void) => void)(({ requestId }) => {
      const entry = p.store.find((e) => e.requestId === requestId);
      if (entry) {
        entry.wsLifecycle ??= {};
        entry.wsLifecycle.closed = { ts: Date.now() };
      }
    });

    // WebSocket frame error — 帧解析错误 / 异常断连，以前漏接
    (c.Network["webSocketFrameError"] as (cb: (e: { requestId: string; errorMessage: string }) => void) => void)(({ requestId, errorMessage }) => {
      const entry = p.store.find((e) => e.requestId === requestId);
      if (entry) {
        entry.wsLifecycle ??= {};
        entry.wsLifecycle.closed = { ts: Date.now(), reason: errorMessage };
      }
    });

    // Server-Sent Events
    (c.Network["eventSourceMessageReceived"] as (cb: (e: { requestId: string; data: string; eventName?: string; eventId?: string }) => void) => void)(({ requestId, data, eventName, eventId }) => {
      const entry = p.store.find((e) => e.requestId === requestId);
      if (entry) {
        entry.sse ??= [];
        entry.sse.push({ data, eventName, eventId, ts: Date.now() });
      }
    });

    // ────────── Audits domain ──────────
    (c.Audits["issueAdded"] as (cb: (e: { issue: { code: string; details: unknown } }) => void) => void)(({ issue }) => {
      pushCapped(p.issues, {
        profile: name,
        timestamp: Date.now(),
        issueCode: issue.code,
        details: issue.details,
      }, MAX_AUDIT_ISSUES_PER_PROFILE, "issues");
    });

    // ────────── Security domain ──────────
    (c.Security["securityStateChanged"] as (cb: (e: { securityState: string; explanations?: unknown[] }) => void) => void)(({ securityState, explanations }) => {
      pushCapped(p.securityStates, {
        profile: name,
        timestamp: Date.now(),
        state: securityState,
        explanations: explanations as SecurityStateEvent["explanations"],
      }, MAX_SECURITY_PER_PROFILE, "security");
    });

    // ────────── Runtime domain ──────────
    (c.Runtime["consoleAPICalled"] as (cb: (e: {
      type: string;
      args: Array<{ type: string; subtype?: string; value?: unknown; description?: string; className?: string }>;
      executionContextId: number;
      timestamp: number;
      stackTrace?: { callFrames: Array<{ url: string; lineNumber: number; columnNumber: number; functionName: string }> };
    }, sessionId?: string) => void) => void)((e, sessionId) => {
      // DOM mutation routing: injected MutationObserver writes console.debug('__CDP_DOM__' + JSON)
      const firstArg = e.args?.[0];
      if (e.type === "debug" && firstArg?.type === "string" && typeof firstArg.value === "string" && firstArg.value.startsWith("__CDP_DOM__")) {
        try {
          const raw = JSON.parse(firstArg.value.slice(11)) as { t: string; g: string; an: number; rn: number; at: string; ov: string };
          pushCapped(p.domMutations, {
            profile: name,
            type: raw.t,
            target: raw.g,
            addedNodes: raw.an,
            removedNodes: raw.rn,
            attributeName: raw.at,
            oldValue: raw.ov,
            sessionId,
            timestamp: e.timestamp || Date.now(),
          }, MAX_DOM_MUTATIONS_PER_PROFILE, "domMutations");
        } catch { /* parse fail → skip */ }
        return;
      }
      pushCapped(p.consoleLogs, {
        profile: name,
        timestamp: e.timestamp || Date.now(),
        type: e.type,
        args: (e.args || []).map((a) => ({
          type: a.type,
          subtype: a.subtype,
          value: a.value,
          description: a.description,
          className: a.className,
        })),
        stackTrace: e.stackTrace,
        url: e.stackTrace?.callFrames?.[0]?.url,
        executionContextId: e.executionContextId,
      }, MAX_CONSOLE_PER_PROFILE, "console");
    });

    // Critical 2: Log.entryAdded — 浏览器自身警告（mixed content / CSP report / deprecation / network errors）
    // 这跟 Runtime.consoleAPICalled 是两个独立来源。两类都进 consoleLogs 同一 buffer。
    (c.Log["entryAdded"] as (cb: (e: {
      entry: {
        source: string; // "xml" | "javascript" | "network" | "storage" | "appcache" | "rendering" | "security" | "deprecation" | "worker" | "violation" | "intervention" | "recommendation" | "other"
        level: string; // "verbose" | "info" | "warning" | "error"
        text: string;
        timestamp: number; // ms since epoch
        url?: string;
        lineNumber?: number;
        stackTrace?: { callFrames: Array<{ url: string; lineNumber: number; columnNumber: number; functionName: string }> };
        networkRequestId?: string;
        workerId?: string;
      };
    }) => void) => void)(({ entry }) => {
      const args: ConsoleLog["args"] = [
        { type: "string", value: entry.text },
        { type: "string", value: `[source=${entry.source}]` },
      ];
      if (entry.networkRequestId) {
        args.push({ type: "string", value: `[networkRequestId=${entry.networkRequestId}]` });
      }
      if (entry.workerId) {
        args.push({ type: "string", value: `[workerId=${entry.workerId}]` });
      }
      pushCapped(p.consoleLogs, {
        profile: name,
        timestamp: entry.timestamp || Date.now(),
        type: entry.level, // verbose/info/warning/error
        args,
        stackTrace: entry.stackTrace,
        url: entry.url,
      }, MAX_CONSOLE_PER_PROFILE, "console");
    });

    (c.Runtime["exceptionThrown"] as (cb: (e: {
      timestamp: number;
      exceptionDetails: {
        text: string;
        url?: string;
        lineNumber?: number;
        columnNumber?: number;
        stackTrace?: { callFrames: Array<{ url: string; lineNumber: number; columnNumber: number; functionName: string }> };
        exception?: { type: string; subtype?: string; className?: string; description?: string; value?: unknown };
      };
    }) => void) => void)(({ exceptionDetails, timestamp }) => {
      pushCapped(p.exceptions, {
        profile: name,
        timestamp: timestamp || Date.now(),
        text: exceptionDetails.text,
        url: exceptionDetails.url,
        lineNumber: exceptionDetails.lineNumber,
        columnNumber: exceptionDetails.columnNumber,
        stackTrace: exceptionDetails.stackTrace,
        exception: exceptionDetails.exception
          ? {
              type: exceptionDetails.exception.type,
              subtype: exceptionDetails.exception.subtype,
              className: exceptionDetails.exception.className,
              description: exceptionDetails.exception.description,
              value: exceptionDetails.exception.value,
            }
          : undefined,
      }, MAX_EXCEPTIONS_PER_PROFILE, "exceptions");
    });

    // ────────── Page domain ──────────
    (c.Page["javascriptDialogOpening"] as (cb: (e: {
      url: string;
      message: string;
      type: string;
      defaultPrompt?: string;
      hasBrowserHandler?: boolean;
    }) => void) => void)((e) => {
      pushCapped(p.dialogs, {
        profile: name,
        timestamp: Date.now(),
        url: e.url,
        message: e.message,
        dialogType: e.type,
        defaultPrompt: e.defaultPrompt,
        hasBrowserHandler: e.hasBrowserHandler,
      }, MAX_DIALOGS_PER_PROFILE, "dialogs");
    });

    (c.Page["frameNavigated"] as (cb: (e: { frame: { id: string; parentId?: string; url: string; name?: string; loaderId?: string; mimeType?: string } }) => void) => void)(({ frame }) => {
      pushCapped(p.frameEvents, {
        profile: name,
        timestamp: Date.now(),
        type: "navigated",
        frameId: frame.id,
        parentFrameId: frame.parentId,
        url: frame.url,
        name: frame.name,
        loaderId: frame.loaderId,
        mimeType: frame.mimeType,
      }, MAX_FRAMES_PER_PROFILE, "frames");

      // Lazy origin tracking — Storage.indexedDBContentUpdated /
      // cacheStorageContentUpdated 不会自动 emit，必须 per-origin opt-in。
      // 每次 frameNavigated 提取 origin，未 track 过则 track。
      try {
        const u = new URL(frame.url);
        if (u.protocol === "http:" || u.protocol === "https:") {
          const origin = u.origin;
          if (!p.trackedOrigins.has(origin)) {
            p.trackedOrigins.add(origin);
            void (c.Storage["trackIndexedDBForOrigin"] as (q: unknown) => Promise<unknown>)({ origin })
              .catch((err: unknown) => this.logger.warn(`[cdp-traffic] ${name}: trackIndexedDB ${origin} failed: ${err}`));
            void (c.Storage["trackCacheStorageForOrigin"] as (q: unknown) => Promise<unknown>)({ origin })
              .catch((err: unknown) => this.logger.warn(`[cdp-traffic] ${name}: trackCacheStorage ${origin} failed: ${err}`));
          }
        }
      } catch {
        // frame.url 可能是 about:blank / data: / chrome:// — 不支持的 origin 跳过
      }
    });

    (c.Page["frameAttached"] as (cb: (e: { frameId: string; parentFrameId?: string }) => void) => void)((e) => {
      pushCapped(p.frameEvents, {
        profile: name,
        timestamp: Date.now(),
        type: "attached",
        frameId: e.frameId,
        parentFrameId: e.parentFrameId,
      }, MAX_FRAMES_PER_PROFILE, "frames");
    });

    (c.Page["frameDetached"] as (cb: (e: { frameId: string }) => void) => void)((e) => {
      pushCapped(p.frameEvents, {
        profile: name,
        timestamp: Date.now(),
        type: "detached",
        frameId: e.frameId,
      }, MAX_FRAMES_PER_PROFILE, "frames");
    });

    // Critical 4: frameStartedLoading / frameStoppedLoading（之前 schema 列了但 listener 没注册）
    (c.Page["frameStartedLoading"] as (cb: (e: { frameId: string }) => void) => void)((e) => {
      pushCapped(p.frameEvents, {
        profile: name,
        timestamp: Date.now(),
        type: "startedLoading",
        frameId: e.frameId,
      }, MAX_FRAMES_PER_PROFILE, "frames");
    });

    (c.Page["frameStoppedLoading"] as (cb: (e: { frameId: string }) => void) => void)((e) => {
      pushCapped(p.frameEvents, {
        profile: name,
        timestamp: Date.now(),
        type: "stoppedLoading",
        frameId: e.frameId,
      }, MAX_FRAMES_PER_PROFILE, "frames");
    });

    // ────────── Storage domain ──────────
    (c.Storage["indexedDBContentUpdated"] as (cb: (e: { origin: string; databaseName: string; objectStoreName: string }) => void) => void)((e) => {
      pushCapped(p.storageEvents, {
        profile: name,
        timestamp: Date.now(),
        type: "indexedDB.contentUpdated",
        origin: e.origin,
        databaseName: e.databaseName,
        objectStoreName: e.objectStoreName,
      }, MAX_STORAGE_PER_PROFILE, "storage");
    });

    (c.Storage["cacheStorageContentUpdated"] as (cb: (e: { origin: string; cacheName: string; storageKey?: string }) => void) => void)((e) => {
      pushCapped(p.storageEvents, {
        profile: name,
        timestamp: Date.now(),
        type: "cacheStorage.contentUpdated",
        origin: e.origin,
        cacheName: e.cacheName,
        storageKey: e.storageKey,
      }, MAX_STORAGE_PER_PROFILE, "storage");
    });

    // ────────── DOMStorage domain (localStorage / sessionStorage) ──────────
    type DomStorageEvent = { storageId: { securityOrigin: string; isLocalStorage: boolean }; key?: string; newValue?: string; oldValue?: string };

    (c.DOMStorage["domStorageItemAdded"] as (cb: (e: DomStorageEvent) => void) => void)((e) => {
      pushCapped(p.storageEvents, {
        profile: name,
        timestamp: Date.now(),
        type: "domStorage.itemAdded",
        origin: e.storageId.securityOrigin,
        isLocalStorage: e.storageId.isLocalStorage,
        itemKey: e.key,
        itemValue: e.newValue,
      }, MAX_STORAGE_PER_PROFILE, "storage");
    });

    (c.DOMStorage["domStorageItemUpdated"] as (cb: (e: DomStorageEvent) => void) => void)((e) => {
      pushCapped(p.storageEvents, {
        profile: name,
        timestamp: Date.now(),
        type: "domStorage.itemUpdated",
        origin: e.storageId.securityOrigin,
        isLocalStorage: e.storageId.isLocalStorage,
        itemKey: e.key,
        itemValue: e.newValue,
        itemOldValue: e.oldValue,
      }, MAX_STORAGE_PER_PROFILE, "storage");
    });

    (c.DOMStorage["domStorageItemRemoved"] as (cb: (e: DomStorageEvent) => void) => void)((e) => {
      pushCapped(p.storageEvents, {
        profile: name,
        timestamp: Date.now(),
        type: "domStorage.itemRemoved",
        origin: e.storageId.securityOrigin,
        isLocalStorage: e.storageId.isLocalStorage,
        itemKey: e.key,
      }, MAX_STORAGE_PER_PROFILE, "storage");
    });

    (c.DOMStorage["domStorageItemsCleared"] as (cb: (e: DomStorageEvent) => void) => void)((e) => {
      pushCapped(p.storageEvents, {
        profile: name,
        timestamp: Date.now(),
        type: "domStorage.cleared",
        origin: e.storageId.securityOrigin,
        isLocalStorage: e.storageId.isLocalStorage,
      }, MAX_STORAGE_PER_PROFILE, "storage");
    });

    // ────────── Fetch domain (capture-only mode + P2.I intercept control) ──────────
    // 无 intercept pattern → 记录 + 自动 continue（capture-only 模式）
    // 有 intercept pattern 匹配 → 记录 + 暂停，等 cdp_fetch_continue/fail 操作
    (c.Fetch["requestPaused"] as (cb: (e: {
      requestId: string;
      request: { url: string; method: string; headers: Record<string, string>; postData?: string };
      frameId?: string;
      resourceType?: string;
    }, sessionId?: string) => void) => void)(async (e, sessionId) => {
      const captured: CapturedRequest = {
        requestId: `fetch-${e.requestId}`,
        profile: name,
        timestamp: Date.now(),
        request: {
          url: e.request.url,
          method: e.request.method,
          headers: e.request.headers ?? {},
          ...(e.request.postData ? { postData: e.request.postData } : {}),
        },
        resourceType: e.resourceType,
        ...(e.frameId ? { frameId: e.frameId } : {}),
      };
      pushCapped(p.fetchPaused, captured, MAX_REQUEST_PER_PROFILE, "fetch");

      // Check intercept patterns — if any pattern substring-matches the URL, pause
      let shouldIntercept = false;
      for (const pattern of p.fetchInterceptState.patterns) {
        if (e.request.url.includes(pattern)) {
          shouldIntercept = true;
          break;
        }
      }

      if (shouldIntercept) {
        // Pause: store in pending map with 30s auto-continue timeout
        const timer = setTimeout(() => {
          const entry = p.fetchInterceptState.paused.get(captured.requestId);
          if (entry) {
            p.fetchInterceptState.paused.delete(captured.requestId);
            void (c.Fetch["continueRequest"] as (q: unknown) => Promise<unknown>)({ requestId: e.requestId })
              .catch(() => {});
          }
        }, 30_000);
        p.fetchInterceptState.paused.set(captured.requestId, {
          requestId: e.requestId,
          captured,
          timer,
        });
      } else {
        // Auto-continue (capture-only mode)
        try {
          await (c.Fetch["continueRequest"] as (q: unknown) => Promise<unknown>)({ requestId: e.requestId });
        } catch {
          // Fetch.continueRequest may throw if the target detached mid-flight
        }
      }
    });

    // ────────── Debugger domain (scriptParsed only) ──────────
    // 只订阅 scriptParsed — 不全开 Debugger（太重，会让浏览器变慢）
    // scriptParsed 给浏览器编译后的 JS 元数据（url / sourceMapURL / hash / isModule / length）
    // ────────── WebAuthn domain (P2.J) ──────────
    // 订阅 credentialAdded/Asserted — passkey target 出现时抓 WebAuthn 调用
    (c["WebAuthn"] as {
      credentialAdded?: (cb: (e: { credential?: { credentialId?: string; rpId?: string }; authenticatorId?: string }) => void) => void;
      credentialAsserted?: (cb: (e: { credential?: { credentialId?: string; rpId?: string }; authenticatorId?: string }) => void) => void;
    } | undefined)?.["credentialAdded"]?.((e) => {
      pushCapped(p.webauthnEvents, {
        profile: name,
        type: "credentialAdded",
        rpId: e.credential?.rpId,
        credentialId: e.credential?.credentialId,
        timestamp: Date.now(),
      }, MAX_WEBAUTHN_EVENTS_PER_PROFILE, "webauthn");
    });
    (c["WebAuthn"] as {
      credentialAsserted?: (cb: (e: { credential?: { credentialId?: string; rpId?: string }; authenticatorId?: string }) => void) => void;
    } | undefined)?.["credentialAsserted"]?.((e) => {
      pushCapped(p.webauthnEvents, {
        profile: name,
        type: "credentialAsserted",
        rpId: e.credential?.rpId,
        credentialId: e.credential?.credentialId,
        timestamp: Date.now(),
      }, MAX_WEBAUTHN_EVENTS_PER_PROFILE, "webauthn");
    });

    (c.Debugger["scriptParsed"] as (cb: (e: {
      scriptId: string;
      url: string;
      startLine?: number;
      startColumn?: number;
      endLine?: number;
      endColumn?: number;
      executionContextId?: number;
      hash?: string;
      isModule?: boolean;
      length?: number;
      sourceMapURL?: string;
      hasSourceURL?: boolean;
    }, sessionId?: string) => void) => void)(({ scriptId, url, sourceMapURL, hash, isModule, length }, sessionId) => {
      pushCapped(p.scripts, {
        profile: name,
        scriptId,
        url,
        sourceMapURL,
        hash,
        isModule,
        length,
        sessionId,
        timestamp: Date.now(),
      }, MAX_SCRIPTS_PER_PROFILE, "scripts");
    });

    // ────────── Enable all domains ──────────
    // Network 是 must-have；其他 domain 失败时单独 swallow（不同版本 Chrome 支持不一致）
    await (c.Network["enable"] as () => Promise<void>)();
    await Promise.all([
      (c.Audits["enable"] as () => Promise<void>)().catch((e: unknown) => this.logger.warn(`[cdp-traffic] ${name}: Audits.enable failed: ${e}`)),
      (c.Security["enable"] as () => Promise<void>)().catch((e: unknown) => this.logger.warn(`[cdp-traffic] ${name}: Security.enable failed: ${e}`)),
      (c.Runtime["enable"] as () => Promise<void>)().then(() => {
        void this._injectDomObserver(name, c as { Runtime: Record<string, (...args: unknown[]) => Promise<unknown>> });
      }).catch((e: unknown) => this.logger.warn(`[cdp-traffic] ${name}: Runtime.enable failed: ${e}`)),
      (c.Page["enable"] as () => Promise<void>)().catch((e: unknown) => this.logger.warn(`[cdp-traffic] ${name}: Page.enable failed: ${e}`)),
      (c.DOMStorage["enable"] as () => Promise<void>)().catch((e: unknown) => this.logger.warn(`[cdp-traffic] ${name}: DOMStorage.enable failed: ${e}`)),
      (c.Log["enable"] as () => Promise<void>)().catch((e: unknown) => this.logger.warn(`[cdp-traffic] ${name}: Log.enable failed: ${e}`)),
      // Fetch.enable 不传 patterns = 拦截所有请求
      (c.Fetch["enable"] as (q?: unknown) => Promise<void>)({}).catch((e: unknown) => this.logger.warn(`[cdp-traffic] ${name}: Fetch.enable failed: ${e}`)),
      (c.Debugger["enable"] as () => Promise<void>)().catch((e: unknown) => this.logger.warn(`[cdp-traffic] ${name}: Debugger.enable failed: ${e}`)),
      (c["WebAuthn"] as { enable: () => Promise<void> } | undefined)?.["enable"]?.().catch((e: unknown) => this.logger.warn(`[cdp-traffic] ${name}: WebAuthn.enable failed: ${e}`)),
      // Storage 没有顶层 enable，需要 per-origin track（高级用法，留给 backlog）。这里跳过。
    ]);

    // ────────── OOPIF: cross-origin iframe capture ──────────
    // flaten=true means child target events arrive on this WS with sessionId routing.
    // Existing Network/Fetch/Audits/etc handlers auto-receive child events — they
    // ignore the extra sessionId arg and process params normally.

    const enableChildSession = async (sessionId: string): Promise<void> => {
      await Promise.all([
        (c.Network["enable"] as (q: unknown, sid?: string) => Promise<void>)({}, sessionId).catch((e: unknown) => this.logger.warn(`[cdp-traffic] ${name}: child Network.enable(${sessionId}) failed: ${e}`)),
        (c.Fetch["enable"] as (q?: unknown, sid?: string) => Promise<void>)({}, sessionId).catch((e: unknown) => this.logger.warn(`[cdp-traffic] ${name}: child Fetch.enable(${sessionId}) failed: ${e}`)),
        (c.Audits["enable"] as (q: unknown, sid?: string) => Promise<void>)({}, sessionId).catch((e: unknown) => this.logger.warn(`[cdp-traffic] ${name}: child Audits.enable(${sessionId}) failed: ${e}`)),
        (c.Security["enable"] as (q: unknown, sid?: string) => Promise<void>)({}, sessionId).catch((e: unknown) => this.logger.warn(`[cdp-traffic] ${name}: child Security.enable(${sessionId}) failed: ${e}`)),
        (c.Runtime["enable"] as (q: unknown, sid?: string) => Promise<void>)({}, sessionId).then(() => {
          void this._injectDomObserver(name, c as { Runtime: Record<string, (...args: unknown[]) => Promise<unknown>> }, sessionId);
        }).catch((e: unknown) => this.logger.warn(`[cdp-traffic] ${name}: child Runtime.enable(${sessionId}) failed: ${e}`)),
        (c.Log["enable"] as (q: unknown, sid?: string) => Promise<void>)({}, sessionId).catch((e: unknown) => this.logger.warn(`[cdp-traffic] ${name}: child Log.enable(${sessionId}) failed: ${e}`)),
        (c.Debugger["enable"] as (q: unknown, sid?: string) => Promise<void>)({}, sessionId).catch((e: unknown) => this.logger.warn(`[cdp-traffic] ${name}: child Debugger.enable(${sessionId}) failed: ${e}`)),
        (c["WebAuthn"] as { enable: (q: unknown, sid?: string) => Promise<void> } | undefined)?.["enable"]?.({}, sessionId).catch((e: unknown) => this.logger.warn(`[cdp-traffic] ${name}: child WebAuthn.enable(${sessionId}) failed: ${e}`)),
        // Recursive: nested iframes (grandchildren) also get auto-attached
        (c.Target["setAutoAttach"] as (q: unknown, sid?: string) => Promise<void>)(
          { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
          sessionId,
        ).catch((e: unknown) => this.logger.warn(`[cdp-traffic] ${name}: child Target.setAutoAttach(${sessionId}) failed: ${e}`)),
      ]);
    };

    // Subscribe to Target.attachedToTarget BEFORE calling setAutoAttach
    // (race-free: we won't miss any child target that attaches between enable and subscribe)
    (c.Target["attachedToTarget"] as (cb: (params: { sessionId: string; targetInfo: { type: string; url: string; title?: string }; waitingForDebugger: boolean }, sessionId?: string) => void) => void)((params) => {
      const ti = params.targetInfo;
      if (ti.type === "iframe" || ti.type === "webview" || ti.type === "worker" || ti.type === "service_worker") {
        void enableChildSession(params.sessionId);
        if (ti.type === "iframe" || ti.type === "webview") {
          this.logger.info(`[cdp-traffic] ${name}: OOPIF ${ti.type} attached url=${ti.url} session=${params.sessionId}`);
        } else if (ti.type === "service_worker") {
          this.logger.info(`[cdp-traffic] ${name}: ServiceWorker attached url=${ti.url} session=${params.sessionId}`);
        }
      }
    });

    // Initiate auto-attach on this page target — child targets will fire
    // Target.attachedToTarget above
    try {
      await (c.Target["setAutoAttach"] as (q: unknown) => Promise<void>)({
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
      this.logger.info(`[cdp-traffic] ${name}: Target.setAutoAttach enabled (flatten=true)`);
    } catch (err) {
      this.logger.warn(`[cdp-traffic] ${name}: Target.setAutoAttach failed: ${err}`);
    }

    const targetId = target.id;
    c.on("disconnect", () => {
      p.clients.delete(client);
      p.connectedTargetIds.delete(targetId);
    });
  }

  query(profile: string, filters: {
    url_contains?: string;
    method?: string;
    status?: number;
    resource_type?: string;
    after?: string;
    limit?: number;
  }): CapturedRequest[] {
    const p = this.profiles.get(profile);
    if (!p) return [];
    let rows = [...p.store];
    if (filters.url_contains) {
      const needle = filters.url_contains.toLowerCase();
      rows = rows.filter((r) => r.request?.url?.toLowerCase().includes(needle));
    }
    if (filters.method) {
      const m = filters.method.toUpperCase();
      rows = rows.filter((r) => r.request?.method?.toUpperCase() === m);
    }
    if (typeof filters.status === "number") {
      rows = rows.filter((r) => r.response?.status === filters.status);
    }
    if (filters.resource_type) {
      const rt = filters.resource_type.toLowerCase();
      rows = rows.filter((r) => r.resourceType?.toLowerCase() === rt);
    }
    if (filters.after) {
      const afterMs = new Date(filters.after).getTime();
      if (!Number.isNaN(afterMs)) rows = rows.filter((r) => r.timestamp > afterMs);
    }
    const limit = filters.limit ?? 50;
    return rows.slice(-limit);
  }

  detail(profile: string, requestId: string): CapturedRequest | null {
    const p = this.profiles.get(profile);
    if (!p) return null;
    // 检查 store + fetchPaused 两个 buffer
    return p.store.find((r) => r.requestId === requestId)
      ?? p.fetchPaused.find((r) => r.requestId === requestId)
      ?? null;
  }

  // ────────── 7 个新 query 函数（按事件类型分） ──────────

  queryAudits(profile: string, filters: { issue_code?: string; after?: string; limit?: number }): AuditIssue[] {
    const p = this.profiles.get(profile);
    if (!p) return [];
    let rows = [...p.issues];
    if (filters.issue_code) {
      const needle = filters.issue_code.toLowerCase();
      rows = rows.filter((r) => r.issueCode.toLowerCase().includes(needle));
    }
    if (filters.after) {
      const afterMs = new Date(filters.after).getTime();
      if (!Number.isNaN(afterMs)) rows = rows.filter((r) => r.timestamp > afterMs);
    }
    return rows.slice(-(filters.limit ?? 50));
  }

  queryConsole(profile: string, filters: { log_type?: string; text_contains?: string; after?: string; limit?: number }): ConsoleLog[] {
    const p = this.profiles.get(profile);
    if (!p) return [];
    let rows = [...p.consoleLogs];
    if (filters.log_type) {
      const t = filters.log_type.toLowerCase();
      rows = rows.filter((r) => r.type.toLowerCase() === t);
    }
    if (filters.text_contains) {
      const needle = filters.text_contains.toLowerCase();
      rows = rows.filter((r) =>
        r.args.some((a) => {
          const s = (a.value ?? a.description ?? "").toString().toLowerCase();
          return s.includes(needle);
        })
      );
    }
    if (filters.after) {
      const afterMs = new Date(filters.after).getTime();
      if (!Number.isNaN(afterMs)) rows = rows.filter((r) => r.timestamp > afterMs);
    }
    return rows.slice(-(filters.limit ?? 100));
  }

  queryExceptions(profile: string, filters: { text_contains?: string; after?: string; limit?: number }): RuntimeException[] {
    const p = this.profiles.get(profile);
    if (!p) return [];
    let rows = [...p.exceptions];
    if (filters.text_contains) {
      const needle = filters.text_contains.toLowerCase();
      rows = rows.filter((r) => r.text.toLowerCase().includes(needle));
    }
    if (filters.after) {
      const afterMs = new Date(filters.after).getTime();
      if (!Number.isNaN(afterMs)) rows = rows.filter((r) => r.timestamp > afterMs);
    }
    return rows.slice(-(filters.limit ?? 50));
  }

  queryDialogs(profile: string, filters: { dialog_type?: string; after?: string; limit?: number }): PageDialog[] {
    const p = this.profiles.get(profile);
    if (!p) return [];
    let rows = [...p.dialogs];
    if (filters.dialog_type) {
      const t = filters.dialog_type.toLowerCase();
      rows = rows.filter((r) => r.dialogType.toLowerCase() === t);
    }
    if (filters.after) {
      const afterMs = new Date(filters.after).getTime();
      if (!Number.isNaN(afterMs)) rows = rows.filter((r) => r.timestamp > afterMs);
    }
    return rows.slice(-(filters.limit ?? 50));
  }

  querySecurity(profile: string, filters: { state?: string; after?: string; limit?: number }): SecurityStateEvent[] {
    const p = this.profiles.get(profile);
    if (!p) return [];
    let rows = [...p.securityStates];
    if (filters.state) {
      const s = filters.state.toLowerCase();
      rows = rows.filter((r) => r.state.toLowerCase() === s);
    }
    if (filters.after) {
      const afterMs = new Date(filters.after).getTime();
      if (!Number.isNaN(afterMs)) rows = rows.filter((r) => r.timestamp > afterMs);
    }
    return rows.slice(-(filters.limit ?? 50));
  }

  queryStorage(profile: string, filters: { type?: string; origin?: string; key_contains?: string; after?: string; limit?: number }): StorageWriteEvent[] {
    const p = this.profiles.get(profile);
    if (!p) return [];
    let rows = [...p.storageEvents];
    if (filters.type) {
      const t = filters.type.toLowerCase();
      rows = rows.filter((r) => r.type.toLowerCase().includes(t));
    }
    if (filters.origin) {
      const o = filters.origin.toLowerCase();
      rows = rows.filter((r) => r.origin?.toLowerCase().includes(o));
    }
    if (filters.key_contains) {
      const k = filters.key_contains.toLowerCase();
      rows = rows.filter((r) => r.itemKey?.toLowerCase().includes(k));
    }
    if (filters.after) {
      const afterMs = new Date(filters.after).getTime();
      if (!Number.isNaN(afterMs)) rows = rows.filter((r) => r.timestamp > afterMs);
    }
    return rows.slice(-(filters.limit ?? 100));
  }

  queryFrames(profile: string, filters: { type?: string; url_contains?: string; after?: string; limit?: number }): FrameLifecycleEvent[] {
    const p = this.profiles.get(profile);
    if (!p) return [];
    let rows = [...p.frameEvents];
    if (filters.type) {
      const t = filters.type.toLowerCase();
      rows = rows.filter((r) => r.type.toLowerCase() === t);
    }
    if (filters.url_contains) {
      const needle = filters.url_contains.toLowerCase();
      rows = rows.filter((r) => r.url?.toLowerCase().includes(needle));
    }
    if (filters.after) {
      const afterMs = new Date(filters.after).getTime();
      if (!Number.isNaN(afterMs)) rows = rows.filter((r) => r.timestamp > afterMs);
    }
    return rows.slice(-(filters.limit ?? 50));
  }

  queryFetchPaused(profile: string, filters: { url_contains?: string; method?: string; after?: string; limit?: number }): CapturedRequest[] {
    const p = this.profiles.get(profile);
    if (!p) return [];
    let rows = [...p.fetchPaused];
    if (filters.url_contains) {
      const needle = filters.url_contains.toLowerCase();
      rows = rows.filter((r) => r.request?.url?.toLowerCase().includes(needle));
    }
    if (filters.method) {
      const m = filters.method.toUpperCase();
      rows = rows.filter((r) => r.request?.method?.toUpperCase() === m);
    }
    if (filters.after) {
      const afterMs = new Date(filters.after).getTime();
      if (!Number.isNaN(afterMs)) rows = rows.filter((r) => r.timestamp > afterMs);
    }
    return rows.slice(-(filters.limit ?? 50));
  }

  getFetchInterceptPaused(profile: string): Array<{ requestId: string; capturedRequestId: string; cdpRequestId: string; url: string; method: string; headers: Record<string, string>; postData?: string; capturedAt: string; timerRemainingMs: number; next: Record<string, string> }> {
    const p = this.profiles.get(profile);
    if (!p) return [];
    const result: Array<{ requestId: string; capturedRequestId: string; cdpRequestId: string; url: string; method: string; headers: Record<string, string>; postData?: string; capturedAt: string; timerRemainingMs: number; next: Record<string, string> }> = [];
    for (const [capturedId, entry] of p.fetchInterceptState.paused) {
      result.push({
        requestId: capturedId,
        capturedRequestId: capturedId,
        cdpRequestId: entry.requestId,
        url: entry.captured.request?.url ?? "",
        method: entry.captured.request?.method ?? "",
        headers: entry.captured.request?.headers ?? {},
        postData: entry.captured.request?.postData,
        capturedAt: new Date(entry.captured.timestamp).toISOString(),
        timerRemainingMs: Math.max(0, 30_000 - (Date.now() - entry.captured.timestamp)),
        next: {
          continue: `agent-browser intercept continue ${capturedId} --profile ${profile}`,
          fail: `agent-browser intercept fail ${capturedId} --profile ${profile}`,
        },
      });
    }
    return result;
  }

  async fetchContinue(profile: string, capturedRequestId: string, options: FetchContinueOptions = {}): Promise<{ ok: boolean; error?: string; rewriteBoundary?: Record<string, unknown> }> {
    const p = this.profiles.get(profile);
    if (!p) return { ok: false, error: `profile not found: ${profile}` };
    const entry = p.fetchInterceptState.paused.get(capturedRequestId)
      ?? [...p.fetchInterceptState.paused.values()].find((candidate) => candidate.requestId === capturedRequestId);
    if (!entry) return { ok: false, error: `request not found or already released: ${capturedRequestId}` };
    clearTimeout(entry.timer);
    const storedId = [...p.fetchInterceptState.paused.entries()].find(([, candidate]) => candidate === entry)?.[0] ?? capturedRequestId;
    p.fetchInterceptState.paused.delete(storedId);
    const client = [...p.clients][0] as { Fetch: Record<string, (...args: unknown[]) => Promise<unknown>> } | undefined;
    if (!client) return { ok: false, error: "no active CDP client" };
    try {
      const originalHeaders = entry.captured.request?.headers ?? {};
      const removeHeaders = new Set((options.removeHeaders ?? []).map((name) => name.toLowerCase()));
      const headerOverrides = options.headerOverrides ?? {};
      const hasBodyOverride = options.body !== undefined || options.bodyBase64 !== undefined || options.json !== undefined;
      if (hasBodyOverride && !Object.keys(headerOverrides).some((name) => name.toLowerCase() === "content-length")) {
        removeHeaders.add("content-length");
      }
      const mergedHeaders = { ...originalHeaders, ...headerOverrides };
      const headers = Object.entries(mergedHeaders)
        .filter(([name]) => !removeHeaders.has(name.toLowerCase()))
        .map(([name, value]) => ({ name, value }));
      const bodyText = options.json !== undefined
        ? JSON.stringify(options.json)
        : options.body;
      const postData = options.bodyBase64
        ?? (bodyText !== undefined ? Buffer.from(bodyText, "utf8").toString("base64") : undefined);
      const continueParams = {
        requestId: entry.requestId,
        ...(options.url ? { url: options.url } : {}),
        ...(options.method ? { method: options.method.toUpperCase() } : {}),
        ...(headers.length ? { headers } : {}),
        ...(postData !== undefined ? { postData } : {}),
      };
      await (client.Fetch["continueRequest"] as (q: unknown) => Promise<unknown>)(continueParams);
      return {
        ok: true,
        rewriteBoundary: {
          mode: "cdp-fetch-in-flight",
          source: "Fetch.continueRequest",
          capturedRequestId: storedId,
          cdpRequestId: entry.requestId,
          changed: {
            url: Boolean(options.url),
            method: Boolean(options.method),
            headers: Object.keys(headerOverrides),
            removedHeaders: [...removeHeaders],
            body: postData !== undefined,
          },
          bodyEncoding: postData !== undefined ? "base64-over-cdp-json" : "none",
          note: "This continues a real browser request paused before it leaves the browser. It is not a page fetch replay.",
        },
      };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async fetchFail(profile: string, capturedRequestId: string, errorReason: string): Promise<{ ok: boolean; error?: string }> {
    const p = this.profiles.get(profile);
    if (!p) return { ok: false, error: `profile not found: ${profile}` };
    const entry = p.fetchInterceptState.paused.get(capturedRequestId)
      ?? [...p.fetchInterceptState.paused.values()].find((candidate) => candidate.requestId === capturedRequestId);
    if (!entry) return { ok: false, error: `request not found or already released: ${capturedRequestId}` };
    clearTimeout(entry.timer);
    const storedId = [...p.fetchInterceptState.paused.entries()].find(([, candidate]) => candidate === entry)?.[0] ?? capturedRequestId;
    p.fetchInterceptState.paused.delete(storedId);
    const client = [...p.clients][0] as { Fetch: Record<string, (...args: unknown[]) => Promise<unknown>> } | undefined;
    if (!client) return { ok: false, error: "no active CDP client" };
    try {
      await (client.Fetch["failRequest"] as (q: unknown) => Promise<unknown>)({
        requestId: entry.requestId,
        errorReason,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  queryDomMutations(profile: string, filters: {
    type?: string;
    target_contains?: string;
    after?: string;
    before?: string;
    limit?: number;
  }): DomMutation[] {
    const p = this.profiles.get(profile);
    if (!p) return [];
    let rows = [...p.domMutations];
    if (filters.type) {
      const t = filters.type.toLowerCase();
      rows = rows.filter((r) => r.type.toLowerCase() === t);
    }
    if (filters.target_contains) {
      const needle = filters.target_contains.toLowerCase();
      rows = rows.filter((r) => r.target.toLowerCase().includes(needle));
    }
    if (filters.after) {
      const afterMs = new Date(filters.after).getTime();
      if (!Number.isNaN(afterMs)) rows = rows.filter((r) => r.timestamp > afterMs);
    }
    if (filters.before) {
      const beforeMs = new Date(filters.before).getTime();
      if (!Number.isNaN(beforeMs)) rows = rows.filter((r) => r.timestamp < beforeMs);
    }
    return rows.slice(-(filters.limit ?? 100));
  }

  queryWebAuthn(profile: string, filters: {
    type?: string;
    after?: string;
    limit?: number;
  }): WebAuthnEvent[] {
    const p = this.profiles.get(profile);
    if (!p) return [];
    let rows = [...p.webauthnEvents];
    if (filters.type) {
      const t = filters.type.toLowerCase();
      rows = rows.filter((r) => r.type.toLowerCase() === t);
    }
    if (filters.after) {
      const afterMs = new Date(filters.after).getTime();
      if (!Number.isNaN(afterMs)) rows = rows.filter((r) => r.timestamp > afterMs);
    }
    return rows.slice(-(filters.limit ?? 50));
  }

  queryScripts(profile: string, filters: {
    url_contains?: string;
    hostname?: string;
    has_source_map?: boolean;
    is_module?: boolean;
    after?: string;
    before?: string;
    limit?: number;
  }): ScriptParsedEntry[] {
    const p = this.profiles.get(profile);
    if (!p) return [];
    let rows = [...p.scripts];
    if (filters.url_contains) {
      const needle = filters.url_contains.toLowerCase();
      rows = rows.filter((r) => r.url.toLowerCase().includes(needle));
    }
    if (filters.hostname) {
      const needle = filters.hostname.toLowerCase();
      rows = rows.filter((r) => {
        try { return new URL(r.url).hostname.toLowerCase() === needle; }
        catch { return false; }
      });
    }
    if (filters.has_source_map === true) {
      rows = rows.filter((r) => !!r.sourceMapURL);
    } else if (filters.has_source_map === false) {
      rows = rows.filter((r) => !r.sourceMapURL);
    }
    if (filters.is_module === true) {
      rows = rows.filter((r) => r.isModule === true);
    } else if (filters.is_module === false) {
      rows = rows.filter((r) => !r.isModule);
    }
    if (filters.after) {
      const afterMs = new Date(filters.after).getTime();
      if (!Number.isNaN(afterMs)) rows = rows.filter((r) => r.timestamp > afterMs);
    }
    if (filters.before) {
      const beforeMs = new Date(filters.before).getTime();
      if (!Number.isNaN(beforeMs)) rows = rows.filter((r) => r.timestamp < beforeMs);
    }
    return rows.slice(-(filters.limit ?? 100));
  }

  async getScriptSource(profile: string, scriptId: string): Promise<{ scriptSource: string; scriptId: string }> {
    const p = this.profiles.get(profile);
    if (!p) throw new Error(`profile not found: ${profile}`);
    const client = [...p.clients][0] as {
      Debugger: Record<string, (...args: unknown[]) => Promise<{ scriptSource: string }>>;
    } | undefined;
    if (!client) throw new Error(`profile ${profile} has no active CDP client`);
    const result = await (client.Debugger["getScriptSource"] as (q: unknown) => Promise<{ scriptSource: string }>)({ scriptId });
    return { scriptSource: result.scriptSource, scriptId };
  }

  async getCookies(profile: string, urls: string[]): Promise<unknown[]> {
    const p = this.profiles.get(profile);
    if (!p) throw new Error(`profile not found: ${profile}`);
    // Use any connected client from this profile
    const client = [...p.clients][0] as {
      Network: Record<string, (...args: unknown[]) => Promise<{ cookies?: unknown[] }>>;
    } | undefined;
    if (!client) throw new Error(`profile ${profile} has no active CDP client`);
    const result = await (client.Network["getCookies"] as (p: unknown) => Promise<{ cookies?: unknown[] }>)({ urls });
    return result.cookies ?? [];
  }

  async clearCookies(
    profile: string,
    opts: { domain?: string; name?: string; url?: string },
  ): Promise<{ cleared: number | "all"; mode: string }> {
    const p = this.profiles.get(profile);
    if (!p) throw new Error(`profile not found: ${profile}`);
    const client = [...p.clients][0] as {
      Network: Record<string, (...args: unknown[]) => Promise<unknown>>;
    } | undefined;
    if (!client) throw new Error(`profile ${profile} has no active CDP client`);

    if (opts.name) {
      // name-mode：CDP 要求同时给 url 或 domain 才能定位 cookie jar
      if (!opts.domain && !opts.url) {
        throw new Error("name 模式必须同时传 domain 或 url（CDP 要求），否则会静默不删");
      }
      await (client.Network["deleteCookies"] as (p: unknown) => Promise<unknown>)({
        name: opts.name,
        ...(opts.domain ? { domain: opts.domain } : {}),
        ...(opts.url ? { url: opts.url } : {}),
      });
      return { cleared: 1, mode: "by-name" };
    }

    if (opts.domain) {
      // domain-only: list all cookies for that domain (含 .domain 后缀子域), delete each
      const all = (await (client.Network["getAllCookies"] as () => Promise<{
        cookies?: Array<{ name: string; domain: string }>;
      }>)()).cookies ?? [];
      const matching = all.filter(
        (c) => c.domain === opts.domain || c.domain.endsWith(`.${opts.domain}`),
      );
      for (const c of matching) {
        await (client.Network["deleteCookies"] as (p: unknown) => Promise<unknown>)({
          name: c.name,
          domain: c.domain,
        });
      }
      return { cleared: matching.length, mode: "by-domain" };
    }

    // clearAll：无 filter
    await (client.Network["clearBrowserCookies"] as () => Promise<unknown>)();
    return { cleared: "all", mode: "all" };
  }

  stats(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, p] of this.profiles) {
      out[name] = {
        endpoint: p.endpoint.kind,
        cdpPort: p.endpoint.kind === "port" ? p.endpoint.cdpPort : undefined,
        cdpUrl: p.endpoint.kind === "url" ? p.endpoint.cdpUrl : undefined,
        connected: p.clients.size > 0,
        captured: p.store.length,
        newest: p.store[p.store.length - 1]?.timestamp,
        // 各类事件 buffer 当前条数
        events: {
          requests: p.store.length,
          fetchPaused: p.fetchPaused.length,
          issues: p.issues.length,
          consoleLogs: p.consoleLogs.length,
          exceptions: p.exceptions.length,
          dialogs: p.dialogs.length,
          securityStates: p.securityStates.length,
          storageEvents: p.storageEvents.length,
          frameEvents: p.frameEvents.length,
          scripts: p.scripts.length,
          domMutations: p.domMutations.length,
          webauthnEvents: p.webauthnEvents.length,
        },
      };
    }
    return out;
  }

  /** Inject a MutationObserver IIFE via Runtime.evaluate — 抓 JS 动态 DOM 变化
   *  (XSS injection sink / 动态 form / iframe / script 注入)。
   *  observer 把 mutations 序列化成 console.debug('__CDP_DOM__' + JSON)。
   *  用唯一全局变量名 + IIFE + try/catch 防 page JS 冲突。 */
  private async _injectDomObserver(
    profile: string,
    client: { Runtime: Record<string, (...args: unknown[]) => Promise<unknown>> },
    sessionId?: string,
  ): Promise<void> {
    const varName = _domMutationVar();
    const code = `(function(){if(window.${varName})return;window.${varName}=true;try{new MutationObserver(function(m){for(var i=0;i<m.length;i++){var r=m[i];console.debug('__CDP_DOM__'+JSON.stringify({t:r.type,g:(r.target.nodeName||'')+(r.target.id?'#'+r.target.id:'')+(r.target.className?'.'+r.target.className.split(' ').join('.'):''),an:r.addedNodes?r.addedNodes.length:0,rn:r.removedNodes?r.removedNodes.length:0,at:r.attributeName||'',ov:(r.oldValue||'').slice(0,200)}))}}).observe(document.documentElement,{childList:true,subtree:true,attributes:true,characterData:true,attributeOldValue:true,characterDataOldValue:true})}catch(e){}})();`;
    try {
      if (sessionId) {
        await (client.Runtime["evaluate"] as (q: unknown, sid?: string) => Promise<unknown>)(
          { expression: code },
          sessionId,
        );
      } else {
        await (client.Runtime["evaluate"] as (q: unknown) => Promise<unknown>)({ expression: code });
      }
    } catch {
      // silent — page 可能还没 load DOM
    }
  }

  /** Spool evicted ring-buffer entries to disk ($CDP_SECURITY_DATA_DIR/cdp-spool/<profile>/<date>.jsonl).
   *  Best-effort: write failures are logged but never thrown — audit path must not
   *  block the main capture path. */
  private async _spoolWrite(profile: string, kind: string, entry: unknown): Promise<void> {
    try {
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10);
      const dir = join(SPOOL_DIR, profile);
      await mkdir(dir, { recursive: true });
      const line = JSON.stringify({ ts: now.toISOString(), kind, entry }) + "\n";
      await appendFile(join(dir, `${dateStr}.jsonl`), line, "utf-8");
    } catch (err) {
      this.logger.warn(`[cdp-traffic] spool write failed ${profile}/${kind}: ${err}`);
    }
  }

  /** 暴露 ProfileState 给 register 层 — diagnostic 需要 buffer size + connected 状态 */
  getProfile(profile: string): ProfileState | undefined {
    return this.profiles.get(profile);
  }

  /** L5: 健康检查 — 检测 capture 是否真的工作 */
  runSelfTest(profileName: string): Record<string, unknown> {
    const p = this.profiles.get(profileName);
    if (!p) {
      return {
        profile: profileName,
        ok: false,
        error: `unknown profile '${profileName}'`,
        knownProfiles: Array.from(this.profiles.keys()),
      };
    }
    const connected = p.clients.size > 0;
    const mkHealth = (count: number) => ({
      count,
      status: count > 0 ? "healthy" : "empty",
    });
    const buffersHealth = {
      requests: mkHealth(p.store.length),
      fetchPaused: mkHealth(p.fetchPaused.length),
      issues: mkHealth(p.issues.length),
      consoleLogs: mkHealth(p.consoleLogs.length),
      exceptions: mkHealth(p.exceptions.length),
      dialogs: mkHealth(p.dialogs.length),
      securityStates: mkHealth(p.securityStates.length),
      storageEvents: mkHealth(p.storageEvents.length),
      frameEvents: mkHealth(p.frameEvents.length),
      scripts: mkHealth(p.scripts.length),
      domMutations: mkHealth(p.domMutations.length),
      webauthnEvents: mkHealth(p.webauthnEvents.length),
    };
    const recommendations: string[] = [];
    if (!connected) {
      recommendations.push(
        `profile '${profileName}' 当前 disconnected — 先用 browser 工具指定 profile='${profileName}' 打开页面`,
      );
    }
    if (connected && p.frameEvents.length === 0) {
      recommendations.push(
        `frameEvents=0 但 profile 已连：可能 plugin attach 之后还没 navigate 任何页面，或 Page.enable 失败（查 gateway log "Page.enable failed"）`,
      );
    }
    if (connected && p.frameEvents.length > 0 && p.issues.length === 0) {
      recommendations.push(
        `已 navigate 但 issues=0：访问的页面可能没触发 CSP/CORS/Cookie 拦截。访问带 mixed content、跨站 cookie 限制或严格 CSP 的授权测试页时通常会有 issues`,
      );
    }
    if (connected && p.frameEvents.length > 0 && p.consoleLogs.length === 0) {
      recommendations.push(
        `已 navigate 但 consoleLogs=0：页面可能没主动 console.log。注意：浏览器自身警告（mixed content / CSP report）走 Log.entryAdded（也存在 consoleLogs buffer 里）`,
      );
    }
    if (p.trackedOrigins.size === 0 && p.frameEvents.length > 0) {
      recommendations.push(
        `trackedOrigins=0：navigate 触发但 origin tracking 没启动，可能 Storage.trackIndexedDBForOrigin 失败（查 gateway log）`,
      );
    }
    return {
      profile: profileName,
      ok: connected,
      endpoint: p.endpoint.kind,
      cdpPort: p.endpoint.kind === "port" ? p.endpoint.cdpPort : undefined,
      cdpUrl: p.endpoint.kind === "url" ? p.endpoint.cdpUrl : undefined,
      connected,
      buffersHealth,
      trackedOriginsCount: p.trackedOrigins.size,
      recommendations,
    };
  }
}

const _capture = new TrafficCapture();

export default definePluginEntry({
  id: "cdp-traffic-capture",
  name: "CDP Traffic Capture",
  description: "Attaches to each browser profile's CDP endpoint and captures full request/response/WS traffic + 8 个 CDP domain 事件。zod 强 schema 校验 + L3 0 条诊断 hint + L4 错误落盘 + L5 self-test。",
  register(api: PluginApi) {
    const logger = api.logger;
    _capture.setLogger(logger);

    const service: PluginService = {
      id: "cdp-traffic-capture",
      start: async () => {
        await _capture.loadProfiles();
        _capture.startReconnectLoop();
        logger.info("[cdp-traffic] plugin registered");
      },
      stop: async () => {
        await _capture.stop();
      },
    };
    api.registerService(service);
    // ====================================================================
    // 6 type-based CDP tools (merged from 21)
    // ====================================================================

    // ─── cdp_query(type, ...filters) — dispatches 12 query types ───
    api.registerTool((_ctx) => defineCdpTool({
      name: "cdp_query",
      label: "查询 CDP 捕获数据",
      description: "按 type 查询 browser profile 的各类 CDP 捕获数据。type: traffic/audits/console/dialogs/exceptions/security/storage/frames/scripts/dom_mutations/webauthn/fetch。不同 type 支持不同 filter 字段（如 traffic 支持 url_contains/method/status，console 支持 log_type/text_contains）。",
      details: "统一 CDP 数据查询入口，替代 12 个独立 query 工具。依据 type 参数分发到对应缓冲区：traffic→Network.requestWillBeSent 缓存；audits→Audits.issueAdded；console→Runtime.consoleAPICalled + Log.entryAdded；dialogs→Page.javascriptDialogOpening；exceptions→Runtime.exceptionThrown；security→Security.securityStateChanged；storage→Storage+DOMStorage 事件；frames→Page.frame* 生命周期；scripts→Debugger.scriptParsed；dom_mutations→注入 MutationObserver 记录；webauthn→WebAuthn 事件；fetch→Fetch.requestPaused 快照。仅传当前 type 相关的 filter 字段生效，不相关的忽略。返回格式因 type 而异（如 traffic 返回 requests[]，audits 返回 issues[]）。",
      schema: CdpQuerySchema,
      async execute(params) {
        _capture.activate(params.profile);
        const ps = _capture.getProfile(params.profile);
        const connected = (ps?.clients.size ?? 0) > 0;
        const mkDiag = (buf: unknown[], fc: number, f: Record<string,unknown>, es?: Record<string,string[]>) =>
          generateDiagnostic({ bufferSize: (buf as any[]).length, filteredCount: fc, filters: f, enumSamples: es, profileConnected: connected, profile: params.profile });
        let buf: any[], filtered: any[], diag: { hint?: string } | null = null, limit: number, result: Record<string,unknown>;

        switch (params.type) {
          case "traffic": {
            buf = ps?.store ?? [];
            filtered = buf.slice();
            if (params.url_contains) { const n = params.url_contains.toLowerCase(); filtered = filtered.filter((r: any) => r.request?.url?.toLowerCase().includes(n)); }
            if (params.hostname) { const n = params.hostname.toLowerCase(); filtered = filtered.filter((r: any) => { try { return new URL(r.request?.url ?? "").hostname.toLowerCase() === n } catch { return false } }); }
            if (params.method) { const m = params.method.toUpperCase(); filtered = filtered.filter((r: any) => r.request?.method?.toUpperCase() === m); }
            if (typeof params.status === "number") filtered = filtered.filter((r: any) => r.response?.status === params.status);
            if (params.resource_type) { const rt = params.resource_type.toLowerCase(); filtered = filtered.filter((r: any) => r.resourceType?.toLowerCase() === rt); }
            if (params.failed_only) filtered = filtered.filter((r: any) => r.failed === true);
            if (params.from_cache !== undefined) filtered = filtered.filter((r: any) => r.fromCache === params.from_cache);
            if (params.blocked_reason_contains) { const n = params.blocked_reason_contains.toLowerCase(); filtered = filtered.filter((r: any) => r.blockedReason?.toLowerCase().includes(n)); }
            if (params.after) { const ms = new Date(params.after).getTime(); if (!Number.isNaN(ms)) filtered = filtered.filter((r: any) => r.timestamp > ms); }
            if (params.before) { const ms = new Date(params.before).getTime(); if (!Number.isNaN(ms)) filtered = filtered.filter((r: any) => r.timestamp < ms); }
            limit = params.limit ?? 50;
            const rows = filtered.slice(-limit);
            const compact = rows.map((r: any) => {
              const tf = r.initiator?.stack?.callFrames?.[0];
              return { requestId: r.requestId, timestamp: new Date(r.timestamp).toISOString(), method: r.request?.method, url: r.request?.url, status: r.response?.status, mimeType: r.response?.mimeType, resourceType: r.resourceType, failed: r.failed, fromCache: r.fromCache, blockedReason: r.blockedReason, frameId: r.frameId, redirectHops: r.redirectChain?.length, initiatorType: r.initiator?.type, initiatorUrl: r.initiator?.url, initiatorLine: r.initiator?.lineNumber, initiatorParentRequestId: r.initiator?.requestId, initiatorTopFrame: tf ? { url: tf.url, lineNumber: tf.lineNumber, functionName: tf.functionName } : undefined, initiatorStackDepth: r.initiator?.stack?.callFrames?.length, requestHeaderCount: Object.keys(r.request?.headers ?? {}).length, responseHeaderCount: Object.keys(r.response?.headers ?? {}).length, bodyBytes: r.bodyBytes, bodyPath: r.bodyPath, wsFrames: r.ws?.length };
            });
            diag = mkDiag(buf, filtered.length, { url_contains: params.url_contains, hostname: params.hostname, method: params.method, status: params.status, resource_type: params.resource_type, failed_only: params.failed_only, from_cache: params.from_cache, blocked_reason_contains: params.blocked_reason_contains }, filtered.length === 0 && buf.length > 0 ? { method: uniqueFieldValues(buf, (r: any) => r.request?.method), resourceType: uniqueFieldValues(buf, (r: any) => r.resourceType), status: uniqueFieldValues(buf, (r: any) => r.response?.status !== undefined ? String(r.response.status) : undefined), blockedReason: uniqueFieldValues(buf, (r: any) => r.blockedReason) } : undefined);
            result = { returned: compact.length, total: filtered.length, hasMore: filtered.length > compact.length, bufferSize: buf.length, requests: compact };
            break;
          }
          case "audits": {
            buf = ps?.issues ?? [];
            filtered = buf.slice();
            if (params.issue_code) { const n = params.issue_code.toLowerCase(); filtered = filtered.filter((r: any) => r.issueCode?.toLowerCase().includes(n)); }
            if (params.after) { const ms = new Date(params.after).getTime(); if (!Number.isNaN(ms)) filtered = filtered.filter((r: any) => r.timestamp > ms); }
            if (params.before) { const ms = new Date(params.before).getTime(); if (!Number.isNaN(ms)) filtered = filtered.filter((r: any) => r.timestamp < ms); }
            limit = params.limit ?? 50;
            diag = mkDiag(buf, filtered.length, { issue_code: params.issue_code }, filtered.length === 0 && buf.length > 0 ? { issueCode: uniqueFieldValues(buf, (r: any) => r.issueCode) } : undefined);
            result = { returned: filtered.slice(-limit).length, total: filtered.length, hasMore: filtered.length > limit, bufferSize: buf.length, issues: filtered.slice(-limit) };
            break;
          }
          case "console": {
            buf = ps?.consoleLogs ?? [];
            filtered = buf.slice();
            if (params.log_type) { const t = params.log_type.toLowerCase(); filtered = filtered.filter((r: any) => r.type.toLowerCase() === t); }
            if (params.text_contains) { const n = params.text_contains.toLowerCase(); filtered = filtered.filter((r: any) => r.args?.some?.((a: any) => typeof a.value === "string" && a.value.toLowerCase().includes(n))); }
            if (params.after) { const ms = new Date(params.after).getTime(); if (!Number.isNaN(ms)) filtered = filtered.filter((r: any) => r.timestamp > ms); }
            if (params.before) { const ms = new Date(params.before).getTime(); if (!Number.isNaN(ms)) filtered = filtered.filter((r: any) => r.timestamp < ms); }
            limit = params.limit ?? 50;
            diag = mkDiag(buf, filtered.length, { log_type: params.log_type, text_contains: params.text_contains }, filtered.length === 0 && buf.length > 0 ? { type: uniqueFieldValues(buf, (r: any) => r.type) } : undefined);
            result = { returned: filtered.slice(-limit).length, total: filtered.length, hasMore: filtered.length > limit, bufferSize: buf.length, logs: filtered.slice(-limit) };
            break;
          }
          case "dialogs": {
            buf = ps?.dialogs ?? [];
            filtered = buf.slice();
            if (params.dialog_type) { const t = params.dialog_type.toLowerCase(); filtered = filtered.filter((r: any) => r.dialogType.toLowerCase() === t); }
            if (params.after) { const ms = new Date(params.after).getTime(); if (!Number.isNaN(ms)) filtered = filtered.filter((r: any) => r.timestamp > ms); }
            if (params.before) { const ms = new Date(params.before).getTime(); if (!Number.isNaN(ms)) filtered = filtered.filter((r: any) => r.timestamp < ms); }
            limit = params.limit ?? 50;
            diag = mkDiag(buf, filtered.length, { dialog_type: params.dialog_type }, filtered.length === 0 && buf.length > 0 ? { dialogType: uniqueFieldValues(buf, (r: any) => r.dialogType) } : undefined);
            result = { returned: filtered.slice(-limit).length, total: filtered.length, hasMore: filtered.length > limit, bufferSize: buf.length, dialogs: filtered.slice(-limit) };
            break;
          }
          case "exceptions": {
            buf = ps?.exceptions ?? [];
            filtered = buf.slice();
            if (params.text_contains) { const n = params.text_contains.toLowerCase(); filtered = filtered.filter((r: any) => r.text?.toLowerCase().includes(n)); }
            if (params.after) { const ms = new Date(params.after).getTime(); if (!Number.isNaN(ms)) filtered = filtered.filter((r: any) => r.timestamp > ms); }
            if (params.before) { const ms = new Date(params.before).getTime(); if (!Number.isNaN(ms)) filtered = filtered.filter((r: any) => r.timestamp < ms); }
            limit = params.limit ?? 50;
            diag = mkDiag(buf, filtered.length, { text_contains: params.text_contains });
            result = { returned: filtered.slice(-limit).length, total: filtered.length, hasMore: filtered.length > limit, bufferSize: buf.length, exceptions: filtered.slice(-limit) };
            break;
          }
          case "security": {
            buf = ps?.securityStates ?? [];
            filtered = buf.slice();
            if (params.state) { const t = params.state.toLowerCase(); filtered = filtered.filter((r: any) => r.state.toLowerCase() === t); }
            if (params.after) { const ms = new Date(params.after).getTime(); if (!Number.isNaN(ms)) filtered = filtered.filter((r: any) => r.timestamp > ms); }
            if (params.before) { const ms = new Date(params.before).getTime(); if (!Number.isNaN(ms)) filtered = filtered.filter((r: any) => r.timestamp < ms); }
            limit = params.limit ?? 50;
            diag = mkDiag(buf, filtered.length, { state: params.state }, filtered.length === 0 && buf.length > 0 ? { state: uniqueFieldValues(buf, (r: any) => r.state) } : undefined);
            result = { returned: filtered.slice(-limit).length, total: filtered.length, hasMore: filtered.length > limit, bufferSize: buf.length, states: filtered.slice(-limit) };
            break;
          }
          case "storage": {
            buf = ps?.storageEvents ?? [];
            filtered = buf.slice();
            if (params.storage_type) { const n = params.storage_type.toLowerCase(); filtered = filtered.filter((r: any) => r.type?.toLowerCase().includes(n)); }
            if (params.origin) { const n = params.origin.toLowerCase(); filtered = filtered.filter((r: any) => r.origin?.toLowerCase() === n); }
            if (params.key_contains) { const n = params.key_contains.toLowerCase(); filtered = filtered.filter((r: any) => r.itemKey?.toLowerCase().includes(n) || r.storageKey?.toLowerCase().includes(n)); }
            if (params.after) { const ms = new Date(params.after).getTime(); if (!Number.isNaN(ms)) filtered = filtered.filter((r: any) => r.timestamp > ms); }
            if (params.before) { const ms = new Date(params.before).getTime(); if (!Number.isNaN(ms)) filtered = filtered.filter((r: any) => r.timestamp < ms); }
            limit = params.limit ?? 50;
            diag = mkDiag(buf, filtered.length, { storage_type: params.storage_type, origin: params.origin, key_contains: params.key_contains }, filtered.length === 0 && buf.length > 0 ? { type: uniqueFieldValues(buf, (r: any) => r.type) } : undefined);
            result = { returned: filtered.slice(-limit).length, total: filtered.length, hasMore: filtered.length > limit, bufferSize: buf.length, events: filtered.slice(-limit) };
            break;
          }
          case "frames": {
            buf = ps?.frameEvents ?? [];
            filtered = buf.slice();
            if (params.frame_type) { const t = params.frame_type.toLowerCase(); filtered = filtered.filter((r: any) => r.type.toLowerCase() === t); }
            if (params.frame_url_contains) { const n = params.frame_url_contains.toLowerCase(); filtered = filtered.filter((r: any) => r.url?.toLowerCase().includes(n)); }
            if (params.after) { const ms = new Date(params.after).getTime(); if (!Number.isNaN(ms)) filtered = filtered.filter((r: any) => r.timestamp > ms); }
            if (params.before) { const ms = new Date(params.before).getTime(); if (!Number.isNaN(ms)) filtered = filtered.filter((r: any) => r.timestamp < ms); }
            limit = params.limit ?? 50;
            diag = mkDiag(buf, filtered.length, { frame_type: params.frame_type, frame_url_contains: params.frame_url_contains }, filtered.length === 0 && buf.length > 0 ? { type: uniqueFieldValues(buf, (r: any) => r.type) } : undefined);
            result = { returned: filtered.slice(-limit).length, total: filtered.length, hasMore: filtered.length > limit, bufferSize: buf.length, frames: filtered.slice(-limit) };
            break;
          }
          case "scripts": {
            buf = ps?.scripts ?? [];
            filtered = buf.slice();
            if (params.script_url_contains) { const n = params.script_url_contains.toLowerCase(); filtered = filtered.filter((r: any) => r.url?.toLowerCase().includes(n)); }
            if (params.has_source_map !== undefined) filtered = filtered.filter((r: any) => !!r.sourceMapURL === params.has_source_map);
            if (params.is_module !== undefined) filtered = filtered.filter((r: any) => r.isModule === params.is_module);
            if (params.after) { const ms = new Date(params.after).getTime(); if (!Number.isNaN(ms)) filtered = filtered.filter((r: any) => r.timestamp > ms); }
            if (params.before) { const ms = new Date(params.before).getTime(); if (!Number.isNaN(ms)) filtered = filtered.filter((r: any) => r.timestamp < ms); }
            limit = params.limit ?? 50;
            diag = mkDiag(buf, filtered.length, { script_url_contains: params.script_url_contains, has_source_map: params.has_source_map, is_module: params.is_module });
            result = { returned: filtered.slice(-limit).length, total: filtered.length, hasMore: filtered.length > limit, bufferSize: buf.length, scripts: filtered.slice(-limit) };
            break;
          }
          case "dom_mutations": {
            buf = ps?.domMutations ?? [];
            filtered = buf.slice();
            if (params.mutation_type) { const t = params.mutation_type.toLowerCase(); filtered = filtered.filter((r: any) => r.type.toLowerCase() === t); }
            if (params.mutation_target_contains) { const n = params.mutation_target_contains.toLowerCase(); filtered = filtered.filter((r: any) => r.target?.toLowerCase().includes(n)); }
            if (params.after) { const ms = new Date(params.after).getTime(); if (!Number.isNaN(ms)) filtered = filtered.filter((r: any) => r.timestamp > ms); }
            if (params.before) { const ms = new Date(params.before).getTime(); if (!Number.isNaN(ms)) filtered = filtered.filter((r: any) => r.timestamp < ms); }
            limit = params.limit ?? 100;
            diag = mkDiag(buf, filtered.length, { mutation_type: params.mutation_type, mutation_target_contains: params.mutation_target_contains }, filtered.length === 0 && buf.length > 0 ? { type: uniqueFieldValues(buf, (r: any) => r.type) } : undefined);
            result = { returned: filtered.slice(-limit).length, total: filtered.length, hasMore: filtered.length > limit, bufferSize: buf.length, mutations: filtered.slice(-limit) };
            break;
          }
          case "webauthn": {
            buf = ps?.webauthnEvents ?? [];
            filtered = buf.slice();
            if (params.webauthn_type) { const t = params.webauthn_type.toLowerCase(); filtered = filtered.filter((r: any) => r.type.toLowerCase() === t); }
            if (params.after) { const ms = new Date(params.after).getTime(); if (!Number.isNaN(ms)) filtered = filtered.filter((r: any) => r.timestamp > ms); }
            if (params.before) { const ms = new Date(params.before).getTime(); if (!Number.isNaN(ms)) filtered = filtered.filter((r: any) => r.timestamp < ms); }
            limit = params.limit ?? 50;
            diag = mkDiag(buf, filtered.length, { webauthn_type: params.webauthn_type }, filtered.length === 0 && buf.length > 0 ? { type: uniqueFieldValues(buf, (r: any) => r.type) } : undefined);
            result = { returned: filtered.slice(-limit).length, total: filtered.length, hasMore: filtered.length > limit, bufferSize: buf.length, events: filtered.slice(-limit) };
            break;
          }
          case "fetch": {
            buf = ps?.fetchPaused ?? [];
            filtered = buf.slice();
            if (params.url_contains) { const n = params.url_contains.toLowerCase(); filtered = filtered.filter((r: any) => r.request?.url?.toLowerCase().includes(n)); }
            if (params.method) { const m = params.method.toUpperCase(); filtered = filtered.filter((r: any) => r.request?.method?.toUpperCase() === m); }
            if (params.after) { const ms = new Date(params.after).getTime(); if (!Number.isNaN(ms)) filtered = filtered.filter((r: any) => r.timestamp > ms); }
            if (params.before) { const ms = new Date(params.before).getTime(); if (!Number.isNaN(ms)) filtered = filtered.filter((r: any) => r.timestamp < ms); }
            limit = params.limit ?? 50;
            diag = mkDiag(buf, filtered.length, { url_contains: params.url_contains, method: params.method }, filtered.length === 0 && buf.length > 0 ? { method: uniqueFieldValues(buf, (r: any) => r.request?.method) } : undefined);
            result = { returned: filtered.slice(-limit).length, total: filtered.length, hasMore: filtered.length > limit, bufferSize: buf.length, requests: filtered.slice(-limit) };
            break;
          }
        }
        return { ...result, ...(diag ?? {}) };
      },
    }) as AnyAgentTool);

    // Retired 2026-06-13: cdp_get, cdp_cookies. 0 references across server,
    // CLI, smoke tests, and helloworld skills. Mechanism A (plugin attaches CDP
    // to 9222) was eclipsed by the Playwright-driven managed browser; agents
    // read traffic via profileRegistry now. cdp_query / cdp_fetch_intercept
    // below stay because the server's agent_inspect focus=console and the CLI
    // intercept subcommand still depend on them.

    // ─── cdp_fetch_intercept(action, ...) — dispatches 4 actions ───
    api.registerTool((_ctx) => defineCdpTool({
      name: "cdp_fetch_intercept",
      label: "Fetch 拦截控制",
      description: "控制 browser profile 的 Fetch domain 拦截。action: start（标记 URL pattern 开始拦截）/ list（列当前暂停的请求）/ continue（放行，可选改 URL/method/header/body）/ fail（模拟网络失败）。",
      details: "start：传入 url_pattern（substring 匹配完整 URL，空串匹配所有），匹配的请求不再自动 continue 而是暂停（30s 超时自动放行）。list：返回 capturedRequestId、原始请求、剩余超时和下一步 CLI。continue：传入 captured_request_id，可改 url/method/header_overrides/remove_headers/body/body_base64/json 后放行。fail：传入 captured_request_id + 可选 error_reason 模拟网络失败。用于 Agentic Burp 的 Intercept/Edit-and-forward：修改浏览器真实在途请求，而不是页面 fetch replay。",
      schema: CdpFetchInterceptSchema,
      async execute(params) {
        _capture.activate(params.profile);
        const p = _capture.getProfile(params.profile);
        if (!p) return { error: `profile not found: ${params.profile}` };
        switch (params.action) {
          case "start":
            p.fetchInterceptState.patterns.add(params.url_pattern ?? "");
            return { ok: true, profile: params.profile, url_pattern: params.url_pattern ?? "", totalPatterns: p.fetchInterceptState.patterns.size };
          case "list":
            return _capture.getFetchInterceptPaused(params.profile);
          case "continue":
            return _capture.fetchContinue(params.profile, params.captured_request_id ?? "", {
              headerOverrides: params.header_overrides,
              removeHeaders: params.remove_headers,
              url: params.url,
              method: params.method,
              body: params.body,
              bodyBase64: params.body_base64,
              json: params.json,
            });
          case "fail":
            return _capture.fetchFail(params.profile, params.captured_request_id ?? "", params.error_reason ?? "BlockedByClient");
        }
      },
    }) as AnyAgentTool);

    // Retired 2026-06-13: cdp_stats, cdp_self_test. Same reason as cdp_get /
    // cdp_cookies above — 0 real callers. Capture health is observable via
    // profile_traffic_summary (Playwright-driven, what agents actually use).

  },
});
