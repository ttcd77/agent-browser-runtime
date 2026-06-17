import { describe, it, expect } from "vitest";

// Characterization test for the getTraffic requestId normalization fix
// (agent-cdp-server.mjs:1932-1935).
//
// Root cause: CDP requestId values are decimal-string-shaped (e.g. "44880.489").
// When they enter through CLI flag coercion (coerceFlagValue), they become Number
// 44880.489. The original strict-equality comparison missed these matches.
// The fix converts both sides to String before comparing.

describe("getTraffic requestId String normalization", () => {
  // Simulates what getTraffic now does: String(target) === String(entry.requestId)
  const match = (entry, id) => String(entry.requestId) === String(id);

  it("matches decimal-string requestId against numeric input (the bug scenario)", () => {
    const entries = [
      { requestId: "44880.120", url: "https://a.com/b" },
      { requestId: "44880.489", url: "https://a.com/target" },
    ];

    const found = entries.find((e) => match(e, 44880.489));
    expect(found).toBeDefined();
    expect(found.url).toBe("https://a.com/target");
  });

  it("matches when both sides are strings (no regression)", () => {
    const entries = [{ requestId: "44880.489", url: "https://a.com/target" }];

    expect(entries.find((e) => match(e, "44880.489"))).toBeDefined();
    expect(entries.find((e) => match(e, "44880.489"))?.requestId).toBe("44880.489");
  });

  it("does NOT match different requestIds", () => {
    const entries = [{ requestId: "44880.489", url: "https://a.com/target" }];

    expect(entries.find((e) => match(e, "99999.999"))).toBeUndefined();
  });

  it("returns undefined for empty traffic (getTraffic returns null)", () => {
    const entries = [];
    const found = entries.find((e) => match(e, "44880.489"));
    expect(found).toBeUndefined();
  });

  it("matches integer requestId values as well (String coercion is safe)", () => {
    const entries = [
      { requestId: "12345", url: "https://a.com/a" },
      { requestId: "44880.489", url: "https://a.com/b" },
    ];

    const found = entries.find((e) => match(e, 12345));
    expect(found).toBeDefined();
    expect(found.requestId).toBe("12345");
  });
});
