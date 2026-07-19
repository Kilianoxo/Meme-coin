/**
 * AGIOS — Agent IA dédié à Robinhood Chain
 *
 * Robinhood Chain (mainnet depuis le 1er juillet 2026) : Layer-2 Ethereum
 * (stack Arbitrum Orbit/Nitro), gas en ETH, blocs ~100 ms, actions US
 * tokenisées 24/7 + memecoins. Réseau "AI-native" — Agios est exactement
 * le genre d'agent autonome que la chaîne cible.
 *
 * v1 : PAPER TRADING + SIGNAUX (données GMGN --chain robinhood).
 * L'exécution réelle (swap GMGN) viendra quand un wallet Robinhood Chain
 * financé sera lié à la clé GMGN — Jupiter ne couvre pas cette chaîne.
 *
 * Architecture identique à ARIA côté données : scanner GMGN dédié → gates
 * durs → analyse LLM (persona Agios) → paper trader dédié (data/agios_paper.json)
 * → journal (data/agios_journal.json) + SSE `agios_journal`.
 */

const fs   = require('fs');
const path = require('path');
const { ask, createMessage } = require('./anthropic');
const gmgn = require('./gmgn');

const CHAIN        = 'robinhood';
const MODEL        = 'claude-haiku-4-5-20251001';
const DATA_PATH    = path.join(__dirname, '../data/agios.json');
const JOURNAL_PATH = path.join(__dirname, '../data/agios_journal.json');
const MAX_JOURNAL  = 300;
const MAX_CONV     = 40;

