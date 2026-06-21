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

// Never silently truncate text returned to the agent.
// If content exceeds this threshold, write to disk and return a filePath instead.
const TEXT_INLINE_THRESHOLD = 200_000;

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
