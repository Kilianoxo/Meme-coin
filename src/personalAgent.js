/**
 * ARIA — Agent IA Personnel
 *
 * Agent unique qui remplace le système multi-agents (Bull/Bear/Risk Manager).
 * Personnalité évolutive, mémoire persistante, chat dashboard + Telegram.
 *
 * Fonctions :
 *  - analyzeToken()     → analyse single-call (remplace runDebate)
 *  - chat()             → conversation dashboard
 *  - sendMessage()      → messages proactifs + ping Telegram si haute priorité
 *  - evolvePersonality()→ apprentissage après chaque trade clôturé
 *  - watchlist          → tokens + wallets à surveiller
 */

const fs   = require('fs');
const path = require('path');
const { createMessage, ask } = require('./anthropic');

const DATA_PATH  = path.join(__dirname, '../data/agent.json');
const MODEL      = 'claude-haiku-4-5-20251001';
const MAX_CONV   = 60; // messages max conservés

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
    this.data        = this._load();
    this._notify     = null;     // fn(msg: string) → Telegram
    this._pushSSE    = null;     // fn(entry: object) → SSE dashboard
  }

  /** Callback pour envoyer un message Telegram (haute priorité) */
  setNotifyCallback(fn) { this._notify = fn; }

  /** Callback pour pusher un événement SSE au dashboard */
  setSSECallback(fn)    { this._pushSSE = fn; }

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

  // ─── Personnalité ──────────────────────────────────────────────────────────

  _systemPrompt(ctx = {}) {
    const p = this.data.personality;
    const lines = [
      `Tu es ARIA, l'agent IA personnel d'un trader de meme coins Solana.`,
      `Personnalité : ${p.traits.join(', ')}. Humeur : ${MOOD_LABELS[p.mood] || p.mood}. Style : ${p.tradingStyle}.`,
      `Tolérance risque : ${p.riskTolerance.toFixed(1)}/10. Confiance : ${p.confidence.toFixed(1)}/10.`,
    ];
    if (p.lessonsLearned.length > 0)
      lines.push(`Tes leçons récentes : ${p.lessonsLearned.slice(-3).join(' / ')}`);
    if (ctx.balance    != null) lines.push(`Balance wallet : ${ctx.balance.toFixed(4)} SOL`);
    if (ctx.positions  != null) lines.push(`${ctx.positions} position(s) ouverte(s)`);
    lines.push('');
    lines.push(`Règles : réponds en français, tutois l'utilisateur, sois concise (2-4 phrases sauf si analyse demandée).`);
    lines.push(`Tu as de vraies opinions. 1-2 emojis max. Si une action te semble risquée, dis-le franchement.`);
    return lines.join('\n');
  }

  /**
   * Fait évoluer la personnalité après chaque trade clôturé.
   * Appelé depuis trader.js à la vente.
   */
  evolvePersonality(outcome, pnlPct) {
    const p = this.data.personality;
    const s = this.data.stats;

    if (outcome === 'WIN') {
      s.winStreak++;
      s.lossStreak  = 0;
      s.correctCalls++;
      p.confidence  = Math.min(10, p.confidence + 0.3);
      p.mood        = s.winStreak >= 3 ? 'excited' : 'satisfied';
      if (pnlPct > 50) p.aggressiveness = Math.min(10, p.aggressiveness + 0.2);
    } else {
      s.lossStreak++;
      s.winStreak     = 0;
      p.confidence    = Math.max(1.0, p.confidence    - 0.4);
      p.riskTolerance = Math.max(2.0, p.riskTolerance - 0.3);
      p.mood          = s.lossStreak >= 2 ? 'concerned' : 'cautious';
      if (pnlPct < -30) {
        const lesson = `Réduire la taille sur tokens à liquidité faible (perte ${Math.abs(pnlPct).toFixed(0)}%)`;
        if (!p.lessonsLearned.includes(lesson)) p.lessonsLearned.push(lesson);
        if (p.lessonsLearned.length > 10) p.lessonsLearned.shift();
      }
    }

    if      (p.riskTolerance <= 3) p.tradingStyle = 'prudent';
    else if (p.riskTolerance >= 7) p.tradingStyle = 'agressif';
    else                           p.tradingStyle = 'équilibré';

    s.tradesAnalyzed++;
    this._save();
    console.log(`[ARIA] Évolution — mood: ${p.mood} | confiance: ${p.confidence.toFixed(1)} | style: ${p.tradingStyle}`);

    // Message proactif si la série de pertes est préoccupante
    if (s.lossStreak >= 3) {
      this.sendMessage(
        `⚠️ ${s.lossStreak} trades perdants consécutifs. Je réduis mon agressivité. Peut-être faire une pause ?`,
        'high'
      ).catch(() => {});
    } else if (s.winStreak >= 3 && outcome === 'WIN') {
      this.sendMessage(`🎯 ${s.winStreak} wins consécutifs ! La stratégie fonctionne bien en ce moment.`).catch(() => {});
    }
  }

  // ─── Analyse de token ──────────────────────────────────────────────────────

  /**
   * Analyse un token et retourne un objet debate compatible avec bot.js.
   * Single Claude call — remplace le système 5-calls multi-agents.
   *
   * @returns {Object} debate — { token, security, rugReport, overview, lpLock, decision, _ariaMode: true }
   */
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

    // Hard block immédiat — pas besoin de Claude
    if (rugReport?.rugged || security?.mintAuthority) {
      const reason = rugReport?.rugged ? 'Rugpull confirmé par RugCheck' : 'Mint authority encore active';
      return this._buildDebate(token, security, rugReport, overview, lpLock,
        { decision: 'SKIP', score: 0, confidence: 10, reasoning: reason, suggestedAmountPct: 0, stopLossPct: 20, takeProfitPct: 50 }
      );
    }

    const secLine = security
      ? `Mint: ${security.mintAuthority ? 'OUI ⛔' : 'off'} | Freeze: ${security.freezeAuthority ? 'OUI' : 'off'} | Holders: ${overview?.holder ?? '?'}`
      : 'Sécurité: N/A';
    const rugLine = rugReport ? `RugCheck: ${rugReport.score}/1000 (${rugReport.riskLevel})` : 'RugCheck: N/A';
    const lpLine  = lpLock   ? `LP: ${lpLock.lpLockedPct.toFixed(0)}% lock ($${(lpLock.lpLockedUSD / 1000).toFixed(1)}K)` : 'LP: ?';
    const recLine = rec?.isRecurring
      ? `RÉCIDIVISTE — vu ${rec.sightings}x${rec.avgPeakPct ? `, peak moy +${rec.avgPeakPct}%` : ''}`
      : 'Première apparition';

    const prompt = [
      `Analyse ce token Solana. Donne une décision de trading en JSON.`,
      ``,
      `$${sym} (${name}) — ${addr}`,
      `Prix: $${parseFloat(token.priceUsd || 0).toFixed(8)}`,
      `Var: 1h ${p.h1 ?? '?'}% | 6h ${p.h6 ?? '?'}% | 24h ${p.h24 ?? '?'}%`,
      `Liq: $${(liq/1000).toFixed(1)}K | Vol24h: $${(vol/1000).toFixed(1)}K | MCap: $${(mcap/1000).toFixed(1)}K`,
      `Source: ${token._source || '?'}`,
      secLine, rugLine, lpLine,
      `Historique: ${recLine}`,
      ``,
      `Mon profil: risque ${pers.riskTolerance.toFixed(1)}/10, style ${pers.tradingStyle}.`,
      ``,
      `JSON uniquement (pas de texte autour):`,
      `{"decision":"BUY"|"WATCH"|"SKIP","score":<0-100>,"confidence":<1-10>,"reasoning":"<200 chars max>","suggestedAmountPct":<1-5>,"stopLossPct":<15-35>,"takeProfitPct":<30-100>}`,
    ].join('\n');

    try {
      const raw  = await ask(null, prompt, MODEL);
      const json = JSON.parse(raw.match(/\{[\s\S]*?\}/)?.[0] || '{}');

      const clamp = (v, lo, hi) => typeof v === 'number' ? Math.max(lo, Math.min(hi, v)) : null;
      const decision = {
        decision:           ['BUY','WATCH','SKIP'].includes(json.decision) ? json.decision : 'SKIP',
        score:              clamp(json.score, 0, 100)   ?? 0,
        confidence:         clamp(json.confidence, 0, 10) ?? 5,
        reasoning:          (json.reasoning || '').slice(0, 250),
        suggestedAmountPct: clamp(json.suggestedAmountPct, 0, 10) ?? 3,
        stopLossPct:        clamp(json.stopLossPct, 10, 50)  ?? 20,
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

  /**
   * Envoie un message à ARIA et retourne sa réponse.
   * @param {string} userMessage
   * @param {Object} ctx — { balance?, positions? } contexte portefeuille
   */
  async chat(userMessage, ctx = {}) {
    this.data.conversation.push({ role: 'user', content: userMessage, timestamp: Date.now() });
    if (this.data.conversation.length > MAX_CONV)
      this.data.conversation = this.data.conversation.slice(-MAX_CONV);

    const messages = this.data.conversation.slice(-24).map(m => ({ role: m.role, content: m.content }));

    try {
      const resp = await createMessage({
        model:     MODEL,
        maxTokens: 350,
        system:    this._systemPrompt(ctx),
        messages,
      });
      const text = resp.content[0].text;

      this.data.conversation.push({ role: 'assistant', content: text, timestamp: Date.now() });
      if (this.data.conversation.length > MAX_CONV)
        this.data.conversation = this.data.conversation.slice(-MAX_CONV);
      this._save();

      // Détecte automatiquement les adresses Solana pour auto-ajout watchlist
      this._autoWatch(userMessage);

      // Push SSE en temps réel vers le dashboard
      if (this._pushSSE)
        this._pushSSE({ type: 'aria_response', content: text, timestamp: Date.now() });

      return text;
    } catch (err) {
      console.error('[ARIA] Erreur chat:', err.message);
      return "Désolée, j'ai eu un bug technique. Réessaie.";
    }
  }

  /** Détecte les adresses Solana dans un message → auto-ajout watchlist si mot-clé présent */
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

  /**
   * ARIA envoie spontanément un message (alerte, observation, conseil).
   * @param {string} content
   * @param {'normal'|'high'} priority — 'high' envoie aussi sur Telegram
   */
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

  // ─── Watchlist ─────────────────────────────────────────────────────────────

  addWatchToken(address, symbol, name, reason = '') {
    if (this.data.watchlist.tokens.find(t => t.address === address)) return false;
    this.data.watchlist.tokens.push({ address, symbol, name, reason, addedAt: Date.now(), lastPrice: null });
    this._save();
    console.log(`[ARIA] Token watchlist + $${symbol} (${address.slice(0,8)}…)`);
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
    console.log(`[ARIA] Wallet watchlist + ${label || address.slice(0,8)}…`);
    return true;
  }

  removeWatchWallet(address) {
    const before = this.data.watchlist.wallets.length;
    this.data.watchlist.wallets = this.data.watchlist.wallets.filter(w => w.address !== address);
    if (this.data.watchlist.wallets.length !== before) this._save();
  }

  // ─── API publique pour le dashboard ───────────────────────────────────────

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
