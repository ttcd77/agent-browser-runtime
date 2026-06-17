/**
 * browser-bridge HTTP client shared by the profile-pool plugin.
 *
 * A thin HTTP client for the local browser bridge (profile registration and
 * listing). It has no other dependencies and can run standalone.
 */
const TIMEOUT_MS = 30_000;

/** Narrow unknown to Record<string, unknown>; return an empty object when it is not a plain object. */
export function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

// ---------------------------------------------------------------------------
// browser-bridge (127.0.0.1:9302) client — used only by browser-profile-pool
// ---------------------------------------------------------------------------

const BRIDGE_URL = process.env.BROWSER_BRIDGE_URL ?? "http://127.0.0.1:9302";

let _bridgeTokenCache: { token: string | null; loadedAt: number } | null = null;

function resolveBridgeToken(): string | null {
  const fromEnv = process.env.BROWSER_BRIDGE_TOKEN;
  if (fromEnv) return fromEnv;
  const now = Date.now();
  if (_bridgeTokenCache && now - _bridgeTokenCache.loadedAt < 60_000) {
    return _bridgeTokenCache.token;
  }
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
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    const gateway = (cfg["gateway"] ?? {}) as Record<string, unknown>;
    const auth = (gateway["auth"] ?? {}) as Record<string, unknown>;
    const token = (auth["token"] as string | undefined) ?? null;
    _bridgeTokenCache = { token, loadedAt: now };
    return token;
  } catch {
    _bridgeTokenCache = { token: null, loadedAt: now };
    return null;
  }
}

export async function bridgeRequest(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  profile?: string,
): Promise<unknown> {
  const token = resolveBridgeToken();
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (method === "POST" && body !== undefined) headers["Content-Type"] = "application/json";

  const url = new URL(`${BRIDGE_URL}${path}`);
  if (profile) url.searchParams.set("profile", profile);
  if (method === "GET" && body && typeof body === "object") {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const r = await fetch(url.toString(), {
    method,
    headers,
    ...(method === "POST" && body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  // bridge 可能返回纯文本错误(如 "Unauthorized"、404 HTML)。先读 text,再尝试 JSON parse,
  // 失败时把 status + raw body 一并抛出,不静默吞错。
  const text = await r.text();
  if (!r.ok) {
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* 保留原文 */ }
    throw new Error(
      `browser-bridge ${r.status} ${r.statusText} @ ${method} ${path}: ${
        typeof parsed === "string" ? parsed : JSON.stringify(parsed)
      }`,
    );
  }
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return { raw: text }; }
}

export const bridgePost = (path: string, body: unknown, profile?: string) =>
  bridgeRequest("POST", path, body, profile);

export const bridgeGet = (path: string, query?: Record<string, unknown>, profile?: string) =>
  bridgeRequest("GET", path, query, profile);
