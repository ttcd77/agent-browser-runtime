import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";

const INTRUDER_SPEC_SCHEMA = "agent-browser.attack.intruder.spec.v1";
const INTRUDER_JOB_SCHEMA = "agent-browser.attack.intruder.job.v1";
const INTRUDER_SUMMARY_SCHEMA = "agent-browser.attack.intruder.summary.v1";
const INTRUDER_EVIDENCE_SCHEMA = "agent-browser.attack.intruder.evidence.v1";

const DEFAULT_BOUNDARIES = [
  "Attack jobs orchestrate existing ABR primitives and aggregate objective evidence.",
  "This P0.1 Intruder job only plans variants and writes artifacts; it does not send requests.",
  "Clusters and previews are objective planning evidence, not vulnerability findings.",
];
const DEFAULT_MAX_RUN_VARIANTS = 200;
const MAX_REPLAY_BATCH_SIZE = 50;

function isoNow(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function dateStamp(now = new Date()) {
  return isoNow(now).replace(/[-:]/g, "").replace(/\..+$/, "Z");
}

function safeIdPart(raw, fallback = "job") {
  const value = String(raw || fallback).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return value || fallback;
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function fileSummary(file) {
  if (!file || !existsSync(file)) return { path: file, exists: false };
  const stat = statSync(file);
  if (stat.isDirectory()) {
    return {
      path: file,
      exists: true,
      kind: "directory",
      modifiedAt: stat.mtime.toISOString(),
      sha256: null,
    };
  }
  return {
    path: file,
    exists: true,
    kind: "file",
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
  };
}

function requestBodyText(request = {}) {
  if (typeof request.postData === "string") return request.postData;
  if (typeof request.requestPostData === "string") return request.requestPostData;
  if (typeof request.bodyText === "string" && request.hasPostData) return request.bodyText;
  return "";
}

function sourceRequestSnapshot(request = {}, maxBodyPreview = 2000) {
  const body = requestBodyText(request);
  return {
    schema: "agent-browser.attack.intruder.source-request.v1",
    requestId: request.requestId || null,
    method: request.method || "GET",
    url: request.url || "",
    resourceType: request.resourceType || null,
    status: request.status ?? null,
    mimeType: request.mimeType || null,
    capturedAt: request.timestamp || request.wallTime || request.createdAt || null,
    requestHeaders: request.requestHeaders || {},
    responseHeaders: request.responseHeaders || {},
    hasPostData: Boolean(request.hasPostData || body),
    postDataLength: body ? body.length : (request.postDataLength ?? null),
    postDataPreview: body ? body.slice(0, maxBodyPreview) : null,
    bodyPreviewTruncated: body.length > maxBodyPreview,
    bodyPath: request.bodyPath || null,
    captureBoundaries: [
      "Source request snapshot is copied from profile-local captured F12 traffic.",
      "If postDataPreview is truncated or absent, Chrome did not expose a full body through this artifact.",
    ],
  };
}

function sourceSnapshotToRequest(snapshot = {}) {
  return {
    requestId: snapshot.requestId,
    method: snapshot.method || "GET",
    url: snapshot.url || "",
    requestHeaders: snapshot.requestHeaders || {},
    responseHeaders: snapshot.responseHeaders || {},
    hasPostData: snapshot.hasPostData,
    postData: snapshot.postDataPreview || "",
    postDataLength: snapshot.postDataLength,
    status: snapshot.status,
    bodyText: snapshot.bodyText || "",
  };
}

function normalizePayloadSets(payloadSets = []) {
  return payloadSets.map((set, index) => {
    const id = safeIdPart(set?.id || `payloads-${index + 1}`, `payloads-${index + 1}`);
    const values = Array.isArray(set?.values) ? set.values.map((value) => String(value)) : [];
    return {
      ...set,
      id,
      type: set?.type || "wordlist",
      values,
      count: values.length,
    };
  });
}

function normalizePositions(positions = []) {
  return positions.map((position, index) => ({
    ...position,
    id: safeIdPart(position?.id || `position-${index + 1}`, `position-${index + 1}`),
    location: String(position?.location || "url").toLowerCase(),
    replace: position?.replace === undefined ? "$PAYLOAD$" : String(position.replace),
  }));
}

function normalizeSpec(input = {}, fallback = {}) {
  const spec = {
    schema: input.schema || INTRUDER_SPEC_SCHEMA,
    profile: input.profile || fallback.profile,
    source: {
      ...(input.source || {}),
      requestId: input.source?.requestId || fallback.requestId,
    },
    transport: {
      engine: "browser-fetch-replay",
      batchSize: 50,
      credentials: "include",
      maxBodyPreview: 1000,
      ...(input.transport || {}),
    },
    positions: normalizePositions(input.positions || []),
    payloadSets: normalizePayloadSets(input.payloadSets || []),
    attackMode: input.attackMode || "sniper",
    matchers: Array.isArray(input.matchers) ? input.matchers : [],
    extractors: Array.isArray(input.extractors) ? input.extractors : [],
    baseline: input.baseline || { enabled: false },
    rateLimit: input.rateLimit || {},
    stopPolicy: input.stopPolicy || {},
    output: {
      saveEvery: 50,
      includeBodies: "preview",
      clusterBy: ["status", "bodyLengthBucket", "headerSignature", "extractorValues"],
      ...(input.output || {}),
    },
  };
  return spec;
}

function payloadSetForPosition(spec, positionIndex) {
  const position = spec.positions[positionIndex] || {};
  if (position.payloadSetId) {
    const matched = spec.payloadSets.find((set) => set.id === position.payloadSetId);
    if (matched) return matched;
  }
  return spec.payloadSets[positionIndex] || spec.payloadSets[0] || { id: "payloads", values: [], count: 0 };
}

function countPlannedVariants(spec) {
  if (spec.attackMode === "single") return 1;
  if (!spec.positions.length || !spec.payloadSets.length) return 0;
  if (spec.attackMode === "pitchfork") {
    return Math.min(...spec.positions.map((_, index) => payloadSetForPosition(spec, index).count));
  }
  if (spec.attackMode === "cluster_bomb") {
    return spec.positions.reduce((total, _position, index) => total * payloadSetForPosition(spec, index).count, 1);
  }
  return spec.positions.reduce((total, _position, index) => total + payloadSetForPosition(spec, index).count, 0);
}

const MAX_SELECTOR_PATTERN_LEN = 1000;

function compilePattern(pattern) {
  if (typeof pattern !== "string" || pattern.length > MAX_SELECTOR_PATTERN_LEN) {
    throw new Error(`selector pattern must be a string of ≤${MAX_SELECTOR_PATTERN_LEN} chars`);
  }
  return new RegExp(pattern);
}

function regexApplies(pattern, text) {
  try {
    return compilePattern(pattern).test(String(text || ""));
  } catch (_error) {
    return false;
  }
}

function jsonPathRead(jsonText, path) {
  if (!jsonText || !path || !String(path).startsWith("$.")) return { ok: false, reason: "unsupported-json-path" };
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, reason: "body-is-not-json" };
  }
  const parts = String(path).slice(2).split(".").filter(Boolean);
  let current = parsed;
  for (const part of parts) {
    if (!current || typeof current !== "object" || !(part in current)) return { ok: false, reason: "json-path-not-found" };
    current = current[part];
  }
  return { ok: true, value: current };
}

