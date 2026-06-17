import { describe, it, expect, vi, afterEach } from "vitest";
import net from "node:net";

// ── Import pure helper functions first (no mocking needed) ────────────────────
import { countHttpResponses, parseResponseHead } from "./raw-request.mjs";

// ── Inline server fixture for rawSocketRequest integration tests ───────────────
// We spin up a real TCP server using node:net so rawSocketRequest can connect
// to a real socket without mocking net.connect. This keeps the test "real" for
// the happy path while remaining fully local.

async function startEchoServer(responseLines) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      // Collect the full request then send the response
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString("latin1");
        // Simple heuristic: respond once we see end of headers (\r\n\r\n)
        if (data.includes("\r\n\r\n")) {
          socket.write(responseLines.join("\r\n"));
          socket.end();
        }
      });
      socket.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
    server.on("error", () => {});
  });
}

// ── countHttpResponses ─────────────────────────────────────────────────────────

describe("countHttpResponses", () => {
  it("returns 0 for empty string", () => {
    expect(countHttpResponses("")).toBe(0);
  });

  it("returns 1 for a single HTTP/1.1 200 response", () => {
    const text = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n";
    expect(countHttpResponses(text)).toBe(1);
  });

  it("returns 1 for HTTP/1.0 response", () => {
    expect(countHttpResponses("HTTP/1.0 404 Not Found\r\n\r\n")).toBe(1);
  });

  it("returns 2 for two pipelined responses (smuggling signal)", () => {
    const text = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\nHTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n";
    expect(countHttpResponses(text)).toBe(2);
  });

  it("returns 3 for three responses", () => {
    const text = [
      "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
      "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
      "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
    ].join("");
    expect(countHttpResponses(text)).toBe(3);
  });

  it("handles LF-only separators", () => {
    const text = "HTTP/1.1 200 OK\nContent-Length: 0\n\nHTTP/1.1 404 Not Found\n";
    expect(countHttpResponses(text)).toBe(2);
  });

  it("does not count non-HTTP lines", () => {
    const text = "HTTP/2 200 OK\r\nSome other text\r\n";
    // HTTP/2 does not match HTTP/1.[01]
    expect(countHttpResponses(text)).toBe(0);
  });
});

// ── parseResponseHead ─────────────────────────────────────────────────────────

describe("parseResponseHead", () => {
  it("parses status line", () => {
    const { statusLine } = parseResponseHead("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nbody");
    expect(statusLine).toBe("HTTP/1.1 200 OK");
  });

  it("parses headers correctly", () => {
    const text = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 100\r\n\r\n";
    const { headers } = parseResponseHead(text);
    expect(headers["Content-Type"]).toBe("text/html");
    expect(headers["Content-Length"]).toBe("100");
  });

  it("joins duplicate header names with comma+space", () => {
    const text = "HTTP/1.1 200 OK\r\nContent-Length: 10\r\nContent-Length: 20\r\n\r\n";
    const { headers } = parseResponseHead(text);
    expect(headers["Content-Length"]).toBe("10, 20");
  });

  it("handles empty response (no headers, no body)", () => {
    const { statusLine, headers } = parseResponseHead("");
    expect(statusLine).toBe("");
    expect(headers).toEqual({});
  });

  it("handles missing \\r\\n\\r\\n boundary (incomplete response)", () => {
    const text = "HTTP/1.1 200 OK\r\nContent-Type: text/plain";
    const { statusLine, headers } = parseResponseHead(text);
    expect(statusLine).toBe("HTTP/1.1 200 OK");
    expect(headers["Content-Type"]).toBe("text/plain");
  });
});

// ── rawSocketRequest — error cases ────────────────────────────────────────────

import { rawSocketRequest, rawRaceRequest } from "./raw-request.mjs";

describe("rawSocketRequest — error cases", () => {
  it("throws when host is empty", async () => {
    await expect(rawSocketRequest({ rawRequest: "GET / HTTP/1.0\r\n\r\n" })).rejects.toThrow("host is required");
  });

  it("throws when rawRequest is empty", async () => {
    await expect(rawSocketRequest({ host: "example.com", rawRequest: "" })).rejects.toThrow("rawRequest");
  });

  it("rejects on connection failure (unreachable port)", async () => {
    await expect(
      rawSocketRequest({
        host: "127.0.0.1",
        port: 1, // well below reserved range, will fail
        rawRequest: "GET / HTTP/1.0\r\n\r\n",
        readTimeoutMs: 500,
      })
    ).rejects.toThrow();
  });
});

// ── rawSocketRequest — happy path (real local TCP server) ─────────────────────

