/**
 * Moteur de trading — Solana + Jupiter API v6
 *
 * Jupiter API (https://lite-api.jup.ag/swap/v1) gère le routing optimal
 * entre tous les DEX Solana (Raydium, Orca, Meteora, etc.)
 */

const {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const { getAssociatedTokenAddress, getAccount } = require('@solana/spl-token');
const bs58        = require('bs58');
const fs          = require('fs');
const https       = require('https');
const path        = require('path');
const agentMemory   = require('./agentMemory');
const tokenHistory  = require('./tokenHistory');
const personalAgent = require('./personalAgent');
const logger        = require('./logger');

const PERSIST_FILE = path.join(__dirname, '..', 'data', 'positions.json');

// Clé API Jupiter optionnelle — obtenir gratuitement sur https://station.jup.ag
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || null;
const JUPITER_URL = 'https://lite-api.jup.ag/swap/v1';
const JUPITER_PRICE_URL = 'https://lite-api.jup.ag/price/v2';

/**
 * Requête HTTPS via le module natif Node.js (contourne undici/fetch).
 * @param {string} url
 * @param {{ method?: string, headers?: object, body?: string }} opts
 * @returns {Promise<any>} — JSON parsé
 */
function httpsRequest(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body   = opts.body || null;
    const reqOpts = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   opts.method || 'GET',
      headers:  {
        'Content-Type': 'application/json',
        ...(JUPITER_API_KEY ? { Authorization: `Bearer ${JUPITER_API_KEY}` } : {}),
        ...(opts.headers || {}),
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
      timeout: 15_000,
    };

    const req = https.request(reqOpts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode} — ${url}`));
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON invalide: ${e.message}`)); }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout Jupiter')); });
    if (body) req.write(body);
    req.end();
  });
}
const WSOL = 'So11111111111111111111111111111111111111112';
const MONITOR_INTERVAL_MS = 30_000; // vérifie les positions toutes les 30s

class Trader {
  constructor() {
    this.connection = new Connection(
      process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
      'confirmed'
    );
    this.wallet = null;
    this.positions = new Map(); // tokenAddress → position
    this.history = [];
    this._monitorTimer = null;
    this._load();
  }

  // ─── Persistance ──────────────────────────────────────────────────────────

  _load() {
    try {
      if (!fs.existsSync(PERSIST_FILE)) return;
      const raw = fs.readFileSync(PERSIST_FILE, 'utf8');
      const { positions, history } = JSON.parse(raw);
      if (Array.isArray(history)) this.history = history;
      if (Array.isArray(positions)) {
        for (const p of positions) this.positions.set(p.tokenMint, p);
      }
      console.log(`[Trader] Chargé: ${this.positions.size} position(s), ${this.history.length} trade(s) depuis le disque.`);
    } catch (err) {
      console.warn('[Trader] Impossible de charger positions.json:', err.message);
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(PERSIST_FILE), { recursive: true });
      const data = {
        positions: Array.from(this.positions.values()),
        history: this.history,
      };
      fs.writeFileSync(PERSIST_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      console.warn('[Trader] Impossible de sauvegarder positions.json:', err.message);
    }
  }

  // ─── Wallet ──────────────────────────────────────────────────────────────

  loadWallet(privateKeyBase58) {
    const secret = bs58.decode(privateKeyBase58);
    this.wallet = Keypair.fromSecretKey(secret);
    console.log(`[Trader] Wallet: ${this.wallet.publicKey.toBase58()}`);
    return this.wallet.publicKey.toBase58();
  }

  get walletAddress() {
    return this.wallet?.publicKey.toBase58() || null;
  }

  // ─── Balances ─────────────────────────────────────────────────────────────

  async getSolBalance() {
    if (!this.wallet) throw new Error('Wallet non chargé');
    const lamports = await this.connection.getBalance(this.wallet.publicKey);
    return lamports / LAMPORTS_PER_SOL;
  }

