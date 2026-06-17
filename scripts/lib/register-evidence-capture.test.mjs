import { describe, it, expect } from "vitest";
import { registerEvidenceCaptureTools } from "./register-evidence-capture.mjs";

// Characterization tests for the Evidence-capture (feedback + capture-control +
// traffic/timeline) tool family carved out of agent-cdp-server.mjs. They lock (a)
// which tools the family registers and their public surface, and (b) that a
// representative handler is correctly wired to its injected deps — in particular the
// shared managedCaptureSessions Map (injected by reference) and profileRegistry.
// Deep handler logic is verbatim-preserved and covered by the f12-view /
// network-summary / feedback-notes unit tests + the tool-registry contract net.

function mockDeps(overrides = {}) {
  return {
    tools: new Map(),
    profileRegistry: {
      getCapture: () => null,
      queryTraffic: () => [],
      readWebSockets: () => [],
      readEventSources: () => [],
      clearCapturedEvidence: () => ({}),
      setCapture: (_n, c) => c,
      touchProfile: async () => {},
      ...overrides.profileRegistry,
    },
    sleep: async () => {},
    resolveProfile: overrides.resolveProfile
      || (async (name) => ({ name: name || "default", tabId: "tab-1", evidenceDir: "/tmp/evidence" })),
    withManagedPageClient: overrides.withManagedPageClient || (async () => ({})),
    startManagedCaptureSession: async () => ({ started: true }),
    stopManagedCaptureSession: async () => ({ stopped: true }),
    clearManagedCaptureSessionBuffer: () => ({ cleared: true }),
    managedCaptureSessions: overrides.managedCaptureSessions || new Map(),
    maybeRoutePersonal: async () => null,
  };
}

describe("registerEvidenceCaptureTools", () => {
  it("registers the evidence-capture family with the expected names", () => {
    const deps = mockDeps();
    registerEvidenceCaptureTools(deps);
    expect([...deps.tools.keys()].sort()).toEqual([
      "browser_capture_bisect",
      "browser_capture_clear",
      "browser_capture_start",
      "browser_capture_status",
      "browser_capture_stop",
      "browser_feedback",
      "browser_issues_log",
      "profile_network_timeline",
      "profile_traffic_query",
      "profile_traffic_summary",
    ]);
  });

  it("every registered tool exposes name + description + object schema + async execute", () => {
    const deps = mockDeps();
    registerEvidenceCaptureTools(deps);
    for (const [name, tool] of deps.tools) {
      expect(tool.name).toBe(name);
      expect(typeof tool.description).toBe("string");
      expect(tool.parameters?.type).toBe("object");
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("browser_capture_status reads the injected shared managedCaptureSessions Map", async () => {
    const sessions = new Map([["t", { live: true }]]);
    const deps = mockDeps({
      managedCaptureSessions: sessions,
      profileRegistry: {
        getCapture: () => ({ enabled: true }),
        queryTraffic: () => [{ requestId: "r-1" }, { requestId: "r-2" }],
      },
    });
    registerEvidenceCaptureTools(deps);
    const result = await deps.tools.get("browser_capture_status").execute("id", { profile: "t" });
    const report = JSON.parse(result.content[0].text);
    expect(report.profile).toBe("t");
    expect(report.persistentCaptureActive).toBe(true);
    expect(report.trafficCount).toBe(2);
  });
});
