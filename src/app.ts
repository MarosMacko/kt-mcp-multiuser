/**
 * The Express app: the MCP endpoint, the OAuth 2.1 authorization-server
 * endpoints the connector flow needs, and a few plain pages.
 *
 *   POST /mcp                                   the MCP endpoint (bearer-protected)
 *   /.well-known/oauth-protected-resource       RFC 9728 discovery
 *   /.well-known/oauth-authorization-server     RFC 8414 discovery
 *   /authorize /token /register /revoke         OAuth endpoints (from the SDK)
 *   GET /                                       landing page: what this is, how to connect
 *   GET /privacy                                privacy notice
 *   GET|POST /forget                            disconnect an account and delete its data
 *   GET /healthz                                liveness, unauthenticated
 *   GET /badge/users.json                       number of connected accounts, as a shields.io endpoint badge
 *
 * Kept separate from the entrypoint so tests can build it with a stubbed
 * login check instead of a real Kalorické tabuľky account.
 */

import express from 'express';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { Config } from './config.js';
import { isKtSite, KtClient, type KtCredentials } from './kt/client.js';
import { registerTools, serverInstructions } from './mcp/tools.js';
import { type AccountAuth, MCP_SCOPE, MultiUserOAuthProvider, preferredSite } from './auth/provider.js';
import { AllowList, Keyring } from './auth/users.js';
import { forgetPage, landingPage, privacyPage, sendPage } from './web/pages.js';
import { BUILD } from './version.js';

export interface AppDeps {
  verifyLogin: (credentials: KtCredentials) => Promise<void>;
  createClient: (credentials: KtCredentials) => KtClient;
}

export const realDeps: AppDeps = {
  verifyLogin: credentials => new KtClient(credentials).verifyLogin(),
  createClient: credentials => new KtClient(credentials),
};

/** Logged-in site sessions are kept warm this long after a user's last call. */
const CLIENT_IDLE_MS = 60 * 60 * 1000;
const MAX_CACHED_CLIENTS = 500;
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

