// register-deep-evidence.mjs — Debugger / sources / source-maps / traces / coverage / memory / token-scan family.
// Extracted verbatim from agent-cdp-server.mjs registerStandaloneBrowserTools (behavior-preserving).
// Dependencies are injected via deps; pure/lib helpers are imported directly.
// Two source spans straddle the research-pack/composite family (left in the closure); both move here
// as two tools.set runs. tokenFlowTracePageFunction is injected + stringified (H3). Three module-level
// pre-closure helpers (sourceMatches/buildSourceSearchDrilldowns/debuggerPausedSummary) are unexported
// and therefore injected via deps.
import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Never silently truncate source text returned to the agent.
// Content below this limit is inlined; above it is written to disk and a filePath is returned.
const TEXT_INLINE_THRESHOLD = 200_000;

// ── attack-harness subprocess proxy (same pattern as register-replay-attack.mjs) ──
const __filename_deep = fileURLToPath(import.meta.url);
const __dirname_deep = dirname(__filename_deep);
const PYTHON_DEEP = process.env.PYTHON_BIN || "python";
const AH_CWD_DEEP = process.env.ATTACK_HARNESS_CWD
  || join(__dirname_deep, "..", "..", "..", "helloworld", "attack-harness");

function attackHarnessDeep(pyCode, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_DEEP, ["-c", pyCode], {
      cwd: AH_CWD_DEEP,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    let out = "", err = "";
    proc.stdout.on("data", (d) => out += d.toString("utf-8"));
    proc.stderr.on("data", (d) => err += d.toString("utf-8"));
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`attack-harness timed out after ${timeoutMs}ms: ${err || out}`));
    }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        try {
          resolve(JSON.parse(out.trim() || "{}"));
        } catch (e) {
          resolve({ ok: true, _raw: out.trim(), _parse_note: String(e.message) });
        }
      } else {
        reject(new Error(err || out || `exit code ${code}`));
      }
    });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

import { toolResult } from "./result-format.mjs";
import { prettyPrintJavaScript } from "./pretty-print.mjs";
import { findSourceMatches } from "./source-search.mjs";
import {
  extractSourceMapReference,
  parseSourceMapMetadata,
  loadSourceMap,
  sourceMapOriginalEntries,
  selectSourceMapOriginalSource,
} from "./source-map.mjs";
import {
  summarizeTraceEvents,
  summarizePerformanceInsights,
  summarizePerformanceObserverSnapshot,
  extractTraceScreenshots,
  findLatestTracePath,
  findRecentTracePaths,
  compareTraceEvents,
  summarizeTraceQuery,
  summarizeCpuProfile,
} from "./trace-summaries.mjs";
import {
  rangeLength,
  summarizeCoverageRanges,
  coverageSnippet,
  coverageByteSummary,
} from "./coverage.mjs";
import { writeSourceMapOriginalSources, readSourceMapArtifact } from "./sourcemap-fs.mjs";
import { scanRecord } from "./evidence-summaries.mjs";

