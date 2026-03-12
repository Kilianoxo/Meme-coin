/**
 * ARIA — Agent IA Personnel
 *
 * Agent unique avec accès complet à toutes les données du système :
 * portefeuille, positions, historique des trades, analyses récentes,
 * mémoire des agents, patterns de tokens, watchlist.
 *
 * Capacités :
 *  - analyzeToken()      → analyse single-call (remplace runDebate)
 *  - chat()              → conversation avec contexte live complet
 *  - sendMessage()       → alertes proactives (dashboard + Telegram)
 *  - evolvePersonality() → apprentissage immédiat après chaque trade
 *  - _learnFromHistory() → réflexion profonde périodique (toutes les 30 min)
 *  - heartbeat           → surveillance autonome positions + watchlist
 */

const fs   = require('fs');
const path = require('path');
const { createMessage, ask } = require('./anthropic');
const dex         = require('./dexscreener');
const agentMemory = require('./agentMemory');
const tokenHistory = require('./tokenHistory');
const state       = require('./state');

const DATA_PATH = path.join(__dirname, '../data/agent.json');
const MODEL     = 'claude-haiku-4-5-20251001';
const MAX_CONV  = 60;

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
  watchlist:    { tokens: [], wallets: [] },
  conversation: [],
  stats: { tradesAnalyzed: 0, correctCalls: 0, winStreak: 0, lossStreak: 0 },
  updatedAt: null,
};

class PersonalAgent {
  constructor() {
    this.data     = this._load();
    this._notify  = null;  // fn(msg) → Telegram
    this._pushSSE = null;  // fn(entry) → SSE dashboard
    this._trader  = null;  // référence trader pour heartbeat + contexte live
    this._hbTimer = null;  // setInterval heartbeat
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
        watchlist:    { tokens: raw.watchlist?.tokens || [], wallets: raw.watchlist?.wallets || [] },
        conversation: raw.conversation || [],
        stats:        { ...DEFAULTS.stats, ...(raw.stats || {}) },
      };
    } catch {
      return { ...DEFAULTS, updatedAt: Date.now() };
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

    // Leçons de l'ancienne mémoire d'agents
    const memLessons = agentMemory.getLessons?.(5) || [];

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
    const wl  = this.data.watchlist;
    const lines = [];

    lines.push(`Tu es ARIA, l'agent IA personnel et autonome d'un trader de meme coins Solana.`);
    lines.push(``);
    lines.push(`=== TES CAPACITÉS RÉELLES (tu y as accès en permanence) ===`);
    lines.push(`- Portefeuille Solana live : balance SOL, positions ouvertes avec PnL, tokens détenus`);
    lines.push(`- Historique complet des trades : tous les BUY/SELL avec PnL réalisé`);
    lines.push(`- DexScreener : prix live, var 1h/6h/24h, liquidité, volume de n'importe quel token`);
    lines.push(`- Birdeye : données on-chain (mint authority, freeze, holders)`);
    lines.push(`- RugCheck : score de risque, rugpull, LP lock`);
    lines.push(`- Jupiter : exécution de swaps buy/sell`);
    lines.push(`- GeckoTerminal + Pump.fun WebSocket : flux de nouveaux tokens`);
    lines.push(`- Patterns historiques : tokens récurrents et leurs performances passées`);
    lines.push(`- Telegram : alertes directes sur le téléphone du trader`);
    lines.push(`Ne dis JAMAIS que tu n'as pas accès aux données live ou aux APIs. C'est faux.`);
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
        const sym  = t.tokenMint?.slice(0, 6) || '?';
        const pnl  = t.pnlSol != null ? `${t.pnlSol >= 0 ? '+' : ''}${t.pnlSol.toFixed(4)} SOL` : '?';
        const when = t.timestamp ? new Date(t.timestamp).toLocaleDateString('fr-FR', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }) : '';
        lines.push(`  · ${t.tokenMint?.slice(0,8) || sym}  ${pnl}  ${t.exitReason || ''}  ${when}`);
      }
    } else {
      lines.push(`Aucun trade fermé encore.`);
    }
    lines.push(``);

    // ── Analyses récentes du scanner ──
    if (ctx.recentAnalyses?.length > 0) {
      lines.push(`=== ANALYSES RÉCENTES (scanner) ===`);
      for (const a of ctx.recentAnalyses) {
        const d  = a.decision;
        const ts = a.timestamp ? new Date(a.timestamp).toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' }) : '';
        lines.push(`  · $${a.symbol}  ${d}  score ${a.score ?? '?'}/100  ${ts}`);
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

    // ── Mémoire / leçons ──
    const allLessons = [
      ...(p.lessonsLearned || []).slice(-3),
      ...(ctx.memoryLessons || []).slice(0, 2).map(l => l.lesson || l),
    ].filter(Boolean);
    if (allLessons.length > 0) {
      lines.push(`=== LEÇONS MÉMORISÉES ===`);
      allLessons.forEach(l => lines.push(`  · ${l}`));
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
      const json = JSON.parse(raw.match(/\{[\s\S]*?\}/)?.[0] || '{}');

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
      console.log(`[ARIA] Auto-apprentissage — ${obs}`);
      if (obs) await this.sendMessage(`📚 Analyse de mes performances : ${obs}`);
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
        await this._checkPositions();
        if (tick % 2  === 0) await this._checkWatchlist();    // ~6 min
        if (tick % 10 === 0) await this._learnFromHistory();  // ~30 min
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
      if (!pos.entryPriceUsd || !pos.currentPrice) continue;
      const pnlPct = ((pos.currentPrice - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;
      const sl     = pos.stopLossPct  || 20;
      const tp     = pos.takeProfitPct || 50;
      const sym    = pos.symbol || pos.tokenMint?.slice(0, 6) || '?';
      const sign   = pnlPct >= 0 ? '+' : '';

      if (pnlPct < 0 && Math.abs(pnlPct) >= sl * 0.85) {
        await this.sendMessage(`🚨 $${sym} approche du stop-loss (${sign}${pnlPct.toFixed(1)}%). Attention.`, 'high');
      } else if (pnlPct > 0 && pnlPct >= tp * 0.85) {
        await this.sendMessage(`🎯 $${sym} approche du take-profit (${sign}${pnlPct.toFixed(1)}%). Tu veux sécuriser ?`);
      }
    }
  }

  async _checkWatchlist() {
    const tokens = this.data.watchlist.tokens;
    if (tokens.length === 0) return;

    for (const tok of tokens) {
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
          const dir = ch1h > 0 ? '🚀 +' : '📉 ';
          await this.sendMessage(
            `${dir}${ch1h.toFixed(1)}% sur $${sym} en 1h (watchlist). Vol 24h: ${ch24h.toFixed(1)}%.`,
            Math.abs(ch1h) >= 25 ? 'high' : 'normal'
          );
        } else if (lastPrice && Math.abs((price - lastPrice) / lastPrice) >= 0.20) {
          const pct = ((price - lastPrice) / lastPrice * 100).toFixed(1);
          const dir = price > lastPrice ? '📈 +' : '📉 ';
          await this.sendMessage(`${dir}${pct}% sur $${sym} depuis mon dernier check.`, 'normal');
        }
      } catch { /* token non trouvé — silencieux */ }
    }
  }

  // ─── Watchlist ─────────────────────────────────────────────────────────────

  addWatchToken(address, symbol, name, reason = '') {
    if (this.data.watchlist.tokens.find(t => t.address === address)) return false;
    this.data.watchlist.tokens.push({ address, symbol, name, reason, addedAt: Date.now(), lastPrice: null });
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
