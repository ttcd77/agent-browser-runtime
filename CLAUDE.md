# Claude Guide — Agent Browser Runtime

## First Step

Always work in this repository:

```powershell
cd <agent-browser-runtime>
```

Do not implement or commit this project's tasks from a workstation control
directory. Work from this repository root.

## Task Handoff

For delegated work, read the current task file first:

```powershell
Get-Content .\task.md -Raw
```

Follow `task.md` as the source of truth for scope, tests, commit message, and report path.

## Product Boundary

This project is an agent-facing F12 / DevTools evidence runtime.

- Collect objective browser evidence.
- Expose evidence paths, tool calls, and browser/DevTools boundaries.
- Do not classify findings as vulnerabilities.
- Do not add risk scores, exploitability scores, or severity judgments.
- Use local fixtures or explicitly authorized test pages only.

## Reporting

After completing a delegated task:

1. Commit the work.
2. Write the full result into the dev report path specified by `task.md`.
3. In chat, reply only with:

```text
完成。结果文件: <path>
Commit: <hash>
Tests: <short pass/fail summary>
```

Do not paste long reports into chat unless explicitly asked.

## Checks

Use the checks required by `task.md`. Common checks:

```powershell
npm run smoke:example
npm run check
npm run release:readiness
```

`smoke:personal` requires the Personal Chrome extension and bridge to be running.
