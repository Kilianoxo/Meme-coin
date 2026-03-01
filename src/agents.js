/**
 * Système multi-agents IA — Débat Bull vs Bear vs Risk Manager
 *
 * Round 1 (parallèle) : Momentum — vitesse et force du marché
 * Round 2 (parallèle) : Bull (opportunités) + Bear (risques)
 * Round 3 (séquentiel): Risk Manager — décision finale pondérée
 */

const { ask } = require('./anthropic');

const MODEL = 'claude-haiku-4-5-20251001'; // Rapide + économique pour les débats

function formatTokenForAgents(token) {
  return JSON.stringify({
    analysisDate: new Date().toISOString(),
    symbol: token.baseToken?.symbol,
    name: token.baseToken?.name,
    address: token.baseToken?.address,
    priceUsd: token.priceUsd,
    priceChange: token.priceChange,
    volume: token.volume,
    liquidity: token.liquidity,
    marketCap: token.marketCap,
    fdv: token.fdv,
    txns: token.txns,
    dex: token.dexId,
    pairCreatedAt: token.pairCreatedAt
      ? new Date(token.pairCreatedAt).toISOString()
      : null,
  }, null, 2);
}

function formatWhaleData(token, security, overview) {
  const tx = token.txns || {};
  const vol = token.volume || {};

  return JSON.stringify({
    holders: {
      unique:     overview?.holder               ?? null,
      top10Pct:   security?.top10HolderPercent   ?? null,
      creatorPct: security?.creatorPercentage    ?? null,
      ownerPct:   security?.ownerPercentage      ?? null,
    },
    activity: {
      txns: {
        h1:  { buys: tx.h1?.buys  ?? 0, sells: tx.h1?.sells  ?? 0 },
        h6:  { buys: tx.h6?.buys  ?? 0, sells: tx.h6?.sells  ?? 0 },
        h24: { buys: tx.h24?.buys ?? 0, sells: tx.h24?.sells ?? 0 },
      },
      volume: { h1: vol.h1 ?? 0, h24: vol.h24 ?? 0 },
    },
    marketCap: token.marketCap?.usd ?? null,
    liquidity:  token.liquidity?.usd ?? null,
  }, null, 2);
}

function formatMomentumData(token) {
  const pc = token.priceChange || {};
  const vol = token.volume || {};
  const tx = token.txns || {};
  const h1 = tx.h1 || {};
  const h6 = tx.h6 || {};
  const h24 = tx.h24 || {};

  return JSON.stringify({
    priceChange: { h1: pc.h1 ?? 0, h6: pc.h6 ?? 0, h24: pc.h24 ?? 0 },
    volume:      { h1: vol.h1 ?? 0, h6: vol.h6 ?? 0, h24: vol.h24 ?? 0 },
    txns: {
      h1:  { buys: h1.buys  ?? 0, sells: h1.sells  ?? 0 },
      h6:  { buys: h6.buys  ?? 0, sells: h6.sells  ?? 0 },
      h24: { buys: h24.buys ?? 0, sells: h24.sells ?? 0 },
    },
  }, null, 2);
}

function parseAgentJson(text, fallback) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  try {
    return JSON.parse(match[0]);
  } catch {
    return fallback;
  }
}

/**
 * Agent MOMENTUM — Analyse la vitesse et la force du marché (Round 1)
 * Retourne: { score: 0-10, trend: string, buyPressure: 0-10, volumeSignal: string,
 *             signals: string[], warning: string|null }
 */
