# msquic 入りの .NET SDK。WebTransport の試作を Linux で動かすための像。
# 作る:   wslc build -t mado-wt-poc tools/wt-poc
# 組む:   wslc run --rm -v "<リポジトリ>:/src" -w /src mado-wt-poc dotnet build tools/wt-poc
# 動かす: wslc run --rm --name wtpoc --network wtnet -v "<リポジトリ>:/src" -w /src mado-wt-poc dotnet tools/wt-poc/bin/Debug/net10.0/wt-poc.dll
# 試す:   wslc run --rm --network wtnet -v "<リポジトリ>:/src" mcr.microsoft.com/playwright:v1.56.1-noble \
#           sh -c "cd /tmp && npm i playwright@1.56.1 >/dev/null 2>&1 && NODE_PATH=/tmp/node_modules node /src/tools/wt-poc/headless.cjs"
# (wtnet は wslc network create wtnet で作る)
# wslc の -p 4433:4433/udp は、返りの UDP の送信元の port が 4433 にならない。そのため Windows の Chrome からは QUIC がつながらない。
FROM mcr.microsoft.com/dotnet/sdk:10.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL -o /tmp/ms.deb https://packages.microsoft.com/config/ubuntu/24.04/packages-microsoft-prod.deb \
 && dpkg -i /tmp/ms.deb && rm /tmp/ms.deb \
 && apt-get update \
 && apt-get install -y --no-install-recommends libmsquic \
 && rm -rf /var/lib/apt/lists/*
