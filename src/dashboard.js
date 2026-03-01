/**
 * Dashboard Web — Monitoring en temps réel
 *
 * Accès : http://localhost:3000 (ou DASHBOARD_PORT dans .env)
 * Aucune dépendance externe — HTTP natif Node.js uniquement.
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PUBLIC_DIR = path.join(__dirname, 'public');

class Dashboard {
  constructor(trader) {
    this.trader = trader;
    this.port   = parseInt(process.env.DASHBOARD_PORT || '3000', 10);
    this.server = http.createServer((req, res) => this._handle(req, res));
  }

  start() {
    this.server.listen(this.port, () => {
      console.log(`[Dashboard] 🌐 Interface web disponible sur http://localhost:${this.port}`);
    });
  }

  // ─── Routing ──────────────────────────────────────────────────────────────

  _handle(req, res) {
    const { pathname } = url.parse(req.url);

    if (pathname === '/api/data') {
      this._apiData(res);
      return;
    }

    // Fichiers statiques depuis src/public/
    const filePath = pathname === '/' ? '/index.html' : pathname;
    const full = path.resolve(PUBLIC_DIR, '.' + filePath);

    // Sécurité: empêcher la traversée de dossier
    if (!full.startsWith(PUBLIC_DIR)) {
      res.writeHead(403); res.end(); return;
    }

    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); res.end('404 Not Found'); return; }
      const ext = path.extname(full);
      const ct  = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' }[ext] || 'text/plain';
      res.writeHead(200, { 'Content-Type': ct + '; charset=utf-8' });
      res.end(data);
    });
  }

  async _apiData(res) {
    try {
      const data = await this._buildData();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ─── Construction des données ─────────────────────────────────────────────

  async _buildData() {
    const positions = Array.from(this.trader.positions.values());
    const history   = this.trader.history || [];

    // Prix live pour les positions ouvertes (Jupiter Price API)
    const mints  = positions.map(p => p.tokenMint);
    const prices = mints.length > 0 ? await this._fetchPrices(mints) : {};

    const enrichedPositions = positions.map(p => {
      const currentPrice = prices[p.tokenMint] ?? null;
      const pnlPct = p.entryPriceUsd && currentPrice
        ? ((currentPrice - p.entryPriceUsd) / p.entryPriceUsd) * 100
        : null;
      const pnlSol = pnlPct !== null ? p.solSpent * (pnlPct / 100) : null;
      return { ...p, currentPrice, pnlPct, pnlSol };
    });

    // Stats globales
    const sells       = history.filter(h => h.action === 'SELL' && h.pnlSol != null);
    const realizedPnl = sells.reduce((s, h) => s + h.pnlSol, 0);
    const wins        = sells.filter(h => h.pnlSol > 0).length;
    const winRate     = sells.length > 0 ? Math.round((wins / sells.length) * 100) : null;

    // Timeline PnL cumulatif (pour le graphique)
    const pnlTimeline = [];
    let cum = 0;
    sells
      .slice()
      .sort((a, b) => a.timestamp - b.timestamp)
      .forEach(h => {
        cum += h.pnlSol;
        pnlTimeline.push({ t: h.timestamp, pnl: parseFloat(cum.toFixed(6)) });
      });

    // PnL par jour sur 7 jours
    const dailyPnl = this._dailyPnl(sells, 7);

    // Résumé + alertes semaine
    const weekAgo   = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const weekSells = sells.filter(h => h.timestamp >= weekAgo);
    const weekPnl   = weekSells.reduce((s, h) => s + h.pnlSol, 0);
    const weekWins  = weekSells.filter(h => h.pnlSol > 0).length;

    return {
      updatedAt: Date.now(),
      stats: {
        realizedPnl:   parseFloat(realizedPnl.toFixed(6)),
        winRate,
        totalTrades:   sells.length,
        openPositions: enrichedPositions.length,
      },
      weekly: {
        pnl:     parseFloat(weekPnl.toFixed(6)),
        trades:  weekSells.length,
        wins:    weekWins,
        winRate: weekSells.length > 0 ? Math.round((weekWins / weekSells.length) * 100) : null,
        alerts:  this._weekAlerts(weekSells, sells),
      },
      pnlTimeline,
      dailyPnl,
      positions: enrichedPositions,
      history:   history.slice(-100).reverse(),
    };
  }

  // ─── PnL par jour ─────────────────────────────────────────────────────────

  _dailyPnl(sells, days) {
    const result = [];
    for (let i = days - 1; i >= 0; i--) {
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      dayStart.setDate(dayStart.getDate() - i);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);

      const pnl = sells
        .filter(h => h.timestamp >= dayStart.getTime() && h.timestamp < dayEnd.getTime())
        .reduce((s, h) => s + h.pnlSol, 0);

      result.push({
        label: dayStart.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }),
        pnl:   parseFloat(pnl.toFixed(6)),
      });
    }
    return result;
  }

  // ─── Alertes semaine ──────────────────────────────────────────────────────

  _weekAlerts(weekSells, allSells) {
    const alerts = [];

    if (weekSells.length === 0) {
      alerts.push({ type: 'info', msg: 'Aucun trade fermé cette semaine.' });
      return alerts;
    }

    // Win rate faible
    const wr = Math.round((weekSells.filter(h => h.pnlSol > 0).length / weekSells.length) * 100);
    if (wr < 40 && weekSells.length >= 3)
      alerts.push({ type: 'warn', msg: `Win rate faible cette semaine : ${wr}%` });

    // SL consécutifs (sur les 5 derniers trades)
    const recent = allSells.slice(-5).reverse();
    const streak = recent.findIndex(h => h.pnlSol > 0);
    const consecutiveLosses = streak === -1 ? recent.length : streak;
    if (consecutiveLosses >= 3)
      alerts.push({ type: 'warn', msg: `${consecutiveLosses} stop-loss consécutifs récents` });

    // Meilleur trade de la semaine
    const best = weekSells.reduce((b, h) => h.pnlSol > (b?.pnlSol ?? -Infinity) ? h : b, null);
    if (best?.pnlSol > 0)
      alerts.push({ type: 'good', msg: `Meilleur trade : +${best.pnlSol.toFixed(4)} SOL (${best.tokenMint.slice(0, 6)}…)` });

    // Pire trade de la semaine
    const worst = weekSells.reduce((w, h) => h.pnlSol < (w?.pnlSol ?? Infinity) ? h : w, null);
    if (worst?.pnlSol < 0)
      alerts.push({ type: 'bad', msg: `Pire trade : ${worst.pnlSol.toFixed(4)} SOL (${worst.tokenMint.slice(0, 6)}…)` });

    // PnL semaine positif
    const weekTotal = weekSells.reduce((s, h) => s + h.pnlSol, 0);
    if (weekTotal > 0 && consecutiveLosses < 3 && wr >= 40)
      alerts.push({ type: 'good', msg: `Bonne semaine : ${weekSells.length} trades, ${wr}% win rate` });

    return alerts;
  }

  // ─── Prix live Jupiter ────────────────────────────────────────────────────

  async _fetchPrices(mints) {
    try {
      const ids  = mints.join(',');
      const data = await this._get(`https://api.jup.ag/price/v2?ids=${ids}`);
      const out  = {};
      for (const [mint, info] of Object.entries(data?.data ?? {})) {
        if (info?.price) out[mint] = parseFloat(info.price);
      }
      return out;
    } catch { return {}; }
  }

  _get(targetUrl) {
    return new Promise((resolve, reject) => {
      https.get(targetUrl, { headers: { 'User-Agent': 'meme-coin-dashboard/1.0' } }, res => {
        let raw = '';
        res.on('data', c => (raw += c));
        res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
      }).on('error', reject);
    });
  }
}

module.exports = Dashboard;
