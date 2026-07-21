/**
 * Client GMGN — via gmgn-cli (npm install -g gmgn-cli@1.3.9)
 *
 * Source de données premium : les lignes trending contiennent des champs de
 * due-diligence introuvables sur DexScreener/GeckoTerminal :
 *   smart_degen_count (smart money), renowned_count (KOL), sniper_count,
 *   bundler_rate, dev_team_hold_rate, top_10_holder_rate, rug_ratio,
 *   buy_tax/sell_tax, is_honeypot, renounced_mint/freeze, momentum 5m.
 *
 * Méthodologie intégrée (portée du demo officiel GMGNAI/skillmarket-demos) :
 *   1. hardGates()     — gates déterministes anti-rug + consensus smart money
 *   2. judge()         — verdict momentum "golden runner vs bag-holder" (pur code)
 *   3. assessEscape()  — monitoring de fuite des positions (honeypot apparu,
 *                        mint retrouvée, concentration top10 en hausse)
 *   Règle d'or GMGN : le LLM ne touche jamais au risque ni à la fuite — tout ici
 *   est déterministe. ARIA reçoit ces données en ENTRÉE de son analyse.
 *
 * Configuration :
 *   - GMGN_API_KEY dans .env OU ~/.config/gmgn/.env (format gmgn-cli officiel)
 *   - gmgn-cli installé globalement (npm i -g gmgn-cli)
 *   - GMGN_TRENDING_ARGS (optionnel) — remplace les arguments trending par défaut
 *   - GMGN_MIN_CONFLUENCE (défaut 1) — smart money + KOL minimum (gate consensus)
 * Sans clé ou sans CLI → module indisponible, le bot fonctionne sans (dégradé propre).
 */

const { execFile } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const CHAIN            = 'sol';
const GMGN_ENV_PATH    = path.join(os.homedir(), '.config', 'gmgn', '.env');
const TRENDING_TTL_MS  = 25_000;      // cache trending (protège le quota, scan toutes les 30s)
const SECURITY_TTL_MS  = 5 * 60_000;  // cache token security par adresse
const INFO_TTL_MS      = 60_000;      // cache token info / prix par adresse
const HOT_TTL_MS       = 60_000;      // cache hot-searches
const CLI_TIMEOUT_MS   = 25_000;

// Gates durs — seuils du demo officiel GMGN (CFG de app.py)
const GATES = {
  requireRenouncedMint: true,
  maxBuyTax:            0.10,
  maxSellTax:           0.10,
  maxRugRatio:          0.60,
  maxBundlerRatio:      0.30,
  maxDevHoldingPct:     0.10,
  maxTop10Concentration: 0.40,
  minConfluence:        parseInt(process.env.GMGN_MIN_CONFLUENCE || '1', 10),
};

// Verdict momentum — seuils du LLMJudge GMGN
const JUDGE = {
  rejectChg1h:    -0.12,  // 1h ≤ -12%
  rejectChg5m:    -0.06,  // ET 5m ≤ -6% → saignée, on ne suit pas
  buyRatioPass:    0.50,  // buy ratio ≥ 50% → golden runner, on peut suivre
  buyRatioReject:  0.42,  // buy ratio < 42% → distribution / bag-holder
};

// ─── Environnement gmgn-cli ──────────────────────────────────────────────────

let _envCache = null;
function _gmgnEnv() {
  if (_envCache) return _envCache;
  const extra = {};
  try {
    // Format .env gmgn-cli : ~/.config/gmgn/.env (clés éventuellement quotées, \n littéraux)
    for (const line of fs.readFileSync(GMGN_ENV_PATH, 'utf8').split('\n')) {
      const idx = line.indexOf('=');
      if (idx === -1 || line.trim().startsWith('#')) continue;
      const k = line.slice(0, idx).trim();
      let   v = line.slice(idx + 1).trim();
      if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0])) v = v.slice(1, -1);
      extra[k] = v.replace(/\\n/g, '\n');
    }
  } catch { /* fichier absent — on ne dépend que de process.env */ }
  _envCache = { ...extra, ...process.env }; // process.env prioritaire
  return _envCache;
}

function hasKey() { return !!_gmgnEnv().GMGN_API_KEY; }