async function runMomentumAgent(token) {
  const system = `Tu es un agent spécialisé dans l'analyse du momentum de tokens Solana.
Tu analyses UNIQUEMENT les signaux de vitesse et de force du marché — pas les fondamentaux, pas les narratives.

Signaux à analyser:
1. Tendance prix: compare priceChange.h1 avec priceChange.h6/6 (rythme horaire moyen)
   → h1 > h6/6 = accélération, h1 < h6/6 = ralentissement
2. Tendance volume: compare volume.h1 avec volume.h6/6
   → h1 > h6/6 = volume croissant, sinon décroissant
3. Pression d'achat: buys/(buys+sells) sur h1 et h6 — les acheteurs dominent-ils?
4. Cohérence signal:
   • prix UP + volume UP + buy ratio > 60% → momentum authentique
   • prix UP + volume FLAT + peu de txns   → pump suspect (warning)
   • prix DOWN + volume UP                 → distribution, danger (warning)
   • prix FLAT + buy ratio élevé           → accumulation silencieuse

Patterns (trend):
- ACCELERATING : prix accélère sur h1 vs h6, volume croissant, buy dominance
- STABLE        : mouvement régulier sans accélération notable
- FADING        : prix positif mais h1 < h6/6, volume décroissant
- REVERSAL      : h1 opposé en direction à h24 (inversion de tendance)

Calcule buyPressure = (buys_h1 / (buys_h1 + sells_h1)) × 10, arrondi à 1 décimale.
Si buys_h1 + sells_h1 = 0, utilise les données h6.

Réponds UNIQUEMENT avec ce JSON (pas d'autre texte):
{"score": <0-10>, "trend": "ACCELERATING|STABLE|FADING|REVERSAL", "buyPressure": <0.0-10.0>, "volumeSignal": "GROWING|STABLE|DECLINING", "signals": ["signal court 1", "signal court 2"], "warning": <"texte" ou null>}`;

  const text = await ask(system, `Analyse le momentum:\n${formatMomentumData(token)}`, MODEL);
  return parseAgentJson(text, {
    score: 5,
    trend: 'STABLE',
    buyPressure: 5.0,
    volumeSignal: 'STABLE',
    signals: ['Données insuffisantes pour l\'analyse momentum'],
    warning: null,
  });
}

/**
 * Agent WHALE — Analyse la structure de détention et détecte les manipulations (Round 1)
 * Données: top10/créateur/owner %, holder count, cross-check activité vs concentration
 * Retourne: { score: 0-10, concentrationRisk: string, distributionSignal: string,
 *             holderHealth: string, signals: string[], warning: string|null }
 */
async function runWhaleAgent(token, security = null, overview = null) {
  // Sans données Birdeye, score neutre — pas la peine de solliciter le LLM
  if (!security && !overview) {
    return {
      score: 5,
      concentrationRisk: 'MEDIUM',
      distributionSignal: 'NEUTRAL',
      holderHealth: 'MODERATE',
      signals: ['Données de holders indisponibles (clé Birdeye manquante)'],
      warning: null,
    };
  }

  const system = `Tu es un agent spécialisé dans l'analyse de la structure de détention des tokens Solana.
Tu évalues la santé distributionnelle du token et détectes les schémas de manipulation par gros wallets.

ANALYSE DES DONNÉES:
1. Concentration (top10Pct, creatorPct, ownerPct):
   - top10Pct > 80% → CRITICAL | 60-80% → HIGH | 40-60% → MEDIUM | < 40% → LOW
   - creatorPct > 15% → flag majeur (risque de dump créateur)
   - ownerPct > 10% → flag supplémentaire

2. Santé du réseau (unique holders):
   - < 100 → CRITICAL | 100-500 → THIN | 500-2000 → MODERATE | > 2000 → HEALTHY

3. Signal de distribution (cross-check activité h24 + concentration):
   - buys > 65% des txns h24 ET holders > 500 → ACCUMULATING (positif)
   - buys < 35% des txns h24                  → DISTRIBUTING (négatif, whales sortent)
   - Sinon                                     → NEUTRAL

4. Patterns de manipulation (warning si détecté):
   - Volume h1 élevé + holders < 200 → probable wash trading
   - buy ratio > 80% h1 mais holders < 300 → pump coordonné suspect
   - creatorPct > 20% + prix en hausse → précondition dump classique

Calcule score 0-10:
  Base 10, puis:
  - concentrationRisk: CRITICAL -5 | HIGH -3 | MEDIUM -1 | LOW 0
  - holderHealth: HEALTHY +1 | MODERATE 0 | THIN -1 | CRITICAL -2
  - distributionSignal: ACCUMULATING +1 | NEUTRAL 0 | DISTRIBUTING -2
  Clamp entre 0 et 10.

Réponds UNIQUEMENT avec ce JSON (pas d'autre texte):
{"score": <0-10>, "concentrationRisk": "LOW|MEDIUM|HIGH|CRITICAL", "distributionSignal": "ACCUMULATING|NEUTRAL|DISTRIBUTING", "holderHealth": "HEALTHY|MODERATE|THIN|CRITICAL", "signals": ["signal court 1", "signal court 2"], "warning": <"texte" ou null>}`;

  const text = await ask(system, `Analyse la structure de détention:\n${formatWhaleData(token, security, overview)}`, MODEL);
  return parseAgentJson(text, {
    score: 5,
    concentrationRisk: 'MEDIUM',
    distributionSignal: 'NEUTRAL',
    holderHealth: 'MODERATE',
    signals: ['Données insuffisantes pour l\'analyse whale'],
    warning: null,
  });
}

