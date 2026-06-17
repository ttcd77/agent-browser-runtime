// Pure trace / performance / CPU-profile view-model builders, extracted from
// agent-cdp-server.mjs (2026-06-06 monolith carve, behavior-preserving). No CDP
// and no module state: each operates over already-captured Chrome trace event
// arrays, PerformanceObserver snapshots, or CPU profiles and returns an
// objective summary / diff using only JS stdlib. The trace-screenshot and
// trace-path helpers touch the local filesystem (write extracted frames, list
// saved trace JSON) exactly like the already-extracted evidence-artifacts
// helpers, so node:fs / node:path are imported here. Unit-tested in
// trace-summaries.test.mjs.

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function classifyTraceEvent(name, category) {
  const text = `${name} ${category}`.toLowerCase();
  if (/urlrequest|resource|network|netlog|sendrequest|receiveresponse|loading/.test(text)) return "network";
  if (/parsehtml|commitload|navigation|markload|markDOMContent|firstcontentfulpaint/i.test(name)) return "loading";
  if (/functioncall|evaluatescript|v8|timerfire|eventdispatch|runtask|compile|parse script|javascript/i.test(name)) return "scripting";
  if (/layout|style|recalculatestyle|updatelayouttree|invalidate/i.test(name)) return "rendering";
  if (/paint|raster|composite|draw|gpu/i.test(name)) return "painting";
  return "other";
}

export function addTraceBucket(map, key, durationMs, count = 1) {
  const bucket = map[key] || { count: 0, durationMs: 0 };
  bucket.count += count;
  bucket.durationMs += durationMs;
  map[key] = bucket;
}

export function summarizeRenderingTimeline(events = [], limit = 50) {
  const rows = [];
  let minTs = Infinity;
  for (const event of events) {
    if (typeof event.ts === "number") minTs = Math.min(minTs, event.ts);
  }
  for (const event of events) {
    if (typeof event.ts !== "number") continue;
    const name = String(event.name || "(unknown)");
    const phase = classifyTraceEvent(name, event.cat);
    const isScreenshot = name.toLowerCase().includes("screenshot");
    if (!isScreenshot && !["loading", "scripting", "rendering", "painting"].includes(phase)) continue;
    rows.push({
      name,
      phase: isScreenshot ? "screenshot" : phase,
      category: event.cat || "",
      ts: event.ts,
      startOffsetMs: Number.isFinite(minTs) ? Math.round(((event.ts - minTs) / 1000) * 100) / 100 : null,
      durationMs: typeof event.dur === "number" ? Math.round((event.dur / 1000) * 100) / 100 : 0,
      thread: event.tid,
      process: event.pid,
      frame: event.args?.frame || event.args?.frameId || event.args?.data?.frame || null,
      data: event.args?.data ? {
        url: event.args.data.url,
        requestId: event.args.data.requestId,
        nodeId: event.args.data.nodeId,
        layerId: event.args.data.layerId,
        clip: event.args.data.clip,
      } : null,
    });
  }
  rows.sort((a, b) => a.ts - b.ts || b.durationMs - a.durationMs);
  return {
    eventCount: rows.length,
    returnedCount: Math.min(rows.length, limit),
    rows: rows.slice(0, limit),
    truncated: rows.length > limit,
    captureBoundaries: [
      "Rendering timeline is derived from Chrome trace events exposed by DevTools Tracing.",
      "It groups observed loading, scripting, rendering, painting, and screenshot events by timestamp.",
      "This is an objective event timeline, not a root-cause or vulnerability judgment.",
    ],
  };
}

