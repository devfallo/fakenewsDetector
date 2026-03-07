#!/usr/bin/env sh
set -eu

RUN_MODE="${GEMINI_RUN_MODE:-headless}"
export DISPLAY="${DISPLAY:-:99}"
XVFB_WHD="${XVFB_WHD:-1366x900x24}"
ENABLE_VNC="${ENABLE_VNC:-true}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"

# Stale Chromium singleton locks can prevent persistent profile launch.
rm -f /app/.gemini-profile/SingletonLock /app/.gemini-profile/SingletonSocket /app/.gemini-profile/SingletonCookie || true

if [ "$RUN_MODE" = "novnc" ]; then
  Xvfb "$DISPLAY" -screen 0 "$XVFB_WHD" -nolisten tcp &

  if [ "$ENABLE_VNC" = "true" ]; then
    fluxbox >/tmp/fluxbox.log 2>&1 &
    x11vnc -display "$DISPLAY" -forever -shared -rfbport "$VNC_PORT" -nopw -noxdamage >/tmp/x11vnc.log 2>&1 &

    if [ -x /usr/share/novnc/utils/novnc_proxy ]; then
      /usr/share/novnc/utils/novnc_proxy --vnc "localhost:${VNC_PORT}" --listen "${NOVNC_PORT}" >/tmp/novnc.log 2>&1 &
    else
      websockify --web /usr/share/novnc/ "${NOVNC_PORT}" "localhost:${VNC_PORT}" >/tmp/novnc.log 2>&1 &
    fi
  fi
fi

sleep 1
exec node index.js
