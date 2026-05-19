# Dev Report: Add Operator Demo Report for Research Pack

**Date**: 2026-05-19  
**Commit**: see below  
**Author**: Claude

---

## Modified / Created Files

| File | Action |
|---|---|
| `scripts/security-research-demo-report.mjs` | **Created** — demo report helper module |
| `scripts/example-security-research-pack-smoke.mjs` | **Updated** — import helper, generate report, add 8 assertions |

No product files (examples, src, runtime) were changed. Documentation files were not changed because the existing `docs/security-research-pack.md` and `docs/agent-operator-runbook.md` already describe the operator handoff pattern from the previous round.

---

## Design

### `scripts/security-research-demo-report.mjs`

Exports a single function:

```js
export function buildOperatorDemoReport(result, options = {}) { ... }
```

Takes the structured output of `examples/security-research-pack.mjs` and returns a Markdown string. Sections:

| Section | Content |
|---|---|
| **Capture Summary** | backend, profile, URL, request count, console errors, failed requests, handoff/coverage status, capture boundaries |
| **F12 Evidence Surfaces** | table of artifact paths that are present; lists missing/skipped if any |
| **Operator Handoff** | `firstRead.purpose` + `firstRead.route` JSON block (bounded read call) |
| **First Request Drilldown** | `firstRequest` tool call JSON + URL, status, header count from `firstF12RequestDetail` |
| **Route Artifacts** | table with name + inspect tool + read tool for each route artifact |
| **Suggested Next Tool Calls** | up to 3 drilldown tool call blocks (from `operatorHandoff.drilldowns`) |
| **Objective Boundary** | fixed statement: "Collect browser evidence only; do not classify findings as vulnerabilities." |

The module also has a CLI entry point:

```bash
node scripts/security-research-demo-report.mjs <input.json> [output.md]
```

Design constraints enforced:
- No full JSON dumps (only compact `route` objects, max ~10 lines each).
- No `vulnerability found`, `high risk`, `exploitable`, `security score`.
- All content is derived from already-computed fields; zero new API calls.

### Smoke integration (Method A)

After all existing assertions pass, the smoke test:

1. Calls `buildOperatorDemoReport(output)` on the in-memory example result.
2. Writes the Markdown to `<tempDir>/operator-demo-report.md`.
3. Asserts 8 conditions:
   - Report is non-empty.
   - Contains `## Operator Handoff`.
   - Contains `## Objective Boundary`.
   - Contains the actual `researchPackPath` (confirms ≥1 artifact path is present).
   - Contains `devtools_artifact_read` (confirms next tool calls are present).
   - Does NOT contain `vulnerability found`.
   - Does NOT contain `high risk`.
   - Does NOT contain `exploitable`.

The report is written inside `tempDir`, which is already cleaned up by the `removePathWithRetry` logic from the previous round.

---

## Test Commands and Real Results

```
node --check scripts/security-research-demo-report.mjs    → syntax OK ✅
node --check scripts/example-security-research-pack-smoke.mjs → syntax OK ✅
npm run smoke:example                                      → EXIT 0 ✅
npm run check  (build + 83 unit tests + CLI smoke)          → EXIT 0 ✅
```

`npm run smoke:example` output (relevant lines):

```
Security research pack example smoke passed:
- fixture: http://127.0.0.1:33440/
- requests: 3
- research pack: ...\1779158627074-security-research-pack.json
- drilldowns: 5
- route artifacts: 11
- operatorHandoff.routeArtifacts: 11
- operatorHandoff.firstRequest.tool: devtools_request_detail
- operatorHandoff.drilldowns: 3
- demo report: ...\operator-demo-report.md (5620 chars)
SMOKE_EXIT: 0
```

Demo report: 5620 characters — compact summary, not a JSON dump.

---

## Generated Demo Report: Path Example

The report is written to `<tempDir>/operator-demo-report.md` during smoke (cleaned up after). In production use:

```bash
# Save the example output to JSON first
node examples/security-research-pack.mjs https://example.com > /tmp/pack.json

# Generate the Markdown report
node scripts/security-research-demo-report.mjs /tmp/pack.json /tmp/demo-report.md
```

---

## Commit Hash

**`<filled below>`**

---

## Unresolved Issues

None. All 8 new assertions pass. Cleanup still uses `removePathWithRetry` from the previous round — no regression.

---

## Next Steps

- If the demo report format stabilises, wire it into the CLI via `--report-md <path>` (task.md Method B) so operators get a Markdown report alongside the JSON summary automatically.
- Extract `waitForChildExit` and `removePathWithRetry` into `scripts/test-helpers.mjs` if a second smoke test needs them.
