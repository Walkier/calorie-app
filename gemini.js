// Calorie estimation via the Gemini API, called directly from the browser.
// This is the only file that knows about the LLM provider. To switch providers,
// rewrite estimateCalories() and keep the same input and return shape.

const API_URL = 'https://generativelanguage.googleapis.com/v1beta';

// Models to try, in order: the main model first, then the backup. Each model has its own
// capacity and free-tier quota, so when one is overloaded or used up the other often works.
const MODELS = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
];

// "high" is Gemini's extended thinking level, used for every model.
const THINKING_LEVEL = 'high';
const TIMEOUT_MS = 120_000; // per request; high thinking usually takes 10–40 s

// Retries for temporary server errors, with exponential backoff: wait about 1 s, then 2 s,
// then 4 s between tries of the same model. After the last try, move on to the backup model.
const TRIES_PER_MODEL = 4;
const BASE_DELAY_MS = 1000;
const RETRY_STATUSES = new Set([500, 502, 503]);

const INSTRUCTIONS = `You are a nutrition expert estimating the calories in a meal someone ate.
You will get a text description, one or more photos, or both.

- Identify each food and drink, estimate its portion size, and estimate its calories.
  In photos, use plates, utensils, hands and packaging to judge scale.
- Prefer the text over the photo for things a photo can't show: quantities, how much was
  actually eaten, ingredients, brands, cooking method.
- If a nutrition label or a menu with calorie counts is visible or mentioned, use those numbers.
- Include likely hidden calories such as cooking oil, butter, dressings and sauces.
- Give one best estimate per item, never a range. total_calories must equal the sum of the items.
- If there is no food or drink at all, return an empty items list, 0 calories, and say so in notes.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short name for the meal, e.g. "Chicken burrito bowl"' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          portion: { type: 'string', description: 'Estimated amount, e.g. "1 cup" or "150 g"' },
          calories: { type: 'integer' },
        },
        required: ['name', 'portion', 'calories'],
      },
    },
    total_calories: { type: 'integer' },
    notes: { type: 'string', description: 'One short sentence on the main assumptions' },
  },
  required: ['title', 'items', 'total_calories', 'notes'],
};

/** Display name for a model id, e.g. for "Estimated by Gemini 3.8 Flash". */
export function modelLabel(id) {
  return MODELS.find((m) => m.id === id)?.label ?? id;
}

/**
 * Gets an estimate, retrying and falling back to the backup model as needed.
 * onStatus(message) is called with progress updates while retrying, for showing to the user.
 *
 * @param {{ apiKey: string, text: string, images: { mime: string, base64: string }[], onStatus?: (message: string) => void }} meal
 * @returns {Promise<{ title: string, calories: number, items: { name: string, portion: string, calories: number }[], notes: string, model: string }>}
 */
export async function estimateCalories({ apiKey, text, images, onStatus = () => {} }) {
  const body = JSON.stringify(requestBody(text, images));
  const failures = []; // [{ model, error }] for the final message if every model fails

  for (const model of MODELS) {
    const previous = failures.at(-1);
    if (previous) onStatus(`${previous.model.label} ${previous.error.message}. Trying ${model.label}…`);

    for (let attempt = 1; attempt <= TRIES_PER_MODEL; attempt++) {
      try {
        return { ...(await callModel(apiKey, model.id, body)), model: model.id };
      } catch (error) {
        if (!(error instanceof Unavailable)) throw error; // e.g. a bad API key: retrying won't help
        if (!error.retry || attempt === TRIES_PER_MODEL) {
          failures.push({ model, error });
          break; // on to the backup model
        }
        onStatus(`${model.label} ${error.message}. Retrying (try ${attempt + 1} of ${TRIES_PER_MODEL})…`);
        await sleep(backoffDelay(attempt));
      }
    }
  }

  const summary = failures.map((f) => `${f.model.label} ${f.error.message}`).join(', and ');
  const advice = failures.every((f) => f.error.rateLimit)
    ? 'The free tier allows a limited number of requests per day, so try again later.'
    : 'Try again in a few minutes.';
  throw new Error(`Couldn't get an estimate: ${summary}. ${advice}`);
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

function requestBody(text, images) {
  // Google recommends putting images before the text that refers to them.
  const parts = images.map((img) => ({ inlineData: { mimeType: img.mime, data: img.base64 } }));
  parts.push({ text: text ? `Meal description: ${text}` : 'Estimate the calories in the meal in the photo(s).' });
  return {
    systemInstruction: { parts: [{ text: INSTRUCTIONS }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      thinkingConfig: { thinkingLevel: THINKING_LEVEL },
      responseMimeType: 'application/json',
      responseJsonSchema: RESPONSE_SCHEMA,
    },
  };
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
  // Rate limit or used-up quota: the backup model has its own quota, so switch right away.
  if (res.status === 429) throw new Unavailable('hit its rate limit', { rateLimit: true });
  // Model not found (e.g. retired by Google) or the server's own deadline passed: try the backup.
  if (res.status === 404) throw new Unavailable('is not available (error 404)');
  if (res.status === 504) throw new Unavailable('took too long to respond (error 504)');

  if (!res.ok) {
    const message = data.error?.message ?? 'unknown error';
    if (/api key/i.test(message)) throw new Error('Gemini rejected your API key. Check it in Settings.');
    throw new Error(`Gemini error ${res.status}: ${message}`);
  }

  return parseEstimate(data);
}

function parseEstimate(data) {
  const candidate = data.candidates?.[0];
  // Skip thought-summary parts; only the answer parts hold the JSON.
  const answer = (candidate?.content?.parts ?? [])
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');

  if (!answer) {
    const reason = data.promptFeedback?.blockReason ?? candidate?.finishReason ?? 'no answer';
    throw new Error(`Gemini returned no estimate (${reason}).`);
  }

  let parsed;
  try {
    parsed = JSON.parse(answer.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new Error('Gemini returned an answer that was not valid JSON. Try again.');
  }

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
