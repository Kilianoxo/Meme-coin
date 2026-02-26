/**
 * Client PumpPortal — WebSocket temps réel pour Pump.fun
 *
 * WebSocket gratuit, sans clé: wss://pumpportal.fun/api/data
 *
 * Événements émis:
 *   'newToken'   — Nouveau token créé sur la bonding curve (pas encore tradeable)
 *   'migration'  — Token gradué vers PumpSwap (maintenant tradeable via Jupiter)
 *
 * Format newToken: { mint, name, symbol, description, twitter, telegram, website,
 *                    creator, marketCapSol, vSolInBondingCurve, initialBuy }
 * Format migration: { mint, name, symbol, pool, txType: 'migrate' }
 */

const { EventEmitter } = require('events');

const WS_URL = 'wss://pumpportal.fun/api/data';
const RECONNECT_DELAY_MS = 5_000;

class PumpFunClient extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.isRunning = false;
    this._reconnectTimer = null;
    this.newTokenCount = 0;
    this.migrationCount = 0;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this._connect();
  }

  stop() {
    this.isRunning = false;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  _connect() {
    console.log('[PumpFun] Connexion à PumpPortal...');
    try {
      this.ws = new WebSocket(WS_URL);
    } catch (err) {
      console.error('[PumpFun] Impossible de créer le WebSocket:', err.message);
      this._scheduleReconnect();
      return;
    }

    this.ws.addEventListener('open', () => {
      console.log('[PumpFun] ✅ Connecté — écoute des nouveaux tokens et migrations');
      // Nouveaux tokens (bonding curve)
      this.ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      // Graduations vers PumpSwap
      this.ws.send(JSON.stringify({ method: 'subscribeMigration' }));
    });

    this.ws.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data);
        this._handleMessage(data);
      } catch {
        // Ignore les messages non-JSON (ex: ping/pong texte)
      }
    });

    this.ws.addEventListener('error', () => {
      console.error('[PumpFun] Erreur WebSocket — reconnexion...');
    });

    this.ws.addEventListener('close', () => {
      console.warn('[PumpFun] Déconnecté de PumpPortal.');
      if (this.isRunning) this._scheduleReconnect();
    });
  }

  _handleMessage(data) {
    if (!data || !data.mint) return;

    // Migration = graduation vers PumpSwap/Raydium
    if (data.txType === 'migrate' || data.pool) {
      this.migrationCount++;
      console.log(`[PumpFun] 🎓 Migration #${this.migrationCount}: ${data.symbol || data.mint.slice(0, 8)}`);
      this.emit('migration', data);
      return;
    }

    // Nouveau token créé sur la bonding curve
    if (data.name) {
      this.newTokenCount++;
      this.emit('newToken', data);
    }
  }

  _scheduleReconnect() {
    console.log(`[PumpFun] Reconnexion dans ${RECONNECT_DELAY_MS / 1000}s...`);
    this._reconnectTimer = setTimeout(() => {
      if (this.isRunning) this._connect();
    }, RECONNECT_DELAY_MS);
  }

  getStats() {
    const connected = this.ws?.readyState === 1; // WebSocket.OPEN = 1
    return {
      connected,
      newTokenCount: this.newTokenCount,
      migrationCount: this.migrationCount,
    };
  }
}

module.exports = new PumpFunClient();
