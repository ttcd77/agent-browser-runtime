// register-evidence-capture.mjs — Feedback + capture-control + traffic/timeline evidence tool family.
// Extracted verbatim from agent-cdp-server.mjs registerStandaloneBrowserTools (behavior-preserving).
// Dependencies are injected via deps; pure/lib helpers are imported directly.
// The browserFeedbackTool const (consumed only inside this family) moves in with it.
import { toolResult } from "./result-format.mjs";
import { normalizeProfileName } from "./result-format.mjs";
import { createFeedbackNote } from "./feedback-notes.mjs";
import { buildNetworkF12Columns, buildNetworkTimeline } from "./f12-view.mjs";
import { summarizeNetworkRecords, buildCaptureBisect } from "./network-summary.mjs";

export function registerEvidenceCaptureTools(deps) {
  const {
    tools,
    profileRegistry,
    sleep,
    resolveProfile,
    withManagedPageClient,
    startManagedCaptureSession,
    stopManagedCaptureSession,
    clearManagedCaptureSessionBuffer,
    managedCaptureSessions,
    maybeRoutePersonal,
  } = deps;

  const browserFeedbackTool = {
    name: "browser_feedback",
    description:
      "Agent feedback entrypoint: record a local bug, capability gap, docs issue, product friction, or idea about Agent Browser Runtime. This writes a local feedback/*.md note and does not judge vulnerabilities.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["bug", "gap", "docs", "product", "idea"], description: "Feedback category." },
        title: { type: "string", description: "Required. Short one-line title for the feedback note." },
        summary: { type: "string", description: "Detailed description of the issue or idea." },
        repro: { type: "string", description: "Reproduction steps for bugs." },
        expected: { type: "string", description: "What the agent expected to happen." },
        actual: { type: "string", description: "What actually happened." },
        evidence: { type: "string", description: "Relevant evidence (tool output, error message, file path)." },
        next: { type: "string", description: "Suggested next action or fix direction." },
        tool: { type: "string", description: "The tool name this feedback is about (e.g. browser_click)." },
        profile: { type: "string", description: "Profile name associated with the feedback, if applicable." },
        reporter: { type: "string", description: "Agent or system that generated the feedback. Defaults to browser-worker-tool." },
      },
      required: ["title"],
    },
    async execute(_id, params = {}) {
      const note = createFeedbackNote({
        ...params,
        reporter: params.reporter || "browser-worker-tool",
      });
      return toolResult({
        ...note,
        feedbackUrl: "http://127.0.0.1:17335/feedback",
        docs: "docs/feedback-and-gaps.md",
        publicIssueRule: "Review and redact before publishing. Do not include cookies, tokens, private screenshots, real HARs, or account state.",
      });
    },
  };
  tools.set("browser_feedback", browserFeedbackTool);

  tools.set("browser_capture_start", {
    name: "browser_capture_start",
    description: "Start explicit F12 capture for a managed browser profile. Appends to the existing traffic log by default — does NOT destroy prior evidence. Pass clear=true only when you explicitly want a fresh segment and accept losing every previously captured request.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted. Profile must exist (create with profile_create or browser_open)." },
        clear: { type: "boolean", description: "Physically delete traffic.jsonl + websockets.jsonl + eventsource.jsonl + in-memory buffer before starting. NOT recoverable. Default false (append mode). Pass true only when starting a clean segment is more valuable than every byte of prior evidence." },
        label: { type: "string", description: "Optional label to tag this capture session (e.g. \"login-flow\", \"checkout\")." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_capture_start", params);
      if (routed) return toolResult(routed);
      // H-04: profile must already exist — do not silently create an empty dir.
      if (params?.profile) {
        const requestedName = normalizeProfileName(params.profile);
        const existing = profileRegistry.listProfiles().find((p) => p.name === requestedName);
        if (!existing) {
          return toolResult({ ok: false, error: "profile_not_found", profile: requestedName, hint: "Create the profile first with profile_create or browser_open." });
        }
      }
      const profile = await resolveProfile(params?.profile);
      const previousSession = await stopManagedCaptureSession(profile.name, "restart");
      // Default flipped from opt-out to opt-in. The old default (clear=true)
      // silently destroyed agents' own evidence whenever they re-armed capture
      // — in a live production capture run this cost the user the payment-API
      // traffic at the exact moment it was needed. Docs alone cannot save a
      // tool whose default is destructive: someone will always omit the flag.
      // Now: pass clear=true explicitly when you really want a wipe; otherwise
      // this just appends to the existing jsonl.
      let clearedEvidence = null;
      if (params?.clear === true) {
        clearedEvidence = profileRegistry.clearCapturedEvidence(profile.name);
        clearManagedCaptureSessionBuffer(profile.name);
      }
      const capture = profileRegistry.setCapture(profile.name, {
        enabled: true,
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        label: params?.label || null,
      });
      const persistentSession = await startManagedCaptureSession(profile);
      return toolResult({
        ok: true,
        backend: "managed-cdp",
        profile: profile.name,
        capture,
        cleared: params?.clear === true,
        clearedEvidence,
        previousSession,
        persistentSession,
      });
    },
  });

  tools.set("browser_capture_stop", {
    name: "browser_capture_stop",
    description: "Stop explicit F12 capture for a managed browser profile.",
    parameters: { type: "object", properties: { profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." } } },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_capture_stop", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const persistentSession = await stopManagedCaptureSession(profile.name, "stop");
      const capture = profileRegistry.setCapture(profile.name, {
        enabled: false,
        stoppedAt: new Date().toISOString(),
      });
      return toolResult({ ok: true, backend: "managed-cdp", profile: profile.name, capture, persistentSession });
    },
  });

  tools.set("browser_capture_clear", {
    name: "browser_capture_clear",
    description: "Clear captured F12 events for a managed browser profile.",
    parameters: { type: "object", properties: { profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." } } },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_capture_clear", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const clearedEvidence = profileRegistry.clearCapturedEvidence(profile.name);
      const clearedActiveBuffer = clearManagedCaptureSessionBuffer(profile.name);
      return toolResult({ ok: true, backend: "managed-cdp", profile: profile.name, ...clearedEvidence, clearedEvidence, clearedActiveBuffer, capture: profileRegistry.getCapture(profile.name) });
    },
  });

  tools.set("browser_capture_status", {
    name: "browser_capture_status",
    description: "Inspect explicit F12 capture status for a managed browser profile.",
    parameters: { type: "object", properties: { profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." } } },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_capture_status", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      return toolResult({
        ok: true,
        backend: "managed-cdp",
        profile: profile.name,
        capture: profileRegistry.getCapture(profile.name),
        persistentCaptureActive: managedCaptureSessions.has(profile.name),
        trafficCount: profileRegistry.queryTraffic(profile.name, { limit: 50_000 }).length,
      });
    },
  });

  tools.set("profile_traffic_query", {
    name: "profile_traffic_query",
    description: "Query captured network traffic for a managed profile. If profile is omitted, uses the server default profile.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the server default profile if omitted." },
        url_contains: { type: "string", description: "Filter: return only requests whose URL contains this substring." },
        hostname: { type: "string", description: "Filter: return only requests to this hostname." },
        method: { type: "string", description: "Filter: return only requests with this HTTP method (e.g. \"GET\", \"POST\")." },
        status: { type: "number", description: "Filter: return only requests with this exact HTTP status code." },
        status_min: { type: "number", description: "Filter: return only requests with status >= this value." },
        status_max: { type: "number", description: "Filter: return only requests with status <= this value." },
        resource_type: { type: "string", description: "Filter: return only requests of this resource type (e.g. \"XHR\", \"Fetch\", \"Document\")." },
        mime_contains: { type: "string", description: "Filter: return only responses whose MIME type contains this substring." },
        failed: { type: "boolean", description: "Filter: if true, return only failed requests." },
        redirected: { type: "boolean", description: "Filter: if true, return only redirected requests." },
        from_cache: { type: "boolean", description: "Filter: if true, return only cache-served responses." },
        from_service_worker: { type: "boolean", description: "Filter: if true, return only service-worker-handled responses." },
        has_request_body: { type: "boolean", description: "Filter: if true, return only requests that have a captured request body." },
        has_response_body: { type: "boolean", description: "Filter: if true, return only requests that have a captured response body." },
        request_header: { type: "object", description: "Filter: return only requests containing this header (key-value object, e.g. {\"Authorization\": \"Bearer\"})." },
        response_header: { type: "object", description: "Filter: return only responses containing this header." },
        sort_by: { type: "string", description: "Field to sort results by (e.g. \"timestamp\", \"status\", \"url\"). Default: timestamp." },
        sort_dir: { type: "string", enum: ["asc", "desc"], description: "Sort direction. Default \"asc\"." },
        limit: { type: "number", description: "Maximum results to return. Default 50." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("profile_traffic_query", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const rows = profileRegistry.queryTraffic(profile.name, params);
      return toolResult({
        profile: profile.name,
        evidenceDir: profile.evidenceDir,
        filtersApplied: params || {},
        requests: rows.map((row) => ({ ...row, f12Columns: buildNetworkF12Columns(row) })),
        websockets: profileRegistry.readWebSockets(profile.name).slice(-(typeof params?.limit === "number" ? Math.min(Math.max(1, params.limit), 10_000) : 50)),
        count: rows.length,
        f12TableColumns: ["name", "status", "type", "initiator", "size", "time", "domain", "method", "scheme", "protocol"],
      });
    },
  });

  tools.set("profile_traffic_summary", {
    name: "profile_traffic_summary",
    description: "Summarize profile-local managed browser Network events for agent dashboards and triage.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the server default profile if omitted." },
        limit: { type: "number", description: "Maximum entries to include in the summary sample. Default 10." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("profile_traffic_summary", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const rows = profileRegistry.queryTraffic(profile.name, { limit: 1000000 });
      const websockets = profileRegistry.readWebSockets(profile.name);
      return toolResult({
        profile: profile.name,
        evidenceDir: profile.evidenceDir,
        capture: profileRegistry.getCapture(profile.name),
        ...summarizeNetworkRecords(rows, websockets, typeof params?.limit === "number" ? Math.min(Math.max(1, params.limit), 10_000) : 10),
      });
    },
  });

  tools.set("profile_network_timeline", {
    name: "profile_network_timeline",
    description: "Return F12 Network Timing/Initiator-style rows for captured managed browser requests.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the server default profile if omitted." },
        limit: { type: "number", description: "Maximum timeline rows to return. Default 100." },
        url_contains: { type: "string", description: "Filter: return only requests whose URL contains this substring." },
        hostname: { type: "string", description: "Filter: return only requests to this hostname." },
        method: { type: "string", description: "Filter: return only requests with this HTTP method." },
        status: { type: "number", description: "Filter: return only requests with this exact HTTP status code." },
        status_min: { type: "number", description: "Filter: return only requests with status >= this value." },
        status_max: { type: "number", description: "Filter: return only requests with status <= this value." },
        resource_type: { type: "string", description: "Filter: return only requests of this resource type." },
        mime_contains: { type: "string", description: "Filter: return only responses whose MIME type contains this substring." },
        failed: { type: "boolean", description: "Filter: if true, return only failed requests." },
        redirected: { type: "boolean", description: "Filter: if true, return only redirected requests." },
        from_cache: { type: "boolean", description: "Filter: if true, return only cache-served responses." },
        from_service_worker: { type: "boolean", description: "Filter: if true, return only service-worker-handled responses." },
        has_request_body: { type: "boolean", description: "Filter: if true, return only requests with a captured request body." },
        has_response_body: { type: "boolean", description: "Filter: if true, return only requests with a captured response body." },
        request_header: { type: "object", description: "Filter: return only requests containing this header." },
        response_header: { type: "object", description: "Filter: return only responses containing this header." },
        sort_by: { type: "string", description: "Field to sort by. Default: timestamp." },
        sort_dir: { type: "string", enum: ["asc", "desc"], description: "Sort direction. Default \"asc\"." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("profile_network_timeline", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const limit = typeof params?.limit === "number" ? Math.min(Math.max(1, params.limit), 10_000) : 100;
      const rows = profileRegistry.queryTraffic(profile.name, { ...params, limit });
      return toolResult({
        profile: profile.name,
        evidenceDir: profile.evidenceDir,
        capture: profileRegistry.getCapture(profile.name),
        filtersApplied: params || {},
        count: rows.length,
        timeline: buildNetworkTimeline(rows, limit),
      });
    },
  });

  tools.set("browser_capture_bisect", {
    name: "browser_capture_bisect",
    description: "Bisect captured managed-browser F12 evidence into Network, page/frame, realtime, and summary buckets.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the server default profile if omitted." },
        limit: { type: "number", description: "Maximum network requests to include in the bisect output. Default 200." },
        save: { type: "boolean", description: "If true (default), saves the bisect output to a file in the evidence directory." },
        path: { type: "string", description: "Optional. Absolute path to write the bisect output JSON. Defaults to a timestamped file in the profile evidence directory." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_capture_bisect", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const limit = typeof params?.limit === "number" ? Math.min(Math.max(1, params.limit), 10_000) : 200;
      return toolResult(buildCaptureBisect({
        profile: profile.name,
        evidenceDir: profile.evidenceDir,
        capture: profileRegistry.getCapture(profile.name),
        requests: profileRegistry.queryTraffic(profile.name, { limit: 1000000 }),
        websockets: profileRegistry.readWebSockets(profile.name),
        eventSources: profileRegistry.readEventSources(profile.name),
        limit,
        save: params?.save !== false,
        path: params?.path || null,
      }));
    },
  });

  tools.set("browser_issues_log", {
    name: "browser_issues_log",
    description: "Return Chrome DevTools Issues-panel events reported by the browser for the current page.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        tabId: { type: "string", description: "Optional. Tab id override." },
        reload: { type: "boolean", description: "If true (default), reload the page to trigger fresh issue events before collecting." },
        ignoreCache: { type: "boolean", description: "If true, reload with cache bypassed. Default false." },
        waitMs: { type: "number", description: "Milliseconds to wait after reload for issues to be emitted. Default 1200, clamped to 30000." },
        limit: { type: "number", description: "Maximum issue events to return. Default 100." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_issues_log", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const waitMs = typeof params?.waitMs === "number" ? Math.min(Math.max(100, params.waitMs), 30_000) : 1200;
      const limit = typeof params?.limit === "number" ? Math.min(Math.max(1, params.limit), 10_000) : 100;
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        const issues = [];
        let auditsAvailable = true;
        try {
          await client.Audits.enable();
          client.Audits.issueAdded((event) => {
            issues.push({ timestamp: new Date().toISOString(), ...event });
          });
        } catch (err) {
          auditsAvailable = false;
          issues.push({ error: String(err?.message || err) });
        }
        if (params?.reload !== false) {
          await client.Page.enable();
          await client.Page.reload({ ignoreCache: Boolean(params?.ignoreCache) });
          await sleep(waitMs);
        } else {
          await sleep(waitMs);
        }
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          auditsAvailable,
          issueCount: issues.filter((entry) => !entry.error).length,
          issues: issues.slice(-limit),
        };
      }));
    },
  });
}
