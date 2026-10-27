@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   小四张 · 联机服务
echo ============================================
echo.
echo   本机打开：http://localhost:3000
echo   同一 WiFi 的朋友可用：http://本机IP:3000
echo   异地朋友请用隧道或部署（见使用说明）
echo.
echo   关闭此窗口即停止服务
echo ============================================
echo.
node server.js
pause
