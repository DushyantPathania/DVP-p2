// db.js — sql.js + IndexedDB caching
// Loads the SQLite DB into memory (sql.js), with persistent caching in IndexedDB.

let SQL, db;

const IDB_NAME  = "cricket-sqlite-cache";
const IDB_STORE = "files";

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbGet(key) {
  return idbOpen().then(idb => new Promise((res, rej) => {
    const tx = idb.transaction(IDB_STORE, "readonly");
    const r = tx.objectStore(IDB_STORE).get(key);
    r.onsuccess = () => res(r.result || null);
    r.onerror   = () => rej(r.error);
  }));
}
function idbPut(key, value) {
  return idbOpen().then(idb => new Promise((res, rej) => {
    const tx = idb.transaction(IDB_STORE, "readwrite");
    const r = tx.objectStore(IDB_STORE).put(value, key);
    r.onsuccess = () => res();
    r.onerror   = () => rej(r.error);
  }));
}
async function idbKeys(prefix="") {
  const idb = await idbOpen();
  return new Promise((res, rej) => {
    const tx = idb.transaction(IDB_STORE, "readonly");
    const store = tx.objectStore(IDB_STORE);
    const req = store.getAllKeys();
    req.onsuccess = () => {
      const all = (req.result || []).map(String);
      res(prefix ? all.filter(k => k.startsWith(prefix)) : all);
    };
    req.onerror = () => rej(req.error);
  });
}
async function idbDelete(key) {
  const idb = await idbOpen();
  return new Promise((res, rej) => {
    const tx = idb.transaction(IDB_STORE, "readwrite");
    const r = tx.objectStore(IDB_STORE).delete(key);
    r.onsuccess = () => res();
    r.onerror   = () => rej(r.error);
  });
}

const DB = {
  /**
   * Initialize the in-memory DB.
   * @param {string|string[]} sources - URL or list of URLs to try (first success wins)
   * @param {{version?: string, cacheKey?: string}} opts
   *   - version: bump when you update the DB to force refresh (e.g. "2025-11-12")
   *   - cacheKey: override default cache key
   */
  async init(sources, opts = {}) {
    if (db) return;
    const urls = Array.isArray(sources) ? sources : [sources];
    const version  = opts.version || "v1";
    const cacheKey = opts.cacheKey || `cricket.db::${version}`;

    SQL = await initSqlJs({
      locateFile: f => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${f}`
    });

    // 1) Try IndexedDB cache first
    try {
      const cached = await idbGet(cacheKey);
      if (cached && cached.byteLength) {
        db = new SQL.Database(new Uint8Array(cached));
        console.info("[DB] loaded from IndexedDB cache:", cacheKey);
        return;
      }
    } catch (e) {
      console.warn("[DB] cache read failed:", e);
    }

    // 2) Fetch from the first working URL, then cache it
    let lastErr;
    for (const url of urls) {
      try {
        const res = await fetch(url, { cache: "no-cache" });
        if (!res.ok) throw new Error(`HTTP ${res.status} at ${url}`);
        const buf = await res.arrayBuffer();
        await idbPut(cacheKey, buf);
        db = new SQL.Database(new Uint8Array(buf));
        console.info("[DB] fetched & cached:", url, "→", cacheKey);
        return;
      } catch (e) {
        lastErr = e;
        console.warn("[DB] fetch failed:", e.message);
      }
    }
    throw new Error(`Failed to load DB from all sources: ${lastErr?.message || "unknown"}`);
  },

  queryAll(sql, params = []) {
    if (!db) throw new Error("DB not initialized");
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  },

  /** Clear cached DBs (optionally by prefix) */
  async clearCache(prefix = "cricket.db::") {
    const keys = await idbKeys(prefix);
    await Promise.all(keys.map(idbDelete));
    console.info("[DB] cache cleared:", keys);
  }
};

window.DB = DB;
