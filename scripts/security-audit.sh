#!/usr/bin/env bash
# Adversarial check of a deployed kt-mcp: tries to reach the tools without
# signing in. Read-only — registers a few throwaway OAuth clients but never
# signs in, logs food or reads a diary.
#
#   ./scripts/security-audit.sh https://kt.example.com
set -uo pipefail

B="${1:-}"
[[ -n "$B" ]] || { echo "usage: $0 https://<your-host>" >&2; exit 2; }
B="${B%/}"
pass=0; fail=0
ok(){ printf '  \033[32mBLOCKED\033[0m  %s\n' "$1"; pass=$((pass+1)); }
bad(){ printf '  \033[31mLEAK!!!\033[0m  %s\n' "$1"; fail=$((fail+1)); }
rand(){ head -c24 /dev/urandom | base64 | tr -d '/+='; }
mcp(){ curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X "${2:-POST}" "$B/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-06-18' ${1:+-H "Authorization: Bearer $1"} \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'; }
register(){ curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$B/register" -H 'Content-Type: application/json' \
  -d "{\"client_name\":\"Audit\",\"redirect_uris\":[\"$1\"],\"token_endpoint_auth_method\":\"none\"}"; }

echo "── Unauthenticated MCP call ──"
code=$(mcp); [ "$code" = 401 ] && ok "no token → 401" || bad "no token → $code"

echo; echo "── Forged bearer tokens ──"
for t in "$(rand)" admin null undefined " "; do
  code=$(mcp "$t"); [ "$code" = 401 ] && ok "token '${t:0:10}' → 401" || bad "token '${t:0:10}' → $code"
done

echo; echo "── Phishing redirect URIs must not register ──"
for uri in https://evil.example/cb http://localhost.evil.example/cb http://localhost@evil.example/cb \
           https://chatgpt.com.evil.example/connector/oauth/x https://claude.ai.evil.example/api/mcp/auth_callback; do
  code=$(register "$uri"); [ "$code" = 400 ] && ok "$uri → 400" || bad "$uri → $code"
done

echo; echo "── Fabricated codes and refresh tokens at /token ──"
CID=$(curl -s --max-time 10 "$B/register" -H 'Content-Type: application/json' \
  -d '{"client_name":"Audit","redirect_uris":["https://claude.ai/api/mcp/auth_callback"],"token_endpoint_auth_method":"none"}' \
  | sed -n 's/.*"client_id":"\([^"]*\)".*/\1/p')
for c in guess AAAAAAAA "$(rand)"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$B/token" \
    -d "grant_type=authorization_code&code=$c&code_verifier=xyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxyz&client_id=$CID&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback")
  [ "$code" -ge 400 ] && ok "fabricated code '${c:0:8}' → $code" || bad "fabricated code accepted → $code"
done
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$B/token" -d "grant_type=refresh_token&refresh_token=$(rand)&client_id=$CID")
[ "$code" -ge 400 ] && ok "forged refresh_token → $code" || bad "forged refresh_token → $code"

echo; echo "── Foreign Origin (DNS rebinding) ──"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "$B/mcp" -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -d '{}')
[ "$code" = 403 ] && ok "foreign Origin → 403" || bad "foreign Origin → $code"

echo; echo "── Verb / path tricks to skip the auth middleware ──"
for spec in "GET /mcp" "DELETE /mcp" "PUT /mcp" "POST /mcp/" "POST /MCP" "POST //mcp"; do
  m=${spec% *}; p=${spec#* }
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X "$m" "$B$p" \
    -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
  case "$code" in 401|403|404|405) ok "$m $p → $code";; *) bad "$m $p → $code";; esac
done

echo; echo "── Sign-in page headers ──"
headers=$(curl -s -D - -o /dev/null --max-time 10 "$B/privacy")
grep -qi "^content-security-policy:.*default-src 'none'" <<<"$headers" && ok "strict CSP on pages" || bad "pages lack a strict CSP"
grep -qi '^x-frame-options: *DENY' <<<"$headers" && ok "pages cannot be framed" || bad "pages can be framed (clickjacking)"

echo; echo "══════════════════════════════════════════════════"
echo "blocked: $pass   leaked: $fail"
(( fail == 0 ))
