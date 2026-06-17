import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  safeArtifactName,
  writeSourceMapOriginalSources,
  pathInsideRoot,
  readSourceMapArtifact,
} from "./sourcemap-fs.mjs";

// Characterization tests pinning the source-map artifact filesystem helpers
// carved out of agent-cdp-server.mjs. These lock the filename sanitization, the
// extracted-source writing (manifest shape, skipped no-content entries, sha256),
// the path-containment guard, and the bounded artifact read so the monolith
// refactor cannot silently change how extracted sources are written/guarded/read.

let dir;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sourcemap-fs-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("safeArtifactName", () => {
  it("keeps only the last path segment and sanitizes unsafe chars", () => {
    expect(safeArtifactName("https://a.com/path/to/app.js")).toBe("app.js");
    expect(safeArtifactName("C:\\win\\dir\\thing.map")).toBe("thing.map");
    expect(safeArtifactName("a b/c?d=*e")).toBe("c_d__e"); // ?, =, * -> _
  });
  it("falls back when empty", () => {
    expect(safeArtifactName("", "fallback")).toBe("fallback");
    expect(safeArtifactName(null)).toBe("source");
  });
  it("truncates to 120 chars", () => {
    const long = "x".repeat(300) + ".js";
    expect(safeArtifactName(long).length).toBe(120);
  });
});

describe("pathInsideRoot", () => {
  it("accepts the root itself and descendants, rejects outside paths", () => {
    expect(pathInsideRoot(join(dir, "sub", "f.txt"), dir)).toBe(true);
    expect(pathInsideRoot(dir, dir)).toBe(true);
    expect(pathInsideRoot(join(dir, "..", "elsewhere", "f.txt"), dir)).toBe(false);
  });
});

describe("writeSourceMapOriginalSources", () => {
  it("writes sources + manifest, skips no-content entries, and hashes saved files", () => {
    const result = writeSourceMapOriginalSources(
      dir,
      { url: "https://a.com/app.js", scriptId: "42" },
      [
        { index: 0, source: "webpack://src/a.js", hasContent: true, contentText: "const a = 1;\n" },
        { index: 1, source: "webpack://src/b.js", hasContent: false },
      ],
      { version: 3 },
    );
    expect(existsSync(result.sourceRoot)).toBe(true);
    expect(existsSync(result.manifestPath)).toBe(true);
    // returned sources strip content/contentText
    expect(result.sources).toHaveLength(2);
    const saved = result.sources.find((s) => s.index === 0);
    expect(saved.saved).toBe(true);
    expect(saved.contentText).toBeUndefined();
    expect(saved.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(saved.path)).toBe(true);
    expect(readFileSync(saved.path, "utf8")).toBe("const a = 1;\n");
    const skipped = result.sources.find((s) => s.index === 1);
    expect(skipped.saved).toBe(false);
    expect(skipped.path).toBe(null);
    expect(skipped.reason).toMatch(/no sourcesContent/);
    // manifest content
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    expect(manifest.sourceCount).toBe(2);
    expect(manifest.savedCount).toBe(1);
    expect(manifest.metadata).toEqual({ version: 3 });
  });
});

describe("readSourceMapArtifact", () => {
  it("reads a file inside the allowed root with size + hash + bounded text", () => {
    const file = join(dir, "readme.txt");
    writeFileSync(file, "hello source map artifact");
    const out = readSourceMapArtifact(file, dir);
    expect(out.path).toBe(file);
    expect(out.bytes).toBe(Buffer.byteLength("hello source map artifact", "utf8"));
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(out.contentText).toBe("hello source map artifact");
    expect(out.truncated).toBe(false);
  });
  it("truncates when over maxChars", () => {
    const file = join(dir, "big.txt");
    writeFileSync(file, "abcdefghij");
    const out = readSourceMapArtifact(file, dir, 4);
    expect(out.truncated).toBe(true);
    expect(out.contentBytes).toBe(10); // full byte length still reported
  });
  it("throws on missing path, outside-root, and nonexistent file", () => {
    expect(() => readSourceMapArtifact("", dir)).toThrow(/path is required/);
    expect(() => readSourceMapArtifact(join(dir, "..", "evil.txt"), dir)).toThrow(/outside this profile evidence directory/);
    expect(() => readSourceMapArtifact(join(dir, "nope.txt"), dir)).toThrow(/does not exist/);
  });
});
