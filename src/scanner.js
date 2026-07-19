/**
 * Scanner de tokens — 100% données GMGN
 * Émet des événements: 'candidate' (token brut) et 'debate' (résultat IA)
 *
 * Source unique : GMGN trending (gmgn-cli + GMGN_API_KEY requis).
 * Chaque ligne trending porte déjà toute la due-diligence (smart money, KOL,
 * snipers, bundlers, taxes, rug ratio, mint/freeze, holders) → zéro appel
 * supplémentaire par candidat, gates durs déterministes avant l'IA.
 *
 * DexScreener / GeckoTerminal / Birdeye / RugCheck / Pump.fun : supprimés.
 */

const { EventEmitter } = require('events');
const personalAgent = require('./personalAgent');
const gmgn          = require('./gmgn');
const tokenHistory  = require('./tokenHistory');
const state         = require('./state');

// Nombre max de tokens envoyés en débat IA par cycle de scan
// Les candidats sont triés par pertinence avant sélection
const MAX_CANDIDATES_PER_SCAN = 5;

const SCAN_INTERVAL_MS = 30_000; // 30 secondes

// Durée pendant laquelle un token vu est ignoré.
// Après ce délai il redevient éligible — utile pour les tokens plus âgés
// qui gagnent du momentum après notre premier passage.
const SEEN_TTL_MS = 4 * 3_600_000; // 4 heures

const FILTERS = {
  minLiquidityUsd: parseFloat(process.env.MIN_LIQUIDITY_USD    || '5000'),
  // Volume mesuré sur la fenêtre trending GMGN (1h par défaut) — plus strict qu'un 24h
  minVolumeUsd:    parseFloat(process.env.MIN_VOLUME_24H_USD   || '20000'),
  minMarketCapUsd: parseFloat(process.env.MIN_MARKET_CAP_USD   || '30000'),
  maxAgeHours:     parseFloat(process.env.MAX_TOKEN_AGE_HOURS  || '72'),
  minAgeHours:     parseFloat(process.env.MIN_TOKEN_AGE_HOURS  || '6'),
};

