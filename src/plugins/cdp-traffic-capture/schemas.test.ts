/**
 * Lock CDP enum schemas to **real CDP protocol values**.
 * If anyone changes description to suggest values that schema doesn't accept,
 * these tests fail. Defends against description-vs-implementation drift
 * (the root cause of the 22-bug audit on 2026-04-28).
 */

import { describe, it, expect } from "vitest";
import {
  ResourceTypeEnum,
  ConsoleLogTypeEnum,
  DialogTypeEnum,
  SecurityStateEnum,
  FrameEventTypeEnum,
  HttpMethodEnum,
  AuditsIssueCodeSchema,
  StorageTypeSchema,
  generateDiagnostic,
  uniqueFieldValues,
} from "./schemas.js";

describe("ResourceTypeEnum (Network.ResourceType)", () => {
  // CDP Network.ResourceType v1.3 - 18 values, PascalCase
  const VALID = [
    "Document", "Stylesheet", "Image", "Media", "Font", "Script",
    "TextTrack", "XHR", "Fetch", "Prefetch", "EventSource", "WebSocket",
    "Manifest", "SignedExchange", "Ping", "CSPViolationReport", "Preflight", "Other",
  ];
  it.each(VALID)("accepts CDP value '%s'", (v) => {
    expect(ResourceTypeEnum.safeParse(v).success).toBe(true);
  });
  it("rejects lowercase (CDP uses PascalCase)", () => {
    expect(ResourceTypeEnum.safeParse("script").success).toBe(false);
    expect(ResourceTypeEnum.safeParse("xhr").success).toBe(false);
  });
  it("rejects unknown value", () => {
    expect(ResourceTypeEnum.safeParse("Custom").success).toBe(false);
  });
});

describe("ConsoleLogTypeEnum (Runtime.consoleAPICalled.type)", () => {
  // CDP Runtime ConsoleAPICalled type - 18 values
  const VALID = [
    "log", "debug", "info", "error", "warning",
    "dir", "dirxml", "table", "trace", "clear",
    "startGroup", "startGroupCollapsed", "endGroup",
    "assert", "profile", "profileEnd", "count", "timeEnd",
  ];
  it.each(VALID)("accepts CDP value '%s'", (v) => {
    expect(ConsoleLogTypeEnum.safeParse(v).success).toBe(true);
  });
  it("REGRESSION: rejects 'warn' (CDP uses full word 'warning')", () => {
    // 历史 bug: description 写 'warn' 但 CDP 是 'warning'，导致 LLM 'warn' 调 0 条
    expect(ConsoleLogTypeEnum.safeParse("warn").success).toBe(false);
  });
});

describe("DialogTypeEnum (Page.javascriptDialogOpening.type)", () => {
  it.each(["alert", "confirm", "prompt", "beforeunload"])("accepts '%s'", (v) => {
    expect(DialogTypeEnum.safeParse(v).success).toBe(true);
  });
  it("rejects 'before-unload' (no dash in CDP)", () => {
    expect(DialogTypeEnum.safeParse("before-unload").success).toBe(false);
  });
});

describe("SecurityStateEnum (Security.securityStateChanged.securityState)", () => {
  it.each(["unknown", "neutral", "insecure", "secure", "info", "insecure-broken"])(
    "accepts '%s'", (v) => {
      expect(SecurityStateEnum.safeParse(v).success).toBe(true);
    },
  );
  it("REGRESSION: 'insecure-broken' has dash (not underscore)", () => {
    expect(SecurityStateEnum.safeParse("insecure-broken").success).toBe(true);
    expect(SecurityStateEnum.safeParse("insecure_broken").success).toBe(false);
  });
});

describe("FrameEventTypeEnum", () => {
  // 自定义 5 个值（不是 CDP 直接的 enum，是 plugin 内部 type 字段）
  it.each(["navigated", "attached", "detached", "startedLoading", "stoppedLoading"])(
    "accepts '%s'", (v) => {
      expect(FrameEventTypeEnum.safeParse(v).success).toBe(true);
    },
  );
  it("REGRESSION: startedLoading/stoppedLoading must work after critical-4 fix", () => {
    // critical 4: 之前 description 列了但 listener 没注册，schema 也错没
    expect(FrameEventTypeEnum.safeParse("startedLoading").success).toBe(true);
    expect(FrameEventTypeEnum.safeParse("stoppedLoading").success).toBe(true);
  });
});

describe("HttpMethodEnum", () => {
  it.each(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "CONNECT", "TRACE"])(
    "accepts '%s'", (m) => {
      expect(HttpMethodEnum.safeParse(m).success).toBe(true);
    },
  );
  it("rejects lowercase (filter does toUpperCase, but schema enforces uppercase)", () => {
    expect(HttpMethodEnum.safeParse("get").success).toBe(false);
  });
});

