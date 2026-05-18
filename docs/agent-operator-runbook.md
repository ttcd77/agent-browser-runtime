# Agent Operator Runbook

This runbook is for an AI agent using Agent Browser Runtime professionally.

## First Principle

The runtime is an evidence tool. It reports browser facts, artifact paths, capture
boundaries, and unavailable data. It does not decide whether something is a
vulnerability.

## Default Workflow

For professional AppSec work, the default route is:

```text
browser_open -> browser_capture -> browser_inspect -> browser_security_pack -> drilldownPlan
```

You can retrieve this as machine-readable instructions:

```bash
curl -X POST http://127.0.0.1:17335/tool/devtools_workflow_guide \
  -H "content-type: application/json" \
  -d "{\"profile\":\"default\",\"task\":\"professional-appsec\"}"
```

1. Check backend capability.

```bash
curl -X POST http://127.0.0.1:17335/tool/devtools_backend_capabilities \
  -H "content-type: application/json" \
  -d "{\"profile\":\"default\"}"
```

2. Open or attach to a page.

```bash
curl -X POST http://127.0.0.1:17335/tool/browser_open \
  -H "content-type: application/json" \
  -d "{\"profile\":\"default\",\"url\":\"https://example.com\"}"
```

3. Start capture before reproducing behavior.

```bash
curl -X POST http://127.0.0.1:17335/tool/browser_capture \
  -H "content-type: application/json" \
  -d "{\"profile\":\"default\",\"action\":\"start\",\"clear\":true,\"label\":\"first-pass\"}"
```

4. Interact through the facade.

```bash
curl -X POST http://127.0.0.1:17335/tool/browser_act \
  -H "content-type: application/json" \
  -d "{\"profile\":\"default\",\"action\":\"snapshot\"}"
```

5. Inspect by focus area instead of guessing tools.

```bash
curl -X POST http://127.0.0.1:17335/tool/browser_inspect \
  -H "content-type: application/json" \
  -d "{\"profile\":\"default\",\"focus\":\"overview\",\"limit\":10}"
```

Read `summary`, `completeness`, `nextTools`, and `toolPlan` before drilling
down. If data is missing, decide whether a reload/capture boundary is needed.

## Network Table Drilldown

Use `devtools_network_summary` for first-pass counts. When the table is large,
use `devtools_network_log` or `devtools_network_timeline` with filters instead
of asking the model to scan everything:

```bash
curl -X POST http://127.0.0.1:17335/tool/devtools_network_log \
  -H "content-type: application/json" \
  -d "{\"profile\":\"default\",\"url_contains\":\"/api/\",\"status_min\":200,\"status_max\":299,\"resource_type\":\"Fetch\",\"sort_by\":\"start\",\"sort_dir\":\"asc\",\"limit\":50}"
```

Useful objective filters: `url_contains`, `hostname`, `method`, `status`,
`status_min`, `status_max`, `resource_type`, `mime_contains`, `failed`,
`redirected`, `from_cache`, `from_service_worker`, `has_request_body`,
`has_response_body`, `request_header`, and `response_header`. Header filters use
`{"name":"content-type","valueContains":"json"}`. The tool returns
`filtersApplied` so the evidence record shows how the table was reduced.

## Redirect Drilldown

Use `browser_inspect` or `devtools_network_summary` first. If a row reports a
redirect chain, call:

```bash
curl -X POST http://127.0.0.1:17335/tool/devtools_request_detail \
  -H "content-type: application/json" \
  -d "{\"profile\":\"default\",\"requestId\":\"<request-id>\"}"
```

Read `redirectChain`, `status`, response headers, `initiator`, and
`initiatorSourceContext` together. The runtime reports the chain Chrome observed
during capture; it does not infer missing historical redirects from cache or
server logs.

## Request Replay Boundary

`devtools_request_replay` and `devtools_request_replay_batch` replay captured
requests with browser `fetch` from the current page context. Always read
`replayBoundary`:

- `headerHandling.skippedHeaders` explains headers the browser refused to send.
- `bodyHandling` explains whether the replay included a body and how it was
  encoded.
- `replayTransport` records credential mode, redirect mode, cache mode, method,
  and URL.
- `captureBoundaries` states what this replay cannot prove: it is not a raw
  socket/TLS/HTTP2-level reproduction.

Use replay output as evidence for follow-up reasoning, not as a standalone
finding.

## Trace Drilldown

Capture a short trace around the smallest reproducible action:

```bash
curl -X POST http://127.0.0.1:17335/tool/devtools_chrome_trace \
  -H "content-type: application/json" \
  -d "{\"profile\":\"default\",\"durationMs\":1000,\"maxEvents\":20}"
```

Then query by category, event name, duration, thread, or time range:

```bash
curl -X POST http://127.0.0.1:17335/tool/devtools_trace_query \
  -H "content-type: application/json" \
  -d "{\"profile\":\"default\",\"tracePath\":\"<trace-path>\",\"minDurationMs\":5,\"contextEvents\":2}"
```

`contextWindows` returns neighboring events on the same trace thread around the
first matched events. Use it like the Performance panel's local context: helpful
for orientation, but not causal proof by itself.

## One-Call Evidence Pack

For a repeatable first-pass evidence package:

```bash
npm run research:pack -- --url https://example.com --profile researcher
```

This calls `devtools_security_research_pack` and prints local artifact paths,
the workflow used, capture status, artifact kind counts, handoff readiness, and
first drill-down tools. Use `--json` for the full response.

When reading a returned pack, check these fields before deeper analysis:

- `summary.handoffReady`: whether the mechanical handoff checklist is complete.
- `summary.handoffMissing`: missing handoff components, if any.
- `handoffCompleteness.checks`: objective checklist for workflow, research pack,
  drilldown plan, artifact index, evidence timeline, capture status, and F12
  parity matrix.
- `summary.researchPackPath`: the saved cross-session handoff JSON.
- `summary.drilldownPlanPath`: deterministic next tool routes.
- `summary.capture`: final capture status and observed traffic count.

Read the handoff file with bounded artifact tools instead of loading every
artifact into context:

```bash
curl -X POST http://127.0.0.1:17335/tool/devtools_artifact_read \
  -H "content-type: application/json" \
  -d "{\"profile\":\"researcher\",\"path\":\"<researchPackPath>\",\"mode\":\"line\",\"startLine\":1,\"maxLines\":120}"
```

## Choosing Tools

Use this order:

1. `browser_*` facade.
2. `agent_inspect` or `browser_inspect` with a focus area.
3. `devtools_capability_map` or `devtools_workflow_guide`.
4. Exact `devtools_*` drill-down tool.
5. Raw CDP command only when there is no wrapper.

## Backend Choice

Use Personal Profile when the user says:

- "inspect what I am seeing",
- "use my current browser",
- "this only happens in my logged-in state".

Use Agent Browser when the task needs:

- clean profile state,
- repeatable target work,
- profile-scoped evidence directories,
- broader direct-CDP coverage.

## Artifact Discipline

Prefer saved paths for large evidence:

- HAR,
- trace JSON,
- Application export,
- evidence bundle,
- manifest,
- request correlation graph.

Do not paste large bodies, traces, or heap files into model context. Read or
query artifacts only when needed.
