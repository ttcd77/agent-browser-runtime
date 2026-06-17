import { describe, it, expect } from "vitest";
import { truncateText } from "./text-utils.mjs";

// Characterization tests pinning truncateText, the shared text-truncation leaf
// carved out of agent-cdp-server.mjs. It coerces nullish input to "", treats a
// non-positive / non-finite maxChars as "no limit", and reports whether the
// returned text was cut. Several evidence builders depend on this exact shape.

describe("truncateText", () => {
  it("returns the full text untruncated when within the limit", () => {
    expect(truncateText("hello", 10)).toEqual({ text: "hello", truncated: false });
  });
  it("slices to maxChars and flags truncation when over the limit", () => {
    expect(truncateText("hello world", 5)).toEqual({ text: "hello", truncated: true });
  });
  it("coerces nullish input to an empty string", () => {
    expect(truncateText(null)).toEqual({ text: "", truncated: false });
    expect(truncateText(undefined)).toEqual({ text: "", truncated: false });
  });
  it("treats a non-positive or non-finite maxChars as no limit", () => {
    expect(truncateText("abc", 0)).toEqual({ text: "abc", truncated: false });
    expect(truncateText("abc", -1)).toEqual({ text: "abc", truncated: false });
    expect(truncateText("abc", Infinity)).toEqual({ text: "abc", truncated: false });
  });
});
