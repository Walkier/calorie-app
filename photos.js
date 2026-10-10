// Meal photos, stored in IndexedDB. localStorage only holds about 5 MB and only text,
// while IndexedDB stores image files directly and can use a large share of free disk.
// Each record is { mealId, blob }, with an index on mealId.

const DB_NAME = 'calorie-tracker';
const STORE = 'photos';

let dbPromise = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { autoIncrement: true }).createIndex('mealId', 'mealId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((err) => {
    dbPromise = null; // let the next call try again
    throw err;
  });
  return dbPromise;
}

// Runs fn(objectStore) in one transaction. If fn returns a function, the transaction
// resolves with its result once everything has been written or read.
async function run(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const getResult = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(typeof getResult === 'function' ? getResult() : undefined);
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Photo storage failed.'));
  });
}

/** Saves photos (Blobs) for a meal. */
export function savePhotos(mealId, blobs) {
  return run('readwrite', (store) => {
    for (const blob of blobs) store.add({ mealId, blob });
  });
}

/** Photos for several meals at once: Map of mealId -> [Blob]. */
export function getPhotos(mealIds) {
  return run('readonly', (store) => {
    const index = store.index('mealId');
    const requests = mealIds.map((id) => [id, index.getAll(id)]);
    return () => new Map(requests.map(([id, req]) => [id, req.result.map((r) => r.blob)]));
  });
}

export function deletePhotos(mealId) {
  return run('readwrite', (store) => {
    const req = store.index('mealId').getAllKeys(mealId);
    req.onsuccess = () => req.result.forEach((key) => store.delete(key));
  });
}

/** Every photo, as [{ mealId, blob }], for backups. */
export function allPhotos() {
  return run('readonly', (store) => {
    const req = store.getAll();
    return () => req.result;
  });
}

/** Adds [{ mealId, blob }] records in one go, for restoring backups. */
export function addPhotos(records) {
  return run('readwrite', (store) => {
    for (const { mealId, blob } of records) store.add({ mealId, blob });
  });
}

// ---------- Conversions ----------

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function base64ToBlob(base64, mime) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: mime });
}
