import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fileSha256,
  listEvidenceFiles,
  readJsonFile,
  summarizeResearchPackHandoff,
  inspectArtifactFile,
  inferArtifactKind,
  buildArtifactIndex,
  buildArtifactSearch,
  readArtifactSlice,
  evidenceTimestamp,
  buildEvidenceTimeline,
} from "./evidence-artifacts.mjs";

// Characterization tests pinning the behavior of the evidence/artifact filesystem
// helpers carved out of agent-cdp-server.mjs. These lock the artifact-kind
// inference, bounded artifact inspect/read envelopes, evidence-index and search
// shapes, handoff-summary gating, and timeline construction so the monolith
// refactor cannot silently change how agents navigate saved evidence.

let dir;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "evid-artifacts-"));
  writeFileSync(join(dir, "hello.txt"), "alpha token beta\nsecond line\n");
  writeFileSync(join(dir, "data.json"), JSON.stringify({ a: 1, b: [1, 2, 3] }));
  mkdirSync(join(dir, "har"));
  writeFileSync(join(dir, "har", "trace.har"), JSON.stringify({ log: { entries: [{ request: { url: "https://x" } }] } }));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("fileSha256 / readJsonFile", () => {
  it("hashes file content deterministically (sha256 hex)", () => {
    const p = join(dir, "hello.txt");
    const h = fileSha256(p);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(fileSha256(p)).toBe(h);
  });
  it("parses JSON files", () => {
    expect(readJsonFile(join(dir, "data.json"))).toEqual({ a: 1, b: [1, 2, 3] });
  });
});

