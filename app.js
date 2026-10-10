// Front end: one page, plain JavaScript, no build step.
import * as store from './store.js';
import * as photoStore from './photos.js';
import { exportBackup, importBackup } from './backup.js';
import { estimateCalories, modelLabel } from './gemini.js';

const MAX_PHOTOS = 5;
const MAX_PHOTO_SIDE = 1280; // px. Photos are shrunk before upload to keep it fast.
const PHOTO_QUALITY = 0.85;
const CARRY_DAYS = 7; // with carry-over on, going over the target more than a week ago no longer counts
const CARRY_SHARE = 0.25; // and at most this share of the target is taken off any one day

const $ = (selector) => document.querySelector(selector);
const els = {
  prev: $('#prev-day'),
  next: $('#next-day'),
  title: $('#day-title'),
  total: $('#day-total'),
  goToday: $('#go-today'),
  form: $('#meal-form'),
  text: $('#meal-text'),
  photoInput: $('#photo-input'),
  previews: $('#previews'),
  submit: $('#submit-btn'),
  status: $('#form-status'),
  list: $('#meal-list'),
  empty: $('#empty-msg'),
  template: $('#meal-template'),
  openSettings: $('#open-settings'),
  settings: $('#settings'),
  settingsForm: $('#settings-form'),
  apiKey: $('#api-key'),
  target: $('#target'),
  dayTarget: $('#day-target'),
  targetInfo: $('#target-info'),
  targetFill: $('#target-info .target-fill'),
  targetMark: $('#target-info .target-mark'),
  targetLeft: $('#target-left'),
  carriedOver: $('#carried-over'),
  carryOver: $('#carry-over'),
  exportBtn: $('#export-btn'),
  importInput: $('#import-input'),
  settingsStatus: $('#settings-status'),
  viewer: $('#photo-viewer'),
  viewerImg: $('#photo-viewer img'),
};

let currentDay = todayKey(); // the day being shown; new meals are logged to it
let viewingToday = true;
let photos = []; // [{ blob, url }] waiting to be submitted
let photoWork = Promise.resolve(); // resizing of just-picked photos; submit waits for it
let thumbUrls = []; // object URLs for the thumbnails on screen, freed on the next render
let renderCount = 0; // lets a slow photo load notice the user has paged away

// ---------- Dates: local time, as "YYYY-MM-DD" ----------

