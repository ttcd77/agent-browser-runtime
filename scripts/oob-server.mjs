cat: /tmp/.passthrough: No such file or directory
// BOUNDARY: Out-of-band (OOB) catch-all callback server. It records OBJECTIVE
// interactions only — who called back, when, over what protocol, with what raw
// request — and serves them back through a poll API. It does NOT decide whether a
// blind vulnerability exists. A callback to /<token>/... means "something fetched
// the URL the agent planted"; whether that proves blind SSRF / SSTI / XXE / log4j
// / data exfil is the agent's classification job, NOT this server's.
//
// Wave-10 additions:
//   • HTTP redirect chain: /<token>/redir?to=<URL> — records callback then 302s
//   • DNS exfil listener: UDP + TCP port 53, handles <payload>.<token>.exfil.zone
//
// Self-contained node program. Run standalone:
//   OOB_LISTEN_PORT=8080 node scripts/oob-server.mjs
//   OOB_DNS_PORT=0 node scripts/oob-server.mjs   # HTTP only, no DNS
//
// The public hostname/base it lives behind is whatever you deploy it under; the
// agent side (lib/oob-client.mjs) addresses it via OOB_SERVER_BASE and never
// hardcodes a real address. This program just listens on a port.
import http from "node:http";
import dgram from "node:dgram";
import net from "node:net";
import { randomUUID } from "node:crypto";

// dns-packet is a runtime dep (package.json dependencies). It is ~2 KB + pure JS.
// We lazy-import it only when the DNS listener is actually started so that
// unit tests that set OOB_DNS_PORT=0 don't fail if the package is absent.
let dnsPacket;
async function loadDnsPacket() {
  if (!dnsPacket) {
    dnsPacket = (await import("dns-packet")).default ?? (await import("dns-packet"));
  }
  return dnsPacket;
}
function getDnsPacket() {
  if (!dnsPacket) throw new Error("dns-packet not yet loaded — call loadDnsPacket() first");
  return dnsPacket;
}

const PORT = Number(process.env.OOB_LISTEN_PORT) || 8090;
const DNS_PORT = process.env.OOB_DNS_PORT !== undefined
  ? Number(process.env.OOB_DNS_PORT)
  : 53;
// Zone suffix that appears after the token label in an exfil query name.
// e.g. "deadbeef.abc.exfil.YOUR-DOMAIN.example" → payload="deadbeef", token="abc"
const DNS_ZONE = (process.env.OOB_DNS_ZONE || "exfil.YOUR-DOMAIN.example").toLowerCase().replace(/\.$/, "");
const BUFFER_MAX = Math.max(1, Number(process.env.OOB_BUFFER_MAX) || 1000);
const BODY_LIMIT = 4096; // bytes of request body retained per interaction
const startedAt = Date.now();

// In-memory ring buffer — shared by HTTP + DNS entries.
const ring = [];
function pushInteraction(entry) {
  ring.push(entry);
  if (ring.length > BUFFER_MAX) ring.splice(0, ring.length - BUFFER_MAX);
}

// The callback token is the first path segment: /abc123/whatever -> "abc123".
function extractToken(pathname) {
  const seg = String(pathname || "/").split("/").filter(Boolean);
  return seg.length ? seg[0] : "";
}

// Prefer leftmost X-Forwarded-For hop (original client as seen by first proxy).
function sourceIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket?.remoteAddress || null;
}

function readBody(req, cap) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let truncated = false;
    req.on("data", (chunk) => {
      if (buf.length >= cap) { truncated = true; return; }
      const room = cap - buf.length;
      buf = Buffer.concat([buf, chunk.length <= room ? chunk : chunk.subarray(0, room)]);
      if (chunk.length > room) truncated = true;
    });
    req.on("end", () => resolve({ body: buf.toString("utf8"), truncated }));
    req.on("error", () => resolve({ body: buf.toString("utf8"), truncated }));
  });
}

// Minimal 1x1 transparent GIF so a target that expects an image doesn't error out.
const PIXEL_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

function sendPixel(res) {
  res.writeHead(200, { "content-type": "image/gif", "content-length": PIXEL_GIF.length, "cache-control": "no-store" });
  res.end(PIXEL_GIF);
}

function sendJson(res, status, obj) {
  const text = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  res.end(text);
}

// --- management API (prefix /__oob/, never recorded as a callback) ---
function handleAdmin(req, url, res) {
  if (url.pathname === "/__oob/health") {
    const dnsRunning = (udpServer && udpServer.listening) || (tcpDnsServer && tcpDnsServer.listening);
    return sendJson(res, 200, {
      ok: true,
      bufferSize: ring.length,
      uptimeMs: Date.now() - startedAt,
      dns: { port: DNS_PORT, zone: DNS_ZONE, running: !!dnsRunning },
    });
  }
  if (url.pathname === "/__oob/poll") {
    const token = url.searchParams.get("token");
    if (!token) return sendJson(res, 400, { error: "token query param is required" });
    const sinceRaw = url.searchParams.get("since");
    const sinceMs = sinceRaw ? Date.parse(sinceRaw) : NaN;
    const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit")) || 100));
    let rows = ring.filter((e) => e.token === token);
    if (!Number.isNaN(sinceMs)) rows = rows.filter((e) => Date.parse(e.timestamp) > sinceMs);
    if (rows.length > limit) rows = rows.slice(rows.length - limit);
    return sendJson(res, 200, { schema: "agent-browser-runtime.oob-server-poll.v1", token, count: rows.length, interactions: rows });
  }
  return sendJson(res, 404, { error: "unknown /__oob/ route", pathname: url.pathname });
}

