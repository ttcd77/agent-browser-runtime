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

  tools.set("browser_click", {
    name: "browser_click",
    description: "Click by CSS selector, visible text, or x/y coordinate. For SPA/same-page buttons that should not wait for a navigation, pass waitMode=\"no-navigation\" or waitMode=\"spa\"; pass inputMode=\"dom\" only when a direct HTMLElement.click() is intended. Returns effective: false + evidence block when the click registered with the driver but produced no observable side effect (no navigation, no DOM change, no history change) — usually a sign that the actionability check passed but the SPA's React handler did not fire. Agents seeing effective: false should snapshot the page, reconsider the selector, or fall back to a different inputMode.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        selector: { type: "string", description: "CSS selector for the element to click (e.g. \"#submit\", \"button.primary\"). Use text instead for visible-label matching." },
        text: { type: "string", description: "Visible text of the element to click (e.g. \"Sign in\", \"Add to cart\"). Alternative to selector." },
        inputMode: { type: "string", enum: ["playwright", "dom"], description: "Click mechanism. Default \"playwright\" (Playwright locator). Use \"dom\" for a direct HTMLElement.click() fallback on SPA elements." },
        waitMode: { type: "string", enum: ["settle", "no-navigation", "spa", "none"], description: "Post-click wait strategy. Default \"settle\". Use \"no-navigation\" or \"spa\" for same-page buttons that do not trigger navigation." },
        waitMs: { type: "number", description: "Additional milliseconds to wait after the click action. Default 800." },
        actionTimeoutMs: { type: "number", description: "How long to wait for locator/actionability before clicking. Default 3000 ms." },
        timeoutMs: { type: "number", description: "Alias for actionTimeoutMs on the pre-action locator/actionability wait." },
        observeAfter: { type: "boolean", description: "Return a bounded after-click page observation." },
        returnSnapshot: { type: "boolean", description: "Alias for observeAfter." },
        x: { type: "number", description: "X coordinate for coordinate-based click. Requires y." },
        y: { type: "number", description: "Y coordinate for coordinate-based click. Requires x." },
        framePath: { type: "string", description: "Optional. Frame path string for clicking inside a specific iframe." },
        frameIndexes: { type: "array", items: { type: "number" }, description: "Optional. Frame index path for nested iframe targeting." },
        tabId: { type: "string", description: "Optional. Tab id override. Managed: profile tab override. Personal: Chrome tab id." },
        maxShadowRoots: { type: "number", description: "Advisory — not consumed by driver code. Playwright handles shadow DOM traversal natively with no configurable limit." },
        includeFrames: { type: "boolean", description: "Not implemented — driver ignores this flag. To target elements inside an iframe use framePath (iframe CSS selector string, e.g. 'iframe#chat') or frameIndexes (0-based integer array, e.g. [0] for the first iframe)." },
        includeShadow: { type: "boolean", description: "Advisory — not consumed by driver code. Playwright auto-traverses open shadow roots. For explicit shadow-root element targeting use a CSS selector with Playwright's >> deep-piercing syntax." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_click", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const waitPlan = clickWaitPlan(params);
      const capture = await runManagedPlaywrightAction({
        profile,
        eventType: "browser_click",
        waitMs: waitPlan.waitMs,
        event: {
          mode: typeof params?.x === "number" && typeof params?.y === "number" ? "coordinates" : (params?.selector ? "selector" : "text"),
          inputMode: "playwright",
          waitMode: waitPlan.waitMode,
          selector: params?.selector,
          text: params?.text,
          x: params?.x,
          y: params?.y,
          actionTimeoutMs: actionTimeoutMs(params),
        },
        action: () => managedPlaywrightDriver.click(profile.name, params),
      });
      const afterObservation = waitPlan.observeAfter ? await managedPlaywrightDriver.observe(profile.name) : undefined;
      return toolResult({
        profile: profile.name,
        evidenceDir: profile.evidenceDir,
        ...capture.result,
        waitMode: waitPlan.waitMode,
        waitMs: waitPlan.waitMs,
        guidance: waitPlan.guidance,
        capturedTraffic: capture.capturedTraffic,
        trafficFile: capture.trafficFile,
        eventFile: capture.eventFile,
        afterObservation,
      });
    },
  });

  tools.set("browser_hover", {
    name: "browser_hover",
    description: "Hover over an element by CSS selector, visible text, or x/y coordinate. Use for menus, tooltips, and controls revealed on mouseover.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        selector: { type: "string", description: "CSS selector for the element to hover over." },
        text: { type: "string", description: "Visible text of the element to hover over. Alternative to selector." },
        waitMs: { type: "number", description: "Additional milliseconds to wait after hover. Default 300." },
        actionTimeoutMs: { type: "number", description: "How long to wait for locator/actionability before hovering. Default 3000 ms." },
        timeoutMs: { type: "number", description: "Alias for actionTimeoutMs on the pre-action locator/actionability wait." },
        observeAfter: { type: "boolean", description: "Return a bounded after-hover page observation." },
        returnSnapshot: { type: "boolean", description: "Alias for observeAfter." },
        x: { type: "number", description: "X coordinate for coordinate-based hover. Requires y." },
        y: { type: "number", description: "Y coordinate for coordinate-based hover. Requires x." },
        framePath: { type: "string", description: "Optional. Frame path string for hovering inside a specific iframe." },
        frameIndexes: { type: "array", items: { type: "number" }, description: "Optional. Frame index path for nested iframe targeting." },
        tabId: { type: "string", description: "Optional. Tab id override." },
        maxShadowRoots: { type: "number", description: "Advisory — not consumed by driver code. Playwright handles shadow DOM traversal natively with no configurable limit." },
        includeFrames: { type: "boolean", description: "Not implemented — driver ignores this flag. To target elements inside an iframe use framePath (iframe CSS selector string, e.g. 'iframe#chat') or frameIndexes (0-based integer array, e.g. [0] for the first iframe)." },
        includeShadow: { type: "boolean", description: "Advisory — not consumed by driver code. Playwright auto-traverses open shadow roots. For explicit shadow-root element targeting use a CSS selector with Playwright's >> deep-piercing syntax." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_hover", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const waitPlan = clickWaitPlan(params, 300);
      const capture = await runManagedPlaywrightAction({
        profile,
        eventType: "browser_hover",
        waitMs: waitPlan.waitMs,
        event: {
          mode: typeof params?.x === "number" && typeof params?.y === "number" ? "coordinates" : (params?.selector ? "selector" : "text"),
          selector: params?.selector,
          text: params?.text,
          x: params?.x,
          y: params?.y,
          actionTimeoutMs: actionTimeoutMs(params),
        },
        action: () => managedPlaywrightDriver.hover(profile.name, params),
      });
      const afterObservation = waitPlan.observeAfter ? await managedPlaywrightDriver.observe(profile.name) : undefined;
      return toolResult({ profile: profile.name, evidenceDir: profile.evidenceDir, ...capture.result, capturedTraffic: capture.capturedTraffic, trafficFile: capture.trafficFile, eventFile: capture.eventFile, afterObservation });
    },
  });

  tools.set("browser_double_click", {
    name: "browser_double_click",
    description: "Double-click an element by CSS selector, visible text, or x/y coordinate. Use for editable table cells, file rows, and controls that require a double-click gesture.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        selector: { type: "string", description: "CSS selector for the element to double-click." },
        text: { type: "string", description: "Visible text of the element to double-click. Alternative to selector." },
        waitMode: { type: "string", enum: ["settle", "no-navigation", "spa", "none"], description: "Post-click wait strategy. Default \"settle\"." },
        waitMs: { type: "number", description: "Additional milliseconds to wait after the double-click. Default 800." },
        actionTimeoutMs: { type: "number", description: "How long to wait for locator/actionability before double-clicking. Default 3000 ms." },
        timeoutMs: { type: "number", description: "Alias for actionTimeoutMs on the pre-action locator/actionability wait." },
        observeAfter: { type: "boolean", description: "Return a bounded after-double-click page observation." },
        returnSnapshot: { type: "boolean", description: "Alias for observeAfter." },
        x: { type: "number", description: "X coordinate for coordinate-based double-click. Requires y." },
        y: { type: "number", description: "Y coordinate for coordinate-based double-click. Requires x." },
        framePath: { type: "string", description: "Optional. Frame path string for targeting inside a specific iframe." },
        frameIndexes: { type: "array", items: { type: "number" }, description: "Optional. Frame index path for nested iframe targeting." },
        tabId: { type: "string", description: "Optional. Tab id override." },
        maxShadowRoots: { type: "number", description: "Advisory — not consumed by driver code. Playwright handles shadow DOM traversal natively with no configurable limit." },
        includeFrames: { type: "boolean", description: "Not implemented — driver ignores this flag. To target elements inside an iframe use framePath (iframe CSS selector string, e.g. 'iframe#chat') or frameIndexes (0-based integer array, e.g. [0] for the first iframe)." },
        includeShadow: { type: "boolean", description: "Advisory — not consumed by driver code. Playwright auto-traverses open shadow roots. For explicit shadow-root element targeting use a CSS selector with Playwright's >> deep-piercing syntax." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_double_click", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const waitPlan = clickWaitPlan(params);
      const capture = await runManagedPlaywrightAction({
        profile,
        eventType: "browser_double_click",
        waitMs: waitPlan.waitMs,
        event: {
          mode: typeof params?.x === "number" && typeof params?.y === "number" ? "coordinates" : (params?.selector ? "selector" : "text"),
          waitMode: waitPlan.waitMode,
          selector: params?.selector,
          text: params?.text,
          x: params?.x,
          y: params?.y,
          actionTimeoutMs: actionTimeoutMs(params),
        },
        action: () => managedPlaywrightDriver.doubleClick(profile.name, params),
      });
      const afterObservation = waitPlan.observeAfter ? await managedPlaywrightDriver.observe(profile.name) : undefined;
      return toolResult({ profile: profile.name, evidenceDir: profile.evidenceDir, ...capture.result, waitMode: waitPlan.waitMode, waitMs: waitPlan.waitMs, guidance: waitPlan.guidance, capturedTraffic: capture.capturedTraffic, trafficFile: capture.trafficFile, eventFile: capture.eventFile, afterObservation });
    },
  });

  tools.set("browser_drag", {
    name: "browser_drag",
    description: "Drag one element to another element or point. Use selector (CSS selector) or text (visible text) to identify the drag source; use targetSelector/toSelector or targetText/toText for the drop target; or use deltaX/deltaY to drag by a pixel offset. Do NOT use 'from'/'to' parameter names — use selector/targetSelector.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        selector: { type: "string", description: "CSS selector for the drag source element." },
        text: { type: "string", description: "Visible text of the drag source element. Alternative to selector." },
        targetSelector: { type: "string", description: "CSS selector for the drop target element." },
        targetText: { type: "string", description: "Visible text of the drop target. Alternative to targetSelector." },
        toSelector: { type: "string", description: "Alias for targetSelector." },
        toText: { type: "string", description: "Alias for targetText." },
        x: { type: "number", description: "Source X coordinate for coordinate-based drag." },
        y: { type: "number", description: "Source Y coordinate for coordinate-based drag." },
        toX: { type: "number", description: "Destination X coordinate for coordinate-based drag." },
        toY: { type: "number", description: "Destination Y coordinate for coordinate-based drag." },
        deltaX: { type: "number", description: "Pixel offset in X from the source element center." },
        deltaY: { type: "number", description: "Pixel offset in Y from the source element center." },
        waitMs: { type: "number", description: "Additional milliseconds to wait after drag. Default 500." },
        actionTimeoutMs: { type: "number", description: "How long to wait for source/target locator actionability. Default 3000 ms." },
        timeoutMs: { type: "number", description: "Alias for actionTimeoutMs." },
        observeAfter: { type: "boolean", description: "Return a bounded after-drag page observation." },
        returnSnapshot: { type: "boolean", description: "Alias for observeAfter." },
        steps: { type: "number", description: "Number of intermediate steps for the drag gesture. Higher = smoother." },
        framePath: { type: "string", description: "Optional. Frame path for source element inside a specific iframe." },
        frameIndexes: { type: "array", items: { type: "number" }, description: "Optional. Frame index path for nested iframe source." },
        targetFramePath: { type: "string", description: "Optional. Frame path for the drop target element." },
        targetFrameIndexes: { type: "array", items: { type: "number" }, description: "Optional. Frame index path for nested iframe drop target." },
        tabId: { type: "string", description: "Optional. Tab id override." },
        maxShadowRoots: { type: "number", description: "Advisory — not consumed by driver code. Playwright handles shadow DOM traversal natively with no configurable limit." },
        includeFrames: { type: "boolean", description: "Not implemented — driver ignores this flag. To target elements inside an iframe use framePath (iframe CSS selector string, e.g. 'iframe#chat') or frameIndexes (0-based integer array, e.g. [0] for the first iframe)." },
        includeShadow: { type: "boolean", description: "Advisory — not consumed by driver code. Playwright auto-traverses open shadow roots. For explicit shadow-root element targeting use a CSS selector with Playwright's >> deep-piercing syntax." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_drag", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const waitPlan = clickWaitPlan(params, 500);
      const capture = await runManagedPlaywrightAction({
        profile,
        eventType: "browser_drag",
        waitMs: waitPlan.waitMs,
        event: {
          selector: params?.selector || null,
          text: params?.text || null,
          targetSelector: params?.targetSelector || params?.toSelector || null,
          targetText: params?.targetText || params?.toText || null,
          x: params?.x,
          y: params?.y,
          toX: params?.toX,
          toY: params?.toY,
          deltaX: params?.deltaX,
          deltaY: params?.deltaY,
          actionTimeoutMs: actionTimeoutMs(params),
        },
        action: () => managedPlaywrightDriver.drag(profile.name, params),
      });
      const afterObservation = waitPlan.observeAfter ? await managedPlaywrightDriver.observe(profile.name) : undefined;
      return toolResult({ profile: profile.name, evidenceDir: profile.evidenceDir, ...capture.result, capturedTraffic: capture.capturedTraffic, trafficFile: capture.trafficFile, eventFile: capture.eventFile, afterObservation });
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

  tools.set("browser_observe", {
    name: "browser_observe",
    description: "Return an agent-friendly list of visible controls with stable selector candidates and suggested CLI actions.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        limit: { type: "number", description: "Maximum controls to return. Default 60, max 200." },
        includeHidden: { type: "boolean", description: "If true, include hidden/invisible controls. Default false." },
        tabId: { type: "string", description: "Optional. Tab id override." },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        const limit = Math.max(1, Math.min(200, Number(params?.limit || 60)));
        const includeHidden = Boolean(params?.includeHidden);
        const expression = `(() => {
          const limit = ${JSON.stringify(limit)};
          const includeHidden = ${JSON.stringify(includeHidden)};
          const quote = (value) => {
            if (window.CSS?.escape) return CSS.escape(String(value));
            return String(value).replace(/["\\\\]/g, "\\\\$&");
          };
          const visible = (el) => {
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
          };
          const selectorFor = (el) => {
            const tag = el.tagName.toLowerCase();
            if (el.id) return "#" + quote(el.id);
            const name = el.getAttribute("name");
            if (name) return tag + "[name=\\"" + quote(name) + "\\"]";
            const type = el.getAttribute("type");
            if (type && ["input", "button"].includes(tag)) return tag + "[type=\\"" + quote(type) + "\\"]";
            const aria = el.getAttribute("aria-label");
            if (aria) return tag + "[aria-label=\\"" + quote(aria) + "\\"]";
            const cls = Array.from(el.classList || []).slice(0, 2).map(quote).join(".");
            if (cls) return tag + "." + cls;
            return tag;
          };
          const textFor = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || el.placeholder || el.getAttribute("title") || "").trim().replace(/\\s+/g, " ").slice(0, 160);
          const actionFor = (el) => {
            const tag = el.tagName.toLowerCase();
            const type = String(el.getAttribute("type") || "").toLowerCase();
            if (tag === "select" || type === "checkbox" || type === "radio") return "select";
            if (tag === "input" || tag === "textarea" || el.isContentEditable) return "type";
            return "click";
          };
          return {
            title: document.title,
            url: location.href,
            activeElement: document.activeElement ? selectorFor(document.activeElement) : null,
            controls: Array.from(document.querySelectorAll("button,a,input,textarea,select,[role=button],[contenteditable=true],summary,label"))
              .filter((el) => includeHidden || visible(el))
              .slice(0, limit)
              .map((el, index) => {
                const tag = el.tagName.toLowerCase();
                const type = el.getAttribute("type") || "";
                const text = textFor(el);
                const selector = selectorFor(el);
                const action = actionFor(el);
                const suggested =
                  action === "type" ? "agent-browser type <text> --selector " + JSON.stringify(selector) :
                  action === "select" ? "agent-browser select --selector " + JSON.stringify(selector) + " --value <value>" :
                  text ? "agent-browser click --text " + JSON.stringify(text) + " --wait-mode no-navigation" :
                  "agent-browser click --selector " + JSON.stringify(selector) + " --wait-mode no-navigation";
                return { index, tag, type, role: el.getAttribute("role") || "", text, selector, action, suggested };
              })
          };
        })()`;
        const result = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
        return { ok: true, profile: profile.name, tabId: target.id, ...(result.result?.value || {}) };
      }));
    },
  });

  tools.set("browser_stuck", {
    name: "browser_stuck",
    description: "Return a normalized diagnosis of why the current page may be stuck: captcha, mfa, login wall, error, or no-page. Does not assess vulnerabilities.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        tabId: { type: "string", description: "Optional. Tab id override." },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const profileName = profile.name;
      let url = null;
      let title = null;
      let bodyText = "";
      let pageState = null;
      let formState = null;
      let networkState = null;
      let tabId = null;
      let pageAccessError = null;
      try {
        const pageResult = await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
          tabId = target.id;
          const expression = `(() => {
            const text = document.body?.innerText || "";
            const controls = Array.from(document.querySelectorAll("button,input,select,textarea,a[href],[role=button]"));
            const disabledControls = controls.filter((el) => Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"));
            const submitControls = controls.filter((el) => {
              const tag = el.tagName.toLowerCase();
              const type = String(el.getAttribute("type") || "").toLowerCase();
              const role = String(el.getAttribute("role") || "").toLowerCase();
              const label = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().toLowerCase();
              return type === "submit"
                || (role === "button" && /submit|sign in|log in|continue|next/.test(label))
                || (tag === "button" && /submit|sign in|log in|continue|next/.test(label));
            });
            const disabledSubmitControls = submitControls.filter((el) => Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"));
            const visibleControls = controls.filter((el) => {
              const style = getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
            });
            const describeElement = (el) => {
              if (!el || el === document.body || el === document.documentElement) return null;
              return {
                tag: el.tagName.toLowerCase(),
                type: el.getAttribute("type") || "",
                name: el.getAttribute("name") || "",
                id: el.id || "",
                placeholder: el.getAttribute("placeholder") || "",
                ariaLabel: el.getAttribute("aria-label") || "",
              };
            };
            return {
              url: location.href,
              title: document.title,
              text: text.slice(0, 4000),
              pageState: {
                readyState: document.readyState,
                bodyTextLength: text.length,
                visibleControlCount: visibleControls.length,
                disabledControlCount: disabledControls.length,
                hasActiveElement: Boolean(document.activeElement && document.activeElement !== document.body),
                activeElement: describeElement(document.activeElement),
              },
              formState: {
                formCount: document.forms.length,
                inputCount: document.querySelectorAll("input").length,
                passwordInputCount: document.querySelectorAll("input[type=password]").length,
                fileInputCount: document.querySelectorAll("input[type=file]").length,
                textareaCount: document.querySelectorAll("textarea").length,
                submitControlCount: submitControls.length,
                disabledSubmitControlCount: disabledSubmitControls.length,
              }
            };
          })()`;
          const result = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
          return result.result?.value || {};
        });
        url = pageResult.url || null;
        title = pageResult.title || null;
        bodyText = pageResult.text || "";
        pageState = pageResult.pageState || null;
        formState = pageResult.formState || null;
      } catch (error) {
        pageAccessError = String(error?.message || error);
      }
      const recentRequests = profileRegistry.queryTraffic(profileName, { limit: 50 });
      const actionableRequests = recentRequests.filter((entry) => !["WebSocket", "EventSource"].includes(String(entry.resourceType || "")));
      const pendingRequests = actionableRequests.filter((entry) => entry.status == null && !entry.finishedAt && !entry.failed);
      const failedRequests = actionableRequests.filter((entry) => Boolean(entry.failed) || (typeof entry.status === "number" && entry.status >= 400));
      const nowMs = Date.now();
      const requestAgeMs = (entry) => {
        const raw = entry.timestamp || entry.startedAt || entry.wallTime || null;
        if (!raw) return null;
        const parsed = Date.parse(raw);
        return Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : null;
      };
      const stalePendingRequests = pendingRequests.filter((entry) => {
        const ageMs = requestAgeMs(entry);
        return typeof ageMs === "number" && ageMs >= 10_000;
      });
      const summarizeRequest = (entry) => ({
        requestId: entry.requestId || null,
        url: entry.url || null,
        method: entry.method || null,
        status: entry.status ?? null,
        resourceType: entry.resourceType || null,
        failed: Boolean(entry.failed),
        errorText: entry.errorText || null,
        ageMs: requestAgeMs(entry),
      });
      networkState = {
        checkedRecentRequests: true,
        recentRequestCount: recentRequests.length,
        pendingCount: pendingRequests.length,
        stalePendingCount: stalePendingRequests.length,
        failedCount: failedRequests.length,
        latestPending: pendingRequests.slice(-3).map(summarizeRequest),
        latestFailed: failedRequests.slice(-3).map(summarizeRequest),
        capture: profileRegistry.getCapture(profileName),
      };
      const combined = `${title || ""} ${bodyText}`.toLowerCase();
      const signals = [];
      if (!url) {
        signals.push("no-page");
      } else {
        if ((pageState?.bodyTextLength || 0) < 20 && pageState?.visibleControlCount === 0) signals.push("blank-page");
        if (pageState?.readyState && pageState.readyState !== "complete") signals.push("loading-document");
        if (/loading|please wait|processing|spinner/.test(combined)) signals.push("loading-text");
        if (formState?.submitControlCount > 0 && formState.disabledSubmitControlCount === formState.submitControlCount) signals.push("submit-disabled");
        if (/captcha|recaptcha|hcaptcha/.test(combined)) signals.push("captcha");
        if (/\bmfa\b|otp|passkey|two-factor|2fa|authenticator/.test(combined)) signals.push("mfa");
        if (/sign in|log in|login/.test(combined)) signals.push("login");
        if (/\berror\b|failed|denied|forbidden/.test(combined)) signals.push("error");
        if (networkState.stalePendingCount > 0) signals.push("network-pending");
        if (networkState.failedCount > 0) signals.push("network-failures");
      }
      const next = [];
      if (signals.includes("no-page")) {
        next.push("browser_open");
        next.push("browser_worker_doctor");
        next.push("browser_tabs");
      } else if (signals.includes("blank-page")) {
        next.push("browser_screenshot");
        next.push("browser_inspect");
      } else if (signals.includes("loading-document") || signals.includes("loading-text")) {
        next.push("browser_wait");
        next.push("browser_inspect");
      } else if (signals.includes("network-pending")) {
        next.push("profile_traffic_query");
        next.push("browser_wait");
        next.push("browser_inspect");
      } else if (signals.includes("network-failures")) {
        next.push("profile_traffic_query");
        next.push("browser_inspect");
      } else if (signals.includes("submit-disabled")) {
        next.push("browser_observe");
        next.push("browser_wait");
      } else if (signals.includes("captcha")) {
        next.push("browser_observe");
        next.push("browser_screenshot");
      } else if (signals.includes("mfa")) {
        next.push("browser_type");
      } else if (signals.includes("login")) {
        next.push("browser_type");
        next.push("browser_observe");
      } else if (signals.includes("error")) {
        next.push("browser_observe");
        next.push("browser_screenshot");
      } else {
        next.push("browser_observe");
      }
      return toolResult({ ok: true, profile: profileName, tabId, url, title, pageState, formState, networkState, pageAccessError, signals, next });
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