/**
 * Agent BULL — Optimiste, cherche les opportunités (Round 2)
 * Reçoit le résultat Momentum du Round 1 pour affiner son score.
 * @param {Object} momentum - Résultat de runMomentumAgent (optionnel)
 * Retourne: { score: 0-10, arguments: string[], entryReason: string, narrative: string|null }
 */
async function runBullAgent(token, momentum = null) {
  const system = `Tu es un analyste crypto OPTIMISTE spécialisé dans les meme coins Solana.
Tu analyses les données de marché pour identifier les opportunités de trading à court terme.

IMPORTANT — Narrative:
Le champ "analysisDate" indique la date réelle. Évalue si le nom/symbole surfe sur une narrative
d'actualité forte (géopolitique, culture pop, tendances crypto). Narrative forte = multiplicateur hype.

IMPORTANT — Intégration du Momentum (pré-calculé par un agent spécialisé):
Utilise le résumé momentum pour moduler ton score final:
- trend ACCELERATING + buyPressure > 7  → signal fort, ajouter +1 à +2 au score
- trend STABLE                          → neutre, pas d'ajustement
- trend FADING                          → tempère l'optimisme, -1 au score
- trend REVERSAL                        → contre-signal sérieux, -2 au score
- momentum.warning présent              → mentionner comme nuance dans les arguments

Sois factuel et concis. Ne dépasse pas 3 arguments.

Réponds UNIQUEMENT avec ce JSON (pas d'autre texte):
{"score": <0-10>, "arguments": ["arg1", "arg2", "arg3"], "entryReason": "raison principale", "narrative": "contexte narratif ou null"}`;

  let content = `Analyse ce token:\n${formatTokenForAgents(token)}`;

  if (momentum) {
    content += `\n\nMomentum (pré-calculé par agent spécialisé):
- Score: ${momentum.score}/10  |  Tendance: ${momentum.trend}
- Pression d'achat: ${momentum.buyPressure}/10  |  Volume: ${momentum.volumeSignal}
- Signaux: ${JSON.stringify(momentum.signals)}${momentum.warning ? `\n- ⚠️ Warning: ${momentum.warning}` : ''}`;
  }

  const text = await ask(system, content, MODEL);
  return parseAgentJson(text, {
    score: 5,
    arguments: ['Données insuffisantes pour une analyse précise'],
    entryReason: 'Analyse impossible',
    narrative: null,
  });
}

/**
 * Agent BEAR — Pessimiste, détecte rug pulls et scams (Round 2)
 * Reçoit le résultat Whale du Round 1 — n'analyse plus les holders directement.
 * @param {Object} token     - Données DexScreener
 * @param {Object} security  - Données Birdeye security: mint/freeze authority (optionnel)
 * @param {Object} rugReport - Résumé RugCheck (optionnel)
 * @param {Object} lpLock    - Données LP lock — { lpLockedPct, lpLockedUSD, isLocked } (optionnel)
 * @param {Object} whale     - Résultat de runWhaleAgent (optionnel)
 * Retourne: { riskScore: 0-10, redFlags: string[], verdict: "AVOID|CAUTION|OK" }
 */
