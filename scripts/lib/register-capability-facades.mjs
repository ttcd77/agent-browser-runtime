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

  tools.set("browser_capabilities", {
    name: "browser_capabilities",
    description: "Product routing map for agents: show Basic, Pentest, and Personal Browser capability lanes, default backend, first tools, and boundaries.",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute() {
      return toolResult(browserProductCapabilities());
    },
  });

  tools.set("browser_ready", {
    name: "browser_ready",
    description: "Scenario readiness check. Use before Basic, Pentest, or Personal Browser work to get explicit blockers and next tools.",
    parameters: {
      type: "object",
      properties: {
        scenario: {
          type: "string",
          enum: ["basic", "pentest", "personal"],
          description: "Readiness scenario to check. Values: basic (page ops), pentest (F12/security), personal (user's Chrome). Default: basic.",
        },
        profile: { type: "string", description: "Profile name to check. Defaults to server default profile." },
        checkStuck: { type: "boolean", description: "Check for stuck/blank/CAPTCHA page signals. Default: true." },
      },
    },
    async execute(id, params = {}) {
      const parseTool = async (name, input = {}) => {
        const result = await tools.get(name).execute(id, input);
        return JSON.parse(result.content?.[0]?.text || "{}");
      };
      const normalize = (value) => {
        const key = String(value || "basic").trim().toLowerCase();
        if (["basic", "operate", "operation", "ops", "money"].includes(key)) return "basic";
        if (["pentest", "appsec", "f12", "security", "replay", "burp"].includes(key)) return "pentest";
        if (["personal", "personal-browser", "current-tab", "my-chrome"].includes(key)) return "personal";
        throw new Error("browser_ready scenario must be basic, pentest, or personal");
      };
      const scenario = normalize(params?.scenario);
      const capabilities = browserProductCapabilities();
      const lane = capabilities.scenarios.find((entry) => entry.scenario === scenario);
      const blocking = [];
      const suggestedNext = [];
      const addNext = (entries) => {
        for (const entry of entries || []) {
          if (entry && !suggestedNext.includes(entry)) suggestedNext.push(entry);
        }
      };
      const checks = {
        backend: await parseTool("browser_backend_status", {}),
        profile: null,
        stuck: null,
        personalBridge: null,
      };

      if (scenario === "personal") {
        checks.personalBridge = {
          ok: checks.backend?.personal?.ok === true,
          state: checks.backend?.personal?.ok === true ? "connected" : "personal-bridge-needed",
          expectedTransport: "Chrome extension bridge using chrome.debugger",
          personal: checks.backend?.personal || null,
        };
        if (!checks.personalBridge.ok) blocking.push("personal-bridge-needed");
        addNext(checks.personalBridge.ok
          ? ["browser_tabs", "browser_snapshot with backend=personal/currentTab=true", "browser_inspect with backend=personal"]
          : ["Start Personal Chrome bridge: npm run personal:chrome", "Reload/enable the extension, then retry browser_ready scenario=personal"]);
      } else {
        const profileName = params?.profile || defaultProfileName;
        const profiles = await profileRegistry.listProfiles();
        const found = profiles.some((entry) => entry.name === profileName);
        checks.profile = {
          ok: found,
          profile: profileName,
          knownProfiles: profiles.map((entry) => entry.name),
        };
        if (!found) blocking.push("profile-missing");
        if (params?.checkStuck !== false && found) {
          checks.stuck = await parseTool("browser_stuck", { profile: profileName });
          const signals = Array.isArray(checks.stuck?.signals) ? checks.stuck.signals : [];
          if (checks.stuck?.pageAccessError) blocking.push("page-access-error");
          for (const signal of signals) {
            if (["no-page", "blank-page", "loading-document", "loading-text", "submit-disabled", "captcha", "mfa", "login", "error"].includes(signal)) {
              blocking.push(`page-${signal}`);
            }
          }
          addNext(checks.stuck?.suggestedNext);
        }
        addNext(scenario === "pentest"
          ? ["browser_capture action=start", "browser_inspect mode=network", "browser_security_pack", "browser_raw profile_request_payload for drilldown"]
          : ["browser_open", "browser_snapshot", "browser_click", "browser_type", "browser_press", "browser_select", "browser_wait", "browser_upload"]);
      }

      return toolResult({
        schema: "agent-browser.ready.v1",
        ok: blocking.length === 0,
        scenario,
        defaultBackend: lane?.defaultBackend || (scenario === "personal" ? "personal" : "managed"),
        checks,
        readySummary: {
          state: blocking.length === 0 ? "ready" : "not-ready",
          blocking,
          nextTools: suggestedNext,
          evidence: {
            checkedBackend: true,
            checkedProfile: Boolean(checks.profile),
            checkedStuck: Boolean(checks.stuck),
            checkedPersonalBridge: Boolean(checks.personalBridge),
          },
          boundary: "browser_ready checks current runtime readiness. It does not perform the task, authenticate accounts, collect evidence, or judge vulnerabilities.",
        },
        capabilityLane: lane,
        boundary: "Use browser_capabilities for product routes and browser_ready for current environment readiness.",
      });
    },
  });

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
      // In personal-only mode (slim-abr) the managed backend is intentionally
      // removed. Skip the recovery probe (it would surface a stub stack trace
      // into the diagnostic response) and report "removed" cleanly.
      const personalOnly = process.env.CDP_LAUNCH_BROWSER === "0";
      const recovery = personalOnly
        ? { browserVersion: null, recoveryAttempted: false, recovered: false, error: null }
        : await recoverManagedCdp("backend-status");
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
          backend: personalOnly ? "managed-removed-slim-abr" : "managed-cdp",
          runtimeIdentity: Array.isArray(managedTabs) ? managedRuntimeIdentity(recovery.browserVersion) : { ...browserRuntimeIdentity, reachable: false },
          cdpPort,
          cdpReachable: Array.isArray(managedTabs),
          cdpHealth: {
            reachable: Array.isArray(managedTabs),
            failureMode: personalOnly ? "managed-removed-in-slim-abr" : (Array.isArray(managedTabs) ? null : "managed-cdp-unreachable"),
            recoveryAttempted: recovery.recoveryAttempted,
            recovered: recovery.recovered,
            recoveryError: recovery.error,
          },
          blocker: personalOnly ? "use-personal-bridge-or-spawn-profile" : (Array.isArray(managedTabs) ? null : "managed-cdp-unreachable"),
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
