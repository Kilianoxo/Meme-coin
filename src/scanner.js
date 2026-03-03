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

// Délais d'attente avant chaque tentative de lookup DexScreener après une graduation
// Tentative 1 → attend 30s, tentative 2 → attend 45s
const MIGRATION_DEXSCREENER_DELAYS_MS = [30_000, 45_000];

// Nombre max de tokens envoyés en débat IA par cycle de scan
// Les candidats sont triés par pertinence avant sélection
const MAX_CANDIDATES_PER_SCAN = 5;

const SCAN_INTERVAL_MS = 30_000; // 30 secondes

// Durée pendant laquelle un token vu est ignoré.
// Après ce délai il redevient éligible — utile pour les tokens plus âgés
// qui gagnent du momentum après notre premier passage.
const SEEN_TTL_MS = 4 * 3_600_000; // 4 heures

const FILTERS = {
  minLiquidityUsd: parseFloat(process.env.MIN_LIQUIDITY_USD    || '10000'),
  minVolume24hUsd: parseFloat(process.env.MIN_VOLUME_24H_USD   || '50000'),
  minMarketCapUsd: parseFloat(process.env.MIN_MARKET_CAP_USD   || '100000'),
  maxAgeHours:     parseFloat(process.env.MAX_TOKEN_AGE_HOURS  || '72'),
  minAgeHours:     parseFloat(process.env.MIN_TOKEN_AGE_HOURS  || '1'),  // ignore < 1h par défaut
};

class Scanner extends EventEmitter {
  constructor() {
    super();
    // Map<address, expiryTimestamp> — TTL 4h, permet de rescanner des tokens
    // plus âgés qui gagnent du momentum après notre premier passage.
    this.seenAddresses = new Map();
    this.isRunning = false;
    this.scanCount = 0;
    this._interval = null;
  }

  /** Vérifie si un token a déjà été vu récemment (TTL 4h) */
  _isSeen(address) {
    const expiry = this.seenAddresses.get(address);
    if (expiry === undefined) return false;
    if (Date.now() >= expiry) { this.seenAddresses.delete(address); return false; }
    return true;
  }

  /** Marque un token comme vu pour SEEN_TTL_MS */
  _markSeen(address) {
    this.seenAddresses.set(address, Date.now() + SEEN_TTL_MS);
  }

  /**
   * Vérifie si une paire passe les filtres de base.
   * @param {Object}  pair
   * @param {boolean} skipAgeFilter — true pour les sources "trending/top" où
   *                                  les tokens peuvent être plus âgés mais
   *                                  avoir du momentum prouvé.
   */
  _passesFilters(pair, skipAgeFilter = false) {
    if (pair.chainId !== 'solana') return false;

    const liquidity = pair.liquidity?.usd || 0;
    const volume24h = pair.volume?.h24 || 0;
    const marketCap = pair.marketCap || pair.fdv || 0;

    if (liquidity < FILTERS.minLiquidityUsd) return false;
    if (volume24h < FILTERS.minVolume24hUsd) return false;
    if (marketCap < FILTERS.minMarketCapUsd) return false;

    if (pair.pairCreatedAt) {
      const ageHours = (Date.now() - pair.pairCreatedAt) / 3_600_000;

      // Trop récent : pas assez de données pour une analyse fiable
      if (ageHours < FILTERS.minAgeHours) return false;

      // Trop vieux : sauf pour les sources trending/top-boosted (skipAgeFilter)
      if (!skipAgeFilter && ageHours > FILTERS.maxAgeHours) return false;
    }

    return true;
  }

