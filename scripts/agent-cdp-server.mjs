import { appendFileSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, execFile } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import CDP from "chrome-remote-interface";
import { validateParams } from "./lib/schema-validate.mjs";
import { createFeedbackNote, listFeedbackNotes } from "./lib/feedback-notes.mjs";
import { rawSocketRequest, rawRaceRequest } from "./lib/raw-request.mjs";
import { forgeJwt } from "./lib/jwt-forge.mjs";
import { oobAlloc, oobPoll } from "./lib/oob-client.mjs";
import { ManagedPlaywrightDriver, hideChromeWindow } from "./lib/managed-playwright-driver.mjs";
import {
  buildAttackIntruderEvidence,
  buildAttackIntruderResults,
  createAttackIntruderJob,
  pauseAttackIntruderJob,
  readAttackIntruderJob,
  resumeAttackIntruderJob,
  runAttackIntruderJob,
} from "./lib/attack-intruder.mjs";
import { findSourceMatches } from "./lib/source-search.mjs";
import { buildInitiatorSummary } from "./lib/initiator-summary.mjs";
import { registerRealtimeHarTools } from "./lib/register-realtime-har.mjs";
import { registerEvidenceConsoleTools } from "./lib/register-evidence-console.mjs";
import { registerEvidenceCaptureTools } from "./lib/register-evidence-capture.mjs";
import { registerApplicationStorageTools } from "./lib/register-application-storage.mjs";
import { registerPageHealthTools } from "./lib/register-page-health.mjs";
import { registerSnapshotDomTools } from "./lib/register-snapshot-dom.mjs";
import { registerInteractionTools } from "./lib/register-interaction.mjs";
import { registerDeepEvidenceTools } from "./lib/register-deep-evidence.mjs";
import { registerCapabilityFacadeTools } from "./lib/register-capability-facades.mjs";
import { registerUnifiedFacades } from "./lib/register-unified-facades.mjs";
import {
  workspaceDir,
  recordToolUsage,
  getToolUsage,
  rankTools,
  loadAgentHelpers,
  writeAgentHelpers,
  readAgentHelpersSource,
  listDomainSkills,
  readDomainSkill,
  writeDomainSkill,
  listDomainSkillHosts,
  workspaceStatus,
} from "./lib/agent-workspace.mjs";
import { truncateText } from "./lib/text-utils.mjs";
import { prettyPrintJavaScript } from "./lib/pretty-print.mjs";
import {
  extractSourceMapReference,
  sourceMapSummary,
  decodeDataUrlText,
  parseSourceMapMetadata,
  loadSourceMap,
  sourceMapOriginalEntries,
  selectSourceMapOriginalSource,
} from "./lib/source-map.mjs";
import {
  buildNetworkF12Columns,
  timingPhase,
  buildNetworkTimeline,
  parseCookieHeader,
  lowerHeaderMap,
  buildInitiatorSourceContext,
  buildRequestF12Sections,
  sourceContextLines,
} from "./lib/f12-view.mjs";
import {
  classifyTraceEvent,
  addTraceBucket,
  summarizeRenderingTimeline,
  summarizeLayoutPaintFlameChart,
  summarizeTraceEvents,
  summarizePerformanceInsights,
  summarizePerformanceObserverSnapshot,
  extractTraceScreenshots,
  findLatestTracePath,
  findRecentTracePaths,
  traceProfile,
  diffMap,
  compareTraceEvents,
  summarizeTraceQuery,
  summarizeCpuProfile,
} from "./lib/trace-summaries.mjs";
import {
  prepareReplayHeaders,
  headerHas,
  setHeaderIfMissing,
  buildReplayBody,
  buildReplayBoundaryEvidence,
  headerMapLower,
  diffReplayResponse,
} from "./lib/replay-http.mjs";
import {
  rangeLength,
  summarizeCoverageRanges,
  coverageSnippet,
  coverageByteSummary,
} from "./lib/coverage.mjs";
import {
  devtoolsToolCategory,
  devtoolsToolCatalogFromEntries,
  devtoolsCapabilityMapFromEntries,
  devtoolsF12ParityMatrix,
  devtoolsWorkflowGuide,
  browserProductCapabilities,
} from "./lib/capability-catalog.mjs";
import {
  safeArtifactName,
  writeSourceMapOriginalSources,
  pathInsideRoot,
  readSourceMapArtifact,
} from "./lib/sourcemap-fs.mjs";
import {
  normalizePathForCompare,
  domSearchAttributes,
  domSearchNodeSummary,
  normalizeForcedPseudoClasses,
  frameIndexesFromOptions,
  debuggerRemoteObjectSummary,
} from "./lib/dom-debug-utils.mjs";
import {
  buildRequestCorrelationGraph,
  flattenFrameTree,
  summarizeNetworkRecords,
  groupCount,
  capturePageKey,
  buildCaptureBisect,
} from "./lib/network-summary.mjs";
import {
  buildRequestDetail,
  summarizeEvidenceCompleteness,
  buildAgentInspectToolPlan,
  professionalAppsecWorkflowSummary,
  buildProfessionalReadiness,
} from "./lib/inspect-readiness.mjs";
import {
  buildResearchPackHandoffCompleteness,
  buildResearchPackArtifactCoverage,
  buildResearchPackDrilldowns,
  buildResearchPackF12Navigation,
  summarizeF12RequestDetail,
} from "./lib/research-pack.mjs";

const root = process.cwd();
const DIRECT_CDP_CORE_DOMAINS = [
  "Accessibility",
  "Audits",
  "Browser",
  "CacheStorage",
  "Console",
  "CSS",
  "Database",
  "Debugger",
  "DOM",
  "DOMDebugger",
  "DOMSnapshot",
  "Emulation",
  "Fetch",
  "HeapProfiler",
  "IO",
  "Input",
  "Inspector",
  "Log",
  "Memory",
  "Network",
  "Overlay",
  "Page",
  "Performance",
  "Profiler",
  "Runtime",
  "Security",
  "ServiceWorker",
  "Storage",
  "SystemInfo",
  "Target",
  "Tracing",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

async function humanDelay(minMs = 12, maxMs = 55) {
  await sleep(Math.round(randomBetween(minMs, maxMs)));
}

function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function browserExecutable() {
  if (process.env.CDP_BROWSER_EXECUTABLE) return process.env.CDP_BROWSER_EXECUTABLE;
  // CDP_BROWSER_USE_CLOAK=1 opts into launching CloakBrowser (patched Chromium
  // with fingerprint randomisation) instead of the real Chrome/Edge executable.
  // This controls the browser executable only — the interaction engine is always
  // ManagedPlaywrightDriver regardless (E3.4). Default (no env var) launches real
  // Chrome, which passes most anti-bot checks and retains full CDP capability.
  if (process.env.CDP_BROWSER_USE_CLOAK === "1") {
    const cloakExecutable = cloakBrowserExecutable();
    if (cloakExecutable) return cloakExecutable;
  }
  // Chrome first — matches user's daily browser on most machines + clean Playwright
  // story. Edge is fallback when Chrome isn't installed. Pre-this-commit the order
  // was Edge → Chrome, which on Windows meant any default install (Edge always
  // present) attached/launched Edge even when the user's daily browser was Chrome.
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/microsoft-edge",
            "/usr/bin/microsoft-edge-stable",
          ];
  return candidates.find((candidate) => existsSync(candidate));
}

function cloakBrowserExecutable() {
  if (process.env.CLOAK_BROWSER_EXECUTABLE) return existsSync(process.env.CLOAK_BROWSER_EXECUTABLE) ? process.env.CLOAK_BROWSER_EXECUTABLE : null;
  if (process.env.CLOAKBROWSER_BINARY_PATH) return existsSync(process.env.CLOAKBROWSER_BINARY_PATH) ? process.env.CLOAKBROWSER_BINARY_PATH : null;
  const cacheDir = join(homedir(), ".cloakbrowser");
  if (!existsSync(cacheDir)) return null;
  try {
    const candidates = readdirSync(cacheDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(cacheDir, entry.name, process.platform === "win32" ? "chrome.exe" : "chrome"))
      .filter((candidate) => existsSync(candidate))
      .sort((a, b) => {
        try {
          return statSync(b).mtimeMs - statSync(a).mtimeMs;
        } catch {
          return 0;
        }
      });
    return candidates[0] || null;
  } catch {
    return null;
  }
}

import {
  buildBrowserRuntimeIdentity,
  parseBrowserExtraArgs,
} from "./lib/browser-identity.mjs";

async function waitForCdp(port) {
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`browser CDP endpoint needs a concrete port, got: ${port}`);
  }
  const url = `http://127.0.0.1:${port}/json/version`;
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // keep waiting
    }
    await sleep(250);
  }
  throw new Error(`browser CDP endpoint is not available: ${url}`);
}

async function cdpEndpointAvailable(port) {
  if (!Number.isFinite(port) || port <= 0) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

// Personal-only mode (Step 4e): managed backend is stubbed, so there's no
// Chrome listening on the cdpPort the boot chain expects. We start a tiny
// HTTP stub that satisfies just enough of the DevTools HTTP endpoint surface
// (/json/version + empty /json target list) so waitForCdp, cdpJson, and the
// target watcher don't error. Real browser actions route via the personal
// bridge (separate process / port), not through this stub.
async function startStubCdpServer(port) {
  const server = http.createServer((req, res) => {
    const url = req.url || "";
    if (url === "/json/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        Browser: "ABR-Stub/0.1 (managed backend removed in slim-abr-raw-cdp)",
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/abr-stub`,
        userAgent: "ABR-Stub",
        "V8-Version": "0",
        "WebKit-Version": "0",
      }));
      return;
    }
    if (url === "/json" || url === "/json/list" || url.startsWith("/json?")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not-supported-in-personal-only-mode");
  });
  await new Promise((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  return server;
}

function devToolsActivePortPath(userDataDir) {
  return join(userDataDir, "DevToolsActivePort");
}

function readDevToolsActivePort(userDataDir) {
  try {
    const filePath = devToolsActivePortPath(userDataDir);
    const content = readFileSync(filePath, "utf8");
    const [firstLine] = content.split(/\r?\n/);
    const port = Number.parseInt(firstLine, 10);
    if (!(Number.isFinite(port) && port > 0)) {
      // SF-9: file exists but content is malformed — warn so the 20s timeout isn't cryptic
      console.warn(`[cdp-port] DevToolsActivePort file exists at ${filePath} but port is not a valid integer (got: ${JSON.stringify(firstLine)})`);
      return null;
    }
    return port;
  } catch (err) {
    // ENOENT is expected during startup; other errors (EACCES, malformed path) are worth noting
    if (err?.code !== "ENOENT") {
      console.warn("[cdp-port] readDevToolsActivePort error (non-ENOENT):", err?.message || err);
    }
    return null;
  }
}

async function waitForManagedCdpEndpoint({ requestedPort, userDataDir }) {
  if (Number.isFinite(requestedPort) && requestedPort > 0) {
    await waitForCdp(requestedPort);
    return requestedPort;
  }
  for (let i = 0; i < 80; i++) {
    const activePort = readDevToolsActivePort(userDataDir);
    if (activePort && await cdpEndpointAvailable(activePort)) return activePort;
    await sleep(250);
  }
  throw new Error(`browser CDP endpoint is not available; no DevToolsActivePort appeared under ${userDataDir}`);
}

// Root cause #7 (2026-06-03 reliability redesign): in fixed-port mode the worker
// only HTTP-probes the CDP port to decide "a browser is already here, attach to
// it." If a FOREIGN browser (the user's own Edge, a leftover, another worker)
// squats on the port, the worker silently attaches and drives the wrong
// browser. This verifies the browser already on `cdpPort` is the worker's own
// by matching the OS process command line: it must carry BOTH the debugging
// port AND the worker's expected --user-data-dir. Windows-first; fail-OPEN
// (returns { verified:false, reason } without throwing) so an environment where
// the check can't run never blocks worker startup.
async function verifyManagedBrowserOwnership(cdpPort, expectedUserDataDir) {
  if (process.platform !== "win32") {
    return { verified: false, checked: false, reason: "ownership-check-unsupported-platform" };
  }
  const wantDir = normalizePathForCompare(expectedUserDataDir);
  if (!wantDir) return { verified: false, checked: false, reason: "no-expected-user-data-dir" };
  const psQuery =
    "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe' OR Name='chromium.exe'\" " +
    "| Where-Object { $_.CommandLine -like '*--remote-debugging-port=" + cdpPort + "*' -and $_.CommandLine -notlike '*--type=*' } " +
    "| Select-Object -ExpandProperty CommandLine";
  const commandLine = await new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    try {
      const child = execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", psQuery],
        { timeout: 5000, windowsHide: true },
        (err, stdout) => finish(err ? null : String(stdout || "")),
      );
      child.on("error", () => finish(null));
    } catch {
      finish(null);
    }
  });
  if (commandLine === null) {
    return { verified: false, checked: false, reason: "ownership-check-unavailable" };
  }
  const lines = commandLine.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    // Port is reachable per HTTP but no owning browser process was found — could
    // be a relay/proxy. Treat as unverified (caller decides).
    return { verified: false, checked: true, reason: "no-owning-browser-process-found" };
  }
  const match = (line) => normalizePathForCompare((line.match(/--user-data-dir=("[^"]*"|\S+)/i)?.[1]) || "") === wantDir;
  if (lines.some(match)) {
    return { verified: true, checked: true, reason: "user-data-dir-match" };
  }
  const foreignDirs = lines
    .map((line) => (line.match(/--user-data-dir=("[^"]*"|\S+)/i)?.[1] || "").replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  return { verified: false, checked: true, reason: "foreign-browser-on-port", foreignUserDataDirs: foreignDirs };
}

async function cdpJson(port, path, init = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
  if (!response.ok) {
    throw new Error(`CDP HTTP ${path} failed: ${response.status} ${await response.text()}`);
  }
  return await response.json();
}

async function minimizeBrowserWindow(childPid) {
  // Default: minimize on launch so the headful browser doesn't steal focus.
  // Window stays in taskbar — user can see it and restore if needed.
  // Set CDP_BROWSER_START_MINIMIZED=0 to keep the browser window visible.
  if (process.env.CDP_BROWSER_START_MINIMIZED === "0") return;
  if (!childPid) return;
  try {
    if (process.platform === "win32") {
      // ShowWindow SW_MINIMIZE = 6 — minimizes to taskbar, keeps icon visible.
      // This is more reliable than CDP Browser.setWindowBounds which can hide
      // the window entirely (no taskbar entry → user loses visibility).
      const { execFile } = await import("node:child_process");
      await new Promise((resolve) => {
        const ps = execFile(
          "powershell.exe",
          [
            "-NoProfile", "-NonInteractive", "-Command",
            `Add-Type -Name W -Namespace C -MemberDefinition '[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int n);';` +
            `Get-Process -Id ${childPid} -ErrorAction SilentlyContinue | ` +
            `ForEach-Object { if($_.MainWindowHandle) { [C.W]::ShowWindow($_.MainWindowHandle, 6) | Out-Null } }`,
          ],
          { timeout: 5000, windowsHide: true },
          (err) => resolve(err ? null : true),
        );
        ps.on("error", () => resolve(null));
      });
      // Fallback retry after a short delay — Chrome may not have created its
      // window handle yet on the first attempt.
      await sleep(2000);
      await new Promise((resolve) => {
        const ps = execFile(
          "powershell.exe",
          [
            "-NoProfile", "-NonInteractive", "-Command",
            `Add-Type -Name W -Namespace C -MemberDefinition '[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int n);';` +
            `Get-Process -Id ${childPid} -ErrorAction SilentlyContinue | ` +
            `ForEach-Object { if($_.MainWindowHandle) { [C.W]::ShowWindow($_.MainWindowHandle, 6) | Out-Null } }`,
          ],
          { timeout: 5000, windowsHide: true },
          (err) => resolve(err ? null : true),
        );
        ps.on("error", () => resolve(null));
      });
    }
  } catch {
    // Best-effort — never block startup if minimize fails
  }
}

async function runBrowserProcessCdpCommand(port, method, commandParams = {}) {
  const versionResponse = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!versionResponse.ok) {
    throw new Error(`CDP version endpoint failed: ${versionResponse.status} ${await versionResponse.text()}`);
  }
  const version = await versionResponse.json();
  if (!version.webSocketDebuggerUrl) {
    throw new Error("CDP version endpoint did not expose webSocketDebuggerUrl");
  }
  const browserClient = await CDP({ target: version.webSocketDebuggerUrl });
  try {
    return await browserClient.send(method, commandParams && typeof commandParams === "object" ? commandParams : {});
  } finally {
    await browserClient.close().catch(() => {});
  }
}

// Root cause #8 (2026-06-03 reliability redesign): keep ONE persistent
// browser-level CDP connection open, subscribe to Target.targetDestroyed, and
// notify the caller when any tab dies so stale profile bindings can be cleared
// proactively (not just lazily on next use, which previously could crash on an
// explicit tabId). Fail-OPEN by design: if the connection cannot be
// established or drops, it retries with backoff and the worker keeps running on
// the existing reactive (rebuild-on-next-use) path; it never throws into
// startup. Reconnects across managed-browser relaunches.
function startTargetDestroyedWatcher({ getCdpPort, onDestroyed, isStopped }) {
  let client = null;
  let stopped = false;
  let retryTimer = null;

  async function connect() {
    if (stopped || (isStopped && isStopped())) return;
    const port = getCdpPort();
    try {
      const version = await cdpJson(port, "/json/version");
      if (!version?.webSocketDebuggerUrl) throw new Error("no webSocketDebuggerUrl");
      const next = await CDP({ target: version.webSocketDebuggerUrl });
      client = next;
      next.on("disconnect", () => {
        if (client === next) client = null;
        scheduleReconnect(1000);
      });
      next.on("event", async (message) => {
        if (message.method === "Target.targetDestroyed") {
          const tabId = message.params?.targetId;
          try { await onDestroyed(tabId); } catch { /* never let a handler kill the watcher */ }
        }
      });
      await next.send("Target.setDiscoverTargets", { discover: true });
    } catch {
      scheduleReconnect(2000);
    }
  }

  function scheduleReconnect(delayMs) {
    if (stopped || (isStopped && isStopped())) return;
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, delayMs);
    if (retryTimer.unref) retryTimer.unref();
  }

  void connect();

  return {
    async stop() {
      stopped = true;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      if (client) { await client.close().catch(() => {}); client = null; }
    },
  };
}

async function listPageTargets(port) {
  const targets = await cdpJson(port, "/json/list");
  return targets.filter((target) => target.type === "page");
}

async function ensurePageTarget(port, tabId) {
  const pages = await listPageTargets(port);
  if (tabId) {
    const exact = pages.find((target) => target.id === tabId);
    if (exact) return exact;
    throw new Error(`tab not found: ${tabId}`);
  }
  const usable = pages.find((target) => target.url !== "devtools://devtools/bundled/devtools_app.html");
  if (usable) return usable;
  throw new Error("no page target is attached; use browser_open with a real URL before calling page-scoped tools");
}

async function createBrowserContext(port) {
  const result = await runBrowserProcessCdpCommand(port, "Target.createBrowserContext", {
    disposeOnDetach: false,
  });
  if (!result?.browserContextId) throw new Error("Target.createBrowserContext did not return browserContextId");
  return result.browserContextId;
}

async function targetBrowserContextId(port, targetId) {
  if (!targetId) return null;
  const result = await runBrowserProcessCdpCommand(port, "Target.getTargets").catch(() => null);
  const target = result?.targetInfos?.find((entry) => entry.targetId === targetId);
  return target?.browserContextId || null;
}

async function disposeBrowserContext(port, browserContextId) {
  if (!browserContextId) return;
  await runBrowserProcessCdpCommand(port, "Target.disposeBrowserContext", { browserContextId }).catch(() => {});
}

async function createPageTarget(port, url, options = {}) {
  if (!url || url === "about:blank") {
    if (!options?.allowBlank) {
      throw new Error("createPageTarget requires a real URL; refusing to create an implicit about:blank page");
    }
    url = "about:blank";
  }
  const browserContextId = options?.browserContextId;
  if (browserContextId) {
    const result = await runBrowserProcessCdpCommand(port, "Target.createTarget", {
      url,
      browserContextId,
    });
    const targetId = result?.targetId;
    if (!targetId) throw new Error("Target.createTarget did not return targetId");
    if (url && url !== "about:blank") {
      const client = await CDP({ port, target: targetId });
      try {
        await client.Page.enable();
        await client.Page.navigate({ url });
      } finally {
        await client.close().catch(() => {});
      }
    }
    await sleep(50);
    const pages = await listPageTargets(port);
    return pages.find((target) => target.id === targetId) || { id: targetId, title: "", url, type: "page" };
  }
  return await cdpJson(port, `/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
}

import {
  toolResult,
  axValue,
  normalizeAccessibilityNode,
  normalizeProfileName,
} from "./lib/result-format.mjs";

import {
  looksSensitiveKey,
  looksSensitiveValue,
  scanRecord,
  cookieExpiry,
  summarizeCookies,
  cookiePartitionKeyLabel,
  summarizeCookiePartitions,
  summarizeStorageBoundaries,
  summarizeStorageBuckets,
  severityRank,
  buildSignalSummary,
} from "./lib/evidence-summaries.mjs";

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
} from "./lib/evidence-artifacts.mjs";

import {
  requestOrigin,
  requestPathname,
  requestSet,
  diffRequestSets,
  extractHarRecords,
  extractBundleNetworkRecords,
  analyzeHarCompleteness,
  diffObjectKeys,
  headerValue,
  authHeaderEvidence,
} from "./lib/network-har.mjs";

import {
  requestDurationMs,
  hostnameForUrl,
  networkDisplayName,
  pickFilterValue,
  booleanFilterValue,
  headerMatches,
  networkRequestMatchesFilters,
  sortNetworkRequests,
  filterNetworkRequests,
  limitNetworkRequests,
} from "./lib/network-filters.mjs";

function sourceMatches(script, params = {}) {
  if (params.urlContains) {
    const needle = String(params.urlContains).toLowerCase();
    if (!String(script.url || "").toLowerCase().includes(needle)) return false;
  }
  if (typeof params.hasSourceMap === "boolean" && Boolean(script.sourceMapURL) !== params.hasSourceMap) return false;
  if (typeof params.isModule === "boolean" && Boolean(script.isModule) !== params.isModule) return false;
  return true;
}

function buildSourceSearchDrilldowns(results = [], params = {}) {
  const firstMatch = results.find((entry) => entry && !entry.error && entry.scriptId) || null;
  if (!firstMatch) {
    return [
      {
        label: "Reload and search parsed sources again",
        tool: "browser_sources_search",
        input: {
          query: params.query || "<query>",
          reload: true,
          ignoreCache: true,
          maxMatches: params.maxMatches || 50,
        },
        why: "If no parsed script matched, reload with cache bypass to collect a fresh scriptParsed set.",
      },
    ];
  }
  const drilldowns = [
    {
      label: "Read matching script source",
      tool: "browser_source_get",
      input: { scriptId: firstMatch.scriptId },
      why: "Open the complete parsed script that contains the literal match.",
    },
    {
      label: "Pretty-print matching script",
      tool: "browser_source_pretty_print",
      input: { scriptId: firstMatch.scriptId, query: params.query || undefined },
      why: "Create a readable view of minified or bundled script text near the same match.",
    },
  ];
  if (firstMatch.sourceMapURL) {
    drilldowns.push({
      label: "Inspect source map metadata",
      tool: "browser_source_map_metadata",
      input: { scriptId: firstMatch.scriptId, fetchMap: true },
      why: "Check whether DevTools can map the generated script back to original sources.",
    });
    drilldowns.push({
      label: "Extract original source-map files",
      tool: "browser_source_map_sources",
      input: { scriptId: firstMatch.scriptId, save: true, maxSources: 20 },
      why: "Save extractable original sources as bounded local artifacts for later review.",
    });
  }
  if (firstMatch.url && typeof firstMatch.line === "number") {
    drilldowns.push({
      label: "Set breakpoint at matching source location",
      tool: "browser_debugger_control",
      input: {
        action: "setBreakpointByUrl",
        url: firstMatch.url,
        lineNumber: Math.max(0, firstMatch.line - 1),
        columnNumber: Math.max(0, firstMatch.column || 0),
      },
      why: "Attach a DevTools breakpoint at the same generated-script location without interpreting runtime impact.",
    });
  }
  return drilldowns;
}

function pushTextSearchMatches(results, { category, source, locator = {}, text, query, options = {} }) {
  const remaining = Math.max(0, (typeof options.maxMatches === "number" ? options.maxMatches : 50) - results.length);
  if (!remaining) return;
  const matches = findSourceMatches(String(text || ""), String(query || ""), {
    caseSensitive: Boolean(options.caseSensitive),
    maxMatches: remaining,
    contextChars: typeof options.contextChars === "number" ? options.contextChars : 120,
  });
  for (const match of matches) {
    results.push({
      category,
      source,
      ...locator,
      ...match,
    });
    if (results.length >= (typeof options.maxMatches === "number" ? options.maxMatches : 50)) break;
  }
}

function domMutationWatchPageFunction(options) {
  const startedAt = new Date().toISOString();
  const selector = String(options.selector || "");
  const node = document.querySelector(selector);
  const maxEvents = Math.max(1, Number(options.maxEvents || 100));
  const durationMs = Math.max(100, Number(options.durationMs || 1000));
  function describeNode(target) {
    if (!target) return null;
    if (target.nodeType === Node.TEXT_NODE) {
      return {
        nodeType: "text",
        text: String(target.textContent || "").slice(0, 200),
        parent: describeNode(target.parentElement),
      };
    }
    if (!(target instanceof Element)) {
      return {
        nodeType: target.nodeType,
        nodeName: target.nodeName,
      };
    }
    return {
      nodeType: "element",
      tagName: target.tagName.toLowerCase(),
      id: target.id || "",
      className: typeof target.className === "string" ? target.className : "",
      text: String(target.textContent || "").trim().slice(0, 200),
    };
  }
  function pathFor(target) {
    if (!(target instanceof Element)) return "";
    const parts = [];
    let current = target;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        part += `#${current.id}`;
        parts.unshift(part);
        break;
      }
      const parent = current.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter((child) => child.tagName === current.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ");
  }
  return new Promise((resolve) => {
    if (!node) {
      resolve({
        found: false,
        selector,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs,
        eventCount: 0,
        events: [],
      });
      return;
    }
    const events = [];
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (events.length >= maxEvents) break;
        events.push({
          timestamp: new Date().toISOString(),
          type: mutation.type,
          target: describeNode(mutation.target),
          targetPath: pathFor(mutation.target),
          attributeName: mutation.attributeName || null,
          attributeNamespace: mutation.attributeNamespace || null,
          oldValue: mutation.oldValue ?? null,
          addedNodes: [...mutation.addedNodes].slice(0, 10).map(describeNode),
          removedNodes: [...mutation.removedNodes].slice(0, 10).map(describeNode),
          addedNodeCount: mutation.addedNodes.length,
          removedNodeCount: mutation.removedNodes.length,
        });
      }
    });
    observer.observe(node, {
      subtree: options.subtree !== false,
      childList: options.childList !== false,
      attributes: options.attributes !== false,
      characterData: Boolean(options.characterData),
      attributeOldValue: options.attributeOldValue !== false,
      characterDataOldValue: Boolean(options.characterDataOldValue),
    });
    let triggerError = null;
    if (options.triggerExpression) {
      try {
        const fn = new Function(String(options.triggerExpression));
        setTimeout(() => {
          try { fn(); }
          catch (error) { triggerError = String(error?.message || error); }
        }, 0);
      } catch (error) {
        triggerError = String(error?.message || error);
      }
    }
    setTimeout(() => {
      observer.disconnect();
      resolve({
        found: true,
        selector,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs,
        target: describeNode(node),
        targetPath: pathFor(node),
        observerOptions: {
          subtree: options.subtree !== false,
          childList: options.childList !== false,
          attributes: options.attributes !== false,
          characterData: Boolean(options.characterData),
          attributeOldValue: options.attributeOldValue !== false,
          characterDataOldValue: Boolean(options.characterDataOldValue),
        },
        triggerError,
        eventCount: events.length,
        events,
        truncated: events.length >= maxEvents,
      });
    }, durationMs);
  });
}

function domSearchFallbackPageFunction(options) {
  const query = String(options.query || "");
  const maxResults = Math.max(0, Number(options.maxResults || 20));
  const maxOuterHTMLChars = Math.max(0, Number(options.maxOuterHTMLChars || 1200));
  const includeFrames = options.includeFrames !== false;
  const seen = new Set();
  const results = [];
  const frameErrors = [];
  function push(element, source, frame = null) {
    if (!element || element.nodeType !== 1 || seen.has(element) || results.length >= maxResults) return;
    seen.add(element);
    const outerHTML = String(element.outerHTML || "");
    results.push({
      source,
      frame,
      nodeType: element.nodeType,
      nodeName: element.nodeName,
      localName: element.localName,
      attributes: Object.fromEntries([...element.attributes].map((attr) => [attr.name, attr.value])),
      text: String(element.textContent || "").trim().slice(0, 300),
      outerHTML: outerHTML.slice(0, maxOuterHTMLChars),
      outerHTMLTruncated: outerHTML.length > maxOuterHTMLChars,
    });
  }
  function frameInfo(win, path) {
    try {
      return {
        path,
        url: win.location.href,
        origin: win.location.origin,
        title: win.document?.title || "",
      };
    } catch (error) {
      return { path, inaccessible: true, error: String(error?.message || error) };
    }
  }
  function searchDocument(doc, frame) {
    if (!doc?.documentElement || results.length >= maxResults) return;
    try {
      doc.querySelectorAll(query).forEach((element) => push(element, "querySelectorAll", frame));
    } catch {
      // Not a CSS selector; text and XPath passes below can still match.
    }
    try {
      const xpath = doc.evaluate(query, doc, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
      let node = xpath.iterateNext();
      while (node && results.length < maxResults) {
        push(node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement, "xpath", frame);
        node = xpath.iterateNext();
      }
    } catch {
      // Not an XPath expression.
    }
    const needle = query.toLowerCase();
    if (needle) {
      const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_ELEMENT);
      let node = walker.currentNode;
      while (node && results.length < maxResults) {
        const haystack = `${node.id || ""} ${node.className || ""} ${node.getAttribute?.("name") || ""} ${node.getAttribute?.("aria-label") || ""} ${node.textContent || ""} ${node.outerHTML || ""}`.toLowerCase();
        if (haystack.includes(needle)) push(node, "text", frame);
        node = walker.nextNode();
      }
    }
    if (includeFrames) {
      const frames = Array.from(doc.querySelectorAll("iframe,frame"));
      frames.forEach((frameElement, index) => {
        if (results.length >= maxResults) return;
        try {
          const childWindow = frameElement.contentWindow;
          const childDocument = frameElement.contentDocument || childWindow?.document;
          if (!childDocument) return;
          searchDocument(childDocument, frameInfo(childWindow, `${frame?.path || "top"} > frame[${index}]`));
        } catch (error) {
          frameErrors.push({
            path: `${frame?.path || "top"} > frame[${index}]`,
            src: frameElement.getAttribute("src") || frameElement.getAttribute("srcdoc") || "",
            error: String(error?.message || error),
          });
        }
      });
    }
  }
  searchDocument(document, frameInfo(window, "top"));
  return {
    query,
    returnedCount: results.length,
    includeFrames,
    frameErrors,
    results,
  };
}

