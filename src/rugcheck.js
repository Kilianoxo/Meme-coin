/**
 * Client RugCheck — Détection de rugpull / honeypot sur Solana
 *
 * API publique gratuite, aucune clé requise.
 * Doc: https://api.rugcheck.xyz/swagger/index.html
 *
 * Score de risque (cumulatif):
 *   0–300   : Faible risque  ✅
 *   300–700 : Risque modéré  ⚠️
 *   700+    : Risque élevé   🔴
 *
 * Niveaux de risque retournés par l'API:
 *   "info"   → informatif, pas bloquant
 *   "warn"   → à surveiller
 *   "danger" → signal fort de scam / rug
 */

const BASE_URL = 'https://api.rugcheck.xyz/v1';

/**
 * Récupère le rapport RugCheck d'un token Solana
 * @param {string} mint - Adresse du token
 * @returns {Promise<Object|null>}
 * {
 *   score: number,           // Score de risque cumulatif (plus haut = plus dangereux)
 *   rugged: boolean,         // true si le token a déjà été rugpull
 *   risks: Array<{           // Liste des risques détectés
 *     name: string,
 *     description: string,
 *     level: "info"|"warn"|"danger",
 *     score: number,
 *   }>,
 * }
 */
async function getTokenReport(mint) {
  try {
    const res = await fetch(`${BASE_URL}/tokens/${mint}/report/summary`, {
      headers: { 'accept': 'application/json' },
      signal: AbortSignal.timeout(8_000), // 8s timeout
    });

    if (res.status === 404) return null; // Token inconnu de RugCheck
    if (!res.ok) return null;

    const json = await res.json();

    // Normalise la réponse — certains champs peuvent manquer selon la version de l'API
    return {
      score: json.score ?? 0,
      rugged: json.rugged ?? false,
      risks: Array.isArray(json.risks) ? json.risks : [],
    };
  } catch {
    return null; // Timeout ou erreur réseau → silencieux
  }
}

/**
 * Hard filter RugCheck — true si le token est trop dangereux pour être analysé
 * Règles (assouplies pour tokens trendy établis):
 *   - Déjà rugpull → DANGER absolu
 *   - Score > 1200 → trop risqué (800 bloquait trop de tokens légitimes)
 *   - Risque "danger" sur mint authority ou honeypot uniquement (LP lock ignoré)
 */

// Risques "danger" qui bloquent réellement (rug/honeypot)
const HARD_DANGER_RISKS = new Set([
  'Honeypot',
  'Freeze Authority still enabled',
  'Mint Authority still enabled',
  'Copycat Token',
]);

function isHardBlocked(report) {
  if (!report) return false; // Pas de données = on laisse passer (silencieux)

  if (report.rugged) return true;
  if (report.score > 1200) return true;
  if (report.risks.some((r) => r.level === 'danger' && HARD_DANGER_RISKS.has(r.name))) return true;

  return false;
}

/**
 * Résumé court pour les agents IA
 * Retourne uniquement les risques warn + danger (pas les info)
 */
function summarizeForAgents(report) {
  if (!report) return null;

  const significantRisks = report.risks
    .filter((r) => r.level === 'warn' || r.level === 'danger')
    .map((r) => `[${r.level.toUpperCase()}] ${r.name}: ${r.description}`);

  return {
    score: report.score,
    rugged: report.rugged,
    riskLevel: report.score < 300 ? 'LOW' : report.score < 700 ? 'MODERATE' : 'HIGH',
    significantRisks,
  };
}

/**
 * Formate le rapport pour l'affichage Telegram (HTML)
 */
function formatReport(report) {
  if (!report) return null;

  const scoreEmoji = report.score < 300 ? '✅' : report.score < 700 ? '⚠️' : '🔴';
  const dangers = report.risks.filter((r) => r.level === 'danger');
  const warns = report.risks.filter((r) => r.level === 'warn');

  return {
    scoreEmoji,
    score: report.score,
    rugged: report.rugged,
    dangers: dangers.map((r) => r.name),
    warns: warns.map((r) => r.name),
  };
}

/**
 * Récupère les données de verrouillage de liquidité via le rapport complet RugCheck
 * Endpoint: GET /v1/tokens/{mint}/report (plus lourd que /summary, mais contient markets[].lp)
 * @returns {Promise<{ lpLockedPct: number, lpLockedUSD: number, isLocked: boolean }|null>}
 */
async function getLpLockData(mint) {
  try {
    const res = await fetch(`${BASE_URL}/tokens/${mint}/report`, {
      headers: { 'accept': 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });

    if (res.status === 404) return null;
    if (!res.ok) return null;

    const json = await res.json();
    const markets = Array.isArray(json.markets) ? json.markets : [];
    if (markets.length === 0) return null;

    // Marché principal = le plus de liquidité totale
    const main = markets.reduce((best, m) => {
      const bestLiq = (best.liquidityA ?? 0) + (best.liquidityB ?? 0);
      const mLiq = (m.liquidityA ?? 0) + (m.liquidityB ?? 0);
      return mLiq > bestLiq ? m : best;
    });

    const lp = main?.lp ?? {};
    const lpLockedPct = lp.lpLockedPct ?? 0;
    const lpLockedUSD = lp.lpLockedUSD ?? 0;

    return {
      lpLockedPct,
      lpLockedUSD,
      isLocked: lpLockedPct >= 80,
    };
  } catch {
    return null;
  }
}

module.exports = { getTokenReport, getLpLockData, isHardBlocked, summarizeForAgents, formatReport };
