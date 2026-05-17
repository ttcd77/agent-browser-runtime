# Open Source Release Checklist

This project is intended to be useful as a real agent browser runtime and as a
portfolio-quality security engineering project.

## Must Be True Before Public Release

- `npm run check` passes.
- `npm run contract:devtools` reports the same Managed and Personal tool count.
- `npm run smoke:f12` passes on Managed Browser.
- `npm run smoke:personal` passes after the Chrome extension and bridge are
  running.
- README explains the two product modes clearly:
  Personal Chrome and Managed Browser.
- Safety boundaries are visible before examples that touch cookies, headers,
  bodies, or authenticated state.
- Examples use `example.com` or user-authorized targets only.
- No private targets, credentials, local evidence files, or personal browser data
  are committed.

## Portfolio Signals

The repo should make these engineering signals obvious:

- F12 parity as an agent-facing tool layer, not a screenshot toy.
- Unified `devtools_*` contract across Personal Chrome and Managed Browser.
- Structured evidence capture for security research.
- Profile-scoped browser state and evidence directories.
- Raw CDP escape hatch via `devtools_cdp_command`.
- Contract tests that prevent backend drift.
- Smoke tests that exercise real browser behavior.

## Good First Public Demo

Use Managed Browser mode so the demo does not depend on a user's private Chrome
profile:

1. Start the server with `CDP_LAUNCH_BROWSER=1 npm run agent:server`.
2. Create a profile named `researcher`.
3. Call `devtools_security_research_pack` against `https://example.com`.
4. Show the returned HAR, Application export, trace, and evidence bundle paths.
5. Drill into one request with `devtools_request_detail`.

This demonstrates the product without touching private cookies or real accounts.

## Keep Private

Do not publish:

- personal Chrome extension runtime state,
- `runtime/` evidence directories,
- captured HAR files from authenticated sessions,
- browser profile directories,
- real bug bounty target evidence,
- screenshots containing accounts or private data.

## Next Polish Items

- Add a CLI wrapper for the research pack.
- Add a short demo GIF or screenshot using only `example.com`.
- Add a minimal MCP adapter example.
- Add a "known backend limitations" section to the README.
- Rename any remaining internal wording that sounds tied to OpenClaw unless it
  is explicitly compatibility-related.
