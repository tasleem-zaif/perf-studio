const { OpenAI, AzureOpenAI } = require('openai');
const db = require('../db');
const { decrypt } = require('./encryption');

// Default models per provider — used when no model is explicitly saved. Kept in sync with
// Settings.jsx's DEFAULT_MODEL — both were pointing at a stale Claude model ID until this pass.
// No entry for 'azure' — a deployment name is account-specific, there's no sane fallback.
const DEFAULT_MODELS = {
  openai: 'gpt-4o',
  claude: 'claude-sonnet-5',
  gemini: 'gemini-2.0-flash',
};

// Each provider's hard output-token ceiling — not a config knob, the actual model limit.
// A response asking the model to reproduce a whole script can never exceed this regardless
// of how max_tokens is set; callers that need to reproduce a whole file (auto-heal's
// full-script rewrite) must check the script's own size against this before calling, since
// no retry will ever get more room.
const MAX_OUTPUT_TOKENS = {
  openai: 16384, // gpt-4o's actual hard ceiling — max_tokens above this is rejected/clamped by OpenAI itself
  claude: 8192,  // Claude's default ceiling without the extended-output beta header (untested here — see note in getMaxOutputTokens callers)
  gemini: 8192,  // conservative ceiling shared by current Gemini 2.x models
  azure: 16384,  // Azure OpenAI deployments are typically GPT-4o-class — same ceiling as openai
};

async function getSettings() {
  return db.prepare(`
    SELECT ai.* FROM ai_settings ai
    JOIN users u ON u.id = ai.user_id
    WHERE u.role IN ('org_admin', 'super_admin') AND ai.api_key IS NOT NULL AND ai.api_key != ''
    ORDER BY ai.id DESC LIMIT 1
  `).get();
}

// Returns the current provider's max output tokens, or null if AI isn't configured yet —
// lets a caller pre-flight-check "will this response even fit" before spending a call.
async function getMaxOutputTokens() {
  const settings = await getSettings();
  if (!settings) return null;
  return MAX_OUTPUT_TOKENS[settings.provider] || MAX_OUTPUT_TOKENS.openai;
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
  if (settings.provider === 'azure' && !rawModel) {
    throw new Error('Azure OpenAI deployment name not configured. Go to Settings → AI Configuration and enter your deployment name.');
  }
  const model = rawModel || DEFAULT_MODELS[settings.provider] || 'gpt-4o';

  // Decrypt the stored API key before use
  const apiKey = decrypt(settings.api_key);

  // Both 'script' (k6) and 'heal' can ask the model to reproduce an entire generated
  // script (JMX/JS, easily tens of KB) verbatim inside a JSON string field — without an
  // explicit max_tokens, both providers' (and especially Anthropic's OpenAI-compatibility
  // shim, where max_tokens is a required field natively) low implicit defaults truncate
  // mid-string on anything but a small script, producing "Unterminated string in JSON"
  // and a wasted round-trip. Sized to each provider's actual output ceiling.
  const maxTokens = MAX_OUTPUT_TOKENS[settings.provider] || MAX_OUTPUT_TOKENS.openai;

  // A response cut off by the token limit (finish_reason 'length') is truncated mid-JSON
  // by definition — surface that plainly instead of letting the caller's JSON.parse fail
  // with a cryptic "Unterminated string" and no indication of why.
  function checkTruncated(resp) {
    if (resp.choices[0].finish_reason === 'length') {
      throw new Error(`AI response was cut off at the ${maxTokens}-token output limit before it could finish — the script is likely too large for the configured model to rewrite in one response.`);
    }
    return resp.choices[0].message.content;
  }

  if (settings.provider === 'openai') {
    const client = new OpenAI({ apiKey });
    const resp = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
      temperature: 0.2,
      max_tokens: maxTokens,
    });
    return checkTruncated(resp);
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
      max_tokens: maxTokens,
    });
    return checkTruncated(resp);
  }

  if (settings.provider === 'gemini') {
    // Uses Google's OpenAI-compatible endpoint
    const client = new OpenAI({
      apiKey,
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    });
    const resp = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
      temperature: 0.2,
      max_tokens: maxTokens,
    });
    return checkTruncated(resp);
  }

  if (settings.provider === 'azure') {
    if (!settings.azure_endpoint) {
      throw new Error('Azure OpenAI endpoint not configured. Go to Settings → AI Configuration and enter your resource endpoint.');
    }
    const client = new AzureOpenAI({
      apiKey,
      endpoint: settings.azure_endpoint,
      apiVersion: (settings.azure_api_version && settings.azure_api_version.trim()) || '2024-10-21',
    });
    // model here is the deployment name, not a base model ID — Azure routes by deployment
    const resp = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
      temperature: 0.2,
      max_tokens: maxTokens,
    });
    return checkTruncated(resp);
  }

  throw new Error(`Unknown AI provider: ${settings.provider}`);
}

module.exports = { callAi, getMaxOutputTokens };
