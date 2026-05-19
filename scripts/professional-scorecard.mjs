#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

async function waitForHealth(port) {
  const url = `http://127.0.0.1:${port}/health`;
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // keep waiting
    }
    await sleep(250);
  }
  throw new Error(`server did not become healthy: ${url}`);
}

async function callTool(baseUrl, name, body = {}) {
  const response = await fetch(`${baseUrl}/tool/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${name} failed: ${response.status} ${await response.text()}`);
  }
  return await response.json();
}

function panelStatus(rows = []) {
  return rows.map((row) => ({
    panel: row.panel,
    coverage: row.coverage,
    managed: row.managed,
    personal: row.personal,
    toolCount: Array.isArray(row.tools) ? row.tools.length : 0,
    boundaries: row.boundaries || [],
  }));
}

function isStrong(row) {
  return String(row.coverage || "").startsWith("strong");
}

function computeScorecard({ parity, capabilityMap, workflow, readiness, toolCatalog }) {
  const rows = Array.isArray(parity.rows) ? parity.rows : [];
  const strongPanels = rows.filter((row) => isStrong(row)).map((row) => row.panel);
  const partialPanels = rows
    .filter((row) => !isStrong(row) && row.coverage !== "intentional-gap")
    .map((row) => row.panel);
  const intentionalGapPanels = rows
    .filter((row) => row.coverage === "intentional-gap")
    .map((row) => row.panel);
  const facadePath = toolCatalog.agentEntryPoints?.facadePath || [];
  const professionalPath = toolCatalog.agentEntryPoints?.professionalPath || [];
  const expectedWorkflow = ["browser_open", "browser_capture", "browser_inspect", "browser_security_pack", "drilldownPlan"];
  const workflowAligned = expectedWorkflow.join(" -> ") === (workflow.defaultPath || []).join(" -> ");
  const objectiveBoundaryText = [
    parity.objectiveBoundaries || [],
    workflow.boundaries || [],
    readiness.objectiveBoundary || "",
    toolCatalog.agentEntryPoints?.objectiveBoundary || "",
  ].flat().join(" ");
  const objectiveBoundaryHeld = /does not (classify|judge)|not.*vulnerability/i.test(objectiveBoundaryText);
  const corePanels = ["Network", "Elements / Frames / Accessibility", "Application", "Sources / Debugger", "Console / Issues / Security", "Recorder / Evidence Workflow"];
  const missingCorePanels = corePanels.filter((panel) => !strongPanels.includes(panel));
  const appsecCoreAligned = missingCorePanels.length === 0 && workflowAligned && objectiveBoundaryHeld;
  const managedSupportCount = rows.filter((row) => row.managed === "supported").length;
  const personalSupportCount = rows.filter((row) => row.personal === "supported").length;
  const personalPartialCount = rows.filter((row) => row.personal === "partial").length;

  return {
    schema: "agent-browser-runtime.professional-scorecard.v1",
    generatedAt: new Date().toISOString(),
    backend: parity.backend || "managed-cdp",
    verdict: appsecCoreAligned ? "professional-core-ready" : "needs-core-work",
    targetStandard: parity.targetStandard,
    productBoundary: parity.professionalToolPositioning,
    alignment: {
      appsecCoreAligned,
      workflowAligned,
      objectiveBoundaryHeld,
      facadeFirst: facadePath.includes("browser_open") && facadePath.includes("browser_security_pack"),
      evidencePackRoute: professionalPath.includes("browser_security_pack"),
      rawEscapeHatch: facadePath.includes("browser_raw") || toolCatalog.agentEntryPoints?.compressedTools?.some((group) => group.label === "escape-hatch"),
    },
    panelCoverage: {
      panelCount: rows.length,
      strongPanelCount: strongPanels.length,
      strongPanels,
      partialPanels,
      intentionalGapPanels,
      missingCorePanels,
      managedSupportCount,
      personalSupportCount,
      personalPartialCount,
      rows: panelStatus(rows),
    },
    agentUsability: {
      recommendedFirstCall: toolCatalog.agentEntryPoints?.recommendedFirstCall || null,
      facadePath,
      professionalPath,
      workflowPath: workflow.defaultPath || [],
      capabilityPanelCount: Array.isArray(capabilityMap.panels) ? capabilityMap.panels.length : 0,
      readinessSummary: readiness.summary || null,
      readinessMissing: readiness.missing || [],
    },
    nextEngineeringFocus: [
      "Keep Managed Browser/CDP as the professional mainline.",
      "Use Personal Chrome as an operator-authorized bridge with explicit chrome.debugger boundaries.",
      "Add focused wrappers only when an AppSec workflow needs them; use raw CDP escape hatch otherwise.",
      "Keep objective evidence collection separate from vulnerability reasoning.",
    ],
  };
}

const serverPort = await freePort();
const browserPort = await freePort();
const tempDir = mkdtempSync(join(tmpdir(), "agent-professional-scorecard-"));
const child = spawn(process.execPath, ["scripts/agent-cdp-server.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    CDP_LAUNCH_BROWSER: "1",
    CDP_AGENT_SERVER_PORT: String(serverPort),
    CDP_BROWSER_PORT: String(browserPort),
    CDP_BROWSER_HEADLESS: "1",
    CDP_SECURITY_DATA_DIR: join(tempDir, "runtime"),
    CDP_BROWSER_USER_DATA_DIR: join(tempDir, "browser"),
  },
  stdio: "ignore",
});

try {
  await waitForHealth(serverPort);
  const baseUrl = `http://127.0.0.1:${serverPort}`;
  const profile = "professional-scorecard";
  const [parity, capabilityMap, workflow, readiness, toolCatalog] = await Promise.all([
    callTool(baseUrl, "devtools_f12_parity_matrix", { profile }),
    callTool(baseUrl, "devtools_capability_map", { profile }),
    callTool(baseUrl, "devtools_workflow_guide", { profile, task: "professional-appsec" }),
    callTool(baseUrl, "devtools_professional_readiness", { profile }),
    callTool(baseUrl, "devtools_tool_catalog", { profile }),
  ]);
  console.log(JSON.stringify(computeScorecard({ parity, capabilityMap, workflow, readiness, toolCatalog }), null, 2));
} finally {
  await fetch(`http://127.0.0.1:${serverPort}/shutdown`, { method: "POST" }).catch(() => {});
  setTimeout(() => child.kill(), 500);
  setTimeout(() => rmSync(tempDir, { recursive: true, force: true }), 1000);
}
