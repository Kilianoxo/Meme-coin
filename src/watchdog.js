/**
 * Watchdog — Surveillance du scanner et gestion des erreurs critiques
 *
 * Fonctions :
 *   - Vérifie toutes les 60s que le scanner progresse (scanCount augmente)
 *   - Si bloqué depuis > 3 min → redémarre le scanner + alerte Telegram
 *   - Capture uncaughtException + unhandledRejection → log fichier + alerte Telegram
 */

const logger = require('./logger');

const CHECK_INTERVAL_MS    = 60_000;      // vérification toutes les 60s
const STARTUP_GRACE_MS     = 2 * 60_000; // attente avant surveillance (cold start)
const SCAN_STALE_MS        = 3 * 60_000; // scanner bloqué si aucun scan depuis 3 min

class Watchdog {
  /**
   * @param {import('./scanner')} scanner
   * @param {(msg: string) => Promise<void>} sendAlert  — fonction async d'alerte Telegram
   */
  constructor(scanner, sendAlert) {
    this.scanner   = scanner;
    this.sendAlert = sendAlert;

    this._lastScanCount    = -1;
    this._lastScanChangeAt = Date.now();

    this._interval = null;
  }

  start() {
    // Période de grâce : le scanner fait son premier scan avant qu'on surveille
    setTimeout(() => {
      this._lastScanCount    = this.scanner.scanCount;
      this._lastScanChangeAt = Date.now();

      this._interval = setInterval(() => this._checkScanner(), CHECK_INTERVAL_MS);
      console.log('[Watchdog] 🐕 Surveillance active (scanner + erreurs critiques).');
    }, STARTUP_GRACE_MS);

    // Capture des erreurs non gérées au niveau du process
    process.on('uncaughtException',   (err)    => this._onFatal('uncaughtException', err));
    process.on('unhandledRejection',  (reason) => {
      const err = reason instanceof Error ? reason : new Error(String(reason));
      this._onFatal('unhandledRejection', err);
    });
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  // ── Scanner stall detection ───────────────────────────────────────────────

  async _checkScanner() {
    const now          = Date.now();
    const currentCount = this.scanner.scanCount;

    if (currentCount !== this._lastScanCount) {
      // Le scanner a progressé → tout va bien
      this._lastScanCount    = currentCount;
      this._lastScanChangeAt = now;
      return;
    }

    const staleMs = now - this._lastScanChangeAt;
    if (staleMs <= SCAN_STALE_MS) return;

    const staleMin = Math.round(staleMs / 60_000);
    console.warn(`[Watchdog] ⚠️ Scanner bloqué depuis ${staleMin} min — tentative de redémarrage...`);
    logger.error('watchdog', `Scanner bloqué depuis ${staleMin} min — redémarrage automatique`);

    try {
      this.scanner.stop();
      await new Promise((r) => setTimeout(r, 2_000));
      this.scanner.start();

      // Reset du timer pour ne pas retriggerer immédiatement
      this._lastScanCount    = this.scanner.scanCount;
      this._lastScanChangeAt = Date.now();

      await this._alert(
        `⚠️ <b>Watchdog</b>: Scanner bloqué (${staleMin} min sans scan)\n` +
        `✅ Redémarrage automatique effectué.`
      );
    } catch (err) {
      console.error('[Watchdog] Erreur lors du redémarrage scanner:', err.message);
      logger.error('watchdog', `Échec redémarrage scanner: ${err.message}`);
      await this._alert(
        `🔴 <b>Watchdog</b>: Échec du redémarrage scanner\n<code>${err.message}</code>`
      );
    }
  }

  // ── Erreurs non catchées ─────────────────────────────────────────────────

  async _onFatal(type, err) {
    const msg = err?.message || String(err);
    console.error(`[Watchdog] 💥 ${type}:`, err);
    logger.error(type, msg);

    await this._alert(
      `💥 <b>Erreur critique — ${type}</b>\n<code>${msg.slice(0, 400)}</code>`
    );
  }

  // ── Envoi d'alerte (sans planter si Telegram est mort) ───────────────────

  async _alert(text) {
    try {
      await this.sendAlert(text);
    } catch (err) {
      console.error('[Watchdog] Impossible d\'envoyer l\'alerte Telegram:', err.message);
    }
  }
}

module.exports = Watchdog;
