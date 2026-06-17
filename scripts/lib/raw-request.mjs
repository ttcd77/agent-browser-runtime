// Raw byte-exact HTTP send over node sockets (net/tls), bypassing Chrome.
//
// WHY: profile_request_replay runs fetch() inside the Chrome page via CDP
// Runtime.evaluate, so Chrome's network stack normalises framing — you cannot
// emit dual Content-Length, CL.TE/TE.CL desync, or pipelined requests. This
// module sends the exact bytes the agent gives, over a plain node socket, so
// HTTP request smuggling and protocol-level framing tests become possible.
//
// BOUNDARY: it returns objective signals only (status line, header set,
// httpResponseCount, timing, close reason, raw bytes). It does NOT decide
// whether a desync/smuggle happened — that classification is the agent's job.
import net from "node:net";
import tls from "node:tls";

// Count HTTP/1.x status lines in the response stream. >1 is an objective hint
// that the connection returned more than one response (pipelining / smuggling
// desync), NOT a vulnerability verdict.
export function countHttpResponses(text) {
  const m = text.match(/(?:^|\r\n|\n)HTTP\/1\.[01] \d{3}/g);
  return m ? m.length : 0;
}

export function parseResponseHead(text) {
  const end = text.indexOf("\r\n\r\n");
  const head = end >= 0 ? text.slice(0, end) : text;
  const lines = head.split(/\r\n/);
  const headers = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(":");
    if (i > 0) {
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      // join duplicate header names so dual Content-Length stays visible
      headers[k] = headers[k] ? `${headers[k]}, ${v}` : v;
    }
  }
  return { statusLine: lines[0] || "", headers };
}

export async function rawSocketRequest(params = {}) {
  const host = String(params?.host || "").trim();
  if (!host) throw new Error("host is required");
  const useTls = params?.tls != null ? Boolean(params.tls) : (params?.port == null || Number(params.port) === 443);
  const port = Number(params?.port) || (useTls ? 443 : 80);
  const requestBuf = params?.rawRequestBase64
    ? Buffer.from(String(params.rawRequestBase64), "base64")
    : Buffer.from(String(params?.rawRequest ?? ""), "utf8");
  if (!requestBuf.length) throw new Error("rawRequest (or rawRequestBase64) is required");
  const maxBytes = Math.min(64 * 1024 * 1024, Math.max(1024, Number(params?.maxResponseBytes) || 524288));
  const timeoutMs = Math.min(60_000, Math.max(500, Number(params?.readTimeoutMs) || 10000));

  return await new Promise((resolveP, rejectP) => {
    const chunks = [];
    let total = 0, settled = false, connectedAt = null, firstByteAt = null;
    const t0 = Date.now();
    let socket;
    let timer;
    const done = (closeReason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket && socket.destroy(); } catch {}
      const raw = Buffer.concat(chunks);
      const text = raw.toString("latin1");
      const head = parseResponseHead(text);
      resolveP({
        schema: "agent-browser-runtime.raw-request.v1",
        target: { host, port, tls: useTls, servername: params?.servername || host },
        requestBytes: requestBuf.length,
        closeReason,
        timing: {
          connectMs: connectedAt ? connectedAt - t0 : null,
          firstByteMs: firstByteAt ? firstByteAt - t0 : null,
          totalMs: Date.now() - t0,
        },
        responseBytes: total,
        responseTruncated: total > maxBytes,
        statusLine: head.statusLine,
        responseHeaders: head.headers,
        httpResponseCount: countHttpResponses(text),
        responsePreview: text.slice(0, 4000),
        responseBase64: raw.subarray(0, Math.min(raw.length, maxBytes)).toString("base64"),
        boundary: "Byte-exact node socket send (bypasses Chrome). Objective signals only: status line, headers, httpResponseCount, timing, closeReason. httpResponseCount>1 can indicate request smuggling / response desync but is NOT a vulnerability judgment — verify and classify in the agent.",
      });
    };
    const fail = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket && socket.destroy(); } catch {}
      rejectP(e);
    };
    const onConnect = () => {
      connectedAt = Date.now();
      try { socket.write(requestBuf); } catch (e) { fail(e); }
    };
    try {
      socket = useTls
        ? tls.connect({ host, port, servername: params?.servername || host, rejectUnauthorized: false }, onConnect)
        : net.connect({ host, port }, onConnect);
    } catch (e) { return fail(e); }
    socket.on("data", (buf) => {
      if (firstByteAt === null) firstByteAt = Date.now();
      const room = maxBytes - total;
      if (room > 0) chunks.push(buf.length <= room ? buf : buf.subarray(0, room));
      total += buf.length;
    });
    socket.on("end", () => done("end"));
    socket.on("close", () => done("close"));
    socket.on("error", fail);
    timer = setTimeout(() => done("timeout"), timeoutMs);
  });
}

