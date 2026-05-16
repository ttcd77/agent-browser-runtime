# Roadmap

## 0.1: Standalone Agent Browser Runtime

- Local HTTP tool server for Codex, Claude, SDKs, and OpenClaw.
- Unified `devtools_*` contract across Personal Chrome and Managed Browser.
- Profile-scoped browser actions: navigate, click, type, eval, screenshot, snapshot.
- Explicit Agent DevTools capture switch: capture is off by default, and the agent
  starts/stops recording when it needs F12-style evidence.
- Profile-scoped traffic and event journals when capture is enabled.
- Default profile support for simple use.
- OpenClaw adapter kept as compatibility layer.
- Product, server, and live browser smoke tests.

## 0.2: F12 Parity

- Network panel: fuller HAR timings, raw socket-level replay edge cases, and
  replay UI. Initiator stack summaries, lifecycle flags, HAR object/file export,
  bounded HAR bodies, browser fetch replay, forbidden-header reporting, and
  raw/form/json/multipart replay helpers are now in the unified tool contract.
- Application panel: Service Worker summaries/detail, CacheStorage summaries/detail,
  and Application JSON export are now in the unified tool contract. Next work is
  deeper cookie partition metadata where exposed.
- Elements panel: same-origin iframe-aware DOM search, forced pseudo-state style
  inspection, Accessibility snapshot, and raw Chrome DOMSnapshot are now in the
  unified tool contract. Next work is deeper iframe element targeting.
- Sources panel: breakpoints, scopes, live debugging, and AST-lossless
  formatting where CDP exposes it. Parsed script listing, source reads, literal
  source search, heuristic pretty-print, and source map metadata are now in the
  unified tool contract.
- Security panel: certificate/security-state summaries from response
  `securityDetails` and CDP security events are now in the unified tool
  contract; next work is UI-level explanation and edge-case coverage.
- Performance panel: Chrome Tracing stream capture, trace screenshot frame
  extraction, trace duration phase summaries, busiest thread/process summaries,
  top duration events, and CPU profiles are now in the unified tool contract.
  Next work is deeper layout/paint flame chart summaries.

## 0.3: Open-Source Polish

- Add release notes and minimal contribution guide.
- Split sensitive evidence examples from public examples.
- Add a small SDK client helper.

## 0.4: Personal Browser Mode

- Improve attach diagnostics for already-running CDP browsers.
- Add an explicit "personal browser" safety prompt or config flag.
- Make it easy to launch a visible debugging browser for private troubleshooting.
- Keep default docs recommending dedicated profiles for target work.

## 0.5: Stronger Isolation

- Optional multi-port browser processes for process-level isolation.
- Per-profile retention and cleanup policies.
- Optional SQLite profile registry and traffic journal.

## 0.6: UI

- Minimal local UI for profile list, profile diagnostics, capture status, and
  common F12 actions is available at `/panel`.
- Human-readable profile names only; hide tab ids and CDP internals from panel
  data.
- Keep SDK/agent APIs as the core product surface.
