/**
 * Prix USD des tokens — Jupiter Price API v3 (la v2 est dépréciée depuis
 * le 30/09/2025 et ses limites d'accès sont réduites progressivement).
 *
 * - Requêtes groupées : jusqu'à 50 mints par appel
 * - Cache court (PRICE_TTL_MS) pour que trader, paper et dashboard qui
 *   demandent les mêmes tokens au même moment ne multiplient pas les appels
 * - Lit aussi l'ancien format v2 ({ data: { mint: { price } } }) par sécurité
 */

const PRICE_URL    = process.env.JUPITER_PRICE_URL || 'https://lite-api.jup.ag/price/v3';
const PRICE_TTL_MS = 3_000;
const BATCH        = 50;

const _cache = new Map(); // mint → { ts, price }

function _parse(json, mint) {
  const v3 = json?.[mint];
  if (v3 && v3.usdPrice != null) return parseFloat(v3.usdPrice);
  const v2 = json?.data?.[mint];
  if (v2 && v2.price != null) return parseFloat(v2.price);
  return null;
}

async function _fetchChunk(mints) {
  const headers = { Accept: 'application/json' };
  if (process.env.JUPITER_API_KEY) headers['x-api-key'] = process.env.JUPITER_API_KEY;
  const res = await fetch(`${PRICE_URL}?ids=${mints.join(',')}`, { headers, signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`Jupiter price HTTP ${res.status}`);
  return res.json();
}

/**
 * @param {string[]} mints
 * @returns {Promise<Object<string, number>>} mint → prix USD (mints inconnus absents)
 */
async function getPrices(mints) {
  const now  = Date.now();
  const out  = {};
  const todo = [];
  for (const m of new Set(mints.filter(Boolean))) {
    const c = _cache.get(m);
    if (c && now - c.ts < PRICE_TTL_MS) { if (c.price != null) out[m] = c.price; }
    else todo.push(m);
  }
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    try {
      const json = await _fetchChunk(chunk);
      for (const m of chunk) {
        const p = _parse(json, m);
        const price = p > 0 ? p : null;
        _cache.set(m, { ts: now, price });
        if (price != null) out[m] = price;
      }
    } catch { /* réseau / quota : les mints absents seront retentés au prochain appel */ }
  }
  return out;
}

async function getPrice(mint) {
  return (await getPrices([mint]))[mint] ?? null;
}

module.exports = { getPrices, getPrice, PRICE_URL };
