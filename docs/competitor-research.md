# Competitor Research

Updated: 2026-05-17

This project should not be built in a vacuum. The browser-agent market already
has strong open-source and commercial work around DevTools MCP, real-browser
control, AI browser automation, trace capture, and API discovery. Our product
direction should absorb the strongest ideas while staying focused on the gap:
security-research-grade browser evidence for agents, across Personal Chrome and
Managed Browser backends, without pretending to judge vulnerabilities.

Local source cache: `research/competitors/` (ignored by git).

## Market Map

| Project | Shape | What It Does Well | What It Does Not Solve For Us |
|---|---|---|---|
| Chrome DevTools MCP | Official MCP server over Chrome DevTools | Clean DevTools-to-agent baseline: pages, input, console, network, performance trace, memory snapshot, Lighthouse, screenshots, script eval, extension tools. | It is a general DevTools MCP. It is not specifically a security evidence runtime, does not organize target/profile-scoped evidence packs the way we need, and is less focused on Personal/Managed parity as a product model. |
| OpenChrome | MCP + real Chrome/CDP + optional desktop/daemon UX | Strong product packaging: real logged-in Chrome, tab/session isolation, tool catalogue, capability map, doctor/check, outcome contracts, evidence bundles, traces, network body capture, profile handling. | Very broad automation harness. It has many tools and product claims; our differentiation should not be "more tools", but a smaller facade plus deeper security evidence discipline. |
| Browserbase Stagehand | AI browser automation SDK | Excellent mental model: `act`, `observe`, `extract`, `agent`. Caching and self-healing ideas are useful for reducing brittle selector work. | More automation/extraction than F12 evidence. It usually assumes an SDK/cloud-browser automation workflow, not a local security research evidence workbench. |
| Browserbase Skills | Agent skills over Browserbase/browse CLI | `browser-trace` is highly relevant: second read-only CDP client, raw CDP firehose, screenshots, DOM dumps, per-page slicing. `browser-to-api` turns traces into OpenAPI-like API maps. | Skills depend on Browserbase/browse conventions. Response bodies are separated from the CDP firehose and require extra capture. Not a unified Personal Chrome + Managed Browser runtime. |
| YetiBrowser MCP / Browser MCP style projects | Browser extension + local MCP server | Simple browser-control MCP surface: snapshot, navigation, click/type, screenshot, console logs, page state, storage/cookies. Local-first positioning is clear. | Usually focused on generic control and QA. Less evidence depth: request replay, auth-boundary reports, trace querying, coverage, heap/source maps, and security packs are not the center. |
| Nanobrowser / SeeAct-style extensions | Extension-based browser agent | Useful DOM tree construction, clickable-element maps, iframe/shadow handling, step history, side-panel interaction. | More autonomous browsing than objective DevTools evidence. Often agent-loop heavy, less suited as a neutral tool layer for other agents. |
| Shripi / API inspector products | Browser/API capture product | Strong API reverse-engineering UX: capture browser traffic, turn flows into API understanding. | Narrower than browser security research; usually not a full F12/CDP runtime or agent tool layer. |

## What We Should Absorb

1. **Official baseline from Chrome DevTools MCP**
   - Treat it as the compatibility floor.
   - Keep raw CDP escape hatches so agents can reach domains not wrapped by our facade.
   - Compare our `devtools_*` surface against its domains: Network, Console, Page, Input, Runtime, Performance, Memory, Lighthouse-like auditing, screenshots, snapshots, extensions.

2. **OpenChrome's packaging discipline**
   - Add generated capability maps, tool category docs, doctor/check commands, and transport health checks.
   - Keep the "facts versus decisions" line: the runtime gathers evidence; the host agent decides.
   - Borrow the idea of output handles for very large artifacts so agents do not flood context with huge bodies, traces, or heap files.

3. **Browserbase Skills' trace architecture**
   - Maintain a durable raw CDP event stream.
   - Slice events by page/frame/request family after capture.
   - Store screenshots and DOM snapshots alongside the CDP timeline.
   - Be explicit that response bodies require `Network.getResponseBody` round trips; the event stream alone is not enough.

4. **Stagehand's small primitive layer**
   - Do not expose 80+ tools as the default user/agent experience.
   - Keep high-level primitives: open, act, inspect, capture, evidence pack, replay, raw.
   - Let specialized agents drill into lower-level tools only when they know what they need.

5. **Extension projects' Personal Chrome lessons**
   - Personal Chrome must be permissioned and transparent.
   - `chrome.debugger` is an alternate CDP transport for a tab, but it has browser/security boundaries.
   - The product must clearly show when it is using Personal Profile versus Agent Browser.

## Differentiation

Our strongest angle is not generic browser automation. The market already has
that. Our angle should be:

> Agent Browser Runtime is a local, security-research-oriented DevTools evidence
> runtime. It gives agents the objective evidence a human would collect from F12,
> organized by profile/target, with replayable artifacts and backend parity
> between Personal Chrome and Managed Browser.

Concrete differentiators:

- **Security evidence first**: HAR, bodies, storage, cookies, service workers,
  frames, console, issues, source maps, coverage, performance traces, CPU/heap,
  WebSocket/SSE, request correlation, replay variants, auth-boundary evidence.
- **Objective tool layer**: no built-in vulnerability verdicts. The runtime
  returns facts, completeness boundaries, and artifact paths.
- **Personal + Managed parity**: same `browser_*` and `devtools_*` contract over
  both a user's real Chrome and an agent-managed browser.
- **Profile-scoped workspaces**: each role/target gets its own tab, evidence
  directory, capture journal, and artifacts.
- **Agent usability**: small facade by default, detailed tools by drill-down,
  raw CDP command as escape hatch.
- **Portfolio value**: the project demonstrates CDP, extension transport,
  browser security evidence, local artifacts, request replay, and agent-facing
  product design.

## Immediate Engineering Implications

1. Keep `browser_*` as the default facade. Do not make agents choose from every
   low-level tool first.
2. Keep `devtools_*` as the full F12 drill-down layer.
3. Add or improve a generated capability map similar to OpenChrome, but keep it
   grouped by human DevTools panels: Network, Elements, Console, Sources,
   Application, Performance, Memory, Security, Recorder/Evidence.
4. Add a trace-bisect workflow inspired by Browserbase Skills:
   - raw CDP event journal,
   - per-page buckets,
   - per-request bodies,
   - query helpers over saved artifacts.
5. Add Source Map original-source extraction next. It is a natural continuation
   of the Sources panel and useful for security research.
6. Keep Risk Summary out of the core. Replace subjective scoring with objective
   signals such as failed requests, console errors, CSP/mixed-content warnings,
   auth boundary changes, token-like strings, and missing capture boundaries.

## Sources Checked

- Chrome DevTools MCP source: `research/competitors/chrome-devtools-mcp`
- OpenChrome source: `research/competitors/openchrome`
- Browserbase Stagehand source: `research/competitors/stagehand`
- Browserbase Skills source: `research/competitors/browserbase-skills`
- YetiBrowser MCP source: `research/competitors/yetibrowser-mcp`
- Nanobrowser source: `research/competitors/nanobrowser`
- SeeAct Chrome Extension source: `research/competitors/seeact-chrome-extension`
- BrowserKing source: `research/competitors/browserking`
- Sarathi AI Agent source: `research/competitors/sarathi-ai-agent`

