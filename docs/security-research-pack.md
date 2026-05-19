# Security Research Evidence Pack

`devtools_security_research_pack` is the one-call workflow for an agent doing
authorized web security research.

It does not decide whether a site is vulnerable. It does the mechanical F12 work
that a careful researcher would otherwise repeat by hand, then returns the raw
evidence and saved artifact paths.

## What "One Call" Means

The agent calls one tool:

```json
{
  "profile": "researcher",
  "url": "https://example.com",
  "limit": 20,
  "includeHar": true,
  "includeTrace": true,
  "includeApplicationExport": true
}
```

The runtime then performs a bounded workflow:

1. Navigate to the URL when provided.
2. Start a DevTools capture window.
3. Hard reload the page so Network, Console, Security, Frame, and Application
   evidence is collected from a clean page load.
4. Run `agent_inspect` over the useful first-pass areas:
   `overview`, `network`, `storage`, `console`, `sources`, and `performance`.
5. Save the evidence artifacts the agent would normally need to ask for
   separately:
   HAR, HAR completeness report, Application export, Chrome trace, trace
   summary, compact evidence bundle, evidence manifest, request correlation
   graph, auth boundary report, and worker/frame boundary report.
6. Return one structured response with summaries, completeness notes, artifact
   paths, and suggested next tools for drill-down.

This is why it is "one-click" from the product point of view: the user or agent
does not click through Network, Application, Sources, Performance, and Console
manually. One tool call creates a portable evidence package.

## What It Produces

Typical output includes:

- request and response summaries,
- Console and DevTools Issues evidence,
- cookies, storage, Service Worker, IndexedDB, and Cache Storage summaries,
- source/script inventory and source-map metadata,
- Performance timing, observer entries, and optional Chrome trace file,
- saved HAR path,
- saved HAR completeness path for body, timing, redirect, and
  security-metadata coverage,
- saved Application export path,
- saved evidence bundle path,
- saved evidence manifest path with file hashes,
- saved request correlation graph path,
- saved auth boundary report path,
- saved worker/frame boundary report path,
- workflow snapshot showing the professional `browser_*` facade path that
  produced the pack,
- `agentEntryPoints` snapshot from `devtools_tool_catalog`, so another agent can
  continue from the same facade-first route without scanning the full tool
  surface,
- final capture status, including whether capture is still enabled, capture
  label, timestamps, and observed traffic count when the backend exposes it,
- handoff completeness checklist for workflow, research pack, drilldown plan,
  artifact index, evidence timeline, capture status, and parity matrix,
- artifact coverage rows showing whether each requested evidence file is
  `present`, `skipped`, or `missing`,
- `summary.harCompletenessPath`, a standalone JSON artifact for HAR body,
  timing, redirect, and security-metadata coverage,
- `f12Navigation`, a deterministic index from captured request nodes to
  `devtools_request_detail` plus F12 request sections,
- `summary.f12NavigationPath`, a standalone JSON artifact for the same F12
  navigation index, indexed as `f12-navigation` for direct agent handoff,
- `firstF12RequestDetail`, a compact objective summary of the first captured
  request's F12 detail sections, including section availability, header names,
  payload/body availability, cookie counts, timing, initiator, redirects, and
  security metadata where Chrome exposed them,
- `summary.firstF12RequestDetailPath`, a standalone JSON artifact for that
  first request-detail summary, indexed as `request-detail` so an agent can
  inspect it without loading the full research pack,
- capture boundaries so the agent knows what time window was recorded.

The saved paths are local files under the selected profile evidence directory.
They are intentionally not hidden behind a UI because agents need direct,
machine-readable artifacts.

The CLI shortcut also calls `devtools_professional_readiness` after the pack is
created. This gives the agent a separate mechanical check for workflow,
capture, artifact inventory, evidence timeline, and the first F12 request-detail
route. It is still only an evidence-readiness check, not a vulnerability
judgment. The human-readable CLI summary also prints the first captured request's
available F12 detail sections, header counts, and body availability so an agent
can orient itself without immediately loading the full request detail. It also
prints route artifacts for saved F12 evidence, including F12 navigation, HAR
completeness, trace, Application export, evidence bundle, drilldown plan,
evidence manifest, correlation graph, auth boundary, and worker/frame boundary
reports. Each route artifact includes bounded `devtools_artifact_inspect` /
`devtools_artifact_read` follow-up tools.

## Why This Helps Security Research

Security research usually fails when weak signals are missed or when the
researcher cannot reconstruct what happened later. This workflow is designed to
avoid that:

- the capture boundary is explicit,
- the first page load is preserved,
- storage and network evidence are exported together,
- the agent can cite file paths instead of relying on memory,
- the response stays objective and leaves vulnerability judgment to the agent.

## Backend Support

The same tool name works in both product modes:

- Managed Browser: direct CDP runtime for agent-owned browser profiles.
- Personal Chrome: extension bridge over the user's active Chrome tab.

If a backend cannot provide a sub-artifact, the response should say so in the
step result instead of silently dropping it.

Transport boundaries:

- Managed Browser uses direct CDP and can expose broader browser-process
  DevTools domains where Chrome allows them.
- Personal Chrome uses the extension `chrome.debugger` transport against the
  user's selected tab. Browser-process CDP commands and some heavy artifacts may
  return structured `notApplicable` responses with Managed Browser fallback
  guidance.
- Both modes keep the same `devtools_*` names and return capture boundaries so
  agents can distinguish complete evidence from unavailable or uncaptured data.

## Recommended Agent Flow

1. Call `devtools_backend_capabilities`.
2. Call `devtools_security_research_pack`.
3. Read `summary` and `steps`.
4. Open the saved evidence bundle and manifest.
5. Use `summary.f12NavigationPath`, `summary.firstF12RequestDetailPath`,
   `f12Navigation`, or readiness `routeSummary.firstF12RequestDetail` for the
   first concrete request-detail drill-down.
6. Use readiness `routeSummary.*Artifact` entries for direct inspect/read routes
   into the saved F12 evidence files.
7. Use the correlation graph and auth boundary report to choose deeper
   drill-down.
8. Drill down with `devtools_request_detail`, `devtools_request_payload`,
   `devtools_capture_diff`, `devtools_token_scan`, `devtools_storage_snapshot`,
   `devtools_source_get`, or `devtools_trace_query` only when needed.

This keeps the default flow simple while preserving the lower-level F12 tools.

## CLI Shortcut

Start the Managed Browser server first:

```bash
CDP_LAUNCH_BROWSER=1 npm run agent:server
```

Then run:

```bash
npm run research:pack -- --url https://example.com --profile researcher
```

Use `--personal` to call the Personal Chrome bridge at `127.0.0.1:17337`
instead:

```bash
npm run research:pack -- --personal --url https://example.com --no-trace
```
