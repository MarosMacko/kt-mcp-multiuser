import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { md5Hex } from '../kt/client.js';
import { type AccountAuth, MultiUserOAuthProvider, preferredSite } from './provider.js';
import { AllowList, Keyring } from './users.js';

const EMAIL = 'friend@example.com';
const MD5 = md5Hex('correct horse');
const DAY = 24 * 60 * 60 * 1000;

function provider(stateFile: string, serverKey: Buffer, allowFile: string | null = null) {
  return new MultiUserOAuthProvider({
    stateFile,
    allowList: new AllowList(allowFile),
    keyring: new Keyring(serverKey),
    allowedRedirectUris: [],
    allowedRedirectPatterns: [],
    verifyLogin: async () => {},
  });
}

/** A state file as v0.1 (single key, readable e-mails, raw tokens) wrote it. */
function writeLegacyState(file: string, serverKey: Buffer) {
  const legacy = new Keyring(serverKey).legacyBox();
  const now = Date.now();
  writeFileSync(
    file,
    JSON.stringify({
      clients: { c1: { client_id: 'c1', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] } },
      accessTokens: {
        'old-access': { clientId: 'c1', user: EMAIL, scopes: ['caltrack:log'], expiresAt: now + 20 * DAY },
        'expired-access': { clientId: 'c1', user: EMAIL, scopes: ['caltrack:log'], expiresAt: now - 1 },
        'orphan-access': { clientId: 'c1', user: 'gone@example.com', scopes: ['caltrack:log'], expiresAt: now + DAY },
      },
      refreshTokens: {
        'old-refresh': { clientId: 'c1', user: EMAIL, scopes: ['caltrack:log'], expiresAt: now + 50 * DAY },
      },
      users: { [EMAIL]: { credentials: legacy.seal(MD5), createdAt: now, lastLoginAt: now } },
    }),
  );
}

test('migrates a v1 state file without signing anyone out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kt-provider-'));
  try {
    const file = join(dir, 'oauth-state.json');
    const key = randomBytes(32);
    writeLegacyState(file, key);
    const p = provider(file, key);

    const info = await p.verifyAccessToken('old-access');
    const account = info.extra?.['account'] as AccountAuth;
    assert.equal(account.credentials.email, EMAIL);
    assert.equal(account.credentials.passwordMd5, MD5);
    assert.equal(account.credentials.site, 'cz', 'accounts from before the .sk choice stay on .cz');
    assert.ok(info.expiresAt! * 1000 <= Date.now() + 7 * DAY + 1000, 'long v1 lifetimes are capped');

    await assert.rejects(p.verifyAccessToken('expired-access'));
    await assert.rejects(p.verifyAccessToken('orphan-access'));

    const text = readFileSync(file, 'utf8');
    const state = JSON.parse(text);
    assert.equal(state.version, 2);
    assert.equal(state.users, undefined);
    assert.ok(!text.includes(EMAIL), 'no readable e-mail');
    assert.ok(!text.includes('old-access') && !text.includes('old-refresh'), 'no raw tokens');
    assert.ok(state.clients.c1, 'registered clients are kept');

    const client = state.clients.c1;
    const tokens = await p.exchangeRefreshToken(client, 'old-refresh');
    const fresh = await p.verifyAccessToken(tokens.access_token);
    assert.equal((fresh.extra?.['account'] as AccountAuth).credentials.email, EMAIL);
    await assert.rejects(p.verifyAccessToken('old-access'), 'refresh retires the old access token');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stolen state file is useless even with the server key, and a new key signs everyone out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kt-provider-'));
  try {
    const file = join(dir, 'oauth-state.json');
    const key = randomBytes(32);
    writeLegacyState(file, key);
    provider(file, key); // migrate
    const state = JSON.parse(readFileSync(file, 'utf8'));
    const keyring = new Keyring(key);
    // Without the token, no box opens the record: try the server-key-only box.
    const [record] = Object.values(state.accessTokens) as { credentials: string }[];
    assert.throws(() => keyring.legacyBox().open(record!.credentials));
    assert.throws(() => keyring.boxFor('guess').open(record!.credentials));

    const rotated = provider(file, randomBytes(32));
    await assert.rejects(rotated.verifyAccessToken('old-access'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('forgetUser removes every token of one account only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kt-provider-'));
  try {
    const file = join(dir, 'oauth-state.json');
    const key = randomBytes(32);
    writeLegacyState(file, key);
    const p = provider(file, key);
    const keyring = new Keyring(key);
    assert.equal(p.forgetUser(keyring.userKey('someone-else@example.com')), 0);
    assert.equal(p.forgetUser(keyring.userKey(' Friend@Example.com ')), 2);
    await assert.rejects(p.verifyAccessToken('old-access'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removing an e-mail from the allowlist revokes its tokens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kt-provider-'));
  try {
    const file = join(dir, 'oauth-state.json');
    const allow = join(dir, 'allowed-users');
    writeFileSync(allow, `${EMAIL}\n`);
    const key = randomBytes(32);
    writeLegacyState(file, key);
    const p = provider(file, key, allow);
    await p.verifyAccessToken('old-access');
    await new Promise(r => setTimeout(r, 20));
    writeFileSync(allow, '# nobody\n');
    await assert.rejects(p.verifyAccessToken('old-access'));
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).refreshTokens, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('picks the site from the browser language', () => {
  assert.equal(preferredSite('sk-SK,sk;q=0.9,cs;q=0.8,en;q=0.7'), 'sk');
  assert.equal(preferredSite('en-US,en;q=0.9,sk;q=0.8'), 'sk');
  assert.equal(preferredSite('cs-CZ,cs;q=0.9,sk;q=0.8'), 'cz');
  assert.equal(preferredSite('en-US'), 'cz');
  assert.equal(preferredSite(undefined), 'cz');
});
