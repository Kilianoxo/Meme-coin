/**
 * Client Anthropic — 100% maison, fetch brut, aucun SDK
 * Doc: https://docs.anthropic.com/en/api/messages
 */

const API_URL = 'https://api.anthropic.com/v1/messages';

/**
 * @param {Object} params
 * @param {string} params.model         - ID du modèle Claude
 * @param {number} params.maxTokens     - Tokens max en réponse
 * @param {string} [params.system]      - System prompt
 * @param {Array}  params.messages      - Historique [{role, content}]
 * @returns {Promise<Object>}           - Réponse complète de l'API
 */
async function createMessage({ model = 'claude-haiku-4-5-20251001', maxTokens = 512, system, messages }) {
  const body = { model, max_tokens: maxTokens, messages };
  if (system) body.system = system;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${err}`);
  }

  return res.json();
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
