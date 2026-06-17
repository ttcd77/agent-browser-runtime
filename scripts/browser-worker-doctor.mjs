#!/usr/bin/env node

const DEFAULT_BASE_URL = "http://127.0.0.1:17335";
const DEFAULT_PERSONAL_BASE_URL = "http://127.0.0.1:17337";
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
const personalBaseUrl = trimTrailingSlash(
  process.env.AGENT_BROWSER_PERSONAL_URL ||
  process.env.PERSONAL_CHROME_HTTP_URL ||
  DEFAULT_PERSONAL_BASE_URL,
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
  backendRouting: {
    managed: {
      baseUrl,
      useWhen: [
        "Agent-owned browser profile is fine.",
        "You need repeatable F12/CDP evidence, clean profiles, HARs, traces, replay, heap/coverage, or isolated target identities.",
        "You are opening a target from scratch through Browser Runtime.",
      ],
    },
    personalChrome: {
      baseUrl: personalBaseUrl,
      useWhen: [
        "The user says personal, my Chrome, real Chrome, current tab, already logged in, or a managed login is blocked.",
        "You need the human's real cookies, extensions, browser history/reputation, or active logged-in page.",
        "You need to attach after Chrome is already open. Use the extension bridge; do not try to retrofit --remote-debugging-port.",
      ],
      startCommand: "npm run personal:chrome",
      bridgeRule: "Personal Chrome is an extension bridge on 17337. Managed Browser is CDP on 17335/9222. Do not copy cookies or Chrome profiles as the first recovery path when the extension bridge is available.",
    },
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
      "cd <path-to>\\agent-browser-runtime",
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
  personalChrome: null,
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

try {
  const personalHealth = await fetchJson(`${personalBaseUrl}/health`, timeoutMs);
  result.personalChrome = {
    ok: personalHealth?.ok === true,
    baseUrl: personalBaseUrl,
    connected: Number(personalHealth?.connected || 0),
    activeTab: personalHealth?.activeTab || null,
    tools: Array.isArray(personalHealth?.tools) ? personalHealth.tools.length : 0,
    useFor: result.backendRouting.personalChrome.useWhen,
  };
  if (result.personalChrome.ok && result.personalChrome.connected > 0) {
    result.nextActions.push("Personal Chrome bridge is available. For real Chrome/current logged-in tabs, call tools at AGENT_BROWSER_PERSONAL_URL or PERSONAL_CHROME_HTTP_URL instead of the managed worker.");
  } else {
    result.nextActions.push("Personal Chrome bridge is not connected. To inspect the user's already-open Chrome, run npm run personal:chrome and ensure the unpacked extension is enabled.");
  }
} catch (error) {
  result.personalChrome = {
    ok: false,
    baseUrl: personalBaseUrl,
    connected: 0,
    error: String(error?.message || error),
    useFor: result.backendRouting.personalChrome.useWhen,
  };
  result.nextActions.push("Personal Chrome bridge is unavailable. Run npm run personal:chrome when the user asks to inspect their real/current/logged-in Chrome.");
}

// --- Windows Scheduled Task checks (Windows only) ---
if (process.platform === "win32") {
  result.scheduledTasks = {};
  const tasks = [
    {
      key: "agentServer",
      name: "AgentBrowserRuntime-AgentServer",
      reinstallCommand: "powershell -ExecutionPolicy Bypass -File scripts\\install-agent-server-task.ps1",
    },
    {
      key: "personalBridge",
      name: "AgentBrowserRuntime-PersonalBridge",
      reinstallCommand: "powershell -ExecutionPolicy Bypass -File scripts\\install-personal-bridge-task.ps1",
    },
  ];

  for (const task of tasks) {
    try {
      const taskResult = await queryScheduledTask(task.name);
      result.scheduledTasks[task.key] = taskResult;
      if (!taskResult.registered) {
        result.nextActions.push(`Scheduled Task '${task.name}' is not registered — run: ${task.reinstallCommand}`);
      } else if (taskResult.lastTaskResult !== 0) {
        const hex = `0x${taskResult.lastTaskResult.toString(16).toUpperCase().padStart(8, "0")}`;
        const explanation = explainTaskResultCode(taskResult.lastTaskResult);
        result.nextActions.push(
          `Scheduled Task '${task.name}' last run failed (${hex}: ${explanation}) — run: ${task.reinstallCommand}`,
        );
      }
    } catch (err) {
      result.scheduledTasks[task.key] = { registered: null, error: String(err?.message || err) };
    }
  }
}

console.log(JSON.stringify(result, null, 2));
if (strict && !result.ok) process.exit(1);

/**
 * Query a Windows Scheduled Task by name using schtasks.exe.
 * Returns { registered, taskName, status, lastTaskResult, lastRunTime }.
 */
async function queryScheduledTask(taskName) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  try {
    const { stdout } = await execFileAsync(
      "schtasks",
      ["/query", "/tn", taskName, "/v", "/fo", "LIST"],
      { timeout: 8000, windowsHide: true },
    );
    // Parse key fields from LIST output
    const getField = (label) => {
      const re = new RegExp(`^${label}:\\s*(.+)$`, "im");
      const m = stdout.match(re);
      return m ? m[1].trim() : null;
    };
    const lastTaskResultRaw = getField("Last Result");
    // schtasks returns decimal on English locale but may return hex on some
    let lastTaskResult = 0;
    if (lastTaskResultRaw !== null) {
      const parsed = lastTaskResultRaw.startsWith("0x") || lastTaskResultRaw.startsWith("0X")
        ? parseInt(lastTaskResultRaw, 16)
        : parseInt(lastTaskResultRaw, 10);
      lastTaskResult = isNaN(parsed) ? -1 : parsed >>> 0; // treat as uint32
    }
    return {
      registered: true,
      taskName,
      status: getField("Status") || getField("Scheduled Task State") || null,
      lastTaskResult,
      lastRunTime: getField("Last Run Time") || null,
    };
  } catch (err) {
    // schtasks exits 1 with "ERROR: The system cannot find the file specified." when task not found
    const msg = String(err?.message || err);
    if (msg.includes("cannot find") || msg.includes("does not exist") || (err?.code === 1 && msg.includes("ERROR:"))) {
      return { registered: false, taskName };
    }
    throw err;
  }
}

/**
 * Return a human-readable explanation for common Windows task result codes.
 * https://docs.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-error-and-success-constants
 */
function explainTaskResultCode(code) {
  // treat as uint32 for comparison
  const u = code >>> 0;
  const map = {
    0x00000000: "Success",
    0x00041300: "Task is ready to run at its next scheduled time",
    0x00041301: "Task is currently running",
    0x00041303: "Task has not yet run",
    0x00041305: "One or more of the properties that are needed to run this task have not been set",
    0x0004130B: "Task is disabled",
    0x41303:    "Task directory / working directory not found (workdir mismatch — re-run install script from the correct project root)",
    0x80041305: "Task is disabled",
    0x80070002: "Working directory or executable not found (path changed — re-run install script)",
    0x8007010B: "The directory name is invalid (working directory not found)",
    0xC000013A: "Application exited due to Ctrl+C / SIGINT",
    0xC0000142: "Application failed to initialize",
    0xFFFFFFFF: "Unspecified error",
  };
  if (map[u] !== undefined) return map[u];
  // 267011 decimal = 0x41303
  if (u === 267011) return "Task directory / working directory not found (workdir mismatch — re-run install script from the correct project root)";
  return "unknown error code";
}

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