describe("rawSocketRequest — happy path with local echo server", () => {
  it("returns schema, statusLine, responseHeaders, and timing", async () => {
    const { server, port } = await startEchoServer([
      "HTTP/1.1 200 OK",
      "Content-Type: text/plain",
      "Content-Length: 5",
      "",
      "hello",
    ]);
    try {
      const result = await rawSocketRequest({
        host: "127.0.0.1",
        port,
        tls: false,
        rawRequest: "GET / HTTP/1.0\r\nHost: localhost\r\n\r\n",
        readTimeoutMs: 3000,
      });
      expect(result.schema).toBe("agent-browser-runtime.raw-request.v1");
      expect(result.statusLine).toBe("HTTP/1.1 200 OK");
      expect(result.responseHeaders["Content-Type"]).toBe("text/plain");
      expect(result.httpResponseCount).toBe(1);
      expect(typeof result.timing.connectMs).toBe("number");
      expect(typeof result.timing.firstByteMs).toBe("number");
      expect(typeof result.timing.totalMs).toBe("number");
      expect(result.target.host).toBe("127.0.0.1");
      expect(result.target.tls).toBe(false);
      expect(result.requestBytes).toBeGreaterThan(0);
      expect(typeof result.boundary).toBe("string");
    } finally {
      server.close();
    }
  });

  it("returns rawRequestBase64 path (base64-encoded request)", async () => {
    const { server, port } = await startEchoServer([
      "HTTP/1.1 204 No Content",
      "",
      "",
    ]);
    try {
      const rawB64 = Buffer.from("GET / HTTP/1.0\r\nHost: localhost\r\n\r\n").toString("base64");
      const result = await rawSocketRequest({
        host: "127.0.0.1",
        port,
        tls: false,
        rawRequestBase64: rawB64,
        readTimeoutMs: 3000,
      });
      expect(result.statusLine).toBe("HTTP/1.1 204 No Content");
    } finally {
      server.close();
    }
  });

  it("detects httpResponseCount > 1 for pipelined responses", async () => {
    const { server, port } = await startEchoServer([
      "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
    ]);
    try {
      const result = await rawSocketRequest({
        host: "127.0.0.1",
        port,
        tls: false,
        rawRequest: "GET / HTTP/1.0\r\n\r\n",
        readTimeoutMs: 2000,
      });
      expect(result.httpResponseCount).toBe(2);
    } finally {
      server.close();
    }
  });
});

// ── rawRaceRequest — error cases ──────────────────────────────────────────────

describe("rawRaceRequest — error cases", () => {
  it("throws when host is missing", async () => {
    await expect(
      rawRaceRequest({ requests: [{ rawRequest: "GET / HTTP/1.0\r\n\r\n" }, { rawRequest: "GET / HTTP/1.0\r\n\r\n" }] })
    ).rejects.toThrow("host is required");
  });

  it("throws when fewer than 2 requests provided", async () => {
    await expect(
      rawRaceRequest({ host: "127.0.0.1", requests: [{ rawRequest: "GET / HTTP/1.0\r\n\r\n" }] })
    ).rejects.toThrow("at least 2");
  });

  it("throws when requests is empty", async () => {
    await expect(rawRaceRequest({ host: "127.0.0.1", requests: [] })).rejects.toThrow("at least 2");
  });

  it("throws when a request entry has an empty rawRequest", async () => {
    await expect(
      rawRaceRequest({
        host: "127.0.0.1",
        requests: [{ rawRequest: "GET / HTTP/1.0\r\n\r\n" }, { rawRequest: "" }],
      })
    ).rejects.toThrow("empty rawRequest");
  });
});

// ── rawRaceRequest — happy path ───────────────────────────────────────────────

describe("rawRaceRequest — happy path with local echo server", () => {
  it("returns schema, count, results[], signals with parallel syncMode", async () => {
    const { server, port } = await startEchoServer([
      "HTTP/1.1 200 OK",
      "Content-Length: 0",
      "",
      "",
    ]);
    try {
      const req = "GET / HTTP/1.0\r\nHost: localhost\r\n\r\n";
      const result = await rawRaceRequest({
        host: "127.0.0.1",
        port,
        tls: false,
        syncMode: "parallel",
        requests: [{ rawRequest: req }, { rawRequest: req }],
        readTimeoutMs: 3000,
      });
      expect(result.schema).toBe("agent-browser-runtime.race-request.v1");
      expect(result.count).toBe(2);
      expect(result.results.length).toBe(2);
      expect(result.syncMode).toBe("parallel");
      expect(typeof result.signals.statusDistribution).toBe("object");
      expect(typeof result.signals.firstByteSpreadMs).toBe("number");
      expect(typeof result.signals.distinctStatusCount).toBe("number");
      expect(result.target.host).toBe("127.0.0.1");
    } finally {
      server.close();
    }
  });

  it("each result has index, statusLine, responseHeaders, timing, httpResponseCount", async () => {
    const { server, port } = await startEchoServer([
      "HTTP/1.1 200 OK",
      "Content-Type: text/plain",
      "",
      "ok",
    ]);
    try {
      const req = "GET / HTTP/1.0\r\nHost: localhost\r\n\r\n";
      const result = await rawRaceRequest({
        host: "127.0.0.1",
        port,
        tls: false,
        syncMode: "parallel",
        requests: [{ rawRequest: req }, { rawRequest: req }],
        readTimeoutMs: 3000,
      });
      for (const r of result.results) {
        expect(typeof r.index).toBe("number");
        expect(typeof r.statusLine).toBe("string");
        expect(typeof r.responseHeaders).toBe("object");
        expect(typeof r.httpResponseCount).toBe("number");
        expect(typeof r.responseBytes).toBe("number");
      }
    } finally {
      server.close();
    }
  });

  it("statusDistribution counts status codes", async () => {
    const { server, port } = await startEchoServer([
      "HTTP/1.1 200 OK",
      "Content-Length: 0",
      "",
      "",
    ]);
    try {
      const req = "GET / HTTP/1.0\r\nHost: localhost\r\n\r\n";
      const result = await rawRaceRequest({
        host: "127.0.0.1",
        port,
        tls: false,
        syncMode: "parallel",
        requests: [{ rawRequest: req }, { rawRequest: req }],
        readTimeoutMs: 3000,
      });
      expect(result.signals.statusDistribution["200"]).toBeGreaterThanOrEqual(1);
    } finally {
      server.close();
    }
  });
});
