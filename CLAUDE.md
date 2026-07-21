# Meme Coin Bot — Notes pour Claude

## Contexte du projet
Bot de trading automatique de meme coins Solana via Telegram + dashboard web.
Piloté par ARIA, un agent IA personnel 100% autonome (Claude Haiku).
Second agent : AGIOS — dédié à Robinhood, DEUX volets :
  1. Robinhood Chain (L2 Ethereum/Arbitrum Orbit, mainnet juillet 2026, memecoins +
     actions tokenisées, gas ETH) — PAPER TRADING (données GMGN --chain robinhood ;
     exécution réelle à venir, Jupiter = Solana only)
  2. Robinhood Agentic Trading (courtage réel, actions US) — connexion OAuth au
     serveur MCP officiel agent.robinhood.com/mcp/trading, compte "Agentic" dédié
     à fonds pré-chargés. Trading réel OFF par défaut (confirmation Telegram).
Stack: Node.js, Telegraf, Jupiter API (swaps + prix), GMGN (source de données unique via gmgn-cli).
Le propriétaire trade aussi manuellement sur GMGN — positions importables via /addposition.

## Architecture
- `index.js` — Point d'entrée, charge le wallet et démarre Bot + Scanner + Dashboard + Watchdog + ARIA
- `src/bot.js` — Interface Telegram (commandes + callbacks + délégation autonomie ARIA)
- `src/scanner.js` — Détecte les tokens (GMGN trending UNIQUEMENT) — paramétrable { chain, label, analyzer } ; 2 instances : sol→ARIA, robinhood→Agios
- `src/gmgn.js` — Client GMGN via gmgn-cli, MULTI-CHAIN (sol/robinhood/eth/bsc/base — trending/info/prix/sécurité/hot par chaîne, gates chain-aware : mint/freeze = sol only) — SOURCE DE DONNÉES UNIQUE (trending, hot-searches, token info/prix, sécurité, smart money/KOL/snipers/bundlers, gates durs, verdict momentum, monitoring de fuite). REQUIS pour le scan/analyse ; sans clé le scanner attend
- `src/trader.js` — Exécute les trades Jupiter (lite-api.jup.ag/swap/v1), gère SL/TP/trailing stop, persistance disque
- `src/agios.js` — AGIOS : agent Robinhood Chain (persona propre, analyse LLM, journal data/agios_journal.json + SSE agios_journal, chat agentique avec outils Robinhood MCP pontés dynamiquement, paper trading dédié data/agios_paper.json via PaperTrader { chain:'robinhood' })
- `src/robinhoodMcp.js` — Client MCP Robinhood Agentic Trading (OAuth 2.0+PKCE via SDK officiel
  @modelcontextprotocol/sdk, tokens persistés dans ~/.config/robinhood-mcp/ chmod 600). Aucun nom
  d'outil codé en dur (MCP auto-descriptif, tools/list) — dégradé propre si non connecté
- `src/personalAgent.js` — ARIA : analyse, chat agentique avec outils (tool use), autonomie (achat/vente auto), journal, apprentissage, heartbeat
- `src/paperTrader.js` — Simulation sans risque — paramétrable { file, label, chain } (prix GMGN si chaîne non-sol)
- `src/agents.js` — Ancien système multi-agents (suspendu — gardé pour agentBus/dashboard floor)
- `src/agentMemory.js` — Mémoire des débats + poids dynamiques + suggestions
- `src/tokenHistory.js` — Détection des tokens récidivistes (mêmes tickers, nouvelles adresses)
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

