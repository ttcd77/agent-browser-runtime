import { describe, it, expect } from "vitest";
import { registerInteractionTools } from "./register-interaction.mjs";

// Characterization tests for the Interaction tool family (the largest carve) out of
// agent-cdp-server.mjs. They lock (a) which tools the family registers and their public
// surface, and (b) that a representative handler is correctly wired to its injected deps
// (maybeRoutePersonal + profileTargetStatus). The family also pulled in two pure helper
// fns (keySpecFromToken/parseKeyCombo, used by browser_press) and is injected with the
// human-dispatch fns + page-injected *InFramePageFunction names; their behavior is
// verbatim-preserved and covered by the tool-registry contract net.

function noop() { return null; }

function mockDeps(overrides = {}) {
  const base = {
    tools: new Map(),
    profileRegistry: { touchProfile: async () => {}, ...overrides.profileRegistry },
    defaultProfileName: "default",
    managedPlaywrightDriver: overrides.managedPlaywrightDriver || {},
    resolveProfile: async (name) => ({ name: name || "default", tabId: "tab-1", evidenceDir: "/tmp/evidence" }),
    withManagedPageClient: async (_p, _t, fn) => fn(overrides.client || {}, { id: "tab-1" }),
    maybeRoutePersonal: overrides.maybeRoutePersonal || (async () => null),
    runProfileAction: async () => ({}),
    runManagedPlaywrightAction: async () => ({}),
    clickWaitPlan: () => ({}),
    actionTimeoutMs: () => 8000,
    evaluateUntil: async () => ({}),
    pointIsActionable: () => true,
    pointReceivesEvents: () => true,
    focusIsReady: () => true,
    quickPageObservation: async () => ({}),
    captureNetworkForProfile: async () => ({}),
    profileTargetStatus: overrides.profileTargetStatus
      || (async () => ({ pages: [], profiles: [], profileNamesByTab: new Map() })),
    dispatchHumanMouseClick: noop,
    dispatchHumanMouseMove: noop,
    dispatchHumanMouseDoubleClick: noop,
    dispatchHumanDrag: noop,
    dispatchHumanText: noop,
    sleep: async () => {},
    humanDelay: async () => {},
    selectInFramePageFunction: noop,
    clickInFramePageFunction: noop,
    pointInFramePageFunction: noop,
    typeInFramePageFunction: noop,
    focusInFramePageFunction: noop,
  };
  return base;
}

describe("registerInteractionTools", () => {
  it("registers the interaction family with the expected names", () => {
    const deps = mockDeps();
    registerInteractionTools(deps);
    expect([...deps.tools.keys()].sort()).toEqual([
      "browser_click",
      "browser_double_click",
      "browser_drag",
      "browser_hover",
      "browser_navigate",
      "browser_observe",
      "browser_press",
      "browser_scroll",
      "browser_select",
      "browser_stuck",
      "browser_tab_close",
      "browser_tabs",
      "browser_type",
      "browser_upload",
      "browser_wait",
    ]);
  });

  it("every registered tool exposes name + description + object schema + async execute", () => {
    const deps = mockDeps();
    registerInteractionTools(deps);
    for (const [name, tool] of deps.tools) {
      expect(tool.name).toBe(name);
      expect(typeof tool.description).toBe("string");
      expect(tool.parameters?.type).toBe("object");
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("browser_tabs is wired to injected deps (maybeRoutePersonal passthrough + profileTargetStatus)", async () => {
    let routeCalled = false;
    const deps = mockDeps({
      maybeRoutePersonal: async () => { routeCalled = true; return null; },
      profileTargetStatus: async () => ({
        pages: [{ id: "tab-1", title: "T", url: "https://x" }],
        profiles: [{ name: "p", status: "attached", tabId: "tab-1" }, { name: "q", status: "stale", tabId: "tab-2" }],
        profileNamesByTab: new Map([["tab-1", ["p"]]]),
      }),
    });
    registerInteractionTools(deps);
    const result = await deps.tools.get("browser_tabs").execute("id", {});
    const report = JSON.parse(result.content[0].text);
    expect(routeCalled).toBe(true);
    expect(report.tabs).toHaveLength(1);
    expect(report.tabs[0].profiles).toEqual(["p"]);
    expect(report.summary.liveTabs).toBe(1);
    expect(report.summary.attachedProfiles).toBe(1);
    expect(report.summary.staleProfiles).toBe(1);
  });
});
