import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function waitForExit(child, timeoutMs = 10000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function waitForHealth(port) {
  const url = `http://127.0.0.1:${port}/health`;
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // keep waiting
    }
    await sleep(300);
  }
  throw new Error(`agent server did not become healthy: ${url}`);
}

async function cdpReachable(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForCdpDrop(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await cdpReachable(port)) return true;
    await sleep(150);
  }
  return false;
}

function runCli(args, serverPort, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "scripts/agent-browser-cli.mjs",
      ...args,
      "--server",
      `http://127.0.0.1:${serverPort}`,
    ], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      let parsed = null;
      try {
        parsed = stdout ? JSON.parse(stdout) : null;
      } catch {
        parsed = null;
      }
      if (code !== 0) {
        const error = new Error(`agent-browser CLI failed ${code}: ${stderr || stdout}`);
        error.stdout = stdout;
        error.stderr = stderr;
        error.json = parsed;
        reject(error);
        return;
      }
      resolve(parsed);
    });
  });
}

function startTestServer() {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/api/profile-smoke")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, profileSmoke: true, url: req.url }));
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
<title>Researcher Space</title>
<button id="go" onclick="fetch('/api/profile-smoke?source=click')">Go</button>
<div id="spa-signup"><span>Sign up</span></div>
<input id="msg" onkeydown="if(event.key === 'Enter') fetch('/api/profile-smoke?source=type')">
<script>
fetch("/api/profile-smoke").then((r) => r.json()).then((data) => console.log(data.ok));
document.getElementById("spa-signup").addEventListener("click", () => fetch("/api/profile-smoke?source=spa-signup"));
</script>`);
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

const serverPort = await freePort();
const personalBridgePort = await freePort();
const testServer = await startTestServer();
const testServerPort = testServer.address().port;
const dataDir = mkdtempSync(join(tmpdir(), "agent-browser-runtime-server-smoke-"));
const preexistingConfigPath = join(dataDir, "browser-profiles.json");
writeFileSync(
  preexistingConfigPath,
  `${JSON.stringify({
    browser: {
      profiles: {
        "agent-server-smoke": { cdpPort: 9222 },
        "legacy-attacker-auth": { cdpPort: 9222 },
      },
    },
  }, null, 2)}\n`,
  "utf8",
);
const child = spawn(
  process.execPath,
  ["scripts/agent-cdp-server.mjs"],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CDP_LAUNCH_BROWSER: "1",
      CDP_AGENT_SERVER_PORT: String(serverPort),
      CDP_AGENT_PROFILE: "agent-server-smoke",
      CDP_BROWSER_HEADLESS: "1",
      CDP_SECURITY_DATA_DIR: dataDir,
      AGENT_BROWSER_PERSONAL_URL: `http://127.0.0.1:${personalBridgePort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  const health = await waitForHealth(serverPort);
  if (!health.browserProcess?.managedByWorker || !health.browserProcess.running || !health.browserProcess.pid) {
    throw new Error(`health did not expose managed browser process state: ${JSON.stringify(health.browserProcess)}`);
  }
  if (health.cdpPortMode !== "ephemeral" || health.requestedCdpPort !== 0 || !health.cdpPort || health.cdpPort <= 0) {
    throw new Error(`health did not expose ephemeral managed CDP state: ${JSON.stringify({ cdpPort: health.cdpPort, requestedCdpPort: health.requestedCdpPort, cdpPortMode: health.cdpPortMode })}`);
  }
  if (health.profilePortSummary?.state !== "runtime-managed" || health.profilePortSummary?.ok !== true) {
    throw new Error(`ephemeral CDP mode should not block on profile port drift: ${JSON.stringify(health.profilePortSummary)}`);
  }
  if (health.profilePortSummary?.ignoredMismatchedCount !== 0 || health.profilePortSummary?.ports?.[String(health.cdpPort)] !== 2) {
    throw new Error(`ephemeral CDP mode did not reconcile preexisting profile ports: ${JSON.stringify(health.profilePortSummary)}`);
  }
  if (health.profilePortReconciliation?.changedCount !== 1 || health.profilePortReconciliation?.state !== "reconciled") {
    throw new Error(`health did not expose profile port reconciliation: ${JSON.stringify(health.profilePortReconciliation)}`);
  }
  const liveBrowserPort = health.cdpPort;
  const firstBrowserPid = health.browserProcess.pid;
  try {
    process.kill(firstBrowserPid);
  } catch {
    // If the platform has already reaped the process, the next health check still proves reachability.
  }
  if (await waitForCdpDrop(liveBrowserPort)) {
    const recoveredHealth = await waitForHealth(serverPort);
    if (!recoveredHealth.ok || recoveredHealth.cdpHealth?.recovered !== true || recoveredHealth.browserProcess?.pid === firstBrowserPid) {
      throw new Error(`health did not recover a killed managed browser: ${JSON.stringify(recoveredHealth)}`);
    }
  }
  const cliEnv = {
    CDP_SECURITY_DATA_DIR: dataDir,
    AGENT_BROWSER_OWNER: "agent-server-smoke-cli",
  };
  const cliDoctor = await runCli(["doctor"], serverPort, cliEnv);
  if (!cliDoctor.ok || cliDoctor.schema !== "agent-browser.doctor.v1") {
    throw new Error(`agent-browser doctor did not read live worker: ${JSON.stringify(cliDoctor)}`);
  }
  const cliProfile = "cli-live-researcher";
  const cliCreate = await runCli(["profile", "create", cliProfile], serverPort, cliEnv);
  if (!cliCreate.ok || cliCreate.profile?.name !== cliProfile) {
    throw new Error(`agent-browser profile create failed against live worker: ${JSON.stringify(cliCreate)}`);
  }
  const cliLease = await runCli(["profile", "lease", "acquire", "--profile", cliProfile, "--owner", "agent-server-smoke-cli", "--ttl-seconds", "60"], serverPort, cliEnv);
  if (!cliLease.ok || cliLease.profileLeaseSummary?.state !== "leased") {
    throw new Error(`agent-browser CLI lease acquire failed: ${JSON.stringify(cliLease)}`);
  }
  const cliCapture = await runCli(["capture", "start", "--profile", cliProfile, "--label", "cli-live-smoke", "--owner", "agent-server-smoke-cli"], serverPort, cliEnv);
  if (!cliCapture.capture?.enabled && cliCapture.ok === false) {
    throw new Error(`agent-browser capture start failed against live worker: ${JSON.stringify(cliCapture)}`);
  }
  const cliOpen = await runCli(["open", `http://127.0.0.1:${testServerPort}/?cli=1`, "--profile", cliProfile, "--wait-ms", "700", "--owner", "agent-server-smoke-cli"], serverPort, cliEnv);
  if (cliOpen.profile !== cliProfile && cliOpen.profile?.name !== cliProfile) {
    throw new Error(`agent-browser open did not use CLI profile: ${JSON.stringify(cliOpen)}`);
  }
  const cliFill = await runCli(["fill", "from-cli", "--selector", "#msg", "--profile", cliProfile, "--owner", "agent-server-smoke-cli"], serverPort, cliEnv);
  if (cliFill.schema !== "agent-browser.fill.v1" || cliFill.result?.value !== "from-cli") {
    throw new Error(`agent-browser fill did not drive live worker input: ${JSON.stringify(cliFill)}`);
  }
  const cliRequests = await runCli(["requests", "--profile", cliProfile, "--url-contains", "/api/profile-smoke", "--limit", "20"], serverPort, cliEnv);
  if (!Array.isArray(cliRequests.requests) || cliRequests.requests.length === 0 || cliRequests.coverage?.truncated === true) {
    throw new Error(`agent-browser requests did not read live network evidence: ${JSON.stringify(cliRequests)}`);
  }
  const cliLeaseConflict = await runCli(["open", `http://127.0.0.1:${testServerPort}/?blocked=1`, "--profile", cliProfile, "--owner", "other-agent"], serverPort, cliEnv).catch((error) => error);
  if (!cliLeaseConflict.json || cliLeaseConflict.json.error?.code !== "profile_lease_conflict") {
    throw new Error(`agent-browser CLI did not block conflicting live profile owner: ${JSON.stringify(cliLeaseConflict.json || cliLeaseConflict.message)}`);
  }
  const cliLeaseRelease = await runCli(["profile", "lease", "release", "--profile", cliProfile, "--owner", "agent-server-smoke-cli"], serverPort, cliEnv);
  if (!cliLeaseRelease.released) {
    throw new Error(`agent-browser CLI lease release failed: ${JSON.stringify(cliLeaseRelease)}`);
  }
  const cliDownloadDir = mkdtempSync(join(dataDir, "cli-downloads-"));
  const cliDownloadDoctor = await runCli(["download", "doctor", "--profile", cliProfile, "--dir", cliDownloadDir], serverPort, cliEnv);
  if (!cliDownloadDoctor.ok || cliDownloadDoctor.downloadSummary?.state !== "ready") {
    throw new Error(`agent-browser download doctor did not accept live download dir: ${JSON.stringify(cliDownloadDoctor)}`);
  }
  const cliDownloadStart = await runCli(["download", "start", "--profile", cliProfile, "--dir", cliDownloadDir, "--owner", "agent-server-smoke-cli"], serverPort, cliEnv);
  if (cliDownloadStart.schema !== "agent-browser.download.watch.v1" || cliDownloadStart.downloadSummary?.state !== "watching") {
    throw new Error(`agent-browser download start did not arm live watcher: ${JSON.stringify(cliDownloadStart)}`);
  }
  const cliDownloadDiagnose = await runCli(["download", "diagnose", "--profile", cliProfile, "--dir", cliDownloadDir], serverPort, cliEnv);
  if (cliDownloadDiagnose.schema !== "agent-browser.download.diagnose.v1" || cliDownloadDiagnose.downloadSummary?.evidence?.checkedCdpWatchStatus !== true) {
    throw new Error(`agent-browser download diagnose did not combine live watcher and directory evidence: ${JSON.stringify(cliDownloadDiagnose)}`);
  }
  const cliAuthProfile = "cli-auth-bootstrap";
  const cliAuthUrl = `http://127.0.0.1:${testServerPort}/?auth=cli`;
  const cliAuthStart = await runCli(["auth", "bootstrap", "start", "--profile", cliAuthProfile, "--url", cliAuthUrl, "--success-url-contains", "auth=cli", "--owner", "agent-server-smoke-cli"], serverPort, cliEnv);
  if (cliAuthStart.schema !== "agent-browser.auth.bootstrap.v1" || cliAuthStart.action !== "start" || cliAuthStart.authSummary?.state !== "operator-action-needed") {
    throw new Error(`agent-browser auth bootstrap start failed against live worker: ${JSON.stringify(cliAuthStart)}`);
  }
  const cliAuthStatus = await runCli(["auth", "bootstrap", "status", "--profile", cliAuthProfile, "--success-url-contains", "auth=cli"], serverPort, cliEnv);
  if (cliAuthStatus.authComplete !== true || cliAuthStatus.authSummary?.state !== "complete") {
    throw new Error(`agent-browser auth bootstrap status did not observe live success condition: ${JSON.stringify(cliAuthStatus)}`);
  }
  const cliAuthFinish = await runCli(["auth", "bootstrap", "finish", "--profile", cliAuthProfile, "--success-url-contains", "auth=cli", "--owner", "agent-server-smoke-cli"], serverPort, cliEnv);
  if (cliAuthFinish.authComplete !== true || cliAuthFinish.capture?.enabled) {
    throw new Error(`agent-browser auth bootstrap finish did not stop live capture: ${JSON.stringify(cliAuthFinish)}`);
  }
  const attackerProfile = "cli-live-attacker";
  const victimProfile = "cli-live-victim";
  const registryTarget = "cli-live-target";
  await runCli(["profile", "create", attackerProfile], serverPort, cliEnv);
  await runCli(["profile", "create", victimProfile], serverPort, cliEnv);
  await runCli(["profile", "registry", "set", "--profile", attackerProfile, "--project", "agent-browser-runtime", "--platform", "fixture.local", "--account", "attacker@example.test", "--target", registryTarget, "--role", "attacker"], serverPort, cliEnv);
  await runCli(["profile", "registry", "set", "--profile", victimProfile, "--project", "agent-browser-runtime", "--platform", "fixture.local", "--account", "victim@example.test", "--target", registryTarget, "--role", "victim"], serverPort, cliEnv);
  const cliRegistryValidate = await runCli(["profile", "registry", "validate", "--target", registryTarget, "--require-roles", "attacker,victim", "--unique-roles"], serverPort, cliEnv);
  if (!cliRegistryValidate.ok || cliRegistryValidate.validationSummary?.readyForTwoAccount !== true) {
    throw new Error(`agent-browser registry validate did not mark live two-account metadata ready: ${JSON.stringify(cliRegistryValidate)}`);
  }
  const cliRegistryDiagnose = await runCli(["profile", "registry", "diagnose", "--target", registryTarget, "--require-roles", "attacker,victim", "--unique-roles", "--check-live"], serverPort, cliEnv);
  if (!cliRegistryDiagnose.ok || cliRegistryDiagnose.registrySummary?.evidence?.checkedLiveProfiles !== true) {
    throw new Error(`agent-browser registry diagnose did not check live managed profiles: ${JSON.stringify(cliRegistryDiagnose)}`);
  }
  const cliTargetPreflight = await runCli(["profile", "preflight", "--target", registryTarget, "--require-roles", "attacker,victim", "--profiles", `${attackerProfile},${victimProfile}`, "--url", `http://127.0.0.1:${testServerPort}/?isolation=1`], serverPort, cliEnv);
  if (cliTargetPreflight.ok !== true || cliTargetPreflight.preflightSummary?.readyForTwoAccount !== true || cliTargetPreflight.checks?.isolation?.coverage?.valuesRedacted !== true) {
    throw new Error(`agent-browser target preflight did not verify live two-profile isolation: ${JSON.stringify(cliTargetPreflight)}`);
  }

  async function callTool(name, params = {}) {
    const response = await fetch(`http://127.0.0.1:${serverPort}/tool/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!response.ok) {
      throw new Error(`${name} failed: ${response.status} ${await response.text()}`);
    }
    return await response.json();
  }

  const statsResponse = await fetch(`http://127.0.0.1:${serverPort}/tool/cdp_stats`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!statsResponse.ok) {
    throw new Error(`cdp_stats failed: ${statsResponse.status} ${await statsResponse.text()}`);
  }
  const stats = await statsResponse.json();
  const profileStats = stats["agent-server-smoke"];
  if (!profileStats) throw new Error(`missing stats for agent-server-smoke: ${JSON.stringify(stats)}`);

  const backendStatus = await callTool("browser_backend_status");
  if (!backendStatus.ok || backendStatus.managed?.backend !== "managed-cdp" || backendStatus.personal?.ok !== false) {
    throw new Error(`browser_backend_status did not report managed/personal routing: ${JSON.stringify(backendStatus)}`);
  }
  const personalUnavailable = await callTool("browser_inspect", { backend: "personal", mode: "overview" });
  if (personalUnavailable.ok !== false || personalUnavailable.error !== "personal_bridge_unavailable") {
    throw new Error(`personal route should fail with structured unavailable response: ${JSON.stringify(personalUnavailable)}`);
  }

  const initialCapture = await callTool("browser_capture_status");
  if (initialCapture.capture.enabled) {
    throw new Error(`capture should be off by default: ${JSON.stringify(initialCapture)}`);
  }
  await callTool("browser_capture_start", { label: "default-profile-smoke" });

  const defaultNavigateResponse = await fetch(`http://127.0.0.1:${serverPort}/tool/browser_navigate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: `http://127.0.0.1:${testServerPort}/`, waitMs: 700 }),
  });
  if (!defaultNavigateResponse.ok) {
    throw new Error(`default browser_navigate failed: ${defaultNavigateResponse.status} ${await defaultNavigateResponse.text()}`);
  }
  const defaultNavigate = await defaultNavigateResponse.json();
  if (defaultNavigate.profile !== health.defaultProfile) {
    throw new Error(`omitted profile did not use default profile: ${JSON.stringify(defaultNavigate)}`);
  }

  const defaultTrafficResponse = await fetch(`http://127.0.0.1:${serverPort}/tool/profile_traffic_query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url_contains: "/api/profile-smoke", limit: 20 }),
  });
  if (!defaultTrafficResponse.ok) {
    throw new Error(`default profile_traffic_query failed: ${defaultTrafficResponse.status} ${await defaultTrafficResponse.text()}`);
  }
  const defaultTraffic = await defaultTrafficResponse.json();
  if (defaultTraffic.profile !== health.defaultProfile || defaultTraffic.requests.length === 0) {
    throw new Error(`omitted profile traffic did not use default profile: ${JSON.stringify(defaultTraffic)}`);
  }

  const defaultSeed = await callTool("browser_eval", {
    expression: `(() => {
      document.cookie = "agent_profile_isolation=default; Path=/; SameSite=Lax";
      localStorage.setItem("agent_profile_isolation", "default");
      return { cookie: document.cookie, localStorage: localStorage.getItem("agent_profile_isolation") };
    })()`,
  });
  if (!String(defaultSeed.result?.cookie || "").includes("agent_profile_isolation=default") || defaultSeed.result?.localStorage !== "default") {
    throw new Error(`default profile did not seed isolation fixture: ${JSON.stringify(defaultSeed)}`);
  }

  const profileCreateResponse = await fetch(`http://127.0.0.1:${serverPort}/tool/profile_create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: "researcher" }),
  });
  if (!profileCreateResponse.ok) {
    throw new Error(`profile_create failed: ${profileCreateResponse.status} ${await profileCreateResponse.text()}`);
  }
  await callTool("browser_capture_start", { profile: "researcher", label: "researcher-smoke" });

  const navigateResponse = await fetch(`http://127.0.0.1:${serverPort}/tool/browser_navigate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: "researcher", url: `http://127.0.0.1:${testServerPort}/`, waitMs: 700 }),
  });
  if (!navigateResponse.ok) {
    throw new Error(`browser_navigate failed: ${navigateResponse.status} ${await navigateResponse.text()}`);
  }

  const typeResponse = await fetch(`http://127.0.0.1:${serverPort}/tool/browser_type`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: "researcher", selector: "#msg", text: "hello" }),
  });
  if (!typeResponse.ok) {
    throw new Error(`browser_type failed: ${typeResponse.status} ${await typeResponse.text()}`);
  }

  const fillResponse = await fetch(`http://127.0.0.1:${serverPort}/tool/browser_type`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: "researcher", selector: "#msg", text: "filled", clear: true }),
  });
  if (!fillResponse.ok) {
    throw new Error(`browser_type (fill) failed: ${fillResponse.status} ${await fillResponse.text()}`);
  }
  const fillResult = await fillResponse.json();
  if (fillResult.value !== "filled") {
    throw new Error(`browser_type (fill) did not replace input value: ${JSON.stringify(fillResult)}`);
  }

  const snapshotResponse = await fetch(`http://127.0.0.1:${serverPort}/tool/browser_snapshot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: "researcher" }),
  });
  if (!snapshotResponse.ok) {
    throw new Error(`browser_snapshot failed: ${snapshotResponse.status} ${await snapshotResponse.text()}`);
  }
  const snapshot = await snapshotResponse.json();
  if (snapshot.title !== "Researcher Space" || snapshot.profile !== "researcher") {
    throw new Error(`unexpected snapshot title: ${JSON.stringify(snapshot)}`);
  }
  const signUpFind = await callTool("browser_find", { profile: "researcher", query: "Sign up" });
  if (!signUpFind.matches?.length || !signUpFind.matches.some((entry) => String(entry.text || "").includes("Sign up"))) {
    throw new Error(`browser_find did not find visible SPA text: ${JSON.stringify(signUpFind)}`);
  }
  const waitVisible = await callTool("browser_wait", { profile: "researcher", selector: "#go", timeoutMs: 1000 });
  if (!waitVisible.ok || waitVisible.waitSummary?.state !== "satisfied") {
    throw new Error(`browser_wait did not report satisfied summary: ${JSON.stringify(waitVisible)}`);
  }
  const waitTimeout = await callTool("browser_wait", { profile: "researcher", selector: "#does-not-exist", timeoutMs: 100, pollMs: 25 });
  if (waitTimeout.ok !== false || !waitTimeout.waitSummary?.blockers?.includes("selector-not-attached")) {
    throw new Error(`browser_wait timeout did not expose selector blocker: ${JSON.stringify(waitTimeout)}`);
  }

  const researcherIsolation = await callTool("browser_eval", {
    profile: "researcher",
    expression: `(() => ({
      cookie: document.cookie,
      localStorage: localStorage.getItem("agent_profile_isolation")
    }))()`,
  });
  if (String(researcherIsolation.result?.cookie || "").includes("agent_profile_isolation=default") || researcherIsolation.result?.localStorage === "default") {
    throw new Error(`managed profiles share browser storage: ${JSON.stringify(researcherIsolation)}`);
  }

  const clickResponse = await fetch(`http://127.0.0.1:${serverPort}/tool/browser_click`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: "researcher", selector: "#go", waitMs: 700 }),
  });
  if (!clickResponse.ok) {
    throw new Error(`browser_click failed: ${clickResponse.status} ${await clickResponse.text()}`);
  }
  const textClick = await callTool("browser_click", { profile: "researcher", text: "Sign up", waitMode: "no-navigation", waitMs: 700 });
  if (!textClick.ok || textClick.error) {
    throw new Error(`browser_click by visible SPA text failed: ${JSON.stringify(textClick)}`);
  }

  const typeEnterResponse = await fetch(`http://127.0.0.1:${serverPort}/tool/browser_type`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: "researcher", selector: "#msg", text: "again", pressEnter: true, waitMs: 700 }),
  });
  if (!typeEnterResponse.ok) {
    throw new Error(`browser_type enter failed: ${typeEnterResponse.status} ${await typeEnterResponse.text()}`);
  }

  const evalResponse = await fetch(`http://127.0.0.1:${serverPort}/tool/browser_eval`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: "researcher", expression: "fetch('/api/profile-smoke?source=eval').then(r => r.json())", waitMs: 700 }),
  });
  if (!evalResponse.ok) {
    throw new Error(`browser_eval failed: ${evalResponse.status} ${await evalResponse.text()}`);
  }

  const screenshotResponse = await fetch(`http://127.0.0.1:${serverPort}/tool/browser_screenshot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: "researcher" }),
  });
  if (!screenshotResponse.ok) {
    throw new Error(`browser_screenshot failed: ${screenshotResponse.status} ${await screenshotResponse.text()}`);
  }

  const listResponse = await fetch(`http://127.0.0.1:${serverPort}/tool/profile_list`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!listResponse.ok) {
    throw new Error(`profile_list failed: ${listResponse.status} ${await listResponse.text()}`);
  }
  const profileList = await listResponse.json();
  if (!profileList.profiles.some((entry) => entry.name === "researcher")) {
    throw new Error(`researcher profile missing from registry: ${JSON.stringify(profileList)}`);
  }
  if (!profileList.summary || typeof profileList.summary.liveTabs !== "number") {
    throw new Error(`profile_list did not include attachment summary: ${JSON.stringify(profileList)}`);
  }

  const adoptedUrl = `http://127.0.0.1:${testServerPort}/?adopt=1`;
  const cdpNewResponse = await fetch(`http://127.0.0.1:${liveBrowserPort}/json/new?${encodeURIComponent(adoptedUrl)}`, { method: "PUT" });
  if (!cdpNewResponse.ok) {
    throw new Error(`CDP /json/new for adopt smoke failed: ${cdpNewResponse.status} ${await cdpNewResponse.text()}`);
  }
  await sleep(500);
  const adoptResponse = await fetch(`http://127.0.0.1:${serverPort}/tool/browser_adopt_tab`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: "adopted-live-tab", urlContains: "adopt=1", reason: "agent-server-smoke" }),
  });
  if (!adoptResponse.ok) {
    throw new Error(`browser_adopt_tab failed: ${adoptResponse.status} ${await adoptResponse.text()}`);
  }
  const adopted = await adoptResponse.json();
  if (!adopted.ok || adopted.profile?.name !== "adopted-live-tab" || !adopted.profile?.url?.includes("adopt=1")) {
    throw new Error(`browser_adopt_tab did not bind expected target: ${JSON.stringify(adopted)}`);
  }
  const tabsAfterAdopt = await callTool("browser_tabs");
  if (!tabsAfterAdopt.tabs.some((tab) => tab.profiles?.includes("adopted-live-tab"))) {
    throw new Error(`browser_tabs did not show adopted profile binding: ${JSON.stringify(tabsAfterAdopt)}`);
  }
  const adoptedSnapshot = await callTool("browser_snapshot", { profile: "adopted-live-tab" });
  if (adoptedSnapshot.title !== "Researcher Space") {
    throw new Error(`adopted tab snapshot mismatch: ${JSON.stringify(adoptedSnapshot)}`);
  }
  const resumedAttached = await callTool("profile_resume", { profile: "adopted-live-tab" });
  if (resumedAttached.resumed !== "attached-existing-tab") {
    throw new Error(`profile_resume should reuse attached tab: ${JSON.stringify(resumedAttached)}`);
  }
  await callTool("profile_delete", { profile: "adopted-live-tab" });
  const resumedStale = await callTool("profile_resume", { profile: "adopted-live-tab", url: adoptedUrl, waitMs: 500 });
  if (!resumedStale.ok || !resumedStale.profile?.url?.includes("adopt=1")) {
    throw new Error(`profile_resume did not reopen profile URL: ${JSON.stringify(resumedStale)}`);
  }
  const resumedSnapshot = await callTool("browser_snapshot", { profile: "adopted-live-tab" });
  if (resumedSnapshot.title !== "Researcher Space") {
    throw new Error(`resumed profile snapshot mismatch: ${JSON.stringify(resumedSnapshot)}`);
  }
  const authStart = await callTool("browser_auth_bootstrap", {
    profile: "auth-bootstrap-smoke",
    action: "start",
    loginUrl: `http://127.0.0.1:${testServerPort}/?auth=1`,
    successUrlContains: "auth=1",
    label: "auth-bootstrap-smoke",
    waitMs: 500,
  });
  if (!authStart.ok || authStart.mode !== "operator-assisted") {
    throw new Error(`browser_auth_bootstrap start failed: ${JSON.stringify(authStart)}`);
  }
  const authStatus = await callTool("browser_auth_bootstrap", {
    profile: "auth-bootstrap-smoke",
    action: "status",
    successUrlContains: "auth=1",
  });
  if (!authStatus.success || !authStatus.checks?.urlMatched) {
    throw new Error(`browser_auth_bootstrap status did not observe success URL: ${JSON.stringify(authStatus)}`);
  }
  const authFinish = await callTool("browser_auth_bootstrap", {
    profile: "auth-bootstrap-smoke",
    action: "finish",
    successUrlContains: "auth=1",
  });
  if (!authFinish.success || authFinish.capture?.enabled) {
    throw new Error(`browser_auth_bootstrap finish did not stop capture on success: ${JSON.stringify(authFinish)}`);
  }

  const panelResponse = await fetch(`http://127.0.0.1:${serverPort}/panel`);
  if (!panelResponse.ok) {
    throw new Error(`panel failed: ${panelResponse.status} ${await panelResponse.text()}`);
  }
  const panelHtml = await panelResponse.text();
  if (!panelHtml.includes("Agent DevTools")) {
    throw new Error("panel HTML did not contain Agent DevTools title");
  }

  const panelDataResponse = await fetch(`http://127.0.0.1:${serverPort}/panel-data?profile=researcher`);
  if (!panelDataResponse.ok) {
    throw new Error(`panel-data failed: ${panelDataResponse.status} ${await panelDataResponse.text()}`);
  }
  const panelData = await panelDataResponse.json();
  if (!panelData.ok || panelData.current?.tabId || panelData.profiles.some((entry) => entry.tabId)) {
    throw new Error(`panel-data should be public-facing and hide tab ids: ${JSON.stringify(panelData)}`);
  }

  const trafficResponse = await fetch(`http://127.0.0.1:${serverPort}/tool/profile_traffic_query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: "researcher", url_contains: "/api/profile-smoke", limit: 20 }),
  });
  if (!trafficResponse.ok) {
    throw new Error(`profile_traffic_query failed: ${trafficResponse.status} ${await trafficResponse.text()}`);
  }
  const traffic = await trafficResponse.json();
  const apiRequest = traffic.requests.find((entry) => String(entry.url).includes("/api/profile-smoke"));
  if (!apiRequest) {
    throw new Error(`profile traffic did not include /api/profile-smoke: ${JSON.stringify(traffic)}`);
  }
  for (const source of ["click", "spa-signup", "type", "eval"]) {
    if (!traffic.requests.some((entry) => String(entry.url).includes(`source=${source}`))) {
      throw new Error(`profile traffic missing source=${source}: ${JSON.stringify(traffic)}`);
    }
  }

  const trafficGetResponse = await fetch(`http://127.0.0.1:${serverPort}/tool/profile_traffic_get`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: "researcher", requestId: apiRequest.requestId }),
  });
  if (!trafficGetResponse.ok) {
    throw new Error(`profile_traffic_get failed: ${trafficGetResponse.status} ${await trafficGetResponse.text()}`);
  }
  const trafficDetail = await trafficGetResponse.json();
  if (!trafficDetail.entry?.url?.includes("/api/profile-smoke")) {
    throw new Error(`profile traffic detail mismatch: ${JSON.stringify(trafficDetail)}`);
  }

  const stoppedCapture = await callTool("browser_capture_stop", { profile: "researcher" });
  if (stoppedCapture.capture.enabled) {
    throw new Error(`capture did not stop: ${JSON.stringify(stoppedCapture)}`);
  }

  const shutdownResponse = await fetch(`http://127.0.0.1:${serverPort}/shutdown`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!shutdownResponse.ok) {
    throw new Error(`shutdown failed: ${shutdownResponse.status} ${await shutdownResponse.text()}`);
  }
  const exited = await waitForExit(child);
  if (!exited) throw new Error("agent server did not exit after /shutdown");

  console.log("Agent server smoke passed:");
  console.log(`- local HTTP server: http://127.0.0.1:${serverPort}`);
  console.log(`- browser CDP port: ${liveBrowserPort} (${health.cdpPortMode})`);
  console.log(`- default profile: ${health.defaultProfile}`);
  console.log("- cdp_stats callable standalone");
  console.log("- profile_create/profile_list callable standalone");
  console.log("- omitted profile calls use the server default profile");
  console.log("- capture is explicit and off by default");
  console.log("- unified backend router exposes managed status and structured personal fallback");
  console.log("- profile-bound browser_navigate/browser_type/browser_snapshot callable standalone");
  console.log("- profile-bound browser_find/browser_click/browser_eval/browser_screenshot evidence recorded");
  console.log("- profile_traffic_query/profile_traffic_get callable standalone");
  console.log("- browser_adopt_tab binds existing live CDP tabs back to durable profiles");
  console.log("- profile_resume recovers attached or stale profiles after agent/session disconnects");
  console.log("- browser_auth_bootstrap supports operator-assisted login bootstrap and status checks");
  console.log("- /panel and /panel-data provide public-facing dashboard data");
  console.log("- agent-browser CLI drives the live worker for doctor/profile/capture/open/fill/requests");
  console.log("- agent-browser CLI profile lease guard blocks conflicting owners before live browser mutation");
  console.log("- agent-browser CLI validates live download watcher and directory diagnostics");
  console.log("- agent-browser CLI validates live auth bootstrap start/status/finish");
  console.log("- agent-browser CLI validates live profile registry diagnose and two-profile preflight isolation");
} catch (err) {
  if (child.exitCode === null) child.kill();
  console.error(stdout);
  console.error(stderr);
  throw err;
} finally {
  await new Promise((resolve) => testServer.close(resolve));
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Windows can briefly hold browser profile handles after process exit.
  }
}
