/**
 * Client Birdeye — Sécurité et données avancées on-chain
 *
 * Clé gratuite sur https://bds.birdeye.so (30K compute units/mois, 1 RPS)
 * Variable d'env: BIRDEYE_API_KEY
 *
 * Endpoints utilisés:
 *   GET /defi/token_security  — mint authority, freeze authority, concentration holders
 *   GET /defi/token_overview  — holder count, volume, market cap enrichi
 */

const BASE_URL = 'https://public-api.birdeye.so';

/** Retourne null si pas de clé ou si le token n'existe pas sur Birdeye */
async function fetchBirdeye(path) {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: {
        'accept': 'application/json',
        'X-API-KEY': apiKey,
        'x-chain': 'solana',
      },
    });

    if (res.status === 401) {
      console.warn('[Birdeye] Clé API invalide (401)');
      return null;
    }
    if (res.status === 429) {
      console.warn('[Birdeye] Rate limit atteint (429)');
      return null;
    }
    if (!res.ok) return null;

    const json = await res.json();
    return json?.data || null;
  } catch {
    return null;
  }
}

/**
 * Données de sécurité d'un token
 * @returns {Promise<Object|null>}
 * {
 *   mintAuthority: string|null,      // null = révoqué (bon signe)
 *   freezeAuthority: string|null,    // null = révoqué (bon signe)
 *   top10HolderPercent: number,      // % supply tenu par les 10 plus gros holders
 *   creatorPercentage: number,       // % supply tenu par le créateur
 *   ownerPercentage: number,         // % supply tenu par l'owner
 * }
 */
async function getTokenSecurity(tokenAddress) {
  return fetchBirdeye(`/defi/token_security?address=${tokenAddress}`);
}

/**
 * Vue d'ensemble d'un token (complète DexScreener)
 * @returns {Promise<Object|null>}
 * {
 *   holder: number,      // Nombre de holders uniques
 *   price: number,
 *   mc: number,          // Market cap
 *   v24hUSD: number,     // Volume 24h en USD
 *   liquidity: number,
 * }
 */
async function getTokenOverview(tokenAddress) {
  return fetchBirdeye(`/defi/token_overview?address=${tokenAddress}`);
}

/**
 * Récupère security + overview en parallèle
 * @returns {Promise<{ security: Object|null, overview: Object|null }>}
 */
async function getTokenData(tokenAddress) {
  const [security, overview] = await Promise.all([
    getTokenSecurity(tokenAddress),
    getTokenOverview(tokenAddress),
  ]);
  return { security, overview };
}

/**
 * Hard filter — retourne true si le token est trop dangereux pour être analysé
 * Règles:
 *   - Mint authority encore active → peut printer des tokens à l'infini → DANGER
 *   - Créateur détient > 20% du supply → risque de dump → DANGER
 *   - Top 10 holders > 90% du supply → manipulation évidente → DANGER
 */
function isHardBlocked(security) {
  if (!security) return false; // Pas de données = on laisse passer

  if (security.mintAuthority !== null && security.mintAuthority !== undefined) {
    return true; // Mint authority active
  }
  if ((security.creatorPercentage || 0) > 20) {
    return true; // Créateur tient trop de tokens
  }
  if ((security.top10HolderPercent || 0) > 90) {
    return true; // Concentration extrême
  }

  return false;
}

/** Formate le résumé sécurité pour l'affichage Telegram */
function formatSecurity(security) {
  if (!security) return null;

  const mint = security.mintAuthority ? '🔴 Active' : '✅ Révoquée';
  const freeze = security.freezeAuthority ? '🔴 Active' : '✅ Révoquée';
  const top10 = security.top10HolderPercent != null
    ? `${security.top10HolderPercent.toFixed(1)}%` : '?';
  const creator = security.creatorPercentage != null
    ? `${security.creatorPercentage.toFixed(1)}%` : '?';

  return { mint, freeze, top10, creator };
}

module.exports = { getTokenSecurity, getTokenOverview, getTokenData, isHardBlocked, formatSecurity };
