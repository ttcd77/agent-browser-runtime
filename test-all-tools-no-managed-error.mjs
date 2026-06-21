#!/usr/bin/env node
/**
 * test-all-tools-no-managed-error.mjs — Smoke test: verify zero tools throw
 * "managed backend removed" when the ABR server is running in slim mode.
 *
 * Usage:
 *   node test-all-tools-no-managed-error.mjs [--url http://localhost:9222]
 *
 * Reads /health.tools from the running ABR server, calls each tool once
 * with minimal params, and reports:
 *   ✅ ok           — tool returned cleanly (no managed error)
 *   ⚠️  structured   — tool returned structured error (ok:false, error:"managed_backend_removed" etc.)
 *   ❌ throws       — tool threw "managed backend removed"
 *
 * Zero-tolerance for ❌. ⚠️ is acceptable (structured error with guidance).
 *
 * V1 (2026-06-21) — Port A smoke verification.
 */

const ABR_URL = process.argv.find(a => a.startsWith("http")) || "http://127.0.0.1:9222";
const HEALTH_URL = `${ABR_URL}/health.tools`;
const CALL_URL = `${ABR_URL}/tools/call`;

// Minimal params per tool — just enough to trigger the execute path
const MINIMAL_PARAMS = {
  // Business tools (ported to Python — should return ✅)
  browser_token_flow_trace: { profile: "smoke-test" },
  browser_token_scan: { profile: "smoke-test" },
  browser_sources_search: { profile: "smoke-test", query: "test" },
  browser_security_pack: { profile: "smoke-test" },
  browser_security_research_pack: { profile: "smoke-test" },
  browser_replay: { profile: "smoke-test", requestId: "nonexistent" },
  browser_scan_bridge: { profile: "smoke-test", target: "smoke-test", scope: ["example.com"] },
  browser_scan_bola: { target: "smoke-test", execute: false },
  browser_scan_status: { target: "smoke-test" },
  browser_domain_skills_list: { profile: "smoke-test", hostname: "example.com" },
  browser_domain_skills_read: { profile: "smoke-test", hostname: "example.com", filename: "test.md" },
  browser_domain_skills_write: { profile: "smoke-test", hostname: "example.com", filename: "test.md", content: "# Test" },
  browser_agent_helpers_read: { profile: "smoke-test" },
  browser_agent_helpers_write: { profile: "smoke-test", source: "def test(): return 42" },
  browser_tool_usage: { profile: "smoke-test" },

  // Browser operations (should route via personal — ⚠️ structured error acceptable)
  browser_open: { profile: "smoke-test", url: "https://example.com" },
  browser_navigate: { profile: "smoke-test", url: "https://example.com" },
  browser_click: { profile: "smoke-test", selector: "body" },
  browser_type: { profile: "smoke-test", selector: "input", text: "test" },
  browser_snapshot: { profile: "smoke-test" },
  browser_screenshot: { profile: "smoke-test" },
  browser_eval: { profile: "smoke-test", expression: "1+1" },
  browser_cdp_command: { profile: "smoke-test", method: "Runtime.evaluate" },
  browser_memory_snapshot: { profile: "smoke-test" },
  browser_heap_snapshot: { profile: "smoke-test" },
  browser_performance_trace: { profile: "smoke-test" },
  browser_chrome_trace: { profile: "smoke-test" },
  browser_cpu_profile: { profile: "smoke-test" },
  browser_coverage_snapshot: { profile: "smoke-test" },
  browser_coverage_detail: { profile: "smoke-test" },
  browser_click_xy: { profile: "smoke-test", x: 0, y: 0 },
  browser_fill_framework: { profile: "smoke-test", selector: "input", text: "test" },
  browser_screenshot_drive: { profile: "smoke-test" },

  // Intruder/replay tools (already ported — should return ✅)
  profile_raw_request: { host: "example.com" },
  profile_race_request: { host: "example.com", requests: [{ rawRequest: "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n" }, { rawRequest: "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n" }] },
  profile_jwt_forge: { token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.abc" },
  profile_oob_alloc: {},
  attack_intruder_create: { spec: { name: "test", positions: [], payloadSets: [] } },
  attack_intruder_status: { jobId: "nonexistent" },
};

const MANAGED_REMOVED_PATTERN = /managed backend removed/i;

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
  return { status: res.status, body: await res.json().catch(() => null), text: await res.text().catch(() => "") };
}

async function callTool(name, params) {
  try {
    const res = await fetch(CALL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: name, params }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    if (MANAGED_REMOVED_PATTERN.test(text)) {
      return { tool: name, result: "❌", detail: "managed_backend_removed in response", text: text.slice(0, 200) };
    }
    if (res.ok) {
      return { tool: name, result: "✅", detail: `HTTP ${res.status}` };
    }
    return { tool: name, result: "⚠️", detail: `HTTP ${res.status}`, text: text.slice(0, 200) };
  } catch (err) {
    const msg = err?.message || String(err);
    if (MANAGED_REMOVED_PATTERN.test(msg)) {
      return { tool: name, result: "❌", detail: "managed_backend_removed throw", error: msg };
    }
    return { tool: name, result: "⚠️", detail: "throw (non-managed)", error: msg.slice(0, 200) };
  }
}

async function main() {
  console.log(`ABR smoke test — ${new Date().toISOString()}`);
  console.log(`Target: ${ABR_URL}\n`);

  // Get tool list
  let tools = [];
  try {
    const health = await fetchJson(HEALTH_URL);
    if (health.body?.tools) {
      tools = health.body.tools;
      console.log(`Found ${tools.length} tools from /health.tools\n`);
    }
  } catch (err) {
    console.log(`Cannot reach /health.tools: ${err.message}`);
    console.log("Running static subset of known tools...\n");
  }

  // Run smoke calls
  const results = [];
  const toolNames = tools.length > 0
    ? tools.map(t => t.name).filter(n => MINIMAL_PARAMS[n])
    : Object.keys(MINIMAL_PARAMS);

  for (const name of toolNames) {
    const params = MINIMAL_PARAMS[name];
    if (!params) continue;
    process.stdout.write(`  ${name}... `);
    const r = await callTool(name, params);
    console.log(r.result !== "❌" ? r.result : `${r.result} ${r.detail}`);
    results.push(r);
  }

  // Summary
  const ok = results.filter(r => r.result === "✅").length;
  const warn = results.filter(r => r.result === "⚠️").length;
  const fail = results.filter(r => r.result === "❌").length;

  console.log(`\n─── Results ───`);
  console.log(`  ✅ ok:          ${ok}`);
  console.log(`  ⚠️  structured:  ${warn}`);
  console.log(`  ❌ THROWS:      ${fail}`);
  console.log(`  Total:          ${results.length}`);

  if (fail > 0) {
    console.log(`\n❌ FAIL: ${fail} tool(s) still throw "managed backend removed". Fix required.`);
    for (const r of results.filter(r => r.result === "❌")) {
      console.log(`   - ${r.tool}: ${r.detail}`);
    }
    process.exit(1);
  }

  console.log(`\n✅ PASS: Zero tools throw "managed backend removed".`);
  process.exit(0);
}

main().catch(err => {
  console.error("Test harness error:", err.message);
  process.exit(2);
});
