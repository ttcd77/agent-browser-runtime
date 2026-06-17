// register-profile-lifecycle.mjs — Profile lifecycle + tab adoption tool family.
// Extracted verbatim from agent-cdp-server.mjs registerStandaloneBrowserTools (behavior-preserving).
// Dependencies are injected via deps; pure/lib helpers are imported directly.
import { toolResult, normalizeProfileName } from "./result-format.mjs";

export function registerProfileLifecycleTools(deps) {
  const {
    tools,
    cdpPort,
    profileRegistry,
    defaultProfileName,
    managedPlaywrightDriver,
    sleep,
    createBrowserContext: _createBrowserContext,
    createPageTarget,
    resolveProfile,
    runManagedPlaywrightAction,
    withManagedPageClient,
    profileTargetStatus,
    findAdoptableTarget,
    summarizeTargetForRegistry,
    resumableUrlFromProfile,
  } = deps;

  tools.set("profile_create", {
    name: "profile_create",
    description: "Create or reopen a durable agent browser profile. A profile owns one tab and one evidence directory.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Required. Profile name (slug, e.g. 'target-clean')." },
        url: { type: "string", description: "URL to open in the new profile. Omit to create metadata-only without a browser tab." },
      },
      required: ["profile"],
    },
    async execute(_id, params) {
      const profile = await profileRegistry.ensureProfileRecord(params?.profile, {
        browserContextId: null,
        browserContextOwned: false,
        isolation: "managed-playwright",
        driver: "playwright",
      });
      if (!params?.url) return toolResult({ ok: true, profile, created: "metadata-only", note: "No browser tab was opened because no URL was provided." });
      const resumed = await tools.get("profile_resume").execute("agent-cdp-server", {
        profile: profile.name,
        url: params.url,
      });
      return resumed;
    },
  });

  tools.set("profile_list", {
    name: "profile_list",
    description: "List durable agent browser profiles managed by this local server, including whether each profile is attached to a live CDP tab.",
    parameters: { type: "object", properties: {} },
    async execute() {
      const status = await profileTargetStatus();
      return toolResult({
        profiles: status.profiles,
        summary: {
          total: status.profiles.length,
          attached: status.profiles.filter((profile) => profile.status === "attached").length,
          stale: status.profiles.filter((profile) => profile.status === "stale").length,
          unbound: status.profiles.filter((profile) => profile.status === "unbound").length,
          liveTabs: status.pages.length,
        },
        registryFile: profileRegistry.registryFile,
      });
    },
  });

  tools.set("browser_adopt_tab", {
    name: "browser_adopt_tab",
    description:
      "Bind an existing live CDP tab to a durable profile. Use this when a visible page exists in the managed browser but the profile registry points at a stale or wrong tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Required. Profile name to bind." },
        tabId: { type: "string", description: "Exact tab ID to adopt. Takes precedence over URL/title filters." },
        urlContains: { type: "string", description: "Adopt the first tab whose URL contains this substring." },
        titleContains: { type: "string", description: "Adopt the first tab whose title contains this substring." },
        latest: { type: "boolean", description: "Adopt the most recently opened tab." },
        preferNonBlank: { type: "boolean", description: "Skip blank/about:blank tabs when selecting the best match." },
        reason: { type: "string", description: "Human-readable adoption reason recorded in the profile registry." },
      },
      required: ["profile"],
    },
    async execute(_id, params) {
      const { pages, profiles } = await profileTargetStatus();
      const target = findAdoptableTarget(pages, params);
      if (!target) {
        return toolResult({
          ok: false,
          error: "no_matching_live_tab",
          profile: normalizeProfileName(params?.profile),
          filters: {
            tabId: params?.tabId || null,
            urlContains: params?.urlContains || null,
            titleContains: params?.titleContains || null,
          },
          liveTabs: pages.map(summarizeTargetForRegistry),
          staleProfiles: profiles.filter((profile) => profile.status === "stale").map((profile) => ({
            name: profile.name,
            tabId: profile.tabId,
            title: profile.title,
            url: profile.url,
          })),
          next: "Open or reload the page through browser_open/browser_navigate, or connect the worker to the browser process that owns the visible tab.",
        });
      }
      const before = profiles.find((profile) => profile.name === normalizeProfileName(params?.profile)) || null;
      const profile = await profileRegistry.adoptProfile(params?.profile, target, {
        adoptedAt: new Date().toISOString(),
        adoptReason: params?.reason || null,
      });
      return toolResult({
        ok: true,
        profile,
        adoptedTarget: summarizeTargetForRegistry(target),
        previousProfile: before
          ? {
              name: before.name,
              tabId: before.tabId,
              title: before.title,
              url: before.url,
              status: before.status,
            }
          : null,
        next: "Use browser_snapshot/browser_inspect/browser_capture on this profile. If the desired visible page is absent from liveTabs, it is not attached to this CDP endpoint.",
      });
    },
  });

  tools.set("profile_resume", {
    name: "profile_resume",
    description:
      "Recover a durable profile after an agent chat/session or browser tab was closed. Reuses a live tab when attached; otherwise reopens the profile's last URL in a fresh managed tab and binds it back.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Required. Profile name to resume." },
        url: { type: "string", description: "URL to open if the profile has no live tab. Defaults to the profile's last URL." },
        waitMs: { type: "number", description: "Wait time in ms after navigation. Default: 800." },
        reload: { type: "boolean", description: "Force reload even when the tab is already attached. Default: false." },
      },
      required: ["profile"],
    },
    async execute(_id, params) {
      const requested = normalizeProfileName(params?.profile);
      const status = await profileTargetStatus();
      const existing = status.profiles.find((entry) => entry.name === requested) || null;
      const waitMs = typeof params?.waitMs === "number" ? Math.min(Math.max(0, params.waitMs), 60_000) : 800;
      if (existing?.status === "attached" && existing.currentTarget && params?.reload !== true) {
        return toolResult({
          ok: true,
          profile: existing,
          resumed: "attached-existing-tab",
          continuity: "live-tab-continuity",
          note: "The original live CDP tab is still attached. Continue with browser_snapshot/browser_inspect/browser_capture.",
        });
      }
      const url = resumableUrlFromProfile({ url: params?.url || existing?.url }, "about:blank");
      if (url === "about:blank") {
        return toolResult({
          ok: false,
          profile: requested,
          error: "profile_resume_requires_url",
          reason: "Resuming a managed Playwright profile without a real URL would create an implicit about:blank page.",
          previousProfile: existing
            ? {
                name: existing.name,
                tabId: existing.tabId,
                title: existing.title,
                url: existing.url,
                status: existing.status,
              }
            : null,
          next: [`agent-browser profile resume ${requested} --url <url>`, `agent-browser open <url> --profile ${requested}`],
        });
      }
      const profileSeed = await profileRegistry.ensureProfileRecord(requested, {
        browserContextId: null,
        browserContextOwned: false,
        isolation: "managed-playwright",
        driver: "playwright",
      });
      const capture = await runManagedPlaywrightAction({
        profile: profileSeed,
        eventType: "profile_resume",
        waitMs,
        event: { url, resumeReason: existing?.status === "stale" ? "stale-profile-tab" : existing ? "unbound-profile" : "new-profile" },
        action: () => managedPlaywrightDriver.open(requested, { url, waitMs }),
      });
      const profile = await profileRegistry.ensureProfileRecord(requested, {
        tabId: capture.result?.tabId || `playwright:${requested}`,
        title: capture.result?.title || "",
        url: capture.result?.url || url,
        browserContextId: null,
        browserContextOwned: false,
        isolation: "managed-playwright",
        driver: "playwright",
        tabDestroyedAt: null,
      });
      return toolResult({
        ok: true,
        profile,
        resumed: existing?.status === "stale" ? "opened-playwright-page-from-last-url" : existing ? "opened-playwright-page-for-profile" : "created-playwright-profile-page",
        previousProfile: existing
          ? {
              name: existing.name,
              tabId: existing.tabId,
              title: existing.title,
              url: existing.url,
              status: existing.status,
            }
          : null,
        openedTarget: {
          id: profile.tabId,
          title: profile.title,
          url: profile.url,
          type: "page",
        },
        continuity: "browser-storage-continuity-only",
        driver: "playwright",
        capturedTraffic: capture.capturedTraffic,
        trafficFile: capture.trafficFile,
        eventFile: capture.eventFile,
        next: "Run browser_snapshot or browser_inspect, then browser_capture start before the next important action.",
      });
    },
  });

  tools.set("browser_resume_profile", {
    name: "browser_resume_profile",
    description: "Facade alias for profile_resume. Use this as the first recovery step when a role/profile looks disconnected after an agent session was closed.",
    parameters: tools.get("profile_resume").parameters,
    async execute(id, params) {
      return await tools.get("profile_resume").execute(id, params);
    },
  });

  tools.set("browser_auth_bootstrap", {
    name: "browser_auth_bootstrap",
    description:
      "Operator-assisted auth bootstrap for managed profiles. Opens or resumes a login page, starts objective capture, and lets a human complete login/2FA/anti-abuse checks in the visible browser. It observes completion; it does not bypass login controls.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        action: {
          type: "string",
          enum: ["start", "status", "finish"],
          description: "Bootstrap phase. start: open login page and begin capture. status: check current auth state. finish: finalize and stop capture. Default: start.",
        },
        loginUrl: { type: "string", description: "Login page URL to open (start action). Must start with https://." },
        successUrlContains: { type: "string", description: "Declare success when the current URL contains this string." },
        successSelector: { type: "string", description: "Declare success when this CSS selector matches on the page." },
        successCookieNames: { type: "array", items: { type: "string" }, description: "Declare success when all these cookie names are present." },
        label: { type: "string", description: "Capture label. Default: operator-assisted-auth-bootstrap." },
        waitMs: { type: "number", description: "Wait time in ms after opening the login page. Default: 800." },
        stopCaptureOnSuccess: { type: "boolean", description: "Stop capture recording when success is detected. Default: true." },
      },
    },
    async execute(_id, params) {
      const action = String(params?.action || "start").toLowerCase();
      const profileName = params?.profile || defaultProfileName;
      const waitMs = typeof params?.waitMs === "number" ? Math.min(Math.max(0, params.waitMs), 60_000) : 800;
      const successUrlContains = params?.successUrlContains ? String(params.successUrlContains) : "";
      const successSelector = params?.successSelector ? String(params.successSelector) : "";
      const successCookieNames = Array.isArray(params?.successCookieNames) ? params.successCookieNames.map(String).filter(Boolean) : [];
      const configuredSuccessConditions = [
        successUrlContains ? "url" : "",
        successSelector ? "selector" : "",
        successCookieNames.length ? "cookies" : "",
      ].filter(Boolean);
      const noSuccessConditionConfigured = configuredSuccessConditions.length === 0;
      if (action === "start") {
        let profile;
        if (params?.loginUrl) {
          const url = String(params.loginUrl);
          if (!/^https?:\/\//i.test(url)) throw new Error("loginUrl must start with http:// or https://");
          const target = await createPageTarget(cdpPort, url);
          if (waitMs > 0) await sleep(waitMs);
          profile = await profileRegistry.adoptProfile(profileName, target, {
            authBootstrapStartedAt: new Date().toISOString(),
            authBootstrapLoginUrl: url,
          });
        } else {
          const status = await tools.get("profile_resume").execute("agent-cdp-server", { profile: profileName, waitMs });
          profile = JSON.parse(status.content?.[0]?.text || "{}").profile;
        }
        const capture = profileRegistry.setCapture(profile.name, {
          enabled: true,
          startedAt: new Date().toISOString(),
          stoppedAt: null,
          label: params?.label || "operator-assisted-auth-bootstrap",
        });
        const eventFile = profileRegistry.appendEvent(profile.name, {
          type: "browser_auth_bootstrap_start",
          tabId: profile.tabId,
          url: profile.url,
          successUrlContains: successUrlContains || null,
          successSelector: successSelector || null,
          successCookieNames,
          configuredSuccessConditions,
          noSuccessConditionConfigured,
          operatorAction: "Complete login manually in the visible managed browser, then call browser_auth_bootstrap with action=status or action=finish.",
        });
        return toolResult({
          ok: true,
          profile: profile.name,
          tabId: profile.tabId,
          url: profile.url,
          capture,
          eventFile,
          mode: "operator-assisted",
          boundary: "The tool opens and records the browser state; the human completes password, 2FA, and anti-abuse checks.",
          next: "After the page reaches the authenticated state, call browser_auth_bootstrap with action=status or action=finish.",
        });
      }
      if (!["status", "finish"].includes(action)) throw new Error("action must be start, status, or finish");
      const profile = await resolveProfile(profileName);
      return toolResult(await withManagedPageClient(profile, profile.tabId, async (client, target) => {
        await client.Page.enable().catch(() => {});
        await client.Network.enable().catch(() => {});
        const successSelectorLiteral = JSON.stringify(successSelector);
        const locationResult = await client.Runtime.evaluate({
          expression: `(() => {
            const successSelector = ${successSelectorLiteral};
            return {
              href: location.href,
              title: document.title,
              readyState: document.readyState,
              selectorMatched: successSelector ? Boolean(document.querySelector(successSelector)) : false,
            };
          })()`,
          returnByValue: true,
          awaitPromise: true,
        }).catch(() => null);
        const page = locationResult?.result?.value || { href: target.url || profile.url || "about:blank", title: target.title || profile.title || "", readyState: "unknown" };
        const cookiesResult = await client.Network.getCookies().catch(() => ({ cookies: [] }));
        const cookieNames = Array.isArray(cookiesResult.cookies) ? cookiesResult.cookies.map((cookie) => cookie.name).filter(Boolean) : [];
        const urlMatched = Boolean(successUrlContains && String(page.href || "").includes(successUrlContains));
        const selectorMatched = Boolean(successSelector && page.selectorMatched);
        const missingCookies = successCookieNames.filter((name) => !cookieNames.includes(name));
        const cookiesMatched = successCookieNames.length ? missingCookies.length === 0 : false;
        const success = urlMatched || selectorMatched || cookiesMatched;
        let capture = profileRegistry.getCapture(profile.name);
        if (action === "finish" && (success || params?.stopCaptureOnSuccess === false)) {
          capture = profileRegistry.setCapture(profile.name, {
            ...capture,
            enabled: params?.stopCaptureOnSuccess === false,
            stoppedAt: params?.stopCaptureOnSuccess === false ? capture.stoppedAt : new Date().toISOString(),
          });
        }
        const nextProfile = await profileRegistry.touchProfile(profile.name, { tabId: target.id, url: page.href, title: page.title });
        const eventFile = profileRegistry.appendEvent(profile.name, {
          type: `browser_auth_bootstrap_${action}`,
          tabId: target.id,
          page,
          success,
          checks: {
            successUrlContains: successUrlContains || null,
            urlMatched,
            successSelector: successSelector || null,
            selectorMatched,
            successCookieNames,
            cookiesMatched,
            missingCookies,
            observedCookieNames: cookieNames,
            configuredSuccessConditions,
            noSuccessConditionConfigured,
          },
        });
        return {
          ok: true,
          profile: nextProfile.name,
          tabId: target.id,
          page,
          success,
          capture,
          eventFile,
          checks: {
            successUrlContains: successUrlContains || null,
            urlMatched,
            successSelector: successSelector || null,
            selectorMatched,
            successCookieNames,
            cookiesMatched,
            missingCookies,
            observedCookieNames: cookieNames,
            configuredSuccessConditions,
            noSuccessConditionConfigured,
          },
          boundary: "Manual/operator-assisted auth state observation only. No bypass decision or vulnerability judgment is made.",
          next: success
            ? "Proceed with browser_capture/browser_inspect/security pack using this authenticated profile."
            : (noSuccessConditionConfigured
              ? "Call status or finish again with successUrlContains, successSelector, or successCookieNames so auth state can be checked objectively."
              : "Complete login in the visible browser, then call status again."),
        };
      }));
    },
  });

  tools.set("profile_delete", {
    name: "profile_delete",
    description: "Delete a managed browser profile record, close its tab, and remove the profile directory (including evidence files) from disk.",
    parameters: {
      type: "object",
      properties: { profile: { type: "string", description: "Required. Profile name to delete." } },
      required: ["profile"],
    },
    async execute(_id, params) {
      return toolResult(await profileRegistry.deleteProfile(params?.profile));
    },
  });

  tools.set("profile_warm_from_personal", {
    name: "profile_warm_from_personal",
    description:
      "Copy Google trust cookies from the user's personal Chrome into a managed profile. This makes the managed profile appear as a real user to bot detection systems (Arkose Labs, reCAPTCHA) without sharing any target-site cookies. Call this before registering an account or visiting a page that uses bot detection on a fresh managed profile.",
    parameters: {
      type: "object",
      properties: {
        profile: {
          type: "string",
          description: "Managed profile name to warm. Defaults to the active default profile.",
        },
        domains: {
          type: "array",
          items: { type: "string" },
          description: "Domains to copy from personal Chrome. Defaults to Google trust domains: .google.com, .accounts.google.com, .gstatic.com.",
        },
      },
    },
    async execute(_id, params) {
      const cookiesGetTool = tools.get("browser_cookies_get");
      const cookiesSetTool = tools.get("browser_cookies_set");
      if (!cookiesGetTool || !cookiesSetTool) {
        return toolResult({ ok: false, error: "browser_cookies_get or browser_cookies_set not yet registered" });
      }

      const targetDomains = Array.isArray(params?.domains) && params.domains.length
        ? params.domains
        : [".google.com", ".accounts.google.com", ".gstatic.com"];

      const allCookies = [];
      const fetchErrors = [];

      for (const domain of targetDomains) {
        const raw = await cookiesGetTool.execute("profile_warm_from_personal", { backend: "personal", domain });
        const parsed = JSON.parse(raw?.content?.[0]?.text || "{}");
        if (parsed.ok === false) {
          fetchErrors.push({ domain, error: parsed.error || "unknown" });
          continue;
        }
        const batch = Array.isArray(parsed.cookies) ? parsed.cookies : [];
        allCookies.push(...batch);
      }

      if (!allCookies.length && fetchErrors.length) {
        return toolResult({
          ok: false,
          profile: params?.profile || null,
          fetched: 0,
          injected: 0,
          domains: targetDomains,
          fetchErrors,
          note: "Failed to fetch any cookies from personal Chrome. Ensure the personal bridge is running (agent-browser ready personal) and you are logged in to Google.",
        });
      }

      // Deduplicate by name+domain
      const seen = new Set();
      const unique = allCookies.filter((c) => {
        const key = `${c.name}@${c.domain}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // Drop already-expired persistent cookies; keep session cookies (expires === -1)
      const nowSec = Math.floor(Date.now() / 1000);
      const valid = unique.filter((c) => c.expires === -1 || c.expires > nowSec + 60);

      // Map Chrome cookie format to Playwright addCookies format
      const sameSiteMap = { no_restriction: "None", lax: "Lax", strict: "Strict", unspecified: "Lax" };
      const playwrightCookies = valid.map((c) => {
        const entry = {
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || "/",
        };
        if (typeof c.httpOnly === "boolean") entry.httpOnly = c.httpOnly;
        if (typeof c.secure === "boolean") entry.secure = c.secure;
        if (c.sameSite) {
          const mapped = sameSiteMap[c.sameSite.toLowerCase()];
          if (mapped) entry.sameSite = mapped;
        }
        if (c.expires && c.expires !== -1) entry.expires = c.expires;
        return entry;
      });

      if (!playwrightCookies.length) {
        return toolResult({
          ok: false,
          profile: params?.profile || null,
          fetched: allCookies.length,
          deduped: unique.length,
          valid: 0,
          injected: 0,
          domains: targetDomains,
          fetchErrors: fetchErrors.length ? fetchErrors : undefined,
          note: "No valid (non-expired) Google cookies found in personal Chrome. Sign in to Google in your personal browser and retry.",
        });
      }

      const setRaw = await cookiesSetTool.execute("profile_warm_from_personal", {
        backend: "managed",
        profile: params?.profile,
        cookies: playwrightCookies,
      });
      const setResult = JSON.parse(setRaw?.content?.[0]?.text || "{}");

      return toolResult({
        ok: setResult.ok !== false,
        profile: params?.profile || null,
        domains: targetDomains,
        fetched: allCookies.length,
        deduped: unique.length,
        valid: valid.length,
        injected: setResult.count ?? playwrightCookies.length,
        fetchErrors: fetchErrors.length ? fetchErrors : undefined,
        setResult,
        note: setResult.ok !== false
          ? `Google trust cookies copied to managed profile '${params?.profile || "default"}'. Bot detection should now see this profile as a real user.`
          : `Cookie injection failed: ${setResult.error || "unknown error"}`,
      });
    },
  });
}
