# GitHub Publish Guide

This guide is for preparing Agent Browser Runtime as a public portfolio repository.

## Recommended Repository

- Name: `agent-browser-runtime`
- Visibility: public when ready to attach to applications; private until then if you want another review pass.
- Description: `Local DevTools/F12 evidence runtime for AI agents and AppSec workflows.`
- Topics: `ai-agent`, `chrome-devtools-protocol`, `cdp`, `devtools`, `browser-tools`, `security-research`, `appsec`

## Pre-Push Checklist

Run:

```bash
npm run release:readiness
npm run check:professional
git status --short
```

Before pushing, confirm:

- no target evidence is tracked,
- no HAR files are tracked,
- no browser profile directories are tracked,
- no cookies, bearer tokens, account screenshots, or private target notes are tracked,
- README links to the portfolio one-pager, roadmap, safety boundaries, and operator runbook,
- the latest commit represents a clean, explainable checkpoint.

Quick tracked-file scan:

```powershell
$patterns = '(targets/active|\.har$|runtime/|profiles|cookies|token|secret|browser-runtime-2026|AppData|\.png$|\.zip$|\.tgz$)'
git ls-files | Select-String -Pattern $patterns -CaseSensitive:$false
```

The expected result is no private runtime data. Documentation filenames may match terms such as `evidence`; review those manually.

## What To Say In Applications

Short version:

> I built Agent Browser Runtime, a local DevTools/F12 evidence runtime for AI agents. It gives agents a facade-first browser API plus low-level CDP drilldowns for Network, Application, Elements, Sources, Security, Performance, Trace, WebSocket/SSE, and evidence-pack workflows. The tool is designed for objective AppSec evidence capture rather than vulnerability scoring.

Longer version:

> The project came from a practical problem in agentic security research: agents can click around websites, but they often cannot see the evidence a human researcher would inspect in Chrome DevTools. I built a local runtime that starts a managed browser, records profile-scoped evidence, exposes F12-style drilldowns, and emits machine-readable research packs that another agent can resume from. I deliberately kept the tool boundary objective: it collects browser facts and artifact paths, while the human or model performs the security judgment.

## Keep Private

Do not publish:

- real target evidence under `targets/active`,
- authenticated HAR files,
- browser profile folders,
- screenshots containing private accounts,
- local logs with credentials or tokens,
- personal Chrome runtime state.

## After First Push

Good follow-up polish:

- add a short demo GIF using only `example.com` or a local fixture,
- add GitHub Actions for `npm run release:readiness` and `npm run check`,
- add a minimal MCP adapter package,
- add a signed or packaged Personal Chrome extension release when that path matures.

