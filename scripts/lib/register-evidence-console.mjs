// register-evidence-console.mjs — Console panel + request/traffic detail evidence tool family.
// Extracted verbatim from agent-cdp-server.mjs registerStandaloneBrowserTools (behavior-preserving).
// Dependencies are injected via deps; pure/lib helpers are imported directly.
import { toolResult } from "./result-format.mjs";
import { buildInitiatorSummary } from "./initiator-summary.mjs";
import { buildInitiatorSourceContext, sourceContextLines } from "./f12-view.mjs";
import { buildRequestDetail } from "./inspect-readiness.mjs";

export function registerEvidenceConsoleTools(deps) {
  const {
    tools,
    profileRegistry,
    sleep,
    resolveProfile,
    withManagedPageClient,
    maybeRoutePersonal,
  } = deps;

  tools.set("browser_console_log", {
    name: "browser_console_log",
    description: "Capture Console panel events, Log entries, exceptions, stack traces, and parsed script metadata for the current profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        tabId: { type: "string", description: "CDP tab ID. Defaults to the profile's current tab." },
        reload: { type: "boolean", description: "Reload the page to capture fresh console output. Default: false." },
        ignoreCache: { type: "boolean", description: "Bypass cache on reload. Default: false." },
        waitMs: { type: "number", description: "Wait time in ms after page load to collect events. Default: 8000." },
        limit: { type: "number", description: "Max events per category to return. Default: 100." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_console_log", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const waitMs = typeof params?.waitMs === "number" ? Math.min(Math.max(0, params.waitMs), 30_000) : 1000;
      const limit = typeof params?.limit === "number" ? Math.min(Math.max(1, params.limit), 10_000) : 100;
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        const MAX_CONSOLE_BUFFER = 1000;
        const consoleEvents = [];
        const exceptions = [];
        const logEntries = [];
        const scripts = new Map();
        const cleanups = [];
        const on = (register, handler) => {
          const cleanup = register(handler);
          if (typeof cleanup === "function") cleanups.push(cleanup);
        };
        await client.Runtime.enable();
        await client.Log.enable().catch(() => {});
        await client.Debugger.enable().catch(() => {});
        await client.Page.enable();
        on((cb) => client.Runtime.consoleAPICalled(cb), (event) => {
          if (consoleEvents.length < MAX_CONSOLE_BUFFER) {
            consoleEvents.push({
              timestamp: new Date().toISOString(),
              type: event.type,
              args: (event.args || []).map((arg) => arg.value ?? arg.description ?? arg.type),
              stackTrace: event.stackTrace,
              executionContextId: event.executionContextId,
            });
          }
        });
        on((cb) => client.Runtime.exceptionThrown(cb), (event) => {
          if (exceptions.length < MAX_CONSOLE_BUFFER) {
            exceptions.push({
              timestamp: new Date().toISOString(),
              exceptionId: event.exceptionId,
              timestampRaw: event.timestamp,
              details: event.exceptionDetails,
            });
          }
        });
        on((cb) => client.Log.entryAdded(cb), (event) => {
          if (logEntries.length < MAX_CONSOLE_BUFFER) {
            logEntries.push({ timestamp: new Date().toISOString(), entry: event.entry });
          }
        });
        on((cb) => client.Debugger.scriptParsed(cb), (event) => {
          scripts.set(event.scriptId, {
            scriptId: event.scriptId,
            url: event.url,
            startLine: event.startLine,
            startColumn: event.startColumn,
            endLine: event.endLine,
            endColumn: event.endColumn,
            executionContextId: event.executionContextId,
            hash: event.hash,
            sourceMapURL: event.sourceMapURL,
            isModule: event.isModule,
            length: event.length,
          });
        });
        if (params?.reload) {
          await client.Page.reload({ ignoreCache: Boolean(params?.ignoreCache) });
        }
        await sleep(waitMs);
        for (const cleanup of cleanups) cleanup();
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          counts: {
            console: consoleEvents.length,
            exceptions: exceptions.length,
            logs: logEntries.length,
            scripts: scripts.size,
          },
          console: consoleEvents.slice(-limit),
          exceptions: exceptions.slice(-limit),
          logs: logEntries.slice(-limit),
          scripts: [...scripts.values()].slice(-limit),
        };
      }));
    },
  });

  tools.set("browser_console_source_context", {
    name: "browser_console_source_context",
    description: "Return source lines around a Console/exception stack frame script location.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        tabId: { type: "string", description: "CDP tab ID. Defaults to the profile's current tab." },
        scriptId: { type: "string", description: "CDP script ID from a stack frame or browser_sources_list." },
        urlContains: { type: "string", description: "Fallback: find a script whose URL contains this substring when scriptId is not provided." },
        lineNumber: { type: "number", description: "0-based line number from the stack frame. Default: 0." },
        columnNumber: { type: "number", description: "0-based column number from the stack frame." },
        contextLines: { type: "number", description: "Lines of source context to include before and after the target line. Default: 5." },
        reload: { type: "boolean", description: "Reload the page to re-capture scripts. Default: false." },
        waitMs: { type: "number", description: "Wait time in ms after reload. Default: 8000." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_console_source_context", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const lineNumber = typeof params?.lineNumber === "number" ? params.lineNumber : 0;
      const contextLines = typeof params?.contextLines === "number" ? Math.min(Math.max(1, params.contextLines), 500) : 5;
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        const scripts = new Map();
        await client.Debugger.enable();
        client.Debugger.scriptParsed((event) => {
          scripts.set(event.scriptId, {
            scriptId: event.scriptId,
            url: event.url,
            startLine: event.startLine,
            startColumn: event.startColumn,
            endLine: event.endLine,
            endColumn: event.endColumn,
            sourceMapURL: event.sourceMapURL,
            isModule: event.isModule,
            length: event.length,
          });
        });
        if (params?.reload) {
          await client.Page.enable();
          await client.Page.reload({ ignoreCache: false });
          await sleep(typeof params?.waitMs === "number" ? Math.min(Math.max(0, params.waitMs), 30_000) : 1000);
        } else {
          await sleep(typeof params?.waitMs === "number" ? Math.min(Math.max(0, params.waitMs), 30_000) : 300);
        }
        let script = params?.scriptId ? scripts.get(String(params.scriptId)) : null;
        let source = null;
        if (params?.scriptId) {
          source = await client.Debugger.getScriptSource({ scriptId: String(params.scriptId) }).catch(() => null);
          if (source && !script) {
            script = { scriptId: String(params.scriptId), url: null };
          }
        }
        if (!script && params?.urlContains) {
          const needle = String(params.urlContains).toLowerCase();
          script = [...scripts.values()].find((entry) => String(entry.url || "").toLowerCase().includes(needle)) || null;
        }
        if (!script) throw new Error("matching script not found");
        if (!source) {
          source = await client.Debugger.getScriptSource({ scriptId: script.scriptId });
        }
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          script,
          location: {
            scriptId: script.scriptId,
            url: script.url,
            lineNumber,
            columnNumber: typeof params?.columnNumber === "number" ? params.columnNumber : null,
          },
          contextLines,
          lines: sourceContextLines(source.scriptSource || "", lineNumber, contextLines),
        };
      }));
    },
  });

  tools.set("profile_traffic_get", {
    name: "profile_traffic_get",
    description: "Get one captured traffic record for a managed profile. If profile is omitted, uses the server default profile.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        requestId: { type: "string", description: "Required. Request ID from profile_traffic_query." },
      },
      required: ["requestId"],
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("profile_traffic_get", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const entry = profileRegistry.getTraffic(profile.name, params?.requestId);
      return toolResult({
        profile: profile.name,
        evidenceDir: profile.evidenceDir,
        entry,
        bodyPath: entry?.bodyPath,
        bodyText: entry?.bodyText,
        bodyBase64Encoded: entry?.bodyBase64Encoded,
        ...(entry ? {} : { error: "request_not_found", requestId: params?.requestId }),
      });
    },
  });

  tools.set("profile_request_detail", {
    name: "profile_request_detail",
    description: "Return F12 request-detail evidence for one captured managed browser request: headers, cookies, timing, initiator, redirects, and body availability.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        requestId: { type: "string", description: "Required. Request ID from profile_traffic_query." },
      },
      required: ["requestId"],
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("profile_request_detail", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const entry = profileRegistry.getTraffic(profile.name, params?.requestId);
      let cookies = [];
      let initiatorSourceContext = null;
      if (entry?.url) {
        const detailProbe = await withManagedPageClient(profile, profile.tabId, async (client) => {
          await client.Network.enable().catch(() => {});
          await client.Debugger.enable().catch(() => {});
          const result = await client.Network.getCookies({ urls: [entry.url] }).catch(() => ({ cookies: [] }));
          const initiatorSummary = buildInitiatorSummary(entry.initiator || null);
          return {
            cookies: result.cookies || [],
            initiatorSourceContext: await buildInitiatorSourceContext(
              (scriptId) => client.Debugger.getScriptSource({ scriptId }),
              initiatorSummary,
              5,
            ),
          };
        }).catch(() => ({ cookies: [], initiatorSourceContext: null }));
        cookies = detailProbe.cookies || [];
        initiatorSourceContext = detailProbe.initiatorSourceContext || null;
      }
      const detail = buildRequestDetail(entry, cookies);
      if (detail) detail.initiatorSourceContext = initiatorSourceContext;
      return toolResult({
        profile: profile.name,
        evidenceDir: profile.evidenceDir,
        requestId: params?.requestId,
        detail,
        ...(entry ? {} : { error: "request_not_found" }),
      });
    },
  });

  tools.set("profile_request_payload", {
    name: "profile_request_payload",
    description: "Get request payload/postData for a captured managed browser requestId when CDP still has it available.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        requestId: { type: "string", description: "Required. Request ID from profile_traffic_query." },
      },
      required: ["requestId"],
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("profile_request_payload", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      return toolResult(await withManagedPageClient(profile, profile.tabId, async (client, target) => {
        await client.Network.enable({
          maxTotalBufferSize: 100000000,
          maxResourceBufferSize: 50000000,
          maxPostDataSize: 50000000,
        });
        const entry = profileRegistry.getTraffic(profile.name, params?.requestId);
        let payload = null;
        try {
          payload = await client.Network.getRequestPostData({ requestId: String(params.requestId) });
        } catch (_err) {
          // H-13: normalize CDP error (e.g. "Protocol error (Network.getRequestPostData): No resource...")
          // into a clean, structured response instead of leaking internal CDP method names.
          return {
            ok: false,
            error: "request_not_found",
            requestId: params?.requestId,
            profile: profile.name,
            tabId: target.id,
            hint: "The requestId is not known to CDP. Capture traffic first with browser_capture_start, or use profile_traffic_query to list valid request IDs.",
          };
        }
        return {
          profile: profile.name,
          tabId: target.id,
          request: entry,
          postData: payload.postData,
          postDataLength: payload.postData ? String(payload.postData).length : 0,
          redacted: false,
        };
      }));
    },
  });
}
