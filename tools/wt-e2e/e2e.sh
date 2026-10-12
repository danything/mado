#!/bin/sh
# Playwright の像の中で e2e.cjs を動かす。run.sh が書いた CA を Chromium(NSS)に信頼させてから始める
set -e
apt-get update -qq >/dev/null && apt-get install -y -qq libnss3-tools >/dev/null
mkdir -p "$HOME/.pki/nssdb"
certutil -d "sql:$HOME/.pki/nssdb" -N --empty-password 2>/dev/null || true
certutil -d "sql:$HOME/.pki/nssdb" -A -t "C,," -n mado-e2e -i /src/tools/wt-e2e/.ca.crt
# web/rdp の部品を 1 つの JS にする(bun は npm で入れる)
cd /tmp && npm i playwright@1.56.1 bun@1.4.3 >/dev/null 2>&1
/tmp/node_modules/.bin/bun build /src/tools/wt-e2e/client.ts --outfile /tmp/client.js --format iife >/dev/null
NODE_PATH=/tmp/node_modules node /src/tools/wt-e2e/e2e.cjs
