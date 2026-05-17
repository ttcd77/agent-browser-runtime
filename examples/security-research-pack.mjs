#!/usr/bin/env node

const server = process.env.AGENT_BROWSER_SERVER || "http://127.0.0.1:17335";
const profile = process.env.AGENT_BROWSER_PROFILE || "researcher";
const url = process.argv[2] || "https://example.com";

async function callTool(name, input = {}) {
  const response = await fetch(`${server}/tool/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${name} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

await callTool("profile_create", { profile });

const pack = await callTool("devtools_security_research_pack", {
  profile,
  url,
  limit: 20,
  waitMs: 1000,
  includeHar: true,
  includeTrace: true,
  includeApplicationExport: true,
});

console.log(JSON.stringify({
  backend: pack.backend,
  profile: pack.profile,
  url: pack.url,
  summary: pack.summary,
  captureBoundaries: pack.captureBoundaries,
  artifactPaths: {
    harPath: pack.summary?.harPath,
    applicationExportPath: pack.summary?.applicationExportPath,
    chromeTracePath: pack.summary?.chromeTracePath,
    evidenceBundlePath: pack.summary?.evidenceBundlePath,
  },
  nextTools: pack.nextTools,
}, null, 2));
