import { describe, it, expect } from "vitest";
import { registerSnapshotDomTools } from "./register-snapshot-dom.mjs";

// Characterization tests for the Snapshot/DOM-read tool family carved out of
// agent-cdp-server.mjs. The family is non-contiguous (its three spans straddle two
// other register* calls in source), so these tests lock that exactly the 12 expected
// tools land here. They also verify a representative handler is wired to its injected
// deps — including profileRegistry (a closure param that must be threaded through) and
// the result-format lib helper. Page-injected *PageFunction names are injected and
// stringified verbatim; their behavior is unchanged by the move. Deep handler logic is
// covered by the dom-debug-utils / network-summary / result-format unit tests + the
// tool-registry contract net.

function mockDeps(overrides = {}) {
  const noopPageFn = function pageFn() { return null; };
  return {
    tools: new Map(),
    profileRegistry: {
      touchProfile: async () => {},
      appendEvent: () => "/tmp/ev.json",
      ...overrides.profileRegistry,
    },
    managedPlaywrightDriver: overrides.managedPlaywrightDriver || {},
    resolveProfile: overrides.resolveProfile
      || (async (name) => ({ name: name || "default", tabId: "tab-1", evidenceDir: "/tmp/evidence" })),
    withManagedPageClient: overrides.withManagedPageClient
      || (async (_profile, _tabId, fn) => fn(overrides.client || {}, { id: "tab-1" })),
    resolveNodeIdForSelector: overrides.resolveNodeIdForSelector || (async () => null),
    maybeRoutePersonal: async () => null,
    runProfileAction: async () => ({}),
    runManagedPlaywrightAction: async () => ({}),
    selectInFramePageFunction: noopPageFn,
    styleInFramePageFunction: noopPageFn,
    domSearchFallbackPageFunction: noopPageFn,
    frameAccessPageFunction: noopPageFn,
    frameShadowBoundaryPageFunction: noopPageFn,
    domMutationWatchPageFunction: noopPageFn,
  };
}

describe("registerSnapshotDomTools", () => {
  it("registers the snapshot/DOM-read family with the expected names", () => {
    const deps = mockDeps();
    registerSnapshotDomTools(deps);
    expect([...deps.tools.keys()].sort()).toEqual([
      "browser_accessibility_snapshot",
      "browser_css_styles",
      "browser_dom_mutation_watch",
      "browser_dom_search",
      "browser_dom_snapshot",
      "browser_elements_snapshot",
      "browser_eval",
      "browser_event_listeners",
      "browser_find",
      "browser_frame_tree",
      "browser_screenshot",
      "browser_snapshot",
    ]);
  });

  it("every registered tool exposes name + description + object schema + async execute", () => {
    const deps = mockDeps();
    registerSnapshotDomTools(deps);
    for (const [name, tool] of deps.tools) {
      expect(tool.name).toBe(name);
      expect(typeof tool.description).toBe("string");
      expect(tool.parameters?.type).toBe("object");
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("browser_accessibility_snapshot is wired to injected deps (client + profileRegistry + lib mapper)", async () => {
    let touched = null;
    const client = {
      Accessibility: {
        enable: async () => {},
        getFullAXTree: async () => ({ nodes: [{ nodeId: "1", role: { value: "button" } }, { nodeId: "2", role: { value: "link" } }] }),
      },
    };
    const deps = mockDeps({
      client,
      profileRegistry: { touchProfile: async (name, patch) => { touched = { name, patch }; } },
    });
    registerSnapshotDomTools(deps);
    const result = await deps.tools.get("browser_accessibility_snapshot").execute("id", { profile: "t" });
    const report = JSON.parse(result.content[0].text);
    expect(report.profile).toBe("t");
    expect(report.tabId).toBe("tab-1");
    expect(report.nodeCount).toBe(2);
    expect(report.returned).toBe(2);
    expect(Array.isArray(report.nodes)).toBe(true);
    // profileRegistry was actually threaded through (the dep that was initially missed).
    expect(touched?.name).toBe("t");
  });
});
