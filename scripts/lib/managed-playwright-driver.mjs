import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { normalizeProfileName } from "./result-format.mjs";

// ── Minimize helpers ──────────────────────────────────────────────────
let _minimizeEnabled = null;
function minimizeEnabled() {
  if (_minimizeEnabled !== null) return _minimizeEnabled;
  _minimizeEnabled = process.env.CDP_BROWSER_START_MINIMIZED !== "0";
  return _minimizeEnabled;
}

// Install with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1. Runtime drives the locally
// installed real browser channel, not Playwright's bundled Chromium.
//
// Default is Google Chrome (stable). Its navigator.userAgentData advertises a
// coherent "Google Chrome" brand, which anti-bot WAFs (e.g. AWS WAF) expect.
// The previous "msedge" default advertised a "Microsoft Edge" brand
// that mismatches a Chrome-shaped UA string and got flagged as a red signal.
// Override per machine/target with ABR_PLAYWRIGHT_CHANNEL=chrome|msedge|chrome-beta.
const PLAYWRIGHT_CHANNEL = process.env.ABR_PLAYWRIGHT_CHANNEL || "chrome";
// --start-maximized + viewport:null (set at launch) make the page report the
// real OS window size. Without it Playwright pins a 1280x720 viewport, a known
// automation tell that bot.sannysoft / rebrowser and WAF challenges flag.
// NOTE: --disable-blink-features=AutomationControlled is REQUIRED to keep
// navigator.webdriver=false on this Chrome+Playwright combo. Removing it (even
// with ignoreDefaultArgs:['--enable-automation']) flips webdriver=true — proven
// red by stealth-scorecard 2026-06-06. The flag triggers a LOCAL "unsupported
// command-line flag" infobar, but that is cosmetic: the page/WAF cannot see it.
// Do NOT remove it to hide the banner — you would re-expose the automation tell.
// Auto-detect secondary monitor bounds at first use
let _secondaryMonitor = null;
function secondaryMonitor() {
  if (_secondaryMonitor) return _secondaryMonitor;
  if (process.env.CDP_BROWSER_SECONDARY_X) {
    _secondaryMonitor = {
      x: Number(process.env.CDP_BROWSER_SECONDARY_X),
      y: Number(process.env.CDP_BROWSER_SECONDARY_Y) || 0,
      w: Number(process.env.CDP_BROWSER_SECONDARY_W) || 1920,
      h: Number(process.env.CDP_BROWSER_SECONDARY_H) || 1080,
    };
    return _secondaryMonitor;
  }
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary } | ForEach-Object { $_.Bounds.X; $_.Bounds.Y; $_.Bounds.Width; $_.Bounds.Height }"`,
      { timeout: 3000, windowsHide: true },
    ).toString().trim();
    if (out) {
      const [x, y, w, h] = out.split(/\r?\n/).map(Number);
      _secondaryMonitor = { x: x || 3440, y: y || 0, w: w || 1920, h: h || 1080 };
      return _secondaryMonitor;
    }
  } catch { /* fall through */ }
  _secondaryMonitor = { x: 3440, y: 0, w: 1920, h: 1080 };
  return _secondaryMonitor;
}

function playwrightArgs() {
  const base = ["--disable-blink-features=AutomationControlled"];
  if (minimizeEnabled()) {
    const sm = secondaryMonitor();
    // Top-right corner of secondary monitor (sm.x + sm.w - 480, 0).
    // Small window, doesn't steal focus, doesn't cover the user's work.
    const rightX = sm.x + sm.w - 480;
    return [...base, `--window-position=${rightX},0`, "--window-size=480,360"];
  }
  return [...base, "--start-maximized"];
}

function actionTimeoutMs(params = {}, fallback = 8000) {
  const raw = params.actionTimeoutMs ?? params.timeoutMs;
  if (raw === undefined || raw === null || raw === true) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(30_000, value));
}

function waitTimeoutMs(params = {}, fallback = 10_000) {
  const raw = params.timeoutMs ?? params.actionTimeoutMs;
  if (raw === undefined || raw === null || raw === true) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(60_000, value));
}

function normalizeKeyboardShortcut(raw) {
  return String(raw || "")
    .split("+")
    .map((part) => {
      const token = part.trim();
      const lower = token.toLowerCase();
      if (lower === "ctrl") return "Control";
      if (lower === "cmd" || lower === "command" || lower === "win" || lower === "windows") return "Meta";
      if (lower === "esc") return "Escape";
      if (lower === "return") return "Enter";
      if (lower === "del") return "Delete";
      if (lower === "space") return "Space";
      if (lower === "up") return "ArrowUp";
      if (lower === "down") return "ArrowDown";
      if (lower === "left") return "ArrowLeft";
      if (lower === "right") return "ArrowRight";
      return token;
    })
    .filter(Boolean)
    .join("+");
}

