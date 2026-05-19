# Professional Scorecard Gate

Date: 2026-05-19

## What Changed

Added `scripts/professional-scorecard.mjs` and `npm run professional:scorecard`.

The scorecard starts a temporary Managed Browser, calls the existing objective
F12 tools, and returns a machine-readable maturity summary:

- `devtools_f12_parity_matrix`
- `devtools_capability_map`
- `devtools_workflow_guide`
- `devtools_professional_readiness`
- `devtools_tool_catalog`

It does not inspect a real target and does not judge vulnerabilities. It checks
whether the professional AppSec evidence workflow is mechanically aligned.

## Latest Result

`npm run professional:scorecard` returned:

- Verdict: `professional-core-ready`
- Backend: `managed-cdp`
- AppSec core aligned: `true`
- Workflow aligned: `true`
- Objective boundary held: `true`
- Facade-first route present: `true`
- Evidence-pack route present: `true`
- Raw CDP escape hatch present: `true`
- F12 panel rows: `9`
- Strong panel rows: `8`
- Intentional gap rows: `DevTools UI Extras`

The intentional gap is UI-only DevTools extras such as Lighthouse UI, Recorder
UI, Sensors, Overrides, Animations, Rendering overlays, and visual editor
affordances. The scorecard keeps these explicit instead of pretending they are
implemented.

## Gate Integration

`npm run check:professional` now includes `npm run professional:scorecard`.

`scripts/open-source-readiness.mjs` now requires the `professional:scorecard`
script to remain present.

## Verification

- `node --check scripts/professional-scorecard.mjs`: passed
- `npm run professional:scorecard`: passed
- `npm run release:readiness`: passed
- `npm run check:professional`: passed

## Objective Boundary

This change only measures tool capability and workflow readiness. It does not
classify any browser signal as a vulnerability, exploit, or risk.
