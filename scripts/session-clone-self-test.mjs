#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  cloneOriginState,
  cdpOriginStateAdapter,
  filterCookiesForOrigins,
  navigateCdpToOrigin,
  openCdpPageSession,
} from "./lib/origin-state-clone.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
  }
  return result.result?.value;
}

async function seedSourceState(cdp, origin) {
  await cdp.send("Network.enable").catch(() => {});
  await cdp.send("Network.setCookies", {
    cookies: [{
      name: "abr_clone_http_only",
      value: "cookie-value",
      url: `${origin}/`,
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    }],
  });
  await navigateCdpToOrigin(cdp, origin, { force: true });
  await evaluate(cdp, `(async () => {
    localStorage.setItem("abr.local", "local-value");
    sessionStorage.setItem("abr.session", "session-value");
    await new Promise((resolve, reject) => {
      const deleteRequest = indexedDB.deleteDatabase("abr-clone-db");
      deleteRequest.onsuccess = () => resolve();
      deleteRequest.onerror = () => reject(deleteRequest.error);
      deleteRequest.onblocked = () => resolve();
    });
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("abr-clone-db", 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("items", { keyPath: "id" });
        store.createIndex("byType", "type", { unique: false });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("items", "readwrite");
      tx.objectStore("items").put({ id: "row-1", type: "demo", value: "indexed-value" });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return true;
  })()`);
}

async function readDestinationState(cdp, origin) {
  await navigateCdpToOrigin(cdp, origin);
  const page = await evaluate(cdp, `(async () => {
    const idb = await new Promise((resolve, reject) => {
      const request = indexedDB.open("abr-clone-db");
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("items", "readonly");
        const get = tx.objectStore("items").get("row-1");
        get.onsuccess = () => {
          const value = get.result;
          db.close();
          resolve(value);
        };
        get.onerror = () => reject(get.error);
      };
      request.onerror = () => reject(request.error);
    });
    return {
      localStorage: localStorage.getItem("abr.local"),
      sessionStorage: sessionStorage.getItem("abr.session"),
      indexedDB: idb,
      documentCookie: document.cookie,
    };
  })()`);
  const allCookies = await cdp.send("Network.getAllCookies");
  const cookies = filterCookiesForOrigins(allCookies.cookies || [], [origin]);
  return { page, cookies };
}

async function cleanupStep(label, fn, timeoutMs = 10_000) {
  try {
    const result = await Promise.race([
      Promise.resolve().then(fn),
      new Promise((resolve) => setTimeout(() => resolve({ cleanupTimedOut: true }), timeoutMs)),
    ]);
    if (result?.cleanupTimedOut) {
      console.warn(`session-clone-self-test: cleanup timeout: ${label}`);
    }
  } catch (error) {
    console.warn(`session-clone-self-test: cleanup failed: ${label}: ${String(error?.message || error)}`);
  }
}

async function main() {
  const testProfilesRoot = process.env.ABR_PROFILES_ROOT || join(tmpdir(), "abr-session-clone-profiles");
  const templateDir = join(testProfilesRoot, "_template");
  if (!existsSync(templateDir)) {
    const sourceTemplate = join(homedir(), "abr-chrome", "_template");
    if (!existsSync(sourceTemplate)) {
      throw new Error(`spawn profile template missing: ${sourceTemplate}`);
    }
    mkdirSync(testProfilesRoot, { recursive: true });
    cpSync(sourceTemplate, templateDir, { recursive: true });
  }
  process.env.ABR_PROFILES_ROOT = testProfilesRoot;
  const {
    killChromeProfile,
    spawnChromeProfile,
  } = await import("./lib/spawn-chrome-profile.mjs");

  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end("<!doctype html><title>ABR Session Clone Self Test</title><main>ok</main>");
  });
  const address = await listen(server);
  const origin = `http://127.0.0.1:${address.port}`;
  const suffix = randomUUID().slice(0, 8);
  const srcName = `clone-src-${suffix}`;
  const dstName = `clone-dst-${suffix}`;
  let srcSession = null;
  let dstSession = null;

  try {
    const srcProfile = await spawnChromeProfile(srcName);
    const dstProfile = await spawnChromeProfile(dstName);
    srcSession = await openCdpPageSession(srcProfile.port);
    dstSession = await openCdpPageSession(dstProfile.port);

    await seedSourceState(srcSession, origin);
    const report = await cloneOriginState({
      source: cdpOriginStateAdapter(srcSession),
      destination: cdpOriginStateAdapter(dstSession),
      origins: [origin],
      maxIndexedDbRecords: 100,
    });
    assert.equal(report.ok, true);

    const state = await readDestinationState(dstSession, origin);
    const cookie = state.cookies.find((entry) => entry.name === "abr_clone_http_only");
    assert.equal(cookie?.value, "cookie-value");
    assert.equal(cookie?.httpOnly, true);
    assert.equal(state.page.localStorage, "local-value");
    assert.equal(state.page.sessionStorage, "session-value");
    assert.deepEqual(state.page.indexedDB, { id: "row-1", type: "demo", value: "indexed-value" });
    assert.equal(state.page.documentCookie.includes("abr_clone_http_only"), false);

    console.log("session-clone-self-test: PASS");
    console.log(JSON.stringify({
      origin,
      sourceProfile: srcProfile.name,
      destinationProfile: dstProfile.name,
      clonedOrigins: report.originCount,
      cookieHttpOnlyCopied: true,
      localStorageCopied: true,
      sessionStorageCopied: true,
      indexedDbCopied: true,
    }, null, 2));
  } finally {
    if (srcSession) await cleanupStep("src CDP session", () => srcSession.close(), 1000);
    if (dstSession) await cleanupStep("dst CDP session", () => dstSession.close(), 1000);
    await cleanupStep("src profile", () => killChromeProfile(srcName, { removeData: true }), 20_000);
    await cleanupStep("dst profile", () => killChromeProfile(dstName, { removeData: true }), 20_000);
    await cleanupStep("http server", () => new Promise((resolve) => {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      server.close(() => resolve());
    }), 1000);
  }
}

main().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error("session-clone-self-test: FAIL");
  console.error(error);
  process.exit(1);
});
