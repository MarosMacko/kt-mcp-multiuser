// End-to-end check of the connector sign-in flow against a throwaway app
// instance, with the kaloricketabulky.cz login stubbed out. Food search still
// goes to the real site (it works anonymously).
//
//   npm run build && node scripts/e2e-auth.mjs

import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../dist/app.js';
import { CLIENT_ORIGINS, CLIENT_REDIRECT_PATTERNS, CLIENT_REDIRECT_URIS } from '../dist/config.js';
import { KtClient, KtError, md5Hex } from '../dist/kt/client.js';

const dir = mkdtempSync(join(tmpdir(), 'kt-e2e-'));
const allowFile = join(dir, 'allowed-users');
writeFileSync(allowFile, '# test\nfriend@example.com\n');
const REDIRECT = 'http://127.0.0.1:1/test-callback';
const GOOD_PASSWORD = 'correct horse';

const config = {
  publicUrl: new URL('https://kt.test'),
  port: 0,
  stateDir: dir,
  credentialsKey: randomBytes(32),
  allowedUsersFile: allowFile,
  allowedRedirectUris: [...CLIENT_REDIRECT_URIS, REDIRECT],
  allowedRedirectPatterns: CLIENT_REDIRECT_PATTERNS,
  allowedOrigins: CLIENT_ORIGINS,
};
const app = createApp(config, {
  verifyLogin: async c => {
    if (c.passwordMd5 !== md5Hex(GOOD_PASSWORD)) throw new KtError('wrong password (stub)');
  },
  createClient: c => new KtClient(c),
});
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}
const form = obj => new URLSearchParams(obj).toString();
const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', redirect: 'manual', body, headers });
let ipCounter = 10;
const freshIp = () => `203.0.113.${ipCounter++}`;

