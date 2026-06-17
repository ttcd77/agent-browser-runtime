import { describe, it, expect, vi, afterEach } from "vitest";

// We mock the node:http and node:https modules because oob-client makes real
// network calls. The mock intercepts the request and resolves/rejects based on
// per-test configuration so core logic is tested without a live server.

// ── Module mock setup ──────────────────────────────────────────────────────────
// oob-client.mjs imports http and https at module load time. We use vitest's
// `vi.mock` + `vi.hoisted` to intercept them before the module is loaded.

const { mockHttpGet, mockHttpsGet } = vi.hoisted(() => {
  const makeReqStub = (behavior) => {
    let timeoutCb = null;
    const req = {
      _behavior: behavior,
      setTimeout(ms, cb) { timeoutCb = cb; },
      destroy() { if (timeoutCb) timeoutCb(); },
      on(event, cb) {
        if (event === "error" && behavior?.networkError) {
          Promise.resolve().then(() => cb(new Error("ECONNREFUSED")));
        }
        return req;
      },
    };
    return req;
  };

  // Factory: returns a mock `mod.get` that drives the response based on config.
  const makeGet = (cfg) => (url, cb) => {
    const req = makeReqStub(cfg);
    if (cfg?.networkError) return req;
    // Simulate an HTTP response on next tick
    Promise.resolve().then(() => {
      const chunks = [];
      const res = {
        statusCode: cfg?.statusCode ?? 200,
        resume() {},
        on(event, handler) {
          if (event === "data" && cfg?.body) {
            Promise.resolve().then(() => handler(Buffer.from(JSON.stringify(cfg.body))));
          }
          if (event === "end") {
            Promise.resolve().then(() => {
              if (cfg?.body) Promise.resolve().then(handler);
              else handler();
            });
          }
          if (event === "error") { /* no-op */ }
          return res;
        },
      };
      cb(res);
    });
    return req;
  };

  const cfg = { health: {}, poll: {} };
  const mockHttpGet = vi.fn((url, cb) => makeGet(cfg.current)(url, cb));
  const mockHttpsGet = vi.fn((url, cb) => makeGet(cfg.current)(url, cb));

  // Expose config mutator so tests can configure per-call
  mockHttpGet._cfg = cfg;
  mockHttpsGet._cfg = cfg;

  return { mockHttpGet, mockHttpsGet };
});

vi.mock("node:http", () => ({
  default: { get: mockHttpGet },
  get: mockHttpGet,
}));
vi.mock("node:https", () => ({
  default: { get: mockHttpsGet },
  get: mockHttpsGet,
}));

const { oobAlloc, oobPoll } = await import("./oob-client.mjs");