let _cliAvailable = null; // null = pas encore sondé
/** true si gmgn-cli est installé ET une clé API est configurée */
async function isAvailable() {
  if (!hasKey()) return false;
  if (_cliAvailable !== null) return _cliAvailable;
  try {
    await _exec(['--version'], 8_000);
    _cliAvailable = true;
    console.log('[GMGN] gmgn-cli détecté + clé API — source GMGN activée');
  } catch (err) {
    // ENOENT = CLI absent. Toute autre erreur (ex: --version inconnu) = CLI présent.
    _cliAvailable = err.code !== 'ENOENT';
    if (!_cliAvailable) {
      console.warn('[GMGN] GMGN_API_KEY configurée mais gmgn-cli introuvable — npm install -g gmgn-cli');
    }
  }
  return _cliAvailable;
}

// ─── Exécution CLI ───────────────────────────────────────────────────────────

function _exec(args, timeout = CLI_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile('gmgn-cli', args, { env: _gmgnEnv(), timeout, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const e = new Error(`gmgn-cli: ${String(stderr || err.message).trim().slice(0, 300)}`);
          e.code = err.code;
          return reject(e);
        }
        resolve(stdout);
      });
  });
}

async function _cli(args, chain = CHAIN) {
  const out  = await _exec([...args, '--chain', chain, '--raw']);
  const json = JSON.parse(out);
  // gmgn-cli signale limite/quota via exit 0 + code métier non nul — ne pas
  // le traiter silencieusement comme une liste vide
  if (json && typeof json === 'object' && json.code != null && json.code !== 0) {
    throw new Error(`gmgn-cli code=${json.code} ${json.msg || json.message || ''}`.trim());
  }
  return json;
}

// ─── Helpers de parsing (le CLI renvoie prix/volumes en strings, booléens en 0/1) ──

function _f(v, d = 0) { const n = parseFloat(v); return isNaN(n) ? d : n; }
function _b(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number')  return v !== 0;
  if (typeof v === 'string')  return ['1', 'true', 'yes'].includes(v.trim().toLowerCase());
  return false;
}
const _clamp = (x, lo = 0, hi = 1) => x < lo ? lo : x > hi ? hi : x;

// ─── Trending ────────────────────────────────────────────────────────────────

// Filtres de base poussés côté serveur GMGN (économise bande passante + bruit).
// Les mêmes seuils sont re-vérifiés localement par le scanner (_passesFilters).
// sol garde le filtre not_wash_trading (spécifique Solana) ; les chaînes EVM
// (robinhood/eth/bsc/base) utilisent les args génériques.
function _defaultTrendingArgs(chain) {
  const args = [
    'market', 'trending',
    '--interval', '1h', '--order-by', 'volume', '--direction', 'desc',
    '--limit', '100',
    '--min-liquidity',  process.env.MIN_LIQUIDITY_USD  || '5000',
    '--min-marketcap',  process.env.MIN_MARKET_CAP_USD || '30000',
  ];
  if (chain === 'sol') args.push('--filter', 'not_wash_trading');
  return args;
}

const _trendingCaches = new Map(); // chain → { ts, rows }

/**
 * Récupère le trending GMGN d'une chaîne, normalisé au format DexScreener
 * (compatible scanner) avec les champs riches GMGN attachés dans `_gmgn`.
 * @param {string} chain — 'sol' (défaut) | 'robinhood' | 'eth' | 'bsc' | 'base'
 * @returns {Promise<Object[]>} paires normalisées
 */
async function getTrending(chain = CHAIN) {
  const cached = _trendingCaches.get(chain);
  if (cached && Date.now() - cached.ts < TRENDING_TTL_MS) return cached.rows;

  const envKey = chain === 'sol' ? 'GMGN_TRENDING_ARGS' : `GMGN_TRENDING_ARGS_${chain.toUpperCase()}`;
  const custom = (process.env[envKey] || '').trim();
  const args   = custom ? custom.split(/\s+/) : _defaultTrendingArgs(chain);
  const resp   = await _cli(args, chain);
  const data   = resp?.data ?? resp;
  const rows   = (data && typeof data === 'object' && (data.rank || data.tokens)) || [];
  const pairs  = rows.map(r => normalizeRow(r, chain)).filter(Boolean);

  _trendingCaches.set(chain, { ts: Date.now(), rows: pairs });
  return pairs;
}

/**
 * Normalise une ligne trending gmgn-cli 1.3.9 vers le format DexScreener
 * utilisé dans tout le bot. Les extras GMGN vont dans `_gmgn` (ratios en décimal).
 */
