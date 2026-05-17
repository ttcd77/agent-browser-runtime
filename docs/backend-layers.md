# Backend Layers

Agent Browser Runtime has two browser layers behind one `devtools_*` contract.

## Layer 1: Personal Chrome / `chrome.debugger`

This layer is for the user's real browser.

- Transport: Chrome extension bridge plus `chrome.debugger`.
- Best use: "I am seeing this in my own browser; agent, inspect it."
- Strength: real profile state, login state, cookies, extensions, and visible user
  context.
- Boundary: `chrome.debugger` exposes an allowlisted subset of Chrome DevTools
  Protocol domains. It is excellent for ordinary web-page F12 work, but it is
  not the broadest possible CDP surface.

Use `devtools_backend_capabilities` to see the allowlisted domains reported by
the active extension.

## Layer 2: Managed Browser / Direct CDP

This layer is for agent-owned browser profiles and repeatable target work.

- Transport: direct Chrome DevTools Protocol over a remote debugging endpoint.
- Best use: target testing, clean profiles, repeatable captures, and deeper CDP
  coverage.
- Strength: broader CDP access than the extension layer and clean
  profile-scoped evidence directories.
- Boundary: the friendly wrappers are still ordinary-web-page F12 tools. Use
  `devtools_cdp_command` as the escape hatch for page-target CDP methods that do
  not yet have a wrapper.
- Extra CDP layer: use `devtools_browser_cdp_command` for browser-process
  commands such as `Browser.getVersion`, `Target.getTargets`, or `SystemInfo.*`
  where Chrome exposes them.

## Shared Rule

The tool should not become the limiting factor. If a human can open F12, start
recording, reproduce an action, and see browser evidence, the agent should have a
same-class tool path. If Chrome did not retain evidence, or the browser security
model blocks access, tools should return structured incomplete/unavailable
results instead of pretending the data exists.
