#!/bin/sh
# xrdp-sesman と xrdp を前で動かす(コンテナの主プロセスは xrdp)
mkdir -p /var/run/xrdp /run/dbus
dbus-daemon --system --fork 2>/dev/null || true
xrdp-sesman
exec xrdp --nodaemon
