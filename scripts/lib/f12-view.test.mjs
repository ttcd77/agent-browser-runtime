import { describe, it, expect } from "vitest";
import {
  buildNetworkF12Columns,
  timingPhase,
  buildNetworkTimeline,
  parseCookieHeader,
  lowerHeaderMap,
  buildInitiatorSourceContext,
  buildRequestF12Sections,
  sourceContextLines,
} from "./f12-view.mjs";

// Characterization tests pinning the behavior of the pure F12 / DevTools
// view-model builders carved out of agent-cdp-server.mjs. These lock the F12
// network-row column shape, request timing-phase derivation, cookie-header
// parsing, case-insensitive header lowering, the request-detail section model,
// and the async initiator source-context builder (which takes a getScriptSource
// callback). Coverage here is the net for these helpers, so it asserts concrete
// objective-evidence shapes rather than just smoke-loading the module.

describe("buildNetworkF12Columns", () => {
  it("derives F12 network-row columns from a captured request", () => {
    const cols = buildNetworkF12Columns({
      url: "https://a.com/p?x=1",
      method: "GET",
      status: 200,
      resourceType: "fetch",
      encodedDataLength: 123,
      bodyBytes: 50,
      remoteIPAddress: "1.2.3.4",
      remotePort: 443,
      redirectChain: [{}],
      initiator: { type: "script" },
    });
    expect(cols.name).toBe("p?x=1"); // last path segment + query, via networkDisplayName
    expect(cols.domain).toBe("a.com");
    expect(cols.scheme).toBe("https"); // protocol with trailing ":" stripped
    expect(cols.remoteAddress).toBe("1.2.3.4:443");
    expect(cols.sizeBytes).toBe(123); // encodedDataLength preferred over bodyBytes
    expect(cols.resourceSizeBytes).toBe(50);
    expect(cols.initiatorType).toBe("script");
    expect(cols.flags.redirected).toBe(true);
    expect(cols.flags.hasResponseBody).toBe(true); // bodyBytes present counts as a readable response body
  });

  it("falls back safely when the URL is unparseable", () => {
    const cols = buildNetworkF12Columns({ url: "not a url" });
    expect(cols.domain).toBe("");
    expect(cols.scheme).toBe("");
    expect(cols.method).toBe(null);
    expect(cols.status).toBe(null);
    expect(cols.initiatorStackDepth).toBe(0);
  });
});

describe("timingPhase", () => {
  it("returns the bounded delta between two valid timing keys", () => {
    expect(timingPhase({ a: 10, b: 30 }, "a", "b")).toBe(20);
  });
  it("returns null when a key is missing, negative, or timing is absent", () => {
    expect(timingPhase({ a: 10 }, "a", "b")).toBe(null);
    expect(timingPhase({ a: -1, b: 30 }, "a", "b")).toBe(null);
    expect(timingPhase(null, "a", "b")).toBe(null);
  });
});

describe("buildNetworkTimeline", () => {
  it("maps requests to timeline rows with derived phases and f12 columns", () => {
    const tl = buildNetworkTimeline([
      {
        requestId: "r1",
        url: "https://h.com/x",
        method: "GET",
        status: 200,
        timing: { requestTime: 0, proxyStart: 1, proxyEnd: 2, dnsStart: 2, dnsEnd: 4, sendStart: 5, sendEnd: 6, receiveHeadersEnd: 9 },
      },
    ]);
    expect(tl).toHaveLength(1);
    expect(tl[0].hostname).toBe("h.com");
    expect(tl[0].phases.queueing).toBe(1); // proxyStart - requestTime
    expect(tl[0].phases.dns).toBe(2); // dnsEnd - dnsStart
    expect(tl[0].phases.wait).toBe(3); // receiveHeadersEnd - sendEnd
    expect(tl[0].f12Columns).toBeTruthy();
  });
  it("returns [] for non-array input and null phases when timing is absent", () => {
    expect(buildNetworkTimeline(null)).toEqual([]);
    const tl = buildNetworkTimeline([{ requestId: "r2", url: "https://h.com/y", method: "GET" }]);
    expect(tl[0].phases).toBe(null);
    expect(tl[0].redirectCount).toBe(0);
  });
});

