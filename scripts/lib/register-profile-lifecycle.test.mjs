import { describe, it, expect } from "vitest";
import { registerProfileLifecycleTools } from "./register-profile-lifecycle.mjs";

// Characterization tests for the Profile-lifecycle + tab-adoption tool family carved
// out of agent-cdp-server.mjs. They lock (a) which tools the family registers and
// their public surface, and (b) that a representative handler is correctly wired to
// its injected deps (profileTargetStatus + profileRegistry) — i.e. no dep dropped
// during the closure carve. Deep handler logic is verbatim-preserved and covered by
// the tool-registry contract net.

function mockDeps(overrides = {}) {
  return {
    tools: new Map(),
    cdpPort: 9222,
    profileRegistry: {
      registryFile: "/tmp/profiles.json",
      deleteProfile: async () => ({ ok: true }),
      ...overrides.profileRegistry,
    },
    defaultProfileName: "default",
    managedPlaywrightDriver: null,
    sleep: async () => {},
    createBrowserContext: async () => "ctx-1",
    createPageTarget: async () => ({ id: "tab-1", url: "about:blank", title: "" }),
    resolveProfile: async (name) => ({ name: name || "default", tabId: "tab-1", evidenceDir: "/tmp/evidence" }),
    runManagedPlaywrightAction: async () => ({ result: {}, capturedTraffic: 0, trafficFile: null, eventFile: null }),
    withManagedPageClient: async () => ({}),
    profileTargetStatus: overrides.profileTargetStatus
      || (async () => ({ profiles: [], pages: [] })),
    findAdoptableTarget: () => null,
    summarizeTargetForRegistry: (t) => t,
    resumableUrlFromProfile: (p, fallback) => p?.url || fallback,
    ...overrides.top,
  };
}

describe("registerProfileLifecycleTools", () => {
  it("registers the profile-lifecycle family with the expected names", () => {
    const deps = mockDeps();
    registerProfileLifecycleTools(deps);
    expect([...deps.tools.keys()].sort()).toEqual([
      "browser_adopt_tab",
      "browser_auth_bootstrap",
      "browser_resume_profile",
      "profile_create",
      "profile_delete",
      "profile_list",
      "profile_resume",
      "profile_warm_from_personal",
    ]);
  });

  it("every registered tool exposes name + description + object schema + async execute", () => {
    const deps = mockDeps();
    registerProfileLifecycleTools(deps);
    for (const [name, tool] of deps.tools) {
      expect(tool.name).toBe(name);
      expect(typeof tool.description).toBe("string");
      expect(tool.parameters?.type).toBe("object");
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("profile_list handler is wired to injected deps (empty status → zero summary)", async () => {
    const deps = mockDeps({
      profileTargetStatus: async () => ({
        profiles: [
          { name: "a", status: "attached" },
          { name: "b", status: "stale" },
          { name: "c", status: "unbound" },
        ],
        pages: [{ id: "tab-1" }],
      }),
    });
    registerProfileLifecycleTools(deps);
    const result = await deps.tools.get("profile_list").execute();
    const report = JSON.parse(result.content[0].text);
    expect(report.summary.total).toBe(3);
    expect(report.summary.attached).toBe(1);
    expect(report.summary.stale).toBe(1);
    expect(report.summary.unbound).toBe(1);
    expect(report.summary.liveTabs).toBe(1);
    expect(report.registryFile).toBe("/tmp/profiles.json");
  });
});
