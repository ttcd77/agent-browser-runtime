import { describe, it, expect } from "vitest";
import {
  requestOrigin,
  requestPathname,
  requestSet,
  diffRequestSets,
  extractHarRecords,
  extractBundleNetworkRecords,
  countBy,
  analyzeHarCompleteness,
  diffObjectKeys,
  headerValue,
  authHeaderEvidence,
} from "./network-har.mjs";

// Characterization tests pinning the behavior of the pure network/HAR view-model
// builders carved out of agent-cdp-server.mjs. These lock URL parsing fallbacks,
// request-set diffing, HAR completeness coverage ratios, header lookup, and auth
// -header evidence shape so the monolith refactor cannot silently change what the
// objective network evidence reports.

describe("requestOrigin / requestPathname", () => {
  it("parses origin and pathname, falling back safely on bad URLs", () => {
    expect(requestOrigin("https://a.com/x?y=1")).toBe("https://a.com");
    expect(requestOrigin("not a url")).toBe("");
    expect(requestPathname("https://a.com/p/q")).toBe("/p/q");
    expect(requestPathname("garbage")).toBe("garbage");
    expect(requestPathname("https://a.com")).toBe("/");
  });
});

describe("requestSet / diffRequestSets", () => {
  it("keys by method+origin+path and counts", () => {
    const set = requestSet([
      { method: "GET", url: "https://a.com/x", status: 200 },
      { method: "GET", url: "https://a.com/x", status: 200 },
    ]);
    expect(set.size).toBe(1);
    const item = set.get("GET https://a.com/x");
    expect(item.count).toBe(2);
    expect(item.statuses["200"]).toBe(2);
  });
  it("diffs two request sets into added/removed/changed", () => {
    const before = [{ method: "GET", url: "https://a.com/x", status: 200 }];
    const after = [
      { method: "GET", url: "https://a.com/x", status: 500 },
      { method: "POST", url: "https://a.com/y", status: 201 },
    ];
    const d = diffRequestSets(before, after);
    expect(d.added).toHaveLength(1);
    expect(d.removed).toHaveLength(0);
    expect(d.changed).toHaveLength(1); // status flipped 200 -> 500 at same key
    expect(d.added[0].key).toBe("POST https://a.com/y");
  });
});

describe("extractHarRecords / extractBundleNetworkRecords", () => {
  it("extracts simple records from a HAR payload", () => {
    const recs = extractHarRecords({ har: { log: { entries: [{ request: { method: "GET", url: "u" }, response: { status: 200 } }] } } });
    expect(recs).toEqual([{ method: "GET", url: "u", status: 200 }]);
  });
  it("prefers an explicit requests array, else falls back to HAR", () => {
    expect(extractBundleNetworkRecords({ requests: [{ url: "a" }] })).toEqual([{ url: "a" }]);
    expect(extractBundleNetworkRecords({ har: { log: { entries: [] } } })).toEqual([]);
  });
});

describe("countBy", () => {
  it("tallies rows by a key function, defaulting missing keys to (none)", () => {
    expect(countBy([{ t: "a" }, { t: "a" }, { t: "b" }], (r) => r.t)).toEqual({ a: 2, b: 1 });
    expect(countBy([{}], (r) => r.missing)).toEqual({ "(none)": 1 });
  });
});

describe("analyzeHarCompleteness", () => {
  it("computes coverage ratios over HAR entries", () => {
    const har = {
      log: {
        entries: [
          {
            request: { url: "https://a.com/x", method: "GET" },
            response: { status: 200, content: { _bodyIncluded: true } },
            timings: { blocked: 1, dns: 1, connect: 1, ssl: 1, send: 1, wait: 1, receive: 1 },
            time: 10,
          },
        ],
      },
    };
    const out = analyzeHarCompleteness(har);
    expect(out.entryCount).toBe(1);
    expect(out.coverage.bodiesIncluded.ratio).toBe(1);
    expect(out.coverage.allTimingPhases.ratio).toBe(1);
    expect(out.boundaries.length).toBeGreaterThan(0);
  });
  it("handles an empty HAR safely (null ratios)", () => {
    const out = analyzeHarCompleteness({});
    expect(out.entryCount).toBe(0);
    expect(out.coverage.bodiesIncluded.ratio).toBe(null);
  });
});

describe("headerValue / authHeaderEvidence / diffObjectKeys", () => {
  it("looks up a header value case-insensitively", () => {
    expect(headerValue({ "Content-Type": "json" }, "content-type")).toBe("json");
    expect(headerValue({}, "x")).toBe(undefined);
  });
  it("surfaces auth/cookie/csrf header evidence per request", () => {
    const ev = authHeaderEvidence([
      { requestId: "1", method: "GET", url: "u", requestHeaders: { Authorization: "Bearer xyz", Cookie: "a=b" } },
    ]);
    expect(ev).toHaveLength(1);
    expect(ev[0].hasAuthorizationHeader).toBe(true);
    expect(ev[0].authorizationScheme).toBe("Bearer");
    expect(ev[0].hasCookieHeader).toBe(true);
    expect(ev[0].cookieHeaderBytes).toBe(3);
  });
  it("diffs object keys into added/removed/common (sorted)", () => {
    expect(diffObjectKeys({ a: 1, b: 2 }, { b: 2, c: 3 })).toEqual({ added: ["c"], removed: ["a"], common: ["b"] });
  });
});
