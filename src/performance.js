/**
 * Mesure de performance — quels signaux et quelles notes gagnent vraiment.
 *
 * Unité = la POSITION (achat → dernière vente), pas la ligne de vente : une
 * position sortie en 3 paliers compte pour 1 trade, PnL = somme des ventes.
 * Chaque position porte `entry.signals` (pourquoi elle a été ouverte) et les
 * notes d'entrée (score final, score quantitatif, score LLM) → on peut voir
 * quel signal et quel score prédisent réellement un gain.
 */

const SIGNAL_LABELS = {
  smart_money: 'Smart money massive',
  rotation:    'Rotation KOL + smart money',
  live_flow:   'Flux smart money live',
  rupture:     'Rupture de score',
  micro_cap:   'Micro-cap saine',
  early:       'Source early (5 min)',
  score_seul:  'Score seul',
  copy_trade:  'Copy-trading',
  manuel:      'Achat manuel',
  import:      'Importé',
  inconnu:     'Avant étiquetage',
};

const SCORE_BUCKETS = [
  { label: '< 55',   min: -Infinity, max: 55 },
  { label: '55–64',  min: 55, max: 65 },
  { label: '65–74',  min: 65, max: 75 },
  { label: '75–84',  min: 75, max: 85 },
  { label: '≥ 85',   min: 85, max: Infinity },
];

/**
 * Reconstruit les positions fermées depuis l'historique du trader réel.
 * Les lignes antérieures à l'étiquetage (sans positionId) sont regroupées par
 * token pour ne pas être perdues, avec le signal "inconnu".
 */
function closedPositionsFromHistory(history = []) {
  const buys = new Map();   // positionId → BUY
  const groups = new Map(); // clé → { buy, sells[] }
  const open = new Set();

  for (const h of history) {
    if (h.action === 'BUY' && h.positionId) buys.set(h.positionId, h);
  }
  for (const h of history) {
    if (h.action !== 'SELL') continue;
    const key = h.positionId || `legacy-${h.tokenMint}`;
    // Une vente totale clôt la position même si son PnL est inconnu (vente hors bot)
    if (h.pct === 100) open.delete(key); else open.add(key);
    if (h.pnlSol == null) continue;
    if (!groups.has(key)) groups.set(key, { buy: h.positionId ? buys.get(h.positionId) : null, sells: [] });
    groups.get(key).sells.push(h);
  }

  const out = [];
  for (const [key, { buy, sells }] of groups) {
    // Position encore partiellement ouverte (palier pris, reste en cours) → pas encore jugée
    if (open.has(key) && !key.startsWith('legacy-')) continue;
    const last = sells[sells.length - 1];
    const pnlSol = sells.reduce((s, x) => s + x.pnlSol, 0);
    const cost = buy?.solSpent ?? null;
    out.push({
      key,
      symbol:    buy?.symbol || last.symbol || null,
      signals:   buy?.entry?.signals || last.entrySignals || ['inconnu'],
      score:     buy?.entry?.score ?? null,
      quant:     buy?.entry?.quantScore ?? null,
      llm:       buy?.entry?.llmScore ?? null,
      pnlSol,
      pnlPct:    cost ? (pnlSol / cost) * 100 : null,
      exit:      last.exitReason || null,
      closedAt:  last.timestamp,
      holdMin:   buy?.entryTimestamp ? Math.round((last.timestamp - buy.entryTimestamp) / 60_000) : null,
    });
  }
  return out.sort((a, b) => a.closedAt - b.closedAt);
}

/** Positions fermées du paper trader (déjà une ligne par position) */
function closedPositionsFromPaper(history = []) {
  return history.map(h => ({
    key: `${h.address}-${h.entryTime}`,
    symbol: h.symbol,
    signals: h.entry?.signals || ['inconnu'],
    score: h.score ?? null,
    quant: h.entry?.quantScore ?? null,
    llm:   h.entry?.llmScore ?? null,
    pnlSol: h.pnlSol,
    pnlPct: h.pnlPct,
    exit: h.reason,
    closedAt: h.exitTime,
    holdMin: h.entryTime ? Math.round((h.exitTime - h.entryTime) / 60_000) : null,
  }));
}

function _agg(list) {
  const n = list.length;
  const wins = list.filter(p => p.pnlSol > 0).length;
  const pnl = list.reduce((s, p) => s + p.pnlSol, 0);
  const pcts = list.map(p => p.pnlPct).filter(v => v != null);
  return {
    trades:   n,
    wins,
    winRate:  n ? Math.round((wins / n) * 100) : null,
    pnlSol:   parseFloat(pnl.toFixed(4)),
    avgPct:   pcts.length ? parseFloat((pcts.reduce((a, b) => a + b, 0) / pcts.length).toFixed(1)) : null,
  };
}

/** Résultats par signal d'entrée (une position multi-signaux compte dans chacun) */
function bySignal(closed) {
  const m = new Map();
  for (const p of closed) for (const s of p.signals) {
    if (!m.has(s)) m.set(s, []);
    m.get(s).push(p);
  }
  return [...m.entries()]
    .map(([signal, list]) => ({ signal, label: SIGNAL_LABELS[signal] || signal, ..._agg(list) }))
    .sort((a, b) => b.trades - a.trades);
}

/** Résultats par tranche de note — dit si un score plus haut gagne vraiment plus */
function byScore(closed, field = 'score') {
  return SCORE_BUCKETS.map(b => {
    const list = closed.filter(p => p[field] != null && p[field] >= b.min && p[field] < b.max);
    return { bucket: b.label, ..._agg(list) };
  }).filter(r => r.trades > 0);
}

function summary(closed) {
  return {
    ..._agg(closed),
    bySignal: bySignal(closed),
    byScore:  byScore(closed, 'score'),
    byQuant:  byScore(closed, 'quant'),
    byLlm:    byScore(closed, 'llm'),
  };
}

module.exports = { closedPositionsFromHistory, closedPositionsFromPaper, bySignal, byScore, summary, SIGNAL_LABELS };
