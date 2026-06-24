# Project Overview

Agent Browser Runtime is a local DevTools evidence runtime for AI agents. It gives an agent a browser workbench that is closer to how an application security researcher uses Chrome DevTools: open a page, start capture, reproduce behavior, collect objective evidence, and drill into the exact browser facts behind an observation.

The project is intentionally not a vulnerability scanner. It does not decide whether something is exploitable or assign severity. Its job is to expose browser evidence clearly enough that a human researcher or an AI agent can reason from facts rather than screenshots, guesses, or incomplete page state.

## Problem

AI agents can navigate pages, but they often miss the deeper browser evidence that a human would inspect in F12:

- redirect chains,
- request and response bodies,
- WebSocket and Server-Sent Events payloads,
- frame and shadow DOM boundaries,
- storage, cookies, cache, service workers, and application state,
- console, security, source, performance, and trace evidence,
- local artifact paths that a later agent can resume from.

Without this layer, an agent can interact with a website but still fail to understand what the browser actually observed.

## What It Provides

- **Agent Browser mainline**: starts an isolated real Chrome profile for professional AppSec work, with headless mode reserved for CI and smoke tests.
- **Personal Chrome beta**: optional bridge for operator-authorized inspection of a user's own browser state.
- **Unified backend router**: the main worker can route `browser_*` facade calls to Agent Browser or Personal Chrome through one product entrypoint.
- **Facade-first agent API**: agents start with `browser_open`, `browser_capture`, `browser_inspect`, and `browser_security_pack` instead of choosing from dozens of low-level tools.
- **F12 drilldown tools**: `devtools_*` tools expose Network, Application, Elements, Sources, Security, Console, Frames, Performance, Trace, and raw CDP escape hatches.
- **Evidence packs**: one command can produce a manifest, HAR, application export, trace artifacts, correlation graph, realtime payload logs, and machine-readable operator handoff.
- **Profile-scoped operating spaces**: each profile owns its browser tab, evidence directory, traffic journal, event journal, screenshots, and snapshots.
- **Objective boundary**: readiness and evidence tools return facts, routes, and artifact paths. They do not classify vulnerabilities.

## Current Maturity

Current status: **professional core ready, active development**.

The Agent Browser path is the primary supported workflow. It has release readiness checks, contract checks, unit tests, F12 smoke tests, professional workflow smoke tests, example workflow smoke tests, an acceptance suite, and a scorecard. Personal Chrome mode exists for local authorized debugging and is now reachable through the same main facade by passing `backend: "personal"` or `currentTab: true`, but it should still be treated as beta because it depends on the local Chrome extension bridge and user authorization.

Implementation note: some low-level APIs and compatibility responses still use
the legacy backend id `managed`. Agent-facing docs and prompts should call that
lane **Agent Browser**.

Known boundaries are documented rather than hidden. For example, historical browser data cannot be recovered if capture was not enabled before the action, and browser replay is not raw socket-level replay.

## Demo Path

Safe public demo:

```bash
npm install
npm run build
$env:CDP_LAUNCH_BROWSER="1"
npm run agent:server
```

In another terminal:

```bash
npm run research:pack -- --url https://example.com --profile researcher
```

The output returns local artifact paths and a machine-readable handoff for the next agent or operator.

Agent-facing current-tab route:

```json
{
  "tool": "browser_inspect",
  "params": {
    "backend": "personal",
    "mode": "overview"
  }
}
```

## Safety

Use only with browser profiles, accounts, and targets you are authorized to inspect. Do not commit captured HAR files, profile data, private target evidence, screenshots with accounts, or authenticated browser artifacts.
