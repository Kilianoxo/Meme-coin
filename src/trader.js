/**
 * Moteur de trading — Solana + Jupiter API v6
 *
 * Jupiter API (https://quote-api.jup.ag/v6) gère le routing optimal
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
const bs58 = require('bs58');

const JUPITER_URL = 'https://quote-api.jup.ag/v6';
const JUPITER_PRICE_URL = 'https://api.jup.ag/price/v2';
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

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Jupiter quote: HTTP ${res.status}`);
    return res.json();
  }

  /** Exécute un swap à partir d'un devis Jupiter */
  async executeSwap(quote) {
    if (!this.wallet) throw new Error('Wallet non chargé');

    // 1. Récupère la transaction sérialisée
    const swapRes = await fetch(`${JUPITER_URL}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: this.wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }),
    });
    if (!swapRes.ok) throw new Error(`Jupiter swap: HTTP ${swapRes.status}`);
    const { swapTransaction } = await swapRes.json();

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
      const res = await fetch(`${JUPITER_PRICE_URL}?ids=${mintAddress}`);
      if (!res.ok) return null;
      const json = await res.json();
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
      solSpent: solAmount,
      buyTxId: txId,
      entryTimestamp: Date.now(),
      outAmount: quote.outAmount,
      entryPriceUsd,
      stopLossPct,
      takeProfitPct,
      status: 'open',
    };
    this.positions.set(tokenMint, position);
    this.history.push({ action: 'BUY', ...position });

    console.log(`[Trader] ✅ Achat OK — tx: ${txId}`);
    return { txId, quote, position };
  }

  /**
   * Vend un pourcentage d'un token en SOL
   * @param {string} tokenMint
   * @param {number} pct        - Pourcentage à vendre (1-100)
   * @param {number} slippageBps
   */
  async sell(tokenMint, pct = 100, slippageBps = 300) {
    if (!this.wallet) throw new Error('Wallet non chargé');

    const balance = await this.getTokenBalance(tokenMint);
    if (balance === BigInt(0)) throw new Error('Balance token nulle');

    const amount = (balance * BigInt(pct)) / BigInt(100);
    console.log(`[Trader] Vente: ${pct}% de ${tokenMint}`);

    const quote = await this.getQuote(tokenMint, WSOL, amount.toString(), slippageBps);
    const txId = await this.executeSwap(quote);

    const trade = { action: 'SELL', tokenMint, pct, txId, timestamp: Date.now() };
    this.history.push(trade);

    if (pct === 100) {
      const pos = this.positions.get(tokenMint);
      if (pos) {
        pos.status = 'closed';
        pos.sellTxId = txId;
        pos.closeTimestamp = Date.now();
      }
      this.positions.delete(tokenMint);
    }

    console.log(`[Trader] ✅ Vente OK — tx: ${txId}`);
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

      const changePct = ((currentPrice - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;
      const shortMint = tokenMint.slice(0, 8) + '...';

      let reason = null;

      if (changePct <= -pos.stopLossPct) {
        reason = `🛑 *STOP LOSS* déclenché\n${shortMint}\nEntrée: $${pos.entryPriceUsd.toFixed(8)}\nActuel: $${currentPrice.toFixed(8)}\nPnL: ${changePct.toFixed(1)}%`;
      } else if (changePct >= pos.takeProfitPct) {
        reason = `🎯 *TAKE PROFIT* déclenché\n${shortMint}\nEntrée: $${pos.entryPriceUsd.toFixed(8)}\nActuel: $${currentPrice.toFixed(8)}\nPnL: +${changePct.toFixed(1)}%`;
      }

      if (reason) {
        try {
          console.log(`[Trader] ${reason.replace(/\*/g, '')}`);
          const { txId } = await this.sell(tokenMint, 100);
          if (notify) {
            notify(`${reason}\n[Voir la tx](https://solscan.io/tx/${txId})`);
          }
        } catch (err) {
          console.error(`[Trader] Erreur vente SL/TP (${shortMint}): ${err.message}`);
          if (notify) notify(`⚠️ Erreur vente SL/TP pour \`${shortMint}\`: ${err.message}`);
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
