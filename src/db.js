// Archivio locale sul telefono (IndexedDB): catalogo, conteggi e impostazioni.
const NAME = "conta-pezzi", VERSION = 2;
let dbp;

function open() {
  dbp ||= new Promise((resolve, reject) => {
    const r = indexedDB.open(NAME, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("items")) db.createObjectStore("items", { keyPath: "id" });
      if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "id" });
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv", { keyPath: "k" });
      if (!db.objectStoreNames.contains("profiles")) db.createObjectStore("profiles", { keyPath: "id" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

export const getAll = (store) => tx(store, "readonly", (s) => s.getAll());
export const put = (store, obj) => tx(store, "readwrite", (s) => s.put(obj));
export const del = (store, id) => tx(store, "readwrite", (s) => s.delete(id));
export const clear = (store) => tx(store, "readwrite", (s) => s.clear());
export async function getKV(k, def) {
  const r = await tx("kv", "readonly", (s) => s.get(k));
  return r ? r.v : def;
}
export const setKV = (k, v) => put("kv", { k, v });

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
