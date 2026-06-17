import { describe, it, expect } from "vitest";
import {
  devtoolsToolCategory,
  buildAgentToolEntryPoints,
  buildCapabilityAgentUsage,
  devtoolsToolCatalogFromEntries,
  devtoolsCapabilityMapFromEntries,
  devtoolsF12ParityMatrix,
  devtoolsWorkflowGuide,
  browserProductCapabilities,
} from "./capability-catalog.mjs";

// Characterization tests pinning the pure capability-catalog builders carved out
// of agent-cdp-server.mjs. These lock the per-tool category routing, the
// available-set-driven entry points / usage routes, the catalog + capability-map
// derivation from registry entries (filtering, category counts, panel mapping),
// the backend-sensitive parity matrix, the workflow-guide recipe selection, and
// the static product capability map. They assert concrete shapes (routing/
// counts), not just smoke loads.

const sampleEntries = [
  { name: "agent_inspect", description: "first pass", parameters: { required: ["focus"], properties: { focus: {}, limit: {} } } },
  { name: "browser_network_summary", description: "network", parameters: { properties: {} } },
  { name: "browser_process_cdp", description: "raw", parameters: { required: ["method"], properties: { method: {} } } },
  { name: "browser_open", description: "facade open", parameters: { properties: { url: {} } } },
  { name: "browser_security_pack", description: "facade pack", parameters: { properties: {} } },
];

describe("devtoolsToolCategory", () => {
  it("routes names to F12 panel categories", () => {
    expect(devtoolsToolCategory("agent_inspect")).toBe("orientation");
    expect(devtoolsToolCategory("browser_capability_map")).toBe("orientation");
    expect(devtoolsToolCategory("browser_network_summary")).toBe("network");
    expect(devtoolsToolCategory("browser_cookie_summary")).toBe("application");
    expect(devtoolsToolCategory("browser_frame_tree")).toBe("dom-frame");
    expect(devtoolsToolCategory("browser_sources_search")).toBe("sources-debugger");
    expect(devtoolsToolCategory("browser_chrome_trace")).toBe("performance");
    expect(devtoolsToolCategory("browser_evidence_bundle")).toBe("evidence-workflow");
    expect(devtoolsToolCategory("browser_process_cdp")).toBe("raw-cdp");
    expect(devtoolsToolCategory("totally_unknown")).toBe("other");
  });
});

describe("buildAgentToolEntryPoints", () => {
  it("only lists tools present in the available set", () => {
    const ep = buildAgentToolEntryPoints(new Set(["browser_open", "browser_security_pack"]));
    expect(ep.defaultMode).toBe("facade-first");
    // no browser_professional_readiness in set => fall back to capability_map
    expect(ep.recommendedFirstCall).toBe("browser_capability_map");
    expect(ep.facadePath).toEqual(["browser_open", "browser_security_pack"]);
    const orient = ep.compressedTools.find((g) => g.label === "orient");
    expect(orient.tools).toEqual([]); // none of the orient tools available
    const pkg = ep.compressedTools.find((g) => g.label === "package");
    expect(pkg.tools).toEqual(["browser_security_pack"]);
    expect(ep.professionalRouteSummary.evidencePack.tool).toBe("browser_security_pack");
  });
  it("promotes professional_readiness as first call when available", () => {
    const ep = buildAgentToolEntryPoints(new Set(["browser_professional_readiness"]));
    expect(ep.recommendedFirstCall).toBe("browser_professional_readiness");
    expect(ep.professionalRouteSummary.firstStep.tool).toBe("browser_professional_readiness");
  });
});

describe("buildCapabilityAgentUsage", () => {
  it("injects researcher profile only for managed-cdp backend and filters by availability", () => {
    const available = new Set(["browser_professional_readiness", "browser_open"]);
    const managed = buildCapabilityAgentUsage(available, "managed-cdp");
    expect(managed.defaultRoute.map((s) => s.tool)).toEqual(["browser_professional_readiness", "browser_open"]);
    expect(managed.defaultRoute[0].input.profile).toBe("researcher"); // managed => profile injected
    const personal = buildCapabilityAgentUsage(available, "personal-chrome");
    expect(personal.defaultRoute[0].input.profile).toBeUndefined(); // non-managed => no profile
  });
});

