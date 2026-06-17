import { describe, it, expect } from "vitest";
import { registerCapabilityFacadeTools } from "./register-capability-facades.mjs";

// Characterization tests for the capability / readiness / backend-status facade family
// carved out of agent-cdp-server.mjs. They lock (a) which tools the family registers and
// their public surface, and (b) that a representative handler is correctly wired to its
// injected deps — i.e. no dep dropped during the closure carve. Deep handler logic is
// verbatim-preserved and covered by the capability-catalog unit tests + the tool-registry
// contract net.

function mockDeps(overrides = {}) {
  return {
    tools: new Map(),
    cdpPort: 0,
    profileRegistry: {
      listProfiles: async () => [],
      ...overrides.profileRegistry,
    },
    defaultProfileName: "default",
    options: {},
    recoverManagedCdp: async () => ({ browserVersion: null, recoveryAttempted: false, recovered: false, error: null }),
    managedRuntimeIdentity: () => ({}),
    managedBrowserProcessSummary: () => null,
    managedCdpPortMode: "fixed",
    browserRuntimeIdentity: { reachable: false },
    personalBridgeUrl: "http://127.0.0.1:0",
    personalBridgeHealth: async () => ({ ok: false }),
    callJson: async () => ({ ok: false, status: 0, body: null }),
    cdpJson: async () => null,
    summarizeProfilePortConfig: () => ({ ok: true, next: [] }),
    ...overrides.top,
  };
}

describe("registerCapabilityFacadeTools", () => {
  it("registers the capability-facade family with the expected names", () => {
    const deps = mockDeps();
    registerCapabilityFacadeTools(deps);
    expect([...deps.tools.keys()].sort()).toEqual([
      "browser_backend_status",
      "browser_capabilities",
      "browser_ready",
    ]);
  });

  it("every registered tool exposes name + description + object schema + async execute", () => {
    const deps = mockDeps();
    registerCapabilityFacadeTools(deps);
    for (const [name, tool] of deps.tools) {
      expect(tool.name).toBe(name);
      expect(typeof tool.description).toBe("string");
      expect(tool.parameters?.type).toBe("object");
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("browser_capabilities handler returns the product capability map", async () => {
    const deps = mockDeps();
    registerCapabilityFacadeTools(deps);
    const result = await deps.tools.get("browser_capabilities").execute("id", {});
    const report = JSON.parse(result.content[0].text);
    expect(report.schema).toBe("agent-browser.capabilities.v1");
    expect(report.ok).toBe(true);
  });

  it("browser_backend_status returns the unified router status", async () => {
    const deps = mockDeps();
    registerCapabilityFacadeTools(deps);
    const result = await deps.tools.get("browser_backend_status").execute("id", {});
    const report = JSON.parse(result.content[0].text);
    expect(report.router).toBe("unified-browser-runtime");
    expect(report.managed.backend).toBe("managed-cdp");
  });
});
