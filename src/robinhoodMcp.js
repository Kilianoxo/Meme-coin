/**
 * Client MCP — Robinhood Agentic Trading
 *
 * Connecte Agios au serveur MCP officiel de Robinhood (agent.robinhood.com/mcp/trading)
 * pour trader de VRAIES actions US sur un compte "Agentic" dédié (fonds pré-chargés,
 * séparés du compte principal — le reste du compte Robinhood reste en lecture seule).
 *
 * Authentification : OAuth 2.0 + PKCE (le serveur publie ses métadonnées OAuth,
 * découvertes automatiquement par le SDK MCP — aucun secret Robinhood en dur ici).
 * Étape interactive UNIQUE : ouvrir un lien dans un navigateur sur la machine qui
 * fait tourner le bot (pas cette session cloud), se connecter à Robinhood, autoriser
 * l'agent. Les tokens (accès + refresh) sont ensuite persistés sur disque, comme
 * gmgn-cli le fait pour sa clé API.
 *
 * Contrairement à GMGN, on NE code AUCUN nom d'outil en dur : MCP est auto-descriptif
 * (tools/list), donc listTools()/callTool() servent tels quels tout ce que Robinhood
 * expose (portefeuille, ordres…), sans supposer un schéma précis.
 *
 * Sécurité :
 *  - Aucun mot de passe Robinhood ne transite jamais par ce code (OAuth pur)
 *  - Tokens stockés dans ~/.config/robinhood-mcp/ (chmod 600), jamais dans le repo
 *  - Le compte Agentic est isolé par Robinhood lui-même — cette couche n'ajoute
 *    aucun accès supplémentaire, elle appelle juste les outils exposés
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');

const CONFIG_DIR      = path.join(os.homedir(), '.config', 'robinhood-mcp');
const TOKENS_PATH     = path.join(CONFIG_DIR, 'tokens.json');
const CLIENT_PATH     = path.join(CONFIG_DIR, 'client.json');
const SERVER_URL      = process.env.ROBINHOOD_MCP_URL || 'https://agent.robinhood.com/mcp/trading';
const CALLBACK_PORT   = parseInt(process.env.ROBINHOOD_MCP_CALLBACK_PORT || '8090', 10);
const CALLBACK_URL    = `http://localhost:${CALLBACK_PORT}/callback`;
const SETUP_TIMEOUT_MS = 5 * 60_000; // 5 min pour compléter l'autorisation dans le navigateur

// ─── Provider OAuth — persiste sur disque au lieu d'InMemoryOAuthClientProvider ──

class FileOAuthClientProvider {
  constructor(onRedirect) {
    this._onRedirect = onRedirect || (() => {});
    this._codeVerifier = null;
  }

  get redirectUrl() { return CALLBACK_URL; }

  get clientMetadata() {
    return {
      client_name:   'Agios (Meme Coin Bot)',
      redirect_uris: [CALLBACK_URL],
      grant_types:   ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // PKCE public client
    };
  }

  clientInformation() {
    try {
      return JSON.parse(fs.readFileSync(CLIENT_PATH, 'utf8'));
    } catch {
      return undefined;
    }
  }

  saveClientInformation(info) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CLIENT_PATH, JSON.stringify(info, null, 2));
    try { fs.chmodSync(CLIENT_PATH, 0o600); } catch { /* Windows */ }
  }

  tokens() {
    try {
      return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
    } catch {
      return undefined;
    }
  }

  saveTokens(tokens) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
    try { fs.chmodSync(TOKENS_PATH, 0o600); } catch { /* Windows */ }
  }

  redirectToAuthorization(authorizationUrl) {
    this._onRedirect(authorizationUrl.toString());
  }

  saveCodeVerifier(v) { this._codeVerifier = v; }
  codeVerifier() {
    if (!this._codeVerifier) throw new Error('Aucun code_verifier PKCE en mémoire — relance la connexion');
    return this._codeVerifier;
  }
}

/** Supprime les tokens persistés (déconnexion) */
function disconnect() {
  for (const p of [TOKENS_PATH, CLIENT_PATH]) {
    try { fs.unlinkSync(p); } catch { /* déjà absent */ }
  }
}

function hasStoredTokens() {
  try { return !!JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'))?.access_token; }
  catch { return false; }
}

// ─── Serveur de callback local (le temps de l'autorisation navigateur) ──────

function _waitForCallback(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Délai dépassé — l'autorisation n'a pas été complétée dans les 5 minutes"));
    }, timeoutMs);

    const server = http.createServer((req, res) => {
      if (!req.url || !req.url.startsWith('/callback')) {
        res.writeHead(404); res.end(); return;
      }
      const url   = new URL(req.url, `http://localhost:${port}`);
      const code  = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (code) {
        res.end('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>✅ Robinhood connecté</h2><p>Tu peux fermer cette fenêtre et retourner sur Telegram.</p></body></html>');
      } else {
        res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>❌ Échec</h2><p>${error || 'erreur inconnue'}</p></body></html>`);
      }

      clearTimeout(timer);
      setTimeout(() => server.close(), 1000);
      if (code) resolve(code);
      else reject(new Error(`Autorisation refusée par Robinhood : ${error}`));
    });

    server.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} déjà utilisé — une autre connexion est peut-être déjà en cours`));
      } else {
        reject(err);
      }
    });

    server.listen(port);
  });
}