export function summarizeLayoutPaintFlameChart(events = [], limit = 50) {
  const candidates = [];
  let minTs = Infinity;
  for (const event of events) {
    if (typeof event.ts !== "number") continue;
    minTs = Math.min(minTs, event.ts);
    const name = String(event.name || "(unknown)");
    const phase = classifyTraceEvent(name, event.cat);
    if (!["rendering", "painting"].includes(phase)) continue;
    if (typeof event.dur !== "number" || event.dur <= 0) continue;
    candidates.push({
      event,
      name,
      phase,
      threadKey: `${event.pid || "?"}:${event.tid || "?"}`,
      start: event.ts,
      end: event.ts + event.dur,
      durationMs: Math.round((event.dur / 1000) * 100) / 100,
    });
  }

  candidates.sort((a, b) => a.threadKey.localeCompare(b.threadKey) || a.start - b.start || b.end - a.end);
  const activeByThread = new Map();
  const rows = [];
  const phaseBuckets = {};
  const threadBuckets = {};

  for (const item of candidates) {
    const active = activeByThread.get(item.threadKey) || [];
    while (active.length && active[active.length - 1] <= item.start) active.pop();
    const depth = active.length;
    active.push(item.end);
    activeByThread.set(item.threadKey, active);
    addTraceBucket(phaseBuckets, item.phase, item.durationMs);
    addTraceBucket(threadBuckets, item.threadKey, item.durationMs);
    rows.push({
      name: item.name,
      phase: item.phase,
      category: item.event.cat || "",
      thread: item.event.tid,
      process: item.event.pid,
      threadKey: item.threadKey,
      depth,
      ts: item.start,
      startOffsetMs: Number.isFinite(minTs) ? Math.round(((item.start - minTs) / 1000) * 100) / 100 : null,
      durationMs: item.durationMs,
      frame: item.event.args?.frame || item.event.args?.frameId || item.event.args?.data?.frame || null,
      nodeId: item.event.args?.data?.nodeId || null,
      layerId: item.event.args?.data?.layerId || null,
      clip: item.event.args?.data?.clip || null,
    });
  }

  const topDurationBuckets = (object) => Object.entries(object)
    .sort((a, b) => b[1].durationMs - a[1].durationMs)
    .slice(0, limit)
    .map(([name, value]) => ({
      name,
      count: value.count,
      durationMs: Math.round(value.durationMs * 100) / 100,
    }));

  return {
    eventCount: rows.length,
    returnedCount: Math.min(rows.length, limit),
    threadCount: new Set(rows.map((row) => row.threadKey)).size,
    maxDepth: rows.reduce((max, row) => Math.max(max, row.depth), 0),
    byPhase: topDurationBuckets(phaseBuckets),
    byThread: topDurationBuckets(threadBuckets),
    rows: rows.slice(0, limit),
    truncated: rows.length > limit,
    captureBoundaries: [
      "Layout/paint flame chart rows are reconstructed from complete Chrome trace events with timestamps and durations.",
      "Depth is a same-thread nesting approximation for rendering and painting events, not a causal dependency graph.",
      "Missing rows mean Chrome did not expose matching trace events in this capture window.",
    ],
  };
}

