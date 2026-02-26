/**
 * Client GeckoTerminal — Source complémentaire de détection de tokens Solana
 *
 * API publique, sans clé, 30 req/min.
 * Docs: https://apiguide.geckoterminal.com/
 *
 * Endpoints utilisés:
 *   GET /networks/solana/new_pools      — nouveaux pools (très frais)
 *   GET /networks/solana/trending_pools — pools en tendance
 *
 * Retourne les données normalisées au format DexScreener pour compatibilité avec
 * le reste du bot (agents, scanner, bot.js).
 */

const BASE_URL = 'https://api.geckoterminal.com/api/v2';
const NETWORK = 'solana';

async function fetchGecko(path) {
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { accept: 'application/json;version=20230302' },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/**
 * Normalise un pool GeckoTerminal (JSON:API) vers le format DexScreener
 * utilisé partout dans le bot.
 *
 * @param {Object} pool     - item de data[]
 * @param {Array}  included - tableau included[] (tokens, dex)
 * @returns {Object} paire au format DexScreener
 */
function normalizePair(pool, included = []) {
  const attr = pool.attributes || {};

  // Résolution base_token depuis included
  const baseTokenRelId = pool.relationships?.base_token?.data?.id; // ex: "solana_AbCdEf..."
  const baseTokenRaw = included.find((i) => i.id === baseTokenRelId) || {};
  const baseTokenAttr = baseTokenRaw.attributes || {};

  // Résolution dex depuis included
  const dexRelId = pool.relationships?.dex?.data?.id;
  const dexRaw = included.find((i) => i.id === dexRelId) || {};

  // Adresse du token de base (enlève le préfixe "solana_")
  const baseAddress = baseTokenAttr.address || baseTokenRelId?.replace(/^solana_/, '') || '';

  // Date de création du pool
  const createdAt = attr.pool_created_at ? new Date(attr.pool_created_at).getTime() : null;

  return {
    // Champ source pour savoir d'où vient ce candidat
    _source: 'geckoterminal',

    chainId: NETWORK,
    dexId: dexRaw.attributes?.name || dexRelId || 'unknown',
    pairAddress: attr.address || '',
    pairCreatedAt: createdAt,

    baseToken: {
      address: baseAddress,
      symbol: baseTokenAttr.symbol || '???',
      name: baseTokenAttr.name || baseTokenAttr.symbol || '???',
    },

    priceUsd: attr.base_token_price_usd || '0',
    priceChange: {
      m5: parseFloat(attr.price_change_percentage?.m5 || 0),
      h1: parseFloat(attr.price_change_percentage?.h1 || 0),
      h6: parseFloat(attr.price_change_percentage?.h6 || 0),
      h24: parseFloat(attr.price_change_percentage?.h24 || 0),
    },

    volume: {
      m5: parseFloat(attr.volume_usd?.m5 || 0),
      h1: parseFloat(attr.volume_usd?.h1 || 0),
      h6: parseFloat(attr.volume_usd?.h6 || 0),
      h24: parseFloat(attr.volume_usd?.h24 || 0),
    },

    // GeckoTerminal appelle ça reserve_in_usd
    liquidity: {
      usd: parseFloat(attr.reserve_in_usd || 0),
    },

    marketCap: parseFloat(attr.market_cap_usd || 0),
    fdv: parseFloat(attr.fdv_usd || 0),

    txns: {
      m5: attr.transactions?.m5 || { buys: 0, sells: 0 },
      h1: attr.transactions?.h1 || { buys: 0, sells: 0 },
      h6: attr.transactions?.h6 || { buys: 0, sells: 0 },
      h24: attr.transactions?.h24 || { buys: 0, sells: 0 },
    },
  };
}

/**
 * Récupère les nouveaux pools Solana (page 1 = les + récents)
 * @returns {Promise<Object[]>} tableau de paires normalisées
 */
async function getNewPools() {
  const data = await fetchGecko(
    `/networks/${NETWORK}/new_pools?include=base_token,dex&page=1`
  );
  if (!data?.data) return [];
  const included = data.included || [];
  return data.data.map((pool) => normalizePair(pool, included));
}

/**
 * Récupère les pools en tendance sur Solana
 * @returns {Promise<Object[]>} tableau de paires normalisées
 */
async function getTrendingPools() {
  const data = await fetchGecko(
    `/networks/${NETWORK}/trending_pools?include=base_token,dex&page=1`
  );
  if (!data?.data) return [];
  const included = data.included || [];
  return data.data.map((pool) => normalizePair(pool, included));
}

module.exports = { getNewPools, getTrendingPools, normalizePair };
