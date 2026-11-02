#!/bin/sh
# mado を Linux のコンテナで動かす。AMT の電源と SOL の試験用(tls は off、http の 8080)。
# session.key は決まった値にして、e2e.ts が Cookie とトークンを作れるようにする。OIDC はログインのときにしか使わないので、でたらめな値でよい。
#   wslc network create amtnet
#   wslc run -d --rm --name amt --network amtnet --network-alias amt.test -v "<リポジトリ>:/app" -w /app oven/bun:1 bun tools/amt-e2e/fake-amt.ts
#   wslc run -d --rm --name mado-amt --network amtnet --network-alias mado.test -v "<リポジトリ>:/src" -w /src mcr.microsoft.com/dotnet/sdk:10.0 sh tools/amt-e2e/run.sh
#   wslc run --rm --network amtnet -v "<リポジトリ>:/app" -w /app oven/bun:1 bun tools/amt-e2e/e2e.ts
# 先に dist/web を作っておく(bun run build:web)。
set -e
D=/tmp/mado-amt
rm -rf $D && mkdir -p $D/data
printf '\001%.0s' $(seq 1 32) > $D/data/session.key
cat > $D/mado.json <<'EOF'
{
  "host": "mado.test",
  "tls": "off",
  "listen": { "http": 8080 },
  "oidc": { "issuer": "https://idp.invalid", "client_id": "x", "client_secret": "y" },
  "data_dir": "data",
  "targets": [
    { "name": "pc", "host": "127.0.0.1" },
    { "name": "z440-amt", "type": "amt", "host": "amt.test" }
  ],
  "status": { "port": 0 },
  "update": { "enabled": false }
}
EOF
dotnet build server -v q -nologo
exec dotnet server/bin/Debug/net10.0/mado.dll --config $D/mado.json
