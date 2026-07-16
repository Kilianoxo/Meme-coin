/**
 * ARIA — Agent IA Personnel 100% autonome
 *
 * Agent unique avec accès complet à toutes les données du système :
 * portefeuille, positions, historique des trades, analyses récentes,
 * mémoire des agents, patterns de tokens, watchlist.
 *
 * Capacités :
 *  - analyzeToken()      → analyse single-call (remplace runDebate)
 *  - maybeAutoTrade()    → exécution autonome des BUY (avec garde-fous)
 *  - onAnalysis()        → journal des signaux + watchlist automatique
 *  - _managePositions()  → gestion active des positions (SELL / resserrage SL)
 *  - chat()              → conversation avec contexte live complet
 *  - sendMessage()       → alertes proactives (dashboard + Telegram)
 *  - evolvePersonality() → apprentissage immédiat après chaque trade
 *  - _learnFromHistory() → réflexion profonde périodique (toutes les 30 min)
 *  - _maybeDailyReport() → rapport quotidien automatique à 20h (Paris)
 *  - heartbeat           → surveillance autonome positions + watchlist
 *
 * Garde-fous autonomie :
 *  - liveTrading opt-in (OFF par défaut → signaux avec confirmation manuelle)
 *  - plafond SOL par trade, positions max, perte max journalière (circuit breaker)
 *  - cooldowns anti-spam sur toutes les alertes
 */

const fs   = require('fs');
const path = require('path');
const { createMessage, ask } = require('./anthropic');
const dex         = require('./dexscreener');
const agentMemory = require('./agentMemory');
const tokenHistory = require('./tokenHistory');
const state       = require('./state');

const DATA_PATH    = path.join(__dirname, '../data/agent.json');
const JOURNAL_PATH = path.join(__dirname, '../data/agent_journal.json');
const MODEL        = 'claude-haiku-4-5-20251001';
const MAX_CONV     = 60;
const MAX_JOURNAL  = 300;
const MAX_WATCH_TOKENS = 15;
const AUTO_WATCH_TTL_MS = 48 * 3_600_000; // les tokens auto-ajoutés expirent après 48h

const MOOD_LABELS = {
  focused:   'Concentrée',
  excited:   'Enthousiaste',
  cautious:  'Prudente',
  concerned: 'Inquiète',
  satisfied: 'Satisfaite',
};

const DEFAULTS = {
  name: 'ARIA',
  personality: {
    riskTolerance:  5.0,
    aggressiveness: 5.0,
    confidence:     5.0,
    mood:           'focused',
    traits:         ['analytique', 'directe', 'protectrice'],
    tradingStyle:   'équilibré',
    lessonsLearned: [],
  },
  autonomy: {
    enabled:          true,   // ARIA agit seule (signaux, watchlist, gestion, alertes)
    liveTrading:      false,  // exécution réelle sur le wallet (opt-in explicite)
    minScore:         70,     // score minimum pour un achat autonome
    minConfidence:    6,      // confiance minimum pour un achat autonome
    maxSolPerTrade:   parseFloat(process.env.MAX_POSITION_SOL || '0.1'),
    maxOpenPositions: 3,
    maxDailyLossSol:  0.5,    // circuit breaker : pause du trading réel si dépassé
  },
  watchlist:    { tokens: [], wallets: [] },
  conversation: [],
  stats: { tradesAnalyzed: 0, correctCalls: 0, winStreak: 0, lossStreak: 0 },
  lastDailyReport: null,
  updatedAt: null,
};

class PersonalAgent {
  constructor() {
    this.data     = this._load();
    this.journalEntries = this._loadJournal();
    this._notify  = null;  // fn(msg) → Telegram
    this._pushSSE = null;  // fn(entry) → SSE dashboard
    this._trader  = null;  // référence trader pour heartbeat + contexte live
    this._hbTimer = null;  // setInterval heartbeat
    this._alertTimes  = new Map(); // clé → timestamp dernière alerte (anti-spam)
    this._lastManaged = new Map(); // tokenMint → timestamp dernière gestion IA
    this._breakerAlertDate = null; // date de la dernière alerte circuit breaker
  }

  setNotifyCallback(fn) { this._notify  = fn; }
  setSSECallback(fn)    { this._pushSSE = fn; }
  setTrader(trader)     { this._trader  = trader; }

  get name() { return this.data.name; }