function selectInFramePageFunction(options) {
  const hasSelector = typeof options.selector === "string" && options.selector.length > 0;
  const selector = hasSelector ? String(options.selector) : "";
  const text = String(options.text || "");
  const frameIndexes = Array.isArray(options.frameIndexes) ? options.frameIndexes : [];
  const wanted = text.toLowerCase();
  const includeFrames = options.includeFrames !== false;
  const includeShadow = options.includeShadow !== false;
  const maxShadowRoots = Math.max(0, Math.min(200, Number(options.maxShadowRoots) || 60));
  const interactiveSelector = [
    "button",
    "a",
    "input",
    "textarea",
    "select",
    "label",
    "summary",
    "[role=button]",
    "[role=link]",
    "[role=textbox]",
    "[role=combobox]",
    "[role=searchbox]",
    "[role=menuitem]",
    "[role=tab]",
    "[role=switch]",
    "[role=checkbox]",
    "[role=radio]",
    "[contenteditable='']",
    "[contenteditable=true]",
    "[tabindex]",
    "[onclick]",
  ].join(",");
  const clickableSelector = [
    "button",
    "a",
    "input",
    "textarea",
    "select",
    "summary",
    "[role=button]",
    "[role=link]",
    "[role=textbox]",
    "[role=combobox]",
    "[role=searchbox]",
    "[role=menuitem]",
    "[role=tab]",
    "[role=switch]",
    "[role=checkbox]",
    "[role=radio]",
    "[contenteditable='']",
    "[contenteditable=true]",
    "[tabindex]",
    "[onclick]",
  ].join(",");
  function byId(value, doc = document) {
    if (!value) return "";
    return String(value).split(/\s+/).map((id) => {
      try {
        return doc.getElementById(id)?.textContent || "";
      } catch {
        return "";
      }
    }).join(" ");
  }
  function labelsText(node) {
    const labels = node.labels ? Array.from(node.labels) : [];
    if (node.id) {
      try {
        labels.push(...Array.from(node.ownerDocument.querySelectorAll(`label[for="${CSS.escape(node.id)}"]`)));
      } catch {
        // Ignore invalid ids.
      }
    }
    return labels.map((label) => label.textContent || "").join(" ");
  }
  function locatorText(node) {
    return [
      node.innerText || "",
      node.textContent || "",
      typeof node.value === "string" ? node.value : "",
      node.getAttribute?.("aria-label") || "",
      byId(node.getAttribute?.("aria-labelledby") || "", node.ownerDocument || document),
      node.getAttribute?.("placeholder") || "",
      node.getAttribute?.("title") || "",
      node.getAttribute?.("name") || "",
      node.getAttribute?.("alt") || "",
      labelsText(node),
      node.getAttribute?.("role") || "",
      node.tagName || "",
    ].join(" ").replace(/\s+/g, " ").trim().toLowerCase();
  }
  function visibleCandidate(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.tagName === "HTML" || node.tagName === "BODY") return false;
    const rect = node.getBoundingClientRect?.();
    if (!rect || rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(node);
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  }
  function matchInRoot(root) {
    if (!root) return null;
    if (selector === "document" || (!hasSelector && !text)) return root;
    if (selector) {
      try {
        const found = root.querySelector(selector);
        if (found) return found;
      } catch {
        return null;
      }
    } else {
      const direct = Array.from(root.querySelectorAll(interactiveSelector))
        .find((node) => locatorText(node).includes(wanted));
      if (direct) return direct.closest?.(clickableSelector) || direct;
      const textMatch = Array.from(root.querySelectorAll("*"))
        .filter(visibleCandidate)
        .filter((node) => locatorText(node).includes(wanted))
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          const aText = locatorText(a).length;
          const bText = locatorText(b).length;
          return aText - bText || (ar.width * ar.height) - (br.width * br.height);
        })[0];
      if (textMatch) return textMatch.closest?.(clickableSelector) || textMatch;
    }
    return null;
  }
  function shadowRoots(root) {
    if (!includeShadow || !root?.querySelectorAll) return [];
    const roots = [];
    const all = Array.from(root.querySelectorAll("*"));
    for (const el of all) {
      if (roots.length >= maxShadowRoots) break;
      if (el.shadowRoot) roots.push({ host: el, root: el.shadowRoot });
    }
    return roots;
  }
  function visitRoot(root, meta) {
    const matched = matchInRoot(root);
    if (matched) {
      matched.__abrLocatorMeta = meta;
      return matched;
    }
    for (const entry of shadowRoots(root)) {
      const found = visitRoot(entry.root, {
        ...meta,
        shadowPath: [...(meta.shadowPath || []), entry.host.tagName?.toLowerCase() || "host"],
      });
      if (found) return found;
    }
    if (includeFrames && root?.querySelectorAll) {
      const frames = Array.from(root.querySelectorAll("iframe,frame"));
      for (let index = 0; index < frames.length; index += 1) {
        try {
          const frame = frames[index];
          const childDocument = frame.contentDocument || frame.contentWindow?.document;
          if (!childDocument) continue;
          const found = visitRoot(childDocument, {
            ...meta,
            framePath: `${meta.framePath || "top"} > frame[${index}]`,
            frameIndexes: [...(meta.frameIndexes || []), index],
            frameUrl: frame.src || childDocument.location?.href || "",
          });
          if (found) return found;
        } catch {
          // Cross-origin frames are intentionally skipped here; inspect frame access separately.
        }
      }
    }
    return null;
  }
  let doc = document;
  let meta = { framePath: options.framePath || "top", frameIndexes: [], shadowPath: [] };
  for (const index of frameIndexes) {
    const frames = Array.from(doc.querySelectorAll("iframe,frame"));
    const frame = frames[index];
    if (!frame) return null;
    doc = frame.contentDocument || frame.contentWindow?.document;
    if (!doc) return null;
    meta = {
      ...meta,
      framePath: `${meta.framePath || "top"} > frame[${index}]`,
      frameIndexes: [...(meta.frameIndexes || []), index],
      frameUrl: frame.src || doc.location?.href || "",
    };
  }
  return visitRoot(doc, meta);
}

function styleInFramePageFunction(options) {
  const el = selectInFramePageFunction(options);
  if (!el || el.nodeType !== 1) return { found: false, error: "selector_not_found", framePath: options.framePath || null };
  const computed = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const computedStyle = Array.from(computed).map((name) => ({ name, value: computed.getPropertyValue(name) }));
  return {
    found: true,
    source: "runtime-frame-fallback",
    framePath: options.framePath || null,
    selector: options.selector,
    nodeName: el.nodeName,
    localName: el.localName,
    text: String(el.textContent || "").trim().slice(0, 500),
    outerHTML: String(el.outerHTML || "").slice(0, options.maxOuterHTMLChars || 4000),
    computedStyle: { computedStyle },
    boxModel: {
      model: {
        content: [rect.left, rect.top, rect.right, rect.top, rect.right, rect.bottom, rect.left, rect.bottom],
        border: [rect.left, rect.top, rect.right, rect.top, rect.right, rect.bottom, rect.left, rect.bottom],
        padding: [rect.left, rect.top, rect.right, rect.top, rect.right, rect.bottom, rect.left, rect.bottom],
        margin: [rect.left, rect.top, rect.right, rect.top, rect.right, rect.bottom, rect.left, rect.bottom],
        width: rect.width,
        height: rect.height,
      },
    },
  };
}

function frameAccessPageFunction() {
  const rows = [];
  function visit(doc, path) {
    const frames = Array.from(doc.querySelectorAll("iframe,frame"));
    frames.forEach((frame, index) => {
      const childPath = `${path} > frame[${index}]`;
      const row = {
        path: childPath,
        tagName: frame.tagName,
        id: frame.id || null,
        name: frame.getAttribute("name") || null,
        src: frame.getAttribute("src") || frame.getAttribute("srcdoc") || "",
        sandbox: frame.getAttribute("sandbox") || null,
        accessible: false,
      };
      try {
        const childWindow = frame.contentWindow;
        const childDocument = frame.contentDocument || childWindow?.document;
        row.url = childWindow?.location?.href || "";
        row.origin = childWindow?.location?.origin || "";
        row.title = childDocument?.title || "";
        row.accessible = Boolean(childDocument?.documentElement);
        if (row.accessible) visit(childDocument, childPath);
      } catch (error) {
        row.error = String(error?.message || error);
      }
      rows.push(row);
    });
  }
  visit(document, "top");
  return rows;
}

function frameShadowBoundaryPageFunction(options = {}) {
  const maxShadowRoots = Math.max(0, Number(options.maxShadowRoots || 100));
  const shadowRoots = [];
  const frameRows = [];
  const frameErrors = [];
  function nodeLabel(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
    const id = node.id ? `#${node.id}` : "";
    const cls = typeof node.className === "string" && node.className.trim()
      ? `.${node.className.trim().split(/\s+/).slice(0, 3).join(".")}`
      : "";
    return `${node.tagName.toLowerCase()}${id}${cls}`;
  }
  function cssPath(el) {
    const parts = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        part += `#${current.id}`;
        parts.unshift(part);
        break;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ");
  }
  function frameInfo(win, path) {
    try {
      return {
        path,
        url: win.location.href,
        origin: win.location.origin,
        title: win.document?.title || "",
      };
    } catch (error) {
      return { path, inaccessible: true, error: String(error?.message || error) };
    }
  }
  function scanRoot(root, ownerPath, frame) {
    if (!root || shadowRoots.length >= maxShadowRoots) return;
    const elements = root.querySelectorAll ? Array.from(root.querySelectorAll("*")) : [];
    for (const el of elements) {
      if (shadowRoots.length >= maxShadowRoots) break;
      if (!el.shadowRoot) continue;
      const shadow = el.shadowRoot;
      const path = `${ownerPath} > ${cssPath(el)}::shadow`;
      const entry = {
        path,
        mode: shadow.mode || "open",
        host: {
          label: nodeLabel(el),
          path: cssPath(el),
          id: el.id || null,
          tagName: el.tagName,
        },
        frame,
        childElementCount: shadow.children?.length || 0,
        textLength: String(shadow.textContent || "").length,
        sampleText: String(shadow.textContent || "").trim().slice(0, 240),
        slotCount: shadow.querySelectorAll ? shadow.querySelectorAll("slot").length : 0,
      };
      shadowRoots.push(entry);
      scanRoot(shadow, path, frame);
    }
  }
  function visit(win, doc, path) {
    const frame = frameInfo(win, path);
    scanRoot(doc, path, frame);
    const frames = Array.from(doc.querySelectorAll("iframe,frame"));
    frames.forEach((frameElement, index) => {
      const childPath = `${path} > frame[${index}]`;
      const row = {
        path: childPath,
        tagName: frameElement.tagName,
        id: frameElement.id || null,
        name: frameElement.getAttribute("name") || null,
        src: frameElement.getAttribute("src") || frameElement.getAttribute("srcdoc") || "",
        sandbox: frameElement.getAttribute("sandbox") || null,
        accessible: false,
      };
      try {
        const childWindow = frameElement.contentWindow;
        const childDocument = frameElement.contentDocument || childWindow?.document;
        row.url = childWindow?.location?.href || "";
        row.origin = childWindow?.location?.origin || "";
        row.title = childDocument?.title || "";
        row.accessible = Boolean(childDocument?.documentElement);
        if (row.accessible) visit(childWindow, childDocument, childPath);
      } catch (error) {
        row.error = String(error?.message || error);
        frameErrors.push({ path: childPath, error: row.error, src: row.src });
      }
      frameRows.push(row);
    });
  }
  visit(window, document, "top");
  return {
    generatedAt: new Date().toISOString(),
    frames: frameRows,
    frameCount: frameRows.length,
    inaccessibleFrameCount: frameRows.filter((frame) => frame.accessible === false).length,
    frameErrors,
    shadowRoots,
    shadowRootCount: shadowRoots.length,
    truncatedShadowRoots: shadowRoots.length >= maxShadowRoots,
    boundaries: [
      "Open shadow roots are enumerable from page JavaScript; closed shadow roots are intentionally not exposed.",
      "Same-origin iframe documents can be inspected from page context; cross-origin or sandboxed frame internals may be unavailable.",
      "This is DOM boundary evidence only, not a vulnerability judgment.",
    ],
  };
}

function tokenFlowTracePageFunction(options) {
  const durationMs = Math.max(50, Number(options.durationMs || 1000));
  const maxEvents = Math.max(1, Number(options.maxEvents || 100));
  const includeValues = options.includeValues !== false;
  const triggerExpression = String(options.triggerExpression || "");
  const tokenPatterns = [
    /bearer\s+[a-z0-9._~+/=-]{8,}/i,
    /(?:token|secret|session|jwt|auth|api[_-]?key)[a-z0-9_.:/?&=%+\-\s]{0,40}[=:]\s*[a-z0-9._~+/=-]{8,}/i,
    /eyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}/,
    /sk-[a-zA-Z0-9_-]{16,}/,
  ];
  const events = [];
  const originals = {
    fetch: window.fetch,
    xhrOpen: XMLHttpRequest.prototype.open,
    xhrSetRequestHeader: XMLHttpRequest.prototype.setRequestHeader,
    xhrSend: XMLHttpRequest.prototype.send,
    localSet: Storage.prototype.setItem,
    localGet: Storage.prototype.getItem,
    cookie: Object.getOwnPropertyDescriptor(Document.prototype, "cookie") || Object.getOwnPropertyDescriptor(HTMLDocument.prototype, "cookie"),
  };
  const now = () => new Date().toISOString();
  const safeString = (value) => {
    try {
      if (typeof value === "string") return value;
      if (value instanceof Headers) return JSON.stringify(Object.fromEntries(value.entries()));
      if (value && typeof value === "object") return JSON.stringify(value);
      return String(value ?? "");
    } catch {
      return String(value ?? "");
    }
  };
  const tokenHits = (parts) => {
    const text = parts.map(safeString).join(" ");
    return tokenPatterns
      .map((pattern) => text.match(pattern)?.[0])
      .filter(Boolean);
  };
  const push = (event) => {
    if (events.length >= maxEvents) return;
    const hits = tokenHits([event.value, event.key, event.url, event.headers, event.body]);
    events.push({
      at: now(),
      tokenLike: hits.length > 0,
      tokenHits: includeValues ? hits : hits.map((hit) => ({ length: hit.length })),
      ...event,
      ...(includeValues ? {} : {
        value: event.value ? { length: safeString(event.value).length } : undefined,
        body: event.body ? { length: safeString(event.body).length } : undefined,
        headers: event.headers ? { length: safeString(event.headers).length } : undefined,
      }),
    });
  };
  const readHeaders = (headers) => {
    try {
      if (!headers) return {};
      if (headers instanceof Headers) return Object.fromEntries(headers.entries());
      if (Array.isArray(headers)) return Object.fromEntries(headers);
      if (typeof headers === "object") return { ...headers };
      return headers;
    } catch {
      return {};
    }
  };
  window.fetch = async function agentTokenFlowFetch(input, init = {}) {
    const url = typeof input === "string" ? input : input?.url;
    const headers = readHeaders(init?.headers || input?.headers);
    push({ api: "fetch", phase: "request", url, method: init?.method || input?.method || "GET", headers, body: init?.body || null });
    const response = await originals.fetch.apply(this, arguments);
    try {
      const clone = response.clone();
      const text = await clone.text();
      push({ api: "fetch", phase: "response", url: response.url || url, status: response.status, value: text.slice(0, options.maxValueChars || 4000) });
    } catch (error) {
      push({ api: "fetch", phase: "response-body-error", url: response.url || url, status: response.status, error: String(error?.message || error) });
    }
    return response;
  };
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__agentTokenFlow = { method, url, headers: {} };
    return originals.xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    this.__agentTokenFlow = this.__agentTokenFlow || { headers: {} };
    this.__agentTokenFlow.headers[name] = value;
    return originals.xhrSetRequestHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    const meta = this.__agentTokenFlow || {};
    push({ api: "XMLHttpRequest", phase: "request", url: meta.url, method: meta.method, headers: meta.headers, body });
    this.addEventListener("loadend", () => {
      push({ api: "XMLHttpRequest", phase: "response", url: meta.url, status: this.status, value: String(this.responseText || "").slice(0, options.maxValueChars || 4000) });
    });
    return originals.xhrSend.apply(this, arguments);
  };
  Storage.prototype.setItem = function(key, value) {
    const area = this === localStorage ? "localStorage" : this === sessionStorage ? "sessionStorage" : "Storage";
    push({ api: area, phase: "setItem", key, value });
    return originals.localSet.apply(this, arguments);
  };
  Storage.prototype.getItem = function(key) {
    const value = originals.localGet.apply(this, arguments);
    const area = this === localStorage ? "localStorage" : this === sessionStorage ? "sessionStorage" : "Storage";
    push({ api: area, phase: "getItem", key, value });
    return value;
  };
  if (originals.cookie?.get && originals.cookie?.set) {
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get() {
        const value = originals.cookie.get.call(document);
        push({ api: "document.cookie", phase: "get", value });
        return value;
      },
      set(value) {
        push({ api: "document.cookie", phase: "set", value });
        return originals.cookie.set.call(document, value);
      },
    });
  }
  const restore = () => {
    window.fetch = originals.fetch;
    XMLHttpRequest.prototype.open = originals.xhrOpen;
    XMLHttpRequest.prototype.setRequestHeader = originals.xhrSetRequestHeader;
    XMLHttpRequest.prototype.send = originals.xhrSend;
    Storage.prototype.setItem = originals.localSet;
    Storage.prototype.getItem = originals.localGet;
    if (originals.cookie) {
      Object.defineProperty(document, "cookie", originals.cookie);
    }
  };
  return new Promise((resolve) => {
    let triggerResult = null;
    let triggerError = null;
    Promise.resolve()
      .then(() => triggerExpression ? Function(triggerExpression)() : null)
      .then((value) => { triggerResult = value; })
      .catch((error) => { triggerError = String(error?.message || error); });
    setTimeout(() => {
      restore();
      resolve({
        url: location.href,
        durationMs,
        eventCount: events.length,
        tokenLikeEventCount: events.filter((event) => event.tokenLike).length,
        events,
        triggerResult,
        triggerError,
      });
    }, durationMs);
  });
}

async function resolveNodeIdForSelector(client, selector, options = {}) {
  const frameIndexes = frameIndexesFromOptions(options);
  const searchNode = async () => {
    const search = await client.DOM.performSearch({ query: selector, includeUserAgentShadowDOM: true }).catch(() => null);
    const count = Number(search?.resultCount || 0);
    if (!search?.searchId || count <= 0) return null;
    const ids = await client.DOM.getSearchResults({ searchId: search.searchId, fromIndex: 0, toIndex: Math.min(count, 5) }).catch(() => ({ nodeIds: [] }));
    await client.DOM.discardSearchResults({ searchId: search.searchId }).catch(() => {});
    return (ids.nodeIds || []).find((nodeId) => nodeId) || null;
  };
  if (!frameIndexes.length) {
    const documentNode = await client.DOM.getDocument({ depth: -1, pierce: true });
    const query = await client.DOM.querySelector({ nodeId: documentNode.root.nodeId, selector });
    return { nodeId: query.nodeId || null, frameIndexes, via: "dom-query-selector" };
  }
  const objectGroup = "agent-browser-runtime-frame-selector";
  const evaluated = await client.Runtime.evaluate({
    expression: `(${selectInFramePageFunction.toString()})(${JSON.stringify({ selector, frameIndexes })})`,
    objectGroup,
    returnByValue: false,
    awaitPromise: true,
  });
  const objectId = evaluated.result?.objectId;
  if (!objectId || evaluated.result?.subtype === "null") {
    await client.Runtime.releaseObjectGroup({ objectGroup }).catch(() => {});
    return { nodeId: null, frameIndexes, via: "runtime-frame-selector", exception: evaluated.exceptionDetails || null };
  }
  const node = await client.DOM.requestNode({ objectId }).catch((error) => ({ error: String(error?.message || error), nodeId: null }));
  await client.Runtime.releaseObjectGroup({ objectGroup }).catch(() => {});
  const fallbackNodeId = node.nodeId ? null : await searchNode();
  return { nodeId: node.nodeId || fallbackNodeId || null, frameIndexes, via: node.nodeId ? "runtime-frame-selector" : "dom-search-fallback", error: node.error || null };
}

async function debuggerScopePreview(client, scopeChain = [], maxScopes = 5, maxProperties = 20) {
  const scopes = [];
  for (const scope of scopeChain.slice(0, maxScopes)) {
    const row = {
      type: scope.type,
      name: scope.name || "",
      startLocation: scope.startLocation || null,
      endLocation: scope.endLocation || null,
      object: scope.object ? {
        type: scope.object.type,
        subtype: scope.object.subtype,
        className: scope.object.className,
        description: scope.object.description,
      } : null,
      properties: [],
      propertyError: null,
    };
    if (scope.object?.objectId && scope.type !== "global") {
      try {
        const properties = await client.Runtime.getProperties({
          objectId: scope.object.objectId,
          ownProperties: true,
          accessorPropertiesOnly: false,
          generatePreview: true,
        });
        row.properties = (properties.result || []).slice(0, maxProperties).map((property) => ({
          name: property.name,
          enumerable: property.enumerable,
          configurable: property.configurable,
          writable: property.writable,
          isOwn: property.isOwn,
          value: property.value ? {
            type: property.value.type,
            subtype: property.value.subtype,
            className: property.value.className,
            description: property.value.description,
            value: property.value.value,
            unserializableValue: property.value.unserializableValue,
          } : null,
        }));
        row.propertiesTruncated = (properties.result || []).length > maxProperties;
      } catch (error) {
        row.propertyError = String(error?.message || error);
      }
    }
    scopes.push(row);
  }
  return scopes;
}

async function debuggerFrameEvaluations(client, callFrameId, options = {}) {
  const expressions = Array.isArray(options.evaluateExpressions)
    ? options.evaluateExpressions.map((entry) => String(entry || "").trim()).filter(Boolean).slice(0, Math.max(0, Number(options.maxEvaluateExpressions || 10)))
    : [];
  if (!expressions.length) return [];
  const maxValueChars = typeof options.maxEvaluationValueChars === "number" ? options.maxEvaluationValueChars : 4000;
  const rows = [];
  for (const expression of expressions) {
    try {
      const result = await client.Debugger.evaluateOnCallFrame({
        callFrameId,
        expression,
        objectGroup: "agent-browser-runtime-debugger-eval",
        includeCommandLineAPI: Boolean(options.includeCommandLineAPI),
        silent: true,
        returnByValue: options.evaluateReturnByValue !== false,
        throwOnSideEffect: Boolean(options.throwOnSideEffect),
        generatePreview: true,
      });
      rows.push({
        expression,
        result: debuggerRemoteObjectSummary(result.result || {}, maxValueChars),
        exceptionDetails: result.exceptionDetails || null,
      });
    } catch (error) {
      rows.push({ expression, error: String(error?.message || error) });
    }
  }
  await client.Runtime.releaseObjectGroup({ objectGroup: "agent-browser-runtime-debugger-eval" }).catch(() => {});
  return rows;
}

async function debuggerPausedSummary(client, event, options = {}) {
  if (!event) return null;
  const maxFrames = typeof options.maxFrames === "number" ? options.maxFrames : 10;
  const maxScopes = typeof options.maxScopes === "number" ? options.maxScopes : 5;
  const maxProperties = typeof options.maxProperties === "number" ? options.maxProperties : 20;
  const maxEvaluateFrames = typeof options.maxEvaluateFrames === "number" ? options.maxEvaluateFrames : 1;
  const frames = [];
  for (const [index, frame] of (event.callFrames || []).slice(0, maxFrames).entries()) {
    frames.push({
      callFrameId: frame.callFrameId,
      functionName: frame.functionName,
      url: frame.url,
      location: frame.location,
      functionLocation: frame.functionLocation || null,
      this: frame.this ? {
        type: frame.this.type,
        subtype: frame.this.subtype,
        className: frame.this.className,
        description: frame.this.description,
        value: frame.this.value,
      } : null,
      scopeChain: await debuggerScopePreview(client, frame.scopeChain || [], maxScopes, maxProperties),
      evaluations: index < maxEvaluateFrames ? await debuggerFrameEvaluations(client, frame.callFrameId, options) : [],
    });
  }
  return {
    reason: event.reason,
    data: event.data || null,
    hitBreakpoints: event.hitBreakpoints || [],
    asyncStackTrace: event.asyncStackTrace || null,
    asyncStackTraceId: event.asyncStackTraceId || null,
    callFrameCount: event.callFrames?.length || 0,
    callFrames: frames,
    callFramesTruncated: (event.callFrames?.length || 0) > maxFrames,
  };
}

