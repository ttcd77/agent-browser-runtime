#!/usr/bin/env node
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, "agent-browser-cli.mjs");
const fixtureUserDataDir = join(homedir(), ".agent-browser-runtime", "browser-identities", "default");
const tempDir = mkdtempSync(join(tmpdir(), "agent-browser-cli-smoke-"));
const workflowPath = join(tempDir, "workflow.json");
const requests = [];
let fixtureProfilePortSummary = {
  ok: true,
  state: "canonical",
  canonicalCdpPort: 9222,
  totalProfiles: 1,
  mismatchedCount: 0,
  mismatchedProfiles: [],
  ports: { "9222": 1 },
};
let fixturePersonalOk = false;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        baseUrl: "fixture",
        cdpPort: 9222,
        cdpEndpoint: "http://127.0.0.1:9222",
        browserAttachMode: "launched-managed-browser",
        browserLaunchMode: "headful",
        browserHeadless: false,
        launchedByServer: true,
        cdpHealth: {
          reachable: true,
          failureMode: null,
          recoveryAttempted: false,
          recovered: false,
          recoveryError: null,
        },
        browserProcess: {
          managedByWorker: true,
          running: true,
          pid: 12345,
          relaunchCount: 0,
          cdpPort: 9222,
        },
        browserRuntimeIdentity: {
          productBackend: "managed",
          transport: "direct-cdp",
          physicalBrowser: "CloakBrowser",
          browserProduct: "Chrome/126.0.0.0",
          cdpPort: 9222,
          cdpEndpoint: "http://127.0.0.1:9222",
          attachMode: "launched-managed-browser",
          launchMode: "headful",
          headless: false,
          launchedByServer: true,
          userDataDir: fixtureUserDataDir,
        },
        profilePortSummary: fixtureProfilePortSummary,
      }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/tools") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ tools: ["browser_open", "browser_raw"] }));
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/tool/")) {
      const tool = decodeURIComponent(url.pathname.slice("/tool/".length));
      const raw = await readBody(req);
      const payload = raw ? JSON.parse(raw) : {};
      requests.push({ tool, payload });
      const rawToolName = payload.tool || payload.toolName || "";
      const rawParams = payload.input || payload.params || {};
      if (tool === "browser_click" && payload.text === "Broken") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "browser_click timed out waiting for actionability" }));
        return;
      }
      if (tool === "browser_raw" && !String(rawToolName).startsWith("devtools_") && !String(rawToolName).startsWith("browser_") && !String(rawToolName).startsWith("profile_")) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "browser_raw only allows devtools_* / browser_* / profile_* tools" }));
        return;
      }
      if (tool === "browser_raw" && rawToolName === "profile_request_replay" && rawParams?.headers?.["content-length"]) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Refused to set unsafe header: content-length" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (tool === "browser_capture" && payload.action === "status") {
        res.end(JSON.stringify({
          ok: true,
          profile: payload.profile || "default",
          action: "status",
          captureEnabled: true,
          capturedRequestCount: 1,
        }));
        return;
      }
      if (tool === "browser_raw" && rawToolName === "profile_traffic_query") {
        if (rawParams?.urlContains === "nomatch") {
          res.end(JSON.stringify({
            profile: rawParams.profile || "default",
            filtersApplied: rawParams,
            returned: 0,
            total: 0,
            hasMore: false,
            requests: [],
          }));
          return;
        }
        if (rawParams?.urlContains === "many-graphql") {
          const allRows = Array.from({ length: 8 }, (_, index) => ({
            requestId: `gql-${index + 1}`,
            method: "POST",
            status: 200,
            resourceType: "fetch",
            url: `https://example.com/many-graphql/${index + 1}`,
            hasRequestBody: true,
            hasResponseBody: true,
            f12Columns: {
              name: `many-graphql-${index + 1}`,
              method: "POST",
              status: 200,
              type: "fetch",
              initiator: "script",
              time: "24 ms",
            },
          }));
          const limit = Number(rawParams.limit || allRows.length);
          const rows = allRows.slice(0, Math.min(limit, allRows.length));
          res.end(JSON.stringify({
            profile: rawParams.profile || "default",
            filtersApplied: rawParams,
            returned: rows.length,
            total: allRows.length,
            hasMore: rows.length < allRows.length,
            requests: rows,
          }));
          return;
        }
        const networkLog = {
          profile: rawParams.profile || "default",
          filtersApplied: rawParams,
          returned: 1,
          total: 1,
          hasMore: false,
          requests: [{
            requestId: "req-1",
            method: "POST",
            status: 200,
            resourceType: "fetch",
            url: "https://example.com/graphql",
            hasRequestBody: true,
            hasResponseBody: true,
            f12Columns: {
              name: "graphql",
              method: "POST",
              status: 200,
              type: "fetch",
              initiator: "script",
              time: "24 ms",
            },
          }],
        };
        res.end(JSON.stringify(rawParams.profile === "wrapped-raw"
          ? { backend: "managed-cdp", facade: "browser_raw", tool: rawToolName, result: networkLog }
          : networkLog));
        return;
      }
      if (tool === "browser_raw" && rawToolName === "profile_request_payload") {
        res.end(JSON.stringify({
          profile: rawParams.profile || "default",
          requestId: rawParams.requestId,
          postData: JSON.stringify({
            operationName: "UpdateRole",
            query: "mutation UpdateRole($role: String!) { updateRole(role: $role) { id role } }",
            variables: { role: "user" },
          }),
          postDataLength: 120,
        }));
        return;
      }
      if (tool === "browser_security_summary") {
        res.end(JSON.stringify({
          ok: true,
          schema: "agent-browser.security.summary.fixture",
          profile: payload.profile || "default",
          page: { url: "https://example.com", securityState: "secure" },
          certificate: { subjectName: "example.com" },
        }));
        return;
      }
      if (tool === "browser_screenshot") {
        const result = {
          ok: true,
          profile: payload.profile || "default",
          tabId: "tab-1",
          path: "C:\\tmp\\agent-browser-shot.png",
          mimeType: "image/png",
          bytes: 2_048_000,
          imageInlined: payload.includeImage !== false,
        };
        if (payload.includeImage !== false) {
          result._mcp = {
            content: [
              { type: "text", text: JSON.stringify(result) },
              { type: "image", data: "large-base64-placeholder", mimeType: "image/png" },
            ],
          };
        }
        res.end(JSON.stringify(result));
        return;
      }
      if (tool === "browser_find") {
        res.end(JSON.stringify({
          ok: true,
          profile: payload.profile || "default",
          query: payload.query,
          candidates: [{
            selector: "input[name=email]",
            text: "Email",
            role: "textbox",
          }],
        }));
        return;
      }
      if (tool === "browser_evidence_bundle") {
        res.end(JSON.stringify({
          schema: "agent-browser.evidence.bundle.v1",
          ok: true,
          profile: payload.profile || "default",
          summary: {
            url: "https://example.com/dashboard",
            requestCount: 2,
            issueCount: 0,
            screenshotPath: "C:\\tmp\\agent-browser-shot.png",
            unavailableCount: 0,
          },
          bundlePath: "C:\\tmp\\agent-browser-evidence.json",
          bundle: {
            snapshot: { title: "Dashboard", controls: [] },
            screenshot: { path: "C:\\tmp\\agent-browser-shot.png", imageInlined: false },
          },
          nextCommands: ["agent-browser artifact inspect \"C:\\tmp\\agent-browser-evidence.json\""],
          boundary: "Evidence bundle collects objective browser state.",
        }));
        return;
      }
      if (tool === "browser_download_watch") {
        res.end(JSON.stringify({
          schema: "agent-browser.download.watch.v1",
          ok: true,
          profile: payload.profile || "default",
          mode: "cdp-browser-events",
          action: payload.action,
          downloadPath: payload.downloadPath || payload.dir || "downloads",
          completed: payload.action === "status" ? [{ suggestedFilename: "report.csv", state: "completed" }] : [],
          boundary: "Uses CDP Browser.setDownloadBehavior with Browser.downloadWillBegin/downloadProgress events.",
        }));
        return;
      }
      if (tool === "browser_auth_bootstrap") {
        const action = payload.action || "start";
        const configuredSuccessConditions = [
          payload.successUrlContains ? "url" : "",
          payload.successSelector ? "selector" : "",
          Array.isArray(payload.successCookieNames) && payload.successCookieNames.length ? "cookies" : "",
        ].filter(Boolean);
        res.end(JSON.stringify({
          ok: true,
          profile: payload.profile || "default",
          action,
          url: payload.loginUrl || "https://example.com/login",
          success: action !== "start" && configuredSuccessConditions.length > 0,
          checks: {
            successUrlContains: payload.successUrlContains || null,
            successSelector: payload.successSelector || null,
            selectorMatched: Boolean(payload.successSelector),
            successCookieNames: payload.successCookieNames || [],
            configuredSuccessConditions,
            noSuccessConditionConfigured: configuredSuccessConditions.length === 0,
          },
          boundary: "Manual/operator-assisted auth state observation only.",
          next: action === "start" ? "Complete login, then run status." : "Proceed with authenticated profile.",
        }));
        return;
      }
      if (tool === "browser_eval") {
        const profile = payload.profile || "default";
        res.end(JSON.stringify({
          profile,
          result: {
            href: "https://example.com/dashboard",
            origin: "https://example.com",
            cookie: profile === "attacker" ? "sid=attacker-session" : "sid=victim-session",
            cookieNames: ["sid"],
            localStorageEntries: [["account", profile]],
            sessionStorageEntries: [["tab", profile]],
          },
        }));
        return;
      }
      if (tool === "browser_backend_status") {
        res.end(JSON.stringify({
          ok: true,
          backend: "managed",
          mode: "managed",
          workerUrl: "http://127.0.0.1:17335",
          cdpPort: 9222,
          backendDetail: "managed CDP browser on port 9222",
          managed: {
            ok: true,
            backend: "managed-cdp",
            runtimeIdentity: {
              productBackend: "managed",
              transport: "direct-cdp",
              physicalBrowser: "CloakBrowser",
              browserProduct: "Chrome/126.0.0.0",
              cdpPort: 9222,
              cdpEndpoint: "http://127.0.0.1:9222",
              attachMode: "launched-managed-browser",
              launchMode: "headful",
              headless: false,
              launchedByServer: true,
              userDataDir: fixtureUserDataDir,
            },
            profilePortSummary: fixtureProfilePortSummary,
          },
          personal: fixturePersonalOk
            ? {
                ok: true,
                status: 200,
                backend: "personal-chrome",
                health: {
                  ok: true,
                  connected: 1,
                  clients: [{ name: "personal-chrome" }],
                },
              }
            : {
                ok: false,
                status: 503,
                backend: "personal-chrome",
                error: "personal bridge unavailable",
              },
          suggestedNext: fixtureProfilePortSummary.ok ? [] : fixtureProfilePortSummary.next,
        }));
        return;
      }
      if (tool === "browser_tabs") {
        const profile = payload.profile || "default";
        res.end(JSON.stringify({
          ok: true,
          profile,
          tabs: [{ tabId: "tab-1", url: "https://example.com/dashboard", title: "Dashboard", active: true }],
          count: 1,
        }));
        return;
      }
      if (tool === "profile_list") {
        res.end(JSON.stringify({
          ok: true,
          profiles: [{ name: "researcher", state: "idle" }, { name: "authenticated", state: "idle" }, { name: "default", state: "idle" }],
          count: 3,
        }));
        return;
      }
      if (tool === "browser_scroll") {
        res.end(JSON.stringify({
          ok: true,
          profile: payload.profile || "default",
          scrollX: 0,
          scrollY: 0,
          before: { scrollX: 0, scrollY: 0 },
          after: { scrollX: 0, scrollY: 0 },
          delta: { x: Number(payload.x || 0), y: Number(payload.y || 600) },
          viewport: { width: 1280, height: 720 },
          document: { scrollWidth: 1280, scrollHeight: 640, clientWidth: 1280, clientHeight: 720 },
          canScrollY: false,
          movedY: false,
          reachedTop: true,
          reachedBottom: true,
        }));
        return;
      }
      if (tool === "browser_raw" && rawToolName === "profile_request_detail") {
        const requestId = rawParams.requestId;
        if (requestId === "fetch-intercept-1" || requestId === "missing-request") {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `requestId not found: ${requestId}` }));
          return;
        }
        const bodies = {
          "req-1": JSON.stringify({ role: "user", id: 1 }),
          "req-2": JSON.stringify({ role: "admin", id: 1, permissions: ["delete"] }),
        };
        res.end(JSON.stringify({
          profile: rawParams.profile || "default",
          requestId,
          method: "POST",
          url: "https://example.com/graphql",
          status: 200,
          headers: { "content-type": "application/json", "content-length": "120", cookie: "sid=secret", "sec-ch-ua": "\"Chromium\"" },
          body: bodies[requestId] || JSON.stringify({ requestId }),
        }));
        return;
      }
      if (tool === "browser_raw" && rawToolName === "profile_request_replay") {
        const body = rawParams.json ? JSON.stringify(rawParams.json) : String(rawParams.body || "{\"ok\":true}");
        res.end(JSON.stringify({
          profile: rawParams.profile || "default",
          requestId: rawParams.requestId,
          status: body.includes("admin") ? 403 : 200,
          headers: { "content-type": "application/json" },
          body,
        }));
        return;
      }
      if (tool === "browser_raw" && rawToolName === "profile_request_replay_batch") {
        const variants = Array.isArray(rawParams.variants) ? rawParams.variants : [];
        res.end(JSON.stringify({
          profile: rawParams.profile || "default",
          requestId: rawParams.requestId,
          results: variants.map((variant, index) => {
            const body = variant.json ? JSON.stringify(variant.json) : String(variant.body || "{\"ok\":true}");
            return {
              label: variant.label || `variant-${index + 1}`,
              status: body.includes("admin") ? 403 : 200,
              headers: { "content-type": "application/json" },
              body,
            };
          }),
        }));
        return;
      }
      if (tool === "browser_stuck") {
        const profile = payload.profile || "default";
        if (profile === "authenticated") {
          res.end(JSON.stringify({
            ok: true,
            profile,
            tabId: "tab-authenticated",
            url: "https://example.com/dashboard",
            title: "Dashboard",
            pageAccessError: null,
            pageState: {
              readyState: "complete",
              bodyTextLength: 128,
              visibleControlCount: 1,
              disabledControlCount: 0,
            },
            formState: {
              formCount: 0,
              inputCount: 0,
              passwordInputCount: 0,
              disabledSubmitControlCount: 0,
            },
            signals: [],
            suggestedNext: [`agent-browser observe --profile ${profile}`],
          }));
          return;
        }
        if (profile === "blank-form") {
          res.end(JSON.stringify({
            ok: true,
            profile,
            tabId: "tab-blank-form",
            url: "https://example.com/login",
            title: "Login",
            pageAccessError: null,
            pageState: {
              readyState: "complete",
              bodyTextLength: 0,
              visibleControlCount: 2,
              disabledControlCount: 0,
            },
            formState: {
              formCount: 1,
              inputCount: 1,
              passwordInputCount: 0,
              disabledSubmitControlCount: 0,
            },
            signals: ["blank-page"],
            suggestedNext: [`agent-browser observe --profile ${profile}`],
          }));
          return;
        }
        if (profile === "network-pending") {
          res.end(JSON.stringify({
            ok: true,
            profile,
            tabId: "tab-network-pending",
            url: "https://example.com/dashboard",
            title: "Dashboard",
            pageAccessError: null,
            pageState: {
              readyState: "complete",
              bodyTextLength: 128,
              visibleControlCount: 2,
              disabledControlCount: 0,
            },
            formState: {
              formCount: 0,
              inputCount: 0,
              passwordInputCount: 0,
              disabledSubmitControlCount: 0,
            },
            networkState: {
              checkedRecentRequests: true,
              recentRequestCount: 4,
              pendingCount: 1,
              stalePendingCount: 1,
              failedCount: 0,
              latestPending: [{ requestId: "pending-1", url: "https://example.com/api/slow", method: "POST", status: null, ageMs: 30000 }],
              latestFailed: [],
              capture: { enabled: true, label: "pending-smoke" },
            },
            signals: ["network-pending"],
            suggestedNext: [`agent-browser requests --profile ${profile} --limit 20`],
          }));
          return;
        }
        res.end(JSON.stringify({
          ok: true,
          profile,
          tabId: "tab-1",
          url: "https://example.com/dashboard",
          title: "Dashboard",
          pageAccessError: null,
          pageState: {
            readyState: "complete",
            bodyTextLength: 128,
            visibleControlCount: 3,
            disabledControlCount: 0,
            hasActiveElement: false,
            activeElement: null,
          },
          formState: {
            formCount: 1,
            inputCount: 2,
            passwordInputCount: 1,
            fileInputCount: 0,
            textareaCount: 0,
            submitControlCount: 1,
            disabledSubmitControlCount: 0,
          },
          signals: [],
          suggestedNext: [`agent-browser observe --profile ${profile}`],
        }));
        return;
      }
      if (tool === "cdp_fetch_intercept" && payload.action === "list") {
        res.end(JSON.stringify([{
          requestId: "fetch-intercept-1",
          capturedRequestId: "fetch-intercept-1",
          cdpRequestId: "intercept-1",
          url: "https://example.com/graphql",
          method: "POST",
          headers: { "content-type": "application/json" },
          postData: "{\"role\":\"user\"}",
          timerRemainingMs: 25000,
        }]));
        return;
      }
      if (tool === "cdp_fetch_intercept" && payload.action === "continue") {
        res.end(JSON.stringify({
          ok: true,
          capturedRequestId: payload.captured_request_id,
          url: "https://example.com/graphql",
          method: "POST",
        }));
        return;
      }
      res.end(JSON.stringify({ ok: true, tool, payload }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    } else {
      res.end();
    }
  }
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address();
const baseArgs = ["--server", `http://127.0.0.1:${port}`];