export function summarizeTraceEvents(events = [], limit = 10) {
  const byCategory = {};
  const byName = {};
  const byPhase = {};
  const byThread = {};
  const byProcess = {};
  const longEvents = [];
  const screenshots = [];
  const networkLike = [];
  const topDurations = [];
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const event of events) {
    const categories = String(event.cat || "").split(",").filter(Boolean);
    for (const category of categories) byCategory[category] = (byCategory[category] || 0) + 1;
    const name = String(event.name || "(unknown)");
    byName[name] = (byName[name] || 0) + 1;
    if (typeof event.ts === "number") {
      minTs = Math.min(minTs, event.ts);
      maxTs = Math.max(maxTs, event.ts + (typeof event.dur === "number" ? event.dur : 0));
    }
    const durationMs = typeof event.dur === "number" ? event.dur / 1000 : 0;
    if (durationMs > 0) {
      const phase = classifyTraceEvent(name, event.cat);
      addTraceBucket(byPhase, phase, durationMs);
      addTraceBucket(byThread, `${event.pid || "?"}:${event.tid || "?"}`, durationMs);
      addTraceBucket(byProcess, String(event.pid || "?"), durationMs);
      topDurations.push({
        name,
        category: event.cat,
        phase,
        ts: event.ts,
        durationMs: Math.round(durationMs * 100) / 100,
        thread: event.tid,
        process: event.pid,
      });
    }
    if (typeof event.dur === "number" && event.dur >= 50_000) {
      longEvents.push({
        name,
        category: event.cat,
        phase: classifyTraceEvent(name, event.cat),
        ts: event.ts,
        durationMs: Math.round(event.dur / 1000),
        thread: event.tid,
        process: event.pid,
      });
    }
    if (name.toLowerCase().includes("screenshot")) {
      screenshots.push({ name, ts: event.ts, args: event.args });
    }
    if (String(event.cat || "").includes("netlog") || /^Resource|^Network|URLRequest/i.test(name)) {
      networkLike.push({ name, category: event.cat, ts: event.ts, args: event.args });
    }
  }
  longEvents.sort((a, b) => b.durationMs - a.durationMs);
  topDurations.sort((a, b) => b.durationMs - a.durationMs);
  const topEntries = (object) => Object.entries(object)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
  const topDurationBuckets = (object) => Object.entries(object)
    .sort((a, b) => b[1].durationMs - a[1].durationMs)
    .slice(0, limit)
    .map(([name, value]) => ({
      name,
      count: value.count,
      durationMs: Math.round(value.durationMs * 100) / 100,
    }));
  return {
    eventCount: events.length,
    timeRangeMs: Number.isFinite(minTs) && Number.isFinite(maxTs) ? Math.round((maxTs - minTs) / 1000) : 0,
    topCategories: topEntries(byCategory),
    topNames: topEntries(byName),
    durationByPhase: topDurationBuckets(byPhase),
    busiestThreads: topDurationBuckets(byThread),
    busiestProcesses: topDurationBuckets(byProcess),
    topDurations: topDurations.slice(0, limit),
    renderingTimeline: summarizeRenderingTimeline(events, limit),
    layoutPaintFlameChart: summarizeLayoutPaintFlameChart(events, limit),
    longEventCount: longEvents.length,
    longEvents: longEvents.slice(0, limit),
    screenshotEventCount: screenshots.length,
    screenshots: screenshots.slice(0, limit),
    networkEventCount: networkLike.length,
    networkEvents: networkLike.slice(0, limit),
  };
}

export function summarizePerformanceInsights(page = {}, chromeTrace = null, limit = 10) {
  const performancePage = page?.page || page || {};
  const resources = Array.isArray(performancePage.resources) ? performancePage.resources : [];
  const longTasks = Array.isArray(performancePage.longTasks) ? performancePage.longTasks : [];
  const paints = Array.isArray(performancePage.paints) ? performancePage.paints : [];
  const navigation = Array.isArray(performancePage.navigation) ? performancePage.navigation[0] : null;
  const slowResources = resources
    .map((entry) => ({
      name: entry.name,
      initiatorType: entry.initiatorType,
      duration: Math.round(Number(entry.duration || 0) * 100) / 100,
      transferSize: entry.transferSize,
      encodedBodySize: entry.encodedBodySize,
      decodedBodySize: entry.decodedBodySize,
      renderBlockingStatus: entry.renderBlockingStatus,
    }))
    .filter((entry) => entry.duration > 0)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, limit);
  const longestLongTasks = longTasks
    .map((entry) => ({
      name: entry.name,
      startTime: Math.round(Number(entry.startTime || 0) * 100) / 100,
      duration: Math.round(Number(entry.duration || 0) * 100) / 100,
      attribution: entry.attribution,
    }))
    .sort((a, b) => b.duration - a.duration)
    .slice(0, limit);
  const traceSummary = chromeTrace?.traceSummary || chromeTrace?.summary || null;
  const traceLongEvents = Array.isArray(traceSummary?.longEvents) ? traceSummary.longEvents.slice(0, limit) : [];
  return {
    generatedAt: new Date().toISOString(),
    source: {
      performanceEntries: true,
      chromeTrace: Boolean(traceSummary),
      tracePath: chromeTrace?.tracePath || null,
    },
    page: {
      url: performancePage.url || null,
      durationMs: performancePage.durationMs || null,
      timeOrigin: performancePage.timeOrigin || null,
    },
    navigation: navigation ? {
      type: navigation.type,
      duration: Math.round(Number(navigation.duration || 0) * 100) / 100,
      domContentLoadedEventEnd: navigation.domContentLoadedEventEnd,
      loadEventEnd: navigation.loadEventEnd,
      transferSize: navigation.transferSize,
      encodedBodySize: navigation.encodedBodySize,
      decodedBodySize: navigation.decodedBodySize,
    } : null,
    paints,
    resourceCount: resources.length,
    slowResources,
    longTaskCount: longTasks.length,
    longestLongTasks,
    trace: traceSummary ? {
      eventCount: traceSummary.eventCount,
      timeRangeMs: traceSummary.timeRangeMs,
      durationByPhase: traceSummary.durationByPhase || [],
      busiestThreads: traceSummary.busiestThreads || [],
      topDurations: traceSummary.topDurations || [],
      longEventCount: traceSummary.longEventCount || 0,
      longEvents: traceLongEvents,
      screenshotEventCount: traceSummary.screenshotEventCount || 0,
    } : null,
    captureBoundaries: [
      "Performance entries describe the current page's browser-exposed timing state.",
      "Long task attribution is browser-provided and may be sparse.",
      "Chrome trace evidence is complete only for the explicit trace window.",
      "This is objective performance evidence, not a root-cause verdict.",
    ],
    nextTools: ["browser_chrome_trace", "browser_cpu_profile", "browser_coverage_detail", "browser_source_get"],
  };
}