function normalizeRow(row, chain = CHAIN) {
  if (!row || !row.address) return null;

  const buys  = Math.round(_f(row.buys));
  const sells = Math.round(_f(row.sells));
  const vol   = _f(row.volume);      // avec --interval 1h : volume de la dernière heure
  const mcap  = _f(row.market_cap);
  const ct    = _f(row.creation_timestamp) || _f(row.open_timestamp);

  const gmgn = {
    smartDegen:      Math.round(_f(row.smart_degen_count)),
    renowned:        Math.round(_f(row.renowned_count)),
    sniper:          Math.round(_f(row.sniper_count)),
    holderCount:     Math.round(_f(row.holder_count)),
    bundler:         _f(row.bundler_rate),
    devHold:         _f(row.dev_team_hold_rate),
    top10:           _f(row.top_10_holder_rate),
    rugRatio:        _f(row.rug_ratio),
    buyTax:          _f(row.buy_tax),
    sellTax:         _f(row.sell_tax),
    honeypot:        _b(row.is_honeypot),
    // EVM (robinhood/eth/bsc/base) : is_renounced remplace renounced_mint
    renouncedMint:   _b(row.renounced_mint) || _b(row.is_renounced),
    renouncedFreeze: chain === 'sol' ? _b(row.renounced_freeze_account) : true,
    openSource:      _b(row.is_open_source),
    burnRatio:       _f(row.burn_ratio),
    // price_change_percentXX est un nombre en % (35.0 = +35%) → décimal en interne
    chg5m:           _f(row.price_change_percent5m) / 100,
    chg1h:           _f(row.price_change_percent1h) / 100,
    buyRatio:        (buys + sells) > 0 ? buys / (buys + sells) : 0.5,
    turnover:        mcap > 0 ? vol / mcap : 0,
    confluence:      Math.round(_f(row.smart_degen_count)) + Math.round(_f(row.renowned_count)),
  };
  gmgn.verdict = judge(gmgn); // verdict momentum déterministe pré-calculé

  return {
    _source:  chain === 'sol' ? 'gmgn-trending' : `gmgn-${chain}`,
    _gmgn:    gmgn,
    _chain:   chain,
    chainId:  chain === 'sol' ? 'solana' : chain,
    dexId:    'gmgn',
    pairAddress:   row.address,
    pairCreatedAt: ct > 0 ? ct * 1000 : null,
    baseToken: {
      address: row.address,
      symbol:  row.symbol || '???',
      name:    row.name || row.symbol || '???',
    },
    priceUsd: String(_f(row.price)),
    priceChange: {
      m5:  _f(row.price_change_percent5m),
      h1:  _f(row.price_change_percent1h),
      h6:  _f(row.price_change_percent6h),
      h24: _f(row.price_change_percent24h),
    },
    // interval 1h → volume = volume horaire. Utilisé aussi comme h24 (approximation
    // CONSERVATRICE : le filtre min volume 24h devient plus strict, jamais plus laxiste).
    volume: { h1: vol, h24: _f(row.volume_24h) || vol },
    liquidity: { usd: _f(row.liquidity) },
    marketCap: mcap,
    fdv:       _f(row.fdv) || mcap,
    txns: { h1: { buys, sells } },
  };
}

/** Cherche une paire dans le cache trending d'une chaîne par adresse (sans appel CLI) */
function findTrendingRow(address, chain = CHAIN) {
  const cached = _trendingCaches.get(chain);
  return cached?.rows.find(p => p.baseToken?.address === address) || null;
}

// Slugs des URLs gmgn.ai par chaîne
const CHAIN_SLUGS = { sol: 'sol', eth: 'eth', bsc: 'bsc', base: 'base', robinhood: 'rh' };

/** URL de la page GMGN d'un token */
function tokenUrl(address, chain = CHAIN) {
  return `https://gmgn.ai/${CHAIN_SLUGS[chain] || chain}/token/${address}`;
}

// ─── Token info / prix ───────────────────────────────────────────────────────

const _infoCache = new Map(); // addr → { ts, info }

/**
 * Infos de base + prix temps réel d'un token (token info, cache 60s).
 * @returns {Promise<{address, symbol, name, priceUsd, marketCap, holderCount, raw}|null>}
 */
async function getTokenInfo(addr, chain = CHAIN) {
  const key    = `${chain}|${addr}`;
  const cached = _infoCache.get(key);
  if (cached && Date.now() - cached.ts < INFO_TTL_MS) return cached.info;

  try {
    const d   = await _cli(['token', 'info', '--address', addr], chain);
    const raw = d?.data && typeof d.data === 'object' ? d.data : d;
    // Le prix peut être un nombre, une string ou un objet imbriqué {price:{price:"…"}}
    const p    = raw.price;
    const info = {
      address:     raw.address || addr,
      symbol:      raw.symbol || '???',
      name:        raw.name || raw.symbol || '???',
      priceUsd:    typeof p === 'object' && p !== null ? _f(p.price) : _f(p),
      marketCap:   _f(raw.market_cap),
      liquidity:   _f(raw.liquidity),
      holderCount: Math.round(_f(raw.holder_count)),
      raw,
    };
    _infoCache.set(key, { ts: Date.now(), info });
    return info;
  } catch {
    return null;
  }
}