// ─── Client MCP (lazy — importé en ESM dynamique, le SDK est ESM-only) ──────

let _mcpModules = null;
async function _loadSdk() {
  if (_mcpModules) return _mcpModules;
  const [{ Client }, { StreamableHTTPClientTransport }, { UnauthorizedError }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/client/auth.js'),
  ]);
  _mcpModules = { Client, StreamableHTTPClientTransport, UnauthorizedError };
  return _mcpModules;
}

let _client       = null; // instance Client connectée (ou null)
let _connecting   = null; // Promise en cours si une connexion est déjà en vol

/**
 * Connexion silencieuse — réutilise les tokens persistés. Ne déclenche JAMAIS
 * de flux OAuth interactif (utiliser startSetup() pour ça). Retourne le client
 * connecté, ou null si pas encore autorisé / tokens expirés sans refresh possible.
 */
async function _connectSilent() {
  if (_client) return _client;
  if (!hasStoredTokens()) return null;
  if (_connecting) return _connecting;

  _connecting = (async () => {
    try {
      const { Client, StreamableHTTPClientTransport } = await _loadSdk();
      const provider  = new FileOAuthClientProvider();
      const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), { authProvider: provider });
      const client    = new Client({ name: 'agios-meme-coin-bot', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);
      _client = client;
      console.log('[RobinhoodMCP] ✅ Connecté (tokens existants)');
      return _client;
    } catch (err) {
      console.warn('[RobinhoodMCP] Connexion silencieuse échouée:', err.message);
      return null;
    } finally {
      _connecting = null;
    }
  })();

  return _connecting;
}

/** true si un client MCP Robinhood est actuellement connecté et utilisable */
async function isAvailable() {
  return !!(await _connectSilent());
}

/**
 * Lance le flux d'autorisation interactif COMPLET : ouvre un lien à donner au
 * trader, attend qu'il l'autorise dans son navigateur, capture le code,
 * termine le handshake OAuth. À appeler UNE FOIS depuis la machine qui fait
 * tourner le bot (pas depuis un environnement cloud sans navigateur/réseau).
 *
 * @param {(url: string) => void} onAuthUrl — reçoit l'URL à envoyer au trader (Telegram)
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function startSetup(onAuthUrl) {
  const { Client, StreamableHTTPClientTransport, UnauthorizedError } = await _loadSdk();

  let authUrlSent = false;
  const provider = new FileOAuthClientProvider((url) => {
    authUrlSent = true;
    onAuthUrl(url);
  });

  const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), { authProvider: provider });
  const client    = new Client({ name: 'agios-meme-coin-bot', version: '1.0.0' }, { capabilities: {} });

  try {
    await client.connect(transport);
    // Tokens déjà valides (reconnexion) — pas besoin de navigateur
    _client = client;
    return { ok: true };
  } catch (err) {
    if (!(err instanceof UnauthorizedError) && err?.constructor?.name !== 'UnauthorizedError') {
      return { ok: false, error: err.message };
    }
  }

  if (!authUrlSent) {
    return { ok: false, error: "Le serveur n'a pas fourni de lien d'autorisation (vérifie ROBINHOOD_MCP_URL)" };
  }

  try {
    const code = await _waitForCallback(CALLBACK_PORT, SETUP_TIMEOUT_MS);
    await transport.finishAuth(code);
    // Reconnecte avec les tokens fraîchement obtenus
    const transport2 = new StreamableHTTPClientTransport(new URL(SERVER_URL), { authProvider: provider });
    const client2 = new Client({ name: 'agios-meme-coin-bot', version: '1.0.0' }, { capabilities: {} });
    await client2.connect(transport2);
    _client = client2;
    console.log('[RobinhoodMCP] ✅ Autorisation complétée, connecté.');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Coupe la connexion + oublie les tokens (déconnexion complète) */
async function disconnectAll() {
  try { await _client?.close?.(); } catch { /* silencieux */ }
  _client = null;
  disconnect();
}

// ─── Outils MCP — passthrough générique, aucun nom codé en dur ─────────────

/**
 * Liste les outils exposés par le serveur Robinhood (portefeuille, ordres…),
 * au format natif MCP (name, description, inputSchema en JSON Schema).
 */
async function listTools() {
  const client = await _connectSilent();
  if (!client) return [];
  try {
    const res = await client.listTools();
    return res.tools || [];
  } catch (err) {
    console.warn('[RobinhoodMCP] listTools:', err.message);
    return [];
  }
}

/** Appelle un outil Robinhood par son nom exact (tel que retourné par listTools) */
async function callTool(name, args = {}) {
  const client = await _connectSilent();
  if (!client) throw new Error('Robinhood MCP non connecté — /robinhood_connect sur Telegram');
  const res = await client.callTool({ name, arguments: args });
  return res;
}

module.exports = {
  SERVER_URL,
  isAvailable,
  hasStoredTokens,
  startSetup,
  disconnectAll,
  listTools,
  callTool,
};
