/**
 * Who may use this server, and how their Kalorické tabuľky login is kept.
 *
 * Access: open to anyone with a kaloricketabulky.sk/.cz account, unless the owner
 * points ALLOWED_USERS_FILE at a plain text file (one e-mail per line, `#`
 * comments). That file is re-read whenever its mtime changes, so adding or
 * removing someone takes effect on their next request without a restart.
 *
 * Storage: the site's login takes the md5 hex of the password, so that is all
 * the server ever keeps — never the plain password. It is stored once per
 * issued token, encrypted (AES-256-GCM) with a key derived from both the
 * server secret and that token. The state file holds only token hashes, so a
 * leaked state file, even together with the server secret, decrypts nothing.
 * E-mails are never stored in readable form: records carry an HMAC of the
 * address ("user key") so one person's tokens can still be found and deleted.
 */

import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class AllowList {
  private mtimeMs = -1;
  private emails = new Set<string>();

  /** `file` null means no list: everyone is allowed. */
  constructor(private readonly file: string | null) {}

  get restricted(): boolean {
    return this.file !== null;
  }

  has(email: string): boolean {
    if (this.file === null) return true;
    this.refresh(this.file);
    return this.emails.has(normaliseEmail(email));
  }

  private refresh(file: string): void {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      // A configured but missing file means nobody is allowed — fail closed.
      this.emails = new Set();
      this.mtimeMs = -1;
      return;
    }
    if (mtimeMs === this.mtimeMs) return;
    this.mtimeMs = mtimeMs;
    this.emails = new Set(
      readFileSync(file, 'utf8')
        .split('\n')
        .map(line => line.replace(/#.*/, ''))
        .map(normaliseEmail)
        .filter(line => line !== ''),
    );
  }
}

/** AES-256-GCM with a random IV: iv(12) | tag(16) | ciphertext, base64. */
export class CredentialBox {
  constructor(private readonly key: Buffer) {}

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }

  open(sealed: string): string {
    const raw = Buffer.from(sealed, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
}

/** The key-derivation and hashing rules for everything persisted about a user. */
export class Keyring {
  constructor(private readonly serverKey: Buffer) {}

  /** What a token is stored under. Tokens are 256-bit random, so a plain hash is enough. */
  tokenId(token: string): string {
    return createHash('sha256').update(token).digest('base64url');
  }

  /**
   * Stable pseudonymous id for an account: finds one person's tokens without
   * storing the address. .sk and .cz have separate accounts, so the site is part
   * of it (.cz keeps the original form, which tokens from before the choice use).
   */
  userKey(email: string, site: 'cz' | 'sk' = 'cz'): string {
    const prefix = site === 'sk' ? 'user:sk:' : 'user:';
    return createHmac('sha256', this.serverKey).update(`${prefix}${normaliseEmail(email)}`).digest('base64url');
  }

  /** The box for the login stored alongside one token; needs both the server key and the token. */
  boxFor(token: string): CredentialBox {
    const key = Buffer.from(hkdfSync('sha256', this.serverKey, Buffer.from(token, 'utf8'), 'kt-mcp credentials v2', 32));
    return new CredentialBox(key);
  }

  /** The box used by state files before v2 (server key only); read once during migration. */
  legacyBox(): CredentialBox {
    return new CredentialBox(this.serverKey);
  }
}

/** Short, non-reversible label for log lines. */
export function logId(userKey: string): string {
  return `u:${userKey.slice(0, 8)}`;
}

/** Sliding-window counters keyed by any string. */
class Window {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  full(key: string, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter(t => now - t < this.windowMs);
    if (recent.length === 0) this.hits.delete(key);
    else this.hits.set(key, recent);
    return recent.length >= this.max;
  }

  add(key: string, now: number): void {
    this.hits.set(key, [...(this.hits.get(key) ?? []), now]);
    // Keep memory bounded when many distinct keys show up.
    if (this.hits.size > 10_000) this.prune(now);
  }

  /** Forgets keys whose hits have all left the window. */
  prune(now: number): void {
    for (const [k, list] of this.hits) if (list.every(t => now - t >= this.windowMs)) this.hits.delete(k);
  }
}

/**
 * Sign-in throttling. Every attempt that reaches the site costs a real login
 * request there, so these limits also stop this server from being used to
 * test stolen passwords against Kalorické tabuľky:
 *
 *   - 5 failures per IP and per account (e-mail) per 15 minutes,
 *   - 20 attempts of any outcome per IP per 15 minutes,
 *   - `globalMax` failures per hour across everyone (sign-in pauses for all).
 */
export class LoginLimiter {
  private readonly ipFailures = new Window(5, 15 * 60 * 1000);
  private readonly accountFailures = new Window(5, 15 * 60 * 1000);
  private readonly ipAttempts = new Window(20, 15 * 60 * 1000);
  private readonly siteFailures: Window;

  constructor(globalMax = 60) {
    this.siteFailures = new Window(globalMax, 60 * 60 * 1000);
  }

  blocked(ip: string, account: string | null): boolean {
    const now = Date.now();
    return (
      this.ipFailures.full(ip, now) ||
      this.ipAttempts.full(ip, now) ||
      (account !== null && this.accountFailures.full(account, now)) ||
      this.siteFailures.full('*', now)
    );
  }

  /**
   * Drops stale entries. Run periodically: the privacy page promises that IP
   * addresses stay in memory no longer than an hour.
   */
  prune(): void {
    const now = Date.now();
    for (const window of [this.ipFailures, this.accountFailures, this.ipAttempts, this.siteFailures]) window.prune(now);
  }

  recordAttempt(ip: string): void {
    this.ipAttempts.add(ip, Date.now());
  }

  /**
   * `reachedSite` is false for e-mails refused by the allowlist: those never
   * cost a login request, so they only count against the caller's IP — a
   * stranger can't burn the global budget that way.
   */
  recordFailure(ip: string, account: string | null, reachedSite: boolean): void {
    const now = Date.now();
    this.ipFailures.add(ip, now);
    if (account !== null) this.accountFailures.add(account, now);
    if (reachedSite) this.siteFailures.add('*', now);
  }
}
