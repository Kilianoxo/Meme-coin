# Meme Coin Bot — Notes pour Claude

## Contexte du projet
Bot de trading automatique de meme coins Solana via Telegram + dashboard web.
Piloté par ARIA, un agent IA personnel 100% autonome (Claude Haiku).
Stack: Node.js, Telegraf, Jupiter API (swaps), DexScreener, GeckoTerminal, Birdeye, RugCheck.
Le propriétaire trade aussi manuellement sur GMGN — positions importables via /addposition.

## Architecture
- `index.js` — Point d'entrée, charge le wallet et démarre Bot + Scanner + Dashboard + Watchdog + ARIA
- `src/bot.js` — Interface Telegram (commandes + callbacks + délégation autonomie ARIA)
- `src/scanner.js` — Détecte les tokens (DexScreener top-boosted + GeckoTerminal trending + GMGN trending si configuré — Pump.fun supprimé)
- `src/gmgn.js` — Client GMGN via gmgn-cli (smart money/KOL/snipers/bundlers, gates durs, verdict momentum, monitoring de fuite) — optionnel, dégradé propre sans clé
- `src/trader.js` — Exécute les trades Jupiter (lite-api.jup.ag/swap/v1), gère SL/TP/trailing stop, persistance disque
- `src/personalAgent.js` — ARIA : analyse, chat, autonomie (achat/vente auto), journal, apprentissage, heartbeat
- `src/paperTrader.js` — Simulation sans risque (positions fictives, mêmes analyses)
- `src/agents.js` — Ancien système multi-agents (suspendu — gardé pour agentBus/dashboard floor)
- `src/agentMemory.js` — Mémoire des débats + poids dynamiques + suggestions
- `src/tokenHistory.js` — Détection des tokens récidivistes (mêmes tickers, nouvelles adresses)
- `src/birdeye.js` — Sécurité on-chain (mint authority, freeze, concentration holders)
- `src/rugcheck.js` — Détection rugpull / LP lock
- `src/dexscreener.js` — Client DexScreener API
- `src/geckoterminal.js` — Client GeckoTerminal API
- `src/dashboard.js` — Serveur web (HTTP natif) : API + SSE temps réel
- `src/public/index.html` — Dashboard (onglets Dashboard / ARIA / Paper Trading)
- `src/watchdog.js` — Redémarre le scanner s'il bloque, capture les erreurs fatales
- `src/logger.js` — Log JSON dans logs/bot.log
- `src/state.js` — Flags globaux (agentsEnabled, recentAnalyses)
- `data/positions.json` — Positions + historique trader réel
- `data/agent.json` — Personnalité + autonomie + watchlist + conversation ARIA
- `data/agent_journal.json` — Journal des actions autonomes d'ARIA
- `data/paper_positions.json` — Paper trading
- `data/tokenHistory.json` — Tokens récurrents