// --- HTTP redirect chain handler ---
// Route: /<token>/redir?to=<URL-encoded-target>
// Records the callback then 302s to the decoded target URL.
async function handleRedir(req, url, res) {
  const toParam = url.searchParams.get("to");
  const token = extractToken(url.pathname); // first segment

  // Record even if to= is missing (still proves the callback happened)
  const redirectedTo = toParam ? decodeURIComponent(toParam) : null;

  const { body, truncated } = await readBody(req, BODY_LIMIT);
  const entry = {
    id: randomUUID(),
    token,
    source_ip: sourceIp(req),
    method: req.method,
    path: url.pathname + (url.search || ""),
    host_header: req.headers.host || null,
    user_agent: req.headers["user-agent"] || null,
    headers: { ...req.headers },
    body,
    body_truncated: truncated,
    protocol: "http",
    redirected_to: redirectedTo,
    timestamp: new Date().toISOString(),
  };
  pushInteraction(entry);

  if (!redirectedTo) {
    // Degenerate case: no target, return pixel
    return sendPixel(res);
  }

  // 302 redirect with 1x1 GIF body for SSRF chain compatibility
  res.writeHead(302, {
    "location": redirectedTo,
    "content-type": "image/gif",
    "content-length": PIXEL_GIF.length,
    "cache-control": "no-store",
  });
  res.end(PIXEL_GIF);
}

const httpServer = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://oob.local");
  } catch {
    res.writeHead(400); res.end(); return;
  }

  if (url.pathname.startsWith("/__oob/")) {
    return handleAdmin(req, url, res);
  }

  // /<token>/redir path — redirect chain
  const pathParts = url.pathname.split("/").filter(Boolean);
  if (pathParts.length >= 2 && pathParts[1] === "redir") {
    return handleRedir(req, url, res);
  }

  // Everything else: record as plain HTTP callback, return pixel
  const { body, truncated } = await readBody(req, BODY_LIMIT);
  const entry = {
    id: randomUUID(),
    token: extractToken(url.pathname),
    source_ip: sourceIp(req),
    method: req.method,
    path: url.pathname + (url.search || ""),
    host_header: req.headers.host || null,
    user_agent: req.headers["user-agent"] || null,
    headers: { ...req.headers },
    body,
    body_truncated: truncated,
    protocol: "http",
    timestamp: new Date().toISOString(),
  };
  pushInteraction(entry);
  sendPixel(res);
});

