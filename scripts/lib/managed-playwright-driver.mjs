// MANAGED BACKEND STUB — replaces the 877-line Playwright-driven driver.
//
// Step 4b of the slim-abr-raw-cdp branch: cuts the managed backend entirely.
// All browser actions now route via the personal Chrome extension over the
// bridge WS. The full driver lived in this file historically (Playwright +
// chromium.launchPersistentContext + ~30 async action methods). It is gone.
//
// We keep the two named exports the rest of the codebase imports so a
// production worker still boots; calling any method throws loudly so we
// find and fix the caller instead of silently degrading. Construction
// itself does NOT throw — caller chains that just inject the driver into
// `deps` keep working until they actually try to drive a managed browser.

class StubManagedDriver {}

const stubHandler = {
  get(target, prop) {
    // Standard JS / Node introspection probes — return undefined cleanly,
    // do NOT throw. (then=undefined so the proxy isn't accidentally awaited.)
    if (prop === "then" || prop === "constructor" || typeof prop === "symbol") {
      return undefined;
    }
    // Anything else: a stub method that fails loud on call.
    return function stubMethod() {
      throw new Error(
        `managed backend removed in slim-abr-raw-cdp — '${String(prop)}' is unavailable. ` +
        `Route via the personal Chrome extension (use browser_*/personal_chrome_* tools, ` +
        `select target browser with personal_chrome_select_browser).`
      );
    };
  },
};

export class ManagedPlaywrightDriver {
  constructor(_options = {}) {
    return new Proxy(new StubManagedDriver(), stubHandler);
  }
}

// hideChromeWindow used to push the managed browser window to the back of the
// z-order. With managed gone, no window to hide — no-op.
export function hideChromeWindow(_userDataDir) {
  /* no-op: managed backend removed */
}
