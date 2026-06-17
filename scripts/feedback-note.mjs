#!/usr/bin/env node

import { allowedFeedbackTypes, createFeedbackNote, parseFeedbackArgs } from "./lib/feedback-notes.mjs";

const args = parseFeedbackArgs(process.argv.slice(2));
const type = String(args.type || "gap").toLowerCase();
const title = String(args.title || "").trim();

if (!allowedFeedbackTypes.has(type) || !title) {
  console.error(`Usage:
  npm run feedback:note -- --type bug|gap|docs|product|idea --title "Short title" [--summary "..."] [--tool "..."] [--profile "..."] [--expected "..."] [--actual "..."] [--next "..."]
`);
  process.exit(1);
}

const note = createFeedbackNote({ ...args, type, title });
console.log(JSON.stringify(note, null, 2));
