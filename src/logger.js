/**
 * Logger — écrit les événements clés dans logs/bot.log
 *
 * Format : une ligne JSON par événement
 * Rotation automatique à 5 MB → bot.log.1
 *
 * Événements loggués :
 *   debate   — décision IA (token, score, BUY/SKIP)
 *   trade    — BUY / SELL exécuté (txId, montant, PnL)
 *   sl_tp    — Stop-loss / Take-profit / Trailing déclenché
 *   error    — erreurs importantes
 *   startup  — démarrage du bot
 */

const fs   = require('fs');
const path = require('path');

const LOG_DIR  = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'bot.log');
const MAX_SIZE = 5 * 1024 * 1024; // 5 MB

function _rotate() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size >= MAX_SIZE) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    }
  } catch { /* fichier inexistant, pas grave */ }
}

function _write(type, data) {
  try {
    _rotate();
    const line = JSON.stringify({ ts: new Date().toISOString(), type, ...data }) + '\n';
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch (err) {
    // Ne jamais faire planter le bot à cause du logger
    console.error('[Logger] Erreur écriture:', err.message);
  }
}

module.exports = {
  /** Décision IA après débat */
  debate(symbol, mint, score, decision) {
    _write('debate', { symbol, mint, score, decision });
  },

  /** Trade BUY exécuté */
  buy(tokenMint, solAmount, txId, stopLossPct, takeProfitPct) {
    _write('trade', { action: 'BUY', tokenMint, solAmount, txId, stopLossPct, takeProfitPct });
  },

  /** Trade SELL exécuté */
  sell(tokenMint, pct, txId, pnlSol, reason) {
    _write('trade', { action: 'SELL', tokenMint, pct, txId, pnlSol, reason });
  },

  /** SL / TP / trailing déclenché */
  sltp(tokenMint, symbol, reason, pnlPct) {
    _write('sl_tp', { tokenMint, symbol, reason, pnlPct });
  },

  /** Erreur importante */
  error(context, message) {
    _write('error', { context, message });
  },

  /** Démarrage du bot */
  startup() {
    _write('startup', { msg: 'Bot démarré' });
  },
};