async function runBearAgent(token, security = null, rugReport = null, lpLock = null, whale = null) {
  const system = `Tu es un analyste crypto PESSIMISTE spécialisé dans la détection de rug pulls et scams sur Solana.

TON PÉRIMÈTRE (ne pas déborder hors de ces sujets):
- Sécurité on-chain: mint authority, freeze authority
- Liquidité: LP lock, liquidité trop basse
- RugCheck: score de risque, historique rugpull, risques détectés
- Marché: volume artificiel (txns faibles vs volume élevé), token trop récent, mcap/fdv suspect
- Narrative: nom/symbole opportuniste sans substance réelle

IMPORTANT — Whale (pré-calculé par agent spécialisé):
L'analyse des holders et concentration est déjà faite. Tu reçois son verdict.
Si concentrationRisk = HIGH/CRITICAL ou distributionSignal = DISTRIBUTING → red flag structurel.
Ne répète pas l'analyse, cite le verdict en une phrase si c'est un red flag.

Sois factuel et concis. Ne dépasse pas 3 red flags.

Réponds UNIQUEMENT avec ce JSON (pas d'autre texte):
{"riskScore": <0-10>, "redFlags": ["flag1", "flag2"], "verdict": "AVOID|CAUTION|OK"}`;

  let content = `Analyse les risques de ce token:\n${formatTokenForAgents(token)}`;

  if (security) {
    content += `\n\nSécurité on-chain (Birdeye):
- Mint authority: ${security.mintAuthority ? '⚠️ ACTIVE (peut créer de nouveaux tokens)' : '✅ Révoquée'}
- Freeze authority: ${security.freezeAuthority ? '⚠️ ACTIVE (peut geler les wallets)' : '✅ Révoquée'}`;
  }

  if (lpLock != null) {
    const pct = lpLock.lpLockedPct.toFixed(1);
    const usd = lpLock.lpLockedUSD >= 1000
      ? `$${(lpLock.lpLockedUSD / 1000).toFixed(1)}K`
      : `$${lpLock.lpLockedUSD.toFixed(0)}`;
    content += `\n\nLiquidité verrouillée (LP lock):
- % verrouillé: ${pct}% (${usd} USD)`;
    if (!lpLock.isLocked) {
      content += `\n⚠️ Liquidité peu ou pas verrouillée — rug pull classique possible`;
    }
  }

  if (rugReport) {
    content += `\n\nAnalyse RugCheck:
- Score de risque: ${rugReport.score}/1000 (${rugReport.riskLevel}) — plus haut = plus dangereux
- Déjà rugpull: ${rugReport.rugged ? '🔴 OUI' : '✅ Non'}`;
    if (rugReport.significantRisks.length > 0) {
      content += `\n- Risques détectés:\n${rugReport.significantRisks.map((r) => `  • ${r}`).join('\n')}`;
    }
  }

  if (whale) {
    content += `\n\nVerdiet Whale (pré-calculé):
- Concentration: ${whale.concentrationRisk}  |  Holders: ${whale.holderHealth}  |  Distribution: ${whale.distributionSignal}${whale.warning ? `\n- ⚠️ ${whale.warning}` : ''}`;
  }

  const text = await ask(system, content, MODEL);
  return parseAgentJson(text, {
    riskScore: 8,
    redFlags: ['Impossible d\'analyser les risques correctement'],
    verdict: 'CAUTION',
  });
}

/**
 * Risk Manager — Décision finale basée sur Bull + Bear + Momentum + Whale
 * @param {Object} momentum - Résultat de runMomentumAgent (optionnel)
 * @param {Object} whale    - Résultat de runWhaleAgent (optionnel)
 * Retourne: { decision: "BUY|SKIP|WAIT", confidence: 0-10, suggestedAmountPct: number,
 *             stopLossPct: number, takeProfitPct: number, reasoning: string }
 */
