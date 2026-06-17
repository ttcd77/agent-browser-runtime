// register-page-health.mjs — Page health / security / signal summary tool family.
// Extracted verbatim from agent-cdp-server.mjs registerStandaloneBrowserTools (behavior-preserving).
// Dependencies are injected via deps; pure/lib helpers are imported directly.
// browser_accessibility_snapshot is interleaved in the source between these spans but belongs to the
// snapshot-dom family, so it stays in the closure; the two page-health spans move here as two tools.set runs.
import { toolResult } from "./result-format.mjs";
import { summarizeNetworkRecords } from "./network-summary.mjs";
import { summarizeCookies, buildSignalSummary } from "./evidence-summaries.mjs";
import { hostnameForUrl } from "./network-filters.mjs";

export function registerPageHealthTools(deps) {
  const {
    tools,
    profileRegistry,
    resolveProfile,
    withManagedPageClient,
    captureNetworkForProfile,
    maybeRoutePersonal,
  } = deps;

  tools.set("browser_security_summary", {
    name: "browser_security_summary",
    description: "Return current page security context and TLS/certificate summary for the profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        tabId: { type: "string", description: "CDP tab ID. Defaults to the profile's current tab." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_security_summary", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        const pageResult = await client.Runtime.evaluate({
          expression: `(() => ({
            url: location.href,
            origin: location.origin,
            protocol: location.protocol,
            isSecureContext,
            mixedContentType: document.mixedContentType || null,
            referrer: document.referrer,
          }))()`,
          returnByValue: true,
        });
        const requests = profileRegistry.queryTraffic(profile.name, { limit: 1000000 });
        const tls = requests
          .filter((request) => request.securityDetails)
          .map((request) => ({
            requestId: request.requestId,
            url: request.url,
            protocol: request.securityDetails.protocol,
            subjectName: request.securityDetails.subjectName,
            issuer: request.securityDetails.issuer,
            validFrom: request.securityDetails.validFrom,
            validTo: request.securityDetails.validTo,
            certificateTransparencyCompliance: request.securityDetails.certificateTransparencyCompliance,
            sanList: request.securityDetails.sanList,
          }));
        const byHost = {};
        for (const entry of tls) {
          let host = "";
          try { host = new URL(entry.url).hostname; } catch { host = ""; }
          if (!host || byHost[host]) continue;
          byHost[host] = entry;
        }
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return { profile: profile.name, tabId: target.id, page: pageResult.result?.value, tlsByHost: byHost, tlsCount: tls.length };
      }));
    },
  });

  tools.set("browser_page_diagnostics", {
    name: "browser_page_diagnostics",
    description: "Return a dashboard-friendly page health summary across Network, Security, Storage, Console, and Accessibility.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        tabId: { type: "string", description: "CDP tab ID. Defaults to the profile's current tab." },
        limit: { type: "number", description: "Max items per network category in the summary. Default: 5." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_page_diagnostics", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const limit = typeof params?.limit === "number" ? Math.min(Math.max(1, params.limit), 10_000) : 5;
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        const pageResult = await client.Runtime.evaluate({
          expression: `(async () => {
            const indexedDbDatabases = indexedDB?.databases ? await indexedDB.databases().catch(() => []) : [];
            const cacheNames = caches?.keys ? await caches.keys().catch(() => []) : [];
            const serviceWorkers = navigator.serviceWorker?.getRegistrations ? await navigator.serviceWorker.getRegistrations().catch(() => []) : [];
            return {
              title: document.title,
              url: location.href,
              origin: location.origin,
              protocol: location.protocol,
              isSecureContext,
              readyState: document.readyState,
              visibilityState: document.visibilityState,
              selectedTextLength: String(getSelection?.() || "").length,
              viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
              storage: {
                localStorageKeys: Object.keys(localStorage || {}).length,
                sessionStorageKeys: Object.keys(sessionStorage || {}).length,
                documentCookieBytes: document.cookie?.length || 0,
                indexedDbDatabases: indexedDbDatabases.length || 0,
                cacheStorageCaches: cacheNames.length || 0,
                serviceWorkerRegistrations: serviceWorkers.length || 0,
              },
            };
          })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        const page = pageResult.result?.value || {};
        const rows = profileRegistry.queryTraffic(profile.name, { limit: 1000000 });
        const websockets = profileRegistry.readWebSockets(profile.name);
        const tlsHosts = {};
        for (const request of rows.filter((entry) => entry.securityDetails)) {
          const host = hostnameForUrl(request.url);
          if (!host || tlsHosts[host]) continue;
          tlsHosts[host] = {
            protocol: request.securityDetails.protocol,
            subjectName: request.securityDetails.subjectName,
            issuer: request.securityDetails.issuer,
            certificateTransparencyCompliance: request.securityDetails.certificateTransparencyCompliance,
          };
        }
        let accessibility = null;
        try {
          await client.Accessibility.enable().catch(() => {});
          const ax = await client.Accessibility.getFullAXTree({ interestingOnly: true });
          accessibility = { nodeCount: Array.isArray(ax.nodes) ? ax.nodes.length : 0 };
        } catch (error) {
          accessibility = { error: String(error?.message || error) };
        }
        const cookies = await client.Network.getCookies().catch(() => ({ cookies: [] }));
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          page: {
            title: page.title,
            url: page.url,
            origin: page.origin,
            protocol: page.protocol,
            isSecureContext: page.isSecureContext,
            readyState: page.readyState,
            visibilityState: page.visibilityState,
            selectedTextLength: page.selectedTextLength,
            viewport: page.viewport,
          },
          capture: profileRegistry.getCapture(profile.name),
          network: summarizeNetworkRecords(rows, websockets, limit),
          security: {
            isSecureContext: page.isSecureContext,
            tlsHosts,
          },
          storage: {
            ...(page.storage || {}),
            browserCookieCount: Array.isArray(cookies.cookies) ? cookies.cookies.length : 0,
            cookieSummary: summarizeCookies(cookies.cookies || []),
          },
          accessibility,
        };
      }));
    },
  });

  tools.set("browser_signal_summary", {
    name: "browser_signal_summary",
    description: "Return objective cross-panel browser signals across Network, Cookies, Storage, Service Workers, Security, and optional token scan. This does not decide vulnerability impact.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        tabId: { type: "string", description: "CDP tab ID. Defaults to the profile's current tab." },
        limit: { type: "number", description: "Max items per network category. Default: 5." },
        includeTokenScan: { type: "boolean", description: "Also run browser_token_scan and include results. Default: false." },
      },
    },
    async execute(id, params) {
      const routed = await maybeRoutePersonal("browser_signal_summary", params);
      if (routed) return toolResult(routed);
      const readPayload = (result) => JSON.parse(result.content?.[0]?.text || "{}");
      const diagnostics = readPayload(await tools.get("browser_page_diagnostics").execute(id, params));
      const cookieResult = readPayload(await tools.get("browser_cookie_summary").execute(id, params));
      const serviceWorkerSummary = readPayload(await tools.get("browser_service_worker_summary").execute(id, params));
      const tokenScan = params?.includeTokenScan
        ? readPayload(await tools.get("browser_token_scan").execute(id, params))
        : null;
      const summary = buildSignalSummary({
        diagnostics,
        cookieSummary: cookieResult.summary,
        serviceWorkerSummary,
        tokenScan,
      });
      return toolResult({
        profile: diagnostics.profile,
        tabId: diagnostics.tabId,
        page: diagnostics.page,
        capture: diagnostics.capture,
        includeTokenScan: Boolean(params?.includeTokenScan),
        ...summary,
      });
    },
  });

  tools.set("browser_hard_reload", {
    name: "browser_hard_reload",
    description: "Disable cache, optionally bypass service worker, clear profile-local traffic, and reload the tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        tabId: { type: "string", description: "CDP tab ID. Defaults to the profile's current tab." },
        clearLog: { type: "boolean", description: "Clear captured traffic before reload. Default: true." },
        bypassServiceWorker: { type: "boolean", description: "Bypass service worker on reload. Default: true." },
        waitMs: { type: "number", description: "Wait time in ms after reload for traffic capture. Default: 8000." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_hard_reload", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const waitMs = typeof params?.waitMs === "number" ? Math.min(Math.max(0, params.waitMs), 60_000) : 1000;
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        if (params?.startCapture !== false) {
          if (params?.clearLog !== false) profileRegistry.clearTraffic(profile.name);
          profileRegistry.setCapture(profile.name, {
            enabled: true,
            startedAt: new Date().toISOString(),
            stoppedAt: null,
            label: params?.label || "hard-reload",
          });
        }
        await client.Page.enable();
        await client.Network.enable();
        await client.Network.setCacheDisabled({ cacheDisabled: true });
        if (params?.bypassServiceWorker !== false) {
          await client.Network.setBypassServiceWorker({ bypass: true }).catch(() => {});
        }
        const capture = await captureNetworkForProfile(client, profile.name, async () => {
          await client.Page.reload({ ignoreCache: true });
        }, waitMs);
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        const eventFile = profileRegistry.appendEvent(profile.name, {
          type: "browser_hard_reload",
          tabId: target.id,
          cacheDisabled: true,
          bypassServiceWorker: params?.bypassServiceWorker !== false,
          capturedTraffic: capture.capturedTraffic,
          trafficFile: capture.trafficFile,
          capture: profileRegistry.getCapture(profile.name),
        });
        return {
          ok: true,
          profile: profile.name,
          tabId: target.id,
          cacheDisabled: true,
          bypassServiceWorker: params?.bypassServiceWorker !== false,
          capturedTraffic: capture.capturedTraffic,
          trafficFile: capture.trafficFile,
          eventFile,
          capture: profileRegistry.getCapture(profile.name),
        };
      }));
    },
  });
}
