#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  navigateCdpToOrigin,
  openCdpPageSession,
} from "./lib/origin-state-clone.mjs";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const defaultBridgeUrl = process.env.PERSONAL_CHROME_HTTP_URL || "http://127.0.0.1:17337";
const strict = process.argv.includes("--strict");
const only = new Set(process.argv
  .filter((arg) => arg.startsWith("--only="))
  .flatMap((arg) => arg.slice("--only=".length).split(",").map((v) => v.trim()).filter(Boolean)));
const include = (name) => only.size === 0 || only.has(name);

const results = [];

function record(name, status, detail = {}) {
  const entry = { name, status, ...detail };
  results.push(entry);
  const suffix = detail.reason ? ` — ${detail.reason}` : detail.summary ? ` — ${detail.summary}` : "";
  console.log(`${status.padEnd(6)} ${name}${suffix}`);
}

async function step(name, fn) {
  if (!include(name)) return;
  try {
    const detail = await fn();
    record(name, "PASS", detail || {});
  } catch (error) {
    if (error?.skip) {
      record(name, "SKIP", { reason: error.message });
      return;
    }
    record(name, "FAIL", { reason: String(error?.message || error) });
    if (strict) throw error;
  }
}

function skip(message) {
  const error = new Error(message);
  error.skip = true;
  return error;
}

async function httpJson(url, { method = "GET", body, timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }
    if (!response.ok) {
      const error = new Error(`${method} ${url} -> ${response.status}: ${text.slice(0, 300)}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function callTool(baseUrl, name, body = {}, timeoutMs = 10000) {
  return await httpJson(`${baseUrl}/tool/${encodeURIComponent(name)}`, {
    method: "POST",
    body,
    timeoutMs,
  });
}

async function startBridge({ httpPort, wsPort, profilesRoot, portBase }) {
  const child = spawn(process.execPath, ["scripts/personal-chrome-bridge.mjs"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PERSONAL_CHROME_HTTP_PORT: String(httpPort),
      PERSONAL_CHROME_WS_PORT: String(wsPort),
      ABR_PROFILES_ROOT: profilesRoot,
      ABR_CHROME_PORT_BASE: String(portBase),
    },
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.stdout.on("data", () => {});
  const baseUrl = `http://127.0.0.1:${httpPort}`;
  for (let i = 0; i < 40; i += 1) {
    try {
      await httpJson(`${baseUrl}/health`, { timeoutMs: 500 });
      return { child, baseUrl };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  try { child.kill(); } catch { /* already gone */ }
  throw new Error(`temporary bridge did not start on ${baseUrl}${stderr ? `: ${stderr.slice(0, 500)}` : ""}`);
}

async function stopBridge(handle) {
  if (!handle?.child || handle.child.killed) return;
  try {
    await httpJson(`${handle.baseUrl}/shutdown`, { method: "POST", body: {}, timeoutMs: 1000 }).catch(() => null);
  } finally {
    try { handle.child.kill(); } catch { /* already gone */ }
  }
}

async function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(`<!doctype html>
<title>ABR Acceptance Fixture</title>
<h1>ABR Acceptance Fixture</h1>
<a id="next" href="/next">Go next</a>
<script>
  localStorage.setItem("abr-acceptance-local", "ready");
</script>`);
      return;
    }
    if (url.pathname === "/next") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(`<!doctype html><title>ABR Acceptance Next</title><h1>ABR Acceptance Next</h1>`);
      return;
    }
    if (url.pathname === "/api/session") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": "abr_acceptance_session=raw-http; Path=/; SameSite=Lax",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ ok: true, marker: "abr-acceptance-api" }));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    origin: `http://127.0.0.1:${server.address().port}`,
  };
}

function collectTools(toolsPayload) {
  const raw = toolsPayload?.tools || {};
  if (Array.isArray(raw)) return new Set(raw.map((tool) => typeof tool === "string" ? tool : tool.name).filter(Boolean));
  return new Set(Object.keys(raw));
}

