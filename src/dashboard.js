/**
 * Dashboard Web — Monitoring en temps réel
 *
 * Accès : http://localhost:3000 (ou DASHBOARD_PORT dans .env)
 * Aucune dépendance externe — HTTP natif Node.js uniquement.
 *
 * Routes :
 *   GET  /              → HTML statique
 *   GET  /api/data      → Stats trading (positions, PnL, historique)
 *   GET  /api/floor     → Trading Floor (chatLog, agentsEnabled, mémoire, suggestions)
 *   GET  /api/events    → SSE — push temps réel des messages agents
 *   POST /api/agents/toggle    → Active/désactive les débats IA
 *   POST /api/suggestions/:id/approve
 *   POST /api/suggestions/:id/reject
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const state       = require('./state');
const agentMemory = require('./agentMemory');
const { agentBus, runDebate } = require('./agents');
const dex      = require('./dexscreener');
const birdeye  = require('./birdeye');
const rugcheck = require('./rugcheck');

const PUBLIC_DIR   = path.join(__dirname, 'public');
const MAX_CHAT_LOG = 120; // messages conservés en mémoire vive

class Dashboard {
  constructor(trader, paperTrader) {
    this.trader      = trader;
    this.paperTrader = paperTrader;
    this.port       = parseInt(process.env.DASHBOARD_PORT || '3000', 10);
    this.server     = http.createServer((req, res) => this._handle(req, res));

    // Trading Floor — log des messages agents (in-memory, max 120)
    this.chatLog    = [];
    // SSE — liste des clients connectés à /api/events
    this.sseClients = [];

    // Écoute le bus des agents → alimente le chatLog et les SSE
    agentBus.on('message', (msg) => this._onAgentMessage(msg));
    agentBus.on('system',  (msg) => this._onSystemMessage(msg));
  }

  start() {
    this.server.listen(this.port, () => {
      console.log(`[Dashboard] 🌐 Interface web disponible sur http://localhost:${this.port}`);
    });
  }

  // ─── Bus agents → chatLog + SSE ─────────────────────────────────────────────

  _onAgentMessage(msg) {
    const entry = { type: 'agent', ...msg };
    this._pushChat(entry);
  }

  _onSystemMessage(msg) {
    const entry = { type: 'system', ...msg };
    this._pushChat(entry);
  }

  _pushChat(entry) {
    this.chatLog.push(entry);
    if (this.chatLog.length > MAX_CHAT_LOG) {
      this.chatLog = this.chatLog.slice(-MAX_CHAT_LOG);
    }
    this._broadcastSSE(entry);
  }

  _broadcastSSE(data) {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    this.sseClients = this.sseClients.filter(({ res }) => {
      try {
        res.write(payload);
        return true;
      } catch {
        return false; // client déconnecté
      }
    });
  }

  // ─── Routing ──────────────────────────────────────────────────────────────

  _handle(req, res) {
    const parsed   = url.parse(req.url);
    const pathname = parsed.pathname;

    // ── API ──────────────────────────────────────────────────────────────────

    if (pathname === '/api/data' && req.method === 'GET') {
      this._apiData(res);
      return;
    }

    if (pathname === '/api/floor' && req.method === 'GET') {
      this._apiFloor(res);
      return;
    }

    if (pathname === '/api/events' && req.method === 'GET') {
      this._apiEvents(req, res);
      return;
    }

    if (pathname === '/api/agents/toggle' && req.method === 'POST') {
      this._apiToggleAgents(res);
      return;
    }

    const suggestMatch = pathname.match(/^\/api\/suggestions\/([^/]+)\/(approve|reject)$/);
    if (suggestMatch && req.method === 'POST') {
      this._apiSuggestion(res, suggestMatch[1], suggestMatch[2]);
      return;
    }

    if (pathname === '/api/paper' && req.method === 'GET') {
      this._apiPaper(res);
      return;
    }

    if (pathname === '/api/paper/reset' && req.method === 'POST') {
      this._apiPaperReset(req, res);
      return;
    }

    if (pathname === '/api/paper/config' && req.method === 'POST') {
      this._apiPaperConfig(req, res);
      return;
    }

    const paperSellMatch = pathname.match(/^\/api\/paper\/sell\/([^/]+)$/);
    if (paperSellMatch && req.method === 'POST') {
      this._apiPaperSell(res, paperSellMatch[1]);
      return;
    }

    if (pathname === '/api/paper/buy' && req.method === 'POST') {
      this._apiPaperBuy(req, res);
      return;
    }

    if (pathname === '/api/debate' && req.method === 'POST') {
      this._apiDebate(req, res);
      return;
    }

    // ── Fichiers statiques depuis src/public/ ─────────────────────────────

    const filePath = pathname === '/' ? '/index.html' : pathname;
    const full = path.resolve(PUBLIC_DIR, '.' + filePath);

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

  // ─── API /api/data ────────────────────────────────────────────────────────

  async _apiData(res) {
    try {
      const data = await this._buildData();
      res.writeHead(200, {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control':               'no-cache',
      });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ─── API /api/floor ──────────────────────────────────────────────────────

  _apiFloor(res) {
    const data = {
      agentsEnabled: state.agentsEnabled,
      chatLog:       this.chatLog,
      lessons:       agentMemory.getLessons(20),
      agentStats:    agentMemory.getStats(),
      suggestions:   agentMemory.getSuggestions(),
    };
    res.writeHead(200, {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'no-cache',
    });
    res.end(JSON.stringify(data));
  }

  // ─── API /api/events — Server-Sent Events ────────────────────────────────

  _apiEvents(req, res) {
    res.writeHead(200, {
      'Content-Type':                'text/event-stream',
      'Cache-Control':               'no-cache',
      'Connection':                  'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(': connected\n\n');

    // Heartbeat toutes les 25s pour garder la connexion vivante
    const hb = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { clearInterval(hb); }
    }, 25_000);

    this.sseClients.push({ res });

    req.on('close', () => {
      clearInterval(hb);
      this.sseClients = this.sseClients.filter(c => c.res !== res);
    });
  }

  // ─── API /api/agents/toggle ──────────────────────────────────────────────

  _apiToggleAgents(res) {
    state.agentsEnabled = !state.agentsEnabled;
    const status = state.agentsEnabled ? 'activés' : 'désactivés';
    console.log(`[Dashboard] Débats IA ${status}`);

    // Notifie le Trading Floor
    this._pushChat({
      type:      'system',
      content:   state.agentsEnabled
        ? '✅ Débats IA activés — les agents vont analyser les prochains tokens.'
        : '⏸️ Débats IA désactivés — aucun crédit API consommé.',
      timestamp: Date.now(),
    });

    res.writeHead(200, {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ agentsEnabled: state.agentsEnabled }));
  }

  // ─── API /api/suggestions/:id/(approve|reject) ──────────────────────────

  _apiSuggestion(res, id, action) {
    const ok = action === 'approve'
      ? agentMemory.approveSuggestion(id)
      : agentMemory.rejectSuggestion(id);

    if (!ok) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Suggestion introuvable' }));
      return;
    }

    const label = action === 'approve' ? 'approuvée' : 'rejetée';
    this._pushChat({
      type:      'system',
      content:   `${action === 'approve' ? '✅' : '❌'} Suggestion ${label} par l'utilisateur.`,
      timestamp: Date.now(),
    });

    res.writeHead(200, {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ ok: true, action, id }));
  }

  // ─── Construction des données /api/data ──────────────────────────────────

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

    // Timeline PnL cumulatif
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
      updatedAt:       Date.now(),
      recentAnalyses:  state.recentAnalyses,
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

    const wr = Math.round((weekSells.filter(h => h.pnlSol > 0).length / weekSells.length) * 100);
    if (wr < 40 && weekSells.length >= 3)
      alerts.push({ type: 'warn', msg: `Win rate faible cette semaine : ${wr}%` });

    const recent = allSells.slice(-5).reverse();
    const streak = recent.findIndex(h => h.pnlSol > 0);
    const consecutiveLosses = streak === -1 ? recent.length : streak;
    if (consecutiveLosses >= 3)
      alerts.push({ type: 'warn', msg: `${consecutiveLosses} stop-loss consécutifs récents` });

    const best = weekSells.reduce((b, h) => h.pnlSol > (b?.pnlSol ?? -Infinity) ? h : b, null);
    if (best?.pnlSol > 0)
      alerts.push({ type: 'good', msg: `Meilleur trade : +${best.pnlSol.toFixed(4)} SOL (${best.tokenMint.slice(0, 6)}…)` });

    const worst = weekSells.reduce((w, h) => h.pnlSol < (w?.pnlSol ?? Infinity) ? h : w, null);
    if (worst?.pnlSol < 0)
      alerts.push({ type: 'bad', msg: `Pire trade : ${worst.pnlSol.toFixed(4)} SOL (${worst.tokenMint.slice(0, 6)}…)` });

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

  // ─── API Paper Trading ────────────────────────────────────────────────────

  async _apiPaper(res) {
    if (!this.paperTrader) {
      this._jsonOk(res, { error: 'Paper trader non initialisé' });
      return;
    }
    try {
      const data      = this.paperTrader.getStats();
      const addresses = data.positions.map(p => p.address);
      const prices    = addresses.length > 0 ? await this._fetchPrices(addresses) : {};

      data.positions = data.positions.map(p => {
        const currentPrice = prices[p.address] ?? null;
        const pnlPct = currentPrice
          ? ((currentPrice - p.entryPrice) / p.entryPrice) * 100
          : null;
        const pnlSol = pnlPct !== null ? p.amountSolIn * (pnlPct / 100) : null;
        return { ...p, currentPrice, pnlPct, pnlSol };
      });

      this._jsonOk(res, data);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  _apiPaperReset(req, res) {
    if (!this.paperTrader) { this._jsonOk(res, { ok: false }); return; }
    this._readBody(req, (body) => {
      const { balance } = body;
      const ok = this.paperTrader.reset(balance ?? 10);
      this._jsonOk(res, { ok, config: this.paperTrader.state.config });
    });
  }

  _apiPaperConfig(req, res) {
    if (!this.paperTrader) { this._jsonOk(res, { ok: false }); return; }
    this._readBody(req, (body) => {
      const config = this.paperTrader.updateConfig(body);
      this._jsonOk(res, { ok: true, config });
    });
  }

  async _apiPaperSell(res, address) {
    if (!this.paperTrader) { this._jsonOk(res, { ok: false }); return; }
    await this.paperTrader.manualSell(address);
    this._jsonOk(res, { ok: true });
  }

  _apiPaperBuy(req, res) {
    if (!this.paperTrader) { this._jsonOk(res, { ok: false, error: 'Paper trader non initialisé' }); return; }
    this._readBody(req, async (body) => {
      const { address, amountSol } = body;
      const result = await this.paperTrader.manualBuy(address, amountSol);
      this._jsonOk(res, result);
    });
  }

  // ─── API /api/debate ──────────────────────────────────────────────────────

  _apiDebate(req, res) {
    this._readBody(req, async ({ address }) => {
      if (!address || typeof address !== 'string' || !address.trim()) {
        this._jsonOk(res, { ok: false, error: 'Adresse manquante' });
        return;
      }
      const addr = address.trim();

      // Annonce immédiate dans le Trading Floor
      this._pushChat({
        type:      'system',
        content:   `🔍 Débat manuel demandé pour <code>${addr.slice(0, 8)}…</code>`,
        timestamp: Date.now(),
      });

      try {
        const pairs = await dex.getTokenPairs('solana', addr);
        if (!pairs || pairs.length === 0) {
          this._jsonOk(res, { ok: false, error: 'Token introuvable sur DexScreener' });
          return;
        }
        const pair = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

        const [{ security, overview }, rugReport, lpLock] = await Promise.all([
          birdeye.getTokenData(addr),
          rugcheck.getTokenReport(addr),
          rugcheck.getLpLockData(addr),
        ]);

        const debate = await runDebate(pair, security, rugReport, overview, lpLock);

        const sym = pair.baseToken?.symbol || addr.slice(0, 6);
        this._pushChat({
          type:      'system',
          content:   `📊 Débat terminé — <b>$${sym}</b> → ${debate.decision?.decision} (${debate.decision?.score ?? '?'}/100)`,
          timestamp: Date.now(),
        });

        this._jsonOk(res, { ok: true, debate, pair });
      } catch (err) {
        this._pushChat({ type: 'system', content: `❌ Erreur débat : ${err.message}`, timestamp: Date.now() });
        this._jsonOk(res, { ok: false, error: err.message });
      }
    });
  }

  _jsonOk(res, data) {
    res.writeHead(200, {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'no-cache',
    });
    res.end(JSON.stringify(data));
  }

  _readBody(req, cb) {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      try { cb(JSON.parse(raw)); } catch { cb({}); }
    });
  }
}

module.exports = Dashboard;
