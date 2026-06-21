/**
 * Agent Workspace tools — Browser Harness-style self-improving tool layer.
 *
 * V3 (2026-06-21): FS-based tools (skills/helpers) ported to attack-harness Python
 * primitives via subprocess. CDP-dependent tools (click_xy, fill_framework,
 * screenshot_drive) rely on maybeRoutePersonal → personal Chrome bridge.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { toolResult } from "./result-format.mjs";
import {
  workspaceStatus,
  loadAgentHelpers,
  getToolUsage,
  rankTools,
} from "./agent-workspace.mjs";

// ── attack-harness subprocess proxy (same pattern as register-replay-attack.mjs) ──
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PYTHON = process.env.PYTHON_BIN || "python";
const AH_CWD = process.env.ATTACK_HARNESS_CWD
  || join(__dirname, "..", "..", "..", "helloworld", "attack-harness");

function attackHarness(pyCode, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, ["-c", pyCode], {
      cwd: AH_CWD,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    let out = "", err = "";
    proc.stdout.on("data", (d) => out += d.toString("utf-8"));
    proc.stderr.on("data", (d) => err += d.toString("utf-8"));
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`attack-harness timed out after ${timeoutMs}ms: ${err || out}`));
    }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        try {
          resolve(JSON.parse(out.trim() || "{}"));
        } catch (e) {
          resolve({ ok: true, _raw: out.trim(), _parse_note: String(e.message) });
        }
      } else {
        reject(new Error(err || out || `exit code ${code}`));
      }
    });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * @param {object} ctx
 * @param {Map} ctx.tools
 * @param {object} ctx.profileRegistry
 * @param {(name?: string) => Promise<object>} ctx.resolveProfile
 * @param {number} ctx.cdpPort
 * @param {object} ctx.managedPlaywrightDriver
 * @param {(toolName: string, params: object) => Promise<object|null>} ctx.maybeRoutePersonal
 */