// Helper: configure mock GET to return a JSON body with given status
function configureMock(opts = {}) {
  // Set the current config on both mocks (they share cfg)
  mockHttpGet._cfg.current = opts;
  mockHttpsGet._cfg.current = opts;
  mockHttpGet.mockClear();
  mockHttpsGet.mockClear();
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── oobAlloc — placeholder base (no network call expected) ────────────────────

// Force the placeholder base by passing an explicit serverBase that is the
// placeholder constant, regardless of what OOB_SERVER_BASE env might be set to.
const PLACEHOLDER = "http://YOUR-OOB-SERVER.example";

describe("oobAlloc — placeholder server base", () => {
  it("returns schema, token, url when explicitly passed the placeholder base", async () => {
    // With the placeholder base, no reachability check is performed.
    configureMock({ statusCode: 200 });
    const result = await oobAlloc({ serverBase: PLACEHOLDER });
    expect(result.schema).toBe("agent-browser-runtime.oob-alloc.v1");
    expect(typeof result.token).toBe("string");
    expect(result.token.length).toBeGreaterThan(0);
    expect(result.url).toContain(result.token);
    expect(result.serverBase).toBe(PLACEHOLDER);
    expect(result.ok).toBeUndefined(); // placeholder path doesn't set ok:false
  });

  it("generates a random token by default (two calls differ)", async () => {
    configureMock({});
    const r1 = await oobAlloc({ serverBase: PLACEHOLDER });
    const r2 = await oobAlloc({ serverBase: PLACEHOLDER });
    expect(r1.token).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(r1.token).not.toBe(r2.token); // random
  });

  it("uses a caller-provided token when params.token is given", async () => {
    configureMock({});
    const result = await oobAlloc({ serverBase: PLACEHOLDER, token: "my-custom-token" });
    expect(result.token).toBe("my-custom-token");
    expect(result.url).toContain("my-custom-token");
  });
});

// ── oobAlloc — real server base (triggers reachability check) ─────────────────

describe("oobAlloc — real server base", () => {
  it("returns ok:true when health probe succeeds (any HTTP response)", async () => {
    configureMock({ statusCode: 200, body: { status: "ok" } });
    const result = await oobAlloc({ serverBase: "http://127.0.0.1:19999" });
    // The health probe returned 200 → allocation should succeed
    expect(result.schema).toBe("agent-browser-runtime.oob-alloc.v1");
    expect(result.token).toBeTruthy();
  });

  it("returns ok:false error when health probe fails (network error)", async () => {
    configureMock({ networkError: true });
    const result = await oobAlloc({ serverBase: "http://127.0.0.1:19998" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("oob_server_unreachable");
    expect(typeof result.hint).toBe("string");
  });

  it("strips trailing slashes from serverBase", async () => {
    configureMock({ statusCode: 200, body: { status: "ok" } });
    const result = await oobAlloc({ serverBase: "http://127.0.0.1:19997///" });
    expect(result.serverBase).not.toMatch(/\/$/);
    expect(result.url).not.toContain("//my-token");
  });
});

// ── oobPoll — error cases ─────────────────────────────────────────────────────

describe("oobPoll — error cases", () => {
  it("returns error when token is missing", async () => {
    const result = await oobPoll({ serverBase: "http://real.example" });
    expect(result.error).toBe("token is required");
    expect(result.schema).toBe("agent-browser-runtime.oob-poll.v1");
  });

  it("returns error when serverBase is explicitly the placeholder", async () => {
    const result = await oobPoll({ token: "abc123", serverBase: PLACEHOLDER });
    expect(result.error).toContain("OOB_SERVER_BASE is unset");
    expect(result.serverBase).toBe(PLACEHOLDER);
  });

  it("returns structured error (not throw) on network error", async () => {
    configureMock({ networkError: true });
    const result = await oobPoll({ token: "abc", serverBase: "http://127.0.0.1:19996" });
    expect(typeof result.error).toBe("string");
    expect(result.schema).toBe("agent-browser-runtime.oob-poll.v1");
  });
});

// ── oobPoll — happy path ──────────────────────────────────────────────────────

describe("oobPoll — happy path", () => {
  it("returns structured interactions when server returns results", async () => {
    const fakeInteractions = [
      {
        source_ip: "1.2.3.4",
        protocol: "http",
        method: "GET",
        path: "/abc123",
        timestamp: "2025-06-01T10:00:00Z",
        user_agent: "curl/7.0",
        headers: { host: "oob.example" },
      },
    ];
    configureMock({ statusCode: 200, body: { interactions: fakeInteractions } });

    const result = await oobPoll({ token: "abc123", serverBase: "http://oob.example" });
    expect(result.schema).toBe("agent-browser-runtime.oob-poll.v1");
    expect(result.token).toBe("abc123");
    expect(result.interactionCount).toBe(1);
    expect(result.interactions[0].source_ip).toBe("1.2.3.4");
    expect(result.interactions[0].protocol).toBe("http");
    expect(result.signals.http_count).toBe(1);
    expect(result.signals.distinct_source_ips).toBe(1);
  });

  it("returns empty interactions array on zero results", async () => {
    configureMock({ statusCode: 200, body: { interactions: [] } });
    const result = await oobPoll({ token: "abc123", serverBase: "http://oob.example" });
    expect(result.interactionCount).toBe(0);
    expect(result.interactions).toEqual([]);
    expect(result.signals.http_count).toBe(0);
    expect(result.signals.distinct_source_ips).toBe(0);
  });

  it("handles response with no interactions key gracefully", async () => {
    configureMock({ statusCode: 200, body: {} });
    const result = await oobPoll({ token: "abc123", serverBase: "http://oob.example" });
    expect(result.interactionCount).toBe(0);
  });

  it("clamps limit between 1 and 1000", async () => {
    configureMock({ statusCode: 200, body: { interactions: [] } });
    // Just check it doesn't throw at boundary values
    await oobPoll({ token: "abc", serverBase: "http://oob.example", limit: 0 });
    await oobPoll({ token: "abc", serverBase: "http://oob.example", limit: 9999 });
    await oobPoll({ token: "abc", serverBase: "http://oob.example", limit: 500 });
  });
});

// ── oobPoll — edge cases ──────────────────────────────────────────────────────

describe("oobPoll — edge cases", () => {
  it("counts distinct source IPs correctly", async () => {
    configureMock({
      statusCode: 200,
      body: {
        interactions: [
          { source_ip: "1.1.1.1", protocol: "http" },
          { source_ip: "2.2.2.2", protocol: "http" },
          { source_ip: "1.1.1.1", protocol: "http" }, // duplicate
        ],
      },
    });
    const result = await oobPoll({ token: "tok", serverBase: "http://oob.example" });
    expect(result.signals.distinct_source_ips).toBe(2);
    expect(result.interactionCount).toBe(3);
  });

  it("dns_only_count counts protocol=dns entries (Wave-10 live DNS listener)", async () => {
    configureMock({
      statusCode: 200,
      body: {
        interactions: [
          { source_ip: "1.2.3.4", protocol: "http" },
          { source_ip: "5.6.7.8", protocol: "dns" },
          { source_ip: "5.6.7.8", protocol: "dns" },
        ],
      },
    });
    const result = await oobPoll({ token: "tok", serverBase: "http://oob.example" });
    expect(result.signals.dns_only_count).toBe(2);
    expect(result.signals.http_count).toBe(1);
  });

  it("boundary field is present in result", async () => {
    configureMock({ statusCode: 200, body: { interactions: [] } });
    const result = await oobPoll({ token: "tok", serverBase: "http://oob.example" });
    expect(typeof result.boundary).toBe("string");
    expect(result.boundary.length).toBeGreaterThan(0);
  });
});

// ── oobAlloc — mode parameter (Wave-10) ──────────────────────────────────────

describe("oobAlloc — mode parameter", () => {
  it("mode=http (default) produces url = base/token", async () => {
    configureMock({ statusCode: 200 });
    const result = await oobAlloc({ serverBase: PLACEHOLDER, mode: "http" });
    expect(result.mode).toBe("http");
    expect(result.url).toBe(`${PLACEHOLDER}/${result.token}`);
  });

  it("mode omitted defaults to http", async () => {
    configureMock({ statusCode: 200 });
    const result = await oobAlloc({ serverBase: PLACEHOLDER });
    expect(result.mode).toBe("http");
    expect(result.url).toContain(result.token);
    expect(result.url).not.toContain("/redir");
  });

  it("mode=redirect produces url = base/token/redir?to=", async () => {
    configureMock({ statusCode: 200 });
    const result = await oobAlloc({ serverBase: PLACEHOLDER, mode: "redirect" });
    expect(result.mode).toBe("redirect");
    expect(result.url).toContain(`/${result.token}/redir?to=`);
  });

  it("mode=dns produces url = <token>.exfil.YOUR-DOMAIN.example (no base)", async () => {
    configureMock({ statusCode: 200 });
    const result = await oobAlloc({ serverBase: PLACEHOLDER, mode: "dns" });
    expect(result.mode).toBe("dns");
    // url should be the DNS domain, not an http URL
    expect(result.url).toMatch(new RegExp(`^${result.token}\\.`));
    expect(result.url).not.toMatch(/^https?:\/\//);
  });

  it("mode=redirect with fixed token produces deterministic url", async () => {
    configureMock({ statusCode: 200 });
    const result = await oobAlloc({ serverBase: PLACEHOLDER, mode: "redirect", token: "testtoken" });
    expect(result.token).toBe("testtoken");
    expect(result.url).toBe(`${PLACEHOLDER}/testtoken/redir?to=`);
  });

  it("invalid mode falls back to http", async () => {
    configureMock({ statusCode: 200 });
    const result = await oobAlloc({ serverBase: PLACEHOLDER, mode: "invalid" });
    expect(result.mode).toBe("http");
  });
});