function validatePositionAgainstRequest(position, request) {
  const selector = position.selector || {};
  const body = requestBodyText(request);
  if (selector.type === "regex" || selector.pattern) {
    const target = position.location === "body" || position.location === "json" || position.location === "form"
      ? body
      : position.location === "headers" || position.location === "header"
        ? JSON.stringify(request.requestHeaders || {})
        : request.url || "";
    const ok = regexApplies(selector.pattern, target);
    return {
      id: position.id,
      ok,
      location: position.location,
      selectorType: "regex",
      reason: ok ? "matched" : "regex-not-found",
    };
  }
  if (position.location === "json" && selector.path) {
    const result = jsonPathRead(body, selector.path);
    return {
      id: position.id,
      ok: result.ok,
      location: position.location,
      selectorType: "jsonPath",
      reason: result.ok ? "matched" : result.reason,
    };
  }
  return {
    id: position.id,
    ok: false,
    location: position.location,
    selectorType: selector.type || null,
    reason: "unsupported-selector",
  };
}

function replaceFirstRegex(pattern, text, payload) {
  let regex;
  try {
    regex = compilePattern(pattern);
  } catch {
    return String(text || "");
  }
  return String(text || "").replace(regex, (...args) => {
    const match = String(args[0] || "");
    const captures = args.slice(1, -2).filter((value) => value !== undefined);
    return captures.length ? match.replace(String(captures[0]), String(payload)) : String(payload);
  });
}