async function runChild(command, args, { timeoutMs = 120000, env = {} } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      reject(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

await step("tool-contract", async () => {
  const suffix = randomUUID().slice(0, 6);
  const tempRoot = mkdtempSync(join(tmpdir(), `abr-acceptance-contract-${suffix}-`));
  const httpPort = 18100 + Math.floor(Math.random() * 500);
  const handle = await startBridge({
    httpPort,
    wsPort: httpPort - 1,
    profilesRoot: tempRoot,
    portBase: httpPort + 1000,
  });
  try {
    const tools = collectTools(await httpJson(`${handle.baseUrl}/tools`));
    for (const required of [
      "browser_tool_help",
      "browser_workflow_guide",
      "browser_professional_readiness",
      "personal_chrome_read_page",
      "personal_chrome_click_ref",
      "profile_create",
      "profile_delete",
      "profile_clone_origin_state",
    ]) {
      assert.equal(tools.has(required), true, `missing tool: ${required}`);
    }

    for (const tool of ["personal_chrome_read_page", "personal_chrome_click_ref", "profile_create", "profile_clone_origin_state"]) {
      const help = await callTool(handle.baseUrl, "browser_tool_help", { tool });
      assert.equal(help.name, tool);
      assert.ok(Object.keys(help.parameters?.properties || {}).length > 0, `${tool} has empty parameter schema`);
    }

    const tasks = [
      "professional-appsec",
      "first-pass",
      "security-research-pack",
      "network-capture",
      "request-replay",
      "auth-boundary",
      "before-after-diff",
      "source-debug",
      "performance",
    ];
    for (const task of tasks) {
      const guide = await callTool(handle.baseUrl, "browser_workflow_guide", { task });
      for (const stepDef of guide.steps || []) {
        const tool = String(stepDef.tool || "");
        if (!tool || tool.startsWith("<")) continue;
        assert.equal(tools.has(tool), true, `workflow ${task} references missing tool ${tool}`);
      }
    }
    return { summary: `${tools.size} tools, ${tasks.length} workflows checked` };
  } finally {
    await stopBridge(handle);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

await step("personal-chrome-safe-tab", async () => {
  const health = await httpJson(`${defaultBridgeUrl}/health`, { timeoutMs: 1500 }).catch(() => null);
  if (!health?.connected) throw skip(`Personal Chrome bridge unavailable or no extension connected at ${defaultBridgeUrl}`);

  const fixture = await startFixtureServer();
  let tabId = null;
  try {
    const browsers = await callTool(defaultBridgeUrl, "personal_chrome_list_browsers", {});
    const browser = (browsers.browsers || []).find((entry) => entry.browserDisplayName || entry.browserInstanceId);
    if (!browser) throw skip("no routable Personal Chrome browser identity");
    const browserSelector = browser.browserDisplayName || browser.browserInstanceId;
    const opened = await callTool(defaultBridgeUrl, "personal_chrome_open", {
      browser: browserSelector,
      url: `${fixture.origin}/`,
      newTab: true,
      active: false,
    });
    tabId = opened.tab?.id;
    assert.ok(tabId, `open did not return tab id: ${JSON.stringify(opened)}`);

    const page = await callTool(defaultBridgeUrl, "personal_chrome_read_page", { tabId, maxChars: 4000 });
    assert.equal(page.url, `${fixture.origin}/`);
    assert.match(page.pageContent || "", /ABR Acceptance Fixture/);
    const linkRef = /\[(ref_\d+)\]/.exec((page.pageContent || "").split("\n").find((line) => /Go next/.test(line)) || "")?.[1];
    assert.ok(linkRef, `read_page did not expose ref for link: ${page.pageContent}`);

    const beforeUrl = page.url;
    const clicked = await callTool(defaultBridgeUrl, "personal_chrome_click_ref", { tabId, ref: linkRef });
    assert.equal(clicked.ok, true, `click_ref failed: ${JSON.stringify(clicked)}`);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const after = await callTool(defaultBridgeUrl, "personal_chrome_read_page", { tabId, maxChars: 4000 });
    assert.notEqual(after.url, beforeUrl, "click_ref reported ok but URL did not change");
    assert.equal(after.url, `${fixture.origin}/next`);
    assert.match(after.pageContent || "", /ABR Acceptance Next/);
    return { summary: `opened background tab ${tabId}, read_page -> click_ref -> verified URL` };
  } finally {
    if (tabId) {
      await callTool(defaultBridgeUrl, "personal_chrome_tab_close", { tabId }).catch(() => null);
    }
    await new Promise((resolve) => fixture.server.close(resolve));
  }
});

await step("agent-browser-lifecycle", async () => {
  const sourceTemplate = join(homedir(), "abr-chrome", "_template");
  if (!existsSync(sourceTemplate)) throw skip(`Agent Browser template missing: ${sourceTemplate}`);

  const suffix = randomUUID().slice(0, 8);
  const tempRoot = mkdtempSync(join(tmpdir(), `abr-acceptance-agent-browser-${suffix}-`));
  cpSync(sourceTemplate, join(tempRoot, "_template"), { recursive: true });
  const httpPort = 18600 + Math.floor(Math.random() * 500);
  const profile = `accept-${suffix}`;
  const fixture = await startFixtureServer();
  const handle = await startBridge({
    httpPort,
    wsPort: httpPort - 1,
    profilesRoot: tempRoot,
    portBase: httpPort + 1000,
  });
  let cdp = null;
  try {
    const created = await callTool(handle.baseUrl, "profile_create", { name: profile }, 60000);
    assert.equal(created.profile, profile);
    assert.ok(created.cdpPort, `profile_create missing cdpPort: ${JSON.stringify(created)}`);
    cdp = await openCdpPageSession(created.cdpPort);
    const nav = await navigateCdpToOrigin(cdp, fixture.origin, { force: true });
    assert.equal(new URL(nav.url).origin, fixture.origin);
    const title = await cdp.send("Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true,
    });
    assert.equal(title.result?.value, "ABR Acceptance Fixture");
    const listed = await callTool(handle.baseUrl, "profile_list", {});
    assert.equal((listed.spawned || []).some((entry) => entry.name === profile), true, "profile_list did not show created Agent Browser");
    const deleted = await callTool(handle.baseUrl, "profile_delete", { name: profile, removeData: true }, 30000);
    assert.equal(deleted.ok, true);
    assert.equal(deleted.removed, true);
    return { summary: `profile_create -> CDP navigate -> profile_delete (${profile})` };
  } finally {
    if (cdp) await cdp.close().catch(() => null);
    await callTool(handle.baseUrl, "profile_delete", { name: profile, removeData: true }, 30000).catch(() => null);
    await stopBridge(handle);
    await new Promise((resolve) => fixture.server.close(resolve));
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

await step("agent-browser-warmup", async () => {
  const sourceTemplate = join(homedir(), "abr-chrome", "_template");
  if (!existsSync(sourceTemplate)) throw skip(`Agent Browser template missing: ${sourceTemplate}`);
  const tempRoot = mkdtempSync(join(tmpdir(), "abr-acceptance-warmup-"));
  try {
    const result = await runChild(process.execPath, ["scripts/session-clone-self-test.mjs"], {
      timeoutMs: 180000,
      env: { ABR_PROFILES_ROOT: tempRoot, ABR_CHROME_PORT_BASE: String(19600 + Math.floor(Math.random() * 300)) },
    });
    assert.match(result.stdout, /session-clone-self-test: PASS/);
    return { summary: "httpOnly cookie, localStorage, sessionStorage, IndexedDB cloned" };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

await step("raw-http", async () => {
  const result = await runChild(process.execPath, ["scripts/raw-request-smoke.mjs"], { timeoutMs: 60000 });
  assert.match(result.stdout, /raw-request smoke: PASS/);
  return { summary: "raw socket request and race primitive smoke passed" };
});

const failed = results.filter((entry) => entry.status === "FAIL");
const skipped = results.filter((entry) => entry.status === "SKIP");
console.log("\nABR acceptance summary:");
console.log(JSON.stringify({
  total: results.length,
  passed: results.filter((entry) => entry.status === "PASS").length,
  skipped: skipped.length,
  failed: failed.length,
  strict,
}, null, 2));

if (failed.length || (strict && skipped.length)) {
  process.exit(1);
}
