#!/usr/bin/env bash
# One-click launcher for the prozetta GUI (Linux / macOS).
# Installs dependencies on first run, starts the web server and opens the browser.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
    echo "Node.js не найден. Установите его с https://nodejs.org и запустите этот скрипт снова."
    echo "Node.js not found. Install it from https://nodejs.org and run this script again."
    read -r -p "Нажмите Enter, чтобы закрыть / Press Enter to close..." _
    exit 1
fi

if [ ! -d node_modules ]; then
    echo "Первый запуск: устанавливаю зависимости, это займёт пару минут..."
    echo "First run: installing dependencies, this takes a couple of minutes..."
    npm install || { read -r -p "npm install failed. Press Enter to close..." _; exit 1; }
fi

PORT="${GUI_PORT:-3457}"
URL="http://127.0.0.1:${PORT}"

# Open the browser once the server has had a moment to start.
(
    sleep 2
    if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1
    elif command -v open >/dev/null 2>&1; then open "$URL"
    else echo "Откройте в браузере / Open in your browser: $URL"
    fi
) &

npm run gui
