#!/usr/bin/env node

import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFeedbackNote, listFeedbackNotes } from "./lib/feedback-notes.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const dir = mkdtempSync(join(tmpdir(), "agent-browser-feedback-"));

try {
  const note = createFeedbackNote({
    dir,
    type: "gap",
    title: "Need bounded feedback smoke route",
    summary: "Smoke test note for the local feedback workflow.",
    tool: "browser_feedback",
    profile: "demo-fixture",
    expected: "Agent can create a local feedback note through shared code.",
    actual: "Note should exist on disk.",
    reporter: "feedback-note-smoke",
  });

  assert(note.ok === true, "note did not report ok");
  assert(existsSync(note.path), `note path does not exist: ${note.path}`);
  const text = readFileSync(note.path, "utf8");
  assert(text.includes("- type: gap"), "note missing type metadata");
  assert(text.includes("- tool: browser_feedback"), "note missing tool metadata");
  assert(text.includes("- reporter: feedback-note-smoke"), "note missing reporter metadata");

  const listed = listFeedbackNotes({ dir });
  assert(listed.notes.length === 1, `expected 1 listed note, got ${listed.notes.length}`);
  assert(listed.notes[0].type === "gap", "listed note type mismatch");
  assert(listed.notes[0].tool === "browser_feedback", "listed note tool mismatch");

  console.log(JSON.stringify({ ok: true, note: note.path, listed: listed.notes.length }, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
