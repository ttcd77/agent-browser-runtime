import { describe, it, expect } from "vitest";
import { registerRealtimeHarTools } from "./register-realtime-har.mjs";

// Characterization tests for the Realtime (WebSocket/SSE) + HAR tool family carved
// out of agent-cdp-server.mjs. They lock (a) which tools the family registers and
// their public surface, and (b) that a representative handler is correctly wired to
// its injected deps (resolveProfile + profileRegistry) — i.e. no dep dropped during
// the closure carve. Deep handler logic is verbatim-preserved and covered by the
// f12-view / network-har unit tests + the tool-registry contract net.

function mockDeps(overrides = {}) {
  return {
    tools: new Map(),
    profileRegistry: {
      readWebSockets: () => [],
      readEventSources: () => [],
      getCapture: () => null,
      queryTraffic: () => [],
      ...overrides.profileRegistry,
    },
    resolveProfile: overrides.resolveProfile
      || (async (name) => ({ name: name || "default", evidenceDir: "/tmp/evidence" })),
    maybeRoutePersonal: async () => null,
  };
}

describe("registerRealtimeHarTools", () => {
  it("registers the realtime + HAR family with the expected names", () => {
    const deps = mockDeps();
    registerRealtimeHarTools(deps);
    expect([...deps.tools.keys()].sort()).toEqual([
      "profile_export_har",
      "profile_har_completeness",
      "profile_realtime_log",
      "profile_save_har",
    ]);
  });

  it("every registered tool exposes name + description + object schema + async execute", () => {
    const deps = mockDeps();
    registerRealtimeHarTools(deps);
    for (const [name, tool] of deps.tools) {
      expect(tool.name).toBe(name);
      expect(typeof tool.description).toBe("string");
      expect(tool.parameters?.type).toBe("object");
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("profile_realtime_log handler is wired to injected deps (empty capture → zero counts)", async () => {
    const deps = mockDeps();
    registerRealtimeHarTools(deps);
    const result = await deps.tools.get("profile_realtime_log").execute("id", { profile: "t" });
    const report = JSON.parse(result.content[0].text);
    expect(report.backend).toBe("managed-cdp");
    expect(report.profile).toBe("t");
    expect(report.websocketCount).toBe(0);
    expect(report.eventSourceMessageCount).toBe(0);
  });
});