class Scanner extends EventEmitter {
  /**
   * @param {Object}   [opts]
   * @param {string}   [opts.chain='sol']  — chaîne GMGN : sol | robinhood | eth | bsc | base
   * @param {string}   [opts.label]        — préfixe de logs (défaut: Scanner / Scanner:chain)
   * @param {Function} [opts.analyzer]     — analyseur IA custom (défaut: ARIA)
   */
  constructor(opts = {}) {
    super();
    this.chain     = opts.chain || 'sol';
    this.label     = opts.label || (this.chain === 'sol' ? 'Scanner' : `Scanner:${this.chain}`);
    this._analyzer = opts.analyzer || null; // null → personalAgent.analyzeToken
    // Map<address, expiryTimestamp> — TTL 4h, permet de rescanner des tokens
    // plus âgés qui gagnent du momentum après notre premier passage.
    this.seenAddresses = new Map();
    this.isRunning = false;
    this.scanCount = 0;
    this._interval = null;
    this._gmgnWarned = false;
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
   * Redéfinit le TTL "vu" d'un token — utilisé pour re-analyser rapidement
   * les scores moyens (30-60) et détecter les ruptures de pattern (35 → 60).
   */
  markSeenTtl(address, ttlMs) {
    this.seenAddresses.set(address, Date.now() + ttlMs);
  }

  /**
   * Filtres de base (liquidité, volume, mcap, âge) sur une paire normalisée.
   * Le filtre d'âge MAX est ignoré : un trending GMGN peut être établi depuis
   * plusieurs jours et avoir du momentum prouvé. Le MIN s'applique toujours.
   */
  _passesFilters(pair) {
    const symbol    = pair.baseToken?.symbol || pair.baseToken?.address?.slice(0, 8) || '?';
    const liquidity = pair.liquidity?.usd || 0;
    const volume    = pair.volume?.h24 || 0;
    const marketCap = pair.marketCap || pair.fdv || 0;

    if (liquidity < FILTERS.minLiquidityUsd) {
      console.log(`[${this.label}] ⛔ ${symbol} liq trop faible: $${liquidity.toFixed(0)} < $${FILTERS.minLiquidityUsd}`);
      return false;
    }
    if (volume < FILTERS.minVolumeUsd) {
      console.log(`[${this.label}] ⛔ ${symbol} volume trop faible: $${volume.toFixed(0)} < $${FILTERS.minVolumeUsd}`);
      return false;
    }
    if (marketCap < FILTERS.minMarketCapUsd) {
      console.log(`[${this.label}] ⛔ ${symbol} mcap trop faible: $${marketCap.toFixed(0)} < $${FILTERS.minMarketCapUsd}`);
      return false;
    }

    if (pair.pairCreatedAt) {
      const ageHours = (Date.now() - pair.pairCreatedAt) / 3_600_000;
      if (ageHours < FILTERS.minAgeHours) {
        console.log(`[${this.label}] ⛔ ${symbol} trop récent: ${ageHours.toFixed(1)}h < ${FILTERS.minAgeHours}h`);
        return false;
      }
    }

    return true;
  }

  /**
   * Score de pertinence rapide (sans LLM) pour prioriser les meilleurs candidats.
   * Vélocité de volume × pression acheteuse × momentum prix, bonus smart money.
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
    // Bonus consensus GMGN : smart money + KOL présents = signal plus fort
    const g            = pair._gmgn;
    const smartBonus   = g ? 1 + Math.min(1, (g.smartDegen + g.renowned * 2) / 50) : 1;

    return volVelocity * buyPressure * priceBonus * smartBonus;
  }

  /** Un cycle de scan complet — source unique : GMGN trending */
  async scan() {
    this.scanCount++;
    console.log(`[${this.label}] Scan #${this.scanCount} (${new Date().toLocaleTimeString('fr-FR')})`);

    if (!(await gmgn.isAvailable())) {
      if (!this._gmgnWarned || this.scanCount % 20 === 0) {
        console.warn(`[${this.label}] ⚠️ GMGN non configuré (gmgn-cli + GMGN_API_KEY requis) — scanner en attente.`);
        this._gmgnWarned = true;
      }
      return;
    }

    let rows = [];
    try {
      rows = await gmgn.getTrending(this.chain);
    } catch (err) {
      console.error(`[${this.label}] Erreur GMGN trending (${this.chain}):`, err.message);
      return;
    }

    const candidates = [];
    for (const pair of rows) {
      const addr = pair.baseToken?.address;
      if (!addr || this._isSeen(addr)) continue;

      // Gates durs GMGN (honeypot, mint, taxes, bundlers, dev, top10, consensus)
      const gate = gmgn.hardGates(pair._gmgn, this.chain);
      if (!gate.ok) {
        console.log(`[${this.label}] ⛔ ${pair.baseToken.symbol} — ${gate.reason}`);
        this._markSeen(addr);
        continue;
      }

      if (this._passesFilters(pair)) {
        candidates.push(pair);
        this._markSeen(addr);
      }
    }

    // Trie par pertinence et ne garde que les meilleurs pour les débats IA
    candidates.sort((a, b) => this._relevanceScore(b) - this._relevanceScore(a));
    const toAnalyze = candidates.slice(0, MAX_CANDIDATES_PER_SCAN);

    console.log(`[${this.label}] ${candidates.length} candidat(s) GMGN — top ${toAnalyze.length} en débat IA`);

    for (const token of toAnalyze) {
      // Émet immédiatement le candidat (pour l'alerte Telegram brute)
      this.emit('candidate', token);

      // Lance l'analyse IA en arrière-plan
      this._analyzeToken(token)
        .catch((err) => console.error(`[${this.label}] Erreur analyse:`, err.message));
    }
  }

  /**
   * Analyse un candidat. La due-diligence vient entièrement de la ligne
   * trending GMGN (déjà passée aux gates durs) — aucun appel API additionnel.
   */
  async _analyzeToken(token) {
    const address = token.baseToken?.address;
    const symbol  = token.baseToken?.symbol || '???';

    // Toggle dashboard : analyses IA suspendues → aucun crédit API consommé
    if (!state.agentsEnabled) {
      console.log(`[${this.label}] ⏸️ ${symbol} non analysé — analyses IA désactivées (dashboard)`);
      return;
    }

    const g = token._gmgn || {};
    // Objets sécurité/overview dérivés des données GMGN (même forme qu'avant
    // pour l'affichage — mintAuthority non-null = danger)
    const security = {
      mintAuthority:      g.renouncedMint   ? null : 'active',
      freezeAuthority:    g.renouncedFreeze ? null : 'active',
      top10HolderPercent: (g.top10 || 0) * 100,
      creatorPercentage:  (g.devHold || 0) * 100,
    };
    const overview = { holder: g.holderCount || null };

    console.log(`[${this.label}] ✅ ${symbol} passe les gates GMGN — ${g.smartDegen ?? 0} smart money, ${g.renowned ?? 0} KOL`);

    // Enregistre le passage des filtres et vérifie si token récidiviste
    const recurringInfo = tokenHistory.recordSighting(
      token.baseToken?.symbol || '',
      token.baseToken?.name   || '',
      address,
      token._source || 'gmgn-trending'
    );
    token._recurring = recurringInfo;

    if (recurringInfo.isRecurring) {
      const dayStr = recurringInfo.daysSinceLast < 1
        ? "aujourd'hui"
        : `il y a ${recurringInfo.daysSinceLast}j`;
      const peakStr = recurringInfo.avgPeakPct != null ? ` | peak moy: +${recurringInfo.avgPeakPct}%` : '';
      console.log(`[${this.label}] 🔄 RÉCIDIVISTE $${symbol} — vu ${recurringInfo.sightings}x (${dayStr})${peakStr}`);
    }

    // Analyse IA (ARIA par défaut, Agios pour la chaîne Robinhood)
    const analyze = this._analyzer || ((...a) => personalAgent.analyzeToken(...a));
    const debate  = await analyze(token, security, null, overview, null);
    if (debate) this.emit('debate', debate);
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[${this.label}] Démarré — source GMGN | filtres: liq>${FILTERS.minLiquidityUsd}$, vol>${FILTERS.minVolumeUsd}$, mcap>${FILTERS.minMarketCapUsd}$, âge min ${FILTERS.minAgeHours}h`);
    this.scan();
    this._interval = setInterval(() => this.scan(), SCAN_INTERVAL_MS);
  }

  stop() {
    if (!this.isRunning) return;
    clearInterval(this._interval);
    this.isRunning = false;
    console.log(`[${this.label}] Arrêté.`);
  }

  getStats() {
    // Nettoie les entrées expirées avant de compter
    const now = Date.now();
    for (const [addr, expiry] of this.seenAddresses) {
      if (now >= expiry) this.seenAddresses.delete(addr);
    }
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
