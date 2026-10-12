#!/bin/sh
# mado を Linux のコンテナで動かす。WebTransport の試験用。
# 証明書は自前の CA で作り、data/tls.crt と data/tls.key に置く(残りが 30 日より多いので ACME には行かない)。
# session.key は決まった値にして、e2e.cjs がトークンを作れるようにする。
# OIDC はログインのときにしか使わないので、でたらめな値でよい。
#   wslc run --rm --name mado-e2e --network wtnet --network-alias mado.test -v "<リポジトリ>:/src" -w /src mado-wt-e2e sh tools/wt-e2e/run.sh
# 先に dist/web を作っておく(bun run build:web)。
set -e
D=/tmp/mado-e2e
rm -rf $D && mkdir -p $D/data
cd $D

# CA と leaf の 2 段。tls.crt は leaf と CA を並べる(中間証明書を一緒に送る道を通す)
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout ca.key -out ca.crt -days 90 -subj "/CN=mado e2e CA" 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout data/tls.key -out leaf.csr -subj "/CN=mado.test" 2>/dev/null
printf "subjectAltName=DNS:mado.test\nextendedKeyUsage=serverAuth\n" > ext.cnf
openssl x509 -req -in leaf.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out leaf.crt -days 60 -extfile ext.cnf 2>/dev/null
cat leaf.crt ca.crt > data/tls.crt
# Chrome に信頼させる CA。e2e.cjs の側で NSS に入れる。
# --ignore-certificate-errors-spki-list は TCP の https には効くが、WebTransport(QUIC)には効かない
cp ca.crt /src/tools/wt-e2e/.ca.crt
# session.key は 32 バイトの 0x01
printf '\001%.0s' $(seq 1 32) > data/session.key

cat > mado.json <<'EOF'
{
  "host": "mado.test",
  "acme": { "email": "e2e@example.com" },
  "oidc": { "issuer": "https://idp.invalid", "client_id": "x", "client_secret": "y" },
  "data_dir": "data",
  "targets": [{ "name": "xrdp", "host": "xrdp", "port": 3389 }],
  "status": { "port": 0 },
  "update": { "enabled": false }
}
EOF

cd /src
dotnet build server -v q -nologo
exec dotnet server/bin/Debug/net10.0/mado.dll --config $D/mado.json