function setJsonPath(jsonText, path, payload) {
  const parsed = JSON.parse(jsonText || "{}");
  const parts = String(path).slice(2).split(".").filter(Boolean);
  let current = parsed;
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = current[parts[index]];
  }
  current[parts[parts.length - 1]] = payload;
  return JSON.stringify(parsed);
}

function applyPositionToReplayVariant(request, position, payload) {
  const selector = position.selector || {};
  const variant = {
    label: `${position.id}=${payload}`,
    method: request.method || "GET",
    url: request.url || "",
  };
  const body = requestBodyText(request);
  if ((position.location === "url" || position.location === "query") && selector.pattern) {
    variant.url = replaceFirstRegex(selector.pattern, variant.url, payload);
  } else if (position.location === "json" && selector.path) {
    variant.body = setJsonPath(body, selector.path, payload);
  } else if ((position.location === "body" || position.location === "form") && selector.pattern) {
    variant.body = replaceFirstRegex(selector.pattern, body, payload);
  } else if ((position.location === "headers" || position.location === "header") && position.name) {
    variant.headers = { [position.name]: payload };
  }
  return variant;
}

function buildPreviewVariants(spec, request, maxPreview = 10) {
  const previews = [];
  const pushPreview = (bindings, replayVariant) => {
    if (previews.length >= maxPreview) return;
    const index = previews.length;
    previews.push({
      variantIndex: index,
      variantId: `v${String(index).padStart(6, "0")}`,
      label: replayVariant.label || Object.entries(bindings).map(([key, value]) => `${key}=${value}`).join(","),
      payloadBindings: bindings,
      replayVariant,
      dryRun: true,
    });
  };
  if (spec.attackMode === "single") {
    pushPreview({}, { label: "single-original", method: request.method || "GET", url: request.url || "" });
    return previews;
  }
  if (spec.attackMode === "pitchfork") {
    const count = countPlannedVariants(spec);
    for (let payloadIndex = 0; payloadIndex < count && previews.length < maxPreview; payloadIndex += 1) {
      const bindings = {};
      let replayVariant = { label: `pitchfork-${payloadIndex + 1}`, method: request.method || "GET", url: request.url || "" };
      spec.positions.forEach((position, positionIndex) => {
        const payload = payloadSetForPosition(spec, positionIndex).values[payloadIndex];
        bindings[position.id] = payload;
        replayVariant = { ...replayVariant, ...applyPositionToReplayVariant(request, position, payload) };
      });
      pushPreview(bindings, replayVariant);
    }
    return previews;
  }
  if (spec.attackMode === "cluster_bomb") {
    const recurse = (positionIndex, bindings, replayVariant) => {
      if (previews.length >= maxPreview) return;
      if (positionIndex >= spec.positions.length) {
        pushPreview(bindings, replayVariant);
        return;
      }
      const position = spec.positions[positionIndex];
      for (const payload of payloadSetForPosition(spec, positionIndex).values) {
        recurse(positionIndex + 1, { ...bindings, [position.id]: payload }, { ...replayVariant, ...applyPositionToReplayVariant(request, position, payload) });
      }
    };
    recurse(0, {}, { label: "cluster-bomb", method: request.method || "GET", url: request.url || "" });
    return previews;
  }
  spec.positions.forEach((position, positionIndex) => {
    for (const payload of payloadSetForPosition(spec, positionIndex).values) {
      if (previews.length >= maxPreview) return;
      pushPreview({ [position.id]: payload }, applyPositionToReplayVariant(request, position, payload));
    }
  });
  return previews;
}

