// Smoke test for the raw-socket HTTP primitive (lib/raw-request.mjs).
// Spins a local HTTP server and exercises byte-exact send + objective signals,
// so we get regression coverage without touching Chrome/the worker.
import http from "node:http";
import { rawSocketRequest, rawRaceRequest } from "./lib/raw-request.mjs";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  ok    ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
    failures++;
  }
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`method=${req.method} path=${req.url} bodylen=${body.length} cl=${req.headers["content-length"] ?? "-"}`);
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
console.log(`raw-request smoke: local server 127.0.0.1:${port}`);

// 1. normal GET -> single 200, objective signals present
const g = await rawSocketRequest({ host: "127.0.0.1", port, tls: false, rawRequest: "GET /hi HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n" });
check("GET status 200", g.statusLine.includes("200"), g.statusLine);
check("GET httpResponseCount=1", g.httpResponseCount === 1, `count=${g.httpResponseCount}`);
check("GET reached path /hi", g.responsePreview.includes("path=/hi"), g.responsePreview.slice(0, 60));
check("GET timing populated", typeof g.timing.connectMs === "number" && typeof g.timing.firstByteMs === "number");
check("GET closeReason set", ["end", "close", "timeout"].includes(g.closeReason), g.closeReason);
check("GET responseBase64 decodes to same bytes", Buffer.from(g.responseBase64, "base64").toString("latin1").includes("200"));

// 2. POST body delivered byte-exact
const p = await rawSocketRequest({ host: "127.0.0.1", port, tls: false, rawRequest: "POST /p HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello" });
check("POST body length 5 delivered", p.responsePreview.includes("bodylen=5"), p.responsePreview.slice(0, 60));

// 3. dual Content-Length sent verbatim (proves no normalisation; server may 200 or 400)
const d = await rawSocketRequest({ host: "127.0.0.1", port, tls: false, rawRequest: "POST /d HTTP/1.1\r\nHost: x\r\nContent-Length: 3\r\nContent-Length: 5\r\nConnection: close\r\n\r\nabcde" });
check("dual-CL request got a response (raw bytes left the socket)", g.responseBytes > 0 && d.responseBytes > 0, `dStatus=${d.statusLine} close=${d.closeReason}`);

// 4. base64 input path
const b = await rawSocketRequest({ host: "127.0.0.1", port, tls: false, rawRequestBase64: Buffer.from("GET /b64 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").toString("base64") });
check("base64 request reached path /b64", b.responsePreview.includes("path=/b64"), b.responsePreview.slice(0, 60));

// 5. missing rawRequest throws
let threw = false;
try { await rawSocketRequest({ host: "127.0.0.1", port, tls: false }); } catch { threw = true; }
check("missing rawRequest throws", threw);

// --- race primitive (rawRaceRequest) ---
const mkReq = (n) => ({ rawRequest: `GET /race${n} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n` });

// 6. last-byte sync: 5 concurrent requests, all answered, objective signals present
const race = await rawRaceRequest({
  host: "127.0.0.1", port, tls: false,
  requests: [mkReq(0), mkReq(1), mkReq(2), mkReq(3), mkReq(4)],
});
check("race schema is race-request.v1", race.schema === "agent-browser-runtime.race-request.v1", race.schema);
check("race syncMode last-byte (default)", race.syncMode === "last-byte", race.syncMode);
check("race count=5", race.count === 5, `count=${race.count}`);
check("race got 5 results", race.results.length === 5, `len=${race.results.length}`);
check("race all 5 got a response (statusLine non-empty)", race.results.every((r) => r.statusLine.length > 0), JSON.stringify(race.results.map((r) => r.statusLine)));
check("race all 5 got status 200", race.results.every((r) => r.statusLine.includes("200")));
check("race every result has numeric firstByteMs", race.results.every((r) => typeof r.firstByteMs === "number"), JSON.stringify(race.results.map((r) => r.firstByteMs)));
check("race each result reached its own path", race.results.every((r, i) => r.responsePreview.includes(`path=/race${r.index}`)) && race.results.length === 5);
check("race signals.firstByteSpreadMs is a number", typeof race.signals.firstByteSpreadMs === "number", `spread=${race.signals.firstByteSpreadMs}`);
check("race signals.statusDistribution has 200=5", race.signals.statusDistribution["200"] === 5, JSON.stringify(race.signals.statusDistribution));
check("race signals.distinctStatusCount=1", race.signals.distinctStatusCount === 1, `distinct=${race.signals.distinctStatusCount}`);
check("race boundary present", typeof race.boundary === "string" && race.boundary.length > 0);

// 7. parallel mode does not throw and returns the same shape
const racePar = await rawRaceRequest({
  host: "127.0.0.1", port, tls: false, syncMode: "parallel",
  requests: [mkReq(10), mkReq(11), mkReq(12)],
});
check("parallel syncMode reported", racePar.syncMode === "parallel", racePar.syncMode);
check("parallel got 3 responses with firstByteMs", racePar.results.length === 3 && racePar.results.every((r) => typeof r.firstByteMs === "number"));
check("parallel signals.firstByteSpreadMs is a number", typeof racePar.signals.firstByteSpreadMs === "number", `spread=${racePar.signals.firstByteSpreadMs}`);

// 8. fewer than 2 requests throws
let raceThrew = false;
try { await rawRaceRequest({ host: "127.0.0.1", port, tls: false, requests: [mkReq(0)] }); } catch { raceThrew = true; }
check("race with <2 requests throws", raceThrew);

server.close();
console.log(failures === 0 ? "raw-request smoke: PASS" : `raw-request smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
