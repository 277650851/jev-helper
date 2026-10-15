@echo off
rem 双击即可打开 Laya 服务管理菜单（或在本目录执行 manage-laya.cmd）。
rem 真正的逻辑在 manage-laya.ps1；这里只是把执行策略绕过一下，免得用户被策略拦住。
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0manage-laya.ps1" %*
exit /b %ERRORLEVEL%
