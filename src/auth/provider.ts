/**
 * A small multi-user OAuth 2.1 authorization server.
 *
 * The MCP spec makes this server an OAuth resource server, and Claude's custom
 * connector flow drives the full authorization-code + PKCE dance. Each person
 * "authorizes" by signing in with their own kaloricketabulky.cz account on the
 * consent page; the server checks the e-mail against the owner's allowlist,
 * verifies the login against the site, keeps the (encrypted) md5 so it can log
 * in on their behalf later, and issues a token bound to that account.
 *
 * Only Claude's own callback URLs may be registered as redirect URIs, so a
 * look-alike client cannot use this consent page to phish a token.
 *
 * The SDK's `mcpAuthRouter` supplies the endpoints and discovery documents and
 * validates PKCE; this file supplies the storage and the consent screen.
 */

import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { KtError, md5Hex, type KtCredentials } from '../kt/client.js';
import { JsonStore } from './store.js';
import { AllowList, CredentialBox, LoginLimiter, normaliseEmail } from './users.js';

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
/** Registered clients that never obtained a token are dropped after a day. */
const UNUSED_CLIENT_TTL_SECONDS = 60 * 60 * 24;
export const MCP_SCOPE = 'caltrack:log';

interface PendingCode {
  clientId: string;
  user: string;
  codeChallenge: string;
  redirectUri: string;
  resource?: string;
  scopes: string[];
  expiresAt: number;
}

interface IssuedToken {
  clientId: string;
  /** Normalised e-mail of the kaloricketabulky.cz account this token acts as. */
  user: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

interface StoredUser {
  /** CredentialBox-sealed md5 hex of the password. */
  credentials: string;
  createdAt: number;
  lastLoginAt: number;
}

interface PersistedState {
  clients: Record<string, OAuthClientInformationFull>;
  accessTokens: Record<string, IssuedToken>;
  refreshTokens: Record<string, IssuedToken>;
  users: Record<string, StoredUser>;
}

const EMPTY_STATE: PersistedState = { clients: {}, accessTokens: {}, refreshTokens: {}, users: {} };

export interface ProviderOptions {
  stateFile: string;
  allowList: AllowList;
  box: CredentialBox;
  allowedRedirectUris: string[];
  /** Resolves if the site accepts the login, throws KtError if it rejects it. */
  verifyLogin: (credentials: KtCredentials) => Promise<void>;
  /** Called after a successful sign-in, so cached sessions pick up new credentials. */
  onLogin?: (user: string) => void;
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

export class MultiUserOAuthProvider implements OAuthServerProvider {
  private readonly store: JsonStore<PersistedState>;
  /** Authorization codes are short-lived; losing them on restart is fine. */
  private readonly pendingCodes = new Map<string, PendingCode>();
  private readonly limiter = new LoginLimiter();

  constructor(private readonly options: ProviderOptions) {
    this.store = new JsonStore(options.stateFile, EMPTY_STATE);
  }

  /** The stored login for an allowed user, or undefined if they must sign in again. */
  credentialsFor(user: string): KtCredentials | undefined {
    if (!this.options.allowList.has(user)) return undefined;
    const users = this.store.read().users;
    const record = Object.hasOwn(users, user) ? users[user] : undefined;
    if (!record) return undefined;
    try {
      return { email: user, passwordMd5: this.options.box.open(record.credentials) };
    } catch {
      // Wrong key (CREDENTIALS_KEY rotated) — treat as signed out.
      return undefined;
    }
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId: string) => {
        const clients = this.store.read().clients;
        // hasOwn guards all state lookups: keys arrive from the network, and
        // "__proto__" or "constructor" would otherwise return a truthy non-record.
        return Object.hasOwn(clients, clientId) ? clients[clientId] : undefined;
      },
      registerClient: async (client) => {
        const full = client as OAuthClientInformationFull;
        const foreign = full.redirect_uris.filter(uri => !this.options.allowedRedirectUris.includes(String(uri)));
        if (full.redirect_uris.length === 0 || foreign.length > 0) {
          console.warn(`[auth] refused client registration "${full.client_name ?? '?'}" redirect_uris=${full.redirect_uris.join(',')}`);
          throw new InvalidClientMetadataError('This server only accepts Claude connector clients');
        }
        this.store.update(state => {
          this.pruneUnusedClients(state);
          state.clients[full.client_id] = full;
        });
        return full;
      },
    };
  }

  /**
   * Renders the sign-in page, then (on POST) verifies the account and mints an
   * authorization code that redirects back to Claude. The SDK routes both verbs here.
   */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const req = res.req;
    const ip = req.ip ?? 'unknown';
    const email = typeof req.body?.email === 'string' ? normaliseEmail(req.body.email) : null;
    const password = typeof req.body?.password === 'string' ? req.body.password : null;
    const page = (status: number, error: string | null) => {
      res.status(status).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(this.consentPage(client, params, error, email ?? ''));
    };

