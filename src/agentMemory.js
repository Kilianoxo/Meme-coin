/**
 * Mémoire des agents IA — apprentissage depuis les outcomes des trades
 *
 * Stocke dans data/agent_memory.json :
 *  - lessons  : débats passés avec leur résultat réel (WIN/LOSS)
 *  - agentStats : précision historique de chaque agent
 *  - suggestions : améliorations proposées par les agents, avec validation humaine
 *
 * Singleton — importé par agents.js, trader.js et dashboard.js
 */

const fs   = require('fs');
const path = require('path');

const MEMORY_FILE = path.join(__dirname, '..', 'data', 'agent_memory.json');
const MAX_LESSONS     = 50;
const MAX_SUGGESTIONS = 20;

class AgentMemory {
  constructor() {
    this.data = this._load();
  }

  // ─── Persistance ────────────────────────────────────────────────────────────

  _load() {
    try {
      if (fs.existsSync(MEMORY_FILE)) {
        return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
      }
    } catch (err) {
      console.warn('[AgentMemory] Impossible de charger:', err.message);
    }
    return this._emptyData();
  }

  _emptyData() {
    return {
      lessons: [],
      agentStats: {
        bull:     { correct: 0, wrong: 0 },
        bear:     { correct: 0, wrong: 0 },
        momentum: { correct: 0, wrong: 0 },
        whale:    { correct: 0, wrong: 0 },
      },
      suggestions: [],
    };
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
      fs.writeFileSync(MEMORY_FILE, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.warn('[AgentMemory] Impossible de sauvegarder:', err.message);
    }
  }

  // ─── Enregistrement d'un débat ─────────────────────────────────────────────

  /**
   * Appelé juste après runDebate() — stocke le contexte du débat
   * en attente de l'outcome réel du trade.
   *
   * @param {string} address     - Adresse mint du token
   * @param {string} symbol      - Symbole du token (ex: "BONK")
   * @param {Object} debateResult - Résultat de runDebate()
   * @returns {string} id de la lesson (pour liaison avec l'outcome)
   */
  recordDebate(address, symbol, debateResult) {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const lesson = {
      id,
      date: new Date().toISOString(),
      symbol: symbol || '???',
      address,
      decision:          debateResult.decision?.decision    ?? 'SKIP',
      score:             debateResult.decision?.score       ?? 0,
      bullScore:         debateResult.bull?.score           ?? null,
      bearRiskScore:     debateResult.bear?.riskScore       ?? null,
      bearVerdict:       debateResult.bear?.verdict         ?? null,
      momentumTrend:     debateResult.momentum?.trend       ?? null,
      momentumScore:     debateResult.momentum?.score       ?? null,
      whaleConcentration: debateResult.whale?.concentrationRisk ?? null,
      whaleScore:        debateResult.whale?.score          ?? null,
      reasoning:         debateResult.decision?.reasoning   ?? null,
      outcome:           'RUNNING', // sera mis à jour à la clôture du trade
      pnlPct:            null,
      exitReason:        null,
    };

    this.data.lessons.push(lesson);
    if (this.data.lessons.length > MAX_LESSONS) {
      this.data.lessons = this.data.lessons.slice(-MAX_LESSONS);
    }
    this._save();
    return id;
  }

  // ─── Enregistrement de l'outcome ───────────────────────────────────────────

