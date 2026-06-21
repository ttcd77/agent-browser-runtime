// register-capability-facades.mjs — Capability / readiness / backend-status facade family.
// Extracted verbatim from agent-cdp-server.mjs registerStandaloneBrowserTools (behavior-preserving).
// Dependencies are injected via deps; pure/lib helpers are imported directly.
// Contiguous block: browser_capabilities, browser_ready, browser_backend_status.
import { toolResult } from "./result-format.mjs";
import { browserProductCapabilities } from "./capability-catalog.mjs";

export function registerCapabilityFacadeTools(deps) {
  const {
    tools,
    cdpPort,
    profileRegistry,
    defaultProfileName,
    options,
    recoverManagedCdp,
    managedRuntimeIdentity,
    managedBrowserProcessSummary,
    managedCdpPortMode,
    browserRuntimeIdentity,
    personalBridgeUrl,
    personalBridgeHealth,
    callJson,
    cdpJson,
    summarizeProfilePortConfig,
  } = deps;



  tools.set("browser_backend_status", {
    name: "browser_backend_status",
    description: "Product router status: show whether the unified browser facade can use Managed CDP and/or the user's Personal Chrome bridge.",
    parameters: {
      type: "object",
      properties: {
        includePersonalSnapshot: { type: "boolean", description: "Also capture a personal Chrome active tab snapshot. Default: false." },
      },
    },
    async execute(id, params) {
      const managedProfiles = await profileRegistry.listProfiles();
      const recovery = await recoverManagedCdp("backend-status");
      const managedTabs = recovery.browserVersion ? await cdpJson(cdpPort, "/json").catch(() => null) : null;
      const profilePortSummary = summarizeProfilePortConfig(process.env.CDP_BROWSER_PROFILE_CONFIG || "", cdpPort, { cdpPortMode: managedCdpPortMode });
      const personal = await personalBridgeHealth();
      let personalSnapshot = null;
      if (personal.ok && params?.includePersonalSnapshot) {
        const snapshot = await callJson(
          `${personalBridgeUrl}/tool/personal_chrome_active_tab_snapshot`,
          { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
          10000,
        );
        personalSnapshot = snapshot.ok ? snapshot.body : { ok: false, status: snapshot.status, error: snapshot.body };
      }
      return toolResult({
        ok: true,
        router: "unified-browser-runtime",
        managed: {
          ok: Array.isArray(managedTabs),
          backend: "managed-cdp",
          runtimeIdentity: Array.isArray(managedTabs) ? managedRuntimeIdentity(recovery.browserVersion) : { ...browserRuntimeIdentity, reachable: false },
          cdpPort,
          cdpReachable: Array.isArray(managedTabs),
          cdpHealth: {
            reachable: Array.isArray(managedTabs),
            failureMode: Array.isArray(managedTabs) ? null : "managed-cdp-unreachable",
            recoveryAttempted: recovery.recoveryAttempted,
            recovered: recovery.recovered,
            recoveryError: recovery.error,
          },
          blocker: Array.isArray(managedTabs) ? null : "managed-cdp-unreachable",
          browserProcess: managedBrowserProcessSummary(),
          defaultProfile: defaultProfileName,
          profiles: managedProfiles.map((entry) => entry.name),
          profilePortSummary,
          profilePortReconciliation: options.profilePortReconciliation || null,
          liveTabs: Array.isArray(managedTabs) ? managedTabs.filter((tab) => tab.type === "page").length : 0,
          useWhen: ["isolated profiles", "clean F12 evidence packs", "repeatable target roles", "CDP-only panels"],
        },
        personal: {
          ...personal,
          backend: "personal-chrome",
          useWhen: ["the user says my Chrome/current tab", "the account is already logged in", "managed browser login is blocked", "mid-session takeover of the real browser"],
        },
        unifiedFacade: {
          defaultBackend: "managed-cdp",
          routePersonalWith: [
            { tool: "browser_inspect", input: { backend: "personal", mode: "overview" } },
            { tool: "browser_open", input: { currentTab: true } },
            { tool: "browser_capture", input: { backend: "personal", action: "start" } },
          ],
          routeManagedWith: [
            { tool: "browser_open", input: { backend: "managed", profile: "target-clean", url: "https://example.com" } },
          ],
        },
        personalSnapshot,
        warnings: profilePortSummary.ok ? [] : ["profile-port-drift"],
        suggestedNext: profilePortSummary.next || [],
      });
    },
  });

}
