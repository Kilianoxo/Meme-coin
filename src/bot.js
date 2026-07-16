/**
 * Bot Telegram — Interface complète de contrôle
 *
 * Commandes:
 *   /start      — Bienvenue
 *   /help       — Liste complète des commandes avec descriptions
 *   /status     — État général du bot
 *   /balance    — Balance SOL du wallet
 *   /scan       — Lancer un scan manuel
 *   /positions  — Positions ouvertes
 *   /history    — 10 derniers trades
 *   /auto       — Activer/désactiver l'auto-trade
 *   /analyse <adresse>          — Analyse complète d'un token
 *   /buy <adresse> <sol>        — Achat manuel
 *   /sell <adresse> [pct]       — Vente manuelle (défaut 100%)
 */

const { Telegraf, Markup } = require('telegraf');
const dex           = require('./dexscreener');
const personalAgent  = require('./personalAgent');
const { formatSecurity } = require('./birdeye');
const rugcheck      = require('./rugcheck');
const tokenHistory  = require('./tokenHistory');
const state         = require('./state');
const logger        = require('./logger');

class Bot {
  constructor(trader, scanner) {
    this.bot = new Telegraf(process.env.TELEGRAM_TOKEN);
    this.trader = trader;
    this.scanner = scanner;
    this.adminId = parseInt(process.env.TELEGRAM_ADMIN_ID, 10);
    this.maxPositionSol = parseFloat(process.env.MAX_POSITION_SOL || '0.1');

    // Guard anti-doublon : adresses de tokens dont l'achat est en cours
    this._buyInFlight = new Set();

    // Compteurs pour le résumé horaire
    this._hourlyAnalyzed = 0;
    this._hourlyRejected = 0;

    this._setupMiddleware();
    this._setupCommands();
    this._setupCallbacks();
    this._listenToScanner();
    this._startHourlySummary();

    // Donne à ARIA le moyen de pinguer Telegram pour les alertes haute priorité
    personalAgent.setNotifyCallback((msg) => this._send(msg, { parse_mode: 'HTML' }));
  }

  // ─── Middleware ────────────────────────────────────────────────────────────

  _setupMiddleware() {
    // Bloque tout le monde sauf l'admin
    this.bot.use((ctx, next) => {
      if (ctx.from?.id !== this.adminId) {
        return ctx.reply('⛔ Accès refusé.');
      }
      return next();
    });
  }

  // ─── Formatage ────────────────────────────────────────────────────────────

