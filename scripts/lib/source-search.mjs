// Pure literal-substring search helper, extracted from agent-cdp-server.mjs
// (2026-06-06 monolith carve, behavior-preserving). No CDP, no filesystem, no
// module state: scans a string for a literal query and returns match positions
// (index/line/column) with surrounding snippets, using only JS stdlib. Shared
// by the artifact-inspect/search tools and the parsed-source search tools.
// Unit-tested in source-search.test.mjs.

export function findSourceMatches(sourceText, query, options = {}) {
  const caseSensitive = Boolean(options.caseSensitive);
  const maxMatches = typeof options.maxMatches === "number" ? options.maxMatches : 50;
  const contextChars = typeof options.contextChars === "number" ? options.contextChars : 80;
  const haystack = caseSensitive ? sourceText : sourceText.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches = [];
  let index = 0;
  while (needle && matches.length < maxMatches) {
    const found = haystack.indexOf(needle, index);
    if (found < 0) break;
    const before = sourceText.slice(0, found);
    const line = before.split(/\r?\n/).length;
    const column = found - Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r"), -1) - 1;
    matches.push({
      index: found,
      line,
      column,
      snippet: sourceText.slice(Math.max(0, found - contextChars), Math.min(sourceText.length, found + query.length + contextChars)),
    });
    index = found + Math.max(needle.length, 1);
  }
  return matches;
}