    if (email === null || password === null) {
      page(200, null);
      return;
    }
    if (this.limiter.blocked(ip)) {
      page(429, 'Príliš veľa neúspešných pokusov. Skús to znova o 15 minút.');
      return;
    }
    if (email.length > 200 || password.length > 200 || email === '' || password === '') {
      page(400, 'Vyplň e-mail aj heslo.');
      return;
    }
    if (!this.options.allowList.has(email)) {
      this.limiter.recordFailure(ip, false);
      console.warn(`[auth] sign-in refused, not on the allowlist: ${email} from ${ip}`);
      page(403, 'Tento e-mail nemá prístup na tento server. Požiadaj správcu, nech ťa pridá.');
      return;
    }

    const credentials: KtCredentials = { email, passwordMd5: md5Hex(password) };
    try {
      await this.options.verifyLogin(credentials);
    } catch (error) {
      if (error instanceof KtError) {
        this.limiter.recordFailure(ip, true);
        console.warn(`[auth] Kalorické tabuľky rejected the login for ${email} from ${ip}: ${error.message}`);
        page(401, 'Kalorické tabuľky odmietli prihlásenie — skontroluj e-mail a heslo.');
      } else {
        console.error(`[auth] could not reach Kalorické tabuľky while signing in ${email}:`, error);
        page(502, 'Kalorické tabuľky teraz neodpovedajú. Skús to o chvíľu znova.');
      }
      return;
    }

    const now = Date.now();
    this.store.update(state => {
      const existing = Object.hasOwn(state.users, email) ? state.users[email] : undefined;
      state.users[email] = {
        credentials: this.options.box.seal(credentials.passwordMd5),
        createdAt: existing?.createdAt ?? now,
        lastLoginAt: now,
      };
    });
    this.options.onLogin?.(email);
    console.log(`[auth] ${email} connected client "${client.client_name ?? client.client_id}" from ${ip}`);

    const code = newToken();
    this.pendingCodes.set(code, {
      clientId: client.client_id,
      user: email,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      resource: params.resource?.href,
      scopes: params.scopes ?? [MCP_SCOPE],
      expiresAt: now + 60_000,
    });

    const redirect = new URL(params.redirectUri);
    redirect.searchParams.set('code', code);
    if (params.state !== undefined) redirect.searchParams.set('state', params.state);
    res.redirect(redirect.href);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const pending = this.pendingCodes.get(authorizationCode);
    if (!pending || pending.clientId !== client.client_id) {
      throw new InvalidGrantError('Unknown or expired authorization code');
    }
    return pending.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const pending = this.pendingCodes.get(authorizationCode);
    this.pendingCodes.delete(authorizationCode);

