import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";

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
<input id="msg" onkeydown="if(event.key === 'Enter') fetch('/api/profile-smoke?source=type')">
<script>
fetch("/api/profile-smoke").then((r) => r.json()).then((data) => console.log(data.ok));
</script>`);
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

const serverPort = await freePort();
const browserPort = await freePort();
const testServer = await startTestServer();
const testServerPort = testServer.address().port;
const child = spawn(
  process.execPath,
  ["scripts/agent-cdp-server.mjs"],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CDP_LAUNCH_BROWSER: "1",
      CDP_AGENT_SERVER_PORT: String(serverPort),
      CDP_BROWSER_PORT: String(browserPort),
      CDP_AGENT_PROFILE: "agent-server-smoke",
      CDP_BROWSER_HEADLESS: "1",
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

  const initialCapture = await callTool("devtools_capture_status");
  if (initialCapture.capture.enabled) {
    throw new Error(`capture should be off by default: ${JSON.stringify(initialCapture)}`);
  }
  await callTool("devtools_capture_start", { label: "default-profile-smoke" });

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

  const profileCreateResponse = await fetch(`http://127.0.0.1:${serverPort}/tool/profile_create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: "researcher" }),
  });
  if (!profileCreateResponse.ok) {
    throw new Error(`profile_create failed: ${profileCreateResponse.status} ${await profileCreateResponse.text()}`);
  }
  await callTool("devtools_capture_start", { profile: "researcher", label: "researcher-smoke" });

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

  const clickResponse = await fetch(`http://127.0.0.1:${serverPort}/tool/browser_click`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: "researcher", selector: "#go", waitMs: 700 }),
  });
  if (!clickResponse.ok) {
    throw new Error(`browser_click failed: ${clickResponse.status} ${await clickResponse.text()}`);
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
  for (const source of ["click", "type", "eval"]) {
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

  const stoppedCapture = await callTool("devtools_capture_stop", { profile: "researcher" });
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
  console.log(`- browser CDP port: ${browserPort}`);
  console.log(`- default profile: ${health.defaultProfile}`);
  console.log("- cdp_stats callable without OpenClaw");
  console.log("- profile_create/profile_list callable without OpenClaw");
  console.log("- omitted profile calls use the server default profile");
  console.log("- capture is explicit and off by default");
  console.log("- profile-bound browser_navigate/browser_type/browser_snapshot callable without OpenClaw");
  console.log("- profile-bound browser_click/browser_eval/browser_screenshot evidence recorded");
  console.log("- profile_traffic_query/profile_traffic_get callable without OpenClaw");
  console.log("- /panel and /panel-data provide public-facing dashboard data");
} catch (err) {
  if (child.exitCode === null) child.kill();
  console.error(stdout);
  console.error(stderr);
  throw err;
} finally {
  await new Promise((resolve) => testServer.close(resolve));
}
