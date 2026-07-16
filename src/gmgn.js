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

async function _cli(args) {
  const out  = await _exec([...args, '--chain', CHAIN, '--raw']);
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

const DEFAULT_TRENDING_ARGS = [
  'market', 'trending',
  '--interval', '1h', '--order-by', 'volume', '--direction', 'desc',
  '--limit', '100', '--filter', 'not_wash_trading',
];

let _trendingCache = { ts: 0, rows: [] };

/**
 * Récupère le trending GMGN, normalisé au format DexScreener (compatible scanner)
 * avec les champs riches GMGN attachés dans `_gmgn`.
 * @returns {Promise<Object[]>} paires normalisées
 */
async function getTrending() {
  if (Date.now() - _trendingCache.ts < TRENDING_TTL_MS) return _trendingCache.rows;

  const custom = (process.env.GMGN_TRENDING_ARGS || '').trim();
  const args   = custom ? custom.split(/\s+/) : DEFAULT_TRENDING_ARGS;
  const resp   = await _cli(args);
  const data   = resp?.data ?? resp;
  const rows   = (data && typeof data === 'object' && (data.rank || data.tokens)) || [];
  const pairs  = rows.map(normalizeRow).filter(Boolean);

  _trendingCache = { ts: Date.now(), rows: pairs };
  return pairs;
}

/**
 * Normalise une ligne trending gmgn-cli 1.3.9 vers le format DexScreener
 * utilisé dans tout le bot. Les extras GMGN vont dans `_gmgn` (ratios en décimal).
 */
function normalizeRow(row) {
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
    bundler:         _f(row.bundler_rate),
    devHold:         _f(row.dev_team_hold_rate),
    top10:           _f(row.top_10_holder_rate),
    rugRatio:        _f(row.rug_ratio),
    buyTax:          _f(row.buy_tax),
    sellTax:         _f(row.sell_tax),
    honeypot:        _b(row.is_honeypot),
    renouncedMint:   _b(row.renounced_mint),
    renouncedFreeze: _b(row.renounced_freeze_account),
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
    _source:  'gmgn-trending',
    _gmgn:    gmgn,
    chainId:  'solana',
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

// ─── Gates durs (méthodo GMGN — déterministe, avant tout appel LLM) ──────────

/**
 * Gates anti-rug + consensus du demo GMGN.
 * @param {Object} g — champ `_gmgn` d'une paire normalisée
 * @returns {{ ok: boolean, reason?: string, gate?: number }} gate 1=avoid-rug, 2=consensus
 */
function hardGates(g) {
  if (!g) return { ok: true };

  if (g.honeypot)
    return { ok: false, reason: 'GMGN gate: honeypot détecté', gate: 1 };
  if (GATES.requireRenouncedMint && !g.renouncedMint)
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
async function getTokenSecurity(addr) {
  const cached = _secCache.get(addr);
  if (cached && Date.now() - cached.ts < SECURITY_TTL_MS) return cached.snap;

  try {
    const d = await _cli(['token', 'security', '--address', addr]);
    const raw  = d?.data && typeof d.data === 'object' ? d.data : d;
    const snap = {
      honeypot:        _b(raw.is_honeypot != null ? raw.is_honeypot : raw.honeypot),
      renouncedMint:   _b(raw.renounced_mint),
      renouncedFreeze: _b(raw.renounced_freeze_account),
      top10:           _f(raw.top_10_holder_rate),
    };
    _secCache.set(addr, { ts: Date.now(), snap });
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
  normalizeRow,
  hardGates,
  judge,
  getTokenSecurity,
  assessEscape,
  GATES,
};
