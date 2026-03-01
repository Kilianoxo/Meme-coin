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
const dex = require('./dexscreener');
const { runDebate } = require('./agents');
const { formatSecurity } = require('./birdeye');
const rugcheck = require('./rugcheck');

class Bot {
  constructor(trader, scanner) {
    this.bot = new Telegraf(process.env.TELEGRAM_TOKEN);
    this.trader = trader;
    this.scanner = scanner;
    this.adminId = parseInt(process.env.TELEGRAM_ADMIN_ID, 10);
    this.autoTrade = false;
    this.maxPositionSol = parseFloat(process.env.MAX_POSITION_SOL || '0.1');

    this._setupMiddleware();
    this._setupCommands();
    this._setupCallbacks();
    this._listenToScanner();
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

  _formatDebate(debate) {
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

  /** Alerte légère pour un nouveau token sur la bonding curve Pump.fun */
  _formatPumpNew(token) {
    const sym = this._esc(token.symbol || '???');
    const name = this._esc(token.name || '');
    const mcSol = token.marketCapSol ? `~${parseFloat(token.marketCapSol).toFixed(1)} SOL` : '?';
    const initialBuy = token.initialBuy ? `${parseFloat(token.initialBuy).toFixed(2)} SOL` : null;
    const pumpUrl = `https://pump.fun/coin/${token.mint}`;

    const links = [];
    if (token.twitter) links.push(`<a href="${token.twitter}">𝕏</a>`);
    if (token.telegram) links.push(`<a href="${token.telegram}">TG</a>`);
    if (token.website) links.push(`<a href="${token.website}">🌐</a>`);

    let msg = `🆕 <b>$${sym}</b> — ${name}\n`;
    msg += `👶 Bonding curve Pump.fun\n`;
    msg += `💰 Market cap: ${mcSol}`;
    if (initialBuy) msg += `  |  🛒 Initial buy: ${initialBuy}`;
    msg += `\n`;
    if (links.length > 0) msg += `${links.join('  |  ')}\n`;
    msg += `📍 <code>${this._esc(token.mint)}</code>\n`;
    msg += `<a href="${pumpUrl}">🔗 Voir sur Pump.fun</a>`;

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
        `/analyse &lt;adresse&gt; — Analyser un token\n` +
        `/buy &lt;adresse&gt; &lt;sol&gt; — Achat manuel\n` +
        `/sell &lt;adresse&gt; [%] — Vente manuelle\n\n` +
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
        `/auto — Activer/désactiver le trading automatique\n` +
        `/scan — Lancer un scan manuel toutes sources\n` +
        `/analyse &lt;adresse&gt; — Analyse complète d'un token\n` +
        `  → Débat IA (Bull / Bear / Risk Manager)\n` +
        `  → Sécurité on-chain (mint, freeze, holders)\n` +
        `/buy &lt;adresse&gt; &lt;sol&gt; — Achat manuel en SOL\n` +
        `/sell &lt;adresse&gt; [%] — Vente manuelle (défaut: 100%)\n\n` +

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
      let balance = 'Wallet non chargé';
      if (this.trader.isReady()) {
        balance = `${(await this.trader.getSolBalance()).toFixed(4)} SOL`;
      }
      await ctx.reply(
        `📊 <b>Statut</b>\n\n` +
        `📡 Scanner: ${stats.isRunning ? '✅ Actif' : '❌ Arrêté'}\n` +
        `🔄 Scans DexScreener: ${stats.scanCount}\n` +
        `👁 Tokens vus: ${stats.seenTokens}\n` +
        `\n🐸 <b>Pump.fun</b> (PumpPortal WS)\n` +
        `   ${stats.pumpFunConnected ? '✅ Connecté' : '❌ Déconnecté'}\n` +
        `   Nouveaux tokens: ${stats.pumpNewTokens || 0}\n` +
        `   Graduations: ${stats.pumpMigrations || 0}\n` +
        `\n🤖 Auto-trade: ${this.autoTrade ? '✅ Activé' : '❌ Désactivé'}\n` +
        `💼 Positions: ${positions.length}\n` +
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
        const shortMint = `\`${p.tokenMint.slice(0, 12)}...\``;
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
          await ctx.reply(`✅ Max position mis à jour: <b>${val} SOL</b>`, { parse_mode: 'HTML' });
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
      this.autoTrade = !this.autoTrade;
      await ctx.reply(
        this.autoTrade
          ? `🤖 Auto-trade <b>ACTIVÉ</b>\n⚠️ Le bot va exécuter les BUY automatiquement.`
          : `🤖 Auto-trade <b>DÉSACTIVÉ</b>\nLes trades devront être confirmés manuellement.`,
        { parse_mode: 'HTML' }
      );
    });

    bot.command('analyse', async (ctx) => {
      const parts = ctx.message.text.trim().split(/\s+/);
      if (parts.length < 2) return ctx.reply('Usage: /analyse <adresse_token>');

      const tokenAddress = parts[1];
      const msg = await ctx.reply('🔍 Récupération des données...');

      try {
        const pairs = await dex.getTokenPairs('solana', tokenAddress);
        if (!pairs || pairs.length === 0) {
          return ctx.reply('❌ Token introuvable sur DexScreener.');
        }
        const pair = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

        await ctx.reply(this._formatToken(pair), { parse_mode: 'HTML', disable_web_page_preview: true });
        await ctx.reply('🤖 Débat IA en cours...');

        const birdeye = require('./birdeye');
        const addr = pair.baseToken?.address;
        const [{ security, overview }, rugReport, lpLock] = await Promise.all([
          birdeye.getTokenData(addr),
          rugcheck.getTokenReport(addr),
          rugcheck.getLpLockData(addr),
        ]);
        const debate = await runDebate(pair, security, rugReport, overview, lpLock);
        await ctx.reply(this._formatDebate(debate), { parse_mode: 'HTML' });

        if (debate.decision.decision === 'BUY') {
          const solAmt = this.maxPositionSol * (debate.decision.suggestedAmountPct || 3) / 100;
          await ctx.reply(
            '💡 Action:',
            Markup.inlineKeyboard([
              Markup.button.callback(`✅ Acheter (${solAmt.toFixed(3)} SOL)`, `buy:${tokenAddress}:${solAmt.toFixed(4)}`),
              Markup.button.callback('❌ Passer', 'skip'),
            ])
          );
        }
      } catch (err) {
        await ctx.reply(`❌ Erreur: ${err.message}`);
      }
    });

    bot.command('buy', async (ctx) => {
      const parts = ctx.message.text.trim().split(/\s+/);
      if (parts.length < 3) return ctx.reply('Usage: /buy <adresse_token> <montant_sol>');

      const [, tokenAddress, solStr] = parts;
      const solAmount = parseFloat(solStr);
      if (isNaN(solAmount) || solAmount <= 0) return ctx.reply('❌ Montant invalide.');

      if (!this.trader.isReady()) return ctx.reply('❌ Wallet non configuré.');

      await ctx.reply(`⏳ Achat de ${solAmount} SOL...`);
      try {
        const { txId } = await this.trader.buy(tokenAddress, solAmount);
        await ctx.reply(
          `✅ <b>Achat réussi!</b>\n<a href="https://solscan.io/tx/${txId}">Voir la tx</a>`,
          { parse_mode: 'HTML', disable_web_page_preview: true }
        );
      } catch (err) {
        await ctx.reply(`❌ ${err.message}`);
      }
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
      try {
        const { txId } = await this.trader.buy(tokenAddress, solAmount, { stopLossPct, takeProfitPct });
        await ctx.reply(
          `✅ <b>Achat réussi!</b> (${solAmount} SOL)\n🛑 SL: -${stopLossPct}%  |  🎯 TP: +${takeProfitPct}%\n<a href="https://solscan.io/tx/${txId}">Voir la tx</a>`,
          { parse_mode: 'HTML', disable_web_page_preview: true }
        );
      } catch (err) {
        await ctx.reply(`❌ ${err.message}`);
      }
    });

    this.bot.action('skip', async (ctx) => {
      await ctx.answerCbQuery('Skippé.');
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    });
  }

  // ─── Événements du scanner ────────────────────────────────────────────────

  _listenToScanner() {
    // Nouveaux tokens sur la bonding curve (seulement si liens sociaux présents)
    this.scanner.on('pumpNew', async (token) => {
      const hasSocials = token.twitter || token.telegram || token.website;
      if (!hasSocials) return; // Filtre les tokens sans présence sociale

      try {
        await this._send(this._formatPumpNew(token), {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
      } catch (err) {
        console.error('[Bot] Erreur alerte pumpNew:', err.message);
      }
    });

    this.scanner.on('debate', async (debate) => {
      try {
        await this._send(this._formatDebate(debate), { parse_mode: 'HTML' });

        if (debate.decision.decision === 'BUY') {
          const solAmt = this.maxPositionSol * (debate.decision.suggestedAmountPct || 3) / 100;

          if (this.autoTrade && this.trader.isReady()) {
            try {
              const { txId } = await this.trader.buy(
                debate.token.baseToken?.address,
                solAmt,
                {
                  stopLossPct: debate.decision.stopLossPct,
                  takeProfitPct: debate.decision.takeProfitPct,
                }
              );
              await this._send(
                `🤖 <b>AUTO-TRADE EXÉCUTÉ</b>\nAchat: ${solAmt} SOL\n<a href="https://solscan.io/tx/${txId}">Voir la tx</a>`,
                { parse_mode: 'HTML', disable_web_page_preview: true }
              );
            } catch (err) {
              await this._send(`❌ Auto-trade échoué: ${err.message}`);
            }
          } else {
            const sl = debate.decision.stopLossPct || 20;
            const tp = debate.decision.takeProfitPct || 50;
            await this.bot.telegram.sendMessage(
              this.adminId,
              '💡 Confirmer l\'achat?',
              Markup.inlineKeyboard([
                Markup.button.callback(
                  `✅ Acheter (${solAmt.toFixed(3)} SOL)`,
                  `buy:${debate.token.baseToken?.address}:${solAmt.toFixed(4)}:${sl}:${tp}`
                ),
                Markup.button.callback('❌ Passer', 'skip'),
              ])
            );
          }
        }
      } catch (err) {
        console.error('[Bot] Erreur alerte débat:', err.message);
      }
    });
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
