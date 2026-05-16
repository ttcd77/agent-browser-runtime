import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import net from "node:net";
import CDP from "chrome-remote-interface";

const root = process.cwd();
const tempDir = mkdtempSync(join(tmpdir(), "oc-cdp-live-smoke-"));
const profileName = "smoke-buyer";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function cleanupTempDir(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  } catch (err) {
    console.warn(`Warning: temporary directory cleanup failed: ${err}`);
    console.warn(`Temporary directory left at: ${path}`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

function browserExecutable() {
  if (process.env.CDP_BROWSER_EXECUTABLE) return process.env.CDP_BROWSER_EXECUTABLE;
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          ]
        : [
            "/usr/bin/microsoft-edge",
            "/usr/bin/microsoft-edge-stable",
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
          ];
  return candidates.find((candidate) => existsSync(candidate));
}

async function waitForCdp(port) {
  const url = `http://127.0.0.1:${port}/json/version`;
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // keep waiting
    }
    await sleep(250);
  }
  throw new Error(`browser CDP endpoint did not start: ${url}`);
}

function startTestServer() {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/api/smoke")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, source: "live-browser-smoke" }));
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
<html>
  <head><title>CDP live smoke</title></head>
  <body>
    <h1>CDP live smoke</h1>
    <script>
      console.log("live smoke page loaded");
      fetch("/api/smoke?nonce=${Date.now()}")
        .then((r) => r.json())
        .then((data) => console.log("smoke fetch", data.ok));
    </script>
  </body>
</html>`);
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

function createMockOpenClawApi() {
  const tools = new Map();
  const services = [];
  const logger = {
    debug: (...args) => console.debug(...args),
    info: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
  };
  return {
    tools,
    services,
    api: {
      logger,
      registerTool(factory) {
        const tool = factory({});
        tools.set(tool.name, tool);
      },
      registerService(service) {
        services.push(service);
      },
    },
  };
}

async function callTool(tools, name, params) {
  const tool = tools.get(name);
  assert(tool, `tool not registered: ${name}`);
  const result = await tool.execute("live-smoke", params);
  return JSON.parse(result.content[0].text);
}

async function waitForToolCondition(tools, name, params, predicate, label, timeoutMs = 15000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await callTool(tools, name, params);
    if (predicate(last)) return last;
    await sleep(500);
  }
  throw new Error(`${label} timed out. Last result: ${JSON.stringify(last)}`);
}

let browser;
let pageClient;
let server;

try {
  const executable = browserExecutable();
  assert(
    executable,
    "No Edge/Chrome executable found. Set CDP_BROWSER_EXECUTABLE to run this smoke test.",
  );

  const cdpPort = await freePort();
  const userDataDir = join(tempDir, "browser-user-data");
  browser = spawn(
    executable,
    [
      `--remote-debugging-port=${cdpPort}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--headless=new",
      "about:blank",
    ],
    { stdio: "ignore", detached: false },
  );

  await waitForCdp(cdpPort);

  const configPath = join(tempDir, "openclaw.json");
  writeFileSync(
    configPath,
    JSON.stringify({ browser: { profiles: { [profileName]: { cdpPort } } } }, null, 2),
    "utf8",
  );
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  process.env.CDP_SECURITY_DATA_DIR = join(tempDir, "data");

  const entry = await import(
    pathToFileURL(join(root, "dist/plugins/cdp-traffic-capture/index.js")).href
  );
  const harness = createMockOpenClawApi();
  entry.default.register(harness.api);
  for (const service of harness.services) {
    await service.start?.();
  }

  await waitForToolCondition(
    harness.tools,
    "cdp_self_test",
    { profile: profileName },
    (result) => result.connected === true,
    "CDP plugin connection",
  );

  server = await startTestServer();
  const appPort = server.address().port;
  const targets = await CDP.List({ port: cdpPort });
  const pageTarget = targets.find((target) => target.type === "page");
  assert(pageTarget, "No browser page target found");
  pageClient = await CDP({ port: cdpPort, target: pageTarget.id });
  await pageClient.Page.enable();
  await pageClient.Page.navigate({ url: `http://127.0.0.1:${appPort}/` });

  const traffic = await waitForToolCondition(
    harness.tools,
    "cdp_query",
    { profile: profileName, type: "traffic", url_contains: "/api/smoke", limit: 10 },
    (result) => Array.isArray(result.requests) && result.requests.some((r) => r.status === 200),
    "captured /api/smoke request",
  );

  const request = traffic.requests.find((entry) => entry.status === 200);
  assert(request?.requestId, "Captured request did not include requestId");
  const detail = await waitForToolCondition(
    harness.tools,
    "cdp_get",
    { profile: profileName, type: "traffic_detail", id: request.requestId },
    (result) => result.response?.status === 200 && Boolean(result.bodyPath),
    "traffic_detail body capture",
  );
  assert(detail.response?.status === 200, "traffic_detail did not return status 200");
  assert(detail.bodyPath, "traffic_detail did not include a bodyPath");

  console.log("Live browser smoke passed:");
  console.log(`- browser CDP port: ${cdpPort}`);
  console.log(`- test page: http://127.0.0.1:${appPort}/`);
  console.log("- plugin connected to a real browser page");
  console.log("- cdp_query captured /api/smoke");
  console.log("- cdp_get returned full traffic detail and bodyPath");

  for (const service of harness.services.reverse()) {
    await service.stop?.();
  }
} finally {
  if (pageClient) await pageClient.close().catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve));
  if (browser && !browser.killed) {
    browser.kill();
    await waitForExit(browser);
  }
  cleanupTempDir(tempDir);
}
