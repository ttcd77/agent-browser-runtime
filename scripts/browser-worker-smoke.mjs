#!/usr/bin/env node

import { spawn } from "node:child_process";
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

async function waitForHealth(baseUrl) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return await response.json();
    } catch {
      // keep waiting
    }
    await sleep(300);
  }
  throw new Error(`Browser Worker did not become healthy: ${baseUrl}/health`);
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

async function runDoctor(baseUrl) {
  const child = spawn(process.execPath, ["scripts/browser-worker-doctor.mjs", "--strict"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_BROWSER_RUNTIME_URL: baseUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exited = await waitForExit(child, 15000);
  if (!exited) {
    child.kill();
    throw new Error("browser-worker-doctor did not exit");
  }
  if (child.exitCode !== 0) {
    throw new Error(`browser-worker-doctor failed: exit=${child.exitCode}\nstdout=${stdout}\nstderr=${stderr}`);
  }
  return JSON.parse(stdout);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const serverPort = await freePort();
const browserPort = await freePort();
const baseUrl = `http://127.0.0.1:${serverPort}`;
const child = spawn(process.execPath, ["scripts/agent-cdp-server.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    CDP_LAUNCH_BROWSER: "1",
    CDP_BROWSER_HEADLESS: "1",
    CDP_AGENT_SERVER_PORT: String(serverPort),
    CDP_BROWSER_PORT: String(browserPort),
    CDP_AGENT_PROFILE: "browser-worker-smoke",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  const health = await waitForHealth(baseUrl);
  assert(health.ok === true, `health was not ok: ${JSON.stringify(health)}`);
  assert(health.defaultProfile === "browser-worker-smoke", `unexpected default profile: ${health.defaultProfile}`);

  const doctor = await runDoctor(baseUrl);
  assert(doctor.ok === true, `doctor was not ok: ${JSON.stringify(doctor)}`);
  assert(doctor.baseUrl === baseUrl, `doctor used wrong baseUrl: ${doctor.baseUrl}`);
  assert(doctor.sdk?.toolRequestType === "browser_runtime_call", "doctor did not expose SDK tool request type");
  assert(doctor.sdk?.owner === "browser_worker", "doctor did not expose Browser Worker owner");
  assert(Array.isArray(doctor.toolCatalog?.facadeAvailable), "doctor did not return facadeAvailable");
  assert(doctor.toolCatalog.facadeAvailable.includes("browser_open"), "browser_open missing from facadeAvailable");
  assert(doctor.toolCatalog.facadeAvailable.includes("browser_security_pack"), "browser_security_pack missing from facadeAvailable");
  assert(doctor.toolCatalog.facadeMissing.length === 0, `facade tools missing: ${doctor.toolCatalog.facadeMissing.join(", ")}`);

  console.log("Browser Worker smoke passed:");
  console.log(`- worker: ${baseUrl}`);
  console.log(`- default profile: ${health.defaultProfile}`);
  console.log(`- facade tools: ${doctor.toolCatalog.facadeAvailable.length}/${doctor.facadeTools.length}`);
  console.log(`- SDK request type: ${doctor.sdk.toolRequestType}`);
} finally {
  try {
    await fetch(`${baseUrl}/shutdown`, { method: "POST" });
  } catch {
    // shutdown endpoint may already be gone
  }
  const exited = await waitForExit(child, 10000);
  if (!exited) child.kill();
  if (child.exitCode && child.exitCode !== 0) {
    console.error(stdout);
    console.error(stderr);
    process.exit(child.exitCode);
  }
}
