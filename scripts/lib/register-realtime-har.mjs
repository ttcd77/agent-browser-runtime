// register-realtime-har.mjs — Realtime (WebSocket/SSE) channel + HAR export tool family.
// Extracted verbatim from agent-cdp-server.mjs registerStandaloneBrowserTools (behavior-preserving).
// Dependencies are injected via deps; pure/lib helpers are imported directly.
import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { toolResult } from "./result-format.mjs";
import { fileSha256 } from "./evidence-artifacts.mjs";
import { buildNetworkTimeline } from "./f12-view.mjs";
import { buildInitiatorSummary } from "./initiator-summary.mjs";
import { analyzeHarCompleteness } from "./network-har.mjs";

export function registerRealtimeHarTools(deps) {
  const { tools, profileRegistry, resolveProfile, maybeRoutePersonal } = deps;

  tools.set("profile_realtime_log", {
    name: "profile_realtime_log",
    description: "Return F12 Network real-time channel evidence: WebSocket lifecycle/frames and EventSource/SSE messages.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        requestId: { type: "string", description: "Filter to a specific WebSocket/SSE request ID." },
        url_contains: { type: "string", description: "Filter channels whose URL contains this substring (case-insensitive)." },
        payload_contains: { type: "string", description: "Filter to channels that have at least one frame containing this string." },
        direction: { type: "string", enum: ["send", "receive"], description: "Filter frames by direction: send or receive." },
        limit: { type: "number", description: "Max channels and frames to return. Default: 100." },
        maxPayloadChars: { type: "number", description: "Max characters per frame payload. Default: 2000." },
        save: { type: "boolean", description: "Save the report as a JSON file to the evidence directory." },
        path: { type: "string", description: "Absolute path for the saved report. Defaults to evidence/realtime/<timestamp>-realtime-log.json." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("profile_realtime_log", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const limit = typeof params?.limit === "number" ? Math.min(Math.max(1, params.limit), 10_000) : 100;
      const maxPayloadChars = typeof params?.maxPayloadChars === "number" ? Math.min(Math.max(1, params.maxPayloadChars), 1_000_000) : 2000;
      const needle = params?.url_contains ? String(params.url_contains).toLowerCase() : null;
      const payloadNeedle = params?.payload_contains ? String(params.payload_contains).toLowerCase() : null;
      const requestedId = params?.requestId ? String(params.requestId) : null;
      const direction = params?.direction ? String(params.direction).toLowerCase() : null;
      const frameMatchesPayload = (frame) => {
        if (!payloadNeedle) return true;
        return String(frame?.payloadData || "").toLowerCase().includes(payloadNeedle);
      };
      const truncatePayload = (value) => {
        if (typeof value !== "string") return value ?? null;
        return value.length > maxPayloadChars ? `${value.slice(0, maxPayloadChars)}...[truncated ${value.length - maxPayloadChars} chars]` : value;
      };
      let websockets = profileRegistry.readWebSockets(profile.name);
      if (requestedId) websockets = websockets.filter((socket) => String(socket.requestId) === requestedId);
      if (needle) websockets = websockets.filter((socket) => String(socket.url || "").toLowerCase().includes(needle));
      if (payloadNeedle) websockets = websockets.filter((socket) => (socket.frames || []).some(frameMatchesPayload));
      websockets = websockets.slice(-limit).map((socket) => {
        const originalFrames = socket.frames || [];
        const frames = originalFrames
          .filter((frame) => !direction || String(frame.direction || "").toLowerCase() === direction)
          .filter(frameMatchesPayload)
          .slice(-limit)
          .map((frame) => ({
            ...frame,
            payloadData: truncatePayload(frame.payloadData),
            truncated: typeof frame.payloadData === "string" && frame.payloadData.length > maxPayloadChars,
          }));
        return {
          requestId: socket.requestId,
          url: socket.url,
          status: socket.status,
          statusText: socket.statusText,
          requestHeaders: socket.requestHeaders,
          responseHeaders: socket.responseHeaders,
          createdAt: socket.createdAt,
          updatedAt: socket.updatedAt,
          closedAt: socket.closedAt,
          errorMessage: socket.errorMessage,
          frameCount: originalFrames.length,
          matchingFrameCount: originalFrames.filter((frame) => (!direction || String(frame.direction || "").toLowerCase() === direction) && frameMatchesPayload(frame)).length,
          returnedFrameCount: frames.length,
          frames,
        };
      });
      let eventSources = profileRegistry.readEventSources(profile.name);
      if (requestedId) eventSources = eventSources.filter((entry) => String(entry.requestId) === requestedId);
      if (payloadNeedle) eventSources = eventSources.filter((entry) => String(entry.data || "").toLowerCase().includes(payloadNeedle));
      eventSources = eventSources.slice(-limit).map((entry) => ({
        ...entry,
        data: truncatePayload(entry.data),
        truncated: typeof entry.data === "string" && entry.data.length > maxPayloadChars,
      }));
      const websocketFrameCount = websockets.reduce((sum, socket) => sum + (socket.frameCount || 0), 0);
      const matchingWebsocketFrameCount = websockets.reduce((sum, socket) => sum + (socket.matchingFrameCount || 0), 0);
      const recommendedDrilldowns = [];
      for (const socket of websockets.slice(0, 10)) {
        if (!socket.requestId) continue;
        recommendedDrilldowns.push({
          label: socket.url ? `Inspect realtime channel ${socket.url}` : `Inspect realtime channel ${socket.requestId}`,
          tool: "profile_realtime_log",
          input: {
            profile: profile.name,
            requestId: socket.requestId,
            ...(payloadNeedle ? { payload_contains: params.payload_contains } : {}),
            ...(direction ? { direction: params.direction } : {}),
          },
          why: "Narrow WebSocket/SSE evidence by concrete channel id without loading unrelated realtime traffic.",
        });
      }
      const report = {
        backend: "managed-cdp",
        profile: profile.name,
        evidenceDir: profile.evidenceDir,
        capture: profileRegistry.getCapture(profile.name),
        websocketCount: websockets.length,
        websocketFrameCount,
        matchingWebsocketFrameCount,
        eventSourceMessageCount: eventSources.length,
        filters: {
          requestId: requestedId,
          url_contains: params?.url_contains || null,
          payload_contains: params?.payload_contains || null,
          direction: params?.direction || null,
        },
        recommendedDrilldowns,
        websockets,
        eventSources,
        boundaries: [
          "Realtime evidence is limited to WebSocket/SSE activity observed after capture/listener attachment.",
          "Payload filtering is literal string matching only; it does not classify protocol messages or security impact.",
        ],
      };
      if (params?.save) {
        const reportPath = params?.path || join(profile.evidenceDir, "realtime", `${Date.now()}-realtime-log.json`);
        mkdirSync(dirname(reportPath), { recursive: true });
        writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
        report.reportPath = reportPath;
        report.reportBytes = statSync(reportPath).size;
        report.reportSha256 = fileSha256(reportPath);
      }
      return toolResult(report);
    },
  });

  tools.set("profile_export_har", {
    name: "profile_export_har",
    description: "Export profile-local managed browser network traffic as a HAR-like object.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        limit: { type: "number", description: "Max traffic records to export. Default: 1000." },
        includeBodies: { type: "boolean", description: "Include response bodies in the HAR entries. Default: false." },
        maxBodyBytes: { type: "number", description: "Max bytes per response body when includeBodies=true. Default: 200000." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("profile_export_har", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const rows = profileRegistry.queryTraffic(profile.name, { limit: typeof params?.limit === "number" ? Math.min(Math.max(1, params.limit), 10_000) : 1000 });
      const includeBodies = params?.includeBodies === true;
      const maxBodyBytes = typeof params?.maxBodyBytes === "number" ? Math.min(Math.max(1, params.maxBodyBytes), 10_000_000) : 200000;
      const responseContent = (request) => {
        const content = {
          size: request.encodedDataLength ?? request.bodyBytes ?? -1,
          mimeType: request.mimeType || "",
        };
        if (!includeBodies) return content;
        if (typeof request.bodyText === "string") {
          const text = request.bodyText.slice(0, maxBodyBytes);
          const fullBytes = Buffer.byteLength(request.bodyText, "utf8");
          return {
            ...content,
            text,
            _bodyIncluded: true,
            _bodySource: "captured-inline-text",
            _bodyBytes: fullBytes,
            _bodyTruncated: fullBytes > maxBodyBytes,
          };
        }
        if (request.bodyPath) {
          try {
            const body = readFileSync(request.bodyPath);
            const limited = body.subarray(0, maxBodyBytes);
            return {
              ...content,
              text: limited.toString("base64"),
              encoding: "base64",
              _bodyIncluded: true,
              _bodySource: "captured-body-file",
              _bodyPath: request.bodyPath,
              _bodyBytes: body.length,
              _bodyTruncated: body.length > maxBodyBytes,
            };
          } catch (error) {
            return {
              ...content,
              _bodyIncluded: false,
              _bodyError: String(error?.message || error),
            };
          }
        }
        return {
          ...content,
          _bodyIncluded: false,
          _bodyUnavailable: true,
        };
      };
      const entries = rows.map((request) => {
        const timelineRow = buildNetworkTimeline([request], 1)[0] || {};
        return {
        startedDateTime: request.timestamp,
        time: timelineRow.durationMs ?? -1,
        request: {
          method: request.method || "",
          url: request.url || "",
          httpVersion: request.protocol || "",
          headers: Object.entries(request.requestHeaders || {}).map(([name, value]) => ({ name, value: String(value) })),
          queryString: (() => {
            try { return [...new URL(request.url).searchParams.entries()].map(([name, value]) => ({ name, value })); }
            catch { return []; }
          })(),
          cookies: [],
          headersSize: -1,
          bodySize: request.postDataLength ?? -1,
          ...(request.postData ? { postData: { mimeType: request.requestHeaders?.["Content-Type"] || request.requestHeaders?.["content-type"] || "", text: request.postData } } : {}),
        },
        response: {
          status: request.status || 0,
          statusText: request.statusText || "",
          httpVersion: request.protocol || "",
          headers: Object.entries(request.responseHeaders || {}).map(([name, value]) => ({ name, value: String(value) })),
          cookies: [],
          content: responseContent(request),
          redirectURL: request.responseHeaders?.location || request.responseHeaders?.Location || "",
          headersSize: -1,
          bodySize: request.encodedDataLength ?? request.bodyBytes ?? -1,
        },
        cache: {
          fromDiskCache: Boolean(request.fromDiskCache),
          fromServiceWorker: Boolean(request.fromServiceWorker),
        },
        timings: request.timing ? {
          blocked: request.timing.proxyStart >= 0 ? request.timing.proxyStart : 0,
          dns: request.timing.dnsEnd >= 0 && request.timing.dnsStart >= 0 ? request.timing.dnsEnd - request.timing.dnsStart : -1,
          connect: request.timing.connectEnd >= 0 && request.timing.connectStart >= 0 ? request.timing.connectEnd - request.timing.connectStart : -1,
          ssl: request.timing.sslEnd >= 0 && request.timing.sslStart >= 0 ? request.timing.sslEnd - request.timing.sslStart : -1,
          send: request.timing.sendEnd >= 0 && request.timing.sendStart >= 0 ? request.timing.sendEnd - request.timing.sendStart : -1,
          wait: request.timing.receiveHeadersEnd >= 0 && request.timing.sendEnd >= 0 ? request.timing.receiveHeadersEnd - request.timing.sendEnd : -1,
          receive: request.finishedAt && request.responseTimestamp ? Math.max(0, new Date(request.finishedAt).getTime() - new Date(request.responseTimestamp).getTime()) : -1,
        } : { send: -1, wait: -1, receive: -1 },
        _requestId: request.requestId,
        _resourceType: request.resourceType,
        _frameId: request.frameId,
        _initiator: request.initiator,
        _initiatorSummary: buildInitiatorSummary(request.initiator || null),
        _timingPhases: timelineRow.phases || null,
        _durationMs: timelineRow.durationMs ?? null,
        _timingSource: request.timing ? "cdp-network-timing" : "wall-clock-capture",
        _securityDetails: request.securityDetails,
        _bodyReadable: Boolean(request.bodyReadable || request.bodyText || request.bodyPath),
      };
      });
      const bodyIndex = entries.map((entry) => ({
        requestId: entry._requestId || null,
        url: entry.request?.url || "",
        method: entry.request?.method || "",
        status: entry.response?.status ?? null,
        mimeType: entry.response?.content?.mimeType || "",
        bodyReadable: Boolean(entry._bodyReadable),
        bodyIncluded: entry.response?.content?._bodyIncluded === true,
        bodySource: entry.response?.content?._bodySource || null,
        bodyBytes: entry.response?.content?._bodyBytes ?? null,
        contentSize: entry.response?.content?.size ?? -1,
        bodySize: entry.response?.bodySize ?? -1,
        bodyTruncated: entry.response?.content?._bodyTruncated === true,
        bodyUnavailable: entry.response?.content?._bodyUnavailable === true,
        bodyError: entry.response?.content?._bodyError || null,
        bodyPath: entry.response?.content?._bodyPath || null,
      }));
      return toolResult({
        profile: profile.name,
        includeBodies,
        maxBodyBytes,
        bodyIndex,
        bodyIndexSummary: {
          entryCount: bodyIndex.length,
          readableCount: bodyIndex.filter((row) => row.bodyReadable).length,
          includedCount: bodyIndex.filter((row) => row.bodyIncluded).length,
          fileBackedCount: bodyIndex.filter((row) => row.bodyPath).length,
          truncatedCount: bodyIndex.filter((row) => row.bodyTruncated).length,
          unavailableCount: bodyIndex.filter((row) => row.bodyUnavailable).length,
        },
        har: {
          log: {
            version: "1.2",
            creator: { name: "Agent Browser Runtime", version: "0.1.0" },
            pages: [],
            entries,
          },
        },
      });
    },
  });

  tools.set("profile_save_har", {
    name: "profile_save_har",
    description: "Export profile-local managed browser network traffic as a HAR-like file and return the saved path.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        limit: { type: "number", description: "Max traffic records to export. Default: 1000." },
        path: { type: "string", description: "Absolute path for the HAR file. Defaults to evidence/har/<timestamp>-network.har." },
        includeBodies: { type: "boolean", description: "Include response bodies in the HAR. Default: false." },
        maxBodyBytes: { type: "number", description: "Max bytes per response body when includeBodies=true. Default: 200000." },
      },
    },
    async execute(id, params) {
      const routed = await maybeRoutePersonal("profile_save_har", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const result = await tools.get("profile_export_har").execute(id, params);
      const payload = JSON.parse(result.content?.[0]?.text || "{}");
      const harText = `${JSON.stringify(payload.har, null, 2)}\n`;
      const harPath = params?.path || join(profile.evidenceDir, "har", `${Date.now()}-network.har`);
      mkdirSync(dirname(harPath), { recursive: true });
      writeFileSync(harPath, harText, "utf8");
      return toolResult({
        profile: profile.name,
        harPath,
        harBytes: Buffer.byteLength(harText, "utf8"),
        entryCount: payload.har?.log?.entries?.length || 0,
        bodyIndex: payload.bodyIndex || [],
        bodyIndexSummary: payload.bodyIndexSummary || null,
      });
    },
  });

  tools.set("profile_har_completeness", {
    name: "profile_har_completeness",
    description: "Report objective HAR evidence completeness for captured traffic: bodies, truncation, timing phases, redirects, and security details.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to server default profile." },
        limit: { type: "number", description: "Max traffic records to analyze. Default: 1000." },
        includeBodies: { type: "boolean", description: "Include response bodies in the analysis. Default: false." },
        maxBodyBytes: { type: "number", description: "Max bytes per response body. Default: 200000." },
        maxRows: { type: "number", description: "Max rows in the completeness report. Default: 50." },
        save: { type: "boolean", description: "Save the completeness report to disk. Default: true." },
        path: { type: "string", description: "Absolute path for the saved report. Defaults to evidence/har/<timestamp>-har-completeness.json." },
      },
    },
    async execute(id, params) {
      const routed = await maybeRoutePersonal("profile_har_completeness", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const exportResult = await tools.get("profile_export_har").execute(id, {
        ...params,
        includeBodies: params?.includeBodies === true,
      });
      const payload = JSON.parse(exportResult.content?.[0]?.text || "{}");
      const report = {
        backend: "managed-cdp",
        profile: profile.name,
        evidenceDir: profile.evidenceDir,
        ...analyzeHarCompleteness(payload.har, {
          includeBodies: params?.includeBodies === true,
          maxBodyBytes: typeof params?.maxBodyBytes === "number" ? Math.min(Math.max(1, params.maxBodyBytes), 10_000_000) : 200000,
          maxRows: typeof params?.maxRows === "number" ? Math.min(Math.max(1, params.maxRows), 10_000) : 50,
        }),
      };
      if (params?.save !== false) {
        const outPath = params?.path || join(profile.evidenceDir, "har", `${Date.now()}-har-completeness.json`);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
        report.reportPath = outPath;
        report.reportBytes = statSync(outPath).size;
      }
      return toolResult(report);
    },
  });
}
