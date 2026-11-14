#!/usr/bin/env sh
# start.sh — macOS / Linux 本地启动（ES 模块与 Web Worker 需要 http:// 才能完整运行）
cd "$(dirname "$0")"
PORT="${PORT:-8765}"
URL="http://127.0.0.1:$PORT/index.html"
echo "圆孔衍射 · 第一问数值实验：$URL  （Ctrl+C 停止）"
( sleep 1; (xdg-open "$URL" || open "$URL") >/dev/null 2>&1 ) &
if command -v python3 >/dev/null 2>&1; then exec python3 -m http.server "$PORT" --bind 127.0.0.1
elif command -v node >/dev/null 2>&1; then exec node server.js "$PORT"
else echo "需要 python3 或 node"; exit 1; fi
