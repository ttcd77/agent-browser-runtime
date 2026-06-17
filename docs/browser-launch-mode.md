# Browser Launch Mode

## Default

Managed Browser defaults to **headful** mode for professional AppSec work.

That means when the runtime launches Edge/Chrome, it opens a visible browser
window. The operator can watch the agent navigate, type, click, and collect F12
evidence.

## Why Headful By Default

Headful mode is closer to how a human researcher uses F12:

- visible UI state can be inspected by the operator;
- browser focus, keyboard input, and user-gesture behavior are easier to verify;
- WebRTC/media flows are less likely to diverge from normal browser behavior;
- target validation is easier to explain and reproduce.

## When To Use Headless

Use headless only for CI, smoke tests, and non-interactive regression runs:

```powershell
$env:CDP_BROWSER_HEADLESS="1"
```

The smoke scripts set this explicitly so automated checks do not steal focus or
open windows during development.

## Health Metadata

`GET /health` returns:

- `browserLaunchMode`: `headful`, `headless`, or `existing-cdp-browser`;
- `browserHeadless`: `true`, `false`, or `null` when attached to an existing
  CDP browser;
- `professionalDefault`: `headful-managed-browser`.

This metadata is evidence about the runtime environment. It does not classify
the target or the captured behavior.
