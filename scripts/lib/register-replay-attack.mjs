// register-replay-attack.mjs — Raw/race/JWT/OOB request + replay + Agentic Intruder tool family.
// Extracted verbatim from agent-cdp-server.mjs registerStandaloneBrowserTools (behavior-preserving).
// Dependencies are injected via deps; pure/lib helpers are imported directly.
// NOTE: the closure-local helper executeProfileRequestReplayBatch stays in the worker and is injected.
import { toolResult } from "./result-format.mjs";
import { rawSocketRequest, rawRaceRequest } from "./raw-request.mjs";
import { forgeJwt } from "./jwt-forge.mjs";
import { oobAlloc, oobPoll } from "./oob-client.mjs";
import { prepareReplayHeaders, buildReplayBody, buildReplayBoundaryEvidence, diffReplayResponse } from "./replay-http.mjs";
import {
  buildAttackIntruderEvidence,
  buildAttackIntruderResults,
  createAttackIntruderJob,
  pauseAttackIntruderJob,
  readAttackIntruderJob,
  resumeAttackIntruderJob,
  runAttackIntruderJob,
} from "./attack-intruder.mjs";

export function registerReplayAttackTools(deps) {
  const {
    tools,
    profileRegistry,
    resolveProfile,
    withManagedPageClient,
    executeProfileRequestReplayBatch,
    maybeRoutePersonal,
  } = deps;

  tools.set("profile_raw_request", {
    name: "profile_raw_request",
    description: "Send a byte-exact HTTP request over a raw node socket (net/tls), bypassing Chrome's network stack. Unlike request_replay (which runs fetch() in the page and is normalised by Chrome), this sends malformed framing verbatim — dual Content-Length, CL.TE/TE.CL desync, pipelined requests — for HTTP request smuggling and protocol-level testing. Returns raw response bytes plus objective signals (httpResponseCount, timing, closeReason); it does NOT judge whether desync occurred (the agent classifies).",
    parameters: {
      type: "object",
      properties: {
        host: { type: "string", description: "Required. Target hostname or IP." },
        port: { type: "number", description: "TCP port. Default: 443 when tls=true, 80 otherwise." },
        tls: { type: "boolean", description: "Use TLS. Default: false." },
        servername: { type: "string", description: "SNI hostname for TLS. Defaults to host." },
        rawRequest: { type: "string", description: "Exact request bytes; put CRLF (\\r\\n) and any malformed framing here verbatim." },
        rawRequestBase64: { type: "string", description: "Base64 request bytes for non-UTF8/binary framing; takes precedence over rawRequest." },
        readTimeoutMs: { type: "number", description: "Socket read timeout in ms. Default: 8000, clamped to 60000." },
        maxResponseBytes: { type: "number", description: "Max response bytes to read before closing. Default: 524288 (512 KB), clamped to 67108864 (64 MB)." },
      },
      required: ["host"],
    },
    async execute(_id, params) {
      return toolResult(await rawSocketRequest(params));
    },
  });

  tools.set("profile_race_request", {
    name: "profile_race_request",
    description: "Fire N (>=2) byte-exact HTTP requests concurrently over independent raw node sockets to drive a TOCTOU / race-condition test (coupon reuse, double-spend, invite/quota bypass, purchase-limit bypass). last-byte sync (default) holds back each request's final byte until ALL sockets have their head flushed, then releases all final bytes in one tight loop (Turbo Intruder gate technique) so the requests contend in a single tight window; parallel mode just Promise.all's the full requests as a fallback. Returns objective signals only — per-request status/headers/bytes, first-byte timing relative to a shared t0, status distribution, and first-byte spread (smaller = tighter race window). It does NOT judge whether the race won; the agent classifies from the status distribution and timing.",
    parameters: {
      type: "object",
      properties: {
        host: { type: "string", description: "Required. Target hostname or IP." },
        port: { type: "number", description: "TCP port. Default: 443 when tls=true, 80 otherwise." },
        tls: { type: "boolean", description: "Use TLS. Default: false." },
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
      return toolResult(await rawRaceRequest(params));
    },
  });

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
      return toolResult(forgeJwt(params));
    },
  });

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
      return toolResult(await oobAlloc(params || {}));
    },
  });

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
      return toolResult(await oobPoll(params || {}));
    },
  });

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
      const url = params?.url || request.url;
      const method = String(params?.method || request.method || "GET").toUpperCase();
      const removeHeaders = Array.isArray(params?.removeHeaders) ? Object.fromEntries(params.removeHeaders.map((name) => [name, null])) : {};
      const headerPrep = prepareReplayHeaders(request.requestHeaders || {}, { ...removeHeaders, ...(params?.headers || {}) });
      const bodyPrep = buildReplayBody(params || {}, request, headerPrep.headers);
      const includeBody = !["GET", "HEAD"].includes(method) && bodyPrep.bodyKind !== "none";
      return toolResult(await withManagedPageClient(profile, profile.tabId, async (client, target) => {
        const result = await client.Runtime.evaluate({
          expression: `(async () => {
            const replay = ${JSON.stringify({
              url,
              method,
              headers: headerPrep.headers,
              body: bodyPrep.body,
              bodyKind: bodyPrep.bodyKind,
              includeBody,
              credentials: params?.credentials || "include",
            })};
            function buildBody(replay) {
              if (!replay.includeBody) return undefined;
              if (replay.bodyKind === "multipart") {
                const form = new FormData();
                for (const [key, value] of Object.entries(replay.body.fields || {})) {
                  if (Array.isArray(value)) {
                    for (const item of value) form.append(key, String(item));
                  } else {
                    form.append(key, String(value));
                  }
                }
                for (const file of replay.body.files || []) {
                  const blob = new Blob([file.content || ""], { type: file.type || "application/octet-stream" });
                  form.append(file.field || "file", blob, file.filename || "upload.bin");
                }
                return form;
              }
              return replay.body;
            }
            const startedAt = new Date().toISOString();
            const response = await fetch(replay.url, {
              method: replay.method,
              headers: replay.headers,
              credentials: replay.credentials,
              cache: "no-store",
              redirect: "follow",
              ...(replay.includeBody ? { body: buildBody(replay) } : {}),
            });
            const text = await response.text();
            return {
              ok: response.ok,
              startedAt,
              finishedAt: new Date().toISOString(),
              url: response.url,
              redirected: response.redirected,
              status: response.status,
              statusText: response.statusText,
              headers: Object.fromEntries(response.headers.entries()),
              bodyText: text,
              bodyBytes: text.length,
            };
          })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        const replayRequest = {
          url,
          method,
          headers: headerPrep.headers,
          bodyKind: bodyPrep.bodyKind,
          skippedHeaders: headerPrep.skipped,
          removedHeaders: headerPrep.removed,
          skippedHeaderNames: headerPrep.skipped.map((entry) => entry.name),
          bodyLength: includeBody ? bodyPrep.bodyLength : 0,
          contentTypeNote: bodyPrep.contentTypeNote || null,
          credentials: params?.credentials || "include",
        };
        return {
          profile: profile.name,
          tabId: target.id,
          originalRequest: request,
          replayRequest,
          replayBoundary: buildReplayBoundaryEvidence({ originalRequest: request, replayRequest, headerPrep, bodyPrep, includeBody }),
          response: result.result?.value,
          responseDiff: result.result?.value ? diffReplayResponse(request, result.result.value, params?.maxBodyPreview) : null,
          exception: result.exceptionDetails,
        };
      }));
    },
  });

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
      // H-13: unpack requestIds[0] if caller incorrectly used the plural form.
      const normalizedParams = { ...(params || {}) };
      if (!normalizedParams.requestId && Array.isArray(normalizedParams.requestIds) && normalizedParams.requestIds.length > 0) {
        normalizedParams.requestId = normalizedParams.requestIds[0];
      }
      return toolResult(await executeProfileRequestReplayBatch(normalizedParams));
    },
  });

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
      return toolResult(createAttackIntruderJob({
        evidenceDir: profile.evidenceDir,
        profile: profile.name,
        request,
        requestId,
        spec: params?.spec || {},
        jobId: params?.jobId,
        maxPreview: typeof params?.maxPreview === "number" ? Math.min(Math.max(1, params.maxPreview), 1_000) : 10,
      }));
    },
  });

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
      const input = {
        jobPath: params?.jobPath,
        jobId: params?.jobId,
        maxVariants: typeof params?.maxVariants === "number" ? Math.min(Math.max(1, params.maxVariants), 50_000) : 200,
        batchSize: typeof params?.batchSize === "number" ? Math.min(Math.max(1, params.batchSize), 500) : undefined,
        delayMs: typeof params?.delayMs === "number" ? Math.min(Math.max(0, params.delayMs), 60_000) : 0,
        replayBatch: executeProfileRequestReplayBatch,
      };
      if (params?.jobPath) return toolResult(await runAttackIntruderJob(input));
      const profile = await resolveProfile(params?.profile);
      return toolResult(await runAttackIntruderJob({ ...input, evidenceDir: profile.evidenceDir }));
    },
  });

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
      if (params?.jobPath) return toolResult(pauseAttackIntruderJob({ jobPath: params.jobPath }));
      const profile = await resolveProfile(params?.profile);
      return toolResult(pauseAttackIntruderJob({ evidenceDir: profile.evidenceDir, jobId: params?.jobId }));
    },
  });

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
      // Align error format with attack_intruder_pause/results/evidence (jobId is required).
      if (!params?.jobPath && !params?.jobId) {
        return toolResult({ ok: false, error: "Error: jobId is required when jobPath is not provided" });
      }
      const input = {
        jobPath: params?.jobPath,
        jobId: params?.jobId,
        maxVariants: typeof params?.maxVariants === "number" ? Math.min(Math.max(1, params.maxVariants), 50_000) : 200,
        batchSize: typeof params?.batchSize === "number" ? Math.min(Math.max(1, params.batchSize), 500) : undefined,
        delayMs: typeof params?.delayMs === "number" ? Math.min(Math.max(0, params.delayMs), 60_000) : 0,
        replayBatch: executeProfileRequestReplayBatch,
      };
      if (params?.jobPath) return toolResult(await resumeAttackIntruderJob(input));
      const profile = await resolveProfile(params?.profile);
      return toolResult(await resumeAttackIntruderJob({ ...input, evidenceDir: profile.evidenceDir }));
    },
  });

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
      if (params?.jobPath) return toolResult(readAttackIntruderJob({ jobPath: params.jobPath }));
      const profile = await resolveProfile(params?.profile);
      return toolResult(readAttackIntruderJob({ evidenceDir: profile.evidenceDir, jobId: params?.jobId }));
    },
  });

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
      const input = { jobPath: params?.jobPath, jobId: params?.jobId, limit: typeof params?.limit === "number" ? Math.min(Math.max(1, params.limit), 10_000) : 50 };
      if (params?.jobPath) return toolResult(buildAttackIntruderResults(input));
      const profile = await resolveProfile(params?.profile);
      return toolResult(buildAttackIntruderResults({ ...input, evidenceDir: profile.evidenceDir }));
    },
  });

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
      if (params?.jobPath) return toolResult(buildAttackIntruderEvidence({ jobPath: params.jobPath }));
      const profile = await resolveProfile(params?.profile);
      return toolResult(buildAttackIntruderEvidence({ evidenceDir: profile.evidenceDir, jobId: params?.jobId }));
    },
  });
}
