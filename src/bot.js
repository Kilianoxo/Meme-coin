/**
 * Bot Telegram — Interface complète de contrôle
 *
 * Commandes:
 *   /start      — Bienvenue + liste des commandes
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

  _formatToken(pair) {
    const sym = pair.baseToken?.symbol || '???';
    const name = pair.baseToken?.name || '';
    const price = parseFloat(pair.priceUsd || 0);
    const ch24 = pair.priceChange?.h24 || 0;
    const vol24 = pair.volume?.h24 || 0;
    const liq = pair.liquidity?.usd || 0;
    const mc = pair.marketCap || pair.fdv || 0;
    const arrow = ch24 >= 0 ? '🟢' : '🔴';
    const pairUrl = pair.url || `https://dexscreener.com/solana/${pair.pairAddress}`;

    return (
      `*${sym}* (${name})\n` +
      `💰 Prix: $${price < 0.0001 ? price.toExponential(4) : price.toFixed(6)}\n` +
      `${arrow} 24h: ${ch24 >= 0 ? '+' : ''}${ch24.toFixed(2)}%\n` +
      `📊 Volume 24h: $${this._fmt(vol24)}\n` +
      `💧 Liquidité: $${this._fmt(liq)}\n` +
      `📈 Market Cap: $${this._fmt(mc)}\n` +
      `🔗 DEX: ${pair.dexId}\n` +
      `📍 \`${pair.baseToken?.address}\`\n` +
      `[Voir sur DexScreener](${pairUrl})`
    );
  }

  _formatDebate(debate) {
    const { bull, bear, decision, token } = debate;
    const sym = token.baseToken?.symbol || '???';
    const name = token.baseToken?.name || '';
    const price = parseFloat(token.priceUsd || 0);
    const ch24 = token.priceChange?.h24 || 0;
    const pairUrl = token.url || `https://dexscreener.com/solana/${token.pairAddress}`;
    const arrow = ch24 >= 0 ? '🟢' : '🔴';
    const decEmoji = { BUY: '🟢', SKIP: '🔴', WAIT: '🟡' }[decision.decision] || '⚪';

    let msg = `━━━━━━━━━━━━━━━━━━━\n`;
    if (debate.isGraduated) msg += `🎓 *TOKEN GRADUÉ — vient de quitter Pump.fun*\n`;
    msg += `🪙 *$${sym}* — ${name}\n`;
    msg += `💰 $${price < 0.0001 ? price.toExponential(2) : price.toFixed(6)}  ${arrow} ${ch24 >= 0 ? '+' : ''}${ch24.toFixed(1)}%\n`;
    msg += `[📊 Voir sur DexScreener](${pairUrl})\n`;
    msg += `━━━━━━━━━━━━━━━━━━━\n\n`;

    msg += `🐂 *Bull* — ${bull.score}/10\n`;
    (bull.arguments || []).slice(0, 3).forEach((a) => (msg += `  → ${a}\n`));

    msg += `\n🐻 *Bear* — ${bear.riskScore}/10  |  ${bear.verdict}\n`;
    (bear.redFlags || []).slice(0, 3).forEach((f) => (msg += `  ⚠️ ${f}\n`));

    // Données de sécurité Birdeye (si disponibles)
    const sec = formatSecurity(debate.security);
    if (sec) {
      msg += `\n🔒 *Sécurité on-chain*\n`;
      msg += `  Mint: ${sec.mint}  |  Freeze: ${sec.freeze}\n`;
      msg += `  Top 10 holders: ${sec.top10}  |  Créateur: ${sec.creator}\n`;
    }

    msg += `\n${decEmoji} *${decision.decision}*  —  confiance ${decision.confidence}/10\n`;
    if (decision.reasoning) msg += `_${decision.reasoning}_\n`;

    if (decision.decision === 'BUY') {
      msg += `\n💸 Taille: ${decision.suggestedAmountPct}%  |  🛑 SL: -${decision.stopLossPct}%  |  🎯 TP: +${decision.takeProfitPct}%`;
    }

    return msg;
  }

  /** Alerte légère pour un nouveau token sur la bonding curve Pump.fun */
  _formatPumpNew(token) {
    const sym = token.symbol || '???';
    const name = token.name || '';
    const mcSol = token.marketCapSol ? `~${parseFloat(token.marketCapSol).toFixed(1)} SOL` : '?';
    const initialBuy = token.initialBuy ? `${parseFloat(token.initialBuy).toFixed(2)} SOL` : null;
    const pumpUrl = `https://pump.fun/coin/${token.mint}`;

    const links = [];
    if (token.twitter) links.push(`[𝕏](${token.twitter})`);
    if (token.telegram) links.push(`[TG](${token.telegram})`);
    if (token.website) links.push(`[🌐](${token.website})`);

    let msg = `🆕 *$${sym}* — ${name}\n`;
    msg += `👶 Bonding curve Pump.fun\n`;
    msg += `💰 Market cap: ${mcSol}`;
    if (initialBuy) msg += `  |  🛒 Initial buy: ${initialBuy}`;
    msg += `\n`;
    if (links.length > 0) msg += `${links.join('  |  ')}\n`;
    msg += `📍 \`${token.mint}\`\n`;
    msg += `[🔗 Voir sur Pump.fun](${pumpUrl})`;

    return msg;
  }

  // ─── Commandes ────────────────────────────────────────────────────────────

  _setupCommands() {
    const { bot } = this;

    bot.command('start', async (ctx) => {
      await ctx.reply(
        `👋 Bonjour\\! Bienvenue sur *Meme Coin Bot*\\!\n\n` +
        `🤖 *Meme Coin Bot* — Actif\\!\n\n` +
        `*Commandes disponibles:*\n` +
        `/status — État du bot\n` +
        `/balance — Balance SOL\n` +
        `/scan — Scanner maintenant\n` +
        `/positions — Positions ouvertes\n` +
        `/history — Historique des trades\n` +
        `/auto — Toggle auto\\-trade\n` +
        `/analyse \\<adresse\\> — Analyser un token\n` +
        `/buy \\<adresse\\> \\<sol\\> — Achat manuel\n` +
        `/sell \\<adresse\\> \\[%\\] — Vente manuelle`,
        { parse_mode: 'MarkdownV2' }
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
        `📊 *Statut*\n\n` +
        `📡 Scanner: ${stats.isRunning ? '✅ Actif' : '❌ Arrêté'}\n` +
        `🔄 Scans DexScreener: ${stats.scanCount}\n` +
        `👁 Tokens vus: ${stats.seenTokens}\n` +
        `\n🐸 *Pump.fun* (PumpPortal WS)\n` +
        `   ${stats.pumpFunConnected ? '✅ Connecté' : '❌ Déconnecté'}\n` +
        `   Nouveaux tokens: ${stats.pumpNewTokens || 0}\n` +
        `   Graduations: ${stats.pumpMigrations || 0}\n` +
        `\n🤖 Auto\\-trade: ${this.autoTrade ? '✅ Activé' : '❌ Désactivé'}\n` +
        `💼 Positions: ${positions.length}\n` +
        `💰 Balance: ${balance}`,
        { parse_mode: 'MarkdownV2' }
      );
    });

    bot.command('balance', async (ctx) => {
      if (!this.trader.isReady()) {
        return ctx.reply('❌ Wallet non configuré (WALLET\\_PRIVATE\\_KEY dans .env)', { parse_mode: 'MarkdownV2' });
      }
      const balance = await this.trader.getSolBalance();
      const addr = this.trader.walletAddress;
      await ctx.reply(
        `💰 *Balance*\n\n${balance.toFixed(6)} SOL\n\`${addr}\``,
        { parse_mode: 'Markdown' }
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

      let msg = `📊 *Positions ouvertes (${positions.length})*\n\n`;
      for (const p of positions) {
        const shortMint = `\`${p.tokenMint.slice(0, 12)}...\``;
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

        msg += `  ⏱ ${age}min  |  [Tx](https://solscan.io/tx/${p.buyTxId})\n\n`;
      }
      await ctx.reply(msg, { parse_mode: 'Markdown' });
    });

    bot.command('history', async (ctx) => {
      const trades = this.trader.getHistory(10);
      if (trades.length === 0) return ctx.reply('📭 Aucun trade effectué.');

      let msg = `📜 *Derniers trades*\n\n`;
      for (const t of trades) {
        const emoji = t.action === 'BUY' ? '🟢' : '🔴';
        const date = new Date(t.entryTimestamp || t.timestamp).toLocaleString('fr-FR');
        msg += `${emoji} ${t.action} — ${date}\n`;
        msg += `\`${t.tokenMint.slice(0, 16)}...\`\n`;
        if (t.buyTxId || t.txId) {
          msg += `[Tx](https://solscan.io/tx/${t.buyTxId || t.txId})\n`;
        }
        msg += '\n';
      }
      await ctx.reply(msg, { parse_mode: 'Markdown' });
    });

    bot.command('auto', async (ctx) => {
      this.autoTrade = !this.autoTrade;
      await ctx.reply(
        this.autoTrade
          ? `🤖 Auto-trade *ACTIVÉ*\n⚠️ Le bot va exécuter les BUY automatiquement.`
          : `🤖 Auto-trade *DÉSACTIVÉ*\nLes trades devront être confirmés manuellement.`,
        { parse_mode: 'Markdown' }
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

        await ctx.reply(this._formatToken(pair), { parse_mode: 'Markdown', disable_web_page_preview: true });
        await ctx.reply('🤖 Débat IA en cours...');

        const debate = await runDebate(pair);
        await ctx.reply(this._formatDebate(debate), { parse_mode: 'Markdown' });

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
          `✅ *Achat réussi!*\n[Voir la tx](https://solscan.io/tx/${txId})`,
          { parse_mode: 'Markdown' }
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
          `✅ *Vente réussie!*\n[Voir la tx](https://solscan.io/tx/${txId})`,
          { parse_mode: 'Markdown' }
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
          `✅ *Achat réussi!* (${solAmount} SOL)\n🛑 SL: -${stopLossPct}%  |  🎯 TP: +${takeProfitPct}%\n[Voir la tx](https://solscan.io/tx/${txId})`,
          { parse_mode: 'Markdown' }
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
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        });
      } catch (err) {
        console.error('[Bot] Erreur alerte pumpNew:', err.message);
      }
    });

    this.scanner.on('debate', async (debate) => {
      try {
        await this._send(this._formatDebate(debate), { parse_mode: 'Markdown' });

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
                `🤖 *AUTO-TRADE EXÉCUTÉ*\nAchat: ${solAmt} SOL\n[Voir la tx](https://solscan.io/tx/${txId})`,
                { parse_mode: 'Markdown' }
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
      this.trader.startMonitor((msg) => this._send(msg, { parse_mode: 'Markdown' }));
    }

    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }
}

module.exports = Bot;
