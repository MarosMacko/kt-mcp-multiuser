// End-to-end check of the connector sign-in flow against throwaway app
// instances, with the Kalorické tabuľky login stubbed out. Food search still
// goes to the real site (it works anonymously); pass --offline to skip it.
//
//   npm run build && node scripts/e2e-auth.mjs [--offline]

import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../dist/app.js';
import { CLIENT_ORIGINS, HOSTED_REDIRECT_PATTERNS, HOSTED_REDIRECT_URIS, LOCAL_REDIRECT_PATTERNS, LOCAL_REDIRECT_URIS } from '../dist/config.js';
import { KtClient, KtError, md5Hex } from '../dist/kt/client.js';

const OFFLINE = process.argv.includes('--offline');
const GOOD_PASSWORD = 'correct horse';
const EMAIL = 'friend@example.com';
const REDIRECT = 'http://127.0.0.1:1/test-callback';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}
const form = obj => new URLSearchParams(obj).toString();
let ipCounter = 10;
const freshIp = () => `203.0.113.${ipCounter++}`;

async function startServer({ allowedUsersFile = null, publicUserCount = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kt-e2e-'));
  const config = {
    publicUrl: new URL('https://kt.test'),
    host: '127.0.0.1',
    port: 0,
    stateDir: dir,
    credentialsKey: randomBytes(32),
    allowedUsersFile,
    localClients: true,
    allowedRedirectUris: [...HOSTED_REDIRECT_URIS, ...LOCAL_REDIRECT_URIS],
    allowedRedirectPatterns: [...HOSTED_REDIRECT_PATTERNS, ...LOCAL_REDIRECT_PATTERNS],
    allowedOrigins: CLIENT_ORIGINS,
    trustProxyHops: 1,
    maxFailedLoginsPerHour: 60,
    publicUserCount,
    operator: { name: 'Test Operator', contact: 'ops@example.com' },
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
  const post = (path, body, headers = {}) =>
    fetch(base + path, { method: 'POST', redirect: 'manual', body, headers: { 'X-Forwarded-For': freshIp(), ...headers } });

  const register = async redirectUri =>
    post('/register', JSON.stringify({ client_name: 'Probe', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }), {
      'Content-Type': 'application/json',
    });

  /** Registers a client and returns a function that runs the authorize POST for it. */
  async function oauthClient(redirectUri = REDIRECT) {
    const client = await (await register(redirectUri)).json();
    const verifier = randomBytes(32).toString('base64url');
    const params = {
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: 'xyz',
      scope: 'caltrack:log',
      resource: 'https://kt.test/mcp',
    };
    const authorize = (fields, ip = freshIp()) =>
      post('/authorize', form({ ...params, ...fields }), { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': ip });
    const signIn = async (email = EMAIL, extra = {}) => {
      const res = await authorize({ email, password: GOOD_PASSWORD, ...extra });
      const code = new URL(res.headers.get('location') ?? 'http://x').searchParams.get('code');
      const tokenRes = await post('/token', form({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: redirectUri, resource: 'https://kt.test/mcp' }), { 'Content-Type': 'application/x-www-form-urlencoded' });
      return { res, tokenRes, tokens: await tokenRes.json() };
    };
    const refresh = refreshToken =>
      post('/token', form({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: client.client_id }), { 'Content-Type': 'application/x-www-form-urlencoded' });
    return { client, params, authorize, signIn, refresh };
  }

  const rpc = async (token, method, params = {}, headers = {}) => {
    const res = await post('/mcp', JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      'MCP-Protocol-Version': '2025-06-18',
      ...headers,
    });
    const text = await res.text();
    const line = text.split('\n').find(l => l.startsWith('data: '));
    let body = null;
    try {
      body = line ? JSON.parse(line.slice(6)) : text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  };

  const close = () => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { base, dir, post, register, oauthClient, rpc, close };
}

// ───────────────────────────── open mode (no allowlist) ─────────────────────────────
const open = await startServer({ publicUserCount: true });
try {
  const { base, post, register, oauthClient, rpc } = open;
  const meta = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  check('protected-resource metadata', meta.resource === 'https://kt.test/mcp', JSON.stringify(meta.authorization_servers));

  const noAuth = await post('/mcp', '{}', { 'Content-Type': 'application/json' });
  check('/mcp without token is 401', noAuth.status === 401, noAuth.headers.get('www-authenticate') ?? '');

  const badgeUsers = async () => (await (await fetch(`${base}/badge/users.json`)).json()).message;
  const badge = await fetch(`${base}/badge/users.json`);
  const badgeBody = await badge.json();
  check('user badge is a shields.io endpoint, 0 before anyone signs in',
    badge.status === 200 && badgeBody.schemaVersion === 1 && badgeBody.message === '0', JSON.stringify(badgeBody));

  for (const uri of [
    'https://evil.example/cb',
    'https://chatgpt.com.evil.example/connector/oauth/abc',
    'https://chatgpt.com/connector/oauth/abc?next=https://evil.example',
    'https://chatgpt.com/connector/oauth/../../evil',
    'http://chatgpt.com/connector/oauth/abc',
    'http://localhost.evil.example/cb',
    'http://127.0.0.1.evil.example/cb',
    'http://localhost:8080/cb?next=https://evil.example',
    'http://localhost@evil.example/cb',
    'https://vscode.dev/redirect/../evil',
  ]) {
    check(`registration refused: ${uri}`, (await register(uri)).status === 400);
  }
  for (const uri of [
    'https://claude.ai/api/mcp/auth_callback',
    'https://chatgpt.com/connector_platform_oauth_redirect',
    'https://chatgpt.com/connector/oauth/cb_1a2B-3c',
    'http://localhost:33418/callback',
    'http://127.0.0.1:6274/oauth/callback',
    'http://[::1]:9000/',
    'https://vscode.dev/redirect',
  ]) {
    check(`registration accepted: ${uri}`, (await register(uri)).status === 201);
  }

  for (const path of ['/', '/privacy', '/forget']) {
    const res = await fetch(base + path);
    const html = await res.text();
    check(`GET ${path} renders`, res.status === 200 && html.includes('lang="sk"') && (res.headers.get('content-security-policy') ?? '').includes("default-src 'none'"));
  }
  check('privacy page names the operator', (await (await fetch(`${base}/privacy`)).text()).includes('ops@example.com'));

  const a = await oauthClient();
  const consent = await fetch(`${base}/authorize?${form(a.params)}`);
  const consentHtml = await consent.text();
  check('consent page renders', consent.status === 200 && consentHtml.includes('name="email"'));
  const consentSk = await (await fetch(`${base}/authorize?${form(a.params)}`, { headers: { 'Accept-Language': 'sk-SK,sk;q=0.9,cs;q=0.8,en;q=0.7' } })).text();
  const consentCs = await (await fetch(`${base}/authorize?${form(a.params)}`, { headers: { 'Accept-Language': 'cs-CZ,cs;q=0.9,en;q=0.8' } })).text();
  check('consent preselects .sk for a Slovak browser', consentSk.includes('value="sk" checked') && !consentSk.includes('value="cz" checked'));
  check('consent preselects .cz for a Czech browser', consentCs.includes('value="cz" checked') && !consentCs.includes('value="sk" checked'));
  check('consent page names the requester', consentHtml.includes('localhost'));
  check('consent CSP allows the redirect origin', (consent.headers.get('content-security-policy') ?? '').includes('form-action \'self\' http://127.0.0.1:1'));

  const wrong = await a.authorize({ email: EMAIL, password: 'nope' });
  check('wrong password refused', wrong.status === 401);

  const lockIp = freshIp();
  for (let i = 0; i < 5; i++) await a.authorize({ email: 'other@example.com', password: 'nope' }, lockIp);
  check('IP locked out after 5 misses', (await a.authorize({ email: EMAIL, password: GOOD_PASSWORD }, lockIp)).status === 429);

  for (let i = 0; i < 5; i++) await a.authorize({ email: 'victim@example.com', password: 'nope' });
  check('account locked out after 5 misses from different IPs', (await a.authorize({ email: 'victim@example.com', password: GOOD_PASSWORD })).status === 429);

  const { res: ok, tokenRes, tokens } = await a.signIn('  Friend@Example.com ');
  check('correct sign-in redirects with code', ok.status === 302 && (ok.headers.get('location') ?? '').startsWith(REDIRECT));
  check('code exchanged for tokens', tokenRes.status === 200 && !!tokens.access_token, `expires_in=${tokens.expires_in}`);
  check('user badge counts the signed-in account', (await badgeUsers()) === '1');

  const stateText = readFileSync(join(open.dir, 'oauth-state.json'), 'utf8');
  const state = JSON.parse(stateText);
  check('state file is versioned', state.version === 2);
  check('state file holds no e-mail', !stateText.toLowerCase().includes('friend@example.com'));
  check('state file holds no raw token', !stateText.includes(tokens.access_token) && !stateText.includes(tokens.refresh_token));
  check('state file holds no md5', !stateText.includes(md5Hex(GOOD_PASSWORD)));

  const init = await rpc(tokens.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
  check('MCP initialize', init.status === 200 && init.body?.result?.serverInfo?.name === 'kaloricketabulky');

  const list = await rpc(tokens.access_token, 'tools/list');
  const toolNames = (list.body?.result?.tools ?? []).map(t => t.name);
  check('tools/list', toolNames.includes('search_food') && toolNames.includes('log_food') && toolNames.includes('disconnect_account'), `${toolNames.length} tools`);

  if (!OFFLINE) {
    let t0 = Date.now();
    const s1 = await rpc(tokens.access_token, 'tools/call', { name: 'search_food', arguments: { query: 'vajce' } });
    const firstMs = Date.now() - t0;
    t0 = Date.now();
    const s2 = await rpc(tokens.access_token, 'tools/call', { name: 'search_food', arguments: { query: 'vajce' } });
    const secondMs = Date.now() - t0;
    const s1text = s1.body?.result?.content?.[0]?.text ?? JSON.stringify(s1.body).slice(0, 200);
    check('search_food returns real data', !s1.body?.result?.isError && s1text.length > 20, s1text.slice(0, 80).replace(/\s+/g, ' '));
    check('second search served from cache', secondMs <= firstMs && JSON.stringify(s1.body.result) === JSON.stringify(s2.body.result), `${firstMs} ms → ${secondMs} ms`);
    check('.cz account gets Czech names', s1text.includes('vejce slepičí'));

    const skClient = await oauthClient('http://localhost:33419/callback');
    const sk = (await skClient.signIn('sk-friend@example.com', { site: 'sk' })).tokens;
    const skInit = await rpc(sk.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
    check('.sk account is told to search in Slovak', (skInit.body?.result?.instructions ?? '').includes('kaloricketabulky.sk'));
    const skSearch = await rpc(sk.access_token, 'tools/call', { name: 'search_food', arguments: { query: 'vajce' } });
    const skText = skSearch.body?.result?.content?.[0]?.text ?? '';
    check('.sk account gets Slovak names from kaloricketabulky.sk', skText.includes('slepačie vajce') && skText.includes('7a9c53538d64527a'));

    // .sk and .cz are separate accounts: forgetting the .cz one leaves the .sk one alone.
    const forgetCz = await post('/forget', form({ email: 'sk-friend@example.com', password: GOOD_PASSWORD, site: 'cz' }), { 'Content-Type': 'application/x-www-form-urlencoded' });
    check('forget on .cz does not touch the .sk account', forgetCz.status === 200 && (await rpc(sk.access_token, 'tools/list')).status === 200);
    const forgetSk = await post('/forget', form({ email: 'sk-friend@example.com', password: GOOD_PASSWORD, site: 'sk' }), { 'Content-Type': 'application/x-www-form-urlencoded' });
    check('forget on .sk removes the .sk account', forgetSk.status === 200 && (await rpc(sk.access_token, 'tools/list')).status === 401);
  }
  const forgetForm = await (await fetch(`${base}/forget`, { headers: { 'Accept-Language': 'sk' } })).text();
  check('forget page asks which site, .sk preselected', forgetForm.includes('Kde máš účet?') && forgetForm.includes('value="sk" checked'));
  check('site choice comes before the e-mail field', consentSk.indexOf('name="site"') < consentSk.indexOf('name="email"'));

  const refreshed = await a.refresh(tokens.refresh_token);
  const tokens2 = await refreshed.json();
  check('refresh token rotates', refreshed.status === 200 && tokens2.access_token && tokens2.access_token !== tokens.access_token);
  check('old refresh token is single-use', (await a.refresh(tokens.refresh_token)).status === 400);
  check('old access token retired on refresh', (await rpc(tokens.access_token, 'tools/list')).status === 401);
  check('new access token works', (await rpc(tokens2.access_token, 'tools/list')).status === 200);

  const foreignOrigin = await post('/mcp', '{}', { 'Content-Type': 'application/json', Origin: 'https://evil.example', Authorization: `Bearer ${tokens2.access_token}` });
  check('foreign Origin refused', foreignOrigin.status === 403);
  check('ChatGPT Origin accepted', (await rpc(tokens2.access_token, 'tools/list', {}, { Origin: 'https://chatgpt.com' })).status === 200);

  // A second client (say ChatGPT next to Claude) for the same account.
  const b = await oauthClient('http://localhost:33418/callback');
  const second = (await b.signIn()).tokens;
  check('second client for the same account', !!second.access_token);
  check('user badge counts an account with two clients once', (await badgeUsers()) === '1');

  const bye = await rpc(tokens2.access_token, 'tools/call', { name: 'disconnect_account', arguments: {} });
  check('disconnect_account tool succeeds', bye.status === 200 && !bye.body?.result?.isError);
  check('disconnect revokes this client', (await rpc(tokens2.access_token, 'tools/list')).status === 401);
  check('disconnect revokes the other client too', (await rpc(second.access_token, 'tools/list')).status === 401);
  check('disconnect revokes refresh tokens', (await b.refresh(second.refresh_token)).status === 400);
  check('user badge drops a disconnected account', (await badgeUsers()) === '0');

  const again = (await a.signIn()).tokens;
  const forgetBad = await post('/forget', form({ email: EMAIL, password: 'nope' }), { 'Content-Type': 'application/x-www-form-urlencoded' });
  check('forget page refuses a wrong password', forgetBad.status === 401 && (await rpc(again.access_token, 'tools/list')).status === 200);
  const forget = await post('/forget', form({ email: EMAIL, password: GOOD_PASSWORD }), { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://kt.test' });
  check('forget page deletes the account', forget.status === 200 && (await forget.text()).includes('Hotovo'));
  check('forgotten token no longer works', (await rpc(again.access_token, 'tools/list')).status === 401);
  const forgetAgain = await post('/forget', form({ email: EMAIL, password: GOOD_PASSWORD }), { 'Content-Type': 'application/x-www-form-urlencoded' });
  check('forget page with nothing stored', forgetAgain.status === 200 && (await forgetAgain.text()).includes('Nie je čo mazať'));
} finally {
  open.close();
}

// ───────────────────────────── allowlist mode ─────────────────────────────
const listDir = mkdtempSync(join(tmpdir(), 'kt-e2e-list-'));
const allowFile = join(listDir, 'allowed-users');
writeFileSync(allowFile, `# test\n${EMAIL}\n`);
const restricted = await startServer({ allowedUsersFile: allowFile });
try {
  check('user badge is off unless PUBLIC_USER_COUNT is set', (await fetch(`${restricted.base}/badge/users.json`)).status === 404);
  const a = await restricted.oauthClient();
  check('allowlist: stranger refused', (await a.authorize({ email: 'stranger@example.com', password: GOOD_PASSWORD })).status === 403);
  const { tokens } = await a.signIn();
  check('allowlist: listed user signs in', !!tokens.access_token);
  check('allowlist: listed user calls tools', (await restricted.rpc(tokens.access_token, 'tools/list')).status === 200);
  // Allowlist edits are picked up by mtime; make sure it moves.
  await new Promise(r => setTimeout(r, 20));
  writeFileSync(allowFile, '# friend removed\n');
  check('allowlist: removal revokes access', (await restricted.rpc(tokens.access_token, 'tools/list')).status === 401);
} finally {
  restricted.close();
  rmSync(listDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