export function registerAgentWorkspaceTools(ctx) {
  const { tools, profileRegistry, resolveProfile, cdpPort, managedPlaywrightDriver, maybeRoutePersonal } = ctx;

  // ── Workspace Health ──────────────────────────────────────────────

  tools.set("browser_workspace_status", {
    name: "browser_workspace_status",
    description:
      "Agent workspace health: what helpers exist, how many domain skills, what tools are most used. " +
      "Use this to understand what the agent already knows about this profile before planning actions.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name." },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const pDir = profileRegistry.profileDir(profile.name);
      const status = workspaceStatus(pDir);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...status }, null, 2) }] };
    },
  });

  // ── Agent Helpers CRUD (→ Python FS primitives) ──────────────────

  tools.set("browser_agent_helpers_read", {
    name: "browser_agent_helpers_read",
    description:
      "Read the current agent_helpers.py file. This is Python code the agent wrote during past sessions to " +
      "fill capability gaps. Agents should read helpers before starting a task to avoid re-inventing.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name." },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const wsDir = profileRegistry.profileDir(profile.name);
      const safe = (v) => v != null ? JSON.stringify(v) : "None";
      const py = `
from attack_harness.helpers import read_helpers
import json
r = read_helpers(workspace_dir=${safe(wsDir)})
print(json.dumps(r, ensure_ascii=False))
`;
      return toolResult(await attackHarness(py, 10000));
    },
  });

  tools.set("browser_agent_helpers_write", {
    name: "browser_agent_helpers_write",
    description:
      "Write or update the agent_helpers.py file. Use this DURING task execution when you discover " +
      "a missing capability. Write idiomatic Python; helpers are available in subsequent attack-harness calls. " +
      "Functions starting with _ are private convention.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name." },
        source: { type: "string", description: "Complete Python source for agent_helpers.py." },
        append: { type: "boolean", description: "If true, append `source` to the existing file instead of replacing it. Default false." },
      },
      required: ["source"],
    },
    async execute(_id, params) {
      if (!params?.source) return toolResult({ ok: false, error: "source is required" });
      const profile = await resolveProfile(params?.profile);
      const wsDir = profileRegistry.profileDir(profile.name);
      const safe = (v) => v != null ? JSON.stringify(v) : "None";
      const py = `
from attack_harness.helpers import write_helpers
import json
r = write_helpers(
    workspace_dir=${safe(wsDir)},
    source=${safe(params.source)},
    append=${safe(params.append)},
)
print(json.dumps(r, ensure_ascii=False))
`;
      return toolResult(await attackHarness(py, 10000));
    },
  });

  // ── Domain Skills (→ Python FS primitives) ───────────────────────

  tools.set("browser_domain_skills_list", {
    name: "browser_domain_skills_list",
    description:
      "List domain skill files for a hostname. Domain skills are Markdown playbooks the agent " +
      "wrote after successfully navigating a site — they capture login flows, API patterns, " +
      "anti-bot behaviours, and stable selectors.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name." },
        hostname: { type: "string", description: "Hostname to look up, e.g. hackerone.com or github.com" },
      },
      required: ["hostname"],
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const wsDir = profileRegistry.profileDir(profile.name);
      const safe = (v) => v != null ? JSON.stringify(v) : "None";
      const py = `
from attack_harness.skills import list_skills
import json
r = list_skills(
    workspace_dir=${safe(wsDir)},
    hostname=${safe(params?.hostname)},
)
print(json.dumps(r, ensure_ascii=False))
`;
      return toolResult(await attackHarness(py, 10000));
    },
  });

  tools.set("browser_domain_skills_read", {
    name: "browser_domain_skills_read",
    description:
      "Read a specific domain skill file. Returns the full Markdown content. " +
      "Read relevant domain skills before planning actions on a known site.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name." },
        hostname: { type: "string", description: "Hostname, e.g. hackerone.com" },
        filename: { type: "string", description: "Skill filename, e.g. navigation.md" },
      },
      required: ["hostname", "filename"],
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const wsDir = profileRegistry.profileDir(profile.name);
      const safe = (v) => v != null ? JSON.stringify(v) : "None";
      const py = `
from attack_harness.skills import read_skill
import json
r = read_skill(
    workspace_dir=${safe(wsDir)},
    hostname=${safe(params?.hostname)},
    filename=${safe(params?.filename)},
)
print(json.dumps(r, ensure_ascii=False))
`;
      return toolResult(await attackHarness(py, 10000));
    },
  });

  tools.set("browser_domain_skills_write", {
    name: "browser_domain_skills_write",
    description:
      "Write or update a domain skill file. Use this AFTER successfully completing a task on a site. " +
      "Capture: the navigation flow, stable selectors/APIs, anti-bot patterns encountered, " +
      "framework quirks, and any hard-won knowledge that would save time on the next visit.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name." },
        hostname: { type: "string", description: "Hostname, e.g. hackerone.com" },
        filename: { type: "string", description: "Filename ending in .md, e.g. navigation.md" },
        content: { type: "string", description: "Markdown content for the skill file." },
      },
      required: ["hostname", "filename", "content"],
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const wsDir = profileRegistry.profileDir(profile.name);
      const safe = (v) => v != null ? JSON.stringify(v) : "None";
      const py = `
from attack_harness.skills import write_skill
import json
r = write_skill(
    workspace_dir=${safe(wsDir)},
    hostname=${safe(params?.hostname)},
    filename=${safe(params?.filename)},
    content=${safe(params?.content)},
)
print(json.dumps(r, ensure_ascii=False))
`;
      return toolResult(await attackHarness(py, 10000));
    },
  });

  // ── Tool Usage Stats (static — no CDP needed) ────────────────────

  tools.set("browser_tool_usage", {
    name: "browser_tool_usage",
    description:
      "Get tool usage statistics for this profile. Returns tools ranked by frequency × success rate. " +
      "Use this to prefer proven tools over rarely-used ones.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name." },
        limit: { type: "integer", description: "Max results to return. Default 20.", default: 20 },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const dir = profileRegistry.profileDir(profile.name);
      const ranked = rankTools(dir).slice(0, params?.limit || 20);
      const helpers = await loadAgentHelpers(dir);
      const helperNames = Object.keys(helpers).filter(k => !k.startsWith("_") && k !== "_loadError");
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            rankedTools: ranked,
            agentHelperFunctions: helperNames,
            hint: "Higher score = more frequently used with high success. Prefer these tools unless the task demands otherwise.",
          }, null, 2),
        }],
      };
    },
  });

  // ── Coordinate Click → must route via personal Chrome ────────────

  tools.set("browser_click_xy", {
    name: "browser_click_xy",
    description:
      "Click at exact pixel coordinates. Screenshot-first interaction: take a screenshot, " +
      "read pixel coordinates from the image, click at (x,y). Routes via personal Chrome bridge.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name." },
        x: { type: "number", description: "X coordinate (pixels from left)." },
        y: { type: "number", description: "Y coordinate (pixels from top)." },
        button: { type: "string", description: "Mouse button: left, right, middle. Default left.", default: "left" },
        clicks: { type: "integer", description: "Number of clicks (1 = single, 2 = double). Default 1.", default: 1 },
        tabId: { type: "string", description: "CDP tab ID override." },
      },
      required: ["x", "y"],
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_click_xy", params);
      if (routed) return toolResult(routed);
      // Managed backend removed — this tool requires a real browser.
      return toolResult({
        ok: false,
        error: "managed_backend_removed",
        message: "browser_click_xy requires a real browser. Use backend=personal to route via Chrome extension.",
        new_tool: "browser_click_xy (with backend=personal)",
      });
    },
  });

  // ── Framework-aware Fill → must route via personal Chrome ────────

  tools.set("browser_fill_framework", {
    name: "browser_fill_framework",
    description:
      "Fill a form input in a framework-managed page (React controlled, Vue v-model, Ember tracked). " +
      "Routes via personal Chrome bridge.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name." },
        selector: { type: "string", description: "CSS selector for the input element." },
        text: { type: "string", description: "Text to type into the input." },
        clearFirst: { type: "boolean", description: "Select-all + delete before typing. Default true.", default: true },
        timeout: { type: "integer", description: "Wait up to this many ms for the element to appear. Default 0.", default: 0 },
        tabId: { type: "string", description: "CDP tab ID override." },
      },
      required: ["selector", "text"],
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_fill_framework", params);
      if (routed) return toolResult(routed);
      return toolResult({
        ok: false,
        error: "managed_backend_removed",
        message: "browser_fill_framework requires a real browser. Use backend=personal to route via Chrome extension.",
        new_tool: "browser_fill_framework (with backend=personal)",
      });
    },
  });

  // ── Screenshot-First Exploration → must route via personal Chrome ─

  tools.set("browser_screenshot_drive", {
    name: "browser_screenshot_drive",
    description:
      "Screenshot-first exploration: take a screenshot and return it WITH the page dimensions " +
      "and device pixel ratio so the agent can plan coordinate-based clicks. Routes via personal Chrome bridge.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name." },
        full: { type: "boolean", description: "Capture full page (beyond viewport). Default false." },
        maxDim: { type: "integer", description: "Max dimension in pixels for thumbnail. Default 1800.", default: 1800 },
        tabId: { type: "string", description: "CDP tab ID override." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_screenshot_drive", params);
      if (routed) return toolResult(routed);
      return toolResult({
        ok: false,
        error: "managed_backend_removed",
        message: "browser_screenshot_drive requires a real browser. Use backend=personal to route via Chrome extension.",
        new_tool: "browser_screenshot_drive (with backend=personal)",
      });
    },
  });
}
