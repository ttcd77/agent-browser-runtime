import { describe, it, expect } from "vitest";
import { registerAliases } from "./register-aliases.mjs";

// F4 (2026-06-11): All devtools_* aliases and browser_fill have been removed.
// registerAliases is now a no-op. These tests lock the zero-alias state
// and verify the no-op contract so future changes are caught.

describe("registerAliases", () => {
  it("registers zero aliases after F4 removal", () => {
    let calls = 0;
    registerAliases({ aliasTool: (..._args) => { calls += 1; } });
    expect(calls).toBe(0);
  });

  it("accepts any deps shape without throwing (no-op is safe)", () => {
    expect(() => registerAliases({})).not.toThrow();
    expect(() => registerAliases({ aliasTool: () => {} })).not.toThrow();
    expect(() => registerAliases({ aliasTool: null })).not.toThrow();
  });
});
