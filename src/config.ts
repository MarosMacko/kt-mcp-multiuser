/**
 * Configuration is entirely environment-driven and validated at boot, so a
 * missing secret fails the service immediately rather than at first use.
 * Every variable is documented in `.env.example`.
 *
 * There are no Kalorické tabuľky credentials here: every user signs in with
 * their own account on the consent page. By default anyone with an account may
 * do so; set ALLOWED_USERS_FILE to limit the server to a list of e-mails.
 */

import { Buffer } from 'node:buffer';

export interface Operator {
  /** Who runs this instance, shown on the privacy page. */
  name: string | null;
  /** How to reach them (e-mail or URL), shown on the privacy page. */
  contact: string | null;
}

export interface Config {
  publicUrl: URL;
  /** Address the HTTP server binds to; 127.0.0.1 behind a local proxy, 0.0.0.0 in a container. */
  host: string;
  port: number;
  stateDir: string;
  /**
   * 32-byte server secret. Every stored login is encrypted with a key derived
   * from it *and* the token that login belongs to, so neither alone is enough.
   */
  credentialsKey: Buffer;
  /** One e-mail per line, re-read on change. Null means anyone may sign in. */
  allowedUsersFile: string | null;
  /** Whether local MCP clients (loopback redirect URIs) may connect. */
  localClients: boolean;
  /** Exact OAuth redirect URIs a client may register. */
  allowedRedirectUris: string[];
  /** Redirect URI shapes a client may register (whole-string matches). Anything else is refused. */
  allowedRedirectPatterns: RegExp[];
  /** Origins accepted on requests that carry an Origin header (besides our own). */
  allowedOrigins: string[];
  /** Reverse-proxy hops in front of the app whose X-Forwarded-For may be trusted. */
  trustProxyHops: number;
  /** Failed Kalorické tabuľky logins per hour across everyone, before sign-in pauses. */
  maxFailedLoginsPerHour: number;
  operator: Operator;
}

/**
 * Hosted connectors: Claude's callback (plus the domain Anthropic says it may
 * move to) and ChatGPT's stable connector callback.
 */
export const HOSTED_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
];

/**
 * ChatGPT gives each custom connector its own callback unless the server
 * returns RFC 9207 `iss` in authorization responses (we don't), see
 * https://developers.openai.com/plugins/build/auth#redirect-url.
 */
export const HOSTED_REDIRECT_PATTERNS = [/^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/];

/**
 * Local MCP clients (Claude Code, VS Code, MCP Inspector, ...) run the OAuth
 * flow from the user's own machine and receive the code on a loopback port
 * (RFC 8252 §7.3). A code sent to loopback never leaves the victim's computer,
 * so a look-alike client gains nothing from registering one of these.
 */
export const LOCAL_REDIRECT_URIS = ['https://vscode.dev/redirect', 'https://insiders.vscode.dev/redirect'];
export const LOCAL_REDIRECT_PATTERNS = [/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:\/[^\s?#]*)?$/];

/** Hosted MCP clients; their backends may send their own Origin. */
export const CLIENT_ORIGINS = ['https://claude.ai', 'https://claude.com', 'https://chatgpt.com'];

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value.trim();
}

function optional(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = optional(name);
  const value = raw === null ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

function flag(name: string, fallback: boolean): boolean {
  const raw = optional(name)?.toLowerCase();
  if (raw === undefined || raw === null) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${name} must be true or false, got "${raw}"`);
}

export function loadConfig(): Config {
  const publicUrl = new URL(required('PUBLIC_URL'));
  if (publicUrl.protocol !== 'https:') {
    throw new Error('PUBLIC_URL must be an https:// URL — OAuth and MCP both require TLS');
  }
  // The OAuth issuer must have no query or fragment, and we compare it against
  // the RFC 8707 resource identifier, so normalise away a trailing slash.
  publicUrl.search = '';
  publicUrl.hash = '';
  if (publicUrl.pathname === '/') publicUrl.pathname = '';

  const credentialsKey = Buffer.from(required('CREDENTIALS_KEY'), 'base64');
  if (credentialsKey.length !== 32) {
    throw new Error('CREDENTIALS_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');
  }

  const localClients = flag('ALLOW_LOCAL_CLIENTS', true);
  const extraRedirects = (optional('EXTRA_REDIRECT_URIS') ?? '').split(/\s+/).filter(uri => uri !== '');

  return {
    publicUrl,
    host: optional('HOST') ?? '127.0.0.1',
    port: integer('PORT', 8092, 1, 65535),
    // The service sets this explicitly; the bare default must be writable by
    // an unprivileged local dev run.
    stateDir: optional('STATE_DIR') ?? './data',
    credentialsKey,
    allowedUsersFile: optional('ALLOWED_USERS_FILE'),
    localClients,
    allowedRedirectUris: [...HOSTED_REDIRECT_URIS, ...(localClients ? LOCAL_REDIRECT_URIS : []), ...extraRedirects],
    allowedRedirectPatterns: [...HOSTED_REDIRECT_PATTERNS, ...(localClients ? LOCAL_REDIRECT_PATTERNS : [])],
    allowedOrigins: CLIENT_ORIGINS,
    trustProxyHops: integer('TRUST_PROXY_HOPS', 1, 0, 10),
    maxFailedLoginsPerHour: integer('MAX_FAILED_LOGINS_PER_HOUR', 60, 1, 100000),
    operator: { name: optional('OPERATOR_NAME'), contact: optional('OPERATOR_CONTACT') },
  };
}
