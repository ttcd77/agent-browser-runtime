// Generic text helpers extracted from agent-cdp-server.mjs (2026-06-06 monolith
// carve, behavior-preserving). Pure, stdlib-only, no CDP / fs / module state.
// truncateText is a shared leaf used across coverage, source-map, DOM-search,
// and pretty-print evidence builders, so it lives in its own tiny module rather
// than being duplicated or coupled into one domain module. Unit-tested in
// text-utils.test.mjs.

export function truncateText(text, maxChars = 120000) {
  const value = String(text || "");
  if (!Number.isFinite(maxChars) || maxChars <= 0 || value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  return { text: value.slice(0, maxChars), truncated: true };
}
