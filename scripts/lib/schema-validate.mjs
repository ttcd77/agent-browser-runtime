// Lightweight JSON Schema validator — only validates required + enum + type (basic).
// Does NOT depend on any external library; intentionally covers a subset of JSON Schema.
//
// Returns:
//   { ok: true }                                  — validation passed
//   { ok: false, error, field, ... }              — validation failed
//
// Two HTTP-friendly coercions are accepted: numeric strings where number is
// expected, and "true"/"false" strings where boolean is expected.

/**
 * Validate `params` against a JSON Schema-like `schema`.
 *
 * Only the top-level `properties`, `required`, and per-property `enum` / `type`
 * fields are checked. Nested objects are not recursed into. Extra params that
 * have no corresponding property definition are allowed (pass-through).
 *
 * Type mismatches always fail. Two HTTP-friendly coercions are accepted: a
 * numeric string where number is expected, and "true"/"false" where boolean is
 * expected. Enum mismatches always fail.
 *
 * @param {Record<string,unknown>|null|undefined} params
 * @param {object|null|undefined} schema  - JSON Schema object (type:"object")
 * @returns {{ ok: boolean, error?: string, field?: string, got?: unknown, expected?: unknown[], hint?: string }}
 */
export function validateParams(params, schema) {
  if (!schema || schema.type !== "object") return { ok: true };

  const properties = schema.properties || {};
  const required = schema.required || [];

  // required fields must be present and non-null
  for (const fieldName of required) {
    if (params == null || params[fieldName] === undefined || params[fieldName] === null) {
      return {
        ok: false,
        error: "missing_required_param",
        field: fieldName,
        hint: `Required parameter '${fieldName}' not provided.`,
      };
    }
  }

  if (params == null) return { ok: true };

  // per-field: type + enum check
  for (const [fieldName, value] of Object.entries(params)) {
    const fieldSchema = properties[fieldName];
    if (!fieldSchema) continue; // no schema for this field → allow

    // enum check — strict: value must be in the declared set
    if (Array.isArray(fieldSchema.enum) && fieldSchema.enum.length > 0) {
      if (!fieldSchema.enum.includes(value)) {
        return {
          ok: false,
          error: "invalid_enum_value",
          field: fieldName,
          got: value,
          expected: fieldSchema.enum,
          hint: `Parameter '${fieldName}' must be one of: ${fieldSchema.enum.join(", ")}`,
        };
      }
    }

    // type check — conservative to avoid breaking callers with relaxed typing
    const expectedType = fieldSchema.type;
    if (expectedType && expectedType !== "any") {
      const actualType = Array.isArray(value) ? "array" : (value === null ? "null" : typeof value);
      const allowedTypes = Array.isArray(expectedType) ? expectedType : [expectedType];

      if (!allowedTypes.includes(actualType) && !allowedTypes.includes("any")) {
        // Special case: numeric string where number expected — accept (common in HTTP params)
        if (allowedTypes.includes("number") && actualType === "string" && Number.isFinite(Number(value))) {
          continue;
        }
        // Special case: "true"/"false" string where boolean expected — accept
        if (allowedTypes.includes("boolean") && (value === "true" || value === "false")) {
          continue;
        }
        // All other type mismatches are rejected.
        return {
          ok: false,
          error: "invalid_param_type",
          field: fieldName,
          got: actualType,
          expected: allowedTypes,
          hint: `Parameter '${fieldName}' must be ${allowedTypes.join(" or ")}, got ${actualType}.`,
        };
      }
    }
  }

  return { ok: true };
}
