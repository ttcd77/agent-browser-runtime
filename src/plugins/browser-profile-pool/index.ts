/**
 * browser-profile-pool plugin
 *
 * 浏览器 profile 池的 2 个工具:
 *   - register_browser_profile  在 ~/.openclaw/openclaw.json 的 browser.profiles 注册新 profile
 *                               (运维窗口用,改 config 触发 gateway reload/restart)
 *   - acquire_browser_profile   从 target 池(如 8x8-1 ~ 8x8-10)挑空闲 profile 返给 caller
 *                               TTL 30 min 自动过期,无 release 工具
 *
 * 拆分自老 security-tools/index.ts(2026-05-05)。schema/executor 写一起;
 * 浏览器 bridge HTTP 客户端从 hub-client.ts 共享 import。
 */
import {
  definePluginEntry,
  type AnyAgentTool,
} from "../../openclaw-shim/plugin-entry.js";
import { acquireLocalBrowserProfile } from "./lease-store.js";
import { bridgePost, bridgeGet, asObject } from "../hub-client.js";

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
// per-target profile 池 — 从 ~/.openclaw/openclaw.json 的 browser.profiles 自动推导
// 命名规范:`<target>-<identity>` 或旧式 `<target>-<数字 slot>` 都进池。
// 例:gocardless-merchant-a / gocardless-payer / 8x8-1。
// 不带 target 前缀的(default / helper-test-profile 等)不进池。
// 每次调用都重读 config — 让 register_browser_profile 后立即可用,不需要重启 gateway。
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
      process.env.OPENCLAW_CONFIG_PATH || path.join(os.homedir(), ".openclaw", "openclaw.json");
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
        "运维窗口里注册新浏览器 profile。\n\n**What**: 在 ~/.openclaw/openclaw.json 的 browser.profiles 里写入一个新 profile。当前架构优先使用统一 9222 + 9326/<profile> 的 cdpUrl 隔离；cdpPort 只是旧式 fallback。\n**How**: 仅 Main / Developer / 外场在系统空闲或用户批准的维护窗口调用。传 name（建议 '<target>-<slot>'）+ 可选 color（#RRGGBB）。\n**Gotcha**: 这是 config 变更，可能触发 gateway reload / restart；Scout / Builder / Breaker 不应在活跃工作中调用，缺 profile 时应通知 Main 排维护窗口。",
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
        "锁一个 Chrome 浏览器 profile 给当前 session 用,防多个 agent 撞同一个 profile 造成 cookie/流量混。**没有 release 工具** — lease 30 min 自动过期。\n\n**What**: 从 target 的 profile 池挑空闲的返回。池子来自 ~/.openclaw/openclaw.json 里所有 `<target>-*` profile,支持旧式数字槽(8x8-1)和身份槽(gocardless-merchant-a / gocardless-payer / gocardless-clean)。租约写进本地 JSON store,同一插件运行时内可避免 profile 撞车。\n**How**: 必传 target(如 'gocardless')。如果任务必须使用某个身份,传 preferred_profile。返回 `{profile_name: 'gocardless-merchant-a'}` 或 `{error: 'pool_exhausted'}`。后续 browser / cdp_query 等浏览器工具用这个 profile name。\n**Gotcha**: 不需要 release(TTL 自动)。pool_exhausted = 等 TTL 过期或人工 register_browser_profile 扩池。不要改用 default / helper / 个人浏览器。",
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
