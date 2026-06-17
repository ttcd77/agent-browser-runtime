// Pure browser-identity helpers, extracted from agent-cdp-server.mjs
// (2026-06-06 monolith carve, behavior-preserving). No CDP, no filesystem, no
// module state: each maps an executable path / CDP version blob / launch
// metadata to a normalized product name or runtime-identity view-model using
// only JS stdlib. buildBrowserRuntimeIdentity composes the other two.
// Unit-tested in browser-identity.test.mjs.

export function browserProductFromExecutable(executable) {
  const path = String(executable || "").toLowerCase();
  if (path.includes(".cloakbrowser") || path.includes("cloakbrowser")) return "CloakBrowser";
  if (path.includes("msedge")) return "Microsoft Edge";
  if (path.includes("chrome")) return "Google Chrome";
  if (path.includes("chromium")) return "Chromium";
  return null;
}

export function browserProductFromVersion(version) {
  const product = String(version?.Browser || version?.browser || "");
  const userAgent = String(version?.["User-Agent"] || version?.userAgent || "");
  if (/cloak/i.test(`${product} ${userAgent}`)) return "CloakBrowser";
  if (/edg\//i.test(`${product} ${userAgent}`)) return "Microsoft Edge";
  if (/chrome\//i.test(product)) return "Google Chrome";
  if (/chromium\//i.test(product)) return "Chromium";
  return null;
}

export function buildBrowserRuntimeIdentity({
  cdpPort,
  requestedCdpPort,
  cdpPortMode,
  existingBrowser,
  browserProcess,
  browserVersion,
  executable,
  userDataDir,
  launchMode,
  headless,
}) {
  const attachMode = existingBrowser
    ? "attached-existing-cdp"
    : browserProcess
      ? "launched-managed-browser"
      : "attached-cdp-after-wait";
  const productName =
    browserProductFromExecutable(executable) ||
    browserProductFromVersion(browserVersion) ||
    "unknown-chromium-family";
  return {
    productBackend: "managed",
    transport: "direct-cdp",
    physicalBrowser: productName,
    browserProduct: browserVersion?.Browser || null,
    protocolVersion: browserVersion?.["Protocol-Version"] || null,
    userAgent: browserVersion?.["User-Agent"] || null,
    executablePath: executable || null,
    cdpPort,
    requestedCdpPort: requestedCdpPort ?? cdpPort,
    cdpPortMode: cdpPortMode || "fixed",
    cdpEndpoint: `http://127.0.0.1:${cdpPort}`,
    processId: browserProcess?.pid || null,
    attachMode,
    launchMode: existingBrowser ? "existing-cdp-browser" : launchMode,
    headless: existingBrowser ? null : headless,
    launchedByServer: Boolean(browserProcess),
    userDataDir: userDataDir || null,
    boundary:
      cdpPortMode === "ephemeral"
        ? "Physical browser and DevTools port are runtime internals under Managed Browser. Agents should route by productBackend/profile, not by Edge/Chrome/Cloak names or a fixed CDP port."
        : "Physical browser is an implementation detail under Managed Browser. Agents should route by productBackend/profile, not by Edge/Chrome/Cloak names.",
  };
}

export function parseBrowserExtraArgs(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    // Fall through to shell-friendly parsing.
  }
  return String(value)
    .split(/[,\r\n]+|\s+(?=--)/)
    .map((part) => part.trim())
    .filter(Boolean);
}
