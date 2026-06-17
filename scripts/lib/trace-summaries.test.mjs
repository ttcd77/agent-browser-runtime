import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import {
  classifyTraceEvent,
  addTraceBucket,
  summarizeRenderingTimeline,
  summarizeLayoutPaintFlameChart,
  summarizeTraceEvents,
  summarizePerformanceInsights,
  summarizePerformanceObserverSnapshot,
  extractTraceScreenshots,
  findLatestTracePath,
  findRecentTracePaths,
  traceProfile,
  diffMap,
  compareTraceEvents,
  summarizeTraceQuery,
  summarizeCpuProfile,
} from "./trace-summaries.mjs";

// Characterization tests pinning the behavior of the pure trace / performance /
// CPU-profile view-model builders carved out of agent-cdp-server.mjs. They lock
// trace-event phase classification, duration bucketing, the trace-event summary
// shape (microsecond->ms conversion, long-event/screenshot detection), CPU
// profile sample tallying, trace diffing/querying, performance-insight and
// PerformanceObserver coverage, and the filesystem trace-screenshot / trace-path
// helpers. These groups had thin coverage, so the assertions here are the net.

describe("classifyTraceEvent", () => {
  it("buckets trace events into network/loading/scripting/rendering/painting/other", () => {
    expect(classifyTraceEvent("ResourceSendRequest", "loading")).toBe("network");
    expect(classifyTraceEvent("ParseHTML", "")).toBe("loading");
    expect(classifyTraceEvent("FunctionCall", "")).toBe("scripting");
    expect(classifyTraceEvent("Layout", "")).toBe("rendering");
    expect(classifyTraceEvent("Paint", "")).toBe("painting");
    expect(classifyTraceEvent("Foo", "bar")).toBe("other");
  });
});

describe("addTraceBucket", () => {
  it("accumulates count and durationMs into a bucket map in place", () => {
    const map = {};
    addTraceBucket(map, "k", 5);
    addTraceBucket(map, "k", 3, 2);
    expect(map).toEqual({ k: { count: 3, durationMs: 8 } });
  });
});

describe("summarizeTraceEvents", () => {
  it("summarizes counts, time range (us->ms), long events and screenshots", () => {
    const events = [
      { name: "Layout", cat: "devtools.timeline", ts: 1000, dur: 60000, pid: 1, tid: 2 },
      { name: "FunctionCall", cat: "v8", ts: 2000, dur: 1000, pid: 1, tid: 2 },
      { name: "Screenshot", cat: "disabled", ts: 3000, args: { snapshot: "AAAA" } },
    ];
    const s = summarizeTraceEvents(events, 5);
    expect(s.eventCount).toBe(3);
    expect(s.timeRangeMs).toBe(60); // (maxTs(1000+60000) - minTs(1000)) / 1000
    expect(s.longEventCount).toBe(1); // 60000us >= 50_000us threshold
    expect(s.screenshotEventCount).toBe(1);
    expect(s.topNames[0]).toEqual({ name: "Layout", count: 1 });
    expect(s.renderingTimeline).toBeTruthy();
    expect(s.layoutPaintFlameChart).toBeTruthy();
  });
});

describe("summarizeRenderingTimeline / summarizeLayoutPaintFlameChart", () => {
  it("keeps only loading/scripting/rendering/painting/screenshot rows in the timeline", () => {
    const out = summarizeRenderingTimeline([
      { name: "Layout", cat: "x", ts: 1000, dur: 2000, pid: 1, tid: 1 },
      { name: "SomethingElse", cat: "x", ts: 2000, dur: 1000, pid: 1, tid: 1 },
    ]);
    expect(out.eventCount).toBe(1);
    expect(out.rows[0].phase).toBe("rendering");
    expect(out.rows[0].startOffsetMs).toBe(0);
  });
  it("reconstructs same-thread nesting depth for rendering/painting events", () => {
    const out = summarizeLayoutPaintFlameChart([
      { name: "Layout", cat: "x", ts: 1000, dur: 5000, pid: 1, tid: 1 },
      { name: "Paint", cat: "x", ts: 2000, dur: 1000, pid: 1, tid: 1 },
    ]);
    expect(out.eventCount).toBe(2);
    expect(out.maxDepth).toBe(1); // Paint nested inside the still-open Layout
  });
});

describe("summarizeCpuProfile", () => {
  it("tallies sample hits per node and totals time deltas", () => {
    const cpu = summarizeCpuProfile(
      { nodes: [{ id: 1, callFrame: { functionName: "foo", url: "u" }, hitCount: 3 }], samples: [1, 1], timeDeltas: [100, 200] },
      5,
    );
    expect(cpu.nodeCount).toBe(1);
    expect(cpu.sampleCount).toBe(2);
    expect(cpu.totalTimeDeltaUs).toBe(300);
    expect(cpu.totalTimeDeltaMs).toBe(0.3);
    expect(cpu.topNodes[0].sampleHits).toBe(2);
    expect(cpu.topNodes[0].functionName).toBe("foo");
  });
  it("drops nodes with no hits and handles an empty profile", () => {
    const cpu = summarizeCpuProfile({ nodes: [{ id: 1, callFrame: {}, hitCount: 0 }], samples: [], timeDeltas: [] });
    expect(cpu.topNodes).toHaveLength(0);
    expect(summarizeCpuProfile({}).nodeCount).toBe(0);
  });
});

