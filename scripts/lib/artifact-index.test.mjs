import { describe, expect, it } from "vitest";
import { buildArtifactIndex, inferArtifactKind, RECOMMENDED_ARTIFACT_KIND_ORDER } from "./artifact-index.mjs";

describe("artifact index routing", () => {
  it("classifies evidence artifacts by stable kind", () => {
    expect(inferArtifactKind("runtime/profiles/default/har/first-network.har")).toBe("har");
    expect(inferArtifactKind("runtime/profiles/default/realtime/ws.json")).toBe("realtime");
    expect(inferArtifactKind("runtime/profiles/default/research-packs/security-research-pack.json")).toBe("research-pack");
    expect(inferArtifactKind("runtime/profiles/default/boundaries/worker-frame-deep-dive.json")).toBe("boundary");
    expect(inferArtifactKind("runtime/profiles/default/screenshots/page.png")).toBe("screenshot");
  });

  it("keeps latestByKind independent from filtered rows", () => {
    const index = buildArtifactIndex([
      {
        path: "runtime/profiles/default/har/old.har",
        relativePath: "har/old.har",
        bytes: 10,
        modifiedAt: "2026-05-19T09:00:00.000Z",
        sha256: "old",
      },
      {
        path: "runtime/profiles/default/har/new.har",
        relativePath: "har/new.har",
        bytes: 20,
        modifiedAt: "2026-05-19T10:00:00.000Z",
        sha256: "new",
      },
      {
        path: "runtime/profiles/default/traces/chrome-trace.json",
        relativePath: "traces/chrome-trace.json",
        bytes: 30,
        modifiedAt: "2026-05-19T08:00:00.000Z",
      },
    ], { kind: "trace" });

    expect(index.artifacts).toHaveLength(1);
    expect(index.artifacts[0].kind).toBe("trace");
    expect(index.latestByKind.har.path).toContain("new.har");
    expect(index.latestByKind.har.readInput).toEqual({
      path: "runtime/profiles/default/har/new.har",
      mode: "line",
      startLine: 1,
      lineCount: 120,
    });
  });

  it("builds deterministic recommended drilldowns without vulnerability judgment", () => {
    const index = buildArtifactIndex(RECOMMENDED_ARTIFACT_KIND_ORDER.map((kind, i) => ({
      path: `runtime/profiles/default/${kind}/${kind}.json`,
      relativePath: `${kind}/${kind}.json`,
      bytes: i + 1,
      modifiedAt: `2026-05-19T10:${String(i).padStart(2, "0")}:00.000Z`,
    })));

    expect(index.recommendedDrilldowns[0]).toMatchObject({
      label: "Latest research-pack artifact",
      tool: "browser_artifact_inspect",
      path: "runtime/profiles/default/research-pack/research-pack.json",
    });
    expect(index.recommendedDrilldowns.some((entry) => entry.tool === "browser_artifact_read" && entry.path.includes("/trace/"))).toBe(false);
    expect(index.boundaries.join("\n")).toContain("does not decide vulnerability impact");
  });
});

