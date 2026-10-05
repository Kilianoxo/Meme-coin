# Meme Coin Bot — Notes pour Claude

## Contexte du projet
Bot de trading automatique de meme coins Solana via Telegram + dashboard web.
Piloté par ARIA, un agent IA personnel 100% autonome (Claude Haiku).
Stack: Node.js, Telegraf, Jupiter API (swaps + prix), GMGN (source de données unique via gmgn-cli).
Le propriétaire trade aussi manuellement sur GMGN — positions importables via /addposition.

## Architecture
- `index.js` — Point d'entrée, charge le wallet et démarre Bot + Scanner + Dashboard + Watchdog + ARIA
- `src/bot.js` — Interface Telegram (commandes + callbacks + délégation autonomie ARIA)
- `src/scanner.js` — Détecte les tokens (GMGN trending 1h + source « early » 5m triée par swaps si `autonomy.earlyScan`). Âge minimum live = `autonomy.minTokenAgeHours` (1h par défaut) ; sous 2h, exige ≥100 holders et ≥2 smart money/KOL
- `src/gmgn.js` — Client GMGN via gmgn-cli (Solana) — SOURCE DE DONNÉES UNIQUE (trending, hot-searches, token info/prix, sécurité, smart money/KOL/snipers/bundlers, gates durs, verdict momentum, monitoring de fuite). REQUIS pour le scan/analyse ; sans clé le scanner attend
- `src/trader.js` — Exécute les trades Jupiter (lite-api.jup.ag/swap/v1), gère SL/TP/trailing stop (surveillance toutes les POSITION_CHECK_SECONDS=10s, prix groupés, anti-chevauchement), persistance disque. Chaque position porte `positionId` + `entry` (signaux d'entrée, notes) ; les SELL recopient positionId/entrySignals
- `src/prices.js` — Prix USD via Jupiter Price API **v3** (la v2 est dépréciée depuis le 30/09/2025) : appels groupés (50 mints), cache 3s, lit aussi l'ancien format v2
- `src/performance.js` — Stats "ce qui marche" : regroupe les ventes par POSITION (paliers additionnés), résultats par signal d'entrée, par tranche de note finale / chiffres / IA
- `src/personalAgent.js` — ARIA : analyse, chat agentique avec outils (tool use), autonomie (achat/vente auto), journal, apprentissage, heartbeat
- `src/paperTrader.js` — Simulation sans risque — 3 STRATÉGIES en parallèle (`STRATEGIES` : main « Actuelle », strict « Sélective », runner « Laisse courir ») sur les mêmes analyses, fichiers data/paper_positions.json, paper_strict.json, paper_runner.json ; positions étiquetées comme le réel
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

## Limite de débit GMGN (IMPORTANT)
GMGN applique un seau qui fuit PAR FORFAIT (Free 5/5, Plus 20/20, Pro 50/50 — unités/s / capacité) et un
POIDS par route (trending 3, hot-searches 3, token info 1, token security 1, track 1, portfolio activity/stats 3,
holdings 2). Les 429 répétés → BAN d'IP jusqu'à 5 min, prolongé de 5 s par requête envoyée pendant le ban.
Tout appel passe par `_cli()` (src/gmgn.js) qui implémente côté client :
- seau pondéré à 60 % du débit du forfait (`GMGN_PLAN` = free|plus|pro, défaut free), 2 requêtes en vol max,
  file à priorités (0 : token security/info = protection des positions ; 2 : trending ; 3 : hot/portfolio),
  requêtes en attente > 60 s abandonnées ;
- fusion des requêtes identiques en cours (single-flight) ;
- porte de ban : au premier 429, plus AUCUNE requête jusqu'à l'heure de levée annoncée + 3 s (erreur locale
  `RateLimitedError`, code GMGN_RATE_LIMITED) ; débit ensuite divisé par 2, puis +25 % par 5 min sans violation ;
- réessai interne de gmgn-cli désactivé (`GMGN_RATE_LIMIT_AUTO_RETRY_MAX_WAIT_MS=0`) ;
- `rateStatus()` (exposé dans /api/data.gmgnStatus → pastille « GMGN en pause » du dashboard) et
  `onRateLimit(fn)` (alerte Telegram au début de chaque pause, max 1 / 10 min).
Le scanner saute ses scans pendant une pause ; la source early (trending 5m) ne tourne qu'un scan sur deux.
NE JAMAIS appeler gmgn-cli en dehors de `_cli()` et ne jamais lancer plusieurs classements d'affilée.

## Mesure et qualité de décision
- Note HYBRIDE (personalAgent.analyzeToken) : `gmgn.quantScore()` (déterministe, 0-100 : consensus
  smart/KOL 25, pression achat 20, momentum 20, liquidité 15, distribution 20 ; plafond 35 si verdict
  reject). Sous QUANT_SKIP_BELOW (30) → SKIP sans appel LLM. Sinon note finale =
  QUANT_WEIGHT (0.6) × chiffres + 0.4 × LLM ; la DÉCISION reste celle du LLM (veto), un BUY sous 55 → WATCH.
  decision.quantScore / llmScore / quantParts conservés.
- `classifySignals(debate)` (sync) étiquette : smart_money, rotation, rupture, micro_cap, early (+ live_flow
  dans _strongSignal, copy_trade pour le copy-trading, score_seul sinon, manuel/import pour les achats humains).
  `_entryInfo()` enregistre signaux + notes + snapshot GMGN + âge sur la position.
- `personalAgent.performanceReport()` → réel + chaque stratégie paper ; injecté dans le prompt système
  (« CE QUI MARCHE », signaux avec ≥3 positions) et l'outil stats_bot. API : /api/performance,
  /api/data.performance, /api/paper/compare, /api/paper?id=<strategie>.

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
Design "fintech" violet : fond dégradé (couche `body::before` fixe), héros en verre, cartes blanches,
icônes SVG en sprite (`<symbol id="i-…">` + robot ARIA `#robot`), police Plus Jakarta Sans.
4 onglets (nav en pilule en desktop, barre fixe en bas < 760px) :
- Accueil : solde wallet en USD (prix SOL via `solPriceUsd` de /api/data), PnL du jour, actions rapides,
  tuiles PnL/win rate/positions/semaine, carte ARIA, positions (jauge SL→TP), derniers trades,
  performance cumulée, semaine, tokens du wallet, analyses récentes
- ARIA : profil (humeur, jauges, traits), chat avec suggestions rapides, watchlists, journal live
- Paper : portefeuille simulé, graphiques, positions (vente), ajout manuel, historique
- Réglages : profils rapides (Prudent/Équilibré/Agressif), interrupteurs (analyses IA, autonomie,
  trading réel, copy-trading), curseurs de seuils, tailles/exposition, paramètres paper, reset.
  Sauvegarde AUTOMATIQUE (attribut `data-save="autonomy|paper"` + debounce 450 ms)
- Fenêtre "Analyser un token" (POST /api/debate) avec verdict, note chiffres / IA + métriques GMGN
- Accueil : carte « Ce qui marche » (onglets Réel + chaque stratégie paper) — par signal, par note,
  « qui prédit le mieux » (note chiffres vs note IA, positions notées ≥ 65)
- Paper : sélecteur de stratégie + comparatif ; Réglages : section Détection (âge minimum, source early),
  la section Paper édite la stratégie sélectionnée
- Chart.js via CDN jsdelivr (repli cdnjs) — si indisponible, le reste du dashboard fonctionne
- SSE /api/events : aria_proactive (toast si hors onglet ARIA), aria_journal
- Mobile : pas de backdrop-filter sur la topbar (sinon la nav fixed se positionne par rapport à elle)

## Variables d'environnement (.env)
TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID, ANTHROPIC_API_KEY (obligatoires)
WALLET_PRIVATE_KEY (optionnel — trading désactivé sans)
SOLANA_RPC_URL (défaut: mainnet-beta public)
JUPITER_API_KEY (optionnel)
GMGN_API_KEY (REQUIS pour le scan — npm i -g gmgn-cli ; aussi lu depuis ~/.config/gmgn/.env)
GMGN_TRENDING_ARGS, GMGN_MIN_CONFLUENCE (optionnels — tuning source GMGN)
MIN_LIQUIDITY_USD (défaut: 5000), MIN_VOLUME_24H_USD (défaut: 20000 — mesuré sur la fenêtre trending GMGN 1h), MIN_MARKET_CAP_USD (défaut: 30000)
MIN_TOKEN_AGE_HOURS (défaut: 1 — valeur initiale, réglable ensuite dans le dashboard), MAX_TOKEN_AGE_HOURS (défaut: 72)
GMGN_PLAN (défaut: free — free|plus|pro, règle le limiteur de débit sur ton forfait GMGN)
POSITION_CHECK_SECONDS (défaut: 10) — fréquence de surveillance SL/TP (réel + paper)
QUANT_WEIGHT (défaut: 0.6), QUANT_SKIP_BELOW (défaut: 30) — note hybride chiffres/IA
JUPITER_PRICE_URL (défaut: https://lite-api.jup.ag/price/v3)
MAX_POSITION_SOL (défaut: 0.1)
DEFAULT_STOP_LOSS_PCT (défaut: 20), DEFAULT_TAKE_PROFIT_PCT (défaut: 50)
DASHBOARD_PORT (défaut: 3000)

## Sécurité des dépendances (npm audit)
`package.json` fixe des `overrides` pour deux chaînes de vulnérabilités transitives de
`@solana/web3.js` (qui pin des versions figées de ses propres dépendances) :
- `rpc-websockets` → forcé en `^10.0.1` (au lieu de `^9.0.2` demandé par web3.js). Corrige la
  chaîne `uuid`/`ws` vulnérable. Sans risque : le bot n'utilise AUCUNE souscription WebSocket
  (`onAccountChange`/`onLogs`…), uniquement du RPC HTTP classique.
- `uuid` → forcé en `^11.1.1` (au lieu de `8.3.2` pin par `jayson`). `jayson` n'appelle que
  `uuid.v4()` sans buffer — la faille (bounds check sur un `buf` passé à v3/v5/v6) n'est de
  toute façon jamais déclenchable via son usage réel.
Résultat : 10 → 3 vulnérabilités (audit re-testé, RPC HTTP réel fonctionnel après upgrade).

**Vulnérabilité restante acceptée** : `bigint-buffer` (GHSA-3gc7-fjrx-p6mg, high, CVSS 7.5,
impact DoS/crash uniquement — pas de fuite de données ni de vol de fonds). La version installée
(1.1.5) est la DERNIÈRE publiée et reste vulnérable : aucun correctif n'existe en amont. Le seul
"fix" proposé par npm (`@solana/spl-token@0.1.8`, mi-2022) est une régression majeure — perte du
support Token-2022, sur lequel reposent une partie des meme coins actuels — pour un correctif
qui ne corrige rien côté `bigint-buffer` lui-même. Le Watchdog redémarre déjà le process
automatiquement sur crash. À réévaluer si un correctif amont sort un jour (`npm audit`).

## Branche de dev
claude/meme-coin-development-MhZiV

## À faire / idées futures
- Backtest sur données historiques (gmgn-cli market kline)
- Nettoyage : retirer agents.js quand le Trading Floor sera définitivement abandonné
