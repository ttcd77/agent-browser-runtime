# Agent DevTools Workflows

These examples use the unified `devtools_*` contract. They work in Managed
Browser mode and Personal Chrome mode as long as the selected backend is running.

## First Pass

Know which browser layer you are using:

```bash
curl -X POST http://127.0.0.1:17335/tool/devtools_backend_capabilities \
  -H "content-type: application/json" \
  -d "{\"profile\":\"default\"}"
```

In Managed Browser mode, browser-process CDP commands are available:

```bash
curl -X POST http://127.0.0.1:17335/tool/devtools_browser_cdp_command \
  -H "content-type: application/json" \
  -d "{\"method\":\"Browser.getVersion\"}"
```

```bash
curl -X POST http://127.0.0.1:17335/tool/agent_inspect \
  -H "content-type: application/json" \
  -d "{\"profile\":\"default\",\"focus\":\"overview\",\"limit\":10}"
```

Read `toolPlan.firstPass`, `nextTools`, and `completeness` before drilling down.

## Network Replay Variants

1. Start capture and reproduce the action.

```bash
curl -X POST http://127.0.0.1:17335/tool/devtools_capture_start \
  -H "content-type: application/json" \
  -d "{\"profile\":\"default\",\"clear\":true,\"label\":\"replay-test\"}"
```

2. Find a request id.

```bash
curl -X POST http://127.0.0.1:17335/tool/agent_inspect \
  -H "content-type: application/json" \
  -d "{\"profile\":\"default\",\"focus\":\"network\",\"limit\":20}"
```

3. Replay variants and compare response diffs.

```bash
curl -X POST http://127.0.0.1:17335/tool/devtools_request_replay_batch \
  -H "content-type: application/json" \
  -d "{\"profile\":\"default\",\"requestId\":\"<request-id>\",\"variants\":[{\"label\":\"json\",\"json\":{\"role\":\"tester\"}},{\"label\":\"form\",\"headers\":{\"Content-Type\":null},\"form\":{\"role\":\"tester\"}}]}"
```

The response includes `responseDiff` for status, headers, body length, previews,
and whether bodies were comparable.

## Application Evidence

```bash
curl -X POST http://127.0.0.1:17335/tool/agent_inspect \
  -H "content-type: application/json" \
  -d "{\"profile\":\"default\",\"focus\":\"storage\",\"includeHeavy\":true}"
```

Use `storageBoundarySummary` to see origins, storage keys, quota evidence, and
whether any frame/storage-key evidence was incomplete. Use
`cookiePartitionSummary` to see whether Chrome exposed partition metadata.

## Token Flow Trace

```bash
curl -X POST http://127.0.0.1:17335/tool/devtools_token_flow_trace \
  -H "content-type: application/json" \
  -d "{\"profile\":\"default\",\"durationMs\":1500,\"triggerExpression\":\"fetch('/api/me').catch(() => {})\"}"
```

This instruments fetch, XHR, storage, and document cookies during the trace
window. It is objective data-flow evidence, not a vulnerability verdict.
