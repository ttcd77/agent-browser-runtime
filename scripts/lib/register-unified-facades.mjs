// register-unified-facades.mjs — Unified browser facade family (the agent-facing high-level API).
// Extracted verbatim from agent-cdp-server.mjs registerStandaloneBrowserTools (behavior-preserving),
// except for the H2 fix below. Tools: browser_open, browser_act, browser_inspect, browser_capture,
// browser_security_pack, browser_auth_boundary, browser_diff, browser_replay, browser_text, browser_raw.
// Dependencies are injected via deps; pure/lib helpers are imported directly.
//
// H2: the worker closure owns `let lastBoundBackend`. Two handlers read it bare. The module
// cannot see the closure let, so it receives getLastBoundBackend (an arrow that closes over the
// live closure let at the call site) and the 2 reads use getLastBoundBackend(). The writes stay
// in the injected rememberActiveBackend helper. These 2 reads are the only non-verbatim change.
//
// H4 (updated F4): facades that previously borrowed devtools_* alias .parameters now reference
// the canonical browser_* / profile_* tools directly. All devtools_* aliases were removed in F4.
import { toolResult } from "./result-format.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Never silently truncate text returned to the agent.
// If content exceeds this threshold, write to disk and return a filePath instead.
const TEXT_INLINE_THRESHOLD = 200_000;

// ── attack-harness subprocess proxy (same pattern as register-replay-attack.mjs) ──
const __filename_facade = fileURLToPath(import.meta.url);
const __dirname_facade = join(__filename_facade, "..");
const PYTHON_FACADE = process.env.PYTHON_BIN || "python";
const AH_CWD_FACADE = process.env.ATTACK_HARNESS_CWD
  || join(__dirname_facade, "..", "..", "..", "helloworld", "attack-harness");