  /**
   * Appelé quand un trade se ferme (sell, SL, TP, trailing).
   * Met à jour la lesson correspondante et met à jour les stats des agents.
   *
   * @param {string} tokenMint  - Adresse mint
   * @param {number} pnlPct     - PnL en % depuis l'entrée
   * @param {string} exitReason - 'MANUAL' | 'STOP_LOSS' | 'TAKE_PROFIT' | 'TRAILING_STOP'
   */
  recordOutcome(tokenMint, pnlPct, exitReason = 'MANUAL') {
    // Cherche la lesson la plus récente encore en cours pour ce token
    const lesson = [...this.data.lessons]
      .reverse()
      .find(l => l.address === tokenMint && l.outcome === 'RUNNING');

    if (!lesson) return; // pas de débat enregistré pour ce trade

    const isWin = pnlPct > 0;
    lesson.outcome    = isWin ? 'WIN' : 'LOSS';
    lesson.pnlPct     = parseFloat(pnlPct.toFixed(2));
    lesson.exitReason = exitReason;

    // Met à jour les stats des agents
    this._updateAgentStats(lesson, isWin);

    // Génère éventuellement une suggestion d'amélioration
    this._maybeGenerateSuggestion(lesson);

    this._save();
    console.log(`[AgentMemory] Outcome enregistré: ${lesson.symbol} → ${lesson.outcome} (${pnlPct.toFixed(1)}%) via ${exitReason}`);
  }

  // ─── Stats des agents ──────────────────────────────────────────────────────

  _updateAgentStats(lesson, isWin) {
    const s = this.data.agentStats;

    // Bull : était-il optimiste à juste titre ?
    if (lesson.bullScore != null && lesson.bullScore >= 6) {
      if (isWin) s.bull.correct++;
      else        s.bull.wrong++;
    }

    // Bear : avait-il raison d'être pessimiste ?
    if (lesson.bearRiskScore != null && lesson.bearRiskScore >= 6) {
      if (!isWin) s.bear.correct++;
      else         s.bear.wrong++;
    }

    // Momentum : le trend était-il un bon indicateur ?
    if (lesson.momentumTrend === 'ACCELERATING' || lesson.momentumTrend === 'STABLE') {
      if (isWin) s.momentum.correct++;
      else        s.momentum.wrong++;
    } else if (lesson.momentumTrend === 'FADING' || lesson.momentumTrend === 'REVERSAL') {
      if (!isWin) s.momentum.correct++;
      else         s.momentum.wrong++;
    }

    // Whale : la concentration était-elle un signal fiable ?
    if (lesson.whaleConcentration === 'LOW' || lesson.whaleConcentration === 'MEDIUM') {
      if (isWin) s.whale.correct++;
      else        s.whale.wrong++;
    } else if (lesson.whaleConcentration === 'HIGH' || lesson.whaleConcentration === 'CRITICAL') {
      if (!isWin) s.whale.correct++;
      else         s.whale.wrong++;
    }
  }

  // ─── Génération de suggestions ─────────────────────────────────────────────

