// Meals and settings live in this browser's localStorage (photos are in IndexedDB, see
// photos.js). Nothing is sent anywhere except the estimate request to Gemini.
// Each day is stored under its own key to keep reads small:
//   calories:day:2026-10-08 -> [meal, meal, ...]
//   calories:apiKey         -> the Gemini API key
//   calories:target         -> daily calorie target (absent means no target)
//
// A meal looks like:
//   { id, day, createdAt, description, title, calories, items: [{ name, portion, calories }],
//     notes, model }
// Its photos are stored in IndexedDB under the meal's id.

const DAY_PREFIX = 'calories:day:';
const API_KEY = 'calories:apiKey';
const TARGET = 'calories:target';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function readDay(day) {
  try {
    return JSON.parse(localStorage.getItem(DAY_PREFIX + day)) ?? [];
  } catch {
    return [];
  }
}

function writeDay(day, meals) {
  try {
    if (meals.length) localStorage.setItem(DAY_PREFIX + day, JSON.stringify(meals));
    else localStorage.removeItem(DAY_PREFIX + day);
  } catch (err) {
    if (err.name === 'QuotaExceededError') {
      throw new Error('Storage is full. Export a backup in Settings, then delete some old meals.');
    }
    throw err;
  }
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Meals for a day, newest first. */
export function getMeals(day) {
  return readDay(day).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Saves a meal and returns it with its id and timestamp filled in. */
export function addMeal(meal) {
  const saved = { id: newId(), createdAt: new Date().toISOString(), ...meal };
  writeDay(meal.day, [...readDay(meal.day), saved]);
  return saved;
}

export function deleteMeal(day, id) {
  writeDay(day, readDay(day).filter((m) => m.id !== id));
}

export function getApiKey() {
  return localStorage.getItem(API_KEY) ?? '';
}

export function setApiKey(key) {
  if (key) localStorage.setItem(API_KEY, key);
  else localStorage.removeItem(API_KEY);
}

/** The daily calorie target, or 0 for none. */
export function getTarget() {
  const target = Math.round(Number(localStorage.getItem(TARGET)));
  return target > 0 ? target : 0;
}

/** Pass 0 (or anything that isn't a positive number) to remove the target. */
export function setTarget(target) {
  target = Math.round(Number(target));
  if (target > 0) localStorage.setItem(TARGET, String(target));
  else localStorage.removeItem(TARGET);
}

// ---------- Backup (used by backup.js) ----------

/** All meals, as { "YYYY-MM-DD": [meal, ...] }. */
export function allDays() {
  const days = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith(DAY_PREFIX)) days[key.slice(DAY_PREFIX.length)] = readDay(key.slice(DAY_PREFIX.length));
  }
  return days;
}

/** Merges meals in the allDays() shape. Meals already present (same id) are skipped. Returns the ids added. */
export function mergeDays(days) {
  const added = new Set();
  for (const [day, meals] of Object.entries(days)) {
    if (!DAY_RE.test(day) || !Array.isArray(meals)) continue;
    const existing = readDay(day);
    const ids = new Set(existing.map((m) => m.id));
    const fresh = meals.filter((m) => m?.id && !ids.has(m.id) && Number.isFinite(m.calories));
    if (fresh.length) {
      writeDay(day, [...existing, ...fresh]);
      fresh.forEach((m) => added.add(m.id));
    }
  }
  return added;
}
