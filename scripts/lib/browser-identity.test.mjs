import { describe, it, expect } from "vitest";
import {
  browserProductFromExecutable,
  browserProductFromVersion,
  buildBrowserRuntimeIdentity,
  parseBrowserExtraArgs,
} from "./browser-identity.mjs";

// Characterization tests pinning the behavior of the pure browser-identity
// helpers carved out of agent-cdp-server.mjs. These lock the executable/version
// -> product mapping, the runtime-identity view-model, and extra-args parsing so
// the monolith refactor cannot silently change how the runtime reports identity.

describe("browserProductFromExecutable", () => {
  it("maps known executables (cloak checked before chrome)", () => {
    expect(browserProductFromExecutable("C:/Users/x/.cloakbrowser/123/chrome.exe")).toBe("CloakBrowser");
    expect(browserProductFromExecutable("/Applications/Microsoft Edge.app/Contents/MacOS/msedge")).toBe("Microsoft Edge");
    expect(browserProductFromExecutable("/usr/bin/google-chrome")).toBe("Google Chrome");
    expect(browserProductFromExecutable("/usr/bin/chromium-browser")).toBe("Chromium");
  });
  it("returns null for unknown / empty input", () => {
    expect(browserProductFromExecutable("/usr/bin/firefox")).toBe(null);
    expect(browserProductFromExecutable("")).toBe(null);
    expect(browserProductFromExecutable(null)).toBe(null);
  });
});

describe("browserProductFromVersion", () => {
  it("detects product from Browser/User-Agent fields", () => {
    expect(browserProductFromVersion({ Browser: "CloakBrowser/1.0" })).toBe("CloakBrowser");
    expect(browserProductFromVersion({ "User-Agent": "Mozilla/5.0 Edg/120.0" })).toBe("Microsoft Edge");
    expect(browserProductFromVersion({ Browser: "Chrome/120.0.0.0" })).toBe("Google Chrome");
    expect(browserProductFromVersion({ Browser: "Chromium/120.0" })).toBe("Chromium");
  });
  it("returns null when no signal matches", () => {
    expect(browserProductFromVersion({ Browser: "HeadlessShell" })).toBe(null);
    expect(browserProductFromVersion({})).toBe(null);
    expect(browserProductFromVersion(null)).toBe(null);
  });
});

describe("buildBrowserRuntimeIdentity", () => {
  it("builds identity for a server-launched managed browser", () => {
    const out = buildBrowserRuntimeIdentity({
      cdpPort: 9222,
      executable: "/usr/bin/google-chrome",
      browserProcess: { pid: 4242 },
      browserVersion: { Browser: "Chrome/120.0", "Protocol-Version": "1.3", "User-Agent": "UA" },
      userDataDir: "/tmp/profile",
      launchMode: "managed",
      headless: true,
    });
    expect(out.productBackend).toBe("managed");
    expect(out.physicalBrowser).toBe("Google Chrome");
    expect(out.cdpPort).toBe(9222);
    expect(out.requestedCdpPort).toBe(9222); // defaults to cdpPort when absent
    expect(out.cdpPortMode).toBe("fixed");
    expect(out.cdpEndpoint).toBe("http://127.0.0.1:9222");
    expect(out.processId).toBe(4242);
    expect(out.attachMode).toBe("launched-managed-browser");
    expect(out.launchMode).toBe("managed");
    expect(out.launchedByServer).toBe(true);
    expect(out.boundary).toMatch(/implementation detail/);
  });
  it("builds identity for an attached existing CDP browser (overrides launchMode/headless)", () => {
    const out = buildBrowserRuntimeIdentity({
      cdpPort: 9333,
      existingBrowser: true,
      launchMode: "managed",
      headless: true,
    });
    expect(out.attachMode).toBe("attached-existing-cdp");
    expect(out.launchMode).toBe("existing-cdp-browser");
    expect(out.headless).toBe(null);
    expect(out.launchedByServer).toBe(false);
    expect(out.physicalBrowser).toBe("unknown-chromium-family");
  });
  it("uses the ephemeral boundary message when cdpPortMode is ephemeral", () => {
    const out = buildBrowserRuntimeIdentity({ cdpPort: 1, cdpPortMode: "ephemeral" });
    expect(out.cdpPortMode).toBe("ephemeral");
    expect(out.boundary).toMatch(/runtime internals/);
  });
  it("falls back to attached-cdp-after-wait when neither existing nor a launched process", () => {
    const out = buildBrowserRuntimeIdentity({ cdpPort: 1 });
    expect(out.attachMode).toBe("attached-cdp-after-wait");
  });
});

describe("parseBrowserExtraArgs", () => {
  it("returns [] for empty input", () => {
    expect(parseBrowserExtraArgs("")).toEqual([]);
    expect(parseBrowserExtraArgs(null)).toEqual([]);
    expect(parseBrowserExtraArgs(undefined)).toEqual([]);
  });
  it("parses a JSON array of args", () => {
    expect(parseBrowserExtraArgs('["--no-sandbox", "--disable-gpu"]')).toEqual(["--no-sandbox", "--disable-gpu"]);
  });
  it("falls back to splitting on commas/newlines and flag boundaries", () => {
    expect(parseBrowserExtraArgs("--no-sandbox,--disable-gpu")).toEqual(["--no-sandbox", "--disable-gpu"]);
    expect(parseBrowserExtraArgs("--no-sandbox --disable-gpu")).toEqual(["--no-sandbox", "--disable-gpu"]);
  });
});