describe("traceProfile / diffMap / compareTraceEvents", () => {
  it("diffs two count maps, dropping zero deltas and sorting by magnitude", () => {
    const before = new Map([["a", 1], ["b", 2]]);
    const after = new Map([["a", 5], ["c", 1]]);
    expect(diffMap(before, after, 10)).toEqual([
      { key: "a", before: 1, after: 5, delta: 4 },
      { key: "b", before: 2, after: 0, delta: -2 },
      { key: "c", before: 0, after: 1, delta: 1 },
    ]);
  });
  it("compares two trace event sets into before/after counts and name deltas", () => {
    const cmp = compareTraceEvents(
      [{ name: "A", ts: 0, dur: 1000, pid: 1, tid: 1 }],
      [{ name: "A", ts: 0, dur: 1000, pid: 1, tid: 1 }, { name: "B", ts: 1, dur: 500, pid: 1, tid: 1 }],
      { limit: 10 },
    );
    expect(cmp.before.eventCount).toBe(1);
    expect(cmp.after.eventCount).toBe(2);
    expect(cmp.deltas.eventCount).toBe(1);
    expect(cmp.deltas.names).toEqual([{ key: "B", before: 0, after: 1, delta: 1 }]);
  });
  it("traceProfile returns count maps keyed by name/category/phase/thread", () => {
    const profile = traceProfile([{ name: "A", cat: "c1", ph: "X", pid: 1, tid: 2, dur: 2000 }]);
    expect(profile.names.get("A")).toBe(1);
    expect(profile.threads.get("1:2")).toBe(1);
    expect(profile.durationsByName.get("A")).toBe(2); // 2000us -> 2ms
  });
});

describe("summarizeTraceQuery", () => {
  it("filters by name, sorts by duration, and counts matched names", () => {
    const events = [
      { name: "A", cat: "cat1", ph: "X", ts: 1000, dur: 5000, pid: 1, tid: 2 },
      { name: "B", cat: "cat2", ph: "X", ts: 2000, dur: 1000, pid: 1, tid: 2 },
      { name: "A", cat: "cat1", ph: "X", ts: 8000, dur: 2000, pid: 1, tid: 3 },
    ];
    const q = summarizeTraceQuery(events, { name: "a", limit: 10 });
    expect(q.matchedCount).toBe(2);
    expect(q.events[0].name).toBe("A");
    expect(q.events[0].durationMs).toBe(5); // longest match first (5000us)
    expect(q.topNames).toEqual([{ key: "A", count: 2 }]);
  });
});

describe("summarizePerformanceInsights", () => {
  it("ranks slow resources and long tasks, normalizes navigation, leaves trace null without a chrome trace", () => {
    const pi = summarizePerformanceInsights(
      { resources: [{ name: "r", duration: 50, initiatorType: "script" }], longTasks: [{ name: "self", startTime: 10, duration: 80 }], navigation: [{ type: "navigate", duration: 200 }] },
      null,
      5,
    );
    expect(pi.resourceCount).toBe(1);
    expect(pi.slowResources[0].duration).toBe(50);
    expect(pi.longTaskCount).toBe(1);
    expect(pi.navigation.duration).toBe(200);
    expect(pi.trace).toBe(null);
  });
});

describe("summarizePerformanceObserverSnapshot", () => {
  it("reports entry-type coverage, layout-shift scores, and long-task counts", () => {
    const po = summarizePerformanceObserverSnapshot(
      {
        entries: [
          { entryType: "longtask", name: "self", startTime: 5, duration: 120 },
          { entryType: "layout-shift", value: 0.1, hadRecentInput: false },
        ],
        requestedEntryTypes: ["longtask", "layout-shift", "foo"],
        supportedEntryTypes: ["longtask", "layout-shift"],
      },
      5,
    );
    expect(po.entryCount).toBe(2);
    expect(po.observedEntryTypes).toEqual(["layout-shift", "longtask"]);
    expect(po.unsupportedEntryTypes).toEqual(["foo"]);
    expect(po.longTasks.count).toBe(1);
    expect(po.layoutShift.totalScore).toBe(0.1);
  });
});

describe("extractTraceScreenshots / findLatestTracePath / findRecentTracePaths (filesystem)", () => {
  it("writes only screenshot frames with a base64 snapshot to disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-summaries-test-"));
    try {
      const frames = extractTraceScreenshots(
        [
          { name: "Screenshot", ts: 111, args: { snapshot: Buffer.from("hello").toString("base64") } },
          { name: "NotShot", ts: 222 },
        ],
        dir,
        { maxScreenshots: 3 },
      );
      expect(frames).toHaveLength(1);
      expect(frames[0].bytes).toBe(5);
      expect(frames[0].mimeType).toBe("image/jpeg");
      expect(existsSync(frames[0].path)).toBe(true);
      expect(extractTraceScreenshots([{ name: "Screenshot", args: { snapshot: "x" } }], null)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("finds the newest and N most recent .json trace files, ignoring non-json", () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-summaries-test-"));
    try {
      writeFileSync(join(dir, "a.json"), "{}");
      writeFileSync(join(dir, "b.json"), "{}");
      writeFileSync(join(dir, "c.txt"), "x");
      const future = new Date(Date.now() + 10000);
      utimesSync(join(dir, "b.json"), future, future); // make b newest
      expect(basename(findLatestTracePath(dir))).toBe("b.json");
      expect(findRecentTracePaths(dir, 2).map((p) => basename(p))).toEqual(["b.json", "a.json"]);
      expect(findLatestTracePath(join(dir, "nope"))).toBe(null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
