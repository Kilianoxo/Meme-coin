# Roadmap — Meme Coin Bot

## PHASE 1 — Infrastructure & Sources de données

| # | Tâche | Priorité | Statut |
|---|-------|----------|--------|
| 1 | Setup projet (dossiers, .env, requirements) | Critique | ✅ Done |
| 2 | DexScreener API — tokens Solana en temps réel | Critique | ✅ Done |
| 3 | Birdeye API — holders, wallets, données avancées | Critique | ✅ Done |
| 4 | GeckoTerminal API — données marché | Important | ✅ Done |
| 5 | Scraper Pump.fun — nouveaux tokens | Critique | ✅ Done |
| 6 | Scraper Photon — volume et momentum | Important | ❌ À faire |

## PHASE 2 — Analyse & Sécurité

| # | Tâche | Priorité | Statut |
|---|-------|----------|--------|
| 7 | Détection rugpull / honeypot (RugCheck API) | Critique | ❌ À faire |
| 8 | Analyse on-chain : holders, top wallets, concentration | Critique | ⚠️ Partiel (mint/freeze/top10% via Birdeye, manque nb holders) |
| 9 | Analyse liquidité : pool size, locked, slippage | Critique | ⚠️ Partiel (liquidité USD dispo, pas de "locked" vérification) |
| 10 | Analyse social : Twitter/X, Telegram | Important | ⚠️ Partiel (présence de liens détectée, pas d'analyse réelle) |
| 11 | Filtres sécurité : mint authority, freeze authority | Critique | ✅ Done |

## PHASE 3 — Les Agents IA (le coeur du système)

| # | Agent | Rôle | Statut |
|---|-------|------|--------|
| 12 | Agent BULL | Trouve les raisons d'acheter | ✅ Done |
| 13 | Agent BEAR | Trouve les red flags | ✅ Done |
| 14 | Agent RISK MANAGER | Gère le risque et le sizing | ✅ Done |
| 15 | Agent WHALE TRACKER | Suit les gros wallets | ❌ À faire |
| 16 | Agent MOMENTUM | Vitesse et tendance du prix | ❌ À faire |
| 17 | Agent COORDINATEUR | Orchestre le débat + verdict final | ⚠️ Partiel (Risk Manager joue ce rôle partiellement) |
| 18 | Système de débat | Score pondéré 0-100 | ⚠️ Partiel (score 0-10, pas de score pondéré global 0-100) |
| 19 | Intégration Claude API | Cerveau des agents | ✅ Done |

## PHASE 4 — Trading Automatique

| # | Tâche | Priorité | Statut |
|---|-------|----------|--------|
| 20 | Connexion wallet Solana (sécurisé) | Critique | ✅ Done |
| 21 | Jupiter Aggregator API — meilleur prix | Critique | ✅ Done |
| 22 | Exécution des trades (buy/sell) | Critique | ✅ Done |
| 23 | Gestion slippage, gas, retry | Critique | ⚠️ Partiel (slippage 300bps, pas de retry tx) |
| 24 | Stop-loss automatique | Critique | ✅ Done |
| 25 | Take-profit automatique | Critique | ✅ Done |
| 26 | Position sizing selon le score de l'agent | Important | ⚠️ Partiel (suggestedAmountPct basique, 1-5%) |
| 27 | Portfolio tracker + PnL temps réel | Important | ✅ Done (/pnl, /positions) |

## PHASE 5 — Monitoring & Sécurité

| # | Tâche | Priorité | Statut |
|---|-------|----------|--------|
| 28 | Dashboard terminal propre | Important | ❌ À faire |
| 29 | Alertes Telegram (trades + alertes) | Important | ✅ Done |
| 30 | Logs complets de toutes les décisions | Important | ⚠️ Partiel (console.log basique, pas de logging structuré) |
| 31 | Base de données SQLite | Important | ❌ À faire (JSON seulement pour l'instant) |
| 32 | Scheduler — scan auto toutes les X minutes | Critique | ✅ Done (30s) |
| 33 | Gestion erreurs + reconnexion auto | Important | ⚠️ Partiel (PumpFun reconnect OK, manque retry API) |

## PHASE 6 — Config & Tests

| # | Tâche | Priorité | Statut |
|---|-------|----------|--------|
| 34 | Config YAML (paramètres modifiables facilement) | Important | ❌ À faire |
| 35 | Mode Paper Trading (simulation sans risque) | Important | ❌ À faire |
| 36 | Backtesting sur données historiques | Bonus | ❌ À faire |
| 37 | Tests unitaires | Bonus | ❌ À faire |

---

## Résumé d'avancement

| Phase | Avancement |
|-------|-----------|
| Phase 1 — Infrastructure | 5/6 ✅ |
| Phase 2 — Analyse & Sécurité | 2/5 ✅ |
| Phase 3 — Agents IA | 4/8 ✅ |
| Phase 4 — Trading | 6/8 ✅ |
| Phase 5 — Monitoring | 2/6 ✅ |
| Phase 6 — Config & Tests | 0/4 ✅ |
