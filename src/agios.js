/**
 * AGIOS — Agent IA dédié à Robinhood Chain + Robinhood Agentic Trading
 *
 * Deux volets, bien distincts :
 *
 * 1. ROBINHOOD CHAIN (memecoins/actions tokenisées on-chain) — L2 Ethereum
 *    (stack Arbitrum Orbit/Nitro), gas ETH, blocs ~100ms, mainnet juillet 2026.
 *    v1 : PAPER TRADING + SIGNAUX (données GMGN --chain robinhood). L'exécution
 *    réelle viendra via swap GMGN quand un wallet Robinhood Chain sera financé
 *    (Jupiter ne couvre pas cette chaîne).
 *    Pipeline : scanner GMGN dédié → gates durs → analyse LLM (persona Agios)
 *    → paper trader dédié (data/agios_paper.json).
 *
 * 2. ROBINHOOD AGENTIC TRADING (courtage réel, actions US) — connexion au
 *    serveur MCP officiel de Robinhood (agent.robinhood.com/mcp/trading) via
 *    OAuth 2.0 (src/robinhoodMcp.js). Trade sur un compte "Agentic" dédié à
 *    fonds pré-chargés (isolé du reste du compte Robinhood). Aucun nom d'outil
 *    codé en dur : MCP est auto-descriptif (tools/list), les outils exposés
 *    par Robinhood sont pontés dynamiquement dans la boucle de chat agentique.
 *    Sécurité : `equitiesLiveTrading` OFF par défaut — toute action qui n'est
 *    pas clairement en lecture seule (annotation MCP readOnlyHint ou heuristique
 *    de nom) passe par une confirmation Telegram avant exécution. Une fois activé,
 *    exécution directe + notification (même contrat que l'autonomie d'ARIA).
 *
 * Journal commun (data/agios_journal.json) + SSE `agios_journal` pour les deux volets.
 */

const fs   = require('fs');
const path = require('path');
const { ask, createMessage } = require('./anthropic');
const gmgn = require('./gmgn');
const robinhoodMcp = require('./robinhoodMcp');

const CHAIN        = 'robinhood';
const MODEL        = 'claude-haiku-4-5-20251001';
const DATA_PATH    = path.join(__dirname, '../data/agios.json');
const JOURNAL_PATH = path.join(__dirname, '../data/agios_journal.json');
const MAX_JOURNAL  = 300;
const MAX_CONV     = 40;
const MAX_TOOL_ROUNDS = 6;
const CONFIRM_TIMEOUT_MS = 10 * 60_000; // 10 min pour répondre à une confirmation de trade

// Heuristique de nom pour les outils Robinhood qui NE SONT PAS en lecture seule
// (utilisée seulement si le serveur ne fournit pas d'annotation readOnlyHint)
const WRITE_TOOL_PAT = /(order|trade|buy|sell|place|execute|submit|cancel|transfer|withdraw|deposit|close|open_position)/i;

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
  equities: {
    liveTrading: false, // exécution directe des trades Robinhood réels (OFF par défaut — vraies actions, vrai argent)
  },
  conversation: [],
  updatedAt: null,
};

class Agios {
  constructor() {
    this.data  = this._load();
    this.paper = null;   // PaperTrader dédié (injecté par index.js)
    this._pushSSE = null;
    this._notify  = null; // fn(msg) → Telegram (confirmations de trades réels)
    this.journalEntries = this._loadJournal();
    this._pendingConfirmations = new Map(); // id → { toolName, input, resolve, reject, timer }
  }

  setPaperTrader(paper) { this.paper = paper; }
  setNotifyCallback(fn) { this._notify = fn; }
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
        equities:     { ...DEFAULTS.equities, ...(raw.equities || {}) },
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

  // ─── Robinhood Agentic Trading (courtage réel, actions US) ─────────────────

  /**
   * Lance la connexion OAuth au serveur MCP Robinhood. Doit être appelé depuis
   * la machine qui fait tourner le bot (navigateur + réseau requis) — jamais
   * depuis un environnement cloud sans accès direct à agent.robinhood.com.
   * @param {(url: string) => void} onAuthUrl — reçoit le lien à transmettre au trader
   */
  async connectEquities(onAuthUrl) {
    this.logAction('CONFIG', 'Connexion Robinhood Agentic Trading démarrée…');
    const result = await robinhoodMcp.startSetup(onAuthUrl);
    if (result.ok) {
      this.logAction('CONFIG', '✅ Robinhood Agentic Trading connecté (compte dédié, OAuth)');
    } else {
      this.logAction('ERROR', `Connexion Robinhood échouée : ${result.error}`);
    }
    return result;
  }

  async disconnectEquities() {
    await robinhoodMcp.disconnectAll();
    this.logAction('CONFIG', 'Robinhood Agentic Trading déconnecté');
  }

  async getEquitiesState() {
    return {
      connected:   await robinhoodMcp.isAvailable(),
      liveTrading: this.data.equities.liveTrading,
    };
  }

