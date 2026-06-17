import { describe, it, expect } from "vitest";
import {
  requestDurationMs,
  hostnameForUrl,
  networkDisplayName,
  pickFilterValue,
  booleanFilterValue,
  headerMatches,
  networkRequestMatchesFilters,
  sortNetworkRequests,
  filterNetworkRequests,
  limitNetworkRequests,
} from "./network-filters.mjs";

// Characterization tests pinning the behavior of the pure network request-shape
// and filter/sort/limit helpers carved out of agent-cdp-server.mjs. These lock
// URL/host/duration derivation, the snake_case+camelCase filter aliasing,
// boolean coercion, header matching, and the sort/limit semantics so the
// monolith refactor cannot silently change how agents slice network evidence.

describe("hostnameForUrl / networkDisplayName / requestDurationMs", () => {
  it("derives hostname, display name, and duration, falling back safely", () => {
    expect(hostnameForUrl("https://a.com:8443/x")).toBe("a.com");
    expect(hostnameForUrl("xx")).toBe("");
    expect(networkDisplayName("https://a.com/p/file.js?x=1")).toBe("file.js?x=1");
    expect(requestDurationMs({})).toBe(null);
    expect(requestDurationMs({ timestamp: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z" })).toBe(1000);
  });
});

describe("pickFilterValue / booleanFilterValue", () => {
  it("picks the first present non-empty alias", () => {
    expect(pickFilterValue({ a: "", b: "v" }, "a", "b")).toBe("v");
    expect(pickFilterValue({}, "a")).toBe(undefined);
  });
  it("coerces booleans from strings/numbers, null when unset/ambiguous", () => {
    expect(booleanFilterValue({ x: "yes" }, "x")).toBe(true);
    expect(booleanFilterValue({ x: "0" }, "x")).toBe(false);
    expect(booleanFilterValue({ x: 5 }, "x")).toBe(true);
    expect(booleanFilterValue({}, "x")).toBe(null);
    expect(booleanFilterValue({ x: "maybe" }, "x")).toBe(null);
  });
});

describe("headerMatches", () => {
  it("matches by name and valueContains case-insensitively", () => {
    expect(headerMatches({ "Set-Cookie": "a=b" }, { name: "set-cookie", valueContains: "a=" })).toBe(true);
    expect(headerMatches({ "Set-Cookie": "a=b" }, { name: "authorization" })).toBe(false);
    expect(headerMatches({ "X": "1" }, {})).toBe(true); // empty filter matches
  });
});

describe("networkRequestMatchesFilters / filterNetworkRequests", () => {
  const rows = [
    { method: "GET", url: "https://a.com/x", status: 200 },
    { method: "POST", url: "https://b.com/y", status: 404 },
  ];
  it("filters by hostname", () => {
    expect(filterNetworkRequests(rows, { hostname: "a.com" })).toHaveLength(1);
  });
  it("filters by the failed flag (status>=400 counts as failed)", () => {
    expect(filterNetworkRequests(rows, { failed: true }).map((r) => r.status)).toEqual([404]);
  });
  it("matches a single entry against a filter set", () => {
    expect(networkRequestMatchesFilters(rows[0], { method: "get" })).toBe(true);
    expect(networkRequestMatchesFilters(rows[0], { method: "post" })).toBe(false);
  });
});

describe("sortNetworkRequests / limitNetworkRequests", () => {
  const rows = [
    { method: "GET", url: "https://a.com/x", status: 200 },
    { method: "POST", url: "https://b.com/y", status: 404 },
  ];
  it("sorts by status descending by default", () => {
    expect(sortNetworkRequests(rows, { sort_by: "status" }).map((r) => r.status)).toEqual([404, 200]);
  });
  it("returns rows unchanged when no sort key is given", () => {
    expect(sortNetworkRequests(rows, {})).toBe(rows);
  });
  it("limits from the tail by default, from the head when sorted", () => {
    expect(limitNetworkRequests([1, 2, 3, 4], {}, 2)).toEqual([3, 4]);
    expect(limitNetworkRequests([1, 2, 3, 4], { sort_by: "status" }, 2)).toEqual([1, 2]);
  });
});
