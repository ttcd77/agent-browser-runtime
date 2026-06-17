// Pure JS/CSS coverage helpers, extracted from agent-cdp-server.mjs (behavior-
// preserving monolith carve). These flatten CDP-style coverage range data into
// objective used/unused byte summaries and source snippets. No CDP client, no
// filesystem, no module state: every function takes already-captured coverage
// ranges / source text and returns data, using JS stdlib plus the already-
// extracted truncateText helper. Unit-tested in coverage.test.mjs.

import { truncateText } from "./text-utils.mjs";

export function rangeLength(range = {}) {
  return Math.max(0, Number(range.endOffset || 0) - Number(range.startOffset || 0));
}

export function summarizeCoverageRanges(functions = []) {
  const ranges = [];
  for (const fn of functions || []) {
    for (const range of fn.ranges || []) {
      ranges.push({
        functionName: fn.functionName || "",
        startOffset: Number(range.startOffset || 0),
        endOffset: Number(range.endOffset || 0),
        count: Number(range.count || 0),
        used: Number(range.count || 0) > 0,
        bytes: rangeLength(range),
      });
    }
  }
  ranges.sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);
  return ranges;
}

export function coverageSnippet(sourceText, range = {}, maxChars = 300) {
  const text = String(sourceText || "");
  const start = Math.max(0, Math.min(text.length, Number(range.startOffset || 0)));
  const end = Math.max(start, Math.min(text.length, Number(range.endOffset || start)));
  const raw = text.slice(start, end);
  const limited = truncateText(raw, maxChars);
  return {
    startOffset: start,
    endOffset: end,
    text: limited.text,
    truncated: limited.truncated,
  };
}

export function coverageByteSummary(ranges = [], fallbackTotalBytes = 0) {
  const totalBytes = Math.max(
    Number(fallbackTotalBytes || 0),
    ...ranges.map((range) => Number(range.endOffset || 0)),
    0,
  );
  let usedBytes = 0;
  let unusedBytes = 0;
  for (const range of ranges) {
    if (range.used) usedBytes += range.bytes;
    else unusedBytes += range.bytes;
  }
  return {
    totalBytes,
    usedBytes,
    unusedBytes,
    usedRatio: totalBytes > 0 ? usedBytes / totalBytes : null,
  };
}
