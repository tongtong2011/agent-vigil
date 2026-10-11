@echo off
chcp 936 >nul
title 爱思办公任务看板 - 桥接服务
cd /d "%~dp0"
echo.
echo  爱思办公任务看板（爱思办公手机协同端）
echo  ==================================
echo.

rem 首次运行自动安装依赖（发布包不含 node_modules）
if not exist node_modules (
  echo  [首次运行] 正在安装依赖，约 1~2 分钟，需要联网...
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo  [失败] 依赖安装出错。请检查：
    echo    1. 已安装 Node.js 18 或以上版本（https://nodejs.org）
    echo    2. 电脑可以联网
    echo  修复后重新双击本文件即可。
    echo.
    pause
    exit /b 1
  )
  echo.
  echo  [完成] 依赖安装成功。
  echo.
)

echo  服务启动中，请保持本窗口开启（关闭窗口 = 停止服务）
echo  启动后按窗口提示操作：手机扫码连接，或打开配置向导完成邮箱等配置
echo.
node bridge.js
echo.
echo  服务已停止。
pause