export function createApp(config: Config, deps: AppDeps = realDeps): express.Express {
  const mcpEndpoint = new URL('/mcp', config.publicUrl);

  /** One long-lived client per account, so its session cookie and lookup cache are reused. */
  const clients = new Map<string, { client: KtClient; passwordMd5: string; site: string | undefined; lastUsed: number }>();

  const allowList = new AllowList(config.allowedUsersFile);
  const provider = new MultiUserOAuthProvider({
    stateFile: join(config.stateDir, 'oauth-state.json'),
    allowList,
    keyring: new Keyring(config.credentialsKey),
    allowedRedirectUris: config.allowedRedirectUris,
    allowedRedirectPatterns: config.allowedRedirectPatterns,
    maxFailedLoginsPerHour: config.maxFailedLoginsPerHour,
    verifyLogin: deps.verifyLogin,
    // A fresh sign-in may carry a new password; start that account's session over.
    onLogin: userKey => clients.delete(userKey),
  });

  function clientFor(account: AccountAuth): KtClient {
    const now = Date.now();
    const cached = clients.get(account.userKey);
    if (cached && cached.passwordMd5 === account.credentials.passwordMd5 && cached.site === account.credentials.site) {
      // Re-insert so Map order stays least-recently-used first.
      clients.delete(account.userKey);
      clients.set(account.userKey, { ...cached, lastUsed: now });
      return cached.client;
    }
    const client = deps.createClient(account.credentials);
    clients.delete(account.userKey);
    clients.set(account.userKey, { client, passwordMd5: account.credentials.passwordMd5, site: account.credentials.site, lastUsed: now });
    while (clients.size > MAX_CACHED_CLIENTS) {
      const oldest = clients.keys().next().value;
      if (oldest === undefined) break;
      clients.delete(oldest);
    }
    return client;
  }

  const sweep = setInterval(() => {
    provider.sweep();
    const cutoff = Date.now() - CLIENT_IDLE_MS;
    for (const [key, entry] of clients) if (entry.lastUsed < cutoff) clients.delete(key);
  }, SWEEP_INTERVAL_MS);
  sweep.unref();

  const app = express();
  app.disable('x-powered-by');
  // Trust exactly the configured number of reverse-proxy hops (default one:
  // Caddy or nginx in front) and no further. `true` would trust any
  // X-Forwarded-For the caller sends, letting an attacker mint a fresh
  // rate-limit bucket per request and defeat brute-force protection on
  // /authorize. The proxy must overwrite that header, not append to it.
  app.set('trust proxy', config.trustProxyHops);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  /**
   * The MCP spec requires Origin validation to defend against DNS rebinding.
   * Browsers set Origin; server-side and CLI clients usually do not, so only
   * reject an Origin that is present and foreign. The hosted clients' own
   * origins are tolerated in case their backends send one (requests still
   * need a token).
   */
  const allowedOrigins = new Set([config.publicUrl.origin, ...config.allowedOrigins]);
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      console.warn(`[http] refused Origin ${JSON.stringify(origin)} on ${req.method} ${req.path}`);
      res.status(403).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Forbidden origin' } });
      return;
    }
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', endpoint: mcpEndpoint.href, version: BUILD.version, commit: BUILD.commit, modified: BUILD.dirty });
  });

  // https://shields.io/badges/endpoint-badge — the README shows it. Only a count, never who.
  app.get('/badge/users.json', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({ schemaVersion: 1, label: 'users', message: String(provider.activeUsers()), color: 'blue' });
  });

  app.get('/', (_req, res) => sendPage(res, 200, landingPage(config.publicUrl, allowList.restricted), { index: true }));
  app.get('/privacy', (_req, res) => sendPage(res, 200, privacyPage(config.operator), { index: true }));
  app.get('/forget', (req, res) => sendPage(res, 200, forgetPage(null, '', preferredSite(req.get('accept-language')))));
  app.post('/forget', async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const site = isKtSite(req.body?.site) ? req.body.site : preferredSite(req.get('accept-language'));
    const outcome = await provider.forgetWithLogin(email, password, site, req.ip ?? 'unknown');
    const status = { done: 200, nothing: 200, invalid: 400, rejected: 401, blocked: 429, unreachable: 502 }[outcome];
    sendPage(res, status, forgetPage(outcome, email.slice(0, 200), site));
  });

  // OAuth authorization-server + protected-resource metadata and endpoints.
  // Must be mounted at the application root.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: config.publicUrl,
      resourceServerUrl: mcpEndpoint,
      resourceName: 'Kalorické tabuľky',
      scopesSupported: [MCP_SCOPE],
    }),
  );

  const requireAuth = requireBearerAuth({
    verifier: provider,
    requiredScopes: [MCP_SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpEndpoint),
  });

  /**
   * One MCP server and transport per request, bound to the caller's account.
   *
   * The 2026-07-28 revision of Streamable HTTP removed protocol-level sessions,
   * so each POST is self-contained — statelessness is the intended shape here,
   * and it means a redeploy can never strand a half-open session.
   */
  app.post('/mcp', requireAuth, async (req, res) => {
    const account = req.auth?.extra?.['account'] as AccountAuth | undefined;
    if (!account) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Sign in again' } });
      return;
    }
    const kt = clientFor(account);
    const sk = account.credentials.site === 'sk';
    const siteName = sk ? 'kaloricketabulky.sk' : 'kaloricketabulky.cz';
    const siteLanguage = sk ? 'Slovak' : 'Czech';

    const server = new McpServer(
      // MCP clients show this; the commit tells copies of the same version apart.
      { name: 'kaloricketabulky', version: BUILD.commit ? `${BUILD.version}+${BUILD.commit}` : BUILD.version },
      {
        instructions: serverInstructions(siteName, siteLanguage),
      },
    );
    registerTools(server, kt);
    registerAccountTools(server, () => {
      clients.delete(account.userKey);
      return provider.forgetUser(account.userKey);
    });

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[mcp] request failed:', error instanceof Error ? error.message : error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' } });
      }
    }
  });

  // Pre-2026-07-28 clients open a GET stream and DELETE sessions; this revision
  // has neither.
  app.all('/mcp', (_req, res) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32601, message: 'Method not allowed' } });
  });

  return app;
}

/** Tools about the connection itself rather than the diary. */
function registerAccountTools(server: McpServer, forget: () => number): void {
  server.registerTool(
    'disconnect_account',
    {
      title: 'Disconnect this account from the server',
      description:
        'Deletes everything this MCP server stores about the user: their encrypted Kalorické tabuľky login and the ' +
        'access of every AI client they connected. Their diary itself is not touched. Afterwards this ' +
        'connector stops working until they sign in again. Call only when the user explicitly asks to disconnect, ' +
        'sign out, or delete their data from this server.',
      inputSchema: {},
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const removed = forget();
      console.log(`[tool] disconnect_account -> ${removed} tokens removed`);
      return {
        content: [
          {
            type: 'text' as const,
            text:
              'Disconnected. The stored login and all access tokens for this account were deleted from the server. ' +
              'To use the connector again, the user removes it in their AI app and adds it again (which shows the sign-in page).',
          },
        ],
      };
    },
  );
}
