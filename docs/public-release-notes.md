# Public Release Notes

This repository is public as an active work-in-progress. The current goal is to build a practical local browser evidence layer for AI agents, with Managed Browser/CDP as the mainline and Personal Chrome as an optional operator-authorized bridge.

## Current Status

- Managed Browser workflow: ready for local professional testing.
- Personal Chrome workflow: beta, useful for explicit local debugging.
- Public examples: use `example.com` or local fixtures.
- Real target evidence: intentionally excluded from this repository.

## Recommended Checks

Run before sharing a commit:

```bash
npm run release:readiness
npm run check:professional
git status --short
```

Quick tracked-file scan:

```powershell
$patterns = '(targets/active|\.har$|runtime/|profiles|cookies|token|secret|browser-runtime-2026|AppData|\.png$|\.zip$|\.tgz$)'
git ls-files | Select-String -Pattern $patterns -CaseSensitive:$false
```

The expected result is no private runtime data. Documentation filenames may match words such as `evidence`; review those manually.

## Keep Private

Do not publish:

- real target evidence,
- authenticated HAR files,
- browser profile folders,
- screenshots containing private accounts,
- local logs with credentials or tokens,
- personal Chrome runtime state.

## Near-Term Work

- Improve public demo flow and examples.
- Continue hardening the native MCP stdio server and custom adapter examples.
- Continue hardening the F12 parity layer around complex sites.
- Package the Personal Chrome extension once the beta path is stable.
