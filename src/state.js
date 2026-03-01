/**
 * État partagé entre modules — singleton Node.js
 * Permet de changer des flags globaux (ex: toggle débats IA)
 * sans redémarrer le bot.
 */
module.exports = {
  agentsEnabled: true, // false = les débats LLM sont suspendus (économie de crédits)
};
