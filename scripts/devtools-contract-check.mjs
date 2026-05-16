import { spawn } from "node:child_process";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

function toolNames(payload) {
  if (Array.isArray(payload.tools)) return payload.tools.map((tool) => (typeof tool === "string" ? tool : tool.name));
  if (payload.tools && typeof payload.tools === "object") return Object.keys(payload.tools);
  return Object.keys(payload || {});
}

async function waitForHealth(port) {
  const url = `http://127.0.0.1:${port}/health`;
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // keep waiting
    }
    await sleep(250);
  }
  throw new Error(`managed server did not become healthy: ${url}`);
}

async function fetchTools(baseUrl) {
  const response = await fetch(`${baseUrl}/tools`);
  if (!response.ok) throw new Error(`tools fetch failed: ${response.status} ${await response.text()}`);
  return toolNames(await response.json()).filter((name) => name?.startsWith("devtools_")).sort();
}

const serverPort = await freePort();
const browserPort = await freePort();
const tempDir = mkdtempSync(join(tmpdir(), "agent-devtools-contract-"));
const child = spawn(process.execPath, ["scripts/agent-cdp-server.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    CDP_LAUNCH_BROWSER: "1",
    CDP_AGENT_SERVER_PORT: String(serverPort),
    CDP_BROWSER_PORT: String(browserPort),
    CDP_BROWSER_HEADLESS: "1",
    CDP_SECURITY_DATA_DIR: join(tempDir, "runtime"),
    CDP_BROWSER_USER_DATA_DIR: join(tempDir, "browser"),
  },
  stdio: "ignore",
});

try {
  await waitForHealth(serverPort);
  const managed = await fetchTools(`http://127.0.0.1:${serverPort}`);

  let personal = [];
  let personalAvailable = false;
  try {
    personal = await fetchTools("http://127.0.0.1:17337");
    personalAvailable = true;
  } catch {
    personal = managed;
  }

  const onlyManaged = managed.filter((name) => !personal.includes(name));
  const onlyPersonal = personal.filter((name) => !managed.includes(name));
  const result = {
    managedCount: managed.length,
    personalCount: personalAvailable ? personal.length : null,
    personalAvailable,
    onlyManaged,
    onlyPersonal,
  };
  console.log(JSON.stringify(result, null, 2));
  if (onlyManaged.length || onlyPersonal.length) {
    throw new Error("devtools_* contract drift detected");
  }
} finally {
  await fetch(`http://127.0.0.1:${serverPort}/shutdown`, { method: "POST" }).catch(() => {});
  setTimeout(() => child.kill(), 500);
  setTimeout(() => rmSync(tempDir, { recursive: true, force: true }), 1000);
}
