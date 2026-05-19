# Dev Report: CLI Markdown Report Output (`--report-md`)

**Date**: 2026-05-19
**Commit**: d0950dd
**Task**: Add `--report-md <path>` to `scripts/security-research-pack-cli.mjs`

---

## Modified Files

| File | Change |
|---|---|
| `scripts/security-research-pack-cli.mjs` | Added `--report-md` arg, `adaptPackForReport()` export, report write in `main()` |
| `scripts/research-pack-cli-smoke.mjs` | Added `--report-md` parseArgs assertions + adapter + report content assertions |
| `docs/security-research-pack.md` | Documented `--report-md` under CLI Shortcut section |

---

## Commit Hash

```
d0950dd Add CLI markdown report output
```

---

## Test Commands and Results

```
node --check scripts/security-research-pack-cli.mjs   → OK
node --check scripts/security-research-demo-report.mjs → OK
npm run smoke:cli                                      → Research pack CLI smoke passed
npm run smoke:example                                  → Security research pack example smoke passed
npm run check                                          → build OK, 83 tests passed, smoke:cli OK
```

Full `npm run check` output:
- TypeScript build: OK (2 plugin manifests copied)
- Unit tests: 83 passed (2 test files)
- `smoke:cli`: Research pack CLI smoke passed

`npm run smoke:example` output:
- fixture requests: 3
- route artifacts: 11
- operatorHandoff.routeArtifacts: 11
- operatorHandoff.firstRequest.tool: devtools_request_detail
- demo report: 5620 chars

---

## `--report-md` Output Path Example

```powershell
npm run research:pack -- --url http://127.0.0.1:PORT/ --report-md .\tmp\operator-demo-report.md
```

CLI prints:
```
- operator demo report: C:\...\tmp\operator-demo-report.md
```

Parent directories are created automatically. Write failures surface as exceptions (no silent swallowing).

---

## Design

### Adapter pattern (`adaptPackForReport`)

The CLI receives a `pack` object from `devtools_security_research_pack`, which has a flat structure (`pack.summary.*Path`, `pack.professionalReadiness`, etc.). The existing `buildOperatorDemoReport` was designed for the example output shape (`result.artifactPaths`, `result.operatorHandoff`, `result.afterReadiness`, etc.).

Rather than modifying the helper (which would risk changing existing example smoke behavior), a dedicated `adaptPackForReport(pack, profile)` function translates the CLI pack into the expected shape:

- `pack.summary.*Path` → `artifactPaths.*`
- `pack.professionalReadiness` → `afterReadiness`
- `pack.handoffCompleteness` → `handoff`
- `pack.professionalReadiness.routeArtifacts` → `operatorHandoff.routeArtifacts` (array form)
- `pack.professionalReadiness.routeSummary.latestHandoffRead` → `operatorHandoff.firstRead.route`
- `pack.firstF12RequestDetail.sections.headers` → `firstF12RequestDetail.headerSummary` (flat form the helper reads)
- `pack.drilldownPlan.drilldowns` → `operatorHandoff.drilldowns` + `firstDrilldowns`

The adapter is exported so the smoke test can import and verify it in isolation without needing a real server.

### No changes to `buildOperatorDemoReport`

The helper was not modified. Its output for the example smoke is unchanged (confirmed by `smoke:example` passing).

### Smoke test additions (`research-pack-cli-smoke.mjs`)

Added to the existing in-process smoke:
1. `parseArgs` assertion for `--report-md`
2. `usage()` assertion for `--report-md`
3. `adaptPackForReport` unit assertions (backend, profile, url, artifactPaths, operatorHandoff shape, headerSummary)
4. `buildOperatorDemoReport` call with adapted mock pack, writing to a temp dir
5. Content assertions: `## Operator Handoff`, `## Objective Boundary`, `devtools_artifact_read`, artifact path presence
6. Forbidden content assertions: no `vulnerability found`, `high risk`, `exploitable`
7. Round-trip assertion: file on disk matches in-memory string

---

## Unresolved Issues

None for this scope.

---

## Next Steps

- When `devtools_professional_readiness` is unavailable (the CLI already catches this and sets `unavailable: true`), `adaptPackForReport` will produce an `operatorHandoff` with empty route artifacts and a fallback boundary string. This is intentional and tested indirectly by the existing error branch in `main()`.
- If a future backend surfaces `operatorHandoff` directly in the research pack response, the adapter can be simplified to pass it through rather than reconstructing from `routeArtifacts`.
- The `--report-md` flag is independent of `--json`; both can be used together if desired (the report is written after JSON print).