## ARIA — Autonomie (exécution directe, sans confirmation — approuvé par le propriétaire)
Config persistée dans agent.json (`autonomy`), modifiable via dashboard (POST /api/agent/autonomy) ou /auto :
- `enabled` — signaux, watchlist auto, gestion de positions, alertes, rapport quotidien
- `liveTrading` — exécution réelle DIRECTE sur le wallet (notification seule, pas de boutons ;
  OFF par défaut → dans ce mode les boutons de confirmation restent le seul moyen d'agir)
- `minScore` (70) — seuil classique ; `flexScore` (55) — suffit avec un SIGNAL FORT :
  smart money massif (≥15 wallets + buy ratio ≥70%), rotation coordonnée (≥2 KOL + ≥10 smart
  + ≥10 snipers), flux live (≥3 achats smart money > 2× ventes), rupture de pattern (score
  +15 pts en <1h — re-scan 5 min des scores 30-60 via scanner.markSeenTtl), micro-cap
  < lowCapMaxMcap (50K) avec liq ≥5K. Logique dans _strongSignal() (personalAgent.js)
- `minSolPerTrade` (0.05) → `maxSolPerTrade` (0.2) — taille linéaire selon confiance (5→9+)
- SL/TP dynamiques (_dynamicSlTp) : volatilité 1h/5m + taille de cap → stops élargis
- `maxOpenPositions` (3), `maxDailyLossSol` (0.5 = circuit breaker), anti re-trade 6h
- Sortie multi-étapes (trader.js, TP_SELL_STAGE1/2=30) : +TP% → vend 30% (TAKE_PROFIT),
  +2×TP% → vend 30% de l'initial (TAKE_PROFIT_2), reste ~40% en trailing ; break-even stop
  après le 1er palier (tpStage ≥1 → sortie si PnL ≤ +3%, BREAKEVEN_STOP)
- `copyTrading` (true) : réplique les achats des wallets suivis — JAMAIS aveuglément :
  gates GMGN + analyse ARIA (SKIP ou conf <5 → refus expliqué), puis _execAutoBuy
  (tous les garde-fous). Max 1 copy par wallet par cycle (~6 min)
- Risk adaptatif (_riskMultiplier) : perte horaire ≥60% du plafond jour → tailles ÷2 ;
  2 ventes perdantes d'affilée → ×0.75 ; loss streak ≥3 → ÷2 (cumulable)
- `traderProfile` (style, riskAppetite, targets, notes) — injecté dans tous les prompts,
  modifiable via l'outil de chat profil_trader
Flux : scanner → analyse ARIA → bot.js appelle `personalAgent.maybeAutoTrade(debate)` (point d'entrée unique).
Heartbeat 3 min : synchro wallet BIDIRECTIONNELLE (~15 min, trader.syncWallet — clôture auto
EXTERNAL_SELL des positions vendues à la main + auto-import des achats manuels GMGN ≥ AUTO_IMPORT_MIN_USD
(10$) sous gestion SL/TP), alertes SL/TP (cooldown 30 min), watchlist tokens (~6 min, cooldown 1h),
tracking LIVE des wallets suivis (~6 min — alerte proactive à chaque nouveau swap, curseur
lastActivityTs par wallet, pur code), gestion active des positions (~9 min, cooldown 20 min/position,
décisions HOLD/SELL/TIGHTEN_SL), apprentissage (~30 min), rapport quotidien à 20h Paris.
Tout est journalisé dans agent_journal.json + push SSE `aria_journal`.

## ARIA — Outils du chat (tool use)
Le chat d'ARIA (dashboard + /agent Telegram) est une boucle agentique (max 6 tours d'outils,
`MAX_TOOL_ROUNDS`) : elle appelle les APIs elle-même, sans qu'on lui donne les adresses.
Outils (`TOOL_DEFS` + `_execTool` dans personalAgent.js) :
- `rechercher_token` — recherche dans le trending + hot-searches GMGN par nom/ticker
- `tokens_tendance` — GMGN trending + hot-searches (smart money/KOL, verdicts)
- `donnees_token` — due diligence GMGN (prix, sécurité, snipers, bundlers, buy ratio)
- `analyser_token` — pipeline d'analyse complet → décision BUY/WATCH/SKIP
- `etat_portefeuille` — balance + positions avec PnL live + PnL du jour + vérif on-chain (surChaine)
- `nettoyer_positions` — synchro bidirectionnelle : clôture les ventes manuelles + importe les achats manuels
- `analyser_wallet` — stats GMGN d'un wallet (winrate, PnL réalisé/non réalisé, positions,
  historique, classification du style : sniper/bot/whale/diamond hands/bag-holder/dev)
- `smart_money_moves` — flux live des trades smart money + KOL agrégé par token
- `stats_bot` — bilan complet (winrate, PnL, peak equity, max drawdown, profit factor,
  meilleurs/pires tokens, sorties par raison, état du risk adaptatif)
