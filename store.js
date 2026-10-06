// Library storage in IndexedDB (localStorage is too small for books).

const DB_NAME = 'narrator'; // original app name, kept so existing libraries survive the rename
const STORE = 'items';
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const getAll = () => run('readonly', s => s.getAll());
export const get = id => run('readonly', s => s.get(id));
export const put = item => run('readwrite', s => s.put(item));
export const remove = id => run('readwrite', s => s.delete(id));

// Reading position is kept separately so saving it doesn't rewrite the whole text.
export const getPos = id => Number(localStorage.getItem(`pos:${id}`)) || 0;
export const setPos = (id, i) => localStorage.setItem(`pos:${id}`, String(i));
export const clearPos = id => localStorage.removeItem(`pos:${id}`);