/** Prix USD seul (via token info caché) — fallback quand Jupiter ne connaît pas le token */
async function getTokenPrice(addr, chain = CHAIN) {
  const info = await getTokenInfo(addr, chain);
  return info && info.priceUsd > 0 ? info.priceUsd : null;
}

// ─── Hot-searches (tokens les plus recherchés) ───────────────────────────────

let _hotCache = { ts: 0, rows: [] };

/** Tokens les plus recherchés sur GMGN (cache 60s), normalisés comme le trending */
async function getHotSearches(limit = 20, chain = CHAIN) {
  if (chain === CHAIN && Date.now() - _hotCache.ts < HOT_TTL_MS) return _hotCache.rows;
  try {
    const resp = await _cli(['market', 'hot-searches', '--interval', '1h', '--limit', String(limit)], chain);
    const data = resp?.data ?? resp;
    const rows = Array.isArray(data) ? data
               : (data && (data.rank || data.tokens || data.list)) || [];
    const pairs = rows.map(r => normalizeRow(r, chain)).filter(Boolean)
      .map(p => ({ ...p, _source: 'gmgn-hot' }));
    if (chain !== CHAIN) return pairs;
    _hotCache = { ts: Date.now(), rows: pairs };
    return pairs;
  } catch {
    return [];
  }
}

/**
 * Recherche un token par nom/ticker dans le trending + hot-searches GMGN.
 * (GMGN n'a pas de recherche texte — on filtre les listes chaudes.)
 * @returns {Promise<Object[]>} paires normalisées correspondantes
 */
async function searchToken(query) {
  const q = String(query || '').toLowerCase().replace(/^\$/, '').trim();
  if (!q) return [];
  const [trending, hot] = await Promise.all([
    getTrending().catch(() => []),
    getHotSearches().catch(() => []),
  ]);
  const seen = new Set();
  const out  = [];
  for (const p of [...trending, ...hot]) {
    const addr = p.baseToken?.address;
    if (!addr || seen.has(addr)) continue;
    const sym  = (p.baseToken.symbol || '').toLowerCase();
    const name = (p.baseToken.name   || '').toLowerCase();
    if (sym.includes(q) || name.includes(q) || addr === query.trim()) {
      seen.add(addr);
      out.push(p);
    }
  }
  return out.slice(0, 5);
}

// ─── Wallets : stats, positions, activité (portfolio) ────────────────────────

const _walletStatsCache    = new Map(); // wallet|period → { ts, stats }
const _walletActivityCache = new Map(); // wallet → { ts, acts }
const _holdingsCache       = new Map(); // wallet → { ts, holdings }
const WALLET_STATS_TTL_MS  = 5 * 60_000;
const WALLET_ACT_TTL_MS    = 60_000;

/** Extrait un tableau de lignes d'une réponse CLI quelle que soit l'enveloppe */
function _rows(resp) {
  const d = resp?.data ?? resp;
  if (Array.isArray(d)) return d;
  if (d && typeof d === 'object') {
    for (const k of ['rank', 'list', 'holdings', 'activities', 'tokens', 'records', 'trades']) {
      if (Array.isArray(d[k])) return d[k];
    }
  }
  return [];
}

/**
 * Statistiques de trading d'un wallet (portfolio stats, cache 5 min).
 * @returns {Promise<Object|null>} winrate, PnL réalisé, ROI, volumétrie, répartition
 */
