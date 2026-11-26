/**
 * A small multi-user OAuth 2.1 authorization server.
 *
 * The MCP spec makes this server an OAuth resource server, and the connector
 * flows of Claude, ChatGPT and local MCP clients drive the full
 * authorization-code + PKCE dance. Each person "authorizes" by signing in with
 * their own Kalorické tabuľky account (.sk or .cz) on the consent page; the server
 * verifies the login against the site and issues tokens bound to that account.
 *
 * What is stored (see users.ts for the key rules):
 *   - tokens only as SHA-256 hashes,
 *   - each token's login (e-mail + md5) encrypted with a key derived from the
 *     server secret and that token, so only a live token can decrypt it,
 *   - the account only as an HMAC "user key", to find one person's tokens.
 *
 * Only known connector callbacks and loopback addresses may be registered as
 * redirect URIs, so a look-alike client cannot use this consent page to phish
 * a token for a site it controls.
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
import { isKtSite, KtError, md5Hex, type KtCredentials, type KtSite } from '../kt/client.js';
import { consentPage, formTargetFor, sendPage } from '../web/pages.js';
import { JsonStore } from './store.js';
import { AllowList, Keyring, LoginLimiter, logId, normaliseEmail } from './users.js';

/** Clients refresh well before this; a shorter life limits what a leaked token is worth. */
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;
/** Also the retention period: an account unused this long is forgotten. */
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 60;
/** Registered clients that never obtained a token are dropped after a day... */
const UNUSED_CLIENT_TTL_SECONDS = 60 * 60 * 24;
/** ...or sooner, oldest first, if registrations pile up. */
const MAX_UNUSED_CLIENTS = 500;
const AUTH_CODE_TTL_MS = 60_000;
const STATE_VERSION = 2;
export const MCP_SCOPE = 'caltrack:log';

interface PendingCode {
  clientId: string;
  userKey: string;
  credentials: KtCredentials;
  codeChallenge: string;
  redirectUri: string;
  resource?: string;
  scopes: string[];
  expiresAt: number;
}

interface StoredToken {
  clientId: string;
  /** HMAC of the account's e-mail (Keyring.userKey). */
  userKey: string;
  /** One authorization; its access and refresh tokens share it. */
  grantId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
  /** JSON KtCredentials sealed with Keyring.boxFor(this token). */
  credentials: string;
}

interface PersistedState {
  version?: number;
  clients: Record<string, OAuthClientInformationFull>;
  /** Keyed by Keyring.tokenId(token). */
  accessTokens: Record<string, StoredToken>;
  refreshTokens: Record<string, StoredToken>;
}