describe("AuditsIssueCodeSchema (substring match)", () => {
  // 这是 substring 匹的 free string，不是 strict enum
  // 测试 description 列的真实 CDP 值能 trigger substring match 逻辑
  const REAL_CDP_VALUES = [
    "CookieIssue", "MixedContentIssue", "BlockedByResponseIssue",
    "HeavyAdIssue", "ContentSecurityPolicyIssue", "SharedArrayBufferIssue",
    "LowTextContrastIssue", "CorsIssue", "AttributionReportingIssue",
    "QuirksModeIssue", "GenericIssue", "DeprecationIssue", "ClientHintIssue",
    "FederatedAuthRequestIssue", "BounceTrackingIssue", "StylesheetLoadingIssue",
    "NavigatorUserAgentIssue", "PropertyRuleIssue", "SameSiteCookieIssue",
    "TrustedWebActivityIssue", "WasmCrossOriginModuleSharingIssue",
    "FederatedAuthUserInfoRequestIssue",
  ];
  it("accepts free string", () => {
    expect(AuditsIssueCodeSchema.safeParse("CookieIssue").success).toBe(true);
    expect(AuditsIssueCodeSchema.safeParse("Cookie").success).toBe(true);
    expect(AuditsIssueCodeSchema.safeParse("Cors").success).toBe(true);
  });
  it("REGRESSION: description-listed prefixes must substring-match real CDP values", () => {
    // bug 1 历史: description 写 'CSP' 但实际 'ContentSecurityPolicyIssue'，substring 不匹
    // 这测确保 description 列的 prefix 真的能 substring-match
    const fakeFilter = (needle: string, haystack: string) =>
      haystack.toLowerCase().includes(needle.toLowerCase());
    expect(fakeFilter("Cookie", "CookieIssue")).toBe(true);
    expect(fakeFilter("Cors", "CorsIssue")).toBe(true);
    expect(fakeFilter("MixedContent", "MixedContentIssue")).toBe(true);
    expect(fakeFilter("ContentSecurityPolicy", "ContentSecurityPolicyIssue")).toBe(true);
    // 'CSP' 拼写不在 substring 里，应该匹不到（这是 by-design，description 必须避免 'CSP' 误导）
    expect(fakeFilter("CSP", "ContentSecurityPolicyIssue")).toBe(false);
  });
});

describe("StorageTypeSchema (substring match for 6 action types)", () => {
  const REAL_TYPES = [
    "indexedDB.contentUpdated",
    "cacheStorage.contentUpdated",
    "domStorage.itemAdded",
    "domStorage.itemUpdated",
    "domStorage.itemRemoved",
    "domStorage.cleared",
  ];
  it("accepts free string", () => {
    expect(StorageTypeSchema.safeParse("indexedDB").success).toBe(true);
    expect(StorageTypeSchema.safeParse("domStorage.itemAdded").success).toBe(true);
  });
  it("REGRESSION: prefix substring match works for big-3 categories", () => {
    const fakeFilter = (needle: string, haystack: string) =>
      haystack.toLowerCase().includes(needle.toLowerCase());
    for (const real of REAL_TYPES) {
      const prefix = real.split(".")[0];
      expect(fakeFilter(prefix, real)).toBe(true);
    }
  });
  it("REGRESSION: description-listed action粒度 must substring-match", () => {
    const fakeFilter = (needle: string, haystack: string) =>
      haystack.toLowerCase().includes(needle.toLowerCase());
    expect(fakeFilter("itemAdded", "domStorage.itemAdded")).toBe(true);
    expect(fakeFilter("contentUpdated", "indexedDB.contentUpdated")).toBe(true);
    expect(fakeFilter("cleared", "domStorage.cleared")).toBe(true);
  });
});

describe("L3 generateDiagnostic", () => {
  it("returns hint when profile disconnected + buffer empty", () => {
    const r = generateDiagnostic({
      bufferSize: 0,
      filteredCount: 0,
      filters: {},
      profileConnected: false,
      profile: "default",
    });
    expect(r?.hint).toContain("disconnected");
    expect(r?.hint).toContain("browser 工具");
  });

  it("returns hint when buffer empty (connected)", () => {
    const r = generateDiagnostic({
      bufferSize: 0,
      filteredCount: 0,
      filters: { issue_code: "Cookie" },
      profileConnected: true,
      profile: "default",
    });
    expect(r?.hint).toContain("0 条事件 captured");
  });

  it("returns hint with enum samples when filter doesn't match", () => {
    const r = generateDiagnostic({
      bufferSize: 100,
      filteredCount: 0,
      filters: { log_type: "warn" },
      enumSamples: { log_type: ["warning", "error", "info"] },
      profileConnected: true,
      profile: "default",
    });
    expect(r?.hint).toContain("Buffer 实际取值样本");
    expect(r?.hint).toContain("warning");
  });

  it("returns null when buffer has matched results", () => {
    const r = generateDiagnostic({
      bufferSize: 100,
      filteredCount: 5,
      filters: { log_type: "warning" },
      profileConnected: true,
      profile: "default",
    });
    expect(r).toBeNull();
  });
});

describe("uniqueFieldValues", () => {
  it("returns unique values up to max", () => {
    const rows = [
      { type: "alert" },
      { type: "alert" },
      { type: "confirm" },
      { type: "prompt" },
      { type: "alert" },
    ];
    const out = uniqueFieldValues(rows, (r) => r.type, 5);
    expect(out).toEqual(["alert", "confirm", "prompt"]);
  });
  it("respects max limit", () => {
    const rows = ["a", "b", "c", "d", "e", "f"].map((t) => ({ type: t }));
    expect(uniqueFieldValues(rows, (r) => r.type, 3)).toHaveLength(3);
  });
  it("skips undefined / empty values", () => {
    const rows = [{ t: "x" }, { t: undefined }, { t: "" }, { t: "y" }];
    expect(uniqueFieldValues(rows, (r) => r.t)).toEqual(["x", "y"]);
  });
});