try {
  const meta = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  check('protected-resource metadata', meta.resource === 'https://kt.test/mcp', JSON.stringify(meta.authorization_servers));

  const noAuth = await post('/mcp', '{}', { 'Content-Type': 'application/json' });
  check('/mcp without token is 401', noAuth.status === 401, noAuth.headers.get('www-authenticate') ?? '');

  const register = redirectUri =>
    post('/register', JSON.stringify({ client_name: 'Probe', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }), { 'Content-Type': 'application/json' });
  for (const uri of [
    'https://evil.example/cb',
    'https://chatgpt.com.evil.example/connector/oauth/abc',
    'https://chatgpt.com/connector/oauth/abc?next=https://evil.example',
    'https://chatgpt.com/connector/oauth/../../evil',
    'http://chatgpt.com/connector/oauth/abc',
  ]) {
    const refused = await register(uri);
    check(`registration refused: ${uri}`, refused.status === 400);
  }
  for (const uri of [
    'https://claude.ai/api/mcp/auth_callback',
    'https://chatgpt.com/connector_platform_oauth_redirect',
    'https://chatgpt.com/connector/oauth/cb_1a2B-3c',
  ]) {
    const accepted = await register(uri);
    check(`registration accepted: ${uri}`, accepted.status === 201);
  }

  const reg = await post('/register', JSON.stringify({ client_name: 'Test', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }), { 'Content-Type': 'application/json' });
  const client = await reg.json();
  check('allowed redirect_uri registration accepted', reg.status === 201 && !!client.client_id);

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authParams = {
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    scope: 'caltrack:log',
    resource: 'https://kt.test/mcp',
  };
  const consent = await fetch(`${base}/authorize?${form(authParams)}`);
  check('consent page renders', consent.status === 200 && (await consent.text()).includes('name="email"'));

  const authPost = (fields, ip) =>
    post('/authorize', form({ ...authParams, ...fields }), { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': ip });

  const notListed = await authPost({ email: 'stranger@example.com', password: GOOD_PASSWORD }, freshIp());
  check('non-allowlisted e-mail refused', notListed.status === 403);

  const wrong = await authPost({ email: 'friend@example.com', password: 'nope' }, freshIp());
  check('wrong password refused', wrong.status === 401);

  const lockIp = freshIp();
  for (let i = 0; i < 5; i++) await authPost({ email: 'friend@example.com', password: 'nope' }, lockIp);
  const locked = await authPost({ email: 'friend@example.com', password: GOOD_PASSWORD }, lockIp);
  check('IP locked out after 5 misses', locked.status === 429);

  const ok = await authPost({ email: '  Friend@Example.com ', password: GOOD_PASSWORD }, freshIp());
  const location = ok.headers.get('location') ?? '';
  const code = new URL(location || 'http://x').searchParams.get('code');
  check('correct sign-in redirects with code', ok.status === 302 && location.startsWith(REDIRECT) && !!code, location.slice(0, 60));

  const tokenRes = await post('/token', form({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT, resource: 'https://kt.test/mcp' }), { 'Content-Type': 'application/x-www-form-urlencoded' });
  const tokens = await tokenRes.json();
  check('code exchanged for tokens', tokenRes.status === 200 && !!tokens.access_token, `expires_in=${tokens.expires_in}`);

  const rpc = async (token, method, params = {}, id = 1) => {
    const res = await post('/mcp', JSON.stringify({ jsonrpc: '2.0', id, method, params }), {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      'MCP-Protocol-Version': '2025-06-18',
    });
    const text = await res.text();
    const line = text.split('\n').find(l => l.startsWith('data: '));
    return { status: res.status, body: line ? JSON.parse(line.slice(6)) : text ? JSON.parse(text) : null };
  };

  const init = await rpc(tokens.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
  check('MCP initialize', init.status === 200 && init.body?.result?.serverInfo?.name === 'kaloricketabulky');

  const list = await rpc(tokens.access_token, 'tools/list');
  const toolNames = (list.body?.result?.tools ?? []).map(t => t.name);
  check('tools/list', toolNames.includes('search_food') && toolNames.includes('log_food'), `${toolNames.length} tools`);

  let t0 = Date.now();
  const s1 = await rpc(tokens.access_token, 'tools/call', { name: 'search_food', arguments: { query: 'vajce' } });
  const firstMs = Date.now() - t0;
  t0 = Date.now();
  const s2 = await rpc(tokens.access_token, 'tools/call', { name: 'search_food', arguments: { query: 'vajce' } });
  const secondMs = Date.now() - t0;
  const s1text = s1.body?.result?.content?.[0]?.text ?? JSON.stringify(s1.body).slice(0, 200);
  check('search_food returns real data', !s1.body?.result?.isError && s1text.length > 20, s1text.slice(0, 120).replace(/\s+/g, ' '));
  check('second search served from cache', secondMs < firstMs && JSON.stringify(s1.body.result) === JSON.stringify(s2.body.result), `${firstMs} ms → ${secondMs} ms`);

  const refreshed = await post('/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }), { 'Content-Type': 'application/x-www-form-urlencoded' });
  const tokens2 = await refreshed.json();
  check('refresh token rotates', refreshed.status === 200 && tokens2.access_token && tokens2.access_token !== tokens.access_token);
  const reused = await post('/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }), { 'Content-Type': 'application/x-www-form-urlencoded' });
  check('old refresh token is single-use', reused.status === 400);

  const foreignOrigin = await post('/mcp', '{}', { 'Content-Type': 'application/json', Origin: 'https://evil.example', Authorization: `Bearer ${tokens2.access_token}` });
  check('foreign Origin refused', foreignOrigin.status === 403);

  const chatgptOrigin = await post('/mcp', JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }), {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Origin: 'https://chatgpt.com',
    Authorization: `Bearer ${tokens2.access_token}`,
    'MCP-Protocol-Version': '2025-06-18',
  });
  check('ChatGPT Origin accepted', chatgptOrigin.status === 200);

  // Allowlist edits are picked up by mtime; make sure it moves.
  await new Promise(r => setTimeout(r, 20));
  writeFileSync(allowFile, '# friend removed\n');
  const revoked = await rpc(tokens2.access_token, 'tools/list');
  check('removing from allowlist revokes access', revoked.status === 401);
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