describe("listEvidenceFiles", () => {
  it("walks a directory, returning relative paths, bytes, and hashes", () => {
    const files = listEvidenceFiles(dir);
    const rels = files.map((f) => f.relativePath).sort();
    expect(rels).toContain("hello.txt");
    expect(rels).toContain("data.json");
    expect(rels.some((r) => r.replace(/\\/g, "/") === "har/trace.har")).toBe(true);
    const hello = files.find((f) => f.relativePath === "hello.txt");
    expect(hello.bytes).toBeGreaterThan(0);
    expect(hello.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(hello.hashSkipped).toBe(false);
  });
});

describe("inferArtifactKind", () => {
  it("classifies by path/extension (delegates to shared inferArtifactKind)", () => {
    expect(inferArtifactKind("/x/y/foo.har")).toBe("har");
    expect(inferArtifactKind("/x/screenshots/a.png")).toBe("screenshot");
    expect(inferArtifactKind("/x/y/weird.bin")).toBe("other");
  });
});

describe("inspectArtifactFile", () => {
  it("reports exists:false for a missing path", () => {
    const out = inspectArtifactFile({ path: join(dir, "nope.txt") });
    expect(out.schema).toBe("agent-browser-runtime.artifact-inspect.v1");
    expect(out.exists).toBe(false);
  });
  it("inspects a text file: kind text, preview lines, and literal matches", () => {
    const out = inspectArtifactFile({ path: join(dir, "hello.txt"), query: "token" });
    expect(out.exists).toBe(true);
    expect(out.isFile).toBe(true);
    expect(out.kind).toBe("text");
    expect(out.previewLineCount).toBe(3); // two lines plus trailing newline split
    expect(out.matchCount).toBe(1);
    expect(out.matches[0].line).toBe(1);
  });
  it("parses JSON artifacts into a json summary", () => {
    const out = inspectArtifactFile({ path: join(dir, "data.json") });
    expect(out.json.ok).toBe(true);
    expect(out.json.topLevelType).toBe("object");
    expect(out.json.keys).toEqual(["a", "b"]);
  });
});

describe("readArtifactSlice", () => {
  it("reads a line slice with 1-based line numbers", () => {
    const out = readArtifactSlice({ path: join(dir, "hello.txt"), startLine: 1, lineCount: 1 });
    expect(out.schema).toBe("agent-browser-runtime.artifact-read.v1");
    expect(out.mode).toBe("line");
    expect(out.returnedLineCount).toBe(1);
    expect(out.lines[0]).toEqual({ lineNumber: 1, text: "alpha token beta" });
  });
  it("reads a byte slice by default", () => {
    const out = readArtifactSlice({ path: join(dir, "hello.txt"), startByte: 0, maxBytes: 5 });
    expect(out.mode).toBe("byte");
    expect(out.contentText).toBe("alpha");
    expect(out.truncatedAfter).toBe(true);
  });
  it("reports exists:false for a missing path", () => {
    expect(readArtifactSlice({ path: join(dir, "missing.bin") }).exists).toBe(false);
  });

  // C-02: allowedRoots whitelist tests
  it("C-02: allows read when path is inside an allowedRoot", () => {
    const out = readArtifactSlice({
      path: join(dir, "hello.txt"),
      startLine: 1,
      lineCount: 1,
      allowedRoots: [dir],
    });
    expect(out.ok).not.toBe(false); // read succeeded — not a rejection
    expect(out.schema).toBe("agent-browser-runtime.artifact-read.v1");
  });
  it("C-02: rejects read when path is outside all allowedRoots", () => {
    const out = readArtifactSlice({
      path: join(dir, "hello.txt"),
      allowedRoots: [join(tmpdir(), "nonexistent-root-xyz")],
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe("path_outside_evidence_directory");
  });
  it("C-02: no whitelist check when allowedRoots is empty (open mode)", () => {
    const out = readArtifactSlice({
      path: join(dir, "hello.txt"),
      allowedRoots: [],
    });
    // empty list = no restriction; read proceeds
    expect(out.ok).not.toBe(false);
  });
});

describe("buildArtifactIndex / buildArtifactSearch", () => {
  it("indexes a file-listing array (delegates to shared builder)", () => {
    const out = buildArtifactIndex([{ path: "/x/a.har", bytes: 10, modifiedAt: "2026-01-01T00:00:00.000Z" }], {});
    expect(out.schema).toBe("agent-browser-runtime.artifact-index.v1");
    expect(out.totalFileCount).toBe(1);
    expect(out.kinds).toEqual({ har: 1 });
  });
  it("searches artifact bodies for a literal query", () => {
    const files = listEvidenceFiles(dir);
    const out = buildArtifactSearch(files, { query: "token" });
    expect(out.schema).toBe("agent-browser-runtime.artifact-search.v1");
    expect(out.query).toBe("token");
    expect(out.matchedFileCount).toBeGreaterThanOrEqual(1);
    const hit = out.fileMatches.find((f) => f.relativePath === "hello.txt");
    expect(hit.matchCount).toBe(1);
  });
  it("throws when query is missing", () => {
    expect(() => buildArtifactSearch([], {})).toThrow(/query is required/);
  });
});

describe("summarizeResearchPackHandoff", () => {
  it("returns null for a non-matching schema", () => {
    expect(summarizeResearchPackHandoff(null)).toBe(null);
    expect(summarizeResearchPackHandoff({ schema: "something-else" })).toBe(null);
  });
  it("summarizes a matching handoff and computes ready", () => {
    const out = summarizeResearchPackHandoff({
      schema: "agent-browser-runtime.security-research-pack-handoff.v1",
      handoffCompleteness: { ready: true },
      artifactCoverage: { ready: true },
      summary: { url: "https://target" },
    });
    expect(out).toBeTruthy();
    expect(out.url).toBe("https://target");
    expect(out.ready).toBe(true);
  });
});

describe("evidenceTimestamp / buildEvidenceTimeline", () => {
  it("normalizes seconds and milliseconds to ISO, rejects junk", () => {
    expect(evidenceTimestamp(1700000000)).toBe("2023-11-14T22:13:20.000Z");
    expect(evidenceTimestamp(1700000000000)).toBe("2023-11-14T22:13:20.000Z");
    expect(evidenceTimestamp("not-a-date")).toBe(null);
    expect(evidenceTimestamp(null)).toBe(null);
  });
  it("builds a timeline from network requests", () => {
    const out = buildEvidenceTimeline({
      requests: [{ method: "GET", status: 200, url: "https://a.com/x", requestId: "r1", timestamp: 1700000000 }],
    }, {});
    expect(out.schema).toBe("agent-browser-runtime.evidence-timeline.v1");
    expect(out.eventCount).toBe(1);
    expect(out.events[0].type).toBe("network-request");
    expect(out.byType["network-request"]).toBe(1);
  });
});
