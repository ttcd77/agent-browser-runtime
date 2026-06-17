# Contributing to Agent Browser Runtime

Thanks for your interest. Here is everything you need to go from zero to a
merged PR.

---

## Development environment

```bash
git clone https://github.com/ttcd77/agent-browser-runtime.git
cd agent-browser-runtime
npm install
npm run build
```

Requirements: Node >= 20. The build step compiles TypeScript (`src/`) to `dist/`
and copies plugin manifests.

---

## Running tests

```bash
# Unit tests (no browser needed)
npm test

# Smoke tests (requires a running worker — see below)
npm run smoke:product
npm run smoke:server
npm run smoke:f12

# Full offline gate
npm run check

# Professional gate (starts a real browser — takes ~2 min)
npm run check:professional
```

Start the worker for smoke tests:

**Linux / macOS:**
```bash
CDP_LAUNCH_BROWSER=1 npm run agent:server
```

**Windows (PowerShell):**
```powershell
$env:CDP_LAUNCH_BROWSER="1"
npm run agent:server
```

---

## Adding a new tool

Tools live in `scripts/lib/register-*.mjs`. Each file registers a family of
related tools by calling a shared `registerTool(server, name, schema, handler)`
pattern.

Steps:

1. Pick or create the right `register-*.mjs` file for your tool family.
2. Define a Zod input schema and a handler function.
3. Call `registerTool(...)` — follow the existing pattern in the same file.
4. Add the tool name to `scripts/lib/__fixtures__/tool-registry.snapshot.json`
   and run the dual-backend completeness test:
   ```bash
   node scripts/devtools-contract-check.mjs
   ```
### Dual-backend completeness rule

Tools that operate on page state should work on both the Managed Browser backend
and the Personal Chrome backend, or explicitly declare they are Managed-only.
The completeness test (`scripts/lib/dual-backend-completeness.test.mjs`) enforces
this. Before submitting, check that your tool either:

- passes both backend paths, or
- is listed in the `managedOnly` set with a documented reason.

### Reverse check

If you delete or rename an existing tool, search for references in
`scripts/lib/register-aliases.mjs`, `docs/agent-devtools-api.md`,
and the SKILL.md files in any dependent project.

---

## PR conventions

### Commit messages

```
type: short description (< 72 chars)

Optional longer explanation.
```

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`.

One logical change per commit. Do not bundle unrelated fixes.

### Tests required

- New tools: add at least one unit test in the corresponding
  `register-*.test.mjs` file.
- Bug fixes: add a test that fails before the fix and passes after.
- New CLI verbs: add a case to `scripts/agent-browser-cli-smoke.mjs`.

### Before opening a PR

```bash
npm run check       # build + unit tests + smoke
npm run lint        # ESLint on scripts/lib/
```

Fix all lint errors. The CI gate runs the same commands.

---

## Code style

No separate ESLint config file — follow the style you see in `scripts/lib/`:

- ES modules (`import`/`export`), not CommonJS.
- `async`/`await`, not `.then()` chains.
- Prefer early returns over deep nesting.
- Tool handlers return plain objects — no throwing strings.
- Zod schemas go at the top of the register block, above the handler.
- Keep tool descriptions short and imperative: "Capture network traffic for a
  profile" not "This tool can be used to capture...".

---

## Reporting bugs

Use the GitHub issue templates:

- **Bug report** — unexpected tool behavior, wrong output shape, crashes.
- **Capability gap** — something F12 can do that ABR cannot.
- **Feedback** — UX friction, confusing tool names, missing next-step hints.

Security issues: do not open a public issue. Email the maintainer directly or
use the private security advisory on GitHub. Do not include HAR files, cookies,
or session tokens in any public issue.

Templates: `.github/ISSUE_TEMPLATE/`

---

## Project structure (quick map)

```
src/
  plugins/             CDP traffic capture, browser profile pool (TypeScript)
  plugin-sdk/          definePluginEntry — plugin host adapter interface
scripts/
  agent-cdp-server.mjs Main worker — HTTP server, backend routing
  agent-browser-cli.mjs CLI entry point
  lib/
    register-*.mjs     Tool registration families
    *-smoke.mjs        Smoke tests
    *-contract*.mjs    Schema / completeness contract checks
    lib/               Shared utilities (network, evidence, replay, ...)
dist/                  Compiled TypeScript output (git-ignored)
docs/                  Product documentation
examples/              Runnable examples
extension/             Personal Chrome extension source
```
