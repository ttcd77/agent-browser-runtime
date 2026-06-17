import { describe, it, expect } from "vitest";
import { validateParams } from "./schema-validate.mjs";

// Unit tests for the lightweight schema validator.
// Coverage: enum (valid/invalid), required (present/missing), type (match/mismatch),
// and boundary cases (no schema, null params, extra params).

describe("validateParams — enum", () => {
  const schema = {
    type: "object",
    properties: {
      action: { type: "string", enum: ["analyze", "extract", "screenshot"] },
    },
  };

  it("accepts a valid enum value", () => {
    expect(validateParams({ action: "analyze" }, schema)).toEqual({ ok: true });
  });

  it("rejects an invalid enum value with structured error", () => {
    const result = validateParams({ action: "invalid-action" }, schema);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_enum_value");
    expect(result.field).toBe("action");
    expect(result.got).toBe("invalid-action");
    expect(result.expected).toEqual(["analyze", "extract", "screenshot"]);
    expect(typeof result.hint).toBe("string");
  });

  it("rejects an empty-string value that is not in the enum", () => {
    const result = validateParams({ action: "" }, schema);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_enum_value");
  });
});

describe("validateParams — required", () => {
  const schema = {
    type: "object",
    required: ["url"],
    properties: {
      url: { type: "string" },
      timeout: { type: "number" },
    },
  };

  it("passes when all required fields are present", () => {
    expect(validateParams({ url: "https://example.com" }, schema)).toEqual({ ok: true });
  });

  it("rejects when a required field is missing", () => {
    const result = validateParams({}, schema);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("missing_required_param");
    expect(result.field).toBe("url");
    expect(typeof result.hint).toBe("string");
  });

  it("rejects when params is null", () => {
    const result = validateParams(null, schema);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("missing_required_param");
    expect(result.field).toBe("url");
  });

  it("rejects when the required field is explicitly null", () => {
    const result = validateParams({ url: null }, schema);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("missing_required_param");
    expect(result.field).toBe("url");
  });
});

describe("validateParams — type (basic)", () => {
  const schema = {
    type: "object",
    properties: {
      count: { type: "number" },
      flag: { type: "boolean" },
      label: { type: "string" },
    },
  };

  it("accepts correct types", () => {
    expect(validateParams({ count: 5, flag: true, label: "hi" }, schema)).toEqual({ ok: true });
  });

  it("accepts numeric string where number expected (relaxed)", () => {
    // Existing callers may pass query-string values; we should not break them.
    expect(validateParams({ count: "42" }, schema)).toEqual({ ok: true });
  });

  it("accepts boolean string where boolean expected (relaxed)", () => {
    expect(validateParams({ flag: "true" }, schema)).toEqual({ ok: true });
    expect(validateParams({ flag: "false" }, schema)).toEqual({ ok: true });
  });

  it("rejects non-numeric string where number expected", () => {
    const result = validateParams({ count: "not-a-number" }, schema);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_param_type");
    expect(result.field).toBe("count");
    expect(result.got).toBe("string");
    expect(result.expected).toEqual(["number"]);
  });
});

describe("validateParams — boundary cases", () => {
  it("returns ok:true when schema is null", () => {
    expect(validateParams({ action: "anything" }, null)).toEqual({ ok: true });
  });

  it("returns ok:true when schema is undefined", () => {
    expect(validateParams({ action: "anything" }, undefined)).toEqual({ ok: true });
  });

  it("returns ok:true when schema type is not 'object'", () => {
    expect(validateParams({ action: "anything" }, { type: "string" })).toEqual({ ok: true });
  });

  it("returns ok:true with null params and no required fields", () => {
    expect(validateParams(null, { type: "object", properties: {} })).toEqual({ ok: true });
  });

  it("allows extra params not in schema properties (pass-through)", () => {
    const schema = {
      type: "object",
      required: ["url"],
      properties: { url: { type: "string" } },
    };
    expect(validateParams({ url: "https://x.com", extraField: "ignored" }, schema)).toEqual({ ok: true });
  });
});