function buildSniperVariantAt(spec, request, variantIndex) {
  if (spec.attackMode === "single") {
    return {
      variantIndex,
      variantId: `v${String(variantIndex).padStart(6, "0")}`,
      label: "single-original",
      payloadBindings: {},
      replayVariant: { label: "single-original", method: request.method || "GET", url: request.url || "" },
    };
  }
  if (spec.attackMode !== "sniper") throw new Error(`attack_intruder_run currently supports sniper mode only, not ${spec.attackMode}`);
  let offset = variantIndex;
  for (let positionIndex = 0; positionIndex < spec.positions.length; positionIndex += 1) {
    const position = spec.positions[positionIndex];
    const payloadSet = payloadSetForPosition(spec, positionIndex);
    if (offset >= payloadSet.values.length) {
      offset -= payloadSet.values.length;
      continue;
    }
    const payload = payloadSet.values[offset];
    const replayVariant = applyPositionToReplayVariant(request, position, payload);
    return {
      variantIndex,
      variantId: `v${String(variantIndex).padStart(6, "0")}`,
      label: replayVariant.label,
      payloadBindings: { [position.id]: payload },
      replayVariant,
    };
  }
  return null;
}

function buildVariantChunk(spec, request, startIndex, count) {
  const variants = [];
  for (let offset = 0; offset < count; offset += 1) {
    const planned = buildSniperVariantAt(spec, request, startIndex + offset);
    if (!planned) break;
    variants.push(planned);
  }
  return variants;
}

function responseHeaderSummary(headers = {}) {
  const entries = Object.entries(headers || {}).map(([name, value]) => [String(name).toLowerCase(), String(value)]);
  entries.sort(([left], [right]) => left.localeCompare(right));
  const signature = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  return {
    count: entries.length,
    names: entries.map(([name]) => name).slice(0, 25),
    signature: `sha256:${signature}`,
  };
}

