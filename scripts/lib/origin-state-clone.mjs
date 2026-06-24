import http from "node:http";
import WebSocket from "ws";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeOrigin(raw) {
  const url = new URL(String(raw || ""));
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error(`origin must be http(s), got: ${raw}`);
  }
  return url.origin;
}

function originUrl(origin) {
  return `${normalizeOrigin(origin)}/`;
}

function hostnameForOrigin(origin) {
  return new URL(normalizeOrigin(origin)).hostname.toLowerCase();
}

function cookieDomainMatches(host, domain) {
  const normalized = String(domain || "").replace(/^\./, "").toLowerCase();
  if (!normalized) return false;
  return host === normalized || host.endsWith(`.${normalized}`);
}

export function cookieMatchesOrigin(cookie, origin) {
  const host = hostnameForOrigin(origin);
  if (cookie?.domain && cookieDomainMatches(host, cookie.domain)) return true;
  if (cookie?.url) {
    try {
      return new URL(cookie.url).origin === normalizeOrigin(origin);
    } catch {
      return false;
    }
  }
  return false;
}

function sameSiteForCdp(value) {
  const raw = String(value || "").toLowerCase();
  if (raw === "strict") return "Strict";
  if (raw === "lax") return "Lax";
  if (raw === "none" || raw === "no_restriction") return "None";
  return undefined;
}

export function cookieParamForOrigin(cookie, origin) {
  const param = {
    name: String(cookie.name || ""),
    value: String(cookie.value ?? ""),
    path: String(cookie.path || "/"),
  };
  if (!param.name) return null;

  if (cookie.domain) param.domain = String(cookie.domain);
  else param.url = originUrl(origin);

  if (typeof cookie.secure === "boolean") param.secure = cookie.secure;
  if (typeof cookie.httpOnly === "boolean") param.httpOnly = cookie.httpOnly;
  const sameSite = sameSiteForCdp(cookie.sameSite);
  if (sameSite) param.sameSite = sameSite;

  const expires = typeof cookie.expires === "number"
    ? cookie.expires
    : typeof cookie.expirationDate === "number"
      ? cookie.expirationDate
      : undefined;
  if (typeof expires === "number" && expires > 0 && cookie.session !== true) {
    param.expires = expires;
  }

  if (cookie.partitionKey && typeof cookie.partitionKey === "object") {
    param.partitionKey = cookie.partitionKey;
  }
  return param;
}

export function filterCookiesForOrigins(cookies, origins) {
  const normalizedOrigins = origins.map(normalizeOrigin);
  return (Array.isArray(cookies) ? cookies : []).filter((cookie) =>
    normalizedOrigins.some((origin) => cookieMatchesOrigin(cookie, origin)));
}