  setEquitiesLiveTrading(enabled) {
    this.data.equities.liveTrading = !!enabled;
    this._save();
    this.logAction('CONFIG', `Trading réel Robinhood (actions US) : ${enabled ? 'ACTIVÉ — exécution directe' : 'désactivé — confirmation requise'}`);
  }

  /** Ponte les outils MCP Robinhood vers le format tool-use Anthropic (aucun nom en dur) */
  async _bridgeRobinhoodTools() {
    const tools = await robinhoodMcp.listTools();
    return tools.map(t => ({
      name:         `rh_${t.name}`,
      description:  (t.description || `Outil Robinhood: ${t.name}`).slice(0, 1000),
      input_schema: t.inputSchema || { type: 'object', properties: {} },
      _raw:         t,
    }));
  }

  /** true si l'outil semble être en lecture seule (annotation MCP, sinon heuristique de nom) */
  _isReadOnlyTool(rawTool) {
    const hint = rawTool?.annotations?.readOnlyHint;
    if (typeof hint === 'boolean') return hint;
    return !WRITE_TOOL_PAT.test(rawTool?.name || '');
  }

  /**
   * Exécute un outil Robinhood ponté. Les outils en lecture seule passent
   * directement. Les autres (ordres, transferts…) :
   *  - liveTrading ON  → exécution directe + notification Telegram
   *  - liveTrading OFF → confirmation Telegram (boutons Oui/Non), 10 min pour répondre
   */
  async _execRobinhoodTool(bridgedName, input) {
    const toolName = bridgedName.replace(/^rh_/, '');
    const tools     = await robinhoodMcp.listTools();
    const rawTool   = tools.find(t => t.name === toolName);
    const readOnly  = rawTool ? this._isReadOnlyTool(rawTool) : false;

    if (readOnly) {
      const res = await robinhoodMcp.callTool(toolName, input);
      return this._mcpResultToPlain(res);
    }

    if (this.data.equities.liveTrading) {
      const res = await robinhoodMcp.callTool(toolName, input);
      this.logAction('BUY', `Action Robinhood exécutée : ${toolName}(${JSON.stringify(input).slice(0, 150)})`, { symbol: null });
      await this._notifyTelegram(`💵 <b>Agios — action Robinhood exécutée</b>\n<code>${toolName}</code>\n${this._esc(JSON.stringify(input).slice(0, 300))}`);
      return this._mcpResultToPlain(res);
    }

    // Confirmation requise — vraie action de courtage, on ne devine jamais
    return this._requestConfirmation(toolName, input);
  }

  _mcpResultToPlain(res) {
    if (!res) return { resultat: 'aucune réponse' };
    const text = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    try { return JSON.parse(text); } catch { return { texte: text.slice(0, 4000) }; }
  }

  _esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  async _notifyTelegram(html) {
    if (this._notify) { try { await this._notify(html); } catch { /* silencieux */ } }
  }