export function summarizePerformanceObserverSnapshot(snapshot = {}, limit = 10) {
  const entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
  const byTypeCount = {};
  for (const entry of entries) {
    const type = entry.entryType || "unknown";
    byTypeCount[type] = (byTypeCount[type] || 0) + 1;
  }
  const supportedEntryTypes = Array.isArray(snapshot.supportedEntryTypes) ? snapshot.supportedEntryTypes : [];
  const requestedEntryTypes = Array.isArray(snapshot.requestedEntryTypes) ? snapshot.requestedEntryTypes : [];
  const unsupportedEntryTypes = Array.isArray(snapshot.unsupportedEntryTypes)
    ? snapshot.unsupportedEntryTypes
    : requestedEntryTypes.filter((type) => !supportedEntryTypes.includes(type));
  const observeErrors = Array.isArray(snapshot.observeErrors) ? snapshot.observeErrors : [];
  const observedEntryTypes = Object.keys(byTypeCount).sort();
  const entryTypeCoverage = requestedEntryTypes.map((type) => {
    const observeError = observeErrors.find((error) => error?.type === type)?.error || null;
    return {
      type,
      requested: true,
      supported: supportedEntryTypes.includes(type),
      observed: Boolean(byTypeCount[type]),
      count: byTypeCount[type] || 0,
      unsupported: unsupportedEntryTypes.includes(type),
      observeError,
    };
  });
  const byType = (type) => entries.filter((entry) => entry.entryType === type);
  const round = (value) => Math.round(Number(value || 0) * 100) / 100;
  const topByDuration = (type) => byType(type)
    .map((entry) => ({
      name: entry.name || null,
      startTime: round(entry.startTime),
      duration: round(entry.duration),
      url: entry.url || entry.renderURL || null,
      detail: entry.detail || null,
      value: entry.value,
      hadRecentInput: entry.hadRecentInput,
    }))
    .sort((a, b) => b.duration - a.duration)
    .slice(0, limit);
  const layoutShifts = byType("layout-shift");
  const unexpectedLayoutShifts = layoutShifts.filter((entry) => !entry.hadRecentInput);
  const lcpCandidates = byType("largest-contentful-paint").sort((a, b) => Number(a.startTime || 0) - Number(b.startTime || 0));
  const lcp = lcpCandidates.at(-1) || null;
  const resources = byType("resource")
    .map((entry) => ({
      name: entry.name,
      initiatorType: entry.initiatorType,
      startTime: round(entry.startTime),
      duration: round(entry.duration),
      transferSize: entry.transferSize,
      encodedBodySize: entry.encodedBodySize,
      decodedBodySize: entry.decodedBodySize,
    }))
    .sort((a, b) => b.duration - a.duration)
    .slice(0, limit);
  return {
    generatedAt: new Date().toISOString(),
    source: "PerformanceObserver",
    supportedEntryTypes,
    requestedEntryTypes,
    observedEntryTypes,
    unsupportedEntryTypes,
    observeErrors,
    entryTypeCoverage,
    entryCount: entries.length,
    byTypeCount,
    largestContentfulPaint: lcp ? {
      name: lcp.name || null,
      startTime: round(lcp.startTime),
      renderTime: round(lcp.renderTime),
      loadTime: round(lcp.loadTime),
      size: lcp.size,
      url: lcp.url || null,
      id: lcp.id || null,
    } : null,
    layoutShift: {
      count: layoutShifts.length,
      totalScore: Math.round(layoutShifts.reduce((sum, entry) => sum + Number(entry.value || 0), 0) * 10000) / 10000,
      unexpectedScore: Math.round(unexpectedLayoutShifts.reduce((sum, entry) => sum + Number(entry.value || 0), 0) * 10000) / 10000,
      top: layoutShifts
        .map((entry) => ({
          startTime: round(entry.startTime),
          value: entry.value,
          hadRecentInput: Boolean(entry.hadRecentInput),
          sourceCount: Array.isArray(entry.sources) ? entry.sources.length : 0,
          sources: Array.isArray(entry.sources) ? entry.sources.slice(0, 5) : [],
        }))
        .sort((a, b) => Number(b.value || 0) - Number(a.value || 0))
        .slice(0, limit),
    },
    longTasks: {
      count: byType("longtask").length,
      top: topByDuration("longtask"),
    },
    longAnimationFrames: {
      count: byType("long-animation-frame").length,
      top: topByDuration("long-animation-frame"),
    },
    eventTiming: {
      count: byType("event").length,
      top: topByDuration("event"),
    },
    paints: byType("paint").map((entry) => ({ name: entry.name, startTime: round(entry.startTime), duration: round(entry.duration) })),
    navigation: byType("navigation").slice(0, 1),
    slowResources: resources,
    captureBoundaries: [
      "PerformanceObserver reports entries Chrome exposes to the current page context.",
      "Some entry types are browser-version dependent and appear in unsupportedEntryTypes when unavailable.",
      "entryTypeCoverage distinguishes unsupported entry types from supported-but-not-observed entry types.",
      "Entries are complete only for buffered entries plus the explicit observation window.",
      "This is objective timing evidence, not a root-cause verdict.",
    ],
    nextTools: ["browser_performance_insights", "browser_chrome_trace", "browser_cpu_profile", "browser_cdp_command"],
  };
}

