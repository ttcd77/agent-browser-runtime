# Changelog

## 0.4.0 - 2026-06-16

Release-prep pass: full audit, P0 cleanup, open-source readiness.

### Added

- OOB DNS exfiltration mode and HTTP redirect chain mode (wave-10).
- OOB collector default switched to a configurable public HTTPS endpoint (wave-9).
- Profile-to-backend binding with automatic CLI injection, removing sticky
  routing and agent-side backend selection (wave-8a).
- `authed-record` CLI subcommand: SPA crawl + capture + API map + auth classify.
- P1a schema honesty + Excavator scan tools integration (`browser_scan_bridge`,
  `browser_scan_bola`, `browser_scan_status`) — capture-to-corpus bridge plus
  automated horizontal-authorization probing.
- `capture_status` 1M-record count cap.
- Friendly EADDRINUSE error message with port-check commands on startup.

### Changed

- `browser_capture_start` `clear` default reversed from `true` to `false`.
- Bridge listens on `127.0.0.1` by default, overridable via
  `PERSONAL_CHROME_HTTP_HOST` env.
- Release readiness phrase checks aligned with post-wave-7 reality.

### Fixed

- 4 root-cause fixes: SPA smart-wait, personal-404, framePath parsing,
  profile-lock on resume.
- `browser_click` side-effect verification — fixes intermittent no-op (P0).
- `browser_wait` rejects unknown params; `Debugger.pause` timeout fallback (P2).
- `getTraffic` uses `String` normalization for `requestId` matching — fixes
  `request_not_found` when IDs arrive as decimals.
- HTTP/2 pseudo-headers stripped before fetch replay.
- Capture auto-resumes after browser close; open-即-开录 + watchdog.
- Browser selection: Chrome preferred over Edge; `preferredBrowser` hardcoded
  `"CloakBrowser"` no longer misleads.
- 2 zombie-session bugs: `deleteProfile` cleanup hook + `startManagedCapture`
  catch.
- 6-issue audit pass: mutex, `stickyBackend` persistence, body gate, dedup.
- Click fingerprint coverage + unconditional traffic persistence.
- Playwright error catching, file rotation, console listener leak.
- `bodyPromises` drained after snapshot.
- Dangling `browser_fill` refs and MCP dead fields removed.

### Security

- **Path traversal**: closed in `browser_artifact_inspect` (C-02) and scan tool
  target/profile name validation.
- **ReDoS**: guarded in `attack-intruder`; `clickWaitPlan` upper bound clamped.
- **Numeric clamping**: all previously unclamped numeric params clamped
  (waitMs, DOM/screenshot size limits, raw socket `maxResponseBytes` /
  `readTimeoutMs`, capture record count).
- **WebSocket / response caps**: frame cap, response size limit, schema
  validation enforcement (audit F-G).
- **Open-source prep**: personal paths, internal hostnames, and archived
  bounty scripts removed from public branch.

## 0.3.0 - 2026-06-11

Wave-2 through wave-7: tool system consolidation, schema validation, and the
MCP-to-CLI migration.

### Added

- Schema validation layer: `invalid_enum_value` / `missing_required` now
  return HTTP 400 with structured error instead of HTTP 500 (wave-4, M-05).
- `systemd` user units (Linux) and `launchd` LaunchAgents (macOS) install
  scripts for auto-start on login.
- `CONTRIBUTING.md` (173 lines) and `docs/architecture.md` (246 lines).
- 94 new unit tests across 4 previously-untested modules (feedback-notes,
  jwt-forge, oob-client, raw-request with real TCP server).
- 220+ parameter descriptions across 12 tool registration modules.
- 9 enums: `action`, `mode`, `scenario`, `inputMode`, `waitMode`, `state`,
  `direction`, `sort_dir`.
- Persistent text: large snapshots/text dumps saved to files with `filePath`
  + `nextCommand` hints instead of silent truncation (6 sites fixed).

### Changed

- **Breaking (wave-7):** MCP server layer removed entirely. All agent-facing
  tools now exposed via HTTP + CLI only — single exposure surface.
- **Breaking (wave-6):** 20 `devtools_*` tools renamed to `browser_*` prefix;
  `devtools_*` prefix retired.
- `nextCommand` / `suggestedNext` unified to `next` array.
- Deprecated params removed: `forceJs`, `waitFor`, `maxChars`, `maxTextLength`.
- README rewritten: 1,477 lines → 323 lines with vs-Playwright/DevTools-MCP
  comparison, ASCII architecture diagram, Win/Linux/macOS quickstart.
- `package.json` metadata completed (author, repository, bugs, homepage,
  keywords).
- Evidence directory permissions: `0700` (mkdir) / `0600` (writeFile) across
  worker and bridge.
- `.npmignore` added; `rolldown` marked as optional dependency.

### Fixed

- **Security baseline (wave-2):** 156 tools, 3 CRITICAL + 14 HIGH fixed.
  - C-01: default bind `127.0.0.1` + token auth on the worker HTTP server.
  - C-02: `artifact_read` whitelist + override env for `browser_artifact_read`.
  - H-02: `ok` auto-injected on every tool response.
  - H-08: 10 MB body cap on HTTP responses.
  - M-01: DNS rebinding protection.
  - H-04: profile not-found structured errors.
  - H-05: timeout fast-fail.
  - H-13: CDP error cleanup.
- 5-stage tool alias cull: 248 → 156 tools; 92 `devtools_*` aliases removed
  plus all callers updated.
- Windows CI matrix, lint warnings 14 → 0.

### Notes

- 0.3.0 is the first version published from the cleaned public branch after
  removing internal references, dev-loop scripts, and archived bounty data.
- 475 tests passing at release (wave-3); 491 at wave-5.

## 0.2.0 - 2026-05-22

Public work-in-progress release focused on making the runtime a usable product
entrypoint rather than a collection of browser scripts.

### Added

- Unified backend router in the main worker.
- `browser_backend_status` / `devtools_backend_status` for agent-readable
  Managed Browser and Personal Chrome availability.
- `backend`, `personal`, `currentTab`, and `useCurrentTab` routing parameters on
  the `browser_*` facade tools.
- Structured `personal_bridge_unavailable` response when an agent asks for the
  user's Chrome tab but the Personal Chrome bridge is not connected.
- Operator-assisted authentication bootstrap for login flows that require human
  completion, 2FA, passkeys, SSO, or anti-abuse scoring.
- Durable profile resume and live-tab adoption diagnostics for long-running
  agent workflows.
- Local feedback notes and GitHub issue templates for bugs, capability gaps, and
  product friction.

### Notes

- Managed Browser/CDP remains the main professional evidence path.
- Personal Chrome is beta and must be explicitly authorized by the local
  operator.
- The project collects objective browser evidence. It does not classify
  vulnerabilities or assign severity.
