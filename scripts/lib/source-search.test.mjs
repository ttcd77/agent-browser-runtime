import { describe, it, expect } from "vitest";
import { findSourceMatches } from "./source-search.mjs";

// Characterization tests pinning the behavior of the pure literal-search helper
// carved out of agent-cdp-server.mjs. These lock match positions, the 1-based
// line numbering, 0-based column, case handling, snippet windowing, and the
// maxMatches cap so artifact/source search drill-down cannot silently change.

describe("findSourceMatches", () => {
  it("returns 1-based line and 0-based column for each match", () => {
    const text = "alpha\nbeta token gamma\ntoken";
    const out = findSourceMatches(text, "token");
    expect(out).toHaveLength(2);
    expect(out[0].line).toBe(2);
    expect(out[0].column).toBe(5); // "beta " is 5 chars before token on line 2
    expect(out[1].line).toBe(3);
    expect(out[1].column).toBe(0);
  });

  it("is case-insensitive by default and case-sensitive when asked", () => {
    expect(findSourceMatches("Foo foo FOO", "foo")).toHaveLength(3);
    expect(findSourceMatches("Foo foo FOO", "foo", { caseSensitive: true })).toHaveLength(1);
  });

  it("honors the maxMatches cap", () => {
    const text = "x".repeat(0) + "ab ab ab ab ab";
    expect(findSourceMatches(text, "ab", { maxMatches: 2 })).toHaveLength(2);
  });

  it("windows the snippet by contextChars around the match", () => {
    const text = "0123456789TARGET0123456789";
    const [m] = findSourceMatches(text, "TARGET", { contextChars: 3 });
    expect(m.index).toBe(10);
    // 3 chars before + "TARGET" + 3 chars after
    expect(m.snippet).toBe("789TARGET012");
  });

  it("returns no matches for empty query or no hit", () => {
    expect(findSourceMatches("hello", "")).toEqual([]);
    expect(findSourceMatches("hello", "zzz")).toEqual([]);
  });

  it("advances past zero-length-safe and overlapping cases without looping", () => {
    // needle longer than 1 char, overlapping occurrences counted non-overlapping
    const out = findSourceMatches("aaaa", "aa");
    expect(out.map((m) => m.index)).toEqual([0, 2]);
  });
});