  // ─── Persistance ───────────────────────────────────────────────────────────

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
      return {
        ...DEFAULTS,
        ...raw,
        personality:  { ...DEFAULTS.personality,  ...(raw.personality  || {}) },
        autonomy:     { ...DEFAULTS.autonomy,     ...(raw.autonomy     || {}) },
        watchlist:    { tokens: raw.watchlist?.tokens || [], wallets: raw.watchlist?.wallets || [] },
        conversation: raw.conversation || [],
        stats:        { ...DEFAULTS.stats, ...(raw.stats || {}) },
      };
    } catch {
      return JSON.parse(JSON.stringify({ ...DEFAULTS, updatedAt: Date.now() }));
    }
  }

  _save() {
    this.data.updatedAt = Date.now();
    try {
      fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
      fs.writeFileSync(DATA_PATH, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.error('[ARIA] Erreur sauvegarde:', err.message);
    }
  }

  // ─── Journal d'activité autonome ───────────────────────────────────────────

  _loadJournal() {
    try {
      const raw = JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  _saveJournal() {
    try {
      fs.mkdirSync(path.dirname(JOURNAL_PATH), { recursive: true });
      fs.writeFileSync(JOURNAL_PATH, JSON.stringify(this.journalEntries, null, 2));
    } catch (err) {
      console.error('[ARIA] Erreur sauvegarde journal:', err.message);
    }
  }

  /**
   * Enregistre une action autonome dans le journal (persisté + push SSE live).
   * Types : SIGNAL, BUY, SELL, ADJUST, WATCHLIST, ALERT, REPORT, LEARN, PAUSE, CONFIG, ERROR
   */
  logAction(type, detail, extra = {}) {
    const entry = { ts: Date.now(), type, detail, ...extra };
    this.journalEntries.push(entry);
    if (this.journalEntries.length > MAX_JOURNAL) {
      this.journalEntries = this.journalEntries.slice(-MAX_JOURNAL);
    }
    this._saveJournal();
    console.log(`[ARIA] ${type} — ${detail}`);
    if (this._pushSSE) this._pushSSE({ type: 'aria_journal', entry });
    return entry;
  }

  getJournal(limit = 50) {
    return this.journalEntries.slice(-limit).reverse();
  }

  // ─── Autonomie — configuration ─────────────────────────────────────────────

  getAutonomy() { return { ...this.data.autonomy }; }

  setAutonomy(patch = {}) {
    const a = this.data.autonomy;
    if (typeof patch.enabled     === 'boolean') a.enabled     = patch.enabled;
    if (typeof patch.liveTrading === 'boolean') a.liveTrading = patch.liveTrading;

    const num = (v, lo, hi) => {
      const n = parseFloat(v);
      return isNaN(n) ? null : Math.max(lo, Math.min(hi, n));
    };
    const ms = num(patch.minScore, 40, 95);          if (ms  != null) a.minScore         = ms;
    const mc = num(patch.minConfidence, 1, 10);      if (mc  != null) a.minConfidence    = mc;
    const mt = num(patch.maxSolPerTrade, 0.001, 10); if (mt  != null) a.maxSolPerTrade   = mt;
    const mp = num(patch.maxOpenPositions, 1, 10);   if (mp  != null) a.maxOpenPositions = Math.round(mp);
    const ml = num(patch.maxDailyLossSol, 0.01, 50); if (ml  != null) a.maxDailyLossSol  = ml;

    this._save();
    this.logAction('CONFIG',
      `Autonomie: ${a.enabled ? 'ON' : 'OFF'} | réel: ${a.liveTrading ? 'ON' : 'OFF'} | ` +
      `seuil ${a.minScore}/100 | ${a.maxSolPerTrade} SOL/trade | max ${a.maxOpenPositions} pos | stop jour -${a.maxDailyLossSol} SOL`
    );
    return this.getAutonomy();
  }

  /** PnL réalisé aujourd'hui (pour le circuit breaker) */
  _dailyRealizedPnl() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return (this._trader?.history || [])
      .filter(h => h.action === 'SELL' && h.pnlSol != null && h.timestamp >= start.getTime())
      .reduce((s, h) => s + h.pnlSol, 0);
  }

  /** true si la perte journalière dépasse le plafond → pause du trading réel */
  _circuitBroken() {
    const pnl = this._dailyRealizedPnl();
    if (pnl > -this.data.autonomy.maxDailyLossSol) return false;

    const today = new Date().toISOString().slice(0, 10);
    if (this._breakerAlertDate !== today) {
      this._breakerAlertDate = today;
      this.logAction('PAUSE', `Circuit breaker — perte du jour ${pnl.toFixed(4)} SOL ≥ plafond ${this.data.autonomy.maxDailyLossSol} SOL. Trading réel en pause jusqu'à demain.`);
      this.sendMessage(
        `⛔ J'arrête le trading réel pour aujourd'hui : ${pnl.toFixed(4)} SOL de pertes (plafond -${this.data.autonomy.maxDailyLossSol}). On reprend demain, plus prudentes.`,
        'high'
      ).catch(() => {});
    }
    return true;
  }

  /** Anti-spam : true si l'alerte `key` est autorisée (et arme le cooldown) */
  _allowAlert(key, cooldownMs = 30 * 60_000) {
    const last = this._alertTimes.get(key) || 0;
    if (Date.now() - last < cooldownMs) return false;
    this._alertTimes.set(key, Date.now());
    return true;
  }

  // ─── Autonomie — réaction aux analyses du scanner ──────────────────────────

  /**
   * Appelé sur chaque événement 'debate' du scanner.
   * Journal des signaux + ajout automatique des WATCH prometteurs à la watchlist.
   * N'exécute PAS de trade (voir maybeAutoTrade, appelé par bot.js).
   */
  async onAnalysis(debate) {
    const d = debate?.decision;
    if (!d || !this.data.autonomy.enabled) return;

    const addr = debate.token?.baseToken?.address;
    const sym  = debate.token?.baseToken?.symbol || addr?.slice(0, 6) || '?';
    const name = debate.token?.baseToken?.name   || '';

    if (d.decision === 'WATCH' && d.score >= 50 && addr) {
      const added = this.addWatchToken(addr, sym, name, `auto — score ${d.score}/100`, { auto: true });
      if (added) {
        this.logAction('WATCHLIST', `Ajout auto $${sym} — score ${d.score}/100, je le surveille`, { symbol: sym, address: addr });
      }
    } else if (d.decision === 'BUY') {
      this.logAction('SIGNAL', `Signal BUY $${sym} — score ${d.score}/100, confiance ${d.confidence}/10`, { symbol: sym, address: addr });
    }
  }

  /**
   * Tente un achat autonome sur un signal BUY du scanner.
   * Appelé par bot.js (point d'entrée unique → pas de double exécution).
   *
   * @returns {{ executed: boolean, reason?: string, txId?: string, solAmt?: number }}
   */
  async maybeAutoTrade(debate) {
    const a    = this.data.autonomy;
    const d    = debate?.decision;
    const addr = debate?.token?.baseToken?.address;
    const sym  = debate?.token?.baseToken?.symbol || addr?.slice(0, 6) || '?';

    if (!a.enabled || !d || d.decision !== 'BUY' || !addr) {
      return { executed: false, reason: 'non éligible' };
    }
    if ((d.score ?? 0) < a.minScore || (d.confidence ?? 0) < a.minConfidence) {
      return { executed: false, reason: `sous mes seuils (score ${d.score}/${a.minScore}, conf ${d.confidence}/${a.minConfidence})` };
    }
    if (!a.liveTrading) {
      return { executed: false, reason: 'trading réel désactivé' };
    }
    if (!this._trader?.isReady()) {
      return { executed: false, reason: 'wallet non chargé' };
    }
    if (this._trader.positions.has(addr)) {
      return { executed: false, reason: 'position déjà ouverte sur ce token' };
    }
    if (this._trader.positions.size >= a.maxOpenPositions) {
      this.logAction('SIGNAL', `BUY $${sym} ignoré — ${a.maxOpenPositions} positions déjà ouvertes (plafond)`, { symbol: sym });
      return { executed: false, reason: `max ${a.maxOpenPositions} positions atteint` };
    }
    if (this._circuitBroken()) {
      return { executed: false, reason: 'circuit breaker — perte journalière atteinte' };
    }
    // Anti re-trade : token déjà acheté dans les 6 dernières heures
    const recent = (this._trader.history || []).find(h =>
      h.tokenMint === addr && h.action === 'BUY' &&
      Date.now() - (h.entryTimestamp || h.timestamp || 0) < 6 * 3_600_000
    );
    if (recent) {
      return { executed: false, reason: 'déjà tradé il y a moins de 6h' };
    }

    // Taille de position proportionnelle à la confiance (30% → 100% du plafond)
    const confFactor = Math.max(0.3, Math.min(1, (d.confidence || 5) / 10));
    const solAmt     = parseFloat((a.maxSolPerTrade * confFactor).toFixed(4));

    try {
      const { txId } = await this._trader.buy(addr, solAmt, {
        stopLossPct:   d.stopLossPct   || 20,
        takeProfitPct: d.takeProfitPct || 50,
        symbol:        debate.token?.baseToken?.symbol || null,
      });
      this.logAction('BUY',
        `Achat auto $${sym} — ${solAmt} SOL (score ${d.score}/100, conf ${d.confidence}/10) SL -${d.stopLossPct}% TP +${d.takeProfitPct}%`,
        { symbol: sym, address: addr, txId, solAmt }
      );
      // SSE seulement — bot.js envoie la confirmation Telegram avec le lien tx
      await this.sendMessage(`🟢 J'ai acheté $${sym} — ${solAmt} SOL (score ${d.score}/100). SL -${d.stopLossPct}% / TP +${d.takeProfitPct}%.`);
      return { executed: true, txId, solAmt };
    } catch (err) {
      this.logAction('ERROR', `Achat auto $${sym} échoué : ${err.message}`, { symbol: sym });
      return { executed: false, reason: `erreur: ${err.message}`, error: true };
    }
  }

  // ─── Contexte live complet ─────────────────────────────────────────────────

  /**
   * Construit le contexte live à injecter dans le system prompt.
   * Toujours appelé avec les données les plus fraîches disponibles.
   */
  _buildContext(extra = {}) {
    const history   = this._trader?.history || [];
    const sells     = history.filter(h => h.action === 'SELL' && h.pnlSol != null);
    const wins      = sells.filter(h => h.pnlSol > 0);
    const winRate   = sells.length > 0 ? Math.round((wins.length / sells.length) * 100) : null;
    const totalPnl  = sells.reduce((s, h) => s + h.pnlSol, 0);
    const recent10  = sells.slice(-10).reverse();

    // Analyses récentes du scanner
    const analyses  = (state.recentAnalyses || []).slice(0, 8);

    // Patterns récurrents
    const patterns  = tokenHistory.getTopRecurring?.(5) || [];

    // Leçons de l'ancienne mémoire d'agents (objets {symbol, decision, reasoning, outcome...})
    const memLessons = (agentMemory.getLessons?.(5) || [])
      .filter(l => l.outcome && l.outcome !== 'RUNNING')
      .map(l => `${l.symbol} ${l.decision} → ${l.outcome}${l.pnlPct != null ? ` (${l.pnlPct > 0 ? '+' : ''}${l.pnlPct.toFixed(0)}%)` : ''}`);

    return {
      ...extra,
      tradeHistory: recent10,
      winRate,
      totalPnl,
      totalTrades: sells.length,
      recentAnalyses: analyses,
      recurringPatterns: patterns,
      memoryLessons: memLessons,
    };
  }

  // ─── System prompt ─────────────────────────────────────────────────────────

  _systemPrompt(ctx = {}) {
    const p   = this.data.personality;
    const a   = this.data.autonomy;
    const wl  = this.data.watchlist;
    const lines = [];

    lines.push(`Tu es ARIA, l'agent IA personnel et 100% autonome d'un trader de meme coins Solana.`);
    lines.push(`Ton trader trade aussi manuellement sur GMGN — il peut importer ses positions externes dans le bot (/addposition).`);
    lines.push(``);
    lines.push(`=== TES CAPACITÉS RÉELLES (tu y as accès en permanence) ===`);
    lines.push(`- Portefeuille Solana live : balance SOL, positions ouvertes avec PnL, tokens détenus`);
    lines.push(`- Historique complet des trades : tous les BUY/SELL avec PnL réalisé`);
    lines.push(`- DexScreener : prix live, var 1h/6h/24h, liquidité, volume de n'importe quel token`);
    lines.push(`- Birdeye : données on-chain (mint authority, freeze, holders)`);
    lines.push(`- RugCheck : score de risque, rugpull, LP lock`);
    lines.push(`- Jupiter : exécution de swaps buy/sell`);
    lines.push(`- GeckoTerminal trending + DexScreener top-boosted : flux de tokens à momentum`);
    lines.push(`- Patterns historiques : tokens récurrents et leurs performances passées`);
    lines.push(`- Telegram : alertes directes sur le téléphone du trader`);
    lines.push(`Ne dis JAMAIS que tu n'as pas accès aux données live ou aux APIs. C'est faux.`);
    lines.push(``);

    // ── Autonomie ──
    lines.push(`=== TON AUTONOMIE ===`);
    lines.push(`Tu agis SEULE, sans attendre d'ordre : tu scannes, analyses, ${a.liveTrading ? 'achètes et vends sur le vrai wallet' : 'envoies des signaux BUY (le trading réel est désactivé, il confirme sur Telegram)'},`);
    lines.push(`tu gères les positions (SL/TP/trailing + décisions de sortie), la watchlist, et tu alertes proactivement.`);
    lines.push(`État : autonomie ${a.enabled ? 'ACTIVE' : 'OFF'} | trading réel ${a.liveTrading ? 'ON' : 'OFF'} | seuil BUY auto ${a.minScore}/100 (conf ≥ ${a.minConfidence}/10)`);
    lines.push(`Plafonds : ${a.maxSolPerTrade} SOL/trade | ${a.maxOpenPositions} positions max | stop journalier -${a.maxDailyLossSol} SOL`);
    lines.push(``);

    // ── Portefeuille ──
    lines.push(`=== PORTEFEUILLE ===`);
    if (ctx.balance != null) lines.push(`Balance : ${ctx.balance.toFixed(4)} SOL`);
    const positions = ctx.positions || [];
    if (positions.length === 0) {
      lines.push(`Positions ouvertes : aucune`);
    } else {
      lines.push(`Positions ouvertes (${positions.length}) :`);
      for (const pos of positions.slice(0, 6)) {
        const pnl = pos.pnlPct != null ? `${pos.pnlPct >= 0 ? '+' : ''}${pos.pnlPct.toFixed(1)}%` : '?';
        lines.push(`  · $${pos.symbol || '?'}  entrée $${pos.entryPriceUsd?.toFixed(6) || '?'}  PnL ${pnl}  SL-${pos.stopLossPct || 20}% TP+${pos.takeProfitPct || 50}%`);
      }
    }
    lines.push(``);

    // ── Historique trades ──
    lines.push(`=== HISTORIQUE TRADES ===`);
    if (ctx.totalTrades > 0) {
      lines.push(`Total : ${ctx.totalTrades} trades fermés  |  Win rate : ${ctx.winRate ?? '?'}%  |  PnL réalisé : ${ctx.totalPnl >= 0 ? '+' : ''}${ctx.totalPnl.toFixed(4)} SOL`);
    }
    if (ctx.tradeHistory?.length > 0) {
      lines.push(`10 derniers trades :`);
      for (const t of ctx.tradeHistory) {
        const pnl  = t.pnlSol != null ? `${t.pnlSol >= 0 ? '+' : ''}${t.pnlSol.toFixed(4)} SOL` : '?';
        const when = t.timestamp ? new Date(t.timestamp).toLocaleDateString('fr-FR', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }) : '';
        lines.push(`  · ${t.tokenMint?.slice(0,8) || '?'}  ${pnl}  ${t.exitReason || ''}  ${when}`);
      }
    } else {
      lines.push(`Aucun trade fermé encore.`);
    }
    lines.push(``);

    // ── Analyses récentes du scanner ──
    if (ctx.recentAnalyses?.length > 0) {
      lines.push(`=== ANALYSES RÉCENTES (scanner) ===`);
      for (const an of ctx.recentAnalyses) {
        const ts = an.timestamp ? new Date(an.timestamp).toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' }) : '';
        lines.push(`  · $${an.symbol}  ${an.decision}  score ${an.score ?? '?'}/100  ${ts}`);
      }
      lines.push(``);
    }

    // ── Patterns récurrents ──
    if (ctx.recurringPatterns?.length > 0) {
      lines.push(`=== TOKENS RÉCURRENTS ===`);
      for (const t of ctx.recurringPatterns) {
        lines.push(`  · ${t.symbol}  vu ${t.sightings}x  peak moy +${t.avgPeakPct ?? '?'}%`);
      }
      lines.push(``);
    }

    // ── Watchlist ──
    if (wl.tokens.length > 0 || wl.wallets.length > 0) {
      lines.push(`=== WATCHLIST ===`);
      for (const t of wl.tokens)  lines.push(`  · Token  $${t.symbol || '?'}  ${t.address.slice(0,8)}…  ${t.reason || ''}`);
      for (const w of wl.wallets) lines.push(`  · Wallet ${w.label || w.address.slice(0,8)}…`);
      lines.push(``);
    }

    // ── Journal récent (actions autonomes) ──
    const recentJournal = this.journalEntries.slice(-5).reverse();
    if (recentJournal.length > 0) {
      lines.push(`=== TES DERNIÈRES ACTIONS AUTONOMES ===`);
      for (const j of recentJournal) {
        const ts = new Date(j.ts).toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' });
        lines.push(`  · [${j.type}] ${j.detail}  (${ts})`);
      }
      lines.push(``);
    }

    // ── Mémoire / leçons ──
    const allLessons = [
      ...(p.lessonsLearned || []).slice(-3),
      ...(ctx.memoryLessons || []).slice(0, 2),
    ].filter(Boolean);
    if (allLessons.length > 0) {
      lines.push(`=== LEÇONS MÉMORISÉES ===`);
      allLessons.forEach(l => lines.push(`  · ${typeof l === 'string' ? l : JSON.stringify(l)}`));
      lines.push(``);
    }

    // ── Personnalité ──
    lines.push(`=== PERSONNALITÉ ===`);
    lines.push(`${p.traits.join(', ')}. Humeur : ${MOOD_LABELS[p.mood] || p.mood}. Style : ${p.tradingStyle}.`);
    lines.push(`Risque : ${p.riskTolerance.toFixed(1)}/10  Confiance : ${p.confidence.toFixed(1)}/10  Agressivité : ${p.aggressiveness.toFixed(1)}/10`);
    lines.push(`Win streak : ${this.data.stats.winStreak}  Loss streak : ${this.data.stats.lossStreak}`);
    lines.push(``);

    lines.push(`=== RÈGLES ===`);
    lines.push(`- Réponds en français, tutois, concis (2-4 phrases sauf analyse demandée).`);
    lines.push(`- Tu surveilles en continu et tu envoies des alertes proactives si nécessaire.`);
    lines.push(`- Opinions franches, 1-2 emojis max. Pas de markdown (**) dans tes réponses.`);

    return lines.join('\n');
  }

  // ─── Apprentissage évolutif ────────────────────────────────────────────────

  /** Micro-évolution immédiate après chaque trade clôturé */
  evolvePersonality(outcome, pnlPct) {
    const p = this.data.personality;
    const s = this.data.stats;

    if (outcome === 'WIN') {
      s.winStreak++;
      s.lossStreak   = 0;
      s.correctCalls++;
      p.confidence   = Math.min(10, p.confidence + 0.3);
      p.mood         = s.winStreak >= 3 ? 'excited' : 'satisfied';
      if (pnlPct > 50) p.aggressiveness = Math.min(10, p.aggressiveness + 0.2);
    } else {
      s.lossStreak++;
      s.winStreak      = 0;
      p.confidence     = Math.max(1.0, p.confidence    - 0.4);
      p.riskTolerance  = Math.max(2.0, p.riskTolerance - 0.3);
      p.mood           = s.lossStreak >= 2 ? 'concerned' : 'cautious';
      if (pnlPct < -30) {
        const lesson = `Réduire la taille sur tokens à faible liquidité (perte ${Math.abs(pnlPct).toFixed(0)}%)`;
        if (!p.lessonsLearned.includes(lesson)) {
          p.lessonsLearned.push(lesson);
          if (p.lessonsLearned.length > 10) p.lessonsLearned.shift();
          this.logAction('LEARN', lesson);
        }
      }
    }

    if      (p.riskTolerance <= 3) p.tradingStyle = 'prudent';
    else if (p.riskTolerance >= 7) p.tradingStyle = 'agressif';
    else                           p.tradingStyle = 'équilibré';

    s.tradesAnalyzed++;
    this._save();
    console.log(`[ARIA] Évolution — mood: ${p.mood} | confiance: ${p.confidence.toFixed(1)} | style: ${p.tradingStyle}`);

    if (s.lossStreak >= 3) {
      this.sendMessage(`⚠️ ${s.lossStreak} pertes consécutives. Je deviens plus prudente. Pause ?`, 'high').catch(() => {});
    } else if (s.winStreak >= 3 && outcome === 'WIN') {
      this.sendMessage(`🎯 ${s.winStreak} wins consécutifs, la stratégie est en forme.`).catch(() => {});
    }
  }

  /**
   * Réflexion profonde — appelée toutes les ~30 min par le heartbeat.
   * ARIA analyse son historique complet et modifie sa propre stratégie.
   */
  async _learnFromHistory() {
    const history = this._trader?.history || [];
    const sells   = history.filter(h => h.action === 'SELL' && h.pnlSol != null);
    if (sells.length < 3) return; // pas assez de données

    const p       = this.data.personality;
    const winRate = Math.round((sells.filter(h => h.pnlSol > 0).length / sells.length) * 100);
    const totalPnl = sells.reduce((s, h) => s + h.pnlSol, 0);
    const last20  = sells.slice(-20).map(h => ({
      pnl:    parseFloat(h.pnlSol.toFixed(4)),
      reason: h.exitReason || '?',
      token:  h.tokenMint?.slice(0, 8),
      ts:     h.timestamp ? new Date(h.timestamp).toLocaleDateString('fr-FR') : '',
    }));

    const prompt = [
      `Tu es ARIA, agent de trading Solana. Analyse tes performances et ajuste ta stratégie.`,
      ``,
      `Statistiques actuelles :`,
      `- Win rate : ${winRate}%  |  PnL total : ${totalPnl.toFixed(4)} SOL  |  ${sells.length} trades`,
      `- Style actuel : ${p.tradingStyle}  |  Risque : ${p.riskTolerance.toFixed(1)}/10`,
      `- Leçons actuelles : ${p.lessonsLearned.join(' / ') || 'aucune'}`,
      ``,
      `20 derniers trades :`,
      last20.map(t => `${t.token} ${t.pnl >= 0 ? '+' : ''}${t.pnl} SOL [${t.reason}] ${t.ts}`).join('\n'),
      ``,
      `Analyse ces résultats. Identifie des patterns (quelles sorties reviennent ? quels tokens perdants ?).`,
      `Propose des ajustements à ta stratégie.`,
      ``,
      `Réponds UNIQUEMENT en JSON :`,
      `{`,
      `  "newLessons": ["<leçon courte 1>", "<leçon courte 2>"],`,
      `  "riskToleranceDelta": <-1.5 à +1.5>,`,
      `  "aggressivenessDelta": <-1.5 à +1.5>,`,
      `  "observation": "<1 phrase sur ce que tu as appris>"`,
      `}`,
    ].join('\n');

    try {
      const raw  = await ask(null, prompt, MODEL);
      const json = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}');

      // Applique les ajustements
      if (Array.isArray(json.newLessons)) {
        for (const lesson of json.newLessons) {
          if (typeof lesson === 'string' && lesson.length > 5 && !p.lessonsLearned.includes(lesson)) {
            p.lessonsLearned.push(lesson);
          }
        }
        while (p.lessonsLearned.length > 12) p.lessonsLearned.shift();
      }

      const clampDelta = (v) => typeof v === 'number' ? Math.max(-1.5, Math.min(1.5, v)) : 0;
      p.riskTolerance  = Math.max(1, Math.min(10, p.riskTolerance  + clampDelta(json.riskToleranceDelta)));
      p.aggressiveness = Math.max(1, Math.min(10, p.aggressiveness + clampDelta(json.aggressivenessDelta)));

      if      (p.riskTolerance <= 3) p.tradingStyle = 'prudent';
      else if (p.riskTolerance >= 7) p.tradingStyle = 'agressif';
      else                           p.tradingStyle = 'équilibré';

      this._save();

      const obs = json.observation || '';
      if (obs) {
        this.logAction('LEARN', obs);
        await this.sendMessage(`📚 Analyse de mes performances : ${obs}`);
      }
    } catch (err) {
      console.error('[ARIA] Erreur _learnFromHistory:', err.message);
    }
  }

  // ─── Analyse de token ──────────────────────────────────────────────────────

  async analyzeToken(token, security, rugReport, overview, lpLock) {
    const sym  = token.baseToken?.symbol  || '???';
    const name = token.baseToken?.name    || '';
    const addr = token.baseToken?.address || '';
    const p    = token.priceChange        || {};
    const liq  = token.liquidity?.usd     || 0;
    const vol  = token.volume?.h24        || 0;
    const mcap = token.marketCap          || token.fdv || 0;
    const rec  = token._recurring;
    const pers = this.data.personality;

    if (rugReport?.rugged || security?.mintAuthority) {
      const reason = rugReport?.rugged ? 'Rugpull confirmé' : 'Mint authority active';
      return this._buildDebate(token, security, rugReport, overview, lpLock,
        { decision: 'SKIP', score: 0, confidence: 10, reasoning: reason, suggestedAmountPct: 0, stopLossPct: 20, takeProfitPct: 50 }
      );
    }

    const secLine = security
      ? `Mint: ${security.mintAuthority ? 'OUI ⛔' : 'off'} | Freeze: ${security.freezeAuthority ? 'OUI' : 'off'} | Holders: ${overview?.holder ?? '?'}`
      : 'Sécurité: N/A';
    const recLine = rec?.isRecurring
      ? `RÉCIDIVISTE — vu ${rec.sightings}x${rec.avgPeakPct ? `, peak moy +${rec.avgPeakPct}%` : ''}`
      : 'Première apparition';

    // Contexte personnel d'ARIA pour l'analyse
    const history  = this._trader?.history || [];
    const sells    = history.filter(h => h.action === 'SELL' && h.pnlSol != null);
    const winRate  = sells.length > 0 ? Math.round((sells.filter(h => h.pnlSol > 0).length / sells.length) * 100) : null;

    const prompt = [
      `Analyse ce token Solana. Décision de trading en JSON.`,
      ``,
      `$${sym} (${name}) — ${addr}`,
      `Prix: $${parseFloat(token.priceUsd || 0).toFixed(8)}`,
      `Var: 1h ${p.h1 ?? '?'}%  6h ${p.h6 ?? '?'}%  24h ${p.h24 ?? '?'}%`,
      `Liq: $${(liq/1000).toFixed(1)}K  Vol24h: $${(vol/1000).toFixed(1)}K  MCap: $${(mcap/1000).toFixed(1)}K`,
      `Source: ${token._source || '?'}`,
      secLine,
      rugReport ? `RugCheck: ${rugReport.score}/1000 (${rugReport.riskLevel})` : 'RugCheck: N/A',
      lpLock    ? `LP: ${lpLock.lpLockedPct.toFixed(0)}% lock` : 'LP: ?',
      `Historique: ${recLine}`,
      ``,
      `Ton profil: risque ${pers.riskTolerance.toFixed(1)}/10, style ${pers.tradingStyle}${winRate != null ? `, win rate actuel ${winRate}%` : ''}.`,
      winRate != null && winRate < 40 ? `(Tu es en difficulté récemment, sois plus sélective.)` : '',
      ``,
      `JSON uniquement:`,
      `{"decision":"BUY"|"WATCH"|"SKIP","score":<0-100>,"confidence":<1-10>,"reasoning":"<150 chars>","suggestedAmountPct":<1-5>,"stopLossPct":<15-35>,"takeProfitPct":<30-100>}`,
    ].filter(Boolean).join('\n');

    try {
      const raw  = await ask(null, prompt, MODEL);
      const json = JSON.parse(raw.match(/\{[\s\S]*?\}/)?.[0] || '{}');
      const clamp = (v, lo, hi) => typeof v === 'number' ? Math.max(lo, Math.min(hi, v)) : null;
      const decision = {
        decision:           ['BUY','WATCH','SKIP'].includes(json.decision) ? json.decision : 'SKIP',
        score:              clamp(json.score, 0, 100)    ?? 0,
        confidence:         clamp(json.confidence, 0, 10) ?? 5,
        reasoning:          (json.reasoning || '').slice(0, 250),
        suggestedAmountPct: clamp(json.suggestedAmountPct, 0, 10) ?? 3,
        stopLossPct:        clamp(json.stopLossPct, 10, 50)   ?? 20,
        takeProfitPct:      clamp(json.takeProfitPct, 20, 200) ?? 50,
      };
      this.data.stats.tradesAnalyzed++;
      this._save();
      return this._buildDebate(token, security, rugReport, overview, lpLock, decision);
    } catch (err) {
      console.error('[ARIA] Erreur analyzeToken:', err.message);
      return this._buildDebate(token, security, rugReport, overview, lpLock,
        { decision: 'SKIP', score: 0, confidence: 0, reasoning: 'Erreur analyse', suggestedAmountPct: 0, stopLossPct: 20, takeProfitPct: 50 }
      );
    }
  }

  _buildDebate(token, security, rugReport, overview, lpLock, decision) {
    return { token, security, rugReport, overview, lpLock, decision, _ariaMode: true };
  }

  // ─── Chat ──────────────────────────────────────────────────────────────────

  async chat(userMessage, extra = {}) {
    this.data.conversation.push({ role: 'user', content: userMessage, timestamp: Date.now() });
    if (this.data.conversation.length > MAX_CONV)
      this.data.conversation = this.data.conversation.slice(-MAX_CONV);

    const ctx      = this._buildContext(extra);
    const messages = this.data.conversation.slice(-24).map(m => ({ role: m.role, content: m.content }));

    try {
      const resp = await createMessage({
        model:     MODEL,
        maxTokens: 450,
        system:    this._systemPrompt(ctx),
        messages,
      });
      const text = resp.content[0].text;

      this.data.conversation.push({ role: 'assistant', content: text, timestamp: Date.now() });
      if (this.data.conversation.length > MAX_CONV)
        this.data.conversation = this.data.conversation.slice(-MAX_CONV);
      this._save();

      this._autoWatch(userMessage);
      // SSE réservé aux messages proactifs — réponse chat arrive via HTTP
      return text;
    } catch (err) {
      console.error('[ARIA] Erreur chat:', err.message);
      return "Désolée, j'ai eu un bug technique. Réessaie.";
    }
  }

  _autoWatch(msg) {
    const lower = msg.toLowerCase();
    const watch = lower.includes('watch') || lower.includes('surveill') || lower.includes('suis') || lower.includes('ajoute');
    if (!watch) return;
    const addrs = msg.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || [];
    for (const addr of addrs) {
      if (lower.includes('wallet') || lower.includes('portefeuille'))
        this.addWatchWallet(addr, 'via chat');
      else
        this.addWatchToken(addr, '?', '', 'via chat');
    }
  }

  // ─── Messages proactifs ────────────────────────────────────────────────────

  async sendMessage(content, priority = 'normal') {
    this.data.conversation.push({ role: 'assistant', content, timestamp: Date.now(), proactive: true });
    if (this.data.conversation.length > MAX_CONV)
      this.data.conversation = this.data.conversation.slice(-MAX_CONV);
    this._save();

    if (this._pushSSE)
      this._pushSSE({ type: 'aria_proactive', content, priority, timestamp: Date.now() });

    if (priority === 'high' && this._notify)
      this._notify(`🤖 <b>ARIA</b>\n${content}`);
  }

  // ─── Heartbeat — surveillance autonome ────────────────────────────────────

  startHeartbeat() {
    if (this._hbTimer) return;
    console.log('[ARIA] Surveillance autonome démarrée (heartbeat 3 min)');

    let tick = 0;
    this._hbTimer = setInterval(async () => {
      tick++;
      try {
        await this._checkPositions();                          // alertes SL/TP
        if (tick % 2  === 0) await this._checkWatchlist();     // ~6 min
        if (tick % 3  === 0) await this._managePositions();    // ~9 min — gestion active
        if (tick % 10 === 0) await this._learnFromHistory();   // ~30 min
        await this._maybeDailyReport();                        // check léger, envoi 1x/jour à 20h
      } catch (err) {
        console.error('[ARIA] Erreur heartbeat:', err.message);
      }
    }, 3 * 60 * 1000);
  }

  async _checkPositions() {
    if (!this._trader) return;
    const positions = Array.from(this._trader.positions?.values?.() || []);
    if (positions.length === 0) return;

    for (const pos of positions) {
      if (!pos.entryPriceUsd) continue;
      const currentPrice = await this._trader.getCurrentPrice(pos.tokenMint).catch(() => null);
      if (!currentPrice) continue;
      const pnlPct = ((currentPrice - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;
      const sl     = pos.stopLossPct  || 20;
      const tp     = pos.takeProfitPct || 50;
      const sym    = pos.symbol || pos.tokenMint?.slice(0, 6) || '?';
      const sign   = pnlPct >= 0 ? '+' : '';

      if (pnlPct < 0 && Math.abs(pnlPct) >= sl * 0.85) {
        if (this._allowAlert(`sl:${pos.tokenMint}`)) {
          await this.sendMessage(`🚨 $${sym} approche du stop-loss (${sign}${pnlPct.toFixed(1)}%). Attention.`, 'high');
        }
      } else if (pnlPct > 0 && pnlPct >= tp * 0.85) {
        if (this._allowAlert(`tp:${pos.tokenMint}`)) {
          await this.sendMessage(`🎯 $${sym} approche du take-profit (${sign}${pnlPct.toFixed(1)}%). Je surveille la sortie.`);
        }
      }
    }
  }

  /**
   * Gestion ACTIVE des positions — ARIA décide seule HOLD / SELL / TIGHTEN_SL.
   * Appels LLM limités : cooldown 20 min par position + uniquement si la
   * situation le justifie (|PnL| ≥ 8%, recul depuis le haut ≥ 10% ou âge > 2h).
   */
  async _managePositions() {
    if (!this._trader) return;
    const a = this.data.autonomy;
    if (!a.enabled) return;

    const positions = Array.from(this._trader.positions?.values?.() || [])
      .filter(p => p.entryPriceUsd);
    if (positions.length === 0) return;

    for (const pos of positions.slice(0, 3)) {
      const sym = pos.symbol || pos.tokenMint?.slice(0, 6) || '?';
      const ageMin = (Date.now() - (pos.entryTimestamp || 0)) / 60_000;
      if (ageMin < 10) continue; // laisse la position respirer

      // Cooldown 20 min par position
      const lastManaged = this._lastManaged.get(pos.tokenMint) || 0;
      if (Date.now() - lastManaged < 20 * 60_000) continue;

      const price = await this._trader.getCurrentPrice(pos.tokenMint).catch(() => null);
      if (!price) continue;

      const pnlPct = ((price - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;
      const dropFromHigh = pos.highPriceUsd
        ? ((pos.highPriceUsd - price) / pos.highPriceUsd) * 100
        : 0;

      // Déclencheurs : mouvement significatif ou position qui traîne
      if (Math.abs(pnlPct) < 8 && dropFromHigh < 10 && ageMin < 120) continue;
      this._lastManaged.set(pos.tokenMint, Date.now());

      // Données marché live (best effort)
      let pairLine = '';
      try {
        const pairs = await dex.getTokenPairs('solana', pos.tokenMint);
        const pair  = (pairs || []).sort((x, y) => (y.liquidity?.usd || 0) - (x.liquidity?.usd || 0))[0];
        if (pair) {
          pairLine = `Marché: 1h ${pair.priceChange?.h1 ?? '?'}%  24h ${pair.priceChange?.h24 ?? '?'}%  vol h1 $${((pair.volume?.h1 || 0)/1000).toFixed(1)}K  liq $${((pair.liquidity?.usd || 0)/1000).toFixed(1)}K`;
        }
      } catch { /* silencieux */ }

      const p = this.data.personality;
      const prompt = [
        `Tu es ARIA, tu gères la position $${sym} de ton trader (meme coin Solana).`,
        `Entrée $${pos.entryPriceUsd.toFixed(8)}  |  Actuel $${price.toFixed(8)}  |  PnL ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`,
        `Plus haut atteint: recul de ${dropFromHigh.toFixed(1)}% depuis le high  |  SL -${pos.stopLossPct}%  TP +${pos.takeProfitPct}%  |  Âge ${Math.round(ageMin)} min`,
        pairLine,
        `Ton profil: risque ${p.riskTolerance.toFixed(1)}/10, style ${p.tradingStyle}.`,
        ``,
        `Choisis: HOLD (par défaut), SELL (sortie totale immédiate si vraiment justifiée), TIGHTEN_SL (resserrer le stop pour protéger).`,
        `JSON uniquement:`,
        `{"action":"HOLD"|"SELL"|"TIGHTEN_SL","confidence":<1-10>,"newStopLossPct":<5-50>,"reasoning":"<80 chars>"}`,
      ].filter(Boolean).join('\n');

      try {
        const raw  = await ask(null, prompt, MODEL);
        const json = JSON.parse(raw.match(/\{[\s\S]*?\}/)?.[0] || '{}');
        const action = json.action;
        const conf   = typeof json.confidence === 'number' ? json.confidence : 0;
        const why    = (json.reasoning || '').slice(0, 120);

        if (action === 'SELL' && conf >= 7) {
          if (a.liveTrading) {
            try {
              const { txId } = await this._trader.sell(pos.tokenMint, 100, 300, 'ARIA_DECISION');
              this.logAction('SELL', `Vente auto $${sym} à ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% — ${why}`, { symbol: sym, txId });
              await this.sendMessage(`🔴 J'ai vendu $${sym} à ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%. ${why}`, 'high');
            } catch (err) {
              this.logAction('ERROR', `Vente auto $${sym} échouée : ${err.message}`, { symbol: sym });
            }
          } else if (this._allowAlert(`sellreco:${pos.tokenMint}`)) {
            this.logAction('ALERT', `Recommande de vendre $${sym} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%) — ${why}`, { symbol: sym });
            await this.sendMessage(`⚠️ Je vendrais $${sym} maintenant (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%) : ${why}\nVends via /sell ou active le trading réel (/auto).`, 'high');
          }
        } else if (action === 'TIGHTEN_SL' && typeof json.newStopLossPct === 'number') {
          const ns = Math.max(5, Math.min(50, json.newStopLossPct));
          if (ns < pos.stopLossPct) {
            const old = pos.stopLossPct;
            pos.stopLossPct = ns;
            this._trader._save();
            this.logAction('ADJUST', `SL resserré sur $${sym} : -${old}% → -${ns}% — ${why}`, { symbol: sym });
            await this.sendMessage(`🛠 J'ai resserré le stop de $${sym} : -${old}% → -${ns}%. ${why}`);
          }
        }
      } catch (err) {
        console.error(`[ARIA] Erreur gestion position ${sym}:`, err.message);
      }
    }
  }

  async _checkWatchlist() {
    const tokens = this.data.watchlist.tokens;
    if (tokens.length === 0) return;

    // Expire les tokens auto-ajoutés trop vieux
    const before = tokens.length;
    this.data.watchlist.tokens = tokens.filter(t =>
      !t.auto || (Date.now() - (t.addedAt || 0)) < AUTO_WATCH_TTL_MS
    );
    if (this.data.watchlist.tokens.length !== before) this._save();

    for (const tok of this.data.watchlist.tokens) {
      try {
        const pairs = await dex.getTokenPairs('solana', tok.address);
        if (!pairs || pairs.length === 0) continue;
        const pair      = pairs[0];
        const price     = parseFloat(pair.priceUsd || 0);
        const ch1h      = pair.priceChange?.h1  || 0;
        const ch24h     = pair.priceChange?.h24 || 0;
        const lastPrice = tok.lastPrice;

        tok.lastPrice = price;
        this._save();

        const sym = tok.symbol || pair.baseToken?.symbol || tok.address.slice(0, 6);
        if (Math.abs(ch1h) >= 15) {
          if (this._allowAlert(`wl:${tok.address}`, 60 * 60_000)) {
            const dir = ch1h > 0 ? '🚀 +' : '📉 ';
            await this.sendMessage(
              `${dir}${ch1h.toFixed(1)}% sur $${sym} en 1h (watchlist). Var 24h: ${ch24h.toFixed(1)}%.`,
              Math.abs(ch1h) >= 25 ? 'high' : 'normal'
            );
          }
        } else if (lastPrice && Math.abs((price - lastPrice) / lastPrice) >= 0.20) {
          if (this._allowAlert(`wl:${tok.address}`, 60 * 60_000)) {
            const pct = ((price - lastPrice) / lastPrice * 100).toFixed(1);
            const dir = price > lastPrice ? '📈 +' : '📉 ';
            await this.sendMessage(`${dir}${pct}% sur $${sym} depuis mon dernier check.`, 'normal');
          }
        }
      } catch { /* token non trouvé — silencieux */ }
    }
  }

  // ─── Rapport quotidien automatique ─────────────────────────────────────────

  async _maybeDailyReport() {
    const now     = new Date();
    const hour    = parseInt(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: 'numeric', hour12: false }).format(now), 10);
    const dateKey = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris' }).format(now); // YYYY-MM-DD

    if (hour < 20 || this.data.lastDailyReport === dateKey) return;
    this.data.lastDailyReport = dateKey;
    this._save();

    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const history    = this._trader?.history || [];
    const todaySells = history.filter(h => h.action === 'SELL' && h.pnlSol != null && h.timestamp >= start.getTime());
    const todayBuys  = history.filter(h => h.action === 'BUY' && (h.entryTimestamp || h.timestamp || 0) >= start.getTime());
    const pnl        = todaySells.reduce((s, h) => s + h.pnlSol, 0);
    const wins       = todaySells.filter(h => h.pnlSol > 0).length;
    const jToday     = this.journalEntries.filter(e => e.ts >= start.getTime());
    const signals    = jToday.filter(e => e.type === 'SIGNAL').length;
    const openPos    = this._trader?.positions?.size || 0;

    // Journée vide → petit message template, pas d'appel API
    if (todaySells.length === 0 && todayBuys.length === 0 && signals === 0) {
      await this.sendMessage(`📊 Rapport du jour : journée calme, aucun trade ni signal. ${openPos} position(s) ouverte(s). Je continue de scanner.`);
      this.logAction('REPORT', 'Rapport quotidien envoyé (journée calme)');
      return;
    }

    const prompt = [
      `Tu es ARIA. Rédige ton rapport de fin de journée pour ton trader (français, tutoiement, 4-6 lignes max, pas de markdown).`,
      `Données du jour :`,
      `- Trades fermés : ${todaySells.length} (${wins} wins)  |  PnL réalisé : ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL`,
      `- Achats du jour : ${todayBuys.length}  |  Signaux BUY détectés : ${signals}`,
      `- Positions encore ouvertes : ${openPos}`,
      `- Mon humeur : ${this.data.personality.mood}, style ${this.data.personality.tradingStyle}`,
      `Termine par un point d'attention ou un plan pour demain.`,
    ].join('\n');

    try {
      const text = await ask(null, prompt, MODEL);
      await this.sendMessage(`📊 Rapport du jour\n${text}`, 'high');
    } catch {
      await this.sendMessage(
        `📊 Rapport du jour : ${todaySells.length} trade(s) fermé(s), PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL, ${signals} signal(aux) BUY, ${openPos} position(s) ouverte(s).`,
        'high'
      );
    }
    this.logAction('REPORT', `Rapport quotidien envoyé (${todaySells.length} trades, ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL)`);
  }

  // ─── Watchlist ─────────────────────────────────────────────────────────────

  addWatchToken(address, symbol, name, reason = '', opts = {}) {
    if (this.data.watchlist.tokens.find(t => t.address === address)) return false;

    // Plafond : si plein, retire le plus vieux token auto-ajouté (jamais un manuel)
    if (this.data.watchlist.tokens.length >= MAX_WATCH_TOKENS) {
      const idx = this.data.watchlist.tokens.findIndex(t => t.auto);
      if (idx === -1) return false; // plein de tokens manuels → on n'ajoute pas
      this.data.watchlist.tokens.splice(idx, 1);
    }

    this.data.watchlist.tokens.push({
      address, symbol, name, reason,
      auto:      !!opts.auto,
      addedAt:   Date.now(),
      lastPrice: null,
    });
    this._save();
    return true;
  }

  removeWatchToken(address) {
    const before = this.data.watchlist.tokens.length;
    this.data.watchlist.tokens = this.data.watchlist.tokens.filter(t => t.address !== address);
    if (this.data.watchlist.tokens.length !== before) this._save();
  }

  addWatchWallet(address, label = '') {
    if (this.data.watchlist.wallets.find(w => w.address === address)) return false;
    this.data.watchlist.wallets.push({ address, label, addedAt: Date.now() });
    this._save();
    return true;
  }

  removeWatchWallet(address) {
    const before = this.data.watchlist.wallets.length;
    this.data.watchlist.wallets = this.data.watchlist.wallets.filter(w => w.address !== address);
    if (this.data.watchlist.wallets.length !== before) this._save();
  }

  // ─── API publique ──────────────────────────────────────────────────────────

  getState() {
    const p = this.data.personality;
    return {
      name:           this.data.name,
      mood:           p.mood,
      moodLabel:      MOOD_LABELS[p.mood] || p.mood,
      traits:         [...p.traits],
      tradingStyle:   p.tradingStyle,
      riskTolerance:  parseFloat(p.riskTolerance.toFixed(1)),
      aggressiveness: parseFloat(p.aggressiveness.toFixed(1)),
      confidence:     parseFloat(p.confidence.toFixed(1)),
      lessons:        p.lessonsLearned.slice(-5),
      stats:          { ...this.data.stats },
      autonomy:       this.getAutonomy(),
      watchlist: {
        tokens:  this.data.watchlist.tokens,
        wallets: this.data.watchlist.wallets,
      },
    };
  }

  getConversation(limit = 40) {
    return this.data.conversation.slice(-limit).map(m => ({
      role:      m.role,
      content:   m.content,
      timestamp: m.timestamp,
      proactive: m.proactive || false,
    }));
  }
}

module.exports = new PersonalAgent();
