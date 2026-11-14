// IndexedDB 翻译缓存，避免重复请求、节省 API 额度
const DB_NAME = 'glimmer-cache';
const STORE = 'tr';
const MAX_AGE = 30 * 24 * 3600 * 1000;
let dbp;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

export async function cacheGetMany(keys) {
  try {
    const d = await db();
    const tx = d.transaction(STORE, 'readonly');
    const st = tx.objectStore(STORE);
    return await Promise.all(
      keys.map(
        (k) =>
          new Promise((resolve) => {
            const r = st.get(k);
            r.onsuccess = () => {
              const v = r.result;
              resolve(v && Date.now() - v.t < MAX_AGE ? v.v : undefined);
            };
            r.onerror = () => resolve(undefined);
          })
      )
    );
  } catch {
    return keys.map(() => undefined);
  }
}

export async function cacheSetMany(entries) {
  try {
    const d = await db();
    const tx = d.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    const t = Date.now();
    for (const [k, v] of entries) if (v) st.put({ v, t }, k);
  } catch {}
}

export async function cacheClear() {
  const d = await db();
  await new Promise((resolve) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = resolve;
  });
}