/** State written before v2: raw tokens as keys, readable e-mails, one login per user. */
interface LegacyToken {
  clientId: string;
  user: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

const EMPTY_STATE: PersistedState = { clients: {}, accessTokens: {}, refreshTokens: {} };

export interface ProviderOptions {
  stateFile: string;
  allowList: AllowList;
  keyring: Keyring;
  allowedRedirectUris: string[];
  allowedRedirectPatterns: RegExp[];
  maxFailedLoginsPerHour?: number;
  /** Resolves if the site accepts the login, throws KtError if it rejects it. */
  verifyLogin: (credentials: KtCredentials) => Promise<void>;
  /** Called after a successful sign-in, so cached sessions pick up new credentials. */
  onLogin?: (userKey: string) => void;
}

/** What a verified access token carries into the MCP request. */
export interface AccountAuth {
  userKey: string;
  credentials: KtCredentials;
}

export type ForgetResult = 'done' | 'nothing' | 'rejected' | 'blocked' | 'unreachable' | 'invalid';

/** sk for browsers that prefer Slovak (before Czech), cz otherwise. */
export function preferredSite(acceptLanguage: string | undefined): KtSite {
  const languages = (acceptLanguage ?? '')
    .split(',')
    .map(part => part.trim().split(';')[0]?.toLowerCase().split('-')[0])
    .filter(Boolean);
  const sk = languages.indexOf('sk');
  const cs = languages.indexOf('cs');
  return sk !== -1 && (cs === -1 || sk < cs) ? 'sk' : 'cz';
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

const own = <T>(record: Record<string, T>, key: string): T | undefined =>
  // hasOwn guards all state lookups: keys arrive from the network, and
  // "__proto__" or "constructor" would otherwise return a truthy non-record.
  Object.hasOwn(record, key) ? record[key] : undefined;

export class MultiUserOAuthProvider implements OAuthServerProvider {
  private readonly store: JsonStore<PersistedState>;
  private readonly keyring: Keyring;
  /** Authorization codes are short-lived; losing them on restart is fine. */
  private readonly pendingCodes = new Map<string, PendingCode>();
  private readonly limiter: LoginLimiter;

  constructor(private readonly options: ProviderOptions) {
    this.keyring = options.keyring;
    this.limiter = new LoginLimiter(options.maxFailedLoginsPerHour);
    this.store = new JsonStore(options.stateFile, EMPTY_STATE);
    if (this.store.read().version !== STATE_VERSION) this.migrate();
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId: string) => own(this.store.read().clients, clientId),
      registerClient: async (client) => {
        const full = client as OAuthClientInformationFull;
        const allowed = (uri: string) =>
          this.options.allowedRedirectUris.includes(uri) ||
          this.options.allowedRedirectPatterns.some(pattern => pattern.test(uri));
        const uris = full.redirect_uris.map(String);
        if (uris.length === 0 || !uris.every(allowed)) {
          console.warn(`[auth] refused client registration ${JSON.stringify(full.client_name ?? '?')} redirect_uris=${JSON.stringify(uris)}`);
          throw new InvalidClientMetadataError(
            'This server accepts Claude, ChatGPT and local (loopback) MCP clients only',
          );
        }
        console.log(`[auth] registered client ${JSON.stringify(full.client_name ?? '?')} redirect_uris=${JSON.stringify(uris)}`);
        this.store.update(state => {
          this.pruneClients(state);
          state.clients[full.client_id] = full;
        });
        return full;
      },
    };
  }

  /**
   * Renders the sign-in page, then (on POST) verifies the account and mints an
   * authorization code that redirects back to the client. The SDK routes both verbs here.
   */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const req = res.req;
    const ip = req.ip ?? 'unknown';
    const email = typeof req.body?.email === 'string' ? normaliseEmail(req.body.email) : null;
    const password = typeof req.body?.password === 'string' ? req.body.password : null;
    // Which site the account lives on: .sk and .cz have separate logins.
    // Preselected from the browser language.
    const site: KtSite = isKtSite(req.body?.site) ? req.body.site : preferredSite(req.get('accept-language'));
    const formTarget = formTargetFor(params.redirectUri);
    const page = (status: number, error: string | null) =>
      sendPage(
        res,
        status,
        consentPage({
          clientName: client.client_name ?? client.client_id,
          redirectUri: params.redirectUri,
          error,
          email: email ?? '',
          site,
          restricted: this.options.allowList.restricted,
          hidden: {
            client_id: client.client_id,
            redirect_uri: params.redirectUri,
            code_challenge: params.codeChallenge,
            code_challenge_method: 'S256',
            state: params.state,
            scope: (params.scopes ?? [MCP_SCOPE]).join(' '),
            resource: params.resource?.href,
            response_type: 'code',
          },
        }),
        { formTargets: formTarget ? [formTarget] : [] },
      );

    if (email === null || password === null) {
      page(200, null);
      return;
    }
    if (email.length > 200 || password.length > 200 || email === '' || password === '') {
      page(400, 'Vyplň e-mail aj heslo.');
      return;
    }
    const userKey = this.keyring.userKey(email, site);
    if (this.limiter.blocked(ip, userKey)) {
      page(429, 'Príliš veľa pokusov o prihlásenie. Skús to znova o 15 minút.');
      return;
    }
    this.limiter.recordAttempt(ip);
    if (!this.options.allowList.has(email)) {
      this.limiter.recordFailure(ip, null, false);
      console.warn(`[auth] sign-in refused, not on the allowlist (${logId(userKey)})`);
      page(403, 'Tento e-mail nemá prístup na tento server. Požiadaj správcu, nech ťa pridá.');
      return;
    }

