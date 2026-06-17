import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFeedbackNote,
  listFeedbackNotes,
  parseFeedbackArgs,
  allowedFeedbackTypes,
} from "./feedback-notes.mjs";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "feedback-notes-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── createFeedbackNote ─────────────────────────────────────────────────────────

describe("createFeedbackNote — happy path", () => {
  it("writes a .md file and returns {ok, path, type, title, createdAt, localOnly}", () => {
    const result = createFeedbackNote({ dir, type: "bug", title: "Widget crashes on click" });
    expect(result.ok).toBe(true);
    expect(result.type).toBe("bug");
    expect(result.title).toBe("Widget crashes on click");
    expect(result.localOnly).toBe(true);
    expect(result.privacy).toBe("review-before-publishing");
    // file on disk
    const text = readFileSync(result.path, "utf8");
    expect(text).toContain("# Widget crashes on click");
    expect(text).toContain("- type: bug");
    expect(text).toContain("- status: new");
  });

  it("uses slug of the title in the filename", () => {
    const result = createFeedbackNote({ dir, type: "gap", title: "Missing timeout option" });
    expect(result.path).toMatch(/missing-timeout-option/);
  });

  it("defaults type to 'gap' when not provided", () => {
    const result = createFeedbackNote({ dir, title: "Some gap" });
    expect(result.type).toBe("gap");
    expect(result.path).toContain("-gap-");
  });

  it("uses env AGENT_BROWSER_FEEDBACK_DIR when no dir param", () => {
    const envKey = "AGENT_BROWSER_FEEDBACK_DIR";
    const prev = process.env[envKey];
    process.env[envKey] = dir;
    try {
      const result = createFeedbackNote({ title: "Env dir test", type: "docs" });
      expect(result.ok).toBe(true);
      expect(result.path).toContain(dir);
    } finally {
      if (prev === undefined) delete process.env[envKey];
      else process.env[envKey] = prev;
    }
  });

  it("embeds summary, repro, expected, actual when provided", () => {
    const result = createFeedbackNote({
      dir,
      type: "bug",
      title: "Crash test",
      summary: "Crashes when table is empty",
      repro: "1. Open page 2. Empty table",
      expected: "Should show empty state",
      actual: "Throws RangeError",
    });
    const text = readFileSync(result.path, "utf8");
    expect(text).toContain("Crashes when table is empty");
    expect(text).toContain("1. Open page 2. Empty table");
    expect(text).toContain("Should show empty state");
    expect(text).toContain("Throws RangeError");
  });

  it("respects a fixed createdAt for deterministic filenames", () => {
    const createdAt = "2025-01-15T10:00:00.000Z";
    const result = createFeedbackNote({ dir, type: "idea", title: "Fixed date idea", createdAt });
    expect(result.path).toContain("2025-01-15");
    expect(result.createdAt).toBe(createdAt);
  });

  it("all allowedFeedbackTypes work without throwing", () => {
    for (const type of allowedFeedbackTypes) {
      const result = createFeedbackNote({ dir, type, title: `Test ${type}` });
      expect(result.ok).toBe(true);
      expect(result.type).toBe(type);
    }
  });
});

// ── createFeedbackNote — error cases ──────────────────────────────────────────

describe("createFeedbackNote — error cases", () => {
  it("throws when title is empty", () => {
    expect(() => createFeedbackNote({ dir, type: "bug", title: "" })).toThrow("feedback title is required");
  });

  it("throws when title is only whitespace", () => {
    expect(() => createFeedbackNote({ dir, type: "bug", title: "   " })).toThrow("feedback title is required");
  });

  it("throws when type is not in allowedFeedbackTypes", () => {
    expect(() => createFeedbackNote({ dir, type: "unknown", title: "Test" })).toThrow("feedback type must be one of:");
  });

  it("error message lists the valid types", () => {
    let msg = "";
    try { createFeedbackNote({ dir, type: "invalid", title: "X" }); } catch (e) { msg = e.message; }
    for (const t of allowedFeedbackTypes) expect(msg).toContain(t);
  });
});

// ── createFeedbackNote — edge cases ───────────────────────────────────────────

