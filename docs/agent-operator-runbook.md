# Agent Operator Runbook

This runbook is for an AI agent using Agent Browser Runtime professionally.

## First Principle

The runtime is an evidence tool. It reports browser facts, artifact paths, capture
boundaries, and unavailable data. It does not decide whether something is a
vulnerability.

## Default Workflow

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

## One-Call Evidence Pack

For a repeatable first-pass evidence package:

```bash
npm run research:pack -- --url https://example.com --profile researcher
```

This calls `devtools_security_research_pack` and prints local artifact paths.
Use `--json` for the full response.

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
