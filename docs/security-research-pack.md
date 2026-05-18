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
   HAR, Application export, Chrome trace, trace summary, compact evidence
   bundle, evidence manifest, request correlation graph, auth boundary report,
   and worker/frame boundary report.
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
- capture boundaries so the agent knows what time window was recorded.

The saved paths are local files under the selected profile evidence directory.
They are intentionally not hidden behind a UI because agents need direct,
machine-readable artifacts.

The CLI shortcut also calls `devtools_professional_readiness` after the pack is
created. This gives the agent a separate mechanical check for workflow,
capture, artifact inventory, and evidence timeline readiness. It is still only
an evidence-readiness check, not a vulnerability judgment.

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
5. Use the correlation graph and auth boundary report to choose drill-down.
6. Drill down with `devtools_request_detail`, `devtools_request_payload`,
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
