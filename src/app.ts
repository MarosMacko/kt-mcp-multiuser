/**
 * The Express app: the MCP endpoint plus the OAuth 2.1 authorization-server
 * endpoints the Claude connector flow needs.
 *
 *   POST /mcp                                   the MCP endpoint (bearer-protected)
 *   /.well-known/oauth-protected-resource       RFC 9728 discovery
 *   /.well-known/oauth-authorization-server     RFC 8414 discovery
 *   /authorize /token /register /revoke         OAuth endpoints (from the SDK)
 *   GET /healthz                                liveness, unauthenticated
 *
 * Kept separate from the entrypoint so tests can build it with a stubbed
 * login check instead of a real kaloricketabulky.cz account.
 */

import express from 'express';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { Config } from './config.js';
import { KtClient, type KtCredentials } from './kt/client.js';
import { registerTools } from './mcp/tools.js';
import { MCP_SCOPE, MultiUserOAuthProvider } from './auth/provider.js';
import { AllowList, CredentialBox } from './auth/users.js';

export interface AppDeps {
  verifyLogin: (credentials: KtCredentials) => Promise<void>;
  createClient: (credentials: KtCredentials) => KtClient;
}

export const realDeps: AppDeps = {
  verifyLogin: credentials => new KtClient(credentials).verifyLogin(),
  createClient: credentials => new KtClient(credentials),
};

export function createApp(config: Config, deps: AppDeps = realDeps): express.Express {
  const mcpEndpoint = new URL('/mcp', config.publicUrl);

  /** One long-lived client per account, so its session cookie and lookup cache are reused. */
  const clients = new Map<string, KtClient>();

  const provider = new MultiUserOAuthProvider({
    stateFile: join(config.stateDir, 'oauth-state.json'),
    allowList: new AllowList(config.allowedUsersFile),
    box: new CredentialBox(config.credentialsKey),
    allowedRedirectUris: config.allowedRedirectUris,
    allowedRedirectPatterns: config.allowedRedirectPatterns,
    verifyLogin: deps.verifyLogin,
    // A fresh sign-in may carry a new password; start that account's session over.
    onLogin: user => clients.delete(user),
  });

  function clientFor(user: string): KtClient | undefined {
    const existing = clients.get(user);
    if (existing) return existing;
    const credentials = provider.credentialsFor(user);
    if (!credentials) return undefined;
    const client = deps.createClient(credentials);
    clients.set(user, client);
    return client;
  }

  const app = express();
  app.disable('x-powered-by');
  // Trust exactly one hop — our own reverse proxy (Caddy) — and no further.
  // `true` would trust any X-Forwarded-For the caller sends, letting an
  // attacker mint a fresh rate-limit bucket per request and defeat brute-force
  // protection on /authorize. Caddy replaces that header with the real client
  // address for untrusted callers.
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  /**
   * The MCP spec requires Origin validation to defend against DNS rebinding.
   * Browsers set Origin; Claude's server-side fetches do not, so only reject an
   * Origin that is present and foreign. The hosted clients' own origins are
   * tolerated in case their backends send one (requests still need a token).
   */
  const allowedOrigins = new Set([config.publicUrl.origin, ...config.allowedOrigins]);
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      console.warn(`[http] refused Origin ${origin} on ${req.method} ${req.path}`);
      res.status(403).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Forbidden origin' } });
      return;
    }
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', endpoint: mcpEndpoint.href });
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
    const user = req.auth?.extra?.['user'];
    const kt = typeof user === 'string' ? clientFor(user) : undefined;
    if (!kt) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Sign in again' } });
      return;
    }

    const server = new McpServer(
      { name: 'kaloricketabulky', version: '0.1.0' },
      {
        instructions:
          'Logs food into the user\'s kaloricketabulky.cz diary. The food database is Czech: search with Czech terms for the best matches. ' +
          'When the user gives a count rather than a weight ("3 eggs"), call get_food_portions and log a natural portion unit instead of estimating grams.',
      },
    );
    registerTools(server, kt);

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[mcp] request failed:', error);
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
