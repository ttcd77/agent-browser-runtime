import { describe, it, expect } from "vitest";
import {
  looksSensitiveKey,
  looksSensitiveValue,
  summarizeCookies,
  summarizeStorageBoundaries,
  summarizeStorageBuckets,
  severityRank,
  buildSignalSummary,
} from "./evidence-summaries.mjs";

// Characterization tests pinning the behavior of the pure summarizers carved out
// of agent-cdp-server.mjs. These lock current output so the monolith refactor
// (and future edits) cannot silently change what these objective view-models report.

describe("looksSensitiveKey / looksSensitiveValue", () => {
  it("flags sensitive key names", () => {
    for (const k of ["authorization", "x-api-key", "csrf-token", "session", "Password"]) {
      expect(looksSensitiveKey(k)).toBe(true);
    }
  });
  it("does not flag benign key names", () => {
    for (const k of ["width", "color", "lang", "page"]) {
      expect(looksSensitiveKey(k)).toBe(false);
    }
  });
  it("flags JWT- and bearer-shaped values", () => {
    expect(looksSensitiveValue("eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF2QT4")).toBe(true);
    expect(looksSensitiveValue("Bearer abcdefghijklmnopqrstuvwxyz0123")).toBe(true);
    expect(looksSensitiveValue("just a normal sentence")).toBe(false);
  });
});

describe("summarizeCookies", () => {
  it("counts secure/insecure/session and surfaces attribute findings", () => {
    const out = summarizeCookies([
      { name: "sid", value: "x", secure: false, httpOnly: false, sameSite: "None", domain: "a.com" },
      { name: "pref", value: "1", secure: true, httpOnly: true, sameSite: "Lax", domain: "a.com", expires: 9999999999 },
    ]);
    expect(out.cookieCount).toBe(2);
    expect(out.secureCount).toBe(1);
    expect(out.insecureCount).toBe(1);
    expect(out.byDomain["a.com"]).toBe(2);
    const sid = out.findings.find((f) => f.name === "sid");
    expect(sid).toBeTruthy();
    expect(sid.attributeSignals).toContain("missing-secure");
  });
  it("handles empty / non-array input safely", () => {
    expect(summarizeCookies().cookieCount).toBe(0);
    expect(summarizeCookies(null).cookieCount).toBe(0);
  });
});

describe("summarizeStorageBoundaries / summarizeStorageBuckets", () => {
  it("aggregates frames by origin and counts storage keys", () => {
    const out = summarizeStorageBoundaries([
      { origin: "https://a.com", storageKey: "k1", usageAndQuota: { usage: 10, quota: 100, usageBreakdown: [] } },
      { origin: "https://a.com", storageKey: "k1" },
      { origin: "https://b.com" },
    ]);
    expect(out.frameCount).toBe(3);
    expect(out.originCount).toBe(2);
    expect(out.quotaUsageBytes).toBe(10);
  });
  it("summarizes storage buckets support flag", () => {
    expect(summarizeStorageBuckets({ supported: true, buckets: [] }).supported).toBe(true);
    expect(summarizeStorageBuckets().bucketCount).toBe(0);
  });
});

describe("severityRank / buildSignalSummary", () => {
  it("ranks severities", () => {
    expect(severityRank("high")).toBe(3);
    expect(severityRank("medium")).toBe(2);
    expect(severityRank("low")).toBe(1);
    expect(severityRank("info")).toBe(0);
    expect(severityRank("nonsense")).toBe(0);
  });
  it("emits signals and sorts by severity (high first)", () => {
    const out = buildSignalSummary({
      diagnostics: { network: { failedCount: 2, failed: [] }, page: { isSecureContext: false, protocol: "http:" } },
    });
    expect(out.summaryKind).toBe("signals");
    expect(out.signalCount).toBeGreaterThanOrEqual(2);
    // high-severity insecure-context must sort ahead of medium failed-requests
    expect(severityRank(out.signals[0].severity)).toBeGreaterThanOrEqual(severityRank(out.signals[out.signals.length - 1].severity));
    expect(out.highCount).toBeGreaterThanOrEqual(1);
  });
});
