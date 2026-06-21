#!/usr/bin/env node
// Smoke: every /health.tools tool must NOT throw "managed backend removed" / "ABR-Stub" when called.
// Validation errors / missing-arg errors are OK — we're not testing correctness, only stub-error absence.
// Exit code 0 = all clean. Exit code 1 = at least one tool still throws stub error.

const PORT = process.env.ABR_PORT || 17335;
const BASE = `http://127.0.0.1:${PORT}`;

const h = await (await fetch(`${BASE}/health`)).json().catch(() => ({}));
const tools = h.tools || [];
if (tools.length === 0) {
  console.error(`No tools returned from ${BASE}/health. Is worker running?`);
  process.exit(2);
}

const results = { ok: [], validation: [], stub_error: [], unknown: [] };

for (const t of tools) {
  let text = "";
  let status = 0;
  try {
    const r = await fetch(`${BASE}/tool/${t}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "smoke-test", _smoke: true }),
    });
    status = r.status;
    text = await r.text();
  } catch (e) {
    results.unknown.push({ t, err: String(e.message || e) });
    continue;
  }
  const isStub = /managed backend removed|ABR-Stub|managed_backend_removed/i.test(text);
  if (isStub) {
    results.stub_error.push({ t, status, snippet: text.slice(0, 200) });
  } else if (status >= 200 && status < 300) {
    results.ok.push(t);
  } else {
    results.validation.push({ t, status });
  }
}

const summary = {
  total: tools.length,
  ok: results.ok.length,
  validation_or_missing_args: results.validation.length,
  stub_error_MUST_BE_0: results.stub_error.length,
  unknown_network_errors: results.unknown.length,
};
console.log("SUMMARY:", JSON.stringify(summary, null, 2));

if (results.stub_error.length > 0) {
  console.log("\nSTUB-ERROR tools (these need fixing):");
  for (const e of results.stub_error) console.log(`  - ${e.t} [${e.status}] : ${e.snippet}`);
}
if (results.unknown.length > 0) {
  console.log("\nUNKNOWN errors:", results.unknown);
}

process.exit(results.stub_error.length > 0 ? 1 : 0);
