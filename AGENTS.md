# AGENTS.md

Instructions for AI agents working on or deploying this repository. Human-facing docs are in Slovak
(README.md, docs/SELF-HOSTING.md); this file is the short English version of what an agent needs.

## What this is

A remote MCP server (TypeScript, Node 22+, Express, `@modelcontextprotocol/sdk`) that lets AI clients read and write
a user's food diary on kaloricketabulky.sk or kaloricketabulky.cz. The two sites share the app and food ids but have
SEPARATE user accounts: the user picks the site at sign-in, it is stored with their credentials and also sets the
language of food names. The server is its own OAuth 2.1 authorization server: each user signs in on `/authorize` with
their own Kalorické tabuľky login. No site credentials go into configuration.

## Commands

```bash
npm ci
npm test                      # tsc build + unit tests (node --test dist/**/*.test.js)
node scripts/e2e-auth.mjs     # end-to-end OAuth flow, stubbed site login; add --offline to skip the real food search
npm run typecheck
```

Run both `npm test` and the e2e script after any change under `src/auth`, `src/app.ts` or `src/config.ts`.

## Deploying (pick one, full detail in docs/SELF-HOSTING.md)

Ask the human for: the domain, whether the server is for them only / a list of people / anyone, and the operator
name + contact to show on `/privacy`. Never invent a contact.

**Docker (fresh machine, ports 80/443 free):**
1. `cp .env.example .env`; set `KT_DOMAIN`, `CREDENTIALS_KEY` (`openssl rand -base64 32`), `OPERATOR_NAME`,
   `OPERATOR_CONTACT`. Leave `PUBLIC_URL`, `HOST`, `PORT`, `STATE_DIR` to compose.
2. DNS A/AAAA record for the domain must point at the machine before Caddy can get a certificate.
3. `BUILD_COMMIT=$(git rev-parse --short HEAD) docker compose up -d --build`, then
   `./scripts/verify-deployment.sh https://<domain>`. (BUILD_COMMIT only labels the build; the image has no .git.)

**systemd behind an existing Caddy/nginx:** follow "Variant B" in docs/SELF-HOSTING.md. Settings go in
`/etc/kt-mcp/kt-mcp.env` (root, 0600), the unit is `deploy/systemd/kt-mcp.service`, updates are
`./deploy/systemd/deploy.sh`.

Finish with `./scripts/verify-deployment.sh` and `./scripts/security-audit.sh` against the public URL; both must pass.

## Rules

- Never commit `.env`, `allowed-users`, `data/` or anything from `STATE_DIR`; never print `CREDENTIALS_KEY`.
- Generate `CREDENTIALS_KEY` once and keep it. Changing it signs every user out; losing `STATE_DIR` does the same.
- The reverse proxy must **overwrite** `X-Forwarded-For` with the client address (Caddy does by default; nginx
  `$remote_addr`), and `TRUST_PROXY_HOPS` must equal the number of proxies. Appending lets attackers bypass
  sign-in rate limits.
- Don't add CSP headers for the app's pages in the proxy; the app sends its own per-page CSP and a second one
  breaks the redirect to local clients.
- Don't enable access logs with client IPs unless the operator asks; the privacy page promises minimal logging.
- One process per state directory. Don't scale to multiple replicas.
- Keep the state file free of readable personal data: tokens stored as hashes, e-mails as HMAC (`Keyring`),
  credentials sealed per token. `src/auth/provider.test.ts` and the e2e script check this.
- User-facing pages are Slovak (`src/web/pages.ts`); tool descriptions for the model are English.
- The version lives only in `package.json` (`npm version minor --no-git-tag-version` bumps it and the lock file).
  `npm run build` adds the commit via `scripts/build-info.mjs` → `dist/build-info.json`, read by `src/version.ts`.
  Never hard-code a version elsewhere.

## Changing tools or the site client

- What the connected AI is told lives in two places only: `serverInstructions()` (cross-tool rules: dates, duplicates,
  drinks, which read tool for which question) and each tool's description, both in `src/mcp/tools.ts`. The README is
  for humans; keep it in step, but no model reads it.
- The site API is undocumented. Read-only endpoints (`/autocomplete/...`, `/foodstuff/detail/...`) work without a
  login, so check response shapes with `curl ... ?format=json` before coding against them. Put the parsing in
  `src/kt/derive.ts` (pure, unit-tested against the live shape) rather than in the HTTP client.
- Never assume what a write does. Verify it against a real account on a date inside the last 12 months (the site
  refuses older writes), read the diary back, then delete the test entry. Get the account owner's go-ahead first.
- Known facts: the diary summary's `activityEnergyTotal` stays empty for watch-imported workouts (burned energy is
  summed from diary activities instead); search rows carry only kcal/100 g; vitamins/minerals have no amounts; a
  recipe's diary entry has `foodId` = the recipe id and `editable: false`.

## Layout

```
src/config.ts         every environment variable (documented in .env.example)
src/app.ts            routes: /mcp, OAuth (SDK router), /, /privacy, /forget, /healthz
src/auth/provider.ts  OAuth provider: consent, tokens, refresh, forget, sweep, v1→v2 state migration
src/auth/users.ts     AllowList, CredentialBox (AES-256-GCM), Keyring (hashes, HMAC, HKDF), LoginLimiter
src/kt/client.ts      kaloricketabulky.cz/.sk client (undocumented API, throws on unexpected shapes)
src/kt/derive.ts      pure parsing: amounts, search fallbacks, duplicates, day completeness, statistics summary
src/mcp/tools.ts      diary tools and server instructions; disconnect_account lives in app.ts
deploy/               docker/ (Caddyfile for compose), systemd/ (unit, deploy.sh, Caddyfile example), extras/
scripts/              verify-deployment.sh, security-audit.sh, e2e-auth.mjs, mcp-call.mjs
```
