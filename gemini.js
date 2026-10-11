// Calls to the Gemini API, made directly from the browser: calorie estimates and the daily food
// ideas. This is the only file that knows about the LLM provider. To switch providers, rewrite
// estimateCalories() and suggestFoods() and keep the same input and return shapes.
// What Gemini is told, and the shape of its answers, are in the prompts/ folder.
import * as estimatePrompt from './prompts/estimate.js?v=590868f';
import * as suggestionPrompt from './prompts/suggestion.js?v=590868f';

const API_URL = 'https://generativelanguage.googleapis.com/v1beta';

// Models to try, in order: the main model first, then the backups. Each model has its own
// capacity and free-tier quota, so when one is overloaded or used up another often works.
// `tries` is how many times to try a model when it has temporary server errors.
const MODELS = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', tries: 2 },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', tries: 3 },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', tries: 4 },
];

// "high" is Gemini's extended thinking level, used for every model.
const THINKING_LEVEL = 'high';
const TIMEOUT_MS = 120_000; // per request; high thinking usually takes 10–40 s

// Retries for temporary server errors, with exponential backoff: wait about 1 s, then 2 s,
// then 4 s between tries of the same model. After a model's last try, move on to the next one.
const BASE_DELAY_MS = 1000;
const RETRY_STATUSES = new Set([500, 502, 503]);

// Food ideas longer than this, in characters, both lines together, are rejected rather than shown.
// The prompt asks for about 50 words, roughly 300 characters.
const MAX_SUGGESTION_LENGTH = 400;

/** Display name for a model id, e.g. for "Estimated by Gemini 3.8 Flash". */
export function modelLabel(id) {
  return MODELS.find((m) => m.id === id)?.label ?? id;
}

/**
 * Gets an estimate, retrying and falling back to the backup models as needed.
 * onStatus(message) is called with progress updates while retrying, for showing to the user.
 *
 * @param {{ apiKey: string, text: string, images: { mime: string, base64: string }[], onStatus?: (message: string) => void }} meal
 * @returns {Promise<{ title: string, calories: number, items: { name: string, portion: string, calories: number }[], notes: string, model: string }>}
 */
export async function estimateCalories({ apiKey, text, images, onStatus = () => {} }) {
  // Google recommends putting images before the text that refers to them.
  const parts = images.map((img) => ({ inlineData: { mimeType: img.mime, data: img.base64 } }));
  parts.push({ text: text ? `Meal description: ${text}` : 'Estimate the calories in the meal in the photo(s).' });
  const body = requestBody(estimatePrompt, parts);
  const { answer, model } = await ask(apiKey, body, 'an estimate', onStatus);
  return { ...toEstimate(answer), model };
}

/**
 * Food ideas based on the meals of the last few days. `days` are the days that have meals,
 * oldest first, and `target` is the daily target (0 for none).
 * `congratulation` is empty unless they're doing well. Neither part contains line breaks.
 *
 * @param {{ apiKey: string, target: number, days: { day: string, total: number, meals: object[] }[] }} log
 * @returns {Promise<{ congratulation: string, ideas: string }>}
 */
export async function suggestFoods({ apiKey, target, days }) {
  // Only what the ideas need: no ids, times, photos, estimate notes or settings other than the target.
  const log = {
    dailyTarget: target || undefined,
    days: days.map(({ day, total, meals }) => ({
      date: day,
      totalCalories: total,
      meals: meals.map((meal) => ({
        description: meal.description || undefined, // empty when only photos were sent
        title: meal.title,
        calories: meal.calories,
        foods: meal.items.map((item) => `${item.name} (${item.portion})`),
      })),
    })),
  };
  const body = requestBody(suggestionPrompt, [{ text: `Food log: ${JSON.stringify(log)}` }]);
  const { answer } = await ask(apiKey, body, 'food ideas');
  const line = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const congratulation = line(answer.congratulation);
  const ideas = line(answer.ideas);
  if (!ideas) throw new Error('Gemini returned no food ideas.');
  if (congratulation.length + ideas.length > MAX_SUGGESTION_LENGTH) throw new Error("Gemini's food ideas were too long.");
  return { congratulation, ideas };
}