export function extractTraceScreenshots(events = [], directory, options = {}) {
  const maxScreenshots = Math.max(0, Number(options.maxScreenshots || 5));
  if (!maxScreenshots || !directory) return [];
  mkdirSync(directory, { recursive: true });
  const frames = [];
  for (const event of events) {
    if (frames.length >= maxScreenshots) break;
    const name = String(event?.name || "");
    const snapshot = event?.args?.snapshot;
    if (!name.toLowerCase().includes("screenshot") || typeof snapshot !== "string" || !snapshot) continue;
    const safeTs = String(event.ts || Date.now()).replace(/[^a-zA-Z0-9_.-]/g, "_");
    const path = join(directory, `${safeTs}-trace-screenshot.jpg`);
    const bytes = Buffer.from(snapshot, "base64");
    writeFileSync(path, bytes);
    frames.push({
      path,
      bytes: bytes.length,
      mimeType: "image/jpeg",
      ts: event.ts,
      name,
    });
  }
  return frames;
}

export function findLatestTracePath(directory) {
  if (!directory || !existsSync(directory)) return null;
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const path = join(directory, name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        // Ignore files that disappear between readdir and stat.
      }
      return { path, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0]?.path || null;
}

export function findRecentTracePaths(directory, count = 2) {
  if (!directory || !existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const path = join(directory, name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        // Ignore files that disappear between readdir and stat.
      }
      return { path, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, count)
    .map((entry) => entry.path);
}

export function traceProfile(events = []) {
  const countMap = (getKey, getValue = () => 1) => {
    const map = new Map();
    for (const event of events) {
      const key = getKey(event) || "(none)";
      map.set(key, (map.get(key) || 0) + getValue(event));
    }
    return map;
  };
  const names = countMap((event) => event.name);
  const categories = countMap((event) => String(event.cat || "").split(",")[0]);
  const phases = countMap((event) => event.ph);
  const threads = countMap((event) => `${event.pid}:${event.tid}`);
  const durationsByName = countMap((event) => event.name, (event) => Number(event.dur || 0) / 1000);
  return { names, categories, phases, threads, durationsByName };
}

export function diffMap(before = new Map(), after = new Map(), limit = 25) {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].map((key) => ({
    key,
    before: Math.round(Number(before.get(key) || 0) * 100) / 100,
    after: Math.round(Number(after.get(key) || 0) * 100) / 100,
    delta: Math.round((Number(after.get(key) || 0) - Number(before.get(key) || 0)) * 100) / 100,
  }))
    .filter((row) => row.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, limit);
}