function locatorMode(params = {}) {
  return params.selector ? "selector" : "text";
}

function encodeProfileForPath(name) {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function createCdpClient(session) {
  const domains = new Map();
  const base = {
    send(method, params = {}) {
      return session.send(method, params && typeof params === "object" ? params : {});
    },
    async close() {
      await session.detach().catch(() => {});
    },
    // EventEmitter forwarding — CDPSession IS an EventEmitter but Proxy hides it
    on: session.on.bind(session),
    once: session.once.bind(session),
    off: (session.off ?? session.removeListener)?.bind(session),
    removeListener: (session.removeListener ?? session.off)?.bind(session),
    addListener: (session.addListener ?? session.on)?.bind(session),
    emit: session.emit?.bind(session),
  };
  return new Proxy(base, {
    get(target, property) {
      if (property in target) return target[property];
      if (typeof property !== "string") return undefined;
      if (!domains.has(property)) {
        domains.set(property, new Proxy({}, {
          get(_domainTarget, methodProperty) {
            if (typeof methodProperty !== "string") return undefined;
            return (...args) => {
              if (args.length === 1 && typeof args[0] === "function") {
                const eventName = `${property}.${methodProperty}`;
                const handler = args[0];
                session.on(eventName, handler);
                return () => {
                  if (typeof session.off === "function") session.off(eventName, handler);
                  else if (typeof session.removeListener === "function") session.removeListener(eventName, handler);
                };
              }
              return session.send(`${property}.${methodProperty}`, args[0] || {});
            };
          },
        }));
      }
      return domains.get(property);
    },
  });
}

export class ManagedPlaywrightDriver {
  // Per-profile serialization: each profile has a promise chain that queues
  // operations to prevent concurrent Playwright calls on the same page handle.
  #profileLocks = new Map();

  constructor({ userDataRoot }) {
    if (!userDataRoot) throw new Error("ManagedPlaywrightDriver requires userDataRoot");
    this.userDataRoot = userDataRoot;
    this.contexts = new Map();
    this.playwrightPromise = null;
  }

  withProfileLock(profileName, fn) {
    const previous = this.#profileLocks.get(profileName) ?? Promise.resolve();
    const next = previous.then(
      () => fn(),
      (prevErr) => {
        console.warn(`[profile-lock] ${profileName}: previous operation failed, running next anyway:`, prevErr?.message || prevErr);
        return fn();
      },
    );
    // Store only a non-rejecting reference so the chain never gets "stuck"
    this.#profileLocks.set(profileName, next.then(() => {}, () => {}));
    return next;
  }

  async loadPlaywright() {
    if (!this.playwrightPromise) {
      this.playwrightPromise = import("playwright").catch((error) => {
        this.playwrightPromise = null;
        // E3.1: CDP_BROWSER_DRIVER env var no longer gates engine selection (engine-collapse);
        // ManagedPlaywrightDriver is always constructed regardless of that env var.
        // This error means the 'playwright' npm package itself failed to import.
        throw new Error(`playwright package failed to load (ensure 'playwright' is installed — CDP_BROWSER_DRIVER env var no longer selects engines): ${error?.message || error}`);
      });
    }
    return await this.playwrightPromise;
  }

  userDataDir(profileName) {
    return join(this.userDataRoot, encodeProfileForPath(profileName));
  }

  async ensurePage(rawProfileName) {
    const profileName = normalizeProfileName(rawProfileName);
    let entry = this.contexts.get(profileName);
    if (!entry || entry.context.pages().every((page) => page.isClosed())) {
      const { chromium } = await this.loadPlaywright();
      const userDataDir = this.userDataDir(profileName);
      mkdirSync(userDataDir, { recursive: true });
      const context = await chromium.launchPersistentContext(userDataDir, {
        channel: PLAYWRIGHT_CHANNEL,
        headless: false,
        args: playwrightArgs(),
        chromiumSandbox: true,
        viewport: null,
      });
      entry = { context, userDataDir };
      this.contexts.set(profileName, entry);
        // Auto-hide after creation: push window behind all others.
      if (minimizeEnabled()) hideChromeWindow(userDataDir);
    }
    const pages = entry.context.pages().filter((candidate) => !candidate.isClosed());
    // Keep the first real page; close only about:blank / newtab leftovers.
    // Previously ALL extra pages were unconditionally closed, which destroyed
    // tabs the agent had open for multi-step workflows. Now only clean up the
    // truly empty ones.
    let page = pages.find((candidate) => {
      const url = candidate.url();
      return url && url !== "about:blank" && url !== "edge://newtab/" && url !== "chrome://newtab/";
    }) || pages[0];
    if (!page) page = await entry.context.newPage();
    for (const extra of pages) {
      if (extra !== page) {
        const url = extra.url();
        if (url === "about:blank" || url === "edge://newtab/" || url === "chrome://newtab/") {
          await extra.close().catch(() => {});
        }
        // Real pages with content are NOT closed — the agent may need them.
      }
    }
    return {
      profile: profileName,
      context: entry.context,
      page,
      userDataDir: entry.userDataDir,
      tabId: `playwright:${profileName}`,
    };
  }

  // Resolve the root that selector/text are queried against. With no frame
  // params this is the page itself (top-level, auto-piercing open shadow DOM).
  // With framePath (CSS path to an iframe, possibly nested) or frameIndexes
  // (array of iframe indices) it descends into the target iframe via Playwright
  // frameLocator chaining. Page and FrameLocator share .locator()/.getByText(),
  // so the caller resolves the element the same way on either root.
  frameScope(page, params = {}) {
    if (Array.isArray(params.frameIndexes) && params.frameIndexes.length) {
      let scope = null;
      for (const raw of params.frameIndexes) {
        const index = Number(raw);
        if (!Number.isInteger(index) || index < 0) {
          throw new Error("frameIndexes must be non-negative integers");
        }
        scope = (scope || page).frameLocator("iframe").nth(index);
      }
      return scope;
    }
    if (params.framePath) {
      try {
        return page.frameLocator(String(params.framePath));
      } catch (err) {
        throw new Error(
          `framePath '${params.framePath}' is not a valid iframe selector: ${err.message}. ` +
          `framePath must be a CSS selector matching an <iframe> element (e.g. 'iframe#chat', ` +
          `'iframe[src*="example.com"]'). For nth-frame access use frameIndexes: [0] instead.`
        );
      }
    }
    return page;
  }

  locator(page, params = {}) {
    const scope = this.frameScope(page, params);
    if (params.selector) return scope.locator(String(params.selector)).first();
    if (params.text) return scope.getByText(String(params.text), { exact: false }).first();
    throw new Error("selector or text is required");
  }

  async openCdpClient(profileName) {
    const handle = await this.ensurePage(profileName);
    const session = await handle.context.newCDPSession(handle.page);
    const client = createCdpClient(session);
    await client.Emulation.setFocusEmulationEnabled({ enabled: true }).catch(() => {});
    return { client, handle };
  }

  async withCdpClient(profileName, fn) {
    return this.withProfileLock(profileName, async () => {
      const { client, handle } = await this.openCdpClient(profileName);
      try {
        return await fn(client, handle);
      } finally {
        await client.close();
      }
    });
  }

  async open(profileName, params = {}) {
    const handle = await this.ensurePage(profileName);
    if (params.url) {
      try {
        await this.navigate(profileName, params);
      } catch (err) {
        // Navigate failures are normal in pentesting (rate limits, WAF, captchas).
        // Do NOT close the profile context — that destroys session cookies and
        // forces a full browser relaunch on next retry, producing the "open, close,
        // open, close" loop. Instead, just clean up only stale about:blank pages.
        const pages = handle.context.pages().filter((candidate) => !candidate.isClosed());
        for (const p of pages) {
          const url = p.url();
          if (url === "about:blank" || url === "edge://newtab/" || url === "chrome://newtab/") {
            await p.close().catch(() => {});
          }
        }
        throw err;
      }
    }
    return await this.pageSummary(handle);
  }

  async navigate(profileName, params = {}) {
    const handle = await this.ensurePage(profileName);
    const url = String(params.url || "");
    if (!/^https?:\/\//i.test(url) && !/^data:/i.test(url) && url !== "about:blank") {
      throw new Error("url must start with http://, https://, data:, or about:blank");
    }
    await handle.page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: actionTimeoutMs(params, 30_000),
    });
    return await this.pageSummary(handle);
  }

  async click(profileName, params = {}) {
    const handle = await this.ensurePage(profileName);
    const timeout = actionTimeoutMs(params);
    const isCoordMode = typeof params.x === "number" && typeof params.y === "number";

    // --- DOM fingerprint helper (runs in browser context) ---
    const fingerprintPage = () => handle.page.evaluate(() => {
      function simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
          hash = ((hash << 5) - hash) + str.charCodeAt(i);
          hash |= 0;
        }
        return Math.abs(hash).toString(36);
      }
      const bodyText = document.body?.innerText ?? "";
      // Hash up to 8000 chars (was 500) to catch changes below the fold.
      // domCount detects React re-renders that mutate DOM structure but keep text.
      return {
        url: window.location.href,
        historyLength: window.history.length,
        bodyHash: bodyText.length + ":" + simpleHash(bodyText.slice(0, 8000)),
        domCount: document.querySelectorAll("*").length,
      };
    });

    // --- Pre-click fingerprint ---
    const beforePage = await fingerprintPage();
    let locator = null;
    let targetBeforeHtml = null;
    if (!isCoordMode) {
      locator = this.locator(handle.page, params);
      targetBeforeHtml = await locator.evaluate((el) => (el.outerHTML || "").slice(0, 200)).catch(() => null);
    }

    // --- Perform the click (existing strategy unchanged) ---
    if (isCoordMode) {
      await handle.page.mouse.click(params.x, params.y);
    } else if (params.forceJs || String(params.inputMode || "").toLowerCase() === "dom") {
      await locator.waitFor({ state: "attached", timeout });
      await locator.evaluate((element) => element.click());
    } else {
      await locator.click({ timeout });
    }

    // --- Wait for SPA/React reaction ---
    await new Promise((resolve) => setTimeout(resolve, 150));

    // --- Post-click fingerprint ---
    const afterPage = await fingerprintPage();
    let targetVanished = false;
    let targetDisabled = false;
    let targetAfterHtml = null;
    if (!isCoordMode) {
      try {
        // locator.evaluate(fn, arg) — Playwright has no timeout option on this
        // API (timeout lives on actions like .click/.fill); a second positional
        // arg would be silently passed to fn instead of being honored. Errors
        // when the element has already detached are caught into null/false.
        targetAfterHtml = await locator.evaluate((el) => (el.outerHTML || "").slice(0, 200)).catch(() => null);
        if (targetAfterHtml === null) {
          targetVanished = true;
        } else {
          targetDisabled = await locator.evaluate((el) => el.disabled === true || el.getAttribute("disabled") !== null).catch(() => false);
        }
      } catch {
        targetVanished = true;
      }
    }

    // --- Determine whether click produced observable side effects ---
    const urlChanged = afterPage.url !== beforePage.url;
    const historyChanged = afterPage.historyLength !== beforePage.historyLength;
    const bodyChanged = afterPage.bodyHash !== beforePage.bodyHash;
    const domCountChanged = afterPage.domCount !== beforePage.domCount;
    const targetTextChanged = !isCoordMode && targetBeforeHtml !== null && targetAfterHtml !== null && targetBeforeHtml !== targetAfterHtml;
    const effective = urlChanged || historyChanged || bodyChanged || domCountChanged || targetVanished || targetDisabled || targetTextChanged;

    const result = {
      ...(await this.pageSummary(handle)),
      ok: true,
      mode: isCoordMode ? "coordinates" : (params.selector ? "selector" : "text"),
      inputMode: "playwright",
      effective,
      effectVerdict: effective ? "side-effect-detected" : "no-side-effect-detected",
      evidence: {
        beforeUrl: beforePage.url,
        afterUrl: afterPage.url,
        beforeBodyHash: beforePage.bodyHash,
        afterBodyHash: afterPage.bodyHash,
        beforeHistoryLength: beforePage.historyLength,
        afterHistoryLength: afterPage.historyLength,
        beforeDomCount: beforePage.domCount,
        afterDomCount: afterPage.domCount,
        domCountChanged,
        targetVanished: isCoordMode ? undefined : targetVanished,
        targetDisabled: isCoordMode ? undefined : targetDisabled,
        targetBeforeHtml: isCoordMode ? undefined : targetBeforeHtml,
        targetAfterHtml: isCoordMode ? undefined : targetAfterHtml,
      },
    };
    if (isCoordMode) {
      result.x = params.x;
      result.y = params.y;
    }
    return result;
  }

  async hover(profileName, params = {}) {
    const handle = await this.ensurePage(profileName);
    const timeout = actionTimeoutMs(params, 3000);
    if (typeof params.x === "number" && typeof params.y === "number") {
      await handle.page.mouse.move(params.x, params.y);
      return { ...(await this.pageSummary(handle)), ok: true, mode: "coordinates", inputMode: "playwright", x: params.x, y: params.y };
    }
    await this.locator(handle.page, params).hover({ timeout });
    return { ...(await this.pageSummary(handle)), ok: true, mode: locatorMode(params), inputMode: "playwright", selector: params.selector || null, text: params.text || null };
  }

  async doubleClick(profileName, params = {}) {
    const handle = await this.ensurePage(profileName);
    const timeout = actionTimeoutMs(params, 3000);
    if (typeof params.x === "number" && typeof params.y === "number") {
      await handle.page.mouse.dblclick(params.x, params.y);
      return { ...(await this.pageSummary(handle)), ok: true, mode: "coordinates", inputMode: "playwright", x: params.x, y: params.y };
    }
    await this.locator(handle.page, params).dblclick({ timeout });
    return { ...(await this.pageSummary(handle)), ok: true, mode: locatorMode(params), inputMode: "playwright", selector: params.selector || null, text: params.text || null };
  }

  async drag(profileName, params = {}) {
    const handle = await this.ensurePage(profileName);
    const timeout = actionTimeoutMs(params, 3000);
    const targetSelector = params.targetSelector || params.toSelector;
    const targetText = params.targetText || params.toText;
    const hasSourcePoint = typeof params.x === "number" && typeof params.y === "number";
    const hasTargetPoint = typeof params.toX === "number" && typeof params.toY === "number";
    const hasDelta = typeof params.deltaX === "number" || typeof params.deltaY === "number";

    if (!hasSourcePoint && (targetSelector || targetText)) {
      const source = this.locator(handle.page, params);
      const target = this.locator(handle.page, {
        selector: targetSelector,
        text: targetText,
        framePath: params.targetFramePath,
        frameIndexes: params.targetFrameIndexes,
      });
      await source.dragTo(target, { timeout });
      return {
        ...(await this.pageSummary(handle)),
        ok: true,
        mode: "locator",
        inputMode: "playwright",
        selector: params.selector || null,
        text: params.text || null,
        targetSelector: targetSelector || null,
        targetText: targetText || null,
      };
    }

    let start = hasSourcePoint ? { x: params.x, y: params.y } : null;
    if (!start) {
      const box = await this.locator(handle.page, params).boundingBox({ timeout });
      if (!box) throw new Error("source locator is not visible");
      start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }

    let end = hasTargetPoint ? { x: params.toX, y: params.toY } : null;
    if (!end && hasDelta) end = { x: start.x + Number(params.deltaX || 0), y: start.y + Number(params.deltaY || 0) };
    if (!end) throw new Error("targetSelector/targetText, toX/toY, or deltaX/deltaY is required");

    await handle.page.mouse.move(start.x, start.y);
    await handle.page.mouse.down();
    await handle.page.mouse.move(end.x, end.y, { steps: Math.max(1, Number(params.steps || 10)) });
    await handle.page.mouse.up();
    return { ...(await this.pageSummary(handle)), ok: true, mode: "coordinates", inputMode: "playwright", source: start, target: end };
  }

  async press(profileName, params = {}) {
    const handle = await this.ensurePage(profileName);
    const timeout = actionTimeoutMs(params, 3000);
    const key = normalizeKeyboardShortcut(params.key || params.combo);
    if (!key) throw new Error("browser_press requires key or combo");
    if (params.selector || params.text) {
      await this.locator(handle.page, params).focus({ timeout });
    }
    await handle.page.keyboard.press(key);
    return { ...(await this.pageSummary(handle)), ok: true, inputMode: "playwright", key, selector: params.selector || null, text: params.text || null };
  }

  async select(profileName, params = {}) {
    const handle = await this.ensurePage(profileName);
    const locator = this.locator(handle.page, params);
    const timeout = actionTimeoutMs(params, 3000);
    const control = await locator.evaluate((element) => ({
      tag: String(element.tagName || "").toLowerCase(),
      type: String(element.type || "").toLowerCase(),
      checked: "checked" in element ? Boolean(element.checked) : null,
    }));
    if (control.tag === "select") {
      const option =
        params.value != null ? { value: String(params.value) }
        : params.label != null ? { label: String(params.label) }
        : typeof params.index === "number" ? { index: params.index }
        : null;
      if (!option) throw new Error("browser_select requires value, label, or index for select controls");
      const selected = await locator.selectOption(option, { timeout });
      return { ...(await this.pageSummary(handle)), ok: true, inputMode: "playwright", selector: params.selector || null, control: "select", value: selected[0] || "" };
    }
    if (control.type === "checkbox" || control.type === "radio") {
      const checked = params.checked !== false;
      if (checked) await locator.check({ timeout });
      else await locator.uncheck({ timeout });
      const value = await locator.evaluate((element) => ({ checked: Boolean(element.checked), value: element.value || "" }));
      return { ...(await this.pageSummary(handle)), ok: true, inputMode: "playwright", selector: params.selector || null, control: control.type, ...value };
    }
    throw new Error(`unsupported_control: ${control.tag || "unknown"} ${control.type || ""}`.trim());
  }

  async wait(profileName, params = {}, options = {}) {
    const handle = await this.ensurePage(profileName);
    const timeoutMs = waitTimeoutMs(params);
    const pollMs = Math.max(25, Number(params.pollMs || 250));
    const state = String(params.state || "visible").toLowerCase();
    const startedAt = Date.now();
    const condition = {
      selector: params.selector ? String(params.selector) : "",
      text: params.text ? String(params.text) : "",
      urlContains: params.urlContains ? String(params.urlContains) : "",
      requestUrlContains: params.requestUrlContains ? String(params.requestUrlContains) : "",
      requestMethod: params.requestMethod ? String(params.requestMethod).toUpperCase() : "",
      requestStatus: typeof params.requestStatus === "number" ? params.requestStatus : null,
      state,
    };

    let observation = null;
    const locatorState = ["attached", "detached", "hidden", "visible"].includes(state) ? state : "visible";
    const nativeWaitStartedAt = Date.now();
    if (condition.selector) {
      await handle.page.locator(condition.selector).first().waitFor({ state: locatorState, timeout: timeoutMs }).catch((err) => {
        // Native waitFor timed out or errored — log a warning so the agent knows the
        // selector was not found during the fast-path wait. The polling loop below will
        // do a final check and return ok:false / timeout if the condition is still unmet.
        process.stderr.write(`[managed-playwright] waitFor selector timed out (selector="${condition.selector}" state=${locatorState} timeout=${timeoutMs}ms): ${err?.message || err}\n`);
      });
    }
    if (condition.text && Date.now() - nativeWaitStartedAt < timeoutMs) {
      await handle.page.getByText(condition.text, { exact: false }).first().waitFor({
        state: locatorState,
        timeout: Math.max(0, timeoutMs - (Date.now() - nativeWaitStartedAt)),
      }).catch((err) => {
        // Same as above — log the timeout so the agent is not misled into thinking the
        // text condition was satisfied when it was merely skipped.
        process.stderr.write(`[managed-playwright] waitFor text timed out (text="${condition.text}" state=${locatorState}): ${err?.message || err}\n`);
      });
    }
    const networkObservation = () => {
      if (typeof options.networkObservation === "function") return options.networkObservation();
      return { networkFound: true, networkRequest: null, networkMatchCount: null };
    };
    const pageObservation = async () => {
      const selectorObservation = condition.selector
        ? await handle.page.locator(condition.selector).first().evaluate((element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return {
              selectorAttached: true,
              selectorVisible: style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0,
            };
          }).catch(() => ({ selectorAttached: false, selectorVisible: false }))
        : { selectorAttached: null, selectorVisible: null };
      const textFound = condition.text ? await handle.page.getByText(condition.text, { exact: false }).first().isVisible().catch(() => false) : null;
      const urlFound = condition.urlContains ? handle.page.url().includes(condition.urlContains) : null;
      return { ok: true, url: handle.page.url(), ...selectorObservation, textFound, urlFound, state };
    };
    const isSatisfied = (entry) => {
      let ok = true;
      if (condition.selector) {
        if (state === "attached") ok = entry.selectorAttached;
        else if (state === "hidden") ok = entry.selectorAttached && !entry.selectorVisible;
        else if (state === "detached") ok = !entry.selectorAttached;
        else ok = entry.selectorVisible;
      }
      if (condition.text) ok = ok && entry.textFound;
      if (condition.urlContains) ok = ok && entry.urlFound;
      if (condition.requestUrlContains) ok = ok && entry.networkFound;
      return Boolean(ok);
    };

    while (Date.now() - startedAt <= timeoutMs) {
      observation = { ...(await pageObservation()), ...networkObservation() };
      if (isSatisfied(observation)) {
        const waitedMs = Date.now() - startedAt;
        return { ...(await this.pageSummary(handle)), ok: true, waitedMs, condition, observation, waitSummary: { state: "satisfied", waitedMs, timeoutMs, pollMs, condition } };
      }
      await handle.page.waitForTimeout(pollMs);
    }
    const waitedMs = Date.now() - startedAt;
    return { ...(await this.pageSummary(handle)), ok: false, error: "timeout", waitedMs, condition, lastObservation: observation, waitSummary: { state: "timeout", waitedMs, timeoutMs, pollMs, condition } };
  }

  async upload(profileName, params = {}) {
    const handle = await this.ensurePage(profileName);
    const fileList = [
      ...(Array.isArray(params.files) ? params.files.map(String) : []),
      ...(params.file ? [String(params.file)] : []),
    ].map((filePath) => resolve(filePath));
    if (fileList.length === 0) return { ...(await this.pageSummary(handle)), ok: false, error: "browser_upload requires file or files" };
    const missing = fileList.filter((filePath) => !existsSync(filePath));
    if (missing.length) return { ...(await this.pageSummary(handle)), ok: false, error: "file_not_found", missing };
    const timeout = actionTimeoutMs(params, 3000);
    const locator = this.locator(handle.page, params);
    await locator.setInputFiles(fileList, { timeout });
    const result = await locator.evaluate((element) => element.files ? {
      fileCount: element.files.length,
      names: Array.from(element.files).map((file) => file.name),
    } : null);
    return { ...(await this.pageSummary(handle)), ok: true, inputMode: "playwright", selector: params.selector || null, files: fileList, result };
  }

  async type(profileName, params = {}) {
    const handle = await this.ensurePage(profileName);
    const locator = this.locator(handle.page, params);
    const timeout = actionTimeoutMs(params);
    const text = String(params.text || "");
    if (params.clear !== false) {
      await locator.fill(text, { timeout });
    } else {
      await locator.type(text, { timeout });
    }
    if (params.pressEnter) await handle.page.keyboard.press("Enter");
    const value = await locator.evaluate((element) => "value" in element ? element.value : null).catch(() => null);
    return { ...(await this.pageSummary(handle)), ok: true, inputMode: "playwright", selector: params.selector || null, value };
  }

  async scroll(profileName, params = {}) {
    const handle = await this.ensurePage(profileName);
    const delta = { x: Number(params.x || 0), y: Number(params.y || 600) };
    const result = await handle.page.evaluate((scrollDelta) => {
      const doc = document.scrollingElement || document.documentElement || document.body;
      const before = { scrollX, scrollY };
      scrollBy(scrollDelta.x, scrollDelta.y);
      const after = { scrollX, scrollY };
      const scrollHeight = doc ? Number(doc.scrollHeight || 0) : 0;
      const scrollWidth = doc ? Number(doc.scrollWidth || 0) : 0;
      const clientHeight = doc ? Number(doc.clientHeight || innerHeight || 0) : Number(innerHeight || 0);
      const clientWidth = doc ? Number(doc.clientWidth || innerWidth || 0) : Number(innerWidth || 0);
      return {
        ok: true,
        scrollX,
        scrollY,
        before,
        after,
        delta: scrollDelta,
        viewport: { width: innerWidth, height: innerHeight },
        document: { scrollWidth, scrollHeight, clientWidth, clientHeight },
        canScrollX: scrollWidth > clientWidth,
        canScrollY: scrollHeight > clientHeight,
        movedX: before.scrollX !== after.scrollX,
        movedY: before.scrollY !== after.scrollY,
        reachedTop: scrollY <= 0,
        reachedBottom: scrollHeight > 0 ? Math.ceil(scrollY + innerHeight) >= scrollHeight : null,
      };
    }, delta);
    return { ...(await this.pageSummary(handle)), ...result };
  }

  async screenshot(profileName, params = {}) {
    const handle = await this.ensurePage(profileName);
    const buffer = await handle.page.screenshot({ fullPage: params.fullPage === true, type: "png" });
    const outPath = params.path || join(this.userDataRoot, "..", "profiles", handle.profile, "screenshots", `${Date.now()}.png`);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, buffer);
    return {
      ...(await this.pageSummary(handle)),
      ok: true,
      path: outPath,
      mimeType: "image/png",
      bytes: buffer.length,
      base64: buffer.toString("base64"),
    };
  }

  async observe(profileName, maxTextLength = 1200) {
    const handle = await this.ensurePage(profileName);
    return await handle.page.evaluate((limit) => ({
      title: document.title,
      url: location.href,
      activeElement: document.activeElement ? {
        tag: document.activeElement.tagName.toLowerCase(),
        id: document.activeElement.id || null,
        name: document.activeElement.getAttribute("name"),
        role: document.activeElement.getAttribute("role"),
        text: (document.activeElement.innerText || document.activeElement.value || document.activeElement.getAttribute("aria-label") || "").slice(0, 160),
      } : null,
      text: (document.body?.innerText || "").slice(0, limit),
    }), Number(maxTextLength) || 1200);
  }

  async pageSummary(handle) {
    const title = await handle.page.title().catch(() => "");
    const url = handle.page.url();
    return {
      backend: "managed-playwright",
      driver: "playwright",
      profile: handle.profile,
      tabId: handle.tabId,
      title,
      url,
      userDataDir: handle.userDataDir,
      launch: {
        channel: PLAYWRIGHT_CHANNEL,
        headless: false,
        args: playwrightArgs(),
        viewport: null,
      },
    };
  }

  async addCookies(profileName, cookies) {
    const handle = await this.ensurePage(profileName);
    await handle.context.addCookies(cookies);
    return { ok: true, backend: "managed", count: cookies.length };
  }

  async getCookies(profileName, filter = {}) {
    const handle = await this.ensurePage(profileName);
    const urls = filter.url ? [filter.url] : undefined;
    let cookies = await handle.context.cookies(urls);
    if (filter.domain) {
      const d = filter.domain.replace(/^\./, "");
      cookies = cookies.filter((c) => c.domain.replace(/^\./, "") === d || c.domain.replace(/^\./, "").endsWith("." + d));
    }
    if (filter.name) {
      cookies = cookies.filter((c) => c.name === filter.name);
    }
    return { ok: true, backend: "managed", count: cookies.length, cookies };
  }

  async closeTab(profileName) {
    const entry = this.contexts.get(profileName);
    if (!entry) {
      return { ok: false, backend: "managed", error: `profile ${profileName} has no live context` };
    }
    const pages = entry.context.pages().filter((p) => !p.isClosed());
    if (!pages.length) {
      return { ok: false, backend: "managed", error: "no live pages" };
    }
    const closedUrls = [];
    for (const page of pages) {
      closedUrls.push(page.url());
      await page.close();
    }
    return { ok: true, backend: "managed", profile: profileName, closedCount: closedUrls.length, closedUrls };
  }

  async closeProfile(rawProfileName) {
    const profileName = normalizeProfileName(rawProfileName);
    const entry = this.contexts.get(profileName);
    if (!entry) return;
    await entry.context.close().catch(() => {});
    this.contexts.delete(profileName);
    this.#profileLocks.delete(profileName);
  }

  async listPages() {
    const rows = [];
    for (const [profile, entry] of this.contexts.entries()) {
      for (const page of entry.context.pages()) {
        if (page.isClosed()) continue;
        rows.push({
          id: `playwright:${profile}`,
          title: await page.title().catch(() => ""),
          url: page.url(),
          type: "page",
          backend: "managed-playwright",
          driver: "playwright",
          profile,
        });
      }
    }
    return rows;
  }
}