  /** Met une action en attente de confirmation Telegram, résolue par confirmAction() */
  _requestConfirmation(toolName, input) {
    const id = `rh_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pendingConfirmations.delete(id);
        resolve({ confirme: false, resultat: 'Délai de confirmation dépassé (10 min) — action annulée.' });
      }, CONFIRM_TIMEOUT_MS);

      this._pendingConfirmations.set(id, { toolName, input, resolve, timer });
      this.logAction('ALERT', `Confirmation requise : ${toolName}(${JSON.stringify(input).slice(0, 150)})`);

      this._notifyTelegram(
        `⚠️ <b>Agios veut exécuter une action Robinhood réelle</b>\n` +
        `<code>${toolName}</code>\n${this._esc(JSON.stringify(input).slice(0, 300))}\n\n` +
        `id: <code>${id}</code>`
      ).catch(() => {});

      if (this._requestConfirmationUi) this._requestConfirmationUi(id, toolName, input);
    });
  }

  /** fn(id, toolName, input) — branché par bot.js pour afficher les boutons inline Telegram */
  setConfirmationUiCallback(fn) { this._requestConfirmationUi = fn; }

  /** Résout une confirmation en attente (appelé depuis le callback des boutons Telegram) */
  async confirmAction(id, approve) {
    const pending = this._pendingConfirmations.get(id);
    if (!pending) return { ok: false, error: 'Confirmation introuvable ou expirée' };
    clearTimeout(pending.timer);
    this._pendingConfirmations.delete(id);

    if (!approve) {
      this.logAction('CONFIG', `Action Robinhood refusée par le trader : ${pending.toolName}`);
      pending.resolve({ confirme: false, resultat: "Refusé par le trader." });
      return { ok: true };
    }

    try {
      const res = await robinhoodMcp.callTool(pending.toolName, pending.input);
      this.logAction('BUY', `Action Robinhood confirmée et exécutée : ${pending.toolName}(${JSON.stringify(pending.input).slice(0, 150)})`);
      pending.resolve({ confirme: true, ...this._mcpResultToPlain(res) });
    } catch (err) {
      this.logAction('ERROR', `Action Robinhood confirmée mais échouée : ${err.message}`);
      pending.resolve({ confirme: true, erreur: err.message });
    }
    return { ok: true };
  }

  getPendingConfirmations() {
    return [...this._pendingConfirmations.entries()].map(([id, p]) => ({ id, toolName: p.toolName, input: p.input }));
  }

  // ─── Chat (boucle agentique — outils Robinhood pontés dynamiquement) ──────

  async _systemPrompt() {
    const lines = [];
    lines.push(`Tu es Agios, l'agent IA dédié à ROBINHOOD du trader (frère d'ARIA qui gère Solana).`);
    lines.push(`Tu couvres DEUX volets, ne les confonds jamais :`);
    lines.push(`1. Robinhood CHAIN (L2 Ethereum/Arbitrum Orbit, blocs ~100ms, gas ETH) : memecoins +`);
    lines.push(`   actions tokenisées on-chain. TVL ~$185M (vs $4.9B Solana), écosystème jeune dopé aux`);
    lines.push(`   incitations — tu es early, sois lucide sur les risques de reflux. Tu es en PAPER`);
    lines.push(`   TRADING ici (simulation, l'exécution réelle viendra avec un wallet financé).`);
    lines.push(`2. Robinhood AGENTIC TRADING (courtage réel) : actions US véritables sur le compte`);
    lines.push(`   "Agentic" dédié du trader (fonds pré-chargés, isolé de son compte principal), via`);
    lines.push(`   les outils rh_* ci-dessous si connecté. C'est du VRAI ARGENT — sois rigoureux.`);
    lines.push(``);

    const eq = await this.getEquitiesState();
    lines.push(`=== ROBINHOOD AGENTIC TRADING (courtage réel) ===`);
    lines.push(`Connecté: ${eq.connected ? 'OUI' : 'NON (le trader doit faire /robinhood_connect sur Telegram)'}`);
    if (eq.connected) {
      lines.push(`Trading réel: ${eq.liveTrading ? 'ACTIF — tu exécutes directement + tu notifies' : 'confirmation requise avant toute action non-lecture (bouton Telegram, 10 min)'}`);
      lines.push(`Utilise les outils rh_* pour lire le portefeuille / positions / historique librement.`);
      lines.push(`Pour une action de trading (ordre, etc.), appelle l'outil rh_* correspondant — la`);
      lines.push(`confirmation (si nécessaire) est gérée automatiquement, ne demande pas la permission`);
      lines.push(`en langage naturel, appelle l'outil directement.`);
    }
    lines.push(``);

    if (this.paper) {
      const st = this.paper.getStats();
      lines.push(`=== TON PAPER TRADING (Robinhood Chain) ===`);
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

    lines.push(`Règles: français, tutoiement, concis (2-4 phrases sauf donnée détaillée demandée), chiffres concrets, 1-2 emojis max, pas de markdown.`);
    return lines.join('\n');
  }

  async chat(userMessage) {
    this.data.conversation.push({ role: 'user', content: userMessage, timestamp: Date.now() });
    if (this.data.conversation.length > MAX_CONV)
      this.data.conversation = this.data.conversation.slice(-MAX_CONV);

    const system = await this._systemPrompt();
    const tools  = await this._bridgeRobinhoodTools();
    const loopMessages = this.data.conversation.slice(-16).map(m => ({ role: m.role, content: m.content }));

    try {
      let text = '';
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const resp = await createMessage({
          model:     MODEL,
          maxTokens: 500,
          system,
          messages:  loopMessages,
          tools:     tools.length > 0 ? tools.map(({ _raw, ...t }) => t) : undefined,
        });

        const toolUses = (resp.content || []).filter(b => b.type === 'tool_use');
        const textPart = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

        if (resp.stop_reason !== 'tool_use' || toolUses.length === 0 || round === MAX_TOOL_ROUNDS) {
          text = textPart || text || "J'ai les données mais pas su conclure, reformule ?";
          break;
        }

        loopMessages.push({ role: 'assistant', content: resp.content });
        const results = [];
        for (const tu of toolUses) {
          console.log(`[Agios] 🔧 Outil: ${tu.name}(${JSON.stringify(tu.input || {}).slice(0, 120)})`);
          let result;
          try {
            result = await this._execRobinhoodTool(tu.name, tu.input || {});
          } catch (err) {
            result = { erreur: err.message?.slice(0, 200) || 'erreur inconnue' };
          }
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result).slice(0, 4000) });
        }
        loopMessages.push({ role: 'user', content: results });
      }

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
      equities:     { ...this.data.equities }, // connected ajouté par getEquitiesState() côté dashboard (async)
    };
  }

  getConversation(limit = 30) {
    return this.data.conversation.slice(-limit).map(m => ({
      role: m.role, content: m.content, timestamp: m.timestamp,
    }));
  }
}

module.exports = new Agios();