  /**
   * Retourne tous les tokens SPL non nuls du wallet (on-chain)
   * @returns {Promise<Array<{ mint, amount, decimals }>>}
   */
  async getWalletTokens() {
    if (!this.wallet) throw new Error('Wallet non chargé');
    const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const { value } = await this.connection.getParsedTokenAccountsByOwner(
      this.wallet.publicKey,
      { programId: TOKEN_PROGRAM }
    );
    return value
      .map(({ account }) => {
        const info = account.data.parsed?.info;
        return {
          mint:      info?.mint      || null,
          amount:    info?.tokenAmount?.uiAmount    || 0,
          decimals:  info?.tokenAmount?.decimals    || 0,
          rawAmount: info?.tokenAmount?.amount      || '0',
        };
      })
      .filter(t => t.mint && t.amount > 0);
  }

  async getTokenBalance(mintAddress) {
    if (!this.wallet) throw new Error('Wallet non chargé');
    try {
      const ata = await getAssociatedTokenAddress(
        new PublicKey(mintAddress),
        this.wallet.publicKey
      );
      const account = await getAccount(this.connection, ata);
      return BigInt(account.amount);
    } catch {
      return BigInt(0);
    }
  }

  // ─── Jupiter Quote & Swap ─────────────────────────────────────────────────

  /**
   * Obtient un devis Jupiter
   * @param {string} inputMint
   * @param {string} outputMint
   * @param {number} amountLamports  - En unités atomiques (lamports pour SOL)
   * @param {number} slippageBps     - Slippage en points de base (300 = 3%)
   */
  async getQuote(inputMint, outputMint, amountLamports, slippageBps = 300) {
    const url = new URL(`${JUPITER_URL}/quote`);
    url.searchParams.set('inputMint', inputMint);
    url.searchParams.set('outputMint', outputMint);
    url.searchParams.set('amount', amountLamports.toString());
    url.searchParams.set('slippageBps', slippageBps.toString());

    return httpsRequest(url.toString());
  }

