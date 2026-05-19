#!/usr/bin/env node

/**
 * Operator Demo Report generator for Agent Browser Runtime.
 *
 * Converts the structured output of examples/security-research-pack.mjs into a
 * compact, human-readable Markdown report. Designed for:
 *
 *   - a new agent that needs to orient quickly without loading full JSON,
 *   - a reviewer who wants to understand what evidence was collected.
 *
 * This module does NOT judge vulnerabilities, assign risk scores, or assess
 * exploitability. It reports browser facts and tool call routes only.
 *
 * Usage:
 *   import { buildOperatorDemoReport } from "./security-research-demo-report.mjs";
 *   const md = buildOperatorDemoReport(packExampleResult);
 *
 * CLI:
 *   node scripts/security-research-demo-report.mjs <input.json> [output.md]
 */

function formatPath(p) {
  return p ? `\`${p}\`` : "_not captured_";
}

/**
 * Build a compact Markdown operator demo report from the structured result of
 * examples/security-research-pack.mjs (or any object with the same shape).
 *
 * @param {object} result - Output object from the security research pack example.
 * @param {object} [options]
 * @param {string} [options.title] - Custom report title.
 * @returns {string} Markdown report text.
 */
export function buildOperatorDemoReport(result, options = {}) {
  const { title = "Agent Browser Runtime — Operator Demo Report" } = options;
  const now = new Date().toISOString();

  const summary = result.summary || {};
  const operatorHandoff = result.operatorHandoff || {};
  const f12Nav = result.f12Navigation || {};
  const firstDetail = result.firstF12RequestDetail || {};
  const afterReadiness = result.afterReadiness || {};
  const artifactPaths = result.artifactPaths || {};
  const captureBoundaries = result.captureBoundaries || {};

  const lines = [];

  // ── Header ─────────────────────────────────────────────────────────────────
  lines.push(`# ${title}`);
  lines.push(`\n_Generated: ${now}_`);
  lines.push("");

  // ── Capture Summary ─────────────────────────────────────────────────────────
  lines.push("## Capture Summary");
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("|---|---|");
  lines.push(`| Backend | \`${result.backend || "unknown"}\` |`);
  lines.push(`| Profile | \`${result.profile || "unknown"}\` |`);
  lines.push(`| URL | \`${result.url || "unknown"}\` |`);
  lines.push(`| Request count | ${summary.requestCount ?? "_unknown_"} |`);

  const consoleErrors = result.consoleSummary?.errorCount ?? null;
  if (consoleErrors !== null) {
    lines.push(`| Console errors | ${consoleErrors} |`);
  }
  const consoleCount = result.consoleSummary?.entryCount ?? summary.consoleEntryCount ?? null;
  if (consoleCount !== null) {
    lines.push(`| Console entries | ${consoleCount} |`);
  }
  const failedRequests = result.networkSummary?.failedCount ?? null;
  if (failedRequests !== null) {
    lines.push(`| Failed requests | ${failedRequests} |`);
  }

  lines.push(
    `| Handoff ready | ${
      result.handoff?.ready === true
        ? "✅ yes"
        : "⚠️ " + (result.handoff?.missing?.join(", ") || "no")
    } |`,
  );
  lines.push(
    `| Artifact coverage | ${
      result.artifactCoverage?.ready === true ? "✅ yes" : "⚠️ see below"
    } |`,
  );

  if (captureBoundaries.startTime || captureBoundaries.endTime) {
    lines.push(`| Capture start | \`${captureBoundaries.startTime || "unknown"}\` |`);
    lines.push(`| Capture end | \`${captureBoundaries.endTime || "unknown"}\` |`);
  }
  lines.push("");

  // ── F12 Evidence Surfaces ───────────────────────────────────────────────────
  lines.push("## F12 Evidence Surfaces");
  lines.push("");
  lines.push("Evidence collected by `devtools_security_research_pack`:");
  lines.push("");

  const surfaceRows = [
    ["F12 Navigation index", artifactPaths.f12NavigationPath],
    ["First request detail", artifactPaths.firstF12RequestDetailPath],
    ["HAR", artifactPaths.harPath],
    ["HAR completeness report", artifactPaths.harCompletenessPath],
    ["Application export", artifactPaths.applicationExportPath],
    ["Chrome trace", artifactPaths.tracePath],
    ["Evidence bundle", artifactPaths.evidenceBundlePath],
    ["Evidence manifest", artifactPaths.evidenceManifestPath],
    ["Correlation graph", artifactPaths.correlationGraphPath],
    ["Auth boundary report", artifactPaths.authBoundaryReportPath],
    ["Worker/frame boundary", artifactPaths.workerFrameReportPath],
    ["Research pack (handoff JSON)", artifactPaths.researchPackPath],
    ["Drilldown plan", artifactPaths.drilldownPlanPath],
  ].filter(([, p]) => p);

  if (surfaceRows.length > 0) {
    lines.push("| Evidence Surface | Path |");
    lines.push("|---|---|");
    for (const [label, p] of surfaceRows) {
      lines.push(`| ${label} | ${formatPath(p)} |`);
    }
  } else {
    lines.push("_No artifact paths available._");
  }
  lines.push("");

  if (result.artifactCoverage?.missing?.length > 0) {
    lines.push(
      `> **Missing artifacts**: ${result.artifactCoverage.missing.join(", ")}`,
    );
    lines.push("");
  }
  if (result.artifactCoverage?.skipped?.length > 0) {
    lines.push(
      `> **Skipped artifacts**: ${result.artifactCoverage.skipped.join(", ")}`,
    );
    lines.push("");
  }

  // ── Operator Handoff ────────────────────────────────────────────────────────
  lines.push("## Operator Handoff");
  lines.push("");

  const firstRead = operatorHandoff.firstRead;
  if (firstRead) {
    lines.push(
      `**First read**: ${firstRead.purpose || "Bounded read of the research pack"}`,
    );
    lines.push("");
    if (firstRead.route) {
      lines.push("```json");
      lines.push(JSON.stringify(firstRead.route, null, 2));
      lines.push("```");
    }
    lines.push("");
  } else {
    lines.push("_Operator handoff not available._");
    lines.push("");
  }

  // ── First Request Drilldown ─────────────────────────────────────────────────
  lines.push("## First Request Drilldown");
  lines.push("");

  const firstRequest = operatorHandoff.firstRequest || f12Nav.firstDetailRoute || null;
  if (firstRequest) {
    lines.push(
      "Call this tool to inspect the first captured request's headers, cookies, timing, and initiator:",
    );
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(firstRequest, null, 2));
    lines.push("```");
    if (firstDetail.url) {
      lines.push("");
      lines.push(`**Request URL**: \`${firstDetail.url}\``);
    }
    if (firstDetail.status !== undefined && firstDetail.status !== null) {
      lines.push(`**Status**: \`${firstDetail.status}\``);
    }
    const headerCount = firstDetail.headerSummary?.requestHeaderCount;
    if (headerCount !== undefined) {
      lines.push(`**Request header count**: ${headerCount}`);
    }
  } else {
    lines.push("_First request detail route not available._");
  }
  lines.push("");

  // ── Route Artifacts ─────────────────────────────────────────────────────────
  lines.push("## Route Artifacts");
  lines.push("");
  lines.push(
    "Each row is a ready-to-execute tool call into a saved evidence file.",
  );
  lines.push(
    "Use `inspectRoute` for a structural summary; use `readRoute` for bounded line-range reading.",
  );
  lines.push("");

  const routeArtifacts = operatorHandoff.routeArtifacts || [];
  if (routeArtifacts.length > 0) {
    lines.push("| Name | Inspect | Read |");
    lines.push("|---|---|---|");
    for (const art of routeArtifacts) {
      const inspect = art.inspectRoute ? `\`${art.inspectRoute.tool}\`` : "—";
      const read = art.readRoute ? `\`${art.readRoute.tool}\`` : "—";
      lines.push(`| \`${art.name}\` | ${inspect} | ${read} |`);
    }
  } else {
    lines.push("_No route artifacts available._");
  }
  lines.push("");

  // ── Suggested Next Tool Calls ───────────────────────────────────────────────
  lines.push("## Suggested Next Tool Calls");
  lines.push("");

  const drilldowns =
    operatorHandoff.drilldowns?.length > 0
      ? operatorHandoff.drilldowns
      : (result.firstDrilldowns || []).slice(0, 3).map((d) => ({
          label: d.label || d.tool || "drilldown",
          tool: d.tool,
          input: d.input || {},
        }));

  if (drilldowns.length > 0) {
    for (const d of drilldowns) {
      lines.push(`**${d.label || d.tool}**`);
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify({ tool: d.tool, input: d.input }, null, 2));
      lines.push("```");
      lines.push("");
    }
  } else {
    lines.push("_No drilldown suggestions available._");
    lines.push("");
  }

  // ── Objective Boundary ──────────────────────────────────────────────────────
  lines.push("## Objective Boundary");
  lines.push("");
  const boundary =
    operatorHandoff.objectiveBoundary ||
    afterReadiness.objectiveBoundary ||
    result.objectiveBoundary ||
    "Collect browser evidence only; do not classify findings as vulnerabilities.";
  lines.push(`> ${boundary}`);
  lines.push("");
  lines.push(
    "This report contains browser runtime evidence: request counts, artifact paths,",
  );
  lines.push(
    "and tool call routes. It does not contain vulnerability conclusions, risk scores,",
  );
  lines.push(
    "or exploitability assessments. Those are separate reasoning steps outside this runtime.",
  );
  lines.push("");

  return lines.join("\n");
}

// ── CLI entry ───────────────────────────────────────────────────────────────
// Run directly: node scripts/security-research-demo-report.mjs <input.json> [output.md]
if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/security-research-demo-report.mjs")) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath) {
    console.error(
      "Usage: node scripts/security-research-demo-report.mjs <input.json> [output.md]",
    );
    process.exit(1);
  }
  const result = JSON.parse(readFileSync(inputPath, "utf8"));
  const md = buildOperatorDemoReport(result);
  if (outputPath) {
    writeFileSync(outputPath, md, "utf8");
    console.log(`Demo report written to: ${outputPath}`);
  } else {
    process.stdout.write(md);
  }
}
