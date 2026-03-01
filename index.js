require('dotenv').config();

const Trader      = require('./src/trader');
const Scanner     = require('./src/scanner');
const Bot         = require('./src/bot');
const Dashboard   = require('./src/dashboard');
const Watchdog    = require('./src/watchdog');
const PaperTrader = require('./src/paperTrader');
const logger      = require('./src/logger');

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

  bot.start();
  scanner.start();
  new Dashboard(trader, paperTrader).start();

  // Branche les résultats de débat vers le paper trader
  scanner.on('debate', (debate) => {
    paperTrader.onDebateResult(debate).catch((err) =>
      console.error('[PaperTrader] Erreur onDebateResult:', err.message)
    );
  });

  const watchdog = new Watchdog(scanner, (msg) => bot._send(msg, { parse_mode: 'HTML' }));
  watchdog.start();

  console.log('✅ Bot opérationnel.');
}

main().catch((err) => {
  console.error('💥 Erreur fatale:', err);
  process.exit(1);
});