function dateKey(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayKey() {
  return dateKey(new Date());
}

function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function shiftDay(key, days) {
  const d = parseKey(key);
  d.setDate(d.getDate() + days);
  return dateKey(d);
}

function dayLabel(key) {
  const today = todayKey();
  if (key === today) return 'Today';
  if (key === shiftDay(today, -1)) return 'Yesterday';
  const d = parseKey(key);
  const options = { weekday: 'short', month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) options.year = 'numeric';
  return d.toLocaleDateString(undefined, options);
}

// ---------- Day view ----------

function showDay(key) {
  currentDay = key;
  viewingToday = key === todayKey();
  const label = dayLabel(key);
  const meals = store.getMeals(key);

  els.title.textContent = label;
  els.next.disabled = key >= todayKey();
  els.goToday.hidden = viewingToday;
  els.submit.textContent = viewingToday ? 'Estimate & add' : `Add to ${label}`;
  const total = mealTotal(meals);
  els.total.textContent = total.toLocaleString();
  showTarget(key, total);
  els.empty.hidden = meals.length > 0;
  const items = meals.map(mealElement);
  els.list.replaceChildren(...items);
  showThumbnails(meals, items);
}

function mealTotal(meals) {
  return meals.reduce((sum, meal) => sum + meal.calories, 0);
}

// "1,250 / 2,000 kcal" with a progress bar and what's left, or how much over, if a daily target
// is set. With carry-over on, the day may have a lower amount to aim for: a mark on the bar shows
// it, what's left counts down to it, and a line under the bar says how much was carried over.
// Between the mark and the target nothing is counted; "over" is only for going past the target.
function showTarget(day, total) {
  const target = store.getTarget();
  els.dayTarget.textContent = target ? ` / ${target.toLocaleString()}` : '';
  els.targetInfo.hidden = !target;
  if (!target) return;
  const carried = store.getCarryOver() ? carriedOver(day, target) : 0;
  const aim = target - carried;
  const left = aim - total;
  const over = total - target;
  els.targetFill.style.width = `${Math.min(100, (total / target) * 100)}%`;
  els.targetMark.hidden = !carried;
  els.targetMark.style.left = `${(aim / target) * 100}%`;
  els.targetInfo.classList.toggle('over', over > 0);
  if (over > 0) els.targetLeft.textContent = `${over.toLocaleString()} over`;
  else els.targetLeft.textContent = left >= 0 ? `${left.toLocaleString()} left` : '';
  els.carriedOver.hidden = !carried;
  els.carriedOver.textContent = `${carried.toLocaleString()} carried over, so aim for ${aim.toLocaleString()}`;
}

// How much to lower a day's target for going over it on the days before. What's owed rolls
// forward: each day adds what was eaten over the full target, or pays off what was eaten under
// it, and a day's target comes down by at most CARRY_SHARE of it, so a big day is made up over
// several. Eating under the target never earns extra. Days with nothing logged are skipped,
// since a day that wasn't logged isn't a day of eating nothing.
function carriedOver(day, target) {
  let owed = 0;
  for (let i = CARRY_DAYS; i > 0; i--) {
    const meals = store.getMeals(shiftDay(day, -i));
    if (meals.length) owed = Math.max(0, owed + mealTotal(meals) - target);
  }
  return Math.min(owed, Math.round(target * CARRY_SHARE));
}

// Photos come from IndexedDB, which is asynchronous, so they're filled in after the list.
async function showThumbnails(meals, items) {
  const thisRender = ++renderCount;
  thumbUrls.forEach((url) => URL.revokeObjectURL(url));
  thumbUrls = [];
  if (!meals.length) return;

  let byMeal;
  try {
    byMeal = await photoStore.getPhotos(meals.map((m) => m.id));
  } catch {
    return; // photo storage unavailable; meals still show
  }
  if (thisRender !== renderCount) return;

  meals.forEach((meal, i) => {
    const thumbs = items[i].querySelector('.thumbs');
    for (const blob of byMeal.get(meal.id) ?? []) {
      const url = URL.createObjectURL(blob);
      thumbUrls.push(url);
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('aria-label', 'View photo');
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      button.append(img);
      button.addEventListener('click', () => {
        els.viewerImg.src = url;
        els.viewer.showModal();
      });
      thumbs.append(button);
    }
  });
}

function mealElement(meal) {
  const li = els.template.content.firstElementChild.cloneNode(true);
  const part = (selector) => li.querySelector(selector);

  part('.meal-title').textContent = meal.title;
  part('.meal-time').textContent = addedLabel(meal);
  part('.meal-kcal strong').textContent = meal.calories.toLocaleString();
  part('.meal-desc').textContent = meal.description;
  part('.notes').textContent = meal.notes;
  part('.model-used').textContent = meal.model ? `Estimated by ${modelLabel(meal.model)}` : '';
  part('.items').append(...meal.items.map((item) => {
    const el = document.createElement('li');
    el.textContent = `${item.name} (${item.portion}): ${item.calories.toLocaleString()} kcal`;
    return el;
  }));
  part('.delete-btn').addEventListener('click', () => {
    if (!confirm(`Delete "${meal.title}"?`)) return;
    store.deleteMeal(meal.day, meal.id);
    photoStore.deletePhotos(meal.id).catch(() => {});
    showDay(currentDay);
  });
  return li;
}

// e.g. "Added 7:35 PM". The date is included if it was logged on a different day.
function addedLabel(meal) {
  const added = new Date(meal.createdAt);
  const options = { hour: 'numeric', minute: '2-digit' };
  if (dateKey(added) !== meal.day) Object.assign(options, { month: 'short', day: 'numeric' });
  return `Added ${added.toLocaleString([], options)}`;
}

// Tapping anywhere on the full-size photo closes it.
els.viewer.addEventListener('click', () => els.viewer.close());

// ---------- Photo picking ----------

async function resizePhoto(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // so transparent PNGs don't turn black as JPEG
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode photo.'))), 'image/jpeg', PHOTO_QUALITY);
  });
}

function renderPreviews() {
  els.previews.replaceChildren(...photos.map((photo) => {
    const wrap = document.createElement('div');
    wrap.className = 'preview';
    const img = document.createElement('img');
    img.src = photo.url;
    img.alt = 'Selected photo';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '✕';
    remove.setAttribute('aria-label', 'Remove photo');
    remove.addEventListener('click', () => {
      URL.revokeObjectURL(photo.url);
      photos = photos.filter((p) => p !== photo);
      renderPreviews();
    });
    wrap.append(img, remove);
    return wrap;
  }));
}

function clearPhotos() {
  photos.forEach((p) => URL.revokeObjectURL(p.url));
  photos = [];
  renderPreviews();
}

// ---------- Meal form ----------

function setStatus(el, message, isError = false) {
  el.textContent = message;
  el.classList.toggle('error', isError);
}

async function addPickedPhotos(files) {
  for (const file of files) {
    if (photos.length >= MAX_PHOTOS) {
      setStatus(els.status, `Up to ${MAX_PHOTOS} photos per meal.`, true);
      break;
    }
    try {
      const blob = await resizePhoto(file);
      photos.push({ blob, url: URL.createObjectURL(blob) });
    } catch {
      setStatus(els.status, `Couldn't read ${file.name}. Try a JPEG or PNG.`, true);
    }
  }
  renderPreviews();
}

