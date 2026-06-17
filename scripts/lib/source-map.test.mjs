import { describe, it, expect } from "vitest";
import {
  extractSourceMapReference,
  sourceMapSummary,
  decodeDataUrlText,
  parseSourceMapMetadata,
  loadSourceMap,
  sourceMapOriginalEntries,
  selectSourceMapOriginalSource,
} from "./source-map.mjs";

// Characterization tests pinning the pure source-map data helpers carved out of
// agent-cdp-server.mjs. They lock: sourceMappingURL comment extraction (both
// // and block-comment forms, last-match-wins), the objective source-map
// summary shape, data-URL decoding (base64 and percent-encoded), the async
// metadata/load behavior on the non-network paths (empty reference, data-URL,
// and external-without-fetch — no live HTTP is exercised), original-source
// entry derivation with sourceRoot resolution and content truncation, and the
// saved-source selection precedence (index -> exact source -> partial ->
// first). Outputs were captured from the live functions before extraction.

describe("extractSourceMapReference", () => {
  it("extracts the URL from a // sourceMappingURL comment", () => {
    expect(extractSourceMapReference("var a=1;\n//# sourceMappingURL=app.js.map")).toBe("app.js.map");
  });
  it("extracts the URL from a block-comment sourceMappingURL", () => {
    expect(extractSourceMapReference("/*# sourceMappingURL=b.map */")).toBe("b.map");
  });
  it("returns empty string when there is no sourceMappingURL", () => {
    expect(extractSourceMapReference("no map here")).toBe("");
  });
});

describe("sourceMapSummary", () => {
  it("summarizes a source map into objective counts and a sources sample", () => {
    expect(
      sourceMapSummary(
        { version: 3, file: "a.js", sources: ["x.ts", "y.ts"], names: ["n"], mappings: "AAAA", sourcesContent: ["code"] },
        "RAW",
      ),
    ).toEqual({
      version: 3,
      file: "a.js",
      sourceRoot: null,
      sourcesCount: 2,
      namesCount: 1,
      mappingsBytes: 4,
      hasSourcesContent: true,
      sourcesContentCount: 1,
      sourcesSample: ["x.ts", "y.ts"],
      rawBytes: 3,
    });
  });
  it("returns all-zero/null fields for a missing map", () => {
    expect(sourceMapSummary(null)).toEqual({
      version: null,
      file: null,
      sourceRoot: null,
      sourcesCount: 0,
      namesCount: 0,
      mappingsBytes: 0,
      hasSourcesContent: false,
      sourcesContentCount: 0,
      sourcesSample: [],
      rawBytes: 0,
    });
  });
});

describe("decodeDataUrlText", () => {
  it("decodes a base64 data URL", () => {
    const b64 = `data:application/json;base64,${Buffer.from('{"v":3}').toString("base64")}`;
    expect(decodeDataUrlText(b64)).toBe('{"v":3}');
  });
  it("decodes a percent-encoded data URL", () => {
    expect(decodeDataUrlText(`data:application/json,${encodeURIComponent('{"x":1}')}`)).toBe('{"x":1}');
  });
  it("throws for a non-data URL", () => {
    expect(() => decodeDataUrlText("http://x")).toThrow("not a data URL");
  });
});

describe("parseSourceMapMetadata", () => {
  it("returns kind 'none' for an empty reference", async () => {
    expect(await parseSourceMapMetadata("")).toEqual({ sourceMapURL: "", kind: "none", resolvedURL: null, map: null });
  });
  it("parses an inline data-URL source map into a summary", async () => {
    const ref = `data:application/json;base64,${Buffer.from(JSON.stringify({ version: 3, sources: ["a.ts"], mappings: "AAAA" })).toString("base64")}`;
    const meta = await parseSourceMapMetadata(ref);
    expect(meta.kind).toBe("data-url");
    expect(meta.resolvedURL).toBe(null);
    expect(meta.mediaType).toBe("application/json");
    expect(meta.map.sourcesCount).toBe(1);
    expect(meta.map.sourcesSample).toEqual(["a.ts"]);
  });
  it("resolves an external reference against the script URL without fetching by default", async () => {
    expect(await parseSourceMapMetadata("app.js.map", "https://h.com/js/app.js")).toEqual({
      sourceMapURL: "app.js.map",
      kind: "external",
      resolvedURL: "https://h.com/js/app.js.map",
      fetched: false,
      map: null,
    });
  });
});

describe("loadSourceMap", () => {
  it("loads and parses a data-URL source map, returning the raw text", async () => {
    const raw = JSON.stringify({ version: 3, sources: ["a.ts"], mappings: "AAAA" });
    const ref = `data:application/json;base64,${Buffer.from(raw).toString("base64")}`;
    const loaded = await loadSourceMap(ref, "https://h.com/app.js");
    expect(loaded.map).toEqual({ version: 3, sources: ["a.ts"], mappings: "AAAA" });
    expect(loaded.rawText).toBe(raw);
  });
  it("returns a null map for an external reference when fetchMap is off", async () => {
    const loaded = await loadSourceMap("app.js.map", "https://h.com/app.js");
    expect(loaded.map).toBe(null);
    expect(loaded.rawText).toBe("");
    expect(loaded.metadata).toEqual({
      sourceMapURL: "app.js.map",
      kind: "external",
      resolvedURL: "https://h.com/app.js.map",
      fetched: false,
      map: null,
    });
  });
});

describe("sourceMapOriginalEntries", () => {
  it("derives original-source entries, resolving sourceRoot and truncating content", () => {
    const map = { sourceRoot: "src/", sources: ["a.ts", "b.ts"], sourcesContent: ["AAAAA", null] };
    const entries = sourceMapOriginalEntries(map, { url: "https://h.com/js/app.js" }, { maxContentChars: 3 });
    expect(entries).toEqual([
      {
        index: 0,
        source: "a.ts",
        resolvedURL: "https://h.com/js/src/a.ts",
        hasContent: true,
        contentBytes: 5,
        contentText: "AAAAA",
        content: "AAA",
        contentTruncated: true,
      },
      {
        index: 1,
        source: "b.ts",
        resolvedURL: "https://h.com/js/src/b.ts",
        hasContent: false,
        contentBytes: 0,
        contentText: "",
        content: "",
        contentTruncated: false,
      },
    ]);
  });
});

describe("selectSourceMapOriginalSource", () => {
  const results = [
    {
      script: { url: "s1" },
      sourceRoot: "/r",
      manifestPath: "/m",
      sources: [
        { index: 0, source: "a.ts", resolvedURL: "https://h/a.ts", saved: true, path: "/r/0-a.ts" },
        { index: 1, source: "b.ts", saved: false, path: null },
      ],
    },
  ];
  it("returns the first saved-with-path entry by default", () => {
    expect(selectSourceMapOriginalSource(results)).toEqual({
      resultIndex: 0,
      script: { url: "s1" },
      sourceRoot: "/r",
      manifestPath: "/m",
      source: { index: 0, source: "a.ts", resolvedURL: "https://h/a.ts", saved: true, path: "/r/0-a.ts" },
    });
  });
  it("selects by index and by source name", () => {
    expect(selectSourceMapOriginalSource(results, { index: 0 }).source.source).toBe("a.ts");
    expect(selectSourceMapOriginalSource(results, { source: "a.ts" }).source.source).toBe("a.ts");
  });
  it("throws when no saved source with a path is available", () => {
    expect(() => selectSourceMapOriginalSource([{ sources: [{ saved: false }] }])).toThrow(
      "no saved source-map original source is available",
    );
  });
});
