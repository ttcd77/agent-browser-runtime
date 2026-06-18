/**
 * Agent Workspace — editable tool layer that grows with use.
 *
 * Browser Harness-style: agents write what's missing during execution.
 * Core helpers stay protected; agent-editable code lives here.
 *
 * Layout (per profile, under ~/.agent-browser-runtime/profiles/<name>/agent-workspace/):
 *   agent_helpers.js     — agent-written JS; dynamically loaded before each tool call
 *   tool-usage.json       — { toolName: { count, lastUsed, successRate, avgDurationMs } }
 *   domain-skills/        — per-host Markdown playbooks the agent writes after success
 *     github/
 *     hackerone/
 *     ...
 *
 * The core pattern mirrors browser-use/browser-harness:
 *   1. Agent encounters missing capability → writes function to agent_helpers.js
 *   2. Next call auto-loads it → capability exists
 *   3. Tool usage stats guide agent toward proven tools
 *   4. Domain skills capture site-specific knowledge across sessions
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const USAGE_FILE = "tool-usage.json";
const HELPERS_FILE = "agent_helpers.js";
const DOMAIN_SKILLS_DIR = "domain-skills";
const MAX_USAGE_ENTRIES = 200;

/**
 * @param {string} profileDir — absolute path to the profile directory
 * @returns {string} absolute path to agent-workspace for this profile
 */
export function workspaceDir(profileDir) {
  return join(profileDir, "agent-workspace");
}

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true, mode: 0o700 });
}

// ── Tool Usage Tracking ──────────────────────────────────────────────

/**
 * Record a tool invocation. Writes synchronously to stay simple — the JSON
 * file is tiny and write frequency is bounded by tool call rate.
 *
 * @param {string} profileDir
 * @param {string} toolName
 * @param {{ ok?: boolean, durationMs?: number }} outcome
 */
export function recordToolUsage(profileDir, toolName, outcome = {}) {
  const dir = workspaceDir(profileDir);
  ensureDir(dir);
  const file = join(dir, USAGE_FILE);
  let data = {};
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // first write
  }
  const entry = data[toolName] || { count: 0, successCount: 0, lastUsed: null, totalDurationMs: 0 };
  entry.count += 1;
  if (outcome.ok !== false) entry.successCount += 1;
  if (typeof outcome.durationMs === "number") entry.totalDurationMs += outcome.durationMs;
  entry.lastUsed = new Date().toISOString();
  entry.successRate = entry.count > 0 ? entry.successCount / entry.count : 0;
  entry.avgDurationMs = entry.count > 0 ? Math.round(entry.totalDurationMs / entry.count) : 0;
  data[toolName] = entry;

  // Prune oldest entries if over limit
  const keys = Object.keys(data);
  if (keys.length > MAX_USAGE_ENTRIES) {
    const sorted = keys.sort((a, b) => (data[a].lastUsed || "").localeCompare(data[b].lastUsed || ""));
    for (const k of sorted.slice(0, keys.length - MAX_USAGE_ENTRIES)) delete data[k];
  }

  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Get tool usage stats, sorted by count descending.
 * @param {string} profileDir
 * @returns {object} { toolName: { count, successRate, lastUsed, avgDurationMs } }
 */
export function getToolUsage(profileDir) {
  try {
    return JSON.parse(readFileSync(join(workspaceDir(profileDir), USAGE_FILE), "utf8"));
  } catch {
    return {};
  }
}

/**
 * Return tool names ranked by a combined score: frequency × successRate.
 * Agents can use this to prefer proven tools.
 * @param {string} profileDir
 * @returns {Array<{ tool: string, count: number, successRate: number, score: number }>}
 */
export function rankTools(profileDir) {
  const usage = getToolUsage(profileDir);
  return Object.entries(usage)
    .map(([tool, s]) => ({
      tool,
      count: s.count,
      successRate: s.successRate,
      score: s.count * (s.successRate || 0.5),
    }))
    .sort((a, b) => b.score - a.score);
}

// ── Agent Helpers — Dynamic Loading ──────────────────────────────────

/**
 * Load agent-editable helpers for a profile. Returns the module exports,
 * or {} if no helpers file exists.
 *
 * Uses a cache-busting query string so edits take effect on next call
 * without a daemon restart. On Node.js, ESM import() caches by URL; we
 * append a timestamp to force re-fetch.
 *
 * @param {string} profileDir
 * @returns {Promise<object>} the exports of agent_helpers.js
 */
