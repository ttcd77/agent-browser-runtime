/**
 * browser-profile-pool plugin
 *
 * 浏览器 profile 池的 2 个工具:
 *   - register_browser_profile  在 browser-profiles.json 的 browser.profiles 注册新 profile
 *                               (运维窗口用,改 config 触发 gateway reload/restart)
 *   - acquire_browser_profile   pick a free profile from a target's pool
 *                               (e.g. app-1 ~ app-10) and return it to the caller.
 *                               30 min TTL auto-expiry, no release tool.
 *
 * Schema and executor live together. The browser-bridge HTTP client is shared
 * via import from bridge-client.ts.
 */
import {
  definePluginEntry,
  type AnyAgentTool,
} from "../../plugin-sdk/plugin-entry.js";
import { acquireLocalBrowserProfile } from "./lease-store.js";
import { bridgePost, bridgeGet, asObject } from "../bridge-client.js";

// ---------------------------------------------------------------------------
// profile 名规范化 / 颜色规范化辅助
// ---------------------------------------------------------------------------

function normalizeBrowserProfileName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name || name.length > 64 || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error("invalid profile name: use lowercase letters, numbers, and hyphens only");
  }
  return name;
}

function normalizeBrowserProfileColor(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  if (!/^#[0-9A-Fa-f]{6}$/.test(normalized)) {
    throw new Error("color must be a hex value like #0066CC");
  }
  return normalized.toUpperCase();
}

function isBrowserProfileAlreadyExistsError(err: unknown): boolean {
  const message = String(err);
  return /browser-bridge\s+409/i.test(message) && /already exists/i.test(message);
}

function extractBridgeProfileList(result: unknown): Record<string, unknown>[] {
  const profiles = asObject(result)["profiles"];
  if (!Array.isArray(profiles)) return [];
  return profiles.filter((entry): entry is Record<string, unknown> => {
    return Boolean(entry) && typeof entry === "object" && !Array.isArray(entry);
  });
}

// ---------------------------------------------------------------------------
// Per-target profile pool — derived automatically from browser.profiles in
// browser-profiles.json. Naming convention: `<target>-<identity>` or the older
// `<target>-<numeric slot>`; both join the pool.
// e.g. app-merchant-a / app-payer / app-1.
// Profiles without a target prefix (default / helper-test-profile, etc.) are
// excluded. Config is re-read on every call so a newly registered profile is
// usable immediately without restarting the host.
// ---------------------------------------------------------------------------

function profileSortKey(name: string): [number, number, string] {
  const numericSlot = name.match(/-(\d+)$/)?.[1];
  if (numericSlot) return [0, Number.parseInt(numericSlot, 10), name];
  const suffix = name.split("-").slice(1).join("-");
  const semanticOrder = [
    "attacker",
    "attacker-auth",
    "merchant-a",
    "merchant-b",
    "victim",
    "victim-auth",
    "payer",
    "guest",
    "guest-clean",
    "clean",
  ];
  const idx = semanticOrder.indexOf(suffix);
  return [1, idx >= 0 ? idx : 999, name];
}

function loadProfileNamesFromConfig(): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require("node:os") as typeof import("node:os");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path") as typeof import("node:path");
    const cfgPath =
      process.env.CDP_BROWSER_PROFILE_CONFIG ||
      path.join(os.homedir(), ".agent-browser-runtime", "browser-profiles.json");
    const cfgRaw = fs.readFileSync(cfgPath, "utf8").replace(/^\uFEFF/, "");
    const cfg = JSON.parse(cfgRaw) as Record<string, unknown>;
    const browser = (cfg["browser"] ?? {}) as Record<string, unknown>;
    const profiles = (browser["profiles"] ?? {}) as Record<string, unknown>;
    return Object.keys(profiles).sort();
  } catch {
    return [];
  }
}

function loadPoolForTarget(target: string, preferredProfile?: string): string[] {
  const prefix = `${target}-`;
  const names = loadProfileNamesFromConfig().filter((name) => name.startsWith(prefix));
  names.sort((a, b) => {
    const ka = profileSortKey(a);
    const kb = profileSortKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2]);
  });
  if (!preferredProfile || !names.includes(preferredProfile)) return names;
  return [preferredProfile, ...names.filter((name) => name !== preferredProfile)];
}

