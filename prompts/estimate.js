// The prompt for calorie estimates: the instructions Gemini gets, and the JSON schema its answer
// must follow. gemini.js sends these with the meal's description and photos, and reads the
// answer's fields (see toEstimate()), so a field renamed here must be renamed there too.
// The instructions are plain text in backticks, so they can't contain a backtick or ${.

export const INSTRUCTIONS = `You are a nutrition expert estimating the calories in a meal someone ate.
You will get a text description, one or more photos, or both.

- Identify each food and drink, estimate its portion size, and estimate its calories.
  In photos, use plates, utensils, hands and packaging to judge scale.
- Prefer the text over the photo for things a photo can't show: quantities, how much was
  actually eaten, ingredients, brands, cooking method.
- If a nutrition label or a menu with calorie counts is visible or mentioned, use those numbers.
- Include likely hidden calories such as cooking oil, butter, dressings and sauces.
- Give one best estimate per item, never a range. total_calories must equal the sum of the items.
- If there is no food or drink at all, return an empty items list, 0 calories, and say so in notes.`;

export const SCHEMA = {
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
