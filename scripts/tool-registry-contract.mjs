// Tool-registry contract check. Boots the worker WITHOUT launching a browser
// (the registry is browser-independent — every tool is registered at startup
// regardless of backend state), fetches GET /tools, and snapshots each tool's
// public surface: { name, description, parameters }.
//
// Why this exists: the big monolith carve (extracting tool families out of the
// 11K-line registerStandaloneBrowserTools closure into register*Tools modules)
// is a registration refactor. Pure-helper carves are guarded by characterization
// unit tests, but the tool closure does live CDP I/O so its handlers can't be
// unit-tested cheaply, and the live browser smokes are environmentally red on
// some machines (single-instance Edge). This check is the missing safety net:
// it pins the EXACT agent-facing surface (names + schemas + descriptions) so any
// accidental tool drop / rename / schema drift during the refactor fails loudly,
// with zero dependency on a working browser.
//
// Usage:
//   node scripts/tool-registry-contract.mjs            compare against fixture (CI / pre-commit gate)
//   node scripts/tool-registry-contract.mjs --update   (re)write the fixture baseline
//
// Exit 0 = surface matches fixture. Exit 1 = drift (printed) or boot failure.

import { spawn } from "node:child_process";
import net from "node:net";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "lib", "__fixtures__", "tool-registry.snapshot.json");
const UPDATE = process.argv.includes("--update");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

// Recursively sort object keys so serialization is stable regardless of the
// insertion order the worker happens to use. Arrays keep their order (order is
// meaningful for things like enum lists and required[]).
function stableSort(value) {
  if (Array.isArray(value)) return value.map(stableSort);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableSort(value[key]);
    return out;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableSort(value), null, 2);
}

async function waitForHealth(port) {
  const url = `http://127.0.0.1:${port}/health`;
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error(`worker did not become healthy at ${url}`);
}

async function fetchRegistry(port) {
  const response = await fetch(`http://127.0.0.1:${port}/tools`);
  if (!response.ok) throw new Error(`/tools fetch failed: ${response.status} ${await response.text()}`);
  const payload = await response.json();
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  // Snapshot only the public surface, sorted by name for a stable diff.
  return tools
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? null,
      parameters: tool.parameters ?? null,
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function diffRegistry(expected, actual) {
  const expByName = new Map(expected.map((t) => [t.name, t]));
  const actByName = new Map(actual.map((t) => [t.name, t]));
  const added = [...actByName.keys()].filter((n) => !expByName.has(n));
  const removed = [...expByName.keys()].filter((n) => !actByName.has(n));
  const changed = [];
  for (const [name, exp] of expByName) {
    const act = actByName.get(name);
    if (!act) continue;
    const fields = [];
    if (stableStringify(exp.description) !== stableStringify(act.description)) fields.push("description");
    if (stableStringify(exp.parameters) !== stableStringify(act.parameters)) fields.push("parameters");
    if (fields.length) changed.push({ name, fields });
  }
  return { added, removed, changed };
}

async function main() {
  const serverPort = await freePort();
  const tempDir = mkdtempSync(join(tmpdir(), "abr-tool-contract-"));
  // No CDP_LAUNCH_BROWSER: the worker serves the full registry without a browser.
  const child = spawn(process.execPath, ["scripts/agent-cdp-server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CDP_AGENT_SERVER_PORT: String(serverPort),
      CDP_SECURITY_DATA_DIR: join(tempDir, "runtime"),
      CDP_BROWSER_USER_DATA_DIR: join(tempDir, "browser"),
    },
    stdio: "ignore",
  });

  let actual;
  try {
    await waitForHealth(serverPort);
    actual = await fetchRegistry(serverPort);
  } finally {
    await fetch(`http://127.0.0.1:${serverPort}/shutdown`, { method: "POST" }).catch(() => {});
    setTimeout(() => child.kill(), 500);
    setTimeout(() => rmSync(tempDir, { recursive: true, force: true }), 1000);
  }

  if (!actual.length) throw new Error("registry is empty — worker registered zero tools");

  if (UPDATE || !existsSync(FIXTURE)) {
    mkdirSync(dirname(FIXTURE), { recursive: true });
    writeFileSync(FIXTURE, stableStringify(actual) + "\n");
    console.log(`[tool-registry-contract] ${UPDATE ? "updated" : "wrote initial"} fixture: ${actual.length} tools -> ${FIXTURE}`);
    return;
  }

  const expected = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const { added, removed, changed } = diffRegistry(expected, actual);
  if (!added.length && !removed.length && !changed.length) {
    console.log(`[tool-registry-contract] OK — ${actual.length} tools match fixture`);
    return;
  }

  console.error("[tool-registry-contract] DRIFT detected:");
  if (added.length) console.error(`  + added (${added.length}): ${added.join(", ")}`);
  if (removed.length) console.error(`  - removed (${removed.length}): ${removed.join(", ")}`);
  if (changed.length) {
    console.error(`  ~ changed (${changed.length}):`);
    for (const c of changed) console.error(`      ${c.name}: ${c.fields.join(", ")}`);
  }
  console.error("If this drift is intentional, re-run with --update and review the fixture diff in your commit.");
  process.exitCode = 1;
}

main().catch((err) => {
  console.error("[tool-registry-contract] FAILED:", err?.message || err);
  process.exit(1);
});
