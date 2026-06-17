export const RECOMMENDED_ARTIFACT_KIND_ORDER = [
  "research-pack",
  "drilldown-plan",
  "har",
  "realtime",
  "application",
  "bundle",
  "manifest",
  "graph",
  "auth-boundary",
  "boundary",
  "trace",
];

const READABLE_RECOMMENDED_KINDS = new Set([
  "research-pack",
  "drilldown-plan",
  "har",
  "realtime",
  "application",
  "bundle",
  "manifest",
  "graph",
  "auth-boundary",
  "boundary",
]);

export function inferArtifactKind(file) {
  const value = String(file || "").replace(/\\/g, "/").toLowerCase();
  const ext = value.split(".").pop() || "";
  if (value.includes("har-completeness")) return "har-completeness";
  if (ext === "har" || value.includes("/har/")) return "har";
  if (value.includes("/traces/") || value.includes("chrome-trace") || value.includes("trace")) return "trace";
  if (value.includes("/screenshots/") || ["png", "jpg", "jpeg", "webp"].includes(ext)) return "screenshot";
  if (value.includes("/application/") || value.includes("application-export") || value.includes("application")) return "application";
  if (value.includes("/f12-navigation/") || value.includes("f12-navigation")) return "f12-navigation";
  if (value.includes("/drilldowns/") || value.includes("research-pack-drilldowns") || value.includes("drilldown")) return "drilldown-plan";
  if (value.includes("/research-packs/") || value.includes("security-research-pack") || value.includes("research-pack")) return "research-pack";
  if (value.includes("/bundles/") || value.includes("evidence-bundle") || value.includes("f12-evidence") || value.includes("bundle")) return "bundle";
  if (value.includes("/manifests/") || value.includes("manifest")) return "manifest";
  if (value.includes("/graphs/") || value.includes("graph")) return "graph";
  if (value.includes("/realtime/") || value.includes("realtime")) return "realtime";
  if (value.includes("/diffs/") || value.includes("diff")) return "diff";
  if (value.includes("/auth/") || value.includes("auth-boundary")) return "auth-boundary";
  if (value.includes("/boundaries/") || value.includes("worker-frame") || value.includes("boundary")) return "boundary";
  if (value.includes("/request-details/") || value.includes("request-detail")) return "request-detail";
  if (value.includes("/heap/") || ext === "heapsnapshot") return "heap";
  if (value.includes("/profiles/") || value.includes("cpu-profile")) return "cpu-profile";
  if (value.includes("/source-maps/") || value.includes("source-map") || value.includes("sources")) return "source-map";
  if (value.includes("/bodies/") || value.includes("body")) return "body";
  if (ext === "json") return "json";
  if (["txt", "log", "md", "html", "js", "mjs", "ts", "css", "csv", "xml", "yml", "yaml", "map"].includes(ext)) return "text";
  return "other";
}

export function buildArtifactIndex(files = [], params = {}) {
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

  const recommendedDrilldowns = RECOMMENDED_ARTIFACT_KIND_ORDER
    .filter((kind) => latestByKind[kind])
    .flatMap((kind) => {
      const artifact = latestByKind[kind];
      const drilldowns = [{
        label: `Latest ${kind} artifact`,
        tool: "browser_artifact_inspect",
        input: artifact.inspectInput,
        path: artifact.path,
      }];
      if (READABLE_RECOMMENDED_KINDS.has(kind)) {
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