  _fmt(n) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return Number(n).toFixed(2);
  }

  /** Échappe les caractères spéciaux HTML dans du contenu dynamique */
  _esc(text) {
    return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  _formatToken(pair) {
    const sym = this._esc(pair.baseToken?.symbol || '???');
    const name = this._esc(pair.baseToken?.name || '');
    const price = parseFloat(pair.priceUsd || 0);
    const ch24 = pair.priceChange?.h24 || 0;
    const vol24 = pair.volume?.h24 || 0;
    const liq = pair.liquidity?.usd || 0;
    const mc = pair.marketCap || pair.fdv || 0;
    const arrow = ch24 >= 0 ? '🟢' : '🔴';
    const pairUrl = pair.url || `https://dexscreener.com/solana/${pair.pairAddress}`;

    return (
      `<b>${sym}</b> (${name})\n` +
      `💰 Prix: $${price < 0.0001 ? price.toExponential(4) : price.toFixed(6)}\n` +
      `${arrow} 24h: ${ch24 >= 0 ? '+' : ''}${ch24.toFixed(2)}%\n` +
      `📊 Volume 24h: $${this._fmt(vol24)}\n` +
      `💧 Liquidité: $${this._fmt(liq)}\n` +
      `📈 Market Cap: $${this._fmt(mc)}\n` +
      `🔗 DEX: ${this._esc(pair.dexId)}\n` +
      `📍 <code>${this._esc(pair.baseToken?.address || '')}</code>\n` +
      `<a href="${pairUrl}">Voir sur DexScreener</a>`
    );
  }

  /** Formate un résultat d'analyse selon le mode (ARIA single-agent ou multi-agents) */
  _formatDebate(debate) {
    if (debate._ariaMode) return this._formatAriaDebate(debate);
    const { bull, bear, momentum, whale, decision, token } = debate;
    const sym      = this._esc(token.baseToken?.symbol || '???');
    const name     = this._esc(token.baseToken?.name || '');
    const price    = parseFloat(token.priceUsd || 0);
    const ch24     = token.priceChange?.h24 || 0;
    const ch1      = token.priceChange?.h1  || 0;
    const pairUrl  = token.url || `https://dexscreener.com/solana/${token.pairAddress}`;
    const decEmoji = { BUY: '🟢', SKIP: '🔴', WAIT: '🟡' }[decision.decision] || '⚪';

    // ─── Header ────────────────────────────────────────────────────────────
    const priceStr  = price < 0.0001 ? price.toExponential(2) : price.toFixed(6);
    const ch24Arrow = ch24 >= 0 ? '🟢' : '🔴';
    const ch1Arrow  = ch1  >= 0 ? '▲'  : '▼';

    let msg = `━━━━━━━━━━━━━━━━━━━\n`;
    if (debate.isGraduated) msg += `🎓 <b>TOKEN GRADUÉ — vient de quitter Pump.fun</b>\n`;
    msg += `🪙 <b>$${sym}</b> — ${name}\n`;
    msg += `💰 $${priceStr}  ${ch24Arrow} ${ch24 >= 0 ? '+' : ''}${ch24.toFixed(1)}% 24h`;
    if (ch1 !== 0) msg += `  ${ch1Arrow} ${Math.abs(ch1).toFixed(1)}% 1h`;
    msg += `\n<a href="${pairUrl}">📊 DexScreener</a>\n`;
    msg += `━━━━━━━━━━━━━━━━━━━\n\n`;

    // ─── Verdict + Score (en premier) ──────────────────────────────────────
    const scoreStr = decision.score != null ? `  —  <b>${decision.score}/100</b>` : '';
    msg += `${decEmoji} <b>${decision.decision}</b>${scoreStr}  —  confiance ${decision.confidence}/10\n`;
    if (decision.reasoning) msg += `<i>${this._esc(decision.reasoning)}</i>\n`;

    // ─── Badge récidiviste ─────────────────────────────────────────────────
    const rec = debate.token?._recurring;
    if (rec?.isRecurring) {
      const dayStr  = rec.daysSinceLast < 1 ? "aujourd'hui" : `il y a ${rec.daysSinceLast}j`;
      const peakStr = rec.avgPeakPct != null ? `  |  📈 peak moy: <b>+${rec.avgPeakPct}%</b>` : '';
      const cycleStr = rec.totalCycles > 0 ? `  |  ${rec.totalCycles} cycle(s) clôturé(s)` : '';
      msg += `\n🔄 <b>RÉCIDIVISTE</b> — vu <b>${rec.sightings}x</b> boosté  |  ${dayStr}${peakStr}${cycleStr}\n`;
    }

    // ─── Agent Momentum ────────────────────────────────────────────────────
    if (momentum) {
      const trendEmoji = { ACCELERATING: '🚀', STABLE: '➡️', FADING: '📉', REVERSAL: '🔄' }[momentum.trend] || '❓';
      const volEmoji   = { GROWING: '📈', STABLE: '➡️', DECLINING: '📉' }[momentum.volumeSignal] || '';
      msg += `\n⚡ <b>Momentum</b> ${momentum.score}/10  |  ${trendEmoji} ${this._esc(momentum.trend)}  |  ${volEmoji} Vol\n`;
      (momentum.signals || []).slice(0, 2).forEach((s) => (msg += `  → ${this._esc(s)}\n`));
      if (momentum.warning) msg += `  ⚠️ ${this._esc(momentum.warning)}\n`;
    }

    // ─── Agent Bull ────────────────────────────────────────────────────────
    msg += `\n🐂 <b>Bull</b> ${bull.score}/10`;
    if (bull.narrative) msg += `  |  💬 ${this._esc(bull.narrative)}`;
    msg += '\n';
    (bull.arguments || []).slice(0, 2).forEach((a) => (msg += `  → ${this._esc(a)}\n`));

    // ─── Agent Bear ────────────────────────────────────────────────────────
    msg += `\n🐻 <b>Bear</b> ${bear.riskScore}/10  |  ${this._esc(bear.verdict)}\n`;
    (bear.redFlags || []).slice(0, 2).forEach((f) => (msg += `  ⚠️ ${this._esc(f)}\n`));

    // ─── Agent Whale ───────────────────────────────────────────────────────
    if (whale) {
      const concEmoji = { LOW: '✅', MEDIUM: '🟡', HIGH: '🟠', CRITICAL: '🔴' }[whale.concentrationRisk] || '❓';
      const distEmoji = { ACCUMULATING: '📥', NEUTRAL: '➡️', DISTRIBUTING: '📤' }[whale.distributionSignal] || '❓';
      const hlthEmoji = { HEALTHY: '✅', MODERATE: '🟡', THIN: '🟠', CRITICAL: '🔴' }[whale.holderHealth] || '❓';
      msg += `\n🐋 <b>Whale</b> ${whale.score}/10  |  ${concEmoji} ${this._esc(whale.concentrationRisk)}  |  ${distEmoji} ${this._esc(whale.distributionSignal)}  |  ${hlthEmoji} ${this._esc(whale.holderHealth)}\n`;
      (whale.signals || []).slice(0, 1).forEach((s) => (msg += `  → ${this._esc(s)}\n`));
      if (whale.warning) msg += `  ⚠️ ${this._esc(whale.warning)}\n`;
    }

    // ─── Sécurité (condensée sur 2 lignes max) ─────────────────────────────
    const sec    = formatSecurity(debate.security, debate.overview);
    const rug    = rugcheck.formatReport(debate.rugReport);
    const hasLp  = debate.lpLock != null;

    if (sec || hasLp || rug) {
      msg += '\n';

      // Ligne 1 : Mint + Freeze + Holders (sans top10/creator — déjà dans Whale)
      if (sec) {
        msg += `🔒 Mint: ${sec.mint}  |  Freeze: ${sec.freeze}`;
        if (sec.holders) {
          const hNum = parseInt(sec.holders.replace(/\s/g, ''), 10);
          msg += `  |  ${hNum < 200 ? '⚠️' : '👥'} ${sec.holders} holders`;
        }
        msg += '\n';
      }

      // Ligne 2 : LP lock + RugCheck
      const secLine2 = [];
      if (hasLp) {
        const pct    = debate.lpLock.lpLockedPct;
        const usd    = debate.lpLock.lpLockedUSD;
        const usdStr = usd >= 1000 ? `$${(usd / 1000).toFixed(1)}K` : `$${usd.toFixed(0)}`;
        secLine2.push(`${pct >= 80 ? '🔐' : pct >= 50 ? '⚠️' : '🔓'} LP: ${pct.toFixed(0)}% (${usdStr})`);
      }
      if (rug) {
        secLine2.push(rug.rugged ? `🔴 <b>RUGPULL DÉTECTÉ</b>` : `${rug.scoreEmoji} RC: ${rug.score}/1000`);
      }
      if (secLine2.length > 0) {
        if (!sec) msg += '🔒 ';
        msg += secLine2.join('  |  ') + '\n';
      }

      // Ligne 3 : Risques RugCheck détaillés (si présents)
      if (rug?.dangers?.length > 0) msg += `  🔴 ${rug.dangers.map((d) => this._esc(d)).join(', ')}\n`;
      if (rug?.warns?.length  > 0) msg += `  ⚠️ ${rug.warns.map((w) => this._esc(w)).join(', ')}\n`;
    }

    // ─── SL/TP (uniquement si BUY) ────────────────────────────────────────
    if (decision.decision === 'BUY') {
      msg += `\n💸 Taille: ${decision.suggestedAmountPct}%  |  🛑 SL: -${decision.stopLossPct}%  |  🎯 TP: +${decision.takeProfitPct}%`;
    }

    return msg;
  }

  /** Format ARIA mode — single agent, pas de sous-agents Bull/Bear/Momentum/Whale */
  _formatAriaDebate(debate) {
    const { decision, token } = debate;
    const sym     = this._esc(token.baseToken?.symbol || '???');
    const name    = this._esc(token.baseToken?.name   || '');
    const price   = parseFloat(token.priceUsd || 0);
    const ch24    = token.priceChange?.h24 || 0;
    const ch1     = token.priceChange?.h1  || 0;
    const ch1Arrow = ch1 >= 0 ? '▲' : '▼';
    const pairUrl = token.url || `https://dexscreener.com/solana/${token.pairAddress}`;
    const liq     = token.liquidity?.usd  || 0;
    const vol24   = token.volume?.h24     || 0;
    const decEmoji = { BUY: '🟢', SKIP: '🔴', WATCH: '🟡' }[decision.decision] || '⚪';

    let msg = `🤖 <b>ARIA</b> — <b>$${sym}</b>${name ? ` — ${name}` : ''}\n`;
    msg += `💲 $${price < 0.001 ? price.toExponential(2) : price.toFixed(6)}`;
    msg += `  ${ch24 >= 0 ? '▲' : '▼'} ${Math.abs(ch24).toFixed(1)}% 24h`;
    if (ch1 !== 0) msg += `  ${ch1Arrow} ${Math.abs(ch1).toFixed(1)}% 1h`;
    msg += `\n💧 Liq: $${this._fmt(liq)}  |  📊 Vol: $${this._fmt(vol24)}\n`;
    msg += `<a href="${pairUrl}">📊 DexScreener</a>\n`;
    msg += `━━━━━━━━━━━━━━━━━━━\n\n`;

    const scoreStr = decision.score != null ? `  —  <b>${decision.score}/100</b>` : '';
    msg += `${decEmoji} <b>${decision.decision}</b>${scoreStr}  —  confiance ${decision.confidence}/10\n`;
    if (decision.reasoning) msg += `<i>${this._esc(decision.reasoning)}</i>\n`;

    // Badge récidiviste
    const rec = token._recurring;
    if (rec?.isRecurring) {
      const dayStr  = rec.daysSinceLast < 1 ? "aujourd'hui" : `il y a ${rec.daysSinceLast}j`;
      const peakStr = rec.avgPeakPct != null ? `  |  📈 peak moy: <b>+${rec.avgPeakPct}%</b>` : '';
      msg += `\n🔄 <b>RÉCIDIVISTE</b> — vu <b>${rec.sightings}x</b>  |  ${dayStr}${peakStr}\n`;
    }

    // Sécurité condensée
    const sec = formatSecurity(debate.security, debate.overview);
    const rug = rugcheck.formatReport(debate.rugReport);
    const hasLp = debate.lpLock != null;

    if (sec || hasLp || rug) {
      msg += '\n';
      if (sec) {
        msg += `🔒 Mint: ${sec.mint}  |  Freeze: ${sec.freeze}`;
        if (sec.holders) msg += `  |  👥 ${sec.holders} holders`;
        msg += '\n';
      }
      const secLine2 = [];
      if (hasLp) {
        const pct = debate.lpLock.lpLockedPct;
        const usd = debate.lpLock.lpLockedUSD;
        const usdStr = usd >= 1000 ? `$${(usd/1000).toFixed(1)}K` : `$${usd.toFixed(0)}`;
        secLine2.push(`${pct >= 80 ? '🔐' : pct >= 50 ? '⚠️' : '🔓'} LP: ${pct.toFixed(0)}% (${usdStr})`);
      }
      if (rug) {
        secLine2.push(rug.rugged ? `🔴 <b>RUGPULL DÉTECTÉ</b>` : `${rug.scoreEmoji} RC: ${rug.score}/1000`);
      }
      if (secLine2.length > 0) msg += secLine2.join('  |  ') + '\n';
      if (rug?.dangers?.length > 0) msg += `  🔴 ${rug.dangers.map((d) => this._esc(d)).join(', ')}\n`;
    }

    if (decision.decision === 'BUY') {
      msg += `\n💸 Taille: ${decision.suggestedAmountPct}%  |  🛑 SL: -${decision.stopLossPct}%  |  🎯 TP: +${decision.takeProfitPct}%`;
    }

    return msg;
  }

  // ─── Commandes ────────────────────────────────────────────────────────────

  _setupCommands() {
    const { bot } = this;

    bot.command('start', async (ctx) => {
      await ctx.reply(
        `👋 Bonjour! Bienvenue sur <b>Meme Coin Bot</b>!\n\n` +
        `🤖 <b>Meme Coin Bot</b> — Actif!\n\n` +
        `<b>Commandes disponibles:</b>\n` +
        `/status — État du bot\n` +
        `/balance — Balance SOL\n` +
        `/pnl — Résumé PnL global\n` +
        `/scan — Scanner maintenant\n` +
        `/positions — Positions ouvertes\n` +
        `/history — Historique des trades\n` +
        `/auto — Toggle auto-trade\n` +
        `/settings — Voir les paramètres\n` +
        `/set &lt;clé&gt; &lt;valeur&gt; — Modifier un paramètre\n` +
        `/debat &lt;adresse&gt; — Suggérer un token → les agents débattent\n` +
        `/analyse &lt;adresse&gt; — Analyser un token\n` +
        `/buy &lt;adresse&gt; &lt;sol&gt; — Achat manuel\n` +
        `/sell &lt;adresse&gt; [%] — Vente manuelle\n` +
        `/addposition &lt;adresse&gt; &lt;sol&gt; — Importer une position externe\n` +
        `/recurring — Tokens récidivistes (boostés plusieurs fois)\n` +
        `/agent [message] — Parler avec ARIA (ton agent IA personnel)\n\n` +
        `/help — Aide détaillée de toutes les commandes`,
        { parse_mode: 'HTML' }
      );
    });

    bot.command('help', async (ctx) => {
      await ctx.reply(
        `📖 <b>Aide — Meme Coin Bot</b>\n\n` +

        `<b>Infos générales</b>\n` +
        `/start — Message de bienvenue\n` +
        `/help — Cette aide\n` +
        `/status — État du bot (scanner, positions, balance)\n` +
        `/balance — Balance SOL du wallet\n\n` +

        `<b>Trading</b>\n` +
        `/auto — Activer/désactiver le trading réel autonome d'ARIA\n` +
        `/scan — Lancer un scan manuel toutes sources\n` +
        `/recurring — Tokens récidivistes (boostés plusieurs fois)\n` +
        `/debat &lt;adresse&gt; — Suggérer un token au débat IA\n` +
        `  → Tu proposes un CA, Bull / Bear / Momentum / Whale débattent\n` +
        `/analyse &lt;adresse&gt; — Analyse complète d'un token\n` +
        `  → Débat IA (Bull / Bear / Risk Manager)\n` +
        `  → Sécurité on-chain (mint, freeze, holders)\n` +
        `/buy &lt;adresse&gt; &lt;sol&gt; — Achat manuel en SOL\n` +
        `/sell &lt;adresse&gt; [%] — Vente manuelle (défaut: 100%)\n` +
        `/addposition &lt;adresse&gt; &lt;sol&gt; — Importer une position achetée hors du bot\n\n` +

        `<b>Suivi</b>\n` +
        `/positions — Positions ouvertes + PnL non réalisé\n` +
        `/history — 10 derniers trades clôturés\n` +
        `/pnl — PnL réalisé + non réalisé global\n\n` +

        `<b>Paramètres</b>\n` +
        `/settings — Afficher les paramètres actuels\n` +
        `/set maxsol &lt;valeur&gt; — Mise max par trade en SOL\n` +
        `/set sl &lt;valeur&gt; — Stop-loss en % (défaut: 20)\n` +
        `/set tp &lt;valeur&gt; — Take-profit en % (défaut: 50)\n\n` +

        `<i>Trailing stop activé automatiquement après +20% de gain.</i>`,
        { parse_mode: 'HTML' }
      );
    });

    bot.command('status', async (ctx) => {
      const stats = this.scanner.getStats();
      const positions = this.trader.getPositions();
      const auto = personalAgent.getAutonomy();
      let balance = 'Wallet non chargé';
      if (this.trader.isReady()) {
        balance = `${(await this.trader.getSolBalance()).toFixed(4)} SOL`;
      }
      await ctx.reply(
        `📊 <b>Statut</b>\n\n` +
        `📡 Scanner: ${stats.isRunning ? '✅ Actif' : '❌ Arrêté'}\n` +
        `🔄 Scans: ${stats.scanCount}\n` +
        `👁 Tokens vus: ${stats.seenTokens}\n` +
        `📈 Sources: DexScreener top-boosted + GeckoTerminal trending\n` +
        `\n🤖 ARIA autonomie: ${auto.enabled ? '✅ Active' : '❌ Off'}\n` +
        `💸 Trading réel: ${auto.liveTrading ? '✅ Activé' : '❌ Désactivé (signaux + confirmation)'}\n` +
        `🎚 Seuil BUY auto: ${auto.minScore}/100  |  Max: ${auto.maxSolPerTrade} SOL/trade, ${auto.maxOpenPositions} positions\n` +
        `⛔ Stop journalier: -${auto.maxDailyLossSol} SOL\n` +
        `\n💼 Positions: ${positions.length}\n` +
        `💰 Balance: ${balance}`,
        { parse_mode: 'HTML' }
      );
    });

    bot.command('balance', async (ctx) => {
      if (!this.trader.isReady()) {
        return ctx.reply('❌ Wallet non configuré (WALLET_PRIVATE_KEY dans .env)', { parse_mode: 'HTML' });
      }
      const balance = await this.trader.getSolBalance();
      const addr = this.trader.walletAddress;
      await ctx.reply(
        `💰 <b>Balance</b>\n\n${balance.toFixed(6)} SOL\n<code>${addr}</code>`,
        { parse_mode: 'HTML' }
      );
    });

    bot.command('scan', async (ctx) => {
      await ctx.reply('🔍 Scan manuel lancé...');
      this.scanner.resetSeen();
      await this.scanner.scan();
      await ctx.reply('✅ Scan terminé.');
    });

    bot.command('positions', async (ctx) => {
      const positions = this.trader.getPositions();
      if (positions.length === 0) return ctx.reply('📭 Aucune position ouverte.');

      let msg = `📊 <b>Positions ouvertes (${positions.length})</b>\n\n`;
      for (const p of positions) {
        const shortMint = `<code>${p.tokenMint.slice(0, 12)}...</code>`;
        const age = Math.floor((Date.now() - p.entryTimestamp) / 60_000);
        msg += `• ${shortMint} — ${p.solSpent} SOL\n`;

        if (p.entryPriceUsd) {
          const currentPrice = await this.trader.getCurrentPrice(p.tokenMint);
          if (currentPrice) {
            const pnlPct = ((currentPrice - p.entryPriceUsd) / p.entryPriceUsd) * 100;
            const arrow = pnlPct >= 0 ? '🟢' : '🔴';
            msg += `  ${arrow} PnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%\n`;
          }
          msg += `  🛑 SL: -${p.stopLossPct}%  |  🎯 TP: +${p.takeProfitPct}%\n`;
        }

        msg += `  ⏱ ${age}min  |  <a href="https://solscan.io/tx/${p.buyTxId}">Tx</a>\n\n`;
      }
      await ctx.reply(msg, { parse_mode: 'HTML', disable_web_page_preview: true });
    });

    bot.command('history', async (ctx) => {
      const trades = this.trader.getHistory(10);
      if (trades.length === 0) return ctx.reply('📭 Aucun trade effectué.');

      let msg = `📜 <b>Derniers trades</b>\n\n`;
      for (const t of trades) {
        const emoji = t.action === 'BUY' ? '🟢' : '🔴';
        const date = new Date(t.entryTimestamp || t.timestamp).toLocaleString('fr-FR');
        msg += `${emoji} ${t.action} — ${date}\n`;
        msg += `<code>${t.tokenMint.slice(0, 16)}...</code>\n`;
        if (t.buyTxId || t.txId) {
          msg += `<a href="https://solscan.io/tx/${t.buyTxId || t.txId}">Tx</a>\n`;
        }
        msg += '\n';
      }
      await ctx.reply(msg, { parse_mode: 'HTML', disable_web_page_preview: true });
    });

    bot.command('pnl', async (ctx) => {
      const positions = this.trader.getPositions();
      const history = this.trader.getHistory(100);

      // PnL réalisé (trades SELL avec entryPriceUsd connu)
      let realizedSol = 0;
      const sellTrades = history.filter((t) => t.action === 'SELL' && t.pnlSol != null);
      for (const t of sellTrades) realizedSol += t.pnlSol;

      // PnL non réalisé (positions ouvertes)
      let unrealizedLines = '';
      let hasUnrealized = false;
      for (const p of positions) {
        if (!p.entryPriceUsd) continue;
        const currentPrice = await this.trader.getCurrentPrice(p.tokenMint);
        if (!currentPrice) continue;
        const pnlPct = ((currentPrice - p.entryPriceUsd) / p.entryPriceUsd) * 100;
        const pnlSol = p.solSpent * (pnlPct / 100);
        const arrow = pnlPct >= 0 ? '🟢' : '🔴';
        const shortMint = `<code>${p.tokenMint.slice(0, 12)}...</code>`;
        unrealizedLines += `${arrow} ${shortMint}: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% (${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL)\n`;
        hasUnrealized = true;
      }

      let msg = `📊 <b>PnL Global</b>\n\n`;
      msg += `✅ <b>Réalisé:</b> ${realizedSol >= 0 ? '+' : ''}${realizedSol.toFixed(4)} SOL`;
      msg += ` (${sellTrades.length} trades clôturés)\n\n`;
      if (hasUnrealized) {
        msg += `📈 <b>Non réalisé (positions ouvertes):</b>\n${unrealizedLines}`;
      } else {
        msg += `📭 Aucune position ouverte avec prix d'entrée.`;
      }

      await ctx.reply(msg, { parse_mode: 'HTML' });
    });

    bot.command('settings', async (ctx) => {
      const sl = parseFloat(process.env.DEFAULT_STOP_LOSS_PCT || '20');
      const tp = parseFloat(process.env.DEFAULT_TAKE_PROFIT_PCT || '50');
      const maxSol = this.maxPositionSol;

      const msg =
        `⚙️ <b>Paramètres actuels</b>\n\n` +
        `💰 Max position: <code>${maxSol} SOL</code>\n` +
        `🛑 Stop Loss par défaut: <code>${sl}%</code>\n` +
        `🎯 Take Profit par défaut: <code>${tp}%</code>\n\n` +
        `Pour modifier, utilise:\n` +
        `/set maxsol &lt;valeur&gt; — ex: /set maxsol 0.05\n` +
        `/set sl &lt;valeur&gt; — ex: /set sl 15\n` +
        `/set tp &lt;valeur&gt; — ex: /set tp 80`;

      await ctx.reply(msg, { parse_mode: 'HTML' });
    });

    bot.command('set', async (ctx) => {
      const parts = ctx.message.text.trim().split(/\s+/);
      if (parts.length < 3) {
        return ctx.reply('Usage: /set <maxsol|sl|tp> <valeur>\nEx: /set sl 15');
      }
      const [, key, rawVal] = parts;
      const val = parseFloat(rawVal);
      if (isNaN(val) || val <= 0) return ctx.reply('❌ Valeur invalide (doit être > 0).');

      switch (key.toLowerCase()) {
        case 'maxsol':
          this.maxPositionSol = val;
          personalAgent.setAutonomy({ maxSolPerTrade: val }); // synchronise le plafond ARIA
          await ctx.reply(`✅ Max position mis à jour: <b>${val} SOL</b> (plafond ARIA synchronisé)`, { parse_mode: 'HTML' });
          break;
        case 'sl':
          process.env.DEFAULT_STOP_LOSS_PCT = String(val);
          await ctx.reply(`✅ Stop Loss par défaut mis à jour: <b>${val}%</b>`, { parse_mode: 'HTML' });
          break;
        case 'tp':
          process.env.DEFAULT_TAKE_PROFIT_PCT = String(val);
          await ctx.reply(`✅ Take Profit par défaut mis à jour: <b>${val}%</b>`, { parse_mode: 'HTML' });
          break;
        default:
          await ctx.reply('❌ Clé inconnue. Utilise: maxsol, sl, ou tp');
      }
    });

    bot.command('auto', async (ctx) => {
      const cur  = personalAgent.getAutonomy();
      const next = personalAgent.setAutonomy({ liveTrading: !cur.liveTrading });
      await ctx.reply(
        next.liveTrading
          ? `🤖 Trading réel <b>ACTIVÉ</b>\n⚠️ ARIA achète et vend seule sur ton wallet.\n` +
            `Garde-fous : max ${next.maxSolPerTrade} SOL/trade, ${next.maxOpenPositions} positions, stop journalier -${next.maxDailyLossSol} SOL.`
          : `🤖 Trading réel <b>DÉSACTIVÉ</b>\nARIA continue de scanner et d'envoyer les signaux — tu confirmes chaque achat.`,
        { parse_mode: 'HTML' }
      );
    });

    // ─── /agent — Chat Telegram avec ARIA ────────────────────────────────────
    bot.command('agent', async (ctx) => {
      const parts = ctx.message.text.trim().split(/\s+(.+)/s);
      const msg   = parts[1]?.trim();

      if (!msg) {
        const s = personalAgent.getState();
        const a = s.autonomy;
        const moodEmoji = { focused: '🎯', excited: '🚀', cautious: '🛡️', concerned: '😟', satisfied: '😊' }[s.mood] || '🤖';
        return ctx.reply(
          `🤖 <b>${s.name}</b> ${moodEmoji}\n` +
          `Humeur: ${s.moodLabel}  |  Style: ${s.tradingStyle}\n` +
          `Confiance: ${s.confidence}/10  |  Risque: ${s.riskTolerance}/10\n\n` +
          `⚡ Autonomie: ${a.enabled ? '✅' : '❌'}  |  Trading réel: ${a.liveTrading ? '✅' : '❌'} (/auto)\n` +
          `🎚 Seuil BUY: ${a.minScore}/100  |  Max ${a.maxSolPerTrade} SOL/trade` +
          `${s.lessons.length > 0 ? `\n\n📚 <i>${this._esc(s.lessons[s.lessons.length-1])}</i>` : ''}\n\n` +
          `Pour parler avec moi: <code>/agent bonjour ARIA!</code>`,
          { parse_mode: 'HTML' }
        );
      }

      await ctx.reply('⏳');
      try {
        let balance = null, positions = null;
        if (this.trader.isReady()) {
          balance    = await this.trader.getSolBalance();
          positions  = this.trader.getPositions().length;
        }
        const reply = await personalAgent.chat(msg, { balance, positions });
        await ctx.reply(`🤖 <b>ARIA</b>\n${this._esc(reply)}`, { parse_mode: 'HTML' });
      } catch (err) {
        await ctx.reply(`❌ ${err.message}`);
      }
    });

    // Redirecte /analyse et /debat vers ARIA (single agent) + gardé runDebate en fallback
    // Handler partagé pour /analyse et /debat
    const analyseHandler = async (ctx) => {
      const parts = ctx.message.text.trim().split(/\s+/);
      const isDebat = parts[0] === '/debat';
      if (parts.length < 2) {
        return ctx.reply(`Usage: ${isDebat ? '/debat' : '/analyse'} <adresse_token>`);
      }

      const tokenAddress = parts[1];
      if (isDebat) {
        await ctx.reply('🤖 Suggestion reçue — les agents vont débattre sur ce token…');
      } else {
        await ctx.reply('🔍 Récupération des données...');
      }

      try {
        const pairs = await dex.getTokenPairs('solana', tokenAddress);
        if (!pairs || pairs.length === 0) {
          return ctx.reply('❌ Token introuvable sur DexScreener.');
        }
        const pair = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

        await ctx.reply(this._formatToken(pair), { parse_mode: 'HTML', disable_web_page_preview: true });
        await ctx.reply('🤖 Débat IA en cours…');

        const birdeye = require('./birdeye');
        const addr = pair.baseToken?.address;
        const [{ security, overview }, rugReport, lpLock] = await Promise.all([
          birdeye.getTokenData(addr),
          rugcheck.getTokenReport(addr),
          rugcheck.getLpLockData(addr),
        ]);
        const debate = await personalAgent.analyzeToken(pair, security, rugReport, overview, lpLock);
        await ctx.reply(this._formatDebate(debate), { parse_mode: 'HTML' });

        if (debate.decision.decision === 'BUY') {
          const a          = personalAgent.getAutonomy();
          const confFactor = Math.max(0.3, Math.min(1, (debate.decision.confidence || 5) / 10));
          const solAmt     = parseFloat((a.maxSolPerTrade * confFactor).toFixed(4));
          const sl     = debate.decision.stopLossPct  || 20;
          const tp     = debate.decision.takeProfitPct || 50;
          await ctx.reply(
            '💡 Action :',
            Markup.inlineKeyboard([
              Markup.button.callback(`✅ Acheter (${solAmt.toFixed(3)} SOL)`, `buy:${tokenAddress}:${solAmt.toFixed(4)}:${sl}:${tp}`),
              Markup.button.callback('❌ Passer', 'skip'),
            ])
          );
        }
      } catch (err) {
        await ctx.reply(`❌ Erreur: ${err.message}`);
      }
    };

    bot.command('analyse', analyseHandler);
    bot.command('debat',   analyseHandler);

    bot.command('buy', async (ctx) => {
      const parts = ctx.message.text.trim().split(/\s+/);
      if (parts.length < 3) return ctx.reply('Usage: /buy <adresse_token> <montant_sol>');

      const [, tokenAddress, solStr] = parts;
      const solAmount = parseFloat(solStr);
      if (isNaN(solAmount) || solAmount <= 0) return ctx.reply('❌ Montant invalide.');

      if (!this.trader.isReady()) return ctx.reply('❌ Wallet non configuré.');
      if (this._buyInFlight.has(tokenAddress)) return ctx.reply('⏳ Achat déjà en cours pour ce token.');

      this._buyInFlight.add(tokenAddress);
      await ctx.reply(`⏳ Achat de ${solAmount} SOL...`);
      try {
        const { txId } = await this.trader.buy(tokenAddress, solAmount);
        await ctx.reply(
          `✅ <b>Achat réussi!</b>\n<a href="https://solscan.io/tx/${txId}">Voir la tx</a>`,
          { parse_mode: 'HTML', disable_web_page_preview: true }
        );
      } catch (err) {
        await ctx.reply(`❌ ${err.message}`);
      } finally {
        this._buyInFlight.delete(tokenAddress);
      }
    });

    bot.command('addposition', async (ctx) => {
      const parts = ctx.message.text.trim().split(/\s+/);
      if (parts.length < 3) return ctx.reply('Usage: /addposition <adresse_token> <sol_dépensé>\nEx: /addposition ABC123... 0.5');

      const [, tokenAddress, solStr] = parts;
      const solSpent = parseFloat(solStr);
      if (isNaN(solSpent) || solSpent <= 0) return ctx.reply('❌ Montant SOL invalide.');

      if (!this.trader.isReady()) return ctx.reply('❌ Wallet non configuré.');

      await ctx.reply('⏳ Import de la position...');
      try {
        const { position } = await this.trader.importPosition(tokenAddress, solSpent);
        const priceStr = position.entryPriceUsd
          ? `$${position.entryPriceUsd.toFixed(6)}`
          : 'prix indisponible';
        await ctx.reply(
          `✅ <b>Position importée!</b>\n` +
          `📍 <code>${this._esc(tokenAddress)}</code>\n` +
          `💰 SOL dépensé: ${solSpent}\n` +
          `💵 Prix d'entrée: ${priceStr}\n` +
          `🛑 SL: -${position.stopLossPct}%  |  🎯 TP: +${position.takeProfitPct}%`,
          { parse_mode: 'HTML' }
        );
      } catch (err) {
        await ctx.reply(`❌ ${err.message}`);
      }
    });

    bot.command('recurring', async (ctx) => {
      const top = tokenHistory.getTopRecurring(10);
      const stats = tokenHistory.getStats();

      if (top.length === 0) {
        return ctx.reply(
          `🔄 <b>Tokens récidivistes</b>\n\n` +
          `📭 Aucun récidiviste détecté pour l'instant.\n\n` +
          `<i>Le bot surveille les tokens qui réapparaissent régulièrement sous le même ticker/nom (souvent avec une nouvelle adresse). Reviens après quelques cycles de scan.</i>`,
          { parse_mode: 'HTML' }
        );
      }

      let msg = `🔄 <b>Top tokens récidivistes</b>  <code>(${stats.total} suivis, ${stats.recurring} récidivistes)</code>\n\n`;
      for (const t of top) {
        const dayStr  = t.daysSinceLast < 1 ? "vu aujourd'hui" : `vu il y a ${t.daysSinceLast}j`;
        const addrNb  = t.addresses > 1 ? ` · ${t.addresses} adresses distinctes` : '';
        const peakStr = t.avgPeakPct != null ? `\n  📈 Peak moyen: <b>+${t.avgPeakPct}%</b>  (${t.totalCycles} cycle(s) clôturé(s))` : '';
        msg += `<b>$${this._esc(t.symbol)}</b>${t.name ? ` — ${this._esc(t.name)}` : ''}\n`;
        msg += `  🔁 <b>${t.sightings}x</b> boosté${addrNb}  ·  ${dayStr}${peakStr}\n`;
        if (t.lastAddress) msg += `  <code>${this._esc(t.lastAddress)}</code>\n`;
        msg += '\n';
      }

      await ctx.reply(msg.trim(), { parse_mode: 'HTML' });
    });

    bot.command('sell', async (ctx) => {
      const parts = ctx.message.text.trim().split(/\s+/);
      if (parts.length < 2) return ctx.reply('Usage: /sell <adresse_token> [pourcentage]');

      const [, tokenAddress, pctStr] = parts;
      const pct = pctStr ? parseInt(pctStr, 10) : 100;

      if (!this.trader.isReady()) return ctx.reply('❌ Wallet non configuré.');

      await ctx.reply(`⏳ Vente de ${pct}%...`);
      try {
        const { txId } = await this.trader.sell(tokenAddress, pct);
        await ctx.reply(
          `✅ <b>Vente réussie!</b>\n<a href="https://solscan.io/tx/${txId}">Voir la tx</a>`,
          { parse_mode: 'HTML', disable_web_page_preview: true }
        );
      } catch (err) {
        await ctx.reply(`❌ ${err.message}`);
      }
    });
  }

  // ─── Callbacks boutons inline ─────────────────────────────────────────────

  _setupCallbacks() {
    // Format: buy:<address>:<sol>[:<stopLossPct>:<takeProfitPct>]
    this.bot.action(/^buy:([^:]+):([^:]+)(?::(\d+):(\d+))?$/, async (ctx) => {
      await ctx.answerCbQuery('⏳ Achat en cours...');
      const [, tokenAddress, solStr, slStr, tpStr] = ctx.match;
      const solAmount = parseFloat(solStr);
      const stopLossPct = slStr ? parseInt(slStr, 10) : 20;
      const takeProfitPct = tpStr ? parseInt(tpStr, 10) : 50;

      if (!this.trader.isReady()) {
        return ctx.reply('❌ Wallet non configuré.');
      }
      if (this._buyInFlight.has(tokenAddress)) {
        return ctx.reply('⏳ Achat déjà en cours pour ce token.');
      }
      this._buyInFlight.add(tokenAddress);
      try {
        const { txId } = await this.trader.buy(tokenAddress, solAmount, { stopLossPct, takeProfitPct });
        await ctx.reply(
          `✅ <b>Achat réussi!</b> (${solAmount} SOL)\n🛑 SL: -${stopLossPct}%  |  🎯 TP: +${takeProfitPct}%\n<a href="https://solscan.io/tx/${txId}">Voir la tx</a>`,
          { parse_mode: 'HTML', disable_web_page_preview: true }
        );
      } catch (err) {
        await ctx.reply(`❌ ${err.message}`);
      } finally {
        this._buyInFlight.delete(tokenAddress);
      }
    });

    this.bot.action('skip', async (ctx) => {
      await ctx.answerCbQuery('Skippé.');
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    });
  }

  // ─── Événements du scanner ────────────────────────────────────────────────

  _listenToScanner() {
    this.scanner.on('debate', async (debate) => {
      if (!debate?.decision) return;
      try {
        this._hourlyAnalyzed++;

        // Log fichier
        logger.debate(
          debate.token?.baseToken?.symbol || '???',
          debate.token?.baseToken?.address || '',
          debate.decision?.score ?? null,
          debate.decision?.decision || 'SKIP'
        );

        // Enregistre dans l'historique du dashboard
        state.pushAnalysis({
          symbol:    debate.token?.baseToken?.symbol || '???',
          mint:      debate.token?.baseToken?.address || '',
          score:     debate.decision?.score ?? null,
          decision:  debate.decision?.decision || 'SKIP',
          timestamp: Date.now(),
        });

        // Journal + watchlist automatique d'ARIA (BUY et WATCH)
        personalAgent.onAnalysis(debate).catch(() => {});

        if (debate.decision.decision !== 'BUY') {
          this._hourlyRejected++;
          return; // Pas de notif Telegram pour les tokens refusés
        }

        // Tentative d'exécution autonome AVANT les notifications
        // (point d'entrée unique → pas de double achat)
        const auto = await personalAgent.maybeAutoTrade(debate);

        // Envoi du débat complet uniquement pour les BUY
        await this._send(this._formatDebate(debate), { parse_mode: 'HTML' });

        if (auto.executed) {
          await this._send(
            `🤖 <b>ARIA — ACHAT AUTONOME</b>\n${auto.solAmt} SOL investis\n<a href="https://solscan.io/tx/${auto.txId}">Voir la tx</a>`,
            { parse_mode: 'HTML', disable_web_page_preview: true }
          );
          return;
        }

        // Non exécuté → boutons de confirmation manuelle
        const a          = personalAgent.getAutonomy();
        const confFactor = Math.max(0.3, Math.min(1, (debate.decision.confidence || 5) / 10));
        const solAmt     = parseFloat((a.maxSolPerTrade * confFactor).toFixed(4));
        const sl = debate.decision.stopLossPct || 20;
        const tp = debate.decision.takeProfitPct || 50;
        const reasonLine = a.liveTrading && auto.reason
          ? `\n<i>ARIA n'a pas acheté seule : ${this._esc(auto.reason)}</i>`
          : '';
        await this.bot.telegram.sendMessage(
          this.adminId,
          `💡 Confirmer l'achat?${reasonLine}`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              Markup.button.callback(
                `✅ Acheter (${solAmt.toFixed(3)} SOL)`,
                `buy:${debate.token.baseToken?.address}:${solAmt.toFixed(4)}:${sl}:${tp}`
              ),
              Markup.button.callback('❌ Passer', 'skip'),
            ]),
          }
        );
      } catch (err) {
        console.error('[Bot] Erreur alerte débat:', err.message);
      }
    });
  }

  _startHourlySummary() {
    setInterval(async () => {
      const analyzed = this._hourlyAnalyzed;
      const rejected = this._hourlyRejected;
      const validated = analyzed - rejected;

      this._hourlyAnalyzed = 0;
      this._hourlyRejected = 0;

      if (analyzed === 0) return; // Rien à signaler

      try {
        await this._send(
          `📊 <b>Résumé horaire</b>\n\n` +
          `🔍 Tokens analysés: <b>${analyzed}</b>\n` +
          `✅ Validés (BUY): <b>${validated}</b>\n` +
          `❌ Refusés: <b>${rejected}</b>`,
          { parse_mode: 'HTML' }
        );
      } catch (err) {
        console.error('[Bot] Erreur résumé horaire:', err.message);
      }
    }, 60 * 60 * 1000); // toutes les heures
  }

  async _send(text, options = {}) {
    return this.bot.telegram.sendMessage(this.adminId, text, options);
  }

  // ─── Démarrage ────────────────────────────────────────────────────────────

  start() {
    this.bot.launch({ dropPendingUpdates: true });
    console.log('[Bot] Telegram bot démarré (polling).');

    // Démarre la surveillance SL/TP si le wallet est chargé
    if (this.trader.isReady()) {
      this.trader.startMonitor((msg) => this._send(msg, { parse_mode: 'HTML' }));
    }

    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }
}

module.exports = Bot;