export function compareTraceEvents(beforeEvents = [], afterEvents = [], params = {}) {
  const limit = Math.max(1, Math.min(typeof params.limit === "number" ? params.limit : 25, 500));
  const before = traceProfile(beforeEvents);
  const after = traceProfile(afterEvents);
  const beforeSummary = summarizeTraceEvents(beforeEvents, limit);
  const afterSummary = summarizeTraceEvents(afterEvents, limit);
  return {
    before: {
      eventCount: beforeEvents.length,
      timeRangeMs: beforeSummary.timeRangeMs,
    },
    after: {
      eventCount: afterEvents.length,
      timeRangeMs: afterSummary.timeRangeMs,
    },
    deltas: {
      eventCount: afterEvents.length - beforeEvents.length,
      timeRangeMs: afterSummary.timeRangeMs != null && beforeSummary.timeRangeMs != null
        ? Math.round((afterSummary.timeRangeMs - beforeSummary.timeRangeMs) * 100) / 100
        : null,
      names: diffMap(before.names, after.names, limit),
      categories: diffMap(before.categories, after.categories, limit),
      phases: diffMap(before.phases, after.phases, limit),
      threads: diffMap(before.threads, after.threads, limit),
      durationByNameMs: diffMap(before.durationsByName, after.durationsByName, limit),
    },
    captureBoundaries: [
      "Trace comparison is only meaningful when both traces captured comparable actions and durations.",
      "This compares observed trace event counts and durations; it does not decide root cause.",
      "Use browser_trace_query on specific changed event names for drill-down.",
    ],
    nextTools: ["browser_trace_query", "browser_chrome_trace", "browser_cpu_profile"],
  };
}

