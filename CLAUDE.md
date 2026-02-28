# Meme Coin Bot — Notes pour Claude

## Contexte du projet
Bot de trading automatique de meme coins Solana via Telegram.
Stack: Node.js, Telegraf, Jupiter API (swaps), DexScreener, GeckoTerminal, Birdeye, Pump.fun WebSocket.

## Architecture
- `index.js` — Point d'entrée, charge le wallet et démarre Bot + Scanner
- `src/bot.js` — Interface Telegram (commandes + callbacks)
- `src/scanner.js` — Détecte les tokens (DexScreener boosted/profiles + GeckoTerminal + Pump.fun WS)
- `src/trader.js` — Exécute les trades Jupiter, gère SL/TP/trailing stop, persistance disque
- `src/agents.js` — Débat Bull vs Bear vs Risk Manager (Claude Haiku)
- `src/birdeye.js` — Sécurité on-chain (mint authority, freeze, concentration holders)
- `src/dexscreener.js` — Client DexScreener API
- `src/geckoterminal.js` — Client GeckoTerminal API
- `src/pumpfun.js` — WebSocket PumpPortal (nouveaux tokens + graduations)
- `src/anthropic.js` — Wrapper Anthropic API
- `data/positions.json` — Persistance positions + historique (créé au runtime)

## Commandes Telegram implémentées
/start, /status, /balance, /scan, /positions, /history, /auto
/pnl — PnL réalisé + non réalisé en temps réel
/settings — Affiche maxSol, SL%, TP%
/set <maxsol|sl|tp> <valeur> — Modifie les paramètres à la volée
/analyse <adresse>, /buy <adresse> <sol>, /sell <adresse> [%]

## Features implémentées
- Scan multi-sources : DexScreener (boosted + profiles) + GeckoTerminal + Pump.fun WS
- Filtres : liquidité, volume 24h, market cap, âge du token
- Birdeye hard filter : mint authority active, créateur >20%, top10 holders >90%
- Débat IA 3 agents (Bull / Bear / Risk Manager) avec Claude Haiku
- Jupiter swaps (buy/sell) avec SL/TP automatique
- Trailing stop-loss : activé après +20% de gain, recul depuis le plus haut
- Persistance disque (positions.json) : survie aux redémarrages
- Messages Telegram en HTML (parse_mode: 'HTML')
- Auto-trade toggle (/auto)
- PnL réalisé tracké dans l'historique (champ pnlSol sur les SELL)

## Variables d'environnement (.env)
TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID, ANTHROPIC_API_KEY (obligatoires)
WALLET_PRIVATE_KEY (optionnel — trading désactivé sans)
SOLANA_RPC_URL (défaut: mainnet-beta public)
BIRDEYE_API_KEY (optionnel — sécurité on-chain désactivée sans)
MIN_LIQUIDITY_USD (défaut: 10000)
MIN_VOLUME_24H_USD (défaut: 50000)
MIN_MARKET_CAP_USD (défaut: 100000)
MAX_TOKEN_AGE_HOURS (défaut: 24)
MAX_POSITION_SOL (défaut: 0.1)
DEFAULT_STOP_LOSS_PCT (défaut: 20)
DEFAULT_TAKE_PROFIT_PCT (défaut: 50)

## Branche de dev
claude/french-greeting-wOjHx

## À faire / idées futures
- Filtre anti-rug amélioré (nombre de holders depuis Birdeye overview)
- Alertes hebdomadaires de perf (PnL total de la semaine)
- Dashboard web simple (Express + HTML)
- Backtest sur données historiques DexScreener
