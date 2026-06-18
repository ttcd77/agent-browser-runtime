/**
 * Agent Workspace tools — Browser Harness-style self-improving tool layer.
 *
 * These tools let agents:
 *   1. Read/write agent_helpers.js   — write missing helpers during execution
 *   2. Read/write domain-skills/      — capture site-specific knowledge
 *   3. Query tool-usage stats         — prefer proven tools by frequency × success
 *   4. Use coordinate-click + framework-aware fill — screenshot-first interaction
 */

import { join } from "node:path";
import {
  workspaceStatus,
  loadAgentHelpers,
  writeAgentHelpers,
  readAgentHelpersSource,
  getToolUsage,
  rankTools,
  listDomainSkills,
  readDomainSkill,
  writeDomainSkill,
  listDomainSkillHosts,
} from "./agent-workspace.mjs";

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

  // ── Agent Helpers CRUD ────────────────────────────────────────────

  tools.set("browser_agent_helpers_read", {
    name: "browser_agent_helpers_read",
    description:
      "Read the current agent_helpers.js file. This is JS code the agent wrote during past sessions to " +
      "fill capability gaps. Agents should read helpers before starting a task to avoid re-inventing.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name." },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const source = readAgentHelpersSource(profileRegistry.profileDir(profile.name));
      const helpers = await loadAgentHelpers(profileRegistry.profileDir(profile.name));
      const functionNames = Object.keys(helpers).filter(k => !k.startsWith("_"));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            source: source || "(empty — no helpers written yet)",
            exportedFunctions: functionNames,
          }, null, 2),
        }],
      };
    },
  });

  tools.set("browser_agent_helpers_write", {
    name: "browser_agent_helpers_write",
    description:
      "Write or update the agent_helpers.js file. Use this DURING task execution when you discover " +
      "a missing browser capability (e.g. a site-specific form filler, a CAPTCHA workaround, a custom " +
      "selector strategy). Write idiomatic JavaScript; the helpers are auto-loaded on next tool call. " +
      "Functions starting with _ are private and won't be exported.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name." },
        source: { type: "string", description: "Complete JavaScript source for agent_helpers.js." },
        append: { type: "boolean", description: "If true, append `source` to the existing file instead of replacing it. Default false." },
      },
      required: ["source"],
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const dir = profileRegistry.profileDir(profile.name);
      let finalSource = params.source;
      if (params.append) {
        const existing = readAgentHelpersSource(dir) || "";
        finalSource = existing ? `${existing}\n\n${params.source}` : params.source;
      }
      writeAgentHelpers(dir, finalSource);
      // Auto-reload so the new functions are available immediately
      const helpers = await loadAgentHelpers(dir);
      const functionNames = Object.keys(helpers).filter(k => !k.startsWith("_") && k !== "_loadError");
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            wrote: params.append ? "appended" : "replaced",
            exportedFunctions: functionNames,
            hint: "Helper functions are now available in subsequent tool calls. Use browser_agent_helpers_read to verify.",
          }, null, 2),
        }],
      };
    },
  });

  // ── Domain Skills ─────────────────────────────────────────────────

  tools.set("browser_domain_skills_list", {
    name: "browser_domain_skills_list",
    description:
      "List domain skill files for a hostname. Domain skills are Markdown playbooks the agent " +
      "wrote after successfully navigating a site — they capture login flows, API patterns, " +
      "anti-bot behaviours, and stable selectors. Read domain skills before starting work on " +
      "a previously-visited site to avoid re-discovering already-known patterns.",
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
      const dir = profileRegistry.profileDir(profile.name);
      const files = listDomainSkills(dir, params.hostname);
      const hosts = files.length ? [params.hostname] : listDomainSkillHosts(dir);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            hostname: params.hostname,
            matchedFiles: files,
            allKnownHosts: hosts,
            hint: files.length
              ? "Use browser_domain_skills_read to read a specific skill file."
              : "No skills for this host. Use browser_domain_skills_write to create one after you learn the site.",
          }, null, 2),
        }],
      };
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
      const dir = profileRegistry.profileDir(profile.name);
      const content = readDomainSkill(dir, params.hostname, params.filename);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: content !== null,
            hostname: params.hostname,
            filename: params.filename,
            content: content || "skill file not found",
          }, null, 2),
        }],
      };
    },
  });

  tools.set("browser_domain_skills_write", {
    name: "browser_domain_skills_write",
    description:
      "Write or update a domain skill file. Use this AFTER successfully completing a task on a site. " +
      "Capture: the navigation flow, stable selectors/APIs, anti-bot patterns encountered, " +
      "framework quirks, and any hard-won knowledge that would save time on the next visit. " +
      "Do NOT write: pixel coordinates (break on layout change), secrets/tokens, or task narration.",
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
      const dir = profileRegistry.profileDir(profile.name);
      writeDomainSkill(dir, params.hostname, params.filename, params.content);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            hostname: params.hostname,
            filename: params.filename,
            path: join(dir, "agent-workspace", "domain-skills", params.hostname, params.filename),
          }, null, 2),
        }],
      };
    },
  });

  // ── Tool Usage Stats ──────────────────────────────────────────────

  tools.set("browser_tool_usage", {
    name: "browser_tool_usage",
    description:
      "Get tool usage statistics for this profile. Returns tools ranked by frequency × success rate. " +
      "Use this to prefer proven tools over rarely-used ones. Also returns a usage summary of your " +
      "agent-written helper functions.",
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

  // ── Coordinate Click (Browser Harness-style screenshot-first) ─────

  tools.set("browser_click_xy", {
    name: "browser_click_xy",
    description:
      "Click at exact pixel coordinates. Screenshot-first interaction: take a screenshot, " +
      "read pixel coordinates from the image, click at (x,y). This bypasses selector fragility — " +
      "clicks go through iframes, shadow DOM, and cross-origin boundaries at the compositor level. " +
      "After clicking, take another screenshot to verify the action landed.",
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
      try {
        return await maybeRoutePersonal("browser_click_xy", params);
      } catch { /* fall through to managed */ }
      const profile = await resolveProfile(params?.profile);
      const tabId = params?.tabId || profile.tabId;
      if (!tabId) throw new Error("No tab attached — use browser_open first.");
      const client = await managedPlaywrightDriver.connectTab(tabId);
      try {
        await client.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: params.x,
          y: params.y,
          button: params.button || "left",
          clickCount: params.clicks || 1,
        });
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: params.x,
          y: params.y,
          button: params.button || "left",
          clickCount: params.clicks || 1,
        });
      } finally {
        await client.close().catch(() => {});
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            x: params.x,
            y: params.y,
            button: params.button || "left",
            clicks: params.clicks || 1,
            hint: "Take a screenshot with browser_screenshot to verify the click landed.",
          }, null, 2),
        }],
      };
    },
  });

  // ── Framework-aware Fill (React / Vue / Ember compatible) ─────────

  tools.set("browser_fill_framework", {
    name: "browser_fill_framework",
    description:
      "Fill a form input in a framework-managed page (React controlled, Vue v-model, Ember tracked). " +
      "Unlike browser_fill which bypasses framework event listeners, this helper focuses the element, " +
      "clears via Ctrl+A+Backspace, types character-by-character via real key events, then dispatches " +
      "synthetic input+change events so the framework detects the update. " +
      "Use this when browser_fill leaves submit buttons disabled or validation doesn't trigger.",
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
      try {
        return await maybeRoutePersonal("browser_fill_framework", params);
      } catch { /* fall through to managed */ }
      const profile = await resolveProfile(params?.profile);
      const tabId = params?.tabId || profile.tabId;
      if (!tabId) throw new Error("No tab attached — use browser_open first.");
      const client = await managedPlaywrightDriver.connectTab(tabId);
      try {
        const selector = params.selector;
        const text = params.text;
        const timeout = params.timeout || 0;

        // Poll for element if timeout > 0
        if (timeout > 0) {
          const deadline = Date.now() + timeout;
          let found = false;
          while (Date.now() < deadline) {
            const result = await client.send("Runtime.evaluate", {
              expression: `!!document.querySelector(${JSON.stringify(selector)})`,
              returnByValue: true,
            });
            if (result.result?.value) { found = true; break; }
            await new Promise(r => setTimeout(r, 300));
          }
          if (!found) throw new Error(`fill_framework: element not found: ${selector} after ${timeout}ms`);
        }

        // Focus the element
        const focusResult = await client.send("Runtime.evaluate", {
          expression: `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.focus();return true;})()`,
          returnByValue: true,
        });
        if (!focusResult.result?.value) {
          throw new Error(`fill_framework: element not found: ${selector}`);
        }

        // Clear via Ctrl+A + Backspace
        if (params.clearFirst !== false) {
          const isMac = false; // Windows/Linux: Ctrl; macOS: Cmd (not relevant for ABR worker usage)
          const mods = 2; // Ctrl
          const selectAll = {
            type: "rawKeyDown", key: "a", code: "KeyA", modifiers: mods,
            windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
          };
          await client.send("Input.dispatchKeyEvent", selectAll);
          await client.send("Input.dispatchKeyEvent", { ...selectAll, type: "keyUp" });
          await client.send("Input.dispatchKeyEvent", {
            type: "rawKeyDown", key: "Backspace", code: "Backspace",
            windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
          });
          await client.send("Input.dispatchKeyEvent", {
            type: "keyUp", key: "Backspace", code: "Backspace",
            windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
          });
        }

        // Type character-by-character
        for (const ch of text) {
          const vk = ch.charCodeAt(0);
          const keyParams = {
            type: "rawKeyDown", key: ch, code: `Key${ch.toUpperCase()}`,
            windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
          };
          await client.send("Input.dispatchKeyEvent", { ...keyParams, text: ch });
          await client.send("Input.dispatchKeyEvent", {
            type: "char", text: ch,
            key: ch, code: `Key${ch.toUpperCase()}`,
            windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
          });
          await client.send("Input.dispatchKeyEvent", { ...keyParams, type: "keyUp" });
        }

        // Dispatch synthetic input + change events so framework picks up the value
        await client.send("Runtime.evaluate", {
          expression: `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
        });

      } finally {
        await client.close().catch(() => {});
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            selector: params.selector,
            textLength: params.text.length,
            cleared: params.clearFirst !== false,
            hint: "Verify with browser_screenshot that the form field updated and submit buttons are enabled.",
          }, null, 2),
        }],
      };
    },
  });

  // ── Screenshot-First Exploration Helper ───────────────────────────

  tools.set("browser_screenshot_drive", {
    name: "browser_screenshot_drive",
    description:
      "Screenshot-first exploration: take a screenshot and return it WITH the page dimensions " +
      "and device pixel ratio so the agent can plan coordinate-based clicks. " +
      "Designed for the Browser Harness pattern: screenshot → read pixels → click_xy → screenshot verify.",
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
      try {
        return await maybeRoutePersonal("browser_screenshot_drive", params);
      } catch { /* fall through */ }
      const profile = await resolveProfile(params?.profile);
      const tabId = params?.tabId || profile.tabId;
      if (!tabId) throw new Error("No tab attached — use browser_open first.");
      const client = await managedPlaywrightDriver.connectTab(tabId);
      try {
        // Get page geometry
        const geoResult = await client.send("Runtime.evaluate", {
          expression: "JSON.stringify({url:location.href,title:document.title,w:innerWidth,h:innerHeight,sx:scrollX,sy:scrollY,dpr:devicePixelRatio})",
          returnByValue: true,
        });
        const geo = JSON.parse(geoResult.result?.value || "{}");

        // Screenshot
        const shot = await client.send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: params.full === true,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                pageInfo: geo,
                viewport: { width: geo.w, height: geo.h },
                scrollX: geo.sx,
                scrollY: geo.sy,
                devicePixelRatio: geo.dpr,
                hint: `Click target: multiply screenshot pixel coordinates by devicePixelRatio (${geo.dpr}). Use browser_click_xy to click.`,
              }, null, 2),
            },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${shot.data}` },
            },
          ],
        };
      } finally {
        await client.close().catch(() => {});
      }
    },
  });
}
