/**
 * Système multi-agents IA — Débat Bull vs Bear vs Risk Manager
 *
 * Bull Agent    → Cherche les opportunités d'achat
 * Bear Agent    → Cherche les risques et red flags
 * Risk Manager  → Prend la décision finale
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
 * Agent BULL — Optimiste, cherche les opportunités
 * Retourne: { score: 0-10, arguments: string[], entryReason: string }
 */
async function runBullAgent(token) {
  const system = `Tu es un analyste crypto OPTIMISTE spécialisé dans les meme coins Solana.
Tu analyses les données de marché pour identifier les opportunités de trading à court terme.
Tu te concentres sur: momentum des prix, volume croissant, liquidité suffisante, hype.

IMPORTANT — Analyse du nom et de la narrative:
Le champ "analysisDate" indique la date réelle d'analyse. Utilise ta connaissance des événements
mondiaux récents (géopolitique, culture pop, tendances crypto) pour évaluer si le nom/symbole du token
surfe sur une narrative d'actualité forte (ex: conflit géopolitique, personnalité virale, mème en vogue).
Une narrative d'actualité forte = multiplicateur de hype à court terme.

Sois factuel et concis. Ne dépasse pas 3 arguments.

Réponds UNIQUEMENT avec ce JSON (pas d'autre texte):
{"score": <0-10>, "arguments": ["arg1", "arg2", "arg3"], "entryReason": "raison principale", "narrative": "contexte narratif détecté ou null"}`;

  const text = await ask(system, `Analyse ce token:\n${formatTokenForAgents(token)}`, MODEL);
  return parseAgentJson(text, {
    score: 5,
    arguments: ['Données insuffisantes pour une analyse précise'],
    entryReason: 'Analyse impossible',
  });
}

/**
 * Agent BEAR — Pessimiste, cherche les risques
 * @param {Object} token    - Données DexScreener
 * @param {Object} security - Données Birdeye (optionnel)
 * Retourne: { riskScore: 0-10, redFlags: string[], verdict: "AVOID|CAUTION|OK" }
 */
async function runBearAgent(token, security = null) {
  const system = `Tu es un analyste crypto PESSIMISTE spécialisé dans la détection de rug pulls et scams sur Solana.
Tu cherches: liquidité trop basse, volume artificiel (txns faibles vs volume élevé), token trop récent,
market cap vs fdv suspect, absence de holders, prix en chute libre.
Si des données de sécurité on-chain sont fournies, utilise-les en priorité (mint authority, concentration holders).

IMPORTANT — Narrative du nom:
Évalue aussi si le nom/symbole semble être un opportunisme narratif sans substance
(ex: nom collé à une actu mais aucune communauté réelle derrière, copie d'un token existant déjà établi).
Une narrative forcée ou déjà exploitée par d'autres tokens = red flag supplémentaire.

Sois factuel et concis. Ne dépasse pas 3 red flags.

Réponds UNIQUEMENT avec ce JSON (pas d'autre texte):
{"riskScore": <0-10>, "redFlags": ["flag1", "flag2"], "verdict": "AVOID|CAUTION|OK"}`;

  let content = `Analyse les risques de ce token:\n${formatTokenForAgents(token)}`;

  if (security) {
    content += `\n\nDonnées sécurité on-chain (Birdeye):
- Mint authority: ${security.mintAuthority ? '⚠️ ACTIVE (peut créer de nouveaux tokens)' : '✅ Révoquée'}
- Freeze authority: ${security.freezeAuthority ? '⚠️ ACTIVE (peut geler les wallets)' : '✅ Révoquée'}
- Top 10 holders: ${security.top10HolderPercent?.toFixed(1) ?? '?'}% du supply
- Part du créateur: ${security.creatorPercentage?.toFixed(1) ?? '?'}% du supply
- Part de l'owner: ${security.ownerPercentage?.toFixed(1) ?? '?'}% du supply`;
  }

  const text = await ask(system, content, MODEL);
  return parseAgentJson(text, {
    riskScore: 8,
    redFlags: ['Impossible d\'analyser les risques correctement'],
    verdict: 'CAUTION',
  });
}

/**
 * Risk Manager — Décision finale basée sur les deux analyses
 * Retourne: { decision: "BUY|SKIP|WAIT", confidence: 0-10, suggestedAmountPct: number,
 *             stopLossPct: number, takeProfitPct: number, reasoning: string }
 */
async function runRiskManager(token, bullAnalysis, bearAnalysis) {
  const system = `Tu es le gestionnaire de risque d'un bot de trading meme coins Solana.
Tu reçois l'analyse du bull (opportunités) et du bear (risques) et prends une décision finale.

Règles de base:
- Si riskScore bear >= 8: toujours SKIP
- Si riskScore bear >= 6 ET score bull <= 5: SKIP
- Si liquidity < 10000 USD: SKIP
- Si volume 24h < 50000 USD: WAIT ou SKIP
- suggestedAmountPct: max 5% du portfolio, commence à 1% si incertain
- stopLossPct: défaut 20%, takeProfitPct: défaut 50%

Réponds UNIQUEMENT avec ce JSON (pas d'autre texte):
{"decision": "BUY|SKIP|WAIT", "confidence": <0-10>, "suggestedAmountPct": <1-5>,
 "stopLossPct": <5-50>, "takeProfitPct": <10-200>, "reasoning": "explication courte"}`;

  const content = `Token: ${formatTokenForAgents(token)}

Analyse BULL (score ${bullAnalysis.score}/10):
${JSON.stringify(bullAnalysis, null, 2)}

Analyse BEAR (risque ${bearAnalysis.riskScore}/10, verdict: ${bearAnalysis.verdict}):
${JSON.stringify(bearAnalysis, null, 2)}`;

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
 * Lance le débat complet entre les 3 agents pour un token
 * @param {Object} token    - Données de paire DexScreener
 * @param {Object} security - Données de sécurité Birdeye (optionnel)
 * @returns {Promise<{bull, bear, decision, token, security}>}
 */
async function runDebate(token, security = null) {
  const symbol = token.baseToken?.symbol || '???';
  console.log(`[Agents] Débat pour ${symbol}${security ? ' (avec données Birdeye)' : ''}...`);

  const [bull, bear] = await Promise.all([
    runBullAgent(token),
    runBearAgent(token, security),
  ]);

  const decision = await runRiskManager(token, bull, bear);

  console.log(`[Agents] ${symbol} → ${decision.decision} (confiance: ${decision.confidence}/10)`);

  return { bull, bear, decision, token, security };
}

module.exports = { runDebate };
