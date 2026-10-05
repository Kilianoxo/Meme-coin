/**
 * TokenHistory — Mémoire des tokens récurrents
 *
 * Détecte les tokens qui réapparaissent régulièrement sous le même ticker/nom
 * (souvent une nouvelle adresse à chaque cycle) et trackent leurs performances.
 *
 * Stratégie de matching :
 *   1. Clé exacte  : normalise le ticker (minuscules, alphanumérique)
 *   2. Clé famille : retire le suffixe numérique (pepe2 → pepe, wojak3 → wojak)
 *      → utile pour les tokens qui incrémentent leur nom à chaque cycle
 *
 * Fichier de persistance : data/tokenHistory.json
 */

const fs   = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '../data/tokenHistory.json');

/** Normalise un string en clé : minuscules + alphanumérique uniquement */
function normalizeKey(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Clé famille : retire le suffixe de version en fin de chaîne.
 * Exemples : "pepe2" → "pepe" | "wojak_v3" → "wojak" | "doge2.0" → "doge"
 */
function familyKey(str) {
  return normalizeKey(str).replace(/v?\d+(\.\d+)*$/, '');
}

class TokenHistory {
  constructor() {
    this.data = this._load();
  }

  _load() {
    try {
      return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    } catch {
      return { tokens: {}, updatedAt: Date.now() };
    }
  }

  _save() {
    this.data.updatedAt = Date.now();
    try {
      fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
      fs.writeFileSync(DATA_PATH, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.error('[TokenHistory] Erreur sauvegarde:', err.message);
    }
  }

  /**
   * Recherche une entrée existante par clé exacte puis par famille.
   * Retourne null si introuvable.
   */
  _findEntry(symbol, name) {
    const exact = normalizeKey(symbol) || normalizeKey(name);
    if (exact && this.data.tokens[exact]) return this.data.tokens[exact];

    const fam = familyKey(symbol) || familyKey(name);
    if (!fam) return null;
    return Object.values(this.data.tokens).find(e => e.familyKey === fam) || null;
  }

  /**
   * Enregistre l'apparition d'un token filtré (boosted/trending, après hard-filters).
   *
   * @param {string} symbol   — ticker du token ($PEPE2)
   * @param {string} name     — nom complet
   * @param {string} address  — adresse du token (peut changer à chaque cycle)
   * @param {string} source   — 'dex-top-boosted' | 'gecko-trending' | …
   * @returns {{ isRecurring, sightings, daysSinceLast, lastPeakPct, avgPeakPct, totalCycles, key }}
   */
  recordSighting(symbol, name, address, source = 'unknown') {
    const key = normalizeKey(symbol) || normalizeKey(name);
    const fam = familyKey(symbol)   || familyKey(name);
    if (!key) return { isRecurring: false };

    const now     = Date.now();
    let   entry   = this._findEntry(symbol, name);

    if (!entry) {
      // Première apparition — crée l'entrée
      entry = {
        symbol,
        name,
        key,
        familyKey: fam,
        addresses:    [address],
        sightings:    1,
        firstSeen:    now,
        lastSeen:     now,
        lastAddress:  address,
        cycles:       [],   // cycles clôturés (avec peakPct + outcome)
        avgPeakPct:   null,
      };
      this.data.tokens[key] = entry;
      this._save();
      return { isRecurring: false, key };
    }

    // Token connu — mise à jour
    const daysSinceLast = (now - entry.lastSeen) / 86_400_000;

    if (!entry.addresses.includes(address)) entry.addresses.push(address);
    entry.sightings++;
    entry.lastSeen   = now;
    entry.lastAddress = address;
    // Enrichit le nom si on a mieux (certaines sources l'omettent)
    if (!entry.name && name) entry.name = name;

    this._save();

    const lastCycle = entry.cycles.length > 0 ? entry.cycles[entry.cycles.length - 1] : null;

    return {
      isRecurring:    entry.sightings >= 2,
      sightings:      entry.sightings,
      daysSinceLast:  parseFloat(daysSinceLast.toFixed(1)),
      lastPeakPct:    lastCycle?.peakPct ?? null,
      avgPeakPct:     entry.avgPeakPct,
      totalCycles:    entry.cycles.length,
      key,
    };
  }

  /**
   * Enregistre la fin d'un cycle de trading (appelé depuis trader.js à la vente).
   * Permet de tracker les performances historiques pour afficher le "peak moyen".
   *
   * @param {string} symbol
   * @param {string} address
   * @param {number|null} peakPct  — gain max atteint pendant la position (%)
   * @param {string} outcome       — 'WIN' | 'LOSS' | 'MANUAL'
   */
  recordCycleEnd(symbol, address, peakPct, outcome) {
    const entry = this._findEntry(symbol, '');
    if (!entry) return;

    entry.cycles.push({
      address,
      closedAt: Date.now(),
      peakPct:  peakPct ?? null,
      outcome,
    });

    // Recalcule la moyenne des peaks sur les cycles avec données
    const peaked = entry.cycles.filter(c => c.peakPct != null);
    entry.avgPeakPct = peaked.length > 0
      ? Math.round(peaked.reduce((s, c) => s + c.peakPct, 0) / peaked.length)
      : null;

    this._save();
  }

  /**
   * Retourne les N tokens les plus récurrents (min 2 sightings), triés par fréquence.
   */
  getTopRecurring(n = 10) {
    return Object.values(this.data.tokens)
      .filter(e => e.sightings >= 2)
      .sort((a, b) => b.sightings - a.sightings)
      .slice(0, n)
      .map(e => ({
        symbol:        e.symbol,
        name:          e.name,
        sightings:     e.sightings,
        addresses:     e.addresses.length,
        daysSinceLast: parseFloat(((Date.now() - e.lastSeen) / 86_400_000).toFixed(1)),
        avgPeakPct:    e.avgPeakPct,
        totalCycles:   e.cycles.length,
        lastAddress:   e.lastAddress,
      }));
  }

  getStats() {
    const entries = Object.values(this.data.tokens);
    return {
      total:       entries.length,
      recurring:   entries.filter(e => e.sightings >= 2).length,
      withCycles:  entries.filter(e => e.cycles.length > 0).length,
    };
  }
}

module.exports = new TokenHistory();