    if (!pending || pending.clientId !== client.client_id) {
      throw new InvalidGrantError('Unknown or expired authorization code');
    }
    if (Date.now() > pending.expiresAt) {
      throw new InvalidGrantError('Authorization code has expired');
    }
    if (redirectUri !== undefined && redirectUri !== pending.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    // RFC 8707: the token must be bound to the resource it was requested for.
    if (resource !== undefined && pending.resource !== undefined && resource.href !== pending.resource) {
      throw new InvalidGrantError('resource does not match the authorization request');
    }

    return this.issueTokens(client.client_id, pending.user, pending.scopes, pending.resource ?? resource?.href);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const refreshTokens = this.store.read().refreshTokens;
    const record = Object.hasOwn(refreshTokens, refreshToken) ? refreshTokens[refreshToken] : undefined;
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError('Unknown refresh token');
    }
    // Rotate: the presented refresh token is single-use.
    this.store.update(state => {
      delete state.refreshTokens[refreshToken];
    });
    if (Date.now() > record.expiresAt) {
      throw new InvalidGrantError('Refresh token has expired');
    }
    if (!this.credentialsFor(record.user)) {
      this.purgeUser(record.user);
      throw new InvalidGrantError('Access for this account has been removed');
    }
    // The grant's scopes are fixed at authorization; a refresh cannot widen them.
    return this.issueTokens(client.client_id, record.user, record.scopes, record.resource ?? resource?.href);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const accessTokens = this.store.read().accessTokens;
    const record = Object.hasOwn(accessTokens, token) ? accessTokens[token] : undefined;
    if (!record) throw new InvalidTokenError('Unknown access token');
    if (Date.now() > record.expiresAt) {
      this.store.update(state => {
        delete state.accessTokens[token];
      });
      throw new InvalidTokenError('Access token has expired');
    }
    // Removing an e-mail from the allowlist revokes that account immediately.
    if (!this.credentialsFor(record.user)) {
      this.purgeUser(record.user);
      throw new InvalidTokenError('Access for this account has been removed');
    }
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: Math.floor(record.expiresAt / 1000),
      resource: record.resource ? new URL(record.resource) : undefined,
      extra: { user: record.user },
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: { token: string }): Promise<void> {
    this.store.update(state => {
      delete state.accessTokens[request.token];
      delete state.refreshTokens[request.token];
    });
  }

  /** Forgets a user's stored login and every token issued to them. */
  private purgeUser(user: string): void {
    const state = this.store.read();
    const hasTokens = (tokens: Record<string, IssuedToken>) => Object.values(tokens).some(t => t.user === user);
    if (!Object.hasOwn(state.users, user) && !hasTokens(state.accessTokens) && !hasTokens(state.refreshTokens)) return;
    this.store.update(s => {
      delete s.users[user];
      for (const [key, value] of Object.entries(s.accessTokens)) if (value.user === user) delete s.accessTokens[key];
      for (const [key, value] of Object.entries(s.refreshTokens)) if (value.user === user) delete s.refreshTokens[key];
    });
    console.log(`[auth] removed stored login and tokens for ${user}`);
  }

  private pruneUnusedClients(state: PersistedState): void {
    const cutoff = Math.floor(Date.now() / 1000) - UNUSED_CLIENT_TTL_SECONDS;
    const inUse = new Set([
      ...Object.values(state.accessTokens).map(t => t.clientId),
      ...Object.values(state.refreshTokens).map(t => t.clientId),
    ]);
    for (const [id, client] of Object.entries(state.clients)) {
      if (!inUse.has(id) && (client.client_id_issued_at ?? 0) < cutoff) delete state.clients[id];
    }
  }

  private issueTokens(clientId: string, user: string, scopes: string[], resource?: string): OAuthTokens {
    const accessToken = newToken();
    const refreshToken = newToken();
    const expiresAt = Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000;

    this.store.update(state => {
      state.accessTokens[accessToken] = { clientId, user, scopes, resource, expiresAt };
      // Refresh tokens outlive access tokens; give them a generous window.
      state.refreshTokens[refreshToken] = {
        clientId,
        user,
        scopes,
        resource,
        expiresAt: expiresAt + ACCESS_TOKEN_TTL_SECONDS * 1000,
      };
      // Opportunistically drop anything already expired.
      const now = Date.now();
      for (const [key, value] of Object.entries(state.accessTokens)) {
        if (value.expiresAt < now) delete state.accessTokens[key];
      }
      for (const [key, value] of Object.entries(state.refreshTokens)) {
        if (value.expiresAt < now) delete state.refreshTokens[key];
      }
    });

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }

  private consentPage(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    error: string | null,
    email: string,
  ): string {
    const hidden = (name: string, value: string | undefined) =>
      value === undefined ? '' : `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;

    return `<!doctype html>
<html lang="sk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Kalorické tabuľky pre Claude</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 26rem; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.5; }
  h1 { font-size: 1.25rem; margin-bottom: .25rem; }
  p { opacity: .75; margin-top: 0; }
  label { display: block; font-weight: 600; margin: 1.1rem 0 .35rem; }
  input[type=email], input[type=password] { width: 100%; padding: .6rem .7rem; font-size: 1rem; border: 1px solid #999; border-radius: .4rem; box-sizing: border-box; }
  button { margin-top: 1.4rem; width: 100%; padding: .65rem; font-size: 1rem; font-weight: 600; border: 0; border-radius: .4rem; background: #2e7d32; color: #fff; cursor: pointer; }
  .error { background: #fdecea; color: #8a1c12; padding: .6rem .75rem; border-radius: .4rem; margin-top: 1rem; }
  .small { font-size: .82rem; opacity: .7; margin-top: 1.5rem; border-top: 1px solid #8884; padding-top: .75rem; }
</style></head><body>
<h1>Prepojiť Claude s Kalorickými tabuľkami</h1>
<p>Prihlás sa e-mailom a heslom, ktorými sa prihlasuješ do Kalorických tabuliek. Claude potom bude môcť čítať a zapisovať tvoj jedálniček.</p>
${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
<form method="POST">
  ${hidden('client_id', client.client_id)}
  ${hidden('redirect_uri', params.redirectUri)}
  ${hidden('code_challenge', params.codeChallenge)}
  ${hidden('code_challenge_method', 'S256')}
  ${hidden('state', params.state)}
  ${hidden('scope', (params.scopes ?? [MCP_SCOPE]).join(' '))}
  ${hidden('resource', params.resource?.href)}
  ${hidden('response_type', 'code')}
  <label for="email">E-mail</label>
  <input type="email" id="email" name="email" value="${escapeHtml(email)}" autocomplete="username" autofocus required maxlength="200">
  <label for="password">Heslo</label>
  <input type="password" id="password" name="password" autocomplete="current-password" required maxlength="200">
  <button type="submit">Prihlásiť a povoliť</button>
</form>
<div class="small">
  Server si uloží zašifrovaný odtlačok hesla (nie heslo samotné), aby sa mohol prihlasovať za teba.
  Ten však na prihlásenie do Kalorických tabuliek stačí, preto tam používaj heslo, ktoré nemáš nikde inde.<br>
  Žiada: <strong>${escapeHtml(client.client_name ?? client.client_id)}</strong>
</div>
</body></html>`;
  }
}
