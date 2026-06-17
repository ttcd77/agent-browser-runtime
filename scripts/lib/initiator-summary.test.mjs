import { describe, it, expect } from "vitest";
import { buildInitiatorSummary } from "./initiator-summary.mjs";

// Characterization tests pinning the behavior of the pure initiator-stack
// normalizer carved out of agent-cdp-server.mjs. These lock null handling, the
// sync/async-parent frame flattening + relation tagging, the initiator-url
// fallback frame, and the derived url/line/stackDepth so the monolith refactor
// cannot silently change how request initiators are reported.

describe("buildInitiatorSummary", () => {
  it("returns null for a null initiator", () => {
    expect(buildInitiatorSummary(null)).toBe(null);
    expect(buildInitiatorSummary()).toBe(null);
  });

  it("flattens sync + async-parent call frames with relation tags", () => {
    const out = buildInitiatorSummary({
      type: "script",
      url: "https://a.com/app.js",
      lineNumber: 10,
      columnNumber: 5,
      stack: {
        description: "click",
        callFrames: [{ functionName: "onClick", url: "https://a.com/app.js", lineNumber: 10, columnNumber: 5, scriptId: "7" }],
        parent: {
          callFrames: [{ functionName: "dispatch", url: "https://a.com/lib.js", lineNumber: 2, columnNumber: 0, scriptId: "8" }],
        },
      },
    });
    expect(out.type).toBe("script");
    expect(out.url).toBe("https://a.com/app.js");
    expect(out.lineNumber).toBe(10);
    expect(out.stackDepth).toBe(2);
    expect(out.callFrames.map((f) => f.relation)).toEqual(["sync", "parent"]);
    expect(out.stackDescription).toBe("click");
  });

  it("appends an initiator-url frame when the initiator url is not already in the stack", () => {
    const out = buildInitiatorSummary({
      type: "parser",
      url: "https://a.com/page.html",
      lineNumber: 1,
      stack: { callFrames: [{ functionName: "fn", url: "https://a.com/other.js", lineNumber: 3 }] },
    });
    expect(out.stackDepth).toBe(2);
    const last = out.callFrames.at(-1);
    expect(last.relation).toBe("initiator-url");
    expect(last.url).toBe("https://a.com/page.html");
  });

  it("records a parentId marker frame and derives url from frames when initiator.url is absent", () => {
    const out = buildInitiatorSummary({
      type: "script",
      stack: {
        callFrames: [{ functionName: "fn", url: "https://a.com/x.js", lineNumber: 4, columnNumber: 1, scriptId: "1" }],
        parentId: { id: "async-1" },
      },
    });
    expect(out.url).toBe("https://a.com/x.js"); // derived from first frame with a url
    expect(out.callFrames.some((f) => f.relation === "parentId")).toBe(true);
  });
});
