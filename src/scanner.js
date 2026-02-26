/**
 * Scanner de tokens — Interroge DexScreener toutes les 30s
 * Émet des événements: 'candidate' (token brut) et 'debate' (résultat IA)
 */

const { EventEmitter } = require('events');
const dex = require('./dexscreener');
const { runDebate } = require('./agents');

const SCAN_INTERVAL_MS = 30_000; // 30 secondes

const FILTERS = {
  minLiquidityUsd: parseFloat(process.env.MIN_LIQUIDITY_USD || '10000'),
  minVolume24hUsd: parseFloat(process.env.MIN_VOLUME_24H_USD || '50000'),
  minMarketCapUsd: parseFloat(process.env.MIN_MARKET_CAP_USD || '100000'),
  maxAgeHours: parseFloat(process.env.MAX_TOKEN_AGE_HOURS || '24'),
};

class Scanner extends EventEmitter {
  constructor() {
    super();
    this.seenAddresses = new Set();
    this.isRunning = false;
    this.scanCount = 0;
    this._interval = null;
  }

  /** Vérifie si une paire passe les filtres de base */
  _passesFilters(pair) {
    if (pair.chainId !== 'solana') return false;

    const liquidity = pair.liquidity?.usd || 0;
    const volume24h = pair.volume?.h24 || 0;
    const marketCap = pair.marketCap || pair.fdv || 0;

    if (liquidity < FILTERS.minLiquidityUsd) return false;
    if (volume24h < FILTERS.minVolume24hUsd) return false;
    if (marketCap < FILTERS.minMarketCapUsd) return false;

    if (pair.pairCreatedAt) {
      const ageHours = (Date.now() - pair.pairCreatedAt) / 3_600_000;
      if (ageHours > FILTERS.maxAgeHours) return false;
    }

    return true;
  }

  /** Sélectionne la meilleure paire (liquidité la plus haute) parmi toutes les paires d'un token */
  _bestPair(pairs) {
    if (!Array.isArray(pairs) || pairs.length === 0) return null;
    return pairs
      .filter((p) => p.chainId === 'solana')
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0] || null;
  }

  /** Récupère la paire complète d'un token à partir de son adresse */
  async _fetchBestPair(tokenAddress) {
    try {
      const pairs = await dex.getTokenPairs('solana', tokenAddress);
      return this._bestPair(pairs);
    } catch {
      return null;
    }
  }

  /** Scanne les tokens boostés (ont payé pour être mis en avant) */
  async _scanBoosted() {
    const boosted = await dex.getLatestBoostedTokens();
    if (!Array.isArray(boosted)) return [];

    const results = [];
    for (const item of boosted) {
      if (!item.tokenAddress || this.seenAddresses.has(item.tokenAddress)) continue;
      const pair = await this._fetchBestPair(item.tokenAddress);
      if (pair && this._passesFilters(pair)) {
        results.push(pair);
        this.seenAddresses.add(item.tokenAddress);
      }
    }
    return results;
  }

  /** Scanne les derniers tokens ayant créé un profil */
  async _scanProfiles() {
    const profiles = await dex.getLatestTokenProfiles();
    if (!Array.isArray(profiles)) return [];

    const results = [];
    for (const item of profiles) {
      if (!item.tokenAddress || this.seenAddresses.has(item.tokenAddress)) continue;
      const pair = await this._fetchBestPair(item.tokenAddress);
      if (pair && this._passesFilters(pair)) {
        results.push(pair);
        this.seenAddresses.add(item.tokenAddress);
      }
    }
    return results;
  }

  /** Un cycle de scan complet */
  async scan() {
    this.scanCount++;
    console.log(`[Scanner] Scan #${this.scanCount} (${new Date().toLocaleTimeString('fr-FR')})`);

    let candidates = [];
    try {
      const [boosted, profiles] = await Promise.all([
        this._scanBoosted(),
        this._scanProfiles(),
      ]);
      // Déduplique par adresse de token
      const seen = new Set();
      for (const pair of [...boosted, ...profiles]) {
        const addr = pair.baseToken?.address;
        if (addr && !seen.has(addr)) {
          seen.add(addr);
          candidates.push(pair);
        }
      }
    } catch (err) {
      console.error('[Scanner] Erreur lors du scan:', err.message);
      return;
    }

    console.log(`[Scanner] ${candidates.length} nouveau(x) candidat(s)`);

    for (const token of candidates) {
      // Émet immédiatement le candidat (pour l'alerte Telegram brute)
      this.emit('candidate', token);

      // Lance le débat IA en arrière-plan
      runDebate(token)
        .then((debate) => this.emit('debate', debate))
        .catch((err) => console.error('[Scanner] Erreur débat IA:', err.message));
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[Scanner] Démarré — filtres: liq>${FILTERS.minLiquidityUsd}$, vol24h>${FILTERS.minVolume24hUsd}$`);
    this.scan();
    this._interval = setInterval(() => this.scan(), SCAN_INTERVAL_MS);
  }

  stop() {
    if (!this.isRunning) return;
    clearInterval(this._interval);
    this.isRunning = false;
    console.log('[Scanner] Arrêté.');
  }

  getStats() {
    return {
      scanCount: this.scanCount,
      seenTokens: this.seenAddresses.size,
      isRunning: this.isRunning,
    };
  }

  /** Remet à zéro les tokens vus (utile pour rescanner) */
  resetSeen() {
    this.seenAddresses.clear();
  }
}

module.exports = Scanner;