async function getWalletStats(wallet, period = '7d') {
  const key    = `${wallet}|${period}`;
  const cached = _walletStatsCache.get(key);
  if (cached && Date.now() - cached.ts < WALLET_STATS_TTL_MS) return cached.stats;

  try {
    const resp = await _cli(['portfolio', 'stats', '--wallet', wallet, '--period', period]);
    let d = resp?.data ?? resp;
    if (Array.isArray(d)) d = d[0] || {};          // multi-wallet → première entrée
    if (!d || typeof d !== 'object') return null;
    const ps = d.pnl_stat || {};
    const stats = {
      wallet,
      period,
      balanceNative:   _f(d.native_balance),
      realizedProfit:  _f(d.realized_profit),
      roi:             _f(d.realized_profit_pnl),
      buys:            Math.round(_f(d.buy)),
      sells:           Math.round(_f(d.sell)),
      boughtCostUsd:   _f(d.bought_cost),
      soldIncomeUsd:   _f(d.sold_income),
      tokensTraded:    Math.round(_f(ps.token_num)),
      winrate:         _f(ps.winrate),
      avgHoldingSec:   Math.round(_f(ps.avg_holding_period)),
      // Répartition des PnL par token : grosses pertes → gros multiples
      pnl:             {
        bigLoss:  Math.round(_f(ps.pnl_lt_nd5_num)),   // < -50%
        loss:     Math.round(_f(ps.pnl_nd5_0x_num)),   // -50% à 0
        small:    Math.round(_f(ps.pnl_0x_2x_num)),    // 0 à 2x
        x2to5:    Math.round(_f(ps.pnl_2x_5x_num)),    // 2x à 5x
        moon:     Math.round(_f(ps.pnl_gt_5x_num)),    // > 5x
      },
      tags:            (d.common?.tags || []).slice(0, 5),
      twitterFans:     Math.round(_f(d.common?.twitter_fans_num || d.common?.followers_count)),
      createdTokens:   Math.round(_f(d.common?.created_token_count)),
      raw:             d,
    };
    _walletStatsCache.set(key, { ts: Date.now(), stats });
    return stats;
  } catch {
    return null;
  }
}

/**
 * Activité (trades) d'un wallet (portfolio activity, cache 60s).
 * @returns {Promise<Array<{type, ts, tokenAddress, tokenSymbol, costUsd, priceUsd}>>}
 */
async function getWalletActivity(wallet, { limit = 30, token = null, types = null } = {}) {
  const cached = _walletActivityCache.get(wallet);
  if (!token && !types && cached && Date.now() - cached.ts < WALLET_ACT_TTL_MS) return cached.acts;

  try {
    const args = ['portfolio', 'activity', '--wallet', wallet, '--limit', String(limit)];
    if (token) args.push('--token', token);
    for (const t of types || []) args.push('--type', t);
    const resp = await _cli(args);
    const acts = _rows(resp).map(a => {
      let ts = _f(a.timestamp || a.ts || a.created_at);
      if (ts > 1e12) ts = ts / 1000; // millisecondes → secondes
      return {
        type:         a.event_type || a.side || a.type || '?',
        ts:           Math.round(ts),
        tokenAddress: a.token?.address || a.token_address || a.address || null,
        tokenSymbol:  a.token?.symbol  || a.token_symbol  || a.symbol  || '?',
        costUsd:      _f(a.cost_usd || a.amount_usd || a.usd_amount || a.volume),
        priceUsd:     _f(a.price_usd || a.price),
      };
    }).filter(a => a.tokenAddress);
    if (!token && !types) _walletActivityCache.set(wallet, { ts: Date.now(), acts });
    return acts;
  } catch {
    return [];
  }
}

/**
 * Positions d'un wallet avec PnL réalisé/non réalisé (portfolio holdings, cache 60s).
 * @returns {Promise<Array<{tokenAddress, symbol, usdValue, realizedProfit, unrealizedProfit, totalProfit}>>}
 */
async function getWalletHoldings(wallet, limit = 20) {
  const cached = _holdingsCache.get(wallet);
  if (cached && Date.now() - cached.ts < WALLET_ACT_TTL_MS) return cached.holdings;

  try {
    const resp = await _cli(['portfolio', 'holdings', '--wallet', wallet,
      '--limit', String(Math.min(limit, 50)), '--order-by', 'usd_value', '--direction', 'desc']);
    const holdings = _rows(resp).map(h => {
      const tok = h.token || {};
      return {
        tokenAddress:     tok.address || h.token_address || h.address || null,
        symbol:           tok.symbol  || h.symbol || '?',
        usdValue:         _f(h.usd_value),
        amount:           _f(h.balance || h.amount),
        avgCostUsd:       _f(h.avg_cost || h.history_bought_cost),
        realizedProfit:   _f(h.realized_profit),
        unrealizedProfit: _f(h.unrealized_profit),
        totalProfit:      _f(h.total_profit),
        lastActiveTs:     Math.round(_f(h.last_active_timestamp)),
      };
    }).filter(h => h.tokenAddress);
    _holdingsCache.set(wallet, { ts: Date.now(), holdings });
    return holdings;
  } catch {
    return [];
  }
}

