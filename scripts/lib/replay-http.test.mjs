import { describe, it, expect } from "vitest";
import {
  prepareReplayHeaders,
  headerHas,
  setHeaderIfMissing,
  buildReplayBody,
  buildReplayBoundaryEvidence,
  headerMapLower,
  diffReplayResponse,
} from "./replay-http.mjs";

// Characterization tests pinning the pure HTTP-replay helpers carved out of
// agent-cdp-server.mjs. These lock the forbidden/client-hint header stripping,
// the header-overwrite-removal semantics, the multipart/form/json/raw body
// selection, the replay-vs-original boundary evidence shape, and the
// original-vs-replay response diff. They assert concrete objective-evidence
// shapes (not smoke loads) so the net catches any behavior drift.

describe("prepareReplayHeaders", () => {
  it("strips forbidden + client-hint headers and records removals when value is nullish/false", () => {
    const out = prepareReplayHeaders(
      { "X-Keep": "yes", Host: "evil.com", "Sec-CH-UA": "x", Cookie: "a=b" },
      { "X-Drop": null, "X-Off": false },
    );
    expect(out.headers).toEqual({ "X-Keep": "yes" });
    // forbidden + client-hint are skipped with reasons
    expect(out.skipped).toEqual([
      { name: "Host", reason: "forbidden-fetch-header" },
      { name: "Sec-CH-UA", reason: "client-hint-forbidden-in-fetch" },
      { name: "Cookie", reason: "forbidden-fetch-header" },
    ]);
    // null + false override values are recorded as removed
    expect(out.removed).toEqual(["X-Drop", "X-Off"]);
  });

  // 伪头（:authority / :method / :path / :scheme）会让 fetch() 抛 Invalid name，
  // 必须在 replay 前剥掉，否则 HTTP/2 站点上整个 replay 崩。
  it("strips HTTP/2 pseudo-headers and keeps real custom headers", () => {
    const out = prepareReplayHeaders({
      ":authority": "app.eu.pendo.io",
      ":method": "POST",
      ":path": "/api/s/123/x",
      ":scheme": "https",
      "x-pendo-xsrf-token": "abc123",
    });
    // 四个伪头都不在 out.headers 里
    expect(out.headers).toEqual({ "x-pendo-xsrf-token": "abc123" });
    // 四个伪头都在 skipped 里，reason 为 http2-pseudo-header
    expect(out.skipped).toHaveLength(4);
    const skippedNames = out.skipped.map((s) => s.name);
    expect(skippedNames).toEqual(expect.arrayContaining([":authority", ":method", ":path", ":scheme"]));
    out.skipped.forEach((s) => {
      expect(s.reason).toBe("http2-pseudo-header");
    });
    // 真实自定义头 x-pendo-xsrf-token 保留在 headers 里
    expect(out.headers["x-pendo-xsrf-token"]).toBe("abc123");
  });

  it("overrides win over raw header values and stringifies", () => {
    const out = prepareReplayHeaders({ "X-A": "raw" }, { "X-A": 42 });
    expect(out.headers).toEqual({ "X-A": "42" });
    expect(out.skipped).toEqual([]);
    expect(out.removed).toEqual([]);
  });
});

describe("headerHas / setHeaderIfMissing", () => {
  it("headerHas is case-insensitive on key", () => {
    expect(headerHas({ "Content-Type": "x" }, "content-type")).toBe(true);
    expect(headerHas({ "Content-Type": "x" }, "authorization")).toBe(false);
    expect(headerHas(null, "anything")).toBe(false);
  });
  it("setHeaderIfMissing only sets when absent (case-insensitive)", () => {
    const h = { "content-type": "keep" };
    setHeaderIfMissing(h, "Content-Type", "new");
    expect(h["content-type"]).toBe("keep"); // unchanged, already present
    setHeaderIfMissing(h, "X-New", "added");
    expect(h["X-New"]).toBe("added");
  });
});

describe("buildReplayBody", () => {
  it("multipart removes Content-Type header and reports boundary note", () => {
    const headers = { "Content-Type": "application/json" };
    const out = buildReplayBody({ multipart: { fields: { a: "1" }, files: [{ name: "f" }] } }, {}, headers);
    expect(out.bodyKind).toBe("multipart");
    expect(out.body).toEqual({ fields: { a: "1" }, files: [{ name: "f" }] });
    expect(headers["Content-Type"]).toBeUndefined(); // stripped so browser sets boundary
    expect(out.contentTypeNote).toMatch(/multipart boundary/);
  });
  it("form url-encodes and sets default content type if missing", () => {
    const headers = {};
    const out = buildReplayBody({ form: { a: "1", b: "two words" } }, {}, headers);
    expect(out.bodyKind).toBe("form");
    expect(out.body).toBe("a=1&b=two+words");
    expect(out.bodyLength).toBe("a=1&b=two+words".length);
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded;charset=UTF-8");
  });
  it("json stringifies and sets application/json", () => {
    const headers = {};
    const out = buildReplayBody({ json: { x: 1 } }, {}, headers);
    expect(out.bodyKind).toBe("json");
    expect(out.body).toBe('{"x":1}');
    expect(out.bodyLength).toBe('{"x":1}'.length);
    expect(headers["Content-Type"]).toBe("application/json");
  });
  it("raw body falls back to request.postData when no explicit body", () => {
    const fromParam = buildReplayBody({ body: "hello" }, {}, {});
    expect(fromParam).toEqual({ bodyKind: "raw", body: "hello", bodyLength: 5 });
    const fromRequest = buildReplayBody({}, { postData: "abc" }, {});
    expect(fromRequest).toEqual({ bodyKind: "raw", body: "abc", bodyLength: 3 });
    const none = buildReplayBody({}, {}, {});
    expect(none).toEqual({ bodyKind: "none", body: undefined, bodyLength: 0 });
  });
});

