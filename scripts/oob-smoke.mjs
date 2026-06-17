// Smoke test for the OOB callback primitive (lib/oob-client.mjs) + catch-all
// server (oob-server.mjs). Starts a real server on a random port, mints a callback
// URL, fires an HTTP callback at it, then polls it back — so we get regression
// coverage for the full alloc -> callback -> poll loop without touching Chrome or
// the worker, and we prove the collector address is NOT hardcoded.
import http from "node:http";
import { start as startOobServer } from "./oob-server.mjs";
import { oobAlloc, oobPoll } from "./lib/oob-client.mjs";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  ok    ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
    failures++;
  }
}

// Tiny GET-with-UA helper so we can simulate a target calling back our URL.
function httpGet(urlStr, userAgent) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { "user-agent": userAgent } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, bytes: Buffer.concat(chunks).length, contentType: res.headers["content-type"] }));
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

// --- bring up the collector on a random free port ---
const PICKED_PORT = 0; // 0 => OS assigns a free port
process.env.OOB_LISTEN_PORT = String(PICKED_PORT);
const server = await startOobServer(PICKED_PORT);
const listenPort = server.address().port;
const base = `http://127.0.0.1:${listenPort}`;
console.log(`oob smoke: collector on ${base}`);

// 1. alloc with explicit serverBase param: url carries the token, base is honoured
const a = oobAlloc({ serverBase: base });
check("alloc schema is oob-alloc.v1", a.schema === "agent-browser-runtime.oob-alloc.v1", a.schema);
check("alloc url contains token", a.url.includes(a.token), `url=${a.url} token=${a.token}`);
check("alloc url uses the param serverBase", a.url.startsWith(base + "/"), a.url);
check("alloc serverBase echoes param", a.serverBase === base, a.serverBase);
check("alloc boundary present (NOT a verdict)", typeof a.boundary === "string" && /NOT a vulnerability judgment/.test(a.boundary));

// 2. serverBase can be overridden via env OOB_SERVER_BASE
const ENV_BASE = "http://env-collector.example";
const prevEnv = process.env.OOB_SERVER_BASE;
process.env.OOB_SERVER_BASE = ENV_BASE;
const aEnv = oobAlloc({});
check("alloc reads OOB_SERVER_BASE from env", aEnv.serverBase === ENV_BASE, aEnv.serverBase);

// 3. with NO env and NO param, base defaults to the placeholder (proves no hardcoded real address)
delete process.env.OOB_SERVER_BASE;
const aDefault = oobAlloc({});
check("alloc default base is the placeholder YOUR-OOB-SERVER.example", aDefault.serverBase === "http://YOUR-OOB-SERVER.example", aDefault.serverBase);
check("alloc default url uses placeholder", aDefault.url.startsWith("http://YOUR-OOB-SERVER.example/"), aDefault.url);
// restore env for the rest of the run
if (prevEnv === undefined) delete process.env.OOB_SERVER_BASE; else process.env.OOB_SERVER_BASE = prevEnv;

// 4. health endpoint of the live collector
const healthRes = await httpGet(`${base}/__oob/health`, "smoke");
check("health endpoint returns 200", healthRes.status === 200, `status=${healthRes.status}`);

// 5. simulate a target callback to the alloc'd URL with a custom User-Agent
const UA = "smoke-oob-callback/1.0";
const cb = await httpGet(`${a.url}/probe?x=1`, UA);
check("callback got a benign 200", cb.status === 200, `status=${cb.status}`);
check("callback response is the 1x1 gif", String(cb.contentType || "").includes("image/gif"), cb.contentType);

// 6. poll the token back: exactly one interaction with the expected objective fields
const poll = await oobPoll({ serverBase: base, token: a.token });
check("poll schema is oob-poll.v1", poll.schema === "agent-browser-runtime.oob-poll.v1", poll.schema);
check("poll has no error", !poll.error, poll.error || "");
check("poll interactionCount=1", poll.interactionCount === 1, `count=${poll.interactionCount}`);
const it = (poll.interactions || [])[0] || {};
check("poll interaction source_ip present", typeof it.source_ip === "string" && it.source_ip.length > 0, JSON.stringify(it.source_ip));
check("poll interaction path contains token", typeof it.path === "string" && it.path.includes(a.token), it.path);
check("poll interaction protocol=http", it.protocol === "http", it.protocol);
check("poll interaction method=GET", it.method === "GET", it.method);
check("poll interaction user_agent matches the callback UA", it.user_agent === UA, it.user_agent);
check("poll interaction has raw_headers object", it.raw_headers && typeof it.raw_headers === "object" && typeof it.raw_headers.host === "string");
check("poll signals.http_count=1", poll.signals && poll.signals.http_count === 1, JSON.stringify(poll.signals));
check("poll signals.dns_only_count=0 (HTTP-only collector)", poll.signals && poll.signals.dns_only_count === 0, JSON.stringify(poll.signals));
check("poll signals.distinct_source_ips=1", poll.signals && poll.signals.distinct_source_ips === 1, JSON.stringify(poll.signals));
check("poll boundary present (NOT a verdict)", typeof poll.boundary === "string" && /NOT a vulnerability judgment/.test(poll.boundary));

// 7. since-filter: polling with a future timestamp returns nothing
const future = new Date(Date.now() + 60000).toISOString();
const pollSince = await oobPoll({ serverBase: base, token: a.token, since: future });
check("poll with future since returns 0 interactions", pollSince.interactionCount === 0, `count=${pollSince.interactionCount}`);

// 8. unknown token returns 0 interactions, no error (noise is ignored)
const pollUnknown = await oobPoll({ serverBase: base, token: "no-such-token-xyz" });
check("poll unknown token => 0 interactions, no error", pollUnknown.interactionCount === 0 && !pollUnknown.error, pollUnknown.error || `count=${pollUnknown.interactionCount}`);

// 9. unreachable collector returns a structured error, does NOT throw/crash
let crashed = false;
let pollDead;
try {
  // 127.0.0.1:1 is a reserved/unbindable port — connection refused fast.
  pollDead = await oobPoll({ serverBase: "http://127.0.0.1:1", token: a.token, timeoutMs: 1500 });
} catch {
  crashed = true;
}
check("poll on unreachable collector does not throw", !crashed);
check("poll on unreachable collector returns an error field", pollDead && typeof pollDead.error === "string" && pollDead.error.length > 0, pollDead ? JSON.stringify(pollDead.error) : "no result");
check("poll on unreachable collector still returns oob-poll.v1 schema", pollDead && pollDead.schema === "agent-browser-runtime.oob-poll.v1", pollDead && pollDead.schema);

// 10. polling the placeholder base (unset env) reports it instead of trying to connect
const pollPlaceholder = await oobPoll({ serverBase: "http://YOUR-OOB-SERVER.example", token: a.token, timeoutMs: 1500 });
check("poll against placeholder base reports it as unset", pollPlaceholder && typeof pollPlaceholder.error === "string" && /placeholder/i.test(pollPlaceholder.error), pollPlaceholder ? pollPlaceholder.error : "no result");

server.close();
console.log(failures === 0 ? "oob smoke: PASS" : `oob smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