let _helperLoadSeq = 0;
export async function loadAgentHelpers(profileDir) {
  const file = join(workspaceDir(profileDir), HELPERS_FILE);
  if (!existsSync(file)) return {};
  _helperLoadSeq += 1;
  const url = pathToFileURL(file).href + `?v=${_helperLoadSeq}`;
  try {
    const mod = await import(url);
    // Strip private (underscore) exports
    const out = {};
    for (const [k, v] of Object.entries(mod)) {
      if (!k.startsWith("_")) out[k] = v;
    }
    return out;
  } catch (err) {
    return { _loadError: String(err?.message || err) };
  }
}

/**
 * Write or replace the agent_helpers.js file.
 * @param {string} profileDir
 * @param {string} source — raw JS source
 */
export function writeAgentHelpers(profileDir, source) {
  const dir = workspaceDir(profileDir);
  ensureDir(dir);
  writeFileSync(join(dir, HELPERS_FILE), source, { mode: 0o600 });
}

/**
 * Read the raw agent_helpers.js content.
 * @param {string} profileDir
 * @returns {string|null}
 */
export function readAgentHelpersSource(profileDir) {
  const file = join(workspaceDir(profileDir), HELPERS_FILE);
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// ── Domain Skills ────────────────────────────────────────────────────

/**
 * List available domain skill files for a hostname.
 * Returns filenames (no path), sorted alphabetically.
 *
 * @param {string} profileDir
 * @param {string} hostname — e.g. "hackerone.com" or "github.com"
 * @returns {string[]}
 */
export function listDomainSkills(profileDir, hostname) {
  const base = join(workspaceDir(profileDir), DOMAIN_SKILLS_DIR);
  // Try exact host, then strip www., then first segment
  const candidates = [];
  if (hostname) {
    candidates.push(hostname);
    const cleaned = hostname.replace(/^www\./, "");
    if (cleaned !== hostname) candidates.push(cleaned);
    const seg = cleaned.split(".")[0];
    if (seg && seg !== cleaned) candidates.push(seg);
  }
  for (const c of candidates) {
    const d = join(base, c);
    try {
      const files = readdirSync(d).filter(f => f.endsWith(".md"));
      if (files.length) return files.sort();
    } catch {
      // directory doesn't exist — try next candidate
    }
  }
  return [];
}

/**
 * Read a specific domain skill file.
 * @param {string} profileDir
 * @param {string} hostname
 * @param {string} filename
 * @returns {string|null} markdown content or null
 */
export function readDomainSkill(profileDir, hostname, filename) {
  // Sanitize filename to prevent traversal
  const safe = String(filename).replace(/[/\\]|\.\./g, "");
  if (!safe.endsWith(".md")) return null;
  const base = join(workspaceDir(profileDir), DOMAIN_SKILLS_DIR, hostname);
  try {
    return readFileSync(join(base, safe), "utf8");
  } catch {
    return null;
  }
}

/**
 * Write or update a domain skill file. Creates host directory if needed.
 * @param {string} profileDir
 * @param {string} hostname
 * @param {string} filename — e.g. "navigation.md"
 * @param {string} content — markdown
 */
export function writeDomainSkill(profileDir, hostname, filename, content) {
  const safe = String(filename).replace(/[/\\]|\.\./g, "");
  if (!safe.endsWith(".md")) throw new Error("domain skill filenames must end with .md");
  const dir = join(workspaceDir(profileDir), DOMAIN_SKILLS_DIR, hostname);
  ensureDir(dir);
  writeFileSync(join(dir, safe), content, { mode: 0o600 });
}

/**
 * List all host directories under domain-skills.
 * @param {string} profileDir
 * @returns {string[]}
 */
export function listDomainSkillHosts(profileDir) {
  const base = join(workspaceDir(profileDir), DOMAIN_SKILLS_DIR);
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }
}

/**
 * Workspace health — agent-readable summary of what exists.
 * @param {string} profileDir
 * @returns {object}
 */
export function workspaceStatus(profileDir) {
  const dir = workspaceDir(profileDir);
  const hasHelpers = existsSync(join(dir, HELPERS_FILE));
  const stats = getToolUsage(profileDir);
  const topTools = rankTools(profileDir).slice(0, 10);
  const hosts = listDomainSkillHosts(profileDir);
  return {
    workspaceDir: dir,
    hasAgentHelpers: hasHelpers,
    totalToolsTracked: Object.keys(stats).length,
    topTools,
    domainSkillHosts: hosts,
    domainSkillCount: hosts.length,
  };
}
