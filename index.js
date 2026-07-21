require('dotenv').config();

const Trader        = require('./src/trader');
const Scanner       = require('./src/scanner');
const Bot           = require('./src/bot');
const Dashboard     = require('./src/dashboard');
const Watchdog      = require('./src/watchdog');
const PaperTrader   = require('./src/paperTrader');
const personalAgent = require('./src/personalAgent');
const agios         = require('./src/agios');
const logger        = require('./src/logger');

// Vérifications de base au démarrage
const required = ['TELEGRAM_TOKEN', 'TELEGRAM_ADMIN_ID', 'ANTHROPIC_API_KEY'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`❌ Variables d'environnement manquantes: ${missing.join(', ')}`);
  console.error('   Copie .env.example en .env et remplis les valeurs.');
  process.exit(1);
}

async function main() {
  logger.startup();
  console.log('🚀 Démarrage Meme Coin Bot...');

  const trader = new Trader();

  if (process.env.WALLET_PRIVATE_KEY) {
    try {
      trader.loadWallet(process.env.WALLET_PRIVATE_KEY);
    } catch (err) {
      console.error(`[Main] ❌ Erreur wallet: ${err.message}`);
      console.error('[Main] Le bot démarre sans wallet — trading désactivé.');
    }
  } else {
    console.warn('[Main] ⚠️  WALLET_PRIVATE_KEY non défini — trading désactivé, alertes seules.');
  }

  const scanner     = new Scanner();
  const paperTrader = new PaperTrader();
  const bot         = new Bot(trader, scanner);

  // ─── AGIOS — agent Robinhood Chain (paper trading + signaux) ─────────────
  const agiosPaper = new PaperTrader({ file: 'agios_paper.json', label: 'Agios:Paper', chain: 'robinhood' });
  agios.setPaperTrader(agiosPaper);
  const agiosScanner = new Scanner({
    chain:    'robinhood',
    label:    'Agios:Scan',
    analyzer: (...args) => agios.analyzeToken(...args),
  });
  agiosScanner.on('debate', (debate) => {
    agios.onDebate(debate).catch((err) => console.error('[Agios] Erreur onDebate:', err.message));
  });
  agiosPaper.on('buy',  (pos) => agios.logAction('BUY',  `Paper BUY $${pos.symbol} @ MC $${((pos.entryMcap || 0) / 1000).toFixed(0)}K — ${pos.amountSolIn.toFixed(3)} unités (score ${pos.score ?? '?'})`, { symbol: pos.symbol, address: pos.address }));
  agiosPaper.on('sell', (rec) => agios.logAction('SELL', `Paper SELL $${rec.symbol} — ${rec.reason} — PnL ${rec.pnlSol >= 0 ? '+' : ''}${rec.pnlSol.toFixed(4)} (${rec.pnlPct.toFixed(1)}%)`, { symbol: rec.symbol, address: rec.address }));

  bot.start();
  scanner.start();
  agiosScanner.start();
  new Dashboard(trader, paperTrader, { agios, agiosPaper }).start();

  // Branche les résultats de débat vers le paper trader
  scanner.on('debate', (debate) => {
    paperTrader.onDebateResult(debate).catch((err) =>
      console.error('[PaperTrader] Erreur onDebateResult:', err.message)
    );
  });

  const watchdog = new Watchdog(scanner, (msg) => bot._send(msg, { parse_mode: 'HTML' }));
  watchdog.start();

  // ARIA — donne accès au trader pour la surveillance autonome puis démarre le heartbeat
  personalAgent.setTrader(trader);
  personalAgent.startHeartbeat();

  console.log('✅ Bot opérationnel.');
}

main().catch((err) => {
  console.error('💥 Erreur fatale:', err);
  process.exit(1);
});