/**
 * Classification déterministe du style de trading d'un wallet (pur code,
 * inspirée du wallet-eval du demo GMGN). Retourne des tags lisibles.
 */
function classifyWallet(stats, activity = []) {
  if (!stats) return [];
  const tags = [];
  const holdH = stats.avgHoldingSec / 3600;

  if (stats.createdTokens > 0 && stats.createdTokens >= stats.tokensTraded / 2) tags.push('dev / créateur de tokens');
  if (stats.tokensTraded >= 500 && holdH < 1)      tags.push('bot / scientifique haute fréquence');
  else if (holdH < 0.5 && stats.tokensTraded >= 50) tags.push('flip rapide / sniper');
  else if (holdH >= 96)                             tags.push('diamond hands (positions longues)');
  if (stats.boughtCostUsd / Math.max(1, stats.buys) >= 5000) tags.push('whale (grosses positions)');
  if (stats.winrate >= 0.55 && stats.realizedProfit > 0)     tags.push('performant (winrate élevé + PnL positif)');
  if (stats.winrate < 0.3 && stats.realizedProfit < 0)       tags.push('bag-holder / degen perdant');
  const totalPnlBuckets = Object.values(stats.pnl).reduce((s, v) => s + v, 0);
  if (totalPnlBuckets > 0 && stats.pnl.bigLoss / totalPnlBuckets > 0.3) tags.push('⚠️ >30% de tokens en perte sévère');
  if (stats.pnl.moon > 0) tags.push(`${stats.pnl.moon} token(s) à +500%`);
  if ((stats.tags || []).includes('smart_degen')) tags.push('🧠 taggé smart money par GMGN');

  return tags.length > 0 ? tags : ['profil neutre / peu de données'];
}

// ─── Track : smart money + KOL en live ───────────────────────────────────────

let _smartCache = { ts: 0, rows: [] };
let _kolCache   = { ts: 0, rows: [] };
const TRACK_TTL_MS = 60_000;

function _normalizeTrackRow(t, source) {
  const tok = t.token || {};
  return {
    source,                                            // 'smart' | 'kol'
    wallet:       t.wallet_address || t.wallet || t.address || null,
    walletName:   t.wallet_name || t.name || t.twitter_username || null,
    side:         (t.event_type || t.side || t.type || '?').toLowerCase(),
    tokenAddress: tok.address || t.token_address || null,
    tokenSymbol:  tok.symbol  || t.token_symbol  || t.symbol || '?',
    amountUsd:    _f(t.amount_usd || t.usd_amount || t.cost_usd || t.volume),
    ts:           Math.round(_f(t.timestamp || t.ts || t.created_at)),
  };
}

/** Trades smart money récents (track smartmoney, cache 60s) */
async function getSmartMoneyTrades(limit = 100) {
  if (Date.now() - _smartCache.ts < TRACK_TTL_MS) return _smartCache.rows;
  try {
    const resp = await _cli(['track', 'smartmoney', '--limit', String(limit)]);
    const rows = _rows(resp).map(t => _normalizeTrackRow(t, 'smart')).filter(t => t.tokenAddress);
    _smartCache = { ts: Date.now(), rows };
    return rows;
  } catch {
    return [];
  }
}

/** Trades KOL récents (track kol, cache 60s) */
async function getKolTrades(limit = 100) {
  if (Date.now() - _kolCache.ts < TRACK_TTL_MS) return _kolCache.rows;
  try {
    const resp = await _cli(['track', 'kol', '--limit', String(limit)]);
    const rows = _rows(resp).map(t => _normalizeTrackRow(t, 'kol')).filter(t => t.tokenAddress);
    _kolCache = { ts: Date.now(), rows };
    return rows;
  } catch {
    return [];
  }
}

/**
 * Agrège les trades smart money + KOL par token : qui achète QUOI maintenant.
 * @returns {Promise<Array<{tokenAddress, symbol, buys, sells, wallets, volumeUsd, kols}>>}
 */
async function getSmartMoneyMoves() {
  const [smart, kol] = await Promise.all([getSmartMoneyTrades(), getKolTrades()]);
  const byToken = new Map();
  for (const t of [...smart, ...kol]) {
    let e = byToken.get(t.tokenAddress);
    if (!e) {
      e = { tokenAddress: t.tokenAddress, symbol: t.tokenSymbol, buys: 0, sells: 0,
            wallets: new Set(), volumeUsd: 0, kols: 0, lastTs: 0 };
      byToken.set(t.tokenAddress, e);
    }
    if (t.side.includes('buy')) e.buys++; else if (t.side.includes('sell')) e.sells++;
    if (t.wallet) e.wallets.add(t.wallet);
    if (t.source === 'kol') e.kols++;
    e.volumeUsd += t.amountUsd;
    if (t.ts > e.lastTs) e.lastTs = t.ts;
  }
  return [...byToken.values()]
    .map(e => ({ ...e, wallets: e.wallets.size }))
    .sort((a, b) => (b.buys - b.sells) - (a.buys - a.sells) || b.volumeUsd - a.volumeUsd);
}