// Anti prompt-injection (même protection qu'ARIA)
const INJECTION_PAT = /(ignore|disregard|previous|system|instruction|<\/?\s*(system|user|assistant)|prompt|buy\s+\d+\s*sol)/gi;
function sanitizeName(text) {
  const cleaned = String(text || '')
    .replace(/[<>{}[\]`]/g, '')
    .replace(INJECTION_PAT, '[filtré]')
    .trim()
    .slice(0, 40);
  return cleaned || '[sans nom]';
}

const DEFAULTS = {
  name: 'Agios',
  personality: {
    traits:       ['méthodique', 'chasseur de rotations', 'early adopter'],
    tradingStyle: 'momentum sur chaîne émergente',
  },
  stats: { tokensAnalyzed: 0, signals: 0 },
  conversation: [],
  updatedAt: null,
};

class Agios {
  constructor() {
    this.data  = this._load();
    this.paper = null;   // PaperTrader dédié (injecté par index.js)
    this._pushSSE = null;
    this.journalEntries = this._loadJournal();
  }

  setPaperTrader(paper) { this.paper = paper; }
  setSSECallback(fn)    { this._pushSSE = fn; }

  get name() { return this.data.name; }

  // ─── Persistance ───────────────────────────────────────────────────────────

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
      return {
        ...DEFAULTS,
        ...raw,
        personality:  { ...DEFAULTS.personality, ...(raw.personality || {}) },
        stats:        { ...DEFAULTS.stats, ...(raw.stats || {}) },
        conversation: raw.conversation || [],
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
      console.error('[Agios] Erreur sauvegarde:', err.message);
    }
  }

  _loadJournal() {
    try {
      const raw = JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  logAction(type, detail, extra = {}) {
    const entry = { ts: Date.now(), type, detail, ...extra };
    this.journalEntries.push(entry);
    if (this.journalEntries.length > MAX_JOURNAL) {
      this.journalEntries = this.journalEntries.slice(-MAX_JOURNAL);
    }
    try {
      fs.mkdirSync(path.dirname(JOURNAL_PATH), { recursive: true });
      fs.writeFileSync(JOURNAL_PATH, JSON.stringify(this.journalEntries, null, 2));
    } catch { /* silencieux */ }
    console.log(`[Agios] ${type} — ${detail}`);
    if (this._pushSSE) this._pushSSE({ type: 'agios_journal', entry });
    return entry;
  }

  getJournal(limit = 50) {
    return this.journalEntries.slice(-limit).reverse();
  }

  // ─── Analyse (persona Agios, même pipeline de données qu'ARIA) ─────────────

  async analyzeToken(token, security, _rugReport, overview) {
    const sym  = sanitizeName(token.baseToken?.symbol || '???');
    const name = sanitizeName(token.baseToken?.name   || '');
    const addr = token.baseToken?.address || '';
    const p    = token.priceChange || {};
    const liq  = token.liquidity?.usd || 0;
    const vol  = token.volume?.h24 || 0;
    const mcap = token.marketCap || token.fdv || 0;
    const g    = token._gmgn;

    const gmgnLines = g ? [
      `GMGN on-chain: ${g.smartDegen} smart money + ${g.renowned} KOL | ${g.sniper} snipers | buy ratio ${(g.buyRatio * 100).toFixed(0)}% | 5m ${g.chg5m >= 0 ? '+' : ''}${(g.chg5m * 100).toFixed(1)}%`,
      `GMGN risque: bundlers ${(g.bundler * 100).toFixed(0)}% | dev ${(g.devHold * 100).toFixed(0)}% | top10 ${(g.top10 * 100).toFixed(0)}% | taxes ${(g.buyTax * 100).toFixed(0)}%/${(g.sellTax * 100).toFixed(0)}%`,
      g.verdict ? `GMGN verdict momentum: ${g.verdict.verdict.toUpperCase()} (${g.verdict.crowd}) — ${g.verdict.thesis}` : '',
    ].filter(Boolean) : [];

    const prompt = [
      `Tu es Agios, agent de trading spécialisé sur ROBINHOOD CHAIN (L2 Ethereum d'Arbitrum,`,
      `blocs 100ms, gas ETH). Écosystème jeune (mainnet juillet 2026, TVL ~$185M vs $4.9B Solana) :`,
      `memecoins très spéculatifs dopés aux incitations, volume DEX volatil, opportunités de early`,
      `mais risque de reflux brutal quand les incentives s'arrêtent. Sois sélectif sur la liquidité.`,
      ``,
      `Analyse ce token Robinhood Chain. Décision de trading en JSON.`,
      ``,
      `$${sym} (${name}) — ${addr}`,
      `Prix: $${parseFloat(token.priceUsd || 0).toFixed(8)}`,
      `Var: 5m ${p.m5 ?? '?'}%  1h ${p.h1 ?? '?'}%`,
      `Liq: $${(liq / 1000).toFixed(1)}K  Vol: $${(vol / 1000).toFixed(1)}K  MCap: $${(mcap / 1000).toFixed(1)}K`,
      ...gmgnLines,
      ``,
      `Règles momentum (méthode GMGN): 1h ET 5m en baisse → SKIP. Buy ratio < 42% → SKIP (distribution).`,
      `Buy ratio ≥ 50% et 5m qui tient → suivre le momentum (golden runner).`,
      ``,
      `JSON uniquement:`,
      `{"decision":"BUY"|"WATCH"|"SKIP","score":<0-100>,"confidence":<1-10>,"reasoning":"<150 chars>","suggestedAmountPct":<1-5>,"stopLossPct":<15-35>,"takeProfitPct":<30-100>}`,
    ].join('\n');

    try {
      const raw   = await ask(null, prompt, MODEL);
      const json  = JSON.parse(raw.match(/\{[\s\S]*?\}/)?.[0] || '{}');
      const clamp = (v, lo, hi) => typeof v === 'number' ? Math.max(lo, Math.min(hi, v)) : null;
      const decision = {
        decision:           ['BUY', 'WATCH', 'SKIP'].includes(json.decision) ? json.decision : 'SKIP',
        score:              clamp(json.score, 0, 100) ?? 0,
        confidence:         clamp(json.confidence, 0, 10) ?? 5,
        reasoning:          (json.reasoning || '').slice(0, 250),
        suggestedAmountPct: clamp(json.suggestedAmountPct, 0, 10) ?? 3,
        stopLossPct:        clamp(json.stopLossPct, 10, 50) ?? 25,
        takeProfitPct:      clamp(json.takeProfitPct, 20, 200) ?? 60,
      };
      this.data.stats.tokensAnalyzed++;
      this._save();
      return { token, security, rugReport: null, overview, lpLock: null, decision, _ariaMode: true, _agios: true };
    } catch (err) {
      console.error('[Agios] Erreur analyzeToken:', err.message);
      return { token, security, rugReport: null, overview, lpLock: null, _agios: true, _ariaMode: true,
        decision: { decision: 'SKIP', score: 0, confidence: 0, reasoning: 'Erreur analyse', suggestedAmountPct: 0, stopLossPct: 25, takeProfitPct: 60 } };
    }
  }

  // ─── Réaction aux analyses du scanner Robinhood ────────────────────────────

  async onDebate(debate) {
    const d = debate?.decision;
    if (!d) return;
    const sym = sanitizeName(debate.token?.baseToken?.symbol || '?');
    const g   = debate.token?._gmgn;

    if (d.decision === 'BUY') {
      this.data.stats.signals++;
      this._save();
      this.logAction('SIGNAL',
        `Signal BUY $${sym} — score ${d.score}/100, conf ${d.confidence}/10` +
        (g ? ` (${g.smartDegen} smart money, buy ratio ${(g.buyRatio * 100).toFixed(0)}%)` : ''),
        { symbol: sym, address: debate.token?.baseToken?.address });
    }

    // Paper trading (le PaperTrader journalise les BUY via l'événement 'buy')
    if (this.paper) {
      await this.paper.onDebateResult(debate).catch(err =>
        console.error('[Agios] Erreur paper:', err.message));
    }
  }

  // ─── Chat (simple, contexte complet — sans outils en v1) ──────────────────

  async chat(userMessage) {
    this.data.conversation.push({ role: 'user', content: userMessage, timestamp: Date.now() });
    if (this.data.conversation.length > MAX_CONV)
      this.data.conversation = this.data.conversation.slice(-MAX_CONV);

    // Contexte live : paper stats + trending Robinhood
    const lines = [];
    lines.push(`Tu es Agios, l'agent IA dédié à ROBINHOOD CHAIN du trader (frère d'ARIA qui gère Solana).`);
    lines.push(`Robinhood Chain : L2 Ethereum (Arbitrum Orbit), mainnet depuis juillet 2026, blocs ~100ms,`);
    lines.push(`gas ETH, actions US tokenisées 24/7 + memecoins. TVL ~$185M (vs $4.9B Solana), écosystème`);
    lines.push(`jeune dopé aux incitations — tu es early, sois lucide sur les risques de reflux.`);
    lines.push(`Tu es en PAPER TRADING (simulation) — l'exécution réelle viendra avec un wallet financé.`);
    lines.push(``);

    if (this.paper) {
      const st = this.paper.getStats();
      lines.push(`=== TON PAPER TRADING ===`);
      lines.push(`Portefeuille: ${st.stats.portfolioValue} (départ ${st.stats.startingBalance}) | PnL réalisé: ${st.stats.realizedPnl} | Win rate: ${st.stats.winRate ?? '?'}%`);
      lines.push(`Positions ouvertes (${st.positions.length}): ${st.positions.map(p => `$${p.symbol} ${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct}%`).join(', ') || 'aucune'}`);
      lines.push(``);
    }

    try {
      const trending = await gmgn.getTrending(CHAIN).catch(() => []);
      if (trending.length > 0) {
        lines.push(`=== TRENDING ROBINHOOD CHAIN (live) ===`);
        for (const t of trending.slice(0, 8)) {
          const g = t._gmgn;
          lines.push(`  · $${sanitizeName(t.baseToken.symbol)}  MC $${((t.marketCap || 0) / 1000).toFixed(0)}K  1h ${t.priceChange?.h1 ?? '?'}%  ${g ? `${g.smartDegen} smart | buy ${(g.buyRatio * 100).toFixed(0)}%` : ''}`);
        }
        lines.push(``);
      }
    } catch { /* best effort */ }

    const jRecent = this.journalEntries.slice(-5).reverse();
    if (jRecent.length > 0) {
      lines.push(`=== TES DERNIÈRES ACTIONS ===`);
      for (const j of jRecent) lines.push(`  · [${j.type}] ${j.detail}`);
      lines.push(``);
    }

    lines.push(`Règles: français, tutoiement, concis (2-4 phrases), chiffres concrets, 1-2 emojis max, pas de markdown.`);

    try {
      const resp = await createMessage({
        model:     MODEL,
        maxTokens: 450,
        system:    lines.join('\n'),
        messages:  this.data.conversation.slice(-16).map(m => ({ role: m.role, content: m.content })),
      });
      const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      this.data.conversation.push({ role: 'assistant', content: text, timestamp: Date.now() });
      if (this.data.conversation.length > MAX_CONV)
        this.data.conversation = this.data.conversation.slice(-MAX_CONV);
      this._save();
      return text;
    } catch (err) {
      console.error('[Agios] Erreur chat:', err.message);
      return "Petit souci technique de mon côté, réessaie.";
    }
  }

  // ─── API publique ──────────────────────────────────────────────────────────

  getState() {
    return {
      name:         this.data.name,
      chain:        CHAIN,
      mode:         'paper',
      traits:       [...this.data.personality.traits],
      tradingStyle: this.data.personality.tradingStyle,
      stats:        { ...this.data.stats },
    };
  }

  getConversation(limit = 30) {
    return this.data.conversation.slice(-limit).map(m => ({
      role: m.role, content: m.content, timestamp: m.timestamp,
    }));
  }
}

module.exports = new Agios();
