/**
 * Configuration is entirely environment-driven and validated at boot, so a
 * missing secret fails the service immediately rather than at first use.
 *
 * There are no kaloricketabulky.cz credentials here: every user (the owner
 * and friends alike) signs in with their own account on the consent page, and
 * only addresses listed in the allowed-users file may do so.
 */

import { Buffer } from 'node:buffer';

export interface Config {
  publicUrl: URL;
  port: number;
  stateDir: string;
  /** AES-256-GCM key that encrypts stored password hashes at rest. */
  credentialsKey: Buffer;
  /** One e-mail per line; re-read on change, no restart needed. */
  allowedUsersFile: string;
  /** Exact OAuth redirect URIs a client may register. Anything else is refused. */
  allowedRedirectUris: string[];
}

/** Claude's connector callback, plus the domain Anthropic says it may move to. */
const CLAUDE_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
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

  const port = Number(process.env['PORT'] ?? 8092);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got "${process.env['PORT']}"`);
  }

  const extraRedirects = (process.env['EXTRA_REDIRECT_URIS'] ?? '')
    .split(/\s+/)
    .filter(uri => uri !== '');

  return {
    publicUrl,
    port,
    // The service sets this explicitly; the bare default must be writable by
    // an unprivileged local dev run.
    stateDir: process.env['STATE_DIR'] ?? './data',
    credentialsKey,
    allowedUsersFile: process.env['ALLOWED_USERS_FILE'] ?? './allowed-users',
    allowedRedirectUris: [...CLAUDE_REDIRECT_URIS, ...extraRedirects],
  };
}
