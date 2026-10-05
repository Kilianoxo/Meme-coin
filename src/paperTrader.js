/**
 * Paper Trader — Simule des trades sans risque réel
 *
 * Utilise les mêmes analyses que le vrai bot (événements 'debate' du scanner)
 * mais avec un seuil d'entrée plus bas (minScore 60 vs 70) et des paramètres
 * légèrement plus agressifs pour apprendre sans perdre de vrais SOL.
 *
 * Persistence : data/paper_positions.json
 */

const EventEmitter = require('events');
const fs           = require('fs');
const path         = require('path');
const gmgn         = require('./gmgn');

const DATA_FILE = path.join(__dirname, '../data/paper_positions.json');

class PaperTrader extends EventEmitter {
  constructor() {
    super();
    this.state = this._loadState();
    // Monitor toutes les 30s comme le vrai trader
    this._monitorInterval = setInterval(() => this._monitorPositions(), 30_000);
  }

  // ─── State & persistance ──────────────────────────────────────────────────

  _defaultState() {
    return {
      config: {
        startingBalance:    10,   // SOL de départ
        currentBalance:     10,   // SOL disponible actuellement
        slPct:              15,   // Stop-loss %
        tpPct:              80,   // Take-profit %
        maxPositionPct:      5,   // % du portefeuille par trade
        minScore:           50,   // Seuil d'entrée — couvre WAIT (50-69) + BUY (70+)
        maxPositions:        5,   // Positions simultanées max
        trailingActivation: 20,   // % de gain pour activer le trailing stop
        trailingDistance:   10,   // % de recul depuis le plus haut pour déclencher
      },
      positions: {},  // { [address]: Position }
      history:   [],  // Position[] fermées, la plus récente en premier
    };
  }