els.photoInput.addEventListener('change', () => {
  const files = [...els.photoInput.files];
  els.photoInput.value = ''; // allow picking the same file again later
  setStatus(els.status, '');
  photoWork = photoWork.then(() => addPickedPhotos(files));
});

els.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (els.submit.disabled) return;
  els.submit.disabled = true; // block double taps right away
  try {
    await submitMeal();
  } catch (err) {
    setStatus(els.status, err.message, true); // keep the text and photos so the user can retry
  } finally {
    els.submit.disabled = false;
  }
});

async function submitMeal() {
  const day = currentDay; // log to the day that was showing when submitted
  await photoWork; // include photos that are still being resized
  const text = els.text.value.trim();
  const apiKey = store.getApiKey();
  if (!apiKey) {
    openSettings('Add your Gemini API key first.');
    return;
  }
  if (!text && photos.length === 0) {
    setStatus(els.status, 'Describe the meal or add a photo.', true);
    return;
  }

  setStatus(els.status, 'Estimating calories… this can take up to a minute.');
  const images = await Promise.all(
    photos.map(async (p) => ({ mime: 'image/jpeg', base64: await photoStore.blobToBase64(p.blob) })),
  );
  const estimate = await estimateCalories({
    apiKey,
    text,
    images,
    onStatus: (message) => setStatus(els.status, message), // retry and fallback progress
  });
  const meal = store.addMeal({ day, description: text, ...estimate });

  // The meal is saved first; if its photos can't be stored, keep the meal and say so.
  let warning = '';
  if (photos.length) {
    try {
      await photoStore.savePhotos(meal.id, photos.map((p) => p.blob));
    } catch {
      warning = "Meal saved, but its photos couldn't be stored on this device.";
    }
  }
  els.text.value = '';
  clearPhotos();
  setStatus(els.status, warning, Boolean(warning));
  showDay(currentDay);
}

// ---------- Settings ----------

function openSettings(message = '') {
  els.apiKey.value = store.getApiKey();
  els.target.value = store.getTarget() || '';
  els.carryOver.checked = store.getCarryOver();
  setStatus(els.settingsStatus, message);
  els.settings.showModal();
}

els.openSettings.addEventListener('click', () => openSettings());

// The form uses method="dialog", so submitting it also closes the dialog. The browser checks
// the target's min/max first and keeps the dialog open if it's out of range.
els.settingsForm.addEventListener('submit', () => {
  store.setApiKey(els.apiKey.value.trim());
  store.setTarget(els.target.value);
  store.setCarryOver(els.carryOver.checked);
  showDay(currentDay);
});

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

els.exportBtn.addEventListener('click', async () => {
  els.exportBtn.disabled = true;
  setStatus(els.settingsStatus, 'Preparing backup…');
  try {
    const backup = await exportBackup();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(backup.blob);
    link.download = `calorie-tracker-backup-${todayKey()}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
    setStatus(els.settingsStatus, `Backup downloaded: ${plural(backup.meals, 'meal')}, ${plural(backup.photos, 'photo')}.`);
  } catch (err) {
    setStatus(els.settingsStatus, `Couldn't create the backup: ${err.message}`, true);
  } finally {
    els.exportBtn.disabled = false;
  }
});

els.importInput.addEventListener('change', async () => {
  const file = els.importInput.files[0];
  els.importInput.value = '';
  if (!file) return;
  setStatus(els.settingsStatus, 'Importing…');
  try {
    const added = await importBackup(file);
    // The backup may have set the target and carry-over; show them so "Save & close" keeps them.
    if (!els.target.value && store.getTarget()) {
      els.target.value = store.getTarget() || '';
      els.carryOver.checked = store.getCarryOver();
    }
    setStatus(els.settingsStatus, `Imported ${plural(added.meals, 'meal')}, ${plural(added.photos, 'photo')}.`);
  } catch (err) {
    setStatus(els.settingsStatus, err.message, true);
  }
  showDay(currentDay);
});

// ---------- Navigation ----------

els.prev.addEventListener('click', () => showDay(shiftDay(currentDay, -1)));
els.next.addEventListener('click', () => {
  if (currentDay < todayKey()) showDay(shiftDay(currentDay, 1));
});
els.goToday.addEventListener('click', () => showDay(todayKey()));

// When the app comes back to the foreground (it may have been open overnight),
// move on to the new day if we were showing "Today".
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') showDay(viewingToday ? todayKey() : currentDay);
});

// ---------- Start ----------

// Ask the browser not to clear our data when the phone is low on space. Chrome decides silently.
navigator.storage?.persist?.().catch(() => {});

showDay(currentDay);
if (!store.getApiKey()) openSettings('Add your Gemini API key to get started.');
