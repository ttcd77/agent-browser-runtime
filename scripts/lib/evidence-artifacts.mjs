// Pure evidence/artifact filesystem helpers, extracted from agent-cdp-server.mjs
// (2026-06-06 monolith carve, behavior-preserving). No CDP, no module state:
// each takes arguments (paths / already-parsed payloads / file-listing arrays)
// and returns a value or a bounded view-model, using only JS stdlib + node fs/
// crypto/path and the shared artifact-index / source-search helpers. Filesystem
// reads are bounded and read-only. Unit-tested in evidence-artifacts.test.mjs.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { buildArtifactIndex as buildSharedArtifactIndex, inferArtifactKind as inferSharedArtifactKind } from "./artifact-index.mjs";
import { findSourceMatches } from "./source-search.mjs";

// C-02: path-containment check — same logic as sourcemap-fs.mjs to keep pure.
function pathInsideRoot(file, rootDir) {
  const target = resolve(file);
  const rootPath = resolve(rootDir);
  const normalizedTarget = process.platform === "win32" ? target.toLowerCase() : target;
  const normalizedRoot = process.platform === "win32" ? rootPath.toLowerCase() : rootPath;
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${sep}`);
}

export function fileSha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function listEvidenceFiles(rootDir, options = {}) {
  const maxFiles = typeof options.maxFiles === "number" ? options.maxFiles : 200;
  const maxBytesForHash = typeof options.maxBytesForHash === "number" ? options.maxBytesForHash : 25_000_000;
  const out = [];
  const walk = (dir) => {
    if (out.length >= maxFiles || !existsSync(dir)) return;
    for (const name of readdirSync(dir).sort().reverse()) {
      if (out.length >= maxFiles) break;
      const file = join(dir, name);
      let stat;
      try {
        stat = statSync(file);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(file);
        continue;
      }
      const relativePath = file.slice(rootDir.length).replace(/^[/\\]/, "");
      out.push({
        path: file,
        relativePath,
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        sha256: stat.size <= maxBytesForHash ? fileSha256(file) : null,
        hashSkipped: stat.size > maxBytesForHash,
      });
    }
  };
  walk(rootDir);
  return out;
}

export function readJsonFile(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function summarizeResearchPackHandoff(parsed) {
  if (!parsed || typeof parsed !== "object" || parsed.schema !== "agent-browser-runtime.security-research-pack-handoff.v1") return null;
  const summary = parsed.summary || {};
  const agentEntryPoints = parsed.agentEntryPoints || {};
  const agentUsage = parsed.agentUsage || {};
  const artifactPaths = parsed.artifactPaths || {};
  const handoffCompleteness = parsed.handoffCompleteness || {};
  const artifactCoverage = parsed.artifactCoverage || {};
  const f12Navigation = parsed.f12Navigation || {};
  const firstF12RequestDetail = parsed.firstF12RequestDetail || null;
  return {
    schema: parsed.schema,
    backend: parsed.backend || null,
    generatedAt: parsed.generatedAt || null,
    profile: parsed.profile || null,
    url: summary.url || parsed.page?.url || null,
    ready: Boolean(handoffCompleteness.ready && artifactCoverage.ready !== false),
    handoffReady: handoffCompleteness.ready ?? null,
    artifactCoverageReady: artifactCoverage.ready ?? null,
    handoffMissing: handoffCompleteness.missing || summary.handoffMissing || [],
    handoffChecks: Array.isArray(handoffCompleteness.checks) ? handoffCompleteness.checks.map((check) => ({
      name: check.name,
      present: Boolean(check.present),
      evidence: check.evidence ?? null,
    })) : [],
    artifactCoverageMissing: artifactCoverage.missing || summary.artifactCoverageMissing || [],
    artifactCoverageSkipped: artifactCoverage.skipped || summary.artifactCoverageSkipped || [],
    artifactCoverageRows: Array.isArray(artifactCoverage.rows) ? artifactCoverage.rows.map((row) => ({
      name: row.name,
      status: row.status,
      requested: Boolean(row.requested),
      path: row.path || null,
    })) : [],
    agentEntryMode: agentEntryPoints.defaultMode || null,
    recommendedFirstCall: agentEntryPoints.recommendedFirstCall || null,
    professionalPath: agentEntryPoints.professionalPath || [],
    drilldownRule: agentEntryPoints.drilldownRule || null,
    recommendedRoute: Array.isArray(agentUsage.recommendedRoute) ? agentUsage.recommendedRoute : (Array.isArray(agentUsage.defaultRoute) ? agentUsage.defaultRoute : []),
    panelRoutes: agentUsage.panelRoutes || null,
    f12Navigation: f12Navigation && typeof f12Navigation === "object" ? {
      schema: f12Navigation.schema || null,
      requestNodeCount: f12Navigation.requestNodeCount ?? null,
      firstRequest: f12Navigation.firstRequest || null,
      firstDetailRoute: Array.isArray(f12Navigation.requests) ? f12Navigation.requests.find((row) => row?.detail)?.detail || null : null,
      requestDrilldowns: Array.isArray(f12Navigation.requests) ? f12Navigation.requests.filter((row) => row?.detail).slice(0, 5).map((row) => ({
        label: row.label || row.f12Columns?.name || row.url || row.requestId || "request detail",
        tool: row.detail.tool,
        input: row.detail.input || {},
        requestId: row.requestId || null,
        f12Columns: row.f12Columns || null,
      })) : [],
      artifacts: f12Navigation.artifacts || null,
      sectionRoutes: f12Navigation.sectionRoutes || null,
      boundaries: f12Navigation.boundaries || [],
    } : null,
    firstF12RequestDetail,
    drilldownCount: parsed.drilldownPlan?.count ?? summary.drilldownCount ?? null,
    firstDrilldowns: (parsed.drilldownPlan?.drilldowns || []).slice(0, 5).map((entry) => ({
      label: entry.label,
      tool: entry.tool,
      input: entry.input,
    })),
    artifactPaths,
    nextTools: parsed.nextTools || [],
    nextRead: summary.researchPackPath ? {
      tool: "browser_artifact_read",
      input: { path: summary.researchPackPath, mode: "line", startLine: 1, lineCount: 160 },
    } : null,
    objectiveBoundary: "This handoff summary checks saved evidence-pack structure and routes only; it does not judge vulnerabilities or security impact.",
  };
}

export function inspectArtifactFile(params = {}) {
  const artifactPath = params.path || params.artifactPath;
  if (!artifactPath) throw new Error("path is required");
  const file = resolve(String(artifactPath));
  const maxBytes = Math.max(1, Math.min(Number(params.maxBytes) || 120000, 2_000_000));
  const maxMatches = Math.max(0, Math.min(Number(params.maxMatches) || 20, 200));
  const contextChars = Math.max(0, Math.min(Number(params.contextChars) || 160, 2000));
  const query = params.query == null ? "" : String(params.query);
  // C-02: enforce path whitelist when callers supply allowedRoots (prevents reading
  // arbitrary OS files). Callers from managed-CDP always pass evidenceDir + tmp.
  const allowedRoots = [
    ...(Array.isArray(params.allowedRoots) ? params.allowedRoots : []),
    ...ARTIFACT_ROOT_OVERRIDE,
  ];
  if (allowedRoots.length > 0) {
    const allowed = allowedRoots.some((root) => pathInsideRoot(file, root));
    if (!allowed) {
      return {
        schema: "agent-browser-runtime.artifact-inspect.v1",
        backend: params.backend || "managed-cdp",
        ok: false,
        path: String(artifactPath),
        resolvedPath: file,
        exists: false,
        error: "path_outside_evidence_directory",
        reason: "The requested path is not inside an ABR-managed evidence directory.",
        boundaries: ["browser_artifact_inspect only reads files inside ABR evidence directories. Set ABR_ARTIFACT_ROOT_OVERRIDE to allow additional roots."],
      };
    }
  }
  if (!existsSync(file)) {
    return {
      schema: "agent-browser-runtime.artifact-inspect.v1",
      backend: params.backend || "managed-cdp",
      path: String(artifactPath),
      resolvedPath: file,
      exists: false,
      boundaries: ["This tool reads local evidence artifacts only; it does not interpret findings."],
    };
  }
  const stat = statSync(file);
  const out = {
    schema: "agent-browser-runtime.artifact-inspect.v1",
    backend: params.backend || "managed-cdp",
    path: String(artifactPath),
    resolvedPath: file,
    exists: true,
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    sha256: stat.isFile() && stat.size <= 25_000_000 ? fileSha256(file) : null,
    hashSkipped: stat.isFile() && stat.size > 25_000_000,
    readLimitBytes: maxBytes,
    boundaries: [
      "This is bounded local artifact inspection for agent drill-down.",
      "It returns structure, previews, and literal matches; it does not decide vulnerability impact.",
      "If an artifact was not captured earlier, this tool cannot reconstruct missing browser events.",
    ],
    nextTools: ["browser_artifact_inspect path=<artifact> query=<literal>", "browser_evidence_manifest", "browser_global_search"],
  };
  if (!stat.isFile()) return out;

  const ext = file.toLowerCase().split(".").pop() || "";
  const textLike = new Set(["json", "har", "txt", "log", "md", "html", "htm", "js", "mjs", "ts", "css", "csv", "xml", "yml", "yaml", "map", "svg"]);
  const buffer = readFileSync(file);
  const previewBuffer = buffer.subarray(0, Math.min(buffer.length, maxBytes));
  const text = previewBuffer.toString("utf8");
  out.previewBytes = previewBuffer.length;
  out.previewTruncated = buffer.length > previewBuffer.length;
  out.kind = textLike.has(ext) || !text.includes("\u0000") ? "text" : "binary";
  if (out.kind !== "text") return out;

  const lines = text.split(/\r?\n/);
  out.previewText = text;
  out.previewLineCount = lines.length;
  out.firstLines = lines.slice(0, Math.min(20, lines.length));
  out.lastLines = lines.slice(Math.max(0, lines.length - 20));

  if (["json", "har", "map"].includes(ext) && buffer.length <= Math.max(maxBytes, 2_000_000)) {
    try {
      const parsed = JSON.parse(buffer.toString("utf8"));
      out.json = {
        ok: true,
        topLevelType: Array.isArray(parsed) ? "array" : typeof parsed,
        keys: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed).slice(0, 80) : [],
        arrayLength: Array.isArray(parsed) ? parsed.length : null,
        harEntryCount: Array.isArray(parsed?.log?.entries) ? parsed.log.entries.length : null,
        traceEventCount: Array.isArray(parsed?.traceEvents) ? parsed.traceEvents.length : null,
      };
      const handoff = summarizeResearchPackHandoff(parsed);
      if (handoff) {
        out.researchPackHandoff = handoff;
        out.nextTools = [
          "browser_artifact_read path=<researchPackPath> mode=line",
          "browser_artifact_inspect path=<drilldownPlanPath>",
          "browser_artifact_index kind=<artifact-kind>",
          ...handoff.nextTools,
        ];
      }
    } catch (error) {
      out.json = { ok: false, error: String(error?.message || error) };
    }
  } else if (["json", "har", "map"].includes(ext)) {
    out.json = { ok: false, skipped: true, reason: "artifact exceeds bounded JSON parse limit" };
  }

  if (query) {
    const searchText = buffer.length <= 5_000_000 ? buffer.toString("utf8") : text;
    out.matches = findSourceMatches(searchText, query, {
      caseSensitive: Boolean(params.caseSensitive),
      maxMatches,
      contextChars,
    });
    out.matchCount = out.matches.length;
    out.searchTruncated = buffer.length > 5_000_000;
  }
  return out;
}

export function inferArtifactKind(file) {
  return inferSharedArtifactKind(file);
  const value = String(file || "").replace(/\\/g, "/").toLowerCase();
  const ext = value.split(".").pop() || "";
  if (value.includes("har-completeness")) return "har-completeness";
  if (ext === "har" || value.includes("/har/")) return "har";
  if (value.includes("/traces/") || value.includes("chrome-trace") || value.includes("trace")) return "trace";
  if (value.includes("/screenshots/") || ["png", "jpg", "jpeg", "webp"].includes(ext)) return "screenshot";
  if (value.includes("/application/") || value.includes("application-export")) return "application";
  if (value.includes("/f12-navigation/") || value.includes("f12-navigation")) return "f12-navigation";
  if (value.includes("/drilldowns/") || value.includes("research-pack-drilldowns")) return "drilldown-plan";
  if (value.includes("/research-packs/") || value.includes("security-research-pack")) return "research-pack";
  if (value.includes("/bundles/") || value.includes("evidence-bundle") || value.includes("f12-evidence")) return "bundle";
  if (value.includes("/manifests/") || value.includes("manifest")) return "manifest";
  if (value.includes("/graphs/") || value.includes("graph")) return "graph";
  if (value.includes("/realtime/") || value.includes("realtime")) return "realtime";
  if (value.includes("/diffs/") || value.includes("diff")) return "diff";
  if (value.includes("/auth/") || value.includes("auth-boundary")) return "auth-boundary";
  if (value.includes("/boundaries/") || value.includes("worker-frame")) return "boundary";
  if (value.includes("/request-details/") || value.includes("request-detail")) return "request-detail";
  if (value.includes("/heap/") || ext === "heapsnapshot") return "heap";
  if (value.includes("/profiles/") || value.includes("cpu-profile")) return "cpu-profile";
  if (value.includes("/source-maps/") || value.includes("source-map")) return "source-map";
  if (value.includes("/bodies/") || value.includes("body")) return "body";
  if (ext === "json") return "json";
  if (["txt", "log", "md", "html", "js", "mjs", "ts", "css", "csv", "xml", "yml", "yaml", "map"].includes(ext)) return "text";
  return "other";
}

export function buildArtifactIndex(files = [], params = {}) {
  return buildSharedArtifactIndex(files, params);
  const query = String(params.query || "").trim().toLowerCase();
  const kindFilter = String(params.kind || "").trim().toLowerCase();
  const maxFiles = Math.max(1, Math.min(Number(params.maxFiles) || 200, 2000));
  const minBytes = Number.isFinite(Number(params.minBytes)) ? Number(params.minBytes) : null;
  const maxBytes = Number.isFinite(Number(params.maxBytes)) ? Number(params.maxBytes) : null;
  const rows = files.map((file) => ({
    ...file,
    kind: inferArtifactKind(file.path || file.relativePath || ""),
  }));
  const filtered = rows
    .filter((file) => !kindFilter || file.kind === kindFilter)
    .filter((file) => !query || `${file.path || ""} ${file.relativePath || ""} ${file.kind}`.toLowerCase().includes(query))
    .filter((file) => minBytes == null || Number(file.bytes || 0) >= minBytes)
    .filter((file) => maxBytes == null || Number(file.bytes || 0) <= maxBytes)
    .sort((a, b) => String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || "")));
  const kinds = {};
  const latestByKind = {};
  let totalBytes = 0;
  for (const file of rows) {
    kinds[file.kind] = (kinds[file.kind] || 0) + 1;
    totalBytes += Number(file.bytes || 0);
    const current = latestByKind[file.kind];
    if (!current || String(file.modifiedAt || "").localeCompare(String(current.modifiedAt || "")) > 0) {
      latestByKind[file.kind] = {
        path: file.path,
        relativePath: file.relativePath,
        kind: file.kind,
        bytes: file.bytes,
        modifiedAt: file.modifiedAt,
        sha256: file.sha256 || null,
        inspectInput: { path: file.path },
        readInput: { path: file.path, mode: "line", startLine: 1, lineCount: 120 },
      };
    }
  }
  const recommendedKindOrder = ["research-pack", "drilldown-plan", "har", "realtime", "application", "bundle", "manifest", "graph", "auth-boundary", "boundary", "trace"];
  const recommendedDrilldowns = recommendedKindOrder
    .filter((kind) => latestByKind[kind])
    .flatMap((kind) => {
      const artifact = latestByKind[kind];
      const drilldowns = [{
        label: `Latest ${kind} artifact`,
        tool: "browser_artifact_inspect",
        input: artifact.inspectInput,
        path: artifact.path,
      }];
      if (["research-pack", "drilldown-plan", "har", "realtime", "application", "bundle", "manifest", "graph", "auth-boundary", "boundary"].includes(kind)) {
        drilldowns.push({
          label: `Read latest ${kind} artifact`,
          tool: "browser_artifact_read",
          input: artifact.readInput,
          path: artifact.path,
        });
      }
      return drilldowns;
    })
    .slice(0, 12);
  return {
    schema: "agent-browser-runtime.artifact-index.v1",
    generatedAt: new Date().toISOString(),
    totalFileCount: rows.length,
    returnedFileCount: Math.min(filtered.length, maxFiles),
    totalBytes,
    kinds,
    latestByKind,
    recommendedDrilldowns,
    filters: {
      query: query || null,
      kind: kindFilter || null,
      minBytes,
      maxBytes,
      maxFiles,
    },
    artifacts: filtered.slice(0, maxFiles).map((file) => ({
      path: file.path,
      relativePath: file.relativePath,
      kind: file.kind,
      bytes: file.bytes,
      modifiedAt: file.modifiedAt,
      sha256: file.sha256 || null,
      hashSkipped: Boolean(file.hashSkipped),
      nextTool: "browser_artifact_inspect",
      inspectInput: { path: file.path },
    })),
    boundaries: [
      "This index lists local evidence artifacts that already exist on disk.",
      "It does not read every artifact body and does not decide vulnerability impact.",
      "latestByKind is a convenience pointer for navigation only; use inspect/read tools for bounded content access.",
      "recommendedDrilldowns are deterministic navigation shortcuts, not findings.",
      "Use browser_artifact_inspect for bounded structure, preview, and literal match drill-down.",
    ],
  };
}

export function buildArtifactSearch(files = [], params = {}) {
  const query = String(params.query || "").trim();
  if (!query) throw new Error("query is required");
  const kindFilter = String(params.kind || "").trim().toLowerCase();
  const maxFiles = Math.max(1, Math.min(Number(params.maxFiles) || 100, 1000));
  const maxMatches = Math.max(1, Math.min(Number(params.maxMatches) || 50, 500));
  const maxMatchesPerFile = Math.max(1, Math.min(Number(params.maxMatchesPerFile) || 10, 100));
  const maxBytesPerFile = Math.max(1024, Math.min(Number(params.maxBytesPerFile) || 500000, 5_000_000));
  const contextChars = Math.max(0, Math.min(Number(params.contextChars) || 160, 2000));
  const rows = files
    .map((file) => ({ ...file, kind: inferArtifactKind(file.path || file.relativePath || "") }))
    .filter((file) => !kindFilter || file.kind === kindFilter)
    .sort((a, b) => String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || "")))
    .slice(0, maxFiles);
  const fileMatches = [];
  let scannedFileCount = 0;
  let skippedFileCount = 0;
  let totalMatches = 0;
  for (const file of rows) {
    if (totalMatches >= maxMatches) break;
    if (!file.path || !existsSync(file.path) || Number(file.bytes || 0) > maxBytesPerFile) {
      skippedFileCount += 1;
      continue;
    }
    const ext = String(file.path).toLowerCase().split(".").pop() || "";
    const searchable = ["har", "json", "txt", "log", "md", "html", "htm", "js", "mjs", "ts", "css", "csv", "xml", "yml", "yaml", "map", "svg"].includes(ext);
    if (!searchable) {
      skippedFileCount += 1;
      continue;
    }
    let text = "";
    try {
      text = readFileSync(file.path, "utf8");
    } catch {
      skippedFileCount += 1;
      continue;
    }
    scannedFileCount += 1;
    const matches = findSourceMatches(text, query, {
      caseSensitive: Boolean(params.caseSensitive),
      maxMatches: Math.min(maxMatchesPerFile, maxMatches - totalMatches),
      contextChars,
    });
    if (!matches.length) continue;
    totalMatches += matches.length;
    fileMatches.push({
      path: file.path,
      relativePath: file.relativePath,
      kind: file.kind,
      bytes: file.bytes,
      modifiedAt: file.modifiedAt,
      matchCount: matches.length,
      matches,
      nextTool: "browser_artifact_inspect",
      inspectInput: { path: file.path, query },
    });
  }
  return {
    schema: "agent-browser-runtime.artifact-search.v1",
    generatedAt: new Date().toISOString(),
    query,
    filters: {
      kind: kindFilter || null,
      maxFiles,
      maxMatches,
      maxMatchesPerFile,
      maxBytesPerFile,
      contextChars,
      caseSensitive: Boolean(params.caseSensitive),
    },
    candidateFileCount: rows.length,
    scannedFileCount,
    skippedFileCount,
    matchedFileCount: fileMatches.length,
    totalMatches,
    fileMatches,
    boundaries: [
      "This is literal search across saved local evidence artifacts.",
      "It skips oversized or non-text artifacts and does not interpret match meaning.",
      "Use browser_artifact_inspect on a returned path for bounded file-level drill-down.",
    ],
  };
}

// C-02: parse ABR_ARTIFACT_ROOT_OVERRIDE once at module load.
// Comma-separated list of additional allowed root directories for power users.
const ARTIFACT_ROOT_OVERRIDE = (process.env.ABR_ARTIFACT_ROOT_OVERRIDE || "")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

export function readArtifactSlice(params = {}) {
  const artifactPath = params.path || params.artifactPath;
  if (!artifactPath) throw new Error("path is required");
  const file = resolve(String(artifactPath));
  const maxBytes = Math.max(1, Math.min(Number(params.maxBytes) || 120000, 2_000_000));
  const startByte = Math.max(0, Number(params.startByte) || 0);
  const startLine = params.startLine == null ? null : Math.max(1, Number(params.startLine) || 1);
  const lineCount = Math.max(1, Math.min(Number(params.lineCount) || 80, 5000));

  // C-02: enforce path whitelist — must be inside one of the caller-supplied
  // allowedRoots (ABR-owned evidence dirs) or the ABR_ARTIFACT_ROOT_OVERRIDE list.
  // This prevents browser_artifact_read from reading arbitrary OS files.
  const allowedRoots = [
    ...(Array.isArray(params.allowedRoots) ? params.allowedRoots : []),
    ...ARTIFACT_ROOT_OVERRIDE,
  ];
  if (allowedRoots.length > 0) {
    const allowed = allowedRoots.some((root) => pathInsideRoot(file, root));
    if (!allowed) {
      return {
        schema: "agent-browser-runtime.artifact-read.v1",
        backend: params.backend || "managed-cdp",
        ok: false,
        path: String(artifactPath),
        resolvedPath: file,
        exists: false,
        error: "path_outside_evidence_directory",
        reason: "The requested path is not inside an ABR-managed evidence directory.",
        boundaries: ["browser_artifact_read only reads files inside ABR evidence directories. Set ABR_ARTIFACT_ROOT_OVERRIDE to allow additional roots."],
      };
    }
  }

  if (!existsSync(file)) {
    return {
      schema: "agent-browser-runtime.artifact-read.v1",
      backend: params.backend || "managed-cdp",
      path: String(artifactPath),
      resolvedPath: file,
      exists: false,
      boundaries: ["This tool reads local evidence artifact slices only; it does not interpret findings."],
    };
  }
  const stat = statSync(file);
  if (!stat.isFile()) {
    return {
      schema: "agent-browser-runtime.artifact-read.v1",
      backend: params.backend || "managed-cdp",
      path: String(artifactPath),
      resolvedPath: file,
      exists: true,
      isFile: false,
      bytes: stat.size,
      boundaries: ["The requested artifact path is not a regular file."],
    };
  }

  const buffer = readFileSync(file);
  const base = {
    schema: "agent-browser-runtime.artifact-read.v1",
    backend: params.backend || "managed-cdp",
    path: String(artifactPath),
    resolvedPath: file,
    exists: true,
    isFile: true,
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    sha256: stat.size <= 25_000_000 ? fileSha256(file) : null,
    hashSkipped: stat.size > 25_000_000,
    kind: inferArtifactKind(file),
    boundaries: [
      "This is bounded local artifact reading for agent drill-down.",
      "It returns exact file slices and does not decide vulnerability impact.",
    ],
    nextTools: ["browser_artifact_search", "browser_artifact_inspect"],
  };

  if (startLine != null) {
    const textLimit = Math.min(buffer.length, Math.max(maxBytes, 5_000_000));
    const text = buffer.subarray(0, textLimit).toString("utf8");
    const lines = text.split(/\r?\n/);
    const zero = startLine - 1;
    const selected = lines.slice(zero, zero + lineCount);
    return {
      ...base,
      mode: "line",
      startLine,
      lineCount,
      returnedLineCount: selected.length,
      lineSearchTruncated: textLimit < buffer.length,
      contentText: selected.join("\n"),
      lines: selected.map((line, index) => ({ lineNumber: startLine + index, text: line })),
    };
  }

  const endByte = Math.min(buffer.length, startByte + maxBytes);
  const slice = buffer.subarray(startByte, endByte);
  const text = slice.toString("utf8");
  return {
    ...base,
    mode: "byte",
    startByte,
    endByte,
    returnedBytes: slice.length,
    truncatedBefore: startByte > 0,
    truncatedAfter: endByte < buffer.length,
    contentText: text,
    contentBase64: params.includeBase64 ? slice.toString("base64") : undefined,
  };
}

export function evidenceTimestamp(value) {
  if (!value) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function buildEvidenceTimeline({ requests = [], consoleLog = {}, issues = {}, realtime = {}, artifacts = [] }, params = {}) {
  const maxEvents = Math.max(1, Math.min(Number(params.maxEvents) || 200, 2000));
  const eventType = String(params.eventType || "").trim().toLowerCase();
  const sourceFilter = String(params.source || "").trim().toLowerCase();
  const query = String(params.query || "").trim().toLowerCase();
  const since = evidenceTimestamp(params.since);
  const until = evidenceTimestamp(params.until);
  const events = [];
  for (const request of requests || []) {
    const timestamp = evidenceTimestamp(request.timestamp || request.startedAt || request.requestTime || request.wallTime || request.responseTimestamp || request.finishedAt);
    events.push({
      timestamp,
      type: "network-request",
      source: "Network",
      label: `${request.method || "GET"} ${request.status || "pending"} ${request.url || ""}`.trim(),
      requestId: request.requestId || null,
      url: request.url || "",
      method: request.method || "",
      status: request.status ?? null,
      resourceType: request.resourceType || request.type || null,
      nextTool: "profile_request_detail",
      drilldownInput: request.requestId ? { requestId: request.requestId } : null,
    });
  }
  for (const entry of consoleLog.console || consoleLog.entries || []) {
    events.push({
      timestamp: evidenceTimestamp(entry.timestamp),
      type: "console",
      source: "Console",
      label: `${entry.type || "console"} ${(entry.args || entry.text || []).toString().slice(0, 160)}`.trim(),
      level: entry.type || entry.level || null,
      nextTool: "browser_console_log",
      drilldownInput: { reload: false },
    });
  }
  for (const entry of consoleLog.exceptions || []) {
    events.push({
      timestamp: evidenceTimestamp(entry.timestamp || entry.timestampRaw),
      type: "exception",
      source: "Console",
      label: entry.details?.text || entry.details?.exception?.description || "Runtime exception",
      exceptionId: entry.exceptionId || null,
      nextTool: "browser_console_source_context",
      drilldownInput: { reload: false },
    });
  }
  for (const entry of consoleLog.logs || []) {
    events.push({
      timestamp: evidenceTimestamp(entry.timestamp || entry.entry?.timestamp),
      type: "log-entry",
      source: "Log",
      label: entry.entry?.text || entry.entry?.url || "Log entry",
      level: entry.entry?.level || null,
      nextTool: "browser_console_log",
      drilldownInput: { reload: false },
    });
  }
  for (const issue of issues.issues || []) {
    events.push({
      timestamp: evidenceTimestamp(issue.timestamp),
      type: "devtools-issue",
      source: "Issues",
      label: issue.issue?.code || issue.code || issue.error || "DevTools issue",
      nextTool: "browser_issues_log",
      drilldownInput: { reload: false },
    });
  }
  for (const socket of realtime.websockets || []) {
    events.push({
      timestamp: evidenceTimestamp(socket.createdAt || socket.updatedAt),
      type: "websocket",
      source: "Network",
      label: `WebSocket ${socket.status || ""} ${socket.url || ""}`.trim(),
      requestId: socket.requestId || null,
      url: socket.url || "",
      nextTool: "profile_realtime_log",
      drilldownInput: socket.requestId ? { requestId: socket.requestId } : {},
    });
    for (const frame of socket.frames || []) {
      events.push({
        timestamp: evidenceTimestamp(frame.timestamp || socket.updatedAt || socket.createdAt),
        type: "websocket-frame",
        source: "Network",
        label: `WebSocket ${frame.direction || "frame"} ${String(frame.payloadData || "").slice(0, 120)}`.trim(),
        requestId: socket.requestId || null,
        nextTool: "profile_realtime_log",
        drilldownInput: socket.requestId ? { requestId: socket.requestId } : {},
      });
    }
  }
  for (const event of realtime.eventSources || []) {
    events.push({
      timestamp: evidenceTimestamp(event.timestamp || event.receivedAt),
      type: "eventsource-message",
      source: "Network",
      label: `EventSource ${String(event.eventName || event.data || "").slice(0, 140)}`.trim(),
      requestId: event.requestId || null,
      nextTool: "profile_realtime_log",
      drilldownInput: event.requestId ? { requestId: event.requestId } : {},
    });
  }
  for (const artifact of artifacts || []) {
    events.push({
      timestamp: evidenceTimestamp(artifact.modifiedAt),
      type: "artifact",
      source: "Evidence",
      label: `${artifact.kind || inferArtifactKind(artifact.path)} ${artifact.relativePath || artifact.path || ""}`.trim(),
      path: artifact.path,
      kind: artifact.kind || inferArtifactKind(artifact.path),
      bytes: artifact.bytes,
      nextTool: "browser_artifact_read",
      drilldownInput: { path: artifact.path },
    });
  }
  const filtered = events
    .filter((event) => event.timestamp || params.includeUndated)
    .filter((event) => !eventType || String(event.type || "").toLowerCase() === eventType)
    .filter((event) => !sourceFilter || String(event.source || "").toLowerCase() === sourceFilter)
    .filter((event) => !query || `${event.type || ""} ${event.source || ""} ${event.label || ""} ${event.url || ""} ${event.path || ""}`.toLowerCase().includes(query))
    .filter((event) => !since || !event.timestamp || String(event.timestamp) >= since)
    .filter((event) => !until || !event.timestamp || String(event.timestamp) <= until);
  const sorted = filtered
    .sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")))
    .slice(-maxEvents);
  const byType = {};
  for (const event of sorted) byType[event.type] = (byType[event.type] || 0) + 1;
  return {
    schema: "agent-browser-runtime.evidence-timeline.v1",
    generatedAt: new Date().toISOString(),
    totalEventCount: events.length,
    filteredEventCount: filtered.length,
    eventCount: sorted.length,
    filters: {
      eventType: eventType || null,
      source: sourceFilter || null,
      query: query || null,
      since,
      until,
      maxEvents,
    },
    byType,
    events: sorted,
    boundaries: [
      "Timeline order is built from timestamps exposed by captured F12 evidence and local artifact mtimes.",
      "It is an objective navigation aid, not a vulnerability or causality judgement.",
      "Missing events mean they were not captured or not timestamped in the current evidence set.",
    ],
  };
}
