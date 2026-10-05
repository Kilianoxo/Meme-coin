/**
 * Client Anthropic — 100% maison, fetch brut, aucun SDK
 * Doc: https://docs.anthropic.com/en/api/messages
 *
 * Retry automatique sur 429 (rate limit) et 529 (overloaded) :
 *   tentative 1 → attend 30s → tentative 2 → attend 45s → abandon
 */

const API_URL      = 'https://api.anthropic.com/v1/messages';
const RETRY_DELAYS = [30_000, 45_000]; // ms avant chaque retry
const RETRYABLE    = new Set([429, 529]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {Object} params
 * @param {string} params.model         - ID du modèle Claude
 * @param {number} params.maxTokens     - Tokens max en réponse
 * @param {string} [params.system]      - System prompt
 * @param {Array}  params.messages      - Historique [{role, content}]
 * @param {Array}  [params.tools]       - Définitions d'outils (tool use)
 * @returns {Promise<Object>}           - Réponse complète de l'API
 */
async function createMessage({ model = 'claude-haiku-4-5-20251001', maxTokens = 512, system, messages, tools }) {
  const body = { model, max_tokens: maxTokens, messages };
  if (system) body.system = system;
  if (Array.isArray(tools) && tools.length > 0) body.tools = tools;

  const headers = {
    'Content-Type':      'application/json',
    'x-api-key':         process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  };

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });

    if (res.ok) return res.json();

    const err = await res.text();

    if (RETRYABLE.has(res.status) && attempt < RETRY_DELAYS.length) {
      const delay = RETRY_DELAYS[attempt];
      console.warn(`[Anthropic] ${res.status} — retry ${attempt + 1}/${RETRY_DELAYS.length} dans ${delay / 1000}s…`);
      await sleep(delay);
      continue;
    }

    throw new Error(`Anthropic API ${res.status}: ${err}`);
  }
}

/** Raccourci : retourne directement le texte de la première réponse */
async function ask(system, userMessage, model) {
  const response = await createMessage({
    model,
    system,
    messages: [{ role: 'user', content: userMessage }],
  });
  return response.content[0].text;
}

module.exports = { createMessage, ask };
