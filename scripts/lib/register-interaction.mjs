// register-interaction.mjs — Tab + navigation + interaction tool family.
// Originally extracted verbatim from agent-cdp-server.mjs registerStandaloneBrowserTools.
// engine-collapse: the raw-CDP interaction path has been removed — every interaction
// verb (navigate/click/hover/double_click/drag/type/press/select/wait/upload/scroll)
// now drives ManagedPlaywrightDriver unconditionally and wraps it in the evidence
// recorder (runManagedPlaywrightAction). The page-read tools (browser_tabs /
// browser_observe / browser_stuck) still read via withManagedPageClient.
// Dependencies are injected via deps.
import { toolResult } from "./result-format.mjs";

export function registerInteractionTools(deps) {
  const {
    tools,
    profileRegistry,
    defaultProfileName,
    managedPlaywrightDriver,
    resolveProfile,
    withManagedPageClient,
    maybeRoutePersonal,
    runManagedPlaywrightAction,
    clickWaitPlan,
    actionTimeoutMs,
    profileTargetStatus,
  } = deps;

  tools.set("browser_tab_close", {
    name: "browser_tab_close",
    description: "Close browser tabs. Managed backend closes all pages in the given profile context (one profile = one tab in normal usage). Personal backend closes a specific tab by tabId from the user's real Chrome. Pass tabId for personal; managed only needs profile. Required cleanup at end of any browser flow so profiles do not accumulate orphan tabs.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Managed profile name. Ignored for personal." },
        tabId: { type: ["string", "number"], description: "Personal backend: Chrome tab id to close. Ignored for managed." },
        tabIds: { type: "array", items: { type: ["string", "number"] }, description: "Personal backend: batch close multiple tab ids." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_tab_close", params);
      if (routed) return toolResult(routed);
      // H-14: validate tabId on managed backend — do NOT silently fall back to active tab.
      if (params?.tabId !== undefined) {
        const { pages } = await profileTargetStatus();
        const tabIdStr = String(params.tabId);
        const matchingPage = pages.find((p) => String(p.id) === tabIdStr);
        if (!matchingPage) {
          return toolResult({ ok: false, error: "invalid_tabId", tabId: params.tabId, hint: "Use browser_tabs to list valid tab IDs.", backend: "managed" });
        }
      }
      const profile = await resolveProfile(params?.profile);
      try {
        const result = await managedPlaywrightDriver.closeTab(profile.name);
        return toolResult({ tool: "browser_tab_close", ...result });
      } catch (error) {
        return toolResult({ ok: false, backend: "managed", error: String(error?.message || error) });
      }
    },
  });

  tools.set("browser_tabs", {
    name: "browser_tabs",
    description: "List the LIVE browser tabs — pages open RIGHT NOW. `tabs` is the answer to \"what is open / what am I driving\". `summary` counts durable profiles by state (liveTabs / attachedProfiles / staleProfiles / unboundProfiles). A 'stale' profile is just a registry snapshot of a tab that is ALREADY CLOSED — hundreds pile up on a busy box, so by default `staleProfiles` shows only the 5 most-recently-used (full count is in summary; `staleProfilesOmitted` says how many were hidden). Pass includeStale:true for the whole stale list. Use browser_tab_close to close a tab; profile param is ignored. On personal backend `staleProfiles`/`summary` are null (registry lives in the worker).",
    parameters: { type: "object", properties: { includeStale: { type: "boolean", description: "Return the full stale-profile list instead of the 5-most-recent preview (default false)." } } },
    async execute(_id, params = {}) {
      const routed = await maybeRoutePersonal("browser_tabs", params);
      if (routed) return toolResult(routed);
      const { pages, profiles, profileNamesByTab } = await profileTargetStatus();
      // Stale = profile whose last-seen tab is already closed. They accumulate into
      // the hundreds and bury the (usually 1-2) live tabs above, which is exactly
      // what makes "what's actually open?" unanswerable. Default to recent-5 + count;
      // full list only on includeStale. summary keeps the true total either way.
      const stale = profiles
        .filter((profile) => profile.status === "stale")
        .sort((a, b) => String(b.lastUsedAt || "").localeCompare(String(a.lastUsedAt || "")));
      const shownStale = params?.includeStale === true ? stale : stale.slice(0, 5);
      return toolResult({
        tabs: pages.map((target) => ({
          id: target.id,
          title: target.title,
          url: target.url,
          profiles: profileNamesByTab.get(target.id) || [],
        })),
        staleProfiles: shownStale.map((profile) => ({
          name: profile.name,
          tabId: profile.tabId,
          title: profile.title,
          url: profile.url,
          lastUsedAt: profile.lastUsedAt,
        })),
        staleProfilesOmitted: stale.length - shownStale.length,
        summary: {
          liveTabs: pages.length,
          attachedProfiles: profiles.filter((profile) => profile.status === "attached").length,
          staleProfiles: stale.length,
          unboundProfiles: profiles.filter((profile) => profile.status === "unbound").length,
        },
      });
    },
  });

  tools.set("browser_navigate", {
    name: "browser_navigate",
    description: "Navigate an existing open tab to a new URL. Low-level: does not create or register a profile, does not set the sticky backend. Use browser_open instead for ordinary agent work — browser_open creates/resumes the profile record, sets sticky backend, and returns diagnostics. Use browser_navigate only when you already have a live tab bound to a profile and just need to change its URL without profile lifecycle overhead. Both managed and personal backends return top-level `url` and `tabId` fields.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        url: { type: "string", description: "Required. URL to navigate to (must start with http://, https://, data:, or file:)." },
        tabId: { type: "string", description: "Optional. Chrome tab id (personal backend) or profile tab id override (managed backend)." },
        waitMs: { type: "number", description: "Milliseconds to wait after navigation for the page to settle. Default 800." },
      },
      required: ["url"],
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_navigate", params);
      if (routed) return toolResult(routed);
      const url = String(params?.url || "");
      if (!/^https?:\/\//i.test(url) && !/^data:/i.test(url) && url !== "about:blank") {
        throw new Error("url must start with http://, https://, data:, or about:blank");
      }
      const profile = await profileRegistry.ensureProfileRecord(params?.profile || defaultProfileName, {
        browserContextId: null,
        browserContextOwned: false,
        isolation: "managed-playwright",
        driver: "playwright",
      });
      const waitMs = typeof params?.waitMs === "number" ? Math.min(Math.max(0, params.waitMs), 60_000) : 800;
      const capture = await runManagedPlaywrightAction({
        profile,
        eventType: "browser_navigate",
        waitMs,
        event: { url, actionTimeoutMs: actionTimeoutMs(params, 30_000) },
        action: () => managedPlaywrightDriver.navigate(profile.name, params),
      });
      return toolResult({
        ok: true,
        profile: profile.name,
        tabId: capture.result.tabId,
        url: capture.result.url,
        title: capture.result.title,
        backend: "managed-playwright",
        driver: "playwright",
        userDataDir: capture.result.userDataDir,
        launch: capture.result.launch,
        evidenceDir: profile.evidenceDir,
        capturedTraffic: capture.capturedTraffic,
        trafficFile: capture.trafficFile,
        eventFile: capture.eventFile,
      });
    },
  });





  tools.set("browser_type", {
    name: "browser_type",
    description: "Type text into a field by simulating individual keystrokes (Playwright keyboard events). Required param: selector (CSS), text. Keystrokes trigger keydown/keypress/keyup events and do NOT clear the field first. Pass clear=true to replace the full value atomically (triple-click clears before typing — preferred for React controlled inputs). Set pressEnter=true to submit after typing.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        selector: { type: "string", description: "Required. CSS selector for the input field (e.g. \"input[name='email']\", \"#password\")." },
        text: { type: "string", description: "Required. Text to type into the field character by character." },
        clear: { type: "boolean", description: "If true, triple-clicks to clear the field before typing. Default false." },
        pressEnter: { type: "boolean", description: "If true, presses Enter after typing to submit the form. Default false." },
        actionTimeoutMs: { type: "number", description: "How long to wait for the field to become focusable/editable. Default 3000 ms, max 60000." },
        timeoutMs: { type: "number", description: "Alias for actionTimeoutMs on the pre-type focus wait." },
        framePath: { type: "string", description: "Optional. Frame path for input inside a specific iframe." },
        frameIndexes: { type: "array", items: { type: "number" }, description: "Optional. Frame index path for nested iframe targeting." },
        tabId: { type: "string", description: "Optional. Tab id override." },
        includeFrames: { type: "boolean", description: "Not implemented — driver ignores this flag. To target elements inside an iframe use framePath (iframe CSS selector string, e.g. 'iframe#chat') or frameIndexes (0-based integer array, e.g. [0] for the first iframe)." },
        includeShadow: { type: "boolean", description: "Advisory — not consumed by driver code. Playwright auto-traverses open shadow roots. For explicit shadow-root element targeting use a CSS selector with Playwright's >> deep-piercing syntax." },
        maxShadowRoots: { type: "number", description: "Advisory — not consumed by driver code. Playwright handles shadow DOM traversal natively with no configurable limit." },
      },
      required: ["selector", "text"],
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_type", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const capture = await runManagedPlaywrightAction({
        profile,
        eventType: "browser_type",
        waitMs: typeof params?.waitMs === "number" ? Math.min(Math.max(0, params.waitMs), 60_000) : 700,
        event: {
          selector: params?.selector,
          textLength: String(params?.text || "").length,
          pressEnter: Boolean(params?.pressEnter),
          inputMode: "playwright",
          actionTimeoutMs: actionTimeoutMs(params),
        },
        action: () => managedPlaywrightDriver.type(profile.name, params),
      });
      return toolResult({
        profile: profile.name,
        evidenceDir: profile.evidenceDir,
        ...capture.result,
        capturedTraffic: capture.capturedTraffic,
        trafficFile: capture.trafficFile,
        eventFile: capture.eventFile,
      });
    },
  });

  tools.set("browser_press", {
    name: "browser_press",
    description: "Press a keyboard key or shortcut in the page, optionally after focusing a selector.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        key: { type: "string", description: "Required. Key or combo such as Enter, Escape, Tab, Ctrl+K, Control+Enter." },
        selector: { type: "string", description: "Optional CSS selector to focus before pressing the key." },
        actionTimeoutMs: { type: "number", description: "How long to wait for the optional selector to become focusable. Default 3000 ms, max 60000." },
        timeoutMs: { type: "number", description: "Alias for actionTimeoutMs on the optional focus wait." },
        framePath: { type: "string", description: "Optional. Frame path for key press inside a specific iframe." },
        frameIndexes: { type: "array", items: { type: "number" }, description: "Optional. Frame index path for nested iframe targeting." },
        includeFrames: { type: "boolean", description: "Not implemented — driver ignores this flag. To target elements inside an iframe use framePath (iframe CSS selector string, e.g. 'iframe#chat') or frameIndexes (0-based integer array, e.g. [0] for the first iframe)." },
        includeShadow: { type: "boolean", description: "Advisory — not consumed by driver code. Playwright auto-traverses open shadow roots. For explicit shadow-root element targeting use a CSS selector with Playwright's >> deep-piercing syntax." },
        maxShadowRoots: { type: "number", description: "Advisory — not consumed by driver code. Playwright handles shadow DOM traversal natively with no configurable limit." },
        tabId: { type: "string", description: "Optional. Tab id override." },
      },
      required: ["key"],
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_press", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const capture = await runManagedPlaywrightAction({
        profile,
        eventType: "browser_press",
        waitMs: typeof params?.waitMs === "number" ? Math.min(Math.max(0, params.waitMs), 60_000) : 300,
        event: { key: params?.key || params?.combo || null, selector: params?.selector || null },
        action: () => managedPlaywrightDriver.press(profile.name, params),
      });
      return toolResult({ profile: profile.name, evidenceDir: profile.evidenceDir, ...capture.result, capturedTraffic: capture.capturedTraffic, trafficFile: capture.trafficFile, eventFile: capture.eventFile });
    },
  });

  tools.set("browser_select", {
    name: "browser_select",
    description: "Set a select/radio/checkbox form control by CSS selector. For <select>, pass value, label, or index. For checkbox/radio, pass checked=true/false.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        selector: { type: "string", description: "Required. CSS selector for the <select>, <input type=checkbox>, or <input type=radio> element." },
        value: { type: "string", description: "For <select>: the option value attribute to select." },
        label: { type: "string", description: "For <select>: the visible option label text to select. Alternative to value." },
        index: { type: "number", description: "For <select>: zero-based index of the option to select. Alternative to value/label." },
        checked: { type: "boolean", description: "For checkbox/radio: true to check, false to uncheck." },
        waitMs: { type: "number", description: "Additional milliseconds to wait after selection. Default 700, max 60000." },
        tabId: { type: "string", description: "Optional. Tab id override." },
      },
      required: ["selector"],
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_select", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      // H-05: fast-fail within 5s if no matching select/checkbox/radio element exists.
      const selector = String(params?.selector || "");
      const fastFailResult = await Promise.race([
        withManagedPageClient(profile, params?.tabId || profile.tabId, async (client) => {
          const probe = await client.Runtime.evaluate({
            expression: `(() => {
              const el = document.querySelector(${JSON.stringify(selector)});
              if (!el) return "not_found";
              const tag = el.tagName.toLowerCase();
              const type = (el.getAttribute("type") || "").toLowerCase();
              if (tag === "select" || type === "checkbox" || type === "radio") return "found";
              return "wrong_type";
            })()`,
            returnByValue: true,
          }).catch(() => ({ result: { value: "error" } }));
          return probe.result?.value || "error";
        }).catch(() => "error"),
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000)),
      ]);
      if (fastFailResult === "not_found") {
        return toolResult({ ok: false, error: "no_select_element", selector, hint: "No element matching the selector was found. Use browser_find or browser_observe to discover valid selectors." });
      }
      if (fastFailResult === "timeout" || fastFailResult === "error") {
        return toolResult({ ok: false, error: "select_probe_failed", selector, hint: "Could not verify element existence within 5s. The profile may not have an active tab." });
      }
      const capture = await runManagedPlaywrightAction({
        profile,
        eventType: "browser_select",
        waitMs: typeof params?.waitMs === "number" ? Math.min(Math.max(0, params.waitMs), 60_000) : 700,
        event: { selector: params?.selector, value: params?.value, label: params?.label, index: params?.index, checked: params?.checked },
        action: () => managedPlaywrightDriver.select(profile.name, params),
      });
      return toolResult({ profile: profile.name, evidenceDir: profile.evidenceDir, ...capture.result, capturedTraffic: capture.capturedTraffic, trafficFile: capture.trafficFile, eventFile: capture.eventFile });
    },
  });



  tools.set("browser_wait", {
    name: "browser_wait",
    description: "Wait for a page condition: selector visible/attached/hidden/detached, visible text, URL substring, captured network request, or a plain timeout.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        selector: { type: "string", description: "CSS selector to wait for (used with state). Omit to wait by text/url/request instead." },
        text: { type: "string", description: "Visible text to wait for on the page." },
        urlContains: { type: "string", description: "Wait until the current page URL contains this substring." },
        requestUrlContains: { type: "string", description: "Wait until captured Network traffic contains a request URL matching this substring." },
        requestMethod: { type: "string", description: "Optional HTTP method filter for requestUrlContains (e.g. \"POST\")." },
        requestStatus: { type: "number", description: "Optional HTTP status code filter for requestUrlContains." },
        state: { type: "string", enum: ["visible", "attached", "hidden", "detached"], description: "Element state to wait for when using selector. Default \"visible\"." },
        timeoutMs: { type: "number", description: "Maximum milliseconds to wait before giving up. Default 8000, clamped to 60000." },
        pollMs: { type: "number", description: "Polling interval in milliseconds for request/URL conditions. Default 500, min 50." },
        tabId: { type: "string", description: "Optional. Tab id override." },
      },
    },
    async execute(_id, params) {
      // MAINTENANCE: keep _schemaProps in sync with the schema's `properties`
      // keys above. If a new wait param is added there, add it here too — the
      // strict validator below rejects anything not in this list (intentionally,
      // to surface --ms/--timeout typo silently dropped before 2026-06-13).
      const _schemaProps = ["profile", "selector", "text", "urlContains", "requestUrlContains", "requestMethod", "requestStatus", "state", "timeoutMs", "pollMs", "tabId"];
      const _allowed = new Set(_schemaProps);
      const _unknown = Object.keys(params || {}).filter(k => !_allowed.has(k));
      if (_unknown.length > 0) {
        const _hints = _unknown.map(p => {
          if (p === "ms") return `"ms" is not a valid parameter — did you mean "timeoutMs"?`;
          if (p === "timeout") return `"timeout" is not a valid parameter — did you mean "timeoutMs"?`;
          return `"${p}" is not a recognized parameter`;
        }).join("; ");
        return toolResult({ ok: false, error: "unknown_params", unknownParams: _unknown, hint: `Known parameters: ${_schemaProps.join(", ")}. ${_hints}` });
      }
      const routed = await maybeRoutePersonal("browser_wait", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const waitParams = {
        ...params,
        timeoutMs: typeof params?.timeoutMs === "number" ? Math.min(Math.max(50, params.timeoutMs), 60_000) : 8_000,
        pollMs: typeof params?.pollMs === "number" ? Math.min(Math.max(50, params.pollMs), 5_000) : 500,
      };
      const networkObservation = () => {
        const requestUrlContains = params?.requestUrlContains ? String(params.requestUrlContains) : "";
        if (!requestUrlContains) return { networkFound: true, networkRequest: null, networkMatchCount: null };
        const requestMethod = params?.requestMethod ? String(params.requestMethod).toUpperCase() : "";
        const rows = profileRegistry.queryTraffic(profile.name, {
          urlContains: requestUrlContains,
          ...(requestMethod ? { method: requestMethod } : {}),
          ...(typeof params?.requestStatus === "number" ? { status: params.requestStatus } : {}),
          limit: 20,
        });
        const latest = rows[rows.length - 1] || null;
        return {
          networkFound: Boolean(latest),
          networkRequest: latest
            ? {
                requestId: latest.requestId || null,
                url: latest.url || null,
                method: latest.method || null,
                status: latest.status ?? null,
                resourceType: latest.resourceType || null,
                finished: Boolean(latest.finishedAt || latest.loadingFinished),
                failed: Boolean(latest.failed),
              }
            : null,
          networkMatchCount: rows.length,
        };
      };
      const capture = await runManagedPlaywrightAction({
        profile,
        eventType: "browser_wait",
        waitMs: 0,
        event: { selector: params?.selector, text: params?.text, urlContains: params?.urlContains, requestUrlContains: params?.requestUrlContains, state: params?.state },
        action: () => managedPlaywrightDriver.wait(profile.name, waitParams, { networkObservation }),
      });
      return toolResult({ profile: profile.name, evidenceDir: profile.evidenceDir, ...capture.result, capturedTraffic: capture.capturedTraffic, trafficFile: capture.trafficFile, eventFile: capture.eventFile });
    },
  });

  tools.set("browser_upload", {
    name: "browser_upload",
    description: "Set files on an input[type=file] by CSS selector, similar to Playwright setInputFiles. Use for upload widgets after finding the file input.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        selector: { type: "string", description: "Required. CSS selector for the file input element (e.g. \"input[type=file]\")." },
        files: { type: "array", items: { type: "string" }, description: "Array of absolute file paths to set on the input. Use file for a single file." },
        file: { type: "string", description: "Single absolute file path to set on the input. Alternative to files array." },
        waitMs: { type: "number", description: "Additional milliseconds to wait after setting files. Default 700, max 60000." },
        tabId: { type: "string", description: "Optional. Tab id override." },
      },
      required: ["selector"],
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_upload", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const fileList = [
        ...(Array.isArray(params?.files) ? params.files.map(String) : []),
        ...(params?.file ? [String(params.file)] : []),
      ];
      const capture = await runManagedPlaywrightAction({
        profile,
        eventType: "browser_upload",
        waitMs: typeof params?.waitMs === "number" ? Math.min(Math.max(0, params.waitMs), 60_000) : 700,
        event: { selector: params?.selector, fileCount: fileList.length },
        action: () => managedPlaywrightDriver.upload(profile.name, params),
      });
      return toolResult({ profile: profile.name, evidenceDir: profile.evidenceDir, ...capture.result, capturedTraffic: capture.capturedTraffic, trafficFile: capture.trafficFile, eventFile: capture.eventFile });
    },
  });

  tools.set("browser_scroll", {
    name: "browser_scroll",
    description: "Scroll the current browser tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        tabId: { type: "string", description: "Optional. Tab id override." },
        x: { type: "number", description: "Horizontal scroll offset in pixels. Default 0." },
        y: { type: "number", description: "Vertical scroll offset in pixels. Default 600 (one viewport down)." },
        waitMs: { type: "number", description: "Additional milliseconds to wait after scrolling. Default 300." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_scroll", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const capture = await runManagedPlaywrightAction({
        profile,
        eventType: "browser_scroll",
        waitMs: typeof params?.waitMs === "number" ? Math.min(Math.max(0, params.waitMs), 60_000) : 300,
        event: { x: params?.x || 0, y: params?.y || 600 },
        action: () => managedPlaywrightDriver.scroll(profile.name, params),
      });
      return toolResult({
        profile: profile.name,
        evidenceDir: profile.evidenceDir,
        ...capture.result,
        capturedTraffic: capture.capturedTraffic,
        trafficFile: capture.trafficFile,
        eventFile: capture.eventFile,
      });
    },
  });
}
