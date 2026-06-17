// Source-map artifact filesystem helpers, extracted from agent-cdp-server.mjs
// (behavior-preserving monolith carve). These write extracted source-map original
// sources to the profile evidence directory and read them back with a path-
// containment guard. They touch the filesystem (like the existing
// evidence-artifacts.mjs) but take no CDP client / session / profile registry:
// inputs are plain rootDir/script/entries data and file paths. Hashing and text
// truncation reuse the already-extracted fileSha256 and truncateText helpers.
// Unit-tested in sourcemap-fs.test.mjs.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileSha256 } from "./evidence-artifacts.mjs";
import { truncateText } from "./text-utils.mjs";

export function safeArtifactName(raw, fallback = "source") {
  const name = String(raw || fallback)
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .pop() || fallback;
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120) || fallback;
}

export function writeSourceMapOriginalSources(rootDir, script = {}, entries = [], metadata = {}) {
  const stamp = Date.now();
  const scriptName = safeArtifactName(script.url || script.scriptId || "script", "script");
  const outDir = join(rootDir, "sources", `${stamp}-${scriptName}`);
  mkdirSync(outDir, { recursive: true });
  const savedSources = [];
  for (const entry of entries) {
    if (!entry.hasContent) {
      savedSources.push({ ...entry, path: null, saved: false, reason: "source map entry has no sourcesContent" });
      continue;
    }
    const file = join(outDir, `${String(entry.index).padStart(3, "0")}-${safeArtifactName(entry.source, "source")}`);
    writeFileSync(file, entry.contentText || "", "utf8");
    savedSources.push({
      ...entry,
      path: file,
      saved: true,
      sha256: fileSha256(file),
    });
  }
  const manifestPath = join(outDir, "manifest.json");
  const manifest = {
    generatedAt: new Date().toISOString(),
    script,
    metadata,
    sourceCount: entries.length,
    savedCount: savedSources.filter((entry) => entry.saved).length,
    sources: savedSources.map(({ content: _content, contentText: _contentText, ...entry }) => entry),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return {
    sourceRoot: outDir,
    manifestPath,
    sources: savedSources.map(({ content: _content, contentText: _contentText, ...entry }) => entry),
  };
}

export function pathInsideRoot(file, rootDir) {
  const target = resolve(file);
  const rootPath = resolve(rootDir);
  const normalizedTarget = process.platform === "win32" ? target.toLowerCase() : target;
  const normalizedRoot = process.platform === "win32" ? rootPath.toLowerCase() : rootPath;
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${sep}`);
}

export function readSourceMapArtifact(file, allowedRoot, maxChars = 120000) {
  if (!file) throw new Error("path is required");
  if (!pathInsideRoot(file, allowedRoot)) {
    throw new Error(`source artifact path is outside this profile evidence directory: ${file}`);
  }
  if (!existsSync(file)) throw new Error(`source artifact path does not exist: ${file}`);
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error(`source artifact path is not a file: ${file}`);
  const text = readFileSync(file, "utf8");
  const limited = truncateText(text, maxChars);
  return {
    path: file,
    bytes: stat.size,
    sha256: fileSha256(file),
    contentText: limited.text,
    truncated: limited.truncated,
    contentBytes: Buffer.byteLength(text, "utf8"),
  };
}
