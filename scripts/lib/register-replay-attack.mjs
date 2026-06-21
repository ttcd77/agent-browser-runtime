// register-replay-attack.mjs — Raw/race/JWT/OOB request + replay + Agentic Intruder tool family.
// V2 (2026-06-21): thin-proxied to helloworld/attack-harness Python primitives via subprocess.
// The 5 helper libs (raw-request, jwt-forge, oob-client, replay-http, attack-intruder) are
// now dead code — kept for reference, not imported.
import { spawn } from "node:child_process";
import { toolResult } from "./result-format.mjs";

// Python executable and attack-harness working directory.
// On Windows, python may be in AppData; attack-harness is installed editable at this path.
const PYTHON = process.env.PYTHON_BIN || "python";
const AH_CWD = process.env.ATTACK_HARNESS_CWD || "C:/Users/Tong/project/helloworld/attack-harness";

/**
 * Spawn attack-harness CLI with a Python snippet on stdin, return parsed JSON result.
 * The Python snippet must print() a single JSON object to stdout.
 */
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
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

export function registerReplayAttackTools(deps) {
  const {
    tools,
    profileRegistry,
    resolveProfile,
    withManagedPageClient,
    executeProfileRequestReplayBatch,
    maybeRoutePersonal,
  } = deps;

  // ── profile_raw_request → raw_socket_request ──────────────────────────
  tools.set("profile_raw_request", {
    name: "profile_raw_request",
    description: "Send a byte-exact HTTP request over a raw Python socket (ssl), bypassing Chrome's network stack. Unlike request_replay (which runs fetch() in the page and is normalised by Chrome), this sends malformed framing verbatim — dual Content-Length, CL.TE/TE.CL desync, pipelined requests — for HTTP request smuggling and protocol-level testing. Returns raw response bytes plus objective signals (httpResponseCount, timing, closeReason); it does NOT judge whether desync occurred (the agent classifies).",
    parameters: {
      type: "object",
      properties: {
        host: { type: "string", description: "Required. Target hostname or IP." },
        port: { type: "number", description: "TCP port. Default: 443 when tls=true, 80 otherwise." },
        tls: { type: "boolean", description: "Use TLS. Default: true for port 443." },
        servername: { type: "string", description: "SNI hostname for TLS. Defaults to host." },
        rawRequest: { type: "string", description: "Exact request bytes; put CRLF (\\r\\n) and any malformed framing here verbatim." },
        rawRequestBase64: { type: "string", description: "Base64 request bytes for non-UTF8/binary framing; takes precedence over rawRequest." },
        readTimeoutMs: { type: "number", description: "Socket read timeout in ms. Default: 8000, clamped to 60000." },
        maxResponseBytes: { type: "number", description: "Max response bytes to read before closing. Default: 524288 (512 KB), clamped to 67108864 (64 MB)." },
      },
      required: ["host"],
    },
    async execute(_id, params) {
      const safe = (v) => v != null ? JSON.stringify(v) : "None";
      const py = `
from attack_harness.raw_http import raw_socket_request
import json
r = raw_socket_request(
    host=${safe(params.host)},
    port=${safe(params.port)},
    tls=${safe(params.tls)},
    servername=${safe(params.servername)},
    raw_request=${safe(params.rawRequest)},
    raw_request_base64=${safe(params.rawRequestBase64)},
    read_timeout_ms=${safe(params.readTimeoutMs)},
    max_response_bytes=${safe(params.maxResponseBytes)},
)
print(json.dumps(r, ensure_ascii=False))
`;
      return toolResult(await attackHarness(py, 60000));
    },
  });

  // ── profile_race_request → raw_race_request ──────────────────────────
  tools.set("profile_race_request", {
    name: "profile_race_request",
    description: "Fire N (>=2) byte-exact HTTP requests concurrently over independent raw Python sockets to drive a TOCTOU / race-condition test (coupon reuse, double-spend, invite/quota bypass, purchase-limit bypass). last-byte sync (default) holds back each request's final byte until ALL sockets have their head flushed, then releases all final bytes in one tight loop (Turbo Intruder gate technique) so the requests contend in a single tight window; parallel mode just threads the full requests as a fallback. Returns objective signals only — per-request status/headers/bytes, first-byte timing relative to a shared t0, status distribution, and first-byte spread (smaller = tighter race window). It does NOT judge whether the race won; the agent classifies from the status distribution and timing.",
    parameters: {
      type: "object",
      properties: {
        host: { type: "string", description: "Required. Target hostname or IP." },
        port: { type: "number", description: "TCP port. Default: 443 when tls=true, 80 otherwise." },
        tls: { type: "boolean", description: "Use TLS. Default: true for port 443." },
        servername: { type: "string", description: "SNI hostname for TLS. Defaults to host." },
        requests: {
          type: "array",
          minItems: 2,
          description: "Required. N (>=2) requests to race. Each is { rawRequest } or { rawRequestBase64 } with exact bytes; put CRLF (\\r\\n) verbatim. They may be identical (e.g. replay the same coupon N times) or differ.",
          items: {
            type: "object",
            properties: {
              rawRequest: { type: "string", description: "Exact request bytes for this entry." },
              rawRequestBase64: { type: "string", description: "Base64 request bytes; takes precedence over rawRequest." },
            },
          },
        },
        syncMode: { type: "string", enum: ["last-byte", "parallel"], description: "last-byte (default) = single-packet/gate sync; parallel = plain concurrent send." },
        readTimeoutMs: { type: "number", description: "Socket read timeout per request in ms. Default: 8000, clamped to 60000." },
        maxResponseBytes: { type: "number", description: "Max response bytes per request. Default: 524288 (512 KB), clamped to 67108864 (64 MB)." },
      },
      required: ["host", "requests"],
    },
    async execute(_id, params) {
      const safe = (v) => v != null ? JSON.stringify(v) : "None";
      const py = `
from attack_harness.raw_http import raw_race_request
import json
r = raw_race_request(
    host=${safe(params.host)},
    port=${safe(params.port)},
    tls=${safe(params.tls)},
    servername=${safe(params.servername)},
    requests=${safe(params.requests)},
    sync_mode=${safe(params.syncMode)},
    read_timeout_ms=${safe(params.readTimeoutMs)},
    max_response_bytes=${safe(params.maxResponseBytes)},
)
print(json.dumps(r, ensure_ascii=False))
`;
      return toolResult(await attackHarness(py, 120000));
    },
  });

  // ── profile_jwt_forge → forge_jwt ────────────────────────────────────
  tools.set("profile_jwt_forge", {
    name: "profile_jwt_forge",
    description: "Forge JWT auth-bypass candidates from an original token — pure offline algorithm (no network, no Chrome). Generates the classic attack families: alg=none (unsigned, with none/None/NONE spellings), weak HS256 secret (cracks the original signature against a wordlist then re-signs), RS256->HS256 alg confusion (signs with the RSA public key PEM as HMAC secret), kid header injection (path-traversal / SQLi / command payloads), and jku/x5u JWKS spoofing — optionally with payload claim mutations for privilege escalation (e.g. role=admin, sub=0). Returns only the constructed candidate tokens plus objective build notes; it does NOT judge whether the target accepts a token or whether privilege was escalated — the agent replays each candidate and classifies.",
    parameters: {
      type: "object",
      properties: {
        token: { type: "string", description: "The original JWT (header.payload.signature) to forge variants from." },
        mutations: { type: "object", description: "Claim overrides shallow-merged into the payload, e.g. { \"role\": \"admin\", \"sub\": \"0\" } for privilege escalation." },
        attacks: {
          type: "array",
          items: { type: "string", enum: ["none", "weak-secret", "hs-confusion", "kid-injection", "jku-spoof", "x5u-spoof"] },
          description: "Which variant families to generate. Default: all.",
        },
        publicKeyPem: { type: "string", description: "RSA/EC public key PEM (the key the target verifies RS256/ES256 with); required for the hs-confusion variant." },
        secretWordlist: { type: "array", items: { type: "string" }, description: "HS256 weak-secret candidates. Default: a small built-in list (secret/password/123456/changeme/jwt/key/admin/test/secretkey ...)." },
        attackerJku: { type: "string", description: "Attacker-controlled URL substituted into the jku/x5u headers; defaults to a placeholder when omitted." },
      },
      required: ["token"],
    },
    async execute(_id, params) {
      const safe = (v) => v != null ? JSON.stringify(v) : "None";
      const py = `
from attack_harness.crypto import forge_jwt
import json
r = forge_jwt(
    token=${safe(params.token)},
    mutations=${safe(params.mutations)},
    attacks=${safe(params.attacks)},
    public_key_pem=${safe(params.publicKeyPem)},
    secret_wordlist=${safe(params.secretWordlist)},
    attacker_jku=${safe(params.attackerJku)},
)
print(json.dumps(r, ensure_ascii=False))
`;
      return toolResult(await attackHarness(py, 10000));
    },
  });

  // ── profile_oob_alloc → oob_alloc ────────────────────────────────────
  tools.set("profile_oob_alloc", {
    name: "profile_oob_alloc",
    description: "Mint a unique out-of-band (OOB) callback URL/domain to plant into a payload for catching BLIND vulnerabilities. Three modes: (1) http (default) — returns a plain callback URL, embed in SSRF/SSTI/XXE/log4j payloads; (2) redirect — returns a base redirect URL (append ?to=<URL-encoded-target>) so the server records the callback then 302s the target to a second URL (SSRF chain: proves out-of-band reach AND redirects to internal endpoint); (3) dns — returns a DNS exfil domain (<token>.exfil.YOUR-DOMAIN.example), embed as DNS query target to exfiltrate data via DNS labels. All modes share the same ring buffer; use profile_oob_poll with the token to read callbacks (protocol field distinguishes http vs dns entries). Server priority: params.serverBase > env OOB_SERVER_BASE > public default. Only mints an identifier — whether a callback proves a blind vuln is the agent's call, NOT a vulnerability judgment.",
    parameters: {
      type: "object",
      properties: {
        serverBase: { type: "string", description: "Collector base URL (e.g. http://your-collector.example). Overrides env OOB_SERVER_BASE. If neither is set, a non-functional placeholder is used and poll will report it." },
        token: { type: "string", description: "Optional fixed token; default is a random crypto token. Sanitised to [A-Za-z0-9_-]." },
        mode: {
          type: "string",
          enum: ["http", "redirect", "dns"],
          description: "Callback mode. http (default): plain URL for SSRF/XXE/log4j. redirect: URL base ending in ?to= — append URL-encoded target, server records callback then 302s to target (SSRF chain). dns: DNS exfil domain <token>.exfil.YOUR-DOMAIN.example — embed as DNS query target, send data in label prefix.",
        },
      },
    },
    async execute(_id, params) {
      const safe = (v) => v != null ? JSON.stringify(v) : "None";
      const py = `
from attack_harness.oob import oob_alloc
import json
try:
    token, url = oob_alloc(
        server_base=${safe(params?.serverBase)},
        token=${safe(params?.token)},
        mode=${safe(params?.mode) || '"http"'},
    )
    print(json.dumps({"ok": True, "token": token, "url": url, "mode": ${safe(params?.mode) || '"http"'}}, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
`;
      return toolResult(await attackHarness(py, 15000));
    },
  });

  // ── profile_oob_poll → oob_poll ──────────────────────────────────────
  tools.set("profile_oob_poll", {
    name: "profile_oob_poll",
    description: "Read back the objective callbacks an OOB token has received from the configurable collector (GET {base}/__oob/poll). Returns interactionCount + interactions (source_ip, protocol, method, path, timestamp, user_agent, raw_headers) plus signals (http_count, dns_only_count, distinct_source_ips). A recorded callback means something fetched the planted URL; whether that proves blind SSRF/SSTI/XXE/log4j is the agent's classification — NOT a vulnerability judgment. Unreachable / timed-out collector returns a structured { error } object instead of throwing.",
    parameters: {
      type: "object",
      properties: {
        token: { type: "string", description: "The token returned by profile_oob_alloc." },
        serverBase: { type: "string", description: "Collector base URL; overrides env OOB_SERVER_BASE. Must match the base the token was alloc'd against." },
        since: { type: "string", description: "ISO timestamp; only return callbacks strictly after it (incremental polling)." },
        limit: { type: "number", description: "Max records to return (1-1000, default 100)." },
        timeoutMs: { type: "number", description: "Poll request timeout in ms (default 8000)." },
      },
      required: ["token"],
    },
    async execute(_id, params) {
      const safe = (v) => v != null ? JSON.stringify(v) : "None";
      const py = `
from attack_harness.oob import oob_poll
import json
r = oob_poll(
    token=${safe(params?.token)},
    server_base=${safe(params?.serverBase)},
    since=${safe(params?.since)},
    limit=${safe(params?.limit)},
    timeout_ms=${safe(params?.timeoutMs)},
)
print(json.dumps(r, ensure_ascii=False))
`;
      return toolResult(await attackHarness(py, 40000));
    },
  });

  // ── profile_request_replay — browser-based, keep CDP path for now ────
  // (requires profileRegistry + CDP; thin-proxy would need full request context)
  tools.set("profile_request_replay", {
    name: "profile_request_replay",
    description: "Replay a captured managed browser request with optional URL, method, headers, and body overrides.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        requestId: { type: "string", description: "Required. Request ID from profile_traffic_query to replay." },
        url: { type: "string", description: "Override the request URL." },
        method: { type: "string", description: "Override the HTTP method." },
        headers: { type: "object", description: "Headers to add or override (key: value pairs; null value removes a header)." },
        removeHeaders: { type: "array", items: { type: "string" }, description: "Header names to remove from the replayed request." },
        body: { type: "string", description: "Override the request body as a raw string." },
        json: { description: "Override body with this value serialized as JSON." },
        form: { type: "object", description: "Override body as URL-encoded form fields." },
        multipart: { type: "object", description: "Override body as multipart/form-data with fields and files." },
        credentials: { type: "string", description: "Fetch credentials mode. Default: include." },
      },
      required: ["requestId"],
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("profile_request_replay", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const request = profileRegistry.getTraffic(profile.name, params?.requestId);
      if (!request) throw new Error(`request not found: ${params?.requestId}`);

      // Build raw HTTP request from captured traffic, replay via Python raw_socket_request
      const url = params?.url || request.url;
      const method = String(params?.method || request.method || "GET").toUpperCase();
      const parsedUrl = new URL(url);
      const headers = { ...(request.requestHeaders || {}), ...(params?.headers || {}) };
      const removeHeaders = Array.isArray(params?.removeHeaders) ? params.removeHeaders : [];
      for (const h of removeHeaders) delete headers[h];

      const body = params?.body || params?.json ? JSON.stringify(params.json) : (params?.form ? new URLSearchParams(params.form).toString() : (request.postData || ""));
      const headerLines = Object.entries(headers)
        .filter(([, v]) => v != null && v !== false)
        .map(([k, v]) => `${k}: ${v}`).join("\\r\\n");
      const rawRequest = `${method} ${parsedUrl.pathname}${parsedUrl.search || ""} HTTP/1.1\\r\\nHost: ${parsedUrl.host}\\r\\n${headerLines}\\r\\n\\r\\n${body}`;

      const safe = (v) => v != null ? JSON.stringify(v) : "None";
      const py = `
from attack_harness.raw_http import raw_socket_request
import json
r = raw_socket_request(
    host=${safe(parsedUrl.hostname)},
    port=${safe(parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80))},
    tls=${safe(parsedUrl.protocol === "https:")},
    raw_request=${safe(rawRequest)},
    read_timeout_ms=15000,
)
print(json.dumps(r, ensure_ascii=False))
`;
      return toolResult({ profile: profile.name, replay: await attackHarness(py, 30000) });
    },
  });

  // ── profile_request_replay_batch — thin-proxy to Python Intruder ─────
  tools.set("profile_request_replay_batch", {
    name: "profile_request_replay_batch",
    description: "Replay one captured managed browser request through multiple variants and return response diffs for edit-and-resend security testing.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        requestId: { type: "string", description: "Required. The requestId to replay (from profile_traffic_query). Use requestId (singular), not requestIds." },
        variants: { type: "array", items: { type: "object" }, description: "Required. Variant override objects; each may override url/method/headers/body etc." },
        maxVariants: { type: "number", description: "Cap on number of variants to replay. Default: unlimited." },
        maxBodyPreview: { type: "number", description: "Max characters of body diff preview per variant." },
      },
      required: ["requestId", "variants"],
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("profile_request_replay_batch", params);
      if (routed) return toolResult(routed);
      // H-13: unpack requestIds[0]
      const normalizedParams = { ...(params || {}) };
      if (!normalizedParams.requestId && Array.isArray(normalizedParams.requestIds) && normalizedParams.requestIds.length > 0) {
        normalizedParams.requestId = normalizedParams.requestIds[0];
      }
      // Delegate to the closure-local batch replay (still browser-based for now)
      return toolResult(await executeProfileRequestReplayBatch(normalizedParams));
    },
  });

  // ── attack_intruder_create → create_job ──────────────────────────────
  tools.set("attack_intruder_create", {
    name: "attack_intruder_create",
    description: "Create an Agentic Intruder P0.1 planning job from a captured request: validate payload positions, count variants, write profile-local artifacts, and return dry-run preview variants without sending requests.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        requestId: { type: "string", description: "Request ID to use as the base request; can also be specified in spec.source.requestId." },
        spec: { type: "object", description: "Required. Intruder job specification: positions, payloads, mode, and optional source/profile fields." },
        jobId: { type: "string", description: "Custom job ID. Defaults to a generated ID." },
        maxPreview: { type: "number", description: "Max preview variants to include in the dry-run response. Default: 10." },
      },
      required: ["spec"],
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile || params?.spec?.profile);
      const requestId = params?.requestId || params?.spec?.source?.requestId;
      const request = requestId ? profileRegistry.getTraffic(profile.name, requestId) : null;
      const safe = (v) => v != null ? JSON.stringify(v) : "None";

      // Extract wordlist and positions from spec
      const spec = params?.spec || {};
      const positions = spec.positions || [];
      const payloadSets = spec.payloadSets || [];
      const wordlist = payloadSets.length > 0 ? (payloadSets[0].values || []) : [];
      const baselineRequest = request ? {
        method: request.method || "GET",
        url: request.url || "",
        headers: request.requestHeaders || {},
        body: request.postData || "",
      } : { method: "GET", url: "", headers: {}, body: "" };

      const py = `
from attack_harness.intruder import create_job
import json
r = create_job(
    name=${safe(spec.name || spec.jobId || "intruder-job")},
    baseline_request=${safe(baselineRequest)},
    payload_positions=${safe(positions)},
    wordlist=${safe(wordlist)},
    attack_mode=${safe(spec.attackMode || "sniper")},
    evidence_dir=${safe(profile.evidenceDir)},
    job_id=${safe(params?.jobId)},
    max_preview=${safe(params?.maxPreview)},
)
print(json.dumps(r, ensure_ascii=False))
`;
      return toolResult(await attackHarness(py, 15000));
    },
  });

  // ── attack_intruder_run → run_job ────────────────────────────────────
  tools.set("attack_intruder_run", {
    name: "attack_intruder_run",
    description: "Explicitly run an Agentic Intruder sniper/wordlist job by chunking planned variants and sending each chunk through profile_request_replay_batch. Default maxVariants is 200 and each replay batch is capped at 50.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name to locate the job evidence directory." },
        jobId: { type: "string", description: "Attack job ID from attack_intruder_create. Required when jobPath is omitted." },
        jobPath: { type: "string", description: "Absolute path to the job directory. Takes precedence over jobId." },
        maxVariants: { type: "number", description: "Max variants to send. Default: 200." },
        batchSize: { type: "number", description: "Replay batch chunk size. Default: 50." },
        delayMs: { type: "number", description: "Delay in ms between batches. Default: 0." },
      },
    },
    async execute(_id, params) {
      const safe = (v) => v != null ? JSON.stringify(v) : "None";
      let evidenceDir = "attack-jobs";
      try {
        if (params?.jobPath) {
          // Extract evidence dir from jobPath
          evidenceDir = params.jobPath.replace(/[\\/]attack-jobs[\\/].*$/, "") || "attack-jobs";
        } else {
          const profile = await resolveProfile(params?.profile);
          evidenceDir = profile.evidenceDir;
        }
      } catch {}

      const py = `
from attack_harness.intruder import run_job
import json
r = run_job(
    job_id=${safe(params?.jobId)},
    evidence_dir=${safe(evidenceDir)},
    max_variants=${safe(params?.maxVariants)},
    batch_size=${safe(params?.batchSize)},
    delay_ms=${safe(params?.delayMs)},
)
print(json.dumps(r, ensure_ascii=False))
`;
      return toolResult(await attackHarness(py, 120000));
    },
  });

  // ── attack_intruder_pause → pause_job ────────────────────────────────
  tools.set("attack_intruder_pause", {
    name: "attack_intruder_pause",
    description: "Mark an Agentic Intruder job paused in state.json. A running job observes the checkpoint after the current replay batch boundary.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name to locate the job evidence directory." },
        jobId: { type: "string", description: "Attack job ID from attack_intruder_create. Required when jobPath is omitted." },
        jobPath: { type: "string", description: "Absolute path to the job directory. Takes precedence over jobId." },
      },
    },
    async execute(_id, params) {
      const safe = (v) => v != null ? JSON.stringify(v) : "None";
      let evidenceDir = "attack-jobs";
      try {
        if (!params?.jobPath) {
          const profile = await resolveProfile(params?.profile);
          evidenceDir = profile.evidenceDir;
        }
      } catch {}

      const py = `
from attack_harness.intruder import pause_job
import json
r = pause_job(job_id=${safe(params?.jobId)}, evidence_dir=${safe(evidenceDir)})
print(json.dumps(r, ensure_ascii=False))
`;
      return toolResult(await attackHarness(py, 5000));
    },
  });

  // ── attack_intruder_resume → resume_job ──────────────────────────────
  tools.set("attack_intruder_resume", {
    name: "attack_intruder_resume",
    description: "Resume an Agentic Intruder job from state.cursor.nextVariantIndex by sending remaining chunks through profile_request_replay_batch.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name to locate the job evidence directory." },
        jobId: { type: "string", description: "Attack job ID from attack_intruder_create. Required when jobPath is omitted." },
        jobPath: { type: "string", description: "Absolute path to the job directory. Takes precedence over jobId." },
        maxVariants: { type: "number", description: "Max variants to send. Default: 200." },
        batchSize: { type: "number", description: "Replay batch chunk size. Default: 50." },
        delayMs: { type: "number", description: "Delay in ms between batches. Default: 0." },
      },
    },
    async execute(_id, params) {
      const safe = (v) => v != null ? JSON.stringify(v) : "None";
      let evidenceDir = "attack-jobs";
      try {
        if (!params?.jobPath) {
          const profile = await resolveProfile(params?.profile);
          evidenceDir = profile.evidenceDir;
        }
      } catch {}

      const py = `
from attack_harness.intruder import resume_job
import json
r = resume_job(
    job_id=${safe(params?.jobId)},
    evidence_dir=${safe(evidenceDir)},
    max_variants=${safe(params?.maxVariants)},
    batch_size=${safe(params?.batchSize)},
    delay_ms=${safe(params?.delayMs)},
)
print(json.dumps(r, ensure_ascii=False))
`;
      return toolResult(await attackHarness(py, 120000));
    },
  });

  // ── attack_intruder_status → status ──────────────────────────────────
  tools.set("attack_intruder_status", {
    name: "attack_intruder_status",
    description: "Read an Agentic Intruder job state from profile-local attack-job artifacts.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name to locate the job evidence directory." },
        jobId: { type: "string", description: "Attack job ID from attack_intruder_create. Required when jobPath is omitted." },
        jobPath: { type: "string", description: "Absolute path to the job directory. Takes precedence over jobId." },
      },
    },
    async execute(_id, params) {
      const safe = (v) => v != null ? JSON.stringify(v) : "None";
      let evidenceDir = "attack-jobs";
      try {
        if (!params?.jobPath) {
          const profile = await resolveProfile(params?.profile);
          evidenceDir = profile.evidenceDir;
        }
      } catch {}

      const py = `
from attack_harness.intruder import status
import json
r = status(job_id=${safe(params?.jobId)}, evidence_dir=${safe(evidenceDir)})
print(json.dumps(r, ensure_ascii=False))
`;
      return toolResult(await attackHarness(py, 5000));
    },
  });

  // ── attack_intruder_results → results ────────────────────────────────
  tools.set("attack_intruder_results", {
    name: "attack_intruder_results",
    description: "Read Agentic Intruder result rows and dry-run preview variants. P0.1 jobs return preview data and zero replay results.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name to locate the job evidence directory." },
        jobId: { type: "string", description: "Attack job ID from attack_intruder_create. Required when jobPath is omitted." },
        jobPath: { type: "string", description: "Absolute path to the job directory. Takes precedence over jobId." },
        limit: { type: "number", description: "Max result rows to return. Default: 50." },
      },
    },
    async execute(_id, params) {
      const safe = (v) => v != null ? JSON.stringify(v) : "None";
      let evidenceDir = "attack-jobs";
      try {
        if (!params?.jobPath) {
          const profile = await resolveProfile(params?.profile);
          evidenceDir = profile.evidenceDir;
        }
      } catch {}

      const py = `
from attack_harness.intruder import results
import json
r = results(
    job_id=${safe(params?.jobId)},
    evidence_dir=${safe(evidenceDir)},
    limit=${safe(params?.limit)},
)
print(json.dumps(r, ensure_ascii=False))
`;
      return toolResult(await attackHarness(py, 10000));
    },
  });

  // ── attack_intruder_evidence — built from status + results ───────────
  tools.set("attack_intruder_evidence", {
    name: "attack_intruder_evidence",
    description: "Write and return an Agentic Intruder P0.1 evidence bundle with spec/state/preview artifact hashes. This is planning evidence only until replay execution lands.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name to locate the job evidence directory." },
        jobId: { type: "string", description: "Attack job ID from attack_intruder_create. Required when jobPath is omitted." },
        jobPath: { type: "string", description: "Absolute path to the job directory. Takes precedence over jobId." },
      },
    },
    async execute(_id, params) {
      const safe = (v) => v != null ? JSON.stringify(v) : "None";
      let evidenceDir = "attack-jobs";
      try {
        if (!params?.jobPath) {
          const profile = await resolveProfile(params?.profile);
          evidenceDir = profile.evidenceDir;
        }
      } catch {}

      const py = `
from attack_harness.intruder import status, results as intruder_results
import json, os, hashlib
s = status(job_id=${safe(params?.jobId)}, evidence_dir=${safe(evidenceDir)})
r = intruder_results(job_id=${safe(params?.jobId)}, evidence_dir=${safe(evidenceDir)})
# Build evidence bundle
def file_summary(path):
    if not os.path.exists(path): return {"path": path, "exists": False}
    st = os.stat(path)
    sha = hashlib.sha256(open(path,"rb").read()).hexdigest() if os.path.isfile(path) else None
    return {"path": path, "exists": True, "bytes": st.st_size, "sha256": sha}
paths = (s.get("state", {}).get("paths", {}) if s.get("ok") else {})
artifacts = {k: file_summary(v) for k, v in paths.items()}
evidence = {
    "schema": "agent-browser.attack.intruder.evidence.v1",
    "ok": True,
    "job_id": ${safe(params?.jobId)},
    "state": s.get("state", {}),
    "summary": s.get("summary", {}),
    "preview": s.get("preview"),
    "results": r,
    "artifacts": artifacts,
}
print(json.dumps(evidence, ensure_ascii=False))
`;
      return toolResult(await attackHarness(py, 10000));
    },
  });
}
