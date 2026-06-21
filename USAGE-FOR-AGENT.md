# Using the slim ABR worktree from an agent

13+ commits in, here's what works end-to-end and what's still gated.

## TL;DR — what your agent can do RIGHT NOW

The worktree bridge runs on **HTTP 17347 / WS 17346**. Production bridge on
17337 is untouched. Production worker on 17335 is also untouched (your
existing tooling keeps working).

The user's real Chrome (or any Chrome instance) has the worktree extension
installed (loaded via chrome://extensions → Developer mode → Load unpacked →
`<worktree-dir>/extension`). It auto-connects the worktree bridge as a
browser with a stable `browserInstanceId` (random UUID, persisted in
chrome.storage.local) and a derived `browserDisplayName` like `Windows-<4hex>`.

Agent calls go to `http://127.0.0.1:17347/tool/<name>`. Examples:

```jsonc
// Discover browsers (Claude-in-Chrome-style)
POST /tool/personal_chrome_list_browsers   {}

// Pin subsequent calls to one
POST /tool/personal_chrome_select_browser  {"browser": "Windows-fe8c"}

// Open a URL in a fresh tab
POST /tool/personal_chrome_open
  {"url": "https://target.example", "newTab": true, "active": false}

// Read the page as an indented role tree with stable [ref_N] ids
POST /tool/personal_chrome_read_page  {"maxChars": 8000}
  // -> { pageContent: 'heading "Welcome" [ref_1]\n  button "Sign in" [ref_2]\n...',
  //      url, title, viewport, refCount, elementsScanned, truncated }

// Click an element from read_page output
POST /tool/personal_chrome_click_ref  {"ref": "ref_2"}

// Type, navigate, scroll, screenshot, snapshot — same surface as the
// production bridge (the tools that survived the cut are listed by
// GET /tools on port 17347).
```

For multiple concurrent agents, each session calls `select_browser` once
with the Chrome instance it wants, then all its subsequent calls auto-route
to that browser via the active-browser hint. Other agents pick a different
browser id and don't collide.

## What's already verified live

- **GitHub Dashboard** (logged-in session preserved): 55 refs, ARIA roles
  correct, password fields auto-redact.
- **BBC homepage**: 96 refs, deep nesting (link > image + heading + button)
  correctly indented.
- **example.com → click 'Learn more' → navigated**: end-to-end click_ref.
- **17-assertion smoke** (`node test-multi-browser.mjs` in worktree root):
  multi-browser routing, identity capture, active selector lifecycle.
- **Worker boot**: starts cleanly in personal-only mode on a temp port,
  `/health` returns `ok: true, blockers: []`, 93 tools.

## Agent-self-service isolated Chrome profiles (Step 4h)

The bridge can spawn its own isolated Chrome instances on demand — each one a
real `chrome.exe` process (same fingerprint as your daily Chrome: same UA,
brands, GPU, TLS stack, fonts), but with its own `--user-data-dir` so cookies /
login / history are isolated, and its own `--remote-debugging-port` so
`cdp-traffic-capture` records traffic per profile under
`~/.agent-browser-runtime/cdp-traffic/<name>/` for after-the-fact analysis.

### One-time setup (operator does this once)

Chrome 137+ blocks the `--load-extension` command-line flag, so the bridge
can't auto-install the worktree extension into freshly-spawned Chromes.
Workaround: build a **template** user-data-dir with the extension pre-loaded
via the chrome://extensions GUI, then every `profile_create` copies it.

```powershell
powershell -File <repo-root>\scripts\setup-template-profile.ps1
# Follow the on-screen prompts:
#   - Chrome opens at chrome://extensions
#   - toggle Developer mode → Load unpacked → pick the worktree extension
#   - close the Chrome window
# Template now lives at %USERPROFILE%\abr-chrome\_template
```

After this, every `profile_create` works.

### Tool calls

```jsonc
// Spawn a fresh isolated Chrome for victim-account testing
POST /tool/profile_create  {"name": "victim"}
  // -> { profile, pid, cdpPort, userDataDir, trafficDir,
  //      alreadyRunning, hint }

// See what's spawned + which extensions are connected
POST /tool/profile_list  {}
  // -> { spawned: [{name, pid, port, userDataDir, startedAt}],
  //      connectedBrowsers: [{id, instanceId, displayName}] }

// Now route an open into that profile by its displayName
// (extension reports it on first hello; see personal_chrome_list_browsers).
POST /tool/personal_chrome_open
  {"url": "https://target", "browser": "Windows-<id>", "newTab": true, "active": false}

// Same browser= for read_page / click_ref / etc

// Tear down — kills chrome process, deletes user-data-dir, keeps traffic for analysis
POST /tool/profile_delete  {"name": "victim", "removeData": true}
```

