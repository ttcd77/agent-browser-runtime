import { describe, it, expect } from "vitest";
import { registerReplayAttackTools } from "./register-replay-attack.mjs";

// Characterization tests for the Replay/attack (raw/race/JWT/OOB request + replay +
// Agentic Intruder) tool family carved out of agent-cdp-server.mjs. They lock (a)
// which tools the family registers and their public surface, and (b) that a
// representative handler is correctly wired to its injected deps — specifically that
// profile_request_replay_batch delegates to the injected closure-local helper
// executeProfileRequestReplayBatch (the dep most likely to be dropped in the carve).
// Deep handler logic is verbatim-preserved and covered by the raw-request /
// jwt-forge / oob-client / replay-http / attack-intruder unit tests + the
// tool-registry contract net.

function mockDeps(overrides = {}) {
  return {
    tools: new Map(),
    profileRegistry: {
      getTraffic: () => null,
      touchProfile: async () => {},
      ...overrides.profileRegistry,
    },
    resolveProfile: overrides.resolveProfile
      || (async (name) => ({ name: name || "default", tabId: "tab-1", evidenceDir: "/tmp/evidence" })),
    withManagedPageClient: overrides.withManagedPageClient || (async () => ({})),
    executeProfileRequestReplayBatch: overrides.executeProfileRequestReplayBatch
      || (async () => ({ ok: true, variantCount: 0, results: [] })),
    maybeRoutePersonal: async () => null,
  };
}

describe("registerReplayAttackTools", () => {
  it("registers the replay/attack family with the expected names", () => {
    const deps = mockDeps();
    registerReplayAttackTools(deps);
    expect([...deps.tools.keys()].sort()).toEqual([
      "attack_intruder_create",
      "attack_intruder_evidence",
      "attack_intruder_pause",
      "attack_intruder_results",
      "attack_intruder_resume",
      "attack_intruder_run",
      "attack_intruder_status",
      "profile_jwt_forge",
      "profile_oob_alloc",
      "profile_oob_poll",
      "profile_race_request",
      "profile_raw_request",
      "profile_request_replay",
      "profile_request_replay_batch",
    ]);
  });

  it("every registered tool exposes name + description + object schema + async execute", () => {
    const deps = mockDeps();
    registerReplayAttackTools(deps);
    for (const [name, tool] of deps.tools) {
      expect(tool.name).toBe(name);
      expect(typeof tool.description).toBe("string");
      expect(tool.parameters?.type).toBe("object");
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("profile_request_replay_batch delegates to the injected executeProfileRequestReplayBatch", async () => {
    let received = null;
    const deps = mockDeps({
      executeProfileRequestReplayBatch: async (params) => {
        received = params;
        return { ok: true, variantCount: 1, results: [{ status: 200 }] };
      },
    });
    registerReplayAttackTools(deps);
    const result = await deps.tools.get("profile_request_replay_batch").execute("id", {
      requestId: "r-1",
      variants: [{ headers: { "X-Test": "1" } }],
    });
    const report = JSON.parse(result.content[0].text);
    expect(report.ok).toBe(true);
    expect(report.variantCount).toBe(1);
    expect(received?.requestId).toBe("r-1");
    expect(Array.isArray(received?.variants)).toBe(true);
  });
});
