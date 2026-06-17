// Pure request-initiator stack normalizer, extracted from agent-cdp-server.mjs
// (2026-06-06 monolith carve, behavior-preserving). No CDP, no filesystem, no
// module state: flattens a CDP Network.Initiator (with sync/async parent stack
// traces) into an ordered callFrames view-model, using only JS stdlib.
// Unit-tested in initiator-summary.test.mjs.

export function buildInitiatorSummary(initiator = null) {
  if (!initiator) return null;
  const stack = initiator.stack || initiator.asyncStackTrace || null;
  const callFrames = [];
  const collectFrames = (trace, relation = "sync") => {
    if (!trace) return;
    for (const frame of trace.callFrames || []) {
      callFrames.push({
        relation,
        functionName: frame.functionName || "",
        url: frame.url || "",
        lineNumber: frame.lineNumber,
        columnNumber: frame.columnNumber,
        scriptId: frame.scriptId || null,
      });
    }
    if (trace.parent) collectFrames(trace.parent, "parent");
    if (trace.parentId) callFrames.push({ relation: "parentId", id: trace.parentId });
  };
  collectFrames(stack);
  if (initiator.url && !callFrames.some((frame) => frame.url === initiator.url)) {
    callFrames.push({
      relation: "initiator-url",
      functionName: "",
      url: initiator.url,
      lineNumber: initiator.lineNumber,
      columnNumber: initiator.columnNumber,
      scriptId: null,
    });
  }
  return {
    type: initiator.type || null,
    url: initiator.url || callFrames.find((frame) => frame.url)?.url || null,
    lineNumber: initiator.lineNumber ?? callFrames.find((frame) => Number.isFinite(frame.lineNumber))?.lineNumber ?? null,
    columnNumber: initiator.columnNumber ?? callFrames.find((frame) => Number.isFinite(frame.columnNumber))?.columnNumber ?? null,
    stackDescription: stack?.description || null,
    stackDepth: callFrames.length,
    callFrames,
  };
}