## ARIA — Autonomie
Config persistée dans agent.json (`autonomy`), modifiable via dashboard (POST /api/agent/autonomy) ou /auto :
- `enabled` — signaux, watchlist auto, gestion de positions, alertes, rapport quotidien
- `liveTrading` — exécution réelle sur le wallet (OFF par défaut, opt-in)
- `minScore` (70), `minConfidence` (6) — seuils d'achat autonome
- `maxSolPerTrade` (0.1), `maxOpenPositions` (3), `maxDailyLossSol` (0.5 = circuit breaker)
Flux : scanner → analyse ARIA → bot.js appelle `personalAgent.maybeAutoTrade(debate)` (point d'entrée unique).
Heartbeat 3 min : alertes SL/TP (cooldown 30 min), watchlist (~6 min, cooldown 1h),
gestion active des positions (~9 min, cooldown 20 min/position, décisions HOLD/SELL/TIGHTEN_SL),
apprentissage (~30 min), rapport quotidien à 20h Paris.
Tout est journalisé dans agent_journal.json + push SSE `aria_journal`.

## Intégration GMGN (méthodo du demo officiel GMGNAI/skillmarket-demos)
- gates durs déterministes AVANT le LLM : honeypot, mint non abandonnée, taxes >10%,
  rug ratio >60%, bundlers >30%, dev >10%, top10 >40%, consensus smart money+KOL < 1
- verdict momentum "golden runner vs bag-holder" (pur code) : 1h+5m en baisse → reject ;
  buy ratio <42% → reject (distribution) ; ≥50% et 5m qui tient → pass même si déjà haut
- monitoring de fuite des positions (heartbeat, PUR CODE, jamais de LLM) : snapshot sécurité
  à l'entrée vs actuel — honeypot apparu (+60), mint retrouvée (+55), top10 +15pts (+22) ;
  sévérité ≥70 → vente d'urgence (liveTrading) ou alerte critique. exitReason: ESCAPE_SIGNAL
- anti prompt-injection : les noms de tokens sont désinfectés (sanitizeName) avant tout prompt LLM
- Les données `_gmgn` (smart money, KOL, snipers, buy ratio, verdict) enrichissent le prompt d'ARIA

## Commandes Telegram implémentées
/start, /help, /status, /balance, /scan, /positions, /history
/auto — Toggle du trading réel autonome d'ARIA
/pnl — PnL réalisé + non réalisé en temps réel
/settings, /set <maxsol|sl|tp> <valeur> (maxsol synchronise le plafond ARIA)
/analyse <adresse>, /debat <adresse> — Analyse ARIA
/buy <adresse> <sol>, /sell <adresse> [%]
/addposition <adresse> <sol> — Importer une position externe (ex: achetée sur GMGN)
/recurring — Tokens récidivistes
/agent [message] — Parler avec ARIA

## Dashboard (port 3000)
- Onglet Dashboard : balance wallet, tokens SPL, positions, PnL cumulé (bot + manuel), historique avec raison de sortie, analyses récentes
- Onglet ARIA : personnalité, panneau Autonomie (toggles + plafonds), chat, watchlists, journal d'activité live
- Onglet Paper Trading : simulation complète avec config indépendante
- Header : chip d'état ARIA (off / autonome / trading réel)
- SSE /api/events : aria_proactive, aria_journal, messages agents

## Variables d'environnement (.env)
TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID, ANTHROPIC_API_KEY (obligatoires)
WALLET_PRIVATE_KEY (optionnel — trading désactivé sans)
SOLANA_RPC_URL (défaut: mainnet-beta public)
BIRDEYE_API_KEY (optionnel — sécurité on-chain désactivée sans)
JUPITER_API_KEY (optionnel)
GMGN_API_KEY (optionnel — nécessite npm i -g gmgn-cli ; aussi lu depuis ~/.config/gmgn/.env)
GMGN_TRENDING_ARGS, GMGN_MIN_CONFLUENCE (optionnels — tuning source GMGN)
MIN_LIQUIDITY_USD (défaut: 5000), MIN_VOLUME_24H_USD (défaut: 20000), MIN_MARKET_CAP_USD (défaut: 30000)
MIN_TOKEN_AGE_HOURS (défaut: 6), MAX_TOKEN_AGE_HOURS (défaut: 72)
MAX_POSITION_SOL (défaut: 0.1)
DEFAULT_STOP_LOSS_PCT (défaut: 20), DEFAULT_TAKE_PROFIT_PCT (défaut: 50)
DASHBOARD_PORT (défaut: 3000)

## Branche de dev
claude/meme-coin-development-MhZiV

## À faire / idées futures
- Suivi des wallets de la watchlist (transactions on-chain, copy-trade)
- Backtest sur données historiques DexScreener
- Prise de profit partielle automatique (vendre 50% au TP, laisser courir le reste)
- Nettoyage : retirer agents.js/pumpfun.js quand le Trading Floor sera définitivement abandonné
