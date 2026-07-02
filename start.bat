@echo off
rem One-click launcher for the prozetta GUI (Windows).
rem Installs dependencies on first run, starts the web server and opens the browser.
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js не найден. Установите его с https://nodejs.org и запустите этот файл снова.
    echo Node.js not found. Install it from https://nodejs.org and run this file again.
    pause
    exit /b 1
)

if not exist node_modules (
    echo Первый запуск: устанавливаю зависимости, это займёт пару минут...
    echo First run: installing dependencies, this takes a couple of minutes...
    call npm install
    if errorlevel 1 (
        pause
        exit /b 1
    )
)

set "PORT=%GUI_PORT%"
if "%PORT%"=="" set "PORT=3457"

rem Open the browser in a detached shell after the server has had time to start.
start "" cmd /c "timeout /t 3 /nobreak >nul & start "" http://127.0.0.1:%PORT%"

call npm run gui
pause