describe("devtoolsToolCatalogFromEntries", () => {
  it("includes agent_inspect + browser_* + profile_* by default and counts categories", () => {
    const cat = devtoolsToolCatalogFromEntries(sampleEntries, {});
    const names = cat.tools.map((t) => t.name);
    expect(names).toContain("agent_inspect");
    expect(names).toContain("browser_network_summary");
    expect(names).toContain("browser_open"); // browser_* tools included by default
    expect(cat.toolCount).toBe(names.length);
    expect(cat.categories.network).toBe(1);
    expect(cat.agentEntryPoints).toBeTruthy();
  });
  it("filters by category and query, and includeBackendSpecific includes all entries", () => {
    const onlyNetwork = devtoolsToolCatalogFromEntries(sampleEntries, { category: "network" });
    expect(onlyNetwork.tools.map((t) => t.name)).toEqual(["browser_network_summary"]);
    const withAll = devtoolsToolCatalogFromEntries(sampleEntries, { includeBackendSpecific: true });
    expect(withAll.tools.map((t) => t.name)).toContain("browser_open");
    const queried = devtoolsToolCatalogFromEntries(sampleEntries, { query: "raw" });
    expect(queried.tools.map((t) => t.name)).toEqual(["browser_process_cdp"]);
  });
});

describe("devtoolsCapabilityMapFromEntries", () => {
  it("splits facade vs product tools and builds one panel per capability category", () => {
    const map = devtoolsCapabilityMapFromEntries(sampleEntries, { backend: "managed-cdp" });
    expect(map.backend).toBe("managed-cdp");
    expect(map.facadeTools.map((t) => t.name)).toEqual(["browser_open", "browser_security_pack"]);
    expect(map.panelCount).toBe(map.panels.length);
    expect(map.panels.length).toBe(10); // one per DEVTOOLS_CAPABILITY_META category
    const network = map.panels.find((p) => p.category === "network");
    expect(network.toolCount).toBe(1);
    const rawCdp = map.panels.find((p) => p.category === "raw-cdp");
    expect(rawCdp.rawEscapeHatch).toBe("browser_cdp_command");
    expect(map.recommendedStart).toEqual(["browser_open", "browser_security_pack"]);
  });
});

describe("devtoolsF12ParityMatrix", () => {
  it("returns 9 panels and counts managed status by default", () => {
    const m = devtoolsF12ParityMatrix("managed-cdp");
    expect(m.backend).toBe("managed-cdp");
    expect(m.rows.length).toBe(9);
    expect(m.summary.panelCount).toBe(9);
    // managed: 7 supported, 1 not-first-class, 1 ... let-counts-self-check sum to 9
    const total = Object.values(m.summary.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(9);
    expect(m.summary.counts.supported).toBe(8); // 8 panels managed=supported, 1 not-first-class
    expect(m.summary.counts["not-first-class"]).toBe(1);
  });
  it("switches Performance/RawCDP rows to partial under personal-chrome", () => {
    const m = devtoolsF12ParityMatrix("personal-chrome");
    const perf = m.rows.find((r) => r.panel === "Performance / Memory");
    expect(perf.coverage).toBe("partial-in-personal");
    expect(m.summary.counts.partial).toBe(2); // Performance + Raw CDP rows
  });
});

describe("devtoolsWorkflowGuide", () => {
  it("normalizes task key and returns the matching recipe", () => {
    const g = devtoolsWorkflowGuide("Professional AppSec");
    expect(g.task).toBe("professional-appsec");
    expect(g.title).toBe("Professional AppSec F12 workflow");
    expect(Array.isArray(g.availableTasks)).toBe(true);
    expect(g.availableTasks).toContain("first-pass");
  });
  it("falls back to first-pass for unknown tasks", () => {
    const g = devtoolsWorkflowGuide("nonexistent-task");
    expect(g.task).toBe("nonexistent-task");
    expect(g.title).toBe("First page inspection"); // recipe fell back to first-pass content
  });
});

describe("browserProductCapabilities", () => {
  it("returns the static product capability map", () => {
    const c = browserProductCapabilities();
    expect(c.schema).toBe("agent-browser.capabilities.v1");
    expect(c.ok).toBe(true);
    expect(c.productModel.primaryBackend).toBe("managed");
    expect(c.scenarios.map((s) => s.scenario)).toEqual(["basic", "pentest", "personal"]);
  });
});
