import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildResearchPackHandoffCompleteness,
  buildResearchPackArtifactCoverage,
  buildResearchPackDrilldowns,
  buildResearchPackF12Navigation,
  summarizeF12RequestDetail,
} from "./research-pack.mjs";

// Characterization tests pinning the security research-pack builders carved out
// of agent-cdp-server.mjs. These lock the handoff-completeness checklist, the
// requested-vs-present artifact coverage, the deterministic drilldown plan
// (including conditional rows + the optional JSON write), the F12 navigation
// index over correlation-graph request nodes, and the single F12 request-detail
// summary. They assert concrete objective-evidence shapes, not smoke loads.

describe("buildResearchPackHandoffCompleteness", () => {
  it("marks present checks and lists missing ones", () => {
    const out = buildResearchPackHandoffCompleteness(
      { researchPackPath: "/p/rp.json", drilldownPlanPath: "/p/dd.json", realtimeLogPath: "/p/rt.json", capture: { enabled: true } },
      { researchPack: { sha256: "h" }, realtime: { reportSha256: "h2" }, artifactIndex: { totalFileCount: 5 }, evidenceTimeline: { eventCount: 3 }, captureStatus: { capture: {} } },
      { task: "professional-appsec", defaultPath: ["browser_security_pack"] },
      { count: 2 },
      { summary: { panelCount: 9 } },
      { defaultRoute: [{ tool: "browser_security_pack" }], panelRoutes: { network: [{ tool: "profile_request_detail" }] } },
    );
    expect(out.ready).toBe(true);
    expect(out.missing).toEqual([]);
    expect(out.presentCount).toBe(out.checks.length);
  });
  it("reports missing checks when artifacts are absent", () => {
    const out = buildResearchPackHandoffCompleteness({}, {}, {}, {}, {}, {});
    expect(out.ready).toBe(false);
    expect(out.missing).toContain("workflow");
    expect(out.missing).toContain("researchPack");
  });
});

describe("buildResearchPackArtifactCoverage", () => {
  it("classifies requested artifacts as present/missing and skips disabled ones", () => {
    const out = buildResearchPackArtifactCoverage(
      { researchPackPath: "/p/rp.json", harPath: "/p/x.har" },
      { includeTrace: false }, // trace disabled => skipped
    );
    expect(out.present).toContain("researchPack");
    expect(out.present).toContain("har");
    expect(out.skipped).toContain("trace");
    expect(out.missing).toContain("realtime"); // requested but no path
    expect(out.ready).toBe(false); // has missing
  });
});

describe("buildResearchPackF12Navigation", () => {
  it("builds a request-node navigation index from the correlation graph", () => {
    const out = buildResearchPackF12Navigation(
      {
        correlationGraph: {
          graphPath: "/p/graph.json",
          nodes: [
            { type: "request", requestId: "r1", url: "https://a.com/api", method: "GET", status: 200, f12Columns: { name: "api", url: "https://a.com/api", method: "GET", status: 200, type: "fetch", flags: {} } },
            { type: "script", url: "https://a.com/app.js" },
          ],
        },
      },
      { profile: "researcher", limit: 5 },
    );
    expect(out.schema).toBe("agent-browser-runtime.f12-navigation.v1");
    expect(out.requestNodeCount).toBe(1); // only the request node
    expect(out.firstRequest.requestId).toBe("r1");
    expect(out.firstRequest.detail.tool).toBe("profile_request_detail");
    expect(out.firstRequest.detail.input.profile).toBe("researcher");
    expect(out.artifacts.correlationGraphPath).toBe("/p/graph.json");
  });
  it("synthesizes f12Columns when a request node lacks them", () => {
    const out = buildResearchPackF12Navigation({ correlationGraph: { nodes: [{ type: "request", requestId: "r2", url: "https://a.com/path/file.js" }] } });
    expect(out.firstRequest.f12Columns.name).toBeTruthy(); // via networkDisplayName
  });
});

describe("summarizeF12RequestDetail", () => {
  it("summarizes a request detail with section availability and header counts", () => {
    const result = {
      detail: {
        requestId: "r1",
        url: "https://a.com/x",
        method: "POST",
        status: 200,
        requestHeaders: { A: "1", B: "2" },
        responseHeaders: { C: "3" },
        f12Sections: { overview: { type: "fetch" }, headers: { general: { requestUrl: "https://a.com/x" } }, payload: {}, cookies: {} },
      },
    };
    const out = summarizeF12RequestDetail(result, { input: { requestId: "r1" } });
    expect(out.schema).toBe("agent-browser-runtime.f12-request-detail-summary.v1");
    expect(out.requestId).toBe("r1");
    expect(out.sectionAvailability.overview).toBe(true);
    expect(out.sectionAvailability.timing).toBe(false);
    expect(out.sections.headers.requestHeaderCount).toBe(2);
    expect(out.sections.headers.responseHeaderCount).toBe(1);
  });
  it("returns null when no detail is present", () => {
    expect(summarizeF12RequestDetail({})).toBe(null);
  });
});

describe("buildResearchPackDrilldowns", () => {
  it("builds base rows plus conditional request/har/trace rows (no fs write without evidenceDir)", () => {
    const plan = buildResearchPackDrilldowns(
      {
        artifactIndex: { artifacts: [{ kind: "har", path: "/p/x.har" }, { kind: "trace", path: "/p/t.json" }] },
        evidenceTimeline: { events: [{ type: "network-request", requestId: "r1" }] },
        trace: { tracePath: "/p/t.json" },
      },
      { profile: "researcher" },
    );
    expect(plan.count).toBe(plan.drilldowns.length);
    const tools = plan.drilldowns.map((d) => d.tool);
    expect(tools).toContain("browser_evidence_timeline"); // base row
    expect(tools).toContain("profile_request_detail"); // firstRequest present
    expect(tools).toContain("browser_artifact_inspect"); // har artifact
    expect(tools).toContain("browser_trace_query"); // tracePath present
    expect(plan.planPath).toBeUndefined(); // no evidenceDir => no write
  });

  it("writes the plan JSON when evidenceDir is provided", () => {
    const dir = mkdtempSync(join(tmpdir(), "research-pack-"));
    try {
      const plan = buildResearchPackDrilldowns({}, { evidenceDir: dir });
      expect(plan.planPath).toBeTruthy();
      expect(existsSync(plan.planPath)).toBe(true);
      const onDisk = JSON.parse(readFileSync(plan.planPath, "utf8"));
      expect(onDisk.count).toBe(plan.count);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
