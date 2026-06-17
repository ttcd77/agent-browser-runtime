import { describe, it, expect } from "vitest";
import {
  normalizePathForCompare,
  domSearchAttributes,
  domSearchNodeSummary,
  normalizeForcedPseudoClasses,
  frameIndexesFromOptions,
  debuggerRemoteObjectSummary,
} from "./dom-debug-utils.mjs";

// Characterization tests pinning the assorted pure DOM/debug helpers carved out
// of agent-cdp-server.mjs. These lock command-line path normalization, the
// flat CDP attribute-array -> object mapping, the DOM node summary (with bounded
// outerHTML), the allowed-forced-pseudo-class filtering, frame-index parsing from
// options/framePath, and the CDP RemoteObject summary (with value truncation).

describe("normalizePathForCompare", () => {
  it("trims, strips wrapping quotes + trailing slashes, lowercases", () => {
    expect(normalizePathForCompare('  "C:\\Users\\X\\Data\\"  ')).toBe("c:\\users\\x\\data");
    expect(normalizePathForCompare("/tmp/foo//")).toBe("/tmp/foo");
    expect(normalizePathForCompare(null)).toBe("");
  });
});

describe("domSearchAttributes", () => {
  it("maps the flat CDP [name, value, ...] array to an object", () => {
    expect(domSearchAttributes(["id", "main", "class", "btn"])).toEqual({ id: "main", class: "btn" });
  });
  it("coerces a dangling name to empty value and stringifies", () => {
    expect(domSearchAttributes(["data-x"])).toEqual({ "data-x": "" });
    expect(domSearchAttributes([])).toEqual({});
  });
});

describe("domSearchNodeSummary", () => {
  it("summarizes a node and parses its attributes", () => {
    const out = domSearchNodeSummary(
      { nodeId: 5, backendNodeId: 9, nodeType: 1, nodeName: "DIV", localName: "div", attributes: ["id", "x"], childNodeCount: 2, frameId: "F1" },
      null,
    );
    expect(out.nodeId).toBe(5);
    expect(out.attributes).toEqual({ id: "x" });
    expect(out.childNodeCount).toBe(2);
    expect(out.frameId).toBe("F1");
    expect(out.outerHTML).toBe(""); // no outerHTMLResult provided
    expect(out.outerHTMLTruncated).toBe(false);
  });
  it("includes bounded outerHTML when provided", () => {
    const out = domSearchNodeSummary({ nodeId: 1 }, { outerHTML: "abcdefghij" }, 4);
    expect(out.outerHTMLTruncated).toBe(true);
    expect(out.outerHTML.length).toBeLessThanOrEqual(10);
  });
});

describe("normalizeForcedPseudoClasses", () => {
  it("keeps allowed pseudo-classes (de-duped, leading colon stripped) and reports skipped", () => {
    const out = normalizeForcedPseudoClasses([":hover", "focus", "hover", "bogus"]);
    expect(out.forced).toEqual(["hover", "focus"]); // de-duplicated, order of first appearance
    expect(out.skipped).toEqual(["bogus"]);
  });
  it("accepts a single string value and handles empty input", () => {
    expect(normalizeForcedPseudoClasses("active")).toEqual({ forced: ["active"], skipped: [] });
    expect(normalizeForcedPseudoClasses(null)).toEqual({ forced: [], skipped: [] });
  });
});

describe("frameIndexesFromOptions", () => {
  it("prefers an explicit integer frameIndexes array", () => {
    expect(frameIndexesFromOptions({ frameIndexes: [0, 2, "3", 1.5] })).toEqual([0, 2, 3]); // non-integers dropped
  });
  it("parses frame[N] tokens from framePath when no array given", () => {
    expect(frameIndexesFromOptions({ framePath: "top > frame[0] > frame[12]" })).toEqual([0, 12]);
    expect(frameIndexesFromOptions({})).toEqual([]);
  });
});

describe("debuggerRemoteObjectSummary", () => {
  it("summarizes a RemoteObject and truncates long string values", () => {
    const out = debuggerRemoteObjectSummary({ type: "string", value: "abcdefghij", description: "str" }, 4);
    expect(out.type).toBe("string");
    expect(out.value).toBe("abcd");
    expect(out.valueTruncated).toBe(true);
  });
  it("passes through non-string values untruncated", () => {
    const out = debuggerRemoteObjectSummary({ type: "number", value: 42 });
    expect(out.value).toBe(42);
    expect(out.valueTruncated).toBe(false);
    const obj = debuggerRemoteObjectSummary({ type: "object", subtype: "null", value: null, unserializableValue: undefined });
    expect(obj.subtype).toBe("null");
    expect(obj.valueTruncated).toBe(false);
  });
});