function digestText(value) {
  if (typeof value !== "string") return null;
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function summarizeReplayResult(job, planned, batchRow) {
  const response = batchRow?.response || null;
  const replayRequest = batchRow?.replayRequest || planned.replayVariant;
  const exception = batchRow?.exception || null;
  return {
    schema: "agent-browser.attack.intruder.result.v1",
    jobId: job.jobId,
    variantIndex: planned.variantIndex,
    variantId: planned.variantId,
    label: planned.label,
    payloadBindings: planned.payloadBindings,
    replayRequest: {
      method: replayRequest?.method || planned.replayVariant.method || "GET",
      url: replayRequest?.url || planned.replayVariant.url || "",
      bodyKind: replayRequest?.bodyKind || (planned.replayVariant.body ? "text" : "none"),
      bodyLength: replayRequest?.bodyLength ?? (planned.replayVariant.body ? String(planned.replayVariant.body).length : 0),
      skippedHeaderNames: replayRequest?.skippedHeaderNames || [],
      credentials: replayRequest?.credentials || planned.replayVariant.credentials || "include",
    },
    response: response
      ? {
          status: response.status ?? null,
          statusText: response.statusText || null,
          url: response.url || null,
          ok: response.ok ?? null,
          redirected: response.redirected ?? null,
          bodyBytes: response.bodyBytes ?? (typeof response.bodyText === "string" ? response.bodyText.length : null),
          headers: responseHeaderSummary(response.headers || {}),
          bodyDigest: digestText(response.bodyText),
          bodyPreview: typeof response.bodyText === "string" ? response.bodyText.slice(0, job.spec?.output?.maxBodyPreview || 1000) : null,
        }
      : null,
    responseDiff: batchRow?.responseDiff || null,
    replayBoundary: batchRow?.replayBoundary || null,
    timing: {
      startedAt: response?.startedAt || null,
      finishedAt: response?.finishedAt || null,
      durationMs: response?.startedAt && response?.finishedAt ? Date.parse(response.finishedAt) - Date.parse(response.startedAt) : null,
    },
    exception,
    boundaries: [
      "Replay used browser-fetch batch replay, not raw socket replay.",
      "Result records objective response data only.",
    ],
  };
}

function validateSpec(spec, request) {
  const errors = [];
  const warnings = [];
  if (spec.schema !== INTRUDER_SPEC_SCHEMA) errors.push(`schema must be ${INTRUDER_SPEC_SCHEMA}`);
  if (!spec.profile) errors.push("profile is required");
  if (!spec.source?.requestId) errors.push("source.requestId is required");
  if (!request?.requestId) errors.push("source request snapshot is required");
  if (!["single", "sniper", "pitchfork", "cluster_bomb"].includes(spec.attackMode)) errors.push(`unsupported attackMode: ${spec.attackMode}`);
  if (spec.attackMode !== "single" && !spec.positions.length) errors.push("positions must contain at least one entry");
  if (spec.attackMode !== "single" && !spec.payloadSets.length) errors.push("payloadSets must contain at least one entry");
  for (const set of spec.payloadSets) {
    if (set.type !== "wordlist") warnings.push(`payload set ${set.id} type ${set.type} is planned but P0.1 only previews wordlist values`);
    if (!set.values.length) errors.push(`payload set ${set.id} has no values`);
  }
  const positionChecks = spec.positions.map((position) => validatePositionAgainstRequest(position, request));
  for (const check of positionChecks) {
    if (!check.ok) errors.push(`position ${check.id} cannot be applied: ${check.reason}`);
  }
  return { ok: errors.length === 0, errors, warnings, positionChecks };
}

export function createAttackIntruderJob({
  evidenceDir,
  profile,
  request,
  spec: rawSpec = {},
  requestId,
  now = new Date(),
  jobId,
  maxPreview = 10,
} = {}) {
  if (!evidenceDir) throw new Error("evidenceDir is required");
  const normalizedProfile = profile || rawSpec.profile;
  const spec = normalizeSpec(rawSpec, { profile: normalizedProfile, requestId });
  const validation = validateSpec(spec, request);
  if (!validation.ok) {
    return {
      schema: "agent-browser.attack.intruder.create.v1",
      ok: false,
      profile: normalizedProfile,
      validation,
      boundary: "Create validates the captured request and spec before writing a job.",
    };
  }

  const createdAt = isoNow(now);
  const id = safeIdPart(jobId || `intruder-${dateStamp(now)}-${randomBytes(4).toString("hex")}`, "intruder-job");
  const root = join(evidenceDir, "attack-jobs", id);
  const paths = {
    root,
    spec: join(root, "spec.json"),
    state: join(root, "state.json"),
    sourceRequest: join(root, "source-request.json"),
    results: join(root, "results.ndjson"),
    summary: join(root, "summary.json"),
    preview: join(root, "preview.json"),
    evidence: join(root, "evidence.json"),
  };
  const sourceRequest = sourceRequestSnapshot(request, spec.transport.maxBodyPreview || 2000);
  const plannedCount = countPlannedVariants(spec);
  const previewVariants = buildPreviewVariants(spec, request, maxPreview);
  const state = {
    schema: "agent-browser.attack.job-state.v1",
    jobId: id,
    kind: "intruder",
    state: "created",
    profile: spec.profile,
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    finishedAt: null,
    cursor: {
      nextVariantIndex: 0,
      generatedCount: plannedCount,
      sentCount: 0,
      failedCount: 0,
    },
    counts: {
      planned: plannedCount,
      previewed: previewVariants.length,
      sent: 0,
      failed: 0,
      matched: 0,
      clusters: 0,
    },
    lastError: null,
    paths,
    boundaries: DEFAULT_BOUNDARIES,
  };
  const summary = {
    schema: INTRUDER_SUMMARY_SCHEMA,
    jobId: id,
    state: "created",
    profile: spec.profile,
    counts: state.counts,
    sourceRequest: {
      requestId: sourceRequest.requestId,
      method: sourceRequest.method,
      url: sourceRequest.url,
      hasPostData: sourceRequest.hasPostData,
      postDataLength: sourceRequest.postDataLength,
    },
    plan: {
      attackMode: spec.attackMode,
      positionCount: spec.positions.length,
      payloadSetCount: spec.payloadSets.length,
      matcherCount: spec.matchers.length,
      extractorCount: spec.extractors.length,
      validation,
    },
    clusters: [],
    baseline: spec.baseline?.enabled ? { enabled: true, status: "not-run-in-p0.1" } : { enabled: false },
    artifactPaths: paths,
    boundaries: DEFAULT_BOUNDARIES,
  };

  mkdirSync(root, { recursive: true });
  writeJson(paths.spec, spec);
  writeJson(paths.state, state);
  writeJson(paths.sourceRequest, sourceRequest);
  writeFileSync(paths.results, "", "utf8");
  writeJson(paths.preview, {
    schema: "agent-browser.attack.intruder.preview.v1",
    jobId: id,
    plannedCount,
    returnedCount: previewVariants.length,
    maxPreview,
    variants: previewVariants,
    boundary: "Preview variants are dry-run replay inputs. They were not sent.",
  });
  writeJson(paths.summary, summary);

  return {
    schema: "agent-browser.attack.intruder.create.v1",
    ok: true,
    jobId: id,
    profile: spec.profile,
    state,
    summary,
    preview: previewVariants,
    nextTools: [
      "attack_intruder_status",
      "attack_intruder_results",
      "attack_intruder_evidence",
    ],
    boundary: "P0.1 created an Intruder planning job only; no request replay has run.",
  };
}

function resolveJobRoot({ evidenceDir, jobId, jobPath }) {
  if (jobPath) return resolve(jobPath);
  if (!evidenceDir) throw new Error("evidenceDir is required when jobPath is not provided");
  if (!jobId) throw new Error("jobId is required when jobPath is not provided");
  return join(evidenceDir, "attack-jobs", safeIdPart(jobId, "intruder-job"));
}

export function readAttackIntruderJob({ evidenceDir, jobId, jobPath } = {}) {
  const root = resolveJobRoot({ evidenceDir, jobId, jobPath });
  const statePath = join(root, "state.json");
  if (!existsSync(statePath)) throw new Error(`attack intruder job not found: ${root}`);
  const state = readJson(statePath);
  const spec = readJson(state.paths?.spec || join(root, "spec.json"));
  const summary = readJson(state.paths?.summary || join(root, "summary.json"));
  const preview = existsSync(state.paths?.preview || join(root, "preview.json"))
    ? readJson(state.paths?.preview || join(root, "preview.json"))
    : null;
  return {
    schema: INTRUDER_JOB_SCHEMA,
    ok: true,
    jobId: state.jobId,
    profile: state.profile,
    state,
    spec,
    summary,
    preview,
    boundary: "Job status is read from profile-local attack-job artifacts.",
  };
}

function readWritableAttackIntruderJob(input = {}) {
  const root = resolveJobRoot(input);
  const statePath = join(root, "state.json");
  if (!existsSync(statePath)) throw new Error(`attack intruder job not found: ${root}`);
  const state = readJson(statePath);
  const spec = readJson(state.paths?.spec || join(root, "spec.json"));
  const sourceRequest = readJson(state.paths?.sourceRequest || join(root, "source-request.json"));
  const summary = readJson(state.paths?.summary || join(root, "summary.json"));
  return {
    jobId: state.jobId,
    profile: state.profile,
    state,
    spec,
    sourceRequest,
    summary,
    paths: state.paths || {},
  };
}

function persistRunState(job, statePatch = {}, summaryPatch = {}) {
  const updatedAt = isoNow();
  const nextState = {
    ...job.state,
    ...statePatch,
    updatedAt,
    cursor: {
      ...(job.state.cursor || {}),
      ...(statePatch.cursor || {}),
    },
    counts: {
      ...(job.state.counts || {}),
      ...(statePatch.counts || {}),
    },
  };
  const nextSummary = {
    ...job.summary,
    ...summaryPatch,
    state: nextState.state,
    counts: nextState.counts,
    updatedAt,
  };
  writeJson(job.paths.state, nextState);
  writeJson(job.paths.summary, nextSummary);
  job.state = nextState;
  job.summary = nextSummary;
}

function failRun(job, error) {
  persistRunState(job, {
    state: "failed",
    finishedAt: isoNow(),
    lastError: {
      message: error?.message || String(error),
      name: error?.name || "Error",
    },
  });
}

function sleepMs(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function runAttackIntruderJob({
  evidenceDir,
  jobId,
  jobPath,
  replayBatch,
  maxVariants = DEFAULT_MAX_RUN_VARIANTS,
  batchSize,
  delayMs = 0,
  now = new Date(),
} = {}) {
  if (typeof replayBatch !== "function") throw new Error("replayBatch function is required");
  const job = readWritableAttackIntruderJob({ evidenceDir, jobId, jobPath });
  if (job.state.state === "completed") {
    return {
      schema: "agent-browser.attack.intruder.run.v1",
      ok: true,
      jobId: job.jobId,
      profile: job.profile,
      state: job.state,
      sentThisRun: 0,
      boundary: "Job was already completed; no replay was sent.",
    };
  }
  if (!["created", "paused", "running", "failed"].includes(job.state.state)) {
    throw new Error(`attack intruder job cannot run from state ${job.state.state}`);
  }
  if (!["sniper", "single"].includes(job.spec.attackMode)) {
    throw new Error(`attack_intruder_run currently supports sniper wordlist jobs only, not ${job.spec.attackMode}`);
  }
  for (const payloadSet of job.spec.payloadSets || []) {
    if (payloadSet.type !== "wordlist") throw new Error(`attack_intruder_run supports wordlist payload sets only, not ${payloadSet.type}`);
  }

  const planned = Number(job.state.cursor?.generatedCount ?? countPlannedVariants(job.spec));
  const startIndex = Number(job.state.cursor?.nextVariantIndex || 0);
  const remaining = Math.max(0, planned - startIndex);
  const allowed = Math.max(1, Number(maxVariants || DEFAULT_MAX_RUN_VARIANTS));
  if (remaining > allowed) {
    return {
      schema: "agent-browser.attack.intruder.run.v1",
      ok: false,
      jobId: job.jobId,
      profile: job.profile,
      state: job.state,
      plannedRemaining: remaining,
      maxVariants: allowed,
      boundary: "Run did not send requests because planned remaining variants exceed maxVariants. Pass an explicit maxVariants at least equal to plannedRemaining to confirm quantity.",
    };
  }

  const request = sourceSnapshotToRequest(job.sourceRequest);
  const effectiveBatchSize = Math.max(1, Math.min(MAX_REPLAY_BATCH_SIZE, Number(batchSize || job.spec.transport?.batchSize || MAX_REPLAY_BATCH_SIZE)));
  let nextVariantIndex = startIndex;
  let sentThisRun = 0;
  let failedThisRun = 0;
  const startedAt = job.state.startedAt || isoNow(now);
  persistRunState(job, {
    state: "running",
    startedAt,
    finishedAt: null,
    lastError: null,
  });

  try {
    while (nextVariantIndex < planned) {
      const latest = readJson(job.paths.state);
      if (latest.state === "paused" && sentThisRun > 0) {
        job.state = latest;
        break;
      }
      const chunk = buildVariantChunk(job.spec, request, nextVariantIndex, Math.min(effectiveBatchSize, planned - nextVariantIndex));
      if (!chunk.length) break;
      const replayResult = await replayBatch({
        profile: job.profile,
        requestId: job.spec.source?.requestId,
        variants: chunk.map((entry) => entry.replayVariant),
        maxVariants: chunk.length,
        maxBodyPreview: job.spec.output?.maxBodyPreview || job.spec.transport?.maxBodyPreview || 1000,
        credentials: job.spec.transport?.credentials || "include",
      });
      const rows = Array.isArray(replayResult?.results) ? replayResult.results : [];
      const batchRowsByIndex = new Map(rows.map((row, index) => [index, row]));
      let failedInChunk = 0;
      for (let index = 0; index < chunk.length; index += 1) {
        const plannedVariant = chunk[index];
        const row = summarizeReplayResult(job, plannedVariant, batchRowsByIndex.get(index) || { exception: { text: "missing batch replay row" } });
        appendFileSync(job.paths.results, `${JSON.stringify(row)}\n`, "utf8");
        if (row.exception) {
          failedThisRun += 1;
          failedInChunk += 1;
        }
      }
      const checkpoint = readJson(job.paths.state);
      if (checkpoint.state === "paused") job.state = checkpoint;
      sentThisRun += chunk.length;
      nextVariantIndex += chunk.length;
      persistRunState(job, {
        cursor: {
          nextVariantIndex,
          generatedCount: planned,
          sentCount: Number(job.state.cursor?.sentCount || 0) + chunk.length,
          failedCount: Number(job.state.cursor?.failedCount || 0) + failedInChunk,
        },
        counts: {
          planned,
          previewed: job.state.counts?.previewed || 0,
          sent: Number(job.state.counts?.sent || 0) + chunk.length,
          failed: Number(job.state.counts?.failed || 0) + failedInChunk,
          matched: job.state.counts?.matched || 0,
          clusters: job.state.counts?.clusters || 0,
        },
      });
      const afterBatch = readJson(job.paths.state);
      if (afterBatch.state === "paused") {
        job.state = afterBatch;
        break;
      }
      if (delayMs > 0 && nextVariantIndex < planned) await sleepMs(delayMs);
    }
    const completed = nextVariantIndex >= planned;
    const currentState = readJson(job.paths.state);
    if (completed) {
      job.state = currentState;
      persistRunState(job, {
        state: "completed",
        finishedAt: isoNow(),
        cursor: { nextVariantIndex, generatedCount: planned },
      });
    } else if (currentState.state !== "paused") {
      job.state = currentState;
      persistRunState(job, { state: "paused" });
    }
    return {
      schema: "agent-browser.attack.intruder.run.v1",
      ok: true,
      jobId: job.jobId,
      profile: job.profile,
      state: readJson(job.paths.state),
      sentThisRun,
      failedThisRun,
      nextVariantIndex,
      replayPrimitive: "profile_request_replay_batch",
      boundary: "Run sent planned variants through the injected profile_request_replay_batch primitive in chunks of at most 50.",
    };
  } catch (error) {
    failRun(job, error);
    throw error;
  }
}

export function pauseAttackIntruderJob({ evidenceDir, jobId, jobPath } = {}) {
  const job = readWritableAttackIntruderJob({ evidenceDir, jobId, jobPath });
  if (job.state.state === "completed") {
    return {
      schema: "agent-browser.attack.intruder.pause.v1",
      ok: true,
      jobId: job.jobId,
      profile: job.profile,
      state: job.state,
      boundary: "Completed job was not changed.",
    };
  }
  persistRunState(job, { state: "paused" });
  return {
    schema: "agent-browser.attack.intruder.pause.v1",
    ok: true,
    jobId: job.jobId,
    profile: job.profile,
    state: job.state,
    boundary: "Pause is checkpointed in state.json. A running job stops after the current batch boundary.",
  };
}

export async function resumeAttackIntruderJob(input = {}) {
  return runAttackIntruderJob(input);
}

export function buildAttackIntruderResults({ evidenceDir, jobId, jobPath, limit = 50 } = {}) {
  const job = readAttackIntruderJob({ evidenceDir, jobId, jobPath });
  const resultsPath = job.state.paths?.results;
  const rows = existsSync(resultsPath)
    ? readFileSync(resultsPath, "utf8").split(/\r?\n/).filter(Boolean).slice(0, limit).map((line) => JSON.parse(line))
    : [];
  return {
    schema: "agent-browser.attack.intruder.results.v1",
    ok: true,
    jobId: job.jobId,
    profile: job.profile,
    state: job.state.state,
    summary: job.summary,
    resultCount: rows.length,
    results: rows,
    preview: job.preview,
    boundary: rows.length
      ? "Results are objective replay rows written by later Intruder execution milestones."
      : "P0.1 has no replay rows; use preview.variants to inspect planned dry-run inputs.",
  };
}

export function buildAttackIntruderEvidence({ evidenceDir, jobId, jobPath } = {}) {
  const job = readAttackIntruderJob({ evidenceDir, jobId, jobPath });
  const artifacts = Object.fromEntries(Object.entries(job.state.paths || {}).map(([name, file]) => [name, fileSummary(file)]));
  const hasReplayRows = artifacts.results?.bytes > 0;
  const evidence = {
    schema: INTRUDER_EVIDENCE_SCHEMA,
    ok: true,
    generatedAt: isoNow(),
    jobId: job.jobId,
    profile: job.profile,
    state: job.state,
    summary: job.summary,
    preview: job.preview,
    artifacts,
    boundaries: [
      ...DEFAULT_BOUNDARIES,
      hasReplayRows
        ? "This evidence bundle is profile-local. Replay rows are included through the results artifact written by attack_intruder_run or attack_intruder_resume."
        : "This evidence bundle is profile-local and does not include live replay evidence until P0.2+.",
    ],
  };
  const evidencePath = job.state.paths?.evidence;
  if (evidencePath) writeJson(evidencePath, evidence);
  return {
    ...evidence,
    evidencePath,
  };
}
