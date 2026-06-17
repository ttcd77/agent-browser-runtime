import { describe, it, expect } from "vitest";
import { registerApplicationStorageTools } from "./register-application-storage.mjs";

// Characterization tests for the Application-storage (storage/cookies/service-worker/
// IndexedDB/CacheStorage) tool family carved out of agent-cdp-server.mjs. They lock
// (a) which tools the family registers and their public surface, and (b) that a
// representative handler is correctly wired to its injected deps (resolveProfile +
// withManagedPageClient + profileRegistry, plus the evidence-summaries lib helpers).
// Deep handler logic is verbatim-preserved and covered by the evidence-summaries unit
// tests + the tool-registry contract net.

function mockDeps(overrides = {}) {
  return {
    tools: new Map(),
    cdpPort: 9222,
    profileRegistry: {
      touchProfile: async () => {},
      ...overrides.profileRegistry,
    },
    resolveProfile: overrides.resolveProfile
      || (async (name) => ({ name: name || "default", tabId: "tab-1", evidenceDir: "/tmp/evidence" })),
    // By default, invoke the callback with a mock client+target so handler wiring runs.
    withManagedPageClient: overrides.withManagedPageClient
      || (async (_profile, _tabId, fn) => fn(overrides.client || {}, { id: "tab-1" })),
    cdpJson: overrides.cdpJson || (async () => []),
    managedPlaywrightDriver: overrides.managedPlaywrightDriver || { addCookies: async () => ({ ok: true, backend: "managed", count: 0 }), getCookies: async () => ({ ok: true, backend: "managed", count: 0, cookies: [] }) },
    maybeRoutePersonal: overrides.maybeRoutePersonal || (async () => null),
  };
}

describe("registerApplicationStorageTools", () => {
  it("registers the application-storage family with the expected names", () => {
    const deps = mockDeps();
    registerApplicationStorageTools(deps);
    expect([...deps.tools.keys()].sort()).toEqual([
      "browser_application_export",
      "browser_cache_entry_get",
      "browser_cache_storage_list",
      "browser_cookie_summary",
      "browser_cookies_get",
      "browser_cookies_set",
      "browser_indexeddb_list",
      "browser_indexeddb_read",
      "browser_service_worker_detail",
      "browser_service_worker_summary",
      "browser_storage_origin_summary",
      "browser_storage_snapshot",
    ]);
  });

  it("every registered tool exposes name + description + object schema + async execute", () => {
    const deps = mockDeps();
    registerApplicationStorageTools(deps);
    for (const [name, tool] of deps.tools) {
      expect(tool.name).toBe(name);
      expect(typeof tool.description).toBe("string");
      expect(tool.parameters?.type).toBe("object");
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("browser_cookie_summary handler is wired to injected deps (client + lib summaries)", async () => {
    const client = {
      Network: { getCookies: async () => ({ cookies: [{ name: "sid", value: "x", domain: "example.com" }] }) },
    };
    const deps = mockDeps({ client });
    registerApplicationStorageTools(deps);
    const result = await deps.tools.get("browser_cookie_summary").execute("id", { profile: "t" });
    const report = JSON.parse(result.content[0].text);
    expect(report.profile).toBe("t");
    expect(report.tabId).toBe("tab-1");
    expect(report.cookies).toHaveLength(1);
    expect(report.summary).toBeTruthy();
    expect(report.partitionSummary).toBeTruthy();
  });
});
