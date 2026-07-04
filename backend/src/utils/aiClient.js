const { OpenAI } = require('openai');
const db = require('../db');
const { decrypt } = require('./encryption');

// Default models per provider — used when no model is explicitly saved
const DEFAULT_MODELS = {
  openai: 'gpt-4o',
  claude: 'claude-sonnet-4-5',
};

async function getSettings() {
  return db.prepare(`
    SELECT ai.* FROM ai_settings ai
    JOIN users u ON u.id = ai.user_id
    WHERE u.role IN ('org_admin', 'super_admin') AND ai.api_key IS NOT NULL AND ai.api_key != ''
    ORDER BY ai.id DESC LIMIT 1
  `).get();
}

/**
 * Call the configured AI provider.
 * @param {number} userId
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {'script'|'heal'} [purpose='script'] — selects which saved model to use
 */
async function callAi(userId, systemPrompt, userPrompt, purpose = 'script') {
  const settings = await getSettings();
  if (!settings || !settings.api_key) {
    throw new Error('AI not configured. Go to Settings → AI Configuration to add your API key.');
  }

  // Pick model based on purpose:
  //   'script' → settings.model (script generation model)
  //   'heal'   → settings.heal_model (auto healer model), falls back to script model
  const rawModel = purpose === 'heal'
    ? (settings.heal_model && settings.heal_model.trim()) || (settings.model && settings.model.trim())
    : (settings.model && settings.model.trim());
  const model = rawModel || DEFAULT_MODELS[settings.provider] || 'gpt-4o';

  // Decrypt the stored API key before use
  const apiKey = decrypt(settings.api_key);

  if (settings.provider === 'openai') {
    const client = new OpenAI({ apiKey });
    const resp = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
      temperature: 0.2,
    });
    return resp.choices[0].message.content;
  }

  if (settings.provider === 'claude') {
    // Uses OpenAI-compatible endpoint via Anthropic
    const client = new OpenAI({
      apiKey,
      baseURL: 'https://api.anthropic.com/v1/',
      defaultHeaders: { 'anthropic-version': '2023-06-01' },
    });
    const resp = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
      temperature: 0.2,
    });
    return resp.choices[0].message.content;
  }

  throw new Error(`Unknown AI provider: ${settings.provider}`);
}

module.exports = { callAi };
