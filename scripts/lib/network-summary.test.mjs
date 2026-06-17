import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRequestCorrelationGraph,
  flattenFrameTree,
  summarizeNetworkRecords,
  groupCount,
  capturePageKey,
  buildCaptureBisect,
} from "./network-summary.mjs";

// Characterization tests pinning the network evidence summary builders carved out
// of agent-cdp-server.mjs. These lock the correlation-graph node/edge derivation,
// the recursive frame-tree flatten, the network overview counts + recommended
// drilldowns, the generic group-count, the page-key precedence, and the capture
// bisect bucketing (including the optional JSON write to the evidence dir).

describe("flattenFrameTree", () => {
  it("flattens a nested frame tree depth-first", () => {
    const tree = {
      frame: { id: "root" },
      childFrames: [
        { frame: { id: "a" }, childFrames: [{ frame: { id: "a1" } }] },
        { frame: { id: "b" } },
      ],
    };
    expect(flattenFrameTree(tree).map((f) => f.id)).toEqual(["root", "a", "a1", "b"]);
    expect(flattenFrameTree(null)).toEqual([]);
  });
});

describe("groupCount", () => {
  it("counts by key, sorts by count desc, maps missing keys to (none)", () => {
    const rows = [{ h: "x" }, { h: "x" }, { h: "y" }, {}];
    expect(groupCount(rows, (r) => r.h)).toEqual([
      { key: "x", count: 2 },
      { key: "y", count: 1 },
      { key: "(none)", count: 1 },
    ]);
    expect(groupCount()).toEqual([]);
  });
});

describe("capturePageKey", () => {
  it("prefers frameId > loaderId > documentURL > url > fallback", () => {
    expect(capturePageKey({ frameId: "F", loaderId: "L" })).toBe("F");
    expect(capturePageKey({ loaderId: "L", url: "u" })).toBe("L");
    expect(capturePageKey({ documentURL: "d" })).toBe("d");
    expect(capturePageKey({ url: "u" })).toBe("u");
    expect(capturePageKey({})).toBe("(unknown-page)");
  });
});

describe("buildRequestCorrelationGraph", () => {
  it("builds request/frame/script nodes and frame-request + redirect edges", () => {
    const graph = buildRequestCorrelationGraph({
      requests: [
        {
          requestId: "r1",
          method: "GET",
          url: "https://a.com/x",
          status: 200,
          frameId: "frame1",
          redirectChain: [{ url: "https://a.com/old", status: 302 }],
        },
      ],
      frames: [{ id: "frame1", url: "https://a.com/" }],
      scripts: [],
    });
    expect(graph.nodeCount).toBe(graph.nodes.length);
    expect(graph.edgeCount).toBe(graph.edges.length);
    const reqNode = graph.nodes.find((n) => n.type === "request");
    expect(reqNode.id).toBe("request:r1");
    expect(reqNode.f12Columns).toBeTruthy(); // derived via buildNetworkF12Columns
    // frame-request edge from frame node to request node
    expect(graph.edges).toContainEqual({ from: "frame:frame1", to: "request:r1", type: "frame-request" });
    // redirect node + edge
    expect(graph.nodes.some((n) => n.type === "redirect")).toBe(true);
    expect(graph.edges.some((e) => e.type === "redirects-to")).toBe(true);
  });
  it("dedupes nodes by id and respects the limit", () => {
    const requests = Array.from({ length: 10 }, (_, i) => ({ requestId: `r${i}`, url: `https://a/${i}`, method: "GET" }));
    const graph = buildRequestCorrelationGraph({ requests, limit: 3 });
    expect(graph.nodes.length).toBeLessThanOrEqual(3);
  });
});

describe("summarizeNetworkRecords", () => {
  it("aggregates counts and recommends concrete drilldowns", () => {
    const requests = [
      { requestId: "ok", url: "https://a.com/ok", method: "GET", status: 200, resourceType: "fetch", encodedDataLength: 100, timing: { requestTime: 0, receiveHeadersEnd: 10 } },
      { requestId: "bad", url: "https://b.com/err", method: "POST", status: 500, resourceType: "xhr", errorText: "boom" },
      { requestId: "redir", url: "https://a.com/r", method: "GET", status: 301, redirectChain: [{ url: "https://a.com/r2", status: 301 }] },
    ];
    const out = summarizeNetworkRecords(requests, [], 10);
    expect(out.requestCount).toBe(3);
    expect(out.failedCount).toBe(1); // status >= 400
    expect(out.redirectCount).toBe(1);
    expect(out.byStatus["200"]).toBe(1);
    expect(out.byHost["a.com"]).toBe(2);
    // recommended drilldowns include a request_detail for the failed request
    const failedDrill = out.recommendedDrilldowns.find((d) => d.input.requestId === "bad");
    expect(failedDrill.tool).toBe("profile_request_detail");
  });
  it("adds a realtime drilldown when websockets are present", () => {
    const out = summarizeNetworkRecords([], [{ requestId: "ws", url: "wss://a", frames: [] }], 5);
    expect(out.websocketCount).toBe(1);
    expect(out.recommendedDrilldowns.some((d) => d.tool === "profile_realtime_log")).toBe(true);
  });
});

describe("buildCaptureBisect", () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "network-summary-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("buckets requests by page and writes the bisect JSON when save=true", () => {
    const out = buildCaptureBisect({
      profile: "researcher",
      evidenceDir: dir,
      capture: { label: "win" },
      requests: [
        { requestId: "a", url: "https://x/1", method: "GET", status: 200, frameId: "f1", resourceType: "fetch" },
        { requestId: "b", url: "https://x/2", method: "POST", status: 404, frameId: "f1", resourceType: "xhr", failed: true },
        { requestId: "c", url: "https://y/3", method: "GET", status: 200, frameId: "f2", resourceType: "document" },
      ],
      websockets: [],
      save: true,
    });
    expect(out.backend).toBe("managed-cdp");
    expect(out.totalEvents).toBe(3);
    expect(out.buckets.network.requestCount).toBe(3);
    expect(out.buckets.network.failedCount).toBe(1); // status 404 counts as failed
    expect(out.buckets.pages.pageCount).toBe(2); // f1, f2
    expect(out.bucketCount).toBe(3);
    expect(existsSync(out.bisectPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(out.bisectPath, "utf8"));
    expect(onDisk.totalEvents).toBe(3);
    expect(typeof out.bisectBytes).toBe("number");
  });

  it("does not write a file when save=false", () => {
    const out = buildCaptureBisect({ profile: "p", evidenceDir: dir, requests: [], save: false });
    expect(out.bisectPath).toBeUndefined();
    expect(out.totalEvents).toBe(0);
  });
});