// ── Window visibility helpers (exported for tools) ────────────────────

function _windowPs(userDataDir, action) {
  if (process.platform !== "win32") return;
  const escaped = userDataDir.replace(/\\/g, "\\\\");
  const flag = action === "hide" ? "[IntPtr]1" : "[IntPtr](-1)"; // HWND_BOTTOM / HWND_TOP
  execSync(
    `powershell -NoProfile -Command "Add-Type -Name W -Namespace C -MemberDefinition '[DllImport(\\\"user32.dll\\\")]public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int w,int h,uint f);';` +
    `\\$flag = ${flag}; \\$SWP_NOACTIVATE = 4; \\$SWP_NOMOVE = 2; \\$SWP_NOSIZE = 1;` +
    `Get-CimInstance Win32_Process -Filter \\\"Name='chrome.exe'\\\" | Where-Object { \\$_.CommandLine -like '*--user-data-dir=${escaped}*' } | ForEach-Object { \\$p = Get-Process -Id \\$_.ProcessId -ErrorAction SilentlyContinue; if (\\$p.MainWindowHandle) { [C.W]::SetWindowPos(\\$p.MainWindowHandle, \\$flag, 0, 0, 0, 0, \\$SWP_NOACTIVATE + \\$SWP_NOMOVE + \\$SWP_NOSIZE) | Out-Null } }"`,
    { timeout: 5000, windowsHide: true },
  );
}

/** Push Chrome window to background (HWND_BOTTOM). Fire-and-forget, never throws. */
export function hideChromeWindow(userDataDir) {
  try { _windowPs(userDataDir, "hide"); } catch { /* never block */ }
}