describe("parseCookieHeader", () => {
  it("splits a Cookie header into name/value pairs, defaulting flags to empty value", () => {
    expect(parseCookieHeader("a=b; c=d; flag")).toEqual([
      { name: "a", value: "b" },
      { name: "c", value: "d" },
      { name: "flag", value: "" },
    ]);
    expect(parseCookieHeader("")).toEqual([]);
  });
});

describe("lowerHeaderMap", () => {
  it("lowercases header keys while preserving values", () => {
    expect(lowerHeaderMap({ "Content-Type": "json", "X-Y": "z" })).toEqual({ "content-type": "json", "x-y": "z" });
    expect(lowerHeaderMap()).toEqual({});
  });
});

describe("buildInitiatorSourceContext", () => {
  it("returns no-script-frame when no usable call frame is present", async () => {
    const out = await buildInitiatorSourceContext(async () => ({ scriptSource: "x" }), { callFrames: [{ url: "u" }] });
    expect(out.available).toBe(false);
    expect(out.reason).toBe("no-script-frame");
  });
  it("resolves source via the callback and returns context lines around the frame", async () => {
    const out = await buildInitiatorSourceContext(
      async () => ({ scriptSource: "a\nb\nc\nd\ne" }),
      { callFrames: [{ scriptId: "7", lineNumber: 2 }] },
      1,
    );
    expect(out.available).toBe(true);
    expect(out.frame.scriptId).toBe("7");
    expect(out.lines).toHaveLength(3);
    expect(out.lines.find((l) => l.selected).text).toBe("c");
  });
  it("surfaces a callback failure as script-source-unavailable evidence", async () => {
    const out = await buildInitiatorSourceContext(async () => { throw new Error("boom"); }, { callFrames: [{ scriptId: "7", lineNumber: 2 }] });
    expect(out.available).toBe(false);
    expect(out.reason).toBe("script-source-unavailable");
    expect(out.error).toBe("boom");
  });
});

describe("buildRequestF12Sections", () => {
  it("builds F12 detail tab sections (headers/payload/cookies/timing) from a request entry", () => {
    const sec = buildRequestF12Sections({
      url: "https://a.com/x",
      method: "POST",
      status: 201,
      requestHeaders: { "Content-Type": "application/json", "Cookie": "s=1" },
      responseHeaders: { "Set-Cookie": "t=2" },
      timing: { requestTime: 0, proxyStart: 1, proxyEnd: 2 },
    });
    expect(sec.cookies.requestCookieHeaderPresent).toBe(true);
    expect(sec.cookies.requestCookies).toEqual([{ name: "s", value: "1" }]);
    expect(sec.cookies.setCookieHeader).toBe("t=2");
    expect(sec.payload.requestContentType).toBe("application/json");
    expect(sec.timing.timingSource).toBe("cdp-network-timing");
    expect(sec.boundaries).toHaveLength(3);
  });
  it("marks timing source as wall-clock when no CDP timing is present", () => {
    const sec = buildRequestF12Sections({ url: "https://a.com/x", method: "GET" });
    expect(sec.timing.timingSource).toBe("wall-clock-capture");
    expect(sec.cookies.requestCookieHeaderPresent).toBe(false);
  });
});

describe("sourceContextLines", () => {
  it("returns a window of lines around the target with the selected flag set", () => {
    expect(sourceContextLines("l0\nl1\nl2\nl3\nl4", 2, 1)).toEqual([
      { lineNumber: 1, line: 2, text: "l1", selected: false },
      { lineNumber: 2, line: 3, text: "l2", selected: true },
      { lineNumber: 3, line: 4, text: "l3", selected: false },
    ]);
  });
  it("clamps the window at file boundaries", () => {
    const rows = sourceContextLines("only", 0, 5);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ lineNumber: 0, line: 1, text: "only", selected: true });
  });
});
