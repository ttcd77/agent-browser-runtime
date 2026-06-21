// register-application-storage.mjs — Application panel (storage/cookies/SW/IndexedDB/CacheStorage) tool family.
// Extracted verbatim from agent-cdp-server.mjs registerStandaloneBrowserTools (behavior-preserving).
// Dependencies are injected via deps; pure/lib helpers are imported directly.
import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { toolResult } from "./result-format.mjs";
import { summarizeCookies, summarizeCookiePartitions, summarizeStorageBoundaries, summarizeStorageBuckets } from "./evidence-summaries.mjs";

export function registerApplicationStorageTools(deps) {
  const {
    tools,
    cdpPort,
    profileRegistry,
    resolveProfile,
    withManagedPageClient,
    cdpJson,
    managedPlaywrightDriver,
    maybeRoutePersonal,
  } = deps;

  // Dep-injection guard: catch missing deps at registration time, not at first tool call.
  if (!tools) throw new Error("registerApplicationStorageTools: deps.tools is required");
  if (!resolveProfile) throw new Error("registerApplicationStorageTools: deps.resolveProfile is required");
  if (!withManagedPageClient) throw new Error("registerApplicationStorageTools: deps.withManagedPageClient is required");
  if (!maybeRoutePersonal) throw new Error("registerApplicationStorageTools: deps.maybeRoutePersonal is required");

  tools.set("browser_storage_snapshot", {
    name: "browser_storage_snapshot",
    description: "Return localStorage, sessionStorage, document-visible cookies, and CDP cookies for the current profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        tabId: { type: "string", description: "Optional. Tab id override." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_storage_snapshot", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const maxIndexedDbRecords = typeof params?.maxIndexedDbRecords === "number" ? Math.min(Math.max(1, params.maxIndexedDbRecords), 1_000) : 20;
      const maxCacheEntries = typeof params?.maxCacheEntries === "number" ? Math.min(Math.max(1, params.maxCacheEntries), 1_000) : 50;
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        const page = await client.Runtime.evaluate({
          expression: `(async () => {
            const limits = { maxIndexedDbRecords: ${JSON.stringify(maxIndexedDbRecords)}, maxCacheEntries: ${JSON.stringify(maxCacheEntries)} };
            async function readIndexedDbDatabase(meta) {
              return await new Promise((resolve) => {
                const result = {
                  name: meta.name,
                  version: meta.version,
                  objectStores: [],
                };
                const request = indexedDB.open(meta.name);
                request.onerror = () => resolve({ ...result, error: String(request.error?.message || request.error || "open_failed") });
                request.onsuccess = () => {
                  const db = request.result;
                  result.version = db.version;
                  const storeNames = Array.from(db.objectStoreNames || []);
                  if (storeNames.length === 0) {
                    db.close();
                    resolve(result);
                    return;
                  }
                  let pending = storeNames.length;
                  for (const storeName of storeNames) {
                    const storeResult = {
                      name: storeName,
                      keyPath: null,
                      autoIncrement: null,
                      indexes: [],
                      sampleRecords: [],
                    };
                    result.objectStores.push(storeResult);
                    try {
                      const tx = db.transaction(storeName, "readonly");
                      const store = tx.objectStore(storeName);
                      storeResult.keyPath = store.keyPath;
                      storeResult.autoIncrement = store.autoIncrement;
                      storeResult.indexes = Array.from(store.indexNames || []).map((indexName) => {
                        const index = store.index(indexName);
                        return { name: index.name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
                      });
                      const cursorRequest = store.openCursor();
                      cursorRequest.onsuccess = () => {
                        const cursor = cursorRequest.result;
                        if (!cursor || storeResult.sampleRecords.length >= limits.maxIndexedDbRecords) return;
                        storeResult.sampleRecords.push({
                          key: cursor.key,
                          primaryKey: cursor.primaryKey,
                          value: cursor.value,
                        });
                        cursor.continue();
                      };
                      tx.oncomplete = () => {
                        pending -= 1;
                        if (pending === 0) {
                          db.close();
                          resolve(result);
                        }
                      };
                      tx.onerror = () => {
                        storeResult.error = String(tx.error?.message || tx.error || "transaction_failed");
                        pending -= 1;
                        if (pending === 0) {
                          db.close();
                          resolve(result);
                        }
                      };
                    } catch (error) {
                      storeResult.error = String(error?.message || error);
                      pending -= 1;
                      if (pending === 0) {
                        db.close();
                        resolve(result);
                      }
                    }
                  }
                };
              });
            }
            const indexedDBSnapshot = { databases: [], supported: Boolean(indexedDB) };
            try {
              if (indexedDB?.databases) {
                const databases = await indexedDB.databases();
                indexedDBSnapshot.databases = await Promise.all(
                  databases
                    .filter((database) => database?.name)
                    .map((database) => readIndexedDbDatabase(database))
                );
              }
            } catch (error) {
              indexedDBSnapshot.error = String(error?.message || error);
            }
            const cacheSnapshot = { caches: [], supported: Boolean(caches) };
            try {
              if (caches?.keys) {
                const names = await caches.keys();
                cacheSnapshot.caches = await Promise.all(names.map(async (name) => {
                  const cache = await caches.open(name);
                  const requests = await cache.keys();
                  const entries = [];
                  for (const request of requests.slice(0, limits.maxCacheEntries)) {
                    const response = await cache.match(request);
                    entries.push({
                      url: request.url,
                      method: request.method,
                      mode: request.mode,
                      credentials: request.credentials,
                      destination: request.destination,
                      status: response?.status,
                      statusText: response?.statusText,
                      type: response?.type,
                      headers: response ? Object.fromEntries(response.headers.entries()) : {},
                    });
                  }
                  return { name, entryCount: requests.length, entries };
                }));
              }
            } catch (error) {
              cacheSnapshot.error = String(error?.message || error);
            }
            const serviceWorkerSnapshot = { supported: Boolean(navigator.serviceWorker) };
            try {
              if (navigator.serviceWorker?.getRegistrations) {
                serviceWorkerSnapshot.registrations = (await navigator.serviceWorker.getRegistrations()).map((registration) => ({
                  scope: registration.scope,
                  active: registration.active ? { scriptURL: registration.active.scriptURL, state: registration.active.state } : null,
                  waiting: registration.waiting ? { scriptURL: registration.waiting.scriptURL, state: registration.waiting.state } : null,
                  installing: registration.installing ? { scriptURL: registration.installing.scriptURL, state: registration.installing.state } : null,
                }));
              }
            } catch (error) {
              serviceWorkerSnapshot.error = String(error?.message || error);
            }
            return {
              url: location.href,
              localStorage: Object.fromEntries(Object.entries(localStorage || {})),
              sessionStorage: Object.fromEntries(Object.entries(sessionStorage || {})),
              cookieVisibleToDocument: document.cookie,
              indexedDB: indexedDBSnapshot,
              cacheStorage: cacheSnapshot,
              serviceWorker: serviceWorkerSnapshot,
            };
          })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        const cookies = await client.Network.getCookies().catch((error) => ({ error: String(error?.message || error) }));
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return { profile: profile.name, tabId: target.id, page: page.result?.value, cookies: cookies.cookies || cookies, meta: { suggestion: "This wrapper reads localStorage/sessionStorage from the page context — cross-origin iframe storage is invisible. For cross-origin storage access, use raw CDP: send_cdp(profile, 'DOMStorage.getDOMStorageItems', {storageId: {...}}). See skills/agent-browser-runtime SKILL.md Layer 2." } };
      }));
    },
  });

  tools.set("browser_storage_origin_summary", {
    name: "browser_storage_origin_summary",
    description: "Return Application-panel origin evidence: frame origins, storage keys, usage/quota, and cookie partition metadata where Chrome exposes it.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        tabId: { type: "string", description: "Optional. Tab id override." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_storage_origin_summary", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        await client.Page.enable().catch(() => {});
        await client.Storage?.enable?.().catch(() => {});
        const page = await client.Runtime.evaluate({
          expression: `(async () => {
            const storageBuckets = { supported: Boolean(navigator.storageBuckets), names: [], buckets: [] };
            try {
              if (navigator.storageBuckets?.keys) {
                storageBuckets.names = Array.from(await navigator.storageBuckets.keys());
                for (const name of storageBuckets.names.slice(0, 20)) {
                  try {
                    const bucket = await navigator.storageBuckets.open(name);
                    storageBuckets.buckets.push({
                      name,
                      estimate: bucket?.estimate ? await bucket.estimate().catch((error) => ({ error: String(error?.message || error) })) : null,
                      persisted: bucket?.persisted ? await bucket.persisted().catch((error) => ({ error: String(error?.message || error) })) : null,
                      expires: bucket?.expires ? await bucket.expires().catch((error) => ({ error: String(error?.message || error) })) : null,
                    });
                  } catch (error) {
                    storageBuckets.buckets.push({ name, error: String(error?.message || error) });
                  }
                }
              }
            } catch (error) {
              storageBuckets.error = String(error?.message || error);
            }
            return {
              url: location.href,
              origin: location.origin,
              protocol: location.protocol,
              host: location.host,
              documentCookieBytes: document.cookie?.length || 0,
              documentCookieNames: String(document.cookie || "").split(";").map((part) => part.trim().split("=")[0]).filter(Boolean),
              storageEstimateSupported: Boolean(navigator.storage?.estimate),
              storageBuckets,
              cookieEnabled: navigator.cookieEnabled,
            };
          })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        const frameTree = await client.Page.getFrameTree().catch(() => null);
        const frames = [];
        function walkFrame(node, parentId = null) {
          if (!node?.frame) return;
          frames.push({
            id: node.frame.id,
            parentId,
            url: node.frame.url,
            origin: (() => {
              try { return new URL(node.frame.url).origin; } catch { return ""; }
            })(),
            name: node.frame.name,
            securityOrigin: node.frame.securityOrigin,
            mimeType: node.frame.mimeType,
          });
          for (const child of node.childFrames || []) walkFrame(child, node.frame.id);
        }
        walkFrame(frameTree?.frameTree);
        const framesWithStorage = [];
        for (const frame of frames) {
          let storageKey = null;
          let storageKeyError = null;
          try {
            storageKey = (await client.Storage.getStorageKeyForFrame({ frameId: frame.id })).storageKey;
          } catch (error) {
            storageKey = null;
            storageKeyError = String(error?.message || error);
          }
          let usageAndQuota = null;
          if (frame.origin && frame.origin !== "null") {
            usageAndQuota = await client.Storage.getUsageAndQuota({ origin: frame.origin }).catch((error) => ({ error: String(error?.message || error) }));
          }
          framesWithStorage.push({ ...frame, storageKey, storageKeyError, usageAndQuota });
        }
        const cookiesResult = await client.Network.getCookies().catch(() => ({ cookies: [] }));
        const cookies = Array.isArray(cookiesResult.cookies) ? cookiesResult.cookies : [];
        const storageBoundarySummary = summarizeStorageBoundaries(framesWithStorage);
        const storageBucketSummary = summarizeStorageBuckets(page.result?.value?.storageBuckets);
        const cookiePartitionSummary = summarizeCookiePartitions(cookies);
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          page: page.result?.value,
          frames: framesWithStorage,
          storageBoundarySummary,
          storageBucketSummary,
          cookieCount: cookies.length,
          cookiePartitionSummary,
          captureBoundaries: [
            "current-state Application evidence; earlier storage writes are not replayed unless separately captured",
            "Storage Buckets are reported only when the page/browser exposes navigator.storageBuckets",
            "Cookie partition metadata is reported only when Chrome exposes partitionKey or partitionKeyOpaque",
          ],
          cookiePartitions: cookies.map((cookie) => ({
            name: cookie.name,
            domain: cookie.domain,
            path: cookie.path,
            sameSite: cookie.sameSite,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            partitionKey: cookie.partitionKey,
            partitionKeyOpaque: cookie.partitionKeyOpaque,
            sourceScheme: cookie.sourceScheme,
            sourcePort: cookie.sourcePort,
          })),
        };
      }));
    },
  });

  tools.set("browser_cookie_summary", {
    name: "browser_cookie_summary",
    description: "Summarize browser cookies for the current profile tab, including SameSite, Secure, HttpOnly, expiry, and objective attribute signals.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        tabId: { type: "string", description: "Optional. Tab id override." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_cookie_summary", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        const cookies = await client.Network.getCookies().catch((error) => ({ error: String(error?.message || error) }));
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          summary: summarizeCookies(cookies.cookies || []),
          partitionSummary: summarizeCookiePartitions(cookies.cookies || []),
          cookies: cookies.cookies || cookies,
        };
      }));
    },
  });

  tools.set("browser_cookies_set", {
    name: "browser_cookies_set",
    description: "Inject cookies into the browser. Use this to lift a logged-in session from one backend and apply it to the other, e.g. take a personal Chrome login and resume it in an isolated managed browser to skip OTP. backend is optional — it follows the profile's sticky backend (the mode you picked for this target), else managed; pass backend to override.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Managed profile name (defaults to default). Ignored for personal backend." },
        backend: {
          type: "string",
          enum: ["managed", "personal"],
          description: "Optional. Follows the profile's sticky backend, else managed. \"managed\" = isolated CDP browser, \"personal\" = the user's real Chrome via the extension bridge.",
        },
        cookies: {
          type: "array",
          description: "Array of cookie objects to set.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Cookie name. Required." },
              value: { type: "string", description: "Cookie value. Required." },
              domain: { type: "string", description: "Domain scope for the cookie (e.g. '.example.com'). Provide domain or url." },
              path: { type: "string", description: "Path scope for the cookie. Default '/'." },
              url: { type: "string", description: "Playwright accepts url instead of domain+path." },
              httpOnly: { type: "boolean", description: "If true, cookie is inaccessible to JavaScript (HttpOnly flag)." },
              secure: { type: "boolean", description: "If true, cookie is only sent over HTTPS (Secure flag)." },
              sameSite: { type: "string", enum: ["Lax", "Strict", "None"], description: "SameSite policy: Lax, Strict, or None." },
              expires: { type: "number", description: "Expiry in unix seconds." },
            },
            required: ["name", "value"],
          },
        },
      },
      required: ["cookies"],
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_cookies_set", params);
      if (routed) return toolResult(routed);
      // Managed path via Playwright context.addCookies
      const profile = await resolveProfile(params?.profile);
      const cookies = Array.isArray(params?.cookies) ? params.cookies : [];
      if (!cookies.length) {
        return toolResult({ ok: false, error: "cookies array is empty or missing" });
      }
      try {
        const result = await managedPlaywrightDriver.addCookies(profile.name, cookies);
        return toolResult({ tool: "browser_cookies_set", ...result, meta: { suggestion: "If this wrapper fails to set cookies (e.g. httpOnly cookies silently dropped, cross-origin domain rejected), use raw CDP: send_cdp(profile, 'Network.setCookies', {cookies: [...]}). Playwright context.addCookies cannot set HttpOnly cookies — raw CDP Network.setCookies can. See skills/agent-browser-runtime SKILL.md Layer 2." } });
      } catch (error) {
        return toolResult({ ok: false, backend: "managed", error: String(error?.message || error) });
      }
    },
  });

  tools.set("browser_cookies_get", {
    name: "browser_cookies_get",
    description:
      "Read cookies from the browser. Use this to lift a logged-in session from personal Chrome and pass it to the managed browser or a VPS scanner. backend is optional — follows the profile's sticky backend, else managed. Schema note (A7): managed returns {ok, backend:\"managed\", count, cookies:[{name,value,domain,path,secure,httpOnly,sameSite,expires}]} at the top level; personal returns the same fields nested under result.result due to the routeToPersonal wrapper — read result.result.cookies when on personal backend.",
    parameters: {
      type: "object",
      properties: {
        backend: {
          type: "string",
          enum: ["managed", "personal"],
          description: "Which browser to read cookies from. Optional — follows the profile's sticky backend, else managed.",
        },
        profile: { type: "string", description: "Managed profile name (defaults to default). Ignored for personal backend." },
        url: {
          type: "string",
          description: "Optional. Filter cookies that apply to this URL.",
        },
        domain: {
          type: "string",
          description: "Optional. Filter cookies by domain (e.g. \".bugcrowd.com\" or \"bugcrowd.com\").",
        },
        name: {
          type: "string",
          description: "Optional. Return only the cookie with this exact name.",
        },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_cookies_get", params);
      if (routed) return toolResult(routed);
      // managed path
      const filter = {};
      if (params?.url) filter.url = params.url;
      if (params?.domain) filter.domain = params.domain;
      if (params?.name) filter.name = params.name;
      const profile = await resolveProfile(params?.profile);
      try {
        const result = await managedPlaywrightDriver.getCookies(profile.name, filter);
        return toolResult({ tool: "browser_cookies_get", ...result, meta: { suggestion: "If this wrapper misses cookies (partitioned cookies, cross-origin iframe cookies, or incomplete partitionKey metadata), use raw CDP: send_cdp(profile, 'Network.getCookies', {urls: [...]}) for full cookie access including partitioned cookies. See skills/agent-browser-runtime SKILL.md Layer 2." } });
      } catch (error) {
        return toolResult({ ok: false, backend: "managed", error: String(error?.message || error) });
      }
    },
  });

  tools.set("browser_service_worker_summary", {
    name: "browser_service_worker_summary",
    description: "Return Application panel-style Service Worker and CacheStorage summary for the current profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        tabId: { type: "string", description: "Optional. Tab id override." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_service_worker_summary", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        const pageResult = await client.Runtime.evaluate({
          expression: `(async () => {
            const result = {
              url: location.href,
              origin: location.origin,
              secureContext: isSecureContext,
              controlledBy: navigator.serviceWorker?.controller
                ? {
                    scriptURL: navigator.serviceWorker.controller.scriptURL,
                    state: navigator.serviceWorker.controller.state,
                  }
                : null,
              registrations: [],
              cacheStorage: { supported: Boolean(caches), names: [] },
            };
            try {
              if (navigator.serviceWorker?.getRegistrations) {
                const registrations = await navigator.serviceWorker.getRegistrations();
                result.registrations = registrations.map((registration) => ({
                  scope: registration.scope,
                  updateViaCache: registration.updateViaCache,
                  active: registration.active ? { scriptURL: registration.active.scriptURL, state: registration.active.state } : null,
                  waiting: registration.waiting ? { scriptURL: registration.waiting.scriptURL, state: registration.waiting.state } : null,
                  installing: registration.installing ? { scriptURL: registration.installing.scriptURL, state: registration.installing.state } : null,
                }));
              }
            } catch (error) {
              result.registrationError = String(error?.message || error);
            }
            try {
              if (caches?.keys) {
                const names = await caches.keys();
                result.cacheStorage.names = names;
                result.cacheStorage.caches = await Promise.all(names.map(async (name) => {
                  const cache = await caches.open(name);
                  const requests = await cache.keys();
                  return {
                    name,
                    entryCount: requests.length,
                    sampleUrls: requests.slice(0, 10).map((request) => request.url),
                  };
                }));
              }
            } catch (error) {
              result.cacheStorage.error = String(error?.message || error);
            }
            return result;
          })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        const page = pageResult.result?.value || {};
        let cdpTargets = [];
        try {
          const targets = await cdpJson(cdpPort, "/json/list");
          cdpTargets = targets
            .filter((entry) => ["service_worker", "worker", "shared_worker"].includes(entry.type))
            .map((entry) => ({
              id: entry.id,
              type: entry.type,
              title: entry.title,
              url: entry.url,
              attached: Boolean(entry.webSocketDebuggerUrl),
            }));
        } catch (error) {
          cdpTargets = [{ error: String(error?.message || error) }];
        }
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          page,
          registrationCount: page.registrations?.length || 0,
          cacheCount: page.cacheStorage?.names?.length || 0,
          cdpTargets,
          cdpTargetCount: cdpTargets.filter((entry) => !entry.error).length,
        };
      }));
    },
  });

  tools.set("browser_service_worker_detail", {
    name: "browser_service_worker_detail",
    description: "Return deeper Application panel Service Worker evidence: registrations, worker scripts, CacheStorage entries, and worker debugger targets.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        tabId: { type: "string", description: "Optional. Tab id override." },
        includeScripts: { type: "boolean", description: "Fetch and include worker script source text. Default true." },
        includeCacheEntries: { type: "boolean", description: "Include CacheStorage entries. Default true." },
        maxScriptChars: { type: "number", description: "Maximum characters per worker script to include. Default 120000." },
        maxCacheEntries: { type: "number", description: "Maximum CacheStorage entries to return per cache. Default 50." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_service_worker_detail", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const includeScripts = params?.includeScripts !== false;
      const includeCacheEntries = params?.includeCacheEntries !== false;
      const maxScriptChars = typeof params?.maxScriptChars === "number" ? Math.min(Math.max(1, params.maxScriptChars), 2_000_000) : 120000;
      const maxCacheEntries = typeof params?.maxCacheEntries === "number" ? Math.min(Math.max(1, params.maxCacheEntries), 1_000) : 50;
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        const pageResult = await client.Runtime.evaluate({
          expression: `(async () => {
            const limits = ${JSON.stringify({ includeScripts, includeCacheEntries, maxScriptChars, maxCacheEntries })};
            const textPreview = (text) => ({
              text: String(text || "").slice(0, limits.maxScriptChars),
              bytes: new TextEncoder().encode(String(text || "")).length,
              truncated: String(text || "").length > limits.maxScriptChars,
            });
            async function fetchText(url) {
              if (!limits.includeScripts || !url) return null;
              try {
                const response = await fetch(url, { cache: "no-store", credentials: "include" });
                const text = await response.text();
                return {
                  url,
                  ok: response.ok,
                  status: response.status,
                  statusText: response.statusText,
                  headers: Array.from(response.headers.entries()).map(([name, value]) => ({ name, value })),
                  ...textPreview(text),
                };
              } catch (error) {
                return { url, error: String(error?.message || error) };
              }
            }
            const result = {
              url: location.href,
              origin: location.origin,
              secureContext: isSecureContext,
              controller: navigator.serviceWorker?.controller
                ? { scriptURL: navigator.serviceWorker.controller.scriptURL, state: navigator.serviceWorker.controller.state }
                : null,
              registrations: [],
              scripts: [],
              cacheStorage: { supported: Boolean(caches), names: [], caches: [] },
            };
            try {
              const registrations = navigator.serviceWorker?.getRegistrations ? await navigator.serviceWorker.getRegistrations() : [];
              const scriptUrls = new Set();
              result.registrations = registrations.map((registration) => {
                const states = {};
                for (const key of ["active", "waiting", "installing"]) {
                  const worker = registration[key];
                  states[key] = worker ? { scriptURL: worker.scriptURL, state: worker.state } : null;
                  if (worker?.scriptURL) scriptUrls.add(worker.scriptURL);
                }
                return {
                  scope: registration.scope,
                  updateViaCache: registration.updateViaCache,
                  ...states,
                };
              });
              result.scripts = await Promise.all(Array.from(scriptUrls).map(fetchText));
            } catch (error) {
              result.registrationError = String(error?.message || error);
            }
            try {
              if (caches?.keys) {
                const names = await caches.keys();
                result.cacheStorage.names = names;
                result.cacheStorage.caches = await Promise.all(names.map(async (name) => {
                  const cache = await caches.open(name);
                  const requests = await cache.keys();
                  const entries = [];
                  if (limits.includeCacheEntries) {
                    for (const request of requests.slice(0, limits.maxCacheEntries)) {
                      const response = await cache.match(request).catch(() => null);
                      entries.push({
                        url: request.url,
                        method: request.method,
                        mode: request.mode,
                        credentials: request.credentials,
                        status: response?.status ?? null,
                        statusText: response?.statusText ?? null,
                        type: response?.type ?? null,
                        headers: response ? Array.from(response.headers.entries()).map(([header, value]) => ({ name: header, value })) : [],
                        bodyUsed: response?.bodyUsed ?? null,
                      });
                    }
                  }
                  return {
                    name,
                    entryCount: requests.length,
                    entries,
                    truncated: requests.length > limits.maxCacheEntries,
                  };
                }));
              }
            } catch (error) {
              result.cacheStorage.error = String(error?.message || error);
            }
            return result;
          })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        const page = pageResult.result?.value || {};
        let cdpTargets = [];
        try {
          const targets = await cdpJson(cdpPort, "/json/list");
          cdpTargets = targets
            .filter((entry) => ["service_worker", "worker", "shared_worker"].includes(entry.type))
            .map((entry) => ({
              id: entry.id,
              type: entry.type,
              title: entry.title,
              url: entry.url,
              attached: Boolean(entry.webSocketDebuggerUrl),
              devtoolsFrontendUrl: entry.devtoolsFrontendUrl,
            }));
        } catch (error) {
          cdpTargets = [{ error: String(error?.message || error) }];
        }
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          page,
          registrationCount: page.registrations?.length || 0,
          scriptCount: page.scripts?.filter(Boolean).length || 0,
          cacheCount: page.cacheStorage?.names?.length || 0,
          cdpTargets,
          cdpTargetCount: cdpTargets.filter((entry) => !entry.error).length,
          meta: { suggestion: "This wrapper fetches SW scripts and cache entries from the page origin only. For cross-origin SW inspection or raw CDP target access, use send_cdp(profile, 'ServiceWorker.enable') + send_cdp(profile, 'ServiceWorker.dispatchSyncEvent', ...). See skills/agent-browser-runtime SKILL.md Layer 2." },
        };
      }));
    },
  });

  tools.set("browser_application_export", {
    name: "browser_application_export",
    description: "Export Application panel data for the current profile tab to a JSON file: storage, cookies, IndexedDB, CacheStorage, and Service Worker summary.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        tabId: { type: "string", description: "Optional. Tab id override." },
        path: { type: "string", description: "Optional. Absolute path to write the export JSON. Defaults to a timestamped file in the profile evidence directory." },
        maxIndexedDbRecords: { type: "number", description: "Maximum records to export per IndexedDB object store. Default 1000." },
        maxCacheEntries: { type: "number", description: "Maximum CacheStorage entries to export per cache. Default 500." },
        includeCacheBodies: { type: "boolean", description: "Include response body text for each CacheStorage entry. Default true." },
        maxCacheBodyChars: { type: "number", description: "Maximum characters per cache response body. Default 200000." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_application_export", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const maxIndexedDbRecords = typeof params?.maxIndexedDbRecords === "number" ? Math.min(Math.max(1, params.maxIndexedDbRecords), 10_000) : 1000;
      const maxCacheEntries = typeof params?.maxCacheEntries === "number" ? Math.min(Math.max(1, params.maxCacheEntries), 5_000) : 500;
      const includeCacheBodies = params?.includeCacheBodies !== false;
      const maxCacheBodyChars = typeof params?.maxCacheBodyChars === "number" ? Math.min(Math.max(1, params.maxCacheBodyChars), 10_000_000) : 200000;
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        const pageResult = await client.Runtime.evaluate({
          expression: `(async () => {
            const limits = ${JSON.stringify({ maxIndexedDbRecords, maxCacheEntries, includeCacheBodies, maxCacheBodyChars })};
            async function readIndexedDbDatabase(meta) {
              return await new Promise((resolve) => {
                const result = { name: meta.name, version: meta.version, objectStores: [] };
                const request = indexedDB.open(meta.name);
                request.onerror = () => resolve({ ...result, error: String(request.error?.message || request.error || "open_failed") });
                request.onsuccess = () => {
                  const db = request.result;
                  result.version = db.version;
                  const storeNames = Array.from(db.objectStoreNames || []);
                  if (!storeNames.length) {
                    db.close();
                    resolve(result);
                    return;
                  }
                  let pending = storeNames.length;
                  for (const storeName of storeNames) {
                    const storeResult = { name: storeName, keyPath: null, autoIncrement: null, indexes: [], records: [], truncated: false };
                    result.objectStores.push(storeResult);
                    try {
                      const tx = db.transaction(storeName, "readonly");
                      const store = tx.objectStore(storeName);
                      storeResult.keyPath = store.keyPath;
                      storeResult.autoIncrement = store.autoIncrement;
                      storeResult.indexes = Array.from(store.indexNames || []).map((indexName) => {
                        const index = store.index(indexName);
                        return { name: index.name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
                      });
                      const cursorRequest = store.openCursor();
                      cursorRequest.onsuccess = () => {
                        const cursor = cursorRequest.result;
                        if (!cursor) return;
                        if (storeResult.records.length >= limits.maxIndexedDbRecords) {
                          storeResult.truncated = true;
                          return;
                        }
                        storeResult.records.push({ key: cursor.key, primaryKey: cursor.primaryKey, value: cursor.value });
                        cursor.continue();
                      };
                      tx.oncomplete = () => {
                        pending -= 1;
                        if (pending === 0) {
                          db.close();
                          resolve(result);
                        }
                      };
                      tx.onerror = () => {
                        storeResult.error = String(tx.error?.message || tx.error || "transaction_failed");
                        pending -= 1;
                        if (pending === 0) {
                          db.close();
                          resolve(result);
                        }
                      };
                    } catch (error) {
                      storeResult.error = String(error?.message || error);
                      pending -= 1;
                      if (pending === 0) {
                        db.close();
                        resolve(result);
                      }
                    }
                  }
                };
              });
            }

            const indexedDBExport = { supported: Boolean(indexedDB), databases: [] };
            try {
              if (indexedDB?.databases) {
                const databases = await indexedDB.databases();
                indexedDBExport.databases = await Promise.all(databases.filter((database) => database?.name).map((database) => readIndexedDbDatabase(database)));
              }
            } catch (error) {
              indexedDBExport.error = String(error?.message || error);
            }

            const cacheExport = { supported: Boolean(caches), caches: [] };
            try {
              if (caches?.keys) {
                const names = await caches.keys();
                cacheExport.caches = await Promise.all(names.map(async (name) => {
                  const cache = await caches.open(name);
                  const requests = await cache.keys();
                  const entries = [];
                  for (const request of requests.slice(0, limits.maxCacheEntries)) {
                    const response = await cache.match(request);
                    const entry = {
                      url: request.url,
                      method: request.method,
                      mode: request.mode,
                      credentials: request.credentials,
                      destination: request.destination,
                      status: response?.status,
                      statusText: response?.statusText,
                      type: response?.type,
                      headers: response ? Object.fromEntries(response.headers.entries()) : {},
                    };
                    if (response && limits.includeCacheBodies) {
                      try {
                        const bodyText = await response.clone().text();
                        entry.bodyText = bodyText.slice(0, limits.maxCacheBodyChars);
                        entry.bodyBytes = bodyText.length;
                        entry.bodyTruncated = bodyText.length > limits.maxCacheBodyChars;
                      } catch (error) {
                        entry.bodyError = String(error?.message || error);
                      }
                    }
                    entries.push(entry);
                  }
                  return { name, entryCount: requests.length, entries, truncated: requests.length > limits.maxCacheEntries };
                }));
              }
            } catch (error) {
              cacheExport.error = String(error?.message || error);
            }

            const serviceWorkerExport = { supported: Boolean(navigator.serviceWorker), registrations: [] };
            try {
              if (navigator.serviceWorker?.getRegistrations) {
                serviceWorkerExport.controller = navigator.serviceWorker.controller
                  ? { scriptURL: navigator.serviceWorker.controller.scriptURL, state: navigator.serviceWorker.controller.state }
                  : null;
                serviceWorkerExport.registrations = (await navigator.serviceWorker.getRegistrations()).map((registration) => ({
                  scope: registration.scope,
                  updateViaCache: registration.updateViaCache,
                  active: registration.active ? { scriptURL: registration.active.scriptURL, state: registration.active.state } : null,
                  waiting: registration.waiting ? { scriptURL: registration.waiting.scriptURL, state: registration.waiting.state } : null,
                  installing: registration.installing ? { scriptURL: registration.installing.scriptURL, state: registration.installing.state } : null,
                }));
              }
            } catch (error) {
              serviceWorkerExport.error = String(error?.message || error);
            }

            return {
              exportedAt: new Date().toISOString(),
              url: location.href,
              origin: location.origin,
              localStorage: Object.fromEntries(Object.entries(localStorage || {})),
              sessionStorage: Object.fromEntries(Object.entries(sessionStorage || {})),
              cookieVisibleToDocument: document.cookie,
              indexedDB: indexedDBExport,
              cacheStorage: cacheExport,
              serviceWorker: serviceWorkerExport,
            };
          })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        const cookies = await client.Network.getCookies().catch((error) => ({ error: String(error?.message || error) }));
        const applicationExport = {
          ...(pageResult.result?.value || {}),
          browserCookies: cookies.cookies || cookies,
        };
        const exportText = `${JSON.stringify(applicationExport, null, 2)}\n`;
        const exportPath = params?.path || join(profile.evidenceDir, "application", `${Date.now()}-application-export.json`);
        mkdirSync(dirname(exportPath), { recursive: true });
        writeFileSync(exportPath, exportText, "utf8");
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return {
          profile: profile.name,
          tabId: target.id,
          exportPath,
          exportBytes: Buffer.byteLength(exportText, "utf8"),
          indexedDbDatabaseCount: applicationExport.indexedDB?.databases?.length || 0,
          cacheCount: applicationExport.cacheStorage?.caches?.length || 0,
          serviceWorkerRegistrationCount: applicationExport.serviceWorker?.registrations?.length || 0,
          cookieCount: Array.isArray(applicationExport.browserCookies) ? applicationExport.browserCookies.length : 0,
          meta: { suggestion: "This wrapper exports storage via page-context JS — IndexedDB and CacheStorage are origin-locked. For cross-origin storage forensic access, use raw CDP: send_cdp(profile, 'IndexedDB.requestDatabaseNames') and send_cdp(profile, 'CacheStorage.requestCacheNames'). See skills/agent-browser-runtime SKILL.md Layer 2." },
        };
      }));
    },
  });

  tools.set("browser_indexeddb_list", {
    name: "browser_indexeddb_list",
    description: "List IndexedDB databases, object stores, indexes, and record counts for the current profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        tabId: { type: "string", description: "Optional. Tab id override." },
        maxDatabases: { type: "number", description: "Maximum IndexedDB databases to list. Default 50." },
        includeCounts: { type: "boolean", description: "Include record counts per object store. Default true." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_indexeddb_list", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const maxDatabases = typeof params?.maxDatabases === "number" ? Math.min(Math.max(1, params.maxDatabases), 200) : 50;
      const includeCounts = params?.includeCounts !== false;
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        const result = await client.Runtime.evaluate({
          expression: `(async () => {
            const maxDatabases = ${JSON.stringify(maxDatabases)};
            const includeCounts = ${JSON.stringify(includeCounts)};
            const out = {
              ok: true,
              url: location.href,
              origin: location.origin,
              supported: Boolean(indexedDB),
              databasesApiSupported: Boolean(indexedDB?.databases),
              databases: [],
              captureBoundaries: [
                "IndexedDB listing is current page-origin state as exposed to page JavaScript.",
                "Record counts use objectStore.count() and can change while the page is running.",
                "If indexedDB.databases() is unavailable, the browser does not expose a full database name list to page JavaScript."
              ],
            };
            if (!indexedDB?.databases) {
              out.ok = false;
              out.error = "indexedDB.databases_unavailable";
              return out;
            }
            const allMetas = await indexedDB.databases();
            const metas = allMetas.slice(0, maxDatabases);
            out.truncated = allMetas.length > maxDatabases;
            for (const meta of metas) {
              const dbOut = { name: meta.name, version: meta.version, objectStores: [], error: null };
              out.databases.push(dbOut);
              if (!meta.name) continue;
              await new Promise((resolve) => {
                const open = indexedDB.open(meta.name);
                open.onerror = () => {
                  dbOut.error = String(open.error?.message || open.error || "open_failed");
                  resolve();
                };
                open.onsuccess = () => {
                  const db = open.result;
                  dbOut.version = db.version;
                  const storeNames = Array.from(db.objectStoreNames || []);
                  if (!storeNames.length) {
                    db.close();
                    resolve();
                    return;
                  }
                  let pending = storeNames.length;
                  const done = () => {
                    pending -= 1;
                    if (pending === 0) {
                      db.close();
                      resolve();
                    }
                  };
                  for (const storeName of storeNames) {
                    const storeOut = { name: storeName, keyPath: null, autoIncrement: null, indexes: [], recordCount: null, error: null };
                    dbOut.objectStores.push(storeOut);
                    try {
                      const tx = db.transaction(storeName, "readonly");
                      const store = tx.objectStore(storeName);
                      storeOut.keyPath = store.keyPath;
                      storeOut.autoIncrement = store.autoIncrement;
                      storeOut.indexes = Array.from(store.indexNames || []).map((indexName) => {
                        const index = store.index(indexName);
                        return { name: index.name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
                      });
                      if (includeCounts) {
                        const countReq = store.count();
                        countReq.onsuccess = () => { storeOut.recordCount = countReq.result; };
                        countReq.onerror = () => { storeOut.countError = String(countReq.error?.message || countReq.error || "count_failed"); };
                      }
                      tx.oncomplete = done;
                      tx.onerror = () => {
                        storeOut.error = String(tx.error?.message || tx.error || "transaction_failed");
                        done();
                      };
                    } catch (error) {
                      storeOut.error = String(error?.message || error);
                      done();
                    }
                  }
                };
              });
            }
            out.databaseCount = out.databases.length;
            out.objectStoreCount = out.databases.reduce((sum, db) => sum + (db.objectStores?.length || 0), 0);
            return out;
          })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return { profile: profile.name, tabId: target.id, page: result.result?.value, exception: result.exceptionDetails };
      }));
    },
  });

  tools.set("browser_indexeddb_read", {
    name: "browser_indexeddb_read",
    description: "Read records from a specific IndexedDB database and object store in the current profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        tabId: { type: "string", description: "Optional. Tab id override." },
        database: { type: "string", description: "Required. Name of the IndexedDB database." },
        store: { type: "string", description: "Required. Name of the object store to read records from." },
        limit: { type: "number", description: "Maximum records to return. Default 50." },
        offset: { type: "number", description: "Number of records to skip (for pagination). Default 0." },
      },
      required: ["database", "store"],
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_indexeddb_read", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const limit = typeof params?.limit === "number" ? Math.min(Math.max(1, params.limit), 5_000) : 50;
      const offset = typeof params?.offset === "number" ? Math.max(0, params.offset) : 0;
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        const result = await client.Runtime.evaluate({
          expression: `(async () => {
            const database = ${JSON.stringify(String(params.database))};
            const storeName = ${JSON.stringify(String(params.store))};
            const limit = ${JSON.stringify(limit)};
            const offset = ${JSON.stringify(offset)};
            return await new Promise((resolve) => {
              const records = [];
              const open = indexedDB.open(database);
              open.onerror = () => resolve({ ok: false, error: String(open.error?.message || open.error || "open_failed"), database, store: storeName, records });
              open.onsuccess = () => {
                const db = open.result;
                if (!Array.from(db.objectStoreNames || []).includes(storeName)) {
                  db.close();
                  resolve({ ok: false, error: "store_not_found", database, store: storeName, records });
                  return;
                }
                const tx = db.transaction(storeName, "readonly");
                const store = tx.objectStore(storeName);
                let skipped = 0;
                const cursorRequest = store.openCursor();
                cursorRequest.onsuccess = () => {
                  const cursor = cursorRequest.result;
                  if (!cursor || records.length >= limit) return;
                  if (skipped < offset) {
                    skipped += 1;
                    cursor.continue();
                    return;
                  }
                  records.push({ key: cursor.key, primaryKey: cursor.primaryKey, value: cursor.value });
                  cursor.continue();
                };
                tx.oncomplete = () => {
                  db.close();
                  resolve({ ok: true, database, store: storeName, limit, offset, returned: records.length, records });
                };
                tx.onerror = () => {
                  db.close();
                  resolve({ ok: false, error: String(tx.error?.message || tx.error || "transaction_failed"), database, store: storeName, records });
                };
              };
            });
          })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return { profile: profile.name, tabId: target.id, page: result.result?.value, exception: result.exceptionDetails };
      }));
    },
  });

  tools.set("browser_cache_storage_list", {
    name: "browser_cache_storage_list",
    description: "List CacheStorage caches and request/response metadata for the current profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        tabId: { type: "string", description: "Optional. Tab id override." },
        maxCaches: { type: "number", description: "Maximum number of caches to list. Default 50." },
        maxEntries: { type: "number", description: "Maximum entries to return per cache. Default 200." },
      },
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_cache_storage_list", params);
      if (routed) return toolResult(routed);
      const profile = await resolveProfile(params?.profile);
      const maxCaches = typeof params?.maxCaches === "number" ? Math.min(Math.max(1, params.maxCaches), 200) : 50;
      const maxEntries = typeof params?.maxEntries === "number" ? Math.min(Math.max(1, params.maxEntries), 5_000) : 200;
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        const result = await client.Runtime.evaluate({
          expression: `(async () => {
            const maxCaches = ${JSON.stringify(maxCaches)};
            const maxEntries = ${JSON.stringify(maxEntries)};
            const out = {
              ok: true,
              url: location.href,
              origin: location.origin,
              supported: Boolean(caches?.keys),
              caches: [],
              captureBoundaries: [
                "CacheStorage listing is current page-origin state as exposed to page JavaScript.",
                "Response bodies are not included in this list; use browser_cache_entry_get for a selected cacheName/url.",
                "Entry metadata can change while Service Workers or page scripts update caches."
              ],
            };
            if (!caches?.keys) {
              out.ok = false;
              out.error = "cacheStorage_unavailable";
              return out;
            }
            const allNames = await caches.keys();
            const names = allNames.slice(0, maxCaches);
            out.truncatedCaches = allNames.length > maxCaches;
            for (const name of names) {
              const cacheOut = { name, entryCount: 0, returnedCount: 0, truncated: false, entries: [], error: null };
              out.caches.push(cacheOut);
              try {
                const cache = await caches.open(name);
                const requests = await cache.keys();
                cacheOut.entryCount = requests.length;
                cacheOut.truncated = requests.length > maxEntries;
                for (const request of requests.slice(0, maxEntries)) {
                  const response = await cache.match(request).catch(() => null);
                  cacheOut.entries.push({
                    url: request.url,
                    method: request.method,
                    mode: request.mode,
                    credentials: request.credentials,
                    destination: request.destination,
                    referrer: request.referrer,
                    status: response?.status ?? null,
                    statusText: response?.statusText ?? null,
                    type: response?.type ?? null,
                    headers: response ? Array.from(response.headers.entries()).map(([header, value]) => ({ name: header, value })) : [],
                  });
                }
                cacheOut.returnedCount = cacheOut.entries.length;
              } catch (error) {
                cacheOut.error = String(error?.message || error);
              }
            }
            out.cacheCount = out.caches.length;
            out.entryCount = out.caches.reduce((sum, cache) => sum + (cache.entryCount || 0), 0);
            return out;
          })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return { profile: profile.name, tabId: target.id, page: result.result?.value, exception: result.exceptionDetails };
      }));
    },
  });

  tools.set("browser_cache_entry_get", {
    name: "browser_cache_entry_get",
    description: "Read one CacheStorage response body by cache name and URL in the current profile tab.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Profile name. Defaults to the active sticky-bound profile if omitted." },
        tabId: { type: "string", description: "Optional. Tab id override." },
        cacheName: { type: "string", description: "Required. Name of the CacheStorage cache (from browser_cache_storage_list)." },
        url: { type: "string", description: "Required. URL of the cached entry to read." },
        maxBodyChars: { type: "number", description: "Max characters of response body to return. Default: 200000, clamped to 10000000." },
      },
      required: ["cacheName", "url"],
    },
    async execute(_id, params) {
      const routed = await maybeRoutePersonal("browser_cache_entry_get", params);
      if (routed) return toolResult(routed);
      // BC-1: guard against null/undefined params being coerced to the string "null"/"undefined"
      if (params?.cacheName == null || params?.cacheName === "") {
        return toolResult({ ok: false, error: "browser_cache_entry_get requires cacheName" });
      }
      if (params?.url == null || params?.url === "") {
        return toolResult({ ok: false, error: "browser_cache_entry_get requires url" });
      }
      const maxBodyChars = typeof params?.maxBodyChars === "number" ? Math.min(Math.max(1, params.maxBodyChars), 10_000_000) : 200000;
      const profile = await resolveProfile(params?.profile);
      return toolResult(await withManagedPageClient(profile, params?.tabId || profile.tabId, async (client, target) => {
        const result = await client.Runtime.evaluate({
          expression: `(async () => {
            const cacheName = ${JSON.stringify(String(params.cacheName))};
            const url = ${JSON.stringify(String(params.url))};
            const maxBodyChars = ${JSON.stringify(maxBodyChars)};
            const cache = await caches.open(cacheName);
            const response = await cache.match(url);
            if (!response) return { ok: false, error: "cache_entry_not_found", cacheName, url };
            const fullText = await response.clone().text();
            const bodyText = fullText.slice(0, maxBodyChars);
            return {
              ok: true,
              cacheName,
              url,
              status: response.status,
              statusText: response.statusText,
              type: response.type,
              headers: Object.fromEntries(response.headers.entries()),
              bodyText,
              bodyBytes: fullText.length,
              bodyTruncated: fullText.length > maxBodyChars,
            };
          })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        await profileRegistry.touchProfile(profile.name, { tabId: target.id });
        return { profile: profile.name, tabId: target.id, page: result.result?.value, exception: result.exceptionDetails };
      }));
    },
  });
}
