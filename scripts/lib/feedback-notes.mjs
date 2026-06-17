import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const allowedFeedbackTypes = new Set(["bug", "gap", "docs", "product", "idea"]);

export function createFeedbackNote(input = {}) {
  const type = String(input.type || "gap").toLowerCase();
  const title = String(input.title || "").trim();
  if (!allowedFeedbackTypes.has(type)) {
    throw new Error(`feedback type must be one of: ${[...allowedFeedbackTypes].join(", ")}`);
  }
  if (!title) {
    throw new Error("feedback title is required");
  }

  const now = input.createdAt ? new Date(input.createdAt) : new Date();
  const date = now.toISOString().slice(0, 10);
  const slug = slugify(title).slice(0, 70) || "note";
  const outDir = String(input.dir || process.env.AGENT_BROWSER_FEEDBACK_DIR || "feedback");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${date}-${type}-${slug}.md`);

  const body = `# ${title}

- type: ${type}
- createdAt: ${now.toISOString()}
- status: new
- privacy: local-note; review before publishing
- tool: ${field(input.tool)}
- profile: ${field(input.profile)}
- reporter: ${field(input.reporter)}

## Summary

${field(input.summary)}

## Reproduction

${field(input.repro)}

## Expected

${field(input.expected)}

## Actual

${field(input.actual)}

## Evidence Pointers

${field(input.evidence)}

## Suggested Next Step

${field(input.next)}

## Public Issue Checklist

- [ ] No cookies, tokens, authorization headers, private screenshots, real HARs, or account state.
- [ ] Reproduced with a local fixture or public-safe target if possible.
- [ ] The issue describes objective tool behavior, not vulnerability impact.
`;

  writeFileSync(outPath, body, "utf8");
  return {
    ok: true,
    path: outPath,
    type,
    title,
    createdAt: now.toISOString(),
    localOnly: true,
    privacy: "review-before-publishing",
  };
}

export function listFeedbackNotes(input = {}) {
  const dir = String(input.dir || process.env.AGENT_BROWSER_FEEDBACK_DIR || "feedback");
  const limit = Number.isFinite(Number(input.limit)) ? Math.max(1, Math.min(200, Number(input.limit))) : 50;
  if (!existsSync(dir)) return { ok: true, dir, notes: [] };
  const notes = readdirSync(dir)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .map((name) => {
      const path = join(dir, name);
      const stat = statSync(path);
      const text = readFileSync(path, "utf8");
      return {
        name,
        path,
        updatedAt: stat.mtime.toISOString(),
        size: stat.size,
        title: firstHeading(text) || name,
        type: metadataValue(text, "type") || inferTypeFromName(name),
        status: metadataValue(text, "status") || "unknown",
        tool: metadataValue(text, "tool") || null,
        profile: metadataValue(text, "profile") || null,
        summary: sectionPreview(text, "Summary"),
      };
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, limit);
  return { ok: true, dir, notes };
}

export function parseFeedbackArgs(argv) {
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

function firstHeading(text) {
  const match = /^#\s+(.+)$/m.exec(text);
  return match?.[1]?.trim() || null;
}

function metadataValue(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^- ${escaped}:\\s*(.+)$`, "mi").exec(text);
  const value = match?.[1]?.trim();
  if (!value || value === "_Not provided._") return null;
  return value;
}

function sectionPreview(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`## ${escaped}\\s+([\\s\\S]*?)(?:\\n## |$)`, "i").exec(text);
  const value = match?.[1]?.trim().replace(/\s+/g, " ");
  if (!value || value === "_Not provided._") return null;
  return value.length > 220 ? `${value.slice(0, 217)}...` : value;
}

function inferTypeFromName(name) {
  for (const type of allowedFeedbackTypes) {
    if (name.includes(`-${type}-`)) return type;
  }
  return "unknown";
}
