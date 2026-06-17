// register-snapshot-dom.mjs — Screenshot / snapshot / DOM-read tool family.
// Extracted verbatim from agent-cdp-server.mjs registerStandaloneBrowserTools (behavior-preserving).
// Dependencies are injected via deps; pure/lib helpers are imported directly.
// Page-injected *PageFunction names are injected and stringified via .toString(); their single
// definitions stay in the worker (never copied). browser_accessibility_snapshot is interleaved
// between two earlier register* calls in source; it joins this family as its own tools.set run.
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { toolResult, normalizeAccessibilityNode, normalizeProfileName } from "./result-format.mjs";
import { flattenFrameTree } from "./network-summary.mjs";
import { domSearchNodeSummary, frameIndexesFromOptions, normalizeForcedPseudoClasses } from "./dom-debug-utils.mjs";

// Never silently truncate page text returned to the agent.
// Content below this limit is inlined; above it is written to disk and a filePath is returned.
const TEXT_INLINE_THRESHOLD = 200_000;

export function registerSnapshotDomTools(deps) {
  const {
    tools,
    profileRegistry,
    managedPlaywrightDriver,
    resolveProfile,
    withManagedPageClient,
    resolveNodeIdForSelector,
    maybeRoutePersonal,
    runProfileAction,
    runManagedPlaywrightAction,
    selectInFramePageFunction,
    styleInFramePageFunction,
    domSearchFallbackPageFunction,
    frameAccessPageFunction,
    frameShadowBoundaryPageFunction,
    domMutationWatchPageFunction,
  } = deps;

  tools.set("browser_screenshot", {
    name: "browser_screenshot",
    description: "Capture a PNG screenshot from the current browser tab. Returns the base64 image as MCP image content so the agent can see it, plus writes a PNG file under the profile evidence directory. Pass includeImage: false to skip the image payload (e.g. for very large captures). Both managed and personal backends return top-level `path`, `mimeType`, and `bytes` fields; on personal backend `bytes` is the base64 character count (not raw PNG size).",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        tabId: { type: "string", description: "Optional. Tab id override." },
        path: { type: "string", description: "Optional. Absolute path to save the PNG file. Defaults to a timestamped file in the profile evidence directory." },
        fullPage: { type: "boolean", description: "If true, captures the full scrollable page. Default false (viewport only)." },
        includeImage: {
          type: "boolean",
          description: "When true (default), returns the PNG as base64 image content visible to the agent. When false, only writes to disk and returns metadata.",
        },
        maxImageBytes: {
          type: "number",
          description: "If set, only inline the image when the PNG is smaller than this many bytes. Default 4_000_000 (~4 MB).",
        },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_screenshot", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const capture = await runManagedPlaywrightAction({
        profile,
        eventType: "browser_screenshot",
        waitMs: 0,
        event: {
          path: params?.path,
          mimeType: "image/png",
          fullPage: params?.fullPage === true,
        },
        action: () => managedPlaywrightDriver.screenshot(profile.name, {
          ...params,
          path: params?.path || join(profile.evidenceDir, "screenshots", `${Date.now()}.png`),
        }),
      });
      const payload = {
        profile: profile.name,
        evidenceDir: profile.evidenceDir,
        ...capture.result,
        eventFile: capture.eventFile,
      };
      const includeImage = params?.includeImage !== false;
      const maxImageBytes = typeof params?.maxImageBytes === "number" ? Math.min(Math.max(1024, params.maxImageBytes), 10_000_000) : 4_000_000;
      const shouldInline = includeImage && payload.bytes <= maxImageBytes;
      if (includeImage && !shouldInline) {
        payload.imageInlined = false;
        payload.imageSkippedReason = `bytes ${payload.bytes} > maxImageBytes ${maxImageBytes}`;
      } else if (shouldInline) {
        payload.imageInlined = true;
      } else {
        payload.imageInlined = false;
      }
      const base64 = payload.base64;
      delete payload.base64;
      return toolResult(
        payload,
        shouldInline ? { image: { data: base64, mimeType: "image/png" } } : undefined,
      );
    },
  });

  tools.set("browser_snapshot", {
    name: "browser_snapshot",
    description: "Return title, URL, visible text, and basic input/button inventory from the current tab. Hidden/aria-hidden controls are filtered and duplicates collapsed to keep the payload small; pass maxControls to change the cap. When page text exceeds 200 000 characters the full text is saved to disk and the response includes filePath + originalLength — use the Read tool on filePath to get the complete text.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        tabId: { type: "string", description: "Optional. Tab id override." },
        maxControls: { type: "number", description: "Max controls to return after filtering/dedup. Default 40, max 200." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_snapshot", params);
      if (routed) return toolResult(routed);
      // H-04: profile must already exist — do not silently return about:blank for a phantom profile.
      if (params?.profile) {
        const requestedName = normalizeProfileName(params.profile);
        const existing = profileRegistry.listProfiles().find((p) => p.name === requestedName);
        if (!existing) {
          return toolResult({ ok: false, error: "profile_not_found", profile: requestedName, hint: "Create the profile first with profile_create or browser_open." });
        }
      }
      const profile = await resolveProfile(params?.profile);
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        const maxControls = typeof params?.maxControls === "number" ? Math.max(1, Math.min(200, params.maxControls)) : 40;
        // Root cause #4 (2026-06-03 reliability redesign): the control inventory
        // used to take querySelectorAll(...).slice(0,80) with NO filtering, so
        // hidden / aria-hidden controls and dozens of identical links (e.g. 80
        // language switchers) all landed in the payload and blew up tokens.
        // Now: skip not-displayed and aria-hidden (incl. inside an aria-hidden
        // ancestor) controls, dedup by tag+role+type+text+id, and report how
        // many were seen vs returned.
        const expression = `(() => {
          const isHidden = (el) => {
            if (el.closest('[aria-hidden="true"]')) return true;
            const s = getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return true;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 && r.height <= 0 && el.tagName !== 'INPUT') return true;
            return false;
          };
          const all = [...document.querySelectorAll("button,a,input,textarea,select,[role=button]")];
          const seen = new Set();
          const controls = [];
          let visibleCount = 0;
          for (const el of all) {
            if (isHidden(el)) continue;
            visibleCount++;
            const entry = {
              tag: el.tagName.toLowerCase(),
              text: (el.innerText || el.value || el.getAttribute("aria-label") || el.placeholder || "").trim().slice(0, 120),
              id: el.id || null,
              name: el.getAttribute("name"),
              type: el.getAttribute("type"),
              role: el.getAttribute("role"),
            };
            const key = [entry.tag, entry.role, entry.type, entry.id, entry.text].join("|");
            if (seen.has(key)) continue;
            seen.add(key);
            if (controls.length < ${maxControls}) controls.push(entry);
          }
          return {
            title: document.title,
            url: location.href,
            text: document.body?.innerText || "",
            controls,
            controlsSummary: { total: all.length, visible: visibleCount, unique: seen.size, returned: controls.length },
          };
        })()`;
        const result = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
        const pageValue = result.result?.value || {};
        await profileRegistry.touchProfile(profile.name, { tabId: target.id, url: pageValue.url, title: pageValue.title });
        const eventFile = profileRegistry.appendEvent(profile.name, {
          type: "browser_snapshot",
          tabId: target.id,
          url: pageValue.url,
          title: pageValue.title,
        });

        const fullText = String(pageValue.text || "");
        if (fullText.length <= TEXT_INLINE_THRESHOLD) {
          return { profile: profile.name, tabId: target.id, evidenceDir: profile.evidenceDir, eventFile, ...pageValue };
        }

        // Text exceeds inline threshold — save to disk, return filePath.
        const textDir = join(profile.evidenceDir, "text-dumps");
        mkdirSync(textDir, { recursive: true });
        const filePath = join(textDir, `browser_snapshot-${Date.now()}.txt`);
        writeFileSync(filePath, fullText, "utf8");
        const previewText = fullText.slice(0, 2000);
        return {
          profile: profile.name,
          tabId: target.id,
          evidenceDir: profile.evidenceDir,
          eventFile,
          title: pageValue.title,
          url: pageValue.url,
          controls: pageValue.controls,
          controlsSummary: pageValue.controlsSummary,
          text: `${previewText}...[truncated, see filePath]`,
          truncated: true,
          originalLength: fullText.length,
          filePath,
          next: [`browser_artifact_read {"path":"${filePath}"}`],
        };
      }));
    },
  });

  tools.set("browser_find", {
    name: "browser_find",
    description: "Find interactive elements on the page using a natural-language query (e.g. \"search bar\", \"add to cart button\", \"login link\"). Matches against innerText, aria-label, placeholder, title, name, role and tag, returns ranked candidates with selectors and bounding boxes so the agent can click/type without writing a CSS selector by hand. Backend note (A5): browser_find is managed-backend only (Playwright DOM search); it does not have a personal-backend route and will silently run on the managed browser even when a profile's sticky backend is personal. For personal-backend DOM search use browser_dom_search instead.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the server default profile." },
        tabId: { type: "string", description: "CDP tab ID override. Defaults to the profile's current tab." },
        query: {
          type: "string",
          description: "Natural-language description of the target element (e.g. \"sign in button\", \"email input\", \"product title containing organic\").",
        },
        maxResults: { type: "number", description: "Default 10, max 30." },
        includeNonInteractive: { type: "boolean", description: "Include any element with matching text, not just clickable controls." },
        includeFrames: { type: "boolean", description: "Search same-origin iframes. Default true." },
        includeShadow: { type: "boolean", description: "Search open shadow roots. Default true." },
        maxShadowRoots: { type: "number", description: "Maximum open shadow roots to inspect. Default 60." },
      },
      required: ["query"],
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const query = String(params?.query || "").trim();
      if (!query) return toolResult({ ok: false, error: "browser_find_query_required", detail: "query must be a non-empty string" });
      const limit = Math.max(1, Math.min(30, Number(params?.maxResults) || 10));
      const includeAll = params?.includeNonInteractive === true;
      const includeFrames = params?.includeFrames !== false;
      const includeShadow = params?.includeShadow !== false;
      const maxShadowRoots = Math.max(0, Math.min(200, Number(params?.maxShadowRoots) || 60));
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        const expression = `(() => {
          const query = ${JSON.stringify(query)};
          const maxResults = ${limit};
          const includeAll = ${includeAll};
          const includeFrames = ${includeFrames};
          const includeShadow = ${includeShadow};
          const maxShadowRoots = ${maxShadowRoots};
          const tokens = query.toLowerCase().split(/\\s+/).filter(Boolean);
          const interactiveSelector = "a,button,input,textarea,select,[role=button],[role=link],[role=textbox],[role=combobox],[role=searchbox],[role=menuitem],[role=tab],[role=switch],[role=checkbox],[role=radio],[contenteditable=\\"\\"],[contenteditable=true],[tabindex],[onclick]";
          const baseSelector = "*";
          const frameErrors = [];
          function collectCandidates(root, meta = { framePath: "top", frameIndexes: [], shadowPath: [] }, acc = []) {
            if (!root?.querySelectorAll) return acc;
            try {
              acc.push(...Array.from(root.querySelectorAll(baseSelector)).map((el) => ({ el, meta })));
            } catch {
              return acc;
            }
            if (includeShadow) {
              let inspected = 0;
              for (const host of Array.from(root.querySelectorAll("*"))) {
                if (inspected >= maxShadowRoots) break;
                if (!host.shadowRoot) continue;
                inspected += 1;
                collectCandidates(host.shadowRoot, {
                  ...meta,
                  shadowPath: [...(meta.shadowPath || []), host.tagName?.toLowerCase() || "host"],
                }, acc);
              }
            }
            if (includeFrames) {
              const frames = Array.from(root.querySelectorAll("iframe,frame"));
              frames.forEach((frame, index) => {
                try {
                  const childDocument = frame.contentDocument || frame.contentWindow?.document;
                  if (!childDocument) return;
                  collectCandidates(childDocument, {
                    ...meta,
                    framePath: (meta.framePath || "top") + " > frame[" + index + "]",
                    frameIndexes: [...(meta.frameIndexes || []), index],
                    frameUrl: frame.src || childDocument.location?.href || "",
                  }, acc);
                } catch (error) {
                  frameErrors.push({
                    path: (meta.framePath || "top") + " > frame[" + index + "]",
                    src: frame.getAttribute("src") || "",
                    error: String(error?.message || error),
                  });
                }
              });
            }
            return acc;
          }
          const all = collectCandidates(document);
          function textById(value) {
            if (!value) return "";
            return String(value).split(/\\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ");
          }
          function labelText(el) {
            const labels = el.labels ? Array.from(el.labels) : [];
            if (el.id) {
              try {
                labels.push(...Array.from(document.querySelectorAll("label[for=\\"" + CSS.escape(el.id) + "\\"]")));
              } catch {
                // Ignore invalid ids.
              }
            }
            return labels.map((label) => label.textContent || "").join(" ");
          }
          function cssPath(el) {
            if (!(el instanceof Element)) return "";
            if (el.id) return "#" + CSS.escape(el.id);
            const parts = [];
            let node = el;
            while (node && node.nodeType === 1 && parts.length < 8) {
              let part = node.tagName.toLowerCase();
              if (node.parentElement) {
                const siblings = Array.from(node.parentElement.children).filter((c) => c.tagName === node.tagName);
                if (siblings.length > 1) {
                  const idx = siblings.indexOf(node) + 1;
                  part += ":nth-of-type(" + idx + ")";
                }
              }
              parts.unshift(part);
              node = node.parentElement;
              if (node && node.id) {
                parts.unshift("#" + CSS.escape(node.id));
                break;
              }
            }
            return parts.join(" > ");
          }
          function visibleRect(el) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return null;
            const style = getComputedStyle(el);
            if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return null;
            return r;
          }
          function gatherText(el) {
            const fields = {
              text: (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 200),
              ariaLabel: el.getAttribute("aria-label") || "",
              ariaLabelledBy: textById(el.getAttribute("aria-labelledby") || ""),
              label: labelText(el),
              placeholder: el.getAttribute("placeholder") || "",
              title: el.getAttribute("title") || "",
              name: el.getAttribute("name") || "",
              role: el.getAttribute("role") || "",
              type: el.getAttribute("type") || "",
              alt: el.getAttribute("alt") || "",
              testId: el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-cy") || "",
              value: typeof el.value === "string" ? String(el.value).slice(0, 200) : "",
            };
            return fields;
          }
          const scored = [];
          for (const candidate of all) {
            const el = candidate.el;
            const meta = candidate.meta || {};
            const rect = visibleRect(el);
            if (!rect) continue;
            const fields = gatherText(el);
            const interactive = el.matches(interactiveSelector) || Boolean(el.closest(interactiveSelector));
            const haystack = [
              fields.text, fields.ariaLabel, fields.ariaLabelledBy, fields.label, fields.placeholder, fields.title, fields.name, fields.role, fields.type, fields.alt, fields.testId, fields.value, el.tagName.toLowerCase(),
            ].join(" | ").toLowerCase();
            if (!haystack.trim()) continue;
            let score = 0;
            let hits = 0;
            for (const tok of tokens) {
              if (!tok) continue;
              let tokScore = 0;
              if (fields.ariaLabel.toLowerCase().includes(tok)) tokScore = Math.max(tokScore, 4);
              if (fields.ariaLabelledBy.toLowerCase().includes(tok)) tokScore = Math.max(tokScore, 4);
              if (fields.label.toLowerCase().includes(tok)) tokScore = Math.max(tokScore, 4);
              if (fields.text.toLowerCase().includes(tok)) tokScore = Math.max(tokScore, 3);
              if (fields.placeholder.toLowerCase().includes(tok)) tokScore = Math.max(tokScore, 3);
              if (fields.testId.toLowerCase().includes(tok)) tokScore = Math.max(tokScore, 3);
              if (fields.title.toLowerCase().includes(tok)) tokScore = Math.max(tokScore, 2);
              if (fields.name.toLowerCase().includes(tok)) tokScore = Math.max(tokScore, 2);
              if (fields.role.toLowerCase().includes(tok)) tokScore = Math.max(tokScore, 2);
              if (fields.type.toLowerCase().includes(tok)) tokScore = Math.max(tokScore, 2);
              if (fields.value.toLowerCase().includes(tok)) tokScore = Math.max(tokScore, 1);
              if (el.tagName.toLowerCase().includes(tok)) tokScore = Math.max(tokScore, 1);
              if (tokScore > 0) { score += tokScore; hits += 1; }
            }
            if (score === 0) continue;
            // Penalty for elements with very long text (likely paragraphs).
            if (fields.text.length > 120 && hits < tokens.length) score -= 1;
            if (!includeAll && !interactive) score -= 0.5;
            scored.push({ el, rect, score, hits, fields, meta, interactive });
          }
          scored.sort((a, b) => b.score - a.score || b.hits - a.hits || Number(b.interactive) - Number(a.interactive) || (a.fields.text.length - b.fields.text.length));
          const top = scored.slice(0, maxResults);
          return {
            query,
            totalCandidates: scored.length,
            matches: top.map((entry, idx) => ({
              rank: idx + 1,
              score: entry.score,
              tokenHits: entry.hits,
              tag: entry.el.tagName.toLowerCase(),
              interactive: entry.interactive,
              role: entry.fields.role || (entry.el.getAttribute("role") || ""),
              text: entry.fields.text,
              attributes: {
                id: entry.el.id || null,
                name: entry.fields.name || null,
                type: entry.fields.type || null,
                ariaLabel: entry.fields.ariaLabel || null,
                ariaLabelledBy: entry.fields.ariaLabelledBy || null,
                label: entry.fields.label || null,
                placeholder: entry.fields.placeholder || null,
                title: entry.fields.title || null,
                testId: entry.fields.testId || null,
                href: entry.el.getAttribute("href") || null,
              },
              selector: cssPath(entry.el),
              framePath: entry.meta.framePath || "top",
              frameIndexes: entry.meta.frameIndexes || [],
              frameUrl: entry.meta.frameUrl || null,
              shadowPath: entry.meta.shadowPath || [],
              bbox: { x: Math.round(entry.rect.left), y: Math.round(entry.rect.top), width: Math.round(entry.rect.width), height: Math.round(entry.rect.height) },
              center: { x: Math.round(entry.rect.left + entry.rect.width / 2), y: Math.round(entry.rect.top + entry.rect.height / 2) },
            })),
            coverage: {
              includeFrames,
              includeShadow,
              includeNonInteractive: true,
              nonInteractivePenaltyApplied: !includeAll,
              maxShadowRoots,
              frameErrors,
            },
            url: location.href,
            title: document.title,
          };
        })()`;
        const result = await client.Runtime.evaluate({ expression, returnByValue: true });
        if (result.exceptionDetails) {
          throw new Error(result.exceptionDetails.text || "browser_find failed");
        }
        const payload = result.result?.value || { query, matches: [], totalCandidates: 0 };
        await profileRegistry.touchProfile(profile.name, { tabId: target.id, url: payload.url, title: payload.title });
        const eventFile = profileRegistry.appendEvent(profile.name, {
          type: "browser_find",
          tabId: target.id,
          query,
          totalCandidates: payload.totalCandidates,
          matchCount: payload.matches?.length || 0,
        });
        return {
          profile: profile.name,
          tabId: target.id,
          eventFile,
          ...payload,
          next: payload.matches?.length
            ? ["browser_click", "browser_type", "browser_screenshot"]
            : ["browser_snapshot", "browser_screenshot"],
        };
      }));
    },
  });

  tools.set("browser_eval", {
    name: "browser_eval",
    description: "Evaluate a JavaScript expression in the current tab and return its value. Required param: expression (not 'code' or 'script'). Supported on both managed and personal backends: managed uses CDP Runtime.evaluate (bypasses page CSP); personal uses chrome.scripting.executeScript with a custom return wrapper. Returns {ok, result, exception}. 'Local trusted use only' means this tool is for authorised agent use on test targets — not for untrusted third-party page content.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        expression: { type: "string", description: "Required. JavaScript expression to evaluate in the page context. Use expression= not code= or script=." },
        tabId: { type: "string", description: "Optional. Tab id override." },
      },
      required: ["expression"],
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_eval", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        const capture = await runProfileAction({
          client,
          profile,
          eventType: "browser_eval",
          waitMs: typeof params?.waitMs === "number" ? Math.min(Math.max(0, params.waitMs), 30_000) : 700,
          event: { tabId: target.id },
          action: async () => await client.Runtime.evaluate({
            expression: String(params.expression || ""),
            returnByValue: true,
            awaitPromise: true,
          }),
        });
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        const result = capture.result;
        const rawValue = result.result?.value;
        const rawStr = rawValue !== undefined ? JSON.stringify(rawValue) : undefined;
        let evalResult = rawValue;
        let evalFilePath;
        if (rawStr && rawStr.length > TEXT_INLINE_THRESHOLD) {
          const evalDir = join(profile.evidenceDir, "eval-results");
          mkdirSync(evalDir, { recursive: true });
          evalFilePath = join(evalDir, `eval-${Date.now()}.json`);
          writeFileSync(evalFilePath, rawStr, "utf8");
          evalResult = undefined;
        }
        return {
          ok: !result.exceptionDetails,
          profile: profile.name,
          tabId: target.id,
          result: evalResult,
          filePath: evalFilePath,
          truncated: evalFilePath ? true : undefined,
          originalLength: evalFilePath ? rawStr.length : undefined,
          exception: result.exceptionDetails,
          capturedTraffic: capture.capturedTraffic,
          trafficFile: capture.trafficFile,
          eventFile: capture.eventFile,
        };
      }));
    },
  });

  tools.set("browser_frame_tree", {
    name: "browser_frame_tree",
    description: "Return the current Page frame tree for the profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        tabId: { type: "string", description: "Optional. Tab id override." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_frame_tree", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        await client.Page.enable();
        const tree = await client.Page.getFrameTree();
        const access = await client.Runtime.evaluate({
          expression: `(${frameAccessPageFunction.toString()})()`,
          returnByValue: true,
          awaitPromise: true,
        }).catch((error) => ({ error: String(error?.message || error) }));
        const boundaries = await client.Runtime.evaluate({
          expression: `(${frameShadowBoundaryPageFunction.toString()})(${JSON.stringify({ maxShadowRoots: params?.maxShadowRoots })})`,
          returnByValue: true,
          awaitPromise: true,
        }).catch((error) => ({ error: String(error?.message || error) }));
        const frameAccess = access.error ? [] : access.result?.value || [];
        const boundarySummary = boundaries.error ? null : boundaries.result?.value || null;
        const frames = flattenFrameTree(tree.frameTree);
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          frameTree: tree.frameTree,
          frames,
          frameCount: frames.length,
          frameAccess,
          inaccessibleFrameCount: frameAccess.filter((frame) => frame.accessible === false).length,
          frameAccessError: access.error || null,
          boundarySummary,
          shadowRoots: boundarySummary?.shadowRoots || [],
          shadowRootCount: boundarySummary?.shadowRootCount || 0,
          frameShadowBoundaryError: boundaries.error || null,
          captureBoundaries: [
            "Page frame tree comes from Chrome Page.getFrameTree.",
            "Frame access and shadow root rows come from the page context and follow same-origin and shadow DOM visibility rules.",
            "Closed shadow roots and cross-origin frame internals may be intentionally unavailable.",
          ],
        };
      }));
    },
  });

  tools.set("browser_accessibility_snapshot", {
    name: "browser_accessibility_snapshot",
    description: "Return Accessibility panel-style AX tree for the current profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        tabId: { type: "string", description: "Optional. Tab id override." },
        interestingOnly: { type: "boolean", description: "If true (default), returns only semantically interesting AX nodes. Set false for the full raw tree." },
        maxNodes: { type: "number", description: "Maximum AX nodes to return. Default 500." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_accessibility_snapshot", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const interestingOnly = params?.interestingOnly !== false;
      const maxNodes = typeof params?.maxNodes === "number" ? Math.min(Math.max(1, params.maxNodes), 5_000) : 500;
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        await client.Accessibility.enable().catch(() => {});
        const response = await client.Accessibility.getFullAXTree({ interestingOnly });
        const allNodes = Array.isArray(response.nodes) ? response.nodes : [];
        const nodes = allNodes.slice(0, maxNodes).map(normalizeAccessibilityNode);
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          interestingOnly,
          nodeCount: allNodes.length,
          returned: nodes.length,
          truncated: allNodes.length > nodes.length,
          nodes,
        };
      }));
    },
  });

  tools.set("browser_elements_snapshot", {
    name: "browser_elements_snapshot",
    description: "Return DOM tree, layout boxes, and computed style for the current profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        tabId: { type: "string", description: "Optional. Tab id override." },
        selector: { type: "string", description: "Optional CSS selector to inspect a specific element in detail alongside the tree." },
        maxNodes: { type: "number", description: "Maximum DOM nodes to include in the tree. Default 250." },
        maxDepth: { type: "number", description: "Maximum tree depth to traverse. Default 6." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_elements_snapshot", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const maxNodes = typeof params?.maxNodes === "number" ? Math.min(Math.max(1, params.maxNodes), 2_000) : 250;
      const maxDepth = typeof params?.maxDepth === "number" ? Math.min(Math.max(1, params.maxDepth), 20) : 6;
      const selector = params?.selector ? String(params.selector) : null;
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        const page = await client.Runtime.evaluate({
          expression: `(() => {
            const maxNodes = ${JSON.stringify(maxNodes)};
            const maxDepth = ${JSON.stringify(maxDepth)};
            const selector = ${JSON.stringify(selector)};
            let seen = 0;
            function nodeLabel(node) {
              if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
              const el = node;
              const id = el.id ? '#' + el.id : '';
              const cls = typeof el.className === 'string' && el.className.trim()
                ? '.' + el.className.trim().split(/\\s+/).slice(0, 4).join('.')
                : '';
              return el.tagName.toLowerCase() + id + cls;
            }
            function cssPath(el) {
              const parts = [];
              let current = el;
              while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
                let part = current.tagName.toLowerCase();
                if (current.id) {
                  part += '#' + CSS.escape(current.id);
                  parts.unshift(part);
                  break;
                }
                const parent = current.parentElement;
                if (parent) {
                  const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
                  if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
                }
                parts.unshift(part);
                current = parent;
              }
              return parts.join(' > ');
            }
            function serialize(el, depth = 0) {
              if (!el || seen >= maxNodes || depth > maxDepth) return null;
              seen += 1;
              const rect = el.getBoundingClientRect();
              const attrs = {};
              for (const attr of Array.from(el.attributes || [])) {
                if (['id', 'class', 'name', 'role', 'aria-label', 'type', 'href', 'src', 'alt', 'title'].includes(attr.name)) attrs[attr.name] = attr.value;
              }
              return {
                label: nodeLabel(el),
                path: cssPath(el),
                text: (el.innerText || el.textContent || '').trim().slice(0, 160),
                attrs,
                rect: {
                  x: Math.round(rect.x),
                  y: Math.round(rect.y),
                  width: Math.round(rect.width),
                  height: Math.round(rect.height),
                  visible: rect.width > 0 && rect.height > 0,
                },
                children: Array.from(el.children || []).map((child) => serialize(child, depth + 1)).filter(Boolean),
              };
            }
            function inspectElement(el) {
              if (!el) return null;
              const computed = getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              return {
                label: nodeLabel(el),
                path: cssPath(el),
                outerHTML: el.outerHTML.slice(0, 4000),
                text: (el.innerText || el.textContent || '').trim().slice(0, 2000),
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
                computedStyle: {
                  display: computed.display,
                  visibility: computed.visibility,
                  opacity: computed.opacity,
                  position: computed.position,
                  zIndex: computed.zIndex,
                  pointerEvents: computed.pointerEvents,
                  overflow: computed.overflow,
                  color: computed.color,
                  backgroundColor: computed.backgroundColor,
                  font: computed.font,
                },
              };
            }
            const selected = selector ? document.querySelector(selector) : null;
            return {
              url: location.href,
              title: document.title,
              viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
              doctype: document.doctype ? '<!doctype ' + document.doctype.name + '>' : null,
              root: serialize(document.documentElement),
              selected: selector ? inspectElement(selected) : null,
              selectedFound: selector ? Boolean(selected) : undefined,
              nodeCountReturned: seen,
              truncated: seen >= maxNodes,
            };
          })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return { profile: profile.name, tabId: target.id, page: page.result?.value };
      }));
    },
  });

  tools.set("browser_dom_snapshot", {
    name: "browser_dom_snapshot",
    description: "Return Chrome DOMSnapshot.captureSnapshot data for the current profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        tabId: { type: "string", description: "Optional. Tab id override." },
        computedStyles: { type: "array", items: { type: "string" }, description: "CSS property names to include in the snapshot. Defaults to a standard set (display, visibility, opacity, position, z-index, color, etc.)." },
        includeDOMRects: { type: "boolean", description: "Include bounding box rects for each node. Default true." },
        includePaintOrder: { type: "boolean", description: "Include paint order for each node. Default true." },
        includeBlendedBackgroundColors: { type: "boolean", description: "Include blended background colors. Default false." },
        includeTextColorOpacities: { type: "boolean", description: "Include text color opacities. Default false." },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const computedStyles = Array.isArray(params?.computedStyles) && params.computedStyles.length
        ? params.computedStyles.map(String)
        : [
            "display",
            "visibility",
            "opacity",
            "position",
            "z-index",
            "color",
            "background-color",
            "font-family",
            "font-size",
            "font-weight",
            "pointer-events",
          ];
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        const snapshot = await client.DOMSnapshot.captureSnapshot({
          computedStyles,
          includeDOMRects: params?.includeDOMRects !== false,
          includePaintOrder: params?.includePaintOrder !== false,
          includeBlendedBackgroundColors: Boolean(params?.includeBlendedBackgroundColors),
          includeTextColorOpacities: Boolean(params?.includeTextColorOpacities),
        });
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          computedStyles,
          documentCount: Array.isArray(snapshot.documents) ? snapshot.documents.length : 0,
          stringCount: Array.isArray(snapshot.strings) ? snapshot.strings.length : 0,
          snapshot,
        };
      }));
    },
  });

  tools.set("browser_dom_search", {
    name: "browser_dom_search",
    description: "Search the live DOM using Chrome DevTools DOM.performSearch, like Elements panel search.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        tabId: { type: "string", description: "Optional. Tab id override." },
        query: { type: "string", description: "Required. CSS selector, XPath, or plain text to search in the DOM." },
        includeUserAgentShadowDOM: { type: "boolean", description: "Include user-agent shadow DOM nodes in the search. Default false." },
        includeFrames: { type: "boolean", description: "Include same-origin iframes in the search. Default true." },
        maxResults: { type: "number", description: "Maximum results to return. Default 20." },
        maxOuterHTMLChars: { type: "number", description: "Maximum outerHTML characters per result. Default 1200." },
      },
      required: ["query"],
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_dom_search", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const query = String(params?.query || "");
      const maxResults = typeof params?.maxResults === "number" ? Math.min(Math.max(1, params.maxResults), 500) : 20;
      const maxOuterHTMLChars = typeof params?.maxOuterHTMLChars === "number" ? Math.min(Math.max(1, params.maxOuterHTMLChars), 2_000_000) : 1200;
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        await client.DOM.enable().catch(() => {});
        const search = await client.DOM.performSearch({
          query,
          includeUserAgentShadowDOM: Boolean(params?.includeUserAgentShadowDOM),
        });
        const count = Number(search.resultCount || 0);
        const endIndex = Math.min(count, Math.max(0, maxResults));
        const ids = endIndex > 0
          ? await client.DOM.getSearchResults({ searchId: search.searchId, fromIndex: 0, toIndex: endIndex })
          : { nodeIds: [] };
        const results = [];
        for (const nodeId of ids.nodeIds || []) {
          const described = await client.DOM.describeNode({ nodeId, depth: 1, pierce: true }).catch((error) => ({ error: String(error?.message || error), node: { nodeId } }));
          const outer = await client.DOM.getOuterHTML({ nodeId }).catch((error) => ({ error: String(error?.message || error), outerHTML: "" }));
          results.push({
            source: "cdp",
            ...domSearchNodeSummary(described.node || { nodeId }, outer, maxOuterHTMLChars),
            describeError: described.error,
            outerHTMLError: outer.error,
          });
        }
        await client.DOM.discardSearchResults({ searchId: search.searchId }).catch(() => {});
        const validResultCount = results.filter((entry) => entry.outerHTML || entry.nodeName || entry.localName).length;
        let fallback = null;
        if (params?.includeFrames !== false || validResultCount < Math.min(count, maxResults)) {
          const fallbackResult = await client.Runtime.evaluate({
            expression: `(${domSearchFallbackPageFunction.toString()})(${JSON.stringify({ query, maxResults, maxOuterHTMLChars, includeFrames: params?.includeFrames !== false })})`,
            awaitPromise: true,
            returnByValue: true,
          }).catch((error) => ({ error: String(error?.message || error) }));
          fallback = fallbackResult.error ? { error: fallbackResult.error, results: [] } : fallbackResult.result?.value;
        }
        const fallbackResults = Array.isArray(fallback?.results) ? fallback.results : [];
        const merged = [
          ...results.filter((entry) => entry.outerHTML || entry.nodeName || entry.localName),
          ...fallbackResults,
        ].slice(0, maxResults);
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          query,
          includeUserAgentShadowDOM: Boolean(params?.includeUserAgentShadowDOM),
          includeFrames: params?.includeFrames !== false,
          resultCount: count,
          returnedCount: merged.length,
          truncated: count > merged.length,
          fallbackUsed: Boolean(fallbackResults.length || fallback?.error),
          fallbackError: fallback?.error,
          results: merged,
        };
      }));
    },
  });

  tools.set("browser_event_listeners", {
    name: "browser_event_listeners",
    description: "Return DevTools Elements-panel Event Listeners for a selected DOM node.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        tabId: { type: "string", description: "Optional. Tab id override." },
        selector: { type: "string", description: "CSS selector for the DOM node. Defaults to document if omitted." },
        framePath: { type: "string", description: "Optional. Frame path string for targeting inside a specific iframe." },
        frameIndexes: { type: "array", items: { type: "number" }, description: "Optional. Frame index path for nested iframe targeting." },
        depth: { type: "number", description: "Depth of the ancestor chain to include event listeners for. Default -1 (full chain)." },
        pierce: { type: "boolean", description: "If true, pierce shadow roots to find listeners. Default true." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_event_listeners", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const selector = params?.selector ? String(params.selector) : "document";
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        await client.Runtime.enable();
        await client.DOMDebugger.enable?.().catch(() => {});
        const frameIndexes = frameIndexesFromOptions(params);
        const expression = frameIndexes.length
          ? `(${selectInFramePageFunction.toString()})(${JSON.stringify({ selector, framePath: params?.framePath || null, frameIndexes })})`
          : selector === "document"
            ? "document"
            : `document.querySelector(${JSON.stringify(selector)})`;
        const node = await client.Runtime.evaluate({
          expression,
          objectGroup: "agent-browser-runtime-event-listeners",
          returnByValue: false,
        });
        const objectId = node.result?.objectId;
        if (!objectId) {
          return {
            profile: profile.name,
            tabId: target.id,
            selector,
            framePath: params?.framePath || null,
            frameIndexes,
            found: false,
            listeners: [],
            count: 0,
          };
        }
        const result = await client.DOMDebugger.getEventListeners({
          objectId,
          depth: typeof params?.depth === "number" ? params.depth : -1,
          pierce: params?.pierce !== false,
        });
        await client.Runtime.releaseObjectGroup({ objectGroup: "agent-browser-runtime-event-listeners" }).catch(() => {});
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        const listeners = (result.listeners || []).map((listener) => ({
          type: listener.type,
          useCapture: listener.useCapture,
          passive: listener.passive,
          once: listener.once,
          scriptId: listener.scriptId,
          lineNumber: listener.lineNumber,
          columnNumber: listener.columnNumber,
          handler: listener.handler ? {
            type: listener.handler.type,
            subtype: listener.handler.subtype,
            className: listener.handler.className,
            description: listener.handler.description,
            objectId: listener.handler.objectId,
          } : null,
          originalHandler: listener.originalHandler ? {
            type: listener.originalHandler.type,
            subtype: listener.originalHandler.subtype,
            className: listener.originalHandler.className,
            description: listener.originalHandler.description,
            objectId: listener.originalHandler.objectId,
          } : null,
          backendNodeId: listener.backendNodeId,
        }));
        return {
          profile: profile.name,
          tabId: target.id,
          selector,
          framePath: params?.framePath || null,
          frameIndexes,
          found: true,
          count: listeners.length,
          listeners,
        };
      }));
    },
  });

  tools.set("browser_css_styles", {
    name: "browser_css_styles",
    description: "Return DevTools Elements-panel Styles/Computed/Box Model evidence for a selected DOM node.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        tabId: { type: "string", description: "Optional. Tab id override." },
        selector: { type: "string", description: "CSS selector for the target node. Defaults to body." },
        framePath: { type: "string", description: "Optional. Frame path string for targeting inside a specific iframe." },
        frameIndexes: { type: "array", items: { type: "number" }, description: "Optional. Frame index path for nested iframe targeting." },
        includeComputed: { type: "boolean", description: "Include computed styles. Default true." },
        includeMatchedRules: { type: "boolean", description: "Include matched CSS rules. Default true." },
        includeBoxModel: { type: "boolean", description: "Include box model dimensions. Default true." },
        forcePseudoClasses: { type: "array", items: { type: "string" }, description: "Pseudo-classes to force during inspection (e.g. [\"hover\", \"focus\"])." },
        persistPseudoState: { type: "boolean", description: "If true, leave forced pseudo-classes active after the call. Default false." },
        maxRules: { type: "number", description: "Maximum CSS rules to return. Default 80." },
      },
    },
    async execute(_id, params) {
      const profile = await resolveProfile(params?.profile);
      const selector = params?.selector ? String(params.selector) : "body";
      const maxRules = typeof params?.maxRules === "number" ? Math.min(Math.max(1, params.maxRules), 1_000) : 80;
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        await client.DOM.enable();
        await client.CSS.enable();
        const resolved = await resolveNodeIdForSelector(client, selector, params);
        if (!resolved.nodeId) {
          const fallbackStyle = await client.Runtime.evaluate({
            expression: `(() => { const selectInFramePageFunction = ${selectInFramePageFunction.toString()}; const styleInFramePageFunction = ${styleInFramePageFunction.toString()}; return styleInFramePageFunction(${JSON.stringify({
              selector,
              framePath: params?.framePath || null,
              frameIndexes: resolved.frameIndexes,
              maxOuterHTMLChars: 4000,
            })}); })()`,
            returnByValue: true,
            awaitPromise: true,
          }).catch((error) => ({ error: String(error?.message || error) }));
          const fallbackValue = fallbackStyle.error ? { found: false, error: fallbackStyle.error } : fallbackStyle.result?.value;
          return {
            profile: profile.name,
            tabId: target.id,
            selector,
            framePath: params?.framePath || null,
            frameIndexes: resolved.frameIndexes,
            ...(fallbackValue || { found: false }),
            selectorResolution: resolved,
            matchedStyles: null,
            fallbackUsed: true,
          };
        }
        const pseudo = normalizeForcedPseudoClasses(params?.forcePseudoClasses);
        let forcePseudoState = null;
        if (pseudo.forced.length) {
          forcePseudoState = await client.CSS.forcePseudoState({
            nodeId: resolved.nodeId,
            forcedPseudoClasses: pseudo.forced,
          }).then(() => ({ applied: true })).catch((error) => ({ applied: false, error: String(error?.message || error) }));
        }
        const [matchedStyles, computedStyle, boxModel] = await Promise.all([
          params?.includeMatchedRules === false
            ? Promise.resolve(null)
            : client.CSS.getMatchedStylesForNode({ nodeId: resolved.nodeId }).catch((error) => ({ error: String(error?.message || error) })),
          params?.includeComputed === false
            ? Promise.resolve(null)
            : client.CSS.getComputedStyleForNode({ nodeId: resolved.nodeId }).catch((error) => ({ error: String(error?.message || error) })),
          params?.includeBoxModel === false
            ? Promise.resolve(null)
            : client.DOM.getBoxModel({ nodeId: resolved.nodeId }).catch((error) => ({ error: String(error?.message || error) })),
        ]);
        if (pseudo.forced.length && params?.persistPseudoState !== true) {
          await client.CSS.forcePseudoState({ nodeId: resolved.nodeId, forcedPseudoClasses: [] }).catch(() => {});
        }
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          selector,
          framePath: params?.framePath || null,
          frameIndexes: resolved.frameIndexes,
          found: true,
          nodeId: resolved.nodeId,
          selectorResolution: resolved,
          forcedPseudoClasses: pseudo.forced,
          skippedPseudoClasses: pseudo.skipped,
          pseudoStatePersisted: Boolean(params?.persistPseudoState && pseudo.forced.length),
          forcePseudoState,
          matchedStyles: matchedStyles ? {
            inlineStyle: matchedStyles.inlineStyle,
            attributesStyle: matchedStyles.attributesStyle,
            matchedCSSRules: Array.isArray(matchedStyles.matchedCSSRules) ? matchedStyles.matchedCSSRules.slice(0, maxRules) : matchedStyles.matchedCSSRules,
            inherited: Array.isArray(matchedStyles.inherited) ? matchedStyles.inherited.slice(0, maxRules) : matchedStyles.inherited,
            pseudoElements: matchedStyles.pseudoElements,
            cssKeyframesRules: matchedStyles.cssKeyframesRules,
            parentLayoutNodeId: matchedStyles.parentLayoutNodeId,
            positionFallbackRules: matchedStyles.positionFallbackRules,
            error: matchedStyles.error,
            truncatedRules: Array.isArray(matchedStyles.matchedCSSRules) && matchedStyles.matchedCSSRules.length > maxRules,
          } : null,
          computedStyle,
          boxModel,
        };
      }));
    },
  });

  tools.set("browser_dom_mutation_watch", {
    name: "browser_dom_mutation_watch",
    description: "Watch DOM mutations for a selector, similar to DevTools Elements DOM-breakpoint evidence without pausing JavaScript.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        tabId: { type: "string", description: "Optional. Tab id override." },
        selector: { type: "string", description: "Required. CSS selector for the element to watch for mutations." },
        durationMs: { type: "number", description: "How long to observe mutations in milliseconds. Default 1000, max 10000." },
        maxEvents: { type: "number", description: "Maximum mutation events to capture. Default 100." },
        subtree: { type: "boolean", description: "Watch all descendants of the target, not just direct children. Default true." },
        childList: { type: "boolean", description: "Observe child node additions/removals. Default true." },
        attributes: { type: "boolean", description: "Observe attribute changes. Default true." },
        characterData: { type: "boolean", description: "Observe text content changes. Default false." },
        attributeOldValue: { type: "boolean", description: "Include old attribute values in mutation records. Default true." },
        characterDataOldValue: { type: "boolean", description: "Include old text content values in mutation records. Default false." },
        triggerExpression: { type: "string", description: "Optional JS expression to evaluate in the page context to trigger mutations after observation starts." },
      },
      required: ["selector"],
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_dom_mutation_watch", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const selector = String(params?.selector || "");
      const durationMs = Math.min(Math.max(typeof params?.durationMs === "number" ? params.durationMs : 1000, 100), 10000);
      const maxEvents = typeof params?.maxEvents === "number" ? Math.min(Math.max(1, params.maxEvents), 5_000) : 100;
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        await client.Runtime.enable().catch(() => {});
        const expression = `(${domMutationWatchPageFunction.toString()})(${JSON.stringify({
          selector,
          durationMs,
          maxEvents,
          subtree: params?.subtree !== false,
          childList: params?.childList !== false,
          attributes: params?.attributes !== false,
          characterData: Boolean(params?.characterData),
          attributeOldValue: params?.attributeOldValue !== false,
          characterDataOldValue: Boolean(params?.characterDataOldValue),
          triggerExpression: params?.triggerExpression ? String(params.triggerExpression) : "",
        })})`;
        const result = await client.Runtime.evaluate({
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        if (result.exceptionDetails) {
          throw new Error(result.exceptionDetails.text || "DOM mutation watch failed");
        }
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          ...(result.result?.value || {}),
        };
      }));
    },
  });
}