export function cdpHttpJson(port, path, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(new Error(`bad CDP JSON from :${port}${path}: ${error.message}`));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

export async function spawnProfileTargetWs(port) {
  const list = await cdpHttpJson(port, "/json");
  const page = Array.isArray(list) && list.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (page) return { wsUrl: page.webSocketDebuggerUrl, targetId: page.id };
  const created = await cdpHttpJson(port, "/json/new?about:blank", "PUT");
  if (!created?.webSocketDebuggerUrl) throw new Error(`could not open a page target on :${port}`);
  return { wsUrl: created.webSocketDebuggerUrl, targetId: created.id };
}

export async function openCdpPageSession(port, { timeoutMs = 15000 } = {}) {
  const { wsUrl, targetId } = await spawnProfileTargetWs(port);
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  let closed = false;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP websocket open timed out on :${port}`)), timeoutMs);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!message.id || !pending.has(message.id)) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(Object.assign(new Error(message.error.message || String(message.error)), { cdpError: message.error }));
    else waiter.resolve(message.result || {});
  });

  ws.on("close", () => {
    closed = true;
    for (const [id, waiter] of pending.entries()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`CDP websocket closed before response id=${id}`));
    }
    pending.clear();
  });

  async function send(method, params = {}) {
    if (closed) throw new Error("CDP websocket is closed");
    const id = nextId++;
    const payload = { id, method, params: params && typeof params === "object" ? params : {} };
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout (${timeoutMs}ms) for ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify(payload), (error) => {
        if (!error) return;
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      });
    });
  }

  async function close() {
    closed = true;
    for (const [id, waiter] of pending.entries()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`CDP session closed before response id=${id}`));
    }
    pending.clear();
    try { ws.close(); } catch { /* already closed */ }
  }

  return { port, targetId, send, close };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
  }
  return result.result?.value;
}

async function waitForDocumentReady(cdp, waitMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    try {
      const ready = await evaluate(cdp, "document.readyState !== 'loading'");
      if (ready) {
        await sleep(150);
        return;
      }
    } catch {
      // Navigation can briefly invalidate the execution context.
    }
    await sleep(150);
  }
}

export async function navigateCdpToOrigin(cdp, origin, { url, waitMs = 8000, force = false } = {}) {
  const targetUrl = url || originUrl(origin);
  const normalizedOrigin = normalizeOrigin(origin);
  if (!force) {
    const current = await evaluate(cdp, "location.origin").catch(() => null);
    if (current === normalizedOrigin) return { navigated: false, url: await evaluate(cdp, "location.href").catch(() => targetUrl) };
  }
  await cdp.send("Page.enable").catch(() => {});
  await cdp.send("Page.navigate", { url: targetUrl });
  await waitForDocumentReady(cdp, waitMs);
  return { navigated: true, url: await evaluate(cdp, "location.href").catch(() => targetUrl) };
}

const exportPageStateExpression = (maxIndexedDbRecords) => `(async () => {
  const maxIndexedDbRecords = ${JSON.stringify(maxIndexedDbRecords)};

  function storageObject(storage) {
    const out = {};
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      out[key] = storage.getItem(key);
    }
    return out;
  }

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
        const done = () => {
          pending -= 1;
          if (pending === 0) {
            db.close();
            resolve(result);
          }
        };
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
              if (storeResult.records.length >= maxIndexedDbRecords) {
                storeResult.truncated = true;
                return;
              }
              storeResult.records.push({ key: cursor.key, primaryKey: cursor.primaryKey, value: cursor.value });
              cursor.continue();
            };
            tx.oncomplete = done;
            tx.onerror = () => {
              storeResult.error = String(tx.error?.message || tx.error || "transaction_failed");
              done();
            };
          } catch (error) {
            storeResult.error = String(error?.message || error);
            done();
          }
        }
      };
    });
  }

  const indexedDBExport = { supported: Boolean(indexedDB), databases: [] };
  try {
    if (indexedDB?.databases) {
      const databases = await indexedDB.databases();
      indexedDBExport.databases = await Promise.all(
        databases.filter((database) => database?.name).map((database) => readIndexedDbDatabase(database))
      );
    }
  } catch (error) {
    indexedDBExport.error = String(error?.message || error);
  }

  return {
    url: location.href,
    origin: location.origin,
    localStorage: storageObject(localStorage),
    sessionStorage: storageObject(sessionStorage),
    indexedDB: indexedDBExport,
  };
})()`;

export async function exportOriginStateFromCdp(cdp, origin, options = {}) {
  const maxIndexedDbRecords = Math.min(Math.max(1, Number(options.maxIndexedDbRecords || 1000)), 10_000);
  await navigateCdpToOrigin(cdp, origin, { url: options.url, force: options.forceNavigate === true });
  await cdp.send("Network.enable").catch(() => {});
  const page = await evaluate(cdp, exportPageStateExpression(maxIndexedDbRecords));
  const allCookies = await cdp.send("Network.getAllCookies")
    .catch(async () => await cdp.send("Network.getCookies", { urls: [originUrl(origin)] }));
  return {
    exportedAt: new Date().toISOString(),
    origin: normalizeOrigin(origin),
    page,
    cookies: filterCookiesForOrigins(allCookies.cookies || [], [origin]),
  };
}

const importPageStateExpression = (state, options) => `(async () => {
  const state = ${JSON.stringify(state)};
  const options = ${JSON.stringify(options)};
  const result = {
    localStorage: { set: 0 },
    sessionStorage: { set: 0 },
    indexedDB: { databases: [] },
  };

  function setStorage(storage, values, label) {
    if (options.clearStorage !== false) storage.clear();
    for (const [key, value] of Object.entries(values || {})) {
      storage.setItem(key, value == null ? "" : String(value));
      result[label].set += 1;
    }
  }

  async function deleteDatabase(name) {
    return await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve({ ok: true });
      request.onerror = () => resolve({ ok: false, error: String(request.error?.message || request.error || "delete_failed") });
      request.onblocked = () => resolve({ ok: false, error: "delete_blocked" });
    });
  }

  async function importDatabase(database) {
    const dbResult = { name: database.name, version: database.version, objectStores: [], ok: true };
    if (!database.name) return { ...dbResult, ok: false, error: "database_name_missing" };
    const deleted = options.clearIndexedDB === false ? { ok: true, skipped: true } : await deleteDatabase(database.name);
    dbResult.deleted = deleted;
    if (!deleted.ok) {
      dbResult.ok = false;
      dbResult.error = deleted.error;
      return dbResult;
    }
    const version = Math.max(1, Math.floor(Number(database.version || 1)));
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(database.name, version);
      request.onupgradeneeded = () => {
        const opened = request.result;
        for (const storeMeta of database.objectStores || []) {
          if (!storeMeta?.name || opened.objectStoreNames.contains(storeMeta.name)) continue;
          const createOptions = {};
          if (storeMeta.keyPath !== null && storeMeta.keyPath !== undefined) createOptions.keyPath = storeMeta.keyPath;
          if (typeof storeMeta.autoIncrement === "boolean") createOptions.autoIncrement = storeMeta.autoIncrement;
          const store = opened.createObjectStore(storeMeta.name, createOptions);
          for (const indexMeta of storeMeta.indexes || []) {
            if (!indexMeta?.name || indexMeta.keyPath === null || indexMeta.keyPath === undefined) continue;
            store.createIndex(indexMeta.name, indexMeta.keyPath, {
              unique: Boolean(indexMeta.unique),
              multiEntry: Boolean(indexMeta.multiEntry),
            });
          }
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error(String(request.error?.message || request.error || "open_failed")));
      request.onblocked = () => reject(new Error("open_blocked"));
    });
    try {
      for (const storeMeta of database.objectStores || []) {
        const storeResult = { name: storeMeta.name, records: 0, ok: true };
        dbResult.objectStores.push(storeResult);
        try {
          const records = Array.isArray(storeMeta.records) ? storeMeta.records : [];
          if (!records.length) continue;
          await new Promise((resolve, reject) => {
            const tx = db.transaction(storeMeta.name, "readwrite");
            const store = tx.objectStore(storeMeta.name);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(new Error(String(tx.error?.message || tx.error || "transaction_failed")));
            for (const record of records) {
              const hasInlineKey = store.keyPath !== null && store.keyPath !== undefined;
              if (hasInlineKey || record.key === undefined) store.put(record.value);
              else store.put(record.value, record.key);
              storeResult.records += 1;
            }
          });
        } catch (error) {
          storeResult.ok = false;
          storeResult.error = String(error?.message || error);
          dbResult.ok = false;
        }
      }
    } finally {
      db.close();
    }
    return dbResult;
  }

  setStorage(localStorage, state.page?.localStorage || state.localStorage, "localStorage");
  if (options.includeSessionStorage !== false) {
    setStorage(sessionStorage, state.page?.sessionStorage || state.sessionStorage, "sessionStorage");
  }

  if (indexedDB && state.page?.indexedDB?.databases) {
    for (const database of state.page.indexedDB.databases) {
      result.indexedDB.databases.push(await importDatabase(database));
    }
  }
  result.indexedDB.databaseCount = result.indexedDB.databases.length;
  result.indexedDB.objectStoreCount = result.indexedDB.databases.reduce((sum, db) => sum + (db.objectStores?.length || 0), 0);
  result.indexedDB.recordCount = result.indexedDB.databases.reduce((sum, db) => sum + (db.objectStores || []).reduce((s, store) => s + (store.records || 0), 0), 0);
  return result;
})()`;

async function setCookies(cdp, cookies, origin) {
  const params = cookies
    .map((cookie) => cookieParamForOrigin(cookie, origin))
    .filter(Boolean);
  if (!params.length) return { set: 0, errors: [] };
  await cdp.send("Network.enable").catch(() => {});
  try {
    await cdp.send("Network.setCookies", { cookies: params });
    return { set: params.length, errors: [] };
  } catch (bulkError) {
    const errors = [];
    let set = 0;
    for (const cookie of params) {
      const fallback = { ...cookie, url: cookie.url || originUrl(origin) };
      try {
        await cdp.send("Network.setCookies", { cookies: [fallback] });
        set += 1;
      } catch (error) {
        errors.push({ name: cookie.name, domain: cookie.domain || null, error: String(error?.message || error) });
      }
    }
    return { set, errors, bulkError: String(bulkError?.message || bulkError) };
  }
}

export async function importOriginStateToCdp(cdp, state, options = {}) {
  const origin = normalizeOrigin(state.origin || state.page?.origin || options.origin);
  const cookieResult = await setCookies(cdp, state.cookies || state.browserCookies || [], origin);
  await navigateCdpToOrigin(cdp, origin, { url: options.url, force: true });
  const pageResult = await evaluate(cdp, importPageStateExpression(state, {
    clearStorage: options.clearStorage !== false,
    clearIndexedDB: options.clearIndexedDB !== false,
    includeSessionStorage: options.includeSessionStorage !== false,
  }));
  return {
    origin,
    cookies: cookieResult,
    page: pageResult,
  };
}

export function cdpOriginStateAdapter(cdp, options = {}) {
  return {
    async exportOriginState(origin, perOriginOptions = {}) {
      return await exportOriginStateFromCdp(cdp, origin, { ...options, ...perOriginOptions });
    },
    async importOriginState(state, perOriginOptions = {}) {
      return await importOriginStateToCdp(cdp, state, { ...options, ...perOriginOptions });
    },
  };
}

export async function cloneOriginState({ source, destination, origins, maxIndexedDbRecords = 1000, includeSessionStorage = true }) {
  if (!source?.exportOriginState) throw new Error("cloneOriginState requires source.exportOriginState");
  if (!destination?.importOriginState) throw new Error("cloneOriginState requires destination.importOriginState");
  const normalizedOrigins = (origins || []).map(normalizeOrigin);
  if (!normalizedOrigins.length) throw new Error("cloneOriginState requires at least one origin");

  const results = [];
  for (const origin of normalizedOrigins) {
    const exported = await source.exportOriginState(origin, { maxIndexedDbRecords });
    const imported = await destination.importOriginState(exported, { includeSessionStorage });
    results.push({
      origin,
      exported: {
        cookieCount: exported.cookies?.length || 0,
        localStorageKeys: Object.keys(exported.page?.localStorage || {}).length,
        sessionStorageKeys: Object.keys(exported.page?.sessionStorage || {}).length,
        indexedDbDatabaseCount: exported.page?.indexedDB?.databases?.length || 0,
        indexedDbRecordCount: (exported.page?.indexedDB?.databases || [])
          .reduce((sum, db) => sum + (db.objectStores || []).reduce((s, store) => s + (store.records?.length || 0), 0), 0),
      },
      imported,
    });
  }

  return {
    ok: results.every((entry) => (entry.imported.cookies.errors || []).length === 0 && (entry.imported.page.indexedDB.databases || []).every((db) => db.ok !== false)),
    clonedAt: new Date().toISOString(),
    originCount: normalizedOrigins.length,
    origins: results,
    boundary: "sessionStorage is copied into the destination tab used for the clone; it is not profile-global browser state.",
  };
}