export function summarizeTraceQuery(events = [], params = {}) {
  const query = String(params.query || "").trim().toLowerCase();
  const nameFilter = String(params.name || "").trim().toLowerCase();
  const categoryFilter = String(params.category || "").trim().toLowerCase();
  const phaseFilter = String(params.phase || "").trim();
  const minDurationUs = typeof params.minDurationMs === "number" ? params.minDurationMs * 1000 : null;
  const maxDurationUs = typeof params.maxDurationMs === "number" ? params.maxDurationMs * 1000 : null;
  const limit = Math.max(1, Math.min(typeof params.limit === "number" ? params.limit : 50, 1000));
  const sortBy = String(params.sortBy || "duration");
  const minTs = Math.min(...events.map((event) => Number(event.ts)).filter(Number.isFinite));
  const startUs = typeof params.startTimeMs === "number" && Number.isFinite(minTs) ? minTs + params.startTimeMs * 1000 : null;
  const endUs = typeof params.endTimeMs === "number" && Number.isFinite(minTs) ? minTs + params.endTimeMs * 1000 : null;
  const matches = events.filter((event) => {
    const duration = Number(event.dur || 0);
    const ts = Number(event.ts);
    if (nameFilter && !String(event.name || "").toLowerCase().includes(nameFilter)) return false;
    if (categoryFilter && !String(event.cat || "").toLowerCase().includes(categoryFilter)) return false;
    if (phaseFilter && String(event.ph || "") !== phaseFilter) return false;
    if (typeof params.processId === "number" && Number(event.pid) !== Number(params.processId)) return false;
    if (typeof params.threadId === "number" && Number(event.tid) !== Number(params.threadId)) return false;
    if (minDurationUs !== null && duration < minDurationUs) return false;
    if (maxDurationUs !== null && duration > maxDurationUs) return false;
    if (startUs !== null && ts < startUs) return false;
    if (endUs !== null && ts > endUs) return false;
    if (query && !JSON.stringify(event).toLowerCase().includes(query)) return false;
    return true;
  });
  const sorted = [...matches].sort((a, b) => {
    if (sortBy === "timestamp") return Number(a.ts || 0) - Number(b.ts || 0);
    if (sortBy === "name") return String(a.name || "").localeCompare(String(b.name || ""));
    return Number(b.dur || 0) - Number(a.dur || 0);
  });
  const countMap = (items, getKey) => {
    const map = new Map();
    for (const item of items) {
      const key = getKey(item) || "(none)";
      map.set(key, (map.get(key) || 0) + 1);
    }
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([key, count]) => ({ key, count }));
  };
  const traceRow = (event) => ({
    name: event.name || "",
    category: event.cat || "",
    phase: event.ph || "",
    processId: event.pid,
    threadId: event.tid,
    timestampUs: event.ts,
    relativeStartMs: Number.isFinite(minTs) && Number.isFinite(Number(event.ts)) ? Math.round(((Number(event.ts) - minTs) / 1000) * 100) / 100 : null,
    durationMs: Math.round((Number(event.dur || 0) / 1000) * 100) / 100,
    args: event.args || {},
  });
  const returnedEvents = sorted.slice(0, limit).map(traceRow);
  const contextEventCount = Math.max(0, Math.min(typeof params.contextEvents === "number" ? params.contextEvents : 2, 10));
  const contextWindowCount = Math.max(0, Math.min(typeof params.contextWindows === "number" ? params.contextWindows : 3, 10));
  const chronological = [...events].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
  const threadKey = (event) => `${event.pid ?? "?"}:${event.tid ?? "?"}`;
  const sameThreadWindow = (target) => {
    const targetTs = Number(target.ts);
    const threadEvents = chronological.filter((event) => threadKey(event) === threadKey(target));
    const index = threadEvents.findIndex((event) => event === target || (event.ts === target.ts && event.name === target.name && event.dur === target.dur));
    const safeIndex = index < 0 ? 0 : index;
    const start = Math.max(0, safeIndex - contextEventCount);
    const end = Math.min(threadEvents.length, safeIndex + contextEventCount + 1);
    return {
      target: traceRow(target),
      thread: threadKey(target),
      sameThreadEventCount: threadEvents.length,
      before: threadEvents.slice(start, safeIndex).map(traceRow),
      after: threadEvents.slice(safeIndex + 1, end).map(traceRow),
      windowStartRelativeMs: Number.isFinite(minTs) && Number.isFinite(targetTs) ? Math.round(((threadEvents[start]?.ts - minTs) / 1000) * 100) / 100 : null,
      windowEndRelativeMs: Number.isFinite(minTs) && Number.isFinite(targetTs) ? Math.round(((threadEvents[end - 1]?.ts - minTs) / 1000) * 100) / 100 : null,
    };
  };
  const contextWindows = contextEventCount > 0
    ? sorted.slice(0, contextWindowCount).map(sameThreadWindow)
    : [];
  const timestamps = events.map((event) => Number(event.ts)).filter(Number.isFinite);
  const maxTs = Math.max(...timestamps);
  const tracePath = params.tracePath || "<trace-path>";
  const firstReturned = returnedEvents[0] || null;
  const recommendedDrilldowns = [];
  if (firstReturned) {
    recommendedDrilldowns.push({
      label: "Query same trace thread",
      tool: "browser_trace_query",
      input: {
        tracePath,
        processId: firstReturned.processId,
        threadId: firstReturned.threadId,
        sortBy: "timestamp",
        limit,
        contextEvents: contextEventCount,
      },
      why: "Stay on the same process/thread as the selected event and inspect neighboring trace events chronologically.",
    });
    recommendedDrilldowns.push({
      label: "Query same trace event name",
      tool: "browser_trace_query",
      input: { tracePath, name: firstReturned.name, limit },
      why: "Find other occurrences of the same Chrome trace event name in this capture.",
    });
    if (typeof firstReturned.relativeStartMs === "number") {
      recommendedDrilldowns.push({
        label: "Query narrow time window around event",
        tool: "browser_trace_query",
        input: {
          tracePath,
          startTimeMs: Math.max(0, firstReturned.relativeStartMs - 25),
          endTimeMs: firstReturned.relativeStartMs + Math.max(25, firstReturned.durationMs || 0) + 25,
          sortBy: "timestamp",
          limit,
        },
        why: "Inspect all trace events near the selected event's timestamp without implying causality.",
      });
    }
  }
  recommendedDrilldowns.push({
    label: "Capture fresh trace around smallest reproduction",
    tool: "browser_chrome_trace",
    input: { durationMs: 1000, maxEvents: limit },
    why: "If the saved trace window is incomplete, capture a new bounded trace around a smaller browser action.",
  });
  return {
    totalEvents: events.length,
    matchedCount: matches.length,
    returnedCount: returnedEvents.length,
    truncated: matches.length > returnedEvents.length,
    timeRangeMs: Number.isFinite(minTs) && Number.isFinite(maxTs) ? Math.round(((maxTs - minTs) / 1000) * 100) / 100 : null,
    filters: {
      query: query || null,
      name: nameFilter || null,
      category: categoryFilter || null,
      phase: phaseFilter || null,
      processId: params.processId ?? null,
      threadId: params.threadId ?? null,
      minDurationMs: params.minDurationMs ?? null,
      maxDurationMs: params.maxDurationMs ?? null,
      startTimeMs: params.startTimeMs ?? null,
      endTimeMs: params.endTimeMs ?? null,
      sortBy,
    },
    categoryCounts: countMap(matches, (event) => String(event.cat || "").split(",")[0]),
    phaseCounts: countMap(matches, (event) => event.ph),
    topNames: countMap(matches, (event) => event.name),
    threads: countMap(matches, (event) => `${event.pid}:${event.tid}`),
    events: returnedEvents,
    contextWindows,
    recommendedDrilldowns,
    drilldown: {
      contextEventsPerSide: contextEventCount,
      contextWindowCount: contextWindows.length,
      contextWindowBasis: "same-thread chronological trace events around the first returned matches",
      nextQueries: [
        "Narrow by threadId/processId from a context window.",
        "Use minDurationMs to focus on long events.",
        "Use name/category filters from topNames/categoryCounts for a smaller window.",
      ],
    },
    captureBoundaries: [
      "This reads a saved Chrome trace JSON file; it cannot recover trace events that were not captured.",
      "Durations are reported from Chrome trace event dur fields when present.",
      "Context windows are same-thread neighboring events, not causal proof.",
      "Use browser_chrome_trace around the smallest reproducible action before querying.",
    ],
  };
}

