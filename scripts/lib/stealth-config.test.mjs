import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// Anti-bot regression guard. The managed browser was driving msedge with
// Playwright's default 1280x720 viewport, mismatching a Chrome UA and failing
// an AWS WAF + reCAPTCHA v3 challenge. These assertions fail loud if anyone
// reverts the channel to Edge or drops viewport:null. Behavioral proof lives in
// `npm run stealth-scorecard`; this is the cheap deterministic tripwire in `check`.
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "managed-playwright-driver.mjs"), "utf8");

describe("managed browser stealth config", () => {
  it("does not default the Playwright channel to Edge", () => {
    // Edge's userAgentData advertises a 'Microsoft Edge' brand that mismatches a
    // Chrome-shaped UA string — a brand-coherence flag for anti-bot WAFs.
    expect(src).not.toMatch(/PLAYWRIGHT_CHANNEL\s*=\s*["']msedge["']/);
    expect(src).toMatch(/ABR_PLAYWRIGHT_CHANNEL\s*\|\|\s*["']chrome["']/);
  });

  it("launches with viewport:null so the page reports the real OS window size", () => {
    // Without viewport:null Playwright pins 1280x720 — a known automation tell.
    expect(src).toMatch(/viewport:\s*null/);
  });
});
