import { describe, it, expect } from "vitest";
import {
  rangeLength,
  summarizeCoverageRanges,
  coverageSnippet,
  coverageByteSummary,
} from "./coverage.mjs";

// Characterization tests pinning the pure JS/CSS coverage helpers carved out of
// agent-cdp-server.mjs. These lock the range-length floor, the flatten + sort +
// used-flag derivation over CDP function ranges, the offset-clamped source
// snippet (delegating truncation to truncateText), and the used/unused/ratio
// byte summary with its fallback-total behavior.

describe("rangeLength", () => {
  it("returns end-start, floored at 0", () => {
    expect(rangeLength({ startOffset: 10, endOffset: 40 })).toBe(30);
    expect(rangeLength({ startOffset: 40, endOffset: 10 })).toBe(0); // negative floored
    expect(rangeLength({})).toBe(0);
  });
});

describe("summarizeCoverageRanges", () => {
  it("flattens function ranges, sets used flag, and sorts by offset", () => {
    const out = summarizeCoverageRanges([
      {
        functionName: "b",
        ranges: [
          { startOffset: 50, endOffset: 80, count: 0 },
          { startOffset: 0, endOffset: 20, count: 3 },
        ],
      },
      {
        functionName: "a",
        ranges: [{ startOffset: 20, endOffset: 50, count: 1 }],
      },
    ]);
    expect(out.map((r) => r.startOffset)).toEqual([0, 20, 50]); // sorted ascending
    expect(out[0]).toEqual({ functionName: "b", startOffset: 0, endOffset: 20, count: 3, used: true, bytes: 20 });
    expect(out[1].functionName).toBe("a");
    expect(out[2].used).toBe(false); // count 0 => unused
    expect(out[2].bytes).toBe(30);
  });
  it("handles empty / missing input", () => {
    expect(summarizeCoverageRanges()).toEqual([]);
    expect(summarizeCoverageRanges([{ functionName: "x" }])).toEqual([]); // no ranges
  });
});

describe("coverageSnippet", () => {
  it("slices source between clamped offsets", () => {
    const out = coverageSnippet("0123456789", { startOffset: 2, endOffset: 6 });
    expect(out).toEqual({ startOffset: 2, endOffset: 6, text: "2345", truncated: false });
  });
  it("clamps offsets into the source bounds", () => {
    const out = coverageSnippet("abc", { startOffset: -5, endOffset: 99 });
    expect(out.startOffset).toBe(0);
    expect(out.endOffset).toBe(3);
    expect(out.text).toBe("abc");
  });
  it("marks truncated when slice exceeds maxChars", () => {
    const out = coverageSnippet("abcdefghij", { startOffset: 0, endOffset: 10 }, 4);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(10);
  });
});

describe("coverageByteSummary", () => {
  it("sums used/unused bytes and computes ratio against derived total", () => {
    const ranges = [
      { used: true, bytes: 30, endOffset: 30 },
      { used: false, bytes: 70, endOffset: 100 },
    ];
    const out = coverageByteSummary(ranges, 0);
    expect(out.totalBytes).toBe(100); // max endOffset
    expect(out.usedBytes).toBe(30);
    expect(out.unusedBytes).toBe(70);
    expect(out.usedRatio).toBeCloseTo(0.3);
  });
  it("uses fallbackTotalBytes when larger than max endOffset and null ratio when total is 0", () => {
    const out = coverageByteSummary([{ used: true, bytes: 10, endOffset: 10 }], 1000);
    expect(out.totalBytes).toBe(1000); // fallback wins
    expect(out.usedRatio).toBeCloseTo(0.01);
    const empty = coverageByteSummary([], 0);
    expect(empty.totalBytes).toBe(0);
    expect(empty.usedRatio).toBe(null);
  });
});
