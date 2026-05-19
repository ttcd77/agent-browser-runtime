#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const allowedTypes = new Set(["bug", "gap", "docs", "product", "idea"]);
const args = parseArgs(process.argv.slice(2));
const type = String(args.type || "gap").toLowerCase();
const title = String(args.title || "").trim();

if (!allowedTypes.has(type) || !title) {
  console.error(`Usage:
  npm run feedback:note -- --type bug|gap|docs|product|idea --title "Short title" [--summary "..."] [--tool "..."] [--profile "..."] [--expected "..."] [--actual "..."] [--next "..."]
`);
  process.exit(1);
}

const now = new Date();
const date = now.toISOString().slice(0, 10);
const slug = slugify(title).slice(0, 70) || "note";
const outDir = String(args.dir || process.env.AGENT_BROWSER_FEEDBACK_DIR || "feedback");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `${date}-${type}-${slug}.md`);

const body = `# ${title}

- type: ${type}
- createdAt: ${now.toISOString()}
- status: new
- privacy: local-note; review before publishing
- tool: ${field(args.tool)}
- profile: ${field(args.profile)}

## Summary

${field(args.summary)}

## Reproduction

${field(args.repro)}

## Expected

${field(args.expected)}

## Actual

${field(args.actual)}

## Evidence Pointers

${field(args.evidence)}

## Suggested Next Step

${field(args.next)}

## Public Issue Checklist

- [ ] No cookies, tokens, authorization headers, private screenshots, real HARs, or account state.
- [ ] Reproduced with a local fixture or public-safe target if possible.
- [ ] The issue describes objective tool behavior, not vulnerability impact.
`;

writeFileSync(outPath, body, "utf8");
console.log(JSON.stringify({ ok: true, path: outPath, type, title }, null, 2));

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      parsed[key] = "true";
    } else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function field(value) {
  const text = String(value || "").trim();
  return text || "_Not provided._";
}
