/**
 * Scanner de tokens — Interroge DexScreener toutes les 30s
 * Émet des événements: 'candidate' (token brut) et 'debate' (résultat IA)
 */

const { EventEmitter } = require('events');
const dex = require('./dexscreener');
const { runDebate } = require('./agents');
const pumpFun = require('./pumpfun');
const birdeye = require('./birdeye');
const gecko = require('./geckoterminal');
const rugcheck = require('./rugcheck');

const MIGRATION_DEXSCREENER_RETRY_ATTEMPTS = 2;
const MIGRATION_DEXSCREENER_RETRY_DELAY_MS = 30_000; // 30s entre chaque tentative (max 60s)

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

  /**
   * Scanne GeckoTerminal — nouveaux pools + trending Solana.
   * Retourne des paires déjà normalisées (format DexScreener).
   * Filtre sur les critères habituels avant de retourner.
   */
  async _scanGecko() {
    let pools = [];
    try {
      const [newPools, trending] = await Promise.all([
        gecko.getNewPools(),
        gecko.getTrendingPools(),
      ]);
      // Déduplique par adresse de pool (un même pool peut être dans les deux listes)
      const seen = new Set();
      for (const p of [...newPools, ...trending]) {
        const key = p.pairAddress || p.baseToken?.address;
        if (key && !seen.has(key)) {
          seen.add(key);
          pools.push(p);
        }
      }
    } catch (err) {
      console.error('[Scanner] Erreur GeckoTerminal:', err.message);
      return [];
    }

    const results = [];
    for (const pair of pools) {
      const addr = pair.baseToken?.address;
      if (!addr || this.seenAddresses.has(addr)) continue;
      if (this._passesFilters(pair)) {
        results.push(pair);
        this.seenAddresses.add(addr);
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
      const [boosted, profiles, geckoResults] = await Promise.all([
        this._scanBoosted(),
        this._scanProfiles(),
        this._scanGecko(),
      ]);
      // Déduplique par adresse de token (les 3 sources peuvent se chevaucher)
      const seen = new Set();
      for (const pair of [...boosted, ...profiles, ...geckoResults]) {
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

      // Lance le débat IA en arrière-plan (avec données Birdeye si dispo)
      this._analyzeToken(token)
        .catch((err) => console.error('[Scanner] Erreur analyse:', err.message));
    }
  }

  /**
   * Récupère les données Birdeye, applique le hard filter, puis lance le débat IA
   */
  async _analyzeToken(token) {
    const address = token.baseToken?.address;
    const symbol = token.baseToken?.symbol || '???';

    // Enrichissement Birdeye + RugCheck (summary + LP lock) en parallèle
    const [{ security, overview }, rugReport, lpLock] = await Promise.all([
      birdeye.getTokenData(address),
      rugcheck.getTokenReport(address),
      rugcheck.getLpLockData(address),
    ]);

    // Hard filter Birdeye (mint authority, concentration holders, holders < 50)
    if (birdeye.isHardBlocked(security, overview)) {
      const holders = overview?.holder ?? '?';
      console.log(`[Scanner] ⛔ ${symbol} bloqué Birdeye (mint/concentration/holders: ${holders})`);
      return;
    }

    // Hard filter RugCheck (rugpull détecté, score > 800, risque "danger")
    if (rugcheck.isHardBlocked(rugReport)) {
      const score = rugReport?.score ?? '?';
      console.log(`[Scanner] ⛔ ${symbol} bloqué RugCheck (score: ${score})`);
      return;
    }

    const lpPct = lpLock ? `${lpLock.lpLockedPct.toFixed(0)}% LP lock` : 'LP lock: ?';
    console.log(`[Scanner] ✅ ${symbol} passe les filtres — ${lpPct}`);

    const debate = await runDebate(token, security, rugReport, overview, lpLock);
    this.emit('debate', debate);
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[Scanner] Démarré — filtres: liq>${FILTERS.minLiquidityUsd}$, vol24h>${FILTERS.minVolume24hUsd}$`);
    this._listenToPumpFun();
    pumpFun.start();
    this.scan();
    this._interval = setInterval(() => this.scan(), SCAN_INTERVAL_MS);
  }

  stop() {
    if (!this.isRunning) return;
    clearInterval(this._interval);
    pumpFun.stop();
    this.isRunning = false;
    console.log('[Scanner] Arrêté.');
  }

  /** Écoute les événements PumpPortal WebSocket */
  _listenToPumpFun() {
    // Nouveau token sur la bonding curve — on stocke le mint pour contexte
    pumpFun.on('newToken', (token) => {
      this.emit('pumpNew', token);
    });

    // Token gradué — maintenant tradeable via Jupiter, analyse immédiate
    pumpFun.on('migration', async (migration) => {
      const sym = migration.symbol || migration.mint?.slice(0, 8) || '???';

      let pair = null;
      for (let attempt = 1; attempt <= MIGRATION_DEXSCREENER_RETRY_ATTEMPTS; attempt++) {
        await new Promise((r) => setTimeout(r, MIGRATION_DEXSCREENER_RETRY_DELAY_MS));
        const pairs = await dex.getTokenPairs('solana', migration.mint);
        pair = this._bestPair(pairs);
        if (pair) break;
        console.log(`[Scanner] Migration ${sym} — pas encore indexé (tentative ${attempt}/${MIGRATION_DEXSCREENER_RETRY_ATTEMPTS})`);
      }

      try {
        if (!pair) {
          console.log(`[Scanner] Migration ${sym} — abandonné après ${MIGRATION_DEXSCREENER_RETRY_ATTEMPTS} tentatives`);
          return;
        }

        // Pour les graduations on bypass les filtres de volume/liquidité
        // (le pool vient juste d'être créé, les métriques sont encore basses)
        if (this.seenAddresses.has(migration.mint)) return;
        this.seenAddresses.add(migration.mint);

        console.log(`[Scanner] 🎓 Analyse de la graduation: ${sym}`);
        const [{ security, overview }, rugReport, lpLock] = await Promise.all([
          birdeye.getTokenData(migration.mint),
          rugcheck.getTokenReport(migration.mint),
          rugcheck.getLpLockData(migration.mint),
        ]);

        if (birdeye.isHardBlocked(security, overview)) {
          console.log(`[Scanner] ⛔ Graduation ${sym} bloquée Birdeye`);
          return;
        }

        if (rugcheck.isHardBlocked(rugReport)) {
          console.log(`[Scanner] ⛔ Graduation ${sym} bloquée RugCheck (score: ${rugReport?.score ?? '?'})`);
          return;
        }

        runDebate(pair, security, rugReport, overview, lpLock)
          .then((debate) => {
            debate.isGraduated = true;
            this.emit('debate', debate);
          })
          .catch((err) => console.error('[Scanner] Erreur débat graduation:', err.message));
      } catch (err) {
        console.error('[Scanner] Erreur fetch graduation:', err.message);
      }
    });
  }

  getStats() {
    const pumpStats = pumpFun.getStats();
    return {
      scanCount: this.scanCount,
      seenTokens: this.seenAddresses.size,
      isRunning: this.isRunning,
      pumpFunConnected: pumpStats.connected,
      pumpNewTokens: pumpStats.newTokenCount,
      pumpMigrations: pumpStats.migrationCount,
    };
  }

  /** Remet à zéro les tokens vus (utile pour rescanner) */
  resetSeen() {
    this.seenAddresses.clear();
  }
}

module.exports = Scanner;
