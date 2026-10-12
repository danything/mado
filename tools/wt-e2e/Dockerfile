# mado の WebTransport を Linux で試すための像。.NET SDK に msquic(libmsquic)を足す。
# Windows では mado.exe の隣の msquic.dll(SChannel 版)を使う。Linux の libmsquic は OpenSSL 版。
#   wslc build -t mado-wt-e2e tools/wt-e2e
# 使い方は run.sh と e2e.cjs の頭に書いた。
FROM mcr.microsoft.com/dotnet/sdk:11.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates openssl \
 && curl -fsSL -o /tmp/ms.deb https://packages.microsoft.com/config/ubuntu/24.04/packages-microsoft-prod.deb \
 && dpkg -i /tmp/ms.deb && rm /tmp/ms.deb \
 && apt-get update \
 && apt-get install -y --no-install-recommends libmsquic \
 && rm -rf /var/lib/apt/lists/*