function createProfileRegistry({ cdpPort, dataDir, onProfileReady }) {
  const registryFile = process.env.CDP_PROFILE_REGISTRY_FILE || join(dataDir, "profiles.json");
  const captureState = new Map();

  // Called by registerStandaloneBrowserTools after stopManagedCaptureSession is
  // available, so deleteProfile can flush + close any in-progress capture session.
  let _onBeforeDeleteProfile = null;

  // Registry-level mutex: serializes all read-modify-write operations on
  // profiles.json. Prevents lost updates when markTabDestroyed fires while
  // createProfile/ensureProfileRecord is awaiting a CDP call.
  // NOTE: non-reentrant. Callers must not hold this lock while calling another
  // locked function — that would deadlock. touchProfile is the canonical example:
  // it calls getProfile→createProfile (which holds its own lock) and ensureProfileRecord
  // (same) only OUTSIDE its own lock acquisition.
  let _registryMutex = Promise.resolve();
  function withRegistryLock(fn) {
    const prev = _registryMutex;
    let _resolve;
    _registryMutex = new Promise((r) => { _resolve = r; });
    return prev.then(() => Promise.resolve().then(fn)).finally(() => _resolve());
  }

  // 0o700: profile registry root is sensitive (cookies, JWT, HAR). Mode is a noop on Windows.
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  function profileDir(name) {
    return join(dataDir, "profiles", name);
  }

  function trafficFile(name) {
    return join(profileDir(name), "traffic", "traffic.jsonl");
  }

  function websocketFile(name) {
    return join(profileDir(name), "traffic", "websockets.jsonl");
  }

  function eventSourceFile(name) {
    return join(profileDir(name), "traffic", "eventsource.jsonl");
  }

  function eventsFile(name) {
    return join(profileDir(name), "events", "events.jsonl");
  }

  function bodyFile(name, requestId, extension = "body") {
    const safeRequestId = String(requestId || "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_");
    return join(profileDir(name), "bodies", `${safeRequestId}.${extension}`);
  }

  function readRegistry() {
    if (!existsSync(registryFile)) return { profiles: {} };
    try {
      const parsed = JSON.parse(readFileSync(registryFile, "utf8"));
      return {
        profiles:
          parsed && typeof parsed === "object" && parsed.profiles && typeof parsed.profiles === "object"
            ? parsed.profiles
            : {},
      };
    } catch (error) {
      throw new Error(`failed to read profile registry ${registryFile}: ${String(error?.message || error)}`);
    }
  }

  function writeRegistry(state) {
    mkdirSync(dirname(registryFile), { recursive: true, mode: 0o700 });
    const text = `${JSON.stringify(state, null, 2)}\n`;
    const tempFile = `${registryFile}.${process.pid}.${Date.now()}.tmp`;
    const backupFile = `${registryFile}.bak`;
    writeFileSync(tempFile, text, "utf8");
    const fd = openSync(tempFile, "r");
    try {
      fsyncSync(fd);
    } catch (error) {
      // Windows can throw EPERM/EINVAL on fsync of some handles; the rename below
      // still gives atomicity (fsync is only a durability optimization), so tolerate these.
      if (error?.code !== "EPERM" && error?.code !== "EINVAL") throw error;
    } finally {
      closeSync(fd);
    }
    if (existsSync(registryFile)) copyFileSync(registryFile, backupFile);
    renameSync(tempFile, registryFile);
  }

  async function createProfile(raw, options = {}) {
    return withRegistryLock(async () => {
    const name = normalizeProfileName(raw);
    const state = readRegistry();
    const now = new Date().toISOString();
    const existing = state.profiles[name];
    if (existing?.tabId && (existing?.browserContextId || existing?.adoptedAt)) {
      try {
        const target = await ensurePageTarget(cdpPort, existing.tabId);
        // Root cause #6 (2026-06-03 reliability redesign): the runtime registry
        // (profiles.json) and the acquire-time pool (browser-profiles.json) are
        // two separate stores. Reusing existing.tabId without confirming it
        // still lives in THIS profile's browserContextId is how a name ends up
        // bound to another profile's tab ("连错 profile" — wrong cookie jar /
        // storage). For an owned-context profile, verify the live tab's context
        // matches the recorded one; on mismatch treat it as stale and rebuild a
        // fresh tab in the correct stored context below. Adopted tabs have no
        // owned context, so the check is skipped for them.
        if (existing.browserContextId && !existing.adoptedAt) {
          const liveContextId = await targetBrowserContextId(cdpPort, target.id);
          if (liveContextId && liveContextId !== existing.browserContextId) {
            throw new Error(
              `profile ${name} tab ${target.id} is in browserContext ${liveContextId}, expected ${existing.browserContextId} (cross-profile binding guard)`,
            );
          }
        }
        const record = {
          ...existing,
          tabId: target.id,
          title: target.title || existing.title || "",
          url: target.url || existing.url || "about:blank",
          lastUsedAt: now,
        };
        state.profiles[name] = record;
        writeRegistry(state);
        return record;
      } catch {
        // stale tab or context mismatch; create a new one below
      }
    }
    if (!options.url) {
      const record = {
        name,
        tabId: null,
        title: "",
        url: existing?.url || "about:blank",
        browserContextId: existing?.browserContextId || null,
        browserContextOwned: Boolean(existing?.browserContextOwned),
        isolation: existing?.isolation || "browser-context",
        createdAt: existing?.createdAt || now,
        lastUsedAt: now,
        evidenceDir: profileDir(name),
        metadataOnly: true,
      };
      mkdirSync(record.evidenceDir, { recursive: true, mode: 0o700 });
      state.profiles[name] = record;
      writeRegistry(state);
      return record;
    }
    let browserContextId = existing?.browserContextId || await createBrowserContext(cdpPort);
    let target;
    try {
      target = await createPageTarget(cdpPort, options.url || "about:blank", { browserContextId });
    } catch (error) {
      if (!existing?.browserContextId) throw error;
      browserContextId = await createBrowserContext(cdpPort);
      target = await createPageTarget(cdpPort, options.url || "about:blank", { browserContextId });
    }
    const record = {
      name,
      tabId: target.id,
      title: target.title || "",
      url: target.url || options.url || "about:blank",
      browserContextId,
      browserContextOwned: true,
      isolation: "browser-context",
      createdAt: existing?.createdAt || now,
      lastUsedAt: now,
      evidenceDir: profileDir(name),
    };
    mkdirSync(record.evidenceDir, { recursive: true, mode: 0o700 });
    state.profiles[name] = record;
    writeRegistry(state);
    await onProfileReady?.(record);
    return record;
  });
  }

  async function getProfile(raw = "default") {
    return await createProfile(raw);
  }

  function listProfiles() {
    return Object.values(readRegistry().profiles);
  }

  async function deleteProfile(raw) {
    return withRegistryLock(async () => {
    const name = normalizeProfileName(raw);
    const state = readRegistry();
    const existing = state.profiles[name];
    if (!existing) return { ok: true, deleted: false, name };
    // Flush and close any active managed capture session before removing the
    // profile record. Without this the session Map keeps a zombie entry with
    // live CDP listeners that consume memory until the next server restart.
    await _onBeforeDeleteProfile?.(name);
    if (existing.tabId) {
      await cdpJson(cdpPort, `/json/close/${encodeURIComponent(existing.tabId)}`).catch(() => null);
    }
    if (existing.browserContextOwned) {
      await disposeBrowserContext(cdpPort, existing.browserContextId);
    }
    delete state.profiles[name];
    writeRegistry(state);
    try { rmSync(profileDir(name), { recursive: true, force: true }); } catch { /* best-effort disk cleanup */ }
    return { ok: true, deleted: true, name };
  });
  }

  async function touchProfile(raw, patch = {}) {
    const name = normalizeProfileName(raw);
    const existing = readRegistry().profiles[name] || {};
    const usesManagedPlaywright =
      patch.driver === "playwright" ||
      patch.isolation === "managed-playwright" ||
      existing.driver === "playwright" ||
      existing.isolation === "managed-playwright" ||
      String(patch.tabId || existing.tabId || "").startsWith("playwright:");
    if (usesManagedPlaywright) {
      // ensureProfileRecord holds its own lock; no outer lock needed here.
      return await ensureProfileRecord(name, {
        ...patch,
        browserContextId: null,
        browserContextOwned: false,
        isolation: "managed-playwright",
        driver: "playwright",
      });
    }
    // getProfile → createProfile holds its own lock for the CDP portion.
    // Acquire a fresh lock only for the final patch write, re-reading state
    // inside the lock so markTabDestroyed updates aren't overwritten.
    const profile = await getProfile(raw);
    return withRegistryLock(async () => {
      const state = readRegistry();
      const next = {
        ...state.profiles[profile.name] || profile,
        ...patch,
        lastUsedAt: new Date().toISOString(),
      };
      state.profiles[profile.name] = next;
      writeRegistry(state);
      return next;
    });
  }

  async function ensureProfileRecord(raw, patch = {}) {
    return withRegistryLock(async () => {
    const name = normalizeProfileName(raw);
    const state = readRegistry();
    const now = new Date().toISOString();
    const existing = state.profiles[name] || {};
    const next = {
      name,
      tabId: null,
      title: "",
      url: "about:blank",
      createdAt: existing.createdAt || now,
      evidenceDir: profileDir(name),
      ...existing,
      ...patch,
      lastUsedAt: now,
    };
    if (patch.browserContextId === null) delete next.browserContextId;
    if (patch.tabDestroyedAt === null) delete next.tabDestroyedAt;
    mkdirSync(next.evidenceDir, { recursive: true, mode: 0o700 });
    state.profiles[name] = next;
    writeRegistry(state);
    return next;
  });
  }

  async function adoptProfile(raw, target, patch = {}) {
    return withRegistryLock(async () => {
    const name = normalizeProfileName(raw);
    if (!target?.id) throw new Error("target with id is required");
    const state = readRegistry();
    const now = new Date().toISOString();
    const existing = state.profiles[name];
    const browserContextId = patch.browserContextId || await targetBrowserContextId(cdpPort, target.id);
    const record = {
      name,
      tabId: target.id,
      title: target.title || "",
      url: target.url || "about:blank",
      ...(browserContextId ? { browserContextId } : {}),
      browserContextOwned: false,
      isolation: browserContextId ? "browser-context" : "adopted-tab",
      createdAt: existing?.createdAt || now,
      lastUsedAt: now,
      evidenceDir: existing?.evidenceDir || profileDir(name),
      ...patch,
    };
    mkdirSync(record.evidenceDir, { recursive: true, mode: 0o700 });
    state.profiles[name] = record;
    writeRegistry(state);
    await onProfileReady?.(record);
    return record;
  });
  }

  function appendTraffic(raw, entries) {
    const name = normalizeProfileName(raw);
    const file = trafficFile(name);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try { if (statSync(file).size > 100 * 1024 * 1024) renameSync(file, `${file}.1`); } catch { }
    for (const entry of entries) {
      appendFileSync(file, `${JSON.stringify({ ...entry, profile: name })}\n`, { encoding: "utf8", mode: 0o600 });
    }
    return file;
  }

  function appendWebSockets(raw, entries) {
    const name = normalizeProfileName(raw);
    const file = websocketFile(name);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try { if (statSync(file).size > 20 * 1024 * 1024) renameSync(file, `${file}.1`); } catch { }
    for (const entry of entries) {
      appendFileSync(file, `${JSON.stringify({ ...entry, profile: name })}\n`, { encoding: "utf8", mode: 0o600 });
    }
    return file;
  }

  function appendEventSources(raw, entries) {
    const name = normalizeProfileName(raw);
    const file = eventSourceFile(name);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try { if (statSync(file).size > 20 * 1024 * 1024) renameSync(file, `${file}.1`); } catch { }
    for (const entry of entries) {
      appendFileSync(file, `${JSON.stringify({ ...entry, profile: name })}\n`, { encoding: "utf8", mode: 0o600 });
    }
    return file;
  }

  function appendEvent(raw, event) {
    const name = normalizeProfileName(raw);
    const file = eventsFile(name);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try { if (statSync(file).size > 5 * 1024 * 1024) renameSync(file, `${file}.1`); } catch { }
    const payload = {
      timestamp: new Date().toISOString(),
      profile: name,
      ...event,
    };
    appendFileSync(file, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
    return file;
  }

  function writeBody(raw, requestId, body, base64Encoded = false) {
    const name = normalizeProfileName(raw);
    const file = bodyFile(name, requestId, base64Encoded ? "bin" : "txt");
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, base64Encoded ? Buffer.from(String(body || ""), "base64") : String(body || ""), base64Encoded ? { mode: 0o600 } : { encoding: "utf8", mode: 0o600 });
    return file;
  }

  function readTraffic(raw) {
    const name = normalizeProfileName(raw);
    const file = trafficFile(name);
    try {
      return readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  function readWebSockets(raw) {
    const name = normalizeProfileName(raw);
    const file = websocketFile(name);
    try {
      return readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  function readEventSources(raw) {
    const name = normalizeProfileName(raw);
    const file = eventSourceFile(name);
    try {
      return readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  function queryTraffic(raw, filters = {}) {
    const rows = filterNetworkRequests(readTraffic(raw), filters);
    const limit = typeof filters.limit === "number" ? filters.limit : 50;
    return limitNetworkRequests(rows, filters, limit);
  }

  function getTraffic(raw, requestId) {
    const target = String(requestId);
    return readTraffic(raw).find((entry) => String(entry.requestId) === target) || null;
  }

  function getCapture(raw) {
    const name = normalizeProfileName(raw);
    return captureState.get(name) || {
      enabled: false,
      startedAt: null,
      stoppedAt: null,
      label: null,
    };
  }

  function setCapture(raw, patch = {}) {
    const name = normalizeProfileName(raw);
    const next = {
      ...getCapture(name),
      ...patch,
    };
    captureState.set(name, next);
    return next;
  }

  function clearTraffic(raw) {
    return clearCapturedEvidence(raw).trafficFile;
  }

  function clearCapturedEvidence(raw) {
    const name = normalizeProfileName(raw);
    const traffic = trafficFile(name);
    const websocket = websocketFile(name);
    const eventSource = eventSourceFile(name);
    const events = eventsFile(name);
    for (const file of [traffic, websocket, eventSource, events]) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "", { encoding: "utf8", mode: 0o600 });
    }
    const bodiesDir = join(profileDir(name), "bodies");
    if (existsSync(bodiesDir)) {
      for (const entry of readdirSync(bodiesDir, { withFileTypes: true })) {
        if (entry.isFile()) unlinkSync(join(bodiesDir, entry.name));
      }
    }
    return { trafficFile: traffic, websocketFile: websocket, eventSourceFile: eventSource, eventsFile: events, bodiesDir };
  }

  // Root cause #8 (2026-06-03 reliability redesign): when a tab is closed or
  // crashes, the profile record keeps pointing at the dead tabId and the next
  // use either crashed (explicit tabId) or lazily rebuilt. Driven by the
  // Target.targetDestroyed subscription, this proactively clears the dead tabId
  // from any profile bound to it, so the very next getProfile() rebuilds a
  // fresh tab in the same browser context (cookies/storage preserved) instead
  // of operating on a stale handle. Returns the list of affected profile names.
  function markTabDestroyed(tabId) {
    return withRegistryLock(() => {
    if (!tabId) return [];
    const state = readRegistry();
    const affected = [];
    for (const [name, record] of Object.entries(state.profiles)) {
      if (record && record.tabId === tabId) {
        affected.push(name);
        state.profiles[name] = { ...record, tabId: null, tabDestroyedAt: new Date().toISOString() };
      }
    }
    if (affected.length > 0) writeRegistry(state);
    return affected;
  });
  }

  return {
    registryFile,
    profileDir,
    createProfile,
    getProfile,
    listProfiles,
    deleteProfile,
    touchProfile,
    ensureProfileRecord,
    adoptProfile,
    markTabDestroyed,
    setDeleteHook(fn) { _onBeforeDeleteProfile = fn; },
    appendTraffic,
    appendWebSockets,
    appendEventSources,
    appendEvent,
    writeBody,
    queryTraffic,
    getTraffic,
    readWebSockets,
    readEventSources,
    getCapture,
    setCapture,
    clearTraffic,
    clearCapturedEvidence,
  };
}

function registerStandaloneBrowserTools(tools, cdpPort, profileRegistry, defaultProfileName, options = {}) {
  const personalBridgeUrl =
    process.env.AGENT_BROWSER_PERSONAL_URL ||
    process.env.PERSONAL_CHROME_HTTP_URL ||
    "http://127.0.0.1:17337";
  const browserRuntimeIdentity = options.browserRuntimeIdentity || null;
  const recoverManagedCdp = options.ensureManagedCdp || (async () => ({
    browserVersion: null,
    recoveryAttempted: false,
    recovered: false,
    error: null,
  }));
  const managedBrowserProcessSummary = options.browserProcessSummary || (() => null);
  const managedRuntimeIdentity = options.runtimeIdentityFor || (() => browserRuntimeIdentity);
  const managedCdpPortMode = options.cdpPortMode || browserRuntimeIdentity?.cdpPortMode || "fixed";
  // Unified managed browser stack: Playwright drives ALL user interactions and
  // CDP sessions opened on the same Playwright page collect evidence. The raw
  // 9222 CDP interaction path has been collapsed away (engine-collapse): there
  // is exactly one interaction engine and it is always constructed — no env
  // gate. CDP_BROWSER_DRIVER no longer selects a second interaction engine.
  // Note: CDP_BROWSER_USE_CLOAK still controls which browser executable is
  // launched (CloakBrowser vs real Chrome); it does NOT select a different
  // interaction engine (E3.4 — both paths use ManagedPlaywrightDriver).
  const managedPlaywrightDriver = new ManagedPlaywrightDriver({
    userDataRoot: join(options.dataDir || root, "playwright-profiles"),
  });

  // Last backend explicitly selected, kept for diagnostics/reporting ONLY (the
  // activeBackend field surfaced to agents). Routing does NOT read this global —
  // see stickyBackendByProfile for the actual per-call routing input.
  let lastBoundBackend = "managed";
  // Per-profile sticky backend (2026-06-10): once a profile explicitly picks a
  // backend, later signal-less calls on the SAME profile reuse it — so an agent
  // selects the mode once per target and stops repeating --backend on every call.
  // This is the correct fix for root cause #5 (2026-06-03), NOT a regression of
  // it: the OLD sticky was a single GLOBAL var, so with inner roles sharing one
  // worker process (execute() always gets the constant id "agent-cdp-server"),
  // session A picking personal silently poisoned session B's managed calls.
  // Scoping the sticky to the profile removes that bleed — every target uses its
  // own profile (hard rule in operator workflow), so one target picking personal
  // cannot touch another. The default profile deliberately never sticks to personal
  // (it is the unnamed, concurrency-shared slot — personal there stays per-call
  // explicit), which keeps the one shared key safe.
  const stickyBackendByProfile = new Map();
  const managedCaptureSessions = new Map();

  // Hydrate stickyBackend from persisted profile records so backend preference
  // survives server restarts. The default profile is excluded intentionally —
  // it must never stick to personal (concurrency-shared slot).
  for (const p of profileRegistry.listProfiles()) {
    if (p.stickyBackend && normalizeProfileName(p.name) !== normalizeProfileName(defaultProfileName)) {
      stickyBackendByProfile.set(normalizeProfileName(p.name), p.stickyBackend);
    }
  }

  function hasExplicitPersonalSignal(params = {}) {
    const backend = String(params?.backend || "").toLowerCase();
    if (backend === "personal" || backend === "personal-chrome") return true;
    if (params?.personal === true || params?.currentTab === true || params?.useCurrentTab === true) return true;
    return false;
  }

  function hasExplicitManagedSignal(params = {}) {
    const backend = String(params?.backend || "").toLowerCase();
    return backend === "managed" || backend === "managed-cdp";
  }

  // Personal Chrome bridge tools that back each facade tool. A facade tool
  // present here can run on the personal backend; one that is absent has no
  // personal implementation and MUST error rather than silently fall back to
  // the managed browser.
  const PERSONAL_FACADE_ROUTES = {
    browser_tabs: "personal_chrome_tabs",
    browser_tab_close: "personal_chrome_tab_close",
    browser_snapshot: "personal_chrome_active_tab_snapshot",
    browser_text: "personal_chrome_active_tab_snapshot",
    browser_navigate: "personal_chrome_open",
    browser_screenshot: "personal_chrome_screenshot",
    browser_click: "personal_chrome_click",
    browser_hover: "personal_chrome_hover",
    browser_double_click: "personal_chrome_double_click",
    browser_drag: "personal_chrome_drag",
    browser_type: "personal_chrome_type",
    browser_press: "personal_chrome_press",
    browser_select: "personal_chrome_select",
    browser_wait: "personal_chrome_wait",
    browser_upload: "personal_chrome_upload",
    browser_scroll: "personal_chrome_scroll",
    browser_eval: "personal_chrome_eval",
    // Facade tools the bridge exposes under the same name.
    browser_open: "browser_open",
    browser_act: "browser_act",
    browser_inspect: "browser_inspect",
    browser_capture: "browser_capture",
    browser_security_pack: "browser_security_pack",
    browser_auth_boundary: "browser_auth_boundary",
    browser_diff: "browser_diff",
    browser_replay: "browser_replay",
    browser_raw: "browser_raw",
    browser_cookies_set: "personal_chrome_cookies_set",
    browser_cookies_get: "personal_chrome_cookies_get",
    browser_token_flow_trace: "personal_chrome_token_flow_trace",
    browser_token_scan: "personal_chrome_token_scan",
    // A. Network forensics / traffic capture
    browser_capture_start: "personal_chrome_capture_start",
    browser_capture_stop: "personal_chrome_capture_stop",
    browser_capture_clear: "personal_chrome_capture_clear",
    browser_capture_status: "personal_chrome_capture_status",
    browser_capture_bisect: "personal_chrome_capture_bisect",
    profile_traffic_query: "personal_chrome_network_log",
    profile_traffic_summary: "personal_chrome_network_summary",
    profile_network_timeline: "personal_chrome_network_timeline",
    profile_realtime_log: "personal_chrome_realtime_log",
    profile_export_har: "personal_chrome_export_har",
    profile_save_har: "personal_chrome_save_har",
    profile_har_completeness: "personal_chrome_har_completeness",
    profile_traffic_get: "personal_chrome_request_body",
    profile_request_detail: "personal_chrome_request_detail",
    profile_request_payload: "personal_chrome_request_payload",
    profile_request_replay: "personal_chrome_request_replay",
    profile_request_replay_batch: "personal_chrome_request_replay_batch",
    // B. Console / runtime
    browser_console_log: "personal_chrome_console_log",
    browser_console_source_context: "personal_chrome_console_source_context",
    // D. Storage / Cookie / Service Worker
    browser_storage_snapshot: "personal_chrome_storage_snapshot",
    browser_storage_origin_summary: "personal_chrome_storage_origin_summary",
    browser_cookie_summary: "personal_chrome_cookie_summary",
    browser_service_worker_summary: "personal_chrome_service_worker_summary",
    browser_service_worker_detail: "personal_chrome_service_worker_detail",
    browser_application_export: "personal_chrome_application_export",
    browser_indexeddb_list: "personal_chrome_indexeddb_list",
    browser_indexeddb_read: "personal_chrome_indexeddb_read",
    browser_cache_storage_list: "personal_chrome_cache_storage_list",
    browser_cache_entry_get: "personal_chrome_cache_entry_get",
    // E. DOM / Elements
    browser_accessibility_snapshot: "personal_chrome_accessibility_snapshot",
    browser_frame_tree: "personal_chrome_frame_tree",
    browser_elements_snapshot: "personal_chrome_elements_snapshot",
    browser_dom_search: "personal_chrome_dom_search",
    browser_event_listeners: "personal_chrome_event_listeners",
    browser_dom_mutation_watch: "personal_chrome_dom_mutation_watch",
    // F. CDP / Debugger
    browser_cdp_command: "personal_chrome_cdp_command",
    browser_debugger_control: "personal_chrome_debugger_control",
    // H. Sources / Source Map
    browser_sources_list: "personal_chrome_sources_list",
    browser_source_get: "personal_chrome_source_get",
    browser_source_pretty_print: "personal_chrome_source_pretty_print",
    browser_source_map_metadata: "personal_chrome_source_map_metadata",
    browser_source_map_sources: "personal_chrome_source_map_sources",
    browser_source_map_source_get: "personal_chrome_source_map_source_get",
    browser_global_search: "personal_chrome_global_search",
    browser_sources_search: "personal_chrome_sources_search",
    // I. Evidence bundle / workflow composite tools
    browser_evidence_bundle: "personal_chrome_evidence_bundle",
    browser_evidence_manifest: "personal_chrome_evidence_manifest",
    browser_artifact_inspect: "personal_chrome_artifact_inspect",
    browser_artifact_index: "personal_chrome_artifact_index",
    browser_artifact_search: "personal_chrome_artifact_search",
    browser_artifact_read: "personal_chrome_artifact_read",
    browser_evidence_timeline: "personal_chrome_evidence_timeline",
    browser_request_correlation_graph: "personal_chrome_request_correlation_graph",
    browser_capture_diff: "personal_chrome_capture_diff",
    browser_auth_boundary_report: "personal_chrome_auth_boundary_report",
    browser_worker_frame_deep_dive: "personal_chrome_worker_frame_deep_dive",
    browser_security_research_pack: "personal_chrome_security_research_pack",
    // C. Security / page health
    browser_security_summary: "personal_chrome_security_summary",
    browser_page_diagnostics: "personal_chrome_page_diagnostics",
    browser_signal_summary: "personal_chrome_signal_summary",
    browser_issues_log: "personal_chrome_issues_log",
    browser_hard_reload: "personal_chrome_hard_reload",
  };

  function personalRouteSupported(toolName) {
    return Object.prototype.hasOwnProperty.call(PERSONAL_FACADE_ROUTES, toolName);
  }

  // Decide which backend a facade call targets. Order of precedence:
  //   1. explicit personal/managed signal on THIS call wins
  //   2. explicit backend=auto runs the auto-route heuristic (does not read sticky)
  //   3. no signal at all → the profile's sticky backend (set by a prior explicit
  //      call on the SAME profile), else managed
  // The sticky read is scoped to the profile (stickyBackendByProfile), so it
  // cannot bleed across targets the way the old global sticky did (root cause #5).
  // Returns "personal" or "managed".
  function resolveBackendForCall(toolName, params = {}) {
    if (hasExplicitPersonalSignal(params)) return "personal";
    if (hasExplicitManagedSignal(params)) return "managed";
    if (String(params?.backend || "").toLowerCase() === "auto") {
      return shouldAutoRoutePersonal(toolName, params) ? "personal" : "managed";
    }
    const sticky = stickyBackendByProfile.get(normalizeProfileName(params?.profile || defaultProfileName));
    if (sticky) return sticky;
    return "managed";
  }

  // Record the backend an explicit call chose: updates the global diagnostics var
  // AND the per-profile sticky that routing reads. Sticky is scoped to the profile
  // so it cannot bleed across targets (root cause #5 fix). The default profile
  // never sticks to personal — there personal stays per-call explicit, so the one
  // concurrency-shared profile key can never be silently flipped to personal.
  function rememberActiveBackend(params = {}) {
    const profileName = normalizeProfileName(params?.profile || defaultProfileName);
    const isDefaultProfile = profileName === normalizeProfileName(defaultProfileName);
    if (hasExplicitPersonalSignal(params)) {
      lastBoundBackend = "personal";
      if (!isDefaultProfile) {
        stickyBackendByProfile.set(profileName, "personal");
        profileRegistry.ensureProfileRecord(profileName, { stickyBackend: "personal" }).catch(() => {});
      }
    } else if (hasExplicitManagedSignal(params)) {
      lastBoundBackend = "managed";
      stickyBackendByProfile.set(profileName, "managed");
      profileRegistry.ensureProfileRecord(profileName, { stickyBackend: "managed" }).catch(() => {});
    }
    return lastBoundBackend;
  }

  function withBackendParameters(parameters = {}) {
    const next = {
      ...(parameters || {}),
      properties: { ...((parameters && parameters.properties) || {}) },
    };
    next.properties.backend = {
      type: "string",
      enum: ["managed", "managed-cdp", "personal", "personal-chrome", "auto"],
      description: "Browser backend. Use personal/currentTab for the user's already-open Chrome; use managed for isolated CDP profiles.",
    };
    next.properties.personal = { type: "boolean", description: "Shortcut for backend=personal." };
    next.properties.currentTab = { type: "boolean", description: "Route to Personal Chrome's active tab when available." };
    next.properties.useCurrentTab = { type: "boolean", description: "Alias for currentTab." };
    return next;
  }

  function stripBackendParameters(params = {}) {
    const { backend, personal, currentTab, useCurrentTab, ...rest } = params || {};
    return rest;
  }

  function shouldRoutePersonal(params = {}) {
    return hasExplicitPersonalSignal(params);
  }

  function shouldAutoRoutePersonal(toolName, params = {}) {
    const backend = String(params?.backend || "").toLowerCase();
    if (backend !== "auto") return false;
    if (params?.personal === true || params?.currentTab === true || params?.useCurrentTab === true) return true;
    if (!params?.url && ["browser_inspect", "browser_capture", "browser_security_pack", "browser_auth_boundary", "browser_diff"].includes(toolName)) {
      return true;
    }
    return false;
  }

  async function callJson(url, options = {}, timeoutMs = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const text = await response.text();
      let body = {};
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { text };
        }
      }
      return { ok: response.ok, status: response.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  async function personalBridgeHealth(timeoutMs = 2500) {
    try {
      const response = await callJson(`${personalBridgeUrl}/health`, {}, timeoutMs);
      return {
        ok: response.ok && response.body?.ok === true && Number(response.body?.connected || 0) > 0,
        status: response.status,
        url: personalBridgeUrl,
        health: response.body,
      };
    } catch (error) {
      // SF-7: include error type so callers can distinguish network failure from bad response
      return {
        ok: false,
        url: personalBridgeUrl,
        error: String(error?.message || error),
        errorType: error?.name || "Error",
      };
    }
  }

  // Shape normalisation: personal bridge returns raw tool payloads that differ
  // structurally from managed responses. Each entry maps a tool name to a
  // function that takes the raw personal result (response.body) and returns a
  // normalised payload whose top-level fields match the managed response shape.
  // Backward-compatible: original fields inside result.* are preserved; only
  // key fields are additionally hoisted to the top level so agent code works
  // identically regardless of backend. Tools not listed here pass through as-is.
  const PERSONAL_RESPONSE_TRANSFORMS = {
    // A2: managed returns {ok, path, mimeType, bytes, imageInlined, ...} at top level.
    // personal returns {ok, backendRouter, result:{tab, mimeType, path, dataUrlBytes}}.
    // Normalise: hoist path, mimeType, dataUrlBytes. Expose `bytes` as alias for
    // dataUrlBytes so agents can read result.bytes on both backends. Note: for personal
    // backend `bytes` is the base64 char count, not raw PNG size (personal bridge
    // does not decode PNG). Use managed backend if exact byte count is needed.
    browser_screenshot: (raw) => {
      const inner = raw?.result ?? {};
      return {
        ...raw,
        path: inner.path ?? raw.path,
        mimeType: inner.mimeType ?? raw.mimeType,
        dataUrlBytes: inner.dataUrlBytes,
        bytes: inner.dataUrlBytes,
      };
    },
    // A3: managed returns {ok, tabId, url, ...} at top level.
    // personal returns {ok, backendRouter, result:{tab:{id, url, ...}, requestedUrl}}.
    // Normalise: hoist url and tabId to top level.
    browser_navigate: (raw) => {
      const tab = raw?.result?.tab ?? {};
      return {
        ...raw,
        url: tab.url ?? raw.url,
        tabId: tab.id ?? raw.tabId,
      };
    },
    // A4: managed returns {tabs, staleProfiles, summary:{liveTabs,...}} at top level.
    // personal returns {ok, backendRouter, result:{tabs:[...]}} without staleProfiles/summary.
    // Normalise: hoist tabs to top level; staleProfiles/summary are null on personal
    // (profile registry lives in the worker, not the personal bridge).
    browser_tabs: (raw) => {
      const tabs = raw?.result?.tabs ?? [];
      return {
        ...raw,
        tabs,
        staleProfiles: null,
        summary: null,
      };
    },
  };

  async function routeToPersonal(toolName, params = {}) {
    const health = await personalBridgeHealth();
    if (!health.ok) {
      return {
        ok: false,
        backendRouter: "personal-chrome",
        routedFrom: "managed-worker",
        tool: toolName,
        error: "personal_bridge_unavailable",
        personalBridge: health,
        next: [
          "Start the Personal Chrome bridge: npm run personal:chrome",
          "Reload or enable the Agent Browser Runtime Chrome extension in the user's Chrome.",
          "Retry the same browser_* call with backend='personal' or currentTab=true.",
        ],
      };
    }

    const input = stripBackendParameters(params);
    let targetTool = PERSONAL_FACADE_ROUTES[toolName] || toolName;
    let targetInput = input;
    if (toolName === "browser_open" && !input.url) {
      targetTool = "personal_chrome_active_tab_snapshot";
      targetInput = {};
    }
    // browser_text exposes maxChars; the extension's chromeSnapshot reads maxTextLength.
    // Translate here so the caller's limit actually reaches the extension.
    if (toolName === "browser_text" && typeof input.maxChars === "number") {
      const { maxChars, ...rest } = targetInput;
      targetInput = { ...rest, maxTextLength: maxChars };
    }

    try {
      const response = await callJson(
        `${personalBridgeUrl}/tool/${encodeURIComponent(targetTool)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(targetInput || {}),
        },
        Number(params?.timeoutMs || 45000),
      );
      if (!response.ok) {
        const is404 = response.status === 404;
        return {
          ok: false,
          backendRouter: "personal-chrome",
          routedFrom: "managed-worker",
          personalBridge: { ok: true, url: personalBridgeUrl },
          tool: toolName,
          forwardedTool: targetTool,
          status: response.status,
          error: is404 ? "personal_tool_not_supported" : "personal_tool_failed",
          hint: is404
            ? `Personal Chrome extension does not expose tool '${targetTool}'. ` +
              `Update the extension, or switch to managed backend (remove backend:'personal').`
            : undefined,
          // SF-6: fall back to {} when bridge returns an empty error body
          result: response.body ?? {},
        };
      }
      // Apply per-tool shape normalisation so personal responses expose the
      // same top-level fields as managed responses (see PERSONAL_RESPONSE_TRANSFORMS).
      const rawBody = response.body ?? {};
      const baseResult = {
        ok: true,
        backendRouter: "personal-chrome",
        routedFrom: "managed-worker",
        personalBridge: { ok: true, url: personalBridgeUrl },
        tool: toolName,
        forwardedTool: targetTool,
        // SF-6: response.body can be undefined when the bridge returns an empty body; fall back to {}
        result: rawBody,
        next: ["Continue through the unified browser_* facade; switch to backend='managed' only for isolated CDP profiles."],
      };
      const transform = PERSONAL_RESPONSE_TRANSFORMS[toolName];
      return transform ? transform(baseResult) : baseResult;
    } catch (error) {
      return {
        ok: false,
        backendRouter: "personal-chrome",
        routedFrom: "managed-worker",
        personalBridge: { ok: true, url: personalBridgeUrl },
        tool: toolName,
        forwardedTool: targetTool,
        error: String(error?.message || error),
      };
    }
  }

  // Returns a result object when the call must NOT run on the managed browser
  // (either it routes to personal, or personal was requested for a tool that
  // has no personal implementation -> explicit error). Returns null when the
  // call should proceed on the managed backend as usual.
  function personalUnsupportedError(toolName, reason) {
    return {
      ok: false,
      backendRouter: "personal-chrome",
      routedFrom: "managed-worker",
      tool: toolName,
      error: "action_unavailable_on_personal_backend",
      reason,
      activeBackend: lastBoundBackend,
      next: [
        `${toolName} has no Personal Chrome implementation; it will not silently run on the managed browser.`,
        "Use a supported personal action (browser_click, browser_type, browser_scroll, browser_snapshot, browser_screenshot, browser_eval) on backend=personal,",
        "or pass backend=managed explicitly to run this action on the isolated managed browser.",
      ],
    };
  }

  async function maybeRoutePersonal(toolName, params = {}) {
    // Any explicit backend signal on this call updates the profile's sticky
    // backend, so the agent picks the mode once per target and later signal-less
    // calls on the same profile reuse it — no more repeating --backend per call.
    // No signal + no sticky resolves to managed (the safe default: the isolated
    // sandbox, never the user's real Chrome).
    rememberActiveBackend(params);
    const backend = resolveBackendForCall(toolName, params);
    if (backend !== "personal") return null;
    if (!personalRouteSupported(toolName)) {
      // Personal was intended (explicit signal or the profile's sticky backend)
      // but this tool cannot reach a personal tab. Fail loud instead of silently
      // routing back to the managed browser (the wrong window).
      return personalUnsupportedError(
        toolName,
        hasExplicitPersonalSignal(params)
          ? "explicit backend=personal but tool has no personal route"
          : `sticky backend is personal but ${toolName} has no personal route`,
      );
    }
    return await routeToPersonal(toolName, params);
  }

  async function resolveProfile(raw) {
    return await profileRegistry.ensureProfileRecord(raw || defaultProfileName, {
      browserContextId: null,
      browserContextOwned: false,
      isolation: "managed-playwright",
      driver: "playwright",
    });
  }

  async function runManagedPlaywrightAction({ profile, eventType, waitMs = 700, event = {}, action }) {
    return await managedPlaywrightDriver.withCdpClient(profile.name, async (client, pageHandle) => {
      // Auto-recover capture if the browser was closed and Playwright silently
      // re-launched it: withCdpClient just gave us a fresh page on a NEW
      // browser process, the old persistent capture session has already been
      // dropped by its disconnect handler (see startManagedCaptureSession),
      // and without re-arming it captureNetworkForProfile would record
      // everything but throw it away because capture.enabled flips to false
      // when the session vanishes. This makes navigate / click / type "just
      // work" even after the user manually closes the browser window — no
      // need for the agent to remember to call browser_open or capture start
      // a second time.
      if (!managedCaptureSessions.has(profile.name)) {
        try {
          await startManagedCaptureSession(profile);
        } catch (err) {
          // Fail-open: a re-arm failure must not block the action itself.
          // The agent will see capturedTraffic=0 on the next read and can
          // call browser_capture_start explicitly to surface the real error.
          console.warn(`[capture-rearm] auto-rearm failed for profile ${profile.name}:`, err?.message || err);
        }
      }
      const capture = await captureNetworkForProfile(client, profile.name, () => action(pageHandle), waitMs);
      const result = capture.result || {};
      await profileRegistry.ensureProfileRecord(profile.name, {
        tabId: result.tabId || pageHandle.tabId,
        title: result.title || "",
        url: result.url || "about:blank",
        browserContextId: null,
        browserContextOwned: false,
        isolation: "managed-playwright",
        driver: "playwright",
        tabDestroyedAt: null,
      });
      const eventFile = profileRegistry.appendEvent(profile.name, {
        type: eventType,
        tabId: result.tabId || pageHandle.tabId,
        url: result.url,
        result: { ...result, base64: undefined },
        capturedTraffic: capture.capturedTraffic,
        trafficFile: capture.trafficFile,
        driver: "playwright",
        ...event,
      });
      return { ...capture, eventFile };
    });
  }

  async function withManagedPageClient(profile, tabId, fn) {
    return await managedPlaywrightDriver.withCdpClient(profile.name, async (client, pageHandle) => {
      const summary = await managedPlaywrightDriver.pageSummary(pageHandle);
      await profileRegistry.ensureProfileRecord(profile.name, {
        tabId: pageHandle.tabId,
        title: summary.title || "",
        url: summary.url || "about:blank",
        browserContextId: null,
        browserContextOwned: false,
        isolation: "managed-playwright",
        driver: "playwright",
        tabDestroyedAt: null,
      });
      return await fn(client, {
        id: pageHandle.tabId,
        title: summary.title,
        url: summary.url,
        type: "page",
      });
    });
  }

  const MAX_FRAMES_PER_SOCKET = 5000;

  async function installNetworkRecorder(client, profileName) {
    const entries = new Map();
    const redirects = new Map();
    const websockets = new Map();
    const eventSources = [];
    const bodyPromises = [];
    const cleanups = [];
    const record = (requestId, patch) => {
      const existing = entries.get(requestId) || { requestId, timestamp: new Date().toISOString() };
      entries.set(requestId, { ...existing, ...patch });
    };
    const listen = (register, handler) => {
      const cleanup = register(handler);
      if (typeof cleanup === "function") cleanups.push(cleanup);
    };
    await client.Network.enable({
      maxTotalBufferSize: 100000000,
      maxResourceBufferSize: 50000000,
      maxPostDataSize: 50000000,
    });
    listen(client.Network.requestWillBeSent.bind(client.Network), (event) => {
      if (event.redirectResponse) {
        const chain = redirects.get(event.requestId) || [];
        chain.push({
          timestamp: new Date().toISOString(),
          url: event.redirectResponse.url,
          status: event.redirectResponse.status,
          statusText: event.redirectResponse.statusText,
          headers: event.redirectResponse.headers,
          mimeType: event.redirectResponse.mimeType,
          protocol: event.redirectResponse.protocol,
          remoteIPAddress: event.redirectResponse.remoteIPAddress,
          remotePort: event.redirectResponse.remotePort,
          securityDetails: event.redirectResponse.securityDetails,
        });
        redirects.set(event.requestId, chain);
      }
      record(event.requestId, {
        url: event.request?.url,
        method: event.request?.method,
        requestHeaders: event.request?.headers,
        hasPostData: event.request?.hasPostData,
        postData: event.request?.postData,
        postDataLength: event.request?.postData ? String(event.request.postData).length : undefined,
        resourceType: event.type,
        frameId: event.frameId,
        initiatorType: event.initiator?.type,
        initiator: event.initiator,
        documentURL: event.documentURL,
        loaderId: event.loaderId,
        redirectChain: redirects.get(event.requestId) || [],
      });
    });
    listen(client.Network.responseReceived.bind(client.Network), (event) => {
      record(event.requestId, {
        status: event.response?.status,
        statusText: event.response?.statusText,
        mimeType: event.response?.mimeType,
        responseHeaders: event.response?.headers,
        timing: event.response?.timing,
        protocol: event.response?.protocol,
        fromDiskCache: event.response?.fromDiskCache,
        fromServiceWorker: event.response?.fromServiceWorker,
        remoteIPAddress: event.response?.remoteIPAddress,
        remotePort: event.response?.remotePort,
        securityDetails: event.response?.securityDetails,
      });
    });
    listen(client.Network.requestWillBeSentExtraInfo.bind(client.Network), (event) => {
      record(event.requestId, {
        requestWillBeSentExtraInfoSeen: true,
        associatedCookies: event.associatedCookies,
        blockedRequestCookies: event.blockedCookies,
        requestHeaders: event.headers,
        requestHeadersText: event.headersText,
        connectTiming: event.connectTiming,
        clientSecurityState: event.clientSecurityState,
        siteHasCookieInOtherPartition: event.siteHasCookieInOtherPartition,
      });
    });
    listen(client.Network.responseReceivedExtraInfo.bind(client.Network), (event) => {
      record(event.requestId, {
        responseReceivedExtraInfoSeen: true,
        extraInfoStatusCode: event.statusCode,
        responseHeaders: event.headers,
        responseHeadersText: event.headersText,
        blockedResponseCookies: event.blockedCookies,
        resourceIPAddressSpace: event.resourceIPAddressSpace,
        cookiePartitionKey: event.cookiePartitionKey,
        cookiePartitionKeyOpaque: event.cookiePartitionKeyOpaque,
      });
    });
    listen(client.Network.loadingFailed.bind(client.Network), (event) => {
      record(event.requestId, {
        failed: true,
        failReason: event.errorText,
        blockedReason: event.blockedReason,
      });
    });
    listen(client.Network.loadingFinished.bind(client.Network), (event) => {
      const existing = entries.get(event.requestId);
      if (!existing) return;
      record(event.requestId, {
        finishedAt: new Date().toISOString(),
        encodedDataLength: event.encodedDataLength,
      });
      const bodyPromise = (async () => {
        try {
          const body = await client.Network.getResponseBody({ requestId: event.requestId });
          // Body is persisted unconditionally — consistent with Fix D which removed
          // the capture.enabled gate on appendTraffic. Previously this gate caused
          // body files to never be written unless browser_capture_start was called.
          const bodyPath = profileRegistry.writeBody(profileName, event.requestId, body.body, body.base64Encoded);
          record(event.requestId, {
            bodyReadable: true,
            bodyUnavailable: false,
            bodyBase64Encoded: body.base64Encoded,
            bodyText: body.base64Encoded ? undefined : body.body,
            bodyPath,
            bodyBytes: body.base64Encoded ? Buffer.from(body.body, "base64").length : Buffer.byteLength(body.body || "", "utf8"),
          });
        } catch (error) {
          record(event.requestId, {
            bodyReadable: false,
            bodyUnavailable: true,
            bodyError: String(error?.message || error),
          });
        }
      })();
      bodyPromises.push(bodyPromise);
    });
    const recordWebSocket = (requestId, method, event) => {
      const timestamp = new Date().toISOString();
      const socket = websockets.get(requestId) || {
        requestId,
        createdAt: timestamp,
        url: event.url,
        frames: [],
        events: [],
      };
      socket.updatedAt = timestamp;
      if (event.url) socket.url = event.url;
      if (method === "Network.webSocketCreated") {
        socket.url = event.url;
        socket.initiator = event.initiator;
      } else if (method === "Network.webSocketWillSendHandshakeRequest") {
        socket.requestHeaders = event.request?.headers;
        socket.wallTime = event.wallTime;
      } else if (method === "Network.webSocketHandshakeResponseReceived") {
        socket.status = event.response?.status;
        socket.statusText = event.response?.statusText;
        socket.responseHeaders = event.response?.headers;
      } else if (method === "Network.webSocketFrameSent" || method === "Network.webSocketFrameReceived") {
        if (socket.frames.length < MAX_FRAMES_PER_SOCKET) {
          socket.frames.push({
            timestamp,
            direction: method === "Network.webSocketFrameSent" ? "sent" : "received",
            opcode: event.response?.opcode,
            mask: event.response?.mask,
            payloadData: event.response?.payloadData,
            payloadLength: event.response?.payloadData ? String(event.response.payloadData).length : 0,
          });
        }
      } else if (method === "Network.webSocketFrameError") {
        socket.errorMessage = event.errorMessage;
      } else if (method === "Network.webSocketClosed") {
        socket.closedAt = timestamp;
      }
      socket.events.push({ timestamp, method, ...event });
      websockets.set(requestId, socket);
    };
    listen(client.Network.webSocketCreated.bind(client.Network), (event) => recordWebSocket(event.requestId, "Network.webSocketCreated", event));
    listen(client.Network.webSocketWillSendHandshakeRequest.bind(client.Network), (event) => recordWebSocket(event.requestId, "Network.webSocketWillSendHandshakeRequest", event));
    listen(client.Network.webSocketHandshakeResponseReceived.bind(client.Network), (event) => recordWebSocket(event.requestId, "Network.webSocketHandshakeResponseReceived", event));
    listen(client.Network.webSocketFrameSent.bind(client.Network), (event) => recordWebSocket(event.requestId, "Network.webSocketFrameSent", event));
    listen(client.Network.webSocketFrameReceived.bind(client.Network), (event) => recordWebSocket(event.requestId, "Network.webSocketFrameReceived", event));
    listen(client.Network.webSocketFrameError.bind(client.Network), (event) => recordWebSocket(event.requestId, "Network.webSocketFrameError", event));
    listen(client.Network.webSocketClosed.bind(client.Network), (event) => recordWebSocket(event.requestId, "Network.webSocketClosed", event));
    listen(client.Network.eventSourceMessageReceived.bind(client.Network), (event) => {
      eventSources.push({
        timestamp: new Date().toISOString(),
        requestId: event.requestId,
        eventName: event.eventName,
        eventId: event.eventId,
        data: event.data,
        dataLength: event.data ? String(event.data).length : 0,
      });
    });

    async function snapshot() {
      await Promise.allSettled(bodyPromises);
      bodyPromises.splice(0, bodyPromises.length);
      return {
        rows: [...entries.values()].filter((entry) => entry.url),
        websocketRows: [...websockets.values()],
        eventSourceRows: [...eventSources],
      };
    }

    function clearBuffered() {
      entries.clear();
      redirects.clear();
      websockets.clear();
      eventSources.splice(0, eventSources.length);
      bodyPromises.splice(0, bodyPromises.length);
    }

    function detach() {
      for (const cleanup of cleanups.splice(0).reverse()) {
        try {
          cleanup();
        } catch (err) {
          // SF-3: log cleanup errors so CDP listener leaks don't go completely silent
          console.warn("[capture detach] cleanup error (non-fatal):", err?.message || err);
        }
      }
    }

    return { snapshot, clearBuffered, detach };
  }

  async function stopManagedCaptureSession(profileName, reason = "stop") {
    const name = normalizeProfileName(profileName || defaultProfileName);
    const session = managedCaptureSessions.get(name);
    if (!session) return { active: false, reason };
    managedCaptureSessions.delete(name);
    let rows = [];
    let websocketRows = [];
    let eventSourceRows = [];
    let snapshotError = null;
    session.recorder.detach();
    try {
      ({ rows, websocketRows, eventSourceRows } = await session.recorder.snapshot());
    } catch (error) {
      snapshotError = String(error?.message || error);
    }
    await session.client.close().catch(() => {});
    const trafficFile = rows.length ? profileRegistry.appendTraffic(name, rows) : null;
    const websocketFile = websocketRows.length ? profileRegistry.appendWebSockets(name, websocketRows) : null;
    const eventSourceFile = eventSourceRows.length ? profileRegistry.appendEventSources(name, eventSourceRows) : null;
    return {
      active: true,
      reason,
      tabId: session.tabId,
      startedAt: session.startedAt,
      stoppedAt: new Date().toISOString(),
      capturedTraffic: rows.length,
      capturedWebSockets: websocketRows.length,
      capturedEventSourceMessages: eventSourceRows.length,
      trafficFile,
      websocketFile,
      eventSourceFile,
      snapshotError,
    };
  }

  // Wire the delete hook so profileRegistry.deleteProfile flushes any active
  // managed capture session and closes the Playwright browser context before
  // removing the profile record. Without the context close, the browser process
  // and its userDataDir stay alive until the next server restart.
  profileRegistry.setDeleteHook(async (name) => {
    await stopManagedCaptureSession(name, "profile-deleted").catch(() => {});
    await managedPlaywrightDriver.closeProfile(name).catch(() => {});
  });

  async function startManagedCaptureSession(profile) {
    await stopManagedCaptureSession(profile.name, "restart");
    const { client, handle } = await managedPlaywrightDriver.openCdpClient(profile.name);
    let recorder;
    try {
      recorder = await installNetworkRecorder(client, profile.name);
      const startedAt = new Date().toISOString();
      // When the underlying browser dies (user closes window, Windows update
      // kills it, Stop-Process, etc.) chrome-remote-interface fires
      // "disconnect" on this client. Without this listener the session stays
      // in managedCaptureSessions as a zombie pointing at a dead client and
      // every subsequent action thinks capture is still running while traffic
      // silently goes nowhere. Removing the session here turns the next
      // runManagedPlaywrightAction into "no active session → auto-start",
      // which transparently brings capture back online on the freshly
      // re-launched browser.
      client.on("disconnect", () => {
        const current = managedCaptureSessions.get(profile.name);
        if (current && current.client === client) {
          managedCaptureSessions.delete(profile.name);
        }
      });
      managedCaptureSessions.set(profile.name, { client, recorder, tabId: handle.tabId, startedAt });
      const summary = await managedPlaywrightDriver.pageSummary(handle);
      await profileRegistry.ensureProfileRecord(profile.name, {
        tabId: handle.tabId,
        title: summary.title || "",
        url: summary.url || "about:blank",
        browserContextId: null,
        browserContextOwned: false,
        isolation: "managed-playwright",
        driver: "playwright",
        tabDestroyedAt: null,
      });
      return { active: true, tabId: handle.tabId, startedAt, driver: "playwright" };
    } catch (error) {
      // Clean up any partial state so we don't leave a zombie session in the Map
      // or orphaned CDP event listeners on the recorder.
      managedCaptureSessions.delete(profile.name);
      if (recorder) recorder.detach();
      await client.close().catch(() => {});
      throw error;
    }
  }

  function clearManagedCaptureSessionBuffer(profileName) {
    const name = normalizeProfileName(profileName || defaultProfileName);
    const session = managedCaptureSessions.get(name);
    if (session) session.recorder.clearBuffered();
    return Boolean(session);
  }

  async function captureNetworkForProfile(client, profileName, action, waitMs = 800) {
    const recorder = await installNetworkRecorder(client, profileName);
    let result;
    try {
      result = await action();
      // Smart wait: if action detected a SPA change (DOM changed but no URL change),
      // the 150ms SPA reaction window is already baked into the click fingerprint check.
      // Only the full settle wait is useful when a real navigation fired.
      const smartWait =
        (result?.effective === true && result?.evidence?.urlChanged === false)
          ? Math.min(waitMs, 50)   // SPA: just flush any in-flight XHR, don't over-wait
          : waitMs;                 // Navigation or no-effect: keep original wait
      await sleep(smartWait);
    } finally {
      recorder.detach();
    }
    const { rows, websocketRows, eventSourceRows } = await recorder.snapshot();
    // Every action's observed traffic is now persisted unconditionally.
    // The old capture.enabled gate meant profile_traffic_query always returned 0
    // unless the agent explicitly called browser_capture_start first.
    // browser_capture_start still adds value for clear:true (wipe before focused
    // capture) and for the persistent CDP session it manages.
    const trafficFile = rows.length ? profileRegistry.appendTraffic(profileName, rows) : null;
    const websocketFile = websocketRows.length ? profileRegistry.appendWebSockets(profileName, websocketRows) : null;
    const eventSourceFile = eventSourceRows.length ? profileRegistry.appendEventSources(profileName, eventSourceRows) : null;
    return {
      result,
      observedTraffic: rows.length,
      observedWebSockets: websocketRows.length,
      observedEventSourceMessages: eventSourceRows.length,
      recordedTraffic: rows.length,
      capturedTraffic: rows.length,
      captureEnabled: profileRegistry.getCapture(profileName).enabled,
      trafficFile,
      websocketFile,
      eventSourceFile,
    };
  }

  async function runProfileAction({ client, profile, eventType, action, waitMs = 700, event = {} }) {
    const capture = await captureNetworkForProfile(client, profile.name, action, waitMs);
    const eventFile = profileRegistry.appendEvent(profile.name, {
      type: eventType,
      tabId: event.tabId,
      url: event.url,
      result: capture.result,
      capturedTraffic: capture.capturedTraffic,
      trafficFile: capture.trafficFile,
      ...event,
    });
    return { ...capture, eventFile };
  }

  function clickWaitPlan(params = {}, defaultWaitMs = 700) {
    const rawMode = String(params.waitMode || params.waitFor || "settle").toLowerCase();
    const normalized =
      ["none", "immediate", "nowait", "no-wait"].includes(rawMode) ? "none"
      : ["spa", "same-page", "samepage", "no-navigation", "nonavigation"].includes(rawMode) ? "no-navigation"
      : "settle";
    const explicitWait = typeof params.waitMs === "number";
    const waitMs =
      explicitWait ? Math.min(Math.max(0, params.waitMs), 60_000)
      : normalized === "none" ? 0
      : normalized === "no-navigation" ? 120
      : defaultWaitMs;
    return {
      waitMode: normalized,
      waitMs,
      observeAfter: params.observeAfter === true || params.returnSnapshot === true || normalized === "no-navigation",
      guidance:
        normalized === "no-navigation"
          ? "Same-page/SPAs usually do not fire a full page load. Verify the result with afterObservation, browser_snapshot, browser_inspect, or a focused browser_eval."
          : normalized === "none"
            ? "No post-click wait was requested. Use this for rapid clicks or when another tool will immediately observe the result."
            : "Default settle mode waits briefly after the click to capture traffic and page changes.",
    };
  }

  function actionTimeoutMs(params = {}, fallback = 8000) {
    const raw = params.actionTimeoutMs ?? params.timeoutMs;
    if (raw === undefined || raw === null || raw === true) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(0, Math.min(30_000, value));
  }

  function summarizeTargetForRegistry(target) {
    return {
      id: target.id,
      title: target.title || "",
      url: target.url || "about:blank",
    };
  }

  async function profileTargetStatus() {
    const cdpPages = await listPageTargets(cdpPort);
    const playwrightPages = await managedPlaywrightDriver.listPages();
    const pages = [...cdpPages, ...playwrightPages];
    const pageById = new Map(pages.map((target) => [target.id, target]));
    const profiles = profileRegistry.listProfiles().map((profile) => {
      const target = profile.tabId ? pageById.get(profile.tabId) : null;
      const status = target ? "attached" : profile.tabId ? "stale" : "unbound";
      return {
        ...profile,
        status,
        attached: Boolean(target),
        stale: status === "stale",
        currentTarget: target ? summarizeTargetForRegistry(target) : null,
      };
    });
    const profileNamesByTab = new Map();
    for (const profile of profiles) {
      if (!profile.tabId) continue;
      const names = profileNamesByTab.get(profile.tabId) || [];
      names.push(profile.name);
      profileNamesByTab.set(profile.tabId, names);
    }
    return { pages, profiles, profileNamesByTab };
  }

  function findAdoptableTarget(pages, params = {}) {
    const tabId = params?.tabId ? String(params.tabId) : "";
    const urlContains = params?.urlContains ? String(params.urlContains).toLowerCase() : "";
    const titleContains = params?.titleContains ? String(params.titleContains).toLowerCase() : "";
    let candidates = pages.filter((target) => target.url !== "devtools://devtools/bundled/devtools_app.html");
    if (tabId) candidates = candidates.filter((target) => target.id === tabId);
    if (urlContains) candidates = candidates.filter((target) => String(target.url || "").toLowerCase().includes(urlContains));
    if (titleContains) candidates = candidates.filter((target) => String(target.title || "").toLowerCase().includes(titleContains));
    if (params?.preferNonBlank !== false) {
      const nonBlank = candidates.filter((target) => target.url && target.url !== "about:blank");
      if (nonBlank.length) candidates = nonBlank;
    }
    if (params?.latest === false) return candidates[0] || null;
    return candidates[candidates.length - 1] || null;
  }

  function resumableUrlFromProfile(profile, fallbackUrl = "about:blank") {
    const url = String(profile?.url || fallbackUrl || "about:blank");
    if (/^https?:\/\//i.test(url) || /^data:/i.test(url) || url === "about:blank") return url;
    return "about:blank";
  }


  registerEvidenceCaptureTools({ tools, profileRegistry, sleep, resolveProfile, withManagedPageClient, startManagedCaptureSession, stopManagedCaptureSession, clearManagedCaptureSessionBuffer, managedCaptureSessions, maybeRoutePersonal });

  registerEvidenceConsoleTools({ tools, profileRegistry, sleep, resolveProfile, withManagedPageClient, maybeRoutePersonal });


  async function executeProfileRequestReplayBatch(params = {}) {
    const profile = await resolveProfile(params?.profile);
    const request = profileRegistry.getTraffic(profile.name, params?.requestId);
    if (!request) throw new Error(`request not found: ${params?.requestId}`);
    const variants = Array.isArray(params?.variants) ? params.variants.slice(0, Math.max(1, Math.min(50, Number(params?.maxVariants || params.variants.length)))) : [];
    if (!variants.length) throw new Error("variants must contain at least one replay variant");
    return withManagedPageClient(profile, profile.tabId, async (client, target) => {
        const results = [];
        for (let index = 0; index < variants.length; index += 1) {
          const variant = variants[index] || {};
          const url = variant.url || request.url;
          const method = String(variant.method || request.method || "GET").toUpperCase();
          const removeHeaders = Array.isArray(variant.removeHeaders) ? Object.fromEntries(variant.removeHeaders.map((name) => [name, null])) : {};
          const headerPrep = prepareReplayHeaders(request.requestHeaders || {}, { ...removeHeaders, ...(variant.headers || {}) });
          const bodyPrep = buildReplayBody(variant, request, headerPrep.headers);
          const includeBody = !["GET", "HEAD"].includes(method) && bodyPrep.bodyKind !== "none";
          const result = await client.Runtime.evaluate({
            expression: `(async () => {
              const replay = ${JSON.stringify({
                url,
                method,
                headers: headerPrep.headers,
                body: bodyPrep.body,
                bodyKind: bodyPrep.bodyKind,
                includeBody,
                credentials: variant.credentials || params?.credentials || "include",
              })};
              function buildBody(replay) {
                if (!replay.includeBody) return undefined;
                if (replay.bodyKind === "multipart") {
                  const form = new FormData();
                  for (const [key, value] of Object.entries(replay.body.fields || {})) {
                    if (Array.isArray(value)) {
                      for (const item of value) form.append(key, String(item));
                    } else {
                      form.append(key, String(value));
                    }
                  }
                  for (const file of replay.body.files || []) {
                    const blob = new Blob([file.content || ""], { type: file.type || "application/octet-stream" });
                    form.append(file.field || "file", blob, file.filename || "upload.bin");
                  }
                  return form;
                }
                return replay.body;
              }
              const startedAt = new Date().toISOString();
              const response = await fetch(replay.url, {
                method: replay.method,
                headers: replay.headers,
                credentials: replay.credentials,
                cache: "no-store",
                redirect: "follow",
                ...(replay.includeBody ? { body: buildBody(replay) } : {}),
              });
              const text = await response.text();
              return {
                ok: response.ok,
                startedAt,
                finishedAt: new Date().toISOString(),
                url: response.url,
                redirected: response.redirected,
                status: response.status,
                statusText: response.statusText,
                headers: Object.fromEntries(response.headers.entries()),
                bodyText: text,
                bodyBytes: text.length,
              };
            })()`,
            returnByValue: true,
            awaitPromise: true,
          });
          const response = result.result?.value || null;
          const replayRequest = {
            url,
            method,
            headers: headerPrep.headers,
            bodyKind: bodyPrep.bodyKind,
            skippedHeaders: headerPrep.skipped,
            removedHeaders: headerPrep.removed,
            skippedHeaderNames: headerPrep.skipped.map((entry) => entry.name),
            bodyLength: includeBody ? bodyPrep.bodyLength : 0,
            contentTypeNote: bodyPrep.contentTypeNote || null,
            credentials: variant.credentials || params?.credentials || "include",
          };
          results.push({
            index,
            label: variant.label || `variant-${index + 1}`,
            replayRequest,
            replayBoundary: buildReplayBoundaryEvidence({ originalRequest: request, replayRequest, headerPrep, bodyPrep, includeBody }),
            response,
            responseDiff: response ? diffReplayResponse(request, response, params?.maxBodyPreview) : null,
            exception: result.exceptionDetails,
          });
        }
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          originalRequest: request,
          variantCount: results.length,
          results,
        };
      });
  }

  registerRealtimeHarTools({ tools, profileRegistry, resolveProfile, maybeRoutePersonal });

  registerInteractionTools({ tools, profileRegistry, defaultProfileName, managedPlaywrightDriver, resolveProfile, withManagedPageClient, maybeRoutePersonal, runManagedPlaywrightAction, clickWaitPlan, actionTimeoutMs, profileTargetStatus });

  registerSnapshotDomTools({ tools, profileRegistry, managedPlaywrightDriver, resolveProfile, withManagedPageClient, resolveNodeIdForSelector, maybeRoutePersonal, runProfileAction, runManagedPlaywrightAction, selectInFramePageFunction, styleInFramePageFunction, domSearchFallbackPageFunction, frameAccessPageFunction, frameShadowBoundaryPageFunction, domMutationWatchPageFunction });

  registerPageHealthTools({ tools, profileRegistry, resolveProfile, withManagedPageClient, captureNetworkForProfile, maybeRoutePersonal });

  registerApplicationStorageTools({ tools, cdpPort, profileRegistry, resolveProfile, withManagedPageClient, cdpJson, managedPlaywrightDriver, maybeRoutePersonal });

  registerDeepEvidenceTools({ tools, profileRegistry, resolveProfile, withManagedPageClient, sleep, tokenFlowTracePageFunction, sourceMatches, buildSourceSearchDrilldowns, debuggerPausedSummary, maybeRoutePersonal });

  tools.set("browser_global_search", {
    name: "browser_global_search",
    description: "Search F12 evidence surfaces for a literal query across Network records, parsed Sources, Storage, IndexedDB samples, and Cache metadata.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the server default profile." },
        tabId: { type: "string", description: "CDP tab ID. Defaults to the profile's current tab." },
        query: { type: "string", description: "Required. Literal string to search across all enabled evidence surfaces." },
        caseSensitive: { type: "boolean", description: "If true, match is case-sensitive. Default false." },
        contextChars: { type: "number", description: "Characters of surrounding context to include around each match. Default 120." },
        maxMatches: { type: "number", description: "Maximum total matches to return across all surfaces. Default 80." },
        maxScripts: { type: "number", description: "Maximum number of source scripts to search. Default 200." },
        maxNetworkRecords: { type: "number", description: "Maximum network records to scan. Default 1000." },
        maxIndexedDbRecords: { type: "number", description: "Maximum IndexedDB sample records to scan. Default 20." },
        maxCacheEntries: { type: "number", description: "Maximum CacheStorage entries to scan. Default 50." },
        includeCacheBodies: { type: "boolean", description: "If true, fetch and search CacheStorage response bodies. Default false." },
        maxCacheBodyChars: { type: "number", description: "Maximum characters to read from each cache response body. Default 50000." },
        includeNetwork: { type: "boolean", description: "Search captured Network records (URL, headers, postData). Default true." },
        includeSources: { type: "boolean", description: "Search parsed JavaScript source scripts. Default true." },
        includeStorage: { type: "boolean", description: "Search localStorage, sessionStorage, cookies, and IndexedDB samples. Default true." },
        reloadSources: { type: "boolean", description: "Re-fetch source scripts from CDP before searching. Default false." },
        ignoreCache: { type: "boolean", description: "Bypass Chrome's response cache when reloading sources. Default false." },
        waitMs: { type: "number", description: "Milliseconds to wait for async evidence collection before searching. Default 0." },
      },
      required: ["query"],
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_global_search", params);
      if (routed) return toolResult(routed);
      if (!params?.query) throw new Error("query is required");
      const profile = await resolveProfile(params?.profile);
      const query = String(params.query);
      const maxMatches = typeof params?.maxMatches === "number" ? Math.min(Math.max(1, params.maxMatches), 10_000) : 80;
      const options = {
        caseSensitive: Boolean(params?.caseSensitive),
        contextChars: typeof params?.contextChars === "number" ? Math.min(Math.max(1, params.contextChars), 10_000) : 120,
        maxMatches,
      };
      const results = [];
      const searched = { networkRecords: 0, scripts: 0, storage: false, applicationExport: false, applicationExportPath: null };

      if (params?.includeNetwork !== false) {
        const records = profileRegistry.queryTraffic(profile.name, { limit: typeof params?.maxNetworkRecords === "number" ? Math.min(Math.max(1, params.maxNetworkRecords), 10_000) : 1000 });
        searched.networkRecords = records.length;
        for (const record of records) {
          if (results.length >= maxMatches) break;
          pushTextSearchMatches(results, {
            category: "network",
            source: "request",
            locator: { requestId: record.requestId, url: record.url, method: record.method, status: record.status, field: "request-record-json" },
            text: JSON.stringify({
              url: record.url,
              method: record.method,
              status: record.status,
              requestHeaders: record.requestHeaders,
              responseHeaders: record.responseHeaders,
              postData: record.postData,
              bodyText: record.bodyText,
              mimeType: record.mimeType,
              initiator: record.initiator,
            }),
            query,
            options,
          });
        }
      }

      if (params?.includeSources !== false && results.length < maxMatches) {
        await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
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
              sourceMapURL: event.sourceMapURL,
              hasSourceURL: event.hasSourceURL,
              isModule: event.isModule,
              length: event.length,
            });
          });
          if (params?.reloadSources !== false) {
            await client.Page.enable();
            await client.Page.reload({ ignoreCache: Boolean(params?.ignoreCache) });
            await sleep(typeof params?.waitMs === "number" ? Math.min(Math.max(0, params.waitMs), 60_000) : 1000);
          } else {
            await sleep(300);
          }
          const rows = [...scripts.values()].slice(-(typeof params?.maxScripts === "number" ? Math.min(Math.max(1, params.maxScripts), 10_000) : 150));
          searched.scripts = rows.length;
          for (const script of rows) {
            if (results.length >= maxMatches) break;
            let source = null;
            try {
              source = await client.Debugger.getScriptSource({ scriptId: script.scriptId });
            } catch {
              continue;
            }
            pushTextSearchMatches(results, {
              category: "sources",
              source: "script",
              locator: { scriptId: script.scriptId, url: script.url, sourceMapURL: script.sourceMapURL, isModule: script.isModule },
              text: source?.scriptSource || "",
              query,
              options,
            });
          }
          await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        });
      }

      if (params?.includeStorage !== false && results.length < maxMatches) {
        searched.storage = true;
        await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
          const page = await client.Runtime.evaluate({
            expression: `(async () => {
              const out = {
                url: location.href,
                localStorage: Object.fromEntries(Object.entries(localStorage || {})),
                sessionStorage: Object.fromEntries(Object.entries(sessionStorage || {})),
                documentCookie: document.cookie || "",
                indexedDB: { supported: Boolean(indexedDB), databases: [] },
                cacheStorage: { supported: Boolean(caches), caches: [] },
              };
              try {
                if (indexedDB?.databases) {
                  out.indexedDB.databases = await indexedDB.databases();
                }
              } catch (error) {
                out.indexedDB.error = String(error?.message || error);
              }
              try {
                if (caches?.keys) {
                  const names = await caches.keys();
                  out.cacheStorage.caches = await Promise.all(names.map(async (name) => {
                    const cache = await caches.open(name);
                    const requests = await cache.keys();
                    return { name, entryCount: requests.length, urls: requests.slice(0, 200).map((request) => request.url) };
                  }));
                }
              } catch (error) {
                out.cacheStorage.error = String(error?.message || error);
              }
              return out;
            })()`,
            returnByValue: true,
            awaitPromise: true,
          });
          pushTextSearchMatches(results, {
            category: "application",
            source: "storage",
            locator: { url: page.result?.value?.url, field: "storage-json" },
            text: JSON.stringify(page.result?.value || {}),
            query,
            options,
          });
          await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        });
        if (results.length < maxMatches) {
          try {
            const exportResult = await tools.get("browser_application_export").execute(_id, {
              profile: profile.name,
              tabId: params?.tabId,
              maxIndexedDbRecords: typeof params?.maxIndexedDbRecords === "number" ? Math.min(Math.max(1, params.maxIndexedDbRecords), 10_000) : 50,
              maxCacheEntries: typeof params?.maxCacheEntries === "number" ? Math.min(Math.max(1, params.maxCacheEntries), 5_000) : 50,
              includeCacheBodies: params?.includeCacheBodies !== false,
              maxCacheBodyChars: typeof params?.maxCacheBodyChars === "number" ? Math.min(Math.max(1, params.maxCacheBodyChars), 10_000_000) : 50000,
            });
            const exportPayload = JSON.parse(exportResult.content?.[0]?.text || "{}");
            searched.applicationExport = true;
            searched.applicationExportPath = exportPayload.exportPath || null;
            const applicationExport = exportPayload.exportPath ? readJsonFile(exportPayload.exportPath) : exportPayload;
            pushTextSearchMatches(results, {
              category: "application",
              source: "application-export",
              locator: { url: applicationExport.url, field: "application-export-json", exportPath: exportPayload.exportPath || null },
              text: JSON.stringify(applicationExport || {}),
              query,
              options,
            });
          } catch (error) {
            searched.applicationExportError = String(error?.message || error);
          }
        }
      }

      return toolResult({
        profile: profile.name,
        query,
        searched,
        matchCount: results.length,
        results,
      });
    },
  });

  tools.set("agent_inspect", {
    name: "agent_inspect",
    description: "Agent-facing F12 router. Pick a focus and get the right DevTools evidence without choosing from dozens of low-level tools.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the server default profile." },
        tabId: { type: "string", description: "CDP tab ID override. Defaults to the profile's current tab." },
        focus: {
          type: "string",
          description: "F12 panel focus: overview, network, storage, console, dom, sources, performance, search, evidence, or debug. Default overview.",
          enum: ["overview", "network", "storage", "console", "dom", "sources", "performance", "search", "evidence", "debug"],
        },
        query: { type: "string", description: "Search query forwarded to the search or sources focus routes." },
        selector: { type: "string", description: "CSS selector used when focus is dom to inspect a specific element." },
        requestId: { type: "string", description: "Network request ID for focused network drill-down." },
        includeHeavy: { type: "boolean", description: "Include heavier evidence passes (source maps, full HAR). Default false." },
        save: { type: "boolean", description: "If true, persist the evidence bundle to disk. Default false." },
        limit: { type: "number", description: "Maximum items per evidence section. Default 20." },
      },
    },
    async execute(id, params) {
      const profile = await resolveProfile(params?.profile);
      const focus = String(params?.focus || "overview");
      const limit = typeof params?.limit === "number" ? Math.min(Math.max(1, params.limit), 10_000) : 20;
      const base = { profile: profile.name, tabId: params?.tabId };
      const readPayload = (result) => JSON.parse(result.content?.[0]?.text || "{}");
      const call = async (name, extra = {}) => readPayload(await tools.get(name).execute(id, { ...base, ...extra }));
      const safeCall = async (name, extra = {}) => {
        try {
          return await call(name, extra);
        } catch (error) {
          return { unavailable: true, tool: name, error: String(error?.message || error) };
        }
      };
      const safeProfileCall = async (name, extra = {}) => {
        try {
          return readPayload(await tools.get(name).execute(id, { profile: profile.name, ...extra }));
        } catch (error) {
          return { unavailable: true, tool: name, error: String(error?.message || error) };
        }
      };
      const objectiveSignals = (payload) => {
        if (!payload || typeof payload !== "object") return payload;
        return payload;
      };
      const out = {
        backend: "managed-cdp",
        profile: profile.name,
        focus,
        generatedAt: new Date().toISOString(),
        summary: "",
        evidence: {},
        nextTools: [],
        professionalWorkflow: professionalAppsecWorkflowSummary(),
        toolPlan: buildAgentInspectToolPlan(focus, {
          requestId: Boolean(params?.requestId),
          query: Boolean(params?.query),
          selector: Boolean(params?.selector),
          includeHeavy: Boolean(params?.includeHeavy),
        }),
      };

      if (focus === "overview") {
        out.evidence.backendCapabilities = await safeCall("browser_backend_capabilities");
        out.evidence.diagnostics = await safeCall("browser_page_diagnostics", { limit });
        out.evidence.signals = objectiveSignals(await safeCall("browser_signal_summary", { limit, includeTokenScan: false }));
        out.evidence.network = await safeProfileCall("profile_traffic_summary", { limit });
        out.evidence.console = await safeCall("browser_console_log", { reload: false, waitMs: 100, limit });
        out.summary = "Objective first pass across page, network, console, storage, and browser signals. This does not decide vulnerability impact.";
        out.nextTools = ["agent_inspect focus=network", "agent_inspect focus=storage", "agent_inspect focus=console", "agent_inspect focus=dom", "agent_inspect focus=evidence"];
      } else if (focus === "network") {
        out.evidence.summary = await safeProfileCall("profile_traffic_summary", { limit: 1000000 });
        out.evidence.timeline = await safeProfileCall("profile_network_timeline", { limit });
        out.evidence.requests = await safeProfileCall("profile_traffic_query", { limit });
        out.evidence.realtime = await safeProfileCall("profile_realtime_log", { limit });
        if (params?.requestId) {
          out.evidence.requestDetail = await safeProfileCall("profile_request_detail", { requestId: params.requestId });
          out.evidence.requestBody = await safeProfileCall("profile_traffic_get", { requestId: params.requestId });
        }
        out.summary = "Network panel route: summary, timing/initiator rows, captured requests, real-time channels, and optional request drill-down.";
        out.nextTools = ["Use requestId with focus=network", "profile_realtime_log", "profile_request_replay", "profile_request_replay_batch", "profile_save_har", "agent_inspect focus=search query=<token/url/header>"];
      } else if (focus === "storage") {
        out.evidence.origin = await safeCall("browser_storage_origin_summary");
        out.evidence.cookies = await safeCall("browser_cookie_summary");
        out.evidence.serviceWorkers = await safeCall("browser_service_worker_summary");
        if (params?.includeHeavy) out.evidence.storage = await safeCall("browser_storage_snapshot");
        out.summary = "Application panel route: origin/quota, cookies, service workers, and optional full storage snapshot.";
        out.nextTools = ["browser_application_export", "browser_indexeddb_list", "browser_indexeddb_read", "browser_cache_storage_list", "browser_cache_entry_get", "agent_inspect focus=search query=<key/value>"];
      } else if (focus === "console") {
        out.evidence.console = await safeCall("browser_console_log", { reload: false, waitMs: 300, limit });
        out.evidence.issues = await safeCall("browser_issues_log", { reload: false, waitMs: 100, limit });
        out.summary = "Console and Issues route: runtime logs, exceptions, security messages, and DevTools issue events.";
        out.nextTools = ["browser_console_source_context", "agent_inspect focus=sources query=<stack marker>", "agent_inspect focus=debug"];
      } else if (focus === "dom") {
        out.evidence.elements = await safeCall("browser_elements_snapshot", { selector: params?.selector, maxNodes: limit * 10 });
        if (params?.query) out.evidence.search = await safeCall("browser_dom_search", { query: params.query, maxResults: limit });
        if (params?.selector) {
          out.evidence.styles = await safeCall("browser_css_styles", { selector: params.selector, maxRules: limit });
          out.evidence.listeners = await safeCall("browser_event_listeners", { selector: params.selector });
        }
        out.summary = "Elements panel route: DOM tree, optional live DOM search, selected-node styles, box model, and event listeners.";
        out.nextTools = ["Pass selector for styles/listeners", "Pass query for DOM search", "browser_dom_mutation_watch"];
      } else if (focus === "sources") {
        out.evidence.sources = await safeCall("browser_sources_list", { limit: limit * 5 });
        if (params?.query) out.evidence.search = await safeCall("browser_sources_search", { query: params.query, maxMatches: limit });
        out.summary = "Sources panel route: parsed scripts, source maps, literal source search, and debugger drill-down.";
        out.nextTools = ["browser_source_get", "browser_source_pretty_print", "browser_source_map_metadata", "browser_source_map_source_get", "agent_inspect focus=debug"];
      } else if (focus === "performance") {
        out.evidence.memory = await safeCall("browser_memory_snapshot");
        out.evidence.observer = await safeCall("browser_performance_observer", { durationMs: 500, maxItems: limit });
        out.evidence.insights = await safeCall("browser_performance_insights", { durationMs: 500, maxItems: limit, includeChromeTrace: Boolean(params?.includeHeavy) });
        out.evidence.performance = await safeCall("browser_performance_trace", { durationMs: 500 });
        if (params?.includeHeavy) out.evidence.cpuProfile = await safeCall("browser_cpu_profile", { durationMs: 500, maxNodes: limit });
        out.summary = "Performance route: memory counters plus objective timing, resource, long-task, and optional trace evidence.";
        out.nextTools = ["browser_performance_observer", "browser_performance_insights", "browser_heap_snapshot", "browser_chrome_trace", "browser_cpu_profile", "browser_coverage_detail"];
      } else if (focus === "search") {
        if (!params?.query) throw new Error("query is required for focus=search");
        out.evidence.search = await safeCall("browser_global_search", { query: params.query, maxMatches: limit });
        out.summary = "Global search route: literal search across currently available F12 evidence surfaces.";
        out.nextTools = ["agent_inspect focus=network query=<...>", "agent_inspect focus=storage query=<...>", "agent_inspect focus=sources query=<...>"];
      } else if (focus === "evidence") {
        out.evidence.bundle = await safeCall("browser_evidence_bundle", { save: params?.save !== false, networkLimit: limit, sourceLimit: limit * 5 });
        out.summary = "Evidence route: compact export bundle for handoff, report writing, or later Agent review.";
        out.nextTools = ["Open bundlePath", "agent_inspect focus=overview", "agent_inspect focus=search query=<hypothesis>"];
      } else if (focus === "debug") {
        out.evidence.debugger = await safeCall("browser_debugger_control", {
          action: params?.query ? "pauseOnExpression" : "snapshot",
          expression: params?.query || undefined,
          waitMs: 500,
          autoResume: true,
          maxFrames: limit,
        });
        out.summary = "Debugger route: paused-frame/scope snapshot or expression-triggered pause. Use low-level debugger tool for precise breakpoints.";
        out.nextTools = ["Use query as pauseOnExpression", "browser_debugger_control action=setBreakpointByUrl", "browser_source_get"];
      } else {
        throw new Error(`unsupported agent_inspect focus: ${focus}`);
      }
      out.completeness = summarizeEvidenceCompleteness(out.evidence);
      return toolResult(out);
    },
  });

  tools.set("browser_evidence_bundle", {
    name: "browser_evidence_bundle",
    description: "Export a compact objective F12 evidence bundle for the current profile: diagnostics, Network summary, Issues, Security, Storage summary, and Sources list.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the server default profile." },
        tabId: { type: "string", description: "CDP tab ID override. Defaults to the profile's current tab." },
        path: { type: "string", description: "Absolute path to save the bundle JSON file. Auto-generated if omitted." },
        save: { type: "boolean", description: "If true (default), persist the bundle to disk and return the file path." },
        sourceLimit: { type: "number", description: "Maximum source scripts to include in the sources list section. Default 100." },
        networkLimit: { type: "number", description: "Maximum network records in the network summary and HAR. Default 10." },
        includeHar: { type: "boolean", description: "If true, include a full HAR export section. Default false." },
        includeSnapshot: { type: "boolean", description: "Include a DOM snapshot section. Default true." },
        includeScreenshot: { type: "boolean", description: "Include a screenshot section. Default true." },
        fullPageScreenshot: { type: "boolean", description: "If true, capture full-page screenshot instead of viewport. Default false." },
        includeTokenScan: { type: "boolean", description: "Include a token scan section for credential/token pattern detection. Default false." },
        includeTokenFlow: { type: "boolean", description: "Include a token flow trace section (JavaScript token propagation). Default false." },
        tokenFlowTriggerExpression: { type: "string", description: "JavaScript expression to trigger before token flow trace. Used only when includeTokenFlow is true." },
      },
    },
    async execute(id, params) {
      const routed = await maybeRoutePersonal("browser_evidence_bundle", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const readPayload = (result) => JSON.parse(result.content?.[0]?.text || "{}");
      const safeReadPayload = async (toolName, input = {}) => {
        try {
          return readPayload(await tools.get(toolName).execute(id, input));
        } catch (error) {
          return {
            unavailable: true,
            tool: toolName,
            error: String(error?.message || error),
          };
        }
      };
      const toolParams = { profile: profile.name, tabId: params?.tabId };
      const bundle = {
        schema: "agent-browser.evidence.bundle.payload.v1",
        generatedAt: new Date().toISOString(),
        profile: profile.name,
        evidenceDir: profile.evidenceDir,
        diagnostics: await safeReadPayload("browser_page_diagnostics", { ...toolParams, limit: params?.networkLimit || 10 }),
        networkSummary: await safeReadPayload("profile_traffic_summary", { profile: profile.name, limit: params?.networkLimit || 10 }),
        issues: await safeReadPayload("browser_issues_log", { ...toolParams, reload: false, waitMs: 100, limit: 50 }),
        security: await safeReadPayload("browser_security_summary", toolParams),
        storage: await safeReadPayload("browser_storage_snapshot", toolParams),
        sources: await safeReadPayload("browser_sources_list", { ...toolParams, limit: params?.sourceLimit || 100 }),
      };
      if (params?.includeSnapshot !== false) {
        bundle.snapshot = await safeReadPayload("browser_snapshot", { ...toolParams });
      }
      if (params?.includeScreenshot !== false) {
        bundle.screenshot = await safeReadPayload("browser_screenshot", {
          ...toolParams,
          includeImage: false,
          fullPage: params?.fullPageScreenshot === true,
        });
      }
      if (params?.includeHar) {
        bundle.har = await safeReadPayload("profile_export_har", {
          profile: profile.name,
          limit: params?.networkLimit || 100,
          includeBodies: false,
        });
      }
      if (params?.includeTokenScan) {
        bundle.tokenScan = await safeReadPayload("browser_token_scan", toolParams);
      }
      if (params?.includeTokenFlow) {
        bundle.tokenFlow = await safeReadPayload("browser_token_flow_trace", {
          ...toolParams,
          durationMs: 800,
          maxEvents: 50,
          triggerExpression: params?.tokenFlowTriggerExpression || "",
        });
      }
      const unavailable = Object.entries(bundle)
        .filter(([, value]) => value && typeof value === "object" && value.unavailable)
        .map(([key, value]) => ({ section: key, tool: value.tool, error: value.error }));
      const summary = {
        url: bundle.diagnostics?.page?.url || bundle.security?.page?.url || "",
        requestCount: bundle.networkSummary?.requestCount || 0,
        issueCount: bundle.issues?.issueCount || 0,
        cookieCount: bundle.storage?.cookies?.length || 0,
        sourceCount: bundle.sources?.count || 0,
        controlCount: Array.isArray(bundle.snapshot?.controls) ? bundle.snapshot.controls.length : 0,
        screenshotPath: bundle.screenshot?.path || null,
        harEntryCount: bundle.har?.har?.log?.entries?.length || 0,
        tokenFindingCount: bundle.tokenScan?.findingCount || bundle.tokenScan?.findings?.length || 0,
        tokenFlowEventCount: bundle.tokenFlow?.trace?.eventCount || 0,
        tokenFlowTokenLikeEventCount: bundle.tokenFlow?.trace?.tokenLikeEventCount || 0,
        unavailableCount: unavailable.length,
      };
      let bundlePath = null;
      if (params?.save !== false) {
        bundlePath = params?.path || join(profile.evidenceDir, "bundles", `${Date.now()}-f12-evidence.json`);
        mkdirSync(dirname(bundlePath), { recursive: true, mode: 0o700 });
        writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
      }
      return toolResult({
        schema: "agent-browser.evidence.bundle.v1",
        ok: unavailable.length === 0,
        profile: profile.name,
        summary,
        unavailable,
        bundlePath,
        bundleBytes: bundlePath ? Buffer.byteLength(JSON.stringify(bundle, null, 2), "utf8") : null,
        bundle,
        nextCommands: [
          bundlePath ? `agent-browser artifact inspect "${bundlePath}"` : "agent-browser evidence bundle --save true",
          "agent-browser inspect evidence --profile <profile>",
          "agent-browser requests --profile <profile> --has-request-body true --limit 50",
        ],
        boundary: "Evidence bundle collects objective browser state. It does not decide whether behavior is vulnerable.",
      });
    },
  });

  tools.set("browser_evidence_manifest", {
    name: "browser_evidence_manifest",
    description: "Create a manifest for profile evidence files: capture window, artifact paths, sizes, hashes, and local provenance. This is objective evidence bookkeeping, not vulnerability analysis.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the server default profile." },
        tabId: { type: "string", description: "CDP tab ID override. Defaults to the profile's current tab." },
        artifactPaths: { type: "array", items: { type: "string" }, description: "Explicit list of artifact file paths to include alongside auto-discovered evidence directory files." },
        maxFiles: { type: "number", description: "Maximum evidence directory files to enumerate. Default 200." },
        save: { type: "boolean", description: "If true (default), persist the manifest JSON to disk." },
        path: { type: "string", description: "Absolute path to save the manifest JSON file. Auto-generated in evidence/manifests/ if omitted." },
      },
    },
    async execute(id, params) {
      const routed = await maybeRoutePersonal("browser_evidence_manifest", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const readPayload = (result) => JSON.parse(result.content?.[0]?.text || "{}");
      const diagnostics = readPayload(await tools.get("browser_page_diagnostics").execute(id, { profile: profile.name, tabId: params?.tabId, limit: 5 }));
      const files = listEvidenceFiles(profile.evidenceDir, { maxFiles: params?.maxFiles || 200 });
      const explicitArtifacts = [];
      for (const file of params?.artifactPaths || []) {
        if (!file || !existsSync(file)) {
          explicitArtifacts.push({ path: file, exists: false });
          continue;
        }
        const stat = statSync(file);
        explicitArtifacts.push({
          path: file,
          exists: true,
          bytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          sha256: stat.size <= 25_000_000 ? fileSha256(file) : null,
          hashSkipped: stat.size > 25_000_000,
        });
      }
      const manifest = {
        schema: "agent-browser-runtime.evidence-manifest.v1",
        backend: "managed-cdp",
        generatedAt: new Date().toISOString(),
        profile: profile.name,
        tabId: diagnostics.tabId || profile.tabId,
        page: diagnostics.page || {},
        capture: profileRegistry.getCapture(profile.name),
        evidenceDir: profile.evidenceDir,
        fileCount: files.length,
        files,
        explicitArtifacts,
        boundaries: [
          "Manifest records local evidence files and hashes only.",
          "It does not classify findings or decide vulnerability impact.",
        ],
      };
      let manifestPath = null;
      if (params?.save !== false) {
        manifestPath = params?.path || join(profile.evidenceDir, "manifests", `${Date.now()}-evidence-manifest.json`);
        mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 });
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      }
      return toolResult({ ...manifest, manifestPath });
    },
  });

  tools.set("browser_artifact_inspect", {
    name: "browser_artifact_inspect",
    description: "Inspect a saved local evidence artifact without loading the whole file into context: metadata, bounded preview, JSON/HAR shape, and literal match windows.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name whose evidence directory is the allowed root. Defaults to server default profile." },
        path: { type: "string", description: "Absolute path to the evidence artifact file to inspect." },
        artifactPath: { type: "string", description: "Alias for path. Use path preferentially." },
        query: { type: "string", description: "Optional literal string to search within the artifact; returns bounded match windows." },
        maxBytes: { type: "number", description: "Maximum bytes to read for the preview section. Default 50000." },
        maxMatches: { type: "number", description: "Maximum search match windows to return when query is provided. Default 20." },
        contextChars: { type: "number", description: "Characters of surrounding context around each search match. Default 200." },
        caseSensitive: { type: "boolean", description: "If true, search match is case-sensitive. Default false." },
      },
      required: ["path"],
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_artifact_inspect", params);
      if (routed) return toolResult(routed);
      // C-02: restrict reads to the resolved profile's evidence directory and the
      // server tmp scratch area, preventing arbitrary OS file disclosure.
      const profile = await resolveProfile(params?.profile).catch(() => null);
      const allowedRoots = profile
        ? [profile.evidenceDir, join(root, "tmp")]
        : [join(root, "tmp")];
      return toolResult(inspectArtifactFile({ ...params, backend: "managed-cdp", allowedRoots }));
    },
  });

  tools.set("browser_artifact_index", {
    name: "browser_artifact_index",
    description: "List saved profile evidence artifacts by type, size, mtime, and path so agents can choose bounded drill-down targets.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name whose evidence directory is scanned. Defaults to the server default profile." },
        kind: { type: "string", description: "Filter artifacts by kind/extension (e.g. 'har', 'json', 'png'). Returns all if omitted." },
        query: { type: "string", description: "Filter artifact paths by this literal substring. Returns all if omitted." },
        maxFiles: { type: "number", description: "Maximum artifact files to enumerate. Default 500." },
        minBytes: { type: "number", description: "Exclude artifacts smaller than this byte count." },
        maxBytes: { type: "number", description: "Exclude artifacts larger than this byte count." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_artifact_index", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const files = listEvidenceFiles(profile.evidenceDir, { maxFiles: Math.max(Number(params?.maxFiles) || 500, 500) });
      return toolResult({
        backend: "managed-cdp",
        profile: profile.name,
        evidenceDir: profile.evidenceDir,
        ...buildArtifactIndex(files, params),
      });
    },
  });

  tools.set("browser_artifact_search", {
    name: "browser_artifact_search",
    description: "Search saved local profile evidence artifacts for a literal query and return bounded match windows plus drill-down paths.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name whose evidence directory is searched. Defaults to the server default profile." },
        query: { type: "string", description: "Required. Literal string to search across artifact file contents." },
        kind: { type: "string", description: "Filter artifact files by kind/extension before searching (e.g. 'har', 'json')." },
        maxFiles: { type: "number", description: "Maximum artifact files to search. Default 500." },
        maxMatches: { type: "number", description: "Maximum total matches to return across all files. Default 80." },
        maxMatchesPerFile: { type: "number", description: "Maximum matches to return per individual file. Default 10." },
        maxBytesPerFile: { type: "number", description: "Maximum bytes to read per file before stopping. Default 1000000." },
        contextChars: { type: "number", description: "Characters of surrounding context around each match. Default 200." },
        caseSensitive: { type: "boolean", description: "If true, match is case-sensitive. Default false." },
      },
      required: ["query"],
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_artifact_search", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const files = listEvidenceFiles(profile.evidenceDir, { maxFiles: Math.max(Number(params?.maxFiles) || 500, 500) });
      return toolResult({
        backend: "managed-cdp",
        profile: profile.name,
        evidenceDir: profile.evidenceDir,
        ...buildArtifactSearch(files, params),
      });
    },
  });

  tools.set("browser_artifact_read", {
    name: "browser_artifact_read",
    description: "Read a bounded slice of a saved local evidence artifact by byte range or line range.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Required. Absolute path to the evidence artifact file to read." },
        artifactPath: { type: "string", description: "Alias for path. Use path preferentially." },
        startByte: { type: "number", description: "Byte offset to start reading from. Default 0 (file start)." },
        maxBytes: { type: "number", description: "Maximum bytes to read from startByte. Default 200000." },
        startLine: { type: "number", description: "1-based line number to start reading from (alternative to byte range)." },
        lineCount: { type: "number", description: "Number of lines to read when using line-range mode. Default 200." },
        includeBase64: { type: "boolean", description: "If true, also return the slice as base64 for binary artifacts. Default false." },
      },
      required: ["path"],
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_artifact_read", params);
      if (routed) return toolResult(routed);
      // C-02: pass managed-worker allowed roots so readArtifactSlice can whitelist-check
      // the requested path. Allowed: profile evidenceDir + <root>/tmp scratch area.
      const profile = await resolveProfile(params?.profile);
      const allowedRoots = [profile.evidenceDir, join(root, "tmp")];
      return toolResult(readArtifactSlice({ ...params, backend: "managed-cdp", allowedRoots }));
    },
  });

  tools.set("browser_evidence_timeline", {
    name: "browser_evidence_timeline",
    description: "Build an objective chronological timeline across captured Network, Console, Issues, realtime channels, and saved evidence artifacts.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the server default profile." },
        tabId: { type: "string", description: "CDP tab ID override. Defaults to the profile's current tab." },
        maxEvents: { type: "number", description: "Maximum total timeline events to include. Default 500." },
        maxNetworkRecords: { type: "number", description: "Maximum network records to include. Default 500." },
        maxArtifacts: { type: "number", description: "Maximum evidence artifact file entries to include. Default 200." },
        includeConsole: { type: "boolean", description: "Include console log events. Default true." },
        includeIssues: { type: "boolean", description: "Include Chrome Issues log events. Default true." },
        includeRealtime: { type: "boolean", description: "Include WebSocket and EventSource realtime events. Default true." },
        includeArtifacts: { type: "boolean", description: "Include saved evidence artifact file entries. Default true." },
        eventType: { type: "string", description: "Filter by event type (e.g. 'network', 'console', 'issue', 'websocket')." },
        source: { type: "string", description: "Filter timeline by event source label." },
        query: { type: "string", description: "Filter timeline events by literal string match in event data." },
        since: { type: "string", description: "ISO 8601 timestamp. Only include events at or after this time." },
        until: { type: "string", description: "ISO 8601 timestamp. Only include events at or before this time." },
      },
    },
    async execute(id, params) {
      const routed = await maybeRoutePersonal("browser_evidence_timeline", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const readPayload = (result) => JSON.parse(result.content?.[0]?.text || "{}");
      const requests = profileRegistry.queryTraffic(profile.name, { limit: typeof params?.maxNetworkRecords === "number" ? Math.min(Math.max(1, params.maxNetworkRecords), 10_000) : 500 });
      const consoleLog = params?.includeConsole === false ? {} : readPayload(await tools.get("browser_console_log").execute(id, {
        profile: profile.name,
        tabId: params?.tabId,
        reload: false,
        waitMs: 50,
        limit: 200,
      }));
      const issues = params?.includeIssues === false ? {} : readPayload(await tools.get("browser_issues_log").execute(id, {
        profile: profile.name,
        tabId: params?.tabId,
        reload: false,
        waitMs: 50,
        limit: 100,
      }));
      const realtime = params?.includeRealtime === false ? {} : {
        websockets: profileRegistry.readWebSockets(profile.name),
        eventSources: profileRegistry.readEventSources(profile.name),
      };
      const artifacts = params?.includeArtifacts === false
        ? []
        : buildArtifactIndex(listEvidenceFiles(profile.evidenceDir, { maxFiles: Math.min(Math.max(Number(params?.maxArtifacts) || 200, 1), 5_000) }), {
          maxFiles: typeof params?.maxArtifacts === "number" ? Math.min(Math.max(1, params.maxArtifacts), 5_000) : 200,
        }).artifacts;
      return toolResult({
        backend: "managed-cdp",
        profile: profile.name,
        evidenceDir: profile.evidenceDir,
        capture: profileRegistry.getCapture(profile.name),
        ...buildEvidenceTimeline({ requests, consoleLog, issues, realtime, artifacts }, params),
      });
    },
  });

  tools.set("browser_request_correlation_graph", {
    name: "browser_request_correlation_graph",
    description: "Build an objective graph connecting frames, scripts, Network requests, and Console entries observed in current F12 evidence.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the server default profile." },
        tabId: { type: "string", description: "CDP tab ID override. Defaults to the profile's current tab." },
        limit: { type: "number", description: "Maximum network records to include in the graph. Default 200." },
        save: { type: "boolean", description: "If true, persist the graph JSON to disk." },
        path: { type: "string", description: "Absolute path to save the graph JSON. Auto-generated if omitted." },
      },
    },
    async execute(id, params) {
      const routed = await maybeRoutePersonal("browser_request_correlation_graph", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const limit = typeof params?.limit === "number" ? Math.min(Math.max(1, params.limit), 10_000) : 200;
      const readPayload = (result) => JSON.parse(result.content?.[0]?.text || "{}");
      const framePayload = readPayload(await tools.get("browser_frame_tree").execute(id, { profile: profile.name, tabId: params?.tabId }));
      const frames = framePayload.frames || flattenFrameTree(framePayload.frameTree);
      const consoleLog = readPayload(await tools.get("browser_console_log").execute(id, { profile: profile.name, tabId: params?.tabId, limit: 100, reload: false, waitMs: 50 }));
      const sources = readPayload(await tools.get("browser_sources_list").execute(id, { profile: profile.name, tabId: params?.tabId, limit }))?.scripts || [];
      const requests = profileRegistry.queryTraffic(profile.name, { limit });
      const graph = buildRequestCorrelationGraph({
        requests,
        consoleEntries: consoleLog.entries || [],
        scripts: sources,
        frames,
        limit,
      });
      let graphPath = null;
      if (params?.save) {
        graphPath = params?.path || join(profile.evidenceDir, "graphs", `${Date.now()}-request-correlation-graph.json`);
        mkdirSync(dirname(graphPath), { recursive: true, mode: 0o700 });
        writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
      }
      return toolResult({
        backend: "managed-cdp",
        profile: profile.name,
        generatedAt: new Date().toISOString(),
        graphPath,
        ...graph,
        boundaries: [
          "Edges are evidence correlations from F12 metadata, not proof of causality.",
          "Use request detail, source context, and debugger tools for drill-down.",
        ],
        nextTools: ["profile_request_detail", "browser_source_get", "browser_console_source_context", "browser_debugger_control"],
      });
    },
  });

  tools.set("browser_capture_diff", {
    name: "browser_capture_diff",
    description: "Compare two saved evidence artifacts or current captured traffic against a saved artifact. Useful for login/logout, role, account, and permission-boundary before/after research.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name used when includeCurrentAsAfter is true. Defaults to the server default profile." },
        beforePath: { type: "string", description: "Required. Absolute path to the 'before' evidence bundle JSON file." },
        afterPath: { type: "string", description: "Absolute path to the 'after' evidence bundle JSON. Uses current profile traffic if omitted." },
        includeCurrentAsAfter: { type: "boolean", description: "If true and afterPath is omitted, use current profile captured traffic as the 'after' snapshot." },
        save: { type: "boolean", description: "If true, persist the diff JSON to disk." },
        path: { type: "string", description: "Absolute path to save the diff JSON. Auto-generated in evidence/diffs/ if omitted." },
      },
      required: ["beforePath"],
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_capture_diff", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const before = readJsonFile(params.beforePath);
      const after = params?.afterPath ? readJsonFile(params.afterPath) : { requests: profileRegistry.queryTraffic(profile.name, { limit: 1000000 }) };
      const beforeRequests = extractBundleNetworkRecords(before);
      const afterRequests = extractBundleNetworkRecords(after);
      const network = diffRequestSets(beforeRequests, afterRequests);
      const beforeStorage = before?.bundle?.storage || before?.storage || {};
      const afterStorage = after?.bundle?.storage || after?.storage || {};
      const storage = {
        topLevelKeys: diffObjectKeys(beforeStorage, afterStorage),
        cookieNames: diffObjectKeys(
          Object.fromEntries((beforeStorage.cookies || []).map((cookie) => [cookie.name, true])),
          Object.fromEntries((afterStorage.cookies || []).map((cookie) => [cookie.name, true])),
        ),
      };
      const diff = {
        schema: "agent-browser-runtime.capture-diff.v1",
        backend: "managed-cdp",
        generatedAt: new Date().toISOString(),
        profile: profile.name,
        beforePath: params.beforePath,
        afterPath: params?.afterPath || null,
        afterSource: params?.afterPath ? "file" : "current-profile-traffic",
        network,
        storage,
        summary: {
          addedRequestShapes: network.added.length,
          removedRequestShapes: network.removed.length,
          changedRequestShapes: network.changed.length,
          addedStorageKeys: storage.topLevelKeys.added.length,
          removedStorageKeys: storage.topLevelKeys.removed.length,
        },
        boundaries: [
          "Diff reports observable changes between two evidence snapshots.",
          "It does not decide whether a change is authorized, expected, or vulnerable.",
        ],
      };
      let diffPath = null;
      if (params?.save) {
        diffPath = params?.path || join(profile.evidenceDir, "diffs", `${Date.now()}-capture-diff.json`);
        mkdirSync(dirname(diffPath), { recursive: true, mode: 0o700 });
        writeFileSync(diffPath, `${JSON.stringify(diff, null, 2)}\n`, "utf8");
      }
      return toolResult({ ...diff, diffPath, nextTools: ["profile_request_detail", "browser_auth_boundary_report", "browser_global_search"] });
    },
  });

  tools.set("browser_auth_boundary_report", {
    name: "browser_auth_boundary_report",
    description: "Collect objective authentication and authorization boundary evidence: cookies, auth headers, token-like values, credentialed requests, storage tokens, and security context.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the server default profile." },
        tabId: { type: "string", description: "CDP tab ID override. Defaults to the profile's current tab." },
        limit: { type: "number", description: "Maximum auth-related request entries per section. Default 50." },
        includeTokenScan: { type: "boolean", description: "Include token/credential scan results in the report. Default true." },
        save: { type: "boolean", description: "If true, persist the report JSON to disk." },
        path: { type: "string", description: "Absolute path to save the report JSON. Auto-generated in evidence/auth/ if omitted." },
      },
    },
    async execute(id, params) {
      const routed = await maybeRoutePersonal("browser_auth_boundary_report", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const limit = typeof params?.limit === "number" ? Math.min(Math.max(1, params.limit), 10_000) : 50;
      const readPayload = (result) => JSON.parse(result.content?.[0]?.text || "{}");
      const requests = profileRegistry.queryTraffic(profile.name, { limit: 1000000 });
      const cookies = readPayload(await tools.get("browser_cookie_summary").execute(id, { profile: profile.name, tabId: params?.tabId }));
      const storage = readPayload(await tools.get("browser_storage_snapshot").execute(id, { profile: profile.name, tabId: params?.tabId }));
      const security = readPayload(await tools.get("browser_security_summary").execute(id, { profile: profile.name, tabId: params?.tabId }));
      const tokenScan = params?.includeTokenScan === false ? null : readPayload(await tools.get("browser_token_scan").execute(id, { profile: profile.name, tabId: params?.tabId }));
      const authRequests = authHeaderEvidence(requests, limit);
      const credentialedRequests = requests
        .filter((request) => headerValue(request.requestHeaders || request.headers || {}, "cookie") || headerValue(request.requestHeaders || request.headers || {}, "authorization"))
        .slice(-limit)
        .map((request) => ({
          requestId: request.requestId,
          method: request.method,
          url: request.url,
          status: request.status,
          resourceType: request.resourceType,
          hasCookies: Boolean(headerValue(request.requestHeaders || request.headers || {}, "cookie")),
          hasAuthorization: Boolean(headerValue(request.requestHeaders || request.headers || {}, "authorization")),
        }));
      const report = {
        schema: "agent-browser-runtime.auth-boundary-report.v1",
        backend: "managed-cdp",
        generatedAt: new Date().toISOString(),
        profile: profile.name,
        page: security.page || {},
        capture: profileRegistry.getCapture(profile.name),
        cookieSummary: cookies.summary || cookies,
        storageSummary: {
          localStorageKeys: Object.keys(storage.localStorage || {}),
          sessionStorageKeys: Object.keys(storage.sessionStorage || {}),
          cookieCount: Array.isArray(storage.cookies) ? storage.cookies.length : 0,
        },
        authRequests,
        credentialedRequests,
        tokenScanSummary: tokenScan ? {
          findingCount: tokenScan.findingCount || tokenScan.findings?.length || 0,
          bySource: tokenScan.bySource || {},
          findings: (tokenScan.findings || []).slice(0, limit),
        } : null,
        security: security.security || security,
        boundaries: [
          "This report lists authentication-related evidence only.",
          "It does not decide whether access control is correct.",
        ],
      };
      let reportPath = null;
      if (params?.save) {
        reportPath = params?.path || join(profile.evidenceDir, "auth", `${Date.now()}-auth-boundary-report.json`);
        mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 });
        writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      }
      return toolResult({ ...report, reportPath, nextTools: ["profile_request_replay_batch", "browser_capture_diff", "browser_token_scan", "browser_cookie_summary"] });
    },
  });

  tools.set("browser_worker_frame_deep_dive", {
    name: "browser_worker_frame_deep_dive",
    description: "Deep-dive frame, iframe, worker, Service Worker, CacheStorage, and target evidence so agents can inspect execution boundaries.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the server default profile." },
        tabId: { type: "string", description: "CDP tab ID override. Defaults to the profile's current tab." },
        includeServiceWorkerDetail: { type: "boolean", description: "If false, skip Service Worker detail fetch (faster). Default true." },
        save: { type: "boolean", description: "If true, persist the deep-dive report JSON to disk." },
        path: { type: "string", description: "Absolute path to save the report JSON. Auto-generated in evidence/boundaries/ if omitted." },
      },
    },
    async execute(id, params) {
      const routed = await maybeRoutePersonal("browser_worker_frame_deep_dive", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const readPayload = (result) => JSON.parse(result.content?.[0]?.text || "{}");
      const frames = readPayload(await tools.get("browser_frame_tree").execute(id, { profile: profile.name, tabId: params?.tabId }));
      const swSummary = readPayload(await tools.get("browser_service_worker_summary").execute(id, { profile: profile.name, tabId: params?.tabId }));
      const swDetail = params?.includeServiceWorkerDetail === false
        ? null
        : readPayload(await tools.get("browser_service_worker_detail").execute(id, { profile: profile.name, tabId: params?.tabId }));
      const targets = await cdpJson(cdpPort, "/json/list").catch(() => []);
      const workerTargets = (targets || []).filter((target) => ["worker", "shared_worker", "service_worker"].includes(target.type));
      const report = {
        schema: "agent-browser-runtime.worker-frame-deep-dive.v1",
        backend: "managed-cdp",
        generatedAt: new Date().toISOString(),
        profile: profile.name,
        frameTree: frames,
        serviceWorkers: {
          summary: swSummary,
          detail: swDetail,
        },
        workerTargets: workerTargets.map((target) => ({
          id: target.id,
          type: target.type,
          title: target.title,
          url: target.url,
          attached: target.attached,
        })),
        summary: {
          frameCount: frames.frameCount || frames.frames?.length || flattenFrameTree(frames.frameTree).length || 0,
          inaccessibleFrameCount: frames.inaccessibleFrameCount || 0,
          serviceWorkerRegistrationCount: swSummary.registrationCount || 0,
          cacheCount: swSummary.cacheCount || 0,
          workerTargetCount: workerTargets.length,
        },
        boundaries: [
          "Cross-origin frame internals may be intentionally unavailable to page-context tools.",
          "Direct CDP target metadata is included when Chrome exposes it.",
        ],
      };
      let reportPath = null;
      if (params?.save) {
        reportPath = params?.path || join(profile.evidenceDir, "boundaries", `${Date.now()}-worker-frame-deep-dive.json`);
        mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 });
        writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      }
      return toolResult({ ...report, reportPath, nextTools: ["browser_frame_tree", "browser_service_worker_detail", "browser_cache_entry_get", "browser_cdp_command"] });
    },
  });

  tools.set("browser_security_research_pack", {
    name: "browser_security_research_pack",
    description: "One-call security research evidence workflow: optionally navigate, start capture, reload, collect agent_inspect routes, save HAR/Application/trace evidence, and return artifact paths.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the server default profile." },
        url: { type: "string", description: "Optional URL to navigate to before starting evidence collection." },
        waitMs: { type: "number", description: "Milliseconds to wait after navigation before collecting evidence. Default 2000." },
        limit: { type: "number", description: "Maximum network records per evidence section. Default 20." },
        includeTrace: { type: "boolean", description: "Include a Chrome performance trace artifact. Default false." },
        includeHar: { type: "boolean", description: "Include a full HAR artifact. Default true." },
        includeApplicationExport: { type: "boolean", description: "Include Application panel export artifact (storage/SW/IndexedDB). Default true." },
        includeTokenScan: { type: "boolean", description: "Include a token/credential scan artifact. Default true." },
        includePerformanceHeavy: { type: "boolean", description: "Include expensive performance metrics (source map, coverage). Default false." },
      },
    },
    async execute(id, params) {
      const routed = await maybeRoutePersonal("browser_security_research_pack", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const readPayload = (result) => JSON.parse(result.content?.[0]?.text || "{}");
      const call = async (name, extra = {}) => readPayload(await tools.get(name).execute(id, { profile: profile.name, ...extra }));
      const safeCall = async (name, extra = {}) => {
        try {
          return await call(name, extra);
        } catch (error) {
          return { unavailable: true, tool: name, error: String(error?.message || error) };
        }
      };
      const waitMs = typeof params?.waitMs === "number" ? Math.min(Math.max(0, params.waitMs), 60_000) : 1200;
      const limit = typeof params?.limit === "number" ? Math.min(Math.max(1, params.limit), 10_000) : 25;
      const steps = [];
      if (params?.url) {
        const url = new URL(String(params.url));
        if (!/^https?:$/.test(url.protocol)) throw new Error("url must use http or https");
        steps.push({ step: "navigate", result: await safeCall("browser_navigate", { url: url.toString(), waitMs }) });
      }
      steps.push({ step: "capture_start", result: await safeCall("browser_capture_start", { clear: true, label: "security-research-pack" }) });
      steps.push({ step: "hard_reload", result: await safeCall("browser_hard_reload", { waitMs }) });
      const consoleReloadCapture = await safeCall("browser_console_log", {
        reload: true,
        ignoreCache: true,
        waitMs,
        limit: Math.max(limit, 100),
      });
      steps.push({
        step: "console_reload_capture",
        result: {
          profile: consoleReloadCapture.profile,
          tabId: consoleReloadCapture.tabId,
          counts: consoleReloadCapture.counts,
        },
      });
      const overview = await safeCall("agent_inspect", { focus: "overview", limit });
      const network = await safeCall("agent_inspect", { focus: "network", limit });
      const storage = await safeCall("agent_inspect", { focus: "storage", limit, includeHeavy: true });
      const consoleEvidence = await safeCall("agent_inspect", { focus: "console", limit });
      // Read the persistent console buffer captured by the traffic-capture plugin.
      // This buffer is populated via Runtime.consoleAPICalled + Log.entryAdded on the
      // persistent CDP connection, so it captures events emitted during hard_reload
      // (before any per-call connection is opened).
      const persistentConsole = await safeCall("cdp_query", { type: "console", limit: Math.max(limit, 100) });
      const sources = await safeCall("agent_inspect", { focus: "sources", limit });
      const performance = await safeCall("agent_inspect", { focus: "performance", limit, includeHeavy: Boolean(params?.includePerformanceHeavy) });
      const artifacts = {};
      artifacts.realtime = await safeCall("profile_realtime_log", { limit: 500, save: true });
      if (params?.includeHar !== false) {
        artifacts.har = await safeCall("profile_save_har", { limit: 500, includeBodies: false });
        artifacts.harCompleteness = await safeCall("profile_har_completeness", {
          includeBodies: false,
          maxRows: 50,
          save: true,
        });
      }
      if (params?.includeApplicationExport !== false) {
        artifacts.application = await safeCall("browser_application_export", {
          maxIndexedDbRecords: 100,
          maxCacheEntries: 100,
        });
      }
      if (params?.includeTrace !== false) {
        artifacts.trace = await safeCall("browser_chrome_trace", { durationMs: 800, maxEvents: 20, maxScreenshots: 2 });
        if (artifacts.trace?.tracePath) {
          artifacts.traceQuery = await safeCall("browser_trace_query", { tracePath: artifacts.trace.tracePath, limit: 10 });
        }
      }
      artifacts.correlationGraph = await safeCall("browser_request_correlation_graph", { limit: 100, save: true });
      artifacts.authBoundary = await safeCall("browser_auth_boundary_report", { limit: 50, includeTokenScan: Boolean(params?.includeTokenScan), save: true });
      artifacts.workerFrame = await safeCall("browser_worker_frame_deep_dive", { includeServiceWorkerDetail: true, save: true });
      artifacts.bundle = await safeCall("browser_evidence_bundle", {
        save: true,
        networkLimit: 100,
        sourceLimit: 100,
        includeHar: false,
        includeTokenScan: Boolean(params?.includeTokenScan),
      });
      artifacts.artifactIndex = await safeCall("browser_artifact_index", { maxFiles: 200 });
      artifacts.evidenceTimeline = await safeCall("browser_evidence_timeline", { maxEvents: 80, maxArtifacts: 120 });
      const parityMatrix = await safeCall("browser_f12_parity_matrix");
      const workflow = devtoolsWorkflowGuide("professional-appsec");
      const toolCatalogSnapshot = devtoolsToolCatalogFromEntries([...tools.values()], {});
      const agentEntryPoints = toolCatalogSnapshot.agentEntryPoints || null;
      const capabilityMapSnapshot = devtoolsCapabilityMapFromEntries([...tools.values()], { backend: "managed-cdp" });
      const agentUsage = capabilityMapSnapshot.agentUsage || null;
      const drilldownPlan = buildResearchPackDrilldowns(artifacts, { profile: profile.name, evidenceDir: profile.evidenceDir });
      artifacts.drilldownPlan = drilldownPlan;
      const f12Navigation = buildResearchPackF12Navigation(artifacts, { profile: profile.name, limit });
      const f12NavigationPath = join(profile.evidenceDir, "f12-navigation", `${Date.now()}-f12-navigation.json`);
      mkdirSync(dirname(f12NavigationPath), { recursive: true, mode: 0o700 });
      writeFileSync(f12NavigationPath, `${JSON.stringify(f12Navigation, null, 2)}\n`, "utf8");
      artifacts.f12Navigation = {
        path: f12NavigationPath,
        bytes: statSync(f12NavigationPath).size,
        sha256: fileSha256(f12NavigationPath),
      };
      const firstF12DetailRoute = f12Navigation.requests.find((row) => row?.detail)?.detail || null;
      const firstF12RequestDetail = firstF12DetailRoute
        ? summarizeF12RequestDetail(await safeCall(firstF12DetailRoute.tool, firstF12DetailRoute.input), firstF12DetailRoute)
        : null;
      let firstF12RequestDetailArtifact = null;
      if (firstF12RequestDetail) {
        const detailPath = join(profile.evidenceDir, "request-details", `${Date.now()}-first-f12-request-detail.json`);
        mkdirSync(dirname(detailPath), { recursive: true, mode: 0o700 });
        writeFileSync(detailPath, `${JSON.stringify(firstF12RequestDetail, null, 2)}\n`, "utf8");
        firstF12RequestDetailArtifact = {
          path: detailPath,
          bytes: statSync(detailPath).size,
          sha256: fileSha256(detailPath),
        };
        artifacts.firstF12RequestDetail = firstF12RequestDetailArtifact;
      }
      artifacts.manifest = await safeCall("browser_evidence_manifest", {
        save: true,
        artifactPaths: [
          artifacts.har?.harPath,
          artifacts.realtime?.reportPath,
          artifacts.harCompleteness?.reportPath,
          artifacts.application?.exportPath,
          artifacts.trace?.tracePath,
          artifacts.bundle?.bundlePath,
          artifacts.correlationGraph?.graphPath,
          artifacts.authBoundary?.reportPath,
          artifacts.workerFrame?.reportPath,
          artifacts.drilldownPlan?.planPath,
          artifacts.f12Navigation?.path,
          firstF12RequestDetailArtifact?.path,
        ].filter(Boolean),
      });
      const networkSummary = network?.evidence?.summary || {};
      const countConsoleEntries = (payload) => {
        const consolePanel = payload?.evidence?.console || payload || {};
        const counts = consolePanel.counts || {};
        return (
          counts.console ??
          counts.entries ??
          consolePanel.entryCount ??
          consolePanel.console?.length ??
          consolePanel.entries?.length ??
          0
        );
      };
      const consoleEntryCount =
        // Prefer the persistent traffic-capture buffer (populated during hard_reload).
        // Fall back to per-call browser_console_log counts if the plugin isn't active.
        (typeof persistentConsole?.total === "number" ? persistentConsole.total : null) ??
        (countConsoleEntries(consoleEvidence) || countConsoleEntries(consoleReloadCapture) || 0);
      const page = overview?.evidence?.diagnostics?.page || {};
      const generatedAt = new Date().toISOString();
      const summary = {
        url: page.url || params?.url || null,
        requestCount: networkSummary.requestCount || 0,
        failedRequestCount: networkSummary.failedRequestCount || networkSummary.errorCount || 0,
        consoleEntryCount,
        cookieCount: storage?.evidence?.cookies?.cookieCount ?? null,
        sourceCount: sources?.evidence?.sources?.count ?? null,
        performanceObserverEntryCount: performance?.evidence?.observer?.summary?.entryCount ?? null,
        tracePath: artifacts.trace?.tracePath || null,
        harPath: artifacts.har?.harPath || null,
        realtimeLogPath: artifacts.realtime?.reportPath || null,
        harCompletenessPath: artifacts.harCompleteness?.reportPath || null,
        applicationExportPath: artifacts.application?.exportPath || null,
        evidenceBundlePath: artifacts.bundle?.bundlePath || null,
        evidenceManifestPath: artifacts.manifest?.manifestPath || null,
        correlationGraphPath: artifacts.correlationGraph?.graphPath || null,
        authBoundaryReportPath: artifacts.authBoundary?.reportPath || null,
        workerFrameReportPath: artifacts.workerFrame?.reportPath || null,
        drilldownPlanPath: drilldownPlan.planPath || null,
        f12NavigationPath: artifacts.f12Navigation?.path || null,
        firstF12RequestDetailPath: firstF12RequestDetailArtifact?.path || null,
        artifactFileCount: artifacts.artifactIndex?.totalFileCount ?? null,
        evidenceTimelineEventCount: artifacts.evidenceTimeline?.eventCount ?? null,
        f12ParityPanelCount: parityMatrix?.summary?.panelCount ?? null,
        drilldownCount: drilldownPlan.count,
        f12NavigationRequestCount: f12Navigation.requestNodeCount,
        firstF12RequestDetailSections: firstF12RequestDetail ? Object.entries(firstF12RequestDetail.sectionAvailability).filter(([, present]) => present).map(([name]) => name) : [],
        workflowTask: workflow.task || "professional-appsec",
      };
      const captureBoundaries = [
        "This workflow records only evidence observable after capture starts and during the reload/reproduction window.",
        "It organizes F12 evidence for security research but does not decide exploitability.",
        "Use returned requestId/scriptId/tracePath values for low-level drill-down tools.",
      ];
      const nextTools = drilldownPlan.drilldowns.map((entry) => entry.tool);
      const researchPackPath = join(profile.evidenceDir, "research-packs", `${Date.now()}-security-research-pack.json`);
      const handoffDrilldowns = [
        {
          label: "Research pack handoff shape",
          tool: "browser_artifact_inspect",
          input: { path: researchPackPath, maxBytes: 12000 },
          why: "Inspect the saved handoff JSON structure without loading every underlying artifact.",
        },
        {
          label: "Research pack handoff preview",
          tool: "browser_artifact_read",
          input: { path: researchPackPath, mode: "line", startLine: 1, maxLines: 120 },
          why: "Read a bounded handoff slice for cross-session or cross-agent context transfer.",
        },
      ];
      const researchPackHandoff = {
        schema: "agent-browser-runtime.security-research-pack-handoff.v1",
        backend: "managed-cdp",
        generatedAt,
        profile: profile.name,
        page,
        summary: { ...summary, researchPackPath },
        artifactPaths: {
          harPath: summary.harPath,
          realtimeLogPath: summary.realtimeLogPath,
          harCompletenessPath: summary.harCompletenessPath,
          tracePath: summary.tracePath,
          applicationExportPath: summary.applicationExportPath,
          evidenceBundlePath: summary.evidenceBundlePath,
          evidenceManifestPath: summary.evidenceManifestPath,
          correlationGraphPath: summary.correlationGraphPath,
          authBoundaryReportPath: summary.authBoundaryReportPath,
          workerFrameReportPath: summary.workerFrameReportPath,
          drilldownPlanPath: summary.drilldownPlanPath,
          f12NavigationPath: summary.f12NavigationPath,
          firstF12RequestDetailPath: summary.firstF12RequestDetailPath,
        },
        agentEntryPoints,
        agentUsage,
        toolCatalogSummary: {
          toolCount: toolCatalogSnapshot.toolCount,
          categories: toolCatalogSnapshot.categories,
        },
        workflow,
        drilldownPlan: {
          planPath: drilldownPlan.planPath || null,
          count: drilldownPlan.count,
          drilldowns: drilldownPlan.drilldowns,
          boundaries: drilldownPlan.boundaries,
        },
        paritySummary: parityMatrix?.summary || null,
        f12Navigation,
        firstF12RequestDetail,
        firstF12RequestDetailArtifact,
        captureBoundaries,
        nextTools,
        handoffDrilldowns,
      };
      mkdirSync(dirname(researchPackPath), { recursive: true, mode: 0o700 });
      writeFileSync(researchPackPath, `${JSON.stringify(researchPackHandoff, null, 2)}\n`, "utf8");
      summary.researchPackPath = researchPackPath;
      artifacts.researchPack = {
        path: researchPackPath,
        bytes: statSync(researchPackPath).size,
        sha256: fileSha256(researchPackPath),
      };
      artifacts.artifactIndex = await safeCall("browser_artifact_index", { maxFiles: 200 });
      summary.artifactFileCount = artifacts.artifactIndex?.totalFileCount ?? summary.artifactFileCount;
      summary.artifactKinds = artifacts.artifactIndex?.kinds || null;
      artifacts.captureStatus = await safeCall("browser_capture_status");
      summary.capture = {
        enabled: artifacts.captureStatus?.capture?.enabled ?? null,
        startedAt: artifacts.captureStatus?.capture?.startedAt || null,
        stoppedAt: artifacts.captureStatus?.capture?.stoppedAt || null,
        label: artifacts.captureStatus?.capture?.label || null,
        trafficCount: artifacts.captureStatus?.trafficCount ?? null,
      };
      const handoffCompleteness = buildResearchPackHandoffCompleteness(summary, artifacts, workflow, drilldownPlan, parityMatrix, agentUsage);
      summary.handoffReady = handoffCompleteness.ready;
      summary.handoffPresentCount = handoffCompleteness.presentCount;
      summary.handoffMissing = handoffCompleteness.missing;
      researchPackHandoff.summary = { ...summary, researchPackPath };
      researchPackHandoff.artifactIndexSummary = {
        totalFileCount: artifacts.artifactIndex?.totalFileCount ?? null,
        kinds: artifacts.artifactIndex?.kinds || null,
      };
      researchPackHandoff.captureStatus = artifacts.captureStatus;
      researchPackHandoff.handoffCompleteness = handoffCompleteness;
      writeFileSync(researchPackPath, `${JSON.stringify(researchPackHandoff, null, 2)}\n`, "utf8");
      artifacts.researchPack = {
        path: researchPackPath,
        bytes: statSync(researchPackPath).size,
        sha256: fileSha256(researchPackPath),
      };
      const artifactCoverage = buildResearchPackArtifactCoverage(summary, params || {});
      summary.artifactCoverageReady = artifactCoverage.ready;
      summary.artifactCoverageMissing = artifactCoverage.missing;
      summary.artifactCoverageSkipped = artifactCoverage.skipped;
      researchPackHandoff.summary = { ...summary, researchPackPath };
      researchPackHandoff.artifactCoverage = artifactCoverage;
      writeFileSync(researchPackPath, `${JSON.stringify(researchPackHandoff, null, 2)}\n`, "utf8");
      artifacts.researchPack = {
        path: researchPackPath,
        bytes: statSync(researchPackPath).size,
        sha256: fileSha256(researchPackPath),
      };
      return toolResult({
        backend: "managed-cdp",
        profile: profile.name,
        generatedAt,
        page,
        summary,
        steps,
        evidence: {
          overview,
          network,
          storage,
          console: consoleEvidence,
          consoleReloadCapture,
          persistentConsole,
          sources,
          performance,
        },
        artifacts,
        artifactCoverage,
        handoffCompleteness,
        workflow,
        agentEntryPoints,
        agentUsage,
        toolCatalogSummary: {
          toolCount: toolCatalogSnapshot.toolCount,
          categories: toolCatalogSnapshot.categories,
        },
        parityMatrix,
        f12Navigation,
        firstF12RequestDetail,
        drilldownPlan,
        handoffDrilldowns,
        captureBoundaries,
        nextTools,
      });
    },
  });


  tools.set("browser_profile_status", {
    name: "browser_profile_status",
    description: "Inspect managed browser profile status: profile name, active tab, evidence directory, CDP endpoint, and capture state.",
    parameters: { type: "object", properties: { profile: { type: "string", description: "Profile name. Defaults to the server default profile." } } },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      return toolResult({
        backend: "managed-cdp",
        profile: profile.name,
        tabId: profile.tabId,
        evidenceDir: profile.evidenceDir,
        cdpEndpoint: `http://127.0.0.1:${cdpPort}`,
        capture: profileRegistry.getCapture(profile.name),
      });
    },
  });

  tools.set("browser_backend_capabilities", {
    name: "browser_backend_capabilities",
    description: "Explain current backend layer, CDP transport, supported domains, and evidence boundaries.",
    parameters: { type: "object", properties: { profile: { type: "string", description: "Profile name. Defaults to the server default profile." } } },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      return toolResult({
        backend: "managed-cdp",
        layer: "direct-cdp",
        transport: "Chrome DevTools Protocol over remote debugging endpoint",
        cdpEndpoint: `http://127.0.0.1:${cdpPort}`,
        profile: profile.name,
        tabId: profile.tabId,
        evidenceDir: profile.evidenceDir,
        capture: profileRegistry.getCapture(profile.name),
        rawCommandTool: "browser_cdp_command",
        rawCommandTransport: "chrome-remote-interface client.send against the selected page target",
        protocolSchemaTool: "browser_protocol_schema",
        domainAccess: {
          mode: "direct-remote-debugging-cdp",
          expectedBroaderThanChromeDebugger: true,
          coreDomains: DIRECT_CDP_CORE_DOMAINS,
          note: "Direct CDP generally exposes the most complete browser automation/debugging surface available to this runtime. The friendly browser_* wrappers target ordinary web-page F12 workflows; browser_cdp_command is the escape hatch for unwrapped page-target methods.",
        },
        bestUseCases: [
          "Agent-owned browser profiles for repeatable target testing.",
          "Fuller CDP coverage than the Personal Chrome extension layer.",
          "Clean evidence capture with explicit profile-scoped traffic and artifact directories.",
        ],
        recordingSemantics: [
          "Network/Console/Security events are complete only for activity after capture starts.",
          "For repeatable evidence, run browser_capture_start, then browser_hard_reload or reproduce the action.",
          "If Chrome did not retain a response body or a value only lived briefly in JavaScript memory, the tool reports missing evidence instead of inventing it.",
        ],
        knownBoundaries: [
          "Chrome internal pages, browser UI, and system dialogs are outside the ordinary-web-page F12 target.",
          "Cross-origin iframe internals follow the browser security model.",
          "Some browser-process domains may need future browser-level session wrappers instead of the current page-target browser_cdp_command.",
        ],
        companionLayer: "personal-chrome chrome.debugger",
      });
    },
  });

  async function runBrowserCdpCommand(method, commandParams = {}) {
    return await runBrowserProcessCdpCommand(cdpPort, method, commandParams);
  }

  const downloadWatchers = new Map();

  async function openBrowserProcessClient() {
    const versionResponse = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
    if (!versionResponse.ok) {
      throw new Error(`CDP version endpoint failed: ${versionResponse.status} ${await versionResponse.text()}`);
    }
    const version = await versionResponse.json();
    if (!version.webSocketDebuggerUrl) throw new Error("CDP version endpoint did not expose webSocketDebuggerUrl");
    return await CDP({ target: version.webSocketDebuggerUrl });
  }

  function downloadWatcherSummary(profileName, watcher) {
    const downloads = [...watcher.downloads.values()].map((entry) => ({
      guid: entry.guid,
      url: entry.url || null,
      suggestedFilename: entry.suggestedFilename || null,
      state: entry.state || "unknown",
      receivedBytes: entry.receivedBytes ?? null,
      totalBytes: entry.totalBytes ?? null,
      filePath: entry.filePath || (entry.suggestedFilename ? join(watcher.downloadPath, entry.suggestedFilename) : null),
      startedAt: entry.startedAt || null,
      updatedAt: entry.updatedAt || null,
    }));
    return {
      schema: "agent-browser.download.watch.v1",
      ok: true,
      profile: profileName,
      mode: "cdp-browser-events",
      downloadPath: watcher.downloadPath,
      browserContextId: watcher.browserContextId || null,
      startedAt: watcher.startedAt,
      activeCount: downloads.filter((entry) => ["inProgress", "unknown"].includes(entry.state)).length,
      completed: downloads.filter((entry) => entry.state === "completed"),
      canceled: downloads.filter((entry) => entry.state === "canceled"),
      downloads,
      boundary: "Uses CDP Browser.setDownloadBehavior with Browser.downloadWillBegin/downloadProgress events. Start this watcher before triggering the download.",
      suggestedNext: [
        `Trigger the download in the browser, then run: agent-browser download status --profile ${profileName}`,
        `Stop when done: agent-browser download stop --profile ${profileName}`,
      ],
    };
  }

  async function browserDownloadWatch(params) {
    const action = String(params?.action || "status").toLowerCase();
    const profileName = params?.profile || defaultProfileName;
    if (action === "start") {
      const existing = downloadWatchers.get(profileName);
      if (existing) {
        await existing.client.close().catch(() => {});
        downloadWatchers.delete(profileName);
      }
      const downloadPath = resolve(String(params?.downloadPath || params?.dir || join(options.dataDir || root, "downloads", profileName)));
      mkdirSync(downloadPath, { recursive: true });
      let browserContextId = null;
      try {
        const profile = await resolveProfile(profileName);
        browserContextId = profile.browserContextId || await targetBrowserContextId(cdpPort, profile.tabId);
      } catch {
        browserContextId = null;
      }
      const client = await openBrowserProcessClient();
      const watcher = {
        client,
        profile: profileName,
        downloadPath,
        browserContextId,
        startedAt: new Date().toISOString(),
        downloads: new Map(),
      };
      client.on("Browser.downloadWillBegin", (event) => {
        watcher.downloads.set(event.guid, {
          guid: event.guid,
          url: event.url,
          suggestedFilename: event.suggestedFilename,
          state: "inProgress",
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      });
      client.on("Browser.downloadProgress", (event) => {
        const previous = watcher.downloads.get(event.guid) || { guid: event.guid, startedAt: new Date().toISOString() };
        watcher.downloads.set(event.guid, {
          ...previous,
          state: event.state,
          receivedBytes: event.receivedBytes,
          totalBytes: event.totalBytes,
          filePath: event.filePath || previous.filePath,
          updatedAt: new Date().toISOString(),
        });
      });
      const behaviorParams = {
        behavior: "allow",
        downloadPath,
        eventsEnabled: true,
        ...(browserContextId ? { browserContextId } : {}),
      };
      await client.send("Browser.setDownloadBehavior", behaviorParams);
      downloadWatchers.set(profileName, watcher);
      return downloadWatcherSummary(profileName, watcher);
    }
    if (action === "status") {
      const watcher = downloadWatchers.get(profileName);
      if (!watcher) {
        return {
          schema: "agent-browser.download.watch.v1",
          ok: false,
          profile: profileName,
          state: "not-started",
          boundary: "No CDP download watcher is active. Start it before triggering a browser download.",
          suggestedNext: [`agent-browser download start --profile ${profileName} --dir <download-dir>`],
        };
      }
      return downloadWatcherSummary(profileName, watcher);
    }
    if (action === "stop") {
      const watcher = downloadWatchers.get(profileName);
      if (!watcher) {
        return { schema: "agent-browser.download.watch.v1", ok: true, profile: profileName, state: "not-started" };
      }
      const summary = downloadWatcherSummary(profileName, watcher);
      await watcher.client.close().catch(() => {});
      downloadWatchers.delete(profileName);
      return { ...summary, stoppedAt: new Date().toISOString(), state: "stopped" };
    }
    throw new Error("download watch action must be start, status, or stop");
  }

  tools.set("browser_process_cdp", {
    name: "browser_process_cdp",
    description: "Managed CDP only: run a raw Chrome DevTools Protocol command against the browser-process endpoint for Browser/SystemInfo/Target-level features.",
    parameters: {
      type: "object",
      properties: {
        method: { type: "string", description: "Required. Chrome DevTools Protocol browser-process method, e.g. 'Browser.getVersion' or 'Target.getTargets'." },
        params: { type: "object", description: "CDP method parameters object. Omit or pass {} for methods with no params." },
      },
      required: ["method"],
    },
    async execute(_id, params) {
      const method = String(params?.method || "").trim();
      if (!/^[A-Za-z0-9_.]+$/.test(method) || !method.includes(".")) {
        throw new Error("method must be a Chrome DevTools Protocol method like Browser.getVersion");
      }
      const result = await runBrowserCdpCommand(method, params?.params);
      return toolResult({
        backend: "managed-cdp",
        layer: "direct-cdp-browser-process",
        cdpEndpoint: `http://127.0.0.1:${cdpPort}`,
        method,
        result,
      });
    },
  });

  tools.set("browser_download_watch", {
    name: "browser_download_watch",
    description: "Managed CDP download watcher. Start before triggering a download, then query status for Browser.downloadWillBegin/downloadProgress events.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "Required action: 'start' to begin watching, 'status' to query progress, 'stop' to stop." },
        profile: { type: "string", description: "Profile name used to scope the download watcher. Defaults to the server default profile." },
        downloadPath: { type: "string", description: "Explicit file path to watch for completion. Used with start action." },
        dir: { type: "string", description: "Directory to monitor for downloaded files. Used with start action." },
      },
    },
    async execute(_id, params) {
      return toolResult(await browserDownloadWatch(params || {}));
    },
  });

  tools.set("browser_protocol_schema", {
    name: "browser_protocol_schema",
    description: "Managed CDP: discover Chrome DevTools Protocol domains, commands, events, and parameters exposed by the current browser.",
    parameters: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Filter results to a specific CDP domain name (e.g. 'Network', 'Runtime')." },
        query: { type: "string", description: "Literal substring filter applied to method/event names and descriptions." },
        includeExperimental: { type: "boolean", description: "Include experimental CDP methods and events. Default true." },
        includeDeprecated: { type: "boolean", description: "Include deprecated CDP methods and events. Default true." },
        limit: { type: "number", description: "Maximum methods/events rows to return. Default 50." },
      },
    },
    async execute(_id, params) {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/protocol`);
      if (!response.ok) {
        throw new Error(`CDP protocol endpoint failed: ${response.status} ${await response.text()}`);
      }
      const protocol = await response.json();
      const query = String(params?.query || "").trim().toLowerCase();
      const domainFilter = String(params?.domain || "").trim().toLowerCase();
      const limit = Math.max(1, typeof params?.limit === "number" ? params.limit : 50);
      const includeExperimental = params?.includeExperimental !== false;
      const includeDeprecated = params?.includeDeprecated !== false;
      const domains = Array.isArray(protocol.domains) ? protocol.domains : [];
      const rows = [];
      for (const domain of domains) {
        if (domainFilter && String(domain.domain || "").toLowerCase() !== domainFilter) continue;
        if (!includeExperimental && domain.experimental) continue;
        if (!includeDeprecated && domain.deprecated) continue;
        const commands = Array.isArray(domain.commands) ? domain.commands : [];
        const events = Array.isArray(domain.events) ? domain.events : [];
        const types = Array.isArray(domain.types) ? domain.types : [];
        const methods = commands
          .filter((command) => includeExperimental || !command.experimental)
          .filter((command) => includeDeprecated || !command.deprecated)
          .map((command) => ({
            method: `${domain.domain}.${command.name}`,
            name: command.name,
            description: command.description || "",
            experimental: Boolean(command.experimental),
            deprecated: Boolean(command.deprecated),
            parameters: Array.isArray(command.parameters) ? command.parameters.map((param) => ({
              name: param.name,
              type: param.type || param.$ref || "object",
              optional: Boolean(param.optional),
              description: param.description || "",
            })) : [],
            returns: Array.isArray(command.returns) ? command.returns.map((param) => ({
              name: param.name,
              type: param.type || param.$ref || "object",
              optional: Boolean(param.optional),
              description: param.description || "",
            })) : [],
          }));
        const eventRows = events
          .filter((event) => includeExperimental || !event.experimental)
          .filter((event) => includeDeprecated || !event.deprecated)
          .map((event) => ({
            event: `${domain.domain}.${event.name}`,
            name: event.name,
            description: event.description || "",
            experimental: Boolean(event.experimental),
            deprecated: Boolean(event.deprecated),
            parameters: Array.isArray(event.parameters) ? event.parameters.map((param) => ({
              name: param.name,
              type: param.type || param.$ref || "object",
              optional: Boolean(param.optional),
              description: param.description || "",
            })) : [],
          }));
        const typeRows = types.map((type) => ({
          id: type.id,
          type: type.type,
          description: type.description || "",
          experimental: Boolean(type.experimental),
          deprecated: Boolean(type.deprecated),
        }));
        const haystack = JSON.stringify({ domain: domain.domain, methods, events: eventRows, types: typeRows }).toLowerCase();
        if (query && !haystack.includes(query)) continue;
        const queryMatches = (value) => !query || JSON.stringify(value).toLowerCase().includes(query);
        const outputCommands = query ? methods.filter(queryMatches) : methods;
        const outputEvents = query ? eventRows.filter(queryMatches) : eventRows;
        const outputTypes = query ? typeRows.filter(queryMatches) : typeRows;
        rows.push({
          domain: domain.domain,
          description: domain.description || "",
          experimental: Boolean(domain.experimental),
          deprecated: Boolean(domain.deprecated),
          commandCount: methods.length,
          eventCount: eventRows.length,
          typeCount: types.length,
          commands: outputCommands.slice(0, limit),
          events: outputEvents.slice(0, limit),
          types: outputTypes.slice(0, limit),
          filtered: Boolean(query),
          truncated: outputCommands.length > limit || outputEvents.length > limit || outputTypes.length > limit,
        });
      }
      return toolResult({
        backend: "managed-cdp",
        layer: "direct-cdp-protocol",
        version: protocol.version || null,
        domainCount: domains.length,
        matchedDomainCount: rows.length,
        query: query || null,
        domain: domainFilter || null,
        domains: rows,
        captureBoundaries: [
          "This reports Chrome's protocol schema, not live page evidence.",
          "Use browser_cdp_command for page-target methods and browser_process_cdp for browser-process methods.",
          "Method availability can still depend on the selected target type and enabled domains.",
        ],
      });
    },
  });

  tools.set("browser_process_version", {
    name: "browser_process_version",
    description: "Managed CDP: return browser-process version metadata from Browser.getVersion.",
    parameters: { type: "object", properties: {} },
    async execute() {
      return toolResult({
        backend: "managed-cdp",
        layer: "direct-cdp-browser-process",
        result: await runBrowserCdpCommand("Browser.getVersion"),
      });
    },
  });

  tools.set("browser_process_targets", {
    name: "browser_process_targets",
    description: "Managed CDP: list browser targets from Target.getTargets for agent target/session discovery.",
    parameters: { type: "object", properties: {} },
    async execute() {
      const result = await runBrowserCdpCommand("Target.getTargets");
      const targets = Array.isArray(result.targetInfos) ? result.targetInfos : [];
      return toolResult({
        backend: "managed-cdp",
        layer: "direct-cdp-browser-process",
        targetCount: targets.length,
        targets,
      });
    },
  });

  tools.set("browser_system_info", {
    name: "browser_system_info",
    description: "Managed CDP: return browser/system information from SystemInfo.getInfo where Chrome exposes it.",
    parameters: { type: "object", properties: {} },
    async execute() {
      return toolResult({
        backend: "managed-cdp",
        layer: "direct-cdp-browser-process",
        result: await runBrowserCdpCommand("SystemInfo.getInfo"),
      });
    },
  });

  tools.set("browser_extension_reload", {
    name: "browser_extension_reload",
    description: "Reload the Personal Chrome extension when that backend is active. No-op for managed CDP.",
    parameters: { type: "object", properties: {} },
    async execute() {
      return toolResult({
        ok: true,
        backend: "managed-cdp",
        notApplicable: true,
        reason: "Managed Browser uses direct CDP and has no Chrome extension service worker to reload.",
      });
    },
  });

  // Advertise the backend selector on the facade action tools so agents can
  // target Personal Chrome explicitly.
  for (const actionToolName of [
    "browser_navigate",
    "browser_click",
    "browser_hover",
    "browser_double_click",
    "browser_drag",
    "browser_type",
    "browser_press",
    "browser_select",
    "browser_wait",
    "browser_upload",
    "browser_scroll",
  ]) {
    const actionTool = tools.get(actionToolName);
    if (actionTool) actionTool.parameters = withBackendParameters(actionTool.parameters);
  }

  function aliasTool(alias, targetName, description, transform = (params) => params) {
    const target = tools.get(targetName);
    if (!target) throw new Error(`cannot alias missing tool: ${targetName}`);
    tools.set(alias, {
      ...target,
      name: alias,
      description,
      async execute(id, params) {
        return await target.execute(id, transform(params || {}));
      },
    });
  }


  tools.set("browser_tool_catalog", {
    name: "browser_tool_catalog",
    description: "Agent usability: list available tools by category, description, required fields, and parameter names so agents do not choose blindly.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Literal substring filter applied to tool names and descriptions." },
        category: { type: "string", description: "Filter by tool category (e.g. 'network', 'storage', 'composite')." },
        includeBackendSpecific: { type: "boolean", description: "Include tools specific to managed-cdp backend. Default true." },
      },
    },
    async execute(_id, params) {
      return toolResult({
        backend: "managed-cdp",
        ...devtoolsToolCatalogFromEntries([...tools.values()], params || {}),
      });
    },
  });

  tools.set("browser_tool_help", {
    name: "browser_tool_help",
    description: "Agent usability: return description, parameters, category, and small usage hints for one tool.",
    parameters: {
      type: "object",
      properties: {
        tool: { type: "string", description: "Required. Exact tool name to get help for (e.g. 'browser_navigate', 'browser_tool_catalog')." },
      },
      required: ["tool"],
    },
    async execute(_id, params) {
      const name = String(params?.tool || "").trim();
      const tool = tools.get(name);
      if (!tool) throw new Error(`unknown tool: ${name}`);
      return toolResult({
        backend: "managed-cdp",
        name: tool.name,
        category: devtoolsToolCategory(tool.name),
        description: tool.description || "",
        parameters: tool.parameters || { type: "object", properties: {} },
        hints: {
          firstPass: tool.name === "agent_inspect" || tool.name === "browser_security_research_pack",
          objectiveBoundary: "This help describes tool usage only; it does not interpret evidence.",
        },
      });
    },
  });

  tools.set("browser_capability_map", {
    name: "browser_capability_map",
    description: "Agent usability: return the DevTools capability map grouped by F12 panel, first-pass tools, drill-down tools, artifacts, and raw CDP escape hatches.",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute() {
      return toolResult(devtoolsCapabilityMapFromEntries([...tools.values()], { backend: "managed-cdp" }));
    },
  });

  tools.set("browser_f12_parity_matrix", {
    name: "browser_f12_parity_matrix",
    description: "Agent usability: return an objective F12 parity matrix for professional AppSec work, including supported panels, partial coverage, tool routes, and browser boundaries.",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute() {
      return toolResult(devtoolsF12ParityMatrix("managed-cdp"));
    },
  });

  tools.set("browser_workflow_guide", {
    name: "browser_workflow_guide",
    description: "Agent usability: return deterministic tool recipes for common browser-security research tasks.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task recipe to retrieve (e.g. 'professional-appsec', 'login-logout', 'cors'). Returns all recipes if omitted." },
      },
    },
    async execute(_id, params) {
      return toolResult({
        backend: "managed-cdp",
        ...devtoolsWorkflowGuide(params?.task),
      });
    },
  });

  tools.set("browser_professional_readiness", {
    name: "browser_professional_readiness",
    description: "Agent usability: report whether the professional F12 evidence workflow is mechanically ready, which evidence pieces are present, and which objective tool to call next.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name to check readiness for. Defaults to the server default profile." },
        includeCaptureBisect: { type: "boolean", description: "Include capture bisect analysis to diagnose missing evidence. Default true." },
        includeHarCompleteness: { type: "boolean", description: "Include HAR completeness check for network body coverage. Default true." },
        includeArtifacts: { type: "boolean", description: "Include artifact index summary. Default true." },
        includeTimeline: { type: "boolean", description: "Include evidence timeline summary. Default true." },
      },
    },
    async execute(id, params) {
      const profileName = params?.profile || defaultProfileName;
      const parseTool = async (name, input = {}) => {
        try {
          const result = await tools.get(name).execute(id, input);
          return JSON.parse(result.content?.[0]?.text || "{}");
        } catch (error) {
          return { unavailable: true, tool: name, error: String(error?.message || error) };
        }
      };
      const workflow = await parseTool("browser_workflow_guide", { task: "professional-appsec" });
      const capabilityMap = await parseTool("browser_capability_map", {});
      const parityMatrix = await parseTool("browser_f12_parity_matrix", {});
      const captureStatus = await parseTool("browser_capture_status", { profile: profileName });
      const captureBisect = params?.includeCaptureBisect === false ? null : await parseTool("browser_capture_bisect", { profile: profileName, save: false, limit: 80 });
      const harCompleteness = params?.includeHarCompleteness === false ? null : await parseTool("profile_har_completeness", { profile: profileName, save: false, includeBodies: false, maxRows: 20 });
      const artifactIndex = params?.includeArtifacts === false ? null : await parseTool("browser_artifact_index", { profile: profileName, maxFiles: 200 });
      const evidenceTimeline = params?.includeTimeline === false ? null : await parseTool("browser_evidence_timeline", { profile: profileName, maxEvents: 80, maxArtifacts: 120 });
      return toolResult(buildProfessionalReadiness({
        backend: "managed-cdp",
        profile: profileName,
        workflow,
        capabilityMap,
        parityMatrix,
        captureStatus,
        captureBisect,
        harCompleteness,
        artifactIndex,
        evidenceTimeline,
      }));
    },
  });

  registerCapabilityFacadeTools({ tools, cdpPort, profileRegistry, defaultProfileName, options, recoverManagedCdp, managedRuntimeIdentity, managedBrowserProcessSummary, managedCdpPortMode, browserRuntimeIdentity, personalBridgeUrl, personalBridgeHealth, callJson, cdpJson, summarizeProfilePortConfig });

  registerUnifiedFacades({ tools, defaultProfileName, profileRegistry, managedPlaywrightDriver, resolveProfile, withManagedPageClient, maybeRoutePersonal, withBackendParameters, rememberActiveBackend, profileTargetStatus, runManagedPlaywrightAction, getLastBoundBackend: () => lastBoundBackend });

}

// Profile-port config file the worker maintains (browser.profiles -> cdpPort).
// This file is just the worker's own profile port table.
const PROFILE_CONFIG_FILENAME = "browser-profiles.json";

// Resolve where the profile-port config lives, honouring an explicit env
// override.
//
//  1. CDP_BROWSER_PROFILE_CONFIG set  -> use it verbatim (dev / external mgr).
//  2. unset (default)                 -> dataDir/browser-profiles.json.
//
// Exports the resolved path via the env var so every later reader (health
// summary, plugins loaded in-process) sees one consistent file.
function resolveProfileConfigPath(dataDir) {
  const explicit = process.env.CDP_BROWSER_PROFILE_CONFIG;
  const configPath = explicit || join(dataDir, PROFILE_CONFIG_FILENAME);
  process.env.CDP_BROWSER_PROFILE_CONFIG = configPath;
  return { configPath, externallyManaged: Boolean(explicit) };
}

function createConfigManager({ defaultProfile, cdpPort, dataDir }) {
  const { configPath, externallyManaged } = resolveProfileConfigPath(dataDir);

  function readConfig() {
    try {
      return JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
    } catch {
      return {};
    }
  }

  function writeConfig(config) {
    if (externallyManaged) return;
    const dir = dirname(configPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tempPath = `${configPath}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    renameSync(tempPath, configPath);
  }

  function ensureProfile(profile, record = {}) {
    const config = readConfig();
    config.browser = config.browser && typeof config.browser === "object" ? config.browser : {};
    config.browser.profiles =
      config.browser.profiles && typeof config.browser.profiles === "object"
        ? config.browser.profiles
        : {};
    config.browser.profiles[profile] = {
      cdpPort,
      ...(record?.browserContextId ? { browserContextId: record.browserContextId } : {}),
      ...(record?.tabId ? { tabId: record.tabId } : {}),
    };
    writeConfig(config);
    process.env.CDP_BROWSER_PROFILE_CONFIG = configPath;
  }

  function reconcileRuntimePorts() {
    if (externallyManaged) {
      return {
        ok: false,
        changedCount: 0,
        changedProfiles: [],
        state: "externally-managed",
        boundary: "CDP_BROWSER_PROFILE_CONFIG points to an external config, so the worker does not rewrite profile ports.",
      };
    }
    const config = readConfig();
    const profiles = config?.browser?.profiles && typeof config.browser.profiles === "object"
      ? config.browser.profiles
      : {};
    const changedProfiles = [];
    for (const [name, record] of Object.entries(profiles)) {
      if (!record || typeof record !== "object") continue;
      if (Number(record.cdpPort) === cdpPort) continue;
      changedProfiles.push({ profile: name, from: record.cdpPort ?? null, to: cdpPort });
      record.cdpPort = cdpPort;
    }
    if (changedProfiles.length > 0) writeConfig(config);
    process.env.CDP_BROWSER_PROFILE_CONFIG = configPath;
    return {
      ok: true,
      changedCount: changedProfiles.length,
      changedProfiles: changedProfiles.slice(0, 25),
      state: changedProfiles.length > 0 ? "reconciled" : "already-current",
      boundary: "Only ABR-managed profile-port metadata was rewritten. Browser cookies, storage, tabs, and profile identities were not changed.",
    };
  }

  ensureProfile(defaultProfile);
  const runtimePortReconciliation = reconcileRuntimePorts();
  return { configPath, ensureProfile, runtimePortReconciliation };
}

function summarizeProfilePortConfig(configPath, canonicalCdpPort, options = {}) {
  const cdpPortMode = options.cdpPortMode || "fixed";
  let config = null;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return {
      ok: false,
      configPath,
      canonicalCdpPort,
      state: "config-unreadable",
      totalProfiles: 0,
      mismatchedCount: 0,
      mismatchedProfiles: [],
      ports: {},
      boundary: "Profile port summary reads local runtime config only. It does not inspect browser cookies or page state.",
    };
  }
  const profiles = config?.browser?.profiles && typeof config.browser.profiles === "object"
    ? config.browser.profiles
    : {};
  const ports = {};
  const mismatchedProfiles = [];
  for (const [name, record] of Object.entries(profiles)) {
    const port = Number(record?.cdpPort);
    const key = Number.isFinite(port) ? String(port) : "missing";
    ports[key] = (ports[key] || 0) + 1;
    if (Number.isFinite(port) && port !== canonicalCdpPort) {
      mismatchedProfiles.push({ profile: name, cdpPort: port });
    }
  }
  const runtimeManaged = cdpPortMode === "ephemeral";
  return {
    ok: runtimeManaged ? true : mismatchedProfiles.length === 0,
    configPath,
    canonicalCdpPort,
    cdpPortMode,
    state: runtimeManaged
      ? "runtime-managed"
      : mismatchedProfiles.length === 0 ? "canonical" : "port-drift",
    totalProfiles: Object.keys(profiles).length,
    mismatchedCount: runtimeManaged ? 0 : mismatchedProfiles.length,
    ignoredMismatchedCount: runtimeManaged ? mismatchedProfiles.length : 0,
    mismatchedProfiles: mismatchedProfiles.slice(0, 25),
    ports,
    next: runtimeManaged
      ? []
      : mismatchedProfiles.length
      ? [`Migrate profile config cdpPort values to ${canonicalCdpPort} before routing agents through named profiles.`]
      : [],
    boundary: runtimeManaged
      ? "Managed Browser is using a runtime DevTools port. Profile identity is the profile name/user-data-dir, not a fixed CDP port."
      : "Profile port summary reads local runtime config only. It does not inspect browser cookies or page state.",
  };
}

