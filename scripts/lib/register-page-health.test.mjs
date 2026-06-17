import { describe, it, expect } from "vitest";
import { registerPageHealthTools } from "./register-page-health.mjs";

// Characterization tests for the Page-health (security/diagnostics/signal/hard-reload)
// tool family carved out of agent-cdp-server.mjs. The family is non-contiguous in the
// source (browser_accessibility_snapshot, a snapshot-dom tool, is interleaved and stays
// in the closure), so these tests also lock that exactly the four page-health tools land
// here. They further check a representative handler is wired to its injected deps
// (resolveProfile + withManagedPageClient + profileRegistry). Deep handler logic is
// verbatim-preserved and covered by the network-summary / evidence-summaries /
// network-filters unit tests + the tool-registry contract net.

function mockDeps(overrides = {}) {
  return {
    tools: new Map(),
    profileRegistry: {
      queryTraffic: () => [],
      readWebSockets: () => [],
      getCapture: () => null,
      touchProfile: async () => {},
      clearTraffic: () => {},
      setCapture: (_n, c) => c,
      appendEvent: () => "/tmp/ev.json",
      ...overrides.profileRegistry,
    },
    resolveProfile: overrides.resolveProfile
      || (async (name) => ({ name: name || "default", tabId: "tab-1", evidenceDir: "/tmp/evidence" })),
    withManagedPageClient: overrides.withManagedPageClient
      || (async (_profile, _tabId, fn) => fn(overrides.client || {}, { id: "tab-1" })),
    captureNetworkForProfile: overrides.captureNetworkForProfile
      || (async () => ({ capturedTraffic: 0, trafficFile: null })),
    maybeRoutePersonal: async () => null,
  };
}

describe("registerPageHealthTools", () => {
  it("registers exactly the page-health family (accessibility tool is NOT here)", () => {
    const deps = mockDeps();
    registerPageHealthTools(deps);
    expect([...deps.tools.keys()].sort()).toEqual([
      "browser_hard_reload",
      "browser_page_diagnostics",
      "browser_security_summary",
      "browser_signal_summary",
    ]);
  });

  it("every registered tool exposes name + description + object schema + async execute", () => {
    const deps = mockDeps();
    registerPageHealthTools(deps);
    for (const [name, tool] of deps.tools) {
      expect(tool.name).toBe(name);
      expect(typeof tool.description).toBe("string");
      expect(tool.parameters?.type).toBe("object");
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("browser_security_summary handler is wired to injected deps (client + traffic store)", async () => {
    const client = {
      Runtime: { evaluate: async () => ({ result: { value: { url: "https://x", protocol: "https:" } } }) },
    };
    const deps = mockDeps({
      client,
      profileRegistry: {
        queryTraffic: () => [
          { requestId: "r-1", url: "https://x/a", securityDetails: { protocol: "TLS 1.3", subjectName: "x" } },
        ],
        touchProfile: async () => {},
      },
    });
    registerPageHealthTools(deps);
    const result = await deps.tools.get("browser_security_summary").execute("id", { profile: "t" });
    const report = JSON.parse(result.content[0].text);
    expect(report.profile).toBe("t");
    expect(report.tabId).toBe("tab-1");
    expect(report.tlsCount).toBe(1);
    expect(report.tlsByHost.x).toBeTruthy();
  });
});
