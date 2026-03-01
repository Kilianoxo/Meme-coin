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
 * Règles:
 *   - Déjà rugpull → DANGER absolu
 *   - Score > 800  → trop risqué
 *   - Au moins un risque de niveau "danger" → bloquant
 */
function isHardBlocked(report) {
  if (!report) return false; // Pas de données = on laisse passer (silencieux)

  if (report.rugged) return true;
  if (report.score > 800) return true;
  if (report.risks.some((r) => r.level === 'danger')) return true;

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

module.exports = { getTokenReport, isHardBlocked, summarizeForAgents, formatReport };