/**
 * Flux smart money/KOL LIVE pour un token précis (depuis les caches track).
 * Utilisé pour enrichir les analyses autonomes d'ARIA.
 */
async function getSmartMoneyForToken(address) {
  const moves = await getSmartMoneyMoves().catch(() => []);
  return moves.find(m => m.tokenAddress === address) || null;
}

// ─── Gates durs (méthodo GMGN — déterministe, avant tout appel LLM) ──────────

/**
 * Gates anti-rug + consensus du demo GMGN.
 * @param {Object} g — champ `_gmgn` d'une paire normalisée
 * @returns {{ ok: boolean, reason?: string, gate?: number }} gate 1=avoid-rug, 2=consensus
 */
function hardGates(g, chain = CHAIN) {
  if (!g) return { ok: true };

  if (g.honeypot)
    return { ok: false, reason: 'GMGN gate: honeypot détecté', gate: 1 };
  // Mint authority = concept Solana ; sur EVM on exige le renounce générique si dispo
  if (chain === 'sol' && GATES.requireRenouncedMint && !g.renouncedMint)
    return { ok: false, reason: 'GMGN gate: mint authority non abandonnée', gate: 1 };
  if (g.buyTax > GATES.maxBuyTax || g.sellTax > GATES.maxSellTax)
    return { ok: false, reason: `GMGN gate: taxes ${(g.buyTax * 100).toFixed(0)}%/${(g.sellTax * 100).toFixed(0)}%`, gate: 1 };
  if (g.rugRatio > GATES.maxRugRatio)
    return { ok: false, reason: `GMGN gate: rug ratio ${(g.rugRatio * 100).toFixed(0)}%`, gate: 1 };
  if (g.bundler > GATES.maxBundlerRatio)
    return { ok: false, reason: `GMGN gate: bundlers ${(g.bundler * 100).toFixed(0)}%`, gate: 1 };
  if (g.devHold > GATES.maxDevHoldingPct)
    return { ok: false, reason: `GMGN gate: dev détient ${(g.devHold * 100).toFixed(0)}%`, gate: 1 };
  if (g.top10 > GATES.maxTop10Concentration)
    return { ok: false, reason: `GMGN gate: top10 ${(g.top10 * 100).toFixed(0)}% concentré`, gate: 1 };
  if (g.confluence < GATES.minConfluence)
    return { ok: false, reason: `GMGN gate: consensus ${g.confluence} (smart ${g.smartDegen}/KOL ${g.renowned}) < ${GATES.minConfluence}`, gate: 2 };

  return { ok: true };
}

// ─── Verdict momentum "golden runner vs bag-holder" (déterministe) ───────────

/**
 * Logique du LLMJudge GMGN (pur code) :
 *  - 1h ET 5m en baisse → reject (saignée, on ne rattrape pas le couteau)
 *  - buy ratio < 42% → reject (vente dominante = distribution / bag-holder)
 *  - buy ratio ≥ 50% et 5m qui tient → pass même après forte hausse (golden runner)
 *  - hausse 1h ≥ 300% = tag "late" (risque de haut de cycle) mais pas un veto
 * @returns {{ verdict: 'pass'|'watch'|'reject', conviction: number, crowd: string, thesis: string }}
 */
