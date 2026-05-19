# Keyboard Input And Text Click

Date: 2026-05-19

## Why

The 8x8 Jitsi prejoin page showed a real product gap in the browser runtime:
writing `input.value` through DOM evaluation was not enough for React/Jitsi to
enable the `Join meeting` action. The button also exposed an older text-click
bug: text mode was shadowed by the default `document` selector.

## Changes

- Added `inputMode: "keyboard"` to `browser_type` / `devtools_type`.
- Keyboard mode focuses the selected element, clears it with CDP key events,
  inserts text with `Input.insertText`, and returns the final value.
- Fixed text-click selection so calls such as
  `browser_act action=click text="Join meeting"` actually search visible text
  and ARIA labels when no CSS selector is supplied.
- Documented keyboard input mode in the README quickstart examples.

## Live Evidence

Controlled 8x8 single-flow validation produced:

- Keyboard input recognized by the page.
- `Join meeting` button changed from disabled to enabled.
- Text click succeeded.
- F12 capture recorded `conference-request`, `xmpp-websocket`,
  `focus@auth`, `notAllowed`, and `Room does not exist` markers.
- HAR recorded 69 requests, including:
  - `POST /conference-request/v1?room=builder-verify` with HTTP 200.
  - `GET /vmms-conference-mapper/...conference-creator...` with HTTP 404.

Evidence path:

`C:\Users\Tong\project\helloworld\targets\active\8x8\evidence\browser-runtime-2026-05-19-keyboard-click-flow\8x8-builder-verify-keyboard-click-flow-summary.md`

## Objective Boundary

This report documents browser runtime capability and captured evidence only. It
does not classify vulnerability impact or severity.