- `acheter` / `vendre` — swaps Jupiter réels (achat plafonné à maxSolPerTrade, journalisé)
- `watchlist` — gestion autonome de la liste de surveillance
Les blocs tool_use/tool_result ne sont PAS persistés dans la conversation (texte seul).
Chaque trade via chat est journalisé dans agent_journal.json.

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
- Le flux smart money/KOL LIVE du token analysé (track smartmoney/kol, cache 60s) est injecté
  dans chaque analyse autonome (getSmartMoneyForToken)

## Agios — Robinhood Agentic Trading (courtage réel, actions US)
Connexion OAuth 2.0+PKCE (jamais de mot de passe Robinhood dans le code) au serveur MCP officiel
`agent.robinhood.com/mcp/trading`. Étape interactive UNIQUE (lien à ouvrir dans un navigateur)
via `/robinhood_connect` sur Telegram ou le bouton dashboard — DOIT se faire depuis la machine qui
fait tourner le bot (pas un environnement cloud sans navigateur/réseau vers agent.robinhood.com).
- `src/robinhoodMcp.js` : `FileOAuthClientProvider` persiste tokens/client OAuth sur disque,
  serveur de callback local (port 8090, `ROBINHOOD_MCP_CALLBACK_PORT`), `startSetup()` bloque
  jusqu'à autorisation (timeout 5 min), `_connectSilent()` réutilise les tokens existants sans
  jamais déclencher de flux interactif. `listTools()`/`callTool()` génériques (0 nom en dur).
- `agios.js` : `equities.liveTrading` (OFF par défaut, persisté dans data/agios.json) — outils
  Robinhood pontés dynamiquement dans la boucle de chat agentique (`_bridgeRobinhoodTools`,
  `rh_<nom>` préfixé). Lecture seule (annotation MCP `readOnlyHint` ou heuristique de nom
  `WRITE_TOOL_PAT`) → exécution libre. Action non-lecture : liveTrading ON → exécution directe +
  notification ; OFF → confirmation Telegram (boutons inline `rhconfirm:<id>:yes|no`, dashboard
  `/api/agios/equities/confirm/:id/:yesno`), timeout 10 min → annulée automatiquement.
- Commandes Telegram : `/robinhood_connect`, `/robinhood_status`, `/robinhood_live` (toggle),
  `/agios [message]` (chat). Dashboard : panneau dédié dans l'onglet Agios (connexion, toggle,
  file de confirmations), lien d'autorisation reçu en live via SSE `agios_auth_url`.

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
- Onglet Agios · Robinhood : hero chaîne, stats paper, positions/historique, journal live, chat (API /api/agios + /api/agios/chat)
- Onglet Paper Trading : simulation complète avec config indépendante
- Skin moderne : palette indigo/nuit, gradients, pills, glassmorphism (bloc SKIN MODERNE en fin de <style>)
- Header : chip d'état ARIA (off / autonome / trading réel)
- SSE /api/events : aria_proactive, aria_journal, messages agents

## Variables d'environnement (.env)
TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID, ANTHROPIC_API_KEY (obligatoires)
WALLET_PRIVATE_KEY (optionnel — trading désactivé sans)
SOLANA_RPC_URL (défaut: mainnet-beta public)
JUPITER_API_KEY (optionnel)
GMGN_API_KEY (REQUIS pour le scan — npm i -g gmgn-cli ; aussi lu depuis ~/.config/gmgn/.env)
GMGN_TRENDING_ARGS, GMGN_MIN_CONFLUENCE (optionnels — tuning source GMGN)
MIN_LIQUIDITY_USD (défaut: 5000), MIN_VOLUME_24H_USD (défaut: 20000 — mesuré sur la fenêtre trending GMGN 1h), MIN_MARKET_CAP_USD (défaut: 30000)
MIN_TOKEN_AGE_HOURS (défaut: 6), MAX_TOKEN_AGE_HOURS (défaut: 72)
MAX_POSITION_SOL (défaut: 0.1)
DEFAULT_STOP_LOSS_PCT (défaut: 20), DEFAULT_TAKE_PROFIT_PCT (défaut: 50)
DASHBOARD_PORT (défaut: 3000)

## Branche de dev
claude/meme-coin-development-MhZiV

## À faire / idées futures
- Copy-trade automatique des wallets suivis (le tracking live existe déjà)
- Backtest sur données historiques (gmgn-cli market kline)
- Prise de profit partielle automatique (vendre 50% au TP, laisser courir le reste)
- Nettoyage : retirer agents.js quand le Trading Floor sera définitivement abandonné