describe("buildReplayBoundaryEvidence", () => {
  it("summarizes transport, header handling and body handling as evidence", () => {
    const ev = buildReplayBoundaryEvidence({
      originalRequest: { url: "https://a/x", method: "POST", protocol: "h2", redirectChain: [{}], hasPostData: true },
      replayRequest: { url: "https://a/x", method: "POST", headers: { Authorization: "t" } },
      headerPrep: { skipped: [{ name: "Host", reason: "forbidden-fetch-header" }], removed: ["X-Drop"] },
      bodyPrep: { bodyKind: "json", bodyLength: 9 },
      includeBody: true,
    });
    expect(ev.replayLayer).toBe("browser-fetch");
    expect(ev.originalTransport.redirected).toBe(true);
    expect(ev.replayTransport.credentials).toBe("include"); // default
    expect(ev.replayTransport.bodyKind).toBe("json");
    expect(ev.headerHandling.sentHeaderNames).toEqual(["Authorization"]);
    expect(ev.headerHandling.skippedHeaderNames).toEqual(["Host"]);
    expect(ev.headerHandling.forbiddenHeaderCount).toBe(1);
    expect(ev.bodyHandling.originalHasPostData).toBe(true);
    expect(ev.bodyHandling.replayBodyLength).toBe(9); // includeBody true => length surfaced
    expect(Array.isArray(ev.captureBoundaries)).toBe(true);
    expect(ev.captureBoundaries.length).toBe(3);
  });
  it("zeros replay body length when includeBody is false", () => {
    const ev = buildReplayBoundaryEvidence({ bodyPrep: { bodyKind: "json", bodyLength: 9 }, includeBody: false });
    expect(ev.bodyHandling.replayBodyLength).toBe(0);
    expect(ev.bodyHandling.replayIncludesBody).toBe(false);
    expect(ev.headerHandling.forbiddenHeaderCount).toBe(0);
  });
});

describe("headerMapLower", () => {
  it("lowercases keys and stringifies values", () => {
    expect(headerMapLower({ "Content-Type": "x", "X-N": 5 })).toEqual({ "content-type": "x", "x-n": "5" });
    expect(headerMapLower(null)).toEqual({});
  });
});

describe("diffReplayResponse", () => {
  it("diffs status, url, headers and bodies between original and replay", () => {
    const out = diffReplayResponse(
      {
        status: 200,
        url: "https://a/x",
        responseHeaders: { "X-Same": "1", "X-Old": "old" },
        bodyText: "hello world",
      },
      {
        status: 403,
        url: "https://a/y",
        headers: { "X-Same": "1", "X-Old": "new" },
        bodyText: "blocked",
        redirected: true,
      },
      4,
    );
    expect(out.originalStatus).toBe(200);
    expect(out.replayStatus).toBe(403);
    expect(out.statusChanged).toBe(true);
    expect(out.urlChanged).toBe(true);
    expect(out.redirectedChanged).toBe(true); // replay redirected, original not
    expect(out.headerChangedCount).toBe(1);
    expect(out.headerDiff).toEqual([{ name: "x-old", original: "old", replay: "new" }]);
    expect(out.bodyComparable).toBe(true);
    expect(out.bodyChanged).toBe(true);
    expect(out.originalBodyLength).toBe("hello world".length);
    expect(out.replayBodyLength).toBe("blocked".length);
    expect(out.bodyLengthDelta).toBe("blocked".length - "hello world".length);
    expect(out.originalBodyPreview).toBe("hell"); // sliced to maxBodyPreview=4
    expect(out.replayBodyPreview).toBe("bloc");
  });
  it("falls back to byte counts and marks body non-comparable when text is absent", () => {
    const out = diffReplayResponse(
      { status: 200, bodyBytes: 1000 },
      { status: 200, bodyBytes: 1200 },
    );
    expect(out.statusChanged).toBe(false);
    expect(out.bodyComparable).toBe(false);
    expect(out.bodyChanged).toBe(null);
    expect(out.originalBodyLength).toBe(1000);
    expect(out.replayBodyLength).toBe(1200);
    expect(out.bodyLengthDelta).toBe(200);
    expect(out.originalBodyPreview).toBe(null);
  });
});