export default definePluginEntry({
  id: "browser-profile-pool",
  name: "browser-profile-pool",
  description:
    "浏览器 profile 注册 + 池租用工具:register_browser_profile / acquire_browser_profile。",

  register(api) {
    // ----- register_browser_profile -----------------------------------------
    api.registerTool((_ctx) => ({
      name: "register_browser_profile",
      label: "register_browser_profile",
      description:
        "Register a new browser profile during a maintenance window.\n\n**What**: Writes a new profile into browser.profiles in browser-profiles.json. The current setup prefers unified-port isolation via a per-profile cdpUrl (e.g. 9326/<profile>); cdpPort is a legacy fallback.\n**How**: Call only while the system is idle or in an approved maintenance window. Pass name (recommended '<target>-<slot>') and an optional color (#RRGGBB).\n**Gotcha**: This is a config change that may trigger a host reload/restart; do not call it during active work. When a profile is missing, schedule a maintenance window instead.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Profile 名，lowercase 字母/数字/dash，例如 'cambium-attacker'",
          },
          color: {
            type: "string",
            description: "可选 hex 颜色，建议 '#0066CC'；不传则自动分配",
          },
        },
        required: ["name"],
      },
      async execute(_id, params) {
        const p = params as Record<string, unknown>;
        try {
          const name = normalizeBrowserProfileName(p["name"]);
          const color = normalizeBrowserProfileColor(p["color"]);

          let payload: Record<string, unknown>;
          try {
            const created = asObject(
              await bridgePost("/profiles/create", { name, ...(color ? { color } : {}) }),
            );
            payload = {
              status: "registered",
              profile: typeof created["profile"] === "string" ? created["profile"] : name,
              cdpPort: typeof created["cdpPort"] === "number" ? created["cdpPort"] : null,
              color: typeof created["color"] === "string" ? created["color"] : color ?? null,
              transport: typeof created["transport"] === "string" ? created["transport"] : null,
              cdpUrl: typeof created["cdpUrl"] === "string" ? created["cdpUrl"] : null,
              userDataDir: typeof created["userDataDir"] === "string" ? created["userDataDir"] : null,
              isRemote: typeof created["isRemote"] === "boolean" ? created["isRemote"] : null,
            };
          } catch (err) {
            if (!isBrowserProfileAlreadyExistsError(err)) throw err;

            const profiles = extractBridgeProfileList(await bridgeGet("/profiles"));
            const existing = profiles.find((profile) => profile["name"] === name);
            if (!existing) throw err;

            payload = {
              status: "already_exists",
              profile: typeof existing["name"] === "string" ? existing["name"] : name,
              cdpPort: typeof existing["cdpPort"] === "number" ? existing["cdpPort"] : null,
              color: typeof existing["color"] === "string" ? existing["color"] : color ?? null,
              transport: typeof existing["transport"] === "string" ? existing["transport"] : null,
              cdpUrl: typeof existing["cdpUrl"] === "string" ? existing["cdpUrl"] : null,
              userDataDir: typeof existing["userDataDir"] === "string" ? existing["userDataDir"] : null,
              isRemote: typeof existing["isRemote"] === "boolean" ? existing["isRemote"] : null,
            };
          }

          return {
            content: [{ type: "text", text: JSON.stringify(payload) }],
            details: payload,
          };
        } catch (err) {
          const payload = { error: String(err) };
          return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
        }
      },
    } as AnyAgentTool));

    // ----- acquire_browser_profile ------------------------------------------
    api.registerTool((_ctx) => ({
      name: "acquire_browser_profile",
      label: "acquire_browser_profile",
      description:
        "Lock a Chrome browser profile for the current session so multiple agents do not collide on the same profile and mix cookies/traffic. **There is no release tool** — the lease auto-expires after 30 min.\n\n**What**: Returns a free profile from the target's pool. The pool is every `<target>-*` profile in browser-profiles.json, supporting legacy numeric slots (app-1) and identity slots (app-merchant-a / app-payer / app-clean). The lease is written to a local JSON store to avoid collisions within the same plugin runtime.\n**How**: target is required (e.g. 'app'). If the task must use a specific identity, pass preferred_profile. Returns `{profile_name: 'app-merchant-a'}` or `{error: 'pool_exhausted'}`. Subsequent browser / cdp_query tools use this profile name.\n**Gotcha**: No release needed (TTL auto-expiry). pool_exhausted = wait for the TTL to expire or extend the pool with register_browser_profile. Do not fall back to default / helper / a personal browser.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: "target 名(小写)如 'gocardless'。决定从哪个 `<target>-*` profile 池里选",
          },
          preferred_profile: {
            type: "string",
            description:
              "(可选)指定优先使用的身份 profile,如 'gocardless-merchant-a'。若被占用则回退到同 target 其他空闲 profile",
          },
          ttl_seconds: {
            type: "number",
            description: "(可选)lease 有效期秒,默认 1800=30min;超时 lease 自动失效,profile 回池",
          },
          caller_label: {
            type: "string",
            description:
              "(可选,audit 用)谁锁的,如 'gocardless-scout' / 'spawn-by-builder-...'",
          },
        },
        required: ["target"],
      },
      async execute(_id, params) {
        const p = params as Record<string, unknown>;
        try {
          const target = p["target"];
          if (typeof target !== "string" || !target.trim()) {
            throw new Error("target required");
          }
          const preferredProfile =
            typeof p["preferred_profile"] === "string" && p["preferred_profile"].trim()
              ? p["preferred_profile"].trim()
              : undefined;
          const pool = loadPoolForTarget(target, preferredProfile);
          if (pool.length === 0) {
            const payload = {
              error: `no pool for target=${target}; register profiles named '${target}-merchant-a', '${target}-payer', '${target}-clean' or '${target}-1', '${target}-2', ...`,
            };
            return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
          }
          const result = acquireLocalBrowserProfile({
            target,
            pool,
            ttl_seconds: typeof p["ttl_seconds"] === "number" ? p["ttl_seconds"] : 1800,
            caller_label: typeof p["caller_label"] === "string" ? p["caller_label"] : "unknown",
          });
          return {
            content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
            details: result,
          };
        } catch (err) {
          const payload = { error: String(err) };
          return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
        }
      },
    } as AnyAgentTool));
  },
});
