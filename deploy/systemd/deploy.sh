#!/usr/bin/env bash
# Build, test and install kt-mcp into /opt/kt-mcp, then restart the service.
# Run as a sudo-capable user from anywhere inside the repo:  ./deploy/systemd/deploy.sh
# One-time setup (kt-mcp user, /etc/kt-mcp/kt-mcp.env, the unit, the proxy) is in docs/SELF-HOSTING.md.
set -euo pipefail
cd "$(dirname "$0")/../.."

npm ci --no-audit --no-fund
npm test                      # builds dist/ and runs the unit tests
node scripts/e2e-auth.mjs     # sign-in flow end to end (stubbed login, real anonymous search)

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
chmod 755 "$stage"            # rsync -a copies this mode onto /opt/kt-mcp; mktemp makes it 0700
cp -r dist package.json package-lock.json "$stage/"
find "$stage/dist" -name '*.test.js*' -delete
(cd "$stage" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)

sudo install -d -o root -g root -m 0755 /opt/kt-mcp
sudo rsync -a --delete --chown=root:root --chmod=D755,F644 "$stage"/ /opt/kt-mcp/
sudo systemctl restart kt-mcp
sleep 2
systemctl is-active kt-mcp
curl -fsS "http://127.0.0.1:${PORT:-8092}/healthz" && echo