  _maybeGenerateSuggestion(lesson) {
    const closedLessons = this.data.lessons.filter(l => l.outcome !== 'RUNNING');
    const recentClosed  = closedLessons.slice(-5);

    // Évite de générer plusieurs suggestions le même jour
    const todayStr = new Date().toISOString().slice(0, 10);
    const alreadyToday = this.data.suggestions.some(s => s.date.startsWith(todayStr));
    if (alreadyToday) return;

    // Pattern 1 : 3+ pertes consécutives récentes
    const recentLosses = recentClosed.filter(l => l.outcome === 'LOSS');
    if (recentLosses.length >= 3 && recentClosed[recentClosed.length - 1]?.outcome === 'LOSS') {
      const avgBull    = recentLosses.reduce((s, l) => s + (l.bullScore || 0), 0) / recentLosses.length;
      const avgScore   = recentLosses.reduce((s, l) => s + (l.score || 0), 0) / recentLosses.length;
      this._addSuggestion('coordinator',
        `${recentLosses.length} pertes récentes consécutives détectées. Score global moyen: ${avgScore.toFixed(0)}/100, ` +
        `score Bull moyen: ${avgBull.toFixed(1)}/10. ` +
        `Suggère de relever le seuil BUY de 70 → 75 pour être plus sélectif sur les prochains tokens.`,
        { losses: recentLosses.length, avgBullScore: avgBull, avgScore }
      );
      return;
    }

    // Pattern 2 : Bear très précis → augmenter son poids
    const { bear } = this.data.agentStats;
    const bearTotal = bear.correct + bear.wrong;
    if (bearTotal >= 5 && lesson.outcome === 'LOSS' && lesson.bearRiskScore >= 7) {
      const bearAcc = bear.correct / bearTotal;
      if (bearAcc >= 0.70) {
        this._addSuggestion('bear',
          `Agent Bear a une précision de ${Math.round(bearAcc * 100)}% sur ${bearTotal} signaux. ` +
          `Suggère d'augmenter son poids dans le score global de 25 → 30 pts ` +
          `(et de réduire Bull de 20 → 15 pts en compensation).`,
          { bearAccuracy: bearAcc, bearTotal }
        );
        return;
      }
    }

    // Pattern 3 : Bull surestimant (trop de faux positifs)
    const { bull } = this.data.agentStats;
    const bullTotal = bull.correct + bull.wrong;
    if (bullTotal >= 5 && lesson.outcome === 'LOSS' && lesson.bullScore >= 8) {
      const bullAcc = bull.correct / bullTotal;
      if (bullAcc <= 0.40) {
        this._addSuggestion('bull',
          `Agent Bull a trop de faux positifs (précision: ${Math.round(bullAcc * 100)}% sur ${bullTotal} signaux). ` +
          `Suggère d'ajouter une condition: score Bull ≥ 8 doit obligatoirement être accompagné ` +
          `d'un trend Momentum ACCELERATING pour compter pleinement.`,
          { bullAccuracy: bullAcc, bullTotal }
        );
        return;
      }
    }

    // Pattern 4 : Trailing stop souvent déclenché → SL trop serré ?
    const trailingHits = closedLessons.filter(l => l.exitReason === 'TRAILING_STOP').length;
    if (trailingHits >= 3 && lesson.exitReason === 'TRAILING_STOP') {
      this._addSuggestion('risk',
        `Le trailing stop s'est déclenché ${trailingHits} fois sur les derniers trades. ` +
        `Suggère d'augmenter le seuil d'activation du trailing de 20% → 25% ` +
        `pour laisser plus de room aux tokens en forte tendance.`,
        { trailingHits }
      );
    }
  }

  _addSuggestion(agent, suggestion, context = {}) {
    this.data.suggestions.push({
      id:         `${Date.now()}_${agent}`,
      date:       new Date().toISOString(),
      agent,
      suggestion,
      context,
      status:     'pending', // 'pending' | 'approved' | 'rejected'
    });
    if (this.data.suggestions.length > MAX_SUGGESTIONS) {
      this.data.suggestions = this.data.suggestions.slice(-MAX_SUGGESTIONS);
    }
    console.log(`[AgentMemory] Nouvelle suggestion (${agent}): ${suggestion.slice(0, 80)}…`);
  }

  // ─── Lecture pour les agents et le dashboard ───────────────────────────────

  /**
   * Résumé court à injecter dans les prompts agents
   * pour qu'ils aient conscience de leur historique récent.
   */
  getContextSummary() {
    const closed = this.data.lessons.filter(l => l.outcome !== 'RUNNING').slice(-10);
    if (closed.length === 0) return null;

    const wins    = closed.filter(l => l.outcome === 'WIN').length;
    const losses  = closed.filter(l => l.outcome === 'LOSS').length;
    const withPnl = closed.filter(l => l.pnlPct != null);
    const avgPnl  = withPnl.length > 0
      ? (withPnl.reduce((s, l) => s + l.pnlPct, 0) / withPnl.length).toFixed(1)
      : null;

    const { bull, bear } = this.data.agentStats;
    const bullTotal = bull.correct + bull.wrong;
    const bearTotal = bear.correct + bear.wrong;
    const bullAcc   = bullTotal > 0 ? Math.round((bull.correct / bullTotal) * 100) : null;
    const bearAcc   = bearTotal > 0 ? Math.round((bear.correct / bearTotal) * 100) : null;

    let ctx = `[MÉMOIRE — ${closed.length} trades récents: ${wins} WIN / ${losses} LOSS`;
    if (avgPnl !== null) ctx += `, PnL moy: ${avgPnl}%`;
    if (bullAcc !== null) ctx += ` | Précision Bull: ${bullAcc}%`;
    if (bearAcc !== null) ctx += ` | Précision Bear: ${bearAcc}%`;
    ctx += ']';

    return ctx;
  }