    const credentials: KtCredentials = { email, passwordMd5: md5Hex(password), site };
    const verdict = await this.checkLogin(credentials, ip, userKey);
    if (verdict === 'rejected') {
      page(401, `kaloricketabulky.${site} odmietli prihlásenie. Skontroluj e-mail, heslo a či máš účet práve na .${site}.`);
      return;
    }
    if (verdict === 'unreachable') {
      page(502, 'Kalorické tabuľky teraz neodpovedajú. Skús to o chvíľu znova.');
      return;
    }

    this.options.onLogin?.(userKey);
    console.log(`[auth] ${logId(userKey)} connected client ${JSON.stringify(client.client_name ?? client.client_id)}`);

    const now = Date.now();
    for (const [code, pending] of this.pendingCodes) if (pending.expiresAt < now) this.pendingCodes.delete(code);
    const code = newToken();
    this.pendingCodes.set(code, {
      clientId: client.client_id,
      userKey,
      credentials,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      resource: params.resource?.href,
      scopes: params.scopes ?? [MCP_SCOPE],
      expiresAt: now + AUTH_CODE_TTL_MS,
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

    return this.issueTokens({
      clientId: client.client_id,
      userKey: pending.userKey,
      grantId: newToken(),
      scopes: pending.scopes,
      resource: pending.resource ?? resource?.href,
      credentials: pending.credentials,
    });
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const id = this.keyring.tokenId(refreshToken);
    const record = own(this.store.read().refreshTokens, id);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError('Unknown refresh token');
    }
    // Rotate: the presented refresh token is single-use, and the access
    // tokens of the same grant are retired with it.
    this.store.update(state => {
      delete state.refreshTokens[id];
      for (const [key, value] of Object.entries(state.accessTokens)) {
        if (value.grantId === record.grantId) delete state.accessTokens[key];
      }
    });
    if (Date.now() > record.expiresAt) {
      throw new InvalidGrantError('Refresh token has expired');
    }
    const credentials = this.openCredentials(record, refreshToken);
    if (!credentials) throw new InvalidGrantError('Sign in again');
    if (!this.options.allowList.has(credentials.email)) {
      this.forgetUser(record.userKey);
      throw new InvalidGrantError('Access for this account has been removed');
    }
    // The grant's scopes are fixed at authorization; a refresh cannot widen them.
    return this.issueTokens({
      clientId: client.client_id,
      userKey: record.userKey,
      grantId: record.grantId,
      scopes: record.scopes,
      resource: record.resource ?? resource?.href,
      credentials,
    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const id = this.keyring.tokenId(token);
    const record = own(this.store.read().accessTokens, id);
    if (!record) throw new InvalidTokenError('Unknown access token');
    if (Date.now() > record.expiresAt) {
      this.store.update(state => {
        delete state.accessTokens[id];
      });
      throw new InvalidTokenError('Access token has expired');
    }
    const credentials = this.openCredentials(record, token);
    if (!credentials) {
      // Server secret rotated: this token can no longer be honoured.
      this.store.update(state => {
        delete state.accessTokens[id];
      });
      throw new InvalidTokenError('Sign in again');
    }
    // Removing an e-mail from the allowlist revokes that account immediately.
    if (!this.options.allowList.has(credentials.email)) {
      this.forgetUser(record.userKey);
      throw new InvalidTokenError('Access for this account has been removed');
    }
    const account: AccountAuth = { userKey: record.userKey, credentials };
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: Math.floor(record.expiresAt / 1000),
      resource: record.resource ? new URL(record.resource) : undefined,
      extra: { account },
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: { token: string }): Promise<void> {
    const id = this.keyring.tokenId(request.token);
    this.store.update(state => {
      delete state.accessTokens[id];
      delete state.refreshTokens[id];
    });
  }

  /** Deletes every token (and so every stored login) of one account. Returns how many went. */
  forgetUser(userKey: string): number {
    const state = this.store.read();
    const count = (tokens: Record<string, StoredToken>) => Object.values(tokens).filter(t => t.userKey === userKey).length;
    const total = count(state.accessTokens) + count(state.refreshTokens);
    if (total === 0) return 0;
    this.store.update(s => {
      for (const [key, value] of Object.entries(s.accessTokens)) if (value.userKey === userKey) delete s.accessTokens[key];
      for (const [key, value] of Object.entries(s.refreshTokens)) if (value.userKey === userKey) delete s.refreshTokens[key];
    });
    for (const [code, pending] of this.pendingCodes) if (pending.userKey === userKey) this.pendingCodes.delete(code);
    console.log(`[auth] forgot ${logId(userKey)} (${total} tokens)`);
    return total;
  }

  /**
   * How many different accounts hold a token that has not expired yet: people who signed in within the
   * refresh-token lifetime and have not disconnected. Only the number leaves the server (the public badge).
   */
  activeUsers(now = Date.now()): number {
    const state = this.store.read();
    const users = new Set<string>();
    for (const tokens of [state.accessTokens, state.refreshTokens]) {
      for (const token of Object.values(tokens)) if (token.expiresAt > now) users.add(token.userKey);
    }
    return users.size;
  }

  /** The "disconnect" page: proves ownership with a site login, then forgets the account. */
  async forgetWithLogin(rawEmail: string, password: string, site: KtSite, ip: string): Promise<ForgetResult> {
    const email = normaliseEmail(rawEmail);
    if (email === '' || password === '' || email.length > 200 || password.length > 200) return 'invalid';
    const userKey = this.keyring.userKey(email, site);
    if (this.limiter.blocked(ip, userKey)) return 'blocked';
    this.limiter.recordAttempt(ip);
    const verdict = await this.checkLogin({ email, passwordMd5: md5Hex(password), site }, ip, userKey);
    if (verdict !== 'ok') return verdict;
    return this.forgetUser(userKey) > 0 ? 'done' : 'nothing';
  }

  /** Housekeeping, run periodically: expired tokens, stale clients, stale codes, old rate-limit entries. */
  sweep(): void {
    const now = Date.now();
    this.limiter.prune();
    for (const [code, pending] of this.pendingCodes) if (pending.expiresAt < now) this.pendingCodes.delete(code);
    const state = this.store.read();
    const expired = (tokens: Record<string, StoredToken>) => Object.values(tokens).some(t => t.expiresAt < now);
    if (expired(state.accessTokens) || expired(state.refreshTokens)) {
      this.store.update(s => {
        this.dropExpired(s, now);
        this.pruneClients(s);
      });
    }
  }

  private async checkLogin(credentials: KtCredentials, ip: string, userKey: string): Promise<'ok' | 'rejected' | 'unreachable'> {
    try {
      await this.options.verifyLogin(credentials);
      return 'ok';
    } catch (error) {
      if (error instanceof KtError) {
        this.limiter.recordFailure(ip, userKey, true);
        console.warn(`[auth] Kalorické tabuľky rejected the login for ${logId(userKey)}`);
        return 'rejected';
      }
      console.error(`[auth] could not reach Kalorické tabuľky:`, error instanceof Error ? error.message : error);
      return 'unreachable';
    }
  }

  private openCredentials(record: StoredToken, token: string): KtCredentials | undefined {
    try {
      const parsed = JSON.parse(this.keyring.boxFor(token).open(record.credentials)) as Partial<KtCredentials>;
      if (typeof parsed.email === 'string' && typeof parsed.passwordMd5 === 'string') {
        return { email: parsed.email, passwordMd5: parsed.passwordMd5, site: isKtSite(parsed.site) ? parsed.site : 'cz' };
      }
    } catch {
      // Wrong key or tampered record.
    }
    return undefined;
  }

  private issueTokens(grant: {
    clientId: string;
    userKey: string;
    grantId: string;
    scopes: string[];
    resource?: string;
    credentials: KtCredentials;
  }): OAuthTokens {
    const accessToken = newToken();
    const refreshToken = newToken();
    const now = Date.now();
    const plain = JSON.stringify(grant.credentials);
    const record = (token: string, ttlSeconds: number): StoredToken => ({
      clientId: grant.clientId,
      userKey: grant.userKey,
      grantId: grant.grantId,
      scopes: grant.scopes,
      resource: grant.resource,
      expiresAt: now + ttlSeconds * 1000,
      credentials: this.keyring.boxFor(token).seal(plain),
    });

    this.store.update(state => {
      state.accessTokens[this.keyring.tokenId(accessToken)] = record(accessToken, ACCESS_TOKEN_TTL_SECONDS);
      state.refreshTokens[this.keyring.tokenId(refreshToken)] = record(refreshToken, REFRESH_TOKEN_TTL_SECONDS);
      this.dropExpired(state, now);
    });

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: grant.scopes.join(' '),
    };
  }

  private dropExpired(state: PersistedState, now: number): void {
    for (const [key, value] of Object.entries(state.accessTokens)) if (value.expiresAt < now) delete state.accessTokens[key];
    for (const [key, value] of Object.entries(state.refreshTokens)) if (value.expiresAt < now) delete state.refreshTokens[key];
  }

  /** Drops clients that never got a token: after a day, or oldest first beyond the cap. */
  private pruneClients(state: PersistedState): void {
    const inUse = new Set([
      ...Object.values(state.accessTokens).map(t => t.clientId),
      ...Object.values(state.refreshTokens).map(t => t.clientId),
    ]);
    const cutoff = Math.floor(Date.now() / 1000) - UNUSED_CLIENT_TTL_SECONDS;
    const unused = Object.entries(state.clients)
      .filter(([id]) => !inUse.has(id))
      .sort(([, a], [, b]) => (a.client_id_issued_at ?? 0) - (b.client_id_issued_at ?? 0));
    unused.forEach(([id, client], index) => {
      const stale = (client.client_id_issued_at ?? 0) < cutoff;
      const overCap = unused.length - index >= MAX_UNUSED_CLIENTS;
      if (stale || overCap) delete state.clients[id];
    });
  }

  /**
   * Upgrades a v1 state file in place: re-keys every live token by its hash,
   * moves the account's login into a per-token box and drops the readable
   * e-mails. Connected clients keep working without signing in again.
   */
  private migrate(): void {
    const legacyBox = this.keyring.legacyBox();
    let migrated = 0;
    this.store.update(state => {
      const raw = state as unknown as {
        users?: Record<string, { credentials?: string }>;
        accessTokens?: Record<string, LegacyToken | StoredToken>;
        refreshTokens?: Record<string, LegacyToken | StoredToken>;
      };
      const logins = new Map<string, KtCredentials>();
      for (const [email, user] of Object.entries(raw.users ?? {})) {
        try {
          if (user?.credentials) logins.set(email, { email, passwordMd5: legacyBox.open(user.credentials) });
        } catch {
          // Unreadable with the current key: that user signs in again.
        }
      }
      const now = Date.now();
      const convert = (tokens: Record<string, LegacyToken | StoredToken> | undefined, ttlSeconds: number) => {
        const out: Record<string, StoredToken> = {};
        for (const [token, value] of Object.entries(tokens ?? {})) {
          const legacy = value as Partial<LegacyToken>;
          const login = typeof legacy.user === 'string' ? logins.get(legacy.user) : undefined;
          if (!login || typeof legacy.clientId !== 'string' || !(Number(legacy.expiresAt) > now)) continue;
          out[this.keyring.tokenId(token)] = {
            clientId: legacy.clientId,
            userKey: this.keyring.userKey(login.email),
            grantId: this.keyring.tokenId(`legacy:${legacy.clientId}:${login.email}`),
            scopes: Array.isArray(legacy.scopes) ? legacy.scopes : [MCP_SCOPE],
            resource: legacy.resource,
            // Also caps the long v1 lifetimes at the current ones.
            expiresAt: Math.min(Number(legacy.expiresAt), now + ttlSeconds * 1000),
            credentials: this.keyring.boxFor(token).seal(JSON.stringify(login)),
          };
          migrated++;
        }
        return out;
      };
      state.accessTokens = convert(raw.accessTokens, ACCESS_TOKEN_TTL_SECONDS);
      state.refreshTokens = convert(raw.refreshTokens, REFRESH_TOKEN_TTL_SECONDS);
      state.clients ??= {};
      delete raw.users;
      state.version = STATE_VERSION;
    });
    if (migrated > 0) console.log(`[auth] migrated state to v${STATE_VERSION}: ${migrated} tokens re-keyed`);
  }
}
