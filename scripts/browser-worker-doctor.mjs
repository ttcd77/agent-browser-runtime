#!/usr/bin/env node

const DEFAULT_BASE_URL = "http://127.0.0.1:17335";
const FACADE_TOOLS = [
  "browser_open",
  "browser_act",
  "browser_inspect",
  "browser_capture",
  "browser_security_pack",
  "browser_auth_boundary",
  "browser_diff",
  "browser_replay",
  "browser_raw",
];

const args = new Set(process.argv.slice(2));
const strict = args.has("--strict");
const baseUrl = trimTrailingSlash(
  process.env.AGENT_BROWSER_RUNTIME_URL ||
  process.env.AGENT_BROWSER_SERVER ||
  DEFAULT_BASE_URL,
);
const timeoutMs = Number(process.env.AGENT_BROWSER_WORKER_DOCTOR_TIMEOUT_MS || 5000);

const result = {
  schema: "agent-browser-runtime.browser-worker-doctor.v1",
  checkedAt: new Date().toISOString(),
  ok: false,
  baseUrl,
  endpoints: {
    health: `${baseUrl}/health`,
    tools: `${baseUrl}/tools`,
    tool: `${baseUrl}/tool/{toolName}`,
    panel: `${baseUrl}/panel`,
  },
  facadeTools: FACADE_TOOLS,
  sdk: {
    env: {
      AGENT_BROWSER_RUNTIME_URL: baseUrl,
    },
    toolRequestType: "browser_runtime_call",
    owner: "browser_worker",
    exampleFile: "examples/sdk-browser-worker-requests.json",
  },
  startCommand: {
    powershell: [
      "cd C:\\Users\\Tong\\project\\agent-browser-runtime",
      "$env:CDP_LAUNCH_BROWSER=\"1\"",
      "npm run agent:server",
    ],
    bash: [
      "cd /path/to/agent-browser-runtime",
      "CDP_LAUNCH_BROWSER=1 npm run agent:server",
    ],
  },
  objectiveBoundary: "Collect browser/F12 evidence only; do not decide whether a signal is a vulnerability.",
  health: null,
  toolCatalog: null,
  nextActions: [],
};

try {
  result.health = await fetchJson(`${baseUrl}/health`, timeoutMs);
  const catalog = await fetchJson(`${baseUrl}/tools`, timeoutMs);
  const names = Array.isArray(catalog?.tools) ? catalog.tools.map((tool) => tool?.name).filter(Boolean) : [];
  result.toolCatalog = {
    count: names.length,
    facadeAvailable: FACADE_TOOLS.filter((name) => names.includes(name)),
    facadeMissing: FACADE_TOOLS.filter((name) => !names.includes(name)),
  };
  result.ok = result.health?.ok === true && result.toolCatalog.facadeMissing.length === 0;
  if (!result.ok) {
    result.nextActions.push("Worker is reachable, but at least one facade tool is missing. Rebuild and restart the server.");
  }
} catch (error) {
  result.nextActions.push("Start the Browser Worker with CDP_LAUNCH_BROWSER=1 npm run agent:server.");
  result.nextActions.push("If another service owns the port, set AGENT_BROWSER_RUNTIME_URL for clients and CDP_AGENT_SERVER_PORT for the runtime.");
  result.error = String(error?.message || error);
}

console.log(JSON.stringify(result, null, 2));
if (strict && !result.ok) process.exit(1);

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    return text.trim() ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}
