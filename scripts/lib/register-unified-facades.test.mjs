import { describe, it, expect } from "vitest";
import { registerUnifiedFacades } from "./register-unified-facades.mjs";

// Characterization tests for the unified browser facade family carved out of
// agent-cdp-server.mjs. They lock (a) which facades the family registers and their public
// surface, and (b) the H2 contract: the two handlers that report the sticky active backend
// read it through the injected getLastBoundBackend() accessor (an arrow over the worker's
// closure `let lastBoundBackend`), not a captured snapshot. Deep facade logic is verbatim-
// preserved and covered by the contract net + the tools each facade delegates to.

// browser_security_pack / browser_auth_boundary borrow .parameters from these
// canonical browser_* targets AT REGISTRATION (F4 renamed from devtools_*).
// Seed them so the family can register without null-deref on .parameters.
function seedAliasTargets(tools) {
  for (const name of [
    "browser_security_research_pack",
    "browser_auth_boundary_report",
    "browser_capture_diff",
  ]) {
    if (!tools.has(name)) {
      tools.set(name, {
        name,
        description: `stub target ${name}`,
        parameters: { type: "object", properties: {} },
        async execute() { return { content: [{ type: "text", text: "{}" }] }; },
      });
    }
  }
  return tools;
}

function mockDeps(overrides = {}) {
  return {
    tools: seedAliasTargets(overrides.tools || new Map()),
    defaultProfileName: "default",
    profileRegistry: {
      ensureProfileRecord: async () => ({ name: "default", evidenceDir: "/tmp/evidence" }),
      listProfiles: () => [],
      ...overrides.profileRegistry,
    },
    // engine-collapse: the worker always constructs managedPlaywrightDriver. Tests that
    // exercise a driver-dependent path inject a stub via overrides.managedPlaywrightDriver.
    managedPlaywrightDriver: overrides.managedPlaywrightDriver || {},
    resolveProfile: async (name) => ({ name: name || "default", evidenceDir: "/tmp/evidence" }),
    withManagedPageClient: async () => ({}),
    maybeRoutePersonal: overrides.maybeRoutePersonal || (async () => null),
    withBackendParameters: (parameters) => parameters,
    rememberActiveBackend: overrides.rememberActiveBackend || (() => {}),
    profileTargetStatus: overrides.profileTargetStatus || (async () => ({ profiles: [] })),
    runManagedPlaywrightAction: async () => ({ result: {}, capturedTraffic: 0 }),
    getLastBoundBackend: overrides.getLastBoundBackend || (() => "managed"),
  };
}

const EXPECTED = [
  "browser_act",
  "browser_auth_boundary",
  "browser_capture",
  "browser_diff",
  "browser_inspect",
  "browser_open",
  "browser_raw",
  "browser_replay",
  "browser_security_pack",
  "browser_text",
];

describe("registerUnifiedFacades", () => {
  it("registers the unified facade family with the expected names", () => {
    const tools = new Map();
    const before = new Set([...seedAliasTargets(tools).keys()]);
    registerUnifiedFacades(mockDeps({ tools }));
    const added = [...tools.keys()].filter((k) => !before.has(k)).sort();
    expect(added).toEqual(EXPECTED);
  });

  it("every registered facade exposes name + description + object schema + async execute", () => {
    const deps = mockDeps();
    registerUnifiedFacades(deps);
    for (const name of EXPECTED) {
      const tool = deps.tools.get(name);
      expect(tool.name).toBe(name);
      expect(typeof tool.description).toBe("string");
      expect(tool.parameters?.type).toBe("object");
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("browser_open reports activeBackend via the injected getLastBoundBackend() accessor (H2)", async () => {
    // engine-collapse: browser_open always drives the single managed Playwright engine
    // (managedPlaywrightDriver is always constructed). url is supplied so the handler opens
    // the page via runManagedPlaywrightAction and returns activeBackend: getLastBoundBackend().
    const tools = new Map();
    // Prove it is the LIVE accessor, not a snapshot: flip the value before the call.
    let bound = "managed";
    const deps = mockDeps({
      tools,
      managedPlaywrightDriver: { open: async () => ({}) },
      getLastBoundBackend: () => bound,
    });
    registerUnifiedFacades(deps);
    bound = "personal";
    const result = await deps.tools.get("browser_open").execute("id", { url: "https://example.com" });
    const report = JSON.parse(result.content[0].text);
    expect(report.facade).toBe("browser_open");
    expect(report.backend).toBe("managed-playwright");
    expect(report.activeBackend).toBe("personal"); // reflects the live let, not the registration-time value
  });

  it("browser_raw rejects tools outside devtools_* / browser_* / profile_* namespaces", async () => {
    const deps = mockDeps();
    registerUnifiedFacades(deps);
    await expect(deps.tools.get("browser_raw").execute("id", { tool: "something_random" }))
      .rejects.toThrow(/only allows devtools_/);
  });

  it("C-03: browser_raw forwards top-level profile to the inner devtools tool", async () => {
    const deps = mockDeps();
    // Register a mock devtools tool that echoes back whatever profile it received.
    deps.tools.set("devtools_status", {
      name: "devtools_status",
      description: "mock",
      parameters: { type: "object", properties: {} },
      async execute(_id, input) {
        return { content: [{ type: "text", text: JSON.stringify({ profile: input.profile, ok: true }) }] };
      },
    });
    registerUnifiedFacades(deps);
    const result = await deps.tools.get("browser_raw").execute("id", {
      tool: "devtools_status",
      profile: "my-profile",
      input: {},
    });
    const parsed = JSON.parse(result.content[0].text);
    // The outer response should carry the profile
    expect(parsed.profile).toBe("my-profile");
    // The inner devtools tool should have received the profile
    expect(parsed.result.profile).toBe("my-profile");
  });
});
