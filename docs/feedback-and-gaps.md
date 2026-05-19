# Feedback And Capability Gap Protocol

Agent Browser Runtime should improve from real agent usage. When an agent hits a
bug, confusing workflow, missing F12 capability, or weak handoff path, record it
as a feedback note before continuing.

## Feedback Types

| Type | Meaning |
|---|---|
| `bug` | Something documented or expected failed. |
| `gap` | A needed F12/AppSec capability is missing or too weak. |
| `docs` | A new agent could not understand how to proceed. |
| `product` | The workflow works but feels awkward or confusing. |
| `idea` | A non-blocking improvement. |

## Local Notes

Use:

```bash
npm run feedback:note -- --type bug --title "browser_inspect network omits redirect chain" --summary "The agent had a requestId but could not see redirect hops from the facade."
```

This writes a markdown note to `feedback/`. The directory is for local triage.
Do not commit sensitive feedback notes. If a note is safe and generally useful,
turn it into a GitHub issue using the templates in `.github/ISSUE_TEMPLATE/`.

Useful fields:

```bash
npm run feedback:note -- \
  --type gap \
  --title "Need source map source search from facade" \
  --summary "Agent had a keyword but had to choose low-level source-map tools manually." \
  --tool browser_inspect \
  --profile demo-fixture \
  --expected "browser_inspect focus=sources should return next tool route." \
  --actual "Only sources_list was obvious." \
  --next "Add source-map drilldown to routeSummary."
```

## Privacy Rule

Never put these in public issues:

- cookies,
- authorization headers,
- API keys,
- real target HARs,
- screenshots with accounts,
- private URLs,
- raw response bodies from authenticated sessions.

For public issues, replace sensitive artifacts with:

- local fixture reproduction,
- `example.com` reproduction,
- redacted structure,
- tool names and objective symptom,
- expected vs actual behavior.

## Agent Triage Loop

1. Record the note.
2. Continue the task if safe.
3. At the end of the round, group notes into:
   - quick fix,
   - needs design,
   - browser boundary,
   - documentation gap.
4. Fix quick items with tests.
5. Convert larger items into GitHub issues or roadmap entries.

## What Counts As A Tool Gap?

A tool gap is not “the tool did not find a vulnerability.” A tool gap is one of:

- Chrome exposes data that the runtime does not surface.
- A facade route does not point to the right low-level tool.
- A handoff lacks the next concrete artifact path or request id.
- A profile/capture state is ambiguous.
- A failure message does not tell the next agent what to do.

The runtime should expose evidence and boundaries. It should not decide impact.