function runCli(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args, ...baseArgs], {
      cwd: join(__dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`CLI failed ${code}: ${stderr}`));
      else resolve(JSON.parse(stdout));
    });
  });
}

function runCliWithEnvServer(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: join(__dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        AGENT_BROWSER_RUNTIME_URL: `http://127.0.0.1:${port}`,
        ...extraEnv,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`CLI failed ${code}: ${stderr}`));
      else resolve(JSON.parse(stdout));
    });
  });
}

function runCliFailure(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args, ...baseArgs], {
      cwd: join(__dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) reject(new Error(`CLI unexpectedly succeeded: ${stdout}`));
      else {
        let json = null;
        try {
          json = stdout ? JSON.parse(stdout) : null;
        } catch {
          json = null;
        }
        resolve({ code, stdout, stderr, json });
      }
    });
  });
}

try {
  const health = await runCli(["doctor"]);
  assert(health.schema === "agent-browser.doctor.v1", "doctor returned wrong schema");
  assert(health.ok === true, "doctor did not read health endpoint");
  assert(health.doctorSummary.state === "worker-ready", "doctor did not summarize worker readiness");
  assert(health.doctorSummary.evidence.cdpHealth?.reachable === true, "doctor did not expose CDP health evidence");
  assert(health.doctorSummary.evidence.browserProcess?.managedByWorker === true, "doctor did not expose managed browser process evidence");
  assert(health.suggestedNext.some((entry) => entry.includes("agent-browser guide")), "doctor did not suggest guide entry point");
  assert(health.suggestedNext.some((entry) => entry.includes("profile preflight")), "doctor did not suggest profile preflight");
  const envServerHealth = await runCliWithEnvServer(["doctor"]);
  assert(envServerHealth.ok === true, "doctor did not use AGENT_BROWSER_RUNTIME_URL when --server is omitted");
  assert(envServerHealth.workerUrl === `http://127.0.0.1:${port}`, "doctor lost discovered worker URL");
  const agentChromePlan = await runCli(["agent-chrome", "plan", "--profile", "agent-smoke", "--url", "https://example.com"]);
  assert(agentChromePlan.lane === "agent-chrome-profile", "agent chrome plan returned wrong lane");
  assert(agentChromePlan.maturity === "profile-routable", "agent chrome plan should expose profile-routable maturity");
  assert(agentChromePlan.markerUrl?.includes("profile=agent-smoke"), "agent chrome plan should expose a profile marker URL");
  assert(agentChromePlan.bootstrapUrl?.includes("profile=agent-smoke"), "agent chrome plan should expose a profile bootstrap URL");
  assert(agentChromePlan.launchArgs?.includes(agentChromePlan.markerUrl), "agent chrome launch args should include marker URL");
  assert(agentChromePlan.remoteDebuggingPort === null, "agent chrome profile should not use a remote debugging port");
  assert(agentChromePlan.controlTransport === "chrome-extension-debugger-bridge", "agent chrome plan returned wrong transport");
  assert(agentChromePlan.extensionInstall?.mode, "agent chrome plan should expose extension install mode");
  if (agentChromePlan.executableKind === "branded-google-chrome") {
    assert(agentChromePlan.extensionInstall.commandLineLoadExtensionSupported === false, "branded Chrome should not claim command-line extension loading");
    assert(!agentChromePlan.launchArgs.some((entry) => String(entry).startsWith("--load-extension=")), "branded Chrome launch args should not include unsupported --load-extension");
  }
  const agentChromeReadyBlocked = await runCli([
    "agent-chrome", "ready",
    "--profile", "studio-demo",
    "--target", "demo",
    "--snapshot-json", JSON.stringify({
      url: "https://example.com/login",
      title: "Login | Example",
      text: "Oh Snap! Failed to verify the Captcha challenge. Your actions look like those of a bot.",
    }),
  ]);
  assert(agentChromeReadyBlocked.ok === false, "agent chrome ready should fail on anti-bot modal evidence");
  assert(agentChromeReadyBlocked.state === "blocked-by-anti-bot-modal", "agent chrome ready did not classify anti-bot modal");
  assert(agentChromeReadyBlocked.acceptance === "login-blocked-by-anti-bot", "agent chrome ready lost anti-bot acceptance result");
  const agentChromeReadyRouted = await runCli([
    "agent-chrome", "ready",
    "--profile", "studio-demo",
    "--target", "demo",
    "--snapshot-json", JSON.stringify({
      url: "https://example.com/login",
      title: "Login | Example",
      text: "Email Address Password",
    }),
  ]);
  assert(agentChromeReadyRouted.ok === true, "agent chrome ready should be ok when profile is routed and no blocker is visible");
  assert(agentChromeReadyRouted.state === "routed-needs-auth-verification", "agent chrome ready should not overclaim login success");
  const healthRaw = await runCli(["health"]);
  assert(healthRaw.ok === true, "health did not return raw health endpoint");
  assert(healthRaw.schema === undefined, "health should remain the raw worker health response");
  const portConfigPath = join(tempDir, "profile-port-config.json");
  writeFileSync(portConfigPath, JSON.stringify({
    browser: {
      profiles: {
        drifted: { cdpPort: 9229 },
        canonical: { cdpPort: 9222 },
      },
    },
  }, null, 2));
  const portStatus = await runCli(["profile", "ports", "status", "--config", portConfigPath]);
  assert(portStatus.ok === false, "profile ports status did not flag drift");
  assert(portStatus.mismatchedCount === 1, "profile ports status lost mismatch count");
  const portRepair = await runCli(["profile", "ports", "repair", "--config", portConfigPath, "--to", "9222"]);
  assert(portRepair.ok === true, "profile ports repair did not complete");
  assert(portRepair.changedCount === 1, "profile ports repair changed wrong number of profiles");
  const repairedConfig = JSON.parse(readFileSync(portConfigPath, "utf8"));
  assert(repairedConfig.browser.profiles.drifted.cdpPort === 9222, "profile ports repair did not rewrite drifted profile");
  const guide = await runCli(["guide"]);
  assert(guide.schema === "agent-browser.guide.v1", "guide returned wrong schema");
  assert(guide.guides.some((entry) => entry.mode === "basic"), "guide missing basic mode");
  assert(guide.guides.some((entry) => entry.mode === "pentest"), "guide missing pentest mode");
  assert(guide.guides.some((entry) => entry.mode === "personal"), "guide missing personal mode");
  assert(guide.entryPoints.preflight.includes("profile preflight"), "guide missing preflight entry point");
  assert(guide.terminology.mode.includes("usage scenario"), "guide did not explain mode terminology");
  assert(guide.browserBackends.managed.role === "primary", "guide did not mark managed backend as primary");
  assert(guide.browserBackends.personal.transport.includes("chrome.debugger"), "guide did not explain personal chrome.debugger transport");
  const capabilities = await runCli(["capabilities"]);
  assert(capabilities.schema === "agent-browser.capabilities.v1", "capabilities returned wrong schema");
  assert(capabilities.productModel.primaryBackend === "managed", "capabilities did not mark managed as primary");
  assert(capabilities.scenarios.some((entry) => entry.scenario === "basic" && entry.maturity === "usable-mainline"), "capabilities missing basic maturity");
  assert(capabilities.scenarios.some((entry) => entry.scenario === "pentest" && entry.maturity === "professional-mainline"), "capabilities missing pentest maturity");
  assert(capabilities.scenarios.some((entry) => entry.scenario === "personal" && entry.defaultBackend === "personal"), "capabilities missing personal backend");
  assert(capabilities.recommendedStart.some((entry) => entry.includes("ready pentest")), "capabilities missing ready start command");
  const basicLane = capabilities.scenarios.find((entry) => entry.scenario === "basic");
  const pentestLane = capabilities.scenarios.find((entry) => entry.scenario === "pentest");
  assert(basicLane.commands.some((entry) => entry.includes("agent-browser fill")), "capabilities basic lane missing fill command");
  assert(basicLane.commands.some((entry) => entry.includes("workflow diagnose")), "capabilities basic lane missing workflow diagnose command");
  assert(pentestLane.commands.some((entry) => entry.includes("requests diagnose")), "capabilities pentest lane missing requests diagnose command");
  assert(pentestLane.commands.some((entry) => entry.includes("profile registry diagnose")), "capabilities pentest lane missing registry diagnose command");
  assert(pentestLane.commands.some((entry) => entry.includes("profile two-account ready")), "capabilities pentest lane missing two-account ready command");
  assert(capabilities.agentUse.interaction.tools.includes("browser_type"), "capabilities agentUse missing browser_type route");
  assert(capabilities.agentUse.interaction.preferCli.some((entry) => entry.includes("action preflight")), "capabilities interaction lane missing action preflight");
  assert(capabilities.agentUse.diagnostics.pentest.some((entry) => entry.includes("repeater diagnose")), "capabilities agentUse missing repeater diagnose route");
  const pentestGuide = await runCli(["guide", "--mode", "pentest"]);
  assert(pentestGuide.guides.length === 1 && pentestGuide.guides[0].mode === "pentest", "guide --mode pentest did not filter");
  assert(pentestGuide.guides[0].defaultBackend === "managed", "pentest guide should default to managed backend");
  assert(pentestGuide.guides[0].flow.some((entry) => entry.includes("requests diagnose")), "pentest guide missing requests diagnose");
  assert(pentestGuide.guides[0].flow.some((entry) => entry.includes("profile two-account ready")), "pentest guide missing two-account ready");
  const basicGuide = await runCli(["guide", "--mode", "basic"]);
  assert(basicGuide.guides[0].flow.some((entry) => entry.includes("agent-browser fill")), "basic guide missing fill command");
  const personalGuide = await runCli(["guide", "--mode", "personal"]);
  assert(personalGuide.guides.length === 1 && personalGuide.guides[0].mode === "personal", "guide --mode personal did not filter");
  assert(personalGuide.guides[0].defaultBackend === "personal", "personal guide should default to personal backend");
  assert(personalGuide.guides[0].boundary.some((entry) => entry.includes("Do not clone cookies")), "personal guide did not expose cookie boundary");
  const basicReady = await runCli(["ready", "basic", "--profile", "researcher"]);
  assert(basicReady.schema === "agent-browser.ready.v1", "ready basic returned wrong schema");
  assert(basicReady.ok === false, "ready basic should expose login-form blocker in fixture");
  assert(basicReady.readySummary.blocking.includes("page-login-form"), "ready basic did not expose page-login-form blocker");
  assert(basicReady.readySummary.evidence.checkedProfilePreflight === true, "ready basic did not run profile preflight");
  assert(basicReady.readySummary.evidence.profilePreflightState === "not-ready", "ready basic did not bubble profile preflight state");
  assert(basicReady.readySummary.evidence.stuckState === "login-form", "ready basic did not bubble stuck state");
  assert(Array.isArray(basicReady.readySummary.evidence.stuckSignals), "ready basic did not expose stuck signals");
  assert(Object.prototype.hasOwnProperty.call(basicReady.readySummary.evidence, "registryState"), "ready basic did not expose registry state slot");
  const basicReadyNoStuck = await runCli(["ready", "basic", "--profile", "researcher", "--no-check-stuck"]);
  assert(basicReadyNoStuck.ok === true, `ready basic --no-check-stuck should pass fixture: ${JSON.stringify(basicReadyNoStuck.readySummary)}`);
  fixtureProfilePortSummary = {
    ok: false,
    state: "port-drift",
    canonicalCdpPort: 9222,
    totalProfiles: 2,
    mismatchedCount: 1,
    mismatchedProfiles: [{ profile: "drifted", cdpPort: 9229 }],
    ports: { "9222": 1, "9229": 1 },
    next: ["agent-browser profile ports repair --to 9222"],
  };
  const driftReady = await runCli(["ready", "basic", "--profile", "researcher", "--no-check-stuck"]);
  assert(driftReady.ok === false, "ready basic should block profile port drift");
  assert(driftReady.readySummary.blocking.includes("profile-port-drift"), "ready basic did not name profile-port-drift blocker");
  assert(driftReady.readySummary.evidence.profilePortSummary?.mismatchedCount === 1, "ready basic did not expose port drift evidence");
  fixtureProfilePortSummary = {
    ok: true,
    state: "canonical",
    canonicalCdpPort: 9222,
    totalProfiles: 1,
    mismatchedCount: 0,
    mismatchedProfiles: [],
    ports: { "9222": 1 },
  };
  const pentestReady = await runCli(["ready", "pentest", "--profile", "researcher"]);
  assert(pentestReady.defaultBackend === "managed", "ready pentest should use managed backend");
  assert(pentestReady.suggestedNext.some((entry) => entry.includes("repeater plan")), "ready pentest did not suggest repeater plan");
  const missingProfileReady = await runCli(["ready", "basic"]);
  assert(missingProfileReady.ok === false, "ready basic without profile should be not-ready");
  assert(missingProfileReady.readySummary.blocking.includes("profile-required"), "ready basic missing profile did not expose blocker");
  const personalReady = await runCli(["ready", "personal"]);
  assert(personalReady.ok === false, "ready personal should require personal bridge in managed fixture");
  assert(personalReady.readySummary.blocking.includes("personal-bridge-needed"), "ready personal did not expose bridge blocker");
  assert(personalReady.readySummary.evidence.personalBridgeState === "bridge-needed", "ready personal did not bubble personal bridge state");
  fixturePersonalOk = true;
  const connectedPersonalReady = await runCli(["ready", "personal"]);
  assert(connectedPersonalReady.ok === true, "ready personal should pass when backend reports the personal bridge connected");
  assert(connectedPersonalReady.readySummary.evidence.personalBridgeState === "connected", "ready personal did not bubble connected personal bridge state");
  fixturePersonalOk = false;

  await runCli(["profile", "list"]);
  await runCli(["profile", "resume", "researcher"]);
  await runCli(["open", "https://example.com", "--profile", "researcher"]);
  await runCli(["see", "snapshot", "--profile", "researcher"]);
  const screenshot = await runCli(["see", "screenshot", "--profile", "researcher"]);
  await runCli(["observe", "--profile", "researcher", "--limit", "20"]);
  await runCli(["click", "--text", "Sign in", "--profile", "researcher", "--wait-mode", "no-navigation"]);
  await runCli(["hover", "--text", "Account", "--profile", "researcher", "--action-timeout-ms", "1200"]);
  await runCli(["dblclick", "--selector", ".editable-row", "--profile", "researcher", "--wait-mode", "no-navigation"]);
  await runCli(["drag", "--selector", ".card", "--to-selector", ".done", "--profile", "researcher", "--action-timeout-ms", "1200"]);
  await runCli(["click", "--text", "Sign up", "--profile", "researcher", "--wait-mode", "no-navigation", "--force-js", "--action-timeout-ms", "1200"]);
  await runCli(["type", "hunter2", "--selector", "input[name=password]", "--profile", "researcher", "--press-enter", "--action-timeout-ms", "1200"]);
  const fillResult = await runCli(["fill", "hello@example.com", "--selector", "input[name=email]", "--profile", "researcher"]);
  assert(fillResult.schema === "agent-browser.fill.v1", "fill returned wrong schema");
  assert(fillResult.clear === true, "fill did not default to clear=true");
  assert(fillResult.fillSummary.evidence.usedBrowserType === true, "fill did not expose browser_type evidence");
  const fillByLabel = await runCli(["fill", "label@example.com", "--label", "Email", "--profile", "researcher"]);
  assert(fillByLabel.resolvedLocator?.selector === "input[name=email]", "fill --label did not resolve selector through browser_find");
  assert(fillByLabel.fillSummary.evidence.resolvedLocator?.source === "browser_find", "fill --label did not expose locator evidence");
  await runCli(["press", "Control+K", "--profile", "researcher", "--selector", "input[name=q]", "--action-timeout-ms", "1200"]);
  await runCli(["select", "--profile", "researcher", "--selector", "select[name=country]", "--value", "US"]);
  await runCli(["wait", "--profile", "researcher", "--selector", ".ready", "--state", "visible", "--timeout-ms", "1000"]);
  await runCli(["wait", "--profile", "researcher", "--request-url-contains", "graphql", "--request-method", "POST", "--request-status", "200", "--timeout-ms", "1000"]);
  await runCli(["click", "--text", "\"Sign up\"", "--profile", "researcher", "--wait-mode", "no-navigation"]);
  await runCli(["type", "hello@example.com", "--selector", "\"#username\"", "--profile", "researcher"]);
  await runCli(["wait", "--profile", "researcher", "--selector", "\"#username\"", "--state", "visible", "--timeout-ms", "1000"]);
  const scrollResult = await runCli(["scroll", "--profile", "researcher", "--direction", "down", "--amount", "300"]);
  await runCli(["form", "fill", "--profile", "researcher", "--fields-json", "{\"input[name=title]\":\"Hello\",\"textarea[name=body]\":\"World\"}"]);
  writeFileSync(workflowPath, JSON.stringify({
    profile: "researcher",
    steps: [
      { action: "open", url: "https://example.com/workflow" },
      { action: "hover", text: "Account" },
      { action: "dblclick", selector: ".editable-row", waitMode: "no-navigation" },
      { action: "drag", selector: ".card", targetSelector: ".done" },
      { action: "type", selector: "input[name=q]", text: "query" },
      { action: "fill", selector: "input[name=email]", text: "hello@example.com" },
      { action: "press", selector: "input[name=q]", key: "Enter" },
      { action: "select", selector: "input[name=confirm]", checked: true },
      { action: "wait", selector: ".done", state: "visible" },
      { action: "screenshot" },
    ],
  }), "utf8");
  const workflowRun = await runCli(["workflow", "run", "--file", workflowPath]);
  const workflowRunWithPreflight = await runCli(
    ["workflow", "run", "--file", workflowPath, "--preflight", "--owner", "workflow-agent", "--acquire-lease", "--ttl-seconds", "60"],
    { CDP_SECURITY_DATA_DIR: join(tempDir, "workflow-preflight") },
  );
  assert(workflowRunWithPreflight.preflight?.preflightSummary?.state === "ready", "workflow run preflight did not pass ready profile");
  assert(workflowRunWithPreflight.preflight?.preflightSummary?.evidence?.checkedLeaseAcquire === true, "workflow run preflight did not acquire/check lease");
  assert(workflowRunWithPreflight.completedCount === 10, "workflow run with preflight did not complete expected steps");
  const failedWorkflowPath = join(tempDir, "failed-workflow.json");
  writeFileSync(failedWorkflowPath, JSON.stringify({
    profile: "researcher",
    steps: [
      { action: "open", url: "https://example.com/workflow" },
      { action: "click", text: "Broken", expectRequestUrlContains: "graphql" },
      { action: "screenshot" },
    ],
  }), "utf8");
  const failedWorkflow = await runCli(["workflow", "run", "--file", failedWorkflowPath]);
  assert(failedWorkflow.schema === "agent-browser.workflow.run.v1", "failed workflow returned wrong schema");
  assert(failedWorkflow.ok === false && failedWorkflow.state === "failed", "failed workflow did not return structured failed state");
  assert(failedWorkflow.completedCount === 2, "failed workflow did not retain completed step count");
  assert(failedWorkflow.failedStep?.index === 1, "failed workflow did not expose failed step index");
  assert(failedWorkflow.failedStep?.recovery?.kind === "browser-action-diagnose", "failed workflow did not expose action recovery");
  assert(failedWorkflow.failedStep.recovery.command.includes("action diagnose click"), "failed workflow recovery did not route to action diagnose");
  assert(failedWorkflow.workflowSummary.nextCommands.some((entry) => entry.includes("agent-browser stuck")), "failed workflow did not expose stuck next command");
  assert(failedWorkflow.workflowSummary.nextCommands.some((entry) => entry.includes("evidence bundle")), "failed workflow did not suggest evidence bundle");
  assert(failedWorkflow.failureEvidence?.collected === false, "failed workflow should not auto collect evidence without opt-in");
  const failedWorkflowWithEvidence = await runCli(["workflow", "run", "--file", failedWorkflowPath, "--evidence-on-failure"]);
  assert(failedWorkflowWithEvidence.ok === false, "failed workflow with evidence should still preserve failed state");
  assert(failedWorkflowWithEvidence.failureEvidence?.collected === true, "failed workflow did not collect evidence with opt-in");
  assert(failedWorkflowWithEvidence.failureEvidence.bundle?.schema === "agent-browser.evidence.bundle.v1", "failed workflow evidence did not include bundle");
  assert(failedWorkflowWithEvidence.workflowSummary.evidence.failureEvidenceCollected === true, "failed workflow summary did not mark evidence collected");
  await runCli(["capture", "start", "--profile", "researcher", "--label", "run-1"]);
  await runCli(["upload", "--profile", "researcher", "--selector", "input[type=file]", "--file", "C:\\tmp\\image.png"]);
  await runCli(["inspect", "network", "--profile", "researcher", "--limit", "5"]);
  const inspectSecurity = await runCli(["inspect", "security", "--profile", "researcher"]);
  const securitySummary = await runCli(["security", "summary", "--profile", "researcher"]);
  const evidenceBundle = await runCli(["evidence", "bundle", "--profile", "researcher", "--include-har"]);
  assert(evidenceBundle.schema === "agent-browser.evidence.bundle.v1", "evidence bundle returned wrong schema");
  assert(evidenceBundle.summary.screenshotPath, "evidence bundle did not expose screenshot path");
  assert(evidenceBundle.bundlePath, "evidence bundle did not expose bundle path");
  await runCli(["pack", "https://example.com", "--profile", "researcher", "--no-trace"]);
  await runCli(["network", "summary", "--profile", "researcher"]);
  const requestList = await runCli(["requests", "--profile", "researcher", "--url-contains", "graphql", "--method", "POST", "--has-request-body", "true"]);
  const wrappedRequestList = await runCli(["requests", "--profile", "wrapped-raw", "--url-contains", "graphql", "--method", "POST", "--has-request-body", "true"]);
  await runCli(["request", "detail", "req-1", "--profile", "researcher"]);
  await runCli(["request", "payload", "req-1", "--profile", "researcher"]);
  await runCli(["request", "body", "req-1", "--profile", "researcher"]);
  const requestDiagnoseReady = await runCli(["request", "diagnose", "req-1", "--profile", "researcher"]);
  assert(requestDiagnoseReady.schema === "agent-browser.request.diagnose.v1", "request diagnose returned wrong schema");
  assert(requestDiagnoseReady.state === "ready-for-repeater", "request diagnose did not mark durable request id ready");
  assert(requestDiagnoseReady.requestSummary.durableNetworkRequestFound === true, "request diagnose did not confirm durable request");
  assert(requestDiagnoseReady.nextCommands.some((entry) => entry.includes("repeater open req-1")), "request diagnose did not suggest Repeater open");
  const requestDiagnoseCaptured = await runCli(["request", "diagnose", "fetch-intercept-1", "--profile", "researcher"]);
  assert(requestDiagnoseCaptured.ok === false, "request diagnose should not accept transient captured id as durable request");
  assert(requestDiagnoseCaptured.state === "likely-captured-request-id", "request diagnose did not classify captured request id");
  assert(requestDiagnoseCaptured.blockers.includes("likely-transient-captured-request-id"), "request diagnose did not name transient id blocker");
  assert(requestDiagnoseCaptured.idBoundary.doNotMix === true, "request diagnose did not expose id boundary");
  assert(requestDiagnoseCaptured.nextCommands.some((entry) => entry.includes("intercept diagnose fetch-intercept-1")), "request diagnose did not route captured id to intercept diagnose");
  const graphqlRequests = await runCli(["graphql", "requests", "--profile", "researcher", "--url-contains", "graphql"]);
  const graphqlPayload = await runCli(["graphql", "payload", "req-1", "--profile", "researcher"]);
  const graphqlReplayResult = await runCli(["graphql", "replay", "req-1", "--profile", "researcher", "--variables-json", "{\"role\":\"admin\"}"]);
  const graphqlInterceptPlan = await runCli(["graphql", "intercept-plan", "req-1", "--profile", "researcher", "--variables-json", "{\"role\":\"admin\"}"]);
  const apiMap = await runCli(["api", "map", "--profile", "researcher"]);
  const requestReplayResult = await runCli(["request", "replay", "req-1", "--profile", "researcher", "--method", "POST", "--json-body", "{\"role\":\"admin\"}"]);
  const requestReplayBatchResult = await runCli(["request", "replay-batch", "req-1", "--profile", "researcher", "--variants-json", "[{\"label\":\"baseline\"},{\"label\":\"admin\",\"json\":{\"role\":\"admin\"}}]"]);
  const requestDiagnose = await runCli(["requests", "diagnose", "--profile", "researcher", "--url-contains", "graphql", "--method", "POST", "--has-request-body", "true"]);
  assert(requestDiagnose.schema === "agent-browser.requests.diagnose.v1", "requests diagnose returned wrong schema");
  assert(requestDiagnose.state === "requests-found", "requests diagnose did not classify matching request");
  assert(requestDiagnose.requestSummary.firstRequestId === "req-1", "requests diagnose did not expose first request id");
  assert(requestDiagnose.nextCommands.some((entry) => entry.includes("repeater open req-1")), "requests diagnose did not suggest repeater open");
  const requestDiagnoseEmpty = await runCli(["requests", "diagnose", "--profile", "researcher", "--url-contains", "nomatch"]);
  assert(requestDiagnoseEmpty.ok === false, "requests diagnose should not be ok for no matching requests");
  assert(requestDiagnoseEmpty.blockers.includes("no-matching-requests"), "requests diagnose did not expose no-match blocker");
  assert(requestDiagnoseEmpty.nextCommands.some((entry) => entry.includes("capture start")), "requests diagnose did not suggest capture start");
  const interceptDiagnose = await runCli(["intercept", "diagnose", "fetch-intercept-1", "--profile", "researcher"]);
  assert(interceptDiagnose.schema === "agent-browser.intercept.diagnose.v1", "intercept diagnose returned wrong schema");
  assert(interceptDiagnose.state === "ready-to-continue", "intercept diagnose did not classify paused request as ready");
  assert(interceptDiagnose.idBoundary.doNotMix === true, "intercept diagnose did not expose id boundary");
  assert(interceptDiagnose.nextCommands.some((entry) => entry.includes("intercept continue fetch-intercept-1")), "intercept diagnose did not suggest continue command");
  await runCli(["replay", "req-1", "--profile", "researcher", "--method", "POST", "--headers-json", "{\"content-type\":\"application/json\"}", "--json-body", "{\"role\":\"admin\"}"]);
  await runCli(["replay-batch", "req-1", "--profile", "researcher", "--variants-json", "[{\"label\":\"baseline\"},{\"label\":\"role-change\",\"json\":{\"role\":\"admin\"}}]"]);
  const repeaterEnv = { CDP_SECURITY_DATA_DIR: join(tempDir, "repeater-test") };
  const repeaterPlan = await runCli(["repeater", "plan", "req-1", "--profile", "researcher"], repeaterEnv);
  assert(repeaterPlan.schema === "agent-browser.repeater.plan.v1", "repeater plan returned wrong schema");
  assert(repeaterPlan.workflow.some((entry) => entry.step === "open-repeater-session"), "repeater plan missing open step");
  assert(repeaterPlan.next.open.includes("repeater open req-1"), "repeater plan missing open next command");
  const repeaterOpen = await runCli(["repeater", "open", "req-1", "--profile", "researcher"], repeaterEnv);
  assert(repeaterOpen.schema === "agent-browser.repeater.open.v1", "repeater open returned wrong schema");
  assert(repeaterOpen.sessionId, "repeater open did not return sessionId");
  assert(repeaterOpen.replayHeaderPolicy.sanitized === true, "repeater open did not mark sanitized browser-controlled headers");
  assert(repeaterOpen.replayHeaderPolicy.removedBrowserControlledHeaders.includes("content-length"), "repeater open did not remove content-length");
  assert(repeaterOpen.replayHeaderPolicy.removedBrowserControlledHeaders.includes("cookie"), "repeater open did not remove cookie");
  assert(repeaterOpen.replayHeaderPolicy.removedBrowserControlledHeaders.includes("sec-ch-ua"), "repeater open did not remove sec-ch-ua");
  assert(repeaterOpen.editable.headers.cookie === undefined, "repeater open left cookie in editable template");
  const repeaterEditUser = await runCli(["repeater", "edit", repeaterOpen.sessionId, "--json-body", "{\"role\":\"user\"}"], repeaterEnv);
  assert(repeaterEditUser.editable.json.role === "user", "repeater edit did not store JSON body");
  const repeaterSendUser = await runCli(["repeater", "send", repeaterOpen.sessionId], repeaterEnv);
  assert(repeaterSendUser.send.status === 200, "repeater send baseline status mismatch");
  assert(repeaterSendUser.replayHeaderPolicy.removedBrowserControlledHeaders.includes("cookie"), "repeater send did not preserve header policy");
  assert(repeaterSendUser.comparisonToPrevious === null, "first repeater send should not compare to previous send");
  assert(repeaterSendUser.repeaterSummary.state === "baseline-sent", "repeater summary did not classify baseline send");
  assert(repeaterSendUser.repeaterSummary.sendCount === 1, "repeater summary did not count first send");
  assert(repeaterSendUser.repeaterSummary.evidenceCommands.some((entry) => entry.includes("bookmark req-1")), "repeater summary did not expose bookmark evidence command");
  assert(repeaterSendUser.repeaterSummary.evidenceCommands.some((entry) => entry.includes("--format json")), "repeater summary did not expose export evidence command");
  const repeaterDiagnoseBaseline = await runCli(["repeater", "diagnose", repeaterOpen.sessionId], repeaterEnv);
  assert(repeaterDiagnoseBaseline.schema === "agent-browser.repeater.diagnose.v1", "repeater diagnose returned wrong schema");
  assert(repeaterDiagnoseBaseline.state === "needs-variant-send", "repeater diagnose did not request variant after baseline");
  assert(repeaterDiagnoseBaseline.blockers.includes("no-variant-send-recorded"), "repeater diagnose did not name missing variant blocker");
  await runCli(["repeater", "edit", repeaterOpen.sessionId, "--json-body", "{\"role\":\"admin\"}"], repeaterEnv);
  const repeaterSendAdmin = await runCli(["repeater", "send", repeaterOpen.sessionId], repeaterEnv);
  assert(repeaterSendAdmin.send.status === 403, "repeater send variant status mismatch");
  assert(repeaterSendAdmin.comparisonToPrevious.diff.statusCode.changed === true, "repeater send did not compare against previous send");
  assert(repeaterSendAdmin.repeaterSummary.state === "variant-tested", "repeater summary did not classify variant send");
  assert(repeaterSendAdmin.repeaterSummary.statusChangedFromPrevious === true, "repeater summary did not expose status change");
  assert(typeof repeaterSendAdmin.boundary === "string", "repeater send did not expose objective boundary");
  const repeaterList = await runCli(["repeater", "list", "--profile", "researcher"], repeaterEnv);
  assert(repeaterList.schema === "agent-browser.repeater.list.v1", "repeater list returned wrong schema");
  assert(repeaterList.sessions.some((entry) => entry.sessionId === repeaterOpen.sessionId), "repeater list did not include open session");
  assert(repeaterList.sessions[0].next.history.includes("agent-browser repeater history"), "repeater list did not include next commands");
  const repeaterHistory = await runCli(["repeater", "history", repeaterOpen.sessionId], repeaterEnv);
  assert(repeaterHistory.sends.length === 2, "repeater history did not keep both sends");
  assert(repeaterHistory.repeaterSummary.latestStatus === 403, "repeater history summary did not expose latest status");
  assert(repeaterHistory.repeaterSummary.evidenceCommands.some((entry) => entry.includes("repeater diff")), "repeater history summary did not expose diff evidence command");
  const repeaterDiff = await runCli(["repeater", "diff", repeaterOpen.sessionId], repeaterEnv);
  assert(repeaterDiff.diff.statusCode.changed === true, "repeater diff did not compare last two sends");
  assert(repeaterDiff.repeaterSummary.statusChangedFromPrevious === true, "repeater diff summary did not expose status change");
  const repeaterDiagnoseReady = await runCli(["repeater", "diagnose", repeaterOpen.sessionId], repeaterEnv);
  assert(repeaterDiagnoseReady.state === "ready-for-evidence", "repeater diagnose did not mark two-send session ready for evidence");
  assert(repeaterDiagnoseReady.observedDifferences.statusChanged === true, "repeater diagnose did not expose status difference");
  assert(repeaterDiagnoseReady.nextCommands.some((entry) => entry.includes("repeater evidence")), "repeater diagnose did not suggest evidence handoff");
  const repeaterEvidence = await runCli(["repeater", "evidence", repeaterOpen.sessionId], repeaterEnv);
  assert(repeaterEvidence.schema === "agent-browser.repeater.evidence.v1", "repeater evidence returned wrong schema");
  assert(repeaterEvidence.baseline.status === 200 && repeaterEvidence.latest.status === 403, "repeater evidence did not expose baseline/latest statuses");
  assert(repeaterEvidence.comparisonToBaseline.diff.statusCode.changed === true, "repeater evidence did not compare latest to baseline");
  assert(repeaterEvidence.replayHeaderPolicy.removedBrowserControlledHeaders.includes("content-length"), "repeater evidence did not include header policy");
  assert(repeaterEvidence.evidenceCommands.some((entry) => entry.includes("bookmark req-1")), "repeater evidence missing bookmark command");
  const repeaterEvidencePath = join(tempDir, "repeater-evidence.json");
  const savedRepeaterEvidence = await runCli(["repeater", "evidence", repeaterOpen.sessionId, "--out", repeaterEvidencePath], repeaterEnv);
  assert(savedRepeaterEvidence.outputPath === repeaterEvidencePath, "repeater evidence did not report output path");
  const savedRepeaterEvidenceFile = JSON.parse(readFileSync(repeaterEvidencePath, "utf8"));
  assert(savedRepeaterEvidenceFile.schema === "agent-browser.repeater.evidence.v1", "saved repeater evidence returned wrong schema");
  assert(savedRepeaterEvidenceFile.latest.status === 403, "saved repeater evidence lost latest status");
  const repeaterHandoffPath = join(tempDir, "repeater-handoff.json");
  const repeaterExportDir = join(tempDir, "repeater-handoff-export");
  const repeaterHandoff = await runCli(["repeater", "handoff", repeaterOpen.sessionId, "--bookmark", "--tag", "handoff", "--export-dir", repeaterExportDir, "--out", repeaterHandoffPath], repeaterEnv);
  assert(repeaterHandoff.schema === "agent-browser.repeater.handoff.v1", "repeater handoff returned wrong schema");
  assert(repeaterHandoff.state === "ready-for-review", "repeater handoff did not classify two-send session as ready");
  assert(repeaterHandoff.handoffSummary.bookmarkWritten === true, "repeater handoff did not write bookmark when requested");
  assert(repeaterHandoff.handoffSummary.requestExportWritten === true, "repeater handoff did not write request export when requested");
  assert(repeaterHandoff.nextCommands.some((entry) => entry.includes("evidence bundle")), "repeater handoff did not suggest evidence bundle");
  const savedRepeaterHandoffFile = JSON.parse(readFileSync(repeaterHandoffPath, "utf8"));
  assert(savedRepeaterHandoffFile.schema === "agent-browser.repeater.handoff.v1", "saved repeater handoff returned wrong schema");
  assert(savedRepeaterHandoffFile.evidence.latest.status === 403, "saved repeater handoff lost latest evidence");
  await runCli(["repeater", "close", repeaterOpen.sessionId], repeaterEnv);
  const hiddenClosedRepeater = await runCli(["repeater", "list", "--profile", "researcher"], repeaterEnv);
  assert(!hiddenClosedRepeater.sessions.some((entry) => entry.sessionId === repeaterOpen.sessionId), "repeater list did not hide closed session by default");
  const listedClosedRepeater = await runCli(["repeater", "list", "--profile", "researcher", "--include-closed"], repeaterEnv);
  assert(listedClosedRepeater.sessions.some((entry) => entry.sessionId === repeaterOpen.sessionId && entry.closedAt), "repeater list did not include closed session when requested");
  const bookmark = await runCli(["bookmark", "req-1", "--profile", "researcher", "--tag", "idor", "--note", "baseline request"], repeaterEnv);
  assert(bookmark.schema === "agent-browser.bookmark.v1", "bookmark returned wrong schema");
  assert(bookmark.bookmark.tag === "idor", "bookmark lost tag");
  const bookmarks = await runCli(["bookmarks", "list", "--profile", "researcher", "--tag", "idor"], repeaterEnv);
  assert(bookmarks.count === 1, "bookmarks list did not return saved bookmark");
  const curlExport = await runCli(["export", "req-1", "--profile", "researcher", "--format", "curl"], repeaterEnv);
  assert(curlExport.schema === "agent-browser.export.v1", "export returned wrong schema");
  assert(curlExport.content.includes("curl") && curlExport.content.includes("https://example.com/graphql"), "curl export missing command/url");
  const rawExport = await runCli(["export", "req-1", "--profile", "researcher", "--format", "raw"], repeaterEnv);
  assert(rawExport.content.startsWith("POST /graphql HTTP/1.1"), "raw export missing request line");
  const jsonExportPath = join(tempDir, "request-export.json");
  await runCli(["export", "req-1", "--profile", "researcher", "--format", "json", "--out", jsonExportPath], repeaterEnv);
  const importedRepeater = await runCli(["import", "--file", jsonExportPath, "--format", "json", "--profile", "researcher"], repeaterEnv);
  assert(importedRepeater.schema === "agent-browser.import.v1", "import returned wrong schema");
  assert(importedRepeater.requestId === "req-1", "import did not preserve source request id");
  assert(importedRepeater.editable.url === "https://example.com/graphql", "import did not restore editable request template");
  const rawImportPath = join(tempDir, "request-export.http");
  await runCli(["export", "req-1", "--profile", "researcher", "--format", "raw", "--out", rawImportPath], repeaterEnv);
  const importedRawRepeater = await runCli(["import", "--file", rawImportPath, "--format", "raw", "--profile", "researcher", "--request-id", "req-1"], repeaterEnv);
  assert(importedRawRepeater.editable.method === "POST", "raw import did not parse request method");
  const deletedBookmark = await runCli(["bookmarks", "delete", bookmark.bookmark.bookmarkId], repeaterEnv);
  assert(deletedBookmark.deleted === true, "bookmarks delete did not delete saved bookmark");
  const interceptStarted = await runCli(["intercept", "start", "--profile", "researcher", "--url-pattern", "graphql"]);
  assert(interceptStarted.schema === "agent-browser.intercept.start.v1", "intercept start did not return stable schema");
  assert(interceptStarted.nextCommands.some((entry) => entry.includes("intercept list")), "intercept start missing list next command");
  const interceptListed = await runCli(["intercept", "list", "--profile", "researcher"]);
  assert(interceptListed.schema === "agent-browser.intercept.list.v1", "intercept list did not return stable schema");
  assert(interceptListed.pausedCount === 1, "intercept list did not summarize paused requests");
  assert(interceptListed.requests[0].next.continueJson.includes("fetch-intercept-1"), "intercept list missing continueJson command");
  const interceptEvidencePath = join(tempDir, "intercept-evidence.json");
  const interceptEvidence = await runCli(["intercept", "evidence", "fetch-intercept-1", "--profile", "researcher", "--out", interceptEvidencePath]);
  assert(interceptEvidence.schema === "agent-browser.intercept.evidence.v1", "intercept evidence did not return stable schema");
  assert(interceptEvidence.selected.capturedRequestId === "fetch-intercept-1", "intercept evidence did not select requested paused request");
  assert(interceptEvidence.idBoundary.doNotMix === true, "intercept evidence did not explain id boundary");
  assert(interceptEvidence.workflow.some((entry) => entry.step === "open-repeater-after-network-id-is-known"), "intercept evidence missing repeater handoff step");
  const savedInterceptEvidence = JSON.parse(readFileSync(interceptEvidencePath, "utf8"));
  assert(savedInterceptEvidence.schema === "agent-browser.intercept.evidence.v1", "saved intercept evidence had wrong schema");
  const interceptContinued = await runCli(["intercept", "continue", "fetch-intercept-1", "--profile", "researcher", "--headers-json", "{\"x-test\":\"1\"}", "--remove-header", "content-length", "--json-body", "{\"role\":\"admin\"}"]);
  assert(interceptContinued.schema === "agent-browser.intercept.continue.v1", "intercept continue did not return stable schema");
  assert(interceptContinued.interceptSummary.modifiedBody === true, "intercept continue did not summarize body modification");
  assert(interceptContinued.postForwardCorrelation.state === "needs-network-request-id", "intercept continue did not expose post-forward correlation state");
  assert(interceptContinued.postForwardCorrelation.idBoundary.doNotMix === true, "intercept continue did not preserve id boundary");
  assert(interceptContinued.postForwardCorrelation.lookup.urlContains === "graphql", "intercept continue did not derive lookup fragment");
  assert(interceptContinued.postForwardCorrelation.nextCommands.some((entry) => entry.includes("agent-browser requests") && entry.includes("graphql")), "intercept continue did not expose request lookup command");
  assert(interceptContinued.postForwardCorrelation.nextCommands.some((entry) => entry.includes("repeater open <requestId>")), "intercept continue did not expose Repeater handoff command");
  assert(interceptContinued.postForwardCorrelation.nextCommands.some((entry) => entry.includes("intercept handoff")), "intercept continue did not expose handoff command");
  const interceptHandoff = await runCli(["intercept", "handoff", "fetch-intercept-1", "--profile", "researcher", "--url-contains", "graphql"]);
  assert(interceptHandoff.schema === "agent-browser.intercept.handoff.v1", "intercept handoff returned wrong schema");
  assert(interceptHandoff.state === "ready-for-repeater", "intercept handoff did not mark durable request ready for Repeater");
  assert(interceptHandoff.selectedRequestId === "req-1", "intercept handoff did not select durable network request id");
  assert(interceptHandoff.idBoundary.doNotMix === true, "intercept handoff did not preserve id boundary");
  assert(interceptHandoff.nextCommands.some((entry) => entry.includes("repeater open req-1")), "intercept handoff did not suggest Repeater open");
  const interceptHandoffOpen = await runCli(["intercept", "handoff", "fetch-intercept-1", "--profile", "researcher", "--url-contains", "graphql", "--open-repeater"], repeaterEnv);
  assert(interceptHandoffOpen.state === "repeater-opened", "intercept handoff --open-repeater did not open a Repeater session");
  assert(interceptHandoffOpen.openedRepeater?.schema === "agent-browser.repeater.open.v1", "intercept handoff did not return opened Repeater");
  const interceptFailed = await runCli(["intercept", "fail", "fetch-intercept-2", "--profile", "researcher", "--error-reason", "BlockedByClient"]);
  assert(interceptFailed.schema === "agent-browser.intercept.fail.v1", "intercept fail did not return stable schema");
  await runCli(["artifact", "read", "tmp/security-research-pack.json", "--start-line", "2", "--max-lines", "3"]);
  await runCli(["feedback", "browser click waited for a non-navigation SPA action", "--type", "tool-bug"]);
  await runCli(["raw", "profile_traffic_summary", "--json", "{\"profile\":\"researcher\",\"limit\":2}"]);
  const failedClick = await runCliFailure(["click", "--text", "Broken", "--profile", "researcher", "--expect-request-url-contains", "graphql"]);
  assert(failedClick.json?.schema === "agent-browser.error.v1", "failed click did not return structured CLI error");
  assert(failedClick.json.error.recovery?.kind === "browser-action-diagnose", "failed click did not expose action diagnose recovery");
  assert(failedClick.json.error.recovery.command.includes("action diagnose click"), "failed click recovery did not route to action diagnose");
  assert(failedClick.json.error.recovery.command.includes("--text \"Broken\""), "failed click recovery did not preserve click text");
  assert(failedClick.json.error.next.some((entry) => entry.includes("agent-browser stuck")), "failed click recovery did not include stuck fallback");
  const rawGuard = await runCliFailure(["call", "browser_raw", "--json", "{\"toolName\":\"profile_traffic_query\",\"params\":{\"profile\":\"researcher\"}}"]);
  assert(rawGuard.json?.schema === "agent-browser.error.v1", "raw guard did not return structured CLI error");
  assert(rawGuard.json.error.code === "input_unsupported_raw_tool", "raw guard did not classify browser_raw restriction");
  assert(rawGuard.json.error.suggestion.includes("agent-browser raw"), "raw guard did not include next action");
  const forbiddenHeaderReplay = await runCliFailure(["replay", "req-1", "--profile", "researcher", "--headers-json", "{\"content-length\":\"999\"}"]);
  assert(forbiddenHeaderReplay.json?.error?.code === "replay_forbidden_header", "replay forbidden header was not classified");
  assert(forbiddenHeaderReplay.json.error.next.some((entry) => entry.includes("intercept start")), "replay forbidden header did not suggest intercept");
  assert(forbiddenHeaderReplay.json.error.boundary.includes("Browser-controlled headers"), "replay forbidden header did not explain boundary");

  const missingArg = await runCliFailure(["profile", "isolation", "check", "--profiles", "attacker"]);
  assert(missingArg.json?.error?.code === "input_invalid_arguments", "missing argument did not return input_invalid_arguments");
  const isolationLeaseEnv = { CDP_SECURITY_DATA_DIR: join(tempDir, "isolation-lease-conflict") };
  await runCli(["profile", "lease", "acquire", "--profile", "victim", "--owner", "agent-a", "--ttl-seconds", "60"], isolationLeaseEnv);
  const beforeIsolationLeaseGuardRequests = requests.length;
  const isolationLeaseConflict = await runCliFailure(["profile", "isolation", "check", "--profiles", "researcher,victim", "--owner", "agent-b", "--url", "https://example.com"], isolationLeaseEnv);
  assert(isolationLeaseConflict.json?.error?.code === "profile_lease_conflict", "profile isolation check did not fail with structured profile lease conflict");
  assert(isolationLeaseConflict.json?.error?.details?.command === "profile isolation check", "profile isolation lease guard did not preserve command");
  assert(isolationLeaseConflict.json?.error?.details?.profile === "victim", "profile isolation lease guard did not identify conflicting profile");
  assert(requests.length === beforeIsolationLeaseGuardRequests, "lease-guarded profile isolation check should not reach the worker");

  // download — nonexistent dir returns immediately with ok: false
  const downloadMissingDir = await runCli(["download", "--profile", "researcher", "--dir", join(tempDir, "no-such-downloads"), "--timeout-ms", "1000"]);
  assert(downloadMissingDir.ok === false, "download with missing dir did not return ok: false");
  assert(downloadMissingDir.schema === "agent-browser.download.v1", "download missing schema");
  assert(downloadMissingDir.state === "missing-dir", "download missing-dir state not returned");
  assert(typeof downloadMissingDir.boundary === "string", "download missing boundary field");
  const downloadDoctorMissing = await runCli(["download", "doctor", "--profile", "researcher", "--dir", join(tempDir, "no-such-downloads")]);
  assert(downloadDoctorMissing.schema === "agent-browser.download.doctor.v1", "download doctor returned wrong schema");
  assert(downloadDoctorMissing.ok === false, "download doctor missing dir did not return ok: false");
  assert(downloadDoctorMissing.state === "missing-dir", "download doctor missing dir did not surface missing-dir state");
  assert(downloadDoctorMissing.downloadSummary.state === "missing-dir", "download doctor summary did not classify missing dir");
  assert(downloadDoctorMissing.downloadSummary.evidence.hasDirectoryCheck === true, "download doctor summary did not expose directory evidence");

  // download — detects a newly completed file in the watched directory
  const downloadDir = join(tempDir, "downloads");
  mkdirSync(downloadDir, { recursive: true });
  const downloadDoctorReady = await runCli(["download", "doctor", "--profile", "researcher", "--dir", downloadDir]);
  assert(downloadDoctorReady.ok === true, "download doctor did not accept ready directory");
  assert(downloadDoctorReady.state === "ready", "download doctor ready dir did not return ready state");
  assert(downloadDoctorReady.downloadSummary.nextCommands.some((entry) => entry.includes("download start")), "download doctor summary did not suggest event watcher");
  const downloadPreflightReady = await runCli(["profile", "preflight", "researcher", "--download-dir", downloadDir], { CDP_SECURITY_DATA_DIR: join(tempDir, "download-preflight-ready") });
  assert(downloadPreflightReady.ok === true, "profile preflight did not accept ready download directory");
  assert(downloadPreflightReady.checks.download.downloadSummary.state === "ready", "profile preflight did not include ready download summary");
  assert(downloadPreflightReady.preflightSummary.evidence.checkedDownload === true, "profile preflight evidence did not mark download check");
  setTimeout(() => writeFileSync(join(downloadDir, "report.csv"), "id,value\n1,ok\n", "utf8"), 1200);
  const downloadFound = await runCli(["download", "--profile", "researcher", "--dir", downloadDir, "--timeout-ms", "6000"]);
  assert(downloadFound.ok === true, "download did not detect new file");
  assert(downloadFound.state === "completed", "download did not return completed state");
  assert(downloadFound.files.some((file) => file.endsWith("report.csv")), "download did not return created file");
  assert(Array.isArray(downloadFound.recentFiles), "download completed result missing recentFiles");
  assert(downloadFound.downloadSummary.state === "completed", "download summary did not classify completed download");
  assert(downloadFound.downloadSummary.completedCount === 1, "download summary did not expose completed count");
  const incompleteDownloadDir = join(tempDir, "downloads-incomplete");
  mkdirSync(incompleteDownloadDir, { recursive: true });
  writeFileSync(join(incompleteDownloadDir, "report.csv.crdownload"), "partial", "utf8");
  const downloadDoctorInProgress = await runCli(["download", "doctor", "--profile", "researcher", "--dir", incompleteDownloadDir]);
  assert(downloadDoctorInProgress.ok === true, "download doctor should accept usable directory with active temp file");
  assert(downloadDoctorInProgress.state === "in-progress", "download doctor did not surface active temp file state");
  assert(downloadDoctorInProgress.incompleteFiles.some((file) => file.name.endsWith(".crdownload")), "download doctor did not return incomplete file details");
  const downloadPreflightInProgress = await runCli(["profile", "preflight", "researcher", "--download-dir", incompleteDownloadDir], { CDP_SECURITY_DATA_DIR: join(tempDir, "download-preflight-in-progress") });
  assert(downloadPreflightInProgress.ok === false, "profile preflight did not block in-progress download directory");
  assert(downloadPreflightInProgress.preflightSummary.blocking.includes("download-in-progress"), "profile preflight did not name download in-progress blocker");
  const incompleteDownload = await runCli(["download", "--profile", "researcher", "--dir", incompleteDownloadDir, "--timeout-ms", "1000"]);
  assert(incompleteDownload.ok === false, "download incomplete result should not be ok");
  assert(incompleteDownload.state === "in-progress", "download did not report in-progress state for incomplete file");
  assert(incompleteDownload.incompleteFiles.some((file) => file.name.endsWith(".crdownload")), "download did not return incomplete file details");
  assert(incompleteDownload.downloadSummary.incompleteCount === 1, "download summary did not expose incomplete count");
  const downloadWatchStart = await runCli(["download", "start", "--profile", "researcher", "--dir", downloadDir]);
  assert(downloadWatchStart.schema === "agent-browser.download.watch.v1", "download start returned wrong schema");
  assert(downloadWatchStart.action === "start", "download start lost action");
  assert(downloadWatchStart.downloadSummary.state === "watching", "download start summary did not mark watching");
  const downloadWatchStatus = await runCli(["download", "status", "--profile", "researcher"]);
  assert(downloadWatchStatus.schema === "agent-browser.download.watch.v1", "download status returned wrong schema");
  assert(downloadWatchStatus.action === "status", "download status lost action");
  assert(downloadWatchStatus.downloadSummary.state === "completed", "download status summary did not surface completed event");
  assert(downloadWatchStatus.downloadSummary.evidence.hasCdpDownloadEvents === true, "download status summary did not expose CDP event evidence");
  const downloadDiagnose = await runCli(["download", "diagnose", "--profile", "researcher", "--dir", downloadDir]);
  assert(downloadDiagnose.schema === "agent-browser.download.diagnose.v1", "download diagnose returned wrong schema");
  assert(downloadDiagnose.state === "completed", "download diagnose did not combine completed watch status");
  assert(downloadDiagnose.checks.doctor.downloadSummary.state === "ready", "download diagnose did not include directory doctor summary");
  assert(downloadDiagnose.checks.watchStatus.downloadSummary.state === "completed", "download diagnose did not include watch status summary");
  assert(downloadDiagnose.downloadSummary.evidence.checkedDirectory === true, "download diagnose did not mark directory evidence");
  assert(downloadDiagnose.downloadSummary.evidence.checkedCdpWatchStatus === true, "download diagnose did not mark watch evidence");
  const downloadWatchReq = requests.find((entry) => entry.tool === "browser_download_watch" && entry.payload.action === "start");
  assert(downloadWatchReq !== undefined, "download start did not call browser_download_watch");

  // auth bootstrap — start opens worker-managed auth bootstrap state
  const authHandoff = await runCli(["auth", "bootstrap", "--profile", "researcher", "--url", "https://example.com/login"]);
  assert(authHandoff.schema === "agent-browser.auth.bootstrap.v1", "auth bootstrap returned wrong schema");
  assert(authHandoff.action === "start", "auth bootstrap did not infer start action from URL");
  assert(authHandoff.authComplete === false, "auth bootstrap without condition should not claim authComplete");
  assert(authHandoff.authSummary.state === "operator-action-needed", "auth bootstrap start did not expose operator action state");
  assert(authHandoff.authSummary.nextCommands.some((entry) => entry.includes("auth bootstrap status")), "auth bootstrap start summary did not suggest status");
  assert(authHandoff.authSummary.coverage.truncated === false, "auth bootstrap summary did not expose coverage");
  assert(typeof authHandoff.instructions === "string", "auth bootstrap missing instructions");

  // auth bootstrap status — observes current profile without reopening login
  const authStatus = await runCli(["auth", "bootstrap", "status", "--profile", "researcher", "--success-url-contains", "dashboard"]);
  assert(authStatus.schema === "agent-browser.auth.bootstrap.v1", "auth bootstrap status returned wrong schema");
  assert(authStatus.action === "status", "auth bootstrap status lost action");
  assert(authStatus.authComplete === true, "auth bootstrap status did not map worker success");
  assert(authStatus.authSummary.state === "complete", "auth bootstrap status did not expose complete state");
  assert(authStatus.authSummary.configuredSuccessConditions.includes("url"), "auth bootstrap summary did not include URL condition");
  assert(authStatus.authSummary.nextCommands.some((entry) => entry.includes("capture start")), "auth bootstrap complete summary did not suggest capture");
  assert(authStatus.authSummary.evidence.hasChecks === true, "auth bootstrap summary did not expose checks evidence");
  assert(authStatus.checks.noSuccessConditionConfigured === false, "auth bootstrap did not mark configured URL condition");

  const authSelectorStatus = await runCli(["auth", "bootstrap", "status", "--profile", "researcher", "--success-selector", ".dashboard"]);
  assert(authSelectorStatus.checks.successSelector === ".dashboard", "auth bootstrap lost success selector");
  assert(authSelectorStatus.next.status.includes("--success-selector"), "auth bootstrap next status did not preserve success selector");

  const authCookieStatus = await runCli(["auth", "bootstrap", "status", "--profile", "researcher", "--success-cookie-names", "sid,auth"]);
  assert(authCookieStatus.checks.configuredSuccessConditions.includes("cookies"), "auth bootstrap did not configure cookie condition");
  assert(authCookieStatus.next.status.includes("--success-cookie-names"), "auth bootstrap next status did not preserve cookie condition");

  const authNoConditionStatus = await runCli(["auth", "bootstrap", "status", "--profile", "researcher"]);
  assert(authNoConditionStatus.authComplete === false, "auth bootstrap without success condition should not claim completion");
  assert(authNoConditionStatus.authSummary.state === "missing-success-condition", "auth bootstrap did not summarize missing success condition");
  assert(authNoConditionStatus.authSummary.nextCommands.some((entry) => entry.includes("--success-selector")), "auth bootstrap missing-condition summary did not suggest success selector");
  assert(authNoConditionStatus.checks.noSuccessConditionConfigured === true, "auth bootstrap did not surface missing success conditions");
  assert(authNoConditionStatus.instructions.includes("No explicit success condition"), "auth bootstrap missing-condition instruction was not explicit");
  const authDiagnoseComplete = await runCli(["auth", "diagnose", "--profile", "authenticated", "--success-url-contains", "dashboard"]);
  assert(authDiagnoseComplete.schema === "agent-browser.auth.diagnose.v1", "auth diagnose returned wrong schema");
  assert(authDiagnoseComplete.ok === true, "auth diagnose did not mark complete auth as ready");
  assert(authDiagnoseComplete.state === "complete", "auth diagnose did not expose complete state");
  assert(authDiagnoseComplete.authSummary.evidence.checkedProfileDoctor === true, "auth diagnose did not check profile doctor");
  assert(authDiagnoseComplete.authSummary.evidence.checkedAuthStatus === true, "auth diagnose did not check auth status");
  assert(authDiagnoseComplete.authSummary.evidence.checkedStuck === true, "auth diagnose did not check stuck state");
  const authDiagnoseMissing = await runCli(["auth", "diagnose", "--profile", "researcher"]);
  assert(authDiagnoseMissing.ok === false, "auth diagnose without success condition should not be ready");
  assert(authDiagnoseMissing.state === "missing-success-condition", "auth diagnose did not classify missing success condition");
  assert(authDiagnoseMissing.blockers.includes("auth-missing-success-condition"), "auth diagnose did not expose missing-condition blocker");
  assert(authDiagnoseMissing.authSummary.nextCommands.some((entry) => entry.includes("--success-url-contains")), "auth diagnose did not suggest success conditions");
  const authPreflightComplete = await runCli(["profile", "preflight", "researcher", "--success-url-contains", "dashboard"], { CDP_SECURITY_DATA_DIR: join(tempDir, "auth-preflight-complete") });
  assert(authPreflightComplete.ok === true, "profile preflight did not accept completed auth condition");
  assert(authPreflightComplete.checks.auth.authComplete === true, "profile preflight did not include complete auth check");
  assert(authPreflightComplete.preflightSummary.evidence.checkedAuth === true, "profile preflight evidence did not mark auth check");
  const authPreflightMissingCondition = await runCli(["profile", "preflight", "researcher", "--check-auth"], { CDP_SECURITY_DATA_DIR: join(tempDir, "auth-preflight-missing") });
  assert(authPreflightMissingCondition.ok === false, "profile preflight did not block auth check without success condition");
  assert(authPreflightMissingCondition.preflightSummary.blocking.includes("auth-missing-success-condition"), "profile preflight did not name auth missing-condition blocker");

  // profile lease — local coordination guard for multi-agent profile use
  const leaseEnv = { CDP_SECURITY_DATA_DIR: join(tempDir, "lease-test") };
  const leaseAcquire = await runCli(["profile", "lease", "acquire", "--profile", "researcher", "--owner", "agent-a", "--purpose", "smoke", "--ttl-seconds", "60"], leaseEnv);
  assert(leaseAcquire.schema === "agent-browser.profile.lease.acquire.v1", "profile lease acquire returned wrong schema");
  assert(leaseAcquire.ok === true, "profile lease acquire did not succeed");
  assert(leaseAcquire.profileLeaseSummary.state === "leased", "profile lease summary did not mark leased state");
  const leaseConflict = await runCli(["profile", "lease", "acquire", "--profile", "researcher", "--owner", "agent-b"], leaseEnv);
  assert(leaseConflict.ok === false, "profile lease acquire did not report conflict");
  assert(leaseConflict.profileLeaseSummary.state === "conflict", "profile lease summary did not classify conflict");
  assert(leaseConflict.profileLeaseSummary.nextCommands.some((entry) => entry.includes("--force")), "profile lease conflict did not suggest force path");
  const leaseStatus = await runCli(["profile", "lease", "status", "--profile", "researcher"], leaseEnv);
  assert(leaseStatus.lease.owner === "agent-a", "profile lease status lost current owner");
  const leaseStatusConflict = await runCli(["profile", "lease", "status", "--profile", "researcher", "--owner", "agent-b"], leaseEnv);
  assert(leaseStatusConflict.status === "leased-by-other", "profile lease status did not classify leased-by-other");
  assert(leaseStatusConflict.conflict.currentOwner === "agent-a", "profile lease status did not expose conflict owner");
  assert(leaseStatusConflict.profileLeaseSummary.state === "conflict", "profile lease status summary did not classify conflict");
  const beforeLeaseGuardRequests = requests.length;
  const guardedOpen = await runCliFailure(["open", "https://example.com/guarded", "--profile", "researcher", "--owner", "agent-b"], leaseEnv);
  assert(guardedOpen.json?.error?.code === "profile_lease_conflict", "open did not fail with structured profile lease conflict");
  assert(guardedOpen.json?.error?.details?.schema === "agent-browser.profile.lease.guard.v1", "open lease guard did not expose guard schema");
  assert(guardedOpen.json?.error?.details?.blockers.includes("profile-leased-by-other"), "open lease guard did not name profile blocker");
  assert(requests.length === beforeLeaseGuardRequests, "lease-guarded open should not reach the worker");
  const guardedFill = await runCliFailure(["fill", "blocked@example.com", "--selector", "input[name=email]", "--profile", "researcher", "--owner", "agent-b"], leaseEnv);
  assert(guardedFill.json?.error?.code === "profile_lease_conflict", "fill did not fail with structured profile lease conflict");
  assert(requests.length === beforeLeaseGuardRequests, "lease-guarded fill should not reach the worker");
  const guardedCapture = await runCliFailure(["capture", "start", "--profile", "researcher", "--owner", "agent-b"], leaseEnv);
  assert(guardedCapture.json?.error?.code === "profile_lease_conflict", "capture start did not fail with structured profile lease conflict");
  assert(requests.length === beforeLeaseGuardRequests, "lease-guarded capture start should not reach the worker");
  const guardedWorkflow = await runCliFailure(["workflow", "run", "--file", workflowPath, "--owner", "agent-b"], leaseEnv);
  assert(guardedWorkflow.json?.error?.code === "profile_lease_conflict", "workflow run without preflight did not honor profile lease guard");
  assert(requests.length === beforeLeaseGuardRequests, "lease-guarded workflow should not reach the worker");
  const ownerOpen = await runCli(["open", "https://example.com/owned", "--profile", "researcher", "--owner", "agent-a"], leaseEnv);
  assert(ownerOpen.payload?.profile === "researcher", "current lease owner could not use leased profile");
  const leasedDoctor = await runCli(["profile", "doctor", "--profile", "researcher", "--owner", "agent-b"], leaseEnv);
  assert(leasedDoctor.profileLease.status === "leased-by-other", "profile doctor did not surface profile lease conflict");
  assert(leasedDoctor.profileLease.conflict.currentOwner === "agent-a", "profile doctor conflict lost lease owner");
  assert(leasedDoctor.suggestedNext.some((entry) => entry.includes("profile lease status")), "profile doctor did not suggest lease status on conflict");
  const leasedPreflight = await runCli(["profile", "preflight", "researcher", "--owner", "agent-b"], leaseEnv);
  assert(leasedPreflight.schema === "agent-browser.profile.preflight.v1", "profile preflight returned wrong schema");
  assert(leasedPreflight.ok === false, "profile preflight did not block leased-by-other profile");
  assert(leasedPreflight.preflightSummary.blocking.includes("profile-leased-by-other"), "profile preflight did not name lease blocker");
  const leaseList = await runCli(["profile", "lease", "list"], leaseEnv);
  assert(leaseList.count === 1, "profile lease list did not show active lease");
  const leaseRelease = await runCli(["profile", "lease", "release", "--profile", "researcher", "--owner", "agent-a"], leaseEnv);
  assert(leaseRelease.released === true, "profile lease release did not release owner lease");
  const leaseStatusAfterRelease = await runCli(["profile", "lease", "status", "--profile", "researcher"], leaseEnv);
  assert(leaseStatusAfterRelease.lease === null, "profile lease status stayed occupied after release");
  const multiLeaseConflictEnv = { CDP_SECURITY_DATA_DIR: join(tempDir, "lease-multi-conflict") };
  await runCli(["profile", "lease", "acquire", "--profile", "victim", "--owner", "agent-a", "--ttl-seconds", "60"], multiLeaseConflictEnv);
  const multiLeaseConflictPreflight = await runCli(["profile", "preflight", "--profiles", "researcher,victim", "--owner", "agent-b"], multiLeaseConflictEnv);
  assert(multiLeaseConflictPreflight.ok === false, "profile preflight did not block multi-profile lease conflict");
  assert(multiLeaseConflictPreflight.checks.leaseStatuses.length === 2, "profile preflight did not check all profile leases");
  assert(multiLeaseConflictPreflight.checks.leaseStatuses.some((entry) => entry.profile === "victim" && entry.status === "leased-by-other"), "profile preflight did not expose victim lease conflict");
  assert(multiLeaseConflictPreflight.preflightSummary.blocking.includes("profile-lease-conflict"), "profile preflight did not name multi-profile lease conflict");
  assert(multiLeaseConflictPreflight.preflightSummary.evidence.leaseConflicts.includes("victim"), "profile preflight evidence did not list conflicting profile");
  const multiLeaseAcquireEnv = { CDP_SECURITY_DATA_DIR: join(tempDir, "lease-multi-acquire") };
  const multiLeaseAcquirePreflight = await runCli(["profile", "preflight", "--profiles", "researcher,victim", "--owner", "agent-b", "--acquire-lease", "--ttl-seconds", "60"], multiLeaseAcquireEnv);
  assert(multiLeaseAcquirePreflight.checks.leaseAcquire.schema === "agent-browser.profile.lease.acquire-batch.v1", "profile preflight did not return batch lease acquire schema");
  assert(multiLeaseAcquirePreflight.checks.leaseAcquire.ok === true, "profile preflight did not acquire all profile leases");
  assert(multiLeaseAcquirePreflight.checks.leaseAcquire.acquisitions.length === 2, "profile preflight batch lease did not include both profiles");
  assert(multiLeaseAcquirePreflight.preflightSummary.evidence.leaseProfiles.includes("researcher") && multiLeaseAcquirePreflight.preflightSummary.evidence.leaseProfiles.includes("victim"), "profile preflight evidence did not list leased profiles");
  const availableDoctor = await runCli(["profile", "doctor", "--profile", "researcher", "--owner", "agent-b"], leaseEnv);
  assert(availableDoctor.profileLease.status === "available", "profile doctor did not show available lease after release");
  assert(availableDoctor.suggestedNext.some((entry) => entry.includes("profile lease acquire")), "profile doctor did not suggest lease acquire when available");
  const availablePreflight = await runCli(["profile", "preflight", "researcher", "--owner", "agent-b"], leaseEnv);
  assert(availablePreflight.ok === true, "profile preflight did not pass available managed profile");
  assert(availablePreflight.preflightSummary.state === "ready", "profile preflight did not mark available profile ready");
  const stuckPreflight = await runCli(["profile", "preflight", "researcher", "--owner", "agent-b", "--check-stuck"], leaseEnv);
  assert(stuckPreflight.ok === false, "profile preflight did not block stuck current page");
  assert(stuckPreflight.checks.stuck.stuckSummary.state === "login-form", "profile preflight did not include stuck summary state");
  assert(stuckPreflight.preflightSummary.blocking.includes("page-login-form"), "profile preflight did not name stuck blocker");
  assert(stuckPreflight.preflightSummary.evidence.checkedStuck === true, "profile preflight evidence did not mark stuck check");
  const acquirePreflight = await runCli(["profile", "preflight", "researcher", "--owner", "agent-c", "--acquire-lease", "--ttl-seconds", "60"], leaseEnv);
  assert(acquirePreflight.ok === true, "profile preflight failed to acquire available lease");
  assert(acquirePreflight.checks.leaseAcquire.ok === true, "profile preflight did not report acquired lease");
  assert(acquirePreflight.checks.doctor.profileLease.status === "leased-by-current-owner", "profile preflight doctor did not see acquired lease");

  // profile registry — set, get, list using temp data dir
  const registryEnv = { CDP_SECURITY_DATA_DIR: join(tempDir, "registry-test") };
  const regSet = await runCli(["profile", "registry", "set", "--profile", "researcher", "--project", "money-arena", "--platform", "example.com", "--account", "researcher@example.com", "--target", "example", "--role", "attacker"], registryEnv);
  assert(regSet.ok === true, "profile registry set did not return ok: true");
  assert(regSet.meta.project === "money-arena", "profile registry set lost project");
  assert(regSet.meta.target === "example", "profile registry set lost target");
  assert(regSet.meta.role === "attacker", "profile registry set lost role");
  const regGet = await runCli(["profile", "registry", "get", "--profile", "researcher"], registryEnv);
  assert(regGet.ok === true, "profile registry get did not return ok: true");
  assert(regGet.meta.account === "researcher@example.com", "profile registry get lost account");
  assert(regGet.meta.role === "attacker", "profile registry get lost role");
  const regList = await runCli(["profile", "registry", "list"], registryEnv);
  assert(regList.count === 1, "profile registry list did not show 1 entry");
  assert(regList.profiles[0].profile === "researcher", "profile registry list lost profile name");
  const targetRegList = await runCli(["profile", "registry", "list", "--target", "example", "--role", "attacker"], registryEnv);
  assert(targetRegList.count === 1, "profile registry list did not filter target/role");
  const regValidate = await runCli(["profile", "registry", "validate", "--profile", "researcher"], registryEnv);
  assert(regValidate.schema === "agent-browser.profile.registry.validate.v1", "profile registry validate returned wrong schema");
  assert(regValidate.ok === true, "profile registry validate did not accept complete metadata");
  const roleCoverageMissing = await runCli(["profile", "registry", "validate", "--target", "example", "--require-roles", "attacker,victim"], registryEnv);
  assert(roleCoverageMissing.ok === false, "profile registry validate did not report missing required role");
  assert(roleCoverageMissing.roleCoverage.missingRoles.includes("victim"), "profile registry validate did not name missing role");
  assert(roleCoverageMissing.validationSummary.state === "missing-roles", "profile registry validation summary did not classify missing roles");
  assert(roleCoverageMissing.validationSummary.nextCommands.some((entry) => entry.includes("example-victim-auth")), "profile registry validation summary did not suggest missing role profile");
  await runCli(["profile", "registry", "set", "--profile", "victim", "--project", "money-arena", "--platform", "example.com", "--account", "victim@example.com", "--target", "example", "--role", "victim"], registryEnv);
  const roleCoverageComplete = await runCli(["profile", "registry", "validate", "--target", "example", "--require-roles", "attacker,victim"], registryEnv);
  assert(roleCoverageComplete.ok === true, "profile registry validate did not accept complete role coverage");
  assert(roleCoverageComplete.validationSummary.readyForTwoAccount === true, "profile registry validation summary did not mark two-account setup ready");
  assert(roleCoverageComplete.validationSummary.nextCommands.some((entry) => entry.includes("profile isolation check")), "profile registry validation summary did not suggest isolation check");
  const registryDiagnoseReady = await runCli(["profile", "registry", "diagnose", "--target", "example", "--require-roles", "attacker,victim", "--unique-roles"], registryEnv);
  assert(registryDiagnoseReady.schema === "agent-browser.profile.registry.diagnose.v1", "profile registry diagnose returned wrong schema");
  assert(registryDiagnoseReady.ok === true, "profile registry diagnose did not accept ready role coverage");
  assert(registryDiagnoseReady.state === "ready", "profile registry diagnose did not expose ready state");
  assert(registryDiagnoseReady.registrySummary.readyForTwoAccount === true, "profile registry diagnose did not mark two-account ready");
  assert(registryDiagnoseReady.registrySummary.evidence.checkedValidation === true, "profile registry diagnose did not check validation");
  assert(registryDiagnoseReady.registrySummary.evidence.checkedMatrix === true, "profile registry diagnose did not check matrix");
  assert(registryDiagnoseReady.registrySummary.evidence.checkedLeaseStatuses === true, "profile registry diagnose did not check lease statuses");
  assert(registryDiagnoseReady.registrySummary.nextCommands.some((entry) => entry.includes("profile preflight")), "profile registry diagnose did not suggest profile preflight");
  const targetReady = await runCli(["ready", "pentest", "--target", "example", "--require-roles", "attacker,victim"], registryEnv);
  assert(targetReady.checks.registryMatrix !== null, "ready pentest target did not include registry matrix");
  assert(targetReady.checks.profilePreflight.profiles.includes("researcher") && targetReady.checks.profilePreflight.profiles.includes("victim"), "ready pentest target did not derive profiles from registry roles");
  assert(targetReady.readySummary.blocking.includes("isolation-not-ready"), "ready pentest target did not require live isolation check");
  assert(!targetReady.readySummary.blocking.includes("profile-required"), "ready pentest target should not require single --profile when target roles are supplied");
  const targetPreflight = await runCli(["profile", "preflight", "--target", "example", "--require-roles", "attacker,victim", "--profiles", "researcher,victim"], registryEnv);
  assert(targetPreflight.ok === false, "profile preflight should require live isolation URL for two-account work");
  assert(targetPreflight.preflightSummary.blocking.includes("isolation-not-ready"), "profile preflight did not name isolation blocker");
  assert(targetPreflight.checks.registry.ok === true, "profile preflight did not pass target registry validation");
  const twoAccountEnv = { CDP_SECURITY_DATA_DIR: join(tempDir, "two-account-ready") };
  await runCli(["profile", "registry", "set", "--profile", "attacker", "--project", "money-arena", "--platform", "example.com", "--account", "attacker@example.com", "--target", "example", "--role", "attacker"], twoAccountEnv);
  await runCli(["profile", "registry", "set", "--profile", "victim", "--project", "money-arena", "--platform", "example.com", "--account", "victim@example.com", "--target", "example", "--role", "victim"], twoAccountEnv);
  const twoAccountNoUrl = await runCli(["profile", "two-account", "ready", "--target", "example", "--require-roles", "attacker,victim"], twoAccountEnv);
  assert(twoAccountNoUrl.schema === "agent-browser.profile.two-account.ready.v1", "two-account ready returned wrong schema");
  assert(twoAccountNoUrl.ok === false, "two-account ready without URL should not claim readiness");
  assert(twoAccountNoUrl.profiles.includes("attacker") && twoAccountNoUrl.profiles.includes("victim"), "two-account ready did not resolve role profiles");
  assert(twoAccountNoUrl.readySummary.blocking.includes("isolation-not-ready"), "two-account ready did not require live isolation URL");
  const twoAccountReady = await runCli(["profile", "two-account", "ready", "--target", "example", "--require-roles", "attacker,victim", "--url", "https://example.com", "--owner", "agent-z", "--acquire-lease"], twoAccountEnv);
  assert(twoAccountReady.ok === true, "two-account ready with URL and leases did not pass");
  assert(twoAccountReady.readySummary.readyForTwoAccount === true, "two-account ready did not mark readyForTwoAccount");
  assert(twoAccountReady.roleAssignments.every((entry) => entry.ready === true), "two-account ready lost role assignments");
  assert(twoAccountReady.readySummary.evidence.checkedIsolation === true, "two-account ready did not run isolation check");
  assert(twoAccountReady.readySummary.evidence.acquiredLeases === true, "two-account ready did not acquire leases when requested");
  await runCli(["profile", "registry", "set", "--profile", "attacker-copy", "--project", "money-arena", "--platform", "example.com", "--account", "attacker-copy@example.com", "--target", "example", "--role", "attacker"], registryEnv);
  const duplicateRoleAllowed = await runCli(["profile", "registry", "validate", "--target", "example", "--require-roles", "attacker,victim"], registryEnv);
  assert(duplicateRoleAllowed.ok === true, "profile registry validate should allow duplicate roles unless requested");
  assert(duplicateRoleAllowed.roleCoverage.duplicateRoles.some((entry) => entry.role === "attacker"), "profile registry validate did not surface duplicate role");
  assert(duplicateRoleAllowed.validationSummary.state === "duplicate-role-warning", "profile registry validation summary did not warn on duplicate role");
  const registryMatrix = await runCli(["profile", "registry", "matrix", "--target", "example", "--require-roles", "attacker,victim,admin"], registryEnv);
  assert(registryMatrix.schema === "agent-browser.profile.registry.matrix.v1", "profile registry matrix returned wrong schema");
  assert(registryMatrix.roles.some((entry) => entry.role === "attacker" && entry.duplicate === true), "profile registry matrix did not surface duplicate attacker role");
  assert(registryMatrix.missingRoles.includes("admin"), "profile registry matrix did not surface missing admin role");
  assert(registryMatrix.isolationPlan.readyForIsolationCheck === false, "profile registry matrix should not mark missing-role setup as ready");
  assert(registryMatrix.isolationPlan.roleProfiles.some((entry) => entry.role === "victim" && entry.selectedProfile === "victim"), "profile registry matrix did not map role to profile");
  assert(registryMatrix.isolationPlan.commands.checkIsolation.includes("profile isolation check"), "profile registry matrix did not expose isolation check command");
  assert(registryMatrix.suggestedNext.some((entry) => entry.includes("profile isolation check")), "profile registry matrix did not suggest isolation check");
  const duplicateRoleStrict = await runCli(["profile", "registry", "validate", "--target", "example", "--require-roles", "attacker,victim", "--unique-roles"], registryEnv);
  assert(duplicateRoleStrict.ok === false, "profile registry validate --unique-roles did not fail duplicate role");
  assert(duplicateRoleStrict.validationSummary.state === "duplicate-roles", "profile registry validation summary did not classify strict duplicate role");
  const regDelete = await runCli(["profile", "registry", "delete", "--profile", "attacker-copy"], registryEnv);
  assert(regDelete.schema === "agent-browser.profile.registry.delete.v1", "profile registry delete returned wrong schema");
  assert(regDelete.deleted === true, "profile registry delete did not delete stale metadata");
  const roleCoverageAfterDelete = await runCli(["profile", "registry", "validate", "--target", "example", "--require-roles", "attacker,victim", "--unique-roles"], registryEnv);
  assert(roleCoverageAfterDelete.ok === true, "profile registry validate stayed false after deleting duplicate role metadata");
  const missingRegValidate = await runCli(["profile", "registry", "validate", "--profile", "missing-profile"], registryEnv);
  assert(missingRegValidate.ok === false, "profile registry validate did not reject missing profile");
  assert(missingRegValidate.invalidCount === 1, "profile registry validate missing invalidCount");
  assert(missingRegValidate.validationSummary.state === "invalid-metadata", "profile registry validation summary did not classify invalid metadata");
  assert(missingRegValidate.validationSummary.evidence.secretLikeFieldsRejected === true, "profile registry validation summary did not expose evidence boundary");
  const registryDiagnoseMissing = await runCli(["profile", "registry", "diagnose", "--target", "missing-target", "--require-roles", "attacker,victim"], registryEnv);
  assert(registryDiagnoseMissing.ok === false, "profile registry diagnose did not reject missing target roles");
  assert(registryDiagnoseMissing.blockers.includes("registry-empty"), "profile registry diagnose did not expose empty registry blocker");
  assert(registryDiagnoseMissing.blockers.includes("missing-role:attacker"), "profile registry diagnose did not expose missing attacker role");

  const registryLeaseEnv = { CDP_SECURITY_DATA_DIR: join(tempDir, "registry-lease-diagnose") };
  await runCli(["profile", "registry", "set", "--profile", "lease-attacker", "--project", "money-arena", "--platform", "example.com", "--account", "attacker@example.com", "--target", "lease-example", "--role", "attacker"], registryLeaseEnv);
  await runCli(["profile", "registry", "set", "--profile", "lease-victim", "--project", "money-arena", "--platform", "example.com", "--account", "victim@example.com", "--target", "lease-example", "--role", "victim"], registryLeaseEnv);
  await runCli(["profile", "lease", "acquire", "--profile", "lease-victim", "--owner", "other-agent"], registryLeaseEnv);
  const registryDiagnoseLeaseConflict = await runCli(["profile", "registry", "diagnose", "--target", "lease-example", "--require-roles", "attacker,victim", "--unique-roles", "--owner", "current-agent"], registryLeaseEnv);
  assert(registryDiagnoseLeaseConflict.ok === false, "profile registry diagnose did not block lease conflict");
  assert(registryDiagnoseLeaseConflict.state === "lease-conflict", "profile registry diagnose did not classify lease conflict");
  assert(registryDiagnoseLeaseConflict.registrySummary.leaseConflictProfiles.includes("lease-victim"), "profile registry diagnose did not name conflicting profile");

  // profile isolation — two-account tests must be able to prove storage did not silently collapse into one profile
  const isolation = await runCli(["profile", "isolation", "check", "--profiles", "attacker,victim", "--url", "https://example.com/dashboard"]);
  assert(isolation.schema === "agent-browser.profile-isolation.v1", "profile isolation returned wrong schema");
  assert(isolation.records.length === 2, "profile isolation did not inspect both profiles");
  assert(isolation.comparisons[0].sameCookieDigest === false, "profile isolation failed to detect distinct cookie digests");
  assert(isolation.coverage.valuesRedacted === true, "profile isolation should not print raw cookie values");

  const byTool = requests.map((entry) => entry.tool);
  assert(byTool.includes("profile_list"), "profile list did not call profile_list");
  assert(byTool.includes("profile_resume"), "profile resume did not call profile_resume");
  assert(byTool.includes("browser_open"), "open did not call browser_open");
  assert(byTool.includes("browser_snapshot"), "see snapshot did not call browser_snapshot");
  assert(byTool.includes("browser_screenshot"), "see screenshot did not call browser_screenshot");
  assert(byTool.includes("browser_observe"), "observe did not call browser_observe");
  assert(byTool.includes("browser_click"), "click did not call browser_click");
  assert(byTool.includes("browser_hover"), "hover did not call browser_hover");
  assert(byTool.includes("browser_double_click"), "dblclick did not call browser_double_click");
  assert(byTool.includes("browser_drag"), "drag did not call browser_drag");
  assert(byTool.includes("browser_press"), "press did not call browser_press");
  assert(byTool.includes("browser_select"), "select did not call browser_select");
  assert(byTool.includes("browser_wait"), "wait did not call browser_wait");
  assert(byTool.includes("browser_upload"), "upload did not call browser_upload");
  assert(byTool.includes("browser_scroll"), "scroll did not call browser_scroll");
  assert(byTool.includes("browser_capture"), "capture did not call browser_capture");
  assert(byTool.includes("browser_inspect"), "inspect did not call browser_inspect");
  assert(byTool.includes("browser_security_summary"), "security summary did not call browser_security_summary");
  assert(byTool.includes("browser_security_pack"), "pack did not call browser_security_pack");
  assert(byTool.includes("browser_raw"), "raw-backed commands did not call browser_raw");
  assert(byTool.includes("browser_feedback"), "feedback did not call browser_feedback");
  assert(byTool.includes("browser_eval"), "profile isolation did not call browser_eval");

  const click = requests.find((entry) => entry.tool === "browser_click");
  assert(click.payload.waitMode === "no-navigation", "click lost waitMode");
  const hover = requests.find((entry) => entry.tool === "browser_hover" && entry.payload.text === "Account");
  assert(hover.payload.profile === "researcher", "hover lost profile/text");
  const dblclick = requests.find((entry) => entry.tool === "browser_double_click" && entry.payload.selector === ".editable-row");
  assert(dblclick.payload.waitMode === "no-navigation", "dblclick lost waitMode");
  const drag = requests.find((entry) => entry.tool === "browser_drag" && entry.payload.selector === ".card");
  assert(drag.payload.targetSelector === ".done", "drag lost target selector");
  assert(Number(drag.payload.actionTimeoutMs) === 1200, "drag lost action timeout");
  const forceClick = requests.find((entry) => entry.tool === "browser_click" && entry.payload.forceJs === true);
  assert(forceClick.payload.inputMode === "dom", "click --force-js did not map to inputMode=dom");
  assert(Number(forceClick.payload.actionTimeoutMs) === 1200, "click lost action timeout");
  const wait = requests.find((entry) => entry.tool === "browser_wait");
  assert(wait.payload.selector === ".ready" && wait.payload.state === "visible", "wait lost selector/state");
  const networkWait = requests.find((entry) => entry.tool === "browser_wait" && entry.payload.requestUrlContains === "graphql");
  assert(networkWait.payload.requestMethod === "POST" && Number(networkWait.payload.requestStatus) === 200, "wait lost network request filters");
  const screenshotReq = requests.find((entry) => entry.tool === "browser_screenshot" && entry.payload.profile === "researcher");
  assert(screenshotReq.payload.includeImage === false, "CLI screenshot should disable inline image by default");
  assert(!screenshot._mcp, "CLI screenshot default should not return inline MCP image content");
  assert(screenshot.cliImagePolicy.inlineImageDefault === false, "CLI screenshot did not explain inline image policy");
  const select = requests.find((entry) => entry.tool === "browser_select" && entry.payload.selector === "select[name=country]");
  assert(select.payload.value === "US", "select lost value");
  const formTypes = requests.filter((entry) => entry.tool === "browser_type" && ["input[name=title]", "textarea[name=body]"].includes(entry.payload.selector));
  assert(formTypes.length === 2, "form fill did not call browser_type for each field");
  const passwordType = requests.find((entry) => entry.tool === "browser_type" && entry.payload.selector === "input[name=password]");
  assert(passwordType.payload.pressEnter === true, "type --press-enter did not pass pressEnter");
  const filledEmail = requests.find((entry) => entry.tool === "browser_type" && entry.payload.selector === "input[name=email]");
  assert(filledEmail.payload.clear === true, "fill did not call browser_type with clear=true");
  assert(filledEmail.payload.text === "hello@example.com", "fill lost text");
  const keyboardPress = requests.find((entry) => entry.tool === "browser_press" && entry.payload.key === "Control+K");
  assert(keyboardPress.payload.selector === "input[name=q]", "press did not pass selector");
  const workflowPress = requests.find((entry) => entry.tool === "browser_press" && entry.payload.key === "Enter");
  assert(workflowPress.payload.selector === "input[name=q]", "workflow press did not pass selector");
  assert(Number(passwordType.payload.actionTimeoutMs) === 1200, "type lost action timeout");
  const quotedClick = requests.find((entry) => entry.tool === "browser_click" && entry.payload.text === "Sign up");
  assert(quotedClick !== undefined, "click did not trim outer quotes from text");
  const quotedType = requests.find((entry) => entry.tool === "browser_type" && entry.payload.selector === "#username");
  assert(quotedType !== undefined, "type did not trim outer quotes from selector");
  const quotedWait = requests.find((entry) => entry.tool === "browser_wait" && entry.payload.selector === "#username");
  assert(quotedWait !== undefined, "wait did not trim outer quotes from selector");
  assert(scrollResult.document.scrollHeight === 640 && scrollResult.canScrollY === false, "scroll did not expose page scroll dimensions");
  assert(workflowRun.schema === "agent-browser.workflow.run.v1" && workflowRun.completedCount === 10, "workflow run did not complete expected steps");
  const upload = requests.find((entry) => entry.tool === "browser_upload");
  assert(upload.payload.selector === "input[type=file]" && upload.payload.file === "C:\\tmp\\image.png", "upload lost selector/file");
  assert(inspectSecurity.profile === "researcher", "inspect security did not call security summary");
  assert(securitySummary.page.securityState === "secure", "security summary did not return security page state");
  const capture = requests.find((entry) => entry.tool === "browser_capture");
  assert(capture.payload.action === "start" && capture.payload.label === "run-1", "capture lost action/label");
  const pack = requests.find((entry) => entry.tool === "browser_security_pack");
  assert(pack.payload.includeTrace === false && pack.payload.includeHar === true, "pack lost include flags");
  assert(requestList.schema === "agent-browser.requests.v1", "requests did not return compact schema");
  assert(requestList.coverage.truncated === false, "requests did not expose non-truncated coverage");
  assert(requestList.requests[0].requestId === "req-1", "requests lost requestId");
  assert(requestList.requests[0].next.replay.includes("agent-browser replay req-1"), "requests did not include replay next command");
  assert(wrappedRequestList.schema === "agent-browser.requests.v1" && wrappedRequestList.requests[0].requestId === "req-1", "requests did not unwrap real browser_raw facade response");
  const requestDetail = requests.find((entry) => entry.tool === "browser_raw" && entry.payload.toolName === "profile_request_detail");
  assert(requestDetail.payload.tool === "profile_request_detail" && requestDetail.payload.input.requestId === "req-1", "request detail did not use browser_raw tool/input contract");
  assert(requestDetail.payload.params.requestId === "req-1", "request detail lost requestId");
  const requestPayload = requests.find((entry) => entry.tool === "browser_raw" && entry.payload.toolName === "profile_request_payload");
  assert(requestPayload.payload.params.requestId === "req-1", "request payload lost requestId");
  assert(graphqlRequests.schema === "agent-browser.graphql.requests.v1", "graphql requests returned wrong schema");
  assert(graphqlRequests.sourceTool === "profile_traffic_query", "graphql requests did not document source tool");
  assert(String(graphqlRequests.mapLogic || "").includes("profile_request_payload"), "graphql requests did not explain deterministic map logic");
  assert(graphqlRequests.inspectLimit === 5, "graphql requests did not expose default inspectLimit");
  assert(graphqlRequests.defaultInspectLimit === 5, "graphql requests did not expose default inspect limit");
  assert(graphqlRequests.coverage.payloadInspection.defaultApplied === true, "graphql requests did not mark default inspect limit");
  assert(graphqlRequests.inspectedRequestIds.includes("req-1"), "graphql requests did not expose inspected request ids");
  assert(Array.isArray(graphqlRequests.skippedPayloadInspectionRequestIds), "graphql requests did not expose skipped request ids");
  assert(graphqlRequests.matchedRequestCount === 1, "graphql requests did not expose matched request count");
  assert(graphqlRequests.coverage.payloadInspection.truncated === false, "graphql requests did not expose payload inspection coverage");
  assert(graphqlRequests.truncated === false, "graphql requests did not expose truncation state");
  assert(graphqlRequests.operations[0].graphql[0].operationName === "UpdateRole", "graphql requests did not summarize operation");
  const boundedGraphqlRequests = await runCli(["graphql", "requests", "--profile", "researcher", "--url-contains", "many-graphql"]);
  assert(boundedGraphqlRequests.truncated === true, "bounded graphql requests did not mark truncation");
  assert(boundedGraphqlRequests.warnings.some((entry) => entry.code === "bounded_payload_inspection"), "bounded graphql requests did not warn about payload inspection cap");
  assert(boundedGraphqlRequests.skippedPayloadInspectionCount === 3, "bounded graphql requests did not count skipped payload inspections");
  assert(boundedGraphqlRequests.next.inspectAllReturnedRows.includes("--inspect-all"), "bounded graphql requests did not expose inspect-all command");
  const boundedRequestList = await runCli(["requests", "--profile", "researcher", "--url-contains", "many-graphql", "--limit", "5"]);
  assert(boundedRequestList.truncated === true, "bounded requests did not mark truncation");
  assert(boundedRequestList.warnings.some((entry) => entry.code === "bounded_network_rows"), "bounded requests did not expose network row warning");
  assert(boundedRequestList.next.fetchMore.includes("--url-contains"), "bounded requests fetchMore lost filters");
  assert(graphqlPayload.graphql[0].variableKeys.includes("role"), "graphql payload lost variable keys");
  assert(apiMap.schema === "agent-browser.api.map.v1", "api map returned wrong schema");
  assert(apiMap.sourceTool === "profile_traffic_query", "api map did not document source tool");
  assert(String(apiMap.mapLogic || "").includes("method + origin + path"), "api map did not explain grouping logic");
  assert(String(apiMap.mapLogic || "").includes("--limit 100"), "api map did not explain input cap");
  assert(apiMap.coverage.truncated === false, "api map did not expose coverage");
  assert(apiMap.totalRequestCount === 1, "api map did not expose total request count");
  assert(apiMap.endpoints[0].path === "/graphql", "api map lost endpoint path");
  assert(apiMap.endpoints[0].next.replay.includes("agent-browser replay req-1"), "api map did not include replay next command");
  const requestBody = requests.find((entry) => entry.tool === "browser_raw" && entry.payload.toolName === "profile_traffic_get");
  assert(requestBody.payload.params.requestId === "req-1", "request body lost requestId");
  const artifactRead = requests.find((entry) => entry.tool === "browser_raw" && entry.payload.toolName === "browser_artifact_read");
  assert(artifactRead.payload.params.path === "tmp/security-research-pack.json", "artifact read lost path");
  assert(artifactRead.payload.params.startLine === 2 && artifactRead.payload.params.maxLines === 3, "artifact read lost bounds");
  const replay = requests.find((entry) => entry.tool === "browser_raw" && entry.payload.toolName === "profile_request_replay" && entry.payload.params.method === "POST" && entry.payload.params.headers?.["content-type"] === "application/json");
  assert(replay.payload.params.requestId === "req-1", "replay lost requestId");
  assert(replay.payload.params.method === "POST", "replay lost method");
  assert(replay.payload.params.headers["content-type"] === "application/json", "replay lost headers");
  assert(replay.payload.params.json.role === "admin", "replay lost JSON body");
  const graphqlReplay = requests.find((entry) => entry.tool === "browser_raw" && entry.payload.toolName === "profile_request_replay" && entry.payload.params.json?.operationName === "UpdateRole");
  assert(graphqlReplay.payload.params.json.variables.role === "admin", "graphql replay did not patch variables");
  const replayBatch = requests.find((entry) => entry.tool === "browser_raw" && entry.payload.toolName === "profile_request_replay_batch");
  assert(replayBatch.payload.params.variants.length === 2, "replay-batch lost variants");
  assert(graphqlReplayResult.schema === "agent-browser.replay.v1", "graphql replay did not return stable replay schema");
  assert(graphqlReplayResult.replaySummary.status === 403, "graphql replay did not summarize replay status");
  assert(graphqlReplayResult.boundary.includes("GraphQL replay patches variables"), "graphql replay did not expose GraphQL boundary");
  assert(graphqlInterceptPlan.schema === "agent-browser.graphql.intercept-plan.v1", "graphql intercept-plan returned wrong schema");
  assert(graphqlInterceptPlan.mode === "cdp-fetch-in-flight", "graphql intercept-plan did not expose in-flight mode");
  assert(graphqlInterceptPlan.workflow.some((entry) => entry.command.includes("intercept start")), "graphql intercept-plan missing intercept start command");
  assert(graphqlInterceptPlan.workflow.some((entry) => entry.command.includes("intercept continue") && entry.command.includes("UpdateRole")), "graphql intercept-plan missing patched continue command");
  assert(graphqlInterceptPlan.idBoundary.doNotMix === true, "graphql intercept-plan did not expose id boundary");
  assert(requestReplayResult.schema === "agent-browser.replay.v1", "request replay did not return stable replay schema");
  assert(requestReplayResult.replaySummary.status === 403, "request replay did not summarize replay status");
  assert(typeof requestReplayResult.next.compare === "string", "request replay missing compare next hint");
  assert(requestReplayBatchResult.schema === "agent-browser.replay-batch.v1", "request replay-batch did not return stable batch schema");
  assert(requestReplayBatchResult.batchSummary.variantCount === 2, "request replay-batch did not summarize variants");
  assert(requestReplayBatchResult.batchSummary.statusCodes.includes(200) && requestReplayBatchResult.batchSummary.statusCodes.includes(403), "request replay-batch did not summarize status codes");
  const interceptStart = requests.find((entry) => entry.tool === "cdp_fetch_intercept" && entry.payload.action === "start");
  assert(interceptStart.payload.url_pattern === "graphql", "intercept start lost url pattern");
  const interceptContinue = requests.find((entry) => entry.tool === "cdp_fetch_intercept" && entry.payload.action === "continue");
  assert(interceptContinue.payload.captured_request_id === "fetch-intercept-1", "intercept continue lost captured request id");
  assert(interceptContinue.payload.header_overrides["x-test"] === "1", "intercept continue lost headers");
  assert(interceptContinue.payload.remove_headers.includes("content-length"), "intercept continue lost removed headers");
  assert(interceptContinue.payload.json.role === "admin", "intercept continue lost JSON body");
  const feedback = requests.find((entry) => entry.tool === "browser_feedback");
  assert(feedback.payload.summary.includes("SPA action"), "feedback lost summary");
  assert(feedback.payload.type === "bug", "feedback did not normalize legacy tool-bug type");
  assert(feedback.payload.title === "browser click waited for a non-navigation SPA action", "feedback did not send required title");

  const authStarts = requests.filter((entry) => entry.tool === "browser_auth_bootstrap" && entry.payload.action === "start");
  assert(authStarts.length >= 1, "auth bootstrap did not call browser_auth_bootstrap start");
  const authStatuses = requests.filter((entry) => entry.tool === "browser_auth_bootstrap" && entry.payload.action === "status");
  assert(authStatuses.length >= 1, "auth bootstrap did not call browser_auth_bootstrap status");

  // stuck — calls browser_stuck, returns ok + signals + suggestedNext
  const stuck = await runCli(["stuck", "--profile", "researcher"]);
  assert(stuck.ok === true, "stuck did not return ok: true");
  assert(Array.isArray(stuck.signals), "stuck did not return signals array");
  assert(Array.isArray(stuck.suggestedNext), "stuck did not return suggestedNext array");
  assert(stuck.pageAccessError === null, "stuck did not expose pageAccessError field");
  assert(stuck.pageState.readyState === "complete", "stuck did not return objective pageState");
  assert(stuck.formState.passwordInputCount === 1, "stuck did not return objective formState");
  assert(stuck.stuckSummary.state === "login-form", "stuck did not summarize login form state");
  assert(stuck.stuckSummary.passwordInputCount === 1, "stuck summary did not preserve password input count");
  assert(stuck.stuckSummary.nextAction.includes("--press-enter"), "stuck summary did not suggest login form next action");
  assert(stuck.stuckSummary.nextCommands.some((entry) => entry.includes("--press-enter")), "stuck summary did not expose runnable next command");
  assert(stuck.stuckSummary.evidence.hasPageState === true, "stuck summary did not expose page evidence state");
  assert(stuck.stuckSummary.evidence.hasFormState === true, "stuck summary did not expose form evidence state");
  assert(stuck.stuckSummary.coverage.truncated === false, "stuck summary did not expose truncation state");
  const stuckReq = requests.find((entry) => entry.tool === "browser_stuck");
  assert(stuckReq !== undefined, "stuck did not call browser_stuck");
  assert(stuckReq.payload.profile === "researcher", "stuck lost profile");
  const blankFormStuck = await runCli(["stuck", "--profile", "blank-form"]);
  assert(blankFormStuck.stuckSummary.state === "unfilled-form", "blank form should classify as unfilled-form, not blank-page");
  assert(blankFormStuck.stuckSummary.nextCommands.some((entry) => entry.includes("agent-browser type")), "unfilled-form should suggest typing into inputs");
  const networkPendingStuck = await runCli(["stuck", "--profile", "network-pending"]);
  assert(networkPendingStuck.stuckSummary.state === "network-pending", "stuck did not classify stale pending network request");
  assert(networkPendingStuck.stuckSummary.stalePendingRequestCount === 1, "stuck summary did not expose stale pending request count");
  assert(networkPendingStuck.stuckSummary.evidence.hasNetworkState === true, "stuck summary did not expose network evidence state");
  assert(networkPendingStuck.stuckSummary.evidence.latestPending[0].requestId === "pending-1", "stuck summary did not expose latest pending request evidence");
  assert(networkPendingStuck.stuckSummary.nextCommands.some((entry) => entry.includes("agent-browser requests")), "network-pending should suggest request inspection");
  const actionDiagnoseReady = await runCli(["action", "diagnose", "click", "--profile", "authenticated", "--text", "Save", "--expect-request-url-contains", "graphql"]);
  assert(actionDiagnoseReady.schema === "agent-browser.action.diagnose.v1", "action diagnose returned wrong schema");
  assert(actionDiagnoseReady.ok === true, "action diagnose should be ready when page, locator, and expected request are present");
  assert(actionDiagnoseReady.actionSummary.evidence.checkedStuck === true, "action diagnose did not check stuck state");
  assert(actionDiagnoseReady.actionSummary.evidence.checkedExpectedRequest === true, "action diagnose did not check expected request");
  assert(actionDiagnoseReady.actionSummary.nextCommands.some((entry) => entry.includes("click")), "action diagnose did not suggest retry click");
  const actionPreflightReady = await runCli(["action", "preflight", "click", "--profile", "authenticated", "--text", "Save", "--expect-request-url-contains", "graphql"]);
  assert(actionPreflightReady.schema === "agent-browser.action.preflight.v1", "action preflight returned wrong schema");
  assert(actionPreflightReady.ok === true, "action preflight should be ready when diagnose checks pass");
  assert(actionPreflightReady.preflightSummary.readyForAction === true, "action preflight did not mark readyForAction");
  assert(actionPreflightReady.boundary.includes("before executing"), "action preflight boundary did not describe pre-action scope");
  const actionDiagnoseMissingRequest = await runCli(["action", "diagnose", "click", "--profile", "authenticated", "--text", "Save", "--expect-request-url-contains", "nomatch"]);
  assert(actionDiagnoseMissingRequest.ok === false, "action diagnose should block when expected request is absent");
  assert(actionDiagnoseMissingRequest.blockers.includes("expected-request-not-observed"), "action diagnose did not name missing request blocker");
  assert(actionDiagnoseMissingRequest.actionSummary.nextCommands.some((entry) => entry.includes("capture start")), "action diagnose did not suggest capture start for missing request");
  const actionPreflightMissingRequest = await runCli(["action", "preflight", "click", "--profile", "authenticated", "--text", "Save", "--expect-request-url-contains", "nomatch"]);
  assert(actionPreflightMissingRequest.ok === false, "action preflight should block when expected request is absent");
  assert(actionPreflightMissingRequest.state === "not-ready", "action preflight did not classify missing request as not-ready");
  assert(actionPreflightMissingRequest.preflightSummary.readyForAction === false, "action preflight did not mark blocked readiness");

  // workflow --validate-only — validates without running
  const validateOnlyPath = join(tempDir, "validate-only.json");
  writeFileSync(validateOnlyPath, JSON.stringify([
    { action: "open", url: "https://example.com" },
    { action: "click", text: "Submit" },
  ]), "utf8");
  const validateOk = await runCli(["workflow", "run", "--file", validateOnlyPath, "--validate-only"]);
  assert(validateOk.valid === true, "workflow --validate-only did not return valid: true for a valid workflow");
  assert(Array.isArray(validateOk.steps), "workflow --validate-only did not return steps array");
  const workflowDiagnoseOk = await runCli(["workflow", "diagnose", "--file", workflowPath]);
  assert(workflowDiagnoseOk.schema === "agent-browser.workflow.diagnose.v1", "workflow diagnose returned wrong schema");
  assert(workflowDiagnoseOk.ok === true, "workflow diagnose did not accept valid workflow");
  assert(workflowDiagnoseOk.stepCount === 10, "workflow diagnose did not count workflow steps");
  assert(workflowDiagnoseOk.actionCounts.fill === 1, "workflow diagnose did not count fill action");
  assert(workflowDiagnoseOk.workflowSummary.hasWait === true, "workflow diagnose did not detect wait step");
  assert(workflowDiagnoseOk.workflowSummary.hasEvidenceStep === true, "workflow diagnose did not detect evidence step");
  assert(workflowDiagnoseOk.workflowSummary.hasPreflight === false, "workflow diagnose should show this fixture has no preflight declaration");
  assert(workflowDiagnoseOk.warnings.some((entry) => entry.code === "no-profile-preflight"), "workflow diagnose did not warn about missing preflight");

  // workflow --validate-only — catches invalid step
  const invalidWorkflowPath = join(tempDir, "invalid-workflow.json");
  writeFileSync(invalidWorkflowPath, JSON.stringify([
    { action: "type", selector: "input[name=q]" },
  ]), "utf8");
  const validateFail = await runCli(["workflow", "run", "--file", invalidWorkflowPath, "--validate-only"]);
  assert(validateFail.valid === false, "workflow --validate-only did not return valid: false for invalid workflow");
  assert(typeof validateFail.error === "string", "workflow --validate-only did not return error string");
  assert(validateFail.stepIndex === 0, "workflow --validate-only did not return correct stepIndex");
  const workflowDiagnoseFail = await runCli(["workflow", "diagnose", "--file", invalidWorkflowPath]);
  assert(workflowDiagnoseFail.ok === false, "workflow diagnose did not reject invalid workflow");
  assert(workflowDiagnoseFail.blockers.includes("workflow-invalid"), "workflow diagnose did not expose invalid blocker");

  // observe — result includes suggestedNext appended by CLI
  const observeResult = await runCli(["observe", "--profile", "researcher", "--limit", "5"]);
  assert(Array.isArray(observeResult.suggestedNext), "observe did not append suggestedNext");
  assert(observeResult.suggestedNext.some((s) => s.includes("stuck")), "observe suggestedNext did not include stuck command");

  // backend status — calls browser_backend_status, returns normalized boundary JSON
  const backendStatusResult = await runCli(["backend", "status"]);
  assert(backendStatusResult.schema === "agent-browser.backend.status.v1", "backend status returned wrong schema");
  assert(typeof backendStatusResult.workerUrl === "string", "backend status missing workerUrl");
  assert(backendStatusResult.backend === "managed", "backend status did not detect managed backend");
  assert(backendStatusResult.runtimeIdentity?.stableAgentName === "Managed Browser", "backend status missing stable runtime identity");
  assert(backendStatusResult.runtimeIdentity?.physicalBrowser === "CloakBrowser", "backend status missing physical browser name");
  assert(backendStatusResult.runtimeIdentity?.displayName?.includes("Managed Browser over CloakBrowser"), "backend status did not expose agent-readable backend identity");
  assert(backendStatusResult.backendStatus?.managed?.profilePortSummary?.ok === true, "backend status did not expose canonical profile port summary");
  assert(typeof backendStatusResult.boundaries === "object", "backend status missing boundaries");
  assert(typeof backendStatusResult.boundaries.managed === "string", "backend status missing boundaries.managed");
  assert(typeof backendStatusResult.boundaries.personal === "string", "backend status missing boundaries.personal");
  assert(typeof backendStatusResult.boundaries.warning === "string", "backend status missing boundaries.warning");
  assert(Array.isArray(backendStatusResult.suggestedNext), "backend status missing suggestedNext");
  assert(backendStatusResult.suggestedNext.length > 0, "backend status suggestedNext is empty");
  assert(backendStatusResult.backendRouteSummary.state === "managed-ready", "backend route summary did not classify managed-ready");
  assert(backendStatusResult.backendRouteSummary.recommendedBackend === "managed", "backend route summary lost recommended backend");
  const backendStatusReq = requests.find((entry) => entry.tool === "browser_backend_status");
  assert(backendStatusReq !== undefined, "backend status did not call browser_backend_status");
  const backendPersonalIntent = await runCli(["backend", "status", "--intent", "personal-current-tab"]);
  assert(backendPersonalIntent.recommendedBackend === "personal", "backend status did not recommend personal for personal-current-tab intent");
  assert(backendPersonalIntent.suggestedNext.some((entry) => entry.includes("Personal Chrome extension bridge")), "backend status did not explain personal bridge boundary");
  assert(backendPersonalIntent.backendRouteSummary.state === "personal-bridge-needed", "backend route summary did not classify personal bridge needed");
  assert(backendPersonalIntent.backendRouteSummary.forbiddenFirstSteps.some((entry) => entry.includes("clone cookies")), "backend route summary did not warn against cookie cloning first");
  fixturePersonalOk = true;
  const backendPersonalConnected = await runCli(["backend", "status", "--intent", "personal-current-tab"]);
  assert(backendPersonalConnected.backendRouteSummary.state === "personal-ready", "backend route summary did not classify connected personal bridge as ready");
  assert(backendPersonalConnected.backendRouteSummary.currentBackend === "personal", "backend route summary did not expose personal current backend when bridge is connected");
  fixturePersonalOk = false;
  const backendTakeoverIntent = await runCli(["backend", "status", "--intent", "takeover-current-chrome"]);
  assert(backendTakeoverIntent.recommendedBackend === "personal", "backend status did not recommend personal for takeover-current-chrome intent");
  assert(backendTakeoverIntent.takeoverBoundary?.managedPath?.includes("Not applicable"), "backend status did not expose managed takeover boundary");
  assert(backendTakeoverIntent.suggestedNext.some((entry) => entry.includes("personal:chrome")), "backend status did not suggest personal bridge startup");
  assert(backendTakeoverIntent.backendRouteSummary.nextCommands.some((entry) => entry.includes("personal:chrome")), "backend route summary did not suggest personal bridge command");
  const backendTwoAccountIntent = await runCli(["backend", "status", "--intent", "two-account"]);
  assert(backendTwoAccountIntent.recommendedBackend === "managed", "backend status did not recommend managed for two-account intent");
  assert(backendTwoAccountIntent.suggestedNext.some((entry) => entry.includes("profile registry validate")), "backend status did not suggest profile registry validation for two-account intent");
  assert(backendTwoAccountIntent.backendRouteSummary.nextCommands.some((entry) => entry.includes("profile isolation check")), "backend route summary did not suggest profile isolation check");
  const backendAuthIntent = await runCli(["backend", "status", "--intent", "auth"]);
  assert(backendAuthIntent.recommendedBackend === "managed", "backend status did not recommend managed for auth intent");
  assert(backendAuthIntent.suggestedNext.some((entry) => entry.includes("auth bootstrap start")), "backend status did not suggest auth bootstrap for auth intent");
  const backendReplayIntent = await runCli(["backend", "status", "--intent", "replay"]);
  assert(backendReplayIntent.recommendedBackend === "managed", "backend status did not recommend managed for replay intent");
  assert(backendReplayIntent.suggestedNext.some((entry) => entry.includes("repeater open")), "backend status did not suggest repeater for replay intent");
  const backendEvidenceIntent = await runCli(["backend", "status", "--intent", "evidence"]);
  assert(backendEvidenceIntent.suggestedNext.some((entry) => entry.includes("pack <url>")), "backend status did not suggest pack for evidence intent");

  // profile doctor — calls profile_list + browser_tabs, returns normalized profile state
  const profileDoctorResult = await runCli(["profile", "doctor", "--profile", "researcher"]);
  assert(profileDoctorResult.schema === "agent-browser.profile.doctor.v1", "profile doctor returned wrong schema");
  assert(profileDoctorResult.profile === "researcher", "profile doctor lost profile name");
  assert(typeof profileDoctorResult.workerUrl === "string", "profile doctor missing workerUrl");
  assert(typeof profileDoctorResult.profileState === "object", "profile doctor missing profileState");
  assert(profileDoctorResult.profileState.found === true, "profile doctor did not find researcher profile");
  assert(typeof profileDoctorResult.attachedTabs === "object", "profile doctor missing attachedTabs");
  assert(typeof profileDoctorResult.boundaries === "object", "profile doctor missing boundaries");
  assert(Array.isArray(profileDoctorResult.suggestedNext), "profile doctor missing suggestedNext");
  assert(profileDoctorResult.suggestedNext.some((s) => s.includes("researcher")), "profile doctor suggestedNext missing profile name");
  const tabsReq = requests.find((entry) => entry.tool === "browser_tabs" && entry.payload.profile === "researcher");
  assert(tabsReq !== undefined, "profile doctor did not call browser_tabs with profile");

  // compare --left --right (file-based)
  const baselineFile = join(tempDir, "baseline.json");
  const variantFile = join(tempDir, "variant.json");
  writeFileSync(baselineFile, JSON.stringify({
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "user", id: 1 }),
  }), "utf8");
  writeFileSync(variantFile, JSON.stringify({
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "admin", id: 1, permissions: ["delete"] }),
  }), "utf8");
  const fileCompare = await runCli(["compare", "--left", baselineFile, "--right", variantFile]);
  assert(fileCompare.schema === "agent-browser.compare.v1", "compare returned wrong schema");
  assert(fileCompare.diff.statusCode.changed === false, "compare status should not have changed");
  assert(fileCompare.diff.jsonTopLevelKeys.applicable === true, "compare did not apply JSON key diff");
  assert(fileCompare.diff.jsonTopLevelKeys.added.includes("permissions"), "compare did not detect added key");
  assert(typeof fileCompare.boundary === "string", "compare missing boundary");
  assert(fileCompare.artifactPaths.left === baselineFile, "compare missing left artifact path");

  // compare by requestIds (server-backed)
  const reqCompare = await runCli(["compare", "req-1", "req-2", "--profile", "researcher"]);
  assert(reqCompare.schema === "agent-browser.compare.v1", "compare by requestId returned wrong schema");
  assert(reqCompare.requestIds.baseline === "req-1", "compare by requestId lost baseline id");
  assert(reqCompare.requestIds.variant === "req-2", "compare by requestId lost variant id");
  assert(reqCompare.diff.jsonTopLevelKeys.added.includes("permissions"), "compare by requestId did not detect added key");

  // replay now returns stable schema + compare hint
  const replayWithSchema = await runCli(["replay", "req-1", "--profile", "researcher", "--method", "POST", "--json-body", "{\"role\":\"admin\"}"]);
  assert(replayWithSchema.schema === "agent-browser.replay.v1", "replay did not return stable schema");
  assert(replayWithSchema.replaySummary.status === 403, "replay did not expose response status summary");
  assert(replayWithSchema.replaySummary.bodyLength > 0, "replay did not expose response body length");
  assert(replayWithSchema.replaySummary.hasBody === true, "replay did not expose body presence");
  assert(typeof replayWithSchema.next.compare === "string", "replay missing compare next hint");
  assert(typeof replayWithSchema.boundary === "string", "replay missing boundary");

  // replay-batch returns stable schema + compare hint
  const replayBatchWithSchema = await runCli(["replay-batch", "req-1", "--profile", "researcher", "--variants-json", "[{\"label\":\"baseline\"},{\"label\":\"admin\",\"json\":{\"role\":\"admin\"}}]"]);
  assert(replayBatchWithSchema.schema === "agent-browser.replay-batch.v1", "replay-batch did not return stable schema");
  assert(replayBatchWithSchema.batchSummary.variantCount === 2, "replay-batch did not summarize variant count");
  assert(replayBatchWithSchema.batchSummary.statusCodes.includes(200) && replayBatchWithSchema.batchSummary.statusCodes.includes(403), "replay-batch did not summarize status codes");
  assert(replayBatchWithSchema.batchSummary.summaries[1].label === "admin", "replay-batch did not preserve variant label");
  assert(typeof replayBatchWithSchema.next.compare === "string", "replay-batch missing compare next hint");

  console.log("Agent browser CLI smoke passed");
} finally {
  server.close();
  rmSync(tempDir, { recursive: true, force: true });
}