export function summarizeCpuProfile(profile = {}, limit = 20) {
  const nodes = Array.isArray(profile.nodes) ? profile.nodes : [];
  const samples = Array.isArray(profile.samples) ? profile.samples : [];
  const timeDeltas = Array.isArray(profile.timeDeltas) ? profile.timeDeltas : [];
  const hitsByNodeId = new Map();
  for (const sample of samples) {
    hitsByNodeId.set(sample, (hitsByNodeId.get(sample) || 0) + 1);
  }
  const topNodes = nodes
    .map((node) => {
      const frame = node.callFrame || {};
      const sampleHits = hitsByNodeId.get(node.id) || 0;
      return {
        nodeId: node.id,
        functionName: frame.functionName || "(anonymous)",
        url: frame.url || "",
        lineNumber: frame.lineNumber,
        columnNumber: frame.columnNumber,
        hitCount: Number(node.hitCount || 0),
        sampleHits,
        childCount: Array.isArray(node.children) ? node.children.length : 0,
        positionTickCount: Array.isArray(node.positionTicks) ? node.positionTicks.reduce((sum, tick) => sum + Number(tick.ticks || 0), 0) : 0,
      };
    })
    .filter((node) => node.hitCount || node.sampleHits || node.positionTickCount)
    .sort((a, b) => (b.sampleHits + b.hitCount + b.positionTickCount) - (a.sampleHits + a.hitCount + a.positionTickCount))
    .slice(0, limit);
  const totalTimeDeltaUs = timeDeltas.reduce((sum, value) => sum + Number(value || 0), 0);
  return {
    nodeCount: nodes.length,
    sampleCount: samples.length,
    timeDeltaCount: timeDeltas.length,
    totalTimeDeltaUs,
    totalTimeDeltaMs: totalTimeDeltaUs / 1000,
    startTime: profile.startTime,
    endTime: profile.endTime,
    topNodes,
  };
}