  _loadState() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      }
    } catch {}
    return this._defaultState();
  }

  _save() {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(this.state, null, 2));
  }

  // ─── Prix Jupiter (lecture seule, pas de swap) ────────────────────────────

  async _fetchPrice(address) {
    try {
      const res = await fetch(`https://lite-api.jup.ag/price/v2?ids=${address}`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return null;
      const json  = await res.json();
      const price = json?.data?.[address]?.price;
      return price != null ? parseFloat(price) : null;
    } catch {
      return null;
    }
  }

  /** Fallback GMGN (token info, caché 60s) si Jupiter ne connaît pas le token */
  async _fetchPriceWithFallback(address) {
    let price = await this._fetchPrice(address);
    if (price != null && price > 0) return { price, source: 'Jupiter' };

    try {
      if (await gmgn.isAvailable()) {
        const gmgnPrice = await gmgn.getTokenPrice(address);
        if (gmgnPrice && gmgnPrice > 0) return { price: gmgnPrice, source: 'GMGN' };
      }
    } catch { /* silencieux */ }

    return null;
  }

  // ─── Entrée depuis un résultat de débat ───────────────────────────────────

  /**
   * Appelé à chaque événement 'debate' du scanner.
   * Décide d'acheter si score >= config.minScore.
   *
   * @param {Object|null} debate - résultat de runDebate (null si agents désactivés)
   */
  async onDebateResult(debate) {
    if (!debate) return;

    const { decision, token, isGraduated, bear } = debate;
    const score   = decision?.score;
    const address = token?.baseToken?.address;
    const symbol  = token?.baseToken?.symbol || address?.slice(0, 6) || '???';

    if (!address || score == null) return;
    if (score < this.state.config.minScore) {
      console.log(`[PaperTrader] ⏭️  $${symbol} ignoré — score ${score} < minScore ${this.state.config.minScore}`);
      return;
    }
    // Bear critique (≥8/10) = rug/pump-and-dump quasi-certain, inutile même en simulation
    if (bear?.riskScore >= 8) {
      console.log(`[PaperTrader] ⏭️  $${symbol} ignoré — Bear critique (${bear.riskScore}/10)`);
      return;
    }
    if (this.state.positions[address]) return;       // déjà en portefeuille
    if (Object.keys(this.state.positions).length >= this.state.config.maxPositions) {
      console.log(`[PaperTrader] ⏭️  $${symbol} ignoré — max positions atteint (${this.state.config.maxPositions})`);
      return;
    }

    const { config } = this.state;
    const amountSol = (config.currentBalance * config.maxPositionPct) / 100;
    if (amountSol < 0.001 || amountSol > config.currentBalance) {
      console.log(`[PaperTrader] ⏭️  $${symbol} ignoré — solde insuffisant (${config.currentBalance.toFixed(4)} ◎)`);
      return;
    }

    // Jupiter Price API en priorité, fallback sur le prix GMGN du token analysé
    let price = await this._fetchPrice(address);
    if (!price || price <= 0) {
      const dexPrice = token.priceUsd ? parseFloat(token.priceUsd) : null;
      if (dexPrice && dexPrice > 0) {
        price = dexPrice;
        console.log(`[PaperTrader] ⚠️  $${symbol} — Jupiter sans prix, fallback prix GMGN @ ${dexPrice}`);
      } else {
        console.log(`[PaperTrader] ⏭️  $${symbol} ignoré — prix introuvable (Jupiter + GMGN)`);
        return;
      }
    }

    const tokensHeld = amountSol / price;

    // Supply estimée depuis les données GMGN du token analysé → permet d'afficher
    // le market cap (l'unité parlante des meme coins) au lieu du prix unitaire
    const refPrice = token.priceUsd ? parseFloat(token.priceUsd) : price;
    const mcapRef  = token.marketCap || token.fdv || 0;
    const supply   = mcapRef > 0 && refPrice > 0 ? mcapRef / refPrice : null;

    config.currentBalance -= amountSol;
    this.state.positions[address] = {
      symbol,
      name:        token.baseToken?.name || '',
      address,
      entryPrice:  price,
      highPrice:   price,
      currentPrice: price,
      supply,
      entryMcap:   supply ? Math.round(supply * price) : null,
      currentMcap: supply ? Math.round(supply * price) : null,
      pnlPct:      0,
      pnlSol:      0,
      tokensHeld,
      amountSolIn: amountSol,
      slPct:       decision.stopLossPct   || config.slPct,
      tpPct:       decision.takeProfitPct || config.tpPct,
      score,
      entryTime:   Date.now(),
      reason:      decision.reasoning || '',
      isGraduated: !!isGraduated,
    };

    this._save();
    console.log(`[PaperTrader] 📝 BUY $${symbol} @ ${price.toExponential(3)} — ${amountSol.toFixed(3)} ◎ (score ${score})`);
    this.emit('buy', this.state.positions[address]);
  }

  // ─── Vente (interne + manuelle) ───────────────────────────────────────────

  async _sellPosition(address, reason) {
    const pos = this.state.positions[address];
    if (!pos) return;

    const fetched     = await this._fetchPriceWithFallback(address);
    // Dernier prix connu du moniteur en secours — jamais le prix d'entrée si évitable
    const exitPrice   = fetched?.price ?? pos.currentPrice ?? pos.entryPrice;
    const solReceived = pos.tokensHeld * exitPrice;
    const pnlSol      = solReceived - pos.amountSolIn;
    const pnlPct      = (pnlSol / pos.amountSolIn) * 100;

    this.state.config.currentBalance += solReceived;

    const record = { ...pos, exitPrice, exitTime: Date.now(), pnlSol, pnlPct, reason };
    this.state.history.unshift(record);
    if (this.state.history.length > 200) this.state.history.pop();

    delete this.state.positions[address];
    this._save();

    const icon = pnlSol > 0 ? '✅' : '❌';
    console.log(`[PaperTrader] ${icon} SELL $${pos.symbol} — ${reason} — PnL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} ◎ (${pnlPct.toFixed(1)}%)`);
    this.emit('sell', record);
  }

  /** Achat manuel déclenché depuis le dashboard */
  async manualBuy(address, amountSol) {
    address = (address || '').trim();
    if (!address) return { ok: false, error: 'Adresse manquante' };

    const amount = parseFloat(amountSol);
    if (isNaN(amount) || amount <= 0) return { ok: false, error: 'Montant invalide' };

    const { config } = this.state;
    if (amount > config.currentBalance)
      return { ok: false, error: `Solde insuffisant (${config.currentBalance.toFixed(4)} ◎ disponible)` };
    if (this.state.positions[address])
      return { ok: false, error: 'Position déjà ouverte sur ce token' };
    if (Object.keys(this.state.positions).length >= config.maxPositions)
      return { ok: false, error: `Max positions atteint (${config.maxPositions})` };

    const result = await this._fetchPriceWithFallback(address);
    if (!result) return { ok: false, error: 'Prix introuvable (Jupiter + GMGN). Vérifie que l\'adresse est un token Solana valide.' };

    const { price, source } = result;
    const tokensHeld = amount / price;

    // Symbole + supply via GMGN token info (best effort) → affichage en market cap
    let symbol = address.slice(0, 6).toUpperCase();
    let supply = null;
    try {
      if (await gmgn.isAvailable()) {
        const info = await gmgn.getTokenInfo(address);
        if (info) {
          if (info.symbol && info.symbol !== '???') symbol = info.symbol;
          if (info.marketCap > 0 && info.priceUsd > 0) supply = info.marketCap / info.priceUsd;
        }
      }
    } catch { /* best effort */ }

    config.currentBalance -= amount;
    this.state.positions[address] = {
      symbol,
      name:        '',
      address,
      entryPrice:  price,
      highPrice:   price,
      currentPrice: price,
      supply,
      entryMcap:   supply ? Math.round(supply * price) : null,
      currentMcap: supply ? Math.round(supply * price) : null,
      pnlPct:      0,
      pnlSol:      0,
      tokensHeld,
      amountSolIn: amount,
      slPct:       config.slPct,
      tpPct:       config.tpPct,
      score:       null,    // pas de débat IA — entrée manuelle
      entryTime:   Date.now(),
      reason:      `Entrée manuelle via dashboard (prix: ${source})`,
      isGraduated: false,
      manual:      true,
    };

    this._save();
    console.log(`[PaperTrader] 📝 BUY MANUEL ${address.slice(0, 8)}… @ ${price.toExponential(3)} [${source}] — ${amount.toFixed(3)} ◎`);
    this.emit('buy', this.state.positions[address]);
    return { ok: true, position: this.state.positions[address] };
  }

  /** Vente manuelle déclenchée depuis le dashboard */
  manualSell(address) {
    return this._sellPosition(address, 'MANUAL');
  }

  // ─── Surveillance SL / TP / Trailing ─────────────────────────────────────

  async _monitorPositions() {
    for (const [address, pos] of Object.entries(this.state.positions)) {
      const fetched = await this._fetchPriceWithFallback(address);
      if (!fetched) continue;
      const price = fetched.price;

      // Met à jour le plus haut
      if (price > pos.highPrice) {
        pos.highPrice = price;
      }

      const gainPct      = ((price - pos.entryPrice)   / pos.entryPrice)   * 100;
      const dropFromHigh = ((pos.highPrice - price)     / pos.highPrice)    * 100;
      const maxGainPct   = ((pos.highPrice - pos.entryPrice) / pos.entryPrice) * 100;

      // Stocke prix actuel + PnL + market cap live sur la position (affichage dashboard)
      pos.currentPrice = price;
      pos.pnlPct       = parseFloat(gainPct.toFixed(2));
      pos.pnlSol       = parseFloat(((pos.tokensHeld * price) - pos.amountSolIn).toFixed(6));
      if (pos.supply) pos.currentMcap = Math.round(pos.supply * price);

      if (gainPct <= -pos.slPct) {
        await this._sellPosition(address, 'STOP_LOSS');
        continue;
      }

      if (gainPct >= pos.tpPct) {
        await this._sellPosition(address, 'TAKE_PROFIT');
        continue;
      }

      const { trailingActivation, trailingDistance } = this.state.config;
      if (maxGainPct >= trailingActivation && dropFromHigh >= trailingDistance) {
        await this._sellPosition(address, 'TRAILING_STOP');
        continue;
      }

      this._save();
    }
  }

  // ─── Contrôles dashboard ──────────────────────────────────────────────────

  /** Réinitialise complètement le portefeuille papier */
  reset(newBalance) {
    const bal = parseFloat(newBalance);
    if (isNaN(bal) || bal <= 0) return false;
    this.state = this._defaultState();
    this.state.config.startingBalance = bal;
    this.state.config.currentBalance  = bal;
    this._save();
    console.log(`[PaperTrader] 🔄 Reset — nouveau portefeuille: ${bal} ◎`);
    return true;
  }

  /** Met à jour les paramètres de configuration */
  updateConfig(params) {
    const allowed = ['slPct', 'tpPct', 'maxPositionPct', 'minScore', 'maxPositions', 'trailingActivation', 'trailingDistance'];
    for (const [k, v] of Object.entries(params)) {
      if (allowed.includes(k)) {
        this.state.config[k] = parseFloat(v);
      }
    }
    this._save();
    return this.state.config;
  }

  // ─── Données pour le dashboard ────────────────────────────────────────────

  getStats() {
    const { config, positions, history } = this.state;
    const openList      = Object.values(positions);
    const totalInvested = openList.reduce((s, p) => s + p.amountSolIn, 0);

    const wins        = history.filter(h => h.pnlSol > 0);
    const losses      = history.filter(h => h.pnlSol <= 0);
    const realizedPnl = history.reduce((s, h) => s + h.pnlSol, 0);
    const winRate     = history.length > 0 ? Math.round((wins.length / history.length) * 100) : null;

    const portfolioValue = config.currentBalance + totalInvested;
    const totalPnlPct    = ((portfolioValue - config.startingBalance) / config.startingBalance) * 100;

    // Timeline PnL cumulatif (du plus ancien au plus récent)
    const timeline = [];
    let cum = 0;
    [...history].reverse().forEach(h => {
      cum += h.pnlSol;
      timeline.push({ t: h.exitTime, pnl: parseFloat(cum.toFixed(6)) });
    });

    return {
      config,
      positions: openList,
      history:   history.slice(0, 100),
      stats: {
        startingBalance: config.startingBalance,
        currentBalance:  config.currentBalance,
        portfolioValue:  parseFloat(portfolioValue.toFixed(6)),
        totalInvested:   parseFloat(totalInvested.toFixed(6)),
        realizedPnl:     parseFloat(realizedPnl.toFixed(6)),
        totalPnlPct:     parseFloat(totalPnlPct.toFixed(2)),
        winRate,
        totalTrades:     history.length,
        wins:            wins.length,
        losses:          losses.length,
        openPositions:   openList.length,
      },
      timeline,
      dailyPnl: this._dailyPnl(history, 7),
    };
  }

  _dailyPnl(history, days) {
    const result = [];
    for (let i = days - 1; i >= 0; i--) {
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      dayStart.setDate(dayStart.getDate() - i);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);

      const pnl = history
        .filter(h => h.exitTime >= dayStart.getTime() && h.exitTime < dayEnd.getTime())
        .reduce((s, h) => s + h.pnlSol, 0);

      result.push({
        label: dayStart.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }),
        pnl:   parseFloat(pnl.toFixed(6)),
      });
    }
    return result;
  }
}

module.exports = PaperTrader;
