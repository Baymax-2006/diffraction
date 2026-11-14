@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PORT=8765
echo 圆孔衍射 · 第一问数值实验 —— 本地启动
echo 浏览器地址: http://127.0.0.1:%PORT%/index.html
echo 关闭本窗口即停止服务器。
echo.
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul && start "" http://127.0.0.1:%PORT%/index.html"

py -3 -c "import sys" >nul 2>nul
if %errorlevel%==0 ( py -3 -m http.server %PORT% --bind 127.0.0.1 & goto :end )
python -c "import sys" >nul 2>nul
if %errorlevel%==0 ( python -m http.server %PORT% --bind 127.0.0.1 & goto :end )
node -v >nul 2>nul
if %errorlevel%==0 ( node server.js %PORT% & goto :end )
echo 未找到 Python 或 Node，改用 PowerShell 内置服务器...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" -Port %PORT%
:end
pause
