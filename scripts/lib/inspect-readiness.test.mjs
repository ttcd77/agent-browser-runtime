import { describe, it, expect } from "vitest";
import {
  buildRequestDetail,
  summarizeEvidenceCompleteness,
  buildAgentInspectToolPlan,
  professionalAppsecWorkflowSummary,
  buildProfessionalReadiness,
} from "./inspect-readiness.mjs";

// Characterization tests pinning the inspect / professional-readiness builders
// carved out of agent-cdp-server.mjs. These lock the full F12 request-detail
// shape (headers/cookies/lifecycle/sections), the recursive evidence-completeness
// note walker, the focus-driven agent_inspect tool plan, the static workflow
// summary, and the professional-readiness report (checks, missing list, next
// actions). They assert concrete objective-evidence shapes, not smoke loads.

describe("buildRequestDetail", () => {
  it("builds a full request-detail view with parsed cookies and lifecycle flags", () => {
    const detail = buildRequestDetail(
      {
        requestId: "r1",
        url: "https://a.com/x",
        method: "POST",
        status: 200,
        requestHeaders: { Cookie: "a=1; b=2", "Content-Type": "application/json" },
        responseHeaders: { "Set-Cookie": "s=9" },
        redirectChain: [{ url: "https://a.com/old" }],
        hasPostData: true,
        bodyText: "x",
      },
      [{ name: "browserCookie" }],
    );
    expect(detail.requestId).toBe("r1");
    expect(detail.cookieHeader).toBe("a=1; b=2");
    expect(detail.requestCookies).toEqual([{ name: "a", value: "1" }, { name: "b", value: "2" }]);
    expect(detail.setCookieHeader).toBe("s=9");
    expect(detail.lifecycleFlags.redirected).toBe(true);
    expect(detail.lifecycleFlags.hasPostData).toBe(true);
    expect(detail.bodyReadable).toBe(true); // bodyText present
    expect(detail.browserCookiesForUrl).toEqual([{ name: "browserCookie" }]);
    expect(detail.f12Sections).toBeTruthy(); // delegated to buildRequestF12Sections
  });
  it("returns null for a missing entry", () => {
    expect(buildRequestDetail(null)).toBe(null);
  });
});

describe("summarizeEvidenceCompleteness", () => {
  it("walks nested evidence and reports unavailable/error/truncated/partial_frames notes", () => {
    const out = summarizeEvidenceCompleteness({
      network: { unavailable: true, tool: "profile_traffic_summary" },
      sources: { error: "boom" },
      dom: { truncated: true, frameErrors: [{}, {}] },
    });
    expect(out.status).toBe("partial");
    const statuses = out.notes.map((n) => n.status);
    expect(statuses).toContain("unavailable");
    expect(statuses).toContain("error");
    expect(statuses).toContain("truncated");
    expect(statuses).toContain("partial_frames");
  });
  it("reports complete when there are no problem markers", () => {
    const out = summarizeEvidenceCompleteness({ network: { requestCount: 3 } });
    expect(out.status).toBe("complete_for_current_capture");
    expect(out.noteCount).toBe(0);
  });
});

describe("buildAgentInspectToolPlan", () => {
  it("returns focus-specific first-pass and drilldown tools", () => {
    const net = buildAgentInspectToolPlan("network", { requestId: "r1" });
    expect(net.firstPass).toContain("profile_traffic_summary");
    expect(net.drillDown).toContain("profile_request_detail"); // requestId present
    const netNoId = buildAgentInspectToolPlan("network", {});
    expect(netNoId.drillDown[0]).toMatch(/pick a requestId/);
  });
  it("falls back to the overview plan for unknown focus", () => {
    const overview = buildAgentInspectToolPlan("totally-unknown");
    expect(overview.firstPass).toContain("browser_backend_capabilities");
    expect(overview.escapeHatch).toBe("browser_cdp_command");
  });
});

describe("professionalAppsecWorkflowSummary", () => {
  it("returns the static professional workflow summary", () => {
    const w = professionalAppsecWorkflowSummary();
    expect(w.task).toBe("professional-appsec");
    expect(w.defaultPath).toContain("browser_security_pack");
    expect(w.readinessTool).toBe("browser_professional_readiness");
  });
});

describe("buildProfessionalReadiness", () => {
  it("flags missing checks and recommends starting capture + evidence pack when nothing is ready", () => {
    const r = buildProfessionalReadiness({ backend: "managed-cdp" });
    expect(r.schema).toBe("agent-browser-runtime.professional-readiness.v1");
    expect(r.ready).toBe(false);
    expect(r.missing).toContain("professionalWorkflow");
    expect(r.missing).toContain("facadeTools");
    // with no capture + no artifacts, first two next actions are capture then pack
    expect(r.nextActions[0].tool).toBe("browser_capture");
    expect(r.nextActions.some((a) => a.tool === "browser_security_pack")).toBe(true);
  });
  it("passes core checks when workflow/capability/parity/capture inputs are healthy", () => {
    const r = buildProfessionalReadiness({
      backend: "managed-cdp",
      profile: "researcher",
      workflow: { task: "professional-appsec", defaultPath: ["browser_open", "browser_security_pack"] },
      capabilityMap: {
        recommendedStart: ["browser_open", "browser_security_pack"],
        agentUsage: { defaultRoute: [{ tool: "browser_security_pack" }], panelRoutes: {} },
      },
      parityMatrix: { summary: { panelCount: 9 } },
      captureStatus: { capture: { enabled: true } },
    });
    const checkByName = Object.fromEntries(r.checks.map((c) => [c.name, c.present]));
    expect(checkByName.professionalWorkflow).toBe(true);
    expect(checkByName.facadeTools).toBe(true);
    expect(checkByName.agentUsageRoute).toBe(true);
    expect(checkByName.f12ParityMatrix).toBe(true);
    expect(r.summary.captureEnabled).toBe(true);
    // capture already enabled => first next action is NOT browser_capture
    expect(r.nextActions[0].tool).not.toBe("browser_capture");
  });
});
