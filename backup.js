// Backup files: everything except the API key, in one JSON file.
//   { app: "calorie-tracker", version: 2, exportedAt,
//     target (daily kcal, only if set), carryOver (true, only if on),
//     days: { "YYYY-MM-DD": [meal, ...] },
//     photos: [{ mealId, mime, data (base64) }] }
// Version 1 files (meals only, no photos) still import.
import * as store from './store.js';
import * as photos from './photos.js';

const APP = 'calorie-tracker';
const VERSION = 2;

/** Builds the backup. Returns { blob, meals, photos } with the counts included. */
export async function exportBackup() {
  const days = store.allDays();
  const mealCount = Object.values(days).reduce((n, meals) => n + meals.length, 0);
  const records = await photos.allPhotos().catch(() => []); // no IndexedDB means no photos

  // Photos are appended to the file one at a time so a big backup doesn't have to fit in
  // memory as a single string. The result is the same as JSON.stringify of the whole thing.
  const header = JSON.stringify({
    app: APP,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    target: store.getTarget() || undefined, // left out of the file when there's no target
    carryOver: store.getCarryOver() || undefined, // likewise when carry-over is off
    days,
  });
  let out = new Blob([header.slice(0, -1), ',"photos":[']);
  for (const [i, { mealId, blob }] of records.entries()) {
    const entry = JSON.stringify({ mealId, mime: blob.type, data: await photos.blobToBase64(blob) });
    out = new Blob([out, i ? ',' : '', entry]);
  }
  return { blob: new Blob([out, ']}'], { type: 'application/json' }), meals: mealCount, photos: records.length };
}

/** Merges a backup file into this device. Returns { meals, photos }: how many were added. */
export async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  if (data?.app !== APP || typeof data.days !== 'object' || data.days === null) {
    throw new Error("That file isn't a Calorie Tracker backup.");
  }

  const addedIds = store.mergeDays(data.days);
  // The target and carry-over come from the backup only if this device has no target of its own.
  if (data.target && !store.getTarget()) {
    store.setTarget(data.target);
    store.setCarryOver(data.carryOver === true);
  }

  // Only restore photos of meals that were just added, so importing twice doesn't duplicate them.
  const wanted = (Array.isArray(data.photos) ? data.photos : []).filter(
    (p) => addedIds.has(p?.mealId) && typeof p.data === 'string' && /^image\//.test(p.mime),
  );
  try {
    if (wanted.length) {
      await photos.addPhotos(wanted.map((p) => ({ mealId: p.mealId, blob: photos.base64ToBlob(p.data, p.mime) })));
    }
  } catch {
    throw new Error(`Imported ${addedIds.size} meals, but their photos couldn't be saved on this device.`);
  }
  return { meals: addedIds.size, photos: wanted.length };
}
