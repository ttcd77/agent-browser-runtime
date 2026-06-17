// Pure source-map data helpers, extracted from agent-cdp-server.mjs
// (2026-06-07 monolith carve, behavior-preserving). These operate over
// sourceMappingURL references, decoded source-map JSON, and already-collected
// result lists. No CDP, no filesystem, no module state: the only side effect is
// the two async helpers fetching an EXTERNAL source-map URL over the network
// (Node global fetch) when the caller opts in via fetchMap. Everything else is
// plain string/URL/JSON/Buffer work plus truncateText from text-utils.
// Filesystem persistence of original sources (writeSourceMapOriginalSources /
// readSourceMapArtifact) stays in the worker; these helpers only shape data.
// Unit-tested in source-map.test.mjs.

import { truncateText } from "./text-utils.mjs";

export function extractSourceMapReference(sourceText) {
  const text = String(sourceText || "");
  const matches = [...text.matchAll(/(?:\/\/[#@]\s*sourceMappingURL=([^\s"'<>]+)|\/\*[#@]\s*sourceMappingURL=([^*]+?)\s*\*\/)/g)];
  const last = matches.at(-1);
  return last ? String(last[1] || last[2] || "").trim() : "";
}

export function sourceMapSummary(map, rawText = "") {
  const sources = Array.isArray(map?.sources) ? map.sources : [];
  const names = Array.isArray(map?.names) ? map.names : [];
  const sourcesContent = Array.isArray(map?.sourcesContent) ? map.sourcesContent : [];
  return {
    version: map?.version ?? null,
    file: map?.file ?? null,
    sourceRoot: map?.sourceRoot ?? null,
    sourcesCount: sources.length,
    namesCount: names.length,
    mappingsBytes: typeof map?.mappings === "string" ? Buffer.byteLength(map.mappings, "utf8") : 0,
    hasSourcesContent: sourcesContent.length > 0,
    sourcesContentCount: sourcesContent.length,
    sourcesSample: sources.slice(0, 20),
    rawBytes: Buffer.byteLength(String(rawText || ""), "utf8"),
  };
}

export function decodeDataUrlText(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^,]*?),(.*)$/s);
  if (!match) throw new Error("not a data URL");
  const meta = match[1] || "";
  const payload = match[2] || "";
  if (/;base64/i.test(meta)) {
    return Buffer.from(payload, "base64").toString("utf8");
  }
  return decodeURIComponent(payload);
}

export async function parseSourceMapMetadata(reference, scriptUrl, options = {}) {
  const sourceMapURL = String(reference || "").trim();
  if (!sourceMapURL) {
    return { sourceMapURL: "", kind: "none", resolvedURL: null, map: null };
  }
  if (sourceMapURL.startsWith("data:")) {
    try {
      const text = decodeDataUrlText(sourceMapURL);
      const map = JSON.parse(text);
      return {
        sourceMapURL,
        kind: "data-url",
        resolvedURL: null,
        mediaType: sourceMapURL.slice(5, sourceMapURL.indexOf(",")).split(";")[0] || null,
        map: sourceMapSummary(map, text),
      };
    } catch (err) {
      return { sourceMapURL, kind: "data-url", resolvedURL: null, map: null, error: String(err?.message || err) };
    }
  }

  let resolvedURL = sourceMapURL;
  try {
    resolvedURL = new URL(sourceMapURL, scriptUrl || "about:blank").toString();
  } catch {
    // Keep the raw reference when the page uses a non-standard URL base.
  }
  const result = {
    sourceMapURL,
    kind: "external",
    resolvedURL,
    fetched: false,
    map: null,
  };
  if (options.fetchMap) {
    try {
      const response = await fetch(resolvedURL);
      const text = await response.text();
      result.fetched = true;
      result.httpStatus = response.status;
      result.contentType = response.headers.get("content-type");
      if (response.ok) {
        result.map = sourceMapSummary(JSON.parse(text), text);
      } else {
        result.error = `HTTP ${response.status}`;
      }
    } catch (err) {
      result.error = String(err?.message || err);
    }
  }
  return result;
}

export async function loadSourceMap(reference, scriptUrl, options = {}) {
  const metadata = await parseSourceMapMetadata(reference, scriptUrl, { fetchMap: Boolean(options.fetchMap) });
  if (!reference || metadata.error) return { metadata, map: null, rawText: "" };
  try {
    if (String(reference).startsWith("data:")) {
      const rawText = decodeDataUrlText(reference);
      return { metadata, map: JSON.parse(rawText), rawText };
    }
    if (!options.fetchMap || !metadata.resolvedURL || !metadata.fetched || !metadata.httpStatus || metadata.httpStatus >= 400) {
      return { metadata, map: null, rawText: "" };
    }
    const response = await fetch(metadata.resolvedURL);
    const rawText = await response.text();
    if (!response.ok) {
      return { metadata: { ...metadata, error: metadata.error || `HTTP ${response.status}` }, map: null, rawText };
    }
    return { metadata, map: JSON.parse(rawText), rawText };
  } catch (err) {
    return { metadata: { ...metadata, error: String(err?.message || err) }, map: null, rawText: "" };
  }
}

export function sourceMapOriginalEntries(map, script = {}, options = {}) {
  const sources = Array.isArray(map?.sources) ? map.sources : [];
  const sourcesContent = Array.isArray(map?.sourcesContent) ? map.sourcesContent : [];
  const maxSources = Math.max(1, Math.min(Number(options.maxSources || 100), 1000));
  const maxContentChars = Math.max(0, Number(options.maxContentChars || 0));
  return sources.slice(0, maxSources).map((source, index) => {
    const hasContent = typeof sourcesContent[index] === "string";
    const content = hasContent ? String(sourcesContent[index]) : "";
    let resolvedURL = source;
    try {
      const root = map?.sourceRoot ? new URL(String(map.sourceRoot), script.url || "about:blank").toString() : script.url || "about:blank";
      resolvedURL = new URL(String(source), root).toString();
    } catch {
      // Keep the source map's raw source entry when URL resolution is not meaningful.
    }
    const limited = maxContentChars > 0 ? truncateText(content, maxContentChars) : { text: "", truncated: false };
    return {
      index,
      source: String(source),
      resolvedURL,
      hasContent,
      contentBytes: Buffer.byteLength(content, "utf8"),
      contentText: content,
      content: limited.text,
      contentTruncated: limited.truncated,
    };
  });
}

export function selectSourceMapOriginalSource(results = [], params = {}) {
  const entries = [];
  for (const [resultIndex, result] of results.entries()) {
    for (const source of result.sources || []) {
      entries.push({
        resultIndex,
        script: result.script || null,
        sourceRoot: result.sourceRoot || null,
        manifestPath: result.manifestPath || null,
        source,
      });
    }
  }
  const savedEntries = entries.filter((entry) => entry.source?.saved && entry.source?.path);
  if (!savedEntries.length) {
    throw new Error("no saved source-map original source is available; the map may not include sourcesContent");
  }
  if (typeof params.index === "number") {
    const byIndex = savedEntries.find((entry) => Number(entry.source?.index) === Number(params.index));
    if (byIndex) return byIndex;
  }
  if (params.source) {
    const needle = String(params.source);
    const exact = savedEntries.find((entry) => String(entry.source?.source || "") === needle);
    if (exact) return exact;
    const partial = savedEntries.find((entry) => String(entry.source?.source || "").includes(needle) || String(entry.source?.resolvedURL || "").includes(needle));
    if (partial) return partial;
  }
  return savedEntries[0];
}