function createConfigIfNeeded({ profile, cdpPort }) {
  const dataDir =
    process.env.CDP_SECURITY_DATA_DIR || join(homedir(), ".agent-browser-runtime");
  // 0o700: root dir for all agent runtime state. Mode is a noop on Windows.
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const { configPath, externallyManaged } = resolveProfileConfigPath(dataDir);
  if (externallyManaged || existsSync(configPath)) return configPath;
  writeFileSync(
    configPath,
    JSON.stringify({ browser: { profiles: { [profile]: { cdpPort } } } }, null, 2),
    "utf8",
  );
  return configPath;
}

function createPluginHost() {
  const tools = new Map();
  const services = [];
  const logger = {
    debug: (...args) => console.debug(...args),
    info: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
  };
  return {
    tools,
    services,
    api: {
      logger,
      registerTool(factory) {
        const tool = factory({});
        tools.set(tool.name, tool);
      },
      registerService(service) {
        services.push(service);
      },
    },
  };
}

// H-08: default 10 MB body limit; configurable via CDP_AGENT_MAX_BODY_BYTES env var.
// Exceeding the limit rejects with HTTP 413 so the server is not vulnerable to
// OOM-based DoS from a single oversized POST.
const MAX_BODY_BYTES = Number.parseInt(process.env.CDP_AGENT_MAX_BODY_BYTES || String(10 * 1024 * 1024), 10);
async function readJson(req) {
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      const err = new Error(`Request body exceeds limit of ${MAX_BODY_BYTES} bytes`);
      err.httpStatus = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB

function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  if (body.length > MAX_RESPONSE_BYTES) {
    res.writeHead(507, { "content-type": "application/json; charset=utf-8", "connection": "close" });
    res.end(JSON.stringify({ ok: false, error: "response_too_large", byteLength: body.length }) + "\n");
    return;
  }
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "connection": "close",
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "connection": "close",
  });
  res.end(html);
}

function panelHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agent DevTools Panel</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f4ef; color: #191816; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; }
    main { display: grid; grid-template-columns: 280px 1fr; min-height: 100vh; }
    aside { border-right: 1px solid #ded8cb; padding: 28px 20px; background: #fbfaf6; }
    h1 { margin: 0 0 8px; font-size: 20px; letter-spacing: 0; }
    .subtle { color: #6c665b; font-size: 13px; line-height: 1.45; }
    .profiles { display: grid; gap: 10px; margin-top: 22px; }
    button.profile { width: 100%; text-align: left; border: 1px solid #ded8cb; background: #fffdf8; color: #191816; border-radius: 8px; padding: 12px; cursor: pointer; }
    button.profile.active { border-color: #2f6b5f; box-shadow: 0 0 0 2px rgba(47,107,95,.16); }
    .name { font-weight: 700; font-size: 15px; }
    .meta { margin-top: 4px; color: #6c665b; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    section { padding: 30px; }
    .topbar { display: flex; justify-content: space-between; align-items: start; gap: 16px; margin-bottom: 20px; }
    .title { font-size: 24px; font-weight: 750; margin: 0; }
    .url { margin-top: 8px; color: #6c665b; font-size: 13px; max-width: 900px; overflow-wrap: anywhere; }
    .actions { display: flex; gap: 8px; }
    .action { border: 1px solid #d4cbbb; background: #fffdf8; border-radius: 8px; padding: 9px 12px; cursor: pointer; }
    .grid { display: grid; grid-template-columns: repeat(5, minmax(130px, 1fr)); gap: 12px; margin-bottom: 18px; }
    .card { border: 1px solid #ded8cb; background: #fffdf8; border-radius: 8px; padding: 14px; min-height: 86px; }
    .label { color: #6c665b; font-size: 12px; margin-bottom: 8px; }
    .value { font-size: 24px; font-weight: 760; }
    .small { color: #6c665b; font-size: 12px; margin-top: 4px; }
    .panel { border: 1px solid #ded8cb; background: #fffdf8; border-radius: 8px; padding: 16px; margin-top: 12px; }
    .panel h2 { font-size: 15px; margin: 0 0 12px; }
    .notice { border: 1px solid #c8dbd5; background: #eef7f3; color: #234d43; border-radius: 8px; padding: 10px 12px; font-size: 13px; margin-bottom: 14px; display: none; overflow-wrap: anywhere; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 9px 6px; border-top: 1px solid #ece7dc; vertical-align: top; }
    th { color: #6c665b; font-weight: 650; }
    .empty { padding: 48px; text-align: center; color: #6c665b; border: 1px dashed #d4cbbb; border-radius: 8px; background: #fffdf8; }
    .pill { display: inline-flex; align-items: center; border-radius: 999px; background: #e9f2ee; color: #235247; padding: 4px 8px; font-size: 12px; }
    @media (max-width: 1060px) { .grid { grid-template-columns: repeat(2, minmax(130px, 1fr)); } }
    @media (max-width: 860px) { main { grid-template-columns: 1fr; } aside { border-right: 0; border-bottom: 1px solid #ded8cb; } }
  </style>
</head>
<body>
  <main>
    <aside>
      <h1>Agent DevTools</h1>
      <div class="subtle">Profiles are agent operating spaces. Pick one to see the current page, Network, Security, Storage, and Accessibility summary.</div>
      <div id="profiles" class="profiles"></div>
    </aside>
    <section>
      <div id="content" class="empty">Loading profiles...</div>
    </section>
  </main>
  <script>
    let state = null;
    let selected = new URLSearchParams(location.search).get("profile") || "";
    async function load() {
      const response = await fetch("/panel-data" + (selected ? "?profile=" + encodeURIComponent(selected) : ""));
      state = await response.json();
      if (!selected && state.defaultProfile) selected = state.defaultProfile;
      render();
    }
    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    }
    function renderProfiles() {
      const box = document.getElementById("profiles");
      box.innerHTML = "";
      for (const profile of state.profiles || []) {
        const button = document.createElement("button");
        button.className = "profile" + (profile.name === selected ? " active" : "");
        button.innerHTML = '<div class="name">' + escapeHtml(profile.name) + '</div><div class="meta">' + escapeHtml(profile.url || "about:blank") + '</div>';
        button.onclick = () => { selected = profile.name; history.replaceState(null, "", "/panel?profile=" + encodeURIComponent(selected)); load(); };
        box.appendChild(button);
      }
    }
    async function runTool(name, body = {}) {
      const notice = document.getElementById("notice");
      notice.style.display = "block";
      notice.textContent = "Running " + name + "...";
      const response = await fetch("/tool/" + encodeURIComponent(name), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile: selected, ...body }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || JSON.stringify(result));
      notice.textContent =
        name === "profile_save_har" ? "HAR saved: " + result.harPath :
        name === "browser_application_export" ? "Application export saved: " + result.exportPath :
        name === "browser_chrome_trace" ? "Trace saved: " + result.tracePath :
        name + " completed.";
      await load();
    }
    function render() {
      renderProfiles();
      const content = document.getElementById("content");
      const current = state.current;
      if (!current || current.error) {
        content.className = "empty";
        content.textContent = current?.error || "No profile selected.";
        return;
      }
      const network = current.network || {};
      const storage = current.storage || {};
      const security = current.security || {};
      const page = current.page || {};
      const capture = current.captureStatus?.capture || current.capture || {};
      const failedRows = (network.failed || []).map(row => '<tr><td>' + escapeHtml(row.status || row.errorText || "failed") + '</td><td>' + escapeHtml(row.method || "") + '</td><td>' + escapeHtml(row.url || "") + '</td></tr>').join("");
      const hostRows = Object.entries(network.byHost || {}).map(([host, count]) => '<tr><td>' + escapeHtml(host) + '</td><td>' + count + '</td></tr>').join("");
      content.className = "";
      content.innerHTML =
        '<div class="topbar"><div><h2 class="title">' + escapeHtml(page.title || selected) + '</h2><div class="url">' + escapeHtml(page.url || "") + '</div></div><div class="actions"><button class="action" onclick="runTool(\\'browser_capture_start\\', { clear: true, label: \\'panel\\' }).catch(alert)">Start Capture</button><button class="action" onclick="runTool(\\'browser_hard_reload\\', { waitMs: 800 }).catch(alert)">Hard Reload</button><button class="action" onclick="runTool(\\'browser_signal_summary\\', {}).catch(alert)">Signals</button><button class="action" onclick="runTool(\\'profile_save_har\\', { limit: 1000 }).catch(alert)">Save HAR</button><button class="action" onclick="runTool(\\'browser_application_export\\', { maxIndexedDbRecords: 1000, maxCacheEntries: 500 }).catch(alert)">Export App</button><button class="action" onclick="runTool(\\'browser_chrome_trace\\', { durationMs: 800, maxEvents: 20 }).catch(alert)">Trace</button><button class="action" onclick="load()">Refresh</button></div></div>' +
        '<div id="notice" class="notice"></div>' +
        '<div class="grid">' +
          '<div class="card"><div class="label">Network</div><div class="value">' + (network.requestCount || 0) + '</div><div class="small">requests, ' + (network.failedCount || 0) + ' failed</div></div>' +
          '<div class="card"><div class="label">Signals</div><div class="value">' + (current.signalSummary?.signalCount || 0) + '</div><div class="small">' + (current.signalSummary?.highCount || 0) + ' high-priority, ' + (current.signalSummary?.mediumCount || 0) + ' medium</div></div>' +
          '<div class="card"><div class="label">Capture</div><div class="value">' + (capture.enabled ? "On" : "Off") + '</div><div class="small">' + escapeHtml(capture.label || "manual switch") + '</div></div>' +
          '<div class="card"><div class="label">Security</div><div class="value">' + (page.isSecureContext ? "OK" : "Check") + '</div><div class="small">' + escapeHtml(page.protocol || "") + '</div></div>' +
          '<div class="card"><div class="label">Cookies</div><div class="value">' + (storage.browserCookieCount || 0) + '</div><div class="small">' + ((storage.cookieSummary?.insecureCount || 0)) + ' insecure, ' + ((storage.cookieSummary?.scriptReadableCount || 0)) + ' script-readable</div></div>' +
          '<div class="card"><div class="label">Accessibility</div><div class="value">' + (current.accessibility?.nodeCount || 0) + '</div><div class="small">AX nodes</div></div>' +
        '</div>' +
        '<div class="panel"><h2>F12 Signals</h2><table><thead><tr><th>Priority</th><th>Panel</th><th>Signal</th><th>Next tools</th></tr></thead><tbody>' + ((current.signalSummary?.signals || current.signalSummary?.findings || []).slice(0, 8).map(row => '<tr><td>' + escapeHtml(row.severity) + '</td><td>' + escapeHtml(row.panel) + '</td><td>' + escapeHtml(row.title) + '<div class="small">' + escapeHtml(row.detail || "") + '</div></td><td>' + escapeHtml((row.nextTools || []).join(", ")) + '</td></tr>').join("") || '<tr><td colspan="4"><span class="pill">No notable F12 signals yet</span></td></tr>') + '</tbody></table></div>' +
        '<div class="panel"><h2>Hosts</h2><table><thead><tr><th>Host</th><th>Requests</th></tr></thead><tbody>' + (hostRows || '<tr><td colspan="2">No captured hosts yet.</td></tr>') + '</tbody></table></div>' +
        '<div class="panel"><h2>Failed Requests</h2><table><thead><tr><th>Status</th><th>Method</th><th>URL</th></tr></thead><tbody>' + (failedRows || '<tr><td colspan="3"><span class="pill">No failed requests in the current capture</span></td></tr>') + '</tbody></table></div>';
    }
    load().catch(error => {
      const content = document.getElementById("content");
      content.className = "empty";
      content.textContent = String(error);
    });
  </script>
</body>
</html>`;
}

function feedbackHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agent Browser Feedback</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f4ef; color: #191816; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; padding: 32px; }
    main { max-width: 1120px; margin: 0 auto; display: grid; grid-template-columns: 420px 1fr; gap: 22px; align-items: start; }
    h1 { font-size: 26px; margin: 0 0 8px; letter-spacing: 0; }
    p { color: #6c665b; line-height: 1.5; margin: 0 0 18px; }
    .card { border: 1px solid #ded8cb; background: #fffdf8; border-radius: 8px; padding: 18px; }
    label { display: block; font-size: 12px; font-weight: 700; color: #5c564d; margin: 12px 0 6px; }
    input, select, textarea { width: 100%; border: 1px solid #d4cbbb; background: #fff; color: #191816; border-radius: 8px; padding: 10px 11px; font: inherit; }
    textarea { min-height: 82px; resize: vertical; }
    button { border: 1px solid #2f6b5f; background: #2f6b5f; color: #fff; border-radius: 8px; padding: 10px 13px; cursor: pointer; margin-top: 14px; font-weight: 700; }
    .secondary { border-color: #d4cbbb; background: #fffdf8; color: #191816; margin-left: 8px; }
    .notice { display: none; border: 1px solid #c8dbd5; background: #eef7f3; color: #234d43; border-radius: 8px; padding: 10px 12px; font-size: 13px; margin: 12px 0; overflow-wrap: anywhere; }
    .note { border-top: 1px solid #ece7dc; padding: 13px 0; }
    .note:first-child { border-top: 0; }
    .note-title { font-weight: 760; }
    .meta { color: #6c665b; font-size: 12px; margin-top: 4px; overflow-wrap: anywhere; }
    .summary { font-size: 13px; margin-top: 7px; color: #3d3934; line-height: 1.45; }
    code { background: #efe9dc; border-radius: 6px; padding: 2px 5px; }
    @media (max-width: 900px) { main { grid-template-columns: 1fr; } body { padding: 18px; } }
  </style>
</head>
<body>
  <main>
    <section class="card">
      <h1>Feedback</h1>
      <p>Record tool bugs, missing F12 evidence, unclear docs, or product friction. Notes stay local in <code>feedback/*.md</code> and must be reviewed before publishing.</p>
      <form id="form">
        <label>Type</label>
        <select name="type">
          <option value="gap">Capability gap</option>
          <option value="bug">Bug</option>
          <option value="docs">Docs</option>
          <option value="product">Product friction</option>
          <option value="idea">Idea</option>
        </select>
        <label>Title</label>
        <input name="title" required placeholder="Short objective title" />
        <label>Summary</label>
        <textarea name="summary" placeholder="What did the agent need, and what happened?"></textarea>
        <label>Tool</label>
        <input name="tool" placeholder="browser_inspect / profile_request_detail / etc." />
        <label>Profile</label>
        <input name="profile" placeholder="demo-fixture / target-guest-clean / etc." />
        <label>Expected</label>
        <textarea name="expected" placeholder="What should the tool have exposed?"></textarea>
        <label>Actual</label>
        <textarea name="actual" placeholder="What did it expose instead?"></textarea>
        <label>Evidence pointers</label>
        <textarea name="evidence" placeholder="Artifact path, request id, safe local fixture, or reproduction hint. No secrets."></textarea>
        <button type="submit">Save local note</button>
        <button class="secondary" type="button" onclick="load()">Refresh</button>
      </form>
      <div id="notice" class="notice"></div>
    </section>
    <section class="card">
      <h1>Local Notes</h1>
      <p>These notes are for agent triage. They are ignored by git unless manually converted into safe public issues.</p>
      <div id="notes">Loading...</div>
    </section>
  </main>
  <script>
    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    }
    function formPayload(form) {
      return Object.fromEntries([...new FormData(form).entries()].map(([key, value]) => [key, String(value).trim()]));
    }
    async function load() {
      const response = await fetch("/feedback-data");
      const data = await response.json();
      const box = document.getElementById("notes");
      if (!data.notes?.length) {
        box.innerHTML = '<div class="meta">No feedback notes yet.</div>';
        return;
      }
      box.innerHTML = data.notes.map(note =>
        '<div class="note"><div class="note-title">' + escapeHtml(note.title) + '</div>' +
        '<div class="meta">' + escapeHtml(note.type) + ' · ' + escapeHtml(note.status) + ' · ' + escapeHtml(note.updatedAt) + '</div>' +
        '<div class="meta">' + escapeHtml(note.tool || "no tool") + ' · ' + escapeHtml(note.profile || "no profile") + '</div>' +
        '<div class="summary">' + escapeHtml(note.summary || "") + '</div>' +
        '<div class="meta">' + escapeHtml(note.path) + '</div></div>'
      ).join("");
    }
    document.getElementById("form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const notice = document.getElementById("notice");
      notice.style.display = "block";
      notice.textContent = "Saving...";
      const response = await fetch("/feedback-note", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...formPayload(event.currentTarget), reporter: "feedback-page" }),
      });
      const result = await response.json();
      if (!response.ok) {
        notice.textContent = result.error || JSON.stringify(result);
        return;
      }
      notice.textContent = "Saved: " + result.path;
      event.currentTarget.reset();
      await load();
    });
    load().catch(error => {
      document.getElementById("notes").textContent = String(error);
    });
  </script>
</body>
</html>`;
}

async function main() {
  const profile = process.env.CDP_AGENT_PROFILE || "default";
  const serverPort = Number.parseInt(process.env.CDP_AGENT_SERVER_PORT || "17335", 10);
  // C-01: default to loopback for local safety. Set CDP_AGENT_SERVER_HOST=0.0.0.0 to
  // allow tailnet / LAN access (required when inner-field agents connect over tailnet).
  // When binding 0.0.0.0 you MUST also set CDP_AGENT_SERVER_TOKEN to a non-empty
  // secret; all /tool/* requests will require "Authorization: Bearer <token>".
  const serverHost = process.env.CDP_AGENT_SERVER_HOST || "127.0.0.1";
  const dataDir =
    process.env.CDP_SECURITY_DATA_DIR || join(homedir(), ".agent-browser-runtime");
  const launchBrowser = process.env.CDP_LAUNCH_BROWSER === "1";
  const cdpPortMode = process.env.CDP_BROWSER_PORT_MODE || (launchBrowser ? "ephemeral" : "fixed");
  const requestedCdpPort = Number.parseInt(process.env.CDP_BROWSER_PORT || (launchBrowser ? "0" : "9222"), 10);
  let cdpPort = Number.isFinite(requestedCdpPort) && requestedCdpPort >= 0 ? requestedCdpPort : (launchBrowser ? 0 : 9222);
  const browserHeadless = process.env.CDP_BROWSER_HEADLESS === "1";
  const browserLaunchMode = browserHeadless ? "headless" : "headful";
  let existingBrowser = cdpPort > 0 ? await cdpEndpointAvailable(cdpPort) : false;
  if (launchBrowser && !existingBrowser && cdpPortMode === "ephemeral") cdpPort = 0;
  let browserProcess = null;
  let browserRelaunchInFlight = null;
  let selectedBrowserExecutable = process.env.CDP_BROWSER_EXECUTABLE || null;
  let selectedBrowserUserDataDir = process.env.CDP_BROWSER_USER_DATA_DIR || null;
  const browserProcessState = {
    managedLaunchRequested: launchBrowser,
    lastLaunchAttemptAt: null,
    lastLaunchSucceededAt: null,
    lastLaunchReason: null,
    lastExit: null,
    relaunchCount: 0,
  };

  function browserLaunchArgs(userDataDir, launchPort) {
    const args = [
      `--remote-debugging-port=${launchPort}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--no-startup-window",
      // Root cause #10 (2026-06-03 reliability redesign): the managed browser
      // runs headful but off-screen/backgrounded, so Windows occlusion
      // detection marks its tabs visibilityState="hidden". On a hidden page
      // Chromium stalls CDP Input.dispatchMouseEvent/dispatchKeyEvent — every
      // real click/type hung ~20-35s and never landed (intermittent, depending
      // on window state). These flags keep the renderer foreground-active and
      // input-responsive regardless of window occlusion/minimize:
      //   - CalculateNativeWinOcclusion: the Windows feature that flips a
      //     covered/minimized window's tabs to hidden (the direct trigger).
      //   - backgrounding-occluded-windows / renderer-backgrounding /
      //     background-timer-throttling: stop the renderer being throttled when
      //     it is not the foreground window.
      // Verified: with --disable-backgrounding-occluded-windows a MINIMIZED
      // window dispatched a click in 2ms and it landed; without it the same
      // click hung 35s and never landed.
      "--disable-features=CalculateNativeWinOcclusion",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      ...(browserHeadless ? ["--headless=new"] : []),
      ...parseBrowserExtraArgs(process.env.CDP_BROWSER_EXTRA_ARGS),
    ];
    if (process.env.CDP_REMOTE_ALLOW_ORIGINS) {
      args.splice(1, 0, `--remote-allow-origins=${process.env.CDP_REMOTE_ALLOW_ORIGINS}`);
    }
    return args;
  }

  function browserProcessSummary() {
    const running =
      Boolean(browserProcess) &&
      browserProcess.exitCode === null &&
      browserProcess.signalCode === null &&
      !browserProcess.killed;
    return {
      ...browserProcessState,
      managedByWorker: Boolean(browserProcess),
      running,
      pid: running ? browserProcess.pid : null,
      executablePath: selectedBrowserExecutable || null,
      userDataDir: selectedBrowserUserDataDir || null,
      cdpPort,
      requestedCdpPort,
      cdpPortMode,
      boundary:
        "The worker only manages a browser process it launched itself. It does not kill or take over the user's normal Chrome.",
    };
  }

  async function launchManagedBrowser(reason) {
    const executable = browserExecutable();
    if (!executable) {
      throw new Error("No Edge/Chrome executable found. Set CDP_BROWSER_EXECUTABLE.");
    }
    selectedBrowserExecutable = executable;
    const userDataDir =
      process.env.CDP_BROWSER_USER_DATA_DIR ||
      join(dataDir, "browser-identities", profile);
    selectedBrowserUserDataDir = userDataDir;
    mkdirSync(userDataDir, { recursive: true });
    if (cdpPort === 0) {
      try {
        unlinkSync(devToolsActivePortPath(userDataDir));
      } catch {
        // It is fine when Chrome has not created the file yet.
      }
    }
    browserProcessState.lastLaunchAttemptAt = new Date().toISOString();
    browserProcessState.lastLaunchReason = reason;
    const launchPort = cdpPort > 0 ? cdpPort : 0;
    const child = spawn(executable, browserLaunchArgs(userDataDir, launchPort), { stdio: "ignore", detached: false });
    browserProcess = child;
    child.once("exit", (code, signal) => {
      browserProcessState.lastExit = {
        code,
        signal,
        exitedAt: new Date().toISOString(),
        pid: child.pid || null,
      };
      if (browserProcess === child) browserProcess = null;
    });
    cdpPort = await waitForManagedCdpEndpoint({ requestedPort: launchPort, userDataDir });
    browserProcessState.lastLaunchSucceededAt = new Date().toISOString();
    await minimizeBrowserWindow(child.pid);
    return child;
  }

  async function ensureManagedCdp(reason) {
    const liveBrowserVersion = await cdpJson(cdpPort, "/json/version").catch(() => null);
    if (liveBrowserVersion) {
      return { browserVersion: liveBrowserVersion, recoveryAttempted: false, recovered: false, error: null };
    }
    if (!launchBrowser) {
      return { browserVersion: null, recoveryAttempted: false, recovered: false, error: null };
    }
    if (!browserRelaunchInFlight) {
      browserRelaunchInFlight = (async () => {
        try {
          if (browserProcess && !browserProcess.killed && browserProcess.exitCode === null) {
            browserProcess.kill();
            await waitForExit(browserProcess, 2500);
          }
          browserProcessState.relaunchCount += 1;
          await launchManagedBrowser(reason);
          const recoveredVersion = await cdpJson(cdpPort, "/json/version").catch(() => null);
          return { browserVersion: recoveredVersion, recoveryAttempted: true, recovered: Boolean(recoveredVersion), error: null };
        } catch (err) {
          return { browserVersion: null, recoveryAttempted: true, recovered: false, error: String(err) };
        } finally {
          browserRelaunchInFlight = null;
        }
      })();
    }
    return await browserRelaunchInFlight;
  }

  if (launchBrowser && !existingBrowser) {
    await launchManagedBrowser("startup");
  }

  // Step 4e: personal-only mode. When operator didn't request a managed launch
  // and no foreign Chrome is already on cdpPort, start a stub HTTP endpoint so
  // the boot chain's CDP probes succeed. All real browser work routes via the
  // personal bridge separately.
  if (!launchBrowser && !(await cdpEndpointAvailable(cdpPort))) {
    await startStubCdpServer(cdpPort);
    console.error(`[agent-cdp-server] personal-only mode: stub CDP server listening on 127.0.0.1:${cdpPort}`);
  }

  await waitForCdp(cdpPort);
  existingBrowser = !browserProcess && await cdpEndpointAvailable(cdpPort);

  // Root cause #7: if we are attaching to a browser we did NOT launch (a
  // pre-existing one on the fixed CDP port), verify it is actually the worker's
  // own managed browser before driving it. Skip when we launched it ourselves.
  let managedBrowserOwnership = browserProcess
    ? { verified: true, checked: false, reason: "launched-by-worker" }
    : { verified: false, checked: false, reason: "not-checked" };
  if (existingBrowser) {
    const expectedUserDataDir =
      process.env.CDP_BROWSER_USER_DATA_DIR || join(dataDir, "browser-identities", profile);
    managedBrowserOwnership = await verifyManagedBrowserOwnership(cdpPort, expectedUserDataDir);
    if (managedBrowserOwnership.checked && !managedBrowserOwnership.verified) {
      console.error(
        `[agent-cdp-server] WARNING: attaching to a browser on CDP port ${cdpPort} that does NOT match the worker's ` +
        `user-data-dir (${expectedUserDataDir}). reason=${managedBrowserOwnership.reason} ` +
        `foreign=${JSON.stringify(managedBrowserOwnership.foreignUserDataDirs || [])}. ` +
        `This is likely a foreign browser (the user's own Edge or a leftover). The worker will report a blocker ` +
        `instead of silently driving it.`,
      );
    }
  }

  const browserVersion = await cdpJson(cdpPort, "/json/version").catch(() => null);
  const browserRuntimeIdentity = buildBrowserRuntimeIdentity({
    cdpPort,
    requestedCdpPort,
    cdpPortMode,
    existingBrowser,
    browserProcess,
    browserVersion,
    executable: selectedBrowserExecutable,
    userDataDir: selectedBrowserUserDataDir,
    launchMode: browserLaunchMode,
    headless: browserHeadless,
  });
  const configManager = createConfigManager({ defaultProfile: profile, cdpPort, dataDir });
  const configPath = configManager.configPath;

  const pluginPath = join(root, "dist/plugins/cdp-traffic-capture/index.js");
  let entry;
  try {
    entry = await import(pathToFileURL(pluginPath).href);
  } catch (err) {
    throw new Error(
      `[agent-cdp-server] cdp-traffic-capture plugin not found at ${pluginPath}.\n` +
      `Run 'npm run build' to compile plugins, then restart the server.\n` +
      `Original error: ${err?.message || err}`
    );
  }
  const harness = createPluginHost();
  entry.default.register(harness.api);
  const profileRegistry = createProfileRegistry({
    cdpPort,
    dataDir,
    onProfileReady: async (record) => {
      configManager.ensureProfile(record.name, record);
      for (const service of harness.services) await service.start?.();
    },
  });
  // Root cause #8: proactively clear stale profile->tab bindings when a tab is
  // destroyed, so the next use rebuilds in the same browser context instead of
  // hitting a dead handle. Fail-open; never blocks startup.
  let shuttingDown = false;
  const targetWatcher = startTargetDestroyedWatcher({
    getCdpPort: () => cdpPort,
    isStopped: () => shuttingDown,
    onDestroyed: async (tabId) => {
      const affected = await profileRegistry.markTabDestroyed(tabId);
      if (affected.length > 0) {
        console.error(`[agent-cdp-server] tab ${tabId} destroyed; cleared stale binding for profiles: ${affected.join(", ")}`);
      }
    },
  });
  // Worker-owned startup must not leave an unbound blank tab behind. Chromium
  // may create a first empty page even when no URL is passed, so clean both the
  // pre-profile snapshot and a post-startup blank scan. Only do this for a
  // browser process launched by this worker; never clean someone else's browser.
  const launchedByWorker = Boolean(browserProcess);
  const orphanPageIds = launchedByWorker
    ? (((await cdpJson(cdpPort, "/json").catch(() => [])) || [])
        .filter((t) => t && t.type === "page").map((t) => t.id))
    : [];
  await profileRegistry.ensureProfileRecord(profile);
  if (launchedByWorker) {
    const isStartupBlankUrl = (raw) => {
      const value = String(raw || "").toLowerCase();
      return !value || value === "about:blank" || value === "edge://newtab/" || value === "chrome://newtab/";
    };
    const closeStartupBlanks = async (extraIds = []) => {
      const startupBlankIds = (((await cdpJson(cdpPort, "/json").catch(() => [])) || [])
        .filter((t) => t && t.type === "page" && isStartupBlankUrl(t.url))
        .map((t) => t.id));
      for (const id of new Set([...extraIds, ...startupBlankIds])) {
        await cdpJson(cdpPort, `/json/close/${encodeURIComponent(id)}`).catch(() => {});
      }
    };
    await closeStartupBlanks(orphanPageIds);
    await sleep(1000);
    await closeStartupBlanks();
    await sleep(250);
    await closeStartupBlanks();
  }
  registerStandaloneBrowserTools(harness.tools, cdpPort, profileRegistry, profile, {
    dataDir,
    browserRuntimeIdentity,
    ensureManagedCdp,
    browserProcessSummary,
    cdpPortMode,
    profilePortReconciliation: configManager.runtimePortReconciliation,
    runtimeIdentityFor: (liveBrowserVersion) => buildBrowserRuntimeIdentity({
      cdpPort,
      requestedCdpPort,
      cdpPortMode,
      existingBrowser,
      browserProcess,
      browserVersion: liveBrowserVersion,
      executable: selectedBrowserExecutable,
      userDataDir: selectedBrowserUserDataDir,
      launchMode: browserLaunchMode,
      headless: browserHeadless,
    }),
  });
  for (const service of harness.services) await service.start?.();

  // M-01: DNS rebinding guard — only allow requests whose Host header resolves to
  // a known-safe value. This prevents a malicious page from using DNS rebinding to
  // reach this server through a same-origin loophole in the browser.
  // Allowed patterns:
  //   • 127.0.0.1[:port] and localhost[:port]  — always safe (loopback)
  //   • 100.x.x.x[:port]                       — Tailscale tailnet range
  // When CDP_AGENT_SERVER_TOKEN is set the token already proves identity, so the
  // Host check is skipped (the attacker cannot forge a token).
  // The /health endpoint skips the check so worker-doctor can always query status.
  const serverToken = process.env.CDP_AGENT_SERVER_TOKEN || null;
  function isDnsRebindingSafe(hostHeader) {
    if (!hostHeader) return true; // no Host → local curl / direct connection
    const host = hostHeader.split(":")[0].toLowerCase();
    return (
      host === "127.0.0.1" ||
      host === "localhost" ||
      /^100\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
    );
  }

  // timing-safe bearer token comparison
  function tokenMatches(provided, expected) {
    if (typeof provided !== "string" || typeof expected !== "string") return false;
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

      // M-01: reject DNS-rebinding attempts on all non-health endpoints.
      // Token-authenticated requests are exempt (token proves identity).
      if (url.pathname !== "/health" && !serverToken && !isDnsRebindingSafe(req.headers.host)) {
        sendJson(res, 403, { error: "dns_rebinding_rejected", reason: "Host header not in allowed list (127.0.0.1 / localhost / 100.x.x.x)" });
        return;
      }

      // C-01: bearer-token auth gate — only applies when CDP_AGENT_SERVER_TOKEN is set.
      // The /health endpoint is always exempt so browser_worker_doctor can check status.
      if (serverToken && url.pathname !== "/health") {
        const authHeader = req.headers["authorization"] || "";
        const provided = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : null;
        if (!tokenMatches(provided, serverToken)) {
          sendJson(res, 401, { error: "unauthorized", reason: "Missing or invalid Authorization: Bearer token" });
          return;
        }
      }

      if (req.method === "GET" && url.pathname === "/health") {
        const recovery = await ensureManagedCdp("health");
        const liveBrowserVersion = recovery.browserVersion;
        const cdpReachable = Boolean(liveBrowserVersion);
        const liveRuntimeIdentity = cdpReachable
          ? buildBrowserRuntimeIdentity({
              cdpPort,
              requestedCdpPort,
              cdpPortMode,
              existingBrowser,
              browserProcess,
              browserVersion: liveBrowserVersion,
              executable: selectedBrowserExecutable,
              userDataDir: selectedBrowserUserDataDir,
              launchMode: browserLaunchMode,
              headless: browserHeadless,
            })
          : { ...browserRuntimeIdentity, reachable: false };
        const profilePortSummary = summarizeProfilePortConfig(configPath, cdpPort, { cdpPortMode });
        // Root cause #7: a foreign browser squatting on the CDP port is only a
        // blocker while we are still attached to it (no browserProcess of our
        // own). If the worker has since launched its own browser, clear it.
        const foreignAttach =
          !browserProcess &&
          managedBrowserOwnership.checked === true &&
          managedBrowserOwnership.verified === false &&
          managedBrowserOwnership.reason === "foreign-browser-on-port";
        const blockers = [
          ...(cdpReachable ? [] : ["managed-cdp-unreachable"]),
          ...(profilePortSummary.ok ? [] : ["profile-port-drift"]),
          ...(foreignAttach ? ["foreign-browser-on-cdp-port"] : []),
        ];
        sendJson(res, 200, {
          ok: cdpReachable && profilePortSummary.ok && !foreignAttach,
          managedBrowserOwnership,
          defaultProfile: profile,
          cdpPort,
          requestedCdpPort,
          cdpPortMode,
          cdpEndpoint: `http://127.0.0.1:${cdpPort}`,
          cdpHealth: {
            reachable: cdpReachable,
            checkedAt: new Date().toISOString(),
            failureMode: cdpReachable ? null : "managed-cdp-unreachable",
            recoveryAttempted: recovery.recoveryAttempted,
            recovered: recovery.recovered,
            recoveryError: recovery.error,
          },
          browserAttachMode: liveRuntimeIdentity.attachMode,
          browserLaunchMode: liveRuntimeIdentity.launchMode,
          browserHeadless: liveRuntimeIdentity.headless,
          browserRuntimeIdentity: liveRuntimeIdentity,
          professionalDefault: "headful-managed-browser",
          // Reflect the actual selected browser, not a hardcoded hint. Pre-this-commit
          // this was "CloakBrowser" verbatim, which was misleading on every machine
          // that did NOT have CloakBrowser installed (fell back to Edge/Chrome but
          // still reported preferredBrowser:"CloakBrowser"), causing operators to
          // think Cloak was in use when it wasn't.
          preferredBrowser:
            process.env.CDP_BROWSER_USE_CLOAK === "1"
              ? "CloakBrowser"
              : liveRuntimeIdentity.physicalBrowser || "Chrome",
          launchedByServer: Boolean(browserProcess),
          browserProcess: browserProcessSummary(),
          browserUserDataDir: liveRuntimeIdentity.userDataDir || undefined,
          profilePortSummary,
          profilePortReconciliation: configManager.runtimePortReconciliation,
          blockers,
          suggestedNext: [
            ...(cdpReachable
              ? []
              : [
                "Run agent-browser backend status to trigger managed browser recovery, or restart the managed worker with CDP_LAUNCH_BROWSER=1.",
                `Check whether another process owns or killed CDP port ${cdpPort}.`,
              ]),
            ...(foreignAttach
              ? [
                `A foreign browser owns CDP port ${cdpPort} (user-data-dir ${JSON.stringify(managedBrowserOwnership.foreignUserDataDirs || [])} != the worker's). Close it (or free the port) and restart the worker so it launches its own managed browser.`,
              ]
              : []),
            ...(profilePortSummary.next || []),
          ],
          configPath,
          profileRegistryFile: profileRegistry.registryFile,
          feedbackUrl: `http://${serverHost}:${serverPort}/feedback`,
          tools: [...harness.tools.keys()],
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/tools") {
        sendJson(res, 200, {
          tools: [...harness.tools.values()].map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/panel") {
        sendHtml(res, 200, panelHtml());
        return;
      }
      if (req.method === "GET" && url.pathname === "/feedback") {
        sendHtml(res, 200, feedbackHtml());
        return;
      }
      if (req.method === "GET" && url.pathname === "/feedback-data") {
        sendJson(res, 200, listFeedbackNotes({ limit: Number(url.searchParams.get("limit") || 50) }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/feedback-note") {
        const params = await readJson(req);
        sendJson(res, 200, {
          ...createFeedbackNote({
            ...params,
            reporter: params.reporter || "feedback-http",
          }),
          docs: "docs/feedback-and-gaps.md",
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/panel-data") {
        const requestedProfile = url.searchParams.get("profile") || profile;
        const profiles = profileRegistry.listProfiles().map((entry) => ({
          name: entry.name,
          title: entry.title,
          url: entry.url,
          createdAt: entry.createdAt,
          lastUsedAt: entry.lastUsedAt,
        }));
        let current = null;
        try {
          const tool = harness.tools.get("browser_page_diagnostics");
          const result = await tool.execute("agent-cdp-server", { profile: requestedProfile, limit: 5 });
          current = JSON.parse(result.content?.[0]?.text || "{}");
          const captureResult = await harness.tools.get("browser_capture_status").execute("agent-cdp-server", { profile: requestedProfile });
          current.captureStatus = JSON.parse(captureResult.content?.[0]?.text || "{}");
          const signalResult = await harness.tools.get("browser_signal_summary").execute("agent-cdp-server", { profile: requestedProfile, limit: 5 });
          current.signalSummary = JSON.parse(signalResult.content?.[0]?.text || "{}");
          const { tabId: _tabId, evidenceDir: _evidenceDir, ...safeCurrent } = current;
          current = safeCurrent;
        } catch (error) {
          current = { error: String(error?.message || error), profile: requestedProfile };
        }
        sendJson(res, 200, {
          ok: true,
          defaultProfile: profile,
          selectedProfile: requestedProfile,
          profiles,
          current,
        });
        return;
      }
      if (req.method === "POST" && url.pathname.startsWith("/tool/")) {
        const toolName = decodeURIComponent(url.pathname.slice("/tool/".length));
        const tool = harness.tools.get(toolName);
        if (!tool) {
          sendJson(res, 404, { error: "tool_not_found", toolName });
          return;
        }
        const params = await readJson(req);
        const validation = validateParams(params, tool.parameters);
        if (!validation.ok) {
          sendJson(res, 400, validation);
          return;
        }
        const t0 = Date.now();
        let result;
        try {
          result = await tool.execute("agent-cdp-server", params);
        } catch (err) {
          if (typeof err?.httpStatus === "number") throw err;
          result = toolResult({ ok: false, error: String(err?.message || err), tool: toolName });
        }
        const durationMs = Date.now() - t0;
        const text = result.content?.[0]?.text ?? "{}";
        const payload = JSON.parse(text);
        // Preserve MCP-shaped content array (e.g. image) so the MCP bridge can pass
        // images and other non-text resources back to the agent. HTTP clients that
        // do not consume _mcp can ignore this field; the original payload is unchanged.
        if (Array.isArray(result.content) && result.content.length > 1) {
          payload._mcp = { content: result.content };
        }
        // Agent Workspace: record tool usage for self-improving tool selection
        if (params?.profile) {
          try {
            const pDir = profileRegistry && typeof profileRegistry.profileDir === "function"
              ? profileRegistry.profileDir(params.profile)
              : null;
            if (pDir) {
              recordToolUsage(pDir, toolName, {
                ok: payload?.ok !== false,
                durationMs,
              });
            }
          } catch { /* best-effort telemetry */ }
        }
        sendJson(res, 200, payload);
        return;
      }
      if (req.method === "POST" && url.pathname === "/shutdown") {
        sendJson(res, 200, { ok: true, shuttingDown: true });
        setTimeout(() => {
          void shutdown().finally(() => process.exit(0));
        }, 50);
        return;
      }
      sendJson(res, 404, { error: "not_found" });
    } catch (err) {
      // H-08: propagate 413 from readJson body-size guard
      const status = (err && typeof err.httpStatus === "number") ? err.httpStatus : 500;
      sendJson(res, status, { error: String(err) });
    }
  });

  async function shutdown() {
    shuttingDown = true;
    await targetWatcher.stop().catch(() => {});
    server.close();
    server.closeAllConnections?.();
    for (const service of harness.services.reverse()) await service.stop?.();
    if (browserProcess && !browserProcess.killed) {
      browserProcess.kill();
      await waitForExit(browserProcess);
    }
  }

  function shutdownWithTimeout(timeoutMs = 15000) {
    const timer = setTimeout(() => {
      console.error("[agent-cdp-server] shutdown timed out after", timeoutMs, "ms — forcing exit");
      process.exit(1);
    }, timeoutMs);
    timer.unref();
    shutdown().then(() => { clearTimeout(timer); process.exit(0); }).catch(() => { clearTimeout(timer); process.exit(1); });
  }

  process.once("SIGINT", () => shutdownWithTimeout());
  process.once("SIGTERM", () => shutdownWithTimeout());

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[agent-cdp-server] Port ${serverPort} is already in use.`);
      console.error(`  Another agent-cdp-server may be running. Check with:`);
      console.error(`    netstat -ano | findstr :${serverPort}   (Windows)`);
      console.error(`    lsof -i :${serverPort}                  (Linux/macOS)`);
      console.error(`  To use a different port: CDP_AGENT_SERVER_PORT=<port> node agent-cdp-server.mjs`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(serverPort, serverHost, () => {
    console.log("Agent CDP server ready:");
    console.log(`- http://${serverHost}:${serverPort}/health`);
    console.log(`- default profile: ${profile}`);
    console.log(`- profile registry: ${profileRegistry.registryFile}`);
    console.log(`- browser CDP: http://127.0.0.1:${cdpPort} (${cdpPortMode})`);
    console.log(`- browser launch mode: ${existingBrowser ? "existing-cdp-browser" : browserLaunchMode}`);
    console.log(`- config: ${configPath}`);
    console.log();
    console.log(`Agent Browser Runtime worker ready: http://${serverHost}:${serverPort}`);
    console.log(`Health check: curl http://${serverHost}:${serverPort}/health`);
    console.log(`Stop with Ctrl+C.`);
  });
}

// SF-12: top-level safety net so an uncaught error doesn't silently kill the server
// without any diagnostic. The worker is the critical path for all agents; a silent
// crash would surface only as ECONNREFUSED with no context.
process.on("uncaughtException", (err) => {
  console.error("[agent-cdp-server] uncaughtException — server may be unstable:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[agent-cdp-server] unhandledRejection — server may be unstable:", reason);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