// Concurrent race / TOCTOU primitive. Sends N byte-exact requests so they hit
// the server at (as close as possible to) the same instant, for single-packet /
// last-byte-sync race-condition testing (coupon reuse, double-spend, quota
// bypass, purchase-limit bypass — server-side TOCTOU logic bugs).
//
// last-byte-sync (Turbo Intruder's gate technique): open one socket per request,
// write every byte EXCEPT the final one and flush, wait until ALL sockets have
// their head out, then in one tight loop release the last byte on each socket.
// With Nagle off (setNoDelay), each final byte leaves as its own packet right
// away, so the N requests complete server-side in a tight window and contend.
//
// BOUNDARY: returns objective signals only (per-request status/headers/bytes,
// first-byte timing relative to a shared t0, status distribution, first-byte
// spread). It does NOT decide whether the race "won" — that is the agent's job.
function buildRequestBuf(spec) {
  return spec?.rawRequestBase64
    ? Buffer.from(String(spec.rawRequestBase64), "base64")
    : Buffer.from(String(spec?.rawRequest ?? ""), "utf8");
}

export async function rawRaceRequest(params = {}) {
  const host = String(params?.host || "").trim();
  if (!host) throw new Error("host is required");
  const useTls = params?.tls != null ? Boolean(params.tls) : (params?.port == null || Number(params.port) === 443);
  const port = Number(params?.port) || (useTls ? 443 : 80);
  const servername = params?.servername || host;
  const requests = Array.isArray(params?.requests) ? params.requests : [];
  if (requests.length < 2) throw new Error("requests must be an array of at least 2 entries");
  const bufs = requests.map((spec, i) => {
    const buf = buildRequestBuf(spec);
    if (!buf.length) throw new Error(`requests[${i}] has empty rawRequest (or rawRequestBase64)`);
    return buf;
  });
  const count = bufs.length;
  const syncMode = params?.syncMode === "parallel" ? "parallel" : "last-byte";
  const maxBytes = Math.min(64 * 1024 * 1024, Math.max(1024, Number(params?.maxResponseBytes) || 524288));
  const timeoutMs = Math.min(60_000, Math.max(500, Number(params?.readTimeoutMs) || 10000));
  const target = { host, port, tls: useTls, servername };

  // Per-request socket state. Each socket collects its own response independently,
  // reusing the same settled-guard / maxBytes-truncation / timeout discipline as
  // rawSocketRequest, so one slow/broken request can't hang the batch.
  function makeWorker(index, requestBuf) {
    const st = {
      index,
      chunks: [],
      total: 0,
      settled: false,
      firstByteAt: null,
      closeReason: null,
      socket: null,
      timer: null,
      headWritten: null, // resolves once head bytes are flushed (last-byte mode)
      donePromise: null,
      resolveDone: null,
    };
    st.donePromise = new Promise((res) => { st.resolveDone = res; });
    const finish = (reason) => {
      if (st.settled) return;
      st.settled = true;
      st.closeReason = reason;
      clearTimeout(st.timer);
      try { st.socket && st.socket.destroy(); } catch {}
      st.resolveDone();
    };
    const onData = (buf) => {
      if (st.firstByteAt === null) st.firstByteAt = Date.now();
      const room = maxBytes - st.total;
      if (room > 0) st.chunks.push(buf.length <= room ? buf : buf.subarray(0, room));
      st.total += buf.length;
    };
    const attach = () => {
      st.socket.setNoDelay(true); // disable Nagle so head + final byte each leave promptly
      st.socket.on("data", onData);
      st.socket.on("end", () => finish("end"));
      st.socket.on("close", () => finish("close"));
      st.socket.on("error", () => finish("error"));
      st.timer = setTimeout(() => finish("timeout"), timeoutMs);
    };
    // connectPromise resolves once the head is on the wire (last-byte mode) or the
    // whole request is written (parallel mode). It rejects only on connect failure.
    st.connectPromise = new Promise((res, rej) => {
      const onConnect = () => {
        try {
          attach();
          if (syncMode === "parallel") {
            st.socket.write(requestBuf, () => res());
          } else {
            // hold back the final byte; flush the head, then signal ready
            const head = requestBuf.subarray(0, requestBuf.length - 1);
            st.lastByte = requestBuf.subarray(requestBuf.length - 1);
            st.socket.write(head, () => res());
          }
        } catch (e) { rej(e); }
      };
      try {
        st.socket = useTls
          ? tls.connect({ host, port, servername, rejectUnauthorized: false }, onConnect)
          : net.connect({ host, port }, onConnect);
        st.socket.on("error", (e) => { if (st.firstByteAt === null && !st.settled) rej(e); });
      } catch (e) { rej(e); }
    });
    return st;
  }

  const workers = bufs.map((buf, i) => makeWorker(i, buf));

  let t0;
  if (syncMode === "parallel") {
    // No precise sync: fire each full request as soon as it connects.
    t0 = Date.now();
    await Promise.all(workers.map((w) => w.connectPromise.catch(() => {})));
  } else {
    // last-byte sync: wait for EVERY socket to have its head flushed, then release
    // all final bytes back-to-back in one synchronous loop. t0 is stamped right
    // before the loop so firstByteMs measures arrival relative to the gate opening.
    await Promise.all(workers.map((w) => w.connectPromise.catch(() => {})));
    t0 = Date.now();
    for (const w of workers) {
      if (w.settled || !w.socket) continue;
      try { w.socket.write(w.lastByte); } catch {}
    }
  }

  // Wait for all sockets to settle (end/close/error/timeout), each independently.
  await Promise.all(workers.map((w) => w.donePromise));

  const results = [];
  const statusDistribution = {};
  const firstBytes = [];
  for (const w of workers) {
    const raw = Buffer.concat(w.chunks);
    const text = raw.toString("latin1");
    const headInfo = parseResponseHead(text);
    const status = (headInfo.statusLine.match(/HTTP\/1\.[01]\s+(\d{3})/) || [])[1] || "none";
    statusDistribution[status] = (statusDistribution[status] || 0) + 1;
    const firstByteMs = w.firstByteAt !== null ? w.firstByteAt - t0 : null;
    if (firstByteMs !== null) firstBytes.push(firstByteMs);
    results.push({
      index: w.index,
      statusLine: headInfo.statusLine,
      responseHeaders: headInfo.headers,
      responseBytes: w.total,
      responseTruncated: w.total > maxBytes,
      firstByteMs,
      httpResponseCount: countHttpResponses(text),
      closeReason: w.closeReason,
      responsePreview: text.slice(0, 2000),
    });
  }
  const firstByteSpreadMs = firstBytes.length >= 1
    ? Math.round((Math.max(...firstBytes) - Math.min(...firstBytes)) * 1000) / 1000
    : null;

  return {
    schema: "agent-browser-runtime.race-request.v1",
    syncMode,
    count,
    target,
    results,
    signals: {
      statusDistribution,
      firstByteSpreadMs,
      distinctStatusCount: Object.keys(statusDistribution).length,
    },
    boundary: "并发竞态原语,只出客观信号(状态分布/首字节时间聚集度),NOT a vulnerability judgment——race 是否成功由 agent 看状态分布和 timing 判定。",
  };
}
