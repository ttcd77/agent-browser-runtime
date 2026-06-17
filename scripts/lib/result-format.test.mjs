import { describe, it, expect } from "vitest";
import {
  toolResult,
  axValue,
  normalizeAccessibilityNode,
  normalizeProfileName,
} from "./result-format.mjs";

// Characterization tests pinning the behavior of the pure result/shape formatters
// carved out of agent-cdp-server.mjs. These lock current output so the monolith
// refactor (and future edits) cannot silently change tool-result envelopes,
// accessibility-node normalization, or profile-name validation.

describe("toolResult", () => {
  it("wraps a payload as a text content block plus details", () => {
    const payload = { ok: true, n: 3 };
    const out = toolResult(payload);
    expect(out.content).toEqual([{ type: "text", text: JSON.stringify(payload) }]);
    expect(out.details).toBe(payload);
  });
  it("appends an image content block when options.image.data is a string", () => {
    const out = toolResult({ a: 1 }, { image: { data: "BASE64", mimeType: "image/jpeg" } });
    expect(out.content).toHaveLength(2);
    expect(out.content[1]).toEqual({ type: "image", data: "BASE64", mimeType: "image/jpeg" });
  });
  it("defaults image mimeType to image/png", () => {
    const out = toolResult({}, { image: { data: "BASE64" } });
    expect(out.content[1].mimeType).toBe("image/png");
  });
  it("ignores image option when data is not a string", () => {
    const out = toolResult({}, { image: { data: 123 } });
    expect(out.content).toHaveLength(1);
  });

  // H-02: ok-injection contract
  it("H-02: leaves ok untouched when payload already has it", () => {
    const payload = { ok: true, x: 1 };
    const out = toolResult(payload);
    expect(out.details).toBe(payload); // same reference — no injection
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.ok).toBe(true);
  });
  it("H-02: injects ok: true when payload has no ok and no error field", () => {
    const out = toolResult({ x: 1 });
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(out.details.ok).toBe(true);
  });
  it("H-02: injects ok: false when payload has an error field but no ok", () => {
    const out = toolResult({ error: "something_failed" });
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(out.details.ok).toBe(false);
  });
  it("H-02: forwarded ok: false beats the error-field heuristic", () => {
    const payload = { ok: false, error: "overridden" };
    const out = toolResult(payload);
    expect(out.details).toBe(payload); // explicit ok wins — no injection
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.ok).toBe(false);
  });
  it("H-02: non-object payloads (string, null) are wrapped in {ok:true, value}", () => {
    const strOut = JSON.parse(toolResult("raw string").content[0].text);
    expect(strOut).toEqual({ ok: true, value: "raw string" });
    const nullOut = JSON.parse(toolResult(null).content[0].text);
    expect(nullOut).toEqual({ ok: true, value: null });
  });
});

describe("axValue", () => {
  it("unwraps an object that has a value property", () => {
    expect(axValue({ value: "button", type: "role" })).toBe("button");
  });
  it("returns the object itself when it has no value property", () => {
    const obj = { type: "role" };
    expect(axValue(obj)).toBe(obj);
  });
  it("returns primitives as-is", () => {
    expect(axValue("plain")).toBe("plain");
    expect(axValue(42)).toBe(42);
  });
  it("maps null/undefined to null", () => {
    expect(axValue(null)).toBe(null);
    expect(axValue(undefined)).toBe(null);
  });
});

describe("normalizeAccessibilityNode", () => {
  it("flattens AX values and maps properties to a name->value object", () => {
    const node = {
      nodeId: "5",
      ignored: false,
      ignoredReasons: [],
      role: { value: "button" },
      name: { value: "Submit" },
      description: { value: "submit form" },
      value: { value: "x" },
      properties: [
        { name: "focusable", value: { value: true } },
        { name: "level", value: { value: 2 } },
      ],
      childIds: ["6", "7"],
      backendDOMNodeId: 99,
      frameId: "frame-1",
    };
    expect(normalizeAccessibilityNode(node)).toEqual({
      nodeId: "5",
      ignored: false,
      ignoredReasons: [],
      role: "button",
      name: "Submit",
      description: "submit form",
      value: "x",
      properties: { focusable: true, level: 2 },
      childIds: ["6", "7"],
      backendDOMNodeId: 99,
      frameId: "frame-1",
    });
  });
  it("defaults properties to {} and childIds to [] when absent", () => {
    const out = normalizeAccessibilityNode({ nodeId: "1" });
    expect(out.properties).toEqual({});
    expect(out.childIds).toEqual([]);
    expect(out.role).toBe(null);
  });
});

describe("normalizeProfileName", () => {
  it("trims and accepts valid profile names", () => {
    expect(normalizeProfileName("  my_profile-1.x  ")).toBe("my_profile-1.x");
  });
  it("defaults empty/null input to 'default'", () => {
    expect(normalizeProfileName(null)).toBe("default");
    expect(normalizeProfileName("")).toBe("default");
    expect(normalizeProfileName(undefined)).toBe("default");
  });
  it("rejects names starting with a non-alphanumeric character", () => {
    expect(() => normalizeProfileName("-bad")).toThrow(/profile must start/);
    expect(() => normalizeProfileName(".bad")).toThrow(/profile must start/);
  });
  it("rejects names containing illegal characters", () => {
    expect(() => normalizeProfileName("bad name")).toThrow();
    expect(() => normalizeProfileName("bad/slash")).toThrow();
  });
});
