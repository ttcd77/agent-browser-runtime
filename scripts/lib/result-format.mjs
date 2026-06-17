// Pure result/shape formatting utilities, extracted from agent-cdp-server.mjs
// (2026-06-06 monolith carve, behavior-preserving). No CDP, no filesystem, no
// module state: each takes arguments and returns a value using only JS stdlib
// (and axValue calls normalizeAccessibilityNode's sibling). Unit-tested in
// result-format.test.mjs.

export function toolResult(payload, options) {
  // H-02: ensure every tool response has an explicit `ok` boolean so agents can
  // write a uniform `if (!result.ok)` guard without inspecting error-field names.
  // Rules:
  //   - payload already has `ok` → leave it untouched (explicit wins)
  //   - payload has an `error` field but no `ok` → inject ok: false
  //   - all other object payloads without `ok` → inject ok: true
  // Non-object payloads (strings, null, arrays) are wrapped so the response
  // always carries an explicit ok:true and a predictable shape.
  let normalized = payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    normalized = { ok: true, value: payload };
  } else if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    if (!Object.prototype.hasOwnProperty.call(payload, "ok")) {
      normalized = {
        ...payload,
        ok: Object.prototype.hasOwnProperty.call(payload, "error") ? false : true,
      };
    }
  }
  const content = [{ type: "text", text: JSON.stringify(normalized) }];
  if (options?.image && typeof options.image.data === "string") {
    content.push({
      type: "image",
      data: options.image.data,
      mimeType: options.image.mimeType || "image/png",
    });
  }
  return { content, details: normalized };
}

export function axValue(value) {
  if (!value || typeof value !== "object") return value ?? null;
  if ("value" in value) return value.value;
  return value;
}

export function normalizeAccessibilityNode(node) {
  return {
    nodeId: node.nodeId,
    ignored: node.ignored,
    ignoredReasons: node.ignoredReasons,
    role: axValue(node.role),
    name: axValue(node.name),
    description: axValue(node.description),
    value: axValue(node.value),
    properties: Array.isArray(node.properties)
      ? Object.fromEntries(node.properties.map((property) => [property.name, axValue(property.value)]))
      : {},
    childIds: node.childIds || [],
    backendDOMNodeId: node.backendDOMNodeId,
    frameId: node.frameId,
  };
}

export function normalizeProfileName(raw) {
  const name = String(raw || "default").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name)) {
    throw new Error("profile must start with a letter/number and contain only letters, numbers, dot, underscore, or dash");
  }
  return name;
}
