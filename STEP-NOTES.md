# slim-abr-raw-cdp branch — step notes

Tracks where Step 4 stopped and what each follow-up needs to unblock.

## Completed

- **Step 1-3** (commit 5349353): multi-browser routing in personal bridge
  (browserInstanceId / browserDisplayName, pickClient by name/id, active hint,
  3 new tools list/select/switch_browser).

- **Step 5** (commit a189b61): read_page DOM walker + click_ref tools,
  Claude-in-Chrome-style. Application-layer click. WeakRef element map per page.

- **Step 4a** (commits 3aae876 / 6ad1a5b): deleted 5 register modules
  (profile-lifecycle / replay-attack / scan / agent-workspace / aliases) plus
  their imports and registration calls in agent-cdp-server.mjs. -1740 lines.

- **Step 4b** (commit 8832fd7): replaced ManagedPlaywrightDriver (877 lines)
  with a 44-line fail-loud stub; dropped Playwright dev dependency; removed
  stealth-scorecard and managed-driver tests. -833 lines on the driver alone.

- **Step 4c** (in progress, DeepSeek Pro background bo2rbwv9q): stripping
  if-managed branches from the 10 remaining register-*.mjs files.

- Real-Chrome E2E verified (commit 2ae7506): read_page on GitHub Dashboard
  (55 refs, logged in), BBC (96 refs), example.com (full click_ref round trip).

## Step 4d — known blockers to address later

### worker boot still requires a CDP browser endpoint

Symptom: `node scripts/agent-cdp-server.mjs` exits with
`Error: browser CDP endpoint is not available: http://127.0.0.1:9229/json/version`
at agent-cdp-server.mjs:287 (`waitForCdp`).

Cause: server startup unconditionally waits for the managed browser's CDP port
to be reachable. With managed gone this never succeeds.

Fix (Step 4e):
- Make `waitForCdp` optional. When CDP_LAUNCH_BROWSER=0 and there is no
  pre-existing CDP browser to attach to, skip the wait and run in
  "personal-only mode" where the worker is a thin HTTP front-end that routes
  every browser tool through the personal bridge.
- Drop `managedBrowserProcessSummary` / `managedCdpPort*` from /health.
- Drop the `managedLaunchRequested` / `relaunchCount` browserProcess block.

Not blocking Step 4c — bridge (personal-chrome-bridge.mjs on 17347/17346) is
the only thing the worktree's smoke / real-Chrome E2E uses, and it runs without
the worker.

### remaining managed deps still injected into register modules

`registerInteractionTools` and the other surviving register modules still
receive `managedPlaywrightDriver` / `withManagedPageClient` / `createBrowserContext`
in their deps object. With the stub in place these injections become no-op
holders — any code path that actually invokes them throws.

After Step 4c removes the if-managed branches, audit the deps object in
agent-cdp-server.mjs and remove fields nothing reads any more. That's Step 4f.

## Step 5b / 6 — pending

After Step 4 completes, delete the 15 tools the inventory says read_page /
click_ref / chrome_eval replace (browser_snapshot / observe / find / text /
click / hover / etc).

## Step 7 — pending

Move the business-logic tools the inventory flags (attack_intruder / jwt_forge /
oob / scan / replay) into helloworld where they belong. ABR keeps only the
runtime + evidence-collection primitives.

## Dev setup notes

To run worktree bridge on isolated ports without colliding with prod:

    cd C:/Users/Tong/project/abr-slim
    ln -s ../agent-browser-runtime/node_modules ./node_modules  # one-time
    ln -s ../agent-browser-runtime/dist ./dist                  # one-time
    PERSONAL_CHROME_HTTP_PORT=17347 PERSONAL_CHROME_WS_PORT=17346 \
      node scripts/personal-chrome-bridge.mjs

To load the worktree extension into a Chrome instance (Chrome 137+ disables
`--load-extension` command-line flag; GUI is required):

    chrome://extensions  →  Developer mode ON  →  Load unpacked
    →  C:/Users/Tong/project/abr-slim/extension

The extension's chrome.storage.local default bridgeUrl is ws://127.0.0.1:17346,
so it auto-connects the worktree bridge. Production extension at
C:/Users/Tong/project/agent-browser-runtime/extension uses ws://127.0.0.1:17336
and is unaffected.