function attackHarnessFacade(pyCode, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_FACADE, ["-c", pyCode], {
      cwd: AH_CWD_FACADE,
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

// ───────────────────────────────────────────────────────────────────────────
// TRAP for future readers: the backend strings below mislead.
//
// Several facade payloads carry `backend: "managed-cdp"` for backward
// compatibility with old agents and skills that string-match on it. The actual
// runtime backend is Playwright-driven Chrome (the ManagedPlaywrightDriver),
// and traffic is recorded via newCDPSession from the SAME Playwright page,
// not from a separate CDP client on port 9222. The 9222-attaching mechanism
// in plugins/cdp-traffic-capture is mostly retired (see that file's header).
//
// What this means in practice:
//   * Reading "managed-cdp" in a tool response does NOT mean traffic came
//     from a different browser than the one Playwright opened. It's the same
//     browser, same tab.
//   * Do not chase a "two Chrome processes" theory if traffic looks missing.
//     The real culprits are almost always (a) capture.enabled flag was off
//     (browser_open now auto-flips it; see browser_open execute), or (b) the
//     profile's session hasn't been opened yet.
//   * Renaming this field to "managed" or "managed-playwright" is left as a
//     future cleanup — too many external callers may grep for "managed-cdp".
// ───────────────────────────────────────────────────────────────────────────

export function registerUnifiedFacades(deps) {
  const {
    tools,
    defaultProfileName,
    profileRegistry,
    managedPlaywrightDriver,
    resolveProfile,
    withManagedPageClient,
    maybeRoutePersonal,
    withBackendParameters,
    rememberActiveBackend,
    profileTargetStatus: _profileTargetStatus,
    runManagedPlaywrightAction,
    getLastBoundBackend,
  } = deps;

  tools.set("browser_open", {
    name: "browser_open",
    description: "Facade: open a URL in a managed or personal browser profile, register the profile record, and return page diagnostics. Prefer this over browser_navigate for all ordinary agent work — it handles profile lifecycle (create/resume), records sticky backend (pass --backend once; all subsequent calls on this profile follow automatically without re-specifying backend), and returns diagnostics + capturedTraffic. Omitting url when the profile has no live page returns error browser_open_requires_url_or_live_profile. First-time use: pass backend=managed (default, Playwright-driven Chrome isolation) or backend=personal (user's real Chrome via extension bridge, for anti-bot bypass only).",
    parameters: withBackendParameters({
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        url: { type: "string", description: "URL to open. Required for a new profile with no live page." },
        waitMs: { type: "number", description: "Wait time in ms after navigation. Default: 8000." },
      },
    }),
    async execute(id, params) {
      // browser_open records an explicit backend as this profile's sticky backend.
      // (maybeRoutePersonal below also records it, so every dual-backend tool binds
      // the same way; this call is kept so the activeBackend diagnostic is set first.)
      rememberActiveBackend(params);
      const routed = await maybeRoutePersonal("browser_open", params);
      if (routed) return toolResult(routed);
      const profileName = params?.profile || defaultProfileName;
      const requestedUrl = params?.url ? String(params.url) : "";
      if (requestedUrl && !/^https?:\/\//i.test(requestedUrl) && !/^data:/i.test(requestedUrl) && !/^file:/i.test(requestedUrl)) {
        return toolResult({
          ok: false,
          facade: "browser_open",
          profile: profileName,
          error: "browser_open_requires_real_url",
          reason: "browser_open received an invalid or implicit blank URL; refusing to create an about:blank page.",
          rejectedUrl: requestedUrl,
          next: [`agent-browser open <url> --profile ${profileName}`],
        });
      }
      if (!params?.url) {
        const livePlaywrightPages = await managedPlaywrightDriver.listPages();
        const liveProfilePage = livePlaywrightPages.find((page) => page.id === `playwright:${profileName}`);
        if (!liveProfilePage) {
          return toolResult({
            ok: false,
            facade: "browser_open",
            profile: profileName,
            error: "browser_open_requires_url_or_live_profile",
            reason: "Opening a managed Playwright profile with no live page and no URL would create an implicit about:blank page.",
            next: [`agent-browser open <url> --profile ${profileName}`],
          });
        }
      }
      const profileExistedBefore = profileRegistry.listProfiles().some((p) => p.name === profileName);
      const profile = await profileRegistry.ensureProfileRecord(profileName, {
        browserContextId: null,
        browserContextOwned: false,
        isolation: "managed-playwright",
        driver: "playwright",
      });
      const waitMs = typeof params?.waitMs === "number" ? Math.min(Math.max(0, params.waitMs), 60_000) : 800;
      // Auto-enable continuous capture for this profile when it opens. Without
      // this, captureNetworkForProfile records every request but DROPS them
      // unless capture.enabled is true (see agent-cdp-server.mjs:2846), so the
      // user's own activity between browser_open and the first explicit
      // browser_capture_start vanishes. Idempotent: browser_capture_start
      // internally stops any prior session before starting fresh.
      try {
        // clear=false is critical: browser_capture_start defaults to clear=true,
        // which WIPES every previously captured request from the store. If
        // browser_open auto-fired with the default, an agent that calls
        // browser_open twice on the same profile (e.g. switching URLs) would
        // silently destroy the traffic recorded between the two calls — which
        // is exactly the bug an agent hit during a live capture session chasing a payment
        // ValidationError that had already produced its API trace.
        await tools.get("browser_capture_start").execute(id, {
          profile: profile.name,
          label: "browser_open-auto",
          clear: false,
        });
      } catch (err) {
        // Fail-open: a capture-start failure must not block browser_open itself.
        // The error surfaces on the next forensic call when the buffer is empty.
      }
      let capture;
      try {
        capture = await runManagedPlaywrightAction({
          profile,
          eventType: "browser_open",
          waitMs,
          event: { facade: "browser_open", url: params?.url || null },
          action: () => managedPlaywrightDriver.open(profile.name, params || {}),
        });
      } catch (err) {
        // Roll back registry entry if we just created it to avoid ghost profiles.
        if (!profileExistedBefore) {
          profileRegistry.deleteProfile(profile.name).catch(() => {});
        }
        throw err;
      }
      return toolResult({
        backend: "managed-playwright",
        activeBackend: getLastBoundBackend(),
        facade: "browser_open",
        profile: profile.name,
        tabId: capture.result.tabId,
        diagnostics: {
          backend: "managed-playwright",
          driver: "playwright",
          title: capture.result.title,
          url: capture.result.url,
          userDataDir: capture.result.userDataDir,
          launch: capture.result.launch,
        },
        evidenceDir: profile.evidenceDir,
        capturedTraffic: capture.capturedTraffic,
        trafficFile: capture.trafficFile,
        eventFile: capture.eventFile,
        next: ["browser_inspect", "browser_capture", "browser_security_pack"],
      });
    },
  });

  tools.set("browser_act", {
    name: "browser_act",
    description: "Facade: perform a common browser action: click, hover, double_click, drag, type, press, select, wait, scroll, eval, screenshot, or snapshot.",
    parameters: withBackendParameters({
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        action: {
          type: "string",
          enum: ["click", "hover", "double_click", "dblclick", "drag", "type", "press", "select", "wait", "scroll", "eval", "screenshot", "snapshot"],
          description: "Required. Action to perform.",
        },
        selector: { type: "string", description: "CSS selector for click/hover/type/select/drag actions." },
        text: { type: "string", description: "Text to type for the type action." },
        x: { type: "number", description: "X coordinate for drag actions." },
        y: { type: "number", description: "Y coordinate for drag actions." },
        expression: { type: "string", description: "JS expression for the eval action." },
        waitMs: { type: "number", description: "Wait time in ms. Default: 8000." },
        waitMode: { type: "string", description: "Wait mode for the wait action." },
        waitFor: { type: "string", description: "Selector or condition to wait for." },
        observeAfter: { type: "boolean", description: "Capture a network observation window after the action." },
        returnSnapshot: { type: "boolean", description: "Include an accessibility snapshot in the response." },
      },
      required: ["action"],
    }),
    async execute(id, params) {
      const routed = await maybeRoutePersonal("browser_act", params);
      if (routed) return toolResult(routed);
      const action = String(params?.action || "").toLowerCase();
      const profileName = params?.profile || defaultProfileName;
      const actionTools = {
        click: "browser_click",
        hover: "browser_hover",
        double_click: "browser_double_click",
        dblclick: "browser_double_click",
        drag: "browser_drag",
        type: "browser_type",
        press: "browser_press",
        select: "browser_select",
        wait: "browser_wait",
        scroll: "browser_scroll",
        eval: "browser_eval",
        screenshot: "browser_screenshot",
        snapshot: "browser_snapshot",
      };
      const toolName = actionTools[action];
      if (!toolName) throw new Error(`unsupported browser_act action: ${action}`);
      const result = JSON.parse((await tools.get(toolName).execute(id, { ...params, profile: profileName })).content?.[0]?.text || "{}");
      return toolResult({
        backend: "managed-cdp",
        facade: "browser_act",
        action,
        tool: toolName,
        profile: profileName,
        result,
        next: ["browser_inspect", "browser_capture"],
      });
    },
  });

  tools.set("browser_inspect", {
    name: "browser_inspect",
    description: "Facade: inspect the current page through agent_inspect. Modes: overview, network, storage, console, dom, sources, performance, search, evidence, debug.",
    parameters: withBackendParameters({
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        mode: {
          type: "string",
          enum: ["overview", "network", "storage", "console", "dom", "sources", "performance", "search", "evidence", "debug"],
          description: "Inspection mode. Default: overview.",
        },
        query: { type: "string", description: "Search query for search mode." },
        selector: { type: "string", description: "CSS selector for dom mode." },
        requestId: { type: "string", description: "Request ID for network drilldown." },
        limit: { type: "number", description: "Max items to return per category." },
        includeHeavy: { type: "boolean", description: "Include heavy data (full DOM, all scripts). Default: false." },
      },
    }),
    async execute(id, params) {
      const routed = await maybeRoutePersonal("browser_inspect", params);
      if (routed) return toolResult(routed);
      const profileName = params?.profile || defaultProfileName;
      const focus = params?.mode || params?.focus || "overview";
      const result = JSON.parse((await tools.get("agent_inspect").execute(id, { ...params, profile: profileName, focus })).content?.[0]?.text || "{}");
      return toolResult({
        backend: "managed-cdp",
        facade: "browser_inspect",
        profile: profileName,
        mode: focus,
        result,
        next: result.nextTools || ["browser_capture", "browser_security_pack"],
      });
    },
  });

  tools.set("browser_capture", {
    name: "browser_capture",
    description: "Facade: manage F12 recording with start, stop, clear, status, or reload.",
    parameters: withBackendParameters({
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        action: {
          type: "string",
          enum: ["start", "stop", "clear", "status", "reload", "hard_reload"],
          description: "Capture action. Default: status.",
        },
        label: { type: "string", description: "Label for the capture session." },
        clear: { type: "boolean", description: "Clear existing traffic log when starting capture." },
        waitMs: { type: "number", description: "Wait time in ms after reload actions. Default: 8000." },
      },
    }),
    async execute(id, params) {
      const routed = await maybeRoutePersonal("browser_capture", params);
      if (routed) return toolResult(routed);
      const action = String(params?.action || "status").toLowerCase();
      const profileName = params?.profile || defaultProfileName;
      const actionTools = {
        start: "browser_capture_start",
        stop: "browser_capture_stop",
        clear: "browser_capture_clear",
        status: "browser_capture_status",
        reload: "browser_hard_reload",
        hard_reload: "browser_hard_reload",
      };
      const toolName = actionTools[action];
      if (!toolName) {
        return toolResult({
          ok: false,
          facade: "browser_capture",
          error: "unsupported_browser_capture_action",
          receivedAction: action,
          supportedActions: Object.keys(actionTools),
        });
      }
      const result = JSON.parse((await tools.get(toolName).execute(id, { ...params, profile: profileName })).content?.[0]?.text || "{}");
      return toolResult({
        backend: "managed-cdp",
        facade: "browser_capture",
        action,
        tool: toolName,
        profile: profileName,
        result,
        next: ["browser_inspect", "browser_security_pack"],
      });
    },
  });

  tools.set("browser_security_pack", {
    name: "browser_security_pack",
    description: "Facade: composite one-call security research evidence workflow. Runs token_scan + token_flow_trace + sources_search against the profile evidence directory via Python primitives (no CDP/browser needed). For browser-dependent steps (snapshot, capture, storage), use browser_open + browser_act with backend=personal.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the server default profile." },
        query: { type: "string", description: "Optional search query for sources_search." },
        limit: { type: "number", description: "Max items per section. Default 25." },
      },
    },
    async execute(id, params) {
      const profile = await resolveProfile(params?.profile || defaultProfileName);
      const safe = (v) => v != null ? JSON.stringify(v) : "None";
      const results = { facade: "browser_security_pack", profile: profile.name };
      try {
        // token_scan
        const tokenScanPy = `
from attack_harness.diff import token_scan
import json
r = token_scan(traffic_dir=${safe(profile.evidenceDir)})
print(json.dumps(r, ensure_ascii=False))
`;
        results.token_scan = await attackHarnessFacade(tokenScanPy, 60000);
      } catch (e) { results.token_scan = { ok: false, error: String(e.message) }; }
      try {
        // token_flow_trace
        const rows = profileRegistry.queryTraffic(profile.name, { limit: 500 });
        const tracePy = `
from attack_harness.diff import token_flow_trace
import json
r = token_flow_trace(captured_requests=${safe(rows)})
print(json.dumps(r, ensure_ascii=False))
`;
        results.token_flow_trace = await attackHarnessFacade(tracePy, 15000);
      } catch (e) { results.token_flow_trace = { ok: false, error: String(e.message) }; }
      if (params?.query) {
        try {
          const searchPy = `
from attack_harness.diff import sources_search
import json
r = sources_search(sources_dir=${safe(profile.evidenceDir)}, query=${safe(params.query)})
print(json.dumps(r, ensure_ascii=False))
`;
          results.sources_search = await attackHarnessFacade(searchPy, 15000);
        } catch (e) { results.sources_search = { ok: false, error: String(e.message) }; }
      }
      results.ok = true;
      results.note = "browser_security_pack V3: runs Python primitives only (no CDP). For browser-dependent steps, use browser_open + browser_act with backend=personal.";
      return toolResult(results);
    },
  });

  tools.set("browser_auth_boundary", {
    name: "browser_auth_boundary",
    description: "Facade: collect objective authentication-boundary evidence: cookies, auth headers, tokens, storage, and credentialed requests.",
    parameters: withBackendParameters(tools.get("browser_auth_boundary_report").parameters),
    async execute(id, params) {
      const routed = await maybeRoutePersonal("browser_auth_boundary", params);
      if (routed) return toolResult(routed);
      const result = JSON.parse((await tools.get("browser_auth_boundary_report").execute(id, { ...params, profile: params?.profile || defaultProfileName })).content?.[0]?.text || "{}");
      return toolResult({ facade: "browser_auth_boundary", ...result });
    },
  });

  tools.set("browser_diff", {
    name: "browser_diff",
    description: "Facade: compare before/after evidence artifacts or current captured traffic. Requires beforePath and afterPath (absolute paths to bisect JSON artifacts from browser_capture_bisect).",
    parameters: withBackendParameters({
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        beforePath: { type: "string", description: "Required. Absolute path to the before-state bisect artifact (from browser_capture_bisect with save=true)." },
        afterPath: { type: "string", description: "Required. Absolute path to the after-state bisect artifact (from browser_capture_bisect with save=true)." },
      },
      required: ["beforePath", "afterPath"],
    }),
    async execute(id, params) {
      const routed = await maybeRoutePersonal("browser_diff", params);
      if (routed) return toolResult(routed);
      // H-06: fast-fail if required path params are missing — prevents undefined crash in underlying tool.
      if (!params?.beforePath || typeof params.beforePath !== "string") {
        return toolResult({ ok: false, error: "beforePath is required", hint: "Run browser_capture_bisect with save=true to get a bisect artifact path, then pass it as beforePath." });
      }
      if (!params?.afterPath || typeof params.afterPath !== "string") {
        return toolResult({ ok: false, error: "afterPath is required", hint: "Run browser_capture_bisect with save=true after the action, pass it as afterPath." });
      }
      const result = JSON.parse((await tools.get("browser_capture_diff").execute(id, { ...params, profile: params?.profile || defaultProfileName })).content?.[0]?.text || "{}");
      return toolResult({ facade: "browser_diff", ...result });
    },
  });

  tools.set("browser_replay", {
    name: "browser_replay",
    description: "Facade: replay one captured request or run batch variants and compare responses.",
    parameters: withBackendParameters({
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        requestId: { type: "string", description: "Required. Request ID from profile_traffic_query to replay." },
        variants: { type: "array", items: { type: "object" }, description: "Variant override objects for batch replay. If provided uses profile_request_replay_batch." },
      },
      required: ["requestId"],
    }),
    async execute(id, params) {
      // Skip personal routing — this is a pure replay tool, no browser needed.
      // Delegates to profile_request_replay which proxies to attack-harness raw_http.
      const profileName = params?.profile || defaultProfileName;
      const toolName = Array.isArray(params?.variants) && params.variants.length ? "profile_request_replay_batch" : "profile_request_replay";
      try {
        const result = JSON.parse((await tools.get(toolName).execute(id, { ...params, profile: profileName })).content?.[0]?.text || "{}");
        return toolResult({ facade: "browser_replay", tool: toolName, profile: profileName, result });
      } catch (e) {
        return toolResult({ ok: false, facade: "browser_replay", error: String(e.message) });
      }
    },
  });

  tools.set("browser_text", {
    name: "browser_text",
    description: "Facade: extract readable text content from the current page in one call. Returns plain text, page URL, title, and character count. Use instead of browser_eval + document.body.innerText for common text extraction. When the page text exceeds 200 000 characters the full content is saved to disk and the response includes filePath + originalLength — use the Read tool on filePath to get the complete text.",
    parameters: withBackendParameters({
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
      },
    }),
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_text", params);
      if (routed) return toolResult(routed);
      const profileName = params?.profile || defaultProfileName;
      const profile = await resolveProfile(profileName);
      return toolResult(await withManagedPageClient(profile, profile.tabId, async (client, target) => {
        const extractionScript = `
          (function() {
            var main = document.querySelector('article') || document.querySelector('[role="main"]') || document.querySelector('main');
            var source = main || document.body;
            if (!source) return '';
            return source.innerText || '';
          })()
        `;
        const [textResult, urlResult, titleResult] = await Promise.all([
          client.Runtime.evaluate({ expression: extractionScript, returnByValue: true }),
          client.Runtime.evaluate({ expression: 'document.location.href', returnByValue: true }),
          client.Runtime.evaluate({ expression: 'document.title', returnByValue: true }),
        ]);
        const fullText = String(textResult.result?.value || '');
        const url = String(urlResult.result?.value || '');
        const title = String(titleResult.result?.value || '');

        if (fullText.length <= TEXT_INLINE_THRESHOLD) {
          return {
            backend: "managed-cdp",
            facade: "browser_text",
            profile: profileName,
            tabId: target.id,
            url,
            title,
            text: fullText,
            charCount: fullText.length,
            next: ["browser_inspect", "browser_capture"],
          };
        }

        // Content exceeds inline threshold — write to disk, return path.
        const textDir = join(profile.evidenceDir, "text-dumps");
        mkdirSync(textDir, { recursive: true });
        const filePath = join(textDir, `browser_text-${Date.now()}.txt`);
        writeFileSync(filePath, fullText, "utf8");
        const previewText = fullText.slice(0, 2000);
        return {
          backend: "managed-cdp",
          facade: "browser_text",
          profile: profileName,
          tabId: target.id,
          url,
          title,
          text: `${previewText}...[truncated, see filePath]`,
          charCount: previewText.length,
          truncated: true,
          originalLength: fullText.length,
          filePath,
          next: [`browser_artifact_read {"path":"${filePath}"}`, "browser_inspect", "browser_capture"],
        };
      }));
    },
  });

  tools.set("browser_raw", {
    name: "browser_raw",
    description: "Facade: advanced escape hatch. Call one exact devtools_* / browser_* / profile_* tool when the big tools are not enough.",
    parameters: withBackendParameters({
      type: "object",
      properties: {
        tool: { type: "string", description: "Required. Tool name to call: devtools_*, browser_*, or profile_*." },
        input: { type: "object", description: "Parameter object for the target tool." },
      },
      required: ["tool"],
    }),
    async execute(id, params) {
      const routed = await maybeRoutePersonal("browser_raw", params);
      if (routed) return toolResult(routed);
      const toolName = String(params?.tool || "").trim();
      if (!toolName.startsWith("devtools_") && !toolName.startsWith("browser_") && !toolName.startsWith("profile_")) throw new Error("browser_raw only allows devtools_* / browser_* / profile_* tools");
      if (["browser_tool_catalog", "browser_tool_help", "browser_capability_map", "browser_f12_parity_matrix", "browser_workflow_guide", "browser_professional_readiness"].includes(toolName)) throw new Error("use tool usability helpers directly");
      const target = tools.get(toolName);
      if (!target) throw new Error(`unknown devtools tool: ${toolName}`);
      // C-03: merge top-level profile (and profile-adjacent params like tabId) into
      // the inner input so the devtools_* tool operates on the correct profile.
      // params.input is the devtools tool's own params; params.profile is the
      // browser_raw caller's profile selection that was previously discarded.
      const innerInput = {
        ...(params?.profile ? { profile: params.profile } : {}),
        ...(params?.tabId != null ? { tabId: params.tabId } : {}),
        ...(params?.input || {}),
      };
      const result = JSON.parse((await target.execute(id, innerInput)).content?.[0]?.text || "{}");
      return toolResult({ backend: "managed-cdp", facade: "browser_raw", tool: toolName, profile: params?.profile || defaultProfileName, result });
    },
  });
}
