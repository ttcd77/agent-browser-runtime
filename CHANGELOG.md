# Changelog

## 0.5.0 - 2026-06-21 — slim refactor + attack-harness

24 commits removing the Playwright managed wrapper, adding real-Chrome spawn,
read_page / click_ref DOM walker, multi-browser routing, and (in companion
helloworld repo) an attack-harness CLI for composable attack scripting.

### Added

- **`spawn-chrome-profile.mjs`** (~150 lines, replaces deleted 877-line
  Playwright wrapper): `profile_create / list / delete` tools spawn isolated
  real `chrome.exe` processes via `--user-data-dir` + `--remote-debugging-port`.
  Each profile gets identical-to-daily-Chrome fingerprint (no Playwright
  AutomationControlled flag) plus its own cookies/login/history. Template-copy
  install bypasses Chrome 137+'s `--load-extension` ban via one-time
  `setup-template-profile.ps1`.
- **`personal_chrome_list_browsers / select_browser / switch_browser`** tools
  (mirrors Claude-in-Chrome MCP surface): bridge tracks multiple connected
  Chrome instances by `browserInstanceId` + `browserDisplayName`, routes by
  human-readable name; `active` selector lets agent select once and have
  subsequent calls auto-route.
- **`personal_chrome_read_page` + `personal_chrome_click_ref`** (Claude-in-Chrome
  pattern): DOM walker returns indented ARIA-role tree with stable `[ref_N]`
  ids; `click_ref` uses application-layer `element.click()` (proven stable in
  SPAs without Playwright-style actionability).
- **Per-spawned-profile traffic capture on disk**: `cdp-traffic-capture`
  plugin auto-attaches `personal-spawn` backend profiles via
  `browser-profiles.json` watch (1s tick); writes bodies under
  `~/.agent-browser-runtime/cdp-traffic/<name>/`. Verified end-to-end:
  example.com nav produces 7 body files (HTML / JS / CSS / font / XML / favicon).
- **Per-agent tab isolation** in personal bridge: profile param auto-pins a
  dedicated background tab so multiple agents don't fight over the human's
  active tab. Bridge ports configurable via `PERSONAL_CHROME_HTTP_PORT` /
  `PERSONAL_CHROME_WS_PORT`.
- **`profile_jwt_forge` upgraded to attack-variant generator** (BREAKING):
  one call now returns all 6 standard JWT-bypass attack candidates
  (alg=none / weak-secret / hs-confusion / kid-injection / jku-spoof /
  x5u-spoof) from a sample token + mutations. Schema changed from
  `{payload, alg, key}` to `{token, attacks, mutations, ...}`. Implementation
  moved to helloworld `attack-harness/src/attack_harness/crypto.py` (Python),
  ABR tool becomes a subprocess proxy.
- **14 business tools proxied to helloworld attack-harness** via subprocess
  spawn — single source of truth in Python: `profile_raw_request`,
  `profile_race_request`, `profile_jwt_forge`, `profile_oob_alloc`,
  `profile_oob_poll`, `profile_request_replay(_batch)`,
  `attack_intruder_create/run/pause/resume/results/status/evidence`.
- `STEP-NOTES.md` and `USAGE-FOR-AGENT.md` for the worktree refactor history
  and current agent-facing tool catalog with examples.

### Removed

- **Playwright** devDependency (the 877-line
  `scripts/lib/managed-playwright-driver.mjs` wrapper is a 44-line fail-loud
  stub; production worker now spawns real `chrome.exe` via
  `spawn-chrome-profile.mjs` instead).
- **9 managed-only profile-lifecycle tools** (superseded by new
  `profile_create / list / delete` in bridge). Net tool count 163 → 155.
- `stealth-scorecard.mjs` and `stealth-config.test.mjs` (managed-driver
  regression guards; managed driver no longer exists).
- `register-aliases.mjs` (already a stub since F4 cleanup).

### Changed

- Worker `/health`: in personal-only mode (`CDP_LAUNCH_BROWSER=0`) the
  `profile-port-drift` and `foreign-browser-on-cdp-port` blockers are
  suppressed (they were managed-era checks). Stub CDP server on configured
  port lets boot chain (`waitForCdp` / `cdpJson` / `targetWatcher`) satisfy
  without an actual Chrome.
- Default backend routing in `resolveBackendForCall`: when
  `CDP_LAUNCH_BROWSER=0` and no sticky backend matches, default is `personal`
  not `managed` (previously would route to stub and throw).
- `browser_tabs` output: stale profiles auto-truncated to the 5
  most-recently-used with `staleProfilesOmitted` count; `includeStale:true`
  for the full list (was: 347 stale profiles flat).
- `cdp-traffic-capture` reconnect tick 5s → 1s; tracks
  `connectedTargetIds` so new tabs discovered after initial attach;
  `loadingFinished` handler now passes `sessionId` to `getResponseBody`.
- `setup-template-profile.ps1`: one-time operator setup to GUI-install the
  worktree extension into a template `--user-data-dir`; every
  `profile_create` thereafter `cpSync(template, new_profile_dir)` (Chrome
  137+ blocks command-line `--load-extension`).

### Migration

- Agents calling `profile_jwt_forge` with the old `{payload, alg, key}`
  schema must migrate to `{token, attacks, mutations, ...}`. The new API
  produces a richer result (variants list) but requires an existing sample
  JWT as input (use any token from the target).
- Agents that depended on the 9 managed-only `profile_*` lifecycle tools
  (`profile_create` etc, old managed-Playwright version) get a new but
  equivalent implementation via the bridge's `profile_create` (spawn-based).
  Schema for spawn-based is `{name}`; returns `{profile, pid, cdpPort,
  userDataDir, trafficDir, alreadyRunning}`.
- See `STEP-NOTES.md` + `USAGE-FOR-AGENT.md` for the full agent-facing flow
  examples (template setup, profile spawn, read_page + click_ref, multi-browser
  routing, traffic body retrieval).

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