  /**
   * Score de pertinence rapide (sans LLM) pour prioriser les meilleurs candidats.
   * Combine vélocité de volume, pression acheteuse et momentum prix récent.
   * Retourne un nombre positif — plus c'est haut, plus le token est intéressant.
   */
  _relevanceScore(pair) {
    const liq      = pair.liquidity?.usd  || 1;          // évite division par 0
    const volH1    = pair.volume?.h1      || 0;
    const pc       = pair.priceChange     || {};
    const tx       = pair.txns?.h1        || {};
    const buys     = tx.buys  || 0;
    const sells    = tx.sells || 0;
    const total    = buys + sells || 1;

    const volVelocity  = volH1 / liq;                         // volume récent / pool
    const buyPressure  = buys / total;                        // 0→1, >0.5 = majorité acheteurs
    const priceBonus   = 1 + Math.max(0, (pc.h1 || 0)) / 100; // bonus si prix monte

    return volVelocity * buyPressure * priceBonus;
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

  /**
   * Scanne les tokens avec le plus de boosts actifs (soutenu, pas juste récent).
   * Signal plus fort que "latest" : ces tokens ont payé et maintiennent leur boost.
   * skipAgeFilter = true car un top-boosted peut être établi depuis plusieurs jours.
   */
  async _scanTopBoosted() {
    const boosted = await dex.getTopBoostedTokens();
    if (!Array.isArray(boosted)) return [];

    const results = [];
    for (const item of boosted) {
      if (!item.tokenAddress || this._isSeen(item.tokenAddress)) continue;
      const pair = await this._fetchBestPair(item.tokenAddress);
      if (pair && this._passesFilters(pair, true)) {
        results.push({ ...pair, _source: 'dex-top-boosted' });
        this._markSeen(item.tokenAddress);
      }
    }
    return results;
  }

  /**
   * Scanne GeckoTerminal — trending uniquement (plus de nouveaux pools).
   * Les nouveaux pools = 95 % de bruit; le trending = momentum avéré sur 24h.
   * skipAgeFilter = true : ces tokens ont peut-être quelques jours mais ils bougent.
   */
  async _scanTrending() {
    let trending = [];
    try {
      trending = await gecko.getTrendingPools();
    } catch (err) {
      console.error('[Scanner] Erreur GeckoTerminal trending:', err.message);
      return [];
    }

    const results = [];
    for (const pair of trending) {
      const addr = pair.baseToken?.address;
      if (!addr || this._isSeen(addr)) continue;
      if (this._passesFilters(pair, true)) {
        results.push({ ...pair, _source: 'gecko-trending' });
        this._markSeen(addr);
      }
    }
    return results;
  }

  /** Un cycle de scan complet */
  async scan() {
    this.scanCount++;
    console.log(`[Scanner] Scan #${this.scanCount} (${new Date().toLocaleTimeString('fr-FR')})`);

    let candidates = [];
    let trending = [], topBoosted = [];
    try {
      // Deux sources uniquement : trending + top-boosted
      // Les deux ignorent le filtre d'âge MAX (tokens établis avec momentum)
      // mais le filtre MIN s'applique partout (ignore les < 1h)
      [trending, topBoosted] = await Promise.all([
        this._scanTrending(),
        this._scanTopBoosted(),
      ]);
      // Déduplique par adresse de token (les 2 sources peuvent se chevaucher)
      const seen = new Set();
      for (const pair of [...trending, ...topBoosted]) {
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

    // Trie par pertinence (vélocité volume × buy pressure × momentum prix)
    // et ne garde que les MAX_CANDIDATES_PER_SCAN meilleurs pour les débats IA
    candidates.sort((a, b) => this._relevanceScore(b) - this._relevanceScore(a));
    const toAnalyze = candidates.slice(0, MAX_CANDIDATES_PER_SCAN);

    console.log(`[Scanner] ${candidates.length} candidat(s) [${trending.length} trending, ${topBoosted.length} top-boosted] — top ${toAnalyze.length} en débat IA`);

    for (const token of toAnalyze) {
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

    const lpPct   = lpLock ? `${lpLock.lpLockedPct.toFixed(0)}% LP lock` : 'LP lock: ?';
    const source  = token._source ? ` [${token._source}]` : '';
    console.log(`[Scanner] ✅ ${symbol}${source} passe les filtres — ${lpPct}`);

    const debate = await runDebate(token, security, rugReport, overview, lpLock);
    if (debate) this.emit('debate', debate);
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[Scanner] Démarré — filtres: liq>${FILTERS.minLiquidityUsd}$, vol24h>${FILTERS.minVolume24hUsd}$, âge: ${FILTERS.minAgeHours}h–${FILTERS.maxAgeHours}h`);
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
      for (let i = 0; i < MIGRATION_DEXSCREENER_DELAYS_MS.length; i++) {
        await new Promise((r) => setTimeout(r, MIGRATION_DEXSCREENER_DELAYS_MS[i]));
        const pairs = await dex.getTokenPairs('solana', migration.mint);
        pair = this._bestPair(pairs);
        if (pair) break;
        console.log(`[Scanner] Migration ${sym} — pas encore indexé (tentative ${i + 1}/${MIGRATION_DEXSCREENER_DELAYS_MS.length})`);
      }

      try {
        if (!pair) {
          console.log(`[Scanner] Migration ${sym} — abandonné après ${MIGRATION_DEXSCREENER_DELAYS_MS.length} tentatives`);
          return;
        }

        // Pour les graduations on bypass les filtres de volume/liquidité
        // (le pool vient juste d'être créé, les métriques sont encore basses)
        if (this._isSeen(migration.mint)) return;
        this._markSeen(migration.mint);

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
            if (!debate) return;
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
    // Nettoie les entrées expirées avant de compter
    const now = Date.now();
    for (const [addr, expiry] of this.seenAddresses) {
      if (now >= expiry) this.seenAddresses.delete(addr);
    }
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
