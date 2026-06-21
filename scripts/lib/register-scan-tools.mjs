// register-scan-tools.mjs — Excavator scan tools: bridge ABR traffic to analysis pipeline.
// V2 (2026-06-21): uses attack-harness Python path for subprocess calls.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { toolResult } from "./result-format.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// ABR (agent-browser-runtime) and helloworld are siblings under the same project dir.
// scripts/lib → scripts → agent-browser-runtime → project → + helloworld
const WORKSPACE_ROOT = process.env.PROJ ?? join(__dirname, "..", "..", "..", "helloworld");
const OBSERVER_DIR = join(WORKSPACE_ROOT, "system", "excavator", "observer");
const AH_CWD = process.env.ATTACK_HARNESS_CWD || join(WORKSPACE_ROOT, "attack-harness");
const PYTHON = process.env.PYTHON_BIN || "python";

// Helper: run python subprocess, return stdout/stderr + exit code.
// Adds attack-harness src to PYTHONPATH so observer scripts can import attack_harness.
function runPython(args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, args, {
      env: {
        ...process.env,
        PROJ: WORKSPACE_ROOT,
        PYTHONPATH: [AH_CWD + "/src", process.env.PYTHONPATH].filter(Boolean).join(";"),
      },
      cwd: OBSERVER_DIR,
    });
    const stdout = [];
    const stderr = [];
    proc.stdout.on("data", (d) => stdout.push(d.toString()));
    proc.stderr.on("data", (d) => stderr.push(d.toString()));
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`python subprocess timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.join(""), stderr: stderr.join("") });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export function registerScanTools({ tools, resolveProfile }) {

  // ──────────────────────────────────────────────────────────────────────────
  // browser_scan_bridge
  // Converts ABR-captured browser traffic for a profile into a response corpus.
  // Runs capture_bridge.py which reads ABR evidence dir, filters API endpoints,
  // redacts credentials, and writes responses-captured.jsonl to:
  //   targets/active/<target>/evidence/responses-captured.jsonl
  // This output is consumed by browser_scan_bola and signal_extractor.
  // ──────────────────────────────────────────────────────────────────────────
  tools.set("browser_scan_bridge", {
    name: "browser_scan_bridge",
    description: "Bridge ABR-captured browser traffic for a profile into a response corpus for scan analysis. Reads the profile's already-captured network traffic, filters to API-like authenticated endpoints within the given scope domains, redacts credentials, and writes responses-captured.jsonl. Run this before browser_scan_bola.",
    parameters: {
      type: "object",
      required: ["profile", "target", "scope"],
      properties: {
        profile: { type: "string", description: "ABR profile name whose captured traffic to read (e.g. 'mapbox-auth')." },
        target: { type: "string", description: "Target name for output path (e.g. 'mapbox'). Output written to targets/active/<target>/evidence/responses-captured.jsonl." },
        scope: { type: "array", items: { type: "string" }, description: "Scope domain(s) to include (e.g. ['api.mapbox.com', 'account.mapbox.com']). Only requests to these domains are included." },
      },
    },
    async execute(_id, params) {
      if (!params?.profile || !params?.target || !Array.isArray(params?.scope) || params.scope.length === 0) {
        return toolResult({ ok: false, error: "profile, target, and scope (non-empty array) are required" });
      }
      if (!/^[\w][\w.-]{0,99}$/.test(String(params.target))) {
        return toolResult({ ok: false, error: "target must be a simple name (alphanumeric, hyphens, underscores, dots — no path separators)" });
      }
      if (!/^[\w][\w.-]{0,99}$/.test(String(params.profile))) {
        return toolResult({ ok: false, error: "profile must be a simple name (alphanumeric, hyphens, underscores, dots — no path separators)" });
      }
      const scriptPath = join(OBSERVER_DIR, "capture_bridge.py");
      if (!existsSync(scriptPath)) {
        return toolResult({ ok: false, error: `capture_bridge.py not found at ${scriptPath}` });
      }
      const args = [
        scriptPath,
        "--profile", params.profile,
        "--target", params.target,
        "--scope", ...params.scope,
      ];
      let result;
      try {
        result = await runPython(args, 120_000);
      } catch (err) {
        return toolResult({ ok: false, error: err.message });
      }
      const capturedMatch = result.stdout.match(/captured_count:\s*(\d+)/);
      const capturedCount = capturedMatch ? parseInt(capturedMatch[1], 10) : null;
      const outputPath = join(WORKSPACE_ROOT, "targets", "active", params.target, "evidence", "responses-captured.jsonl");
      return toolResult({
        ok: result.code === 0,
        exitCode: result.code,
        capturedCount,
        outputPath: existsSync(outputPath) ? outputPath : null,
        stdout: result.stdout.slice(0, 2000),
        stderr: result.stderr.slice(0, 500) || undefined,
      });
    },
  });

  // ──────────────────────────────────────────────────────────────────────────
  // browser_scan_bola
  // Reads corpus (responses-captured.jsonl), identifies account-scoped endpoints,
  // swaps self_id with victim_ids, sends 3 probes per endpoint (baseline_self /
  // attack_victim / control_anon), writes bola-results.json.
  // Safety: GET/HEAD only, scope-guarded, rate-limited.
  // Default dry run (execute: false) — pass execute: true to send real probes.
  // ──────────────────────────────────────────────────────────────────────────
  tools.set("browser_scan_bola", {
    name: "browser_scan_bola",
    description: "Run horizontal authorization probe (BOLA) against endpoints identified in the scan corpus. Reads corpus from targets/active/<target>/evidence/, swaps account IDs, sends GET probes, writes bola-results.json. Default is dry run — pass execute:true to send real HTTP probes. Run browser_scan_bridge first to build the corpus.",
    parameters: {
      type: "object",
      required: ["target"],
      properties: {
        target: { type: "string", description: "Target name (e.g. 'mapbox'). Must match a directory in targets/active/<target>/evidence/ containing responses-captured.jsonl." },
        victimIds: { type: "string", description: "Optional comma-separated victim account IDs to probe with (e.g. 'id1,id2'). If omitted, uses IDs discovered from corpus." },
        maxEndpoints: { type: "number", description: "Maximum endpoints to probe. Default 30." },
        sleep: { type: "number", description: "Seconds to sleep between probes for rate-limiting. Default 0.2." },
        execute: { type: "boolean", description: "If false (default), dry run only — no real HTTP probes sent. Set to true to run live probes." },
        timeoutMs: { type: "number", description: "Subprocess timeout in milliseconds. Default 120000." },
      },
    },
    async execute(_id, params) {
      if (!params?.target) {
        return toolResult({ ok: false, error: "target is required" });
      }
      if (!/^[\w][\w.-]{0,99}$/.test(String(params.target))) {
        return toolResult({ ok: false, error: "target must be a simple name (alphanumeric, hyphens, underscores, dots — no path separators)" });
      }
      const scriptPath = join(OBSERVER_DIR, "bola_prober.py");
      if (!existsSync(scriptPath)) {
        return toolResult({ ok: false, error: `bola_prober.py not found at ${scriptPath}` });
      }
      const args = [scriptPath, params.target];
      if (params.victimIds) args.push("--victim-ids", params.victimIds);
      if (params.maxEndpoints != null) args.push("--max-endpoints", String(params.maxEndpoints));
      if (params.sleep != null) args.push("--sleep", String(params.sleep));
      if (params.execute === true) args.push("--execute");
      const timeoutMs = Math.min(300_000, Math.max(5_000, Number(params.timeoutMs) || 120_000));
      let result;
      try {
        result = await runPython(args, timeoutMs);
      } catch (err) {
        return toolResult({ ok: false, error: err.message });
      }
      const outputPath = join(WORKSPACE_ROOT, "targets", "active", params.target, "evidence", "bola-results.json");
      return toolResult({
        ok: result.code === 0,
        exitCode: result.code,
        mode: params.execute === true ? "executed" : "dry_run",
        outputPath: existsSync(outputPath) ? outputPath : null,
        stdout: result.stdout.slice(0, 4000),
        stderr: result.stderr.slice(0, 500) || undefined,
      });
    },
  });

  // ──────────────────────────────────────────────────────────────────────────
  // browser_scan_status
  // Lists available scan output files for a target.
  // No subprocess — pure filesystem check.
  // ──────────────────────────────────────────────────────────────────────────
  tools.set("browser_scan_status", {
    name: "browser_scan_status",
    description: "Check what scan output files are available for a target. Returns a list of files found in targets/active/<target>/evidence/ that are produced by the scan pipeline (responses-captured.jsonl, bola-results.json, etc.).",
    parameters: {
      type: "object",
      required: ["target"],
      properties: {
        target: { type: "string", description: "Target name (e.g. 'mapbox')." },
      },
    },
    async execute(_id, params) {
      if (!params?.target) {
        return toolResult({ ok: false, error: "target is required" });
      }
      const evidenceDir = join(WORKSPACE_ROOT, "targets", "active", params.target, "evidence");
      if (!existsSync(evidenceDir)) {
        return toolResult({ ok: true, target: params.target, evidenceDir, exists: false, files: [] });
      }
      const SCAN_FILES = [
        "responses-captured.jsonl",
        "responses.jsonl",
        "bola-results.json",
        "corpus.json",
        "signals.json",
      ];
      const files = SCAN_FILES.map((name) => {
        const p = join(evidenceDir, name);
        if (!existsSync(p)) return null;
        const s = statSync(p);
        return { name, size: s.size, modifiedAt: s.mtime.toISOString() };
      }).filter(Boolean);
      return toolResult({ ok: true, target: params.target, evidenceDir, exists: true, files });
    },
  });
}