function judge(g) {
  const up5 = g.chg5m, up1h = g.chg1h, buy = g.buyRatio;

  if (up1h <= JUDGE.rejectChg1h && up5 <= JUDGE.rejectChg5m) {
    return {
      verdict: 'reject', conviction: 0.3, crowd: 'fading',
      thesis: `Saignée en cours (5m ${(up5 * 100).toFixed(0)}% / 1h ${(up1h * 100).toFixed(0)}%), tendance baissière.`,
    };
  }
  if (buy < JUDGE.buyRatioReject) {
    return {
      verdict: 'reject', conviction: Math.round(Math.min(0.5, 0.2 + buy) * 100) / 100, crowd: 'distributing',
      thesis: `Pression vendeuse dominante (buy ratio ${(buy * 100).toFixed(0)}%) — distribution probable.`,
    };
  }

  const crowd = up1h >= 3.0 ? 'late' : (up5 > 0 && up1h > 0) ? 'early' : 'crowded';
  const sMom  = _clamp((up5 + 0.05) / 0.25);
  const sBuy  = _clamp((buy - 0.45) / 0.20);
  let conv = 0.35 + 0.40 * sMom + 0.20 * sBuy + (up1h > 0 ? 0.05 : 0);
  if (crowd === 'late') conv -= 0.05;
  conv = Math.round(Math.min(0.95, Math.max(0.3, conv)) * 100) / 100;

  const verdict = (buy >= JUDGE.buyRatioPass && up5 > -0.02) ? 'pass' : 'watch';
  const thesis  = `5m ${up5 >= 0 ? '+' : ''}${(up5 * 100).toFixed(0)}% / 1h ${up1h >= 0 ? '+' : ''}${(up1h * 100).toFixed(0)}%, buy ratio ${(buy * 100).toFixed(0)}%` +
    (crowd === 'late' ? ' — déjà haut mais les acheteurs tiennent (golden runner)' : ' — volume et prix montent ensemble') +
    ` ; ${g.smartDegen} smart money + ${g.renowned} KOL présents.`;

  return { verdict, conviction: conv, crowd, thesis };
}

// ─── Token security (snapshot pour le monitoring de fuite) ───────────────────

const _secCache = new Map(); // addr → { ts, snap }

/**
 * Snapshot sécurité normalisé (cache 5 min). null si indisponible.
 * @returns {Promise<{honeypot, renouncedMint, renouncedFreeze, top10}|null>}
 */
async function getTokenSecurity(addr, chain = CHAIN) {
  const key    = `${chain}|${addr}`;
  const cached = _secCache.get(key);
  if (cached && Date.now() - cached.ts < SECURITY_TTL_MS) return cached.snap;

  try {
    const d = await _cli(['token', 'security', '--address', addr], chain);
    const raw  = d?.data && typeof d.data === 'object' ? d.data : d;
    const snap = {
      honeypot:        _b(raw.is_honeypot != null ? raw.is_honeypot : raw.honeypot),
      renouncedMint:   _b(raw.renounced_mint),
      renouncedFreeze: _b(raw.renounced_freeze_account),
      top10:           _f(raw.top_10_holder_rate),
    };
    _secCache.set(key, { ts: Date.now(), snap });
    return snap;
  } catch {
    return null;
  }
}

// ─── Monitoring de fuite (méthodo GMGN — pur code, jamais de LLM ici) ────────

/**
 * Compare le snapshot sécurité actuel à celui de l'entrée en position.
 * Signaux (uniquement les champs stables — burn_ratio exclu volontairement,
 * cf. demo GMGN : sources différentes → faux positifs garantis) :
 *   - honeypot nouvellement déclenché       +60
 *   - mint authority retrouvée (true→false) +55
 *   - top10 en hausse de +15 pts            +22
 * Sévérité ≥ 70 → alerte de fuite.
 * @returns {{ severity: number, signals: Array<{label: string, hit: boolean}> }}
 */
function assessEscape(cur, entry) {
  let severity = 0;
  const signals = [];

  if (cur.honeypot && !entry.honeypot) {
    severity += 60;
    signals.push({ label: 'honeypot nouvellement déclenché', hit: true });
  }
  if (entry.renouncedMint && !cur.renouncedMint) {
    severity += 55;
    signals.push({ label: 'mint authority retrouvée (peut imprimer et dumper)', hit: true });
  }
  if ((cur.top10 || 0) > (entry.top10 || 0) + 0.15) {
    severity += 22;
    signals.push({ label: `concentration top10 montée à ${((cur.top10 || 0) * 100).toFixed(0)}%`, hit: (cur.top10 || 0) > 0.5 });
  }
  if (signals.length === 0) signals.push({ label: 'position saine', hit: false });

  return { severity: Math.min(100, severity), signals };
}

module.exports = {
  isAvailable,
  hasKey,
  getTrending,
  getHotSearches,
  searchToken,
  getTokenInfo,
  getTokenPrice,
  findTrendingRow,
  tokenUrl,
  normalizeRow,
  hardGates,
  judge,
  getTokenSecurity,
  assessEscape,
  // Wallets + smart money live
  getWalletStats,
  getWalletActivity,
  getWalletHoldings,
  classifyWallet,
  getSmartMoneyTrades,
  getKolTrades,
  getSmartMoneyMoves,
  getSmartMoneyForToken,
  GATES,
};