  /**
   * Calcule les poids dynamiques des 4 agents en fonction de leur précision historique.
   * Les poids sont normalisés pour sommer à 85 (les 15 pts restants = sécurité fixe).
   *
   * Nécessite MIN_SAMPLES signaux par agent pour activer l'adaptation.
   * En dessous du seuil → poids par défaut conservé.
   *
   * @returns {{ weights: Object, defaults: Object, adapted: boolean, log: string[] }}
   */
  getDynamicWeights() {
    const MIN_SAMPLES = 5;
    const DEFAULTS = { momentum: 25, bull: 20, bear: 25, whale: 15 }; // somme = 85

    const raw = {};
    const log = [];
    let anyAdapted = false;

    for (const [agent, def] of Object.entries(DEFAULTS)) {
      const s     = this.data.agentStats[agent];
      const total = s.correct + s.wrong;

      if (total < MIN_SAMPLES) {
        raw[agent] = def; // pas assez de données → valeur par défaut
        continue;
      }

      const acc = s.correct / total;

      // Multiplicateur : plus l'agent a raison, plus son poids augmente
      let multiplier;
      if      (acc >= 0.75) multiplier = 1.40;
      else if (acc >= 0.60) multiplier = 1.20;
      else if (acc >= 0.45) multiplier = 1.00;
      else if (acc >= 0.30) multiplier = 0.75;
      else                  multiplier = 0.55;

      raw[agent] = def * multiplier;

      if (multiplier !== 1.00) {
        anyAdapted = true;
        const dir = multiplier > 1.00 ? '↑' : '↓';
        log.push(`${agent}: ${Math.round(acc * 100)}% acc → ×${multiplier} ${dir}`);
      }
    }

    // Renormalise pour que la somme soit exactement 85
    const sum   = Object.values(raw).reduce((a, b) => a + b, 0);
    const scale = 85 / sum;
    const weights = {};
    for (const k of Object.keys(raw)) {
      weights[k] = parseFloat((raw[k] * scale).toFixed(1));
    }

    // Corrige l'arrondi résiduel sur l'agent au plus fort poids
    const drift = parseFloat((85 - Object.values(weights).reduce((a, b) => a + b, 0)).toFixed(1));
    if (drift !== 0) {
      const top = Object.entries(weights).sort((a, b) => b[1] - a[1])[0][0];
      weights[top] = parseFloat((weights[top] + drift).toFixed(1));
    }

    return { weights, defaults: DEFAULTS, adapted: anyAdapted, log };
  }

  getLessons(limit = 30) {
    return this.data.lessons.slice(-limit).reverse();
  }

  getStats() {
    const fmt = (s) => {
      const total = s.correct + s.wrong;
      return {
        correct: s.correct,
        wrong:   s.wrong,
        total,
        accuracy: total > 0 ? Math.round((s.correct / total) * 100) : null,
      };
    };
    return {
      bull:     fmt(this.data.agentStats.bull),
      bear:     fmt(this.data.agentStats.bear),
      momentum: fmt(this.data.agentStats.momentum),
      whale:    fmt(this.data.agentStats.whale),
    };
  }

  getSuggestions() {
    return [...this.data.suggestions].reverse(); // plus récentes en premier
  }

  approveSuggestion(id) {
    const s = this.data.suggestions.find(s => s.id === id);
    if (!s) return false;
    s.status    = 'approved';
    s.approvedAt = new Date().toISOString();
    this._save();
    console.log(`[AgentMemory] Suggestion approuvée: ${id}`);
    return true;
  }

  rejectSuggestion(id) {
    const s = this.data.suggestions.find(s => s.id === id);
    if (!s) return false;
    s.status    = 'rejected';
    s.rejectedAt = new Date().toISOString();
    this._save();
    return true;
  }
}

module.exports = new AgentMemory(); // singleton
