#!/usr/bin/env node
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync, accessSync, constants as fsConstants } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import {
  bindProfileBackendOnOpen,
  injectBackendIntoPayload,
  annotateProfilesWithBackend,
} from "./lib/profile-backend-binding.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_URL = process.env.AGENT_BROWSER_RUNTIME_URL || "http://127.0.0.1:17335";
const RUNTIME_DATA_DIR =
  process.env.CDP_SECURITY_DATA_DIR || join(homedir(), ".agent-browser-runtime");

const PANEL_TO_TOOL = {
  network: "profile_traffic_summary",
  "network-summary": "profile_traffic_summary",
  "network-log": "profile_traffic_query",
  "network-timeline": "profile_network_timeline",
  console: "browser_console_log",
  storage: "browser_storage_snapshot",
  // "sources" intentionally NOT here: the sources handler at line ~7073 handles
  // sub-commands (list / search). Adding sources here would shadow the search branch.
  artifacts: "browser_artifact_index",
  readiness: "browser_professional_readiness",
};

function usage() {
  return `agent-browser

Usage:
  agent-browser doctor|health [--server http://127.0.0.1:17335]
  agent-browser guide [--mode basic|pentest|personal]
  agent-browser capabilities
  agent-browser agent-chrome plan|profiles|bootstrap|launch|studio|clients|status|ready|configure --profile <profile> [--url https://example.com] [--client-id <id>] [--user-data-dir <dir>] [--extension-dir <dir>] [--extension-installed] [--executable <path>]
  agent-browser ready [basic|pentest|personal] [--profile <profile>] [--target <target>] [--profiles a,b]
  agent-browser backend status [--intent clean-target|two-account|personal-current-tab|takeover-current-chrome|auth]
  agent-browser tools
  agent-browser profile list|create|resume|delete|doctor|preflight [name] [--profile <profile>] [--acquire-lease] [--check-stuck] [--check-auth] [--download-dir ./downloads]
  agent-browser profile isolation check --profiles attacker,victim [--url https://target.example]
  agent-browser profile ports status|repair [--to 9222] [--config path]
  agent-browser tabs
  agent-browser call browser_tab_close --json '{"profile":"<profile>"}' (managed) | --json '{"tabId":<id>}' (personal)
  agent-browser open <url> [--profile default] [--backend managed|personal]
  agent-browser see [snapshot|text|screenshot] [--profile default] [--include-image]
  agent-browser observe [--profile default] [--limit 60]
  agent-browser stuck [--profile default]
  agent-browser action preflight|diagnose click|type|fill|wait [--profile default] [--selector ".save" | --text "Save"] [--expect-url-contains dashboard] [--expect-request-url-contains api]
  agent-browser find <query> [--profile default]
  agent-browser click (--text "Save" | --selector "button.save" | --x 10 --y 20) [--wait-mode no-navigation] [--force-js] [--action-timeout-ms 3000]
  agent-browser hover (--text "Menu" | --selector ".menu" | --x 10 --y 20) [--profile default]
  agent-browser dblclick (--text "Row" | --selector ".row" | --x 10 --y 20) [--wait-mode no-navigation]
  agent-browser drag (--selector ".card" | --text "Card" | --x 10 --y 20) (--to-selector ".drop" | --to-text "Done" | --to-x 100 --to-y 200 | --delta-x 40 --delta-y 0)
  agent-browser type <text> (--selector "input[name=email]" | --text "Email") [--press-enter] [--action-timeout-ms 3000]
  agent-browser fill <text> (--selector "input[name=email]" | --label "Email" | --field "Email" | --query "email field") [--press-enter] [--action-timeout-ms 3000]
  agent-browser press <key|combo> [--selector "input[name=q]"] [--profile default]
  agent-browser select --selector "select[name=country]" (--value US | --label "United States" | --index 1 | --checked true)
  agent-browser wait [--selector ".done" | --text "Published" | --url-contains dashboard | --request-url-contains graphql] [--request-method POST] [--request-status 200] [--state visible] [--timeout-ms 10000]
  agent-browser upload --selector "input[type=file]" --file ./image.png
  agent-browser download [--profile default] [--dir ~/Downloads] [--timeout-ms 30000]
  agent-browser download doctor|diagnose|start|status|stop [--profile default] [--dir ~/Downloads]
  agent-browser auth bootstrap [start|status|finish] --profile <profile> [--url <login-url>] [--success-url-contains <text>] [--success-selector ".dashboard"] [--success-cookie-names sid,auth]
  agent-browser auth diagnose --profile <profile> [--success-url-contains <text>] [--success-selector ".dashboard"] [--success-cookie-names sid,auth]
  agent-browser profile registry set --profile <profile> --project <project> --platform <platform> --account <account> [--target <target>] [--role attacker|victim|admin|member]
  agent-browser profile registry get --profile <profile>
  agent-browser profile registry list [--target <target>] [--role attacker]
  agent-browser profile registry delete --profile <profile>
  agent-browser profile registry matrix [--target <target>] [--require-roles attacker,victim]
  agent-browser profile registry validate [--profile <profile>] [--target <target>] [--require-roles attacker,victim] [--unique-roles]
  agent-browser profile registry diagnose [--profile <profile>] [--target <target>] [--require-roles attacker,victim] [--unique-roles] [--check-live]
  agent-browser profile two-account ready --target <target> [--require-roles attacker,victim] [--url https://target.example] [--owner <agent-name>] [--acquire-lease]
  agent-browser profile lease acquire|status|release|list --profile <profile> [--owner <agent-name>] [--ttl-seconds 1800] [--force]
  agent-browser form fill --fields-json '{"input[name=title]":"Hello"}'
  agent-browser workflow run --file ./workflow.json [--validate-only] [--preflight --owner <agent-name> --acquire-lease] [--evidence-on-failure]
  agent-browser workflow diagnose --file ./workflow.json
  agent-browser scroll [--direction down|up|left|right] [--amount 800]
  agent-browser eval <expression>
  agent-browser capture start|stop|status|clear|reload [--label run]
  agent-browser inspect [overview|network|storage|console|dom|sources|performance|search|evidence|debug|security]
  agent-browser security summary [--profile default]
  agent-browser evidence bundle [--profile default] [--include-har] [--include-screenshot false] [--save false]
  agent-browser evidence manifest [--profile default] [--max-files 200]
  agent-browser evidence timeline [--profile default] [--max-events 80]
  agent-browser pack [url] [--no-trace] [--no-har] [--no-application]
  agent-browser requests [--profile default] [--url-contains api] [--method POST] [--has-request-body true] [--limit 20|--all]
  agent-browser requests diagnose [--profile default] [--url-contains api] [--method POST] [--has-request-body true]
  agent-browser request detail|payload|body|diagnose <requestId> [--profile default]
  agent-browser graphql requests|payload|replay|intercept-plan [requestId] [--profile default] [--limit 50|--all] [--inspect-limit 5|--inspect-all] [--variables-json '{}']
  agent-browser api map [--profile default] [--limit 100|--all]
  agent-browser network [summary|log|timeline]
  agent-browser replay <requestId> [--profile default] [--url ...] [--method POST] [--headers-json '{}'] [--body "..."]
  agent-browser replay-batch <requestId> --variants-json '[{"label":"baseline"}]'
  agent-browser repeater plan <requestId> [--profile default]
  agent-browser repeater open <requestId> [--profile default]
  agent-browser repeater edit <sessionId> [--method POST] [--url ...] [--headers-json '{}'] [--body "..."] [--json-body '{}']
  agent-browser repeater send <sessionId>
  agent-browser repeater history <sessionId>
  agent-browser repeater diff <sessionId> [--left <sendId>] [--right <sendId>]
  agent-browser repeater diagnose <sessionId>
  agent-browser repeater evidence <sessionId> [--out ./evidence.json]
  agent-browser repeater handoff <sessionId> [--bookmark] [--export-dir ./handoff] [--out ./repeater-handoff.json]
  agent-browser repeater list [--profile default] [--include-closed]
  agent-browser repeater close <sessionId>
  agent-browser bookmark <requestId> --profile default --tag interesting [--note "..."]
  agent-browser bookmarks list [--profile default] [--tag interesting]
  agent-browser bookmarks delete <bookmarkId>
  agent-browser export <requestId> --profile default --format curl|raw|json [--out ./request.txt]
  agent-browser import --file ./request.json --format json [--profile default] [--request-id req-1]
  agent-browser compare <baselineRequestId> <variantRequestId> [--profile default]
  agent-browser compare --left ./baseline.json --right ./variant.json
  agent-browser intercept start|list|diagnose|continue|fail|evidence|handoff [capturedRequestId] [--profile default] [--url-pattern api] [--url-contains api] [--json-body '{}'] [--out ./intercept-evidence.json] [--open-repeater]
  agent-browser console
  agent-browser storage
  agent-browser call browser_cookies_get --json '{"profile":"<profile>"}' (read cookies for profile)
  agent-browser call browser_cookies_set --json '{"profile":"<profile>","cookies":[...]}' (write cookies)
  agent-browser sources [list|search <query>]
  agent-browser artifact index|inspect|read|search [path|query]  (full sub-actions: index/inspect/read/search)
  agent-browser artifacts  (alias: index only — use 'artifact index' for full feature set; B5)
  agent-browser readiness
  agent-browser workflow [professional-appsec]
  agent-browser token-scan [--profile default] [--limit 500]
  agent-browser global-search <query> [--profile default] [--case-sensitive] [--max-matches 80]
  agent-browser intruder create --profile <profile> --request-id <reqId> --spec-json '{"attackMode":"sniper","payloadPositions":[...]}' [--job-id <id>]
  agent-browser intruder run --profile <profile> [--job-id <id>] [--max-variants 200] [--batch-size 50] [--delay-ms 0]
  agent-browser intruder pause --profile <profile> [--job-id <id>]
  agent-browser intruder resume --profile <profile> [--job-id <id>] [--max-variants 200] [--batch-size 50] [--delay-ms 0]
  agent-browser intruder status --profile <profile> [--job-id <id>]
  agent-browser intruder results --profile <profile> [--job-id <id>] [--limit 50]
  agent-browser intruder evidence --profile <profile> [--job-id <id>]
  agent-browser authed-record --profile <profile> [--url <seed-url>] [--max-clicks 30] [--max-depth 3] [--wait-ms 4000] [--same-origin-only] [--include-auth-detail] [--output -|<file>]
  agent-browser feedback <summary> [--type bug|gap|docs|product|idea] [--title "..."] [--details "..."]
  agent-browser raw <browser_*|profile_*|attack_* tool> [--json '{"profile":"default"}']
  agent-browser call <tool> [--json '{"profile":"default"}']
  agent-browser call profile_warm_from_personal --json '{"profile":"<target>-reg"}' (warm managed profile with Google cookies from personal Chrome — bot-detection bypass before registration flows)

Tool model:
  Use named commands for common browser/F12 actions. Use raw only when the
  named command does not cover the exact DevTools evidence you need.
  Use call for worker-level tools not exposed as named commands: profile_warm_from_personal,
  browser_tab_close, browser_cookies_get, browser_cookies_set, browser_token_scan, profile_jwt_forge,
  profile_raw_request, profile_race_request, profile_oob_alloc, profile_oob_poll, attack_intruder_*.
`;
}

function normalizeKey(key) {
  return key.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const entry = argv[i];
    if (!entry.startsWith("--")) {
      args.push(entry);
      continue;
    }
    if (entry.startsWith("--no-")) {
      flags[normalizeKey(entry.slice(5))] = false;
      continue;
    }
    const key = normalizeKey(entry.slice(2));
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return { args, flags };
}

function numberFlag(flags, name) {
  if (flags[name] === undefined) return undefined;
  const value = Number(flags[name]);
  if (!Number.isFinite(value)) throw new Error(`--${name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} must be a number`);
  return value;
}

function coerceFlagValue(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function payloadFromFlags(flags, omit = []) {
  const payload = {};
  if (flags.json) Object.assign(payload, JSON.parse(String(flags.json)));
  const omitted = new Set(["server", "json", ...omit]);
  for (const [key, value] of Object.entries(flags)) {
    if (omitted.has(key)) continue;
    payload[key] = coerceFlagValue(value);
  }
  return payload;
}

function withDefaults(flags, extra = {}, omit = []) {
  return { ...payloadFromFlags(flags, omit), ...extra };
}

function stripOuterQuotes(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return value;
}

function normalizeLocatorPayload(payload) {
  const next = { ...(payload || {}) };
  for (const key of ["selector", "text", "query"]) {
    if (typeof next[key] === "string") next[key] = stripOuterQuotes(next[key]);
  }
  return next;
}

function selectorFromFindResult(result) {
  const collections = [
    result?.candidates,
    result?.results,
    result?.matches,
    result?.elements,
  ].filter(Array.isArray);
  for (const collection of collections) {
    for (const entry of collection) {
      const selector = entry?.selector || entry?.cssSelector || entry?.locator?.selector || entry?.target?.selector;
      if (selector) return String(selector);
    }
  }
  return result?.selector ? String(result.selector) : null;
}

async function resolveFillPayload(server, flags, text) {
  const payload = normalizeLocatorPayload(withDefaults(flags, { text }, ["value"]));
  const locatorQuery = flags.field || flags.label || flags.placeholder || flags.query;
  if (!payload.selector && locatorQuery) {
    const findPayload = {
      profile: flags.profile,
      query: stripOuterQuotes(String(locatorQuery)),
    };
    const found = await callTool(server, "browser_find", findPayload);
    const selector = selectorFromFindResult(found);
    if (!selector) {
      throw new Error(`fill could not resolve field label/query: ${locatorQuery}`);
    }
    payload.selector = selector;
    payload.resolvedLocator = {
      source: "browser_find",
      query: findPayload.query,
      selector,
    };
  }
  for (const key of ["field", "label", "placeholder", "query"]) delete payload[key];
  return payload;
}

function cliScreenshotPayload(flags) {
  const payload = payloadFromFlags(flags);
  if (payload.includeImage === undefined) payload.includeImage = false;
  return payload;
}

async function cliScreenshot(server, flags) {
  const payload = cliScreenshotPayload(flags);
  const result = await callTool(server, "browser_screenshot", payload);
  if (payload.includeImage === false && result && typeof result === "object") {
    return {
      ...result,
      cliImagePolicy: {
        inlineImageDefault: false,
        reason: "CLI returns screenshot file metadata by default to avoid large base64 JSON output truncation.",
        inlineOptIn: "Pass --include-image only when the caller supports image content or large outputs.",
      },
    };
  }
  return result;
}

function normalizeServerUrl(value) {
  return String(value || "").replace(/\/$/, "");
}

function localIpv4Addresses() {
  const out = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (!entry.address) continue;
      out.push(entry.address);
    }
  }
  return out;
}

function serverCandidates(flags) {
  if (flags.server) return [normalizeServerUrl(flags.server)];
  const candidates = [
    process.env.AGENT_BROWSER_RUNTIME_URL,
    DEFAULT_URL,
    "http://127.0.0.1:17335",
    "http://localhost:17335",
    ...localIpv4Addresses().map((address) => `http://${address}:17335`),
  ].filter(Boolean).map(normalizeServerUrl);
  return [...new Set(candidates)];
}

async function serverHealthProbe(baseUrl, timeoutMs = 500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    if (!response.ok) return false;
    const text = await response.text();
    if (!text) return true;
    const data = JSON.parse(text);
    return data?.ok !== false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function serverBase(flags) {
  const candidates = serverCandidates(flags);
  if (flags.server) return candidates[0];
  for (const candidate of candidates) {
    if (await serverHealthProbe(candidate)) return candidate;
  }
  return candidates[0] || normalizeServerUrl(DEFAULT_URL);
}

function agentChromeExecutable() {
  if (process.env.AGENT_BROWSER_CHROME_EXECUTABLE) return process.env.AGENT_BROWSER_CHROME_EXECUTABLE;
  if (process.env.CHROME_EXECUTABLE) return process.env.CHROME_EXECUTABLE;
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function agentChromeUserDataRoot() {
  if (process.env.AGENT_BROWSER_CHROME_USER_DATA_DIR) return process.env.AGENT_BROWSER_CHROME_USER_DATA_DIR;
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data");
  if (process.platform === "darwin") return join(process.env.HOME || "", "Library", "Application Support", "Google", "Chrome");
  return join(process.env.HOME || "", ".config", "google-chrome");
}

function agentChromeNamedProfiles() {
  const userDataRoot = agentChromeUserDataRoot();
  const localStatePath = join(userDataRoot, "Local State");
  try {
    const localState = JSON.parse(readFileSync(localStatePath, "utf8"));
    const infoCache = localState?.profile?.info_cache || {};
    return Object.entries(infoCache).map(([directory, info]) => ({
      directory,
      name: String(info?.name || directory),
      userName: String(info?.user_name || ""),
      isUsingDefaultName: Boolean(info?.is_using_default_name),
      userDataRoot,
      localStatePath,
    }));
  } catch {
    return [];
  }
}

function resolveAgentChromeNamedProfile(flags = {}) {
  const profiles = agentChromeNamedProfiles();
  const requestedDirectory = flags.chromeProfileDirectory || flags.profileDirectory || flags.chromeProfileDir;
  const requestedName = flags.chromeProfileName || flags.chromeProfile || flags.workspaceProfile || flags.studioProfile;
  if (requestedDirectory) {
    const found = profiles.find((entry) => entry.directory.toLowerCase() === String(requestedDirectory).toLowerCase());
    return found || {
      directory: String(requestedDirectory),
      name: String(requestedDirectory),
      userName: "",
      userDataRoot: agentChromeUserDataRoot(),
      localStatePath: join(agentChromeUserDataRoot(), "Local State"),
    };
  }
  if (requestedName) {
    const needle = String(requestedName).toLowerCase();
    const found = profiles.find((entry) =>
      entry.name.toLowerCase() === needle ||
      entry.userName.toLowerCase() === needle ||
      entry.name.toLowerCase().includes(needle) ||
      entry.userName.toLowerCase().includes(needle));
    if (found) return found;
  }
  return profiles.find((entry) => entry.name.toLowerCase().includes("studio") || entry.userName.toLowerCase().includes("studio"))
    || profiles.find((entry) => entry.directory !== "Default")
    || profiles[0]
    || null;
}

function safeAgentChromeProfileDir(profile) {
  const raw = String(profile || "agent-default").trim() || "agent-default";
  return raw.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").replace(/\s+/g, "-").slice(0, 120) || "agent-default";
}

function agentChromeStateFile() {
  return join(RUNTIME_DATA_DIR, "agent-chrome-profiles.json");
}

function readAgentChromeState() {
  try {
    const parsed = JSON.parse(readFileSync(agentChromeStateFile(), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // missing or corrupt state should not stop plan/launch
  }
  return { profiles: {} };
}

function writeAgentChromeState(state) {
  const file = agentChromeStateFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ profiles: {}, ...state }, null, 2)}\n`, "utf8");
}

function agentChromeMarkerUrl(profile) {
  const params = new URLSearchParams({
    profile: String(profile || "agent-default"),
    lane: "agent-chrome-profile",
  });
  return `http://127.0.0.1:17337/agent-chrome-marker?${params.toString()}`;
}

function agentChromeBootstrapUrl(profile, extensionDir, returnUrl) {
  const params = new URLSearchParams({
    profile: String(profile || "agent-default"),
    extensionDir: String(extensionDir || ""),
  });
  if (returnUrl) params.set("returnUrl", String(returnUrl));
  return `http://127.0.0.1:17337/agent-chrome-bootstrap?${params.toString()}`;
}

function classifyAgentChromeExecutable(executable) {
  const value = String(executable || "").toLowerCase();
  if (!value) return "missing";
  const normalized = value.replace(/\\/g, "/");
  if (normalized.includes("/google/chrome/application/chrome.exe")) return "branded-google-chrome";
  if (normalized.includes("google chrome.app/contents/macos/google chrome")) return "branded-google-chrome";
  if (normalized.endsWith("/google-chrome") || normalized.endsWith("/google-chrome-stable")) return "branded-google-chrome";
  if (normalized.includes("ms-playwright") || normalized.includes("chrome-for-testing") || normalized.includes("chromium")) {
    return "chromium-or-chrome-for-testing";
  }
  return "unknown-chromium-family";
}

function agentChromeExtensionInstallPlan(executable, flags = {}) {
  const executableKind = classifyAgentChromeExecutable(executable);
  const manualInstalled = flags.extensionInstalled === true || flags.manualExtensionInstalled === true;
  const forceCommandLine = flags.forceLoadExtension === true;
  const commandLineLoadExtensionSupported = forceCommandLine || executableKind !== "branded-google-chrome";
  return {
    executableKind,
    mode: commandLineLoadExtensionSupported ? "command-line-load-extension" : "manual-unpacked-required",
    commandLineLoadExtensionSupported,
    manualInstalled,
    readyToConnect: commandLineLoadExtensionSupported || manualInstalled,
    reason: commandLineLoadExtensionSupported
      ? "This browser family can load the ABR extension at launch."
      : "Official Google Chrome 137+ no longer loads extensions with --load-extension. Use --extension-installed after loading the unpacked ABR extension once in this dedicated profile, or use Chrome for Testing/Chromium for automatic launch.",
  };
}

function agentChromeProfilePlan(args = [], flags = {}) {
  const profile = String(flags.profile || flags.name || "agent-default");
  const url = String(flags.url || args[2] || "");
  const executable = String(flags.executable || agentChromeExecutable() || "");
  const extensionDir = String(flags.extensionDir || join(__dirname, "..", "extension"));
  const extensionInstall = agentChromeExtensionInstallPlan(executable, flags);
  const userDataDir = String(
    flags.userDataDir ||
    join(RUNTIME_DATA_DIR, "agent-chrome-profiles", safeAgentChromeProfileDir(profile)),
  );
  const launchArgs = [
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
  ];
  if (extensionInstall.commandLineLoadExtensionSupported) launchArgs.splice(1, 0, `--load-extension=${extensionDir}`);
  const markerUrl = agentChromeMarkerUrl(profile);
  launchArgs.push(markerUrl);
  if (url) launchArgs.push(url);
  const baseOk = Boolean(executable && existsSync(executable) && existsSync(extensionDir));
  return {
    schema: "agent-browser.agent-chrome-profile.plan.v1",
    ok: baseOk,
    lane: "agent-chrome-profile",
    maturity: "profile-routable",
    readiness: extensionInstall.readyToConnect
      ? "launches a dedicated Chrome profile with the ABR extension bridge marker; use clients/status to bind the exact bridge client"
      : "launches a dedicated branded Chrome profile, but the ABR extension must be installed once in that profile before bridge commands can work",
    profile,
    url,
    markerUrl,
    bootstrapUrl: agentChromeBootstrapUrl(profile, extensionDir, url || "https://example.com/login"),
    executablePath: executable || null,
    executableKind: extensionInstall.executableKind,
    executableExists: Boolean(executable && existsSync(executable)),
    userDataDir,
    extensionDir,
    extensionExists: existsSync(extensionDir),
    extensionInstall,
    remoteDebuggingPort: null,
    controlTransport: "chrome-extension-debugger-bridge",
    bridge: {
      httpUrl: "http://127.0.0.1:17337",
      wsUrl: "ws://127.0.0.1:17336/extension",
      startCommand: "npm run personal:chrome",
    },
    launchArgs,
    boundary: "Agent Chrome Profile uses a dedicated browser profile plus the ABR extension bridge. It intentionally does not launch Chrome with --remote-debugging-port. The marker tab lets agents identify the dedicated profile client instead of guessing among personal Chrome windows.",
    nextCommands: extensionInstall.readyToConnect
      ? [
          "npm run personal:chrome",
          `agent-browser agent-chrome launch --profile ${profile} --url https://example.com`,
          "agent-browser agent-chrome clients",
          `agent-browser agent-chrome status --profile ${profile}`,
        ]
      : [
          "npm run personal:chrome",
          `agent-browser agent-chrome bootstrap --profile ${profile} --url ${url || "https://example.com/login"}`,
          `agent-browser agent-chrome launch --profile ${profile} --extension-installed --url https://example.com`,
          `agent-browser agent-chrome status --profile ${profile}`,
        ],
  };
}

function agentChromeProfileLaunch(args = [], flags = {}) {
  const plan = agentChromeProfilePlan(args, flags);
  if (!plan.executableExists) throw new Error("Google Chrome executable not found. Set AGENT_BROWSER_CHROME_EXECUTABLE.");
  if (!plan.extensionExists) throw new Error(`Agent Browser extension directory not found: ${plan.extensionDir}`);
  if (!plan.url) throw new Error("agent-chrome launch requires --url; refusing to launch an implicit blank page.");
  mkdirSync(plan.userDataDir, { recursive: true });
  const child = spawn(plan.executablePath, plan.launchArgs, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const state = readAgentChromeState();
  state.profiles ||= {};
  state.profiles[plan.profile] = {
    profile: plan.profile,
    lane: "agent-chrome-profile",
    userDataDir: plan.userDataDir,
    markerUrl: plan.markerUrl,
    requestedUrl: plan.url,
    executablePath: plan.executablePath,
    executableKind: plan.executableKind,
    extensionInstall: plan.extensionInstall,
    pid: child.pid || null,
    launchedAt: new Date().toISOString(),
    clientId: null,
  };
  writeAgentChromeState(state);
  return {
    ...plan,
    schema: "agent-browser.agent-chrome-profile.launch.v1",
    ok: true,
    launched: true,
    readiness: plan.extensionInstall.readyToConnect
      ? "launched with marker tab; run agent-chrome status to bind the exact extension bridge client before issuing browser commands"
      : "launched a dedicated branded Chrome profile for extension bootstrap; install the ABR extension in this profile, then relaunch with --extension-installed",
    pid: child.pid || null,
    nextCommands: plan.extensionInstall.readyToConnect
      ? [
          "npm run personal:chrome",
          `agent-browser agent-chrome status --profile ${plan.profile}`,
          `agent-browser agent-chrome configure --profile ${plan.profile} --client-id <clientId>`,
        ]
      : [
          "Open chrome://extensions in the launched profile.",
          "Enable Developer mode, Load unpacked, and select the ABR extension directory.",
          `agent-browser agent-chrome launch --profile ${plan.profile} --extension-installed --url ${plan.url}`,
          `agent-browser agent-chrome status --profile ${plan.profile}`,
        ],
  };
}

function agentChromeStudioProfileOpen(args = [], flags = {}) {
  const profile = String(flags.profile || flags.name || "studio");
  const url = String(flags.url || args[2] || "https://example.com/login");
  const executable = String(flags.executable || agentChromeExecutable() || "");
  const namedProfile = resolveAgentChromeNamedProfile(flags);
  if (!executable || !existsSync(executable)) throw new Error("Google Chrome executable not found. Set AGENT_BROWSER_CHROME_EXECUTABLE.");
  if (!namedProfile?.directory) throw new Error("Chrome named profile not found. Pass --chrome-profile-directory \"Profile 1\" or --chrome-profile-name <name>.");
  const markerUrl = agentChromeMarkerUrl(profile);
  const launchArgs = [
    `--profile-directory=${namedProfile.directory}`,
    "--new-window",
    markerUrl,
    url,
  ];
  const child = spawn(executable, launchArgs, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const state = readAgentChromeState();
  state.profiles ||= {};
  state.profiles[profile] = {
    ...(state.profiles[profile] || {}),
    profile,
    lane: "chrome-named-profile",
    markerUrl,
    requestedUrl: url,
    executablePath: executable,
    executableKind: classifyAgentChromeExecutable(executable),
    chromeProfile: namedProfile,
    extensionInstall: {
      mode: "existing-profile-extension-required",
      readyToConnect: true,
      reason: "This lane opens an existing named Chrome profile. The ABR extension must already be installed in that Chrome profile.",
    },
    pid: child.pid || null,
    launchedAt: new Date().toISOString(),
  };
  writeAgentChromeState(state);
  return {
    schema: "agent-browser.agent-chrome-profile.studio.v1",
    ok: true,
    lane: "chrome-named-profile",
    profile,
    url,
    markerUrl,
    chromeProfile: namedProfile,
    executablePath: executable,
    remoteDebuggingPort: null,
    controlTransport: "chrome-extension-debugger-bridge",
    launchArgs,
    pid: child.pid || null,
    nextCommands: [
      `agent-browser agent-chrome status --profile ${profile}`,
      `agent-browser agent-chrome configure --profile ${profile} --client-id <clientId>`,
    ],
    boundary: "Studio profile opens an existing named Chrome profile through Chrome itself. It does not use --user-data-dir, --remote-debugging-port, Playwright, or Edge, so it will not take over the user's Default profile.",
  };
}

function agentChromeProfileBootstrap(args = [], flags = {}) {
  const returnUrl = String(flags.url || args[2] || "https://example.com/login");
  const plan = agentChromeProfilePlan(args, { ...flags, url: returnUrl });
  if (!plan.executableExists) throw new Error("Google Chrome executable not found. Set AGENT_BROWSER_CHROME_EXECUTABLE.");
  if (!plan.extensionExists) throw new Error(`Agent Browser extension directory not found: ${plan.extensionDir}`);
  mkdirSync(plan.userDataDir, { recursive: true });
  const bootstrapUrl = agentChromeBootstrapUrl(plan.profile, plan.extensionDir, returnUrl);
  const launchArgs = [
    `--user-data-dir=${plan.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    bootstrapUrl,
    "chrome://extensions",
    plan.markerUrl,
  ];
  const child = spawn(plan.executablePath, launchArgs, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const state = readAgentChromeState();
  state.profiles ||= {};
  state.profiles[plan.profile] = {
    ...(state.profiles[plan.profile] || {}),
    profile: plan.profile,
    lane: "agent-chrome-profile",
    userDataDir: plan.userDataDir,
    markerUrl: plan.markerUrl,
    bootstrapUrl,
    requestedUrl: returnUrl,
    executablePath: plan.executablePath,
    executableKind: plan.executableKind,
    extensionInstall: {
      ...plan.extensionInstall,
      mode: "manual-unpacked-required",
      bootstrapStartedAt: new Date().toISOString(),
    },
    pid: child.pid || null,
    launchedAt: new Date().toISOString(),
  };
  writeAgentChromeState(state);
  return {
    ...plan,
    schema: "agent-browser.agent-chrome-profile.bootstrap.v1",
    ok: true,
    launched: true,
    pid: child.pid || null,
    bootstrapUrl,
    returnUrl,
    launchArgs,
    actionRequired: {
      type: "install-unpacked-extension-once",
      profile: plan.profile,
      extensionDir: plan.extensionDir,
      reason: "Official Google Chrome does not command-line-load unpacked extensions. Install the ABR extension once in this dedicated profile, then status can bind the extension bridge client.",
    },
    nextCommands: [
      `agent-browser agent-chrome status --profile ${plan.profile}`,
      `agent-browser agent-chrome launch --profile ${plan.profile} --extension-installed --url ${returnUrl}`,
      `agent-browser agent-chrome status --profile ${plan.profile}`,
    ],
    boundary: "bootstrap only prepares the dedicated Chrome profile. It does not touch the user's Default Chrome profile and does not use a remote debugging port.",
  };
}

async function agentChromeBridgeHealth() {
  return await requestJson("http://127.0.0.1:17337/health");
}

async function agentChromeCallBridgeTool(tool, params = {}) {
  return await requestJson(`http://127.0.0.1:17337/tool/${encodeURIComponent(tool)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
}

async function agentChromeClientRows(options = {}) {
  const health = await agentChromeBridgeHealth();
  const clients = Array.isArray(health.clients) ? health.clients : [];
  const matchUrl = options.matchUrl ? String(options.matchUrl) : "";
  const rows = [];
  for (const client of clients) {
    let tabs = null;
    let error = null;
    try {
      tabs = await agentChromeCallBridgeTool("personal_chrome_tabs", { clientId: client.id });
    } catch (err) {
      error = String(err?.message || err);
    }
    const tabRows = Array.isArray(tabs?.tabs) ? tabs.tabs : [];
    const markerTabs = tabRows.filter((tab) => String(tab.url || "").includes("/agent-chrome-marker?"));
    const markerProfiles = markerTabs
      .map((tab) => {
        try {
          return new URL(tab.url).searchParams.get("profile");
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const matchingTabs = matchUrl
      ? tabRows.filter((tab) => String(tab.url || "") === matchUrl)
      : [];
    rows.push({
      ...client,
      tabCount: tabRows.length,
      activeTab: tabRows.find((tab) => tab.active) || null,
      ...(matchUrl ? {
        matchUrl,
        matchingTabs: matchingTabs.map((tab) => ({
          id: tab.id,
          windowId: tab.windowId,
          title: tab.title,
          url: tab.url,
          active: tab.active,
        })),
      } : {}),
      markerTabs: markerTabs.map((tab) => ({ id: tab.id, title: tab.title, url: tab.url })),
      markerProfiles: [...new Set(markerProfiles)],
      error,
    });
  }
  return {
    schema: "agent-browser.agent-chrome-profile.clients.v1",
    ok: true,
    bridge: {
      ok: health.ok === true,
      connected: health.connected,
      httpUrl: "http://127.0.0.1:17337",
      wsUrl: health.wsUrl || "ws://127.0.0.1:17336/extension",
    },
    clientCount: rows.length,
    clients: rows,
    boundary: "clients lists extension-bridge Chrome windows. A marker tab means that client belongs to an Agent Chrome Profile; no marker means operator/personal or unbound Chrome.",
  };
}

async function agentChromeProfileClients() {
  const result = await agentChromeClientRows();
  return {
    ...result,
    nextCommands: [
      "agent-browser agent-chrome status --profile <profile>",
      "agent-browser agent-chrome configure --profile <profile> --client-id <clientId>",
    ],
  };
}

function agentChromeProfilesCommand() {
  const profiles = agentChromeNamedProfiles();
  return {
    schema: "agent-browser.agent-chrome-profile.profiles.v1",
    ok: true,
    userDataRoot: agentChromeUserDataRoot(),
    profileCount: profiles.length,
    profiles,
    nextCommands: [
      "agent-browser agent-chrome studio --profile studio --chrome-profile-name <name> --url https://example.com/login",
      "agent-browser agent-chrome studio --profile studio --chrome-profile-directory <directory> --url https://example.com/login",
    ],
    boundary: "profiles reads Chrome's Local State only. It does not open tabs, copy cookies, or control Chrome.",
  };
}

function agentChromeUrlMatchSummary(client) {
  return {
    id: client.id,
    name: client.name,
    connectedAt: client.connectedAt,
    lastSeenAt: client.lastSeenAt,
    userAgent: client.userAgent,
    extensionVersion: client.extensionVersion,
    tabCount: client.tabCount,
    matchUrl: client.matchUrl,
    matchingTabs: client.matchingTabs || [],
    markerProfiles: client.markerProfiles || [],
    error: client.error || null,
  };
}

async function agentChromeProfileStatus(flags = {}) {
  const profile = String(flags.profile || flags.name || "agent-default");
  const state = readAgentChromeState();
  const record = state.profiles?.[profile] || {
    profile,
    lane: "agent-chrome-profile",
    markerUrl: agentChromeMarkerUrl(profile),
  };
  const requestedUrl = String(record.requestedUrl || "");
  const clients = await agentChromeClientRows({ matchUrl: requestedUrl });
  const markerMatches = clients.clients.filter((client) => client.markerProfiles.includes(profile));
  const configuredClient = record.clientId
    ? clients.clients.find((client) => client.id === record.clientId)
    : null;
  const requestedUrlMatches = requestedUrl
    ? clients.clients.filter((client) => (client.matchingTabs || []).length > 0)
    : [];
  const selected = configuredClient
    || (markerMatches.length === 1 ? markerMatches[0] : null)
    || (record.lane === "chrome-named-profile" && requestedUrlMatches.length === 1 ? requestedUrlMatches[0] : null);
  const stateName = selected
    ? configuredClient
      ? "ready"
      : markerMatches.length === 1
        ? "ready-marker"
        : "ready-url-match"
    : markerMatches.length > 1
      ? "ambiguous-marker"
      : requestedUrlMatches.length > 1
        ? "ambiguous-url-match"
      : record.clientId
        ? "configured-client-disconnected"
        : "not-bound";
  const isNamedProfile = record.lane === "chrome-named-profile" || Boolean(record.chromeProfile?.directory);
  const chromeProfileName = record.chromeProfile?.name || "studio";
  const notBoundNextCommands = isNamedProfile
    ? [
        `agent-browser agent-chrome studio --profile ${profile} --chrome-profile-name ${chromeProfileName} --url chrome://extensions`,
        "Install or enable the ABR unpacked extension in that named Chrome profile.",
        `agent-browser agent-chrome studio --profile ${profile} --chrome-profile-name ${chromeProfileName} --url ${record.requestedUrl || "https://example.com/login"}`,
        "agent-browser agent-chrome clients",
        `agent-browser agent-chrome status --profile ${profile}`,
      ]
    : [
        `agent-browser agent-chrome bootstrap --profile ${profile} --url ${record.requestedUrl || "https://example.com/login"}`,
        "agent-browser agent-chrome clients",
        `agent-browser agent-chrome configure --profile ${profile} --client-id <clientId>`,
      ];
  return {
    schema: "agent-browser.agent-chrome-profile.status.v1",
    ok: stateName.startsWith("ready"),
    state: stateName,
    profile,
    record,
    selectedClient: selected,
    markerMatches,
    requestedUrlMatches: requestedUrlMatches.map(agentChromeUrlMatchSummary),
    clientCount: clients.clientCount,
    bridge: clients.bridge,
    nextCommands: selected
      ? [
          `agent-browser agent-chrome configure --profile ${profile} --client-id ${selected.id}`,
          `agent-browser call personal_chrome_active_tab_snapshot --json '{"clientId":"${selected.id}"}'`,
        ]
      : notBoundNextCommands,
    boundary: "status resolves a profile to an extension bridge client. Browser actions must pass this clientId or use a later routed facade; otherwise commands can land in the wrong Chrome window.",
  };
}

function flattenEvidenceText(value, depth = 0) {
  if (value === null || value === undefined || depth > 4) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((entry) => flattenEvidenceText(entry, depth + 1)).join("\n");
  if (typeof value === "object") {
    return Object.entries(value)
      .filter(([key]) => !/^(dataUrl|image|screenshot|png|jpeg|bytes)$/i.test(key))
      .map(([key, entry]) => `${key}: ${flattenEvidenceText(entry, depth + 1)}`)
      .join("\n");
  }
  return "";
}

function parseJsonFlag(flags, name) {
  if (flags[name] === undefined) return null;
  return JSON.parse(String(flags[name]));
}

function classifyAgentChromeReadiness({ profile, status, snapshot, pageEval, target = "", successUrlContains = "", successTextContains = "" }) {
  const record = status?.record || {};
  if (!status?.ok) {
    const requestedUrl = record.requestedUrl || "https://example.com/login";
    const isNamedProfile = record.lane === "chrome-named-profile" || Boolean(record.chromeProfile?.directory);
    const chromeProfileName = record.chromeProfile?.name || "studio";
    return {
      ok: false,
      state: "not-bound",
      profile,
      reason: "No extension bridge client is bound to this profile.",
      acceptance: "missing-browser-control",
      evidence: {
        statusState: status?.state || "unknown",
        lane: record.lane || null,
        requestedUrl,
        chromeProfile: record.chromeProfile || null,
      },
      nextCommands: isNamedProfile
        ? [
            `agent-browser agent-chrome studio --profile ${profile} --chrome-profile-name ${chromeProfileName} --url chrome://extensions`,
            "Install or enable the ABR unpacked extension in that named Chrome profile.",
            `agent-browser agent-chrome studio --profile ${profile} --chrome-profile-name ${chromeProfileName} --url ${requestedUrl}`,
            `agent-browser agent-chrome status --profile ${profile}`,
            "agent-browser agent-chrome clients",
            `agent-browser agent-chrome configure --profile ${profile} --client-id <clientId>`,
          ]
        : (status?.nextCommands || [
            `agent-browser agent-chrome studio --profile ${profile} --chrome-profile-name studio --url ${requestedUrl}`,
            `agent-browser agent-chrome status --profile ${profile}`,
          ]),
    };
  }

  const selected = status.selectedClient || {};
  const activeTab = selected.activeTab || {};
  const evalValue = pageEval?.value || pageEval?.result?.value || pageEval?.result || pageEval || {};
  const url = String(evalValue.url || snapshot?.url || activeTab.url || "");
  const title = String(evalValue.title || snapshot?.title || activeTab.title || "");
  const text = [
    title,
    url,
    flattenEvidenceText(snapshot),
    flattenEvidenceText(evalValue),
  ].join("\n");
  const lowerTarget = String(target || "").toLowerCase();
  const botModal = /oh snap|failed to verify (the )?captcha|captcha challenge|actions look like (those of )?a bot|use another browser|can't be processed at the moment/i.test(text);
  const successUrlOk = successUrlContains ? url.includes(String(successUrlContains)) : false;
  const successTextOk = successTextContains ? text.includes(String(successTextContains)) : false;

  if (botModal) {
    const chromeProfileName = record.chromeProfile?.name || "studio";
    return {
      ok: false,
      state: "blocked-by-anti-bot-modal",
      profile,
      reason: "The routed Chrome profile is controllable, but the current page shows an anti-bot / CAPTCHA / WAF challenge modal.",
      acceptance: "login-blocked-by-anti-bot",
      evidence: {
        url,
        title,
        matchedSignals: ["Oh Snap / CAPTCHA challenge / bot modal"],
        statusState: status.state,
        clientId: selected.id || null,
      },
      nextCommands: [
        "Stop retrying this login path until the challenge cooldown/profile state changes.",
        `agent-browser agent-chrome studio --profile ${profile} --chrome-profile-name ${chromeProfileName} --url ${url || "<login-url>"}`,
        `agent-browser agent-chrome ready --profile ${profile}${target ? ` --target ${target}` : ""}`,
      ],
    };
  }

  if (successUrlOk || successTextOk) {
    return {
      ok: true,
      state: "accepted",
      profile,
      reason: "The routed Chrome profile is controllable and the provided success condition matched.",
      acceptance: "success-condition-matched",
      evidence: {
        url,
        title,
        successUrlContains: successUrlContains || null,
        successTextContains: successTextContains || null,
        statusState: status.state,
        clientId: selected.id || null,
      },
      nextCommands: [
        `agent-browser call personal_chrome_capture_start --json '{"clientId":"${selected.id}","label":"${profile}-high-auth"}'`,
        `agent-browser call personal_chrome_security_research_pack --json '{"clientId":"${selected.id}"}'`,
      ],
    };
  }

  return {
    ok: true,
    state: "routed-needs-auth-verification",
    profile,
    reason: "The routed Chrome profile is controllable, but no success condition matched yet.",
    acceptance: "unverified",
    evidence: {
      url,
      title,
      statusState: status.state,
      clientId: selected.id || null,
      target: target || null,
    },
    nextCommands: [
      `agent-browser agent-chrome ready --profile ${profile}${target ? ` --target ${target}` : ""} --success-url-contains <post-login-url-fragment>`,
      `agent-browser call personal_chrome_active_tab_snapshot --json '{"clientId":"${selected.id}"}'`,
    ],
  };
}

async function agentChromeProfileReady(flags = {}) {
  const profile = String(flags.profile || flags.name || "agent-default");
  const target = String(flags.target || "");
  const snapshotFromFlag = parseJsonFlag(flags, "snapshotJson");
  const evalFromFlag = parseJsonFlag(flags, "evalJson");
  const status = snapshotFromFlag
    ? {
        ok: true,
        state: "offline-evidence",
        selectedClient: { id: String(flags.clientId || "offline-client"), activeTab: snapshotFromFlag },
      }
    : await agentChromeProfileStatus(flags);

  let snapshot = snapshotFromFlag;
  let pageEval = evalFromFlag;
  const clientId = status?.selectedClient?.id || flags.clientId;
  if (!snapshot && status?.ok && clientId) {
    try {
      snapshot = await agentChromeCallBridgeTool("personal_chrome_active_tab_snapshot", { clientId });
    } catch (err) {
      snapshot = { error: String(err?.message || err) };
    }
  }
  if (!pageEval && status?.ok && clientId) {
    try {
      pageEval = await agentChromeCallBridgeTool("personal_chrome_eval", {
        clientId,
        expression: "(() => ({ url: location.href, title: document.title, text: document.body ? document.body.innerText.slice(0, 12000) : '' }))()",
      });
    } catch (err) {
      pageEval = { error: String(err?.message || err) };
    }
  }

  const readiness = classifyAgentChromeReadiness({
    profile,
    status,
    snapshot,
    pageEval,
    target,
    successUrlContains: flags.successUrlContains || "",
    successTextContains: flags.successTextContains || "",
  });

  return {
    schema: "agent-browser.agent-chrome-profile.ready.v1",
    ...readiness,
    lane: status?.record?.chromeProfile?.directory ? "chrome-named-profile" : (status?.record?.lane || "chrome-extension-bridge"),
    controlTransport: "chrome-extension-debugger-bridge",
    profileStatus: {
      ok: status?.ok === true,
      state: status?.state || null,
      profile,
      clientId: status?.selectedClient?.id || clientId || null,
    },
    boundary: "ready only reports objective browser/profile/page state. It does not claim bot bypass, infer password correctness, or solve CAPTCHA/MFA.",
  };
}

async function agentChromeProfileConfigure(flags = {}) {
  const profile = String(flags.profile || flags.name || "agent-default");
  const clientId = String(flags.clientId || flags.client || "").trim();
  if (!clientId) throw new Error("agent-chrome configure requires --client-id");
  const clients = await agentChromeClientRows();
  const client = clients.clients.find((entry) => entry.id === clientId);
  if (!client) throw new Error(`extension bridge client not connected: ${clientId}`);
  const state = readAgentChromeState();
  state.profiles ||= {};
  state.profiles[profile] = {
    ...(state.profiles[profile] || {}),
    profile,
    lane: state.profiles[profile]?.lane || "agent-chrome-profile",
    markerUrl: state.profiles[profile]?.markerUrl || agentChromeMarkerUrl(profile),
    clientId,
    configuredAt: new Date().toISOString(),
  };
  writeAgentChromeState(state);
  return {
    schema: "agent-browser.agent-chrome-profile.configure.v1",
    ok: true,
    profile,
    clientId,
    client,
    stateFile: agentChromeStateFile(),
    nextCommands: [
      `agent-browser agent-chrome status --profile ${profile}`,
      `agent-browser call personal_chrome_active_tab_snapshot --json '{"clientId":"${clientId}"}'`,
    ],
    boundary: "configure stores local routing metadata only. It does not copy cookies, passwords, or browser storage.",
  };
}

async function agentChromeProfileCommand(args = [], flags = {}) {
  const action = args[1] || "plan";
  if (action === "plan" || action === "doctor") return agentChromeProfilePlan(args, flags);
  if (action === "profiles" || action === "list-profiles") return agentChromeProfilesCommand();
  if (action === "bootstrap" || action === "setup") return agentChromeProfileBootstrap(args, flags);
  if (action === "launch" || action === "open") return agentChromeProfileLaunch(args, flags);
  if (action === "studio" || action === "workspace") return agentChromeStudioProfileOpen(args, flags);
  if (action === "clients") return await agentChromeProfileClients(flags);
  if (action === "status") return await agentChromeProfileStatus(flags);
  if (action === "ready" || action === "verify") return await agentChromeProfileReady(flags);
  if (action === "configure" || action === "bind") return await agentChromeProfileConfigure(flags);
  throw new Error("agent-chrome action must be plan, profiles, bootstrap, launch, studio, clients, status, ready, or configure");
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(`${response.status} ${response.statusText}: ${JSON.stringify(data)}`);
    error.status = response.status;
    error.statusText = response.statusText;
    error.data = data;
    throw error;
  }
  return data;
}

async function callTool(server, tool, payload) {
  return await requestJson(`${server}/tool/${encodeURIComponent(tool)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
}

async function callRaw(server, toolName, params) {
  // devtools_* prefix retired 2026-06-11 (J1-W6); raw now only accepts the
  // live namespaces. attack_* is the intruder family.
  if (!toolName?.startsWith("browser_") && !toolName?.startsWith("profile_") && !toolName?.startsWith("attack_")) {
    throw new Error("raw requires a browser_* / profile_* / attack_* tool name");
  }
  const input = params || {};
  const raw = await callTool(server, "browser_raw", {
    tool: toolName,
    input,
    // Compatibility for older local fixtures and bridge builds.
    toolName,
    params: input,
  });
  if (raw && typeof raw === "object" && raw.facade === "browser_raw" && Object.prototype.hasOwnProperty.call(raw, "result")) {
    return raw.result;
  }
  return raw;
}

function capturePayload(action, flags) {
  return withDefaults(flags, { action }, ["har", "trace", "application"]);
}

function packPayload(url, flags) {
  return withDefaults(flags, {
    ...(url ? { url } : {}),
    includeHar: flags.har !== false,
    includeTrace: flags.trace !== false,
    includeApplicationExport: flags.application !== false,
  }, ["har", "trace", "application"]);
}

function splitListFlag(value) {
  if (value === undefined || value === true) return [];
  if (Array.isArray(value)) return value;
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeFeedbackType(value) {
  const type = String(value || "bug").trim().toLowerCase();
  return {
    "tool-bug": "bug",
    "capability-gap": "gap",
    friction: "product",
  }[type] || type;
}

function replayPayload(requestId, flags) {
  const payload = withDefaults(flags, { requestId }, [
    "headersJson",
    "removeHeader",
    "bodyFile",
    "jsonBody",
    "formJson",
    "variantsJson",
  ]);
  if (flags.headersJson) payload.headers = JSON.parse(String(flags.headersJson));
  if (flags.removeHeader) payload.removeHeaders = splitListFlag(flags.removeHeader);
  if (flags.bodyFile) payload.body = readFileSync(String(flags.bodyFile), "utf8");
  if (flags.jsonBody) payload.json = JSON.parse(String(flags.jsonBody));
  if (flags.formJson) payload.form = JSON.parse(String(flags.formJson));
  return payload;
}

function replayBatchPayload(requestId, flags) {
  if (!flags.variantsJson) throw new Error("replay-batch requires --variants-json");
  const payload = withDefaults(flags, {
    requestId,
    variants: JSON.parse(String(flags.variantsJson)),
  }, ["variantsJson"]);
  return payload;
}

function applyReplayEdit(target, flags) {
  if (flags.method !== undefined) target.method = String(flags.method).toUpperCase();
  if (flags.url !== undefined) target.url = String(flags.url);
  if (flags.headersJson !== undefined) target.headers = JSON.parse(String(flags.headersJson));
  if (flags.removeHeader !== undefined) target.removeHeaders = splitListFlag(flags.removeHeader);
  if (flags.body !== undefined) target.body = String(flags.body);
  if (flags.bodyFile !== undefined) target.body = readFileSync(String(flags.bodyFile), "utf8");
  if (flags.jsonBody !== undefined) {
    target.json = JSON.parse(String(flags.jsonBody));
    delete target.body;
    delete target.form;
  }
  if (flags.formJson !== undefined) {
    target.form = JSON.parse(String(flags.formJson));
    delete target.body;
    delete target.json;
  }
  return target;
}

function isBrowserControlledHeader(name) {
  const lower = String(name || "").trim().toLowerCase();
  if (!lower) return true;
  if (lower.startsWith(":") || lower.startsWith("sec-") || lower.startsWith("proxy-")) return true;
  return new Set([
    "accept-charset",
    "accept-encoding",
    "access-control-request-headers",
    "access-control-request-method",
    "connection",
    "content-length",
    "cookie",
    "cookie2",
    "date",
    "dnt",
    "expect",
    "host",
    "keep-alive",
    "origin",
    "referer",
    "set-cookie",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "via",
  ]).has(lower);
}

function sanitizeReplayHeaders(headers = {}) {
  const sanitized = {};
  const removed = [];
  for (const [name, value] of Object.entries(headers || {})) {
    if (isBrowserControlledHeader(name)) {
      removed.push(String(name));
      continue;
    }
    sanitized[name] = value;
  }
  removed.sort((a, b) => a.localeCompare(b));
  return {
    headers: sanitized,
    removed,
    policy: {
      sanitized: removed.length > 0,
      removedBrowserControlledHeaders: removed,
      note: "Repeater removes browser-controlled headers from editable replay templates so sends do not fail on forbidden header rules. Removed header names are recorded; values are not duplicated.",
    },
  };
}

function interceptPayload(action, capturedRequestId, flags) {
  const payload = withDefaults(flags, {
    action,
    ...(capturedRequestId ? { captured_request_id: capturedRequestId } : {}),
  }, [
    "capturedRequestId",
    "urlPattern",
    "headersJson",
    "removeHeader",
    "bodyFile",
    "jsonBody",
    "bodyBase64",
  ]);
  if (flags.urlPattern) payload.url_pattern = String(flags.urlPattern);
  if (flags.headersJson) payload.header_overrides = JSON.parse(String(flags.headersJson));
  if (flags.removeHeader) payload.remove_headers = splitListFlag(flags.removeHeader);
  if (flags.bodyFile) payload.body = readFileSync(String(flags.bodyFile), "utf8");
  if (flags.jsonBody) payload.json = JSON.parse(String(flags.jsonBody));
  if (flags.bodyBase64) payload.body_base64 = String(flags.bodyBase64);
  return payload;
}

function compactInterceptEntry(entry = {}, profile = "default") {
  const capturedRequestId = firstDefined(entry.capturedRequestId, entry.captured_request_id, entry.requestId, entry.id);
  const headers = entry.headers || entry.requestHeaders || {};
  const postData = firstDefined(entry.postData, entry.body, entry.requestBody);
  return {
    capturedRequestId,
    cdpRequestId: firstDefined(entry.cdpRequestId, entry.cdp_request_id),
    profile,
    method: entry.method || entry.request?.method || null,
    url: entry.url || entry.request?.url || null,
    timerRemainingMs: typeof entry.timerRemainingMs === "number" ? entry.timerRemainingMs : null,
    headerKeys: Object.keys(headers || {}).sort(),
    hasBody: postData !== undefined && postData !== null && String(postData).length > 0,
    bodyLength: postData !== undefined && postData !== null ? String(postData).length : 0,
    bodyPreview: postData !== undefined && postData !== null ? String(postData).slice(0, 240) : "",
    next: capturedRequestId ? {
      continue: `agent-browser intercept continue ${capturedRequestId} --profile ${profile}`,
      continueJson: `agent-browser intercept continue ${capturedRequestId} --profile ${profile} --json-body '{...}'`,
      fail: `agent-browser intercept fail ${capturedRequestId} --profile ${profile} --error-reason BlockedByClient`,
    } : {},
  };
}

function networkLookupFragment(...values) {
  const value = firstDefined(...values);
  if (!value) return "<api-fragment>";
  const text = String(value);
  try {
    const parsed = new URL(text);
    const path = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : parsed.hostname;
    return path.replace(/^\/+/, "") || parsed.hostname || text;
  } catch {
    return text;
  }
}

function interceptPostForwardCorrelation(raw = {}, flags = {}, profile = "default") {
  const capturedRequestId = firstDefined(
    flags.capturedRequestId,
    flags.captured_request_id,
    raw.capturedRequestId,
    raw.captured_request_id,
    raw.fetchRequestId,
    raw.requestId,
  );
  const url = firstDefined(raw.url, raw.request?.url, flags.urlPattern, flags.url_pattern);
  const method = String(firstDefined(raw.method, raw.request?.method, flags.method, "POST")).toUpperCase();
  const urlContains = networkLookupFragment(flags.urlPattern, flags.url_pattern, url);
  const requestLookup = requestsCommand(profile, {
    urlContains,
    method,
    hasRequestBody: true,
  });
  return {
    state: "needs-network-request-id",
    capturedRequestId,
    reason: "The paused Fetch capturedRequestId is transient. After continue, find the resulting F12 Network requestId before using request detail, replay, or Repeater.",
    lookup: {
      profile,
      method,
      urlContains,
      command: requestLookup,
      selectors: {
        sameProfile: profile,
        sameMethod: method,
        urlContains,
        hasRequestBody: true,
      },
    },
    nextCommands: [
      `agent-browser intercept handoff ${capturedRequestId || "<capturedRequestId>"} --profile ${cliValue(profile)} --url-contains ${cliValue(urlContains)} --method ${cliValue(method)}`,
      requestLookup,
      `agent-browser request detail <requestId> --profile ${cliValue(profile)}`,
      `agent-browser request payload <requestId> --profile ${cliValue(profile)}`,
      `agent-browser repeater open <requestId> --profile ${cliValue(profile)}`,
    ],
    idBoundary: {
      capturedRequestId: "Use only for intercept continue/fail while the request is paused.",
      requestId: "Use after the forwarded browser request appears in F12 Network.",
      doNotMix: true,
    },
  };
}

async function interceptHandoff(server, capturedRequestId, flags = {}) {
  const profile = flags.profile || "default";
  let urlContains = firstDefined(flags.urlContains, flags.url_contains, flags.urlPattern, flags.url_pattern);
  const method = String(firstDefined(flags.method, "POST")).toUpperCase();
  let selectedPausedRequest = null;
  if (!urlContains && capturedRequestId) {
    const rawList = await callTool(server, "cdp_fetch_intercept", interceptPayload("list", null, flags)).catch(() => null);
    if (rawList) {
      const listed = interceptResult("list", rawList, flags);
      selectedPausedRequest = listed.requests.find((entry) => entry.capturedRequestId === capturedRequestId || entry.cdpRequestId === capturedRequestId) || null;
      urlContains = selectedPausedRequest?.url ? networkLookupFragment(selectedPausedRequest.url) : null;
    }
  }
  if (!urlContains) urlContains = "<api-fragment>";
  const networkPayload = {
    profile,
    urlContains,
    method,
    hasRequestBody: flags.hasRequestBody === undefined ? true : flags.hasRequestBody,
    limit: flags.all ? 1000000 : Number(flags.limit || 20),
  };
  const rawNetwork = await callRaw(server, "profile_traffic_query", networkPayload);
  const compact = compactRequestsResult(rawNetwork, networkPayload);
  const durableCandidates = compact.requests.filter((row) => row.requestId);
  const selected = durableCandidates[0] || null;
  const blockers = [];
  const warnings = [];
  if (!durableCandidates.length) blockers.push("no-durable-network-request");
  if (durableCandidates.length > 1) warnings.push("multiple-network-candidates");
  if (compact.truncated) warnings.push("bounded-network-log-may-hide-request");
  const nextCommands = [];
  if (selected?.requestId) {
    nextCommands.push(`agent-browser request diagnose ${selected.requestId} --profile ${profile}`);
    nextCommands.push(`agent-browser request detail ${selected.requestId} --profile ${profile}`);
    nextCommands.push(`agent-browser request payload ${selected.requestId} --profile ${profile}`);
    nextCommands.push(`agent-browser repeater open ${selected.requestId} --profile ${profile}`);
  }
  nextCommands.push(requestsCommand(profile, networkPayload, ["--all"]));
  if (capturedRequestId) nextCommands.push(`agent-browser intercept evidence ${capturedRequestId} --profile ${profile}`);
  let openedRepeater = null;
  if (flags.openRepeater === true && selected?.requestId) {
    openedRepeater = await runRepeaterCommand(server, ["repeater", "open", selected.requestId], { ...flags, profile });
  }
  return {
    ok: blockers.length === 0,
    schema: "agent-browser.intercept.handoff.v1",
    profile,
    capturedRequestId: capturedRequestId || null,
    state: blockers.length ? "needs-network-request" : (openedRepeater ? "repeater-opened" : "ready-for-repeater"),
    blockers,
    warnings,
    lookup: {
      profile,
      method,
      urlContains,
      hasRequestBody: networkPayload.hasRequestBody,
      command: requestsCommand(profile, networkPayload),
    },
    selectedPausedRequest,
    durableCandidates,
    selectedRequestId: selected?.requestId || null,
    openedRepeater,
    network: {
      returned: compact.returned,
      total: compact.total,
      truncated: compact.truncated,
      coverage: compact.coverage,
    },
    nextCommands: [...new Set(nextCommands)],
    idBoundary: {
      capturedRequestId: "Transient paused Fetch id from Intercept. Do not use it with Repeater.",
      requestId: "Durable F12 Network id. Use this with request detail, payload, replay, and Repeater.",
      doNotMix: true,
    },
    boundary: "Intercept handoff correlates an intercepted browser request to captured Network evidence. It does not infer security impact.",
  };
}

function interceptResult(action, raw, flags = {}) {
  const profile = flags.profile || raw?.profile || "default";
  if (action === "list") {
    const entries = Array.isArray(raw)
      ? raw
      : (Array.isArray(raw?.requests) ? raw.requests : (Array.isArray(raw?.captured) ? raw.captured : (Array.isArray(raw?.paused) ? raw.paused : [])));
    const requests = entries.map((entry) => compactInterceptEntry(entry, profile));
    return {
      ok: true,
      schema: "agent-browser.intercept.list.v1",
      profile,
      pausedCount: requests.length,
      requests,
      raw,
      interceptSummary: {
        state: requests.length ? "paused-requests" : "no-paused-requests",
        pausedCount: requests.length,
        soonestTimeoutMs: requests
          .map((entry) => entry.timerRemainingMs)
          .filter((value) => typeof value === "number")
          .sort((a, b) => a - b)[0] ?? null,
      },
      nextCommands: requests.length
        ? requests.flatMap((entry) => [entry.next.continue, entry.next.continueJson, entry.next.fail].filter(Boolean))
        : [
          `agent-browser intercept start --profile ${profile} --url-pattern <api-fragment>`,
          "Trigger the browser action that should create the request.",
          `agent-browser intercept list --profile ${profile}`,
        ],
      boundary: "Intercept list reports paused in-flight browser requests. It does not replay, continue, fail, or judge responses.",
    };
  }
  if (action === "start") {
    const urlPattern = flags.urlPattern || flags.url_pattern || raw?.urlPattern || raw?.url_pattern || "";
    return {
      ok: raw?.ok !== false,
      schema: "agent-browser.intercept.start.v1",
      profile,
      urlPattern,
      raw,
      interceptSummary: {
        state: "armed",
        mode: "cdp-fetch-in-flight",
        urlPattern,
      },
      nextCommands: [
        "Trigger the browser action that should emit the matching request.",
        `agent-browser intercept list --profile ${profile}`,
        `agent-browser intercept continue <capturedRequestId> --profile ${profile} --json-body '{...}'`,
      ],
      boundary: "Intercept start arms CDP Fetch interception for future in-flight browser requests. It does not send traffic by itself.",
    };
  }
  if (action === "continue") {
    const capturedRequestId = flags.capturedRequestId || flags.captured_request_id || raw?.capturedRequestId || raw?.captured_request_id || raw?.requestId || null;
    const postForwardCorrelation = interceptPostForwardCorrelation(raw, flags, profile);
    return {
      ok: raw?.ok !== false,
      schema: "agent-browser.intercept.continue.v1",
      profile,
      capturedRequestId,
      raw,
      interceptSummary: {
        state: "continued",
        modifiedHeaders: flags.headersJson ? Object.keys(JSON.parse(String(flags.headersJson))).sort() : [],
        removedHeaders: flags.removeHeader ? splitListFlag(flags.removeHeader) : [],
        modifiedBody: Boolean(flags.jsonBody || flags.bodyFile || flags.bodyBase64),
      },
      postForwardCorrelation,
      nextCommands: [
        `agent-browser intercept list --profile ${profile}`,
        ...postForwardCorrelation.nextCommands,
        "Inspect the resulting request/response evidence before drawing conclusions.",
      ],
      boundary: "Intercept continue edits and forwards a real in-flight browser request. It records objective routing only, not security impact.",
    };
  }
  if (action === "fail") {
    const capturedRequestId = flags.capturedRequestId || flags.captured_request_id || raw?.capturedRequestId || raw?.captured_request_id || raw?.requestId || null;
    return {
      ok: raw?.ok !== false,
      schema: "agent-browser.intercept.fail.v1",
      profile,
      capturedRequestId,
      raw,
      interceptSummary: {
        state: "failed",
        errorReason: flags.errorReason || flags.error_reason || raw?.errorReason || raw?.error_reason || null,
      },
      nextCommands: [
        `agent-browser intercept list --profile ${profile}`,
        "Reload or retrigger the browser action if another request is needed.",
      ],
      boundary: "Intercept fail aborts a paused in-flight browser request. Use only when simulating or cancelling that browser request is intended.",
    };
  }
  return raw;
}

function interceptEvidencePackage(raw, flags = {}) {
  const profile = flags.profile || raw?.profile || "default";
  const listed = interceptResult("list", raw, flags);
  const requestedId = flags.capturedRequestId || flags.captured_request_id || flags.requestId;
  const selected = requestedId
    ? listed.requests.find((entry) => entry.capturedRequestId === requestedId || entry.cdpRequestId === requestedId) || null
    : listed.requests[0] || null;
  const packageObject = {
    ok: true,
    schema: "agent-browser.intercept.evidence.v1",
    profile,
    capturedRequestId: selected?.capturedRequestId || requestedId || null,
    pausedCount: listed.pausedCount,
    selected,
    requests: listed.requests,
    interceptSummary: {
      state: selected ? "paused-request-selected" : (listed.pausedCount ? "paused-requests" : "no-paused-requests"),
      pausedCount: listed.pausedCount,
      selectedCapturedRequestId: selected?.capturedRequestId || null,
      hasSelectedBody: Boolean(selected?.hasBody),
      selectedHeaderKeys: selected?.headerKeys || [],
    },
    workflow: [
      {
        step: "edit-and-forward-current-request",
        purpose: "Operate on the live paused browser request, equivalent to Burp Intercept edit-and-forward.",
        commands: selected ? [
          selected.next.continue,
          selected.next.continueJson,
          selected.next.fail,
        ].filter(Boolean) : [`agent-browser intercept list --profile ${profile}`],
      },
      {
        step: "recover-network-request-id-after-forward",
        purpose: "After continuing the request, locate the resulting F12 Network request id before using Repeater.",
        commands: [
          `agent-browser requests --profile ${profile} --url-contains <api-fragment> --method ${selected?.method || "POST"} --has-request-body true`,
          `agent-browser request detail <requestId> --profile ${profile}`,
          `agent-browser request payload <requestId> --profile ${profile}`,
        ],
      },
      {
        step: "open-repeater-after-network-id-is-known",
        purpose: "Repeater is anchored to a captured Network requestId, not the transient intercept capturedRequestId.",
        commands: [
          `agent-browser repeater open <requestId> --profile ${profile}`,
          "agent-browser repeater edit <sessionId> --json-body '{...}'",
          "agent-browser repeater send <sessionId>",
          "agent-browser repeater diff <sessionId>",
        ],
      },
    ],
    idBoundary: {
      capturedRequestId: "Transient paused Fetch request id used by intercept continue/fail.",
      requestId: "Captured Network request id used by request detail/payload/replay/repeater after the browser request is observed in traffic.",
      doNotMix: true,
    },
    boundary: "Intercept evidence is an objective local handoff for paused in-flight browser requests. It does not classify vulnerabilities.",
  };
  if (flags.out) {
    const out = String(flags.out);
    mkdirSync(dirname(out), { recursive: true });
    packageObject.outputPath = out;
    writeFileSync(out, `${JSON.stringify(packageObject, null, 2)}\n`, "utf8");
  }
  return packageObject;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function compactRequestRow(row, profile) {
  const requestId = firstDefined(row.requestId, row._requestId, row.id);
  const f12 = row.f12Columns || {};
  return {
    requestId,
    method: firstDefined(row.method, f12.method),
    status: firstDefined(row.status, row.responseStatus, f12.status),
    type: firstDefined(row.resourceType, row.type, f12.type),
    name: firstDefined(f12.name, row.name),
    url: row.url,
    hasRequestBody: Boolean(firstDefined(row.hasRequestBody, row.requestBodyAvailable, row.postDataLength)),
    hasResponseBody: Boolean(firstDefined(row.hasResponseBody, row.bodyIncluded, row.bodyReadable)),
    initiator: firstDefined(f12.initiator, row.initiatorType, row.initiator?.type),
    time: firstDefined(f12.time, row.durationMs, row.time),
    next: requestId ? {
      detail: `agent-browser request detail ${requestId} --profile ${profile}`,
      payload: `agent-browser request payload ${requestId} --profile ${profile}`,
      replay: `agent-browser replay ${requestId} --profile ${profile}`,
    } : undefined,
  };
}

function cliValue(value) {
  return JSON.stringify(String(value));
}

function interceptDiagnose(raw, flags = {}) {
  const profile = flags.profile || raw?.profile || "default";
  const listed = interceptResult("list", raw, flags);
  const blockers = [];
  const warnings = [];
  if (!listed.pausedCount) blockers.push("no-paused-requests");
  const selectedId = flags.capturedRequestId || flags.captured_request_id || flags.requestId;
  const selected = selectedId
    ? listed.requests.find((entry) => entry.capturedRequestId === selectedId || entry.cdpRequestId === selectedId) || null
    : listed.requests[0] || null;
  if (selectedId && !selected) blockers.push("captured-request-not-found");
  if (selected && !selected.hasBody) warnings.push("selected-request-has-no-body");
  const soonestTimeoutMs = listed.interceptSummary?.soonestTimeoutMs ?? null;
  if (typeof soonestTimeoutMs === "number" && soonestTimeoutMs < 5000) warnings.push("paused-request-timeout-soon");
  return {
    ok: blockers.length === 0,
    schema: "agent-browser.intercept.diagnose.v1",
    profile,
    state: blockers.length ? "not-ready" : "ready-to-continue",
    blockers,
    warnings,
    interceptSummary: {
      pausedCount: listed.pausedCount,
      selectedCapturedRequestId: selected?.capturedRequestId || selectedId || null,
      selectedMethod: selected?.method || null,
      selectedUrl: selected?.url || null,
      hasSelectedBody: Boolean(selected?.hasBody),
      soonestTimeoutMs,
    },
    selected,
    requests: listed.requests,
    nextCommands: blockers.includes("no-paused-requests")
      ? [
        `agent-browser intercept start --profile ${cliValue(profile)} --url-pattern ${cliValue(flags.urlPattern || flags.url_pattern || "<api-fragment>")}`,
        "Trigger the browser action that should create the request.",
        `agent-browser intercept diagnose --profile ${cliValue(profile)}`,
      ]
      : [
        selected?.next?.continue,
        selected?.next?.continueJson,
        selected?.next?.fail,
        `agent-browser intercept evidence --profile ${cliValue(profile)}${selected?.capturedRequestId ? ` ${cliValue(selected.capturedRequestId)}` : ""}`,
      ].filter(Boolean),
    idBoundary: {
      capturedRequestId: "Use only for intercept continue/fail while the request is paused.",
      requestId: "Use only after the forwarded browser request appears in F12 Network.",
      doNotMix: true,
    },
    coverage: {
      truncated: false,
      source: "cdp_fetch_intercept action=list",
      pausedCount: listed.pausedCount,
      selectedFound: Boolean(selected),
    },
    boundary: "Intercept diagnose reports paused in-flight request readiness and ID boundaries. It does not continue traffic or judge security impact.",
  };
}

function requestFilterArgs(filters = {}) {
  const parts = [];
  const urlContains = firstDefined(filters.urlContains, filters.url_contains);
  if (urlContains) parts.push("--url-contains", cliValue(urlContains));
  if (filters.method) parts.push("--method", cliValue(filters.method));
  const hasRequestBody = firstDefined(filters.hasRequestBody, filters.has_request_body);
  if (hasRequestBody !== undefined) parts.push("--has-request-body", String(Boolean(hasRequestBody)));
  return parts;
}

function requestsCommand(profile, filters, extraParts = []) {
  return ["agent-browser", "requests", "--profile", cliValue(profile), ...requestFilterArgs(filters), ...extraParts].join(" ");
}

function compactRequestsResult(result, flags) {
  const profile = result.profile || flags.profile || "default";
  const requests = Array.isArray(result.requests) ? result.requests : [];
  const limit = Number(flags.limit || requests.length || 0);
  const returned = typeof result.returned === "number" ? result.returned : requests.length;
  const total = typeof result.total === "number" ? result.total : (typeof result.count === "number" ? result.count : requests.length);
  const hasMore = Boolean(result.hasMore ?? (total > returned));
  const filtersApplied = result.filtersApplied || payloadFromFlags(flags);
  const fetchMoreCommand = hasMore ? requestsCommand(profile, filtersApplied, ["--limit", String(Math.max(limit * 2, returned + 20))]) : undefined;
  const fetchAllCommand = hasMore ? requestsCommand(profile, filtersApplied, ["--all"]) : undefined;
  const warnings = hasMore ? [{
    code: "bounded_network_rows",
    severity: "info",
    message: "Only a bounded slice of captured Network rows is included.",
    returned,
    total,
    limit,
    next: [fetchMoreCommand, fetchAllCommand].filter(Boolean),
  }] : [];
  return {
    schema: "agent-browser.requests.v1",
    profile,
    count: returned,
    total,
    returned,
    hasMore,
    truncated: hasMore,
    warnings,
    filtersApplied,
    coverage: {
      sourceTool: "profile_traffic_query",
      limit,
      returned,
      total,
      hasMore,
      truncated: hasMore,
      note: hasMore
        ? "Output is a bounded slice of captured Network rows. Increase --limit or use --all to fetch more."
        : "All matching rows returned by the source tool are present in this output.",
      next: [fetchMoreCommand, fetchAllCommand].filter(Boolean),
    },
    requests: requests.map((row) => compactRequestRow(row, profile)),
    next: {
      detail: "agent-browser request detail <requestId> --profile <profile>",
      payload: "agent-browser request payload <requestId> --profile <profile>",
      replay: "agent-browser replay <requestId> --profile <profile> --json-body '{...}'",
      batch: "agent-browser replay-batch <requestId> --profile <profile> --variants-json '[...]'",
      fetchMore: fetchMoreCommand,
      fetchAll: fetchAllCommand,
    },
  };
}

async function requestsDiagnose(server, flags = {}) {
  const payload = withDefaults(flags, {
    limit: flags.all ? 1000000 : Number(flags.limit || 20),
  }, ["all"]);
  const [captureStatus, rawNetwork] = await Promise.all([
    callTool(server, "browser_capture", capturePayload("status", flags)).catch((error) => ({ ok: false, error: errorMessage(error) })),
    callRaw(server, "profile_traffic_query", payload),
  ]);
  const compact = compactRequestsResult(rawNetwork, payload);
  const bodyRows = compact.requests.filter((row) => row.hasRequestBody);
  const firstRequest = compact.requests.find((row) => row.requestId) || null;
  const state = compact.total === 0
    ? "no-matching-requests"
    : (compact.hasMore
      ? "bounded-results"
      : (bodyRows.length === 0 ? "requests-without-visible-body" : "requests-found"));
  const blockers = [];
  if (compact.total === 0) blockers.push("no-matching-requests");
  if (compact.hasMore) blockers.push("bounded-network-results");
  if (compact.total > 0 && bodyRows.length === 0) blockers.push("no-visible-request-body-in-returned-rows");
  const nextCommands = [];
  if (compact.total === 0) {
    nextCommands.push(`agent-browser capture start --profile ${compact.profile} --label request-diagnose`);
    nextCommands.push(`agent-browser capture reload --profile ${compact.profile}`);
    nextCommands.push(requestsCommand(compact.profile, compact.filtersApplied, ["--all"]));
  } else {
    if (compact.next.fetchMore) nextCommands.push(compact.next.fetchMore);
    if (compact.next.fetchAll) nextCommands.push(compact.next.fetchAll);
    if (firstRequest?.requestId) {
      nextCommands.push(`agent-browser request detail ${firstRequest.requestId} --profile ${compact.profile}`);
      nextCommands.push(`agent-browser request payload ${firstRequest.requestId} --profile ${compact.profile}`);
      nextCommands.push(`agent-browser repeater open ${firstRequest.requestId} --profile ${compact.profile}`);
    }
    if (bodyRows.length === 0) {
      nextCommands.push(requestsCommand(compact.profile, { ...compact.filtersApplied, hasRequestBody: undefined }, ["--all"]));
    }
  }
  return {
    ok: blockers.length === 0,
    schema: "agent-browser.requests.diagnose.v1",
    profile: compact.profile,
    state,
    blockers,
    filtersApplied: compact.filtersApplied,
    captureStatus,
    requestSummary: {
      matchedTotal: compact.total,
      returned: compact.returned,
      truncated: compact.truncated,
      hasMore: compact.hasMore,
      returnedWithRequestBody: bodyRows.length,
      firstRequestId: firstRequest?.requestId || null,
      firstRequest: firstRequest ? {
        requestId: firstRequest.requestId,
        method: firstRequest.method,
        status: firstRequest.status,
        url: firstRequest.url,
        hasRequestBody: firstRequest.hasRequestBody,
      } : null,
    },
    coverage: compact.coverage,
    warnings: compact.warnings,
    nextCommands,
    boundary: "Requests diagnose reports captured Network evidence coverage and next mechanical steps. It does not infer that an API exists outside captured traffic or judge security impact.",
  };
}

function requestIdLooksLikeCapturedFetchId(requestId) {
  return /(?:^|[-_:])(fetch|intercept|paused|captured)(?:[-_:]|$)/i.test(String(requestId || ""));
}

async function requestDiagnose(server, requestId, flags = {}) {
  const profile = flags.profile || "default";
  const basePayload = withDefaults(flags, { requestId, profile }, ["requestId", "all"]);
  const networkPayload = withDefaults(flags, {
    profile,
    limit: flags.all ? 1000000 : Number(flags.limit || 50),
  }, ["requestId", "all"]);
  const [captureStatus, detailAttempt, payloadAttempt, networkAttempt, interceptAttempt] = await Promise.all([
    callTool(server, "browser_capture", capturePayload("status", { ...flags, profile })).catch((error) => ({ ok: false, error: errorMessage(error) })),
    callRaw(server, "profile_request_detail", basePayload)
      .then((result) => ({ ok: true, result }))
      .catch((error) => ({ ok: false, error: errorMessage(error), code: classifyCliError(error) })),
    callRaw(server, "profile_request_payload", basePayload)
      .then((result) => ({ ok: true, result }))
      .catch((error) => ({ ok: false, error: errorMessage(error), code: classifyCliError(error) })),
    callRaw(server, "profile_traffic_query", networkPayload)
      .then((result) => ({ ok: true, result: compactRequestsResult(result, networkPayload) }))
      .catch((error) => ({ ok: false, error: errorMessage(error), code: classifyCliError(error) })),
    callTool(server, "cdp_fetch_intercept", interceptPayload("list", null, { ...flags, profile }))
      .then((result) => ({ ok: true, result: interceptResult("list", result, { ...flags, profile }) }))
      .catch((error) => ({ ok: false, error: errorMessage(error), code: classifyCliError(error) })),
  ]);
  const networkRows = networkAttempt.ok ? (networkAttempt.result.requests || []) : [];
  const matchingNetworkRow = networkRows.find((row) => row.requestId === requestId) || null;
  const pausedRows = interceptAttempt.ok ? (interceptAttempt.result.requests || []) : [];
  const matchingPausedRow = pausedRows.find((row) => row.capturedRequestId === requestId || row.cdpRequestId === requestId) || null;
  const suspectedCapturedId = Boolean(matchingPausedRow) || requestIdLooksLikeCapturedFetchId(requestId);
  const blockers = [];
  const warnings = [];
  if (suspectedCapturedId && matchingPausedRow) blockers.push("likely-transient-captured-request-id");
  if (!detailAttempt.ok) blockers.push("request-detail-unavailable");
  if (!matchingNetworkRow) blockers.push("request-not-in-returned-network-log");
  if (suspectedCapturedId && !detailAttempt.ok) blockers.push("likely-transient-captured-request-id");
  if (detailAttempt.ok && !payloadAttempt.ok) warnings.push("request-payload-unavailable");
  if (networkAttempt.ok && networkAttempt.result.truncated && !matchingNetworkRow) warnings.push("bounded-network-log-may-hide-request");
  const state = suspectedCapturedId && matchingPausedRow
    ? "likely-captured-request-id"
    : (detailAttempt.ok
    ? (payloadAttempt.ok ? "ready-for-repeater" : "detail-readable")
    : (suspectedCapturedId ? "likely-captured-request-id" : "request-not-found"));
  const nextCommands = [];
  if (suspectedCapturedId && matchingPausedRow) {
    nextCommands.push(`agent-browser intercept diagnose ${requestId} --profile ${profile}`);
    nextCommands.push(`agent-browser intercept evidence ${requestId} --profile ${profile}`);
    nextCommands.push(`agent-browser intercept list --profile ${profile}`);
    nextCommands.push(`agent-browser requests diagnose --profile ${profile} --all`);
  } else if (detailAttempt.ok) {
    nextCommands.push(`agent-browser request payload ${requestId} --profile ${profile}`);
    nextCommands.push(`agent-browser repeater open ${requestId} --profile ${profile}`);
    nextCommands.push(`agent-browser replay ${requestId} --profile ${profile} --json-body '{...}'`);
    nextCommands.push(`agent-browser export ${requestId} --profile ${profile} --format json --out ./request.json`);
  } else if (suspectedCapturedId) {
    nextCommands.push(`agent-browser intercept diagnose ${requestId} --profile ${profile}`);
    nextCommands.push(`agent-browser intercept evidence ${requestId} --profile ${profile}`);
    nextCommands.push(`agent-browser intercept list --profile ${profile}`);
    nextCommands.push(`agent-browser requests diagnose --profile ${profile} --all`);
  } else {
    nextCommands.push(`agent-browser requests diagnose --profile ${profile} --all`);
    nextCommands.push(`agent-browser capture start --profile ${profile} --label request-diagnose`);
    nextCommands.push(`agent-browser capture reload --profile ${profile}`);
  }
  if (networkAttempt.ok && networkAttempt.result.next.fetchAll && !matchingNetworkRow) {
    nextCommands.push(networkAttempt.result.next.fetchAll);
  }
  return {
    ok: detailAttempt.ok && !(suspectedCapturedId && matchingPausedRow),
    schema: "agent-browser.request.diagnose.v1",
    profile,
    requestId,
    state,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    attempts: {
      detail: detailAttempt,
      payload: payloadAttempt,
      network: networkAttempt.ok ? {
        ok: true,
        returned: networkAttempt.result.returned,
        total: networkAttempt.result.total,
        truncated: networkAttempt.result.truncated,
        matchingRequest: matchingNetworkRow,
      } : networkAttempt,
      intercept: interceptAttempt.ok ? {
        ok: true,
        pausedCount: interceptAttempt.result.pausedCount,
        matchingPausedRequest: matchingPausedRow,
      } : interceptAttempt,
      captureStatus,
    },
    requestSummary: {
      durableNetworkRequestFound: Boolean(detailAttempt.ok),
      payloadReadable: Boolean(payloadAttempt.ok),
      matchingNetworkRowFound: Boolean(matchingNetworkRow),
      matchingPausedRequestFound: Boolean(matchingPausedRow),
      suspectedCapturedRequestId: suspectedCapturedId,
    },
    idBoundary: {
      requestId: "Durable F12 Network id. Use this with request detail, payload, replay, and Repeater.",
      capturedRequestId: "Transient paused Fetch id. Use this only with intercept diagnose/evidence/continue/fail while the request is paused.",
      doNotMix: true,
    },
    nextCommands: [...new Set(nextCommands)],
    boundary: "Request diagnose checks mechanical request-id readiness and ID boundaries. It does not replay traffic or judge security impact.",
  };
}

function digestValue(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex").slice(0, 16);
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function tryParseJson(text) {
  if (typeof text !== "string" || !text.trim()) return { ok: false, value: null, error: "empty" };
  try {
    return { ok: true, value: JSON.parse(text), error: null };
  } catch (error) {
    return { ok: false, value: null, error: error.message };
  }
}

// ---------------------------------------------------------------------------
// Compare evidence — diff two replay/request/artifact JSON objects.
// Boundary: tool compares evidence; it does not decide impact.
// ---------------------------------------------------------------------------

function extractBodyText(obj) {
  if (typeof obj.body === "string") return obj.body;
  if (typeof obj.responseBody === "string") return obj.responseBody;
  if (obj.response && typeof obj.response.body === "string") return obj.response.body;
  if (typeof obj.text === "string") return obj.text;
  return JSON.stringify(obj);
}

function extractStatusCode(obj) {
  return obj.status ?? obj.statusCode ?? obj.responseStatus ??
    obj.httpStatus ?? (obj.response && (obj.response.status ?? obj.response.statusCode)) ?? null;
}

const COMPARE_SELECTED_HEADERS = new Set([
  "content-type", "content-length", "x-powered-by", "server",
  "x-frame-options", "location", "cache-control", "vary",
]);

function extractSelectedHeaders(obj) {
  const src = obj.headers ?? obj.responseHeaders ??
    (obj.response && obj.response.headers) ?? {};
  const result = {};
  for (const [key, value] of Object.entries(src)) {
    if (COMPARE_SELECTED_HEADERS.has(key.toLowerCase())) {
      result[key.toLowerCase()] = value;
    }
  }
  return result;
}

function diffHeaders(leftHeaders, rightHeaders) {
  const allKeys = new Set([...Object.keys(leftHeaders), ...Object.keys(rightHeaders)]);
  const changes = [];
  for (const key of allKeys) {
    const lv = leftHeaders[key];
    const rv = rightHeaders[key];
    if (lv !== rv) changes.push({ header: key, left: lv ?? null, right: rv ?? null });
  }
  return { changed: changes.length > 0, changes };
}

function diffJsonTopLevelKeys(leftBody, rightBody) {
  const lp = tryParseJson(leftBody);
  const rp = tryParseJson(rightBody);
  if (!lp.ok || !rp.ok) {
    return { applicable: false, reason: !lp.ok ? "left body is not JSON" : "right body is not JSON" };
  }
  const leftKeys = new Set(lp.value && typeof lp.value === "object" && !Array.isArray(lp.value) ? Object.keys(lp.value) : []);
  const rightKeys = new Set(rp.value && typeof rp.value === "object" && !Array.isArray(rp.value) ? Object.keys(rp.value) : []);
  const added = [...rightKeys].filter((k) => !leftKeys.has(k));
  const removed = [...leftKeys].filter((k) => !rightKeys.has(k));
  const shared = [...leftKeys].filter((k) => rightKeys.has(k));
  return { applicable: true, added, removed, shared, changed: added.length > 0 || removed.length > 0 };
}

function textSnippetDiff(leftBody, rightBody, snippetLen = 120) {
  if (leftBody === rightBody) return { identical: true, firstDiffAt: null, leftSnippet: null, rightSnippet: null };
  let i = 0;
  const minLen = Math.min(leftBody.length, rightBody.length);
  while (i < minLen && leftBody[i] === rightBody[i]) i += 1;
  const start = Math.max(0, i - 20);
  return {
    identical: false,
    firstDiffAt: i,
    leftSnippet: leftBody.slice(start, start + snippetLen),
    rightSnippet: rightBody.slice(start, start + snippetLen),
  };
}

function buildCompareDiff(leftData, rightData, leftLabel, rightLabel) {
  const leftStatus = extractStatusCode(leftData);
  const rightStatus = extractStatusCode(rightData);
  const leftBody = extractBodyText(leftData);
  const rightBody = extractBodyText(rightData);
  const leftHeaders = extractSelectedHeaders(leftData);
  const rightHeaders = extractSelectedHeaders(rightData);
  return {
    schema: "agent-browser.compare.v1",
    left: { label: leftLabel, statusCode: leftStatus, bodyLength: leftBody.length },
    right: { label: rightLabel, statusCode: rightStatus, bodyLength: rightBody.length },
    diff: {
      statusCode: { left: leftStatus, right: rightStatus, changed: leftStatus !== rightStatus },
      bodyLength: {
        left: leftBody.length,
        right: rightBody.length,
        delta: rightBody.length - leftBody.length,
        changed: leftBody.length !== rightBody.length,
      },
      headers: diffHeaders(leftHeaders, rightHeaders),
      jsonTopLevelKeys: diffJsonTopLevelKeys(leftBody, rightBody),
      textSnippet: textSnippetDiff(leftBody, rightBody),
    },
    boundary: "Tool compares evidence; it does not decide impact.",
    next: {
      compare: "agent-browser compare --left baseline.json --right variant.json",
    },
  };
}

async function compareEvidence(server, args, flags) {
  if (flags.left && flags.right) {
    const read = (p) => {
      try { return { ok: true, path: p, data: JSON.parse(readFileSync(String(p), "utf8")) }; }
      catch (e) { return { ok: false, path: p, error: e.message }; }
    };
    const leftArtifact = read(flags.left);
    const rightArtifact = read(flags.right);
    if (!leftArtifact.ok) throw new Error("cannot read --left: " + leftArtifact.error);
    if (!rightArtifact.ok) throw new Error("cannot read --right: " + rightArtifact.error);
    return {
      ...buildCompareDiff(leftArtifact.data, rightArtifact.data, String(flags.left), String(flags.right)),
      artifactPaths: { left: String(flags.left), right: String(flags.right) },
    };
  }
  const baselineId = args[1];
  const variantId = args[2];
  if (!baselineId || !variantId) {
    throw new Error("compare requires --left and --right, or two requestIds as positional arguments");
  }
  const profile = flags.profile || "default";
  const [leftRaw, rightRaw] = await Promise.all([
    callRaw(server, "profile_request_detail", { requestId: baselineId, profile }),
    callRaw(server, "profile_request_detail", { requestId: variantId, profile }),
  ]);
  return {
    ...buildCompareDiff(leftRaw, rightRaw, "requestId:" + baselineId, "requestId:" + variantId),
    requestIds: { baseline: baselineId, variant: variantId, profile },
  };
}

function repeaterDir() {
  return join(RUNTIME_DATA_DIR, "repeater");
}

function repeaterSessionPath(sessionId) {
  const safe = String(sessionId || "").replace(/[^a-zA-Z0-9_.-]/g, "_");
  if (!safe) throw new Error("repeater sessionId is required");
  return join(repeaterDir(), `${safe}.json`);
}

function writeRepeaterSession(session) {
  mkdirSync(repeaterDir(), { recursive: true });
  writeFileSync(repeaterSessionPath(session.sessionId), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

function bookmarksFile() {
  return join(RUNTIME_DATA_DIR, "bookmarks.json");
}

function readBookmarks() {
  try {
    const parsed = JSON.parse(readFileSync(bookmarksFile(), "utf8"));
    return Array.isArray(parsed?.bookmarks) ? parsed.bookmarks : [];
  } catch {
    return [];
  }
}

function writeBookmarks(bookmarks) {
  mkdirSync(dirname(bookmarksFile()), { recursive: true });
  writeFileSync(bookmarksFile(), `${JSON.stringify({ bookmarks }, null, 2)}\n`, "utf8");
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\"'\"'")}'`;
}

function headersToObject(headers) {
  if (!headers) return {};
  if (Array.isArray(headers)) {
    const out = {};
    for (const entry of headers) {
      if (entry?.name) out[String(entry.name)] = String(entry.value ?? "");
    }
    return out;
  }
  if (typeof headers === "object") return headers;
  return {};
}

function formatCurl(template) {
  const parts = ["curl", "-i", "-X", shellSingleQuote(template.method || "GET"), shellSingleQuote(template.url || "")];
  const headers = headersToObject(template.headers);
  for (const [name, value] of Object.entries(headers)) {
    parts.push("-H", shellSingleQuote(`${name}: ${value}`));
  }
  if (template.body) parts.push("--data-raw", shellSingleQuote(template.body));
  if (template.json) parts.push("-H", shellSingleQuote("content-type: application/json"), "--data-raw", shellSingleQuote(JSON.stringify(template.json)));
  if (template.form) parts.push("--data-raw", shellSingleQuote(new URLSearchParams(template.form).toString()));
  return parts.join(" ");
}

function formatRawHttp(template) {
  const url = new URL(template.url || "http://example.invalid/");
  const path = `${url.pathname || "/"}${url.search || ""}`;
  const headers = {
    Host: url.host,
    ...headersToObject(template.headers),
  };
  const body = template.body || (template.json ? JSON.stringify(template.json) : template.form ? new URLSearchParams(template.form).toString() : "");
  const lines = [`${template.method || "GET"} ${path} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  if (body && !Object.keys(headers).some((name) => name.toLowerCase() === "content-length")) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
  lines.push("", body);
  return lines.join("\r\n");
}

function parseRawHttpRequest(content, fallbackUrl) {
  const normalized = String(content || "").replace(/\r\n/g, "\n");
  const splitAt = normalized.indexOf("\n\n");
  const head = splitAt >= 0 ? normalized.slice(0, splitAt) : normalized;
  const body = splitAt >= 0 ? normalized.slice(splitAt + 2) : "";
  const lines = head.split("\n").filter(Boolean);
  const requestLine = lines.shift() || "";
  const requestMatch = requestLine.match(/^([A-Z]+)\s+(\S+)\s+HTTP\/\d(?:\.\d)?$/i);
  if (!requestMatch) throw new Error("import raw requires an HTTP request line like: POST /path HTTP/1.1");
  const headers = {};
  for (const line of lines) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  const method = requestMatch[1].toUpperCase();
  const target = requestMatch[2];
  let url = target;
  if (!/^https?:\/\//i.test(url)) {
    const base = fallbackUrl || (headers.Host ? `https://${headers.Host}` : "");
    if (!base) throw new Error("import raw with a relative request target requires --base-url or a Host header");
    url = new URL(target, base).toString();
  }
  return {
    method,
    url,
    headers,
    ...(body ? { body } : {}),
  };
}

async function requestTemplateFromCapture(server, requestId, profile) {
  const [detail, payload] = await Promise.all([
    callRaw(server, "profile_request_detail", { requestId, profile }),
    callRaw(server, "profile_request_payload", { requestId, profile }).catch((error) => ({ payloadReadError: errorMessage(error) })),
  ]);
  const requestTemplate = extractRequestTemplate(detail, payload);
  return {
    detail,
    payload,
    template: requestTemplate.template,
    replayHeaderPolicy: requestTemplate.replayHeaderPolicy,
  };
}

function readRepeaterSession(sessionId) {
  try {
    return JSON.parse(readFileSync(repeaterSessionPath(sessionId), "utf8"));
  } catch {
    throw new Error(`repeater session not found: ${sessionId}`);
  }
}

function listRepeaterSessions(flags) {
  const profile = flags.profile ? String(flags.profile) : null;
  const includeClosed = flags.includeClosed === true;
  const dir = repeaterDir();
  if (!existsSync(dir)) {
    return {
      ok: true,
      schema: "agent-browser.repeater.list.v1",
      count: 0,
      total: 0,
      filters: { profile, includeClosed },
      sessions: [],
      repeaterDir: dir,
    };
  }

  const sessions = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const session = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (session?.schema !== "agent-browser.repeater.session.v1") continue;
      if (profile && session.profile !== profile) continue;
      if (!includeClosed && session.closedAt) continue;
      sessions.push({
        sessionId: session.sessionId,
        profile: session.profile,
        sourceRequestId: session.sourceRequestId,
        method: session.editable?.method || null,
        url: session.editable?.url || null,
        createdAt: session.createdAt || null,
        updatedAt: session.updatedAt || null,
        closedAt: session.closedAt || null,
        sendCount: Array.isArray(session.sends) ? session.sends.length : 0,
        sessionFile: repeaterSessionPath(session.sessionId),
        next: {
          history: `agent-browser repeater history ${session.sessionId} --profile ${session.profile}`,
          send: `agent-browser repeater send ${session.sessionId} --profile ${session.profile}`,
          diff: `agent-browser repeater diff ${session.sessionId} --profile ${session.profile}`,
        },
      });
    } catch {
      continue;
    }
  }

  sessions.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return {
    ok: true,
    schema: "agent-browser.repeater.list.v1",
    count: sessions.length,
    total: sessions.length,
    filters: { profile, includeClosed },
    sessions,
    repeaterDir: dir,
    boundary: "Repeater list returns local tool sessions only. It does not rank, triage, or judge request importance.",
  };
}

function requestField(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function extractRequestTemplate(detail, payload) {
  const postData = unwrapPostData(payload);
  const rawHeaders = requestField(detail.requestHeaders, detail.headers, detail.request?.headers, {});
  const sanitized = sanitizeReplayHeaders(rawHeaders);
  return {
    template: {
      method: requestField(detail.method, detail.request?.method, detail.f12Columns?.method, "GET"),
      url: requestField(detail.url, detail.request?.url),
      headers: sanitized.headers,
      ...(postData ? { body: postData } : {}),
    },
    replayHeaderPolicy: sanitized.policy,
  };
}

function repeaterSendSummary(raw, sendId) {
  const body = raw.body ?? raw.responseBody ?? raw.result?.body ?? raw.text ?? "";
  const bodyText = typeof body === "string" ? body : JSON.stringify(body ?? "");
  return {
    sendId,
    status: raw.status ?? raw.statusCode ?? raw.response?.status ?? null,
    url: raw.url ?? raw.response?.url ?? null,
    bodyDigest: digestValue(bodyText),
    bodyPreview: bodyText.slice(0, 500),
    raw,
  };
}

function repeaterWorkflowSummary(session, comparisonToPrevious = null) {
  const sends = Array.isArray(session?.sends) ? session.sends : [];
  const latest = sends[sends.length - 1] || null;
  const state = sends.length === 0
    ? "opened"
    : (sends.length === 1 ? "baseline-sent" : "variant-tested");
  const statusChangedFromPrevious = Boolean(comparisonToPrevious?.diff?.statusCode?.changed);
  return {
    state,
    sessionId: session?.sessionId || null,
    profile: session?.profile || null,
    sourceRequestId: session?.sourceRequestId || null,
    sendCount: sends.length,
    latestSendId: latest?.sendId || null,
    latestStatus: latest?.status ?? null,
    statusChangedFromPrevious,
    nextCommands: [
      `agent-browser repeater edit ${session?.sessionId || "<sessionId>"} --profile ${session?.profile || "<profile>"} --json-body '{...}'`,
      `agent-browser repeater send ${session?.sessionId || "<sessionId>"} --profile ${session?.profile || "<profile>"}`,
      `agent-browser repeater history ${session?.sessionId || "<sessionId>"} --profile ${session?.profile || "<profile>"}`,
      `agent-browser repeater diff ${session?.sessionId || "<sessionId>"} --profile ${session?.profile || "<profile>"}`,
    ],
    evidenceCommands: [
      `agent-browser bookmark ${session?.sourceRequestId || "<requestId>"} --profile ${session?.profile || "<profile>"} --tag repeater --note "<why this request matters>"`,
      `agent-browser export ${session?.sourceRequestId || "<requestId>"} --profile ${session?.profile || "<profile>"} --format json --out ./request.json`,
      `agent-browser repeater history ${session?.sessionId || "<sessionId>"} --profile ${session?.profile || "<profile>"}`,
      `agent-browser repeater diff ${session?.sessionId || "<sessionId>"} --profile ${session?.profile || "<profile>"}`,
      `agent-browser repeater handoff ${session?.sessionId || "<sessionId>"} --profile ${session?.profile || "<profile>"} --out ./repeater-handoff.json`,
    ],
    evidence: {
      hasSendHistory: sends.length > 0,
      hasPreviousComparison: Boolean(comparisonToPrevious),
      sourceFields: ["sourceRequestId", "editable", "sends", "comparisonToPrevious"],
    },
    boundary: "Repeater summary is objective workflow metadata. It does not decide whether a response difference is exploitable.",
  };
}

function repeaterEvidencePackage(session, flags = {}) {
  const sends = Array.isArray(session?.sends) ? session.sends : [];
  const baseline = sends[0] || null;
  const latest = sends[sends.length - 1] || null;
  const comparisonToBaseline = baseline && latest && baseline.sendId !== latest.sendId
    ? buildCompareDiff(baseline.raw, latest.raw, baseline.sendId, latest.sendId)
    : null;
  const statusCodes = [...new Set(sends.map((entry) => entry.status).filter((value) => value !== null && value !== undefined))];
  const bodyDigests = sends.map((entry) => ({
    sendId: entry.sendId,
    status: entry.status ?? null,
    bodyDigest: entry.bodyDigest || null,
    bodyPreviewLength: typeof entry.bodyPreview === "string" ? entry.bodyPreview.length : 0,
    sentAt: entry.sentAt || null,
  }));
  const packageObject = {
    schema: "agent-browser.repeater.evidence.v1",
    ok: true,
    sessionId: session?.sessionId || null,
    profile: session?.profile || null,
    sourceRequestId: session?.sourceRequestId || null,
    sessionFile: session?.sessionId ? repeaterSessionPath(session.sessionId) : null,
    replayHeaderPolicy: session?.replayHeaderPolicy || null,
    sendCount: sends.length,
    baseline: baseline ? {
      sendId: baseline.sendId,
      status: baseline.status ?? null,
      bodyDigest: baseline.bodyDigest || null,
      sentAt: baseline.sentAt || null,
    } : null,
    latest: latest ? {
      sendId: latest.sendId,
      status: latest.status ?? null,
      bodyDigest: latest.bodyDigest || null,
      sentAt: latest.sentAt || null,
    } : null,
    statusCodes,
    bodyDigests,
    comparisonToBaseline,
    repeaterSummary: repeaterWorkflowSummary(session, comparisonToBaseline),
    evidenceCommands: [
      `agent-browser repeater history ${session?.sessionId || "<sessionId>"} --profile ${session?.profile || "<profile>"}`,
      `agent-browser repeater diff ${session?.sessionId || "<sessionId>"} --profile ${session?.profile || "<profile>"}`,
      `agent-browser bookmark ${session?.sourceRequestId || "<requestId>"} --profile ${session?.profile || "<profile>"} --tag repeater --note "<why this request matters>"`,
      `agent-browser export ${session?.sourceRequestId || "<requestId>"} --profile ${session?.profile || "<profile>"} --format json --out ./request.json`,
      `agent-browser repeater handoff ${session?.sessionId || "<sessionId>"} --profile ${session?.profile || "<profile>"} --out ./repeater-handoff.json`,
    ],
    boundary: "Repeater evidence package summarizes local replay sends and objective diffs only. It does not decide exploitability or reportability.",
  };
  if (flags.out) {
    const out = String(flags.out);
    mkdirSync(dirname(out), { recursive: true });
    packageObject.outputPath = out;
    writeFileSync(out, `${JSON.stringify(packageObject, null, 2)}\n`, "utf8");
  }
  return packageObject;
}

async function repeaterHandoffPackage(server, session, flags = {}) {
  const sessionId = session?.sessionId || flags.sessionId || "<sessionId>";
  const profile = session?.profile || flags.profile || "default";
  const sourceRequestId = session?.sourceRequestId || null;
  const evidence = repeaterEvidencePackage(session, {});
  const artifacts = {};
  if (flags.bookmark === true && sourceRequestId) {
    artifacts.bookmark = await bookmarkRequest(server, ["bookmark", sourceRequestId], {
      profile,
      tag: flags.tag || "repeater",
      note: flags.note || `Repeater handoff ${sessionId}`,
    });
  }
  if (flags.exportDir && sourceRequestId) {
    const exportDir = String(flags.exportDir);
    mkdirSync(exportDir, { recursive: true });
    artifacts.exportJson = await exportRequest(server, ["export", sourceRequestId], {
      profile,
      format: "json",
      out: join(exportDir, `${sourceRequestId}.json`),
    });
  }
  const packageObject = {
    ok: true,
    schema: "agent-browser.repeater.handoff.v1",
    sessionId,
    profile,
    sourceRequestId,
    state: evidence.sendCount >= 2 ? "ready-for-review" : (evidence.sendCount === 1 ? "needs-variant-send" : "needs-baseline-send"),
    evidence,
    artifacts,
    nextCommands: [
      `agent-browser repeater diagnose ${sessionId} --profile ${profile}`,
      `agent-browser repeater evidence ${sessionId} --profile ${profile} --out ./repeater-evidence.json`,
      `agent-browser bookmark ${sourceRequestId || "<requestId>"} --profile ${profile} --tag repeater --note "<why this request matters>"`,
      `agent-browser export ${sourceRequestId || "<requestId>"} --profile ${profile} --format json --out ./request.json`,
      `agent-browser evidence bundle --profile ${profile} --include-har`,
    ],
    handoffSummary: {
      sendCount: evidence.sendCount,
      baselineStatus: evidence.baseline?.status ?? null,
      latestStatus: evidence.latest?.status ?? null,
      statusCodes: evidence.statusCodes,
      hasComparisonToBaseline: Boolean(evidence.comparisonToBaseline),
      bookmarkWritten: Boolean(artifacts.bookmark),
      requestExportWritten: Boolean(artifacts.exportJson?.out),
      outputPath: flags.out ? String(flags.out) : null,
    },
    boundary: "Repeater handoff packages local replay evidence and optional request artifacts for another agent. It does not decide exploitability or reportability.",
  };
  if (flags.out) {
    const out = String(flags.out);
    mkdirSync(dirname(out), { recursive: true });
    packageObject.outputPath = out;
    writeFileSync(out, `${JSON.stringify(packageObject, null, 2)}\n`, "utf8");
  }
  return packageObject;
}

function repeaterDiagnosis(session) {
  const sends = Array.isArray(session?.sends) ? session.sends : [];
  const sessionId = session?.sessionId || "<sessionId>";
  const profile = session?.profile || "<profile>";
  const baseline = sends[0] || null;
  const latest = sends[sends.length - 1] || null;
  const comparisonToBaseline = baseline && latest && baseline.sendId !== latest.sendId
    ? buildCompareDiff(baseline.raw, latest.raw, baseline.sendId, latest.sendId)
    : null;
  const statusCodes = [...new Set(sends.map((entry) => entry.status).filter((value) => value !== null && value !== undefined))];
  const state = session?.closedAt ? "closed"
    : (sends.length === 0 ? "needs-baseline-send"
      : (sends.length === 1 ? "needs-variant-send" : "ready-for-evidence"));
  const blockers = [];
  if (!session?.sourceRequestId) blockers.push("missing-source-request-id");
  if (!session?.editable) blockers.push("missing-editable-template");
  if (sends.length === 0) blockers.push("no-sends-recorded");
  if (sends.length === 1) blockers.push("no-variant-send-recorded");
  if (session?.closedAt) blockers.push("session-closed");
  const nextCommands = state === "needs-baseline-send"
    ? [
        `agent-browser repeater send ${sessionId} --profile ${profile}`,
        `agent-browser repeater history ${sessionId} --profile ${profile}`,
      ]
    : (state === "needs-variant-send"
      ? [
          `agent-browser repeater edit ${sessionId} --profile ${profile} --json-body '{...}'`,
          `agent-browser repeater send ${sessionId} --profile ${profile}`,
          `agent-browser repeater diff ${sessionId} --profile ${profile}`,
        ]
      : [
          `agent-browser repeater diff ${sessionId} --profile ${profile}`,
          `agent-browser repeater evidence ${sessionId} --profile ${profile}`,
          `agent-browser repeater evidence ${sessionId} --profile ${profile} --out ./repeater-evidence.json`,
          `agent-browser repeater handoff ${sessionId} --profile ${profile} --out ./repeater-handoff.json`,
        ]);
  return {
    ok: blockers.length === 0 || (blockers.length === 1 && blockers[0] === "session-closed"),
    schema: "agent-browser.repeater.diagnose.v1",
    sessionId: session?.sessionId || null,
    profile: session?.profile || null,
    sourceRequestId: session?.sourceRequestId || null,
    replayHeaderPolicy: session?.replayHeaderPolicy || null,
    state,
    blockers,
    sendCount: sends.length,
    statusCodes,
    baseline: baseline ? { sendId: baseline.sendId, status: baseline.status ?? null, sentAt: baseline.sentAt || null, bodyDigest: baseline.bodyDigest || null } : null,
    latest: latest ? { sendId: latest.sendId, status: latest.status ?? null, sentAt: latest.sentAt || null, bodyDigest: latest.bodyDigest || null } : null,
    observedDifferences: comparisonToBaseline ? {
      baselineSendId: baseline.sendId,
      latestSendId: latest.sendId,
      statusChanged: Boolean(comparisonToBaseline.diff?.statusCode?.changed),
      bodyDigestChanged: baseline.bodyDigest !== latest.bodyDigest,
      diff: comparisonToBaseline.diff,
    } : null,
    nextCommands,
    evidenceCommands: [
      `agent-browser repeater history ${sessionId} --profile ${profile}`,
      `agent-browser repeater diff ${sessionId} --profile ${profile}`,
      `agent-browser repeater evidence ${sessionId} --profile ${profile} --out ./repeater-evidence.json`,
      `agent-browser repeater handoff ${sessionId} --profile ${profile} --out ./repeater-handoff.json`,
      `agent-browser export ${session?.sourceRequestId || "<requestId>"} --profile ${profile} --format json --out ./request.json`,
    ],
    coverage: {
      hasEditableTemplate: Boolean(session?.editable),
      hasBaselineSend: sends.length >= 1,
      hasVariantSend: sends.length >= 2,
      hasBaselineComparison: Boolean(comparisonToBaseline),
      hasClosedAt: Boolean(session?.closedAt),
    },
    boundary: "Repeater diagnose reports local workflow completeness and objective response differences only. It does not decide exploitability or reportability.",
  };
}

function replayResponseSummary(raw) {
  const bodyText = extractBodyText(raw);
  return {
    status: extractStatusCode(raw),
    url: raw.url ?? raw.response?.url ?? null,
    bodyLength: bodyText.length,
    bodyDigest: digestValue(bodyText),
    hasBody: bodyText.length > 0,
    contentType: raw.headers?.["content-type"] ?? raw.headers?.["Content-Type"] ?? raw.response?.headers?.["content-type"] ?? null,
  };
}

function replayBatchSummary(raw) {
  const results = Array.isArray(raw.results)
    ? raw.results
    : (Array.isArray(raw.variants) ? raw.variants : (Array.isArray(raw.responses) ? raw.responses : []));
  const summaries = results.map((entry, index) => {
    const summary = replayResponseSummary(entry);
    return {
      index,
      label: entry.label ?? entry.name ?? `variant-${index + 1}`,
      ...summary,
    };
  });
  return {
    variantCount: summaries.length,
    statusCodes: [...new Set(summaries.map((entry) => entry.status).filter((value) => value !== null && value !== undefined))],
    summaries,
  };
}

function replayResult(raw, requestId, flags, boundary = "Replay uses the page fetch layer. Results may differ from actual browser context.") {
  return {
    schema: "agent-browser.replay.v1",
    requestId,
    profile: raw.profile || flags.profile || "default",
    ...raw,
    replaySummary: replayResponseSummary(raw),
    boundary,
    next: { ...(raw.next || {}), compare: "Save to a file, then: agent-browser compare --left baseline.json --right variant.json" },
  };
}

function replayBatchResult(raw, requestId, flags) {
  return {
    schema: "agent-browser.replay-batch.v1",
    requestId,
    profile: raw.profile || flags.profile || "default",
    ...raw,
    batchSummary: replayBatchSummary(raw),
    boundary: "Replay-batch uses the page fetch layer for each variant.",
    next: { ...(raw.next || {}), compare: "Save individual variant results, then: agent-browser compare --left baseline.json --right variant.json" },
  };
}

async function runRepeaterCommand(server, args, flags) {
  const action = args[1] || "history";
  const profile = flags.profile || "default";
  const now = new Date().toISOString();

  if (action === "list") {
    return listRepeaterSessions(flags);
  }

  if (action === "plan") {
    const requestId = args[2] || flags.requestId;
    if (!requestId) throw new Error("repeater plan requires a requestId");
    return {
      ok: true,
      schema: "agent-browser.repeater.plan.v1",
      profile,
      requestId,
      workflow: [
        {
          step: "inspect-captured-request",
          purpose: "Read the request and payload before editing.",
          commands: [
            `agent-browser request detail ${requestId} --profile ${profile}`,
            `agent-browser request payload ${requestId} --profile ${profile}`,
          ],
        },
        {
          step: "open-repeater-session",
          purpose: "Create a file-backed editable Repeater session anchored to the captured browser request.",
          commands: [
            `agent-browser repeater open ${requestId} --profile ${profile}`,
          ],
        },
        {
          step: "edit-and-send",
          purpose: "Edit one field at a time, send, and keep history.",
          commands: [
            "agent-browser repeater edit <sessionId> --json-body '{...}'",
            "agent-browser repeater send <sessionId>",
            "agent-browser repeater history <sessionId>",
            "agent-browser repeater diff <sessionId>",
          ],
        },
        {
          step: "batch-variants",
          purpose: "Use only when the variants are already known and bounded.",
          commands: [
            `agent-browser replay-batch ${requestId} --profile ${profile} --variants-json '[{"label":"baseline"},{"label":"variant","json":{}}]'`,
          ],
        },
        {
          step: "handoff",
          purpose: "Serialize the captured request for another tool or later import.",
          commands: [
            `agent-browser export ${requestId} --profile ${profile} --format json --out ./request.json`,
            "agent-browser import --file ./request.json --format json --profile <profile>",
          ],
        },
      ],
      boundary: "Repeater plan is a mechanical workflow guide. It does not create variants, send requests, or judge response differences.",
      next: {
        detail: `agent-browser request detail ${requestId} --profile ${profile}`,
        payload: `agent-browser request payload ${requestId} --profile ${profile}`,
        open: `agent-browser repeater open ${requestId} --profile ${profile}`,
      },
    };
  }

  if (action === "open") {
    const requestId = args[2] || flags.requestId;
    if (!requestId) throw new Error("repeater open requires a requestId");
    const [detail, payload] = await Promise.all([
      callRaw(server, "profile_request_detail", { requestId, profile }),
      callRaw(server, "profile_request_payload", { requestId, profile }).catch((error) => ({ payloadReadError: errorMessage(error) })),
    ]);
    const requestTemplate = extractRequestTemplate(detail, payload);
    const sessionId = flags.sessionId || `rep-${randomUUID().slice(0, 8)}`;
    const session = {
      schema: "agent-browser.repeater.session.v1",
      sessionId,
      profile,
      sourceRequestId: requestId,
      createdAt: now,
      updatedAt: now,
      source: { detail, payload },
      editable: applyReplayEdit(requestTemplate.template, flags),
      replayHeaderPolicy: requestTemplate.replayHeaderPolicy,
      sends: [],
      boundary: "Repeater stores editable request state and send history. It does not generate attack variants or decide security impact.",
    };
    writeRepeaterSession(session);
    return {
      ok: true,
      schema: "agent-browser.repeater.open.v1",
      sessionId,
      profile,
      requestId,
      editable: session.editable,
      replayHeaderPolicy: session.replayHeaderPolicy,
      sessionFile: repeaterSessionPath(sessionId),
      next: {
        edit: `agent-browser repeater edit ${sessionId} --profile ${profile} --json-body '{...}'`,
        send: `agent-browser repeater send ${sessionId} --profile ${profile}`,
        history: `agent-browser repeater history ${sessionId} --profile ${profile}`,
        list: `agent-browser repeater list --profile ${profile}`,
      },
    };
  }

  const sessionId = args[2] || flags.sessionId;
  if (!sessionId) throw new Error(`repeater ${action} requires a sessionId`);
  const session = readRepeaterSession(sessionId);

  if (action === "edit") {
    session.editable = applyReplayEdit({ ...(session.editable || {}) }, flags);
    session.updatedAt = now;
    writeRepeaterSession(session);
    return {
      ok: true,
      schema: "agent-browser.repeater.edit.v1",
      sessionId,
      profile: session.profile,
      editable: session.editable,
      next: { send: `agent-browser repeater send ${sessionId} --profile ${session.profile}` },
    };
  }

  if (action === "send") {
    assertProfileLeaseAvailableForCommand("repeater send", flags, session.profile || profile);
    const sendId = `send-${String((session.sends || []).length + 1).padStart(3, "0")}`;
    const previousSend = (session.sends || [])[Math.max(0, (session.sends || []).length - 1)] || null;
    if (session.editable?.headers) {
      const sanitized = sanitizeReplayHeaders(session.editable.headers);
      session.editable.headers = sanitized.headers;
      const removed = Array.from(new Set([
        ...(session.replayHeaderPolicy?.removedBrowserControlledHeaders || []),
        ...sanitized.removed,
      ])).sort((a, b) => String(a).localeCompare(String(b)));
      session.replayHeaderPolicy = {
        ...sanitized.policy,
        sanitized: removed.length > 0,
        removedBrowserControlledHeaders: removed,
      };
    }
    const raw = await callRaw(server, "profile_request_replay", {
      requestId: session.sourceRequestId,
      profile: session.profile,
      ...session.editable,
    });
    const summary = { ...repeaterSendSummary(raw, sendId), sentAt: now, editable: session.editable, replayHeaderPolicy: session.replayHeaderPolicy };
    const comparisonToPrevious = previousSend
      ? buildCompareDiff(previousSend.raw, raw, previousSend.sendId, sendId)
      : null;
    session.sends = [...(session.sends || []), summary];
    session.updatedAt = now;
    writeRepeaterSession(session);
    return {
      ok: true,
      schema: "agent-browser.repeater.send.v1",
      sessionId,
      profile: session.profile,
      send: summary,
      replayHeaderPolicy: session.replayHeaderPolicy,
      comparisonToPrevious,
      repeaterSummary: repeaterWorkflowSummary(session, comparisonToPrevious),
      boundary: "Repeater send stores objective replay evidence and optional previous-send comparison. It does not decide security impact.",
      next: {
        edit: `agent-browser repeater edit ${sessionId} --profile ${session.profile} --json-body '{...}'`,
        diff: `agent-browser repeater diff ${sessionId} --profile ${session.profile}`,
        history: `agent-browser repeater history ${sessionId} --profile ${session.profile}`,
      },
    };
  }

  if (action === "history") {
    return {
      ok: true,
      schema: "agent-browser.repeater.history.v1",
      sessionId,
      profile: session.profile,
      sourceRequestId: session.sourceRequestId,
      editable: session.editable,
      sends: session.sends || [],
      sessionFile: repeaterSessionPath(sessionId),
      repeaterSummary: repeaterWorkflowSummary(session),
    };
  }

  if (action === "diff") {
    const sends = session.sends || [];
    const leftId = flags.left || sends[Math.max(0, sends.length - 2)]?.sendId;
    const rightId = flags.right || sends[Math.max(0, sends.length - 1)]?.sendId;
    const left = sends.find((entry) => entry.sendId === leftId);
    const right = sends.find((entry) => entry.sendId === rightId);
    if (!left || !right) throw new Error("repeater diff requires two existing sends; run repeater send at least twice or pass --left/--right");
    const comparison = buildCompareDiff(left.raw, right.raw, left.sendId, right.sendId);
    return {
      ok: true,
      schema: "agent-browser.repeater.diff.v1",
      sessionId,
      profile: session.profile,
      left: left.sendId,
      right: right.sendId,
      diff: comparison.diff,
      repeaterSummary: repeaterWorkflowSummary(session, comparison),
      boundary: "Diff is objective status/header/body/timing comparison only.",
    };
  }

  if (action === "evidence") {
    return repeaterEvidencePackage(session, flags);
  }

  if (action === "handoff") {
    return await repeaterHandoffPackage(server, session, { ...flags, sessionId });
  }

  if (action === "diagnose") {
    return repeaterDiagnosis(session);
  }

  if (action === "close") {
    const closed = { ...session, closedAt: now };
    writeRepeaterSession(closed);
    return { ok: true, schema: "agent-browser.repeater.close.v1", sessionId, profile: session.profile, sessionFile: repeaterSessionPath(sessionId) };
  }

  throw new Error("repeater action must be plan, open, edit, send, history, diff, diagnose, evidence, handoff, list, or close");
}

async function bookmarkRequest(server, args, flags) {
  const requestId = args[1] || flags.requestId;
  if (!requestId) throw new Error("bookmark requires a requestId");
  const profile = flags.profile || "default";
  const tag = flags.tag ? String(flags.tag) : "default";
  const note = flags.note ? String(flags.note) : "";
  const { detail, payload, template } = await requestTemplateFromCapture(server, requestId, profile);
  const bookmark = {
    bookmarkId: `bm-${randomUUID().slice(0, 8)}`,
    requestId,
    profile,
    tag,
    note,
    createdAt: new Date().toISOString(),
    method: template.method,
    url: template.url,
    bodyDigest: digestValue(template.body || (template.json ? JSON.stringify(template.json) : "")),
    detailPreview: {
      status: detail.status ?? detail.statusCode ?? null,
      resourceType: detail.resourceType ?? detail.type ?? null,
    },
    payloadAvailable: !payload.payloadReadError,
  };
  const bookmarks = [...readBookmarks(), bookmark];
  writeBookmarks(bookmarks);
  return {
    ok: true,
    schema: "agent-browser.bookmark.v1",
    bookmark,
    bookmarkFile: bookmarksFile(),
    next: {
      list: `agent-browser bookmarks list --profile ${profile} --tag ${tag}`,
      exportCurl: `agent-browser export ${requestId} --profile ${profile} --format curl`,
      repeater: `agent-browser repeater open ${requestId} --profile ${profile}`,
    },
  };
}

function listBookmarks(flags) {
  const profile = flags.profile ? String(flags.profile) : null;
  const tag = flags.tag ? String(flags.tag) : null;
  const all = readBookmarks();
  const bookmarks = all.filter((entry) => (!profile || entry.profile === profile) && (!tag || entry.tag === tag));
  return {
    ok: true,
    schema: "agent-browser.bookmarks.list.v1",
    count: bookmarks.length,
    total: all.length,
    filters: { profile, tag },
    bookmarks,
    bookmarkFile: bookmarksFile(),
  };
}

function deleteBookmark(args, flags) {
  const bookmarkId = args[2] || flags.bookmarkId;
  if (!bookmarkId) throw new Error("bookmarks delete requires a bookmarkId");
  const all = readBookmarks();
  const next = all.filter((entry) => entry.bookmarkId !== bookmarkId);
  writeBookmarks(next);
  return {
    ok: true,
    schema: "agent-browser.bookmarks.delete.v1",
    bookmarkId,
    deleted: next.length !== all.length,
    count: next.length,
    bookmarkFile: bookmarksFile(),
  };
}

async function exportRequest(server, args, flags) {
  const requestId = args[1] || flags.requestId;
  if (!requestId) throw new Error("export requires a requestId");
  const profile = flags.profile || "default";
  const format = String(flags.format || "curl").toLowerCase();
  const { detail, payload, template } = await requestTemplateFromCapture(server, requestId, profile);
  let content;
  if (format === "curl") content = formatCurl(template);
  else if (format === "raw") content = formatRawHttp(template);
  else if (format === "json") content = JSON.stringify({ profile, requestId, template, detail, payload }, null, 2);
  else throw new Error("export format must be curl, raw, or json");

  const out = flags.out ? String(flags.out) : null;
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, content, "utf8");
  }
  return {
    ok: true,
    schema: "agent-browser.export.v1",
    profile,
    requestId,
    format,
    ...(out ? { out } : { content }),
    coverage: {
      payloadAvailable: !payload.payloadReadError,
      detailAvailable: true,
      valuesRedacted: false,
    },
    boundary: "Export is a mechanical request serialization for handoff/debugging. It does not judge security impact.",
    next: {
      repeater: `agent-browser repeater open ${requestId} --profile ${profile}`,
      bookmark: `agent-browser bookmark ${requestId} --profile ${profile} --tag interesting`,
    },
  };
}

function templateFromImportContent(content, format, flags) {
  if (format === "json") {
    const parsed = JSON.parse(content);
    if (parsed?.template && typeof parsed.template === "object") {
      return {
        template: parsed.template,
        requestId: flags.requestId || parsed.requestId || null,
        sourceProfile: parsed.profile || null,
      };
    }
    if (parsed?.method || parsed?.url || parsed?.headers || parsed?.body || parsed?.json || parsed?.form) {
      return {
        template: parsed,
        requestId: flags.requestId || parsed.requestId || null,
        sourceProfile: parsed.profile || null,
      };
    }
    throw new Error("import json requires an exported request object with template, or a raw request template object");
  }
  if (format === "raw") {
    return {
      template: parseRawHttpRequest(content, flags.baseUrl),
      requestId: flags.requestId || null,
      sourceProfile: null,
    };
  }
  throw new Error("import format must be json or raw");
}

function importRequest(args, flags) {
  const file = flags.file || args[1];
  if (!file) throw new Error("import requires --file");
  const format = String(flags.format || "json").toLowerCase();
  const profile = flags.profile || "default";
  const content = readFileSync(String(file), "utf8");
  const { template, requestId, sourceProfile } = templateFromImportContent(content, format, flags);
  if (!requestId) {
    throw new Error("import requires --request-id unless the JSON export contains requestId; replay must anchor to a captured browser request");
  }
  const now = new Date().toISOString();
  const sessionId = flags.sessionId || `rep-${randomUUID().slice(0, 8)}`;
  const session = {
    schema: "agent-browser.repeater.session.v1",
    sessionId,
    profile,
    sourceRequestId: requestId,
    createdAt: now,
    updatedAt: now,
    source: {
      importedFile: String(file),
      importFormat: format,
      sourceProfile,
    },
    editable: applyReplayEdit(template, flags),
    sends: [],
    boundary: "Imported requests become Repeater sessions. Sending still replays against the captured browser request id; this tool does not invent browser context.",
  };
  writeRepeaterSession(session);
  return {
    ok: true,
    schema: "agent-browser.import.v1",
    sessionId,
    profile,
    requestId,
    format,
    editable: session.editable,
    sessionFile: repeaterSessionPath(sessionId),
    coverage: {
      sourceRequestIdAvailable: true,
      importedFile: String(file),
      valuesRedacted: false,
    },
    next: {
      edit: `agent-browser repeater edit ${sessionId} --profile ${profile} --json-body '{...}'`,
      send: `agent-browser repeater send ${sessionId} --profile ${profile}`,
      history: `agent-browser repeater history ${sessionId} --profile ${profile}`,
    },
  };
}

function unwrapPostData(payloadResult) {
  const candidate = payloadResult?.postData
    ?? payloadResult?.payload?.postData
    ?? payloadResult?.details?.postData
    ?? payloadResult?.result?.postData;
  return typeof candidate === "string" ? candidate : "";
}

function summarizeGraphqlDocument(value) {
  const documents = Array.isArray(value) ? value : [value];
  return documents.map((entry, index) => {
    const query = typeof entry?.query === "string" ? entry.query : "";
    const variables = entry?.variables && typeof entry.variables === "object" ? entry.variables : {};
    const operationMatch = query.match(/\b(query|mutation|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)?/);
    return {
      index,
      operationType: operationMatch?.[1] || null,
      operationName: entry?.operationName || operationMatch?.[2] || null,
      variableKeys: Object.keys(variables),
      queryPreview: query.replace(/\s+/g, " ").slice(0, 240),
    };
  });
}

function mergeGraphqlVariables(document, variablesPatch) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("graphql replay only supports a single JSON object body");
  }
  return {
    ...document,
    variables: {
      ...(document.variables && typeof document.variables === "object" ? document.variables : {}),
      ...variablesPatch,
    },
  };
}

async function graphqlPayload(server, requestId, flags) {
  const raw = await callRaw(server, "profile_request_payload", withDefaults(flags, { requestId }, ["requestId", "variablesJson"]));
  const postData = unwrapPostData(raw);
  const parsed = tryParseJson(postData);
  return {
    schema: "agent-browser.graphql.payload.v1",
    profile: raw.profile || flags.profile || "default",
    requestId,
    postDataLength: postData.length,
    parseOk: parsed.ok,
    parseError: parsed.error,
    graphql: parsed.ok ? summarizeGraphqlDocument(parsed.value) : [],
    body: parsed.ok ? parsed.value : postData,
    next: {
      replayVariables: `agent-browser graphql replay ${requestId} --profile ${raw.profile || flags.profile || "default"} --variables-json '{...}'`,
      intercept: "agent-browser intercept start --profile <profile> --url-pattern <graphql-url-fragment>",
    },
  };
}

async function graphqlInterceptPlan(server, requestId, flags) {
  const payloadInfo = await graphqlPayload(server, requestId, flags);
  if (!payloadInfo.parseOk) throw new Error(`cannot parse GraphQL body: ${payloadInfo.parseError}`);
  let detail = null;
  try {
    detail = await callRaw(server, "profile_request_detail", withDefaults(flags, { requestId }, ["requestId", "variablesJson"]));
  } catch (error) {
    detail = { unavailable: true, error: String(error?.message || error) };
  }
  const profile = payloadInfo.profile || flags.profile || "default";
  const url = firstDefined(detail?.url, detail?.request?.url, flags.urlPattern, flags.url_pattern, "graphql");
  const method = String(firstDefined(detail?.method, detail?.request?.method, flags.method, "POST")).toUpperCase();
  const urlPattern = flags.urlPattern || flags.url_pattern || networkLookupFragment(url);
  const variablesPatch = flags.variablesJson ? JSON.parse(String(flags.variablesJson)) : {};
  const body = Object.keys(variablesPatch).length
    ? mergeGraphqlVariables(payloadInfo.body, variablesPatch)
    : payloadInfo.body;
  const jsonBody = JSON.stringify(body);
  return {
    ok: true,
    schema: "agent-browser.graphql.intercept-plan.v1",
    profile,
    requestId,
    mode: "cdp-fetch-in-flight",
    source: {
      payloadTool: "profile_request_payload",
      detailTool: detail?.unavailable ? null : "profile_request_detail",
      detailUnavailable: Boolean(detail?.unavailable),
      detailError: detail?.error || null,
      url,
      method,
      urlPattern,
    },
    graphql: payloadInfo.graphql,
    variablesPatchKeys: Object.keys(variablesPatch),
    plannedBodyPreview: jsonBody.length > 2000 ? `${jsonBody.slice(0, 2000)}...` : jsonBody,
    plannedBodyLength: jsonBody.length,
    workflow: [
      {
        step: "arm-intercept",
        command: `agent-browser intercept start --profile ${cliValue(profile)} --url-pattern ${cliValue(urlPattern)}`,
        why: "Pause the next matching real browser request before it leaves the browser.",
      },
      {
        step: "trigger-browser-action",
        command: "Repeat the UI action that naturally sends this GraphQL request.",
        why: "In-flight intercept needs a real browser request with the page cookies and WAF/browser signals.",
      },
      {
        step: "inspect-paused-request",
        command: `agent-browser intercept evidence --profile ${cliValue(profile)}`,
        why: "Read the transient capturedRequestId and confirm the paused method/url/body shape.",
      },
      {
        step: "continue-with-patched-body",
        command: `agent-browser intercept continue <capturedRequestId> --profile ${cliValue(profile)} --json-body ${cliValue(jsonBody)}`,
        why: "Forward the real in-flight browser request with patched GraphQL variables/body.",
      },
      {
        step: "recover-network-request-id",
        command: requestsCommand(profile, { urlContains: urlPattern, method, hasRequestBody: true }),
        why: "After continue, find the durable F12 Network requestId. Do not reuse capturedRequestId for request detail or Repeater.",
      },
      {
        step: "package-evidence",
        command: `agent-browser evidence bundle --profile ${cliValue(profile)} --include-har`,
        why: "Collect objective page, screenshot, network, storage, console/security evidence for handoff.",
      },
    ],
    alternatives: {
      fetchLayerReplay: `agent-browser graphql replay ${requestId} --profile ${cliValue(profile)} --variables-json ${cliValue(JSON.stringify(variablesPatch || {}))}`,
      useReplayWhen: "Use replay for ordinary backend checks where page fetch is representative.",
      useInterceptWhen: "Use in-flight intercept when WAF/browser signals, service-worker routing, or page runtime context matters.",
    },
    idBoundary: {
      requestId: "Durable F12 Network id from a captured request; valid for payload/detail/replay/repeater.",
      capturedRequestId: "Transient CDP Fetch id from a paused in-flight request; valid only for intercept continue/fail while paused.",
      doNotMix: true,
    },
    boundary: "Intercept plan is a mechanical workflow guide. It does not arm interception, send traffic, or decide vulnerability impact.",
  };
}

async function graphqlRequests(server, flags) {
  const defaultInspectLimit = 5;
  const requestedInspectLimit = flags.inspectLimit || flags.inspect_limit;
  const inspectAll = Boolean(flags.inspectAll || flags.inspect_all);
  const inspectLimitFlag = inspectAll ? "all" : Number(requestedInspectLimit || defaultInspectLimit);
  const networkLimit = flags.all ? 1000000 : Number(flags.limit || 50);
  const payload = withDefaults(flags, {
    urlContains: flags.urlContains || flags.url_contains || "graphql",
    method: flags.method || "POST",
    hasRequestBody: flags.hasRequestBody ?? flags.has_request_body ?? true,
    limit: networkLimit,
  }, ["urlContains", "url_contains", "has_request_body", "inspectLimit", "inspect_limit", "inspectAll", "inspect_all", "all"]);
  const result = await callRaw(server, "profile_traffic_query", payload);
  const compact = compactRequestsResult(result, payload);
  const operations = [];
  const inspectLimit = inspectLimitFlag === "all" ? compact.requests.length : inspectLimitFlag;
  const rowsToInspect = compact.requests.slice(0, inspectLimit);
  const skippedRows = compact.requests.slice(inspectLimit);
  const fetchMoreNetworkRows = compact.hasMore ? `agent-browser graphql requests --profile ${compact.profile} --url-contains ${JSON.stringify(payload.urlContains)} --limit ${Math.max(networkLimit * 2, compact.returned + 50)} --inspect-limit ${inspectLimit}` : undefined;
  const fetchAllNetworkRows = compact.hasMore ? `agent-browser graphql requests --profile ${compact.profile} --url-contains ${JSON.stringify(payload.urlContains)} --all --inspect-limit ${inspectLimit}` : undefined;
  const inspectMoreReturnedRows = compact.requests.length > inspectLimit ? `agent-browser graphql requests --profile ${compact.profile} --url-contains ${JSON.stringify(payload.urlContains)} --limit ${networkLimit} --inspect-limit ${compact.requests.length}` : undefined;
  const inspectAllReturnedRows = compact.requests.length > inspectLimit ? `agent-browser graphql requests --profile ${compact.profile} --url-contains ${JSON.stringify(payload.urlContains)} --limit ${networkLimit} --inspect-all` : undefined;
  for (const row of rowsToInspect) {
    if (!row.requestId) continue;
    const payloadInfo = await graphqlPayload(server, row.requestId, { ...flags, profile: compact.profile });
    operations.push({
      ...row,
      parseOk: payloadInfo.parseOk,
      parseError: payloadInfo.parseError,
      graphql: payloadInfo.graphql,
      next: {
        payload: `agent-browser graphql payload ${row.requestId} --profile ${compact.profile}`,
        replayVariables: `agent-browser graphql replay ${row.requestId} --profile ${compact.profile} --variables-json '{...}'`,
      },
    });
  }
  const warnings = [];
  if (compact.hasMore) {
    warnings.push({
      code: "bounded_network_rows",
      severity: "info",
      message: "Only a bounded slice of matching GraphQL Network rows was returned.",
      returned: compact.returned,
      total: compact.total,
      limit: networkLimit,
      next: [fetchMoreNetworkRows, fetchAllNetworkRows].filter(Boolean),
    });
  }
  if (compact.requests.length > inspectLimit) {
    warnings.push({
      code: "bounded_payload_inspection",
      severity: "info",
      message: "Only the first returned GraphQL requests had payloads parsed.",
      inspectedCount: rowsToInspect.length,
      skippedCount: skippedRows.length,
      inspectLimit,
      skippedRequestIds: skippedRows.map((row) => row.requestId).filter(Boolean),
      next: [inspectMoreReturnedRows, inspectAllReturnedRows].filter(Boolean),
    });
  }
  return {
    schema: "agent-browser.graphql.requests.v1",
    profile: compact.profile,
    sourceTool: "profile_traffic_query",
    filtersApplied: payload,
    matchedRequestCount: compact.total,
    returnedRequestCount: compact.returned,
    networkLimit,
    networkHasMore: compact.hasMore,
    truncated: compact.truncated || compact.requests.length > inspectLimit,
    warnings,
    inspectLimit,
    defaultInspectLimit,
    inspectAll,
    count: operations.length,
    skippedPayloadInspectionCount: Math.max(0, compact.requests.length - inspectLimit),
    inspectedRequestIds: rowsToInspect.map((row) => row.requestId).filter(Boolean),
    skippedPayloadInspectionRequestIds: skippedRows.map((row) => row.requestId).filter(Boolean),
    operations,
    coverage: {
      network: compact.coverage,
      payloadInspection: {
        returnedRequestCount: compact.requests.length,
        inspectedCount: operations.length,
        inspectLimit,
        defaultInspectLimit,
        defaultApplied: !inspectAll && requestedInspectLimit === undefined,
        inspectAll,
        inspectedRequestIds: rowsToInspect.map((row) => row.requestId).filter(Boolean),
        skippedRequestIds: skippedRows.map((row) => row.requestId).filter(Boolean),
        skippedPayloadInspectionCount: Math.max(0, compact.requests.length - inspectLimit),
        truncated: compact.requests.length > inspectLimit,
        note: compact.requests.length > inspectLimit
          ? "Only the first inspected requests had payloads parsed. Use --inspect-limit N or --inspect-all to expand more."
          : "Every returned request had payload inspection attempted.",
      },
    },
    mapLogic: "Deterministically filters captured F12 Network rows, then reads each inspected request payload with profile_request_payload and parses JSON GraphQL bodies. This issues one serial payload read per inspected request; use --inspect-limit to cap it.",
    boundary: "Only captured requests with readable postData can expose GraphQL operation and variables.",
    next: {
      fetchMoreNetworkRows,
      fetchAllNetworkRows,
      inspectMoreReturnedRows,
      inspectAllReturnedRows,
    },
  };
}

// ════════════════════════════════════════════════════════════════
// authed-record: SPA crawl + capture + API map + auth classify
// ════════════════════════════════════════════════════════════════

const AUTHRECORD_HARD_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const LOGOUT_TITLE_RE = /\b(login|sign\s*in)\b/i;

async function authedRecord(server, args, flags) {
  const profile = flags.profile;
  if (!profile) throw new Error("authed-record requires --profile");

  const seedUrl = flags.url || null;
  const maxClicks = numberFlag(flags, "maxClicks") ?? 30;
  const maxDepth = numberFlag(flags, "maxDepth") ?? 3;
  const waitMs = numberFlag(flags, "waitMs") ?? 4000;
  const sameOriginOnly = flags.sameOriginOnly !== false;
  const includeAuthDetail = Boolean(flags.includeAuthDetail);
  const output = flags.output || "-";

  const startedAt = Date.now();
  const crawlErrors = [];

  // 1. Start capture (may throw non-fatal "client.on" error — capture still starts)
  let captureStarted = false;
  try {
    await callTool(server, "browser_capture", { profile, action: "start" });
    captureStarted = true;
  } catch (err) {
    // Verify capture actually started despite the error
    try {
      const status = await callTool(server, "browser_capture", { profile, action: "status" });
      if (status?.ok || status?.result?.ok || status?.capture?.enabled) {
        captureStarted = true;
        crawlErrors.push({ type: "capture_start_warning", message: errorMessage(err), note: "Capture running despite error" });
      }
    } catch { /* fall through */ }
    if (!captureStarted) {
      throw new Error(`Failed to start network capture: ${errorMessage(err)}`);
    }
  }

  // 2. Open seed URL (or navigate to profile's current page)
  let effectiveSeedUrl = seedUrl;
  try {
    // browser_open with a URL navigates; without one it just resumes the profile
    const openResult = await callTool(server, "browser_open", {
      profile,
      ...(seedUrl ? { url: seedUrl } : {}),
    });
    const openedUrl = openResult?.url || openResult?.openedUrl || openResult?.navigatedTo;
    if (!effectiveSeedUrl && openedUrl) effectiveSeedUrl = openedUrl;

    // Fallback: if still no URL, eval location.href
    if (!effectiveSeedUrl) {
      try {
        const evalResult = await callRaw(server, "browser_eval", {
          profile,
          expression: "location.href",
          returnByValue: true,
        });
        const href = typeof evalResult?.result === "string" ? evalResult.result
          : (evalResult?.result?.value || "");
        if (href && href.startsWith("http")) effectiveSeedUrl = href;
      } catch { /* best effort */ }
    }
    // Wait for seed page to settle
    await callTool(server, "browser_wait", { profile, waitMs: Math.min(waitMs, 3000) });
  } catch (err) {
    if (captureStarted) {
      try { await callTool(server, "browser_capture", { profile, action: "stop" }); } catch { /* best effort */ }
    }
    throw new Error(`Failed to open seed URL: ${errorMessage(err)}`);
  }

  if (!effectiveSeedUrl) {
    throw new Error("No seed URL — pass --url or ensure the profile has an active page");
  }

  // 3. Run SPA crawl — iterative observe-click on the current page
  const crawlStart = Date.now();
  const seedOrigin = (() => {
    try { return new URL(effectiveSeedUrl || "https://localhost").origin; }
    catch { return null; }
  })();

  let pagesVisited = 1; // seed page counts
  let clicksPerformed = 0;
  let loopPrevented = 0;
  const visited = new Set();

  // Mark seed page as visited
  try { visited.add(new URL(effectiveSeedUrl).pathname); } catch { visited.add(effectiveSeedUrl); }

  // Main loop: repeatedly observe current page and click undiscovered links
  while (clicksPerformed < maxClicks) {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= AUTHRECORD_HARD_TIMEOUT_MS) {
      crawlErrors.push({ type: "timeout", message: `Hard timeout reached after ${Math.round(elapsed / 1000)}s` });
      break;
    }

    // Check for logout
    let observeResult;
    try {
      observeResult = await callTool(server, "browser_observe", { profile, limit: 60 });
    } catch (err) {
      crawlErrors.push({ type: "observe_failed", error: errorMessage(err) });
      break;
    }

    const pageTitle = String(observeResult?.title || "");
    if (LOGOUT_TITLE_RE.test(pageTitle)) {
      crawlErrors.push({ type: "logout_detected", title: pageTitle });
      break;
    }

    // Get current URL
    let currentUrl;
    try {
      const evalResult = await callRaw(server, "browser_eval", {
        profile,
        expression: "location.href",
        returnByValue: true,
      });
      currentUrl = typeof evalResult?.result === "string" ? evalResult.result : (evalResult?.result?.value || "");
    } catch { currentUrl = effectiveSeedUrl; }

    // Record this page as visited
    if (currentUrl) {
      try { visited.add(new URL(currentUrl).pathname); } catch { visited.add(currentUrl); }
    }

    // Wait for API calls to settle
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    if (clicksPerformed >= maxClicks) break;

    // Discover links from current page
    const controls = Array.isArray(observeResult?.controls) ? observeResult.controls : [];
    const links = [];

    for (const ctrl of controls) {
      if (links.length >= maxClicks - clicksPerformed) break;

      const tag = String(ctrl.tag || "").toLowerCase();
      const text = String(ctrl.text || "").trim();
      const href = ctrl.href ? String(ctrl.href) : null;
      const role = String(ctrl.role || "").toLowerCase();
      const disabled = ctrl.disabled === true || ctrl.disabled === "true" || ctrl.disabled === "";

      if (disabled) continue;
      if (/log\s*out|sign\s*out/i.test(text)) continue;

      let targetPath = null;
      let selector = ctrl.selector || null;
      const isClickable = tag === "a" || tag === "button" || role === "button" || role === "link" || role === "menuitem";
      const hasNavText = text.length > 0 && text.length < 60;

      if (selector && isClickable && hasNavText) {
        if (tag === "a" && href && href.length > 1) {
          // Traditional anchor with href
          if (href.startsWith("#") || /^javascript:/i.test(href)) continue;
          let linkOrigin;
          try { linkOrigin = new URL(href, currentUrl || effectiveSeedUrl).origin; } catch { continue; }
          if (sameOriginOnly && linkOrigin !== seedOrigin) continue;
          try { targetPath = new URL(href, currentUrl || effectiveSeedUrl).pathname; } catch { continue; }
        } else {
          // SPA nav link or button — use text as de-dup key
          targetPath = `__spa__${text}`;
        }

        if (!targetPath) continue;
        if (visited.has(targetPath)) { loopPrevented += 1; continue; }

        const isNav = /\b(project|config|secret|member|setting|dashboard|admin|account|billing|team|workplace|integration|log|audit|token|api)\b/i.test(text);
        links.push({ selector, tag, text, targetPath, isNav });
      }
    }

    // Sort: nav first
    links.sort((a, b) => (b.isNav ? 1 : 0) - (a.isNav ? 1 : 0));

    // Click links one by one
    let clickedSomething = false;
    for (const link of links) {
      if (clicksPerformed >= maxClicks) break;
      if (Date.now() - startedAt >= AUTHRECORD_HARD_TIMEOUT_MS) break;

      // Track pre-click URL
      const urlBefore = currentUrl;

      try {
        await callTool(server, "browser_click", {
          profile,
          selector: link.selector,
          waitMode: "spa",
        });
        clicksPerformed += 1;
        clickedSomething = true;
      } catch (err) {
        crawlErrors.push({ type: "click_failed", text: link.text, selector: link.selector, error: errorMessage(err) });
        continue;
      }

      // Wait for SPA to settle + API calls
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Check post-click URL
      let urlAfter;
      try {
        const evalResult = await callRaw(server, "browser_eval", {
          profile,
          expression: "location.href",
          returnByValue: true,
        });
        urlAfter = typeof evalResult?.result === "string" ? evalResult.result : (evalResult?.result?.value || "");
      } catch { urlAfter = urlBefore; }

      // Route change detected — mark visited and break to re-observe the new page
      if (urlAfter && urlAfter !== urlBefore) {
        try { visited.add(new URL(urlAfter).pathname); } catch { visited.add(urlAfter); }
        pagesVisited += 1;
        currentUrl = urlAfter;
        // Break out of link loop to re-observe the new page
        break;
      }
    }

    // If no links were clickable or all clicks failed, stop
    if (!clickedSomething && clicksPerformed === 0) break;
    // If we ran out of undiscovered links and no route change occurred, we may be stuck
    if (!clickedSomething && clicksPerformed > 0) {
      // Try once more with a fresh observe (page might have changed)
      if (links.length === 0) break; // no more links to try
    }
  }

  const crawlEnd = Date.now();

  // 4. Stop capture
  try {
    await callTool(server, "browser_capture", { profile, action: "stop" });
  } catch (err) {
    crawlErrors.push({ type: "capture_stop_failed", error: errorMessage(err) });
  }

  // 5. Build API map
  const analysisStart = Date.now();
  const networkLimit = 1000000;
  const trafficResult = await callRaw(server, "profile_traffic_query", { profile, limit: networkLimit });
  const compact = compactRequestsResult(trafficResult, { profile, limit: networkLimit });

  // Group by endpoint
  const byEndpoint = new Map();
  for (const row of compact.requests) {
    const parts = urlParts(row.url);
    const method = row.method || "GET";
    const key = `${method} ${parts.origin || ""}${parts.path}`;
    const current = byEndpoint.get(key) || {
      method,
      origin: parts.origin,
      path: parts.path,
      kind: endpointKind(row),
      requestIds: [],
      statuses: {},
      queryKeys: new Set(),
      hasRequestBody: false,
      hasResponseBody: false,
    };
    current.requestIds.push(row.requestId);
    if (row.status !== undefined && row.status !== null) {
      current.statuses[String(row.status)] = (current.statuses[String(row.status)] || 0) + 1;
    }
    for (const queryKey of parts.queryKeys) current.queryKeys.add(queryKey);
    current.hasRequestBody = current.hasRequestBody || Boolean(row.hasRequestBody);
    current.hasResponseBody = current.hasResponseBody || Boolean(row.hasResponseBody);
    byEndpoint.set(key, current);
  }

  const allEndpoints = [...byEndpoint.values()].map((entry) => ({
    method: entry.method,
    origin: entry.origin,
    path: entry.path,
    kind: entry.kind,
    requestCount: entry.requestIds.length,
    statuses: entry.statuses,
    queryKeys: [...entry.queryKeys],
    hasRequestBody: entry.hasRequestBody,
    hasResponseBody: entry.hasResponseBody,
    firstRequestId: entry.requestIds.find(Boolean) || null,
  }));

  // Auth classification
  let authSummary = null;
  if (includeAuthDetail) {
    const authResult = await classifyAuthHeaders(server, profile, allEndpoints);
    authSummary = authResult.summary;
    // Merge authType into endpoints
    for (const ep of allEndpoints) {
      ep.authType = authResult.endpointAuth.get(`${ep.method} ${ep.origin || ""}${ep.path}`) || null;
    }
  }

  // Group by domain
  const byDomain = {};
  for (const ep of allEndpoints) {
    const origin = ep.origin || "(unknown)";
    if (!byDomain[origin]) byDomain[origin] = { endpointCount: 0, endpoints: [] };
    byDomain[origin].endpointCount += 1;
    const epOut = { ...ep };
    delete epOut.origin;
    byDomain[origin].endpoints.push(epOut);
  }

  const analysisEnd = Date.now();
  const totalDuration = analysisEnd - startedAt;
  const crawlDuration = crawlEnd - crawlStart;
  const analysisDuration = analysisEnd - analysisStart;

  const result = {
    schema: "agent-browser.authed-record.v1",
    profile,
    seedUrl: effectiveSeedUrl || null,
    duration: {
      total_ms: totalDuration,
      total_s: Math.round(totalDuration / 100) / 10,
      crawl_ms: crawlDuration,
      crawl_s: Math.round(crawlDuration / 100) / 10,
      analysis_ms: analysisDuration,
      analysis_s: Math.round(analysisDuration / 100) / 10,
    },
    crawl: {
      pagesVisited,
      clicksPerformed,
      maxDepth,
      loopPrevented,
      errors: crawlErrors.slice(0, 20),
    },
    apiMap: {
      totalEndpoints: allEndpoints.length,
      byDomain,
    },
    ...(authSummary ? { authSummary } : {}),
    next: {
      drillDown: `agent-browser request detail <id> --profile ${profile}`,
      replay: `agent-browser replay <id> --profile ${profile}`,
      apiMap: `agent-browser api map --profile ${profile}`,
    },
    boundary: "authed-record crawls SPA pages within the same origin and captures API traffic via browser_capture/profile_traffic_query. It classifies auth headers when --include-auth-detail is passed. Hard timeout is 10 minutes. Logout detection stops the crawl early.",
  };

  // Write output
  const jsonStr = JSON.stringify(result, null, 2);
  if (output === "-") {
    console.log(jsonStr);
  } else {
    writeFileSync(output, jsonStr + "\n", "utf8");
    console.log(`authed-record written to ${output}`);
  }

  return ""; // already printed above, return empty string for main() to skip double-print
}

async function classifyAuthHeaders(server, profile, endpoints) {
  const endpointAuth = new Map();
  const byType = {};
  const bearerEndpoints = [];
  const cookieEndpoints = [];

  for (const ep of endpoints) {
    if (!ep.firstRequestId) continue;

    const key = `${ep.method} ${ep.origin || ""}${ep.path}`;
    let authType = null;
    let authHeader = null;

    try {
      const detail = await callRaw(server, "profile_request_detail", {
        profile,
        requestId: ep.firstRequestId,
      });
      const headers = Array.isArray(detail?.requestHeaders) ? detail.requestHeaders : [];

      for (const h of headers) {
        const name = String(h.name || "").toLowerCase();
        if (name === "authorization") {
          authHeader = String(h.value || "");
          if (/^bearer\s/i.test(authHeader)) {
            authType = "bearer";
            bearerEndpoints.push(`${ep.origin || ""}${ep.path}`);
          } else if (/^basic\s/i.test(authHeader)) {
            authType = "basic";
          } else {
            authType = "other";
          }
          break;
        }
        if (name === "cookie" && !authType) {
          authType = "cookie";
        }
      }

      // Fallback: if no auth header found but cookies present, mark as cookie
      if (!authType && headers.some((h) => String(h.name || "").toLowerCase() === "cookie")) {
        authType = "cookie";
      }
    } catch {
      // Request detail failed; leave authType null
    }

    endpointAuth.set(key, authType);
    if (authType) {
      byType[authType] = (byType[authType] || 0) + 1;
    }
  }

  return {
    endpointAuth,
    summary: {
      byType,
      bearerEndpoints,
      cookieEndpoints,
    },
  };
}

function urlParts(value) {
  try {
    const parsed = new URL(value);
    return {
      origin: parsed.origin,
      path: parsed.pathname,
      queryKeys: [...parsed.searchParams.keys()],
    };
  } catch {
    return { origin: null, path: value || "", queryKeys: [] };
  }
}

function endpointKind(row) {
  const url = String(row.url || "").toLowerCase();
  const type = String(row.type || "").toLowerCase();
  if (url.includes("graphql")) return "graphql";
  if (type.includes("websocket") || url.startsWith("ws:") || url.startsWith("wss:")) return "websocket";
  if (type.includes("fetch") || type.includes("xhr")) return "api";
  return type || "request";
}

async function apiMap(server, flags) {
  const networkLimit = flags.all ? 1000000 : Number(flags.limit || 100);
  const payload = withDefaults(flags, {
    limit: networkLimit,
  }, ["all"]);
  const result = await callRaw(server, "profile_traffic_query", payload);
  const compact = compactRequestsResult(result, payload);
  const byEndpoint = new Map();
  for (const row of compact.requests) {
    const parts = urlParts(row.url);
    const method = row.method || "GET";
    const key = `${method} ${parts.origin || ""}${parts.path}`;
    const current = byEndpoint.get(key) || {
      method,
      origin: parts.origin,
      path: parts.path,
      kind: endpointKind(row),
      requestIds: [],
      statuses: {},
      queryKeys: new Set(),
      hasRequestBody: false,
      hasResponseBody: false,
    };
    current.requestIds.push(row.requestId);
    if (row.status !== undefined && row.status !== null) {
      current.statuses[String(row.status)] = (current.statuses[String(row.status)] || 0) + 1;
    }
    for (const queryKey of parts.queryKeys) current.queryKeys.add(queryKey);
    current.hasRequestBody = current.hasRequestBody || Boolean(row.hasRequestBody);
    current.hasResponseBody = current.hasResponseBody || Boolean(row.hasResponseBody);
    byEndpoint.set(key, current);
  }
  const endpoints = [...byEndpoint.values()]
    .map((entry) => {
      const firstRequestId = entry.requestIds.find(Boolean);
      return {
        method: entry.method,
        origin: entry.origin,
        path: entry.path,
        kind: entry.kind,
        requestCount: entry.requestIds.length,
        statuses: entry.statuses,
        queryKeys: [...entry.queryKeys],
        hasRequestBody: entry.hasRequestBody,
        hasResponseBody: entry.hasResponseBody,
        firstRequestId,
        next: firstRequestId ? {
          detail: `agent-browser request detail ${firstRequestId} --profile ${compact.profile}`,
          payload: `agent-browser request payload ${firstRequestId} --profile ${compact.profile}`,
          replay: `agent-browser replay ${firstRequestId} --profile ${compact.profile}`,
          graphql: entry.kind === "graphql" ? `agent-browser graphql payload ${firstRequestId} --profile ${compact.profile}` : undefined,
        } : undefined,
      };
    })
    .sort((a, b) => b.requestCount - a.requestCount);
  return {
    schema: "agent-browser.api.map.v1",
    profile: compact.profile,
    sourceTool: "profile_traffic_query",
    requestCount: compact.returned,
    totalRequestCount: compact.total,
    networkLimit,
    hasMore: compact.hasMore,
    truncated: compact.truncated,
    warnings: compact.warnings,
    endpointCount: endpoints.length,
    endpoints,
    coverage: compact.coverage,
    mapLogic: `Deterministically groups captured F12 Network rows by method + origin + path; query keys, status counts, requestIds, and next commands come from those rows. Input is capped by --limit ${payload.limit} rows; increase --limit for larger captures.`,
    boundary: "This is a structural API map from captured Network rows. It is not a vulnerability assessment.",
    next: {
      fetchMore: compact.hasMore ? `agent-browser api map --profile ${compact.profile} --limit ${Math.max(networkLimit * 2, compact.returned + 100)}` : undefined,
      fetchAll: compact.hasMore ? `agent-browser api map --profile ${compact.profile} --all` : undefined,
    },
  };
}

function normalizeFormFields(value) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (Array.isArray(parsed)) {
    return parsed.map((entry) => ({
      selector: entry.selector,
      text: entry.text ?? entry.value ?? "",
      pressEnter: Boolean(entry.pressEnter),
    }));
  }
  if (parsed && typeof parsed === "object") {
    return Object.entries(parsed).map(([selector, text]) => ({ selector, text: String(text), pressEnter: false }));
  }
  throw new Error("form fill expects --fields-json as object or array");
}

async function formFill(server, flags) {
  if (!flags.fieldsJson && !flags.fields) throw new Error("form fill requires --fields-json");
  const fields = normalizeFormFields(flags.fieldsJson || flags.fields);
  const steps = [];
  for (const field of fields) {
    if (!field.selector) throw new Error("form field missing selector");
    const result = await callTool(server, "browser_type", withDefaults(flags, {
      selector: stripOuterQuotes(field.selector),
      text: field.text,
      pressEnter: field.pressEnter,
    }, ["fieldsJson", "fields"]));
    steps.push({ action: "type", selector: field.selector, ok: result.ok !== false, result });
  }
  return {
    schema: "agent-browser.form.fill.v1",
    profile: flags.profile || "default",
    count: steps.length,
    steps,
  };
}

async function runWorkflowStep(server, step, inherited = {}) {
  const action = step.action || step.command;
  const profileDefaults = inherited.profile && !step.profile ? { profile: inherited.profile } : {};
  const params = { ...profileDefaults, ...step };
  delete params.action;
  delete params.command;
  if (action === "open" || action === "navigate") return await callTool(server, "browser_open", params);
  if (action === "click") return await callTool(server, "browser_click", params);
  if (action === "hover") return await callTool(server, "browser_hover", params);
  if (["dblclick", "double-click", "double_click"].includes(action)) return await callTool(server, "browser_double_click", params);
  if (action === "drag") return await callTool(server, "browser_drag", params);
  if (action === "type") return await callTool(server, "browser_type", params);
  if (action === "fill") return await callTool(server, "browser_type", { ...params, clear: params.clear !== false });
  if (action === "press") return await callTool(server, "browser_press", params);
  if (action === "select") return await callTool(server, "browser_select", params);
  if (action === "wait") return await callTool(server, "browser_wait", params);
  if (action === "upload") return await callTool(server, "browser_upload", params);
  if (action === "scroll") return await callTool(server, "browser_scroll", params);
  if (action === "screenshot") {
    if (params.includeImage === undefined) params.includeImage = false;
    return await callTool(server, "browser_screenshot", params);
  }
  if (action === "snapshot") return await callTool(server, "browser_snapshot", params);
  if (action === "form.fill") return await formFill(server, { ...profileDefaults, fieldsJson: JSON.stringify(step.fields || step.fieldsJson || {}) });
  throw new Error(`unsupported workflow action: ${action}`);
}

function validateWorkflow(workflow) {
  const steps = Array.isArray(workflow) ? workflow : (workflow && typeof workflow === "object" ? workflow.steps : null);
  if (!Array.isArray(steps)) return { valid: false, error: "workflow must be an array or {steps:[...]}", stepIndex: -1 };
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const action = step.action || step.command;
    if (!action) return { valid: false, error: "step missing action field", stepIndex: i };
    if (action === "upload") {
      if (!step.file && !step.files) return { valid: false, error: "upload step requires file or files field", stepIndex: i };
    }
    if (action === "type") {
      if (!step.selector) return { valid: false, error: "type step requires selector field", stepIndex: i };
      if (step.text === undefined && step.value === undefined) return { valid: false, error: "type step requires text or value field", stepIndex: i };
    }
    if (action === "fill") {
      if (!step.selector) return { valid: false, error: "fill step requires selector field", stepIndex: i };
      if (step.text === undefined && step.value === undefined) return { valid: false, error: "fill step requires text or value field", stepIndex: i };
    }
    if (action === "hover") {
      if (!step.selector && !step.text && (step.x === undefined || step.y === undefined)) {
        return { valid: false, error: "hover step requires selector, text, or x/y", stepIndex: i };
      }
    }
    if (["dblclick", "double-click", "double_click"].includes(action)) {
      if (!step.selector && !step.text && (step.x === undefined || step.y === undefined)) {
        return { valid: false, error: "dblclick step requires selector, text, or x/y", stepIndex: i };
      }
    }
    if (action === "drag") {
      const hasSource = step.selector || step.text || (step.x !== undefined && step.y !== undefined);
      const hasTarget = step.targetSelector || step.toSelector || step.targetText || step.toText
        || (step.toX !== undefined && step.toY !== undefined)
        || step.deltaX !== undefined || step.deltaY !== undefined;
      if (!hasSource) return { valid: false, error: "drag step requires source selector, text, or x/y", stepIndex: i };
      if (!hasTarget) return { valid: false, error: "drag step requires target selector, text, to-x/y, or delta", stepIndex: i };
    }
    if (action === "press") {
      if (!step.key) return { valid: false, error: "press step requires key field", stepIndex: i };
    }
    if (action === "select") {
      if (!step.selector) return { valid: false, error: "select step requires selector field", stepIndex: i };
      if (step.value === undefined && step.label === undefined && step.index === undefined && step.checked === undefined) {
        return { valid: false, error: "select step requires one of value, label, index, or checked", stepIndex: i };
      }
    }
    if (action === "wait") {
      if (!step.selector && !step.text && !step.urlContains && step.timeoutMs === undefined) {
        return { valid: false, error: "wait step requires at least one of selector, text, urlContains, or timeoutMs", stepIndex: i };
      }
    }
  }
  return { valid: true, steps };
}

function workflowFromFlags(flags) {
  if (!flags.file && !flags.workflowJson) throw new Error("workflow requires --file or --workflow-json");
  return flags.file ? JSON.parse(readFileSync(String(flags.file), "utf8")) : JSON.parse(String(flags.workflowJson));
}

function workflowDiagnose(flags) {
  const workflow = workflowFromFlags(flags);
  const validation = validateWorkflow(workflow);
  const steps = validation.valid ? validation.steps : (Array.isArray(workflow) ? workflow : (Array.isArray(workflow?.steps) ? workflow.steps : []));
  const actionCounts = {};
  for (const step of steps) {
    const action = step?.action || step?.command || "<missing>";
    actionCounts[action] = (actionCounts[action] || 0) + 1;
  }
  const hasWait = steps.some((step) => (step?.action || step?.command) === "wait");
  const hasEvidenceStep = steps.some((step) => ["screenshot", "snapshot"].includes(step?.action || step?.command));
  const hasPreflight = flags.preflight === true || Boolean(!Array.isArray(workflow) && workflow?.preflight);
  const blockers = validation.valid ? [] : ["workflow-invalid"];
  const warnings = [];
  if (validation.valid && !hasWait) warnings.push({ code: "no-explicit-wait", message: "Workflow has no wait step; add one after navigation or submission when page state matters." });
  if (validation.valid && !hasEvidenceStep) warnings.push({ code: "no-evidence-step", message: "Workflow has no screenshot/snapshot step; add one when the result must be handed off." });
  if (validation.valid && !hasPreflight) warnings.push({ code: "no-profile-preflight", message: "Workflow run will not acquire/check a profile lease unless --preflight or workflow.preflight is set." });
  return {
    ok: validation.valid,
    schema: "agent-browser.workflow.diagnose.v1",
    state: validation.valid ? (warnings.length ? "valid-with-warnings" : "valid") : "invalid",
    profile: (Array.isArray(workflow) ? null : workflow?.profile) || flags.profile || "default",
    stepCount: steps.length,
    actionCounts,
    blockers,
    warnings,
    validation,
    workflowSummary: {
      state: validation.valid ? (warnings.length ? "valid-with-warnings" : "valid") : "invalid",
      hasWait,
      hasEvidenceStep,
      hasPreflight,
      nextCommands: validation.valid
        ? [
            flags.file ? `agent-browser workflow run --file ${flags.file} --preflight --owner <agent-name> --acquire-lease` : "agent-browser workflow run --workflow-json '<json>' --preflight --owner <agent-name> --acquire-lease",
            flags.file ? `agent-browser workflow run --file ${flags.file} --validate-only` : "agent-browser workflow run --workflow-json '<json>' --validate-only",
          ]
        : [
            flags.file ? `agent-browser workflow diagnose --file ${flags.file}` : "agent-browser workflow diagnose --workflow-json '<json>'",
          ],
      evidence: {
        checkedStructure: true,
        checkedActionRequirements: true,
        checkedPreflightDeclaration: true,
        source: flags.file ? String(flags.file) : "inline workflow json",
      },
      boundary: "Workflow diagnose validates deterministic browser-action structure only. It does not execute actions or decide whether the business/security task succeeded.",
    },
  };
}

function workflowStepFlags(step = {}, inherited = {}) {
  const profile = step.profile || inherited.profile || "default";
  return {
    ...step,
    profile,
    selector: step.selector || step.targetSelector,
    text: step.text || step.targetText,
    expectUrlContains: step.expectUrlContains || step.urlContains,
    expectRequestUrlContains: step.expectRequestUrlContains || step.requestUrlContains,
  };
}

function workflowStepRecovery(step = {}, index = 0, inherited = {}, error = null) {
  const action = step.action || step.command || "<missing>";
  const flags = workflowStepFlags(step, inherited);
  const diagnoseCommand = actionDiagnoseRecoveryCommand([action], flags);
  const profile = flags.profile || "default";
  const nextCommands = [];
  if (diagnoseCommand) nextCommands.push(diagnoseCommand);
  nextCommands.push(`agent-browser workflow diagnose --file <workflow.json>`);
  nextCommands.push(`agent-browser observe --profile ${cliValue(profile)}`);
  nextCommands.push(`agent-browser stuck --profile ${cliValue(profile)}`);
  nextCommands.push(`agent-browser see screenshot --profile ${cliValue(profile)}`);
  nextCommands.push(`agent-browser evidence bundle --profile ${cliValue(profile)} --include-har`);
  return {
    kind: diagnoseCommand ? "browser-action-diagnose" : "workflow-step-diagnose",
    stepIndex: index,
    action,
    command: diagnoseCommand || `agent-browser workflow diagnose --file <workflow.json>`,
    nextCommands: [...new Set(nextCommands)],
    error: error ? {
      code: classifyCliError(error),
      message: errorMessage(error),
    } : null,
    boundary: "Workflow recovery reports the failed deterministic browser step and objective next diagnostics. It does not retry the step or decide task success.",
  };
}

async function workflowFailureEvidence(server, profile, failedStep, flags = {}) {
  if (flags.evidenceOnFailure !== true) {
    return {
      collected: false,
      command: `agent-browser workflow run --file <workflow.json> --evidence-on-failure`,
      reason: "Pass --evidence-on-failure to collect an objective evidence bundle automatically when a workflow step fails.",
    };
  }
  try {
    const bundle = await callTool(server, "browser_evidence_bundle", {
      profile,
      includeHar: true,
      includeScreenshot: true,
      save: true,
      label: `workflow-failure-step-${failedStep?.index ?? "unknown"}`,
    });
    return {
      collected: true,
      schema: "agent-browser.workflow.failure-evidence.v1",
      profile,
      failedStepIndex: failedStep?.index ?? null,
      bundle,
      boundary: "Failure evidence is an objective browser evidence bundle collected after a workflow step failed. It does not judge task success.",
    };
  } catch (error) {
    return {
      collected: false,
      error: {
        code: classifyCliError(error),
        message: errorMessage(error),
      },
      nextCommands: [
        `agent-browser evidence bundle --profile ${cliValue(profile)} --include-har`,
        `agent-browser see screenshot --profile ${cliValue(profile)}`,
      ],
      boundary: "Failure evidence collection failed; the workflow failure result remains valid.",
    };
  }
}

async function runWorkflow(server, flags) {
  const workflow = workflowFromFlags(flags);
  const validation = validateWorkflow(workflow);
  if (flags.validateOnly) return validation;
  if (!validation.valid) {
    const error = new Error(`workflow validation failed at step ${validation.stepIndex}: ${validation.error}`);
    error.validation = validation;
    throw error;
  }
  const steps = validation.steps;
  const inherited = { profile: (Array.isArray(workflow) ? null : workflow.profile) || flags.profile };
  const workflowPreflight = !Array.isArray(workflow) ? workflow.preflight : null;
  const shouldPreflight = flags.preflight === true || Boolean(workflowPreflight);
  if (!shouldPreflight) {
    const profiles = new Set([inherited.profile || "default"]);
    for (const step of steps) profiles.add(step.profile || inherited.profile || "default");
    for (const profile of profiles) assertProfileLeaseAvailableForCommand("workflow run", flags, profile);
  }
  let preflight = null;
  if (shouldPreflight) {
    const workflowPreflightFlags = workflowPreflight && typeof workflowPreflight === "object" ? workflowPreflight : {};
    preflight = await profilePreflight(server, {
      ...flags,
      ...workflowPreflightFlags,
      profile: inherited.profile || flags.profile || workflowPreflightFlags.profile,
      owner: flags.owner || workflowPreflightFlags.owner || defaultLeaseOwner(),
      purpose: flags.purpose || workflowPreflightFlags.purpose || "workflow-run",
    });
    if (preflight.ok === false) {
      return {
        schema: "agent-browser.workflow.run.v1",
        profile: inherited.profile || "default",
        stepCount: steps.length,
        completedCount: 0,
        ok: false,
        state: "preflight-blocked",
        preflight,
        results: [],
        boundary: "Workflow preflight blocked execution before browser actions. It does not decide business/security success.",
      };
    }
  }
  const results = [];
  let failedStep = null;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    try {
      const result = await runWorkflowStep(server, step, inherited);
      const ok = result.ok !== false;
      const entry = { index, action: step.action || step.command, ok, result };
      if (!ok) {
        entry.recovery = workflowStepRecovery(step, index, inherited);
        failedStep ||= entry;
      }
      results.push(entry);
      if (!ok && step.continueOnError !== true) break;
    } catch (error) {
      const entry = {
        index,
        action: step.action || step.command,
        ok: false,
        error: errorMessage(error),
        recovery: workflowStepRecovery(step, index, inherited, error),
      };
      failedStep ||= entry;
      results.push(entry);
      if (step.continueOnError !== true) break;
    }
  }
  const allOk = results.every((entry) => entry.ok);
  const profile = inherited.profile || "default";
  const failureEvidence = allOk ? null : await workflowFailureEvidence(server, profile, failedStep, flags);
  return {
    schema: "agent-browser.workflow.run.v1",
    profile,
    stepCount: steps.length,
    completedCount: results.length,
    ok: allOk,
    state: allOk ? "completed" : "failed",
    preflight,
    failedStep: failedStep ? {
      index: failedStep.index,
      action: failedStep.action,
      error: failedStep.error || null,
      recovery: failedStep.recovery || null,
    } : null,
    failureEvidence,
    results,
    workflowSummary: {
      state: allOk ? "completed" : "failed",
      failedStepIndex: failedStep?.index ?? null,
      failedAction: failedStep?.action || null,
      nextCommands: failedStep?.recovery?.nextCommands || [
        "agent-browser workflow diagnose --file <workflow.json>",
        `agent-browser observe --profile ${cliValue(profile)}`,
      ],
      evidence: {
        retainedCompletedSteps: true,
        failedStepStructured: Boolean(failedStep),
        preflightRan: Boolean(preflight),
        failureEvidenceCollected: Boolean(failureEvidence?.collected),
        failureEvidenceAvailable: Boolean(failureEvidence),
      },
      boundary: "Workflow summary preserves deterministic step results and recovery commands. It does not decide business or security success.",
    },
    boundary: "Workflow runs deterministic browser actions. It does not decide business success unless the workflow includes explicit wait/screenshot/check steps.",
  };
}

// ---------------------------------------------------------------------------
// Download watcher — bounded local directory poll
// Boundary: watches the OS default Downloads folder (or --dir override).
// It does not use CDP Page.setDownloadBehavior; a future worker tool could
// replace this with event-driven detection.
// ---------------------------------------------------------------------------

function defaultDownloadsDir() {
  if (process.platform === "win32") {
    return join(homedir(), "Downloads");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Downloads");
  }
  return join(homedir(), "Downloads");
}

function snapshotDir(dir) {
  if (!existsSync(dir)) return new Map();
  const entries = new Map();
  try {
    for (const name of readdirSync(dir)) {
      try {
        const st = statSync(join(dir, name));
        if (st.isFile()) entries.set(name, { size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // skip unreadable entries
      }
    }
  } catch {
    // skip unreadable dir
  }
  return entries;
}

function isIncompleteDownload(name) {
  return name.endsWith(".crdownload") || name.endsWith(".part") || name.endsWith(".tmp");
}

function newCompleteFiles(before, after) {
  const result = [];
  for (const [name, info] of after) {
    if (isIncompleteDownload(name)) continue;
    const prior = before.get(name);
    if (!prior || prior.mtimeMs !== info.mtimeMs || prior.size !== info.size) {
      result.push(name);
    }
  }
  return result;
}

function downloadDirState(dir, entries) {
  const files = [...entries.entries()].map(([name, info]) => ({
    name,
    path: join(dir, name),
    size: info.size,
    mtimeMs: info.mtimeMs,
    incomplete: isIncompleteDownload(name),
  }));
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return {
    recentFiles: files.slice(0, 10),
    incompleteFiles: files.filter((file) => file.incomplete),
  };
}

function downloadSummary(result = {}, { profile = "default", action = "poll", dir = null } = {}) {
  const completed = Array.isArray(result.completed) ? result.completed : [];
  const incompleteFiles = Array.isArray(result.incompleteFiles) ? result.incompleteFiles : [];
  let state = result.state || "unknown";
  if (!result.state && action === "start") state = result.ok === false ? "start-failed" : "watching";
  if (!result.state && action === "stop") state = result.ok === false ? "stop-failed" : "stopped";
  if (!result.state && action === "status") state = completed.length > 0 ? "completed" : "watching";
  const watchDir = result.watchDir || result.downloadPath || dir || null;
  const nextCommands = [];
  if (state === "missing-dir" || state === "not-directory" || state === "unreadable" || state === "unwritable") {
    nextCommands.push(`agent-browser download doctor --profile ${profile} --dir <actual-download-dir>`);
  } else if (state === "ready") {
    nextCommands.push(`agent-browser download start --profile ${profile}${watchDir ? ` --dir ${watchDir}` : ""}`);
    nextCommands.push(`Trigger the browser download, then run: agent-browser download status --profile ${profile}`);
  } else if (state === "watching") {
    nextCommands.push(`Trigger the browser download, then run: agent-browser download status --profile ${profile}`);
  } else if (state === "in-progress") {
    nextCommands.push(`agent-browser download --profile ${profile}${watchDir ? ` --dir ${watchDir}` : ""} --timeout-ms 60000`);
    nextCommands.push(`agent-browser download status --profile ${profile}`);
  } else if (state === "completed") {
    nextCommands.push("Use the completed file path from files[] or completed[].");
  } else {
    nextCommands.push(`agent-browser download doctor --profile ${profile}${watchDir ? ` --dir ${watchDir}` : " --dir <download-dir>"}`);
  }
  return {
    state,
    profile,
    action,
    watchDir,
    completedCount: completed.length || (Array.isArray(result.files) ? result.files.length : 0),
    incompleteCount: incompleteFiles.length,
    recentFileCount: Array.isArray(result.recentFiles) ? result.recentFiles.length : 0,
    evidence: {
      hasDirectoryCheck: "exists" in result || "isDirectory" in result || "readable" in result || "writable" in result,
      hasCdpDownloadEvents: Array.isArray(result.completed) || Array.isArray(result.inProgress) || Array.isArray(result.events),
      hasPollingSnapshot: Array.isArray(result.recentFiles) || Array.isArray(result.incompleteFiles),
      sourceFields: ["state", "files", "completed", "incompleteFiles", "recentFiles", "exists", "readable", "writable"],
    },
    coverage: {
      truncated: false,
      note: "Download summary reports observed local directory or CDP download-watch evidence only. The watcher must start before the browser download to see CDP events.",
    },
    nextCommands,
  };
}

function downloadDoctor(flags) {
  const profile = flags.profile || "default";
  const dir = flags.dir ? String(flags.dir) : defaultDownloadsDir();
  const suggestedNext = [];
  let exists = existsSync(dir);
  let isDirectory = false;
  let readable = false;
  let writable = false;
  let accessError = null;
  let state = "ready";
  let dirState = { recentFiles: [], incompleteFiles: [] };
  if (!exists) {
    state = "missing-dir";
    suggestedNext.push(`agent-browser download doctor --profile ${profile} --dir <actual-download-dir>`);
    suggestedNext.push(`agent-browser download start --profile ${profile} --dir <actual-download-dir>`);
  } else {
    try {
      const st = statSync(dir);
      isDirectory = st.isDirectory();
      if (!isDirectory) {
        state = "not-directory";
        suggestedNext.push(`agent-browser download doctor --profile ${profile} --dir <download-directory>`);
      } else {
        accessSync(dir, fsConstants.R_OK);
        readable = true;
        accessSync(dir, fsConstants.W_OK);
        writable = true;
        dirState = downloadDirState(dir, snapshotDir(dir));
        if (dirState.incompleteFiles.length > 0) {
          state = "in-progress";
          suggestedNext.push(`agent-browser download --profile ${profile} --dir ${dir} --timeout-ms 60000`);
        } else {
          suggestedNext.push(`agent-browser download start --profile ${profile} --dir ${dir}`);
          suggestedNext.push(`Trigger the browser download, then run: agent-browser download status --profile ${profile}`);
        }
      }
    } catch (error) {
      accessError = errorMessage(error);
      state = readable ? "unwritable" : "unreadable";
      suggestedNext.push(`Choose a readable/writable download directory, then run: agent-browser download doctor --profile ${profile} --dir <download-dir>`);
    }
  }
  const result = {
    schema: "agent-browser.download.doctor.v1",
    ok: exists && isDirectory && readable && writable,
    profile,
    watchDir: dir,
    state,
    exists,
    isDirectory,
    readable,
    writable,
    accessError,
    ...dirState,
    boundary: "Download doctor checks local directory readiness only. It does not start a browser download or listen for CDP download events.",
    suggestedNext,
  };
  return {
    ...result,
    downloadSummary: downloadSummary(result, { profile, action: "doctor", dir }),
  };
}

async function waitForDownload(dir, timeoutMs) {
  const before = snapshotDir(dir);
  const deadline = Date.now() + timeoutMs;
  const pollMs = 800;
  let after = before;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    after = snapshotDir(dir);
    const found = newCompleteFiles(before, after);
    if (found.length > 0) {
      return { ok: true, files: found.map((name) => join(dir, name)), ...downloadDirState(dir, after) };
    }
  }
  const state = downloadDirState(dir, after);
  const hasIncomplete = state.incompleteFiles.length > 0;
  return {
    ok: false,
    files: [],
    state: hasIncomplete ? "in-progress" : "timeout",
    reason: hasIncomplete
      ? `timeout after ${timeoutMs}ms — incomplete download file still present in ${dir}`
      : `timeout after ${timeoutMs}ms — no new complete files in ${dir}`,
    ...state,
  };
}

async function browserDownload(server, flags) {
  const profile = flags.profile || "default";
  const dir = flags.dir ? String(flags.dir) : defaultDownloadsDir();
  const timeoutMs = numberFlag(flags, "timeoutMs") ?? 30000;
  if (timeoutMs <= 0) throw new Error("--timeout-ms must be greater than 0");
  if (!existsSync(dir)) {
    const result = {
      schema: "agent-browser.download.v1",
      ok: false,
      profile,
      watchDir: dir,
      files: [],
      state: "missing-dir",
      reason: `download directory does not exist: ${dir}`,
      boundary: "Specify --dir to point at the correct download folder for this browser profile.",
      suggestedNext: [
        `agent-browser download --profile ${profile} --dir <actual-download-dir>`,
        `agent-browser screenshot --profile ${profile}`,
      ],
    };
    return {
      ...result,
      downloadSummary: downloadSummary(result, { profile, action: "poll", dir }),
    };
  }
  const result = await waitForDownload(dir, timeoutMs);
  const out = {
    schema: "agent-browser.download.v1",
    ok: result.ok,
    profile,
    watchDir: dir,
    files: result.files,
    state: result.ok ? "completed" : result.state || "timeout",
    incompleteFiles: result.incompleteFiles || [],
    recentFiles: result.recentFiles || [],
    ...(result.reason ? { reason: result.reason } : {}),
    boundary: [
      "This watcher polls the local downloads folder; it does not intercept the CDP download event.",
      "If the browser saves files elsewhere, pass --dir <path>.",
    ].join(" "),
    suggestedNext: result.ok
      ? result.files.map((file) => `Use downloaded file: ${file}`)
      : result.incompleteFiles?.length > 0
        ? [`Download appears in progress. Wait longer or retry: agent-browser download --profile ${profile} --dir ${dir} --timeout-ms ${Math.max(timeoutMs, 60000)}`]
        : [`Confirm the browser download path, then retry: agent-browser download --profile ${profile} --dir <download-dir>`],
  };
  return {
    ...out,
    downloadSummary: downloadSummary(out, { profile, action: "poll", dir }),
  };
}

async function browserDownloadWatch(server, action, flags) {
  const profile = flags.profile || "default";
  const payload = {
    action,
    profile,
    ...(flags.dir ? { dir: String(flags.dir), downloadPath: String(flags.dir) } : {}),
  };
  const result = await callTool(server, "browser_download_watch", payload);
  return {
    ...result,
    downloadSummary: downloadSummary(result, { profile, action, dir: payload.downloadPath || payload.dir || null }),
  };
}

async function downloadDiagnose(server, flags) {
  const profile = flags.profile || "default";
  const dir = flags.dir ? String(flags.dir) : defaultDownloadsDir();
  const doctor = downloadDoctor({ ...flags, profile, dir });
  let watchStatus = null;
  try {
    watchStatus = await browserDownloadWatch(server, "status", { ...flags, profile, dir });
  } catch (error) {
    watchStatus = {
      ok: false,
      error: errorMessage(error),
      downloadSummary: {
        state: "watch-status-unavailable",
        profile,
        action: "status",
        watchDir: dir,
        nextCommands: [`agent-browser download start --profile ${profile} --dir ${dir}`],
        evidence: { hasCdpDownloadEvents: false },
      },
    };
  }
  const blockers = [];
  if (doctor.ok === false) blockers.push(`download-dir-${doctor.state || "not-ready"}`);
  if (doctor.ok === true && doctor.downloadSummary?.state === "in-progress") blockers.push("download-local-in-progress");
  if (watchStatus.ok === false) blockers.push("download-watch-status-unavailable");
  const watchState = watchStatus.downloadSummary?.state || watchStatus.state || "unknown";
  const state = watchState === "completed"
    ? "completed"
    : (blockers.length
      ? "not-ready"
      : (watchState === "watching" ? "watching-ready" : "ready"));
  const nextCommands = [];
  nextCommands.push(...(doctor.downloadSummary?.nextCommands || doctor.suggestedNext || []));
  nextCommands.push(...(watchStatus.downloadSummary?.nextCommands || []));
  if (state === "ready") nextCommands.push(`agent-browser download start --profile ${profile} --dir ${dir}`);
  if (state === "watching-ready") nextCommands.push(`agent-browser download status --profile ${profile}`);
  return {
    ok: blockers.length === 0,
    schema: "agent-browser.download.diagnose.v1",
    profile,
    dir,
    state,
    blockers,
    checks: {
      doctor,
      watchStatus,
    },
    downloadSummary: {
      state,
      profile,
      action: "diagnose",
      watchDir: dir,
      completedCount: watchStatus.downloadSummary?.completedCount || 0,
      incompleteCount: doctor.downloadSummary?.incompleteCount || 0,
      nextCommands: Array.from(new Set(nextCommands)),
      evidence: {
        checkedDirectory: true,
        checkedCdpWatchStatus: true,
        directoryState: doctor.downloadSummary?.state || doctor.state || null,
        watchState,
      },
      boundary: "Download diagnose combines local directory state and CDP download watcher status. It does not trigger a download or infer app export success.",
    },
  };
}

// ---------------------------------------------------------------------------
// Auth bootstrap — operator-assisted auth state machine
// ---------------------------------------------------------------------------

function authBootstrapSummary({ action, raw, noSuccessConditionConfigured, configuredSuccessConditions, profile = "default", conditionSuffix = "" }) {
  const success = Boolean(raw?.success);
  let state = "pending";
  if (action === "start") state = "operator-action-needed";
  else if (success) state = "complete";
  else if (noSuccessConditionConfigured) state = "missing-success-condition";
  else state = "pending-success-condition";
  const nextCommands = state === "operator-action-needed"
    ? [
        `agent-browser stuck --profile ${profile}`,
        `agent-browser auth bootstrap status --profile ${profile}${conditionSuffix}`,
        `agent-browser screenshot --profile ${profile}`,
      ]
    : (state === "complete"
      ? [
          `agent-browser profile registry get --profile ${profile}`,
          `agent-browser capture start --profile ${profile} --label authenticated-work`,
        ]
      : (state === "missing-success-condition"
        ? [
            `agent-browser auth bootstrap status --profile ${profile} --success-url-contains <post-login-path>`,
            `agent-browser auth bootstrap status --profile ${profile} --success-selector <authenticated-selector>`,
            `agent-browser auth bootstrap status --profile ${profile} --success-cookie-names <cookie-name>`,
          ]
        : [
            `agent-browser stuck --profile ${profile}`,
            `agent-browser auth bootstrap status --profile ${profile}${conditionSuffix}`,
            `agent-browser observe --profile ${profile}`,
          ]));
  return {
    state,
    success,
    configuredSuccessConditions,
    noSuccessConditionConfigured,
    nextCommands,
    evidence: {
      hasChecks: Boolean(raw?.checks),
      hasWorkerNext: Boolean(raw?.next),
      successUrlContains: raw?.checks?.successUrlContains ?? null,
      successSelector: raw?.checks?.successSelector ?? null,
      successCookieNames: raw?.checks?.successCookieNames ?? [],
      configuredSuccessConditions,
      sourceFields: ["success", "checks", "next"],
    },
    coverage: {
      truncated: false,
      note: "Auth summary observes configured success conditions only. It does not infer password correctness, MFA state, or anti-abuse scoring.",
    },
    nextAction: state === "operator-action-needed"
      ? "Complete login/MFA/passkey in the visible browser, then run status."
      : (state === "complete"
        ? "Continue with this authenticated profile."
        : (state === "missing-success-condition"
          ? "Run status again with --success-url-contains, --success-selector, or --success-cookie-names."
          : "Check the visible browser, then run status again with the same success condition.")),
  };
}

async function authBootstrap(server, args, flags) {
  const profile = flags.profile || "default";
  const explicitAction = String(args[2] || flags.action || "").toLowerCase();
  const loginUrl = flags.loginUrl || flags.url;
  const successUrlContains = flags.successUrlContains || flags["success-url-contains"];
  const successSelector = flags.successSelector || flags["success-selector"];
  const successCookieNames = flags.successCookieNames || flags["success-cookie-names"];
  const successCookieNameList = successCookieNames ? splitListFlag(successCookieNames) : [];
  const action = ["start", "status", "finish"].includes(explicitAction)
    ? explicitAction
    : (loginUrl ? "start" : "status");
  if (action === "start" && !loginUrl) {
    throw new Error("auth bootstrap start requires --url or --login-url");
  }
  const payload = {
    action,
    profile,
    ...(loginUrl ? { loginUrl: String(loginUrl) } : {}),
    ...(successUrlContains ? { successUrlContains: String(successUrlContains) } : {}),
    ...(successSelector ? { successSelector: String(successSelector) } : {}),
    ...(successCookieNameList.length ? { successCookieNames: successCookieNameList } : {}),
    ...(flags.label ? { label: String(flags.label) } : {}),
    ...(flags.stopCaptureOnSuccess !== undefined ? { stopCaptureOnSuccess: coerceFlagValue(flags.stopCaptureOnSuccess) } : {}),
    ...(flags.waitMs !== undefined ? { waitMs: numberFlag(flags, "waitMs") } : {}),
  };
  const raw = await callTool(server, "browser_auth_bootstrap", payload);
  const conditionArgs = [
    successUrlContains ? `--success-url-contains ${JSON.stringify(String(successUrlContains))}` : "",
    successSelector ? `--success-selector ${JSON.stringify(String(successSelector))}` : "",
    successCookieNameList.length ? `--success-cookie-names ${JSON.stringify(successCookieNameList.join(","))}` : "",
  ].filter(Boolean).join(" ");
  const conditionSuffix = conditionArgs ? ` ${conditionArgs}` : "";
  const noSuccessConditionConfigured = Boolean(raw?.checks?.noSuccessConditionConfigured);
  const configuredSuccessConditions = Array.isArray(raw?.checks?.configuredSuccessConditions)
    ? raw.checks.configuredSuccessConditions
    : [
      successUrlContains ? "url" : "",
      successSelector ? "selector" : "",
      successCookieNameList.length ? "cookies" : "",
    ].filter(Boolean);
  const authSummary = authBootstrapSummary({ action, raw, noSuccessConditionConfigured, configuredSuccessConditions, profile, conditionSuffix });
  return {
    schema: "agent-browser.auth.bootstrap.v1",
    ok: raw?.ok !== false,
    profile,
    action,
    loginUrl: loginUrl ? String(loginUrl) : null,
    authComplete: Boolean(raw?.success),
    authSummary,
    ...raw,
    instructions: action === "start"
      ? "Login page opened and capture started. Complete password, MFA, passkey, or anti-abuse checks in the visible browser, then run auth bootstrap status or finish."
      : (raw?.success
        ? "Success condition matched. Continue with this authenticated profile."
        : (noSuccessConditionConfigured
          ? "No explicit success condition was configured. Run status again with --success-url-contains, --success-selector, or --success-cookie-names."
          : "Success condition has not matched yet. Check the visible browser and run status again.")),
    next: {
      ...(raw?.next ? { workerNext: raw.next } : {}),
      status: `agent-browser auth bootstrap status --profile ${profile}${conditionSuffix}`,
      finish: `agent-browser auth bootstrap finish --profile ${profile}${conditionSuffix}`,
      screenshot: `agent-browser screenshot --profile ${profile}`,
    },
  };
}

async function authDiagnose(server, flags) {
  const profile = flags.profile || "default";
  const conditionArgs = [
    flags.successUrlContains || flags["success-url-contains"] ? `--success-url-contains ${JSON.stringify(String(flags.successUrlContains || flags["success-url-contains"]))}` : "",
    flags.successSelector || flags["success-selector"] ? `--success-selector ${JSON.stringify(String(flags.successSelector || flags["success-selector"]))}` : "",
    flags.successCookieNames || flags["success-cookie-names"] ? `--success-cookie-names ${JSON.stringify(String(flags.successCookieNames || flags["success-cookie-names"]))}` : "",
  ].filter(Boolean).join(" ");
  const status = await authBootstrap(server, ["auth", "bootstrap", "status"], { ...flags, profile });
  let doctor = null;
  try {
    doctor = await profileDoctor(server, { ...flags, profile });
  } catch (error) {
    doctor = { ok: false, error: errorMessage(error) };
  }
  let stuck = null;
  try {
    const rawStuck = await callTool(server, "browser_stuck", { profile });
    stuck = {
      ...rawStuck,
      stuckSummary: stuckSummary(rawStuck, { profile }),
    };
  } catch (error) {
    stuck = { ok: false, error: errorMessage(error) };
  }

  const blockers = [];
  if (doctor?.ok === false || doctor?.profileState?.found === false) blockers.push("profile-not-ready");
  if (doctor?.profileLease?.status === "leased-by-other") blockers.push("profile-leased-by-other");
  if (status.authSummary?.state === "missing-success-condition") blockers.push("auth-missing-success-condition");
  if (status.authComplete !== true && status.authSummary?.state && status.authSummary.state !== "missing-success-condition") {
    blockers.push(`auth-${status.authSummary.state}`);
  }
  if (stuck?.error) blockers.push("stuck-check-failed");
  const stuckState = stuck?.stuckSummary?.state || null;
  if (stuckState && stuckState !== "no-obvious-blocker") blockers.push(`page-${stuckState}`);

  const state = status.authComplete === true
    ? "complete"
    : (status.authSummary?.state === "missing-success-condition"
      ? "missing-success-condition"
      : (stuckState && stuckState !== "no-obvious-blocker"
        ? stuckState
        : "pending"));
  const nextCommands = [
    ...(doctor?.suggestedNext || []),
    ...(status.authSummary?.nextCommands || []),
    ...(stuck?.stuckSummary?.nextCommands || []),
  ];
  if (conditionArgs) nextCommands.push(`agent-browser auth diagnose --profile ${profile} ${conditionArgs}`);
  else nextCommands.push(`agent-browser auth diagnose --profile ${profile} --success-url-contains <post-login-path>`);

  return {
    ok: status.authComplete === true && blockers.length === 0,
    schema: "agent-browser.auth.diagnose.v1",
    profile,
    state,
    authComplete: status.authComplete === true,
    blockers: Array.from(new Set(blockers)),
    checks: {
      doctor,
      status,
      stuck,
    },
    authSummary: {
      state,
      profile,
      configuredSuccessConditions: status.authSummary?.configuredSuccessConditions || [],
      noSuccessConditionConfigured: status.authSummary?.noSuccessConditionConfigured === true,
      stuckState,
      nextCommands: Array.from(new Set(nextCommands)),
      evidence: {
        checkedProfileDoctor: Boolean(doctor),
        checkedAuthStatus: Boolean(status),
        checkedStuck: Boolean(stuck),
        hasSuccessChecks: Boolean(status.checks),
        authState: status.authSummary?.state || null,
      },
      boundary: "Auth diagnose observes profile readiness, configured success conditions, and visible page blockers. It does not enter credentials, bypass MFA, inject cookies, or infer password correctness.",
    },
  };
}

// ---------------------------------------------------------------------------
// Profile registry — local metadata store (no secrets)
// The registry file stores public-safe metadata: project, platform, account.
// It lives at $CDP_SECURITY_DATA_DIR/profile-meta.json (default ~/.agent-browser-runtime/profile-meta.json).
// ---------------------------------------------------------------------------

function profileMetaFile() {
  return join(RUNTIME_DATA_DIR, "profile-meta.json");
}

function readProfileMeta() {
  const file = profileMetaFile();
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // empty or missing
  }
  return {};
}

function writeProfileMeta(data) {
  const file = profileMetaFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function profileConfigFile(flags = {}) {
  return String(
    flags.config ||
    process.env.CDP_BROWSER_PROFILE_CONFIG ||
    join(RUNTIME_DATA_DIR, "browser-profiles.json"),
  );
}

function readJsonFileNoBom(file) {
  return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function profilePortSummaryFromConfig(config, configPath, canonicalCdpPort) {
  const profiles = config?.browser?.profiles && typeof config.browser.profiles === "object"
    ? config.browser.profiles
    : {};
  const ports = {};
  const mismatchedProfiles = [];
  for (const [name, record] of Object.entries(profiles)) {
    const port = Number(record?.cdpPort);
    const key = Number.isFinite(port) ? String(port) : "missing";
    ports[key] = (ports[key] || 0) + 1;
    if (Number.isFinite(port) && port !== canonicalCdpPort) {
      mismatchedProfiles.push({ profile: name, cdpPort: port });
    }
  }
  return {
    ok: mismatchedProfiles.length === 0,
    state: mismatchedProfiles.length === 0 ? "canonical" : "port-drift",
    configPath,
    canonicalCdpPort,
    totalProfiles: Object.keys(profiles).length,
    mismatchedCount: mismatchedProfiles.length,
    mismatchedProfiles: mismatchedProfiles.slice(0, 50),
    ports,
    boundary: "Profile port status reads local runtime routing metadata only. It does not inspect cookies, storage, login state, or vulnerability impact.",
  };
}

async function profilePortsCommand(server, args, flags = {}) {
  const action = args[2] || "status";
  if (!["status", "repair"].includes(action)) throw new Error("profile ports action must be status or repair");
  let health = null;
  try {
    health = await requestJson(`${server}/health`);
  } catch {
    // Local config repair can still run when the worker is down.
  }
  const canonicalCdpPort = Number(flags.to || flags.port || flags.cdpPort || health?.cdpPort || 9222);
  const configPath = String(flags.config || health?.configPath || profileConfigFile(flags));
  let config = null;
  try {
    config = readJsonFileNoBom(configPath);
  } catch (error) {
    return {
      ok: false,
      schema: "agent-browser.profile.ports.v1",
      action,
      state: "config-unreadable",
      configPath,
      canonicalCdpPort,
      error: String(error?.message || error),
      suggestedNext: [`Check that ${configPath} exists and contains JSON.`],
      boundary: "Profile ports only repairs local routing metadata.",
    };
  }
  const before = profilePortSummaryFromConfig(config, configPath, canonicalCdpPort);
  if (action === "status") {
    return {
      ok: before.ok,
      schema: "agent-browser.profile.ports.v1",
      action,
      ...before,
      suggestedNext: before.ok ? [] : [`agent-browser profile ports repair --to ${canonicalCdpPort} --config ${JSON.stringify(configPath)}`],
    };
  }

  const originalConfigText = readFileSync(configPath, "utf8");
  const backupPath = `${configPath}.bak-profile-ports-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const changedProfiles = [];
  for (const [name, record] of Object.entries(config?.browser?.profiles || {})) {
    if (record && record.cdpPort !== undefined && Number(record.cdpPort) !== canonicalCdpPort) {
      changedProfiles.push({ profile: name, from: record.cdpPort, to: canonicalCdpPort });
      record.cdpPort = canonicalCdpPort;
    }
  }
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(backupPath, originalConfigText, "utf8");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const after = profilePortSummaryFromConfig(config, configPath, canonicalCdpPort);
  return {
    ok: after.ok,
    schema: "agent-browser.profile.ports.v1",
    action,
    configPath,
    backupPath,
    changedCount: changedProfiles.length,
    changedProfiles: changedProfiles.slice(0, 50),
    before,
    after,
    suggestedNext: ["agent-browser doctor", "agent-browser backend status"],
    boundary: "Profile port repair updates local routing metadata only. It does not move cookies, tabs, or browser contexts.",
  };
}

function profileLeaseFile() {
  return join(RUNTIME_DATA_DIR, "profile-leases.json");
}

function readProfileLeases() {
  const file = profileLeaseFile();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return (parsed && typeof parsed === "object" && parsed.leases && typeof parsed.leases === "object")
      ? parsed
      : { leases: {} };
  } catch {
    return { leases: {} };
  }
}

function writeProfileLeases(data) {
  const file = profileLeaseFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function defaultLeaseOwner() {
  return process.env.AGENT_BROWSER_OWNER || process.env.CLAUDE_SESSION_ID || process.env.CODEX_SESSION_ID || process.env.USERNAME || process.env.USER || "agent";
}

function pruneProfileLeases(state, now = new Date()) {
  const leases = {};
  for (const [profile, lease] of Object.entries(state.leases || {})) {
    const expiresAt = Date.parse(lease?.expiresAt || lease?.expires_at || "");
    if (Number.isFinite(expiresAt) && expiresAt > now.getTime()) {
      leases[profile] = lease;
    }
  }
  return { leases };
}

function profileLeaseSummary({ action, profile = null, owner = null, lease = null, conflict = null, activeLeases = [] }) {
  const state = conflict ? "conflict"
    : (lease ? "leased"
      : (activeLeases.length ? "active-leases" : "no-active-lease"));
  return {
    state,
    action,
    profile,
    owner,
    activeLeaseCount: activeLeases.length,
    conflict,
    nextCommands: conflict
      ? [
          `agent-browser profile lease status --profile ${profile}`,
          `agent-browser profile lease release --profile ${profile} --owner <current-owner>`,
          `agent-browser profile lease acquire --profile ${profile} --owner ${owner || "<owner>"} --force`,
        ]
      : (lease
        ? [
            `agent-browser profile resume ${profile}`,
            `agent-browser profile lease status --profile ${profile}`,
            `agent-browser profile lease release --profile ${profile} --owner ${owner || lease.owner || "<owner>"}`,
          ]
        : ["agent-browser profile lease acquire --profile <profile> --owner <agent-name>"]),
    evidence: {
      source: "local profile lease file",
      leaseFile: profileLeaseFile(),
      fieldsChecked: ["profile", "owner", "expiresAt", "purpose"],
    },
    boundary: "Profile lease is a local coordination guard. It does not lock Chrome itself; agents must honor the lease before using a profile.",
  };
}

function profileLeaseStatusForProfile(profile, flags = {}) {
  const owner = String(flags.owner || defaultLeaseOwner());
  const state = pruneProfileLeases(readProfileLeases(), new Date());
  const lease = state.leases?.[profile] || null;
  const conflict = lease && lease.owner !== owner
    ? { profile, currentOwner: lease.owner || null, expiresAt: lease.expiresAt || null }
    : null;
  const status = lease
    ? (conflict ? "leased-by-other" : "leased-by-current-owner")
    : "available";
  return {
    status,
    profile,
    owner,
    lease,
    conflict,
    leaseFile: profileLeaseFile(),
    profileLeaseSummary: profileLeaseSummary({ action: "doctor", profile, owner, lease, conflict }),
    boundary: "Profile lease is a local coordination guard. It does not lock Chrome itself; agents must honor the lease before using a profile.",
  };
}

function assertProfileLeaseAvailableForCommand(command, flags = {}, profile = null) {
  const effectiveProfile = String(profile || flags.profile || "default");
  const owner = String(flags.owner || defaultLeaseOwner());
  const status = profileLeaseStatusForProfile(effectiveProfile, { owner });
  if (status.status !== "leased-by-other") return status;
  const error = new Error(`profile ${effectiveProfile} is leased by ${status.conflict?.currentOwner || "another owner"}`);
  error.code = "profile_lease_conflict";
  error.profileLeaseGuard = {
    ok: false,
    schema: "agent-browser.profile.lease.guard.v1",
    command,
    profile: effectiveProfile,
    owner,
    leaseStatus: status,
    blockers: ["profile-leased-by-other"],
    nextCommands: status.profileLeaseSummary?.nextCommands || [
      `agent-browser profile lease status --profile ${effectiveProfile}`,
      `agent-browser profile preflight ${effectiveProfile} --owner ${owner}`,
    ],
    boundary: "The CLI blocked this browser action before it reached the worker because another agent owns the local profile lease.",
  };
  throw error;
}

async function guardedCallTool(server, tool, payload, flags = {}, command = tool) {
  assertProfileLeaseAvailableForCommand(command, flags, payload?.profile || flags.profile || "default");
  // Wave-8: auto-inject backend from profile binding (non-open commands).
  if (tool !== "browser_open") {
    const profileName = payload?.profile || flags.profile;
    if (profileName) injectBackendIntoPayload(profileName, payload);
  }
  return await callTool(server, tool, payload);
}

function profileLeaseCommand(args, flags = {}) {
  const action = args[2] || "status";
  const profile = flags.profile || args[3] || null;
  const owner = String(flags.owner || defaultLeaseOwner());
  const ttlSeconds = numberFlag(flags, "ttlSeconds") ?? 1800;
  const force = flags.force === true;
  const now = new Date();
  const state = pruneProfileLeases(readProfileLeases(), now);
  let leases = { ...(state.leases || {}) };

  if (action === "list") {
    const activeLeases = Object.entries(leases).map(([leaseProfile, lease]) => ({ profile: leaseProfile, ...lease }));
    return {
      ok: true,
      schema: "agent-browser.profile.lease.list.v1",
      count: activeLeases.length,
      activeLeases,
      leaseFile: profileLeaseFile(),
      profileLeaseSummary: profileLeaseSummary({ action, owner, activeLeases }),
    };
  }

  if (!profile) throw new Error(`profile lease ${action} requires --profile`);

  if (action === "status") {
    const statusResult = profileLeaseStatusForProfile(profile, { owner });
    return {
      ok: true,
      schema: "agent-browser.profile.lease.status.v1",
      profile,
      owner,
      status: statusResult.status,
      lease: statusResult.lease,
      conflict: statusResult.conflict,
      leaseFile: profileLeaseFile(),
      profileLeaseSummary: statusResult.profileLeaseSummary,
      boundary: statusResult.boundary,
    };
  }

  if (action === "acquire") {
    if (ttlSeconds <= 0) throw new Error("--ttl-seconds must be greater than 0");
    const existing = leases[profile] || null;
    const sameOwner = existing?.owner === owner;
    if (existing && !sameOwner && !force) {
      const conflict = { profile, currentOwner: existing.owner || null, expiresAt: existing.expiresAt || null };
      return {
        ok: false,
        schema: "agent-browser.profile.lease.acquire.v1",
        profile,
        owner,
        lease: existing,
        conflict,
        leaseFile: profileLeaseFile(),
        profileLeaseSummary: profileLeaseSummary({ action, profile, owner, lease: existing, conflict }),
      };
    }
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
    const lease = {
      profile,
      owner,
      purpose: flags.purpose ? String(flags.purpose) : null,
      acquiredAt: now.toISOString(),
      expiresAt,
      ttlSeconds,
      forced: force && existing && !sameOwner,
    };
    leases[profile] = lease;
    writeProfileLeases({ leases });
    return {
      ok: true,
      schema: "agent-browser.profile.lease.acquire.v1",
      profile,
      owner,
      lease,
      previousLease: force ? existing : null,
      leaseFile: profileLeaseFile(),
      profileLeaseSummary: profileLeaseSummary({ action, profile, owner, lease }),
    };
  }

  if (action === "release") {
    const existing = leases[profile] || null;
    const sameOwner = existing?.owner === owner;
    if (existing && !sameOwner && !force) {
      const conflict = { profile, currentOwner: existing.owner || null, expiresAt: existing.expiresAt || null };
      return {
        ok: false,
        schema: "agent-browser.profile.lease.release.v1",
        profile,
        owner,
        lease: existing,
        conflict,
        leaseFile: profileLeaseFile(),
        profileLeaseSummary: profileLeaseSummary({ action, profile, owner, lease: existing, conflict }),
      };
    }
    if (existing) {
      delete leases[profile];
      writeProfileLeases({ leases });
    }
    return {
      ok: true,
      schema: "agent-browser.profile.lease.release.v1",
      profile,
      owner,
      released: Boolean(existing),
      previousLease: existing,
      leaseFile: profileLeaseFile(),
      profileLeaseSummary: profileLeaseSummary({ action, profile, owner }),
    };
  }

  throw new Error("profile lease action must be acquire, status, release, or list");
}

function profileRegistrySet(flags) {
  const profile = flags.profile;
  if (!profile) throw new Error("profile registry set requires --profile");
  const data = readProfileMeta();
  const existing = (typeof data[profile] === "object" && data[profile] !== null) ? data[profile] : {};
  const updated = { ...existing };
  if (flags.project !== undefined) updated.project = String(flags.project);
  if (flags.platform !== undefined) updated.platform = String(flags.platform);
  if (flags.account !== undefined) updated.account = String(flags.account);
  if (flags.target !== undefined) updated.target = String(flags.target);
  if (flags.role !== undefined) updated.role = String(flags.role);
  updated.updatedAt = new Date().toISOString();
  data[profile] = updated;
  writeProfileMeta(data);
  const validation = validateProfileRegistryEntry(profile, updated);
  return { ok: validation.ok, profile, meta: updated, validation, metaFile: profileMetaFile() };
}

function profileRegistryGet(flags) {
  const profile = flags.profile;
  if (!profile) throw new Error("profile registry get requires --profile");
  const data = readProfileMeta();
  const meta = data[profile] || null;
  return { ok: meta !== null, profile, meta, metaFile: profileMetaFile() };
}

function profileRegistryDelete(flags) {
  const profile = flags.profile;
  if (!profile) throw new Error("profile registry delete requires --profile");
  const data = readProfileMeta();
  const previous = data[profile] || null;
  if (previous) {
    delete data[profile];
    writeProfileMeta(data);
  }
  return {
    ok: true,
    schema: "agent-browser.profile.registry.delete.v1",
    profile,
    deleted: previous !== null,
    previous,
    metaFile: profileMetaFile(),
    boundary: "Deletes local profile registry metadata only. It does not delete the browser profile, cookies, downloads, or captured evidence.",
    next: {
      list: "agent-browser profile registry list",
      validate: previous?.target ? `agent-browser profile registry validate --target ${previous.target}` : "agent-browser profile registry validate",
    },
  };
}

function splitCsvFlag(value) {
  if (value === undefined || value === null || value === true || value === false) return [];
  return String(value).split(",").map((entry) => entry.trim()).filter(Boolean);
}

function profileRegistryList(flags = {}) {
  const data = readProfileMeta();
  const target = flags.target ? String(flags.target) : null;
  const role = flags.role ? String(flags.role) : null;
  const entries = Object.entries(data)
    .map(([profile, meta]) => ({ profile, ...meta }))
    .filter((entry) => (!target || entry.target === target) && (!role || entry.role === role));
  return {
    ok: true,
    count: entries.length,
    total: Object.keys(data).length,
    filters: { target, role },
    profiles: entries,
    metaFile: profileMetaFile(),
  };
}

const PROFILE_REQUIRED_FIELDS = ["project", "platform", "account"];
const PROFILE_SECRET_FIELD_PATTERN = /(password|passwd|pwd|secret|token|cookie|jwt|session|apikey|apiKey|privateKey)/i;

function validateProfileRegistryEntry(profile, meta) {
  const issues = [];
  const warnings = [];
  if (!profile || typeof profile !== "string") {
    issues.push({ code: "missing-profile", message: "Profile name is required." });
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    issues.push({ code: "invalid-meta", message: "Profile metadata must be an object." });
  } else {
    for (const field of PROFILE_REQUIRED_FIELDS) {
      if (typeof meta[field] !== "string" || meta[field].trim() === "") {
        issues.push({ code: `missing-${field}`, field, message: `${field} is required for agent handoff.` });
      }
    }
    for (const key of Object.keys(meta)) {
      if (PROFILE_SECRET_FIELD_PATTERN.test(key)) {
        issues.push({
          code: "secret-like-field",
          field: key,
          message: "Profile registry stores public metadata only. Do not store passwords, cookies, tokens, or session material here.",
        });
      }
    }
    if (typeof meta.account === "string" && meta.account.length > 160) {
      warnings.push({ code: "long-account", field: "account", message: "Account label is unusually long; prefer a short operator-safe identifier." });
    }
  }
  return { ok: issues.length === 0, issues, warnings };
}

function profileRegistryValidationSummary({ entries, invalidCount, targetFilter, requiredRoles, missingRoles, uniqueRoles, duplicateRoles }) {
  const duplicateRoleCount = duplicateRoles.length;
  let state = "ready";
  if (invalidCount > 0) {
    state = "invalid-metadata";
  } else if (missingRoles.length > 0) {
    state = "missing-roles";
  } else if (uniqueRoles && duplicateRoleCount > 0) {
    state = "duplicate-roles";
  } else if (duplicateRoleCount > 0) {
    state = "duplicate-role-warning";
  }
  const target = targetFilter || "<target>";
  const profiles = entries.map((entry) => entry.profile).filter(Boolean);
  const nextCommands = [];
  if (state === "ready") {
    nextCommands.push("agent-browser profile list");
    if (profiles.length >= 2) {
      nextCommands.push(`agent-browser profile isolation check --profiles ${profiles.join(",")} --url <target-url>`);
    } else if (profiles.length === 1) {
      nextCommands.push(`agent-browser profile doctor --profile ${profiles[0]}`);
    }
  } else {
    for (const role of missingRoles) {
      nextCommands.push(`agent-browser profile registry set --profile ${target}-${role}-auth --project <project> --platform <platform> --account <account-label> --target ${target} --role ${role}`);
    }
    for (const duplicate of duplicateRoles) {
      nextCommands.push(`agent-browser profile registry delete --profile <stale-${duplicate.role}-profile>`);
    }
    if (invalidCount > 0) {
      nextCommands.push("agent-browser profile registry list");
    }
    nextCommands.push(`agent-browser profile registry validate --target ${target} --require-roles ${requiredRoles.length ? requiredRoles.join(",") : "attacker,victim"} --unique-roles`);
  }
  return {
    state,
    target: targetFilter,
    requiredRoles,
    uniqueRoles,
    invalidCount,
    missingRoles,
    duplicateRoleCount,
    profileCount: entries.length,
    readyForTwoAccount: invalidCount === 0 && missingRoles.length === 0 && duplicateRoleCount === 0 && entries.length >= Math.max(requiredRoles.length, 2),
    nextCommands,
    evidence: {
      source: "local profile registry metadata",
      fieldsChecked: ["project", "platform", "account", "target", "role"],
      secretLikeFieldsRejected: true,
    },
    boundary: "This summary checks local metadata only. Run profile isolation check to compare live browser storage between profiles.",
  };
}

function profileRegistryValidate(flags) {
  const data = readProfileMeta();
  const profileFilter = flags.profile;
  const targetFilter = flags.target ? String(flags.target) : null;
  const requiredRoles = splitCsvFlag(flags.requireRoles || flags.requiredRoles);
  const uniqueRoles = flags.uniqueRoles === true;
  const entries = Object.entries(data)
    .filter(([profile, meta]) => (!profileFilter || profile === profileFilter) && (!targetFilter || meta?.target === targetFilter))
    .map(([profile, meta]) => ({
      profile,
      meta,
      validation: validateProfileRegistryEntry(profile, meta),
    }));
  if (profileFilter && entries.length === 0) {
    entries.push({
      profile: String(profileFilter),
      meta: null,
      validation: {
        ok: false,
        issues: [{ code: "profile-not-registered", message: "No registry metadata exists for this profile." }],
        warnings: [],
      },
    });
  }
  const invalidCount = entries.filter((entry) => !entry.validation.ok).length;
  const presentRoles = [...new Set(entries.map((entry) => entry.meta?.role).filter((role) => typeof role === "string" && role.trim() !== ""))];
  const missingRoles = targetFilter && requiredRoles.length > 0
    ? requiredRoles.filter((role) => !presentRoles.includes(role))
    : [];
  const profilesByRole = new Map();
  for (const entry of entries) {
    const role = entry.meta?.role;
    if (typeof role !== "string" || role.trim() === "") continue;
    const current = profilesByRole.get(role) || [];
    current.push({ profile: entry.profile, account: entry.meta?.account || null });
    profilesByRole.set(role, current);
  }
  const duplicateRoles = [...profilesByRole.entries()]
    .filter(([, profiles]) => profiles.length > 1)
    .map(([role, profiles]) => ({ role, profiles }));
  const duplicateRoleCount = duplicateRoles.length;
  const roleCoverage = targetFilter && requiredRoles.length > 0
    ? {
        ok: missingRoles.length === 0 && (!uniqueRoles || duplicateRoleCount === 0),
        target: targetFilter,
        requiredRoles,
        presentRoles,
        missingRoles,
        uniqueRoles,
        duplicateRoles,
        profiles: entries.map((entry) => ({ profile: entry.profile, role: entry.meta?.role || null, account: entry.meta?.account || null })),
      }
    : null;
  const suggestedNext = [];
  if (invalidCount === 0 && missingRoles.length === 0 && (!uniqueRoles || duplicateRoleCount === 0)) {
    suggestedNext.push("agent-browser profile list", "agent-browser profile doctor --profile <profile>");
  } else {
    suggestedNext.push("agent-browser profile registry set --profile <profile> --project <project> --platform <platform> --account <account> --target <target> --role <role>");
    for (const role of missingRoles) {
      suggestedNext.push(`agent-browser profile registry set --profile ${targetFilter}-${role}-auth --project <project> --platform <platform> --account <account-label> --target ${targetFilter} --role ${role}`);
    }
    for (const duplicate of duplicateRoles) {
      suggestedNext.push(`Review duplicate role '${duplicate.role}' for target '${targetFilter}': ${duplicate.profiles.map((entry) => entry.profile).join(", ")}`);
      suggestedNext.push(`If one entry is stale metadata, remove it with: agent-browser profile registry delete --profile <stale-profile>`);
    }
  }
  return {
    schema: "agent-browser.profile.registry.validate.v1",
    ok: invalidCount === 0 && missingRoles.length === 0 && (!uniqueRoles || duplicateRoleCount === 0),
    count: entries.length,
    invalidCount,
    roleCoverage,
    profiles: entries,
    metaFile: profileMetaFile(),
    boundary: "Registry validation checks public handoff metadata only; it does not inspect browser cookies, passwords, or login state.",
    validationSummary: profileRegistryValidationSummary({ entries, invalidCount, targetFilter, requiredRoles, missingRoles, uniqueRoles, duplicateRoles }),
    suggestedNext,
  };
}

function profileRegistryMatrix(flags = {}) {
  const data = readProfileMeta();
  const targetFilter = flags.target ? String(flags.target) : null;
  const requiredRoles = splitCsvFlag(flags.requireRoles || flags.requiredRoles);
  const entries = Object.entries(data)
    .map(([profile, meta]) => ({ profile, meta: (meta && typeof meta === "object") ? meta : {} }))
    .filter((entry) => !targetFilter || entry.meta?.target === targetFilter);
  const profilesByRole = new Map();
  const unassignedProfiles = [];
  for (const entry of entries) {
    const role = typeof entry.meta?.role === "string" && entry.meta.role.trim() ? entry.meta.role.trim() : "";
    const view = {
      profile: entry.profile,
      account: entry.meta?.account || null,
      platform: entry.meta?.platform || null,
      project: entry.meta?.project || null,
      target: entry.meta?.target || null,
      updatedAt: entry.meta?.updatedAt || null,
    };
    if (!role) {
      unassignedProfiles.push(view);
      continue;
    }
    const current = profilesByRole.get(role) || [];
    current.push(view);
    profilesByRole.set(role, current);
  }
  const roles = [...profilesByRole.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([role, profiles]) => ({
      role,
      count: profiles.length,
      profiles,
      duplicate: profiles.length > 1,
    }));
  const presentRoles = roles.map((entry) => entry.role);
  const missingRoles = requiredRoles.filter((role) => !presentRoles.includes(role));
  const duplicateRoles = roles.filter((entry) => entry.duplicate).map((entry) => ({
    role: entry.role,
    profiles: entry.profiles.map((profile) => ({ profile: profile.profile, account: profile.account })),
  }));
  const suggestedNext = [];
  if (targetFilter && requiredRoles.length > 0) {
    suggestedNext.push(`agent-browser profile registry validate --target ${targetFilter} --require-roles ${requiredRoles.join(",")} --unique-roles`);
  }
  for (const role of missingRoles) {
    suggestedNext.push(`agent-browser profile registry set --profile ${targetFilter || "<target>"}-${role}-auth --project <project> --platform <platform> --account <account-label> --target ${targetFilter || "<target>"} --role ${role}`);
  }
  for (const duplicate of duplicateRoles) {
    suggestedNext.push(`Review duplicate role '${duplicate.role}': ${duplicate.profiles.map((entry) => entry.profile).join(", ")}`);
  }
  if (entries.length >= 2) {
    suggestedNext.push(`agent-browser profile isolation check --profiles ${entries.map((entry) => entry.profile).join(",")} --url <target-url>`);
  }
  const isolationPlan = {
    purpose: "Use one managed browser profile per test identity so cookies, localStorage, sessionStorage, and captured evidence do not mix during two-account testing.",
    target: targetFilter,
    requiredRoles,
    readyForIsolationCheck: entries.length >= 2 && missingRoles.length === 0,
    roleProfiles: roles.map((entry) => ({
      role: entry.role,
      count: entry.count,
      profiles: entry.profiles.map((profile) => profile.profile),
      selectedProfile: entry.count === 1 ? entry.profiles[0].profile : null,
      duplicate: entry.duplicate,
    })),
    missingRoles,
    duplicateRoles,
    commands: {
      validate: targetFilter && requiredRoles.length > 0
        ? `agent-browser profile registry validate --target ${targetFilter} --require-roles ${requiredRoles.join(",")} --unique-roles`
        : "agent-browser profile registry validate --target <target> --require-roles attacker,victim --unique-roles",
      createMissing: missingRoles.map((role) => `agent-browser profile registry set --profile ${targetFilter || "<target>"}-${role}-auth --project <project> --platform <platform> --account <account-label> --target ${targetFilter || "<target>"} --role ${role}`),
      checkIsolation: entries.length >= 2 ? `agent-browser profile isolation check --profiles ${entries.map((entry) => entry.profile).join(",")} --url <target-url>` : null,
    },
    boundary: "This plan is metadata guidance only. It does not read cookies or prove runtime isolation; run profile isolation check for browser storage signals.",
  };
  return {
    schema: "agent-browser.profile.registry.matrix.v1",
    ok: missingRoles.length === 0,
    target: targetFilter,
    requiredRoles,
    count: entries.length,
    roles,
    presentRoles,
    missingRoles,
    duplicateRoles,
    unassignedProfiles,
    isolationPlan,
    metaFile: profileMetaFile(),
    boundary: "Profile registry matrix reports public metadata only. It does not inspect cookies, credentials, browser storage, or login state.",
    suggestedNext,
  };
}

function profilesFromRegistryDiagnosis(matrix, flags = {}) {
  const profileFilter = flags.profile ? [String(flags.profile)] : [];
  if (profileFilter.length) return profileFilter;
  const selected = [];
  for (const role of matrix.isolationPlan?.roleProfiles || []) {
    if (role.selectedProfile) selected.push(role.selectedProfile);
  }
  if (selected.length) return [...new Set(selected)];
  const fromRoles = [];
  for (const role of matrix.roles || []) {
    for (const profile of role.profiles || []) {
      if (profile?.profile) fromRoles.push(profile.profile);
    }
  }
  if (fromRoles.length) return [...new Set(fromRoles)];
  return [];
}

async function profileRegistryDiagnose(server, flags = {}) {
  const validation = profileRegistryValidate(flags);
  const matrix = profileRegistryMatrix(flags);
  const profiles = profilesFromRegistryDiagnosis(matrix, flags);
  const owner = String(flags.owner || defaultLeaseOwner());
  const leaseStatuses = profiles.map((profile) => profileLeaseStatusForProfile(profile, { owner }));
  const liveChecks = [];
  if (flags.checkLive === true) {
    for (const profile of profiles) {
      try {
        liveChecks.push(await profileDoctor(server, { ...flags, profile }));
      } catch (error) {
        liveChecks.push({ ok: false, profile, error: errorMessage(error) });
      }
    }
  }

  const blockers = [];
  if (validation.count === 0) blockers.push("registry-empty");
  if (validation.invalidCount > 0) blockers.push("invalid-metadata");
  for (const role of validation.roleCoverage?.missingRoles || []) blockers.push(`missing-role:${role}`);
  const duplicateRoles = validation.roleCoverage?.duplicateRoles || [];
  if (flags.uniqueRoles === true) {
    for (const duplicate of duplicateRoles) blockers.push(`duplicate-role:${duplicate.role}`);
  }
  const leaseConflicts = leaseStatuses.filter((entry) => entry.status === "leased-by-other");
  if (leaseConflicts.length) blockers.push("profile-lease-conflict");
  const liveFailures = liveChecks.filter((entry) => entry.ok === false || entry.profileState?.found === false);
  if (liveFailures.length) blockers.push("live-profile-not-ready");

  let state = validation.validationSummary?.state || "unknown";
  if (validation.count === 0) state = "registry-empty";
  if (leaseConflicts.length) state = "lease-conflict";
  if (liveFailures.length) state = "live-profile-not-ready";
  if (blockers.length === 0 && state === "duplicate-role-warning") state = "ready-with-warnings";

  const nextCommands = [
    ...(validation.validationSummary?.nextCommands || []),
    ...(matrix.suggestedNext || []),
  ];
  if (profiles.length) {
    nextCommands.push(`agent-browser profile preflight --profiles ${profiles.join(",")}${flags.target ? ` --target ${flags.target}` : ""}`);
  }
  if (!flags.checkLive && profiles.length) {
    nextCommands.push(`agent-browser profile registry diagnose ${flags.target ? `--target ${flags.target} ` : ""}${validation.roleCoverage?.requiredRoles?.length ? `--require-roles ${validation.roleCoverage.requiredRoles.join(",")} ` : ""}--check-live`.trim());
  }
  for (const conflict of leaseConflicts) {
    nextCommands.push(`agent-browser profile lease status --profile ${conflict.profile}`);
  }

  return {
    ok: blockers.length === 0,
    schema: "agent-browser.profile.registry.diagnose.v1",
    state,
    target: flags.target ? String(flags.target) : null,
    profile: flags.profile ? String(flags.profile) : null,
    requiredRoles: splitCsvFlag(flags.requireRoles || flags.requiredRoles),
    uniqueRoles: flags.uniqueRoles === true,
    profiles,
    blockers: [...new Set(blockers)],
    validation,
    matrix,
    leaseStatuses,
    liveChecks,
    registrySummary: {
      state,
      profileCount: validation.count,
      readyForTwoAccount: validation.validationSummary?.readyForTwoAccount === true && leaseConflicts.length === 0 && liveFailures.length === 0,
      missingRoles: validation.roleCoverage?.missingRoles || [],
      duplicateRoles,
      leaseConflictProfiles: leaseConflicts.map((entry) => entry.profile),
      liveChecked: flags.checkLive === true,
      nextCommands: [...new Set(nextCommands)],
      evidence: {
        checkedValidation: true,
        checkedMatrix: true,
        checkedLeaseStatuses: leaseStatuses.length > 0,
        checkedLiveProfiles: flags.checkLive === true,
        source: "local profile registry metadata and optional managed profile doctor checks",
        metaFile: profileMetaFile(),
      },
      boundary: "Registry diagnose is an agent routing check over public metadata, local leases, and optional profile doctor state. It does not inspect credentials, prove authorization isolation, or judge findings.",
    },
  };
}

function profilesFromRegistryForRoles(target, requiredRoles = []) {
  if (!target || requiredRoles.length === 0) return [];
  const data = readProfileMeta();
  const selected = [];
  for (const role of requiredRoles) {
    const matches = Object.entries(data)
      .filter(([, meta]) => meta?.target === target && meta?.role === role)
      .map(([profile]) => profile);
    if (matches.length !== 1) return [];
    selected.push(matches[0]);
  }
  return [...new Set(selected)];
}

async function profileTwoAccountReady(server, flags = {}) {
  const target = flags.target ? String(flags.target) : null;
  const requiredRoles = splitCsvFlag(flags.requireRoles || flags.requiredRoles);
  const roles = requiredRoles.length ? requiredRoles : ["attacker", "victim"];
  const explicitProfiles = parseCsv(flags.profiles || flags.profile);
  const profiles = explicitProfiles.length ? explicitProfiles : profilesFromRegistryForRoles(target, roles);
  const owner = String(flags.owner || defaultLeaseOwner());
  const validation = profileRegistryValidate({
    ...flags,
    target,
    requireRoles: roles.join(","),
    uniqueRoles: true,
  });
  const matrix = profileRegistryMatrix({
    ...flags,
    target,
    requireRoles: roles.join(","),
  });
  const preflight = await profilePreflight(server, {
    ...flags,
    target,
    profiles: profiles.join(","),
    requireRoles: roles.join(","),
    uniqueRoles: true,
    intent: "two-account",
    owner,
    acquireLease: flags.acquireLease === true,
  });
  const roleAssignments = roles.map((role) => {
    const roleEntry = (matrix.isolationPlan?.roleProfiles || []).find((entry) => entry.role === role);
    const selectedProfile = roleEntry?.selectedProfile || null;
    return {
      role,
      profile: selectedProfile,
      candidates: roleEntry?.profiles || [],
      ready: Boolean(selectedProfile),
      duplicate: Boolean(roleEntry?.duplicate),
    };
  });
  const blockers = [];
  if (!target) blockers.push("target-required");
  if (validation.ok === false) blockers.push("registry-not-ready");
  if (profiles.length < Math.max(roles.length, 2)) blockers.push("profiles-not-resolved");
  for (const blocker of preflight.preflightSummary?.blocking || []) blockers.push(blocker);
  const nextCommands = [
    ...(validation.validationSummary?.nextCommands || []),
    ...(matrix.suggestedNext || []),
    ...(preflight.suggestedNext || []),
  ];
  if (target) {
    nextCommands.push(`agent-browser profile two-account ready --target ${target} --require-roles ${roles.join(",")} --url <target-url> --owner ${owner} --acquire-lease`);
  }
  if (profiles.length >= 2) {
    nextCommands.push(`agent-browser profile isolation check --profiles ${profiles.join(",")} --url <target-url> --owner ${owner}`);
    nextCommands.push(`agent-browser capture start --profile ${profiles[0]} --label two-account-${target || "target"}`);
  }
  return {
    ok: blockers.length === 0,
    schema: "agent-browser.profile.two-account.ready.v1",
    target,
    requiredRoles: roles,
    profiles,
    owner,
    roleAssignments,
    checks: {
      validation,
      matrix,
      preflight,
    },
    readySummary: {
      state: blockers.length === 0 ? "ready" : "not-ready",
      readyForTwoAccount: blockers.length === 0 && profiles.length >= 2,
      blocking: [...new Set(blockers)],
      nextCommands: [...new Set(nextCommands)],
      evidence: {
        checkedRegistryValidation: true,
        checkedRegistryMatrix: true,
        checkedProfilePreflight: true,
        checkedLeaseStatuses: Boolean(preflight.preflightSummary?.evidence?.checkedLeaseStatuses),
        checkedIsolation: Boolean(preflight.preflightSummary?.evidence?.checkedIsolation),
        acquiredLeases: Boolean(preflight.preflightSummary?.evidence?.checkedLeaseAcquire),
        source: "local profile registry metadata, local lease file, and optional live managed-browser isolation check",
      },
      boundary: "Two-account ready is a profile coordination check. It does not authenticate accounts, perform authorization testing, or judge vulnerabilities.",
    },
    boundary: "This command prepares separated managed profiles for two-account work. It does not inspect secrets or decide whether a target is vulnerable.",
  };
}

// ---------------------------------------------------------------------------
// Backend status — normalized backend/worker state for agent orientation
// Boundaries:
//   Managed Browser  = agent-owned profile / repeatable evidence (CDP 17335)
//   Personal Browser = user-authorized current Chrome via extension bridge (17337)
//   Do NOT attach to already-running ordinary Chrome through managed CDP.
// ---------------------------------------------------------------------------

function backendRouteSummary(result) {
  const intent = result.intent || "default";
  const recommendedBackend = result.recommendedBackend || result.backend || "managed";
  const currentBackend = result.backend || null;
  const personalIntent = recommendedBackend === "personal";
  const personalAvailable =
    result.personal?.ok === true ||
    result.backendStatus?.personal?.ok === true ||
    result.workerHealth?.personal?.ok === true;
  const state = personalIntent
    ? (personalAvailable ? "personal-ready" : "personal-bridge-needed")
    : (currentBackend === "managed" ? "managed-ready" : "managed-needed");
  const reason = personalIntent
    ? "Use Personal Chrome when the task explicitly needs the operator's already-open/current Chrome tab or real browser state."
    : "Use Managed Browser for agent-owned profiles, repeatable F12 evidence, isolated identities, replay, capture, and two-account testing.";
  const nextCommands = personalIntent
    ? [
        "npm run personal:chrome",
        "agent-browser backend status --intent personal-current-tab",
        "agent-browser tabs",
        "agent-browser see snapshot",
      ]
    : [
        "agent-browser profile list",
        "agent-browser profile resume <profile>",
        "agent-browser open <url> --profile <profile>",
      ];
  if (intent === "two-account") {
    nextCommands.push("agent-browser profile registry validate --target <target> --require-roles attacker,victim --unique-roles");
    nextCommands.push("agent-browser profile isolation check --profiles <attacker-profile>,<victim-profile> --url <target-url>");
  }
  if (intent === "replay") {
    nextCommands.push("agent-browser capture start --profile <profile> --label replay-baseline");
    nextCommands.push("agent-browser repeater open <requestId> --profile <profile>");
  }
  if (intent === "auth") {
    nextCommands.push("agent-browser auth bootstrap start --profile <profile> --url <login-url> --success-url-contains <success-marker>");
  }
  return {
    state,
    intent,
    currentBackend: personalIntent && personalAvailable ? "personal" : currentBackend,
    recommendedBackend,
    reason,
    nextCommands,
    forbiddenFirstSteps: personalIntent
      ? [
          "Do not clone cookies as the first path.",
          "Do not ask the operator to close/restart ordinary Chrome as the first path.",
          "Do not try to attach Managed CDP to an already-running Chrome that lacks a remote debugging port.",
        ]
      : [
          "Do not use the operator's Personal Chrome for clean target identities or two-account isolation.",
          "Do not mix attacker/victim roles in one browser profile.",
        ],
    evidence: {
      backendStatusAvailable: Boolean(result.backendStatus),
      workerHealthAvailable: Boolean(result.workerHealth),
      sourceFields: ["intent", "backend", "recommendedBackend", "backendStatus", "workerHealth"],
    },
    boundary: "This is backend routing guidance only. It does not connect to Personal Chrome by itself or prove that a profile is authenticated.",
  };
}

function normalizeRuntimeIdentity(backendStatus, workerHealth) {
  const managedIdentity =
    backendStatus?.managed?.runtimeIdentity ||
    backendStatus?.runtimeIdentity ||
    workerHealth?.browserRuntimeIdentity ||
    null;
  if (!managedIdentity) {
    return {
      productBackend: backendStatus?.backend || workerHealth?.backend || null,
      physicalBrowser: "unknown",
      attachMode: workerHealth?.browserAttachMode || null,
      cdpEndpoint: workerHealth?.cdpEndpoint || null,
      warning:
        "Runtime identity is incomplete. Restart the worker after upgrading Agent Browser Runtime so /health exposes browserRuntimeIdentity.",
    };
  }
  const attachMode = managedIdentity.attachMode || workerHealth?.browserAttachMode || null;
  const launchedByServer = Boolean(managedIdentity.launchedByServer || workerHealth?.launchedByServer);
  const physicalBrowser = managedIdentity.physicalBrowser || "unknown-chromium-family";
  const cdpEndpoint =
    managedIdentity.cdpEndpoint ||
    (managedIdentity.cdpPort ? `http://127.0.0.1:${managedIdentity.cdpPort}` : workerHealth?.cdpEndpoint || null);
  return {
    productBackend: managedIdentity.productBackend || "managed",
    transport: managedIdentity.transport || "direct-cdp",
    physicalBrowser,
    browserProduct: managedIdentity.browserProduct || null,
    executablePath: managedIdentity.executablePath || null,
    cdpPort: managedIdentity.cdpPort || workerHealth?.cdpPort || null,
    cdpEndpoint,
    attachMode,
    launchMode: managedIdentity.launchMode || workerHealth?.browserLaunchMode || null,
    headless: "headless" in managedIdentity ? managedIdentity.headless : (workerHealth?.browserHeadless ?? null),
    launchedByServer,
    userDataDir: managedIdentity.userDataDir || workerHealth?.browserUserDataDir || null,
    stableAgentName: "Managed Browser",
    displayName: `Managed Browser over ${physicalBrowser}${cdpEndpoint ? ` (${cdpEndpoint})` : ""}`,
    boundary:
      managedIdentity.boundary ||
      "Physical browser is an implementation detail under Managed Browser. Route by backend/profile, not by Edge/Chrome/Cloak names.",
    warning: attachMode === "attached-existing-cdp"
      ? "Managed Browser is attached to an existing CDP endpoint; confirm the endpoint/profile owner before using it for isolated work."
      : null,
  };
}

async function backendStatus(server, flags) {
  const intent = flags.intent ? String(flags.intent).toLowerCase() : null;
  const managedIntents = new Set(["clean", "clean-target", "target", "two-account", "auth", "f12", "replay", "capture", "evidence"]);
  const personalIntents = new Set(["personal", "personal-current-tab", "current-tab", "my-chrome", "already-logged-in", "real-login", "takeover-current-chrome", "personal-takeover", "current-chrome"]);
  const takeoverIntents = new Set(["takeover-current-chrome", "personal-takeover", "current-chrome", "my-chrome", "current-tab"]);
  const result = {
    schema: "agent-browser.backend.status.v1",
    workerUrl: server,
    intent,
    backend: null,
    backendStatus: null,
    workerHealth: null,
    runtimeIdentity: null,
    boundaries: {
      managed: "Managed Browser = agent-owned profile / repeatable evidence. CDP on 17335. Use for isolated profiles, HARs, traces, replay.",
      personal: "Personal Browser = user-authorized current Chrome via extension bridge (17337). Use when real login state or an already-open tab is needed.",
      warning: "Do not attach to already-running ordinary Chrome through managed CDP. Use the Personal Chrome extension bridge (npm run personal:chrome) instead.",
    },
    decisionGuide: {
      managed: ["clean-target", "two-account", "auth", "f12", "replay", "capture", "evidence"],
      personal: ["personal-current-tab", "takeover-current-chrome", "my-chrome", "already-logged-in", "real-login"],
    },
    takeoverBoundary: null,
    recommendedBackend: null,
    suggestedNext: [],
  };

  // Try the worker's browser_backend_status tool first
  try {
    const backendInfo = await callTool(server, "browser_backend_status", {});
    result.backend = backendInfo?.backend ?? backendInfo?.mode ?? null;
    result.backendStatus = backendInfo;
  } catch {
    // Tool not yet available; fall through to health endpoint
  }

  // Health endpoint for reachability and attach mode
  try {
    const health = await requestJson(`${server}/health`);
    result.workerHealth = health;
    if (!result.backend) {
      const attachMode = String(health?.browserAttachMode || "");
      result.backend = attachMode.includes("personal") ? "personal" : "managed";
    }
  } catch (error) {
    result.workerError = String(error?.message || error);
    result.suggestedNext.push("Worker is not reachable. Start managed worker: CDP_LAUNCH_BROWSER=1 npm run agent:server");
    result.suggestedNext.push("For personal Chrome, run: npm run personal:chrome");
    return result;
  }

  result.runtimeIdentity = normalizeRuntimeIdentity(result.backendStatus, result.workerHealth);
  if (result.runtimeIdentity?.warning) result.suggestedNext.push(result.runtimeIdentity.warning);
  const profilePortSummary =
    result.backendStatus?.managed?.profilePortSummary ||
    result.workerHealth?.profilePortSummary ||
    null;
  if (profilePortSummary && profilePortSummary.ok === false) {
    result.profilePortSummary = profilePortSummary;
    result.ok = false;
    result.state = "not-ready";
    result.suggestedNext.push(
      `Profile config port drift detected: ${profilePortSummary.mismatchedCount || 0} profile(s) are not on CDP ${profilePortSummary.canonicalCdpPort}.`,
    );
    if (Array.isArray(profilePortSummary.next)) result.suggestedNext.push(...profilePortSummary.next);
  }

  if (personalIntents.has(intent)) {
    result.recommendedBackend = "personal";
  } else if (managedIntents.has(intent)) {
    result.recommendedBackend = "managed";
  } else {
    result.recommendedBackend = result.backend || "managed";
  }

  if (result.recommendedBackend === "personal") {
    if (takeoverIntents.has(intent)) {
      result.takeoverBoundary = {
        request: "Inspect or control the operator's already-open Chrome/current tab.",
        managedPath: "Not applicable: Managed Browser cannot attach to an ordinary Chrome process that was not started with a remote debugging port.",
        productPath: "Use the Personal Chrome extension bridge. It connects through the installed extension/chrome.debugger after operator authorization.",
        fallback: "If Personal Chrome is not connected, ask the operator to start the bridge or use Managed Browser with a separate profile instead.",
      };
      result.suggestedNext.push("Start/check Personal Chrome bridge: npm run personal:chrome");
      result.suggestedNext.push("Use Personal backend/current tab; do not clone cookies or restart the user's Chrome as the first path.");
    }
    result.suggestedNext.push("agent-browser tabs -- list attached personal Chrome tabs");
    result.suggestedNext.push("agent-browser see snapshot -- inspect the current page via extension bridge");
    if (result.backend !== "personal") {
      result.suggestedNext.push("If current worker is managed, use the Personal Chrome extension bridge base URL instead of trying to attach ordinary Chrome through CDP.");
    }
  } else {
    result.suggestedNext.push("agent-browser profile list -- list available managed profiles");
    result.suggestedNext.push("agent-browser open <url> --profile default -- open a URL in the managed browser");
    if (intent === "auth") {
      result.suggestedNext.push("agent-browser auth bootstrap start --profile <profile> --url <login-url> --success-url-contains <success-marker>");
      result.suggestedNext.push("After the visible login/MFA/passkey step, run: agent-browser auth bootstrap status --profile <profile> --success-url-contains <success-marker>");
    }
    if (intent === "replay") {
      result.suggestedNext.push("agent-browser capture start --profile <profile> --label replay-baseline");
      result.suggestedNext.push("agent-browser requests --profile <profile> --method POST --has-request-body true --limit 50");
      result.suggestedNext.push("agent-browser repeater open <requestId> --profile <profile>");
    }
    if (["f12", "capture", "evidence"].includes(intent)) {
      result.suggestedNext.push("agent-browser capture start --profile <profile> --label evidence");
      result.suggestedNext.push("agent-browser inspect network --profile <profile>");
      result.suggestedNext.push("agent-browser pack <url> --profile <profile>");
    }
    if (intent === "two-account") {
      result.suggestedNext.push("agent-browser profile registry validate --target <target> --require-roles attacker,victim --unique-roles");
    }
  }

  // Wave-8: backend binding hint.
  result.profileBackendBinding = {
    hint: "Profile backend is now a profile-level persistent attribute (wave-8). Select it once with --backend on the first open; all subsequent CLI calls with --profile X auto-use the stored backend.",
    example: "agent-browser open https://example.com --backend personal --profile resend  # first time",
    subsequent: "agent-browser observe --profile resend  # no --backend needed",
    listCommand: "agent-browser profile list  # shows backend column per profile",
  };
  result.backendRouteSummary = backendRouteSummary(result);
  return result;
}

async function cliDoctor(server, flags) {
  const profile = flags.profile || flags.name || null;
  const target = flags.target ? String(flags.target) : null;
  const requiredRoles = splitCsvFlag(flags.requireRoles || flags.requiredRoles);
  const result = {
    schema: "agent-browser.doctor.v1",
    ok: false,
    workerUrl: server,
    health: null,
    suggestedNext: [],
    doctorSummary: null,
    boundary: "Top-level doctor checks worker reachability and points agents to the bounded preflight entry points. It does not inspect a browser profile unless a profile command is run.",
  };
  try {
    result.health = await requestJson(`${server}/health`);
    result.ok = result.health?.ok !== false;
    if (Array.isArray(result.health?.suggestedNext)) result.suggestedNext.push(...result.health.suggestedNext);
    if (result.health?.profilePortSummary?.ok === false) {
      result.suggestedNext.push(
        `Profile config port drift detected: ${result.health.profilePortSummary.mismatchedCount || 0} profile(s) are not on CDP ${result.health.profilePortSummary.canonicalCdpPort}.`,
      );
    }
  } catch (error) {
    result.error = String(error?.message || error);
    result.suggestedNext.push("Start managed worker: CDP_LAUNCH_BROWSER=1 npm run agent:server");
    result.suggestedNext.push("For Personal Chrome bridge: npm run personal:chrome");
  }

  result.suggestedNext.push("agent-browser guide");
  result.suggestedNext.push("agent-browser backend status");
  if (profile) {
    result.suggestedNext.push(`agent-browser profile preflight --profile ${profile} --owner ${defaultLeaseOwner()}`);
  } else if (target || requiredRoles.length > 0) {
    const rolePart = requiredRoles.length ? ` --require-roles ${requiredRoles.join(",")}` : "";
    result.suggestedNext.push(`agent-browser profile preflight --target ${target || "<target>"}${rolePart} --profiles <profile-a>,<profile-b> --url <target-url>`);
  } else {
    result.suggestedNext.push("agent-browser profile list");
    result.suggestedNext.push("agent-browser profile preflight --profile <profile> --owner <agent-name>");
  }

  result.doctorSummary = {
    state: result.ok ? "worker-ready" : (result.health ? "browser-cdp-unreachable" : "worker-unreachable"),
    nextCommands: result.suggestedNext,
    evidence: {
      healthEndpoint: `${server}/health`,
      healthAvailable: Boolean(result.health),
      cdpReachable: result.health?.cdpHealth?.reachable ?? null,
      cdpHealth: result.health?.cdpHealth || null,
      browserProcess: result.health?.browserProcess || null,
      blockers: result.health?.blockers || [],
      profilePortSummary: result.health?.profilePortSummary || null,
      profileProvided: Boolean(profile),
      targetProvided: Boolean(target),
    },
    boundary: result.boundary,
  };
  return result;
}

function cliGuide(flags = {}) {
  const mode = flags.mode ? String(flags.mode).toLowerCase() : "all";
  const browserBackends = {
    managed: {
      role: "primary",
      meaning: "Managed Browser is an agent-owned browser/profile controlled by Agent Browser Runtime.",
      transport: "Direct Chrome DevTools Protocol over the managed browser remote-debugging endpoint.",
      useWhen: [
        "clean profile or target-scoped identity is needed",
        "two-account attacker/victim isolation is needed",
        "repeatable F12 evidence, HAR, trace, replay, or artifact export is needed",
      ],
    },
    personal: {
      role: "secondary",
      meaning: "Personal Browser is operator-authorized access to the user's already-open Chrome tab.",
      transport: "Chrome extension bridge using chrome.debugger; DevTools commands are routed through extension permission and current-tab scope.",
      useWhen: [
        "the operator explicitly asks to use their current Chrome tab",
        "the real logged-in tab must be inspected without restarting Chrome",
        "the task is personal/ad hoc and does not need clean profile isolation",
      ],
    },
  };
  const basic = {
    mode: "basic",
    scenario: "basic",
    defaultBackend: "managed",
    purpose: "Ordinary browser operation: browse, fill forms, upload/download files, and operate logged-in web apps.",
    flow: [
      "agent-browser doctor",
      "agent-browser profile preflight --profile <profile> --owner <agent-name> --acquire-lease --check-stuck --check-auth --success-url-contains <success-marker>",
      "agent-browser open <url> --profile <profile>",
      "agent-browser observe --profile <profile>",
      "agent-browser action preflight click --profile <profile> --text \"<button>\"",
      "agent-browser click --text \"<button>\" --profile <profile> --wait-mode no-navigation",
      "agent-browser fill \"<value>\" --label \"<field label>\" --profile <profile>",
      "agent-browser type \"<value>\" --selector \"<selector>\" --profile <profile> --press-enter",
      "agent-browser select --selector \"<selector>\" --value <value> --profile <profile>",
      "agent-browser upload --selector \"input[type=file]\" --file <path> --profile <profile>",
      "agent-browser wait --selector <selector> --profile <profile>",
      "agent-browser download start --profile <profile> --dir <download-dir>",
      "agent-browser workflow diagnose --file <workflow.json>",
    ],
  };
  const pentest = {
    mode: "pentest",
    scenario: "pentest",
    defaultBackend: "managed",
    purpose: "F12 evidence and Agentic Burp workflow: capture traffic, inspect request bodies, replay bounded variants, and export objective evidence.",
    flow: [
      "agent-browser doctor",
      "agent-browser profile preflight --profile <target>-attacker-auth --owner <agent-name> --acquire-lease --check-stuck --check-auth --success-url-contains <success-marker>",
      "agent-browser capture start --profile <profile> --label <reason>",
      "agent-browser requests --profile <profile> --method POST --has-request-body true --limit 50",
      "agent-browser request payload <requestId> --profile <profile>",
      "agent-browser requests diagnose --profile <profile>",
      "agent-browser repeater open <requestId> --profile <profile>",
      "agent-browser repeater send <sessionId>",
      "agent-browser repeater diff <sessionId>",
          "agent-browser repeater diagnose <sessionId> --profile <profile>",
          "agent-browser intercept diagnose --profile <profile>",
          "agent-browser profile two-account ready --target <target> --require-roles attacker,victim --url <target-url> --owner <agent-name> --acquire-lease",
          "agent-browser profile registry diagnose --target <target> --require-roles attacker,victim",
      "agent-browser evidence bundle --profile <profile> --include-har",
      "agent-browser export <requestId> --profile <profile> --format json --out ./request.json",
    ],
  };
  const personal = {
    mode: "personal",
    scenario: "personal",
    defaultBackend: "personal",
    purpose: "Operator-authorized current Chrome tab: inspect or operate the user's already-open browser state through the Personal Chrome extension bridge.",
    flow: [
      "agent-browser backend status --intent personal-current-tab",
      "npm run personal:chrome",
      "agent-browser backend status --intent personal-current-tab",
      "agent-browser tabs",
      "agent-browser see snapshot --backend personal --current-tab true",
      "agent-browser observe --backend personal --current-tab true",
      "agent-browser feedback \"Personal Chrome bridge could not inspect current tab\" --type bug",
    ],
    boundary: [
      "Do not clone cookies as the first path.",
      "Do not ask the operator to close/restart ordinary Chrome as the first path.",
      "Managed Browser cannot attach to an already-running ordinary Chrome that lacks a remote debugging port.",
      "Use Managed Browser for clean target identities, two-account isolation, capture/replay, and repeatable evidence.",
    ],
  };
  const guides = mode === "basic" ? [basic]
    : (mode === "pentest" ? [pentest]
      : (mode === "personal" ? [personal] : [basic, pentest, personal]));
  return {
    schema: "agent-browser.guide.v1",
    ok: true,
    mode,
    guides,
    entryPoints: {
      health: "agent-browser doctor",
      preflight: "agent-browser profile preflight --profile <profile> --owner <agent-name> --acquire-lease",
      feedback: "agent-browser feedback \"<summary>\" --type bug --details \"<what happened>\"",
    },
    terminology: {
      mode: "Guide mode is a usage scenario filter, not a browser backend.",
      backend: "Browser backend is the actual connection path: managed direct CDP or personal chrome.debugger extension bridge.",
      managed: "Managed Browser is the professional mainline.",
      personal: "Personal Browser is the secondary operator-authorized current-tab path.",
    },
    browserBackends,
    boundary: "Guide is a usage map only. It does not run browser actions, collect evidence, or judge vulnerabilities.",
  };
}

function normalizeScenario(value) {
  const scenario = String(value || "basic").toLowerCase();
  if (["basic", "operate", "operation", "ops", "money"].includes(scenario)) return "basic";
  if (["pentest", "appsec", "f12", "security", "replay", "burp"].includes(scenario)) return "pentest";
  if (["personal", "personal-browser", "current-tab", "my-chrome"].includes(scenario)) return "personal";
  throw new Error("ready scenario must be basic, pentest, or personal");
}

async function cliReady(server, args, flags = {}) {
  const scenario = normalizeScenario(args[1] || flags.scenario || flags.mode || "basic");
  const guide = cliGuide({ mode: scenario });
  const guideEntry = guide.guides[0];
  const suggestedNext = [];
  const blocking = [];
  const addNext = (entries) => {
    for (const entry of entries || []) {
      if (entry && !suggestedNext.includes(entry)) suggestedNext.push(entry);
    }
  };
  const result = {
    schema: "agent-browser.ready.v1",
    ok: true,
    scenario,
    defaultBackend: guideEntry.defaultBackend,
    checks: {
      backend: null,
      profilePreflight: null,
      registryMatrix: null,
      personalBridge: null,
    },
    guide: guideEntry,
    readySummary: null,
    suggestedNext,
    boundary: "Ready checks tool/runtime readiness for a usage scenario. It does not perform the task, authenticate accounts, collect evidence, or judge vulnerabilities. For personal scenario: read top-level personalReady (true/false) as the verdict; checks.backend reflects the worker's own physical browser, not the personal-bridge state.",
  };

  if (scenario === "personal") {
    result.checks.backend = await backendStatus(server, { ...flags, intent: "personal-current-tab" });
    addNext(result.checks.backend.suggestedNext);
    const activePersonal =
      result.checks.backend.backend === "personal" ||
      result.checks.backend.personal?.ok === true ||
      result.checks.backend.backendStatus?.personal?.ok === true ||
      result.checks.backend.workerHealth?.personal?.ok === true;
    result.checks.personalBridge = {
      ok: activePersonal,
      state: activePersonal ? "connected" : "bridge-needed",
      expectedTransport: "Chrome extension bridge using chrome.debugger",
      nextCommands: activePersonal
        ? ["agent-browser tabs --backend personal", "agent-browser see snapshot --backend personal --current-tab true"]
        : ["npm run personal:chrome", "agent-browser backend status --intent personal-current-tab"],
    };
    addNext(result.checks.personalBridge.nextCommands);
    if (result.checks.backend.workerError) blocking.push("backend-unreachable");
    if (!activePersonal) blocking.push("personal-bridge-needed");
  } else {
    const profile = flags.profile || flags.name || parseCsv(flags.profiles)[0] || null;
    const twoAccountRequested = scenario === "pentest" && Boolean(flags.target || flags.requireRoles || flags.requiredRoles || flags.profiles);
    if (!profile && !twoAccountRequested) {
      blocking.push("profile-required");
      result.ok = false;
      addNext([
        "agent-browser profile list",
        `agent-browser ready ${scenario} --profile <profile>`,
      ]);
    } else {
      const profileCount = parseCsv(flags.profiles || profile).length;
      const intent = flags.intent
        || (scenario === "pentest"
          ? ((profileCount >= 2 || flags.target || flags.requireRoles || flags.requiredRoles) ? "two-account" : "replay")
          : "clean-target");
      if (scenario === "pentest" && (flags.target || flags.requireRoles || flags.requiredRoles)) {
        result.checks.registryMatrix = profileRegistryMatrix(flags);
        addNext(result.checks.registryMatrix.suggestedNext);
      }
      result.checks.profilePreflight = await profilePreflight(server, {
        ...flags,
        profile,
        intent,
        checkStuck: flags.checkStuck !== false,
      });
      result.checks.backend = result.checks.profilePreflight.checks.backend;
      addNext(result.checks.profilePreflight.suggestedNext);
      if (result.checks.profilePreflight.ok === false) {
        blocking.push(...(result.checks.profilePreflight.preflightSummary?.blocking || ["profile-preflight-not-ready"]));
      }
      if (scenario === "pentest") {
        const readyProfiles = result.checks.profilePreflight?.profiles || parseCsv(flags.profiles || profile);
        const primaryProfile = profile || readyProfiles[0] || "<profile>";
        addNext([
          `agent-browser capture start --profile ${primaryProfile} --label evidence`,
          `agent-browser requests --profile ${primaryProfile} --method POST --has-request-body true --limit 50`,
          "agent-browser repeater plan <requestId> --profile <profile>",
        ]);
      }
    }
  }

  result.ok = blocking.length === 0;
  if (scenario === "personal") {
    // Top-level verdict for personal scenario. agents should check this field
    // first — checks.backend reflects the worker's own physical browser (Edge)
    // and is an informational field, not the personal-bridge readiness signal.
    result.personalReady = result.checks.personalBridge?.ok === true;
  }
  result.readySummary = {
    state: result.ok ? "ready" : "not-ready",
    scenario,
    defaultBackend: result.defaultBackend,
    blocking,
    nextCommands: suggestedNext,
    evidence: {
      checkedBackend: Boolean(result.checks.backend),
      profilePortSummary:
        result.checks.backend?.profilePortSummary ||
        result.checks.profilePreflight?.preflightSummary?.evidence?.profilePortSummary ||
        null,
      checkedProfilePreflight: Boolean(result.checks.profilePreflight),
      profilePreflightState: result.checks.profilePreflight?.preflightSummary?.state || null,
      leaseProfiles: result.checks.profilePreflight?.preflightSummary?.evidence?.leaseProfiles || [],
      leaseConflicts: result.checks.profilePreflight?.preflightSummary?.evidence?.leaseConflicts || [],
      profileLeaseStatus: result.checks.profilePreflight?.preflightSummary?.evidence?.profileLeaseStatus || null,
      stuckState: result.checks.profilePreflight?.preflightSummary?.evidence?.stuckState || null,
      stuckSignals: result.checks.profilePreflight?.checks?.stuck?.signals || [],
      stuckNetwork: result.checks.profilePreflight?.checks?.stuck?.stuckSummary
        ? {
            pendingRequestCount: result.checks.profilePreflight.checks.stuck.stuckSummary.pendingRequestCount || 0,
            stalePendingRequestCount: result.checks.profilePreflight.checks.stuck.stuckSummary.stalePendingRequestCount || 0,
            failedRequestCount: result.checks.profilePreflight.checks.stuck.stuckSummary.failedRequestCount || 0,
          }
        : null,
      authState: result.checks.profilePreflight?.preflightSummary?.evidence?.authState || null,
      downloadState: result.checks.profilePreflight?.preflightSummary?.evidence?.downloadState || null,
      registryState: result.checks.profilePreflight?.checks?.registry?.validationSummary?.state || null,
      isolationState: result.checks.profilePreflight?.checks?.isolation
        ? (result.checks.profilePreflight.checks.isolation.ok ? "ready" : "not-ready")
        : null,
      checkedRegistryMatrix: Boolean(result.checks.registryMatrix),
      registryMatrixMissingRoles: result.checks.registryMatrix?.missingRoles || [],
      registryMatrixDuplicateRoles: result.checks.registryMatrix?.roles?.filter((entry) => entry.duplicate).map((entry) => entry.role) || [],
      checkedPersonalBridge: Boolean(result.checks.personalBridge),
      personalBridgeState: result.checks.personalBridge?.state || null,
      guideScenario: guideEntry.scenario,
      guideDefaultBackend: guideEntry.defaultBackend,
    },
    boundary: result.boundary,
  };
  return result;
}

function cliCapabilities() {
  const guide = cliGuide({});
  return {
    schema: "agent-browser.capabilities.v1",
    ok: true,
    productModel: {
      primaryBackend: "managed",
      secondaryBackend: "personal",
      cliRole: "primary product interface for agents and shell workers",
      objectiveBoundary: "Collect browser/F12 evidence and expose boundaries. Do not judge vulnerabilities.",
    },
    browserBackends: guide.browserBackends,
    scenarios: [
      {
        scenario: "basic",
        maturity: "usable-mainline",
        defaultBackend: "managed",
        useFor: ["form fill", "posting workflows", "downloads", "uploads", "logged-in web apps", "Money Project browser work"],
        commands: [
          "agent-browser ready basic --profile <profile>",
          "agent-browser open <url> --profile <profile>",
          "agent-browser observe --profile <profile>",
          "agent-browser click --text \"<button>\" --profile <profile> --wait-mode no-navigation",
          "agent-browser fill \"<value>\" --label \"<field label>\" --profile <profile>",
          "agent-browser type \"<value>\" --selector \"<selector>\" --profile <profile> --press-enter",
          "agent-browser form fill --profile <profile> --fields-json '{\"input[name=title]\":\"Hello\"}'",
          "agent-browser wait --selector <selector> --profile <profile>",
          "agent-browser action preflight click --profile <profile> --text \"<button>\"",
          "agent-browser upload --selector \"input[type=file]\" --file <path> --profile <profile>",
          "agent-browser download start --profile <profile> --dir <dir>",
          "agent-browser download diagnose --profile <profile>",
          "agent-browser auth diagnose --profile <profile>",
          "agent-browser workflow diagnose --file <workflow.json>",
        ],
        boundaries: [
          "Use explicit waits for SPA/no-navigation pages.",
          "Use fill for replacement input; use type --press-enter when the page requires real keyboard submit.",
          "Use profile preflight before reusing a long-lived profile.",
        ],
      },
      {
        scenario: "pentest",
        maturity: "professional-mainline",
        defaultBackend: "managed",
        useFor: ["F12 evidence", "network capture", "request body reading", "GraphQL payloads", "replay", "repeater", "two-account isolation", "evidence export"],
        commands: [
          "agent-browser ready pentest --profile <profile>",
          "agent-browser capture start --profile <profile> --label <reason>",
          "agent-browser requests --profile <profile> --method POST --has-request-body true",
          "agent-browser request payload <requestId> --profile <profile>",
          "agent-browser graphql requests --profile <profile> --all --inspect-all",
          "agent-browser graphql intercept-plan <requestId> --profile <profile> --variables-json '{...}'",
          "agent-browser requests diagnose --profile <profile>",
          "agent-browser repeater open <requestId> --profile <profile>",
          "agent-browser repeater send <sessionId>",
          "agent-browser repeater diagnose <sessionId> --profile <profile>",
          "agent-browser profile two-account ready --target <target> --require-roles attacker,victim --url <target-url> --owner <agent-name> --acquire-lease",
          "agent-browser profile isolation check --profiles attacker,victim --url <same-origin-url>",
          "agent-browser profile registry diagnose --target <target> --require-roles attacker,victim",
          "agent-browser evidence bundle --profile <profile> --include-har",
          "agent-browser pack <url> --profile <profile>",
        ],
        boundaries: [
          "Managed Browser is required for clean target identities and repeatable evidence.",
          "Outputs expose truncation/coverage fields; expand with --all or inspect-all when needed.",
          "Repeater/replay reports objective responses only.",
        ],
      },
      {
        scenario: "personal",
        maturity: "secondary-current-tab",
        defaultBackend: "personal",
        useFor: ["operator-authorized current tab", "real logged-in page inspection", "personal/ad hoc browser help"],
        commands: [
          "npm run personal:chrome",
          "agent-browser ready personal",
          "agent-browser tabs --backend personal",
          "agent-browser see snapshot --backend personal --current-tab true",
          "agent-browser observe --backend personal --current-tab true",
        ],
        boundaries: [
          "Personal Browser uses the Chrome extension chrome.debugger bridge.",
          "Do not use it for two-account isolation, clean target identities, or public evidence.",
          "If the bridge is not connected, use Managed Browser or start the bridge; do not clone cookies as the first path.",
        ],
      },
    ],
    agentUse: {
      interaction: {
        preferCli: [
          "agent-browser action preflight before brittle click/type/fill/wait steps on dynamic pages",
          "agent-browser fill --label/--field for Playwright-style replacement input without hand-copying selectors",
          "agent-browser type --press-enter for React forms that only submit from keyboard Enter",
          "agent-browser wait before reading SPA/no-navigation results",
        ],
        tools: ["browser_type", "browser_press", "browser_select", "browser_wait", "browser_upload"],
      },
      diagnostics: {
        basic: ["agent-browser download diagnose", "agent-browser auth diagnose", "agent-browser workflow diagnose"],
        pentest: ["agent-browser requests diagnose", "agent-browser repeater diagnose", "agent-browser intercept diagnose", "agent-browser profile registry diagnose"],
        rule: "When a command fails or returns partial coverage, run the matching diagnose command before guessing.",
      },
      appsecReplay: {
        fetchLayer: "agent-browser graphql replay <requestId> --profile <profile> --variables-json '{...}'",
        inFlightBrowserRequest: "agent-browser graphql intercept-plan <requestId> --profile <profile> --variables-json '{...}'",
        rule: "Use intercept-plan when WAF/browser signals, service workers, or page runtime context may make fetch-layer replay misleading.",
      },
      evidence: {
        command: "agent-browser evidence bundle --profile <profile> --include-har",
        contains: ["page snapshot", "screenshot path", "network summary", "issues", "security", "storage", "sources"],
        rule: "Use evidence bundle for handoff/report context after capture and before claiming a workflow is reproducible.",
      },
      profileIsolation: {
        rule: "Use separate profiles for attacker/victim or account A/B tests. Do not share cookies across identities.",
        commands: [
          "agent-browser ready pentest --target <target> --require-roles attacker,victim",
          "agent-browser profile registry diagnose --target <target> --require-roles attacker,victim",
          "agent-browser profile isolation check --profiles attacker,victim --url <same-origin-url>",
        ],
      },
    },
    qualityGates: [
      "npm run smoke:agent-browser-cli",
      "npm run smoke:f12",
      "npm run smoke:personal",
      "npm run check",
    ],
    recommendedStart: [
      "agent-browser doctor",
      "agent-browser capabilities",
      "agent-browser ready basic --profile <profile>",
      "agent-browser ready pentest --profile <profile>",
      "agent-browser ready personal",
    ],
    remainingProductWork: [
      "Keep polishing agent-readable failure UX for every command.",
      "Keep expanding end-to-end live smoke workflows around downloads, auth, profile registry, and repeater evidence.",
      "Keep Personal Browser parity explicit with structured notApplicable boundaries where chrome.debugger cannot match Managed CDP.",
    ],
    boundary: "Capability map is product routing information, not a live readiness result. Use agent-browser ready for current environment readiness.",
  };
}

// ---------------------------------------------------------------------------
// Profile doctor — profile state, attached tabs, and suggested next command
// ---------------------------------------------------------------------------

async function profileDoctor(server, flags) {
  const profile = flags.profile;
  if (!profile) throw new Error("profile doctor requires --profile");

  const result = {
    schema: "agent-browser.profile.doctor.v1",
    profile,
    workerUrl: server,
    profileState: null,
    attachedTabs: null,
    profileLease: profileLeaseStatusForProfile(profile, flags),
    boundaries: {
      managed: "Managed Browser = agent-owned profile / repeatable evidence. Profiles are isolated per-agent identity.",
      personal: "Personal Browser = extension bridge to user's real Chrome. Not a managed profile; no profile isolation.",
      warning: "Do not use cookie export, raw CDP port access, or copied Chrome profiles as the first recovery path. Use profile resume or the Personal Chrome extension bridge.",
    },
    suggestedNext: [],
  };

  // Check whether the profile exists in the managed pool
  try {
    const listResult = await callTool(server, "profile_list", {});
    const profileList = Array.isArray(listResult?.profiles) ? listResult.profiles
      : Array.isArray(listResult) ? listResult
      : [];
    const found = profileList.find((p) => (p.name || p.profile) === profile);
    if (found) {
      result.profileState = { found: true, details: found };
    } else {
      result.profileState = {
        found: false,
        knownProfiles: profileList.map((p) => p.name || p.profile).filter(Boolean),
      };
    }
  } catch (error) {
    result.profileState = { found: null, error: String(error?.message || error) };
  }

  // Tabs attached to this profile
  try {
    result.attachedTabs = await callTool(server, "browser_tabs", { profile });
  } catch (error) {
    result.attachedTabs = { error: String(error?.message || error) };
  }

  if (result.profileState?.found === false) {
    result.suggestedNext.push(`agent-browser profile create ${profile}`);
    result.suggestedNext.push(`agent-browser open <url> --profile ${profile}`);
  } else {
    if (result.profileLease.status === "leased-by-other") {
      result.suggestedNext.push(`agent-browser profile lease status --profile ${profile}`);
      result.suggestedNext.push(`agent-browser profile lease acquire --profile ${profile} --owner ${result.profileLease.owner} --force`);
    } else if (result.profileLease.status === "available") {
      result.suggestedNext.push(`agent-browser profile lease acquire --profile ${profile} --owner ${result.profileLease.owner}`);
    }
    result.suggestedNext.push(`agent-browser profile resume ${profile}`);
    result.suggestedNext.push(`agent-browser see snapshot --profile ${profile}`);
    result.suggestedNext.push(`agent-browser observe --profile ${profile}`);
  }

  // Wave-8: show the stored backend for this profile so agents know they don't need --backend.
  try {
    const { readProfileConfig, getStoredBackend, profileConfigFilePath } = await import("./lib/profile-backend-binding.mjs");
    const storedBackend = getStoredBackend(readProfileConfig(profileConfigFilePath()), profile);
    if (storedBackend) {
      result.profileBackendBinding = {
        profile,
        backend: storedBackend,
        hint: `Profile "${profile}" is bound to backend "${storedBackend}". Subsequent calls with --profile ${profile} don't need --backend.`,
      };
    } else {
      result.profileBackendBinding = {
        profile,
        backend: null,
        hint: `Profile "${profile}" has no bound backend yet. Bind one with: agent-browser open <url> --backend personal|managed --profile ${profile}`,
      };
    }
  } catch {
    // Non-fatal: binding info is advisory only.
  }

  return result;
}

async function profilePreflight(server, flags) {
  let profile = flags.profile || flags.name || null;
  const target = flags.target ? String(flags.target) : null;
  const requiredRoles = splitCsvFlag(flags.requireRoles || flags.requiredRoles);
  let profiles = parseCsv(flags.profiles || profile);
  if (profiles.length === 0 && target && requiredRoles.length > 0) {
    profiles = profilesFromRegistryForRoles(target, requiredRoles);
  }
  if (!profile && profiles.length === 1) profile = profiles[0];
  const intent = flags.intent
    ? String(flags.intent)
    : ((profiles.length >= 2 || requiredRoles.length > 0) ? "two-account" : "clean-target");
  const requireRegistry = flags.requireRegistry === true || Boolean(target) || requiredRoles.length > 0;
  const requireIsolation = flags.requireIsolation === true || profiles.length >= 2 || intent === "two-account";
  const suggestedNext = [];
  const addNext = (entries) => {
    for (const entry of entries || []) {
      if (entry && !suggestedNext.includes(entry)) suggestedNext.push(entry);
    }
  };
  const result = {
    schema: "agent-browser.profile.preflight.v1",
    ok: true,
    intent,
    profile,
    profiles,
    target,
    requiredRoles,
    checks: {
      backend: null,
      leaseStatuses: [],
      leaseAcquire: null,
      doctor: null,
      stuck: null,
      auth: null,
      download: null,
      registry: null,
      isolation: null,
    },
    preflightSummary: null,
    suggestedNext,
    boundary: "Profile preflight is an agent coordination check. It does not authenticate accounts, prove isolation by itself, or judge vulnerabilities.",
  };

  result.checks.backend = await backendStatus(server, { ...flags, intent });
  addNext(result.checks.backend.suggestedNext);
  if (result.checks.backend.workerError) result.ok = false;
  if (result.checks.backend.profilePortSummary?.ok === false) result.ok = false;

  const leaseProfiles = Array.from(new Set([...(profiles || []), profile].filter(Boolean)));
  const leaseOwner = flags.owner || defaultLeaseOwner();
  if (leaseProfiles.length > 0) {
    result.checks.leaseStatuses = leaseProfiles.map((leaseProfile) => profileLeaseStatusForProfile(leaseProfile, { owner: leaseOwner }));
    for (const status of result.checks.leaseStatuses) {
      addNext(status.profileLeaseSummary?.nextCommands);
      if (status.status === "leased-by-other") result.ok = false;
    }
  }

  if (leaseProfiles.length > 0 && flags.acquireLease === true) {
    const acquisitions = leaseProfiles.map((leaseProfile) => profileLeaseCommand(["profile", "lease", "acquire"], {
      profile: leaseProfile,
      owner: leaseOwner,
      purpose: flags.purpose || `preflight:${intent}`,
      ttlSeconds: flags.ttlSeconds,
      force: flags.force === true,
    }));
    for (const acquisition of acquisitions) addNext(acquisition.profileLeaseSummary?.nextCommands);
    const conflicts = acquisitions.filter((entry) => entry.ok === false);
    result.checks.leaseAcquire = acquisitions.length === 1
      ? acquisitions[0]
      : {
          ok: conflicts.length === 0,
          schema: "agent-browser.profile.lease.acquire-batch.v1",
          owner: leaseOwner,
          profiles: leaseProfiles,
          acquisitions,
          conflicts: conflicts.map((entry) => entry.conflict).filter(Boolean),
          leaseFile: profileLeaseFile(),
          profileLeaseSummary: {
            state: conflicts.length ? "conflict" : "leased",
            action: "acquire",
            owner: leaseOwner,
            profileCount: leaseProfiles.length,
            conflictCount: conflicts.length,
            nextCommands: acquisitions.flatMap((entry) => entry.profileLeaseSummary?.nextCommands || []),
            evidence: {
              source: "local profile lease file",
              leaseFile: profileLeaseFile(),
              fieldsChecked: ["profile", "owner", "expiresAt", "purpose"],
            },
            boundary: "Profile lease batch is a local coordination guard for multi-profile workflows. It does not lock Chrome itself; agents must honor it.",
          },
        };
    if (result.checks.leaseAcquire.ok === false) result.ok = false;
  }

  if (profile) {
    result.checks.doctor = await profileDoctor(server, { ...flags, profile });
    addNext(result.checks.doctor.suggestedNext);
    if (result.checks.doctor.profileState?.found === false) result.ok = false;
    if (result.checks.doctor.profileLease?.status === "leased-by-other") result.ok = false;
  }

  if (profile && flags.checkStuck === true) {
    try {
      const stuckResult = await callTool(server, "browser_stuck", { profile });
      const summary = stuckSummary(stuckResult, { profile });
      result.checks.stuck = {
        ...stuckResult,
        stuckSummary: summary,
      };
      addNext(summary.nextCommands);
      if (summary.state !== "no-obvious-blocker") result.ok = false;
    } catch (error) {
      result.checks.stuck = { ok: false, error: String(error?.message || error) };
      result.ok = false;
    }
  }

  const hasAuthCondition = Boolean(flags.successUrlContains || flags.successSelector || flags.successCookieNames);
  if (profile && (flags.checkAuth === true || hasAuthCondition)) {
    result.checks.auth = await authBootstrap(server, ["auth", "bootstrap", "status"], { ...flags, profile });
    addNext(result.checks.auth.authSummary?.nextCommands);
    if (result.checks.auth.authComplete !== true) result.ok = false;
  }

  if (profile && (flags.downloadDir || flags.dir)) {
    const download = downloadDoctor({ profile, dir: String(flags.downloadDir || flags.dir) });
    result.checks.download = download;
    addNext(download.downloadSummary?.nextCommands || download.suggestedNext);
    if (download.ok === false || download.downloadSummary?.state !== "ready") result.ok = false;
  }

  if (requireRegistry || profile) {
    result.checks.registry = profileRegistryValidate({
      ...flags,
      profile: requireRegistry ? flags.profile : profile,
      target,
      requireRoles: requiredRoles.join(","),
    });
    addNext(result.checks.registry.suggestedNext);
    if (requireRegistry && result.checks.registry.ok === false) result.ok = false;
  }

  if (requireIsolation) {
    if (profiles.length >= 2 && flags.url) {
      result.checks.isolation = await profileIsolationCheck(server, { ...flags, profiles: profiles.join(",") });
      addNext(result.checks.isolation.suggestedNext);
      if (result.checks.isolation.ok === false) result.ok = false;
    } else {
      result.checks.isolation = {
        ok: false,
        skipped: true,
        reason: profiles.length < 2
          ? "Need at least two profiles for isolation check."
          : "Pass --url <same-origin-url> to run live profile isolation check.",
        command: profiles.length >= 2
          ? `agent-browser profile isolation check --profiles ${profiles.join(",")} --url <target-url>`
          : "agent-browser profile registry validate --target <target> --require-roles attacker,victim --unique-roles",
      };
      addNext([result.checks.isolation.command]);
      result.ok = false;
    }
  }

  const blocking = [];
  if (result.checks.backend?.workerError) blocking.push("backend-unreachable");
  if (result.checks.backend?.profilePortSummary?.ok === false) blocking.push("profile-port-drift");
  if (result.checks.leaseAcquire?.ok === false) blocking.push("lease-acquire-failed");
  const leaseConflicts = (result.checks.leaseStatuses || []).filter((entry) => entry.status === "leased-by-other");
  if (leaseConflicts.length) blocking.push("profile-lease-conflict");
  if (result.checks.doctor?.profileState?.found === false) blocking.push("profile-missing");
  if (result.checks.doctor?.profileLease?.status === "leased-by-other") blocking.push("profile-leased-by-other");
  if (result.checks.stuck?.error) blocking.push("stuck-check-failed");
  if (result.checks.stuck?.stuckSummary && result.checks.stuck.stuckSummary.state !== "no-obvious-blocker") blocking.push(`page-${result.checks.stuck.stuckSummary.state}`);
  if (result.checks.auth?.authComplete === false) blocking.push(`auth-${result.checks.auth.authSummary?.state || "not-complete"}`);
  if (result.checks.download?.ok === false) blocking.push(`download-${result.checks.download.downloadSummary?.state || "not-ready"}`);
  if (result.checks.download?.ok === true && result.checks.download.downloadSummary?.state !== "ready") blocking.push(`download-${result.checks.download.downloadSummary.state}`);
  if (requireRegistry && result.checks.registry?.ok === false) blocking.push("registry-not-ready");
  if (result.checks.isolation?.ok === false) blocking.push("isolation-not-ready");

  result.preflightSummary = {
    state: blocking.length === 0 ? "ready" : "not-ready",
    blocking,
    readyForUse: blocking.length === 0,
    readyForTwoAccount: intent === "two-account" && blocking.length === 0 && profiles.length >= 2,
    nextCommands: suggestedNext,
    evidence: {
      checkedBackend: Boolean(result.checks.backend),
      profilePortSummary: result.checks.backend?.profilePortSummary || null,
      checkedLeaseStatuses: (result.checks.leaseStatuses || []).length > 0,
      checkedLeaseAcquire: Boolean(result.checks.leaseAcquire),
      checkedProfileDoctor: Boolean(result.checks.doctor),
      checkedStuck: Boolean(result.checks.stuck),
      checkedAuth: Boolean(result.checks.auth),
      checkedDownload: Boolean(result.checks.download),
      checkedRegistry: Boolean(result.checks.registry),
      checkedIsolation: Boolean(result.checks.isolation),
      leaseProfiles,
      leaseConflicts: leaseConflicts.map((entry) => entry.profile),
      profileLeaseStatus: result.checks.doctor?.profileLease?.status || null,
      stuckState: result.checks.stuck?.stuckSummary?.state || null,
      authState: result.checks.auth?.authSummary?.state || null,
      downloadState: result.checks.download?.downloadSummary?.state || null,
    },
    boundary: result.boundary,
  };

  return result;
}

async function profileIsolationCheck(server, flags) {
  const profiles = parseCsv(flags.profiles || flags.profile);
  if (profiles.length < 2) {
    throw new Error("profile isolation check requires --profiles <profile-a>,<profile-b>[,...]");
  }
  for (const profile of profiles) {
    assertProfileLeaseAvailableForCommand("profile isolation check", flags, profile);
  }

  const url = flags.url ? String(flags.url) : null;
  const waitMs = numberFlag(flags, "waitMs") ?? 1000;
  const records = [];

  for (const profile of profiles) {
    if (url) {
      await callTool(server, "browser_open", { profile, url, waitMs });
    } else {
      await callTool(server, "profile_resume", { profile }).catch(() => null);
    }

    const observed = await callTool(server, "browser_eval", {
      profile,
      expression: `(() => {
        const cookie = document.cookie || "";
        const cookieNames = cookie.split(";").map(v => v.trim().split("=")[0]).filter(Boolean).sort();
        const localStorageEntries = [];
        for (let i = 0; i < localStorage.length; i += 1) {
          const key = localStorage.key(i);
          localStorageEntries.push([key, localStorage.getItem(key)]);
        }
        const sessionStorageEntries = [];
        for (let i = 0; i < sessionStorage.length; i += 1) {
          const key = sessionStorage.key(i);
          sessionStorageEntries.push([key, sessionStorage.getItem(key)]);
        }
        localStorageEntries.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
        sessionStorageEntries.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
        return {
          href: location.href,
          origin: location.origin,
          cookie,
          cookieNames,
          localStorageEntries,
          sessionStorageEntries
        };
      })()`,
    });
    const result = observed.result || observed;
    const cookie = String(result.cookie || "");
    const localStorageEntries = Array.isArray(result.localStorageEntries) ? result.localStorageEntries : [];
    const sessionStorageEntries = Array.isArray(result.sessionStorageEntries) ? result.sessionStorageEntries : [];
    records.push({
      profile,
      href: result.href || null,
      origin: result.origin || null,
      cookieCount: Array.isArray(result.cookieNames) ? result.cookieNames.length : 0,
      cookieNames: Array.isArray(result.cookieNames) ? result.cookieNames : [],
      cookieDigest: digestValue(cookie),
      localStorageKeys: localStorageEntries.map((entry) => entry?.[0]).filter(Boolean),
      localStorageDigest: digestValue(JSON.stringify(localStorageEntries)),
      sessionStorageKeys: sessionStorageEntries.map((entry) => entry?.[0]).filter(Boolean),
      sessionStorageDigest: digestValue(JSON.stringify(sessionStorageEntries)),
    });
  }

  const comparisons = [];
  for (let i = 0; i < records.length; i += 1) {
    for (let j = i + 1; j < records.length; j += 1) {
      const left = records[i];
      const right = records[j];
      const leftCookies = new Set(left.cookieNames);
      comparisons.push({
        left: left.profile,
        right: right.profile,
        sameOrigin: left.origin === right.origin,
        sameCookieDigest: left.cookieDigest === right.cookieDigest,
        sameLocalStorageDigest: left.localStorageDigest === right.localStorageDigest,
        sameSessionStorageDigest: left.sessionStorageDigest === right.sessionStorageDigest,
        cookieNameOverlap: right.cookieNames.filter((name) => leftCookies.has(name)),
      });
    }
  }

  return {
    ok: true,
    schema: "agent-browser.profile-isolation.v1",
    boundary: "Reports objective browser storage separation signals. It does not decide whether an application authorization finding exists.",
    profiles,
    navigatedTo: url,
    records,
    comparisons,
    coverage: {
      valuesRedacted: true,
      compared: ["origin", "cookie names/digest", "localStorage keys/digest", "sessionStorage keys/digest"],
      note: "Use separate managed profiles such as target-attacker-auth and target-victim-auth for two-account tests. Identical non-empty digests across roles require investigation before trusting authorization results.",
    },
    next: [
      "agent-browser profile registry set --profile <profile> --target <target> --role attacker --account <label>",
      "agent-browser profile registry set --profile <profile> --target <target> --role victim --account <label>",
      "agent-browser capture start --profile <attacker-profile> --label two-account-test",
    ],
  };
}

function stuckSummary(result = {}, flags = {}) {
  const profile = result.profile || flags.profile || "default";
  const signals = Array.isArray(result.signals) ? result.signals : [];
  const pageState = result.pageState || {};
  const formState = result.formState || {};
  const networkState = result.networkState || {};
  const hasFormEvidence = Number(formState.formCount || 0) > 0
    || Number(formState.inputCount || 0) > 0
    || Number(pageState.visibleControlCount || 0) > 0;
  let state = "no-obvious-blocker";
  if (result.pageAccessError) {
    state = "page-access-error";
  } else if (signals.includes("submit-disabled") || Number(formState.disabledSubmitControlCount || 0) > 0) {
    state = "submit-disabled";
  } else if (Number(formState.passwordInputCount || 0) > 0) {
    state = "login-form";
  } else if ((signals.includes("blank-page") || Number(pageState.bodyTextLength || 0) === 0) && hasFormEvidence) {
    state = "unfilled-form";
  } else if (signals.includes("network-pending") || Number(networkState.stalePendingCount || 0) > 0) {
    state = "network-pending";
  } else if (signals.includes("network-failures") || Number(networkState.failedCount || 0) > 0) {
    state = "network-failures";
  } else if (signals.includes("blank-page") || Number(pageState.bodyTextLength || 0) === 0) {
    state = "blank-page";
  } else if (signals.length > 0) {
    state = "signals-present";
  }
  const nextCommands = {
    "login-form": [
      `agent-browser type "<password>" --selector "input[type=password]" --profile ${profile} --press-enter`,
      `agent-browser auth bootstrap status --profile ${profile} --success-url-contains <post-login-path>`,
      `agent-browser observe --profile ${profile}`,
    ],
    "submit-disabled": [
      `agent-browser observe --profile ${profile}`,
      `agent-browser find "<validation text>" --profile ${profile}`,
      `agent-browser see screenshot --profile ${profile}`,
    ],
    "blank-page": [
      `agent-browser see screenshot --profile ${profile}`,
      `agent-browser inspect console --profile ${profile}`,
      `agent-browser inspect network --profile ${profile}`,
    ],
    "unfilled-form": [
      `agent-browser observe --profile ${profile}`,
      `agent-browser find "<field label>" --profile ${profile}`,
      `agent-browser type "<value>" --selector "<input selector>" --profile ${profile}`,
    ],
    "network-pending": [
      `agent-browser requests --profile ${profile} --limit 20`,
      `agent-browser inspect network --profile ${profile}`,
      `agent-browser wait --profile ${profile} --request-url-contains <api-path> --timeout-ms 10000`,
    ],
    "network-failures": [
      `agent-browser requests --profile ${profile} --failed true --limit 20`,
      `agent-browser request detail <requestId> --profile ${profile}`,
      `agent-browser inspect console --profile ${profile}`,
    ],
    "page-access-error": [
      `agent-browser profile doctor --profile ${profile}`,
      `agent-browser tabs --profile ${profile}`,
      `agent-browser backend status --intent personal-current-tab`,
    ],
    "signals-present": [
      `agent-browser observe --profile ${profile}`,
      `agent-browser inspect console --profile ${profile}`,
      `agent-browser inspect network --profile ${profile}`,
    ],
    "no-obvious-blocker": [
      `agent-browser observe --profile ${profile}`,
      `agent-browser find "<visible text>" --profile ${profile}`,
      `agent-browser click --text "<button text>" --profile ${profile} --wait-mode no-navigation`,
    ],
  }[state];
  let nextAction = "Use observe/find/click/type based on the current page evidence.";
  if (state === "login-form") {
    nextAction = "Use agent-browser type with --press-enter on the password field, or auth bootstrap if this is an operator-assisted login.";
  } else if (state === "submit-disabled") {
    nextAction = "Inspect required inputs and visible validation text before clicking again.";
  } else if (state === "blank-page") {
    nextAction = "Run agent-browser see screenshot and inspect console/network for load errors.";
  } else if (state === "unfilled-form") {
    nextAction = "Use observe/find to identify required fields, then type into the visible inputs.";
  } else if (state === "network-pending") {
    nextAction = "Inspect the pending request list and wait on the concrete API path instead of repeating clicks.";
  } else if (state === "network-failures") {
    nextAction = "Open the failed request detail and console evidence before retrying the UI action.";
  } else if (state === "page-access-error") {
    nextAction = "Run agent-browser profile doctor and tabs to reattach the profile.";
  }
  return {
    state,
    signalCount: signals.length,
    formCount: Number(formState.formCount || 0),
    inputCount: Number(formState.inputCount || 0),
    passwordInputCount: Number(formState.passwordInputCount || 0),
    disabledSubmitControlCount: Number(formState.disabledSubmitControlCount || 0),
    pendingRequestCount: Number(networkState.pendingCount || 0),
    stalePendingRequestCount: Number(networkState.stalePendingCount || 0),
    failedRequestCount: Number(networkState.failedCount || 0),
    pageReadyState: pageState.readyState || null,
    evidence: {
      hasPageState: Boolean(result.pageState),
      hasFormState: Boolean(result.formState),
      hasNetworkState: Boolean(result.networkState),
      hasSignals: Array.isArray(result.signals),
      hasSuggestedNext: Array.isArray(result.suggestedNext),
      latestPending: Array.isArray(networkState.latestPending) ? networkState.latestPending : [],
      latestFailed: Array.isArray(networkState.latestFailed) ? networkState.latestFailed : [],
      captureEnabled: networkState.capture?.enabled ?? null,
      pageAccessErrorObserved: result.pageAccessError ?? null,
      sourceFields: ["pageState", "formState", "networkState", "signals", "pageAccessError", "suggestedNext"],
    },
    coverage: {
      truncated: Boolean(result.truncated),
      note: "Stuck summary is derived from browser_stuck live page evidence. It does not recover historical actions or hidden browser state.",
    },
    nextAction,
    nextCommands,
  };
}

function actionFromArgs(args, flags = {}) {
  return String(args[2] || flags.action || flags.command || "").toLowerCase();
}

function actionTargetSummary(flags = {}) {
  const selector = typeof flags.selector === "string" ? stripOuterQuotes(flags.selector) : null;
  const text = typeof flags.text === "string" ? stripOuterQuotes(flags.text) : null;
  const query = typeof flags.query === "string" ? stripOuterQuotes(flags.query) : null;
  const label = typeof flags.label === "string" ? stripOuterQuotes(flags.label) : null;
  const field = typeof flags.field === "string" ? stripOuterQuotes(flags.field) : null;
  return {
    selector,
    text,
    query: query || label || field || text || null,
    hasCoordinates: flags.x !== undefined && flags.y !== undefined,
  };
}

function waitResultSatisfied(result = {}) {
  if (result.ok === false) return false;
  if (result.waitSummary && result.waitSummary.satisfied === false) return false;
  if (result.summary && result.summary.satisfied === false) return false;
  return true;
}

async function actionDiagnose(server, args, flags = {}) {
  const action = actionFromArgs(args, flags);
  if (!action) throw new Error("action diagnose requires an action: click, type, fill, or wait");
  if (!["click", "type", "fill", "wait"].includes(action)) {
    throw new Error("action diagnose action must be click, type, fill, or wait");
  }
  const profile = flags.profile || "default";
  const target = actionTargetSummary(flags);
  const locatorWaitMs = numberFlag(flags, "locatorTimeoutMs") ?? 350;
  const networkLimit = flags.all ? 1000000 : Number(flags.limit || 20);
  const expectUrlContains = flags.expectUrlContains || flags.urlContains || null;
  const expectRequestUrlContains = flags.expectRequestUrlContains || flags.requestUrlContains || null;

  const checks = {};
  checks.stuck = await callTool(server, "browser_stuck", { profile }).catch((error) => ({ ok: false, error: errorMessage(error), code: classifyCliError(error) }));
  checks.observe = await callTool(server, "browser_observe", { profile, limit: Number(flags.observeLimit || 20) })
    .catch((error) => ({ ok: false, error: errorMessage(error), code: classifyCliError(error) }));
  checks.capture = await callTool(server, "browser_capture", capturePayload("status", { profile }))
    .catch((error) => ({ ok: false, error: errorMessage(error), code: classifyCliError(error) }));

  if (target.selector) {
    checks.locator = await callTool(server, "browser_wait", {
      profile,
      selector: target.selector,
      state: "visible",
      timeoutMs: locatorWaitMs,
      pollMs: 50,
    }).catch((error) => ({ ok: false, error: errorMessage(error), code: classifyCliError(error) }));
  } else if (target.query) {
    checks.locator = await callTool(server, "browser_find", {
      profile,
      query: target.query,
      limit: 10,
    }).catch((error) => ({ ok: false, error: errorMessage(error), code: classifyCliError(error) }));
  }

  if (expectUrlContains) {
    checks.expectedUrl = await callTool(server, "browser_wait", {
      profile,
      urlContains: String(expectUrlContains),
      timeoutMs: locatorWaitMs,
      pollMs: 50,
    }).catch((error) => ({ ok: false, error: errorMessage(error), code: classifyCliError(error) }));
  }

  if (expectRequestUrlContains) {
    checks.expectedRequest = await callRaw(server, "profile_traffic_query", {
      profile,
      urlContains: String(expectRequestUrlContains),
      limit: networkLimit,
    }).then((result) => compactRequestsResult(result, { profile, urlContains: String(expectRequestUrlContains), limit: networkLimit }))
      .catch((error) => ({ ok: false, error: errorMessage(error), code: classifyCliError(error) }));
  }

  const stuck = checks.stuck?.ok === false ? null : stuckSummary(checks.stuck, { profile });
  const blockers = [];
  const warnings = [];
  if (checks.stuck?.ok === false) blockers.push("stuck-check-unavailable");
  if (stuck && stuck.state !== "no-obvious-blocker") blockers.push(`page-${stuck.state}`);
  if (!target.selector && !target.query && !target.hasCoordinates && action !== "wait") warnings.push("no-action-target-specified");
  if (checks.locator) {
    const hasFindCandidates = Array.isArray(checks.locator.candidates) && checks.locator.candidates.length > 0;
    const locatorSatisfied = target.selector ? waitResultSatisfied(checks.locator) : hasFindCandidates;
    if (!locatorSatisfied) blockers.push("locator-not-actionable");
  }
  if (checks.expectedUrl && !waitResultSatisfied(checks.expectedUrl)) blockers.push("expected-url-not-observed");
  if (checks.expectedRequest) {
    if (checks.expectedRequest.ok === false) blockers.push("network-log-unavailable");
    else if (Number(checks.expectedRequest.returned || 0) === 0) blockers.push("expected-request-not-observed");
    if (checks.expectedRequest.truncated) warnings.push("bounded-network-log-may-hide-expected-request");
  }
  if (checks.capture?.ok === false) warnings.push("capture-status-unavailable");
  else if (checks.capture && checks.capture.captureEnabled === false) warnings.push("capture-not-enabled");

  const nextCommands = [];
  const profileArg = `--profile ${cliValue(profile)}`;
  if (stuck?.nextCommands) nextCommands.push(...stuck.nextCommands);
  if (target.selector) {
    nextCommands.push(`agent-browser wait --selector ${cliValue(target.selector)} ${profileArg} --state visible --timeout-ms 5000`);
  } else if (target.query) {
    nextCommands.push(`agent-browser find ${cliValue(target.query)} ${profileArg}`);
  } else if (!target.hasCoordinates && action !== "wait") {
    nextCommands.push(`agent-browser observe ${profileArg}`);
  }
  if (action === "click") {
    const locator = target.selector ? `--selector ${cliValue(target.selector)}` : (target.text ? `--text ${cliValue(target.text)}` : "<locator>");
    nextCommands.push(`agent-browser click ${locator} ${profileArg} --wait-mode no-navigation --action-timeout-ms 5000`);
    nextCommands.push(`agent-browser click ${locator} ${profileArg} --force-js --action-timeout-ms 5000`);
  }
  if (action === "type" || action === "fill") {
    const locator = target.selector ? `--selector ${cliValue(target.selector)}` : "<field selector>";
    nextCommands.push(`agent-browser fill ${cliValue("<value>")} ${locator} ${profileArg} --action-timeout-ms 5000`);
    nextCommands.push(`agent-browser type ${cliValue("<value>")} ${locator} ${profileArg} --press-enter --action-timeout-ms 5000`);
  }
  if (action === "wait") {
    if (target.selector) nextCommands.push(`agent-browser wait --selector ${cliValue(target.selector)} ${profileArg} --state visible --timeout-ms 10000`);
    if (expectUrlContains) nextCommands.push(`agent-browser wait --url-contains ${cliValue(expectUrlContains)} ${profileArg} --timeout-ms 10000`);
  }
  if (expectRequestUrlContains) {
    nextCommands.push(`agent-browser capture start ${profileArg} --label action-diagnose`);
    nextCommands.push(`agent-browser requests ${profileArg} --url-contains ${cliValue(expectRequestUrlContains)} --all`);
  } else {
    nextCommands.push(`agent-browser inspect network ${profileArg}`);
  }
  nextCommands.push(`agent-browser see screenshot ${profileArg}`);

  const state = blockers.length
    ? "blocked"
    : (warnings.length ? "ready-with-warnings" : "ready-to-retry");
  return {
    ok: blockers.length === 0,
    schema: "agent-browser.action.diagnose.v1",
    profile,
    action,
    state,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    target,
    expectations: {
      urlContains: expectUrlContains,
      requestUrlContains: expectRequestUrlContains,
    },
    checks,
    actionSummary: {
      state,
      nextCommands: [...new Set(nextCommands)],
      evidence: {
        checkedStuck: Boolean(checks.stuck),
        checkedObserve: Boolean(checks.observe),
        checkedCapture: Boolean(checks.capture),
        checkedLocator: Boolean(checks.locator),
        checkedExpectedUrl: Boolean(checks.expectedUrl),
        checkedExpectedRequest: Boolean(checks.expectedRequest),
        stuckState: stuck?.state || null,
      },
      boundary: "Action diagnose observes objective page/action readiness after a browser action stalls. It does not execute the action, bypass page logic, or decide business/security success.",
    },
  };
}

async function actionPreflight(server, args, flags = {}) {
  const diagnose = await actionDiagnose(server, args, flags);
  const state = diagnose.ok
    ? (diagnose.warnings?.length ? "ready-with-warnings" : "ready")
    : "not-ready";
  const preflightSummary = {
    ...diagnose.actionSummary,
    state,
    readyForAction: diagnose.ok === true,
    boundary: "Action preflight observes objective page, locator, capture, and expectation readiness before executing a browser action. It does not execute the action or infer task success.",
  };
  return {
    ...diagnose,
    schema: "agent-browser.action.preflight.v1",
    state,
    preflightSummary,
    actionSummary: preflightSummary,
    boundary: preflightSummary.boundary,
  };
}

async function runCommand(args, flags) {
  const command = args[0];
  if (!command || command === "help" || flags.help) return usage();

  if (command === "guide") return cliGuide(flags);
  if (command === "capabilities" || command === "capability") return cliCapabilities();
  if (command === "agent-chrome") return agentChromeProfileCommand(args, flags);

  const server = await serverBase(flags);

  if (command === "doctor") return await cliDoctor(server, flags);
  if (command === "ready") return await cliReady(server, args, flags);
  if (command === "health") return await requestJson(`${server}/health`);
  if (command === "tools") return await requestJson(`${server}/tools`);

  if (command === "backend") {
    const action = args[1] || "status";
    if (action === "status") return await backendStatus(server, flags);
    throw new Error("backend action must be status");
  }

  if (command === "call") {
    const tool = args[1];
    if (!tool) throw new Error("call requires a tool name");
    return await callTool(server, tool, payloadFromFlags(flags));
  }

  // Shortcut: agent-browser window hide|show [--profile <name>]
  // Without --profile, show brings ANY active playwright browser to front.
  if (command === "window") {
    const action = args[1] || "show";
    if (!["hide", "show"].includes(action)) throw new Error("window action must be hide or show");
    const toolName = `browser_window_${action}`;
    const payload = payloadFromFlags(flags);
    return await callTool(server, toolName, payload);
  }

  if (command === "raw") {
    const toolName = args[1];
    if (!toolName) throw new Error("raw requires a browser_* / profile_* / attack_* tool name");
    return await callRaw(server, toolName, payloadFromFlags(flags));
  }

  if (command === "profile") {
    const action = args[1] || "list";
    if (action === "isolation") {
      const sub = args[2] || "check";
      if (sub === "check") return await profileIsolationCheck(server, flags);
      throw new Error("profile isolation action must be check");
    }
    if (action === "ports") return await profilePortsCommand(server, args, flags);
    if (action === "registry") {
      const sub = args[2] || "list";
      if (sub === "list") return profileRegistryList(flags);
      if (sub === "get") return profileRegistryGet(flags);
      if (sub === "set") return profileRegistrySet(flags);
      if (sub === "delete") return profileRegistryDelete(flags);
      if (sub === "matrix") return profileRegistryMatrix(flags);
      if (sub === "validate") return profileRegistryValidate(flags);
      if (sub === "diagnose") return await profileRegistryDiagnose(server, flags);
      throw new Error("profile registry action must be set, get, list, delete, matrix, validate, or diagnose");
    }
    if (action === "two-account") {
      const sub = args[2] || "ready";
      if (sub === "ready") return await profileTwoAccountReady(server, flags);
      throw new Error("profile two-account action must be ready");
    }
    if (action === "lease") return profileLeaseCommand(args, flags);
    const profile = args[2] || flags.profile || flags.name;
    if (action === "list") {
      const listResult = await callTool(server, "profile_list", payloadFromFlags(flags));
      // Wave-8: annotate each profile entry with its bound backend from browser-profiles.json.
      if (listResult && Array.isArray(listResult.profiles)) {
        return { ...listResult, profiles: annotateProfilesWithBackend(listResult.profiles) };
      }
      if (Array.isArray(listResult)) {
        return annotateProfilesWithBackend(listResult);
      }
      return listResult;
    }
    if (action === "preflight") return await profilePreflight(server, { ...payloadFromFlags(flags), profile });
    if (!profile) throw new Error(`profile ${action} requires a profile name`);
    if (action === "delete") assertProfileLeaseAvailableForCommand("profile delete", flags, profile);
    if (action === "doctor") return await profileDoctor(server, { ...payloadFromFlags(flags), profile });
    const tool = { create: "profile_create", resume: "profile_resume", delete: "profile_delete" }[action];
    if (!tool) throw new Error("profile action must be list, create, resume, delete, doctor, preflight, isolation, registry, two-account, or lease");
    return await callTool(server, tool, withDefaults(flags, { profile }, ["name"]));
  }

  if (command === "tabs") return await callTool(server, "browser_tabs", payloadFromFlags(flags));

  if (command === "stuck") {
    const result = await callTool(server, "browser_stuck", payloadFromFlags(flags));
    return {
      ...result,
      stuckSummary: stuckSummary(result, flags),
    };
  }

  if (command === "action") {
    const sub = args[1] || "diagnose";
    if (sub === "preflight") return await actionPreflight(server, args, flags);
    if (sub === "diagnose") return await actionDiagnose(server, args, flags);
    throw new Error("action command must be preflight or diagnose");
  }

  if (command === "open" || command === "navigate") {
    const url = args[1] || flags.url;
    if (!url) throw new Error(`${command} requires a URL`);
    const payload = withDefaults(flags, { url }, ["url"]);
    // Wave-8: bind backend to profile on first open; auto-use on subsequent opens.
    const profileName = payload.profile || flags.profile || "default";
    const backendArg = payload.backend || flags.backend || undefined;
    const binding = bindProfileBackendOnOpen(profileName, backendArg);
    if (binding.backend && !payload.backend) payload.backend = binding.backend;
    return await guardedCallTool(server, "browser_open", payload, flags, command);
  }

  if (command === "see") {
    const mode = args[1] || "snapshot";
    const tool = { snapshot: "browser_snapshot", text: "browser_text", screenshot: "browser_screenshot" }[mode];
    if (!tool) throw new Error("see mode must be snapshot, text, or screenshot");
    if (mode === "screenshot") return await cliScreenshot(server, flags);
    return await callTool(server, tool, payloadFromFlags(flags));
  }

  if (command === "snapshot") return await callTool(server, "browser_snapshot", payloadFromFlags(flags));
  if (command === "text") return await callTool(server, "browser_text", payloadFromFlags(flags));
  if (command === "screenshot") return await cliScreenshot(server, flags);

  if (command === "observe") {
    const result = await callTool(server, "browser_observe", payloadFromFlags(flags));
    if (result && typeof result === "object" && !result.next && !result.suggestedNext) {
      const profile = result.profile || flags.profile || "default";
      result.suggestedNext = [`agent-browser stuck --profile ${profile}`];
    }
    return result;
  }

  if (command === "find") {
    const query = args.slice(1).join(" ") || flags.query;
    if (!query) throw new Error("find requires a query");
    return await callTool(server, "browser_find", normalizeLocatorPayload(withDefaults(flags, { query }, ["query"])));
  }

  if (command === "click") {
    const payload = normalizeLocatorPayload(payloadFromFlags(flags));
    if (payload.forceJs === true && !payload.inputMode) payload.inputMode = "dom";
    if (flags.x !== undefined) payload.x = numberFlag(flags, "x");
    if (flags.y !== undefined) payload.y = numberFlag(flags, "y");
    return await guardedCallTool(server, "browser_click", payload, flags, command);
  }

  if (command === "hover") {
    const payload = normalizeLocatorPayload(payloadFromFlags(flags));
    if (flags.x !== undefined) payload.x = numberFlag(flags, "x");
    if (flags.y !== undefined) payload.y = numberFlag(flags, "y");
    return await guardedCallTool(server, "browser_hover", payload, flags, command);
  }

  if (["dblclick", "double-click", "double_click"].includes(command)) {
    const payload = normalizeLocatorPayload(payloadFromFlags(flags));
    if (flags.x !== undefined) payload.x = numberFlag(flags, "x");
    if (flags.y !== undefined) payload.y = numberFlag(flags, "y");
    return await guardedCallTool(server, "browser_double_click", payload, flags, command);
  }

  if (command === "drag") {
    const payload = normalizeLocatorPayload(payloadFromFlags(flags));
    if (payload.toSelector !== undefined && payload.targetSelector === undefined) payload.targetSelector = stripOuterQuotes(String(payload.toSelector));
    if (payload.toText !== undefined && payload.targetText === undefined) payload.targetText = stripOuterQuotes(String(payload.toText));
    if (typeof payload.targetSelector === "string") payload.targetSelector = stripOuterQuotes(payload.targetSelector);
    if (typeof payload.targetText === "string") payload.targetText = stripOuterQuotes(payload.targetText);
    for (const key of ["x", "y", "toX", "toY", "deltaX", "deltaY"]) {
      if (flags[key] !== undefined) payload[key] = numberFlag(flags, key);
    }
    return await guardedCallTool(server, "browser_drag", payload, flags, command);
  }

  if (command === "type") {
    const text = args.slice(1).join(" ") || flags.value || flags.text;
    if (!text) throw new Error("type requires text");
    const payload = normalizeLocatorPayload(withDefaults(flags, { text }, ["value"]));
    return await guardedCallTool(server, "browser_type", payload, flags, command);
  }

  if (command === "fill") {
    const text = args.slice(1).join(" ") || flags.value || flags.text;
    if (!text) throw new Error("fill requires text");
    assertProfileLeaseAvailableForCommand(command, flags, flags.profile || "default");
    const payload = await resolveFillPayload(server, { ...flags, clear: flags.clear !== false }, text);
    const raw = await callTool(server, "browser_type", payload);
    return {
      ok: raw?.ok !== false,
      schema: "agent-browser.fill.v1",
      profile: raw?.profile || payload.profile || "default",
      selector: payload.selector || null,
      resolvedLocator: payload.resolvedLocator || null,
      textLength: String(text).length,
      clear: payload.clear !== false,
      inputMode: raw?.inputMode || payload.inputMode || "keyboard",
      pressEnter: Boolean(payload.pressEnter),
      result: raw,
      fillSummary: {
        state: raw?.ok === false ? "failed" : "filled",
        nextCommands: [
          `agent-browser wait --selector ${JSON.stringify(payload.selector || "<selector>")} --profile ${payload.profile || "default"} --state visible`,
          `agent-browser stuck --profile ${payload.profile || "default"}`,
        ],
        evidence: {
          usedBrowserType: true,
          clearBeforeInput: payload.clear !== false,
          resolvedLocator: payload.resolvedLocator || null,
          actionabilityWait: raw?.actionabilityWait || null,
        },
        boundary: "Fill is a CLI alias over browser_type with clear=true by default. It waits for an editable field and inputs text; it does not bypass page validation or authentication.",
      },
    };
  }

  if (command === "press") {
    const key = args.slice(1).join(" ") || flags.key;
    if (!key) throw new Error("press requires a key or combo");
    const payload = normalizeLocatorPayload(withDefaults(flags, { key }, ["key"]));
    return await guardedCallTool(server, "browser_press", payload, flags, command);
  }

  if (command === "wait") {
    return await callTool(server, "browser_wait", normalizeLocatorPayload(payloadFromFlags(flags)));
  }

  if (command === "select") {
    const payload = normalizeLocatorPayload(payloadFromFlags(flags));
    return await guardedCallTool(server, "browser_select", payload, flags, command);
  }

  if (command === "upload") {
    const file = args[1] || flags.file;
    const payload = withDefaults(flags, {
      ...(file ? { file } : {}),
      ...(flags.files ? { files: splitListFlag(flags.files) } : {}),
    }, ["file", "files"]);
    return await guardedCallTool(server, "browser_upload", normalizeLocatorPayload(payload), flags, command);
  }

  if (command === "download") {
    const action = String(args[1] || flags.action || "").toLowerCase();
    if (action === "doctor") return downloadDoctor(flags);
    if (action === "diagnose") return await downloadDiagnose(server, flags);
    if (["start", "stop"].includes(action)) assertProfileLeaseAvailableForCommand(`download ${action}`, flags, flags.profile || "default");
    if (["start", "status", "stop"].includes(action)) return await browserDownloadWatch(server, action, flags);
    return await browserDownload(server, flags);
  }

  if (command === "auth") {
    const action = args[1] || "bootstrap";
    if (action === "diagnose") return await authDiagnose(server, flags);
    if (action === "bootstrap") {
      const bootstrapAction = String(args[2] || flags.action || (flags.loginUrl || flags.url ? "start" : "status")).toLowerCase();
      if (bootstrapAction !== "status") assertProfileLeaseAvailableForCommand(`auth bootstrap ${bootstrapAction}`, flags, flags.profile || "default");
    }
    if (action === "bootstrap") return await authBootstrap(server, args, flags);
    throw new Error("auth action must be bootstrap or diagnose");
  }

  if (command === "form") {
    const action = args[1] || "fill";
    if (action === "fill") assertProfileLeaseAvailableForCommand("form fill", flags, flags.profile || "default");
    if (action === "fill") return await formFill(server, flags);
    throw new Error("form action must be fill");
  }

  if (command === "workflow") {
    const action = args[1] || "run";
    if (action === "diagnose") return workflowDiagnose(flags);
    if (action === "run") return await runWorkflow(server, flags);
    if (action === "professional-appsec") {
      return await callRaw(server, "browser_workflow_guide", withDefaults(flags, { task: "professional-appsec" }, ["task"]));
    }
    throw new Error("workflow action must be run, diagnose, or professional-appsec");
  }

  if (command === "scroll") {
    const payload = payloadFromFlags(flags, ["direction", "amount"]);
    const amount = Math.abs(flags.amount !== undefined ? numberFlag(flags, "amount") : 600);
    const direction = String(flags.direction || "down").toLowerCase();
    if (payload.x === undefined && payload.y === undefined) {
      if (direction === "up") payload.y = -amount;
      else if (direction === "down") payload.y = amount;
      else if (direction === "left") payload.x = -amount;
      else if (direction === "right") payload.x = amount;
      else throw new Error("scroll --direction must be down, up, left, or right");
    }
    return await guardedCallTool(server, "browser_scroll", payload, flags, command);
  }

  if (command === "eval") {
    const expression = args.slice(1).join(" ") || flags.expression;
    if (!expression) throw new Error("eval requires an expression");
    const payload = withDefaults(flags, { expression }, ["expression"]);
    return await guardedCallTool(server, "browser_eval", payload, flags, command);
  }

  if (command === "capture") {
    const action = args[1] || "status";
    const payload = capturePayload(action, flags);
    if (action !== "status") assertProfileLeaseAvailableForCommand(`capture ${action}`, flags, payload.profile || flags.profile || "default");
    return await callTool(server, "browser_capture", payload);
  }

  if (command === "inspect") {
    const mode = args[1] || flags.mode || flags.focus || "overview";
    if (mode === "security") return await callTool(server, "browser_security_summary", payloadFromFlags(flags));
    return await callTool(server, "browser_inspect", withDefaults(flags, { mode }, ["mode", "focus"]));
  }

  if (command === "security") {
    const action = args[1] || "summary";
    if (action === "summary") return await callTool(server, "browser_security_summary", payloadFromFlags(flags));
    throw new Error("security action must be summary");
  }

  if (command === "evidence") {
    const action = args[1] || "bundle";
    const tool = {
      bundle: "browser_evidence_bundle",
      manifest: "browser_evidence_manifest",
      timeline: "browser_evidence_timeline",
    }[action];
    if (!tool) throw new Error("evidence action must be bundle, manifest, or timeline");
    return await callTool(server, tool, payloadFromFlags(flags));
  }

  if (command === "pack") {
    const url = args[1] || flags.url;
    return await callTool(server, "browser_security_pack", packPayload(url, flags));
  }

  if (command === "network") {
    const mode = args[1] || "summary";
    const tool = { summary: "profile_traffic_summary", log: "profile_traffic_query", timeline: "profile_network_timeline" }[mode];
    if (!tool) throw new Error("network mode must be summary, log, or timeline");
    return await callRaw(server, tool, payloadFromFlags(flags));
  }

  if (command === "requests") {
    const diagnose = args[1] === "diagnose";
    const urlContains = (diagnose ? args.slice(2).join(" ") : args.slice(1).join(" ")) || flags.urlContains || flags.url_contains;
    const payload = withDefaults(flags, {
      ...(urlContains ? { urlContains } : {}),
      limit: flags.all ? 1000000 : Number(flags.limit || 20),
    }, ["urlContains", "url_contains", "all"]);
    if (diagnose) return await requestsDiagnose(server, payload);
    const result = await callRaw(server, "profile_traffic_query", payload);
    return compactRequestsResult(result, payload);
  }

  if (command === "request") {
    const action = args[1] || "detail";
    const requestId = args[2] || flags.requestId;
    if (!requestId) throw new Error("request requires a requestId");
    if (action === "diagnose") return await requestDiagnose(server, requestId, flags);
    const tool = {
      detail: "profile_request_detail",
      payload: "profile_request_payload",
      body: "profile_traffic_get",
      replay: "profile_request_replay",
      "replay-batch": "profile_request_replay_batch",
    }[action];
    if (!tool) throw new Error("request action must be detail, payload, body, diagnose, replay, or replay-batch");
    if (action === "replay") {
      assertProfileLeaseAvailableForCommand("request replay", flags, flags.profile || "default");
      const raw = await callRaw(server, tool, replayPayload(requestId, flags));
      return replayResult(raw, requestId, flags);
    }
    if (action === "replay-batch") {
      assertProfileLeaseAvailableForCommand("request replay-batch", flags, flags.profile || "default");
      const raw = await callRaw(server, tool, replayBatchPayload(requestId, flags));
      return replayBatchResult(raw, requestId, flags);
    }
    return await callRaw(server, tool, withDefaults(flags, { requestId }, ["requestId"]));
  }

  if (command === "graphql") {
    const action = args[1] || "requests";
    if (action === "requests" || action === "list") {
      return await graphqlRequests(server, flags);
    }
    const requestId = args[2] || flags.requestId;
    if (!requestId) throw new Error(`graphql ${action} requires a requestId`);
    if (action === "payload" || action === "inspect") {
      return await graphqlPayload(server, requestId, flags);
    }
    if (["intercept-plan", "intercept", "in-flight", "inflight"].includes(action)) {
      return await graphqlInterceptPlan(server, requestId, flags);
    }
    if (action === "replay") {
      if (!flags.variablesJson) throw new Error("graphql replay requires --variables-json");
      assertProfileLeaseAvailableForCommand("graphql replay", flags, flags.profile || "default");
      const payloadInfo = await graphqlPayload(server, requestId, flags);
      if (!payloadInfo.parseOk) throw new Error(`cannot parse GraphQL body: ${payloadInfo.parseError}`);
      const body = mergeGraphqlVariables(payloadInfo.body, JSON.parse(String(flags.variablesJson)));
      const replayFlags = {
        ...flags,
        jsonBody: JSON.stringify(body),
      };
      const raw = await callRaw(server, "profile_request_replay", replayPayload(requestId, replayFlags));
      return replayResult(raw, requestId, replayFlags, "GraphQL replay patches variables, then uses the page fetch layer. Results may differ from actual browser context.");
    }
    throw new Error("graphql action must be requests, payload, replay, or intercept-plan");
  }

  if (command === "api") {
    const action = args[1] || "map";
    if (action === "map") return await apiMap(server, flags);
    throw new Error("api action must be map");
  }

  if (command === "replay") {
    const requestId = args[1] || flags.requestId;
    if (!requestId) throw new Error("replay requires a requestId");
    assertProfileLeaseAvailableForCommand(command, flags, flags.profile || "default");
    const raw = await callRaw(server, "profile_request_replay", replayPayload(requestId, flags));
    return replayResult(raw, requestId, flags);
  }

  if (command === "replay-batch") {
    const requestId = args[1] || flags.requestId;
    if (!requestId) throw new Error("replay-batch requires a requestId");
    assertProfileLeaseAvailableForCommand(command, flags, flags.profile || "default");
    const raw = await callRaw(server, "profile_request_replay_batch", replayBatchPayload(requestId, flags));
    return replayBatchResult(raw, requestId, flags);
  }

  if (command === "repeater") {
    return await runRepeaterCommand(server, args, flags);
  }

  if (command === "bookmark") {
    return await bookmarkRequest(server, args, flags);
  }

  if (command === "bookmarks") {
    const action = args[1] || "list";
    if (action === "list") return listBookmarks(flags);
    if (action === "delete") return deleteBookmark(args, flags);
    throw new Error("bookmarks action must be list or delete");
  }

  if (command === "export") {
    return await exportRequest(server, args, flags);
  }

  if (command === "import") {
    return importRequest(args, flags);
  }

  if (command === "intercept") {
    const action = args[1] || "list";
    if (!["start", "list", "diagnose", "continue", "fail", "evidence", "handoff"].includes(action)) {
      throw new Error("intercept action must be start, list, diagnose, continue, fail, evidence, or handoff");
    }
    const capturedRequestId = args[2] || flags.capturedRequestId || flags.captured_request_id;
    if (["continue", "fail"].includes(action) && !capturedRequestId) {
      throw new Error(`intercept ${action} requires a capturedRequestId`);
    }
    if (["start", "continue", "fail"].includes(action)) {
      assertProfileLeaseAvailableForCommand(`intercept ${action}`, flags, flags.profile || "default");
    }
    if (action === "diagnose") {
      const raw = await callTool(server, "cdp_fetch_intercept", interceptPayload("list", null, flags));
      return interceptDiagnose(raw, { ...flags, capturedRequestId, captured_request_id: capturedRequestId });
    }
    if (action === "evidence") {
      const raw = await callTool(server, "cdp_fetch_intercept", interceptPayload("list", null, flags));
      return interceptEvidencePackage(raw, { ...flags, capturedRequestId, captured_request_id: capturedRequestId });
    }
    if (action === "handoff") {
      return await interceptHandoff(server, capturedRequestId, flags);
    }
    const payload = interceptPayload(action, capturedRequestId, flags);
    const raw = await callTool(server, "cdp_fetch_intercept", payload);
    return interceptResult(action, raw, { ...flags, capturedRequestId, captured_request_id: capturedRequestId });
  }

  if (PANEL_TO_TOOL[command]) {
    return await callRaw(server, PANEL_TO_TOOL[command], payloadFromFlags(flags));
  }

  if (command === "sources") {
    const action = args[1] || "list";
    if (action === "list") return await callRaw(server, "browser_sources_list", payloadFromFlags(flags));
    if (action === "search") {
      const query = args.slice(2).join(" ") || flags.query;
      if (!query) throw new Error("sources search requires a query");
      return await callRaw(server, "browser_sources_search", withDefaults(flags, { query }, ["query"]));
    }
    throw new Error("sources action must be list or search");
  }

  if (command === "artifact") {
    const action = args[1] || "index";
    if (action === "index") return await callRaw(server, "browser_artifact_index", payloadFromFlags(flags));
    if (action === "inspect") {
      const path = args[2] || flags.path;
      if (!path) throw new Error("artifact inspect requires a path");
      return await callRaw(server, "browser_artifact_inspect", withDefaults(flags, { path }, ["path"]));
    }
    if (action === "read") {
      const path = args[2] || flags.path;
      if (!path) throw new Error("artifact read requires a path");
      return await callRaw(server, "browser_artifact_read", withDefaults(flags, { path }, ["path"]));
    }
    if (action === "search") {
      const query = args.slice(2).join(" ") || flags.query;
      if (!query) throw new Error("artifact search requires a query");
      return await callRaw(server, "browser_artifact_search", withDefaults(flags, { query }, ["query"]));
    }
    throw new Error("artifact action must be index, inspect, read, or search");
  }

  if (command === "readiness") {
    return await callRaw(server, "browser_professional_readiness", payloadFromFlags(flags));
  }

  if (command === "feedback") {
    const summary = args.slice(1).join(" ") || flags.summary || flags.title;
    if (!summary) throw new Error("feedback requires a summary");
    const payload = withDefaults(flags, {
      summary,
      title: flags.title || summary,
      type: normalizeFeedbackType(flags.type),
    }, ["summary", "title"]);
    return await callTool(server, "browser_feedback", payload);
  }

  if (command === "compare") {
    return await compareEvidence(server, args, flags);
  }

  if (command === "token-scan") {
    return await callRaw(server, "browser_token_scan", payloadFromFlags(flags, ["limit"]));
  }

  if (command === "global-search") {
    const query = args.slice(1).join(" ") || flags.query;
    if (!query) throw new Error("global-search requires a query");
    const payload = withDefaults(flags, { query }, ["query", "caseSensitive", "maxMatches"]);
    if (flags["case-sensitive"] !== undefined && payload.caseSensitive === undefined) {
      payload.caseSensitive = flags["case-sensitive"];
    }
    return await callRaw(server, "browser_global_search", payload);
  }

  if (command === "authed-record") {
    return await authedRecord(server, args, flags);
  }

  if (command === "intruder") {
    const action = args[1];
    if (!action) throw new Error("intruder requires an action: create, run, pause, resume, status, results, evidence");
    if (action === "create") {
      const specRaw = flags["spec-json"] || flags.spec;
      if (!specRaw) throw new Error("intruder create requires --spec-json");
      const spec = typeof specRaw === "string" ? JSON.parse(specRaw) : specRaw;
      const payload = { spec, ...payloadFromFlags(flags, ["jobId"]) };
      if (flags["request-id"]) payload.requestId = flags["request-id"];
      if (flags["job-id"]) payload.jobId = flags["job-id"];
      return await callRaw(server, "attack_intruder_create", payload);
    }
    if (action === "run") {
      const payload = payloadFromFlags(flags, ["jobId", "maxVariants", "batchSize", "delayMs"]);
      if (flags["job-id"]) payload.jobId = flags["job-id"];
      if (flags["max-variants"] !== undefined) payload.maxVariants = Number(flags["max-variants"]);
      if (flags["batch-size"] !== undefined) payload.batchSize = Number(flags["batch-size"]);
      if (flags["delay-ms"] !== undefined) payload.delayMs = Number(flags["delay-ms"]);
      return await callRaw(server, "attack_intruder_run", payload);
    }
    if (action === "pause") {
      const payload = payloadFromFlags(flags, ["jobId"]);
      if (flags["job-id"]) payload.jobId = flags["job-id"];
      return await callRaw(server, "attack_intruder_pause", payload);
    }
    if (action === "resume") {
      const payload = payloadFromFlags(flags, ["jobId", "maxVariants", "batchSize", "delayMs"]);
      if (flags["job-id"]) payload.jobId = flags["job-id"];
      if (flags["max-variants"] !== undefined) payload.maxVariants = Number(flags["max-variants"]);
      if (flags["batch-size"] !== undefined) payload.batchSize = Number(flags["batch-size"]);
      if (flags["delay-ms"] !== undefined) payload.delayMs = Number(flags["delay-ms"]);
      return await callRaw(server, "attack_intruder_resume", payload);
    }
    if (action === "status") {
      const payload = payloadFromFlags(flags, ["jobId"]);
      if (flags["job-id"]) payload.jobId = flags["job-id"];
      return await callRaw(server, "attack_intruder_status", payload);
    }
    if (action === "results") {
      const payload = payloadFromFlags(flags, ["jobId", "limit"]);
      if (flags["job-id"]) payload.jobId = flags["job-id"];
      return await callRaw(server, "attack_intruder_results", payload);
    }
    if (action === "evidence") {
      const payload = payloadFromFlags(flags, ["jobId"]);
      if (flags["job-id"]) payload.jobId = flags["job-id"];
      return await callRaw(server, "attack_intruder_evidence", payload);
    }
    throw new Error("intruder action must be create, run, pause, resume, status, results, or evidence");
  }

  throw new Error(`unknown command: ${command}\n\n${usage()}`);
}

function errorMessage(error) {
  if (error?.data?.error) return String(error.data.error);
  return String(error?.message || error || "Unknown error");
}

function classifyCliError(error) {
  if (error?.code === "profile_lease_conflict" || error?.profileLeaseGuard) return "profile_lease_conflict";
  const message = errorMessage(error).toLowerCase();
  if (message.includes("browser_raw only allows")) return "input_unsupported_raw_tool";
  if (message.includes("raw requires a")) return "input_invalid_raw_tool";
  if (message.includes("forbidden header") || message.includes("unsafe header") || message.includes("refused to set")) return "replay_forbidden_header";
  if (message.includes("unknown command")) return "input_unknown_command";
  if (message.includes("requires") || message.includes("must be")) return "input_invalid_arguments";
  if (message.includes("profile") && (message.includes("not found") || message.includes("missing"))) return "profile_not_found";
  if (message.includes("requestid") && message.includes("not found")) return "network_request_not_found";
  if (message.includes("body") && (message.includes("expired") || message.includes("no longer"))) return "network_request_body_expired";
  if (message.includes("capture") && message.includes("not")) return "network_capture_not_started";
  if (message.includes("target detached") || message.includes("session closed")) return "cdp_target_detached";
  if (message.includes("cdp") || message.includes("devtools protocol")) return "cdp_command_failed";
  if (message.includes("fetch failed") || message.includes("econnrefused") || message.includes("connection refused")) return "backend_unavailable";
  if (error?.status) return `backend_http_${error.status}`;
  return "backend_command_failed";
}

function interactionActionForCommand(command) {
  if (["click", "hover", "dblclick", "double-click", "double_click", "press", "select", "drag"].includes(command)) return "click";
  if (["type", "fill", "upload"].includes(command)) return "type";
  if (command === "wait") return "wait";
  return null;
}

function actionDiagnoseRecoveryCommand(args = [], flags = {}) {
  const command = args[0] || "";
  const action = interactionActionForCommand(command);
  if (!action) return null;
  const profile = flags.profile || "<profile>";
  const parts = ["agent-browser", "action", "diagnose", action, "--profile", cliValue(profile)];
  const selector = flags.selector ? stripOuterQuotes(String(flags.selector)) : null;
  const text = flags.text ? stripOuterQuotes(String(flags.text)) : null;
  if (selector) parts.push("--selector", cliValue(selector));
  else if (text) parts.push("--text", cliValue(text));
  if (flags.expectUrlContains) parts.push("--expect-url-contains", cliValue(flags.expectUrlContains));
  if (flags.expectRequestUrlContains || flags.requestUrlContains) {
    parts.push("--expect-request-url-contains", cliValue(flags.expectRequestUrlContains || flags.requestUrlContains));
  }
  return parts.join(" ");
}

function suggestionForCliError(code, args, flags) {
  const profile = flags.profile || "<profile>";
  const command = args[0] || "help";
  const actionRecovery = actionDiagnoseRecoveryCommand(args, flags);
  if (actionRecovery && (code === "backend_command_failed" || code.startsWith("backend_http_") || code === "cdp_command_failed" || code === "cdp_target_detached")) {
    return `Run ${actionRecovery} to inspect page state, locator readiness, capture status, and expected URL/request evidence before retrying.`;
  }
  if (code === "input_unsupported_raw_tool" || code === "input_invalid_raw_tool") {
    return "Use agent-browser raw <browser_*|profile_*|attack_* tool> --json '{\"profile\":\"<profile>\"}', or use agent-browser call for facade tools.";
  }
  if (code === "input_unknown_command") return "Run agent-browser help, then choose a named command before falling back to raw/call.";
  if (code === "input_invalid_arguments") return `Run agent-browser help and retry the ${command} command with the required arguments.`;
  if (code === "profile_not_found") return `Run agent-browser profile list, then agent-browser profile create ${profile} or agent-browser profile resume ${profile}.`;
  if (code === "network_request_not_found") return `Run agent-browser requests --profile ${profile} --all, or start capture and reproduce the action.`;
  if (code === "network_request_body_expired") return `Run agent-browser capture start --profile ${profile}, reproduce the action, then read the request payload again.`;
  if (code === "network_capture_not_started") return `Run agent-browser capture start --profile ${profile}, then reload or reproduce the browser action.`;
  if (code === "cdp_target_detached") return `Run agent-browser tabs and agent-browser profile resume ${profile}; retry after the profile is attached.`;
  if (code === "replay_forbidden_header") return "Remove browser-controlled headers such as content-length, host, cookie, sec-*, or accept-encoding from the replay edit. If the exact in-browser request context is required, use agent-browser intercept start/list/continue.";
  if (code === "profile_lease_conflict") return `This profile is leased by another agent. Run agent-browser profile lease status --profile ${profile}, use the current owner, or acquire/release the lease deliberately.`;
  if (code === "backend_unavailable") return "Run agent-browser doctor and agent-browser backend status; start the worker with npm run agent:server if needed.";
  return "Run agent-browser doctor, then retry with a smaller command or inspect the profile with agent-browser profile doctor --profile <profile>.";
}

function nextForCliError(code, args, flags, error = null) {
  const profile = flags.profile || "<profile>";
  const requestId = args[1] || flags.requestId || "<requestId>";
  const command = args[0] || "";
  const actionRecovery = actionDiagnoseRecoveryCommand(args, flags);
  if (actionRecovery && (code === "backend_command_failed" || code.startsWith("backend_http_") || code === "cdp_command_failed" || code === "cdp_target_detached")) {
    return [
      actionRecovery,
      `agent-browser observe --profile ${profile}`,
      `agent-browser stuck --profile ${profile}`,
      `agent-browser see screenshot --profile ${profile}`,
    ];
  }
  if (code === "replay_forbidden_header") {
    return [
      `agent-browser request detail ${requestId} --profile ${profile}`,
      `agent-browser request payload ${requestId} --profile ${profile}`,
      `agent-browser replay ${requestId} --profile ${profile} --headers-json '{}' --json-body '{...}'`,
      `agent-browser intercept start --profile ${profile} --url-pattern <request-url-fragment>`,
    ];
  }
  if (code === "profile_lease_conflict") {
    const guard = error?.profileLeaseGuard;
    return guard?.nextCommands || [
      `agent-browser profile lease status --profile ${profile}`,
      `agent-browser profile preflight ${profile} --owner <agent-name>`,
      `agent-browser profile lease acquire --profile ${profile} --owner <agent-name>`,
    ];
  }
  if (command === "repeater") {
    const sessionId = args[2] || flags.sessionId || "<sessionId>";
    return [
      `agent-browser repeater history ${sessionId} --profile ${profile}`,
      `agent-browser repeater list --profile ${profile} --include-closed`,
      `agent-browser repeater plan <requestId> --profile ${profile}`,
    ];
  }
  return [];
}

function formatCliError(error, args, flags) {
  const code = classifyCliError(error);
  const next = nextForCliError(code, args, flags, error);
  const actionRecovery = actionDiagnoseRecoveryCommand(args, flags);
  const includeActionRecovery = Boolean(actionRecovery)
    && (code === "backend_command_failed" || code.startsWith("backend_http_") || code === "cdp_command_failed" || code === "cdp_target_detached");
  return {
    ok: false,
    schema: "agent-browser.error.v1",
    command: args[0] || null,
    profile: flags.profile || null,
    error: {
      code,
      message: errorMessage(error),
      suggestion: suggestionForCliError(code, args, flags),
      ...(next.length ? { next } : {}),
      ...(includeActionRecovery ? {
        recovery: {
          kind: "browser-action-diagnose",
          command: actionRecovery,
          boundary: "This recovery path observes objective page/action readiness. It does not retry the action or infer task success.",
        },
      } : {}),
      ...(code === "replay_forbidden_header" ? { boundary: "Replay edits run through browser fetch/CDP constraints. Browser-controlled headers may be rejected; remove them or use intercept for in-flight request editing." } : {}),
      ...(error?.profileLeaseGuard ? { details: error.profileLeaseGuard } : {}),
      ...(error?.status ? { status: error.status, statusText: error.statusText || "" } : {}),
      ...(error?.data ? { details: error.data } : {}),
    },
  };
}

async function main() {
  const { args, flags } = parseArgs(process.argv.slice(2));
  const result = await runCommand(args, flags);
  if (typeof result === "string") console.log(result);
  else console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  const { args, flags } = parseArgs(process.argv.slice(2));
  console.log(JSON.stringify(formatCliError(error, args, flags), null, 2));
  process.exit(1);
});