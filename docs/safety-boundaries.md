# Safety Boundaries

Agent Browser Runtime is for authorized security testing and local browser observability.

It can expose sensitive data:

- cookies, including HttpOnly cookies,
- bearer tokens and session ids in headers,
- request and response bodies,
- WebSocket frames,
- Server-Sent Events,
- script sources,
- account-specific browser storage.

Do not use it on systems, accounts, or browser profiles you are not authorized to test.

## Recommended Setup

- Create dedicated browser profiles for each target and account identity.
- Use names such as `target-attacker`, `target-victim`, `target-admin`, and `target-clean`.
- Do not point the runtime at your personal daily browser profile for target testing.
- Keep captured bodies and spool files out of Git.
- Sanitize evidence before sharing reports.

## Personal Browser Mode

For private debugging, you may intentionally attach an agent to a browser window
you are using yourself. This is useful when you see a strange UI, login, network,
or rendering issue and want an agent to inspect the same state.

Boundary:

- this works only when the browser was launched with remote debugging enabled,
- it may expose your personal cookies and account data to the local tool server,
- use it for your own accounts and your own debugging only,
- use dedicated target profiles for security testing.

## Agent Instructions

Agent prompts should make the authorization boundary explicit:

```text
Use CDP tools only against the configured test profiles and authorized target scope.
Do not clear cookies, intercept requests, or inspect account data outside those profiles.
```

## Request Interception

`cdp_fetch_intercept` is intended for controlled experiments in authorized test sessions:

- header mutation,
- Origin/Referer checks,
- frontend fault injection,
- reproducing browser-only request behavior.

It is not an anti-bot bypass feature.
