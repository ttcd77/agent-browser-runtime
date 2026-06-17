/**
 * profile-backend-binding.mjs
 *
 * Wave-8 "Profile binds backend": read and write the `backend` field in
 * ~/.agent-browser-runtime/browser-profiles.json so every CLI call that
 * carries --profile X automatically knows which backend to use without
 * needing --backend on every invocation.
 *
 * Rules (mirrors the wave-8 spec):
 *   - `default` profile: never writes a backend field (shared context, compat).
 *   - First open with --backend writes the field.
 *   - Subsequent opens without --backend on an already-bound profile: auto-use stored.
 *   - Conflict (stored=A, caller says B): throw with a helpful error listing all profiles.
 *   - Non-open calls with --profile: inject stored backend into payload if backend absent.
 *   - Profile with no backend field: pass through (old compat profile, treated as managed).
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const RUNTIME_DATA_DIR =
  process.env.CDP_SECURITY_DATA_DIR || join(homedir(), ".agent-browser-runtime");

export const VALID_BACKENDS = new Set(["personal", "managed"]);
export const DEFAULT_PROFILE_NAME = "default";

// ---------------------------------------------------------------------------
// Low-level file I/O
// ---------------------------------------------------------------------------

/** Returns the path to browser-profiles.json. */
export function profileConfigFilePath(overridePath) {
  return String(
    overridePath ||
    process.env.CDP_BROWSER_PROFILE_CONFIG ||
    join(RUNTIME_DATA_DIR, "browser-profiles.json"),
  );
}

/** Read the config file; returns { browser: { profiles: {} } } on missing. */
export function readProfileConfig(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8").replace(/^﻿/, "");
    return JSON.parse(raw);
  } catch {
    return { browser: { profiles: {} } };
  }
}

/** Write config back to disk (pretty-printed). */
export function writeProfileConfig(filePath, config) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/** Return the stored backend for a profile, or null if not set. */
export function getStoredBackend(config, profileName) {
  const entry = config?.browser?.profiles?.[profileName];
  if (!entry || !entry.backend) return null;
  return entry.backend;
}

/**
 * Produce a human-readable list of all profiles with their bound backends.
 * Used in error messages.
 */
export function profileBackendListString(config) {
  const profiles = config?.browser?.profiles || {};
  const lines = Object.entries(profiles)
    .filter(([, rec]) => rec?.backend)
    .map(([name, rec]) => `  ${name} → ${rec.backend}`);
  return lines.length ? lines.join("\n") : "  (no profiles have a bound backend yet)";
}

// ---------------------------------------------------------------------------
// Open-time: write backend into profile file
// ---------------------------------------------------------------------------

/**
 * Called when `agent-browser open` runs with --profile X.
 *
 * Behaviour:
 *   - profileName === DEFAULT_PROFILE_NAME: skip (default never gets a backend field).
 *   - backend not provided: if profile has stored backend, fine; if not, fine (no write).
 *   - backend provided:
 *       - profile has no stored backend → write it
 *       - profile has same backend → no-op
 *       - profile has different backend → throw conflict error
 *
 * @param {string} profileName
 * @param {string|undefined} backend  value from --backend flag (may be undefined)
 * @param {string} [configFilePath]   override for tests
 * @returns {{ wrote: boolean, backend: string|null }}
 */
export function bindProfileBackendOnOpen(profileName, backend, configFilePath) {
  if (profileName === DEFAULT_PROFILE_NAME) {
    return { wrote: false, backend: backend || null };
  }

  if (backend && !VALID_BACKENDS.has(backend)) {
    throw new Error(`Invalid backend "${backend}". Must be "personal" or "managed".`);
  }

  const filePath = profileConfigFilePath(configFilePath);
  const config = readProfileConfig(filePath);
  const stored = getStoredBackend(config, profileName);

  if (!backend) {
    // No --backend provided: just return what is stored (may be null).
    return { wrote: false, backend: stored };
  }

  if (stored === null) {
    // First time: write it.
    if (!config.browser) config.browser = {};
    if (!config.browser.profiles) config.browser.profiles = {};
    if (!config.browser.profiles[profileName]) config.browser.profiles[profileName] = {};
    config.browser.profiles[profileName].backend = backend;
    writeProfileConfig(filePath, config);
    return { wrote: true, backend };
  }

  if (stored === backend) {
    // Same backend, no-op.
    return { wrote: false, backend };
  }

  // Conflict.
  const list = profileBackendListString(config);
  throw new Error(
    `Error: Profile "${profileName}" is bound to backend "${stored}". Cannot switch to "${backend}".\n` +
    `Use a different profile name, or delete the profile entry first.\n` +
    `Existing profiles and their backends:\n${list}`,
  );
}

// ---------------------------------------------------------------------------
// Dispatch-time: inject backend into payload for non-open calls
// ---------------------------------------------------------------------------

/**
 * Called before every non-open callTool that has --profile X.
 *
 * If the payload already has `backend` set, validate it against the stored one.
 * If the payload has no `backend`, inject the stored one.
 * If the profile has no stored backend, leave the payload untouched.
 *
 * @param {string|undefined} profileName
 * @param {object} payload  (mutated in place)
 * @param {string} [configFilePath]  override for tests
 * @returns {void}
 */
export function injectBackendIntoPayload(profileName, payload, configFilePath) {
  if (!profileName || profileName === DEFAULT_PROFILE_NAME) return;

  const filePath = profileConfigFilePath(configFilePath);
  const config = readProfileConfig(filePath);
  const stored = getStoredBackend(config, profileName);

  if (!stored) return; // Compat: profile has no backend field, leave payload alone.

  const callerBackend = payload.backend;
  if (!callerBackend) {
    payload.backend = stored;
    return;
  }

  if (callerBackend !== stored) {
    const list = profileBackendListString(config);
    throw new Error(
      `Error: --backend "${callerBackend}" conflicts with profile "${profileName}" (bound to "${stored}").\n` +
      `Drop --backend (CLI will auto-use the profile's backend), or use a different profile.\n` +
      `Existing profiles and their backends:\n${list}`,
    );
  }
  // callerBackend === stored: consistent, pass through.
}

// ---------------------------------------------------------------------------
// Profile list enrichment
// ---------------------------------------------------------------------------

/**
 * Annotate a profiles array (as returned by profile_list) with the backend
 * stored in browser-profiles.json.  Non-destructive: returns a new array.
 *
 * @param {Array<object>} profiles
 * @param {string} [configFilePath]
 * @returns {Array<object>}
 */
export function annotateProfilesWithBackend(profiles, configFilePath) {
  if (!Array.isArray(profiles)) return profiles;
  const filePath = profileConfigFilePath(configFilePath);
  const config = readProfileConfig(filePath);
  return profiles.map((p) => {
    const name = p.name || p.profile;
    if (!name) return p;
    const stored = getStoredBackend(config, name);
    return stored ? { ...p, backend: stored } : { ...p, backend: "managed" }; // default display
  });
}
