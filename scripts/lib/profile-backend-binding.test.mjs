import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  profileConfigFilePath,
  readProfileConfig,
  writeProfileConfig,
  getStoredBackend,
  profileBackendListString,
  bindProfileBackendOnOpen,
  injectBackendIntoPayload,
  annotateProfilesWithBackend,
  VALID_BACKENDS,
  DEFAULT_PROFILE_NAME,
} from "./profile-backend-binding.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempConfigDir() {
  const dir = join(tmpdir(), `abr-binding-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function configPath(dir) {
  return join(dir, "browser-profiles.json");
}

function writeConfig(dir, profilesObj) {
  const data = { browser: { profiles: profilesObj } };
  writeFileSync(configPath(dir), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return configPath(dir);
}

function readConfig(dir) {
  return JSON.parse(readFileSync(configPath(dir), "utf8"));
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("VALID_BACKENDS contains personal and managed", () => {
    expect(VALID_BACKENDS.has("personal")).toBe(true);
    expect(VALID_BACKENDS.has("managed")).toBe(true);
    expect(VALID_BACKENDS.size).toBe(2);
  });

  it("DEFAULT_PROFILE_NAME is 'default'", () => {
    expect(DEFAULT_PROFILE_NAME).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// profileConfigFilePath
// ---------------------------------------------------------------------------

describe("profileConfigFilePath", () => {
  it("returns override path when provided", () => {
    expect(profileConfigFilePath("/tmp/custom.json")).toBe("/tmp/custom.json");
  });

  it("falls back to RUNTIME_DATA_DIR/browser-profiles.json when no override", () => {
    const result = profileConfigFilePath(undefined);
    expect(result).toMatch(/browser-profiles\.json$/);
  });
});

// ---------------------------------------------------------------------------
// readProfileConfig / writeProfileConfig
// ---------------------------------------------------------------------------

describe("readProfileConfig", () => {
  it("returns empty shell when file does not exist", () => {
    const result = readProfileConfig("/nonexistent/path/browser-profiles.json");
    expect(result).toEqual({ browser: { profiles: {} } });
  });

  it("parses an existing file correctly", () => {
    const dir = tempConfigDir();
    writeConfig(dir, { "my-profile": { cdpPort: 9222, backend: "personal" } });
    const cfg = readProfileConfig(configPath(dir));
    expect(cfg.browser.profiles["my-profile"].backend).toBe("personal");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("writeProfileConfig", () => {
  it("creates the file with correct JSON", () => {
    const dir = tempConfigDir();
    const cfg = { browser: { profiles: { "test-profile": { cdpPort: 9222 } } } };
    writeProfileConfig(configPath(dir), cfg);
    const back = JSON.parse(readFileSync(configPath(dir), "utf8"));
    expect(back.browser.profiles["test-profile"].cdpPort).toBe(9222);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// getStoredBackend
// ---------------------------------------------------------------------------

describe("getStoredBackend", () => {
  it("returns null when profile has no backend field", () => {
    const cfg = { browser: { profiles: { "p": { cdpPort: 9222 } } } };
    expect(getStoredBackend(cfg, "p")).toBeNull();
  });

  it("returns stored backend when present", () => {
    const cfg = { browser: { profiles: { "p": { cdpPort: 9222, backend: "personal" } } } };
    expect(getStoredBackend(cfg, "p")).toBe("personal");
  });

  it("returns null when profile does not exist in config", () => {
    const cfg = { browser: { profiles: {} } };
    expect(getStoredBackend(cfg, "missing")).toBeNull();
  });

  it("returns null when config is empty/null", () => {
    expect(getStoredBackend(null, "p")).toBeNull();
    expect(getStoredBackend({}, "p")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// profileBackendListString
// ---------------------------------------------------------------------------

describe("profileBackendListString", () => {
  it("lists profiles with their backends", () => {
    const cfg = {
      browser: {
        profiles: {
          "resend": { backend: "personal" },
          "guest-clean": { backend: "managed" },
          "no-backend": { cdpPort: 9222 },
        },
      },
    };
    const result = profileBackendListString(cfg);
    expect(result).toContain("resend → personal");
    expect(result).toContain("guest-clean → managed");
    expect(result).not.toContain("no-backend");
  });

  it("returns placeholder when no profiles have a backend", () => {
    const cfg = { browser: { profiles: { "a": { cdpPort: 9222 } } } };
    expect(profileBackendListString(cfg)).toContain("no profiles have a bound backend");
  });
});

// ---------------------------------------------------------------------------
// bindProfileBackendOnOpen
// ---------------------------------------------------------------------------

describe("bindProfileBackendOnOpen", () => {
  let dir;
  beforeEach(() => { dir = tempConfigDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("skips write for the 'default' profile even with --backend", () => {
    // Do NOT pre-create a config file here; the function must not create one either.
    const result = bindProfileBackendOnOpen("default", "personal", configPath(dir));
    expect(result.wrote).toBe(false);
    // File should not have been written.
    expect(existsSync(configPath(dir))).toBe(false);
  });

  it("writes backend on first open with --backend personal", () => {
    writeConfig(dir, {});
    const result = bindProfileBackendOnOpen("resend", "personal", configPath(dir));
    expect(result.wrote).toBe(true);
    expect(result.backend).toBe("personal");
    const cfg = readConfig(dir);
    expect(cfg.browser.profiles["resend"].backend).toBe("personal");
  });

  it("writes backend on first open with --backend managed", () => {
    writeConfig(dir, {});
    const result = bindProfileBackendOnOpen("guest-clean", "managed", configPath(dir));
    expect(result.wrote).toBe(true);
    expect(result.backend).toBe("managed");
    const cfg = readConfig(dir);
    expect(cfg.browser.profiles["guest-clean"].backend).toBe("managed");
  });

  it("returns no-op when profile already bound to same backend", () => {
    writeConfig(dir, { "resend": { cdpPort: 9222, backend: "personal" } });
    const result = bindProfileBackendOnOpen("resend", "personal", configPath(dir));
    expect(result.wrote).toBe(false);
    expect(result.backend).toBe("personal");
  });

  it("throws conflict error when profile bound to different backend", () => {
    writeConfig(dir, { "resend": { cdpPort: 9222, backend: "personal" } });
    expect(() =>
      bindProfileBackendOnOpen("resend", "managed", configPath(dir))
    ).toThrow(/bound to backend "personal"/);
    expect(() =>
      bindProfileBackendOnOpen("resend", "managed", configPath(dir))
    ).toThrow(/Cannot switch to "managed"/);
  });

  it("conflict error includes the profile list", () => {
    writeConfig(dir, { "resend": { cdpPort: 9222, backend: "personal" } });
    let caught;
    try { bindProfileBackendOnOpen("resend", "managed", configPath(dir)); }
    catch (e) { caught = e; }
    expect(caught.message).toContain("resend → personal");
  });

  it("returns stored backend when called without --backend and profile already bound", () => {
    writeConfig(dir, { "resend": { cdpPort: 9222, backend: "personal" } });
    const result = bindProfileBackendOnOpen("resend", undefined, configPath(dir));
    expect(result.wrote).toBe(false);
    expect(result.backend).toBe("personal");
  });

  it("returns null backend when called without --backend and profile has no backend", () => {
    writeConfig(dir, { "resend": { cdpPort: 9222 } });
    const result = bindProfileBackendOnOpen("resend", undefined, configPath(dir));
    expect(result.wrote).toBe(false);
    expect(result.backend).toBeNull();
  });

  it("throws on invalid backend value", () => {
    writeConfig(dir, {});
    expect(() =>
      bindProfileBackendOnOpen("resend", "bad-value", configPath(dir))
    ).toThrow(/Invalid backend/);
  });

  it("creates the profile entry if it doesn't exist yet", () => {
    writeConfig(dir, {}); // empty profiles
    bindProfileBackendOnOpen("new-profile", "managed", configPath(dir));
    const cfg = readConfig(dir);
    expect(cfg.browser.profiles["new-profile"].backend).toBe("managed");
  });

  it("preserves existing profile fields when writing backend", () => {
    writeConfig(dir, { "resend": { cdpPort: 9222, browserContextId: "ABC", tabId: "DEF" } });
    bindProfileBackendOnOpen("resend", "personal", configPath(dir));
    const cfg = readConfig(dir);
    expect(cfg.browser.profiles["resend"].cdpPort).toBe(9222);
    expect(cfg.browser.profiles["resend"].browserContextId).toBe("ABC");
    expect(cfg.browser.profiles["resend"].tabId).toBe("DEF");
    expect(cfg.browser.profiles["resend"].backend).toBe("personal");
  });
});

// ---------------------------------------------------------------------------
// injectBackendIntoPayload
// ---------------------------------------------------------------------------

describe("injectBackendIntoPayload", () => {
  let dir;
  beforeEach(() => { dir = tempConfigDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("injects stored backend into payload when payload has no backend", () => {
    writeConfig(dir, { "resend": { cdpPort: 9222, backend: "personal" } });
    const payload = { profile: "resend", url: "https://example.com" };
    injectBackendIntoPayload("resend", payload, configPath(dir));
    expect(payload.backend).toBe("personal");
  });

  it("leaves payload unchanged when profile has no stored backend (compat)", () => {
    writeConfig(dir, { "old-profile": { cdpPort: 9222 } });
    const payload = { profile: "old-profile" };
    injectBackendIntoPayload("old-profile", payload, configPath(dir));
    expect(payload.backend).toBeUndefined();
  });

  it("passes through when payload backend matches stored backend", () => {
    writeConfig(dir, { "resend": { cdpPort: 9222, backend: "personal" } });
    const payload = { profile: "resend", backend: "personal" };
    injectBackendIntoPayload("resend", payload, configPath(dir));
    expect(payload.backend).toBe("personal");
  });

  it("throws conflict when payload backend conflicts with stored backend", () => {
    writeConfig(dir, { "resend": { cdpPort: 9222, backend: "personal" } });
    const payload = { profile: "resend", backend: "managed" };
    expect(() =>
      injectBackendIntoPayload("resend", payload, configPath(dir))
    ).toThrow(/conflicts with profile "resend"/);
  });

  it("conflict error mentions drop --backend suggestion", () => {
    writeConfig(dir, { "resend": { cdpPort: 9222, backend: "personal" } });
    let caught;
    try { injectBackendIntoPayload("resend", { backend: "managed" }, configPath(dir)); }
    catch (e) { caught = e; }
    expect(caught.message).toContain("Drop --backend");
  });

  it("skips injection for the default profile", () => {
    writeConfig(dir, {});
    const payload = {};
    injectBackendIntoPayload("default", payload, configPath(dir));
    expect(payload.backend).toBeUndefined();
  });

  it("skips injection when profileName is undefined", () => {
    writeConfig(dir, {});
    const payload = {};
    injectBackendIntoPayload(undefined, payload, configPath(dir));
    expect(payload.backend).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// annotateProfilesWithBackend
// ---------------------------------------------------------------------------

describe("annotateProfilesWithBackend", () => {
  let dir;
  beforeEach(() => { dir = tempConfigDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("adds backend field to profile objects that have a stored backend", () => {
    writeConfig(dir, {
      "resend": { backend: "personal" },
      "guest-clean": { backend: "managed" },
    });
    const input = [
      { name: "resend", cdpPort: 9222 },
      { name: "guest-clean", cdpPort: 9222 },
    ];
    const result = annotateProfilesWithBackend(input, configPath(dir));
    expect(result[0].backend).toBe("personal");
    expect(result[1].backend).toBe("managed");
  });

  it("adds 'managed' as default for profiles without stored backend", () => {
    writeConfig(dir, { "old": { cdpPort: 9222 } });
    const input = [{ name: "old", cdpPort: 9222 }];
    const result = annotateProfilesWithBackend(input, configPath(dir));
    expect(result[0].backend).toBe("managed");
  });

  it("does not mutate the original array elements", () => {
    writeConfig(dir, { "p": { backend: "personal" } });
    const orig = { name: "p" };
    const input = [orig];
    const result = annotateProfilesWithBackend(input, configPath(dir));
    expect(result[0]).not.toBe(orig);
    expect(orig.backend).toBeUndefined();
  });

  it("returns non-array input unchanged", () => {
    expect(annotateProfilesWithBackend(null)).toBeNull();
    expect(annotateProfilesWithBackend(undefined)).toBeUndefined();
  });

  it("handles profile entries that use 'profile' key instead of 'name'", () => {
    writeConfig(dir, { "resend": { backend: "personal" } });
    const input = [{ profile: "resend", cdpPort: 9222 }];
    const result = annotateProfilesWithBackend(input, configPath(dir));
    expect(result[0].backend).toBe("personal");
  });
});