describe("createFeedbackNote — edge cases", () => {
  it("normalises type to lowercase (e.g. 'Bug' → 'bug')", () => {
    const result = createFeedbackNote({ dir, type: "BUG", title: "Upper type" });
    expect(result.type).toBe("bug");
  });

  it("truncates the filename slug to 70 chars", () => {
    const longTitle = "A".repeat(200);
    const result = createFeedbackNote({ dir, type: "idea", title: longTitle });
    const filename = result.path.split(/[/\\]/).pop() || "";
    // date(10) + - + type(4) + - + slug(max 70) + .md = at most 10+1+4+1+70+3 = 89
    // Slug part bounded to 70
    const slug = filename.replace(/^\d{4}-\d{2}-\d{2}-\w+-/, "").replace(/\.md$/, "");
    expect(slug.length).toBeLessThanOrEqual(70);
  });

  it("missing optional fields produce _Not provided._ in the file body", () => {
    const result = createFeedbackNote({ dir, type: "product", title: "No optionals" });
    const text = readFileSync(result.path, "utf8");
    expect(text).toContain("_Not provided._");
  });
});

// ── listFeedbackNotes ─────────────────────────────────────────────────────────

describe("listFeedbackNotes", () => {
  it("returns {ok, dir, notes:[]} when directory does not exist", () => {
    const result = listFeedbackNotes({ dir: join(dir, "nonexistent") });
    expect(result.ok).toBe(true);
    expect(result.notes).toEqual([]);
  });

  it("lists notes created with createFeedbackNote", () => {
    createFeedbackNote({ dir, type: "bug", title: "Note A" });
    createFeedbackNote({ dir, type: "gap", title: "Note B" });
    const result = listFeedbackNotes({ dir });
    expect(result.ok).toBe(true);
    expect(result.notes.length).toBe(2);
    // Each note has required fields
    for (const note of result.notes) {
      expect(note.name).toMatch(/\.md$/);
      expect(typeof note.updatedAt).toBe("string");
      expect(typeof note.size).toBe("number");
      expect(typeof note.title).toBe("string");
    }
  });

  it("ignores README.md", () => {
    writeFileSync(join(dir, "README.md"), "# readme\n");
    createFeedbackNote({ dir, type: "bug", title: "Real note" });
    const result = listFeedbackNotes({ dir });
    expect(result.notes.every((n) => n.name !== "README.md")).toBe(true);
    expect(result.notes.length).toBe(1);
  });

  it("respects limit parameter (default 50, max 200)", () => {
    for (let i = 0; i < 5; i++) {
      createFeedbackNote({ dir, type: "bug", title: `Note ${i}` });
    }
    const limited = listFeedbackNotes({ dir, limit: 3 });
    expect(limited.notes.length).toBe(3);
  });

  it("extracts type from filename when metadata is missing", () => {
    // Write a minimal md with no metadata block
    writeFileSync(join(dir, "2025-01-01-bug-raw.md"), "# raw note\n");
    const result = listFeedbackNotes({ dir });
    const raw = result.notes.find((n) => n.name === "2025-01-01-bug-raw.md");
    expect(raw?.type).toBe("bug");
  });

  it("sorts notes by updatedAt descending", () => {
    // Create two notes: make one newer by touching it
    createFeedbackNote({ dir, type: "bug", title: "Older note", createdAt: "2025-01-01T00:00:00Z" });
    createFeedbackNote({ dir, type: "gap", title: "Newer note", createdAt: "2025-06-01T00:00:00Z" });
    const result = listFeedbackNotes({ dir });
    // Should be sorted by updatedAt desc; the newer one should appear first or second
    // We can't control mtime perfectly in unit tests, but we can check they're sorted
    const dates = result.notes.map((n) => n.updatedAt);
    const sorted = [...dates].sort((a, b) => b.localeCompare(a));
    expect(dates).toEqual(sorted);
  });
});

// ── parseFeedbackArgs ─────────────────────────────────────────────────────────

describe("parseFeedbackArgs", () => {
  it("parses --key value pairs", () => {
    const result = parseFeedbackArgs(["--type", "bug", "--title", "My Title"]);
    expect(result.type).toBe("bug");
    expect(result.title).toBe("My Title");
  });

  it("treats flag-only args (no following value) as 'true'", () => {
    const result = parseFeedbackArgs(["--verbose"]);
    expect(result.verbose).toBe("true");
  });

  it("treats flag followed by another flag as 'true'", () => {
    const result = parseFeedbackArgs(["--dry-run", "--verbose"]);
    expect(result["dry-run"]).toBe("true");
    expect(result.verbose).toBe("true");
  });

  it("returns empty object for empty argv", () => {
    expect(parseFeedbackArgs([])).toEqual({});
  });
});
