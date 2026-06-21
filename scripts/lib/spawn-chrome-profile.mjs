// Step 4h: spawn isolated Chrome profiles using real chrome.exe (no Playwright).
//
// Replaces the spawn half of the deleted Playwright-driven managed backend.
// Each profile gets its own --user-data-dir (cookie / login / history isolation)
// and a distinct --remote-debugging-port (so cdp-traffic-capture can attach and
// record traffic per profile, see ~/.agent-browser-runtime/cdp-traffic/<name>/).
//
// Fingerprint is identical to the user's daily Chrome: same chrome.exe binary,
// same OS, same GPU, same fonts, same TLS stack. No --disable-blink-features
// flag, no Playwright CDP runtime, no AutomationControlled warning bar.
//
// Chrome 137+ blocks command-line --load-extension, so we propagate the
// extension via template-copy: the operator sets up a one-time template
// user-data-dir with the extension installed via chrome://extensions GUI, and
// every profile_create copies that template directory before launching.

import { spawn, execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import http from "node:http";

const CHROME_EXE = process.env.ABR_CHROME_EXECUTABLE
  || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PROFILES_ROOT = process.env.ABR_PROFILES_ROOT
  || join(homedir(), "abr-chrome");
const TEMPLATE_DIR = join(PROFILES_ROOT, "_template");
const PORT_BASE = Number(process.env.ABR_CHROME_PORT_BASE || 9300);
const PORT_LIMIT = PORT_BASE + 200;

// In-memory registry: profileName -> { name, pid, port, userDataDir, startedAt }
const registry = new Map();

function nextFreePort() {
  for (let p = PORT_BASE; p < PORT_LIMIT; p++) {
    if (![...registry.values()].some((r) => r.port === p)) return p;
  }
  throw new Error(`no free port between ${PORT_BASE}-${PORT_LIMIT}`);
}

function safeName(name) {
  if (!/^[a-zA-Z0-9_-]+$/.test(String(name || ""))) {
    throw new Error(`profile name must match /^[a-zA-Z0-9_-]+$/ — got ${JSON.stringify(name)}`);
  }
  return String(name);
}

function probeCdp(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1200, () => { req.destroy(); resolve(false); });
  });
}

async function waitForCdpReady(port, maxMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await probeCdp(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

export function templateExists() {
  return existsSync(TEMPLATE_DIR);
}

export function templateSetupInstructions() {
  return [
    `Template profile not found at: ${TEMPLATE_DIR}`,
    ``,
    `One-time setup (so spawned profiles get the ABR extension):`,
    `  1. Run: powershell -File scripts/setup-template-profile.ps1`,
    `  2. In the Chrome window that opens (chrome://extensions/):`,
    `     - toggle Developer mode (top-right)`,
    `     - click "Load unpacked"`,
    `     - select the worktree extension folder`,
    `     - close the Chrome window`,
    `  3. The template is now ready. profile_create will copy it for each new profile.`,
  ].join("\n");
}

export async function spawnChromeProfile(rawName) {
  const name = safeName(rawName);

  // Already-running idempotency.
  if (registry.has(name)) {
    const existing = registry.get(name);
    if (await probeCdp(existing.port)) {
      return { ok: true, alreadyRunning: true, ...existing };
    }
    registry.delete(name); // stale
  }

  if (!templateExists()) {
    const err = new Error(templateSetupInstructions());
    err.code = "template_not_set_up";
    throw err;
  }

  const userDataDir = join(PROFILES_ROOT, name);
  if (existsSync(userDataDir)) {
    rmSync(userDataDir, { recursive: true, force: true });
  }
  mkdirSync(PROFILES_ROOT, { recursive: true });
  cpSync(TEMPLATE_DIR, userDataDir, { recursive: true });

  // Template captured the extension's chrome.storage from setup time (instance
  // UUID, displayName). If we kept it, every spawned profile would advertise
  // the same browserInstanceId and bridge would conflate them. Wipe the
  // extension storage dirs so the extension re-initializes a fresh identity
  // on first launch.
  for (const sub of ["Local Extension Settings", "Sync Extension Settings", "Managed Extension Settings"]) {
    const dir = join(userDataDir, "Default", sub);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }

  const port = nextFreePort();
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    `--no-first-run`,
    `--no-default-browser-check`,
    `about:blank`,
  ];

  const proc = spawn(CHROME_EXE, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  proc.unref();

  const ready = await waitForCdpReady(port);
  if (!ready) {
    try { process.kill(proc.pid); } catch { /* already gone */ }
    rmSync(userDataDir, { recursive: true, force: true });
    throw new Error(`chrome did not become CDP-ready on port ${port} within 15s for profile ${name}`);
  }

  const record = {
    name, pid: proc.pid, port, userDataDir,
    startedAt: new Date().toISOString(),
  };
  registry.set(name, record);

  // Step 4i.2 fix: wait for cdp-traffic-capture plugin (in worker process,
  // 1s reconnect tick) to (a) see the new profile entry the bridge just wrote
  // into browser-profiles.json, (b) attach a CDP client, (c) call
  // Network.enable. If agent drives navigation before this, the first-page
  // loadingFinished events fire before Network is enabled and body capture
  // misses them — the disk dir cdp-traffic/<name>/ never gets created.
  // 3.5s = ~3 plugin reconnect ticks + Network.enable, empirically enough.
  await new Promise((r) => setTimeout(r, 3500));

  return { ok: true, alreadyRunning: false, ...record };
}

export function listSpawnedProfiles() {
  return [...registry.values()];
}

// Windows: chrome spawns many subprocesses (renderer, gpu, utility, ...).
// process.kill(pid) only kills the parent; subprocesses keep holding file
// locks on user-data-dir and rm fails. taskkill /F /T /PID kills the whole
// tree. On POSIX, plain process.kill is fine — chrome subprocesses die with
// the parent group.
function killChromeProcessTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" }); }
    catch { /* already gone or no permission */ }
  } else {
    try { process.kill(pid); } catch { /* already gone */ }
  }
}

export async function killChromeProfile(rawName, { removeData = false } = {}) {
  const name = safeName(rawName);
  const rec = registry.get(name);
  if (rec) {
    killChromeProcessTree(rec.pid);
    registry.delete(name);
  }
  const dir = rec?.userDataDir || join(PROFILES_ROOT, name);
  let removed = false;
  if (removeData && existsSync(dir)) {
    // Even after taskkill returns, Windows takes a moment to release file
    // handles. Retry with backoff.
    let lastErr = null;
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        removed = true;
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 300 * (i + 1)));
      }
    }
    if (!removed && lastErr) {
      // Don't throw — caller already got chrome killed. Surface as removed:false.
      return { ok: true, killed: rec || null, removed: false, userDataDir: dir,
        removeError: String(lastErr?.message || lastErr) };
    }
  }
  return { ok: true, killed: rec || null, removed, userDataDir: dir };
}
