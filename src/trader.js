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
const bs58        = require('bs58');
const fs          = require('fs');
const https       = require('https');
const path        = require('path');
const gmgn          = require('./gmgn');
const prices        = require('./prices');
const agentMemory   = require('./agentMemory');
const tokenHistory  = require('./tokenHistory');
const personalAgent = require('./personalAgent');
const logger        = require('./logger');

const PERSIST_FILE = path.join(__dirname, '..', 'data', 'positions.json');

// Clé API Jupiter optionnelle — obtenir gratuitement sur https://station.jup.ag
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || null;
const JUPITER_URL = 'https://lite-api.jup.ag/swap/v1';

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
// Mints à ne jamais auto-importer comme positions (SOL wrappé + stablecoins)
const NON_TRADE_MINTS = new Set([
  WSOL,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);
// Valeur minimum (USD) pour auto-importer un token acheté hors bot (filtre dust/airdrops)
const AUTO_IMPORT_MIN_USD = parseFloat(process.env.AUTO_IMPORT_MIN_USD || '10');
// Fréquence de surveillance SL/TP — les meme coins bougent vite, un stop vérifié
// toutes les 30s pouvait finir 15 points sous son seuil
const MONITOR_INTERVAL_MS = Math.max(3, parseFloat(process.env.POSITION_CHECK_SECONDS || '10')) * 1000;
// Sortie multi-étapes (% de la position INITIALE) :
//   palier 1 (+TP%)   → vend TP_SELL_STAGE1 (30%)
//   palier 2 (+2×TP%) → vend TP_SELL_STAGE2 (30%)
//   le reste (~40%) court en trailing, protégé par un break-even stop.
// TP_SELL_STAGE1=100 → vente totale au TP (ancien comportement).
const TP_SELL_STAGE1 = Math.max(10, Math.min(100, parseFloat(process.env.TP_SELL_STAGE1 || process.env.PARTIAL_TP_PCT || '30')));
const TP_SELL_STAGE2 = Math.max(0,  Math.min(90,  parseFloat(process.env.TP_SELL_STAGE2 || '30')));

class Trader {
  constructor() {
    this.connection = new Connection(
      process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
      'confirmed'
    );
    this.wallet = null;
    this.positions = new Map(); // tokenAddress → position
    this.history = [];
    // Achats envoyés mais pas encore enregistrés (mint → { solAmount, entry, ts, … }) :
    // si la confirmation échoue ou si le process redémarre en plein swap, la position
    // retrouvée dans le wallet est rattachée à son achat (et à sa session) au lieu d'être
    // importée comme un achat manuel hors budget.
    this.pendingBuys = {};
    this._monitorTimer = null;
    this._load();
  }

  // ─── Persistance ──────────────────────────────────────────────────────────

  _load() {
    try {
      if (!fs.existsSync(PERSIST_FILE)) return;
      const raw = fs.readFileSync(PERSIST_FILE, 'utf8');
      const { positions, history, pendingBuys } = JSON.parse(raw);
      if (Array.isArray(history)) this.history = history;
      if (pendingBuys && typeof pendingBuys === 'object') this.pendingBuys = pendingBuys;
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
        pendingBuys: this.pendingBuys,
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
    // SPL classique + Token-2022 (utilisé par une partie des meme coins récents)
    const programs = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
    const results = await Promise.all(programs.map(id =>
      this.connection.getParsedTokenAccountsByOwner(this.wallet.publicKey, { programId: new PublicKey(id) })));
    const value = results.flatMap(r => r.value);
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

  /**
   * Solde brut d'un token (tous comptes, SPL classique ET Token-2022).
   * Renvoie 0n seulement si le wallet ne détient vraiment aucun compte pour ce mint ;
   * une erreur RPC est RELANCÉE — sinon une panne réseau ferait croire que le token
   * a été vendu et la position serait clôturée à tort.
   */
  async getTokenBalance(mintAddress) {
    if (!this.wallet) throw new Error('Wallet non chargé');
    const { value } = await this.connection.getParsedTokenAccountsByOwner(
      this.wallet.publicKey,
      { mint: new PublicKey(mintAddress) }
    );
    return value.reduce((sum, { account }) =>
      sum + BigInt(account.data.parsed?.info?.tokenAmount?.amount || '0'), BigInt(0));
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

    // 3. Attend la confirmation. Une erreur ici (RPC saturé, délai perçu comme expiré)
    // ne veut pas dire que le swap a échoué : on interroge le statut réel avant de conclure.
    try {
      await this.connection.confirmTransaction(
        { signature: txId, blockhash, lastValidBlockHeight },
        'confirmed'
      );
    } catch (err) {
      if (!(await this._landed(txId))) throw err;
      console.warn(`[Trader] Confirmation en erreur (${err.message}) mais tx ${txId} bien exécutée`);
    }

    return txId;
  }

  /** true si la transaction est exécutée sans erreur (quelques essais espacés) */
  async _landed(txId, tries = 4) {
    for (let i = 0; i < tries; i++) {
      try {
        const { value } = await this.connection.getSignatureStatuses([txId], { searchTransactionHistory: true });
        const st = value?.[0];
        if (st) {
          if (st.err) return false;
          if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return true;
        }
      } catch { /* RPC KO : on réessaie */ }
      if (i < tries - 1) await new Promise(r => setTimeout(r, 2_000 * (i + 1)));
    }
    return false;
  }

  /**
   * Variation RÉELLE du solde SOL du wallet causée par une transaction (frais réseau,
   * frais de priorité, rent du compte de token et slippage compris), en SOL.
   * Négative pour un achat, positive pour une vente. null si la tx est introuvable.
   */
  async _txSolDelta(txId) {
    for (let i = 0; i < 3; i++) {
      try {
        const tx = await this.connection.getTransaction(txId, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
        const pre = tx?.meta?.preBalances?.[0], post = tx?.meta?.postBalances?.[0];
        if (typeof pre === 'number' && typeof post === 'number') return (post - pre) / LAMPORTS_PER_SOL;
      } catch { /* réessai */ }
      await new Promise(r => setTimeout(r, 1_500 * (i + 1)));
    }
    return null;
  }

  /**
   * Coût / produit réel d'un swap : la variation de solde mesurée si elle est plausible,
   * sinon le montant du devis (une variation aberrante viendrait d'un autre mouvement).
   */
  async _realSol(txId, expected, side) {
    const delta = await this._txSolDelta(txId);
    if (delta == null) return expected;
    const v = side === 'buy' ? -delta : delta;
    const plausible = side === 'buy'
      ? v >= expected * 0.95 && v <= expected * 1.2 + 0.01
      : v >= 0 && v <= expected * 1.1 + 0.001;
    return plausible ? parseFloat(v.toFixed(9)) : expected;
  }

  /** Valeur estimée (SOL) d'une fraction d'une position, au dernier prix connu (0 si inconnu) */
  _estimatedValueSol(pos, fraction) {
    const cost = (pos.solSpent || 0) * fraction;
    if (!pos.lastPriceUsd || !pos.entryPriceUsd) return 0;
    return cost * (pos.lastPriceUsd / pos.entryPriceUsd);
  }

  /**
   * Le wallet détient moins de tokens que la position suivie (vente partielle à la main
   * sur GMGN) : on retire la part vendue du coût de la position et on l'enregistre comme
   * vente externe, avec un PnL ESTIMÉ au dernier prix connu (les stats l'ignorent, le
   * budget de session l'utilise). Sans cela, la prochaine vente du bot imputerait tout le
   * coût au reste et afficherait une fausse perte.
   */
  _absorbExternalReduction(pos, balance) {
    if (!pos?.outAmount || balance == null) return;
    let tracked;
    try { tracked = BigInt(pos.outAmount); } catch { return; }
    if (tracked <= 0n || balance >= (tracked * 98n) / 100n) return;
    const frac = 1 - Number((balance * 1_000_000n) / tracked) / 1_000_000;
    const cost = (pos.solSpent || 0) * frac;
    const est  = this._estimatedValueSol(pos, frac) - cost;
    this.history.push({
      action: 'SELL', tokenMint: pos.tokenMint, symbol: pos.symbol || null, positionId: pos.positionId || null,
      entrySignals: pos.entry?.signals || null, pct: Math.round(frac * 100), txId: null, timestamp: Date.now(),
      pnlSol: null, estPnlSol: parseFloat(est.toFixed(9)), costSol: parseFloat(cost.toFixed(9)),
      exitReason: 'EXTERNAL_SELL', external: true, partial: true,
    });
    pos.solSpent  = parseFloat(((pos.solSpent || 0) - cost).toFixed(9));
    pos.outAmount = balance.toString();
    console.log(`[Trader] 🔀 ${pos.symbol || pos.tokenMint.slice(0, 8)} : ${Math.round(frac * 100)}% vendus hors du bot — coût de la position réduit`);
  }

  // ─── Trading ──────────────────────────────────────────────────────────────

  // ─── Prix actuel ──────────────────────────────────────────────────────────

  /** Prix actuel en USD (Jupiter Price v3, fallback GMGN si Jupiter ne connaît pas le token) */
  async getCurrentPrice(mintAddress) {
    return (await this._pricesFor([mintAddress]))[mintAddress] ?? null;
  }

  /** Prix groupés : un seul appel Jupiter pour tous les mints, GMGN pour les manquants */
  /**
   * Prix groupés, du plus fiable au plus coûteux — sans jamais bloquer la surveillance :
   *  1. Jupiter Price v3 (un appel pour tous les mints)
   *  2. prix du classement GMGN déjà en mémoire (aucun appel réseau)
   *  3. GMGN token info, en parallèle et borné à 3 s (la file GMGN peut être pleine ou en pause)
   *  4. devis de vente Jupiter pour les positions détenues (indépendant de GMGN)
   */
  async _pricesFor(mints) {
    const out = await prices.getPrices(mints);
    for (const m of mints) {
      if (out[m] != null) continue;
      const row = gmgn.findTrendingRow(m);
      const p = row ? parseFloat(row.priceUsd) : 0;
      if (p > 0) out[m] = p;
    }
    let missing = mints.filter(m => out[m] == null).slice(0, 5);
    if (missing.length > 0 && !gmgn.rateStatus().banned && await gmgn.isAvailable()) {
      const timeout = new Promise(r => setTimeout(() => r(null), 3_000));
      const got = await Promise.all(missing.map(m => Promise.race([gmgn.getTokenPrice(m).catch(() => null), timeout])));
      missing.forEach((m, i) => { if (got[i]) out[m] = got[i]; });
    }
    missing = mints.filter(m => out[m] == null && this.positions.has(m)).slice(0, 3);
    for (const m of missing) {
      const p = await this._quotePriceUsd(m).catch(() => null);
      if (p) out[m] = p;
    }
    return out;
  }

  /** Décimales d'un mint (cache permanent — elles ne changent jamais) */
  async _decimals(mint) {
    this._decCache = this._decCache || new Map();
    if (this._decCache.has(mint)) return this._decCache.get(mint);
    const info = await this.connection.getParsedAccountInfo(new PublicKey(mint));
    const dec = info?.value?.data?.parsed?.info?.decimals;
    if (typeof dec !== 'number') throw new Error('décimales introuvables');
    this._decCache.set(mint, dec);
    return dec;
  }

  /**
   * Prix USD d'un token détenu, déduit d'un devis de vente Jupiter (token → SOL).
   * Dernier recours quand ni Jupiter Price ni GMGN ne donnent de prix ; c'est
   * même la meilleure mesure de ce qu'une vente rapporterait. Cache 30 s par mint.
   */
  async _quotePriceUsd(mint) {
    this._quoteCache = this._quoteCache || new Map();
    const c = this._quoteCache.get(mint);
    if (c && Date.now() - c.ts < 30_000) return c.price;
    const [dec, raw, solUsd] = await Promise.all([this._decimals(mint), this.getTokenBalance(mint), prices.getPrice(WSOL)]);
    if (!solUsd || raw === BigInt(0)) return null;
    const quote = await this.getQuote(mint, WSOL, raw.toString(), 500);
    const solOut = parseFloat(quote?.outAmount || 0) / LAMPORTS_PER_SOL;
    const tokens = Number(raw) / 10 ** dec;
    const price = solOut > 0 && tokens > 0 ? (solOut * solUsd) / tokens : null;
    this._quoteCache.set(mint, { ts: Date.now(), price });
    return price;
  }

  /** Prix d'entrée déduit du swap exécuté (si aucune source de prix n'a répondu avant l'achat) */
  async _entryPriceFromQuote(tokenMint, solAmount, quote) {
    try {
      const [dec, solUsd] = await Promise.all([this._decimals(tokenMint), prices.getPrice(WSOL)]);
      const tokens = Number(quote?.outAmount || 0) / 10 ** dec;
      return solUsd && tokens > 0 ? (solAmount * solUsd) / tokens : null;
    } catch {
      return null;
    }
  }

  /**
   * Market cap + supply estimée à l'entrée (via GMGN, best effort).
   * Le MC est l'unité de mesure des meme coins — le prix unitaire ne parle pas.
   * supply = mcap/prix GMGN → permet de recalculer le MC live: supply × prix actuel.
   */
  async _fetchEntryMcap(tokenMint, entryPriceUsd) {
    try {
      const row = gmgn.findTrendingRow(tokenMint);
      let mcap     = row ? (row.marketCap || 0) : 0;
      let priceRef = row ? parseFloat(row.priceUsd || 0) : 0;
      if (!mcap && await gmgn.isAvailable()) {
        const info = await gmgn.getTokenInfo(tokenMint);
        if (info) { mcap = info.marketCap || 0; priceRef = info.priceUsd || 0; }
      }
      if (!mcap) return { entryMcapUsd: null, tokenSupply: null };
      const supply = priceRef > 0 ? mcap / priceRef : null;
      const entryMcapUsd = supply && entryPriceUsd ? supply * entryPriceUsd : mcap;
      return { entryMcapUsd: Math.round(entryMcapUsd), tokenSupply: supply };
    } catch {
      return { entryMcapUsd: null, tokenSupply: null };
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
      entry = { signals: ['manuel'] }, // pourquoi on achète — sert aux stats par signal
      guard = null, // () => string|null : appelé juste avant le swap, un message annule l'achat
    } = opts;
    if (!this.wallet) throw new Error('Wallet non chargé');

    // Une position existe déjà sur ce token : on la renforce (coût cumulé, prix moyen) si
    // elle appartient au même budget, sinon on refuse — l'écraser ferait disparaître son
    // coût de la comptabilité (budget de session regonflé, faux PnL à la vente).
    const existing = this.positions.get(tokenMint);
    if (existing && (existing.entry?.sessionId || null) !== (entry?.sessionId || null)) {
      throw new Error(existing.entry?.sessionId
        ? 'Position déjà ouverte sur ce token par une session — vends-la ou attends sa clôture'
        : 'Position déjà ouverte sur ce token hors session — la session ne peut pas la renforcer');
    }

    const balance = await this.getSolBalance();
    const needed = solAmount + 0.01; // 0.01 SOL pour les frais
    if (balance < needed) {
      throw new Error(`Balance insuffisante: ${balance.toFixed(4)} SOL (besoin: ${needed.toFixed(4)} SOL)`);
    }

    const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
    console.log(`[Trader] Achat: ${solAmount} SOL → ${tokenMint}`);

    // Prix d'entrée en USD (best effort — n'empêche pas le trade si indispo)
    let entryPriceUsd = await this.getCurrentPrice(tokenMint);

    const quote = await this.getQuote(WSOL, tokenMint, lamports, slippageBps);
    const veto = guard ? guard() : null;
    if (veto) throw new Error(veto);
    this.pendingBuys[tokenMint] = { solAmount, entry, symbol, stopLossPct, takeProfitPct, ts: Date.now() };
    this._save();
    let txId;
    try {
      txId = await this.executeSwap(quote);
    } catch (err) {
      // Échec certain (tx rejetée ou jamais exécutée) : plus rien en attente.
      // L'entrée est gardée si l'envoi a pu partir sans réponse — syncWallet tranchera.
      if (!/timeout|expired|block height|fetch failed|ECONN|socket/i.test(err.message)) {
        delete this.pendingBuys[tokenMint];
        this._save();
      }
      throw err;
    }
    // Coût réel (frais, rent du compte de token, slippage compris)
    const spent = await this._realSol(txId, solAmount, 'buy');
    // Sans prix avant l'achat (Jupiter muet, GMGN en pause), le stop-loss serait inactif :
    // on reconstitue le prix d'entrée à partir du swap réellement exécuté
    if (!entryPriceUsd) entryPriceUsd = await this._entryPriceFromQuote(tokenMint, solAmount, quote);
    delete this.pendingBuys[tokenMint];

    const current = this.positions.get(tokenMint);
    if (current && (current.entry?.sessionId || null) === (entry?.sessionId || null)) {
      // Renforcement : coût cumulé, quantité cumulée, prix d'entrée moyen pondéré
      const oldTokens = current.outAmount ? BigInt(current.outAmount) : null;
      if (current.entryPriceUsd && entryPriceUsd) {
        current.entryPriceUsd = (current.solSpent + spent) / (current.solSpent / current.entryPriceUsd + spent / entryPriceUsd);
        current.highPriceUsd  = Math.max(current.highPriceUsd || 0, current.entryPriceUsd);
      }
      current.solSpent  = parseFloat((current.solSpent + spent).toFixed(9));
      current.outAmount = oldTokens != null ? (oldTokens + BigInt(quote.outAmount)).toString() : null;
      this.history.push({
        action: 'BUY_ADD', positionId: current.positionId, tokenMint, symbol: current.symbol,
        entry: current.entry, solSpent: spent, buyTxId: txId, timestamp: Date.now(),
      });
      this._save();
      console.log(`[Trader] ✅ Renforcement OK — tx: ${txId}`);
      logger.buy(tokenMint, solAmount, txId, current.stopLossPct, current.takeProfitPct);
      return { txId, quote, position: current, added: true };
    }

    const { entryMcapUsd, tokenSupply } = await this._fetchEntryMcap(tokenMint, entryPriceUsd);

    const position = {
      positionId: `${tokenMint.slice(0, 6)}-${Date.now()}`,
      tokenMint,
      symbol,
      entry,
      solSpent: spent,
      buyTxId: txId,
      entryTimestamp: Date.now(),
      outAmount: quote.outAmount,
      entryPriceUsd,
      entryMcapUsd,
      tokenSupply,
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
      entry = { signals: ['import'] },
      outAmount = null,
    } = opts;
    if (this.positions.has(tokenMint)) throw new Error('Ce token est déjà suivi');

    const entryPriceUsd = await this.getCurrentPrice(tokenMint);
    const { entryMcapUsd, tokenSupply } = await this._fetchEntryMcap(tokenMint, entryPriceUsd);

    const position = {
      positionId: `${tokenMint.slice(0, 6)}-${Date.now()}`,
      tokenMint,
      symbol,
      entry,
      solSpent,
      buyTxId: null,
      entryTimestamp: Date.now(),
      outAmount,
      entryPriceUsd,
      entryMcapUsd,
      tokenSupply,
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
    this._absorbExternalReduction(this.positions.get(tokenMint), balance);

    const amount = (balance * BigInt(pct)) / BigInt(100);
    console.log(`[Trader] Vente: ${pct}% de ${tokenMint}`);

    const quote = await this.getQuote(tokenMint, WSOL, amount.toString(), slippageBps);
    const txId = await this.executeSwap(quote);

    const pos = this.positions.get(tokenMint);
    // Produit RÉEL (slippage et frais déduits), pas le montant promis par le devis
    const solReceived = await this._realSol(txId, parseFloat(quote.outAmount) / LAMPORTS_PER_SOL, 'sell');
    // PnL comparé au coût de la fraction vendue (et pas au coût total —
    // sinon une vente partielle affiche une fausse perte)
    const costBasis = pos ? pos.solSpent * (pct / 100) : null;
    const pnlSol    = costBasis != null ? solReceived - costBasis : null;
    const trade = {
      action: 'SELL', tokenMint, symbol: pos?.symbol || null, positionId: pos?.positionId || null,
      entrySignals: pos?.entry?.signals || null, pct, txId, timestamp: Date.now(), pnlSol, exitReason,
    };
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
    } else if (pos && costBasis != null) {
      // Vente partielle : réduit le coût restant de la position
      pos.solSpent = parseFloat((pos.solSpent - costBasis).toFixed(9));
      if (pos.outAmount) { try { pos.outAmount = (BigInt(pos.outAmount) - amount).toString(); } catch { /* ancien format */ } }
    }
    this._save();

    console.log(`[Trader] ✅ Vente OK — tx: ${txId}`);
    logger.sell(tokenMint, pct, txId, pnlSol, exitReason);
    return { txId, quote };
  }

  /**
   * Réconcilie les positions trackées avec la RÉALITÉ on-chain du wallet.
   * Le propriétaire trade aussi manuellement sur GMGN → une position vendue
   * hors du bot reste "ouverte" dans positions.json alors que le wallet ne
   * détient plus le token. Ici : balance on-chain nulle → clôture sans swap
   * (exitReason EXTERNAL_SELL, PnL inconnu → null, n'altère pas les stats).
   *
   * @returns {Promise<{ closed: Array, kept: Array }>}
   */
  async reconcilePositions() {
    if (!this.wallet) throw new Error('Wallet non chargé');

    const closed = [];
    const kept   = [];

    for (const [tokenMint, pos] of [...this.positions]) {
      let balance;
      try {
        balance = await this.getTokenBalance(tokenMint);
      } catch {
        kept.push({ tokenMint, symbol: pos.symbol, onChain: null }); // RPC KO → on ne touche pas
        continue;
      }

      if (balance === BigInt(0)) {
        pos.status         = 'closed';
        pos.closeTimestamp = Date.now();
        this.positions.delete(tokenMint);
        // PnL réel inconnu (vente hors bot) : les stats l'ignorent (pnlSol null), mais le
        // budget de session reçoit une ESTIMATION au dernier prix connu — perte totale si
        // aucun prix — pour ne jamais recréditer le coût entier comme si rien n'était perdu
        this.history.push({
          action: 'SELL', tokenMint, symbol: pos.symbol || null, positionId: pos.positionId || null,
          entrySignals: pos.entry?.signals || null, pct: 100, txId: null,
          timestamp: Date.now(), pnlSol: null,
          estPnlSol: parseFloat((this._estimatedValueSol(pos, 1) - (pos.solSpent || 0)).toFixed(9)),
          costSol: pos.solSpent || 0,
          exitReason: 'EXTERNAL_SELL', external: true,
        });
        closed.push({ tokenMint, symbol: pos.symbol || tokenMint.slice(0, 6), solSpent: pos.solSpent });
        console.log(`[Trader] 🔀 Position ${pos.symbol || tokenMint.slice(0, 8)} clôturée — vendue hors du bot (balance on-chain nulle)`);
      } else {
        const before = pos.solSpent;
        this._absorbExternalReduction(pos, balance);
        if (pos.solSpent !== before) closed.push({ tokenMint, symbol: pos.symbol || tokenMint.slice(0, 6), solSpent: before - pos.solSpent, partial: true });
        kept.push({ tokenMint, symbol: pos.symbol, onChain: balance.toString() });
      }
    }

    if (closed.length > 0) this._save();
    return { closed, kept };
  }

  /**
   * Synchronisation COMPLÈTE wallet ↔ tracking (bidirectionnelle) :
   *  1. reconcilePositions() — clôture les positions vendues à la main (balance nulle)
   *  2. auto-import — les tokens achetés à la main sur GMGN (présents on-chain
   *     mais non trackés, valeur ≥ AUTO_IMPORT_MIN_USD) deviennent des positions
   *     suivies (SL/TP/monitoring de fuite). Entrée = prix actuel, coût estimé
   *     en SOL à la valeur du moment (le vrai coût d'achat est inconnu).
   *
   * @returns {Promise<{ closed: Array, kept: Array, imported: Array }>}
   */
  async syncWallet() {
    const { closed, kept } = await this.reconcilePositions();
    const imported = [];

    try {
      const tokens    = await this.getWalletTokens();
      // Achats dont le swap est passé sans être enregistré (confirmation en erreur, redémarrage) :
      // rattachés à leur achat d'origine (signaux, session) avec le coût envoyé
      for (const [mint, pb] of Object.entries(this.pendingBuys)) {
        const held = tokens.find(t => t.mint === mint);
        if (held && !this.positions.has(mint)) {
          const { position } = await this.importPosition(mint, pb.solAmount, {
            symbol: pb.symbol, stopLossPct: pb.stopLossPct, takeProfitPct: pb.takeProfitPct,
            entry: { ...(pb.entry || {}), recovered: true },
          });
          imported.push({ tokenMint: mint, symbol: position.symbol || mint.slice(0, 6), solSpent: pb.solAmount, recovered: true });
          console.log(`[Trader] ♻️ Achat retrouvé dans le wallet et rattaché à son origine : ${position.symbol || mint.slice(0, 8)}`);
          delete this.pendingBuys[mint];
        } else if (!held && Date.now() - pb.ts > 10 * 60_000) {
          delete this.pendingBuys[mint]; // jamais arrivé : le swap a échoué
        }
      }
      this._save();
      const untracked = tokens
        .filter(t => !this.positions.has(t.mint) && !NON_TRADE_MINTS.has(t.mint))
        .slice(0, 10); // borne les appels prix
      if (untracked.length === 0) return { closed, kept, imported };

      const solPrice = await this.getCurrentPrice(WSOL);
      for (const t of untracked) {
        const price = await this.getCurrentPrice(t.mint);
        if (!price) continue; // Jupiter ne connaît pas → probable dust/airdrop
        const valueUsd = price * t.amount;
        if (valueUsd < AUTO_IMPORT_MIN_USD) continue;

        const solSpent = solPrice ? parseFloat((valueUsd / solPrice).toFixed(4)) : 0;
        // Symbole via GMGN (best effort)
        let symbol = null;
        try {
          const row  = gmgn.findTrendingRow(t.mint);
          symbol = row?.baseToken?.symbol
            || (await gmgn.isAvailable() ? (await gmgn.getTokenInfo(t.mint))?.symbol : null)
            || null;
          if (symbol === '???') symbol = null;
        } catch { /* silencieux */ }

        const { position } = await this.importPosition(t.mint, solSpent, { symbol });
        imported.push({
          tokenMint: t.mint,
          symbol:    position.symbol || t.mint.slice(0, 6),
          valueUsd:  Math.round(valueUsd),
          solSpent,
        });
        console.log(`[Trader] 📥 Token acheté hors bot auto-importé: ${position.symbol || t.mint.slice(0, 8)} (~$${Math.round(valueUsd)})`);
      }
    } catch (err) {
      console.warn('[Trader] syncWallet import:', err.message);
    }

    return { closed, kept, imported };
  }

  // ─── Moniteur Stop Loss / Take Profit ────────────────────────────────────

  /**
   * Démarre la surveillance automatique SL/TP
   * @param {Function} notify - callback(message: string) pour alerter sur Telegram
   */
  startMonitor(notify) {
    if (this._monitorTimer) return; // déjà actif

    this._monitorTimer = setInterval(async () => {
      if (this.positions.size === 0 || this._monitorBusy) return;
      this._monitorBusy = true; // une vente lente ne doit pas lancer un 2e passage en parallèle
      try { await this._checkPositions(notify); }
      catch (err) { console.error('[Trader] Erreur moniteur:', err.message); }
      finally { this._monitorBusy = false; }
    }, MONITOR_INTERVAL_MS);

    console.log(`[Trader] Moniteur SL/TP démarré (intervalle: ${MONITOR_INTERVAL_MS / 1000}s)`);
  }

  stopMonitor() {
    if (this._monitorTimer) {
      clearInterval(this._monitorTimer);
      this._monitorTimer = null;
    }
  }

  async _checkPositions(notify) {
    const live = await this._pricesFor([...this.positions.keys()]);
    for (const [tokenMint, pos] of [...this.positions]) {
      const currentPrice = live[tokenMint];
      if (!currentPrice) continue;
      pos.lastPriceUsd = currentPrice; // sert à estimer une vente faite hors du bot
      if (!pos.entryPriceUsd) {
        // Position sans prix d'entrée (achat ou import pendant une panne de prix) :
        // on prend le premier prix connu comme référence pour activer SL/TP
        pos.entryPriceUsd = currentPrice;
        pos.highPriceUsd  = currentPrice;
        pos.entryPriceReconstructed = true;
        this._save();
        if (notify) notify(`ℹ️ Prix d'entrée de <code>${pos.symbol || tokenMint.slice(0, 8)}</code> reconstitué ($${currentPrice.toPrecision(4)}) — stop-loss et take-profit actifs.`);
        continue;
      }

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

      let reason     = null;
      let exitReason = null;
      let sellPct    = 100;
      let stageAfter = null;

      // Palier atteint (rétro-compat : ancien flag tpTaken = palier 1)
      const tpStage = pos.tpStage ?? (pos.tpTaken ? 1 : 0);

      // Trailing stop-loss activé seulement si le prix a monté > 20% depuis l'entrée
      const gainFromEntry = ((pos.highPriceUsd || pos.entryPriceUsd) - pos.entryPriceUsd) / pos.entryPriceUsd * 100;
      if (gainFromEntry >= 20 && dropFromHigh >= pos.stopLossPct) {
        reason     = `📉 <b>TRAILING STOP</b> déclenché\n${shortMint}\nHaut: $${pos.highPriceUsd.toFixed(8)}\nActuel: $${currentPrice.toFixed(8)}\nRecul: -${dropFromHigh.toFixed(1)}%  |  PnL global: ${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}%`;
        exitReason = 'TRAILING_STOP';
      } else if (changePct <= -pos.stopLossPct) {
        reason     = `🛑 <b>STOP LOSS</b> déclenché\n${shortMint}\nEntrée: $${pos.entryPriceUsd.toFixed(8)}\nActuel: $${currentPrice.toFixed(8)}\nPnL: ${changePct.toFixed(1)}%`;
        exitReason = 'STOP_LOSS';
      } else if (tpStage >= 1 && changePct <= 3) {
        // Après un palier de TP : le reste ne doit jamais repasser dans le rouge
        reason     = `⚖️ <b>BREAK-EVEN STOP</b> — sortie du reste\n${shortMint}\nPnL restant: ${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}% (gains des paliers sécurisés)`;
        exitReason = 'BREAKEVEN_STOP';
      } else if (tpStage === 0 && changePct >= pos.takeProfitPct) {
        // PALIER 1 : vend TP_SELL_STAGE1 % de la position initiale
        sellPct    = TP_SELL_STAGE1;
        stageAfter = 1;
        reason     = sellPct >= 100
          ? `🎯 <b>TAKE PROFIT</b> déclenché\n${shortMint}\nPnL: +${changePct.toFixed(1)}%`
          : `🎯 <b>TP PALIER 1</b> — vente de ${sellPct}%\n${shortMint}\nPnL: +${changePct.toFixed(1)}%\nProchain palier: +${(pos.takeProfitPct * 2).toFixed(0)}% — le reste court (trailing + break-even).`;
        exitReason = 'TAKE_PROFIT';
      } else if (tpStage === 1 && TP_SELL_STAGE2 > 0 && changePct >= pos.takeProfitPct * 2) {
        // PALIER 2 : vend TP_SELL_STAGE2 % de l'INITIAL → % du solde restant
        sellPct    = Math.min(90, Math.round((TP_SELL_STAGE2 / (100 - TP_SELL_STAGE1)) * 100));
        stageAfter = 2;
        reason     = `🎯🎯 <b>TP PALIER 2</b> — vente de ${TP_SELL_STAGE2}% de l'initial\n${shortMint}\nPnL: +${changePct.toFixed(1)}%\nLe reste (~${100 - TP_SELL_STAGE1 - TP_SELL_STAGE2}%) court en trailing jusqu'à la lune.`;
        exitReason = 'TAKE_PROFIT_2';
      }

      // Vente précédente en échec : on attend la fin du délai avant de réessayer
      if (reason && pos.nextSellAttemptAt && Date.now() < pos.nextSellAttemptAt) reason = null;

      if (reason) {
        const sym = pos.symbol || shortMint;
        const EXIT_LABELS = {
          STOP_LOSS: 'Stop-loss', TAKE_PROFIT: 'TP palier 1', TAKE_PROFIT_2: 'TP palier 2',
          TRAILING_STOP: 'Trailing stop', BREAKEVEN_STOP: 'Break-even',
        };
        try {
          console.log(`[Trader] ${reason.replace(/<[^>]+>/g, '')}`);
          logger.sltp(tokenMint, sym, exitReason, changePct);
          // Stop-loss = sortie d'urgence → slippage large (5%) pour garantir le fill
          const slippage = exitReason === 'STOP_LOSS' ? 500 : 300;
          const { txId } = await this.sell(tokenMint, sellPct, slippage, exitReason);
          const p = this.positions.get(tokenMint);
          if (p) { delete p.sellFailCount; delete p.nextSellAttemptAt; delete p.lastSellAlertAt; }
          if (stageAfter != null && sellPct < 100 && p) { p.tpStage = stageAfter; delete p.tpTaken; }
          this._save();
          // Chaque ordre du moniteur dans le journal d'ARIA (adresse, %, prix, PnL)
          personalAgent.logAction('SELL',
            `${EXIT_LABELS[exitReason] || exitReason} $${sym} — vendu ${sellPct}% à $${currentPrice.toFixed(8)} (PnL ${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}%)`,
            { symbol: sym, address: tokenMint, txId }
          );
          if (notify) {
            notify(`${reason}\n<a href="https://solscan.io/tx/${txId}">Voir la tx</a>`);
          }
        } catch (err) {
          console.error(`[Trader] Erreur vente SL/TP (${shortMint}): ${err.message}`);
          if (/balance token nulle/i.test(err.message)) {
            // Le wallet ne détient plus le token (vendu à la main) →
            // resynchronise au lieu de réessayer en boucle à chaque passage
            personalAgent.logAction('ERROR', `Vente ${EXIT_LABELS[exitReason] || exitReason} $${sym} : token absent du wallet`, { symbol: sym, address: tokenMint });
            this.syncWallet().catch(() => {});
            if (notify) notify(`🔀 Position <code>${shortMint}</code> absente du wallet — resynchronisation automatique du tracking.`);
          } else {
            // Réessais espacés (10 s, 30 s, 1 min, puis toutes les 5 min) et alertes limitées :
            // une alerte au 1er échec puis au plus une toutes les 15 min
            pos.sellFailCount = (pos.sellFailCount || 0) + 1;
            const delays = [10_000, 30_000, 60_000, 300_000];
            pos.nextSellAttemptAt = Date.now() + delays[Math.min(pos.sellFailCount - 1, delays.length - 1)];
            this._save();
            if (!pos.lastSellAlertAt || Date.now() - pos.lastSellAlertAt > 15 * 60_000) {
              pos.lastSellAlertAt = Date.now();
              personalAgent.logAction('ERROR',
                `Vente ${EXIT_LABELS[exitReason] || exitReason} $${sym} échouée (${pos.sellFailCount}e essai) : ${err.message}`,
                { symbol: sym, address: tokenMint });
              if (notify) {
                notify(`${pos.sellFailCount >= 6 ? '🚨' : '⚠️'} Vente ${EXIT_LABELS[exitReason] || exitReason} impossible pour <code>${this._escHtml(sym)}</code> (${pos.sellFailCount} essais) : ${this._escHtml(err.message.slice(0, 160))}\n` +
                  `Nouvel essai automatique ${pos.sellFailCount >= 4 ? 'toutes les 5 min' : 'bientôt'}.` +
                  (pos.sellFailCount >= 6 ? ' Vérifie la liquidité du token : tu devras peut-être vendre à la main.' : ''));
              }
            }
          }
        }
      }
    }
  }

  _escHtml(t) { return String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

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