  /** Exécute un swap à partir d'un devis Jupiter */
  async executeSwap(quote) {
    if (!this.wallet) throw new Error('Wallet non chargé');

    // 1. Récupère la transaction sérialisée
    const { swapTransaction } = await httpsRequest(`${JUPITER_URL}/swap`, {
      method: 'POST',
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: this.wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }),
    });

    // 2. Désérialise, signe et envoie
    const txBuffer = Buffer.from(swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(txBuffer);
    transaction.sign([this.wallet]);

    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
    const txId = await this.connection.sendTransaction(transaction, {
      skipPreflight: false,
      maxRetries: 3,
    });

    // 3. Attend la confirmation
    await this.connection.confirmTransaction(
      { signature: txId, blockhash, lastValidBlockHeight },
      'confirmed'
    );

    return txId;
  }

  // ─── Trading ──────────────────────────────────────────────────────────────

  // ─── Prix actuel ──────────────────────────────────────────────────────────

  /**
   * Prix actuel en USD via Jupiter Price API v2
   * @param {string} mintAddress
   * @returns {Promise<number|null>}
   */
  async getCurrentPrice(mintAddress) {
    try {
      const json = await httpsRequest(`${JUPITER_PRICE_URL}?ids=${mintAddress}`);
      const price = json?.data?.[mintAddress]?.price;
      return price ? parseFloat(price) : null;
    } catch {
      return null;
    }
  }

  // ─── Trading ──────────────────────────────────────────────────────────────

  /**
   * Achète un token avec des SOL
   * @param {string} tokenMint  - Adresse du token à acheter
   * @param {number} solAmount  - Montant en SOL
   * @param {Object} opts       - { slippageBps, stopLossPct, takeProfitPct }
   */
  async buy(tokenMint, solAmount, opts = {}) {
    const {
      slippageBps = 300,
      stopLossPct = parseFloat(process.env.DEFAULT_STOP_LOSS_PCT || '20'),
      takeProfitPct = parseFloat(process.env.DEFAULT_TAKE_PROFIT_PCT || '50'),
      symbol = null,
    } = opts;
    if (!this.wallet) throw new Error('Wallet non chargé');

    const balance = await this.getSolBalance();
    const needed = solAmount + 0.01; // 0.01 SOL pour les frais
    if (balance < needed) {
      throw new Error(`Balance insuffisante: ${balance.toFixed(4)} SOL (besoin: ${needed.toFixed(4)} SOL)`);
    }

    const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
    console.log(`[Trader] Achat: ${solAmount} SOL → ${tokenMint}`);

    // Prix d'entrée en USD (best effort — n'empêche pas le trade si indispo)
    const entryPriceUsd = await this.getCurrentPrice(tokenMint);

    const quote = await this.getQuote(WSOL, tokenMint, lamports, slippageBps);
    const txId = await this.executeSwap(quote);

    const position = {
      tokenMint,
      symbol,
      solSpent: solAmount,
      buyTxId: txId,
      entryTimestamp: Date.now(),
      outAmount: quote.outAmount,
      entryPriceUsd,
      stopLossPct,
      takeProfitPct,
      highPriceUsd: entryPriceUsd, // Pour le trailing stop-loss
      status: 'open',
    };
    this.positions.set(tokenMint, position);
    this.history.push({ action: 'BUY', ...position });
    this._save();

    console.log(`[Trader] ✅ Achat OK — tx: ${txId}`);
    logger.buy(tokenMint, solAmount, txId, stopLossPct, takeProfitPct);
    return { txId, quote, position };
  }

  /**
   * Importe une position achetée hors du bot (Phantom, etc.)
   * N'exécute aucun swap — enregistre simplement la position pour le suivi SL/TP.
   * @param {string} tokenMint
   * @param {number} solSpent        - Montant estimé dépensé en SOL
   * @param {Object} opts            - { stopLossPct, takeProfitPct, symbol }
   */
  async importPosition(tokenMint, solSpent, opts = {}) {
    const {
      stopLossPct  = parseFloat(process.env.DEFAULT_STOP_LOSS_PCT  || '20'),
      takeProfitPct = parseFloat(process.env.DEFAULT_TAKE_PROFIT_PCT || '50'),
      symbol = null,
    } = opts;

    const entryPriceUsd = await this.getCurrentPrice(tokenMint);

    const position = {
      tokenMint,
      symbol,
      solSpent,
      buyTxId: null,
      entryTimestamp: Date.now(),
      outAmount: null,
      entryPriceUsd,
      stopLossPct,
      takeProfitPct,
      highPriceUsd: entryPriceUsd,
      status: 'open',
      imported: true,
    };

    this.positions.set(tokenMint, position);
    this.history.push({ action: 'BUY', ...position });
    this._save();

    console.log(`[Trader] 📥 Position importée: ${tokenMint} (${solSpent} SOL estimé)`);
    return { position };
  }

  /**
   * Vend un pourcentage d'un token en SOL
   * @param {string} tokenMint
   * @param {number} pct        - Pourcentage à vendre (1-100)
   * @param {number} slippageBps
   * @param {string} exitReason - Raison de clôture pour la mémoire agents
   */
  async sell(tokenMint, pct = 100, slippageBps = 300, exitReason = 'MANUAL') {
    if (!this.wallet) throw new Error('Wallet non chargé');

    const balance = await this.getTokenBalance(tokenMint);
    if (balance === BigInt(0)) throw new Error('Balance token nulle');

    const amount = (balance * BigInt(pct)) / BigInt(100);
    console.log(`[Trader] Vente: ${pct}% de ${tokenMint}`);

    const quote = await this.getQuote(tokenMint, WSOL, amount.toString(), slippageBps);
    const txId = await this.executeSwap(quote);

    const pos = this.positions.get(tokenMint);
    const solReceived = parseFloat(quote.outAmount) / LAMPORTS_PER_SOL;
    const pnlSol = pos ? solReceived - pos.solSpent : null;
    const trade = { action: 'SELL', tokenMint, pct, txId, timestamp: Date.now(), pnlSol };
    this.history.push(trade);

    if (pct === 100) {
      if (pos) {
        pos.status = 'closed';
        pos.sellTxId = txId;
        pos.closeTimestamp = Date.now();
      }
      this.positions.delete(tokenMint);

      // Enregistre l'outcome + fait évoluer la personnalité d'ARIA
      if (pos && pnlSol != null) {
        const pnlPct  = (pnlSol / pos.solSpent) * 100;
        const outcome = pnlPct >= 0 ? 'WIN' : 'LOSS';
        agentMemory.recordOutcome(tokenMint, pnlPct, exitReason);
        tokenHistory.recordCycleEnd(pos.symbol || '', tokenMint, pnlPct, outcome);
        personalAgent.evolvePersonality(outcome, pnlPct);
      }
    }
    this._save();

    console.log(`[Trader] ✅ Vente OK — tx: ${txId}`);
    logger.sell(tokenMint, pct, txId, pnlSol, exitReason);
    return { txId, quote };
  }

  // ─── Moniteur Stop Loss / Take Profit ────────────────────────────────────

  /**
   * Démarre la surveillance automatique SL/TP
   * @param {Function} notify - callback(message: string) pour alerter sur Telegram
   */
  startMonitor(notify) {
    if (this._monitorTimer) return; // déjà actif

    this._monitorTimer = setInterval(async () => {
      if (this.positions.size === 0) return;
      await this._checkPositions(notify);
    }, MONITOR_INTERVAL_MS);

    console.log('[Trader] Moniteur SL/TP démarré (intervalle: 30s)');
  }

  stopMonitor() {
    if (this._monitorTimer) {
      clearInterval(this._monitorTimer);
      this._monitorTimer = null;
    }
  }

  async _checkPositions(notify) {
    for (const [tokenMint, pos] of this.positions) {
      if (!pos.entryPriceUsd) continue; // pas de prix d'entrée → skip

      const currentPrice = await this.getCurrentPrice(tokenMint);
      if (!currentPrice) continue;

      // Trailing stop-loss : met à jour le prix le plus haut atteint
      if (currentPrice > (pos.highPriceUsd || pos.entryPriceUsd)) {
        pos.highPriceUsd = currentPrice;
        this._save();
      }

      const changePct = ((currentPrice - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;
      // Trailing SL : recul depuis le plus haut
      const dropFromHigh = pos.highPriceUsd
        ? ((pos.highPriceUsd - currentPrice) / pos.highPriceUsd) * 100
        : 0;
      const shortMint = tokenMint.slice(0, 8) + '...';

      let reason = null;
      let exitReason = null;

      // Trailing stop-loss activé seulement si le prix a monté > 20% depuis l'entrée
      const gainFromEntry = ((pos.highPriceUsd || pos.entryPriceUsd) - pos.entryPriceUsd) / pos.entryPriceUsd * 100;
      if (gainFromEntry >= 20 && dropFromHigh >= pos.stopLossPct) {
        reason     = `📉 <b>TRAILING STOP</b> déclenché\n${shortMint}\nHaut: $${pos.highPriceUsd.toFixed(8)}\nActuel: $${currentPrice.toFixed(8)}\nRecul: -${dropFromHigh.toFixed(1)}%  |  PnL global: ${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}%`;
        exitReason = 'TRAILING_STOP';
      } else if (changePct <= -pos.stopLossPct) {
        reason     = `🛑 <b>STOP LOSS</b> déclenché\n${shortMint}\nEntrée: $${pos.entryPriceUsd.toFixed(8)}\nActuel: $${currentPrice.toFixed(8)}\nPnL: ${changePct.toFixed(1)}%`;
        exitReason = 'STOP_LOSS';
      } else if (changePct >= pos.takeProfitPct) {
        reason     = `🎯 <b>TAKE PROFIT</b> déclenché\n${shortMint}\nEntrée: $${pos.entryPriceUsd.toFixed(8)}\nActuel: $${currentPrice.toFixed(8)}\nPnL: +${changePct.toFixed(1)}%`;
        exitReason = 'TAKE_PROFIT';
      }

      if (reason) {
        try {
          console.log(`[Trader] ${reason.replace(/<[^>]+>/g, '')}`);
          logger.sltp(tokenMint, pos.symbol || shortMint, exitReason, changePct);
          const { txId } = await this.sell(tokenMint, 100, 300, exitReason);
          if (notify) {
            notify(`${reason}\n<a href="https://solscan.io/tx/${txId}">Voir la tx</a>`);
          }
        } catch (err) {
          console.error(`[Trader] Erreur vente SL/TP (${shortMint}): ${err.message}`);
          if (notify) notify(`⚠️ Erreur vente SL/TP pour <code>${shortMint}</code>: ${err.message}`);
        }
      }
    }
  }

  // ─── État ─────────────────────────────────────────────────────────────────

  getPositions() {
    return Array.from(this.positions.values());
  }

  getHistory(limit = 20) {
    return this.history.slice(-limit);
  }

  isReady() {
    return this.wallet !== null;
  }
}

module.exports = Trader;