// Sends a request, retrying and falling back to the backup models as needed. Returns the parsed
// JSON answer and the id of the model that gave it. `what` names what was asked for, in the error
// if every model fails: "Couldn't get an estimate: …".
async function ask(apiKey, body, what, onStatus = () => {}) {
  const failures = []; // [{ model, error }] for the final message if every model fails

  for (const model of MODELS) {
    const previous = failures.at(-1);
    if (previous) onStatus(`${previous.model.label} ${previous.error.message}. Trying ${model.label}…`);

    for (let attempt = 1; attempt <= model.tries; attempt++) {
      try {
        return { answer: await callModel(apiKey, model.id, body), model: model.id };
      } catch (error) {
        if (!(error instanceof Unavailable)) throw error; // e.g. a bad API key: retrying won't help
        if (!error.retry || attempt === model.tries) {
          failures.push({ model, error });
          break; // on to the next model
        }
        onStatus(`${model.label} ${error.message}. Retrying (try ${attempt + 1} of ${model.tries})…`);
        await sleep(backoffDelay(attempt));
      }
    }
  }

  // "A failed, B failed, and C failed"
  const summary = new Intl.ListFormat('en').format(failures.map((f) => `${f.model.label} ${f.error.message}`));
  const advice = failures.every((f) => f.error.rateLimit)
    ? 'The free tier allows a limited number of requests per day, so try again later.'
    : 'Try again in a few minutes.';
  throw new Error(`Couldn't get ${what}: ${summary}. ${advice}`);
}

// Thrown when a model can't answer right now. The message completes "<model name> ...".
class Unavailable extends Error {
  constructor(message, { retry = false, rateLimit = false } = {}) {
    super(message);
    this.retry = retry; // true: a temporary problem, worth retrying the same model after a pause
    this.rateLimit = rateLimit;
  }
}

// Wait before retry number n (1, 2, 3…): about 1 s, 2 s, 4 s… Each wait is randomized to
// between half and all of that ("jitter"), the standard way to keep retries from bunching up.
function backoffDelay(n) {
  const max = BASE_DELAY_MS * 2 ** (n - 1);
  return max / 2 + Math.random() * (max / 2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `prompt` is one of the files in prompts/.
function requestBody(prompt, parts) {
  return JSON.stringify({
    systemInstruction: { parts: [{ text: prompt.INSTRUCTIONS }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      thinkingConfig: { thinkingLevel: THINKING_LEVEL },
      responseMimeType: 'application/json',
      responseJsonSchema: prompt.SCHEMA,
    },
  });
}

// One request to one model. Throws Unavailable for problems another try or model might fix,
// and a plain Error for everything else.
async function callModel(apiKey, modelId, body) {
  let res, data;
  try {
    res = await fetch(`${API_URL}/models/${modelId}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    data = await res.json().catch((err) => {
      if (err.name === 'TimeoutError') throw err;
      return {};
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Unavailable('took too long to respond');
    if (!navigator.onLine) throw new Error("You're offline. Connect to the internet and try again.");
    throw new Unavailable("couldn't be reached", { retry: true });
  }

  if (RETRY_STATUSES.has(res.status)) {
    throw new Unavailable(res.status === 503 ? 'is overloaded (error 503)' : `had a server error (${res.status})`, {
      retry: true,
    });
  }
  // Rate limit or used-up quota: each model has its own quota, so switch right away.
  if (res.status === 429) throw new Unavailable('hit its rate limit', { rateLimit: true });
  // Model not found (e.g. retired by Google) or the server's own deadline passed: try the next one.
  if (res.status === 404) throw new Unavailable('is not available (error 404)');
  if (res.status === 504) throw new Unavailable('took too long to respond (error 504)');

  if (!res.ok) {
    const message = data.error?.message ?? 'unknown error';
    if (/api key/i.test(message)) throw new Error('Gemini rejected your API key. Check it in Settings.');
    throw new Error(`Gemini error ${res.status}: ${message}`);
  }

  return parseAnswer(data);
}

// The JSON in a response, parsed.
function parseAnswer(data) {
  const candidate = data.candidates?.[0];
  // Skip thought-summary parts; only the answer parts hold the JSON.
  const answer = (candidate?.content?.parts ?? [])
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');

  if (!answer) {
    const reason = data.promptFeedback?.blockReason ?? candidate?.finishReason ?? 'no reason given';
    throw new Error(`Gemini returned no answer (${reason}).`);
  }

  try {
    return JSON.parse(answer.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new Error('Gemini returned an answer that was not valid JSON. Try again.');
  }
}

// The estimate in Gemini's answer, checked and tidied.
function toEstimate(parsed) {
  const items = (Array.isArray(parsed.items) ? parsed.items : []).map((it) => ({
    name: String(it.name ?? ''),
    portion: String(it.portion ?? ''),
    calories: Math.max(0, Math.round(Number(it.calories) || 0)),
  }));
  // Use the item sum when there are items so the total always matches the breakdown.
  const calories = items.length
    ? items.reduce((sum, it) => sum + it.calories, 0)
    : Math.max(0, Math.round(Number(parsed.total_calories) || 0));

  return {
    title: String(parsed.title || 'Meal').slice(0, 120),
    calories,
    items,
    notes: String(parsed.notes ?? ''),
  };
}
