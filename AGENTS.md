# Agent Browser Runtime Agent Guide

This repository builds a local DevTools evidence runtime for AI agents.

## Product Contract

- Use the `browser_*` facade first.
- Drill down to `devtools_*` only when exact F12 evidence is needed.
- Use `devtools_cdp_command` or `devtools_browser_cdp_command` as escape hatches.
- Keep the objective-tool boundary: collect evidence, do not decide whether a signal is a vulnerability.

## Browser Modes

- Personal Profile: user's real Chrome tab through the extension bridge.
- Agent Browser: managed browser/profile launched by the runtime.

The product contract should stay the same across both modes. Backend-specific names are for debugging and compatibility.

## Local Checks

Open-source readiness:

```bash
npm run release:readiness
```

Fast development check:

```bash
npm run check
```

Full browser/tool check:

```bash
npm run check:full
```

Before public release, run:

```bash
npm run check:release
```

`smoke:personal` requires the Personal Chrome extension and bridge to be running.

## Safety

Do not commit local evidence, browser profiles, logs, captured HAR files, screenshots with accounts, or private target data. Use `example.com` or local fixtures in public examples.
