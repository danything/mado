# 自前の RDP クライアントの GFX([MS-RDPEGFX])と H.264(AVC420)を試すための RDP サーバー(xrdp 0.10 + xorgxrdp + Xfce)。
# Debian の xrdp パッケージは H.264 が無効なので、xrdp を --enable-x264 でソースからビルドする。TLS のみ(NLA なし)。
#   wslc build -t mado-xrdp-gfx tools/xrdp-gfx
#   wslc run -d --name xrdp-gfx -p 13390:3389 mado-xrdp-gfx      # ユーザー ubuntu / パスワード ubuntu
FROM debian:trixie AS build
ARG XRDP=0.10.6.1
ARG XORGXRDP=0.10.5
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl build-essential pkg-config autoconf automake libtool nasm \
      libssl-dev libpam0g-dev libx11-dev libxfixes-dev libxrandr-dev libjpeg-dev libx264-dev libopus-dev \
      xserver-xorg-dev xserver-xorg-core libepoxy-dev libgbm-dev libdrm-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN curl -fsSL https://github.com/neutrinolabs/xrdp/releases/download/v${XRDP}/xrdp-${XRDP}.tar.gz | tar xz \
    && cd xrdp-${XRDP} \
    && ./configure --prefix=/usr --sysconfdir=/etc --localstatedir=/var --enable-x264 --enable-jpeg --enable-opus --disable-fuse \
    && make -j"$(nproc)" && make install DESTDIR=/out && make install
RUN curl -fsSL https://github.com/neutrinolabs/xorgxrdp/releases/download/v${XORGXRDP}/xorgxrdp-${XORGXRDP}.tar.gz | tar xz \
    && cd xorgxrdp-${XORGXRDP} \
    && ./configure --prefix=/usr \
    && make -j"$(nproc)" && make install DESTDIR=/out

FROM debian:trixie
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates openssl libssl3t64 libpam0g libx11-6 libxfixes3 libxrandr2 libjpeg62-turbo libx264-164 libopus0 \
      xserver-xorg-core xserver-xorg-legacy xauth dbus-x11 xfce4 xfce4-terminal x11-xserver-utils procps \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/ /
RUN sed -i 's/^allowed_users=.*/allowed_users=anybody/' /etc/X11/Xwrapper.config 2>/dev/null || echo 'allowed_users=anybody' > /etc/X11/Xwrapper.config \
    && openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=xrdp-gfx -days 3650 -keyout /etc/xrdp/key.pem -out /etc/xrdp/cert.pem \
    && sed -i 's/^security_layer=.*/security_layer=tls/' /etc/xrdp/xrdp.ini \
    && useradd -m -s /bin/bash ubuntu && echo 'ubuntu:ubuntu' | chpasswd \
    && echo 'startxfce4' > /home/ubuntu/.xsession && chown ubuntu:ubuntu /home/ubuntu/.xsession
COPY gfx.toml /etc/xrdp/gfx.toml
COPY start.sh /start.sh
RUN chmod +x /start.sh
EXPOSE 3389
CMD ["/start.sh"]
