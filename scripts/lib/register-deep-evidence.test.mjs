import { describe, it, expect } from "vitest";
import { registerDeepEvidenceTools } from "./register-deep-evidence.mjs";

// Characterization tests for the Deep-evidence (debugger / sources / source-maps /
// traces / coverage / memory / token-scan) tool family carved out of
// agent-cdp-server.mjs. The family is non-contiguous (its two source spans straddle the
// research-pack/composite family, left in the closure), so these tests lock that exactly
// the 22 expected tools land here. They also verify a representative handler is wired to
// its injected deps (resolveProfile + withManagedPageClient + profileRegistry). The three
// injected unexported module-level helpers (sourceMatches / buildSourceSearchDrilldowns /
// debuggerPausedSummary) and tokenFlowTracePageFunction are verbatim-preserved and
// covered by the source-map / trace-summaries / coverage unit tests + the contract net.

function mockDeps(overrides = {}) {
  return {
    tools: new Map(),
    profileRegistry: { touchProfile: async () => {}, ...overrides.profileRegistry },
    resolveProfile: async (name) => ({ name: name || "default", tabId: "tab-1", evidenceDir: "/tmp/evidence" }),
    withManagedPageClient: async (_p, _t, fn) => fn(overrides.client || {}, { id: "tab-1" }),
    sleep: async () => {},
    tokenFlowTracePageFunction: function pageFn() { return null; },
    sourceMatches: () => true,
    buildSourceSearchDrilldowns: () => [],
    debuggerPausedSummary: async () => ({}),
    maybeRoutePersonal: async () => null,
  };
}

describe("registerDeepEvidenceTools", () => {
  it("registers the deep-evidence family with the expected names", () => {
    const deps = mockDeps();
    registerDeepEvidenceTools(deps);
    expect([...deps.tools.keys()].sort()).toEqual([
      "browser_cdp_command",
      "browser_chrome_trace",
      "browser_coverage_detail",
      "browser_coverage_snapshot",
      "browser_cpu_profile",
      "browser_debugger_control",
      "browser_heap_snapshot",
      "browser_memory_snapshot",
      "browser_performance_insights",
      "browser_performance_observer",
      "browser_performance_trace",
      "browser_source_get",
      "browser_source_map_metadata",
      "browser_source_map_source_get",
      "browser_source_map_sources",
      "browser_source_pretty_print",
      "browser_sources_list",
      "browser_sources_search",
      "browser_token_flow_trace",
      "browser_token_scan",
      "browser_trace_compare",
      "browser_trace_query",
    ]);
  });

  it("every registered tool exposes name + description + object schema + async execute", () => {
    const deps = mockDeps();
    registerDeepEvidenceTools(deps);
    for (const [name, tool] of deps.tools) {
      expect(tool.name).toBe(name);
      expect(typeof tool.description).toBe("string");
      expect(tool.parameters?.type).toBe("object");
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("browser_cdp_command is wired to injected deps (validates method, sends via client)", async () => {
    let sent = null;
    const client = { send: async (method, params) => { sent = { method, params }; return { ok: true }; } };
    const deps = mockDeps({ client });
    registerDeepEvidenceTools(deps);
    const result = await deps.tools.get("browser_cdp_command").execute("id", {
      profile: "t",
      method: "Runtime.evaluate",
      params: { expression: "1+1" },
    });
    const report = JSON.parse(result.content[0].text);
    expect(report.profile).toBe("t");
    expect(report.tabId).toBe("tab-1");
    expect(report.method).toBe("Runtime.evaluate");
    expect(sent?.method).toBe("Runtime.evaluate");
    expect(report.result).toEqual({ ok: true });
  });

  it("browser_cdp_command rejects a malformed CDP method (verbatim validation preserved)", async () => {
    const deps = mockDeps({ client: { send: async () => ({}) } });
    registerDeepEvidenceTools(deps);
    await expect(deps.tools.get("browser_cdp_command").execute("id", { profile: "t", method: "notacdpmethod" }))
      .rejects.toThrow(/Chrome DevTools Protocol method/);
  });
});
