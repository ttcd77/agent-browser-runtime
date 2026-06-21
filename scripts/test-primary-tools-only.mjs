// Task G smoke: verify /health surface is thin by default, wrappers hidden behind ?legacy=1.
// Run: node scripts/test-primary-tools-only.mjs [baseUrl]
// Default baseUrl: http://127.0.0.1:17335 (standard ABR managed worker port)

import { PRIMARY_TOOLS } from "./lib/primary-tools.mjs";

const base = process.argv[2] || "http://127.0.0.1:17335";

async function get(path) {
  const url = `${base}${path}`;
  const resp = await fetch(url);
  const body = await resp.json();
  return { status: resp.status, body };
}

async function post(path, payload) {
  const url = `${base}${path}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await resp.json();
  return { status: resp.status, body };
}

const results = { ok: [], fail: [] };
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`PASS ${label}`);
    results.ok.push(label);
  } else {
    console.error(`FAIL ${label} — ${detail}`);
    results.fail.push(label);
  }
}

try {
  // ── 1. /health default → primary tools only ──
  const h = await get("/health");
  check(
    "/health returns 200",
    h.status === 200,
    `got ${h.status}`
  );
  const primaryCount = Array.isArray(h.body.tools) ? h.body.tools.length : 0;
  const allToolsFromHealth = Array.isArray(h.body.tools) ? h.body.tools : [];
  console.log(`  /health tools_count=${h.body.tools_count}, legacy_tools_count=${h.body.legacy_tools_count}`);
  console.log(`  /health tools: ${allToolsFromHealth.join(", ")}`);

  // Should be ≤ PRIMARY_TOOLS.size (primary tools)
  check(
    `/health tools count ≤ ${PRIMARY_TOOLS.size}`,
    primaryCount <= PRIMARY_TOOLS.size && primaryCount > 0,
    `got ${primaryCount}, expected ≤ ${PRIMARY_TOOLS.size}`
  );
  // All returned tools must be in PRIMARY_TOOLS
  const unknownTools = allToolsFromHealth.filter(t => !PRIMARY_TOOLS.has(t));
  check(
    "/health tools are all primary",
    unknownTools.length === 0,
    `unknown: ${unknownTools.join(", ")}`
  );

  // ── 2. /health?legacy=1 → all tools ──
  const hl = await get("/health?legacy=1");
  check(
    "/health?legacy=1 returns 200",
    hl.status === 200,
    `got ${hl.status}`
  );
  const legacyCount = Array.isArray(hl.body.tools) ? hl.body.tools.length : 0;
  console.log(`  /health?legacy=1 tools_count=${legacyCount}, legacy_tools_count=${hl.body.legacy_tools_count}`);
  check(
    "/health?legacy=1 has more tools than default",
    legacyCount > primaryCount,
    `legacy=${legacyCount} vs default=${primaryCount}`
  );
  check(
    "/health?legacy=1 has all primary tools contained",
    PRIMARY_TOOLS.size > 0 && [...PRIMARY_TOOLS].every(t => hl.body.tools.includes(t)),
    "some primary tools missing from legacy list"
  );

  // ── 3. /tools-legacy → all tools ──
  const tl = await get("/tools-legacy");
  check(
    "/tools-legacy returns 200",
    tl.status === 200,
    `got ${tl.status}`
  );
  const toolsLegacyCount = Array.isArray(tl.body.tools) ? tl.body.tools.length : 0;
  check(
    "/tools-legacy count matches /health?legacy=1 count",
    toolsLegacyCount === legacyCount,
    `tools-legacy=${toolsLegacyCount} vs health-legacy=${legacyCount}`
  );

  // ── 4. /tools default → primary only ──
  const t = await get("/tools");
  check(
    "/tools returns 200",
    t.status === 200,
    `got ${t.status}`
  );
  const toolsPrimaryCount = Array.isArray(t.body.tools) ? t.body.tools.length : 0;
  check(
    `/tools count ≤ ${PRIMARY_TOOLS.size}`,
    toolsPrimaryCount <= PRIMARY_TOOLS.size && toolsPrimaryCount === primaryCount,
    `got ${toolsPrimaryCount}, expected ${primaryCount} (matching /health)`
  );

  // ── 5. POST /tool/browser_capture_status → should work (backward compat) ──
  const statusRes = await post("/tool/browser_capture_status", {});
  console.log(`  POST /tool/browser_capture_status → status=${statusRes.status} ok=${statusRes.body?.ok}`);
  // Even if it errors (no profile etc), it should NOT be 404 or "tool not found"
  check(
    "POST /tool/browser_capture_status is reachable (not 404)",
    statusRes.status !== 404,
    `got ${statusRes.status}`
  );

  // ── 6. POST /tool/browser_cookies_set → should still work (legacy wrapper not filtered at execution) ──
  const cookieRes = await post("/tool/browser_cookies_set", {
    profile: "default",
    cookies: [],
  });
  console.log(`  POST /tool/browser_cookies_set → status=${cookieRes.status} ok=${cookieRes.body?.ok}`);
  check(
    "POST /tool/browser_cookies_set is reachable (legacy wrapper not filtered at execution)",
    cookieRes.status !== 404,
    `got ${cookieRes.status}`
  );

  // ── Summary ──
  console.log(`\n=== TASK G SMOKE RESULTS ===`);
  console.log(`Primary tools visible by default: ${primaryCount}`);
  console.log(`All tools (legacy total):        ${legacyCount}`);
  console.log(`Hidden wrappers:                 ${legacyCount - primaryCount}`);
  console.log(`PASS: ${results.ok.length}  FAIL: ${results.fail.length}`);
  if (results.fail.length > 0) {
    console.error(`FAILURES:\n  ${results.fail.join("\n  ")}`);
    process.exit(1);
  }
  console.log("OK");
} catch (err) {
  console.error(`SMOKE CRASH: ${err.message}`);
  process.exit(1);
}
