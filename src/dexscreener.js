/**
 * Client DexScreener — 100% maison, aucun SDK, fetch brut
 * Base URL: https://api.dexscreener.com
 * Rate limit: 300 req/min — aucune clé requise
 */

const BASE_URL = 'https://api.dexscreener.com';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(1000 * (attempt + 1));
    }
  }
}

/** Derniers tokens avec un profil créé sur DexScreener */
async function getLatestTokenProfiles() {
  return fetchJson(`${BASE_URL}/token-profiles/latest/v1`);
}

/** Tokens ayant reçu des boosts récemment (hype active) */
async function getLatestBoostedTokens() {
  return fetchJson(`${BASE_URL}/token-boosts/latest/v1`);
}

/** Tokens avec le plus de boosts actifs en ce moment */
async function getTopBoostedTokens() {
  return fetchJson(`${BASE_URL}/token-boosts/top/v1`);
}

/** Recherche de paires par nom, symbole ou adresse */
async function searchPairs(query) {
  return fetchJson(`${BASE_URL}/latest/dex/search?q=${encodeURIComponent(query)}`);
}

/** Données complètes d'une paire par chainId + adresse de paire */
async function getPairByAddress(chainId, pairAddress) {
  return fetchJson(`${BASE_URL}/latest/dex/pairs/${chainId}/${pairAddress}`);
}

/**
 * Toutes les paires d'un token (prix, volume, liquidité, market cap, etc.)
 * C'est l'endpoint le plus complet pour analyser un token
 */
async function getTokenPairs(chainId, tokenAddress) {
  return fetchJson(`${BASE_URL}/token-pairs/v1/${chainId}/${tokenAddress}`);
}

/** Paires d'un ou plusieurs tokens (addresses séparées par virgule) */
async function getTokensByAddress(tokenAddresses) {
  const addresses = Array.isArray(tokenAddresses)
    ? tokenAddresses.join(',')
    : tokenAddresses;
  return fetchJson(`${BASE_URL}/latest/dex/tokens/${addresses}`);
}

/** Ordres actifs sur un token (nécessite que le token ait payé pour être listé) */
async function getOrders(chainId, tokenAddress) {
  return fetchJson(`${BASE_URL}/orders/v1/${chainId}/${tokenAddress}`);
}

module.exports = {
  getLatestTokenProfiles,
  getLatestBoostedTokens,
  getTopBoostedTokens,
  searchPairs,
  getPairByAddress,
  getTokenPairs,
  getTokensByAddress,
  getOrders,
};
