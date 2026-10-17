/**
 * Who may use this server, and how their kaloricketabulky.cz login is kept.
 *
 * The allowlist is a plain text file the owner edits by hand (one e-mail per
 * line, `#` comments). It is re-read whenever its mtime changes, so adding or
 * removing a friend takes effect on their next request without a restart.
 *
 * Stored credentials are the md5 hex the site's login expects — never the
 * plain password — encrypted with AES-256-GCM so a leaked state file or backup
 * is useless without the key from the root-only environment file.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class AllowList {
  private mtimeMs = -1;
  private emails = new Set<string>();

  constructor(private readonly file: string) {}

  has(email: string): boolean {
    this.refresh();
    return this.emails.has(normaliseEmail(email));
  }

  private refresh(): void {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.file).mtimeMs;
    } catch {
      // A missing file means nobody is allowed — fail closed.
      this.emails = new Set();
      this.mtimeMs = -1;
      return;
    }
    if (mtimeMs === this.mtimeMs) return;
    this.mtimeMs = mtimeMs;
    this.emails = new Set(
      readFileSync(this.file, 'utf8')
        .split('\n')
        .map(line => line.replace(/#.*/, ''))
        .map(normaliseEmail)
        .filter(line => line !== ''),
    );
  }
}

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

/**
 * Failed sign-ins: 5 per IP per 15 minutes, 30 overall per hour. Each failed
 * attempt with an allowed e-mail costs a real login request to the site, so
 * this also keeps us from hammering it on someone's behalf.
 */
export class LoginLimiter {
  private readonly perIp = new Map<string, number[]>();
  private global: number[] = [];

  constructor(
    private readonly ipMax = 5,
    private readonly ipWindowMs = 15 * 60 * 1000,
    private readonly globalMax = 30,
    private readonly globalWindowMs = 60 * 60 * 1000,
  ) {}

  blocked(ip: string): boolean {
    const now = Date.now();
    this.global = this.global.filter(t => now - t < this.globalWindowMs);
    const hits = (this.perIp.get(ip) ?? []).filter(t => now - t < this.ipWindowMs);
    if (hits.length === 0) this.perIp.delete(ip);
    else this.perIp.set(ip, hits);
    return hits.length >= this.ipMax || this.global.length >= this.globalMax;
  }

  /**
   * `reachedSite` is false for e-mails refused by the allowlist: those never
   * cost a login request, so they only count against the caller's IP — a
   * stranger can't burn the global budget and lock everyone else out.
   */
  recordFailure(ip: string, reachedSite: boolean): void {
    const now = Date.now();
    if (reachedSite) this.global.push(now);
    this.perIp.set(ip, [...(this.perIp.get(ip) ?? []), now]);
  }
}
