import { describe, it, expect } from "vitest";
import { registerEvidenceConsoleTools } from "./register-evidence-console.mjs";

// Characterization tests for the Evidence-console (console panel + request/traffic
// detail) tool family carved out of agent-cdp-server.mjs. They lock (a) which tools
// the family registers and their public surface, and (b) that a representative
// handler is correctly wired to its injected deps (resolveProfile + profileRegistry)
// — i.e. no dep dropped during the closure carve. Deep handler logic is
// verbatim-preserved and covered by the f12-view / inspect-readiness unit tests + the
// tool-registry contract net.

function mockDeps(overrides = {}) {
  return {
    tools: new Map(),
    profileRegistry: {
      getTraffic: () => null,
      touchProfile: async () => {},
      ...overrides.profileRegistry,
    },
    sleep: async () => {},
    resolveProfile: overrides.resolveProfile
      || (async (name) => ({ name: name || "default", tabId: "tab-1", evidenceDir: "/tmp/evidence" })),
    withManagedPageClient: overrides.withManagedPageClient || (async () => ({})),
    maybeRoutePersonal: overrides.maybeRoutePersonal || (async () => null),
  };
}

describe("registerEvidenceConsoleTools", () => {
  it("registers the evidence-console family with the expected names", () => {
    const deps = mockDeps();
    registerEvidenceConsoleTools(deps);
    expect([...deps.tools.keys()].sort()).toEqual([
      "browser_console_log",
      "browser_console_source_context",
      "profile_request_detail",
      "profile_request_payload",
      "profile_traffic_get",
    ]);
  });

  it("every registered tool exposes name + description + object schema + async execute", () => {
    const deps = mockDeps();
    registerEvidenceConsoleTools(deps);
    for (const [name, tool] of deps.tools) {
      expect(tool.name).toBe(name);
      expect(typeof tool.description).toBe("string");
      expect(tool.parameters?.type).toBe("object");
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("profile_traffic_get handler is wired to injected deps (missing record → error)", async () => {
    const deps = mockDeps({ profileRegistry: { getTraffic: () => null } });
    registerEvidenceConsoleTools(deps);
    const result = await deps.tools.get("profile_traffic_get").execute("id", { profile: "t", requestId: "r-1" });
    const report = JSON.parse(result.content[0].text);
    expect(report.profile).toBe("t");
    expect(report.error).toBe("request_not_found");
    expect(report.requestId).toBe("r-1");
  });

  it("profile_traffic_get handler returns a found record from the injected registry", async () => {
    const deps = mockDeps({
      profileRegistry: { getTraffic: () => ({ requestId: "r-1", bodyPath: "/tmp/b", bodyText: "x" }) },
    });
    registerEvidenceConsoleTools(deps);
    const result = await deps.tools.get("profile_traffic_get").execute("id", { profile: "t", requestId: "r-1" });
    const report = JSON.parse(result.content[0].text);
    expect(report.entry?.requestId).toBe("r-1");
    expect(report.bodyPath).toBe("/tmp/b");
    expect(report.error).toBeUndefined();
  });
});