httpServer.on("clientError", (_err, socket) => {
  try { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch {}
});

// Backwards-compat alias
const server = httpServer;

// =============================================================================
// DNS listener — UDP + TCP
// =============================================================================

// Extract exfil fields from a query name.
// Expected format: <payload>.<token>.<DNS_ZONE>
// Returns { token, exfilPayload } or null if the zone doesn't match.
function parseExfilQuery(rawName) {
  const name = String(rawName).toLowerCase().replace(/\.$/, "");
  const zoneSuffix = "." + DNS_ZONE;
  if (!name.endsWith(DNS_ZONE)) return { token: "", exfilPayload: null };
  const withoutZone = name.endsWith(zoneSuffix)
    ? name.slice(0, name.length - zoneSuffix.length)
    : name.slice(0, name.length - DNS_ZONE.length);
  const labels = withoutZone.split(".").filter(Boolean);
  // labels[last] = token, labels[0..last-1] = payload labels joined
  if (labels.length === 0) return { token: "", exfilPayload: null };
  const token = labels[labels.length - 1];
  const exfilPayload = labels.slice(0, labels.length - 1).join(".") || null;
  return { token, exfilPayload };
}

// Build a minimal valid DNS response buffer.
function buildDnsResponse(requestBuf, qname, qtype, rcode) {
  const dp = getDnsPacket();

  // Decide answer section based on query type and rcode
  const answers = [];
  if (rcode === "NOERROR") {
    if (qtype === "A") {
      answers.push({ type: "A", class: "IN", name: qname, ttl: 60, data: "127.0.0.1" });
    } else if (qtype === "TXT") {
      answers.push({ type: "TXT", class: "IN", name: qname, ttl: 60, data: ["oob-collector"] });
    }
    // AAAA → NOERROR NODATA (empty answer), others → NXDOMAIN below
  }

  // Parse the request to echo ID + questions
  let reqParsed;
  try { reqParsed = dp.decode(requestBuf); } catch { return null; }

  const response = dp.encode({
    type: "response",
    id: reqParsed.id,
    flags: dp.RECURSION_DESIRED | dp.AUTHORITATIVE_ANSWER,
    rcode: rcode || "NOERROR",
    questions: reqParsed.questions || [],
    answers,
  });
  return response;
}

// Handle a single decoded DNS query buffer. Records the interaction and returns
// the response buffer (or null if the request is malformed / too large).
function handleDnsQuery(msgBuf, rinfo) {
  const dp = getDnsPacket();
  const MAX_NAME_OCTETS = 255;
  const MAX_LABEL_OCTETS = 63;

  let parsed;
  try { parsed = dp.decode(msgBuf); } catch {
    // Malformed — return FORMERR (we can't build a proper response without the ID;
    // craft a minimal one manually if we can recover the ID from raw bytes)
    return null;
  }

  if (!parsed.questions || parsed.questions.length === 0) return null;
  const q = parsed.questions[0];
  const qname = (q.name || "").toLowerCase();
  const qtype = q.type || "A";

  // Validate name length
  if (Buffer.byteLength(qname) > MAX_NAME_OCTETS) {
    return buildDnsResponse(msgBuf, qname, qtype, "FORMERR");
  }
  for (const label of qname.split(".")) {
    if (Buffer.byteLength(label) > MAX_LABEL_OCTETS) {
      return buildDnsResponse(msgBuf, qname, qtype, "FORMERR");
    }
  }

  // Parse exfil fields from the name
  const { token, exfilPayload } = parseExfilQuery(qname);

  // Record the interaction
  const entry = {
    id: randomUUID(),
    token,
    source_ip: rinfo ? rinfo.address : null,
    source_port: rinfo ? rinfo.port : null,
    protocol: "dns",
    query_name: qname,
    query_type: qtype,
    exfil_payload: exfilPayload,
    timestamp: new Date().toISOString(),
  };
  pushInteraction(entry);

  // Determine response type
  let rcode = "NOERROR";
  if (!qname.endsWith(DNS_ZONE)) {
    // Not our zone — NXDOMAIN
    rcode = "NXDOMAIN";
  } else if (!["A", "AAAA", "TXT"].includes(qtype)) {
    rcode = "NXDOMAIN";
  }

  return buildDnsResponse(msgBuf, qname, qtype, rcode);
}

let udpServer = null;
let tcpDnsServer = null;

async function startDns(port) {
  await loadDnsPacket();

  // UDP DNS socket
  udpServer = dgram.createSocket("udp4");
  udpServer.on("message", (msgBuf, rinfo) => {
    let responseBuf;
    try { responseBuf = handleDnsQuery(msgBuf, rinfo); } catch (_e) { return; }
    if (!responseBuf) return;
    udpServer.send(responseBuf, rinfo.port, rinfo.address, (_err) => {});
  });
  udpServer.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error(`oob-server: DNS UDP error: ${err.message}`);
  });
  udpServer.bind(port, "0.0.0.0");

  // TCP DNS socket (RFC 1035: 2-byte length prefix)
  tcpDnsServer = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      // Process complete messages (may receive multiple)
      while (buf.length >= 2) {
        const msgLen = buf.readUInt16BE(0);
        if (buf.length < 2 + msgLen) break; // wait for more data
        const msgBuf = buf.subarray(2, 2 + msgLen);
        buf = buf.subarray(2 + msgLen);
        let responseBuf;
        try { responseBuf = handleDnsQuery(msgBuf, { address: sock.remoteAddress, port: sock.remotePort }); } catch { break; }
        if (!responseBuf) break;
        const lenPrefix = Buffer.alloc(2);
        lenPrefix.writeUInt16BE(responseBuf.length);
        try { sock.write(Buffer.concat([lenPrefix, responseBuf])); } catch {}
      }
    });
    sock.on("error", () => {});
    sock.setTimeout(15000, () => { try { sock.destroy(); } catch {} });
  });
  tcpDnsServer.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error(`oob-server: DNS TCP error: ${err.message}`);
  });
  tcpDnsServer.listen(port, "0.0.0.0");

  // eslint-disable-next-line no-console
  console.log(`oob-server: DNS listeners on :${port}/udp+tcp (zone=${DNS_ZONE})`);
}

// =============================================================================
// Start
// =============================================================================

function start(port = PORT) {
  return new Promise((resolve) => {
    httpServer.listen(port, () => {
      const addr = httpServer.address();
      // eslint-disable-next-line no-console
      console.log(`oob-server: HTTP listening on :${addr.port} (bufferMax=${BUFFER_MAX})`);
      if (DNS_PORT > 0) {
        startDns(DNS_PORT).catch((err) => {
          // eslint-disable-next-line no-console
          console.error(`oob-server: failed to start DNS listeners: ${err.message}`);
        });
      } else {
        // eslint-disable-next-line no-console
        console.log("oob-server: DNS disabled (OOB_DNS_PORT=0)");
      }
      resolve(httpServer);
    });
  });
}

export { server, httpServer, start, PORT, DNS_PORT, DNS_ZONE, pushInteraction, ring, parseExfilQuery, handleDnsQuery };

// crude "is this the entry module" check that works for `node scripts/oob-server.mjs`
const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("oob-server.mjs");
if (invokedDirectly) {
  start();
}
