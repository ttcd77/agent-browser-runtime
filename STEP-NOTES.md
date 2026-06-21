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

## Step 4e — DONE

### worker boot personal-only mode (stub CDP server)

Worker now boots without a real managed Chrome. When the operator passes
`CDP_LAUNCH_BROWSER=0` (no managed launch requested) and no foreign CDP
browser is already listening on `cdpPort`, the boot chain spawns a tiny
HTTP stub on that port that answers just the two DevTools endpoints the
rest of startup probes (`/json/version` returns a fake "ABR-Stub"
identity, `/json/list` returns an empty target array).

Real browser actions still go through the personal bridge in a separate
process (port 17337). The stub never sees them. Verified:

  $ CDP_AGENT_SERVER_PORT=17348 CDP_BROWSER_PORT=9229 CDP_LAUNCH_BROWSER=0 \
      node scripts/agent-cdp-server.mjs
  [agent-cdp-server] personal-only mode: stub CDP server listening on 127.0.0.1:9229
  Agent CDP server ready: http://0.0.0.0:17348

  $ curl http://127.0.0.1:17348/health | jq '.tools | length'
  107

  total tools 153 -> 107 (-46 worker-visible). 25 expected-deleted tools
  (browser_snapshot/find/observe/stuck/text/click/hover/double_click/drag/
   eval/act/inspect/capture/replay/security_pack/capabilities/ready,
   profile_create/list/delete, attack_intruder_create, profile_jwt_forge,
   profile_oob_alloc, browser_token_scan, browser_scan_bridge) all gone.

Two cosmetic blockers remain in /health (`profile-port-drift` warning and
`managedBrowserOwnership.verified: false`) — both are managed-era checks
that produce noise now that the backend is stubbed. Step 4f cleanup
will silence them.

### Expedia is IP-level blocked, not browser-level

Live test against expedia.co.uk via the user's real Chrome (Windows-fe8c,
personal extension, no AutomationControlled flag, no Playwright fingerprint):

  title: "Access Denied"
  refCount: 1 (single heading, nothing else)
  url: https://www.expedia.co.uk/

That is not the "Bot or Not?" / DataDome challenge — that is Akamai edge
denying at TCP/HTTP level before the browser gets to render anything. Worktree
fixes the browser layer (personal real Chrome with real fingerprint), and
that layer is verified working on GitHub Dashboard / BBC / example.com.
But Expedia's specific IP reputation is burnt across the whole group
(expedia / vrbo / cheaptickets / hotwire) — any browser from this IP gets
edge-denied.

ABR cannot fix this layer. Resolution paths:
  A. switch egress IP (mobile hotspot or UK residential proxy — NOT VPS IP)
  B. wait out reputation (days to weeks, Akamai doesn't publish)
  C. drop Expedia from active targets

### Step 4i — traffic body capture on spawned profiles (incomplete)

Plugin auto-activate fix (commit 712abe5 + this commit) successfully:
  - re-reads browser-profiles.json each 5s reconnect tick
  - detects new backend:"personal-spawn" entries (added by bridge's
    profile_create) and auto-activates them
  - attaches CDP session to the spawned chrome's --remote-debugging-port

Live evidence (worker log):
  [cdp-traffic] loaded 204 profiles  (was 203, new entry appeared)
  [cdp-traffic] traffic-test: activated (lazy attach on first use)
  [cdp-traffic] traffic-test: Target.setAutoAttach enabled (flatten=true)
  [cdp-traffic] traffic-test:9300 attached to 1 page(s)

BUT: cdp-traffic/<name>/ directory never gets created and no body files
land on disk. Navigation was driven both as newTab:true and newTab:false
with multi-second waits — no bodies.

Hypothesis (not yet verified): chrome.tabs.update navigation on the
attached page may dispatch Network events on a sessionId routing path
the plugin's top-level c.Network.X handlers don't see. Plugin has
enableChildSession() for OOPIF child targets but the navigation in
the original tab may need similar treatment, or the loadingFinished →
getResponseBody chain silently fails.

Fix path: add debug logging around getResponseBody / writeFile, run a
spawn cycle, see which step actually fails. May need to call
enableChildSession on the navigated page's sessionId. ~30 min debug.

Workaround until fixed: agent can spawn a profile and operate it
(read_page / click_ref / cookies / tabs all work), traffic-capture
metadata (URLs, status codes, headers) is still recorded in-memory and
queryable via profile_traffic_query — only the per-request body files
on disk are missing.

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