export function registerDeepEvidenceTools(deps) {
  const {
    tools,
    profileRegistry,
    resolveProfile,
    withManagedPageClient,
    sleep,
    tokenFlowTracePageFunction,
    sourceMatches,
    buildSourceSearchDrilldowns,
    debuggerPausedSummary,
    maybeRoutePersonal,
  } = deps;

  // Dep-injection guard: catch missing deps at registration time, not at first tool call.
  // These closured deps were historically omitted after carve-outs (commit 37f2159, 7dafc48).
  if (!tools) throw new Error("registerDeepEvidenceTools: deps.tools is required");
  if (!resolveProfile) throw new Error("registerDeepEvidenceTools: deps.resolveProfile is required");
  if (!withManagedPageClient) throw new Error("registerDeepEvidenceTools: deps.withManagedPageClient is required");
  if (!maybeRoutePersonal) throw new Error("registerDeepEvidenceTools: deps.maybeRoutePersonal is required");
  if (!sleep) throw new Error("registerDeepEvidenceTools: deps.sleep is required");
  if (!tokenFlowTracePageFunction) throw new Error("registerDeepEvidenceTools: deps.tokenFlowTracePageFunction is required");
  if (!sourceMatches) throw new Error("registerDeepEvidenceTools: deps.sourceMatches is required");
  if (!buildSourceSearchDrilldowns) throw new Error("registerDeepEvidenceTools: deps.buildSourceSearchDrilldowns is required");
  if (!debuggerPausedSummary) throw new Error("registerDeepEvidenceTools: deps.debuggerPausedSummary is required");

  tools.set("browser_cdp_command", {
    name: "browser_cdp_command",
    description: "Run a raw Chrome DevTools Protocol command against the profile tab for F12 features not yet wrapped as first-class tools.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        tabId: { type: "string", description: "CDP tab ID. Defaults to the profile's current tab." },
        method: { type: "string", description: "Required. Chrome DevTools Protocol method, e.g. 'Runtime.evaluate' or 'Network.enable'." },
        params: { type: "object", description: "CDP method parameters object. Omit or pass {} for methods with no params." },
      },
      required: ["method"],
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_cdp_command", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const method = String(params?.method || "").trim();
      if (!/^[A-Za-z0-9_.]+$/.test(method) || !method.includes(".")) {
        throw new Error("method must be a Chrome DevTools Protocol method like Runtime.evaluate");
      }
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        const result = await client.send(method, params?.params && typeof params.params === "object" ? params.params : {});
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          method,
          result,
        };
      }));
    },
  });

  tools.set("browser_debugger_control", {
    name: "browser_debugger_control",
    description: "Use core DevTools Debugger controls: pause/resume/step, breakpoint setup, XHR breakpoints, and paused call-frame/scope inspection.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        tabId: { type: "string", description: "CDP tab ID. Defaults to the profile's current tab." },
        action: {
          type: "string",
          enum: ["snapshot", "pause", "resume", "stepOver", "stepInto", "stepOut", "pauseOnExpression", "setBreakpointByUrl", "removeBreakpoint", "setXHRBreakpoint", "removeXHRBreakpoint", "probeBreakpointByUrl"],
          description: "Debugger action to perform. Default: snapshot (read paused state without changing it).",
        },
        url: { type: "string", description: "Script URL for setBreakpointByUrl / probeBreakpointByUrl." },
        urlRegex: { type: "string", description: "Regex pattern for setBreakpointByUrl instead of exact url." },
        lineNumber: { type: "number", description: "0-based line number for breakpoint actions." },
        columnNumber: { type: "number", description: "0-based column number for breakpoint actions." },
        condition: { type: "string", description: "Conditional expression for breakpoint; only pauses when truthy." },
        breakpointId: { type: "string", description: "Breakpoint ID for removeBreakpoint. Required for that action." },
        keepBreakpoint: { type: "boolean", description: "Keep the temporary breakpoint after probeBreakpointByUrl. Default: false (auto-remove)." },
        xhrUrlContains: { type: "string", description: "URL substring for setXHRBreakpoint / removeXHRBreakpoint." },
        expression: { type: "string", description: "JS expression for pauseOnExpression. Default: 'debugger;'." },
        triggerExpression: { type: "string", description: "JS expression evaluated after probeBreakpointByUrl to trigger the breakpoint." },
        reload: { type: "boolean", description: "Reload the page to trigger the breakpoint in probeBreakpointByUrl." },
        ignoreCache: { type: "boolean", description: "Bypass cache on reload. Default: false." },
        waitMs: { type: "number", description: "Wait time in ms after the action for breakpoint/pause events. Default: 8000." },
        autoResume: { type: "boolean", description: "Auto-resume after capturing paused state. Default: true for pause/step actions." },
        maxFrames: { type: "number", description: "Max call frames to include in paused summary." },
        maxScopes: { type: "number", description: "Max scope variables per frame." },
        maxProperties: { type: "number", description: "Max properties per scope object." },
        evaluateExpressions: { type: "array", items: { type: "string" }, description: "Expressions to evaluate in each paused frame." },
        maxEvaluateExpressions: { type: "number", description: "Max expressions to evaluate per frame." },
        maxEvaluateFrames: { type: "number", description: "Max frames to evaluate expressions in." },
        maxEvaluationValueChars: { type: "number", description: "Max characters for each evaluated value." },
        evaluateReturnByValue: { type: "boolean", description: "Return evaluated results by value. Default: true." },
        includeCommandLineAPI: { type: "boolean", description: "Include Command Line API in evaluation context." },
        throwOnSideEffect: { type: "boolean", description: "Fail evaluation if it has side effects." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_debugger_control", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const action = String(params?.action || "snapshot");
      const waitMs = Math.min(Math.max(typeof params?.waitMs === "number" ? params.waitMs : 1000, 50), 10000);
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        await client.Runtime.enable().catch(() => {});
        await client.Debugger.enable().catch(() => {});
        let pausedEvent = null;
        client.Debugger.paused((event) => {
          pausedEvent = event;
        });
        client.Debugger.resumed(() => {
          if (action !== "snapshot") pausedEvent = null;
        });

        let commandResult = null;
        let pendingCommand = null;
        let triggerResult = null;
        let cleanupResult = null;
        if (action === "setBreakpointByUrl") {
          commandResult = await client.Debugger.setBreakpointByUrl({
            lineNumber: Number(params?.lineNumber || 0),
            url: params?.url ? String(params.url) : undefined,
            urlRegex: params?.urlRegex ? String(params.urlRegex) : undefined,
            columnNumber: typeof params?.columnNumber === "number" ? params.columnNumber : 0,
            condition: params?.condition ? String(params.condition) : undefined,
          });
        } else if (action === "removeBreakpoint") {
          commandResult = await client.Debugger.removeBreakpoint({ breakpointId: String(params?.breakpointId || "") });
        } else if (action === "setXHRBreakpoint") {
          commandResult = await client.DOMDebugger.setXHRBreakpoint({ url: String(params?.xhrUrlContains || "") });
        } else if (action === "removeXHRBreakpoint") {
          commandResult = await client.DOMDebugger.removeXHRBreakpoint({ url: String(params?.xhrUrlContains || "") });
        } else if (action === "pause") {
          // H-05: send Debugger.pause CDP command with a timeout guard (command itself can hang on a static page),
          // then wait for the paused event (also with a timeout) — whichever times out first signals a static page.
          const pauseCmdMs = Math.min(waitMs, 5000);
          commandResult = await Promise.race([
            client.Debugger.pause().then((r) => r || {}),
            sleep(pauseCmdMs).then(() => ({ timedOut: true, note: "Debugger.pause command did not acknowledge" })),
          ]);
          const pauseEventDeadline = Math.min(waitMs, 5000);
          const pauseEventStart = Date.now();
          const gotPauseEvent = await Promise.race([
            (async () => {
              while (!pausedEvent && Date.now() - pauseEventStart < pauseEventDeadline) {
                await sleep(50);
              }
              return pausedEvent;
            })(),
            sleep(pauseEventDeadline).then(() => null),
          ]);
          if (!gotPauseEvent) {
            return {
              ok: true,
              profile: profile.name,
              evidenceDir: profile.evidenceDir,
              action: "pause",
              paused: false,
              reason: "timeout_no_pause_event",
              hint: "static page has no executing JS — Debugger.pause() never trips. Use browser_snapshot or browser_wait for static page state.",
              commandResult,
            };
          }
        } else if (action === "resume") {
          commandResult = await client.Debugger.resume().catch((error) => ({ error: String(error?.message || error) }));
        } else if (action === "stepOver") {
          commandResult = await client.Debugger.stepOver().catch((error) => ({ error: String(error?.message || error) }));
          await sleep(waitMs);
        } else if (action === "stepInto") {
          commandResult = await client.Debugger.stepInto().catch((error) => ({ error: String(error?.message || error) }));
          await sleep(waitMs);
        } else if (action === "stepOut") {
          commandResult = await client.Debugger.stepOut().catch((error) => ({ error: String(error?.message || error) }));
          await sleep(waitMs);
        } else if (action === "pauseOnExpression") {
          const expression = params?.expression ? String(params.expression) : "debugger;";
          pendingCommand = client.Runtime.evaluate({
            expression,
            awaitPromise: false,
            returnByValue: false,
          }).catch((error) => ({ error: String(error?.message || error) }));
          commandResult = { pending: true, reason: "Runtime.evaluate may remain pending while JavaScript is paused." };
          await sleep(waitMs);
        } else if (action === "probeBreakpointByUrl") {
          commandResult = await client.Debugger.setBreakpointByUrl({
            lineNumber: Number(params?.lineNumber || 0),
            url: params?.url ? String(params.url) : undefined,
            urlRegex: params?.urlRegex ? String(params.urlRegex) : undefined,
            columnNumber: typeof params?.columnNumber === "number" ? params.columnNumber : 0,
            condition: params?.condition ? String(params.condition) : undefined,
          });
          if (params?.reload) {
            await client.Page.enable().catch(() => {});
            pendingCommand = client.Page.reload({ ignoreCache: Boolean(params?.ignoreCache) }).catch((error) => ({ error: String(error?.message || error) }));
          } else if (params?.triggerExpression) {
            pendingCommand = client.Runtime.evaluate({
              expression: String(params.triggerExpression),
              awaitPromise: false,
              returnByValue: false,
            }).catch((error) => ({ error: String(error?.message || error) }));
          }
          await sleep(waitMs);
        } else if (action !== "snapshot") {
          throw new Error(`unsupported debugger action: ${action}`);
        }

        const paused = await debuggerPausedSummary(client, pausedEvent, params || {});
        const shouldResume = params?.autoResume !== false && ["pause", "pauseOnExpression", "stepOver", "stepInto", "stepOut", "probeBreakpointByUrl"].includes(action);
        let resumeResult = null;
        if (paused && shouldResume) {
          resumeResult = await client.Debugger.resume().catch((error) => ({ error: String(error?.message || error) }));
        }
        if (pendingCommand) {
          const settledPendingCommand = await Promise.race([
            pendingCommand,
            sleep(1000).then(() => ({ pending: true, reason: "Runtime.evaluate did not settle after resume timeout." })),
          ]);
          if (action === "probeBreakpointByUrl") {
            triggerResult = settledPendingCommand;
          } else {
            commandResult = settledPendingCommand;
          }
        }
        if (action === "probeBreakpointByUrl" && params?.keepBreakpoint !== true && commandResult?.breakpointId) {
          cleanupResult = await client.Debugger.removeBreakpoint({ breakpointId: commandResult.breakpointId })
            .catch((error) => ({ error: String(error?.message || error) }));
        }
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          action,
          commandResult,
          triggerResult,
          paused,
          autoResumed: Boolean(paused && shouldResume),
          resumeResult,
          cleanupResult,
          captureBoundaries: [
            "Breakpoint evidence is collected from the active Debugger session and current parsed scripts.",
            "probeBreakpointByUrl sets a temporary breakpoint, triggers reload or triggerExpression when supplied, captures paused frames/scopes, then removes the breakpoint unless keepBreakpoint=true.",
            "This tool reports objective debugger state and scope previews; it does not decide whether code behavior is vulnerable.",
          ],
          note: "Managed Browser uses a short-lived CDP session; use probeBreakpointByUrl or pauseOnExpression for capture-and-resume inspection, or raw CDP for specialized flows.",
        };
      }));
    },
  });

  tools.set("browser_token_flow_trace", {
    name: "browser_token_flow_trace",
    description: "Temporarily instrument fetch, XHR, local/session storage, and document.cookie to capture objective token-like data flow evidence during a trigger.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        tabId: { type: "string", description: "CDP tab ID. Defaults to the profile's current tab." },
        durationMs: { type: "number", description: "Observation window in ms. Default: 1000, max 10000." },
        maxEvents: { type: "number", description: "Max token-flow events to capture. Default: 100." },
        maxValueChars: { type: "number", description: "Max characters per captured value. Default: 4000." },
        includeValues: { type: "boolean", description: "Include actual token values in output. Default: true." },
        triggerExpression: { type: "string", description: "JS expression to evaluate to trigger token flow during observation." },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      // Ported to attack-harness Python — operates on captured traffic JSON, no CDP needed.
      // Collect recent captured traffic from profile's evidence store.
      const limit = typeof params?.maxEvents === "number" ? Math.min(Math.max(1, params.maxEvents), 10_000) : 500;
      const rows = profileRegistry.queryTraffic(profile.name, { limit });
      const safe = (v) => v != null ? JSON.stringify(v) : "None";
      const py = `
from attack_harness.diff import token_flow_trace
import json
r = token_flow_trace(
    captured_requests=${safe(rows)},
    target_token_pattern=${safe(params?.targetTokenPattern)},
    max_events=${safe(params?.maxEvents)},
    include_values=${safe(params?.includeValues)},
)
print(json.dumps(r, ensure_ascii=False))
`;
      const result = await attackHarnessDeep(py, 15000);
      return toolResult({ profile: profile.name, ...result });
    },
  });

  tools.set("browser_memory_snapshot", {
    name: "browser_memory_snapshot",
    description: "Return DevTools Memory/Performance Monitor-style counters: JS heap usage, DOM counters, and performance metrics.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        tabId: { type: "string", description: "CDP tab ID. Defaults to the profile's current tab." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_memory_snapshot", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        await client.Runtime.enable().catch(() => {});
        await client.Performance.enable().catch(() => {});
        const heap = await client.Runtime.getHeapUsage().catch((error) => ({ error: String(error?.message || error) }));
        const domCounters = await client.Memory.getDOMCounters().catch((error) => ({ error: String(error?.message || error) }));
        const metrics = await client.Performance.getMetrics().catch((error) => ({ error: String(error?.message || error), metrics: [] }));
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          timestamp: new Date().toISOString(),
          heap,
          domCounters,
          performanceMetrics: Array.isArray(metrics.metrics) ? metrics.metrics : [],
          performanceError: metrics.error,
        };
      }));
    },
  });

  tools.set("browser_heap_snapshot", {
    name: "browser_heap_snapshot",
    description: "Capture a DevTools Memory panel JavaScript heap snapshot through HeapProfiler and save the full .heapsnapshot evidence file.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        tabId: { type: "string", description: "CDP tab ID. Defaults to the profile's current tab." },
        reportProgress: { type: "boolean", description: "Emit HeapProfiler progress events during capture. Default: true." },
        exposeInternals: { type: "boolean", description: "Expose V8 internals in the snapshot. Default: false." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_heap_snapshot", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        await client.HeapProfiler.enable();
        const chunks = [];
        let chunkCount = 0;
        let totalBytes = 0;
        client.HeapProfiler.addHeapSnapshotChunk((event) => {
          const chunk = String(event.chunk || "");
          chunks.push(chunk);
          chunkCount += 1;
          totalBytes += Buffer.byteLength(chunk, "utf8");
        });
        const startedAt = new Date().toISOString();
        await client.HeapProfiler.takeHeapSnapshot({
          reportProgress: params?.reportProgress !== false,
          exposeInternals: Boolean(params?.exposeInternals),
        });
        const heapSnapshotText = chunks.join("");
        const snapshotPath = join(profile.evidenceDir, "heap", `${Date.now()}-heap.heapsnapshot`);
        mkdirSync(dirname(snapshotPath), { recursive: true });
        writeFileSync(snapshotPath, heapSnapshotText, "utf8");
        let meta = null;
        try {
          const parsed = JSON.parse(heapSnapshotText);
          meta = {
            nodeFieldCount: parsed.snapshot?.meta?.node_fields?.length || 0,
            edgeFieldCount: parsed.snapshot?.meta?.edge_fields?.length || 0,
            nodeCount: Array.isArray(parsed.nodes) && parsed.snapshot?.meta?.node_fields?.length
              ? Math.floor(parsed.nodes.length / parsed.snapshot.meta.node_fields.length)
              : null,
            edgeCount: Array.isArray(parsed.edges) && parsed.snapshot?.meta?.edge_fields?.length
              ? Math.floor(parsed.edges.length / parsed.snapshot.meta.edge_fields.length)
              : null,
            stringCount: Array.isArray(parsed.strings) ? parsed.strings.length : null,
          };
        } catch (error) {
          meta = { parseError: String(error?.message || error) };
        }
        await client.HeapProfiler.disable().catch(() => {});
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          backend: "managed-cdp",
          profile: profile.name,
          tabId: target.id,
          startedAt,
          finishedAt: new Date().toISOString(),
          heapSnapshotPath: snapshotPath,
          heapSnapshotBytes: totalBytes,
          chunkCount,
          meta,
        };
      }));
    },
  });

  tools.set("browser_sources_list", {
    name: "browser_sources_list",
    description: "Return Sources panel-style script metadata for the current profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        tabId: { type: "string", description: "CDP tab ID. Defaults to the profile's current tab." },
        urlContains: { type: "string", description: "Filter scripts whose URL contains this substring (case-insensitive)." },
        hasSourceMap: { type: "boolean", description: "Filter by source map presence (true = has map, false = no map)." },
        isModule: { type: "boolean", description: "Filter by ES module type." },
        limit: { type: "number", description: "Max scripts to return. Default: 200." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_sources_list", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const limit = typeof params?.limit === "number" ? Math.min(Math.max(1, params.limit), 10_000) : 200;
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        const scripts = new Map();
        await client.Debugger.enable();
        client.Debugger.scriptParsed((event) => {
          scripts.set(event.scriptId, {
            timestamp: new Date().toISOString(),
            scriptId: event.scriptId,
            url: event.url,
            startLine: event.startLine,
            startColumn: event.startColumn,
            endLine: event.endLine,
            endColumn: event.endColumn,
            executionContextId: event.executionContextId,
            hash: event.hash,
            executionContextAuxData: event.executionContextAuxData,
            isLiveEdit: event.isLiveEdit,
            sourceMapURL: event.sourceMapURL,
            hasSourceURL: event.hasSourceURL,
            isModule: event.isModule,
            length: event.length,
            stackTrace: event.stackTrace,
          });
        });
        await client.Page.enable();
        await client.Page.reload({ ignoreCache: false });
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 1200);
          client.Page.loadEventFired(() => {
            clearTimeout(timer);
            setTimeout(resolve, 300);
          });
        });
        let rows = [...scripts.values()];
        if (params?.urlContains) {
          const needle = String(params.urlContains).toLowerCase();
          rows = rows.filter((script) => String(script.url || "").toLowerCase().includes(needle));
        }
        if (typeof params?.hasSourceMap === "boolean") {
          rows = rows.filter((script) => Boolean(script.sourceMapURL) === params.hasSourceMap);
        }
        if (typeof params?.isModule === "boolean") {
          rows = rows.filter((script) => Boolean(script.isModule) === params.isModule);
        }
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return { profile: profile.name, tabId: target.id, count: rows.length, scripts: rows.slice(-limit) };
      }));
    },
  });

  tools.set("browser_source_get", {
    name: "browser_source_get",
    description: "Return JavaScript source for a scriptId in the current profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        tabId: { type: "string", description: "CDP tab ID. Defaults to the profile's current tab." },
        scriptId: { type: "string", description: "Required. CDP script ID from browser_sources_list." },
      },
      required: ["scriptId"],
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_source_get", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        await client.Debugger.enable();
        const scriptIdStr = String(params.scriptId);
        // H-13: validate scriptId before passing to CDP to avoid leaking raw protocol errors.
        let source;
        try {
          source = await client.Debugger.getScriptSource({ scriptId: scriptIdStr });
        } catch (_err) {
          await profileRegistry.touchProfile(profile.name, { tabId: target.id });
          return {
            ok: false,
            error: "script_not_found",
            scriptId: scriptIdStr,
            profile: profile.name,
            tabId: target.id,
            hint: "Use browser_sources_list to get valid scriptId values for the current page.",
          };
        }
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          scriptId: scriptIdStr,
          scriptSource: source.scriptSource,
          bytecode: source.bytecode,
          length: source.scriptSource ? String(source.scriptSource).length : 0,
        };
      }));
    },
  });

  tools.set("browser_source_pretty_print", {
    name: "browser_source_pretty_print",
    description: "Return a DevTools-style heuristic pretty-printed view of a parsed JavaScript source. When the pretty-printed source exceeds 200 000 characters the full content is saved to disk and the response includes filePath + originalLength — use the Read tool on filePath to get the complete source.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        tabId: { type: "string", description: "CDP tab ID. Defaults to the profile's current tab." },
        scriptId: { type: "string", description: "Select a specific script by CDP script ID; otherwise first match wins." },
        query: { type: "string", description: "Only return a script whose raw source contains this literal string." },
        urlContains: { type: "string", description: "Filter scripts by URL substring (case-insensitive)." },
        hasSourceMap: { type: "boolean", description: "Filter by source map presence." },
        isModule: { type: "boolean", description: "Filter by ES module type." },
        reload: { type: "boolean", description: "Reload page to capture fresh script list. Default: true." },
        ignoreCache: { type: "boolean", description: "Bypass cache on reload. Default: false." },
        waitMs: { type: "number", description: "Wait time in ms after reload for scripts to parse. Default: 8000." },
        maxScripts: { type: "number", description: "Max scripts to search through. Default: 120." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_source_pretty_print", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const waitMs = typeof params?.waitMs === "number" ? Math.min(Math.max(0, params.waitMs), 60_000) : 1200;
      const maxScripts = typeof params?.maxScripts === "number" ? Math.min(Math.max(1, params.maxScripts), 10_000) : 120;
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        const scripts = new Map();
        await client.Debugger.enable();
        client.Debugger.scriptParsed((event) => {
          scripts.set(event.scriptId, {
            timestamp: new Date().toISOString(),
            scriptId: event.scriptId,
            url: event.url,
            startLine: event.startLine,
            startColumn: event.startColumn,
            endLine: event.endLine,
            endColumn: event.endColumn,
            executionContextId: event.executionContextId,
            hash: event.hash,
            executionContextAuxData: event.executionContextAuxData,
            isLiveEdit: event.isLiveEdit,
            sourceMapURL: event.sourceMapURL,
            hasSourceURL: event.hasSourceURL,
            isModule: event.isModule,
            length: event.length,
            stackTrace: event.stackTrace,
          });
        });
        if (params?.reload !== false) {
          await client.Page.enable();
          await client.Page.reload({ ignoreCache: Boolean(params?.ignoreCache) });
          await sleep(waitMs);
        } else {
          await sleep(300);
        }
        const rows = [...scripts.values()]
          .filter((script) => !params?.scriptId || String(script.scriptId) === String(params.scriptId))
          .filter((script) => sourceMatches(script, params))
          .slice(-maxScripts);
        let selected = null;
        let selectedSource = "";
        let selectedError = null;
        for (const script of rows) {
          try {
            const source = await client.Debugger.getScriptSource({ scriptId: script.scriptId });
            const text = String(source?.scriptSource || "");
            if (params?.query && !text.includes(String(params.query))) continue;
            selected = script;
            selectedSource = text;
            break;
          } catch (err) {
            selectedError = String(err?.message || err);
          }
        }
        if (!selected) {
          throw new Error(selectedError || "no matching source found");
        }
        const pretty = prettyPrintJavaScript(selectedSource, params || {});
        const fullPrettyText = pretty.prettyText;
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });

        if (fullPrettyText.length <= TEXT_INLINE_THRESHOLD) {
          return {
            profile: profile.name,
            tabId: target.id,
            script: selected,
            mode: pretty.mode,
            originalBytes: pretty.originalBytes,
            prettyBytes: pretty.prettyBytes,
            prettyText: fullPrettyText,
          };
        }

        // Source exceeds inline threshold — save to disk, return filePath.
        const sourceDir = join(profile.evidenceDir, "source-dumps");
        mkdirSync(sourceDir, { recursive: true });
        const filePath = join(sourceDir, `browser_source_pretty_print-${Date.now()}.js`);
        writeFileSync(filePath, fullPrettyText, "utf8");
        const previewText = fullPrettyText.slice(0, 2000);
        return {
          profile: profile.name,
          tabId: target.id,
          script: selected,
          mode: pretty.mode,
          originalBytes: pretty.originalBytes,
          prettyBytes: pretty.prettyBytes,
          prettyText: `${previewText}...[truncated, see filePath]`,
          truncated: true,
          originalLength: fullPrettyText.length,
          filePath,
          next: [`browser_artifact_read {"path":"${filePath}"}`, `Read ${filePath}`],
        };
      }));
    },
  });

  tools.set("browser_source_map_metadata", {
    name: "browser_source_map_metadata",
    description: "Return sourceMappingURL and source map metadata for a parsed JavaScript source.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        tabId: { type: "string", description: "CDP tab ID. Defaults to the profile's current tab." },
        scriptId: { type: "string", description: "Select a specific script by CDP script ID." },
        query: { type: "string", description: "Only process scripts whose source contains this literal string." },
        urlContains: { type: "string", description: "Filter scripts by URL substring (case-insensitive)." },
        hasSourceMap: { type: "boolean", description: "Filter by source map presence." },
        isModule: { type: "boolean", description: "Filter by ES module type." },
        reload: { type: "boolean", description: "Reload page to capture fresh script list. Default: true." },
        ignoreCache: { type: "boolean", description: "Bypass cache on reload. Default: false." },
        waitMs: { type: "number", description: "Wait time in ms after reload. Default: 8000." },
        maxScripts: { type: "number", description: "Max scripts to process. Default: 120." },
        fetchMap: { type: "boolean", description: "Fetch external .map files over network. Default: false." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_source_map_metadata", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const waitMs = typeof params?.waitMs === "number" ? Math.min(Math.max(0, params.waitMs), 60_000) : 1200;
      const maxScripts = typeof params?.maxScripts === "number" ? Math.min(Math.max(1, params.maxScripts), 10_000) : 120;
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        const scripts = new Map();
        await client.Debugger.enable();
        client.Debugger.scriptParsed((event) => {
          scripts.set(event.scriptId, {
            timestamp: new Date().toISOString(),
            scriptId: event.scriptId,
            url: event.url,
            startLine: event.startLine,
            startColumn: event.startColumn,
            endLine: event.endLine,
            endColumn: event.endColumn,
            executionContextId: event.executionContextId,
            hash: event.hash,
            executionContextAuxData: event.executionContextAuxData,
            isLiveEdit: event.isLiveEdit,
            sourceMapURL: event.sourceMapURL,
            hasSourceURL: event.hasSourceURL,
            isModule: event.isModule,
            length: event.length,
            stackTrace: event.stackTrace,
          });
        });
        if (params?.reload !== false) {
          await client.Page.enable();
          await client.Page.reload({ ignoreCache: Boolean(params?.ignoreCache) });
          await sleep(waitMs);
        } else {
          await sleep(300);
        }
        const rows = [...scripts.values()]
          .filter((script) => !params?.scriptId || String(script.scriptId) === String(params.scriptId))
          .filter((script) => sourceMatches(script, params))
          .slice(-maxScripts);
        const results = [];
        let lastError = null;
        for (const script of rows) {
          try {
            const source = await client.Debugger.getScriptSource({ scriptId: script.scriptId });
            const text = String(source?.scriptSource || "");
            if (params?.query && !text.includes(String(params.query))) continue;
            const reference = script.sourceMapURL || extractSourceMapReference(text);
            const metadata = await parseSourceMapMetadata(reference, script.url, { fetchMap: Boolean(params?.fetchMap) });
            results.push({
              script,
              sourceMapURLFromDebugger: script.sourceMapURL || "",
              sourceMapURLFromComment: extractSourceMapReference(text),
              metadata,
            });
          } catch (err) {
            lastError = String(err?.message || err);
            results.push({ script, error: lastError });
          }
        }
        if (!results.length) {
          throw new Error(lastError || "no matching source found");
        }
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          count: results.length,
          results,
        };
      }));
    },
  });

  tools.set("browser_source_map_sources", {
    name: "browser_source_map_sources",
    description: "Extract original source files from source maps and save them as profile-scoped evidence artifacts.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        tabId: { type: "string", description: "CDP tab ID. Defaults to the profile's current tab." },
        scriptId: { type: "string", description: "Select a specific script by CDP script ID." },
        query: { type: "string", description: "Only process scripts whose source contains this literal string." },
        urlContains: { type: "string", description: "Filter scripts by URL substring (case-insensitive)." },
        hasSourceMap: { type: "boolean", description: "Filter by source map presence." },
        isModule: { type: "boolean", description: "Filter by ES module type." },
        reload: { type: "boolean", description: "Reload page to capture fresh script list. Default: true." },
        ignoreCache: { type: "boolean", description: "Bypass cache on reload. Default: false." },
        waitMs: { type: "number", description: "Wait time in ms after reload. Default: 8000." },
        maxScripts: { type: "number", description: "Max scripts to process. Default: 40." },
        maxSources: { type: "number", description: "Max original sources to extract per script." },
        maxContentChars: { type: "number", description: "Max characters of source content to embed inline." },
        fetchMap: { type: "boolean", description: "Fetch external .map files over network. Default: false." },
        save: { type: "boolean", description: "Save extracted sources to disk. Default: true." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_source_map_sources", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const waitMs = typeof params?.waitMs === "number" ? Math.min(Math.max(0, params.waitMs), 60_000) : 1200;
      const maxScripts = typeof params?.maxScripts === "number" ? Math.min(Math.max(1, params.maxScripts), 10_000) : 40;
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        const scripts = new Map();
        await client.Debugger.enable();
        client.Debugger.scriptParsed((event) => {
          scripts.set(event.scriptId, {
            timestamp: new Date().toISOString(),
            scriptId: event.scriptId,
            url: event.url,
            startLine: event.startLine,
            startColumn: event.startColumn,
            endLine: event.endLine,
            endColumn: event.endColumn,
            executionContextId: event.executionContextId,
            hash: event.hash,
            executionContextAuxData: event.executionContextAuxData,
            isLiveEdit: event.isLiveEdit,
            sourceMapURL: event.sourceMapURL,
            hasSourceURL: event.hasSourceURL,
            isModule: event.isModule,
            length: event.length,
            stackTrace: event.stackTrace,
          });
        });
        if (params?.reload !== false) {
          await client.Page.enable();
          await client.Page.reload({ ignoreCache: Boolean(params?.ignoreCache) });
          await sleep(waitMs);
        } else {
          await sleep(300);
        }
        const rows = [...scripts.values()]
          .filter((script) => !params?.scriptId || String(script.scriptId) === String(params.scriptId))
          .filter((script) => sourceMatches(script, params))
          .slice(-maxScripts);
        const results = [];
        let lastError = null;
        for (const script of rows) {
          try {
            const source = await client.Debugger.getScriptSource({ scriptId: script.scriptId });
            const text = String(source?.scriptSource || "");
            if (params?.query && !text.includes(String(params.query))) continue;
            const reference = script.sourceMapURL || extractSourceMapReference(text);
            const loaded = await loadSourceMap(reference, script.url, { fetchMap: Boolean(params?.fetchMap) });
            const entries = loaded.map ? sourceMapOriginalEntries(loaded.map, script, params || {}) : [];
            const saved = params?.save === false
              ? null
              : writeSourceMapOriginalSources(profile.evidenceDir, script, entries, loaded.metadata);
            results.push({
              script,
              sourceMapURLFromDebugger: script.sourceMapURL || "",
              sourceMapURLFromComment: extractSourceMapReference(text),
              metadata: loaded.metadata,
              sourceCount: entries.length,
              sourcesWithContent: entries.filter((entry) => entry.hasContent).length,
              sources: saved?.sources || entries.map(({ content: _content, contentText: _contentText, ...entry }) => entry),
              sourceRoot: saved?.sourceRoot || null,
              manifestPath: saved?.manifestPath || null,
            });
          } catch (err) {
            lastError = String(err?.message || err);
            results.push({ script, error: lastError });
          }
        }
        if (!results.length) {
          throw new Error(lastError || "no matching source found");
        }
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          evidenceDir: profile.evidenceDir,
          count: results.length,
          results,
          captureBoundaries: [
            "Only source maps referenced by parsed scripts can be extracted.",
            "sourcesContent is saved when present. External original sources are not fetched unless they are embedded in the source map.",
            "For external .map files, pass fetchMap=true so the runtime can retrieve and parse the map file.",
          ],
        };
      }));
    },
  });

  tools.set("browser_source_map_source_get", {
    name: "browser_source_map_source_get",
    description: "Read one saved original source file extracted from a source map, or extract and select one by script/source selector.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        tabId: { type: "string", description: "CDP tab ID. Defaults to the profile's current tab." },
        path: { type: "string", description: "Absolute path to a previously saved source-map artifact file; bypasses live CDP extraction." },
        scriptId: { type: "string", description: "Select source by CDP script ID." },
        query: { type: "string", description: "Only process scripts whose source contains this literal string." },
        urlContains: { type: "string", description: "Filter scripts by URL substring (case-insensitive)." },
        source: { type: "string", description: "Select a specific original source by name/path substring." },
        index: { type: "number", description: "Select a specific original source by 0-based index." },
        hasSourceMap: { type: "boolean", description: "Filter by source map presence." },
        isModule: { type: "boolean", description: "Filter by ES module type." },
        reload: { type: "boolean", description: "Reload page to capture fresh script list. Default: true." },
        ignoreCache: { type: "boolean", description: "Bypass cache on reload. Default: false." },
        waitMs: { type: "number", description: "Wait time in ms after reload. Default: 8000." },
        maxScripts: { type: "number", description: "Max scripts to process. Default: 40." },
        maxSources: { type: "number", description: "Max original sources per script." },
        maxChars: { type: "number", description: "Max characters of source content to return. Default: 120000." },
        fetchMap: { type: "boolean", description: "Fetch external .map files over network. Default: false." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_source_map_source_get", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const maxChars = typeof params?.maxChars === "number" ? Math.min(Math.max(1, params.maxChars), 10_000_000) : 120000;
      if (params?.path) {
        const artifact = readSourceMapArtifact(params.path, profile.evidenceDir, maxChars);
        return toolResult({
          profile: profile.name,
          evidenceDir: profile.evidenceDir,
          selectedBy: "path",
          source: {
            path: artifact.path,
            saved: true,
            bytes: artifact.bytes,
            sha256: artifact.sha256,
          },
          contentText: artifact.contentText,
          contentBytes: artifact.contentBytes,
          truncated: artifact.truncated,
          captureBoundaries: [
            "Reads only previously saved source-map evidence under the selected profile evidence directory.",
            "This tool returns source text and artifact provenance; it does not decide whether the source contains a vulnerability.",
          ],
        });
      }

      const waitMs = typeof params?.waitMs === "number" ? Math.min(Math.max(0, params.waitMs), 60_000) : 1200;
      const maxScripts = typeof params?.maxScripts === "number" ? Math.min(Math.max(1, params.maxScripts), 10_000) : 40;
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        const scripts = new Map();
        await client.Debugger.enable();
        client.Debugger.scriptParsed((event) => {
          scripts.set(event.scriptId, {
            timestamp: new Date().toISOString(),
            scriptId: event.scriptId,
            url: event.url,
            startLine: event.startLine,
            startColumn: event.startColumn,
            endLine: event.endLine,
            endColumn: event.endColumn,
            executionContextId: event.executionContextId,
            hash: event.hash,
            executionContextAuxData: event.executionContextAuxData,
            isLiveEdit: event.isLiveEdit,
            sourceMapURL: event.sourceMapURL,
            hasSourceURL: event.hasSourceURL,
            isModule: event.isModule,
            length: event.length,
            stackTrace: event.stackTrace,
          });
        });
        if (params?.reload !== false) {
          await client.Page.enable();
          await client.Page.reload({ ignoreCache: Boolean(params?.ignoreCache) });
          await sleep(waitMs);
        } else {
          await sleep(300);
        }
        const rows = [...scripts.values()]
          .filter((script) => !params?.scriptId || String(script.scriptId) === String(params.scriptId))
          .filter((script) => sourceMatches(script, params))
          .slice(-maxScripts);
        const results = [];
        let lastError = null;
        for (const script of rows) {
          try {
            const source = await client.Debugger.getScriptSource({ scriptId: script.scriptId });
            const text = String(source?.scriptSource || "");
            if (params?.query && !text.includes(String(params.query))) continue;
            const reference = script.sourceMapURL || extractSourceMapReference(text);
            const loaded = await loadSourceMap(reference, script.url, { fetchMap: Boolean(params?.fetchMap) });
            const entries = loaded.map ? sourceMapOriginalEntries(loaded.map, script, { ...params, maxContentChars: 0 }) : [];
            const saved = writeSourceMapOriginalSources(profile.evidenceDir, script, entries, loaded.metadata);
            results.push({
              script,
              sourceMapURLFromDebugger: script.sourceMapURL || "",
              sourceMapURLFromComment: extractSourceMapReference(text),
              metadata: loaded.metadata,
              sourceCount: entries.length,
              sourcesWithContent: entries.filter((entry) => entry.hasContent).length,
              sources: saved.sources,
              sourceRoot: saved.sourceRoot,
              manifestPath: saved.manifestPath,
            });
          } catch (err) {
            lastError = String(err?.message || err);
            results.push({ script, error: lastError });
          }
        }
        if (!results.length) {
          // H-13: return structured ok:false instead of throwing (which causes HTTP 500).
          await profileRegistry.touchProfile(profile.name, { tabId: target.id });
          return {
            ok: false,
            error: "no_sources_content",
            profile: profile.name,
            tabId: target.id,
            evidenceDir: profile.evidenceDir,
            hint: lastError || "No matching script/source map found. The script may not have a source map or the source map does not embed sourcesContent.",
          };
        }
        let selected, artifact;
        try {
          selected = selectSourceMapOriginalSource(results, params || {});
          artifact = readSourceMapArtifact(selected.source.path, profile.evidenceDir, maxChars);
        } catch (err) {
          // H-13: selectSourceMapOriginalSource or readSourceMapArtifact throws when
          // sourcesContent is absent. Return structured ok:false (HTTP 200) instead of 500.
          await profileRegistry.touchProfile(profile.name, { tabId: target.id });
          return {
            ok: false,
            error: "no_sources_content",
            profile: profile.name,
            tabId: target.id,
            evidenceDir: profile.evidenceDir,
            hint: String(err?.message || err),
            scripts: results.map((r) => ({ script: r.script, sourceMapURL: r.sourceMapURLFromDebugger, sourceCount: r.sourceCount, sourcesWithContent: r.sourcesWithContent })),
          };
        }
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          evidenceDir: profile.evidenceDir,
          selectedBy: params?.source ? "source" : typeof params?.index === "number" ? "index" : "first-saved-source",
          resultIndex: selected.resultIndex,
          script: selected.script,
          sourceRoot: selected.sourceRoot,
          manifestPath: selected.manifestPath,
          source: {
            ...selected.source,
            contentText: undefined,
            content: undefined,
            path: artifact.path,
            bytes: artifact.bytes,
            sha256: artifact.sha256,
          },
          contentText: artifact.contentText,
          contentBytes: artifact.contentBytes,
          truncated: artifact.truncated,
          captureBoundaries: [
            "Only source maps referenced by parsed scripts can be extracted.",
            "sourcesContent is saved when present. External original sources are not fetched unless they are embedded in the source map.",
            "This tool returns source text and artifact provenance; it does not decide whether the source contains a vulnerability.",
          ],
        };
      }));
    },
  });

  tools.set("browser_sources_search", {
    name: "browser_sources_search",
    description: "Search parsed script sources for a literal query and return line/column snippets.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        tabId: { type: "string", description: "CDP tab ID. Defaults to the profile's current tab." },
        query: { type: "string", description: "Required. Literal string to search for in parsed script sources." },
        urlContains: { type: "string", description: "Restrict search to scripts whose URL contains this substring (case-insensitive)." },
        hasSourceMap: { type: "boolean", description: "Filter by source map presence." },
        isModule: { type: "boolean", description: "Filter by ES module type." },
        caseSensitive: { type: "boolean", description: "Case-sensitive search. Default: false." },
        reload: { type: "boolean", description: "Reload page to capture fresh script list. Default: true." },
        ignoreCache: { type: "boolean", description: "Bypass cache on reload. Default: false." },
        waitMs: { type: "number", description: "Wait time in ms after reload. Default: 8000." },
        maxScripts: { type: "number", description: "Max scripts to search. Default: 120." },
        maxMatches: { type: "number", description: "Max total matches to return. Default: 50." },
        contextChars: { type: "number", description: "Characters of context around each match." },
      },
      required: ["query"],
    },
    async execute(_id, params) {
      if (!params?.query) throw new Error("query is required");
      const profile = await resolveProfile(params?.profile);
      // Ported to attack-harness Python — searches source files in evidence dir, no CDP needed.
      const safe = (v) => v != null ? JSON.stringify(v) : "None";
      const py = `
from attack_harness.diff import sources_search
import json
r = sources_search(
    sources_dir=${safe(profile.evidenceDir)},
    query=${safe(params.query)},
    ignore_case=${safe(!params?.caseSensitive)},
    max_files=${safe(params?.maxScripts)},
    max_matches=${safe(params?.maxMatches)},
    context_chars=${safe(params?.contextChars)},
)
print(json.dumps(r, ensure_ascii=False))
`;
      const result = await attackHarnessDeep(py, 30000);
      return toolResult({ profile: profile.name, ...result });
    },
  });

  tools.set("browser_performance_trace", {
    name: "browser_performance_trace",
    description: "Capture a short Performance panel-style snapshot for the current profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        tabId: { type: "string", description: "CDP tab ID. Defaults to the profile's current tab." },
        durationMs: { type: "number", description: "Observation window in ms. Default: 3000, max 15000." },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const routed = await maybeRoutePersonal("browser_performance_trace", params);
      if (routed) return toolResult(routed);
      const durationMs = Math.min(typeof params?.durationMs === "number" ? params.durationMs : 3000, 15000);
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        const result = await client.Runtime.evaluate({
          expression: `(async () => {
            const durationMs = ${JSON.stringify(durationMs)};
            const startedAt = new Date().toISOString();
            await new Promise((resolve) => setTimeout(resolve, durationMs));
            const navigation = performance.getEntriesByType("navigation").map((entry) => entry.toJSON?.() || entry);
            const resources = performance.getEntriesByType("resource").map((entry) => entry.toJSON?.() || entry);
            const marks = performance.getEntriesByType("mark").map((entry) => entry.toJSON?.() || entry);
            const measures = performance.getEntriesByType("measure").map((entry) => entry.toJSON?.() || entry);
            const paints = performance.getEntriesByType("paint").map((entry) => entry.toJSON?.() || entry);
            const longTasks = performance.getEntriesByType("longtask").map((entry) => entry.toJSON?.() || ({
              name: entry.name,
              startTime: entry.startTime,
              duration: entry.duration,
            }));
            return {
              startedAt,
              finishedAt: new Date().toISOString(),
              durationMs,
              timeOrigin: performance.timeOrigin,
              navigation,
              resources,
              paints,
              marks,
              measures,
              longTasks,
              resourceCount: resources.length,
              longTaskCount: longTasks.length,
            };
          })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return { profile: profile.name, tabId: target.id, page: result.result?.value, exception: result.exceptionDetails };
      }));
    },
  });

  tools.set("browser_chrome_trace", {
    name: "browser_chrome_trace",
    description: "Capture Chrome Tracing data for the current profile tab and write the full trace to evidence.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        tabId: { type: "string", description: "CDP tab ID. Defaults to the profile's current tab." },
        durationMs: { type: "number", description: "Capture duration in ms. Default: 1500, range 250–10000." },
        categories: { type: "array", items: { type: "string" }, description: "Tracing categories. Default: devtools.timeline, blink.user_timing, loading, netlog, screenshot." },
        maxEvents: { type: "number", description: "Max events to include in inline summary. Default: 200." },
        maxScreenshots: { type: "number", description: "Max screenshot frames to extract from the trace." },
        saveScreenshots: { type: "boolean", description: "Save screenshot frames to evidence. Default: true." },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const routed = await maybeRoutePersonal("browser_chrome_trace", params);
      if (routed) return toolResult(routed);
      const durationMs = Math.min(Math.max(typeof params?.durationMs === "number" ? params.durationMs : 1500, 250), 10000);
      const categories = Array.isArray(params?.categories) && params.categories.length
        ? params.categories.map(String)
        : [
            "devtools.timeline",
            "blink.user_timing",
            "loading",
            "netlog",
            "disabled-by-default-devtools.screenshot",
          ];
      const maxEvents = typeof params?.maxEvents === "number" ? Math.min(Math.max(1, params.maxEvents), 10_000) : 200;
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        const tracingComplete = new Promise((resolve) => {
          client.Tracing.tracingComplete((event) => resolve(event || {}));
        });
        await client.Tracing.start({
          categories: categories.join(","),
          transferMode: "ReturnAsStream",
        });
        const startedAt = new Date().toISOString();
        await sleep(durationMs);
        await client.Tracing.end();
        const complete = await Promise.race([
          tracingComplete,
          sleep(durationMs + 12000).then(() => {
            throw new Error("Tracing.tracingComplete timed out");
          }),
        ]);
        const chunks = [];
        if (complete.stream) {
          let eof = false;
          while (!eof) {
            const part = await client.IO.read({ handle: complete.stream });
            chunks.push(part.data || "");
            eof = Boolean(part.eof);
          }
          await client.IO.close({ handle: complete.stream }).catch(() => {});
        }
        const traceText = chunks.join("");
        let trace = null;
        let parseError = null;
        try {
          trace = traceText ? JSON.parse(traceText) : null;
        } catch (error) {
          parseError = String(error?.message || error);
        }
        const events = Array.isArray(trace?.traceEvents) ? trace.traceEvents : [];
        const tracePath = join(profile.evidenceDir, "traces", `${Date.now()}-chrome-trace.json`);
        mkdirSync(dirname(tracePath), { recursive: true });
        writeFileSync(tracePath, traceText, "utf8");
        const traceScreenshots = params?.saveScreenshots === false
          ? []
          : extractTraceScreenshots(events, join(profile.evidenceDir, "traces", "screenshots"), { maxScreenshots: params?.maxScreenshots });
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          startedAt,
          finishedAt: new Date().toISOString(),
          durationMs,
          categories,
          tracePath,
          traceTextBytes: traceText.length,
          traceEventCount: events.length,
          traceSummary: summarizeTraceEvents(events, maxEvents),
          traceScreenshotCount: traceScreenshots.length,
          traceScreenshots,
          traceEvents: events.slice(0, maxEvents),
          truncated: events.length > maxEvents,
          parseError,
        };
      }));
    },
  });

  tools.set("browser_trace_query", {
    name: "browser_trace_query",
    description: "Query a saved Chrome trace JSON file by event name, category, phase, duration, thread, or time range without loading the full trace into the agent context.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name used to locate the default trace path." },
        tracePath: { type: "string", description: "Absolute path to the trace JSON file. Defaults to the most recent trace for the profile." },
        query: { type: "string", description: "Filter events whose name or category contains this string." },
        name: { type: "string", description: "Filter events by exact name." },
        category: { type: "string", description: "Filter events by category substring." },
        phase: { type: "string", description: "Filter events by CDP trace phase code (e.g. 'B', 'E', 'X')." },
        processId: { type: "number", description: "Filter events by process ID." },
        threadId: { type: "number", description: "Filter events by thread ID." },
        minDurationMs: { type: "number", description: "Minimum event duration in ms (inclusive)." },
        maxDurationMs: { type: "number", description: "Maximum event duration in ms (inclusive)." },
        startTimeMs: { type: "number", description: "Start of time window in ms from trace origin." },
        endTimeMs: { type: "number", description: "End of time window in ms from trace origin." },
        sortBy: { type: "string", enum: ["duration", "timestamp", "name"], description: "Sort order for results. Values: duration, timestamp, name." },
        limit: { type: "number", description: "Max events to return." },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const tracePath = params?.tracePath || findLatestTracePath(join(profile.evidenceDir, "traces"));
      if (!tracePath) throw new Error("tracePath is required and no saved trace was found for this profile");
      const traceText = readFileSync(tracePath, "utf8");
      const trace = JSON.parse(traceText);
      const events = Array.isArray(trace?.traceEvents) ? trace.traceEvents : [];
      return toolResult({
        backend: "managed-cdp",
        profile: profile.name,
        tracePath,
        traceBytes: Buffer.byteLength(traceText, "utf8"),
        ...summarizeTraceQuery(events, params || {}),
      });
    },
  });

  tools.set("browser_trace_compare", {
    name: "browser_trace_compare",
    description: "Compare two saved Chrome trace JSON files and report objective differences in event names, categories, phases, threads, and duration buckets.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name used to find default trace paths when beforeTracePath/afterTracePath are omitted." },
        beforeTracePath: { type: "string", description: "Absolute path to the before-state Chrome trace JSON. Defaults to second-newest trace for the profile." },
        afterTracePath: { type: "string", description: "Absolute path to the after-state Chrome trace JSON. Defaults to newest trace for the profile." },
        limit: { type: "number", description: "Max diff entries to return per category." },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      let beforeTracePath = params?.beforeTracePath;
      let afterTracePath = params?.afterTracePath;
      if (!beforeTracePath || !afterTracePath) {
        const recent = findRecentTracePaths(join(profile.evidenceDir, "traces"), 2);
        afterTracePath = afterTracePath || recent[0];
        beforeTracePath = beforeTracePath || recent[1];
      }
      if (!beforeTracePath || !afterTracePath) {
        throw new Error("beforeTracePath and afterTracePath are required, or at least two saved traces must exist for this profile");
      }
      const beforeText = readFileSync(beforeTracePath, "utf8");
      const afterText = readFileSync(afterTracePath, "utf8");
      const beforeTrace = JSON.parse(beforeText);
      const afterTrace = JSON.parse(afterText);
      const beforeEvents = Array.isArray(beforeTrace?.traceEvents) ? beforeTrace.traceEvents : [];
      const afterEvents = Array.isArray(afterTrace?.traceEvents) ? afterTrace.traceEvents : [];
      return toolResult({
        backend: "managed-cdp",
        profile: profile.name,
        beforeTracePath,
        afterTracePath,
        beforeTraceBytes: Buffer.byteLength(beforeText, "utf8"),
        afterTraceBytes: Buffer.byteLength(afterText, "utf8"),
        ...compareTraceEvents(beforeEvents, afterEvents, params || {}),
      });
    },
  });

  tools.set("browser_performance_insights", {
    name: "browser_performance_insights",
    description: "Summarize Performance panel timing, slow resources, long tasks, and optional Chrome trace evidence for agents.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        tabId: { type: "string", description: "CDP tab ID. Defaults to the profile's current tab." },
        durationMs: { type: "number", description: "Observation window in ms. Default: 500." },
        includeChromeTrace: { type: "boolean", description: "Also capture a Chrome trace and include it in insights. Default: false." },
        maxItems: { type: "number", description: "Max items per insights category. Default: 10." },
        maxEvents: { type: "number", description: "Max Chrome trace events when includeChromeTrace=true. Default: 20." },
        maxScreenshots: { type: "number", description: "Max screenshot frames from Chrome trace." },
        saveScreenshots: { type: "boolean", description: "Save screenshot frames to evidence." },
      },
    },
    async execute(id, params) {
      const profile = await resolveProfile(params?.profile);
      const readPayload = (result) => JSON.parse(result.content?.[0]?.text || "{}");
      const base = {
        profile: profile.name,
        tabId: params?.tabId,
        durationMs: typeof params?.durationMs === "number" ? params.durationMs : 500,
      };
      const page = readPayload(await tools.get("browser_performance_trace").execute(id, base));
      let chromeTrace = null;
      if (params?.includeChromeTrace) {
        chromeTrace = readPayload(await tools.get("browser_chrome_trace").execute(id, {
          ...base,
          maxEvents: typeof params?.maxEvents === "number" ? params.maxEvents : typeof params?.maxItems === "number" ? params.maxItems : 20,
          maxScreenshots: params?.maxScreenshots,
          saveScreenshots: params?.saveScreenshots,
        }));
      }
      return toolResult({
        backend: "managed-cdp",
        profile: profile.name,
        tabId: page.tabId || params?.tabId || profile.tabId,
        insights: summarizePerformanceInsights(page, chromeTrace, params?.maxItems || 10),
      });
    },
  });

  tools.set("browser_performance_observer", {
    name: "browser_performance_observer",
    description: "Capture browser PerformanceObserver entries such as LCP, layout shift, long tasks, event timing, and long animation frames.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        tabId: { type: "string", description: "CDP tab ID. Defaults to the profile's current tab." },
        durationMs: { type: "number", description: "Observation window in ms. Default: 1000, range 100–15000." },
        entryTypes: { type: "array", items: { type: "string" }, description: "PerformanceObserver entry types to observe. Default: navigation, resource, paint, largest-contentful-paint, layout-shift, longtask, event, long-animation-frame." },
        triggerExpression: { type: "string", description: "JS expression to evaluate at observation start to trigger timed events." },
        maxEntries: { type: "number", description: "Max entries to capture. Default: 500." },
        maxItems: { type: "number", description: "Max items per category in the summary. Default: 10." },
        durationThreshold: { type: "number", description: "Min duration ms for event entries. Default: 16." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_performance_observer", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const options = {
        durationMs: Math.min(Math.max(typeof params?.durationMs === "number" ? params.durationMs : 1000, 100), 15000),
        entryTypes: Array.isArray(params?.entryTypes) && params.entryTypes.length
          ? params.entryTypes.map(String)
          : ["navigation", "resource", "paint", "largest-contentful-paint", "layout-shift", "longtask", "event", "long-animation-frame"],
        triggerExpression: params?.triggerExpression ? String(params.triggerExpression) : "",
        maxEntries: typeof params?.maxEntries === "number" ? Math.min(Math.max(1, params.maxEntries), 10_000) : 500,
        durationThreshold: typeof params?.durationThreshold === "number" ? params.durationThreshold : 16,
      };
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        const result = await client.Runtime.evaluate({
          expression: `(${async (options) => {
            const startedAt = new Date().toISOString();
            const supportedEntryTypes = typeof PerformanceObserver !== "undefined" && Array.isArray(PerformanceObserver.supportedEntryTypes)
              ? PerformanceObserver.supportedEntryTypes
              : [];
            const requestedEntryTypes = Array.isArray(options.entryTypes) ? options.entryTypes : [];
            const unsupportedEntryTypes = requestedEntryTypes.filter((type) => !supportedEntryTypes.includes(type));
            const observeErrors = [];
            const entries = [];
            const observers = [];
            const nodeLabel = (node) => node ? ({
              nodeName: node.nodeName,
              id: node.id || "",
              className: typeof node.className === "string" ? node.className : "",
            }) : null;
            const rectLabel = (rect) => rect ? {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              left: rect.left,
            } : null;
            const cleanEntry = (entry) => {
              const base = entry.toJSON?.() || {};
              const out = {
                ...base,
                name: entry.name,
                entryType: entry.entryType,
                startTime: entry.startTime,
                duration: entry.duration,
              };
              if (entry.entryType === "layout-shift") {
                out.value = entry.value;
                out.hadRecentInput = entry.hadRecentInput;
                out.lastInputTime = entry.lastInputTime;
                out.sources = Array.from(entry.sources || []).map((source) => ({
                  node: nodeLabel(source.node),
                  previousRect: rectLabel(source.previousRect),
                  currentRect: rectLabel(source.currentRect),
                }));
              }
              if (entry.entryType === "largest-contentful-paint") {
                out.renderTime = entry.renderTime;
                out.loadTime = entry.loadTime;
                out.size = entry.size;
                out.id = entry.id || "";
                out.url = entry.url || "";
                out.element = nodeLabel(entry.element);
              }
              if (entry.entryType === "long-animation-frame") {
                out.blockingDuration = entry.blockingDuration;
                out.renderStart = entry.renderStart;
                out.styleAndLayoutStart = entry.styleAndLayoutStart;
                out.scripts = Array.from(entry.scripts || []).slice(0, 20).map((script) => ({
                  name: script.name,
                  duration: script.duration,
                  invoker: script.invoker,
                  invokerType: script.invokerType,
                  sourceURL: script.sourceURL,
                  sourceFunctionName: script.sourceFunctionName,
                  sourceCharPosition: script.sourceCharPosition,
                  windowAttribution: script.windowAttribution,
                }));
              }
              return JSON.parse(JSON.stringify(out));
            };
            for (const type of requestedEntryTypes) {
              if (!supportedEntryTypes.includes(type)) continue;
              try {
                const observer = new PerformanceObserver((list) => {
                  for (const entry of list.getEntries()) {
                    if (entries.length < options.maxEntries) entries.push(cleanEntry(entry));
                  }
                });
                const init = { type, buffered: true };
                if (type === "event") init.durationThreshold = options.durationThreshold;
                observer.observe(init);
                observers.push(observer);
              } catch (error) {
                observeErrors.push({ type, error: String(error?.message || error) });
              }
            }
            let triggerResult = null;
            if (options.triggerExpression) {
              try {
                triggerResult = await eval(options.triggerExpression);
              } catch (error) {
                triggerResult = { error: String(error?.message || error) };
              }
            }
            await new Promise((resolve) => setTimeout(resolve, options.durationMs));
            for (const observer of observers) observer.disconnect();
            return {
              startedAt,
              finishedAt: new Date().toISOString(),
              durationMs: options.durationMs,
              requestedEntryTypes,
              supportedEntryTypes,
              unsupportedEntryTypes,
              observeErrors,
              triggerResult,
              entries,
            };
          }})(${JSON.stringify(options)})`,
          returnByValue: true,
          awaitPromise: true,
        });
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        const snapshot = result.result?.value || {};
        return {
          backend: "managed-cdp",
          profile: profile.name,
          tabId: target.id,
          snapshot,
          summary: summarizePerformanceObserverSnapshot(snapshot, params?.maxItems || 10),
          exception: result.exceptionDetails,
        };
      }));
    },
  });

  tools.set("browser_cpu_profile", {
    name: "browser_cpu_profile",
    description: "Capture a JavaScript CPU profile from the current profile tab and save the full DevTools profile to evidence.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        tabId: { type: "string", description: "CDP tab ID. Defaults to the profile's current tab." },
        durationMs: { type: "number", description: "CPU profiling duration in ms. Default: 1000, range 100–30000." },
        maxNodes: { type: "number", description: "Max top nodes to include in the summary. Default: 20." },
        triggerExpression: { type: "string", description: "JS expression to evaluate during profiling to trigger the code to measure." },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const durationMs = Math.min(Math.max(typeof params?.durationMs === "number" ? params.durationMs : 1000, 100), 30000);
      const routed = await maybeRoutePersonal("browser_cpu_profile", params);
      if (routed) return toolResult(routed);
      const maxNodes = typeof params?.maxNodes === "number" ? Math.min(Math.max(1, params.maxNodes), 10_000) : 20;
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        await client.Runtime.enable().catch(() => {});
        await client.Profiler.enable().catch(() => {});
        await client.Profiler.start();
        const startedAt = new Date().toISOString();
        let triggerResult = null;
        if (params?.triggerExpression) {
          triggerResult = await client.Runtime.evaluate({
            expression: String(params.triggerExpression),
            awaitPromise: true,
            returnByValue: true,
          }).catch((error) => ({ error: String(error?.message || error) }));
        }
        await sleep(durationMs);
        const stopped = await client.Profiler.stop();
        const cpuProfile = stopped.profile || {};
        const profilePath = join(profile.evidenceDir, "profiles", `${Date.now()}-cpu-profile.json`);
        mkdirSync(dirname(profilePath), { recursive: true });
        writeFileSync(profilePath, JSON.stringify(cpuProfile, null, 2), "utf8");
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          startedAt,
          finishedAt: new Date().toISOString(),
          durationMs,
          triggerResult,
          cpuProfilePath: profilePath,
          summary: summarizeCpuProfile(cpuProfile, maxNodes),
        };
      }));
    },
  });

  tools.set("browser_coverage_snapshot", {
    name: "browser_coverage_snapshot",
    description: "Capture short JavaScript precise coverage and CSS rule usage for the current profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        tabId: { type: "string", description: "CDP tab ID. Defaults to the profile's current tab." },
        durationMs: { type: "number", description: "Coverage window in ms. Default: 1000, range 250–10000." },
        maxEntries: { type: "number", description: "Max script/CSS rule entries in the summary. Default: 200." },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const routed = await maybeRoutePersonal("browser_coverage_snapshot", params);
      if (routed) return toolResult(routed);
      const durationMs = Math.min(Math.max(typeof params?.durationMs === "number" ? params.durationMs : 1000, 250), 10000);
      const maxEntries = typeof params?.maxEntries === "number" ? Math.min(Math.max(1, params.maxEntries), 10_000) : 200;
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        await client.DOM.enable().catch(() => {});
        await client.CSS.enable().catch(() => {});
        await client.Profiler.enable().catch(() => {});
        await client.Profiler.startPreciseCoverage({ callCount: true, detailed: true });
        await client.CSS.startRuleUsageTracking().catch(() => {});
        const startedAt = new Date().toISOString();
        await sleep(durationMs);
        const jsCoverage = await client.Profiler.takePreciseCoverage().catch((error) => ({ error: String(error?.message || error), result: [] }));
        await client.Profiler.stopPreciseCoverage().catch(() => {});
        const cssCoverage = await client.CSS.stopRuleUsageTracking().catch((error) => ({ error: String(error?.message || error), ruleUsage: [] }));
        const scripts = Array.isArray(jsCoverage.result) ? jsCoverage.result : [];
        const jsSummary = scripts.map((script) => {
          let usedRanges = 0;
          let unusedRanges = 0;
          let totalRanges = 0;
          for (const fn of script.functions || []) {
            for (const range of fn.ranges || []) {
              totalRanges += 1;
              if ((range.count || 0) > 0) usedRanges += 1;
              else unusedRanges += 1;
            }
          }
          return {
            scriptId: script.scriptId,
            url: script.url,
            functionCount: script.functions?.length || 0,
            totalRanges,
            usedRanges,
            unusedRanges,
          };
        });
        const rules = Array.isArray(cssCoverage.ruleUsage) ? cssCoverage.ruleUsage : [];
        const usedCssRules = rules.filter((rule) => rule.used).length;
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          startedAt,
          finishedAt: new Date().toISOString(),
          durationMs,
          js: {
            scriptCount: scripts.length,
            entries: jsSummary.slice(0, maxEntries),
            truncated: jsSummary.length > maxEntries,
            error: jsCoverage.error,
          },
          css: {
            ruleCount: rules.length,
            usedRuleCount: usedCssRules,
            unusedRuleCount: rules.length - usedCssRules,
            entries: rules.slice(0, maxEntries),
            truncated: rules.length > maxEntries,
            error: cssCoverage.error,
          },
        };
      }));
    },
  });

  tools.set("browser_coverage_detail", {
    name: "browser_coverage_detail",
    description: "Capture DevTools Coverage-panel drilldown data with raw JavaScript ranges, CSS rule usage, and bounded source snippets.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        tabId: { type: "string", description: "CDP tab ID. Defaults to the profile's current tab." },
        durationMs: { type: "number", description: "Coverage window in ms. Default: 1000, range 250–10000." },
        maxEntries: { type: "number", description: "Max script/CSS rule entries to return. Default: 50." },
        maxRangesPerEntry: { type: "number", description: "Max coverage ranges per script entry. Default: 20." },
        maxSnippetChars: { type: "number", description: "Max characters per source snippet. Default: 300." },
        includeSource: { type: "boolean", description: "Fetch and embed source text snippets. Default: true." },
        includeUnused: { type: "boolean", description: "Include unused ranges/rules. Default: true." },
        includeUsed: { type: "boolean", description: "Include used ranges/rules. Default: true." },
        urlContains: { type: "string", description: "Filter scripts by URL substring (case-insensitive)." },
        scriptId: { type: "string", description: "Filter to a specific CDP script ID." },
        styleSheetId: { type: "string", description: "Filter CSS to a specific style sheet ID." },
        reload: { type: "boolean", description: "Reload page before measuring coverage. Default: false." },
        ignoreCache: { type: "boolean", description: "Bypass cache on reload. Default: false." },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const durationMs = Math.min(Math.max(typeof params?.durationMs === "number" ? params.durationMs : 1000, 250), 10000);
      const maxEntries = typeof params?.maxEntries === "number" ? Math.min(Math.max(1, params.maxEntries), 10_000) : 50;
      const maxRangesPerEntry = typeof params?.maxRangesPerEntry === "number" ? Math.min(Math.max(1, params.maxRangesPerEntry), 1_000) : 20;
      const maxSnippetChars = typeof params?.maxSnippetChars === "number" ? Math.min(Math.max(1, params.maxSnippetChars), 1_000_000) : 300;
      const routed = await maybeRoutePersonal("browser_coverage_detail", params);
      if (routed) return toolResult(routed);
      const includeSource = params?.includeSource !== false;
      const includeUsed = params?.includeUsed !== false;
      const includeUnused = params?.includeUnused !== false;
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        await client.Page.enable().catch(() => {});
        await client.Debugger.enable().catch(() => {});
        await client.DOM.enable().catch(() => {});
        await client.CSS.enable().catch(() => {});
        await client.Profiler.enable().catch(() => {});
        await client.Profiler.startPreciseCoverage({ callCount: true, detailed: true });
        await client.CSS.startRuleUsageTracking().catch(() => {});
        const startedAt = new Date().toISOString();
        if (params?.reload) {
          await client.Page.reload({ ignoreCache: Boolean(params?.ignoreCache) }).catch(() => {});
        }
        await sleep(durationMs);
        const jsCoverage = await client.Profiler.takePreciseCoverage().catch((error) => ({ error: String(error?.message || error), result: [] }));
        await client.Profiler.stopPreciseCoverage().catch(() => {});
        const cssCoverage = await client.CSS.stopRuleUsageTracking().catch((error) => ({ error: String(error?.message || error), ruleUsage: [] }));
        const scriptEntries = [];
        const scripts = Array.isArray(jsCoverage.result) ? jsCoverage.result : [];
        for (const script of scripts) {
          if (params?.scriptId && String(script.scriptId) !== String(params.scriptId)) continue;
          if (params?.urlContains && !String(script.url || "").toLowerCase().includes(String(params.urlContains).toLowerCase())) continue;
          const allRanges = summarizeCoverageRanges(script.functions || [])
            .filter((range) => (range.used ? includeUsed : includeUnused));
          let sourceText = "";
          let sourceError = null;
          if (includeSource) {
            try {
              const source = await client.Debugger.getScriptSource({ scriptId: script.scriptId });
              sourceText = String(source?.scriptSource || "");
            } catch (err) {
              sourceError = String(err?.message || err);
            }
          }
          const byteSummary = coverageByteSummary(allRanges, sourceText ? sourceText.length : script.length);
          scriptEntries.push({
            scriptId: script.scriptId,
            url: script.url,
            functionCount: script.functions?.length || 0,
            rangeCount: allRanges.length,
            ...byteSummary,
            sourceError,
            ranges: allRanges.slice(0, maxRangesPerEntry).map((range) => ({
              ...range,
              ...(includeSource && sourceText ? { snippet: coverageSnippet(sourceText, range, maxSnippetChars) } : {}),
            })),
            rangesTruncated: allRanges.length > maxRangesPerEntry,
          });
          if (scriptEntries.length >= maxEntries) break;
        }

        const cssRules = [];
        const cssRaw = Array.isArray(cssCoverage.ruleUsage) ? cssCoverage.ruleUsage : [];
        const cssTextCache = new Map();
        for (const rule of cssRaw) {
          if (params?.styleSheetId && String(rule.styleSheetId) !== String(params.styleSheetId)) continue;
          const used = Boolean(rule.used);
          if (used && !includeUsed) continue;
          if (!used && !includeUnused) continue;
          let snippet = null;
          let sourceError = null;
          if (includeSource) {
            try {
              let text = cssTextCache.get(rule.styleSheetId);
              if (text === undefined) {
                const sheet = await client.CSS.getStyleSheetText({ styleSheetId: rule.styleSheetId });
                text = String(sheet?.text || "");
                cssTextCache.set(rule.styleSheetId, text);
              }
              snippet = coverageSnippet(text, rule, maxSnippetChars);
            } catch (err) {
              sourceError = String(err?.message || err);
            }
          }
          cssRules.push({
            styleSheetId: rule.styleSheetId,
            startOffset: rule.startOffset,
            endOffset: rule.endOffset,
            used,
            bytes: rangeLength(rule),
            sourceError,
            ...(snippet ? { snippet } : {}),
          });
          if (cssRules.length >= maxEntries) break;
        }
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          startedAt,
          finishedAt: new Date().toISOString(),
          durationMs,
          filters: {
            urlContains: params?.urlContains || null,
            scriptId: params?.scriptId || null,
            styleSheetId: params?.styleSheetId || null,
            includeUsed,
            includeUnused,
            includeSource,
          },
          js: {
            scriptCount: scripts.length,
            returnedCount: scriptEntries.length,
            entries: scriptEntries,
            truncated: scripts.length > scriptEntries.length && scriptEntries.length >= maxEntries,
            error: jsCoverage.error,
          },
          css: {
            ruleCount: cssRaw.length,
            returnedCount: cssRules.length,
            entries: cssRules,
            truncated: cssRaw.length > cssRules.length && cssRules.length >= maxEntries,
            error: cssCoverage.error,
          },
        };
      }));
    },
  });

  tools.set("browser_token_scan", {
    name: "browser_token_scan",
    description: "Scan managed browser Network, storage, and cookies for token-like material. Returns full values in authorized runtime mode.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        limit: { type: "number", description: "Max traffic records to scan. Default: 500." },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      // Ported to attack-harness Python — scans disk files, no CDP/browser needed.
      const safe = (v) => v != null ? JSON.stringify(v) : "None";
      const py = `
from attack_harness.diff import token_scan
import json
r = token_scan(
    traffic_dir=${safe(profile.evidenceDir)},
)
print(json.dumps(r, ensure_ascii=False))
`;
      return toolResult({ profile: profile.name, ...(await attackHarnessDeep(py, 60000)) });
    },
  });
}
