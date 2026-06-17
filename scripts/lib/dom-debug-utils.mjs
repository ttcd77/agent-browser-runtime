// Assorted pure helpers extracted from agent-cdp-server.mjs (behavior-preserving
// monolith carve): path normalization for command-line comparison, DOM-search
// attribute/node summarization, forced-pseudo-class normalization, frame-index
// parsing from options, and CDP RemoteObject summarization. None of these take a
// live CDP client / session / registry; they operate on already-fetched node /
// object / option data and return data using JS stdlib plus the already-extracted
// truncateText helper. (The live debugger/frame wrappers that consume these stay
// in the worker.) Unit-tested in dom-debug-utils.test.mjs.

import { truncateText } from "./text-utils.mjs";

export function normalizePathForCompare(p) {
  return String(p || "").trim().replace(/^["']|["']$/g, "").replace(/[\\/]+$/, "").toLowerCase();
}

export function domSearchAttributes(attributes = []) {
  const result = {};
  for (let index = 0; index < attributes.length; index += 2) {
    result[String(attributes[index])] = String(attributes[index + 1] ?? "");
  }
  return result;
}

export function domSearchNodeSummary(node = {}, outerHTMLResult = null, maxOuterHTMLChars = 1200) {
  const outer = outerHTMLResult?.outerHTML ? truncateText(outerHTMLResult.outerHTML, maxOuterHTMLChars) : null;
  return {
    nodeId: node.nodeId,
    backendNodeId: node.backendNodeId,
    nodeType: node.nodeType,
    nodeName: node.nodeName,
    localName: node.localName,
    nodeValue: node.nodeValue,
    attributes: domSearchAttributes(node.attributes || []),
    childNodeCount: node.childNodeCount || 0,
    frameId: node.frameId || null,
    shadowRootType: node.shadowRootType || null,
    outerHTML: outer?.text || "",
    outerHTMLTruncated: Boolean(outer?.truncated),
  };
}

export function normalizeForcedPseudoClasses(value) {
  const allowed = new Set(["active", "focus", "focus-within", "focus-visible", "hover", "target", "visited"]);
  const raw = Array.isArray(value) ? value : (value ? [value] : []);
  const requested = raw.map((entry) => String(entry || "").replace(/^:/, "").trim()).filter(Boolean);
  const forced = [...new Set(requested.filter((entry) => allowed.has(entry)))];
  const skipped = requested.filter((entry) => !allowed.has(entry));
  return { forced, skipped };
}

export function frameIndexesFromOptions(options = {}) {
  if (Array.isArray(options.frameIndexes)) return options.frameIndexes.map((entry) => Number(entry)).filter(Number.isInteger);
  const path = String(options.framePath || "");
  return [...path.matchAll(/frame\[(\d+)\]/g)].map((match) => Number(match[1])).filter(Number.isInteger);
}

export function debuggerRemoteObjectSummary(object = {}, maxValueChars = 4000) {
  const value = object?.value;
  return {
    type: object?.type,
    subtype: object?.subtype,
    className: object?.className,
    description: object?.description,
    value: typeof value === "string" && value.length > maxValueChars ? value.slice(0, maxValueChars) : value,
    valueTruncated: typeof value === "string" && value.length > maxValueChars,
    unserializableValue: object?.unserializableValue,
  };
}
