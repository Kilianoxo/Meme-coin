/**
 * État partagé entre modules — singleton Node.js
 * Permet de changer des flags globaux (ex: toggle débats IA)
 * sans redémarrer le bot.
 */
const MAX_RECENT = 20;

const state = {
  agentsEnabled:   true,   // false = débats LLM suspendus
  recentAnalyses:  [],     // 20 derniers tokens analysés

  pushAnalysis(entry) {
    this.recentAnalyses.unshift(entry);          // plus récent en premier
    if (this.recentAnalyses.length > MAX_RECENT) {
      this.recentAnalyses = this.recentAnalyses.slice(0, MAX_RECENT);
    }
  },
};

module.exports = state;
