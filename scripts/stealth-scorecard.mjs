#!/usr/bin/env node
// Stealth scorecard — regression guard for the agent browser's anti-bot posture.
//
// WHY THIS EXISTS: the managed browser was silently driving Microsoft Edge
// (msedge channel) with Playwright's default 1280x720 viewport. That made
// navigator.userAgentData advertise an Edge brand mismatching a Chrome-shaped UA,
// plus a tell-tale automation viewport — and AWS WAF + reCAPTCHA v3 challenges
// blocked logins. Fix: real Google Chrome channel + viewport:null + real window size
// (scripts/lib/managed-playwright-driver.mjs). This script proves the fix still
// holds and FAILS LOUD if anyone reverts the channel/viewport.
//
// It drives the REAL ManagedPlaywrightDriver (not an ad-hoc Playwright launch)
// against rebrowser-bot-detector and asserts: chrome channel, real viewport, and
// zero red detections. Run: `npm run stealth-scorecard` (or node scripts/stealth-scorecard.mjs).
// Optional: --url=<page> to additionally load a real target and confirm it is not
// served a block page (objective load check only; no login, no classification).
import { ManagedPlaywrightDriver } from "./lib/managed-playwright-driver.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DETECTOR = "https://bot-detector.rebrowser.net/";
const urlArg = process.argv.find((a) => a.startsWith("--url="));
const extraUrl = urlArg ? urlArg.slice("--url=".length) : null;

function readEmojiLines(text) {
  const reds = [];
  const all = [];
  for (const line of text.split("\n")) {
    const t = line.trim().replace(/\s+/g, " ");
    if (/^[🟢🔴⚪️]/u.test(t)) {
      all.push(t);
      if (t.startsWith("🔴")) reds.push(t);
    }
  }
  return { all, reds };
}

const root = mkdtempSync(join(tmpdir(), "abr-scorecard-"));
const driver = new ManagedPlaywrightDriver({ userDataRoot: root });
let exitCode = 0;
const fail = (msg) => {
  console.error("FAIL: " + msg);
  exitCode = 1;
};

try {
  const handle = await driver.ensurePage("scorecard");
  const page = handle.page;
  const launch = (await driver.pageSummary(handle)).launch;

  // --- Config regression guards (cheap, deterministic) ---
  console.log("launch config:", JSON.stringify(launch));
  if (/edge|msedge/i.test(String(launch.channel))) {
    fail(`channel reverted to '${launch.channel}' — Edge brand mismatches a Chrome UA and gets WAF-flagged. Use channel 'chrome'.`);
  }
  if (launch.viewport !== null) {
    fail(`viewport is '${JSON.stringify(launch.viewport)}' — must be null so the page reports the real OS window size (Playwright default 1280x720 is an automation tell).`);
  }

  // --- Live detector (network-dependent; inconclusive, not fail, if unreachable) ---
  let detectorRan = false;
  try {
    await page.goto(DETECTOR, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(4500);
    const info = await page.evaluate(() => ({
      text: document.body.innerText,
      vw: window.innerWidth,
      vh: window.innerHeight,
      ua: navigator.userAgent,
      brands: navigator.userAgentData ? navigator.userAgentData.brands.map((b) => b.brand) : null,
    }));
    detectorRan = true;
    const { all, reds } = readEmojiLines(info.text);
    console.log(`\nrebrowser detector (${all.length} checks):`);
    for (const line of all) console.log("  " + line);
    console.log(`\nUA: ${info.ua}`);
    console.log(`uaData brands: ${JSON.stringify(info.brands)}`);
    console.log(`viewport: ${info.vw}x${info.vh}`);
    if (info.vw === 1280 && info.vh === 720) fail("viewport is exactly 1280x720 (Playwright default automation tell).");
    if (info.brands && !info.brands.some((b) => /google chrome/i.test(b))) {
      fail(`userAgentData brands ${JSON.stringify(info.brands)} do not include 'Google Chrome' — WAF brand-coherence flag.`);
    }
    if (reds.length > 0) fail(`${reds.length} red detection(s) on rebrowser.`);
    else console.log("\nrebrowser: 0 red ✓");
  } catch (e) {
    console.warn(`\nWARN: detector unreachable (${e.message}). Config guards still apply; detector check inconclusive.`);
    if (exitCode === 0) exitCode = 2; // inconclusive, not a clean pass
  }

  // --- Optional target load check (objective: blocked page or not) ---
  if (extraUrl && detectorRan) {
    try {
      await page.goto(extraUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(5000);
      const probe = await page.evaluate(() => ({
        title: document.title,
        body: (document.body.innerText || "").slice(0, 400),
      }));
      const BLOCK = /captcha|are you (a )?human|verify you are|access denied|oh snap|bot detected|unusual traffic|request blocked/i;
      console.log(`\ntarget ${extraUrl}\n  title: ${probe.title}`);
      if (BLOCK.test(probe.title) || BLOCK.test(probe.body)) {
        fail(`target page looks like a block/challenge page: "${probe.title}"`);
      } else {
        console.log("  no block-page keywords detected ✓");
      }
    } catch (e) {
      console.warn(`  WARN: target load failed (${e.message}).`);
    }
  }
} catch (e) {
  fail("scorecard crashed: " + (e?.stack || e?.message || e));
} finally {
  for (const [, entry] of driver.contexts) await entry.context.close().catch(() => {});
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}

console.log(exitCode === 0 ? "\nSCORECARD: PASS" : exitCode === 2 ? "\nSCORECARD: INCONCLUSIVE (detector unreachable)" : "\nSCORECARD: FAIL");
process.exit(exitCode);
