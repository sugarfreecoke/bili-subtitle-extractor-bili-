@echo off
chcp 65001 >nul
title B站字幕批量提取器

set PORT=8899

echo ================================
echo   🎬 B站字幕批量提取器（智能启动）
echo ================================
echo.

:: 检查 Node.js 是否安装
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ 未检测到 Node.js，请先安装：https://nodejs.org
    pause
    exit /b
)

:: 检查 node_modules 是否安装
if not exist "node_modules" (
    echo 📦 正在安装依赖...
    call npm install
    echo ✅ 依赖安装完成
    echo.
)

:: 检查指定端口是否已被占用
netstat -ano | findstr ":%PORT% " >nul
if %errorlevel% equ 0 (
    echo ✅ 服务似乎已经在运行！
    echo 🌐 正在打开 http://localhost:%PORT%
    start http://localhost:%PORT%
    echo.
    echo 💡 如果页面打不开，请尝试手动访问上述地址。
    echo 🔄 如需重启，请先关闭原来的程序（按 Ctrl+C 或任务管理器结束 node.exe）。
    pause
    exit /b
)

:: 端口未被占用，启动服务
echo 🚀 正在启动服务...
echo 🌐 请访问: http://localhost:%PORT%
echo.
start http://localhost:%PORT%
node server.js

pause