# Realtime Payload Filter

## Why

The 8x8/Jitsi browser validation showed that important evidence may live inside
WebSocket frames rather than normal HTTP request rows. For example, XMPP-over-
WebSocket signals such as room-join failures, focus JIDs, and application errors
can be buried in a large realtime stream.

The tool layer should not classify those strings as vulnerabilities. It should
make them objectively retrievable.

## Changed

- `devtools_realtime_log` / `profile_realtime_log` now accepts:
  - `payload_contains`
  - `direction`
  - `requestId`
  - `url_contains`
  - `limit`
  - `maxPayloadChars`
- WebSocket channels can now be filtered by matching frame payloads.
- EventSource/SSE messages can now be filtered by message payload.
- The same filter contract is now implemented in both Managed Browser/CDP and
  Personal Chrome/chrome.debugger mode.
- Results include:
  - `filters`
  - `websocketFrameCount`
  - `matchingWebsocketFrameCount`
  - per-socket `matchingFrameCount`
  - concrete `recommendedDrilldowns`

## Regression

`scripts/devtools-f12-smoke.mjs` now creates a local WebSocket and EventSource
fixture, then verifies payload filtering for both:

- WebSocket `AGENT_WS_MARKER`
- SSE `AGENT_SSE_MARKER`

## Boundary

This remains an objective evidence tool. It does not decide exploitability,
severity, or whether a protocol message is dangerous.
