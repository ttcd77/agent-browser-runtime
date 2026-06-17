import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAttackIntruderEvidence,
  buildAttackIntruderResults,
  createAttackIntruderJob,
  pauseAttackIntruderJob,
  readAttackIntruderJob,
  resumeAttackIntruderJob,
  runAttackIntruderJob,
} from "./attack-intruder.mjs";

function fixtureRequest() {
  return {
    requestId: "req-1",
    method: "POST",
    url: "https://example.test/api/users/1001",
    requestHeaders: { "Content-Type": "application/json", Cookie: "sid=secret" },
    responseHeaders: { "Content-Type": "application/json" },
    hasPostData: true,
    postData: JSON.stringify({ role: "user", ownerId: "1001" }),
    status: 200,
    bodyText: JSON.stringify({ ok: true }),
  };
}

describe("attack intruder P0.1 job model", () => {
  it("creates a dry-run planning job without replay results", () => {
    const dir = mkdtempSync(join(tmpdir(), "abr-intruder-"));
    try {
      const created = createAttackIntruderJob({
        evidenceDir: dir,
        profile: "target-attacker-auth",
        request: fixtureRequest(),
        requestId: "req-1",
        now: new Date("2026-06-04T12:00:00.000Z"),
        jobId: "intruder-test",
        spec: {
          positions: [
            {
              id: "user_id_path",
              location: "url",
              selector: { type: "regex", pattern: "/users/(\\d+)" },
            },
          ],
          payloadSets: [{ id: "ids", type: "wordlist", values: ["1002", "1003"] }],
          attackMode: "sniper",
        },
      });

      expect(created.ok).toBe(true);
      expect(created.summary.counts.planned).toBe(2);
      expect(created.preview).toHaveLength(2);
      expect(created.preview[0].replayVariant.url).toBe("https://example.test/api/users/1002");
      expect(existsSync(created.state.paths.results)).toBe(true);

      const status = readAttackIntruderJob({ evidenceDir: dir, jobId: "intruder-test" });
      expect(status.state.state).toBe("created");

      const results = buildAttackIntruderResults({ evidenceDir: dir, jobId: "intruder-test" });
      expect(results.resultCount).toBe(0);
      expect(results.preview.variants).toHaveLength(2);

      const evidence = buildAttackIntruderEvidence({ evidenceDir: dir, jobId: "intruder-test" });
      expect(evidence.schema).toBe("agent-browser.attack.intruder.evidence.v1");
      expect(evidence.artifacts.spec.sha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails loud when a payload position does not match the captured request", () => {
    const created = createAttackIntruderJob({
      evidenceDir: tmpdir(),
      profile: "target-attacker-auth",
      request: fixtureRequest(),
      requestId: "req-1",
      spec: {
        positions: [
          {
            id: "missing",
            location: "url",
            selector: { type: "regex", pattern: "/accounts/(\\d+)" },
          },
        ],
        payloadSets: [{ id: "ids", type: "wordlist", values: ["2001"] }],
      },
    });

    expect(created.ok).toBe(false);
    expect(created.validation.errors.join("\n")).toContain("position missing cannot be applied");
  });
});

describe("attack intruder P0.2 replay execution", () => {
  it("runs sniper variants through an injected batch replay primitive and writes result rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abr-intruder-run-"));
    try {
      createAttackIntruderJob({
        evidenceDir: dir,
        profile: "target-attacker-auth",
        request: fixtureRequest(),
        requestId: "req-1",
        jobId: "intruder-run-test",
        spec: {
          transport: { batchSize: 2 },
          positions: [{ id: "user_id_path", location: "url", selector: { type: "regex", pattern: "/users/(\\d+)" } }],
          payloadSets: [{ id: "ids", type: "wordlist", values: ["1002", "1003", "1004"] }],
          attackMode: "sniper",
        },
      });
      const replayCalls = [];
      const replayBatch = async (params) => {
        replayCalls.push(params);
        return {
          results: params.variants.map((variant, index) => ({
            index,
            label: variant.label,
            replayRequest: {
              method: variant.method,
              url: variant.url,
              bodyKind: "none",
              bodyLength: 0,
              skippedHeaderNames: ["cookie"],
              credentials: "include",
            },
            response: {
              ok: true,
              startedAt: "2026-06-04T12:00:00.000Z",
              finishedAt: "2026-06-04T12:00:00.025Z",
              url: variant.url,
              status: 200,
              statusText: "OK",
              headers: { "content-type": "application/json" },
              bodyText: JSON.stringify({ variant: variant.label }),
              bodyBytes: 24,
            },
            responseDiff: { statusChanged: false },
            exception: null,
          })),
        };
      };

      const run = await runAttackIntruderJob({
        evidenceDir: dir,
        jobId: "intruder-run-test",
        replayBatch,
        maxVariants: 3,
      });

      expect(run.ok).toBe(true);
      expect(replayCalls).toHaveLength(2);
      expect(replayCalls.map((call) => call.variants.map((variant) => variant.url))).toEqual([
        ["https://example.test/api/users/1002", "https://example.test/api/users/1003"],
        ["https://example.test/api/users/1004"],
      ]);
      const status = readAttackIntruderJob({ evidenceDir: dir, jobId: "intruder-run-test" });
      expect(status.state.state).toBe("completed");
      expect(status.state.cursor.nextVariantIndex).toBe(3);
      expect(status.state.cursor.sentCount).toBe(3);
      const rows = readFileSync(status.state.paths.results, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
      expect(rows).toHaveLength(3);
      expect(rows[0].variantId).toBe("v000000");
      expect(rows[0].response.status).toBe(200);
      expect(rows[0].replayRequest.skippedHeaderNames).toEqual(["cookie"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pauses at a batch boundary and resumes from the saved cursor without resending", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abr-intruder-resume-"));
    try {
      createAttackIntruderJob({
        evidenceDir: dir,
        profile: "target-attacker-auth",
        request: fixtureRequest(),
        requestId: "req-1",
        jobId: "intruder-resume-test",
        spec: {
          transport: { batchSize: 2 },
          positions: [{ id: "user_id_path", location: "url", selector: { type: "regex", pattern: "/users/(\\d+)" } }],
          payloadSets: [{ id: "ids", type: "wordlist", values: ["1002", "1003", "1004", "1005", "1006"] }],
          attackMode: "sniper",
        },
      });
      const replayedUrls = [];
      let callCount = 0;
      const replayBatch = async (params) => {
        callCount += 1;
        replayedUrls.push(...params.variants.map((variant) => variant.url));
        if (callCount === 1) pauseAttackIntruderJob({ evidenceDir: dir, jobId: "intruder-resume-test" });
        return {
          results: params.variants.map((variant, index) => ({
            index,
            label: variant.label,
            replayRequest: { method: variant.method, url: variant.url, bodyKind: "none", bodyLength: 0, skippedHeaderNames: [] },
            response: {
              ok: true,
              startedAt: "2026-06-04T12:00:00.000Z",
              finishedAt: "2026-06-04T12:00:00.010Z",
              url: variant.url,
              status: 204,
              statusText: "No Content",
              headers: {},
              bodyText: "",
              bodyBytes: 0,
            },
            exception: null,
          })),
        };
      };

      const paused = await runAttackIntruderJob({
        evidenceDir: dir,
        jobId: "intruder-resume-test",
        replayBatch,
        maxVariants: 5,
      });
      expect(paused.state.state).toBe("paused");
      expect(paused.state.cursor.nextVariantIndex).toBe(2);

      const resumed = await resumeAttackIntruderJob({
        evidenceDir: dir,
        jobId: "intruder-resume-test",
        replayBatch,
        maxVariants: 3,
      });

      expect(resumed.state.state).toBe("completed");
      expect(replayedUrls).toEqual([
        "https://example.test/api/users/1002",
        "https://example.test/api/users/1003",
        "https://example.test/api/users/1004",
        "https://example.test/api/users/1005",
        "https://example.test/api/users/1006",
      ]);
      const status = readAttackIntruderJob({ evidenceDir: dir, jobId: "intruder-resume-test" });
      expect(status.state.cursor.sentCount).toBe(5);
      const rows = readFileSync(status.state.paths.results, "utf8").trim().split(/\r?\n/);
      expect(rows).toHaveLength(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails loud before replay when the remaining plan exceeds maxVariants", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abr-intruder-max-"));
    try {
      createAttackIntruderJob({
        evidenceDir: dir,
        profile: "target-attacker-auth",
        request: fixtureRequest(),
        requestId: "req-1",
        jobId: "intruder-max-test",
        spec: {
          positions: [{ id: "user_id_path", location: "url", selector: { type: "regex", pattern: "/users/(\\d+)" } }],
          payloadSets: [{ id: "ids", type: "wordlist", values: ["1002", "1003", "1004"] }],
          attackMode: "sniper",
        },
      });
      let replayCalled = false;
      const result = await runAttackIntruderJob({
        evidenceDir: dir,
        jobId: "intruder-max-test",
        replayBatch: async () => {
          replayCalled = true;
          return { results: [] };
        },
        maxVariants: 2,
      });

      expect(result.ok).toBe(false);
      expect(result.boundary).toContain("planned remaining variants exceed maxVariants");
      expect(replayCalled).toBe(false);
      const status = readAttackIntruderJob({ evidenceDir: dir, jobId: "intruder-max-test" });
      expect(status.state.cursor.sentCount).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