### Isolation guarantees

- **Cookies / login / history**: 100% per profile (separate user-data-dir)
- **Browser fingerprint**: identical to your daily Chrome (same chrome.exe)
- **Traffic record**: per profile under `~/.agent-browser-runtime/cdp-traffic/<name>/`
- **Process**: separate chrome.exe — kill one doesn't touch others or your daily Chrome
- **Bridge view**: each profile shows up in `personal_chrome_list_browsers` as
  a distinct `browserDisplayName` / `browserInstanceId`

### What this replaces

`profile_create` is the personal-only re-implementation of what the old
managed backend used to do automatically (Playwright `launchPersistentContext`
per profile). The shell is ~150 lines vs the deleted 877-line Playwright
wrapper, no fingerprint cost.

---

## What's still gated — traffic / HAR / Source-Map capture

The stripped-down managed backend means there's no Chrome on `cdpPort`
unless the user enables it. Without that, `cdp-traffic-capture` has nothing
to attach to and the deep-evidence tools (network log / HAR export /
sources_list / source_map_*) come back empty.

To enable deep evidence capture, the user starts a dedicated Chrome with
the CDP port open and loads the worktree extension into it:

```powershell
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$dir    = "C:\abr-evidence-chrome"   # isolated profile, NOT the user's daily Chrome

& $chrome `
    --user-data-dir=$dir `
    --remote-debugging-port=9229 `
    --no-first-run --no-default-browser-check `
    "chrome://extensions/"

# In that Chrome window: enable Developer mode, Load unpacked from
# <repo-root>\extension

# Then start the worker pointing at this Chrome's CDP port:
$env:CDP_AGENT_SERVER_PORT = "17348"
$env:CDP_BROWSER_PORT = "9229"
$env:CDP_LAUNCH_BROWSER = "0"
cd <repo-root>
node scripts/agent-cdp-server.mjs
```

The worker attaches to that Chrome's CDP (9229), `cdp-traffic-capture`
sees the real Network domain events, and the extension (running in that
same Chrome) reports its identity to the bridge. Now traffic/HAR/source-map
tools work against the same Chrome the agent is driving.

Until that setup is done, every `personal_chrome_*` tool that doesn't need
deep CDP capture (navigate / read_page / click_ref / screenshot / type /
press / select / scroll / cookies / tabs) works against the user's daily
Chrome via the extension WS path.

## What's gone vs the production worker

Tools removed in this branch (per inventory): 57 of the 153 production
tools (~37%). The deletions cluster:

- All 14 `attack_intruder_*` / `profile_*` business tools (replay, JWT
  forge, OOB, raw/race request, batch replay)
- All 3 `browser_scan_*` security-scanner shim tools
- All 9 managed-only `profile_*` lifecycle tools (create/list/delete/...)
- All 10 `agent-workspace` meta tools (helpers / domain-skills / usage)
- 15 tools replaced by `read_page` / `click_ref` / `chrome_eval`
- 6 facade tools (browser_act / inspect / capture / replay / text /
  security_pack)

These 27 business tools will reappear in helloworld after Step 7 (Pro
worker is producing the migration plan right now). Until then, any agent
flow that needed them runs against the production worker (port 17335)
unchanged.

## Quick health checks

```powershell
# Bridge alive?
Invoke-RestMethod http://127.0.0.1:17347/health

# Which Chromes are connected?
Invoke-RestMethod -Method Post http://127.0.0.1:17347/tool/personal_chrome_list_browsers -Body '{}' -ContentType 'application/json'

# Read this very page
Invoke-RestMethod -Method Post http://127.0.0.1:17347/tool/personal_chrome_read_page -Body '{"maxChars":4000}' -ContentType 'application/json'
```

## Branch state

`slim-abr-raw-cdp` is 14 commits ahead of `main`. main is untouched —
production worker / bridge / extension keep running on the unmodified
codebase. Merge plan: after Step 7 plan lands and the helloworld migration
is complete, this branch fast-forwards to main and the production
deployment swaps over.
