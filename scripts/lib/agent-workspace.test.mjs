/**
 * Tests for agent-workspace — core module and Browser Harness integration.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { strict as assert } from "node:assert";

import {
  workspaceDir,
  recordToolUsage,
  getToolUsage,
  rankTools,
  loadAgentHelpers,
  writeAgentHelpers,
  readAgentHelpersSource,
  listDomainSkills,
  readDomainSkill,
  writeDomainSkill,
  listDomainSkillHosts,
  workspaceStatus,
} from "./agent-workspace.mjs";

let tmp;
let profileDir;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "abw-test-"));
  profileDir = join(tmp, "test-profile");
  mkdirSync(profileDir, { recursive: true });
});

afterAll(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ok */ }
});

describe("workspace directory structure", () => {
  it("returns correct workspace path under profile", () => {
    const wd = workspaceDir(profileDir);
    assert.ok(wd.endsWith("agent-workspace"));
    assert.ok(wd.includes("test-profile"));
  });
});

describe("tool usage tracking", () => {
  it("records tool usage and computes stats", () => {
    recordToolUsage(profileDir, "browser_click", { ok: true, durationMs: 50 });
    recordToolUsage(profileDir, "browser_click", { ok: true, durationMs: 30 });
    recordToolUsage(profileDir, "browser_click", { ok: false, durationMs: 100 });
    recordToolUsage(profileDir, "browser_capture", { ok: true, durationMs: 200 });

    const usage = getToolUsage(profileDir);
    assert.equal(usage.browser_click.count, 3);
    assert.equal(usage.browser_click.successCount, 2);
    assert.equal(usage.browser_click.avgDurationMs, 60);
    assert.equal(usage.browser_capture.count, 1);
  });

  it("ranks tools by frequency × successRate", () => {
    const ranked = rankTools(profileDir);
    assert.ok(ranked.length >= 2);
    // browser_click has higher score (3 * 0.67 = 2) than browser_capture (1 * 1 = 1)
    assert.equal(ranked[0].tool, "browser_click");
  });

  it("prunes oldest entries when over MAX limit", () => {
    // Add 250 entries — should prune to 200
    for (let i = 0; i < 250; i++) {
      recordToolUsage(profileDir, `tool_${i}`, { ok: true });
    }
    const usage = getToolUsage(profileDir);
    assert.ok(Object.keys(usage).length <= 200);
  });
});

describe("agent helpers — dynamic loading", () => {
  it("returns {} when no helpers file exists", async () => {
    const helpers = await loadAgentHelpers(profileDir);
    assert.deepEqual(helpers, {});
  });

  it("writes and loads agent helpers", async () => {
    writeAgentHelpers(profileDir, `
      export function customClick(page, selector) {
        return page.querySelector(selector)?.click();
      }
      const _privateVar = 42;
      export const publicVar = "hello";
    `);

    const source = readAgentHelpersSource(profileDir);
    assert.ok(source.includes("customClick"));

    const helpers = await loadAgentHelpers(profileDir);
    assert.equal(typeof helpers.customClick, "function");
    assert.equal(helpers.publicVar, "hello");
    // Private exports are stripped
    assert.equal(helpers._privateVar, undefined);
  });

  it("re-loads after edits (cache busting)", async () => {
    writeAgentHelpers(profileDir, `export const version = 1;`);
    const v1 = await loadAgentHelpers(profileDir);
    assert.equal(v1.version, 1);

    writeAgentHelpers(profileDir, `export const version = 2;`);
    const v2 = await loadAgentHelpers(profileDir);
    assert.equal(v2.version, 2);
  });

  it("handles syntax errors gracefully", async () => {
    writeAgentHelpers(profileDir, `this is not valid javascript {{{`);
    const helpers = await loadAgentHelpers(profileDir);
    assert.ok(helpers._loadError);
  });
});

describe("domain skills", () => {
  it("lists skills by hostname with fallback candidates", () => {
    writeDomainSkill(profileDir, "github.com", "navigation.md", "# GitHub Navigation\n- Click Repositories tab");
    writeDomainSkill(profileDir, "github.com", "issues.md", "# Issues\n- Use /issues?q= filter");

    // Exact match
    const exact = listDomainSkills(profileDir, "github.com");
    assert.deepEqual(exact, ["issues.md", "navigation.md"]);

    // www prefix fallback
    const www = listDomainSkills(profileDir, "www.github.com");
    assert.deepEqual(www, ["issues.md", "navigation.md"]);

    // No match
    const none = listDomainSkills(profileDir, "unknown.com");
    assert.deepEqual(none, []);
  });

  it("reads domain skill content", () => {
    const content = readDomainSkill(profileDir, "github.com", "navigation.md");
    assert.ok(content.includes("Repositories tab"));
  });

  it("rejects path traversal attempts", () => {
    const bad = readDomainSkill(profileDir, "github.com", "../../etc/passwd.md");
    assert.equal(bad, null);
  });

  it("lists all domain skill hosts", () => {
    writeDomainSkill(profileDir, "hackerone.com", "login.md", "# Login flow");
    const hosts = listDomainSkillHosts(profileDir);
    assert.ok(hosts.includes("github.com"));
    assert.ok(hosts.includes("hackerone.com"));
  });

  it("rejects non-.md filenames in writeDomainSkill", () => {
    assert.throws(() => writeDomainSkill(profileDir, "x.com", "bad.js", "code"));
  });
});

describe("workspaceStatus summary", () => {
  it("returns comprehensive health snapshot", () => {
    const status = workspaceStatus(profileDir);
    assert.equal(typeof status.hasAgentHelpers, "boolean");
    assert.equal(typeof status.totalToolsTracked, "number");
    assert.ok(Array.isArray(status.topTools));
    assert.ok(Array.isArray(status.domainSkillHosts));
    assert.equal(typeof status.workspaceDir, "string");
  });
});