async function runRiskManager(token, bullAnalysis, bearAnalysis, momentum = null, whale = null) {
  const system = `Tu es le gestionnaire de risque d'un bot de trading meme coins Solana.
Tu reçois 4 analyses spécialisées et prends la décision finale.

Règles de base:
- Si bear.riskScore >= 8                                        → toujours SKIP
- Si bear.riskScore >= 6 ET bull.score <= 5                    → SKIP
- Si whale.concentrationRisk = "CRITICAL"                      → toujours SKIP
- Si whale.distributionSignal = "DISTRIBUTING"                 → SKIP ou WAIT
- Si momentum.trend = "REVERSAL"                               → penché fortement vers SKIP
- Si momentum.warning != null OU whale.warning != null         → red flag supplémentaire
- Si liquidity < 10000 USD                                     → SKIP
- Si volume 24h < 50000 USD                                    → WAIT ou SKIP
- suggestedAmountPct: max 5% du portfolio, commence à 1% si incertain
- stopLossPct: défaut 20%, takeProfitPct: défaut 50%
- Si momentum.trend = "ACCELERATING" ET whale.holderHealth != "CRITICAL" ET bear.riskScore < 5
  → augmenter takeProfitPct et confidence

Réponds UNIQUEMENT avec ce JSON (pas d'autre texte):
{"decision": "BUY|SKIP|WAIT", "confidence": <0-10>, "suggestedAmountPct": <1-5>,
 "stopLossPct": <5-50>, "takeProfitPct": <10-200>, "reasoning": "explication courte"}`;

  let content = `Token: ${formatTokenForAgents(token)}

Analyse BULL (score ${bullAnalysis.score}/10):
${JSON.stringify(bullAnalysis, null, 2)}

Analyse BEAR (risque ${bearAnalysis.riskScore}/10, verdict: ${bearAnalysis.verdict}):
${JSON.stringify(bearAnalysis, null, 2)}`;

  if (momentum) {
    content += `\n\nAnalyse MOMENTUM (score ${momentum.score}/10, trend: ${momentum.trend}):
${JSON.stringify(momentum, null, 2)}`;
  }

  if (whale) {
    content += `\n\nAnalyse WHALE (score ${whale.score}/10, concentration: ${whale.concentrationRisk}, holders: ${whale.holderHealth}):
${JSON.stringify(whale, null, 2)}`;
  }

  const text = await ask(system, content, MODEL);
  return parseAgentJson(text, {
    decision: 'SKIP',
    confidence: 0,
    suggestedAmountPct: 0,
    stopLossPct: 20,
    takeProfitPct: 50,
    reasoning: 'Erreur lors de la décision finale',
  });
}

/**
 * Lance le débat complet entre les agents pour un token
 *
 * Round 1 (parallèle)  : Momentum + Whale — agents de données spécialisés
 * Round 2 (parallèle)  : Bull(momentum) + Bear(whale) — agents de débat enrichis
 * Round 3 (séquentiel) : Risk Manager — décision finale avec toutes les analyses
 *
 * @param {Object} token     - Données de paire DexScreener
 * @param {Object} security  - Données de sécurité Birdeye (optionnel)
 * @param {Object} rugReport - Résumé RugCheck (optionnel)
 * @param {Object} overview  - Données Birdeye overview — holder count (optionnel)
 * @param {Object} lpLock    - Données LP lock — { lpLockedPct, lpLockedUSD, isLocked } (optionnel)
 * @returns {Promise<{bull, bear, momentum, whale, decision, token, security, rugReport, overview, lpLock}>}
 */
async function runDebate(token, security = null, rugReport = null, overview = null, lpLock = null) {
  const symbol = token.baseToken?.symbol || '???';
  const sources = [
    security ? 'Birdeye' : null,
    overview ? `${overview.holder ?? '?'} holders` : null,
    lpLock != null ? `LP ${lpLock.lpLockedPct.toFixed(0)}%` : null,
    rugReport ? 'RugCheck' : null,
  ].filter(Boolean);
  const sourceStr = sources.length > 0 ? ` (${sources.join(' | ')})` : '';
  console.log(`[Agents] Débat pour ${symbol}${sourceStr}...`);

  // Round 1: agents de données en parallèle
  const [momentum, whale] = await Promise.all([
    runMomentumAgent(token),
    runWhaleAgent(token, security, overview),
  ]);

  // Round 2: agents de débat enrichis par Round 1 (en parallèle)
  const [bull, bear] = await Promise.all([
    runBullAgent(token, momentum),
    runBearAgent(token, security, rugReport, lpLock, whale),
  ]);

  // Round 3: décision finale
  const decision = await runRiskManager(token, bull, bear, momentum, whale);

  console.log(
    `[Agents] ${symbol} → ${decision.decision} | confiance ${decision.confidence}/10` +
    ` | momentum ${momentum.score}/10 (${momentum.trend})` +
    ` | whale ${whale.score}/10 (${whale.concentrationRisk})`
  );

  return { bull, bear, momentum, whale, decision, token, security, rugReport, overview, lpLock };
}

module.exports = { runDebate, runMomentumAgent, runWhaleAgent };